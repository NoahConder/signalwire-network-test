"""The one thing this backend asks SignalWire for: a short-lived subscriber
token, minted with the credentials of the region the page chose.

Regions come from the environment (see load_regions): either
NETWORK_TEST_REGIONS, a JSON object keyed by region name, or, for a single
space, SPACE_NAME / PROJECT_ID / AUTH_TOKEN plus NETWORK_TEST_ECHO_ADDRESS
and NETWORK_TEST_VIDEO_ROOM_ADDRESS, which become the "global" region.
"""
import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Optional

import requests

logger = logging.getLogger(__name__)

# Every call to SignalWire's REST API is bounded so a slow upstream can't hang
# a Flask worker indefinitely.
REQUEST_TIMEOUT_S = 10

DEFAULT_REGION = 'global'


class SignalWireClient:
    """A Fabric REST client for one space and project."""

    def __init__(self, space_name: str, project_id: str, auth_token: str):
        if not all([space_name, project_id, auth_token]):
            raise ValueError("space_name, project_id and auth_token are all required")
        self.space_name = space_name
        self.project_id = project_id
        # The space name is the full hostname (spacename.signalwire.com or a
        # custom domain), used as-is.
        self.api_base = f"https://{space_name}/api/fabric"
        self.auth = (project_id, auth_token)

    def create_subscriber_token(self, reference: str, expires_in: int) -> Dict:
        """Mint a subscriber token: the SAT the Browser SDK authenticates with.
        https://signalwire.com/docs/rest/signalwire-rest/endpoints/fabric/subscriber-tokens-create

        `reference` names the subscriber (SignalWire creates one per reference
        on first use and reuses it after); `expire_at` is a Unix timestamp in
        seconds, per the documented schema.
        """
        expire_at = int(time.time()) + expires_in
        try:
            response = requests.post(
                f"{self.api_base}/subscribers/tokens",
                json={"reference": reference, "expire_at": expire_at},
                auth=self.auth,
                headers={"Content-Type": "application/json"},
                timeout=REQUEST_TIMEOUT_S,
            )
            response.raise_for_status()
            data = response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"Error creating subscriber token: {e}")
            if getattr(e, 'response', None) is not None:
                logger.error(f"Response: {e.response.text}")
            raise Exception("Failed to create subscriber token") from e
        return {
            "token": data.get("token"),
            # The response doesn't echo the expiry; compute it from the request.
            "expires_at": datetime.fromtimestamp(expire_at, tz=timezone.utc).isoformat(),
            "expires_in": expires_in,
        }


@dataclass(frozen=True)
class Region:
    name: str
    space_name: str
    project_id: str
    auth_token: str
    # The Fabric address of the SWML echo script the voice steps dial (for
    # example /public/network-test-echo); the page appends ?channel=audio.
    echo_address: Optional[str]
    # The Fabric address of a video room for the two video steps; None skips
    # them.
    video_room_address: Optional[str]

    def client(self) -> SignalWireClient:
        return SignalWireClient(self.space_name, self.project_id, self.auth_token)


def _optional(raw: Dict, key: str) -> Optional[str]:
    value = raw.get(key)
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _region_from(name: str, raw) -> Optional[Region]:
    if not isinstance(raw, dict):
        logger.error(f"Region {name!r} is not a JSON object")
        return None
    missing = [key for key in ('space_name', 'project_id', 'auth_token') if not str(raw.get(key) or '').strip()]
    if missing:
        logger.error(f"Region {name!r} is missing {missing}; not serving it")
        return None
    return Region(
        name=name,
        space_name=str(raw['space_name']).strip(),
        project_id=str(raw['project_id']).strip(),
        auth_token=str(raw['auth_token']).strip(),
        echo_address=_optional(raw, 'echo_address'),
        video_room_address=_optional(raw, 'video_room_address'),
    )


def load_regions() -> Dict[str, Region]:
    """The configured regions, by (lower-cased) name.

    NETWORK_TEST_REGIONS wins when set; otherwise the single-space variables
    make up the "global" region. Empty when nothing usable is configured (the
    endpoints then answer 503), and a region with a missing field is dropped
    with a log line rather than served half-configured.
    """
    raw_json = os.getenv('NETWORK_TEST_REGIONS', '').strip()
    if raw_json:
        try:
            parsed = json.loads(raw_json)
        except ValueError as e:
            logger.error(f"NETWORK_TEST_REGIONS is not valid JSON: {e}")
            return {}
        if not isinstance(parsed, dict):
            logger.error("NETWORK_TEST_REGIONS must be a JSON object keyed by region name")
            return {}
        regions = {}
        for name, raw in parsed.items():
            region = _region_from(str(name).strip().lower(), raw)
            if region:
                regions[region.name] = region
        return regions

    single = {
        'space_name': os.getenv('SPACE_NAME', ''),
        'project_id': os.getenv('PROJECT_ID', ''),
        'auth_token': os.getenv('AUTH_TOKEN', ''),
        'echo_address': os.getenv('NETWORK_TEST_ECHO_ADDRESS', ''),
        'video_room_address': os.getenv('NETWORK_TEST_VIDEO_ROOM_ADDRESS', ''),
    }
    if not any(single[key].strip() for key in ('space_name', 'project_id', 'auth_token')):
        return {}
    region = _region_from(DEFAULT_REGION, single)
    return {region.name: region} if region else {}
