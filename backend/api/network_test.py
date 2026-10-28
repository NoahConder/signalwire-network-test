"""The network test's backend: a five-minute subscriber token per run, behind
the API key, a per-IP rate limit and (in production) a Cloudflare Turnstile
check, plus the page's configuration. Nothing else here talks to SignalWire.
"""
import logging
import os

import requests
from flask import Blueprint, jsonify, request

from utils.security import client_ip, gate
from utils.signalwire import DEFAULT_REGION, load_regions

logger = logging.getLogger(__name__)
network_test_bp = Blueprint('network_test', __name__)

# One subscriber for every run, and a token that outlives a run (under three
# minutes end to end) with little to spare. The SDK would try to refresh at
# about 80% of the TTL; the page disconnects before that.
#
# The reference names the subscriber: SignalWire creates one per reference on
# the first mint and reuses it after. NETWORK_TEST_SUBSCRIBER_REFERENCE picks
# an existing subscriber instead (its email), for example in a space where a
# new subscriber shouldn't be created.
DEFAULT_TOKEN_REFERENCE = 'network-test'
TOKEN_TTL_S = 300


def token_reference() -> str:
    return os.getenv('NETWORK_TEST_SUBSCRIBER_REFERENCE', '').strip() or DEFAULT_TOKEN_REFERENCE

TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
VERIFY_TIMEOUT_S = 10


def captcha_mode() -> str:
    """'turnstile' when TURNSTILE_SECRET is set; 'disabled' when the deployment
    opted out with NETWORK_TEST_ALLOW_NO_CAPTCHA=true (local development);
    otherwise 'unconfigured', in which case /token refuses (503) rather than
    mint billable tokens for anyone who read the key out of the bundle."""
    if os.getenv('TURNSTILE_SECRET', '').strip():
        return 'turnstile'
    if os.getenv('NETWORK_TEST_ALLOW_NO_CAPTCHA', '').strip().lower() == 'true':
        return 'disabled'
    return 'unconfigured'


def verify_turnstile(token: str, remote_ip: str) -> bool:
    """Cloudflare's siteverify. Tokens are single-use and expire after five
    minutes; a network failure counts as a refusal."""
    try:
        response = requests.post(
            TURNSTILE_VERIFY_URL,
            data={'secret': os.getenv('TURNSTILE_SECRET', ''), 'response': token, 'remoteip': remote_ip},
            timeout=VERIFY_TIMEOUT_S,
        )
        response.raise_for_status()
        result = response.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        logger.error(f"Turnstile verification failed: {e}")
        return False
    if not result.get('success'):
        logger.info(f"Turnstile rejected a token: {result.get('error-codes')}")
        return False
    return True


@network_test_bp.route('/config', methods=['GET'])
def config():
    """What the page needs before it can start: the regions it may pick and
    whether a captcha token is required."""
    blocked = gate(request, 'network-test-config', limit=30)
    if blocked:
        return blocked
    regions = load_regions()
    if not regions:
        return jsonify({"success": False, "error": "No region configured"}), 503
    names = sorted(regions)
    return jsonify({
        "success": True,
        "data": {
            "regions": names,
            "default_region": DEFAULT_REGION if DEFAULT_REGION in regions else names[0],
            "captcha_required": captcha_mode() == 'turnstile',
        },
    })


@network_test_bp.route('/token', methods=['POST'])
def token():
    """Mint the run's subscriber token.

    Body: {"region": "global", "captcha_token": "<Turnstile response>"}. The
    region picks the credentials (and the echo and room addresses echoed
    back); the captcha token is required whenever TURNSTILE_SECRET is set.
    """
    blocked = gate(request, 'network-test', limit=5, window_sec=600)
    if blocked:
        return blocked
    body = request.get_json(silent=True) or {}

    regions = load_regions()
    if not regions:
        return jsonify({"success": False, "error": "No region configured"}), 503
    name = body.get('region') or DEFAULT_REGION
    region = regions.get(name.strip().lower()) if isinstance(name, str) else None
    if not region:
        return jsonify({"success": False, "error": "Unknown region"}), 400

    mode = captcha_mode()
    if mode == 'unconfigured':
        return jsonify({"success": False, "error": "Captcha not configured"}), 503
    if mode == 'turnstile':
        captcha_token = body.get('captcha_token')
        if not isinstance(captcha_token, str) or not captcha_token.strip():
            return jsonify({"success": False, "error": "Captcha required"}), 403
        if not verify_turnstile(captcha_token.strip(), client_ip(request)):
            return jsonify({"success": False, "error": "Captcha rejected"}), 403

    try:
        token_data = region.client().create_subscriber_token(reference=token_reference(), expires_in=TOKEN_TTL_S)
    except Exception as e:
        # Details stay in the server log; the client gets a generic body.
        logger.error(f"Error minting the network-test token for region {region.name}: {e}")
        return jsonify({"success": False, "error": "Failed to generate token"}), 500

    logger.info(f"Network-test token minted for region {region.name}")
    return jsonify({
        "success": True,
        "data": {
            **token_data,
            "region": region.name,
            "echo_address": region.echo_address,
            "video_room_address": region.video_room_address,
        },
    })
