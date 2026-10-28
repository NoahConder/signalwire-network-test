"""The network test's backend: a five-minute guest token per run, allowed to
dial only the region's echo script and video room, behind the API key, a
per-IP rate limit and (in production) a Cloudflare Turnstile check, plus the
page's configuration. Nothing else here talks to SignalWire.
"""
import logging
import os

import requests
from flask import Blueprint, jsonify, request

from utils.security import client_ip, gate
from utils.signalwire import DEFAULT_REGION, load_regions, resolve_addresses

logger = logging.getLogger(__name__)
network_test_bp = Blueprint('network_test', __name__)

# A guest token for every run: outbound-only, allowed to dial only the
# addresses of the region's echo script and video room (resolved from their
# resource IDs and cached; see utils.signalwire.resolve_addresses), and naming
# no subscriber, so nothing is created or billed monthly for it. The token
# outlives a run (under three minutes end to end) with little to spare: the
# SDK would try to refresh shortly before it expires; the page disconnects
# well before that.
TOKEN_TTL_S = 300

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
    """Mint the run's guest token.

    Body: {"region": "global", "captcha_token": "<Turnstile response>"}. The
    region picks the credentials and the resources whose addresses the token
    may dial (the echo and room addresses are echoed back for the page); the
    captcha token is required whenever TURNSTILE_SECRET is set.
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
        addresses = resolve_addresses(region)
        token_data = region.client().create_guest_token(
            allowed_addresses=addresses.allowed_addresses, expires_in=TOKEN_TTL_S)
    except Exception as e:
        # Details stay in the server log; the client gets a generic body.
        logger.error(f"Error minting the network-test token for region {region.name}: {e}")
        return jsonify({"success": False, "error": "Failed to generate token"}), 500

    logger.info(f"Network-test token minted for region {region.name} "
                f"({len(addresses.allowed_addresses)} allowed address(es))")
    return jsonify({
        "success": True,
        "data": {
            **token_data,
            "region": region.name,
            "echo_address": addresses.echo_address,
            "video_room_address": addresses.video_room_address,
        },
    })
