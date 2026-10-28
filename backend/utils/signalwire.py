"""What this backend asks SignalWire for: the addresses of the resources a
region's test dials, and a short-lived guest token allowed to dial only those
addresses, minted with the credentials of the region the page chose.

Regions come from the environment (see load_regions): either
NETWORK_TEST_REGIONS, a JSON object keyed by region name, or, for a single
space, SPACE_NAME / PROJECT_ID / AUTH_TOKEN plus NETWORK_TEST_ECHO_RESOURCE_ID
and NETWORK_TEST_VIDEO_ROOM_RESOURCE_ID, which become the "global" region.
"""
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import requests

logger = logging.getLogger(__name__)

# Every call to SignalWire's REST API is bounded so a slow upstream can't hang
# a Flask worker indefinitely.
REQUEST_TIMEOUT_S = 10

DEFAULT_REGION = 'global'

# A guest token may list at most ten addresses.
MAX_ALLOWED_ADDRESSES = 10

# Resolved addresses are kept per (region, resource) so a run's token request
# costs one POST rather than two GETs and a POST, except once every ten
# minutes. In memory and per worker, like the rate limiter.
ADDRESS_CACHE_TTL_S = 600


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

    def resource_addresses(self, resource_id: str) -> List[Dict]:
        """The Fabric addresses of one resource.
        https://signalwire.com/docs/apis/rest/addresses/list-resource-addresses

        Each entry carries "id" (the address UUID a guest token is allowed to
        dial) and "channels" ({"audio": "/private/x?channel=audio", ...}). One
        page is enough: a token takes ten addresses at most.
        """
        try:
            response = requests.get(
                f"{self.api_base}/resources/{resource_id}/addresses",
                auth=self.auth,
                headers={"Accept": "application/json"},
                timeout=REQUEST_TIMEOUT_S,
            )
            response.raise_for_status()
            data = response.json()
        except (requests.exceptions.RequestException, ValueError) as e:
            self._log_failure(f"listing the addresses of resource {resource_id}", e)
            raise Exception("Failed to list resource addresses") from e
        return data.get("data") or []

    def create_guest_token(self, allowed_addresses: List[str], expires_in: int) -> Dict:
        """Mint a guest token: the SAT the Browser SDK authenticates with.
        https://signalwire.com/docs/apis/rest/subscribers/tokens/create-subscriber-guest-token

        A guest token is outbound-only and can dial only `allowed_addresses`
        (address UUIDs, not resource IDs). Unlike a subscriber token it names
        no subscriber and creates none, so nothing is billed monthly for it.
        `expire_at` is a Unix timestamp in seconds, per the documented schema.
        """
        expire_at = int(time.time()) + expires_in
        try:
            response = requests.post(
                f"{self.api_base}/guests/tokens",
                json={"allowed_addresses": allowed_addresses, "expire_at": expire_at},
                auth=self.auth,
                headers={"Content-Type": "application/json"},
                timeout=REQUEST_TIMEOUT_S,
            )
            response.raise_for_status()
            data = response.json()
        except (requests.exceptions.RequestException, ValueError) as e:
            self._log_failure("creating the guest token", e)
            raise Exception("Failed to create guest token") from e
        # The response's refresh_token isn't forwarded: the page refreshes
        # through this backend, and the token is all the SDK needs.
        return {
            "token": data.get("token"),
            # Computed from the request; the response needn't echo it.
            "expires_at": datetime.fromtimestamp(expire_at, tz=timezone.utc).isoformat(),
            "expires_in": expires_in,
        }

    @staticmethod
    def _log_failure(what: str, e: Exception) -> None:
        logger.error(f"Error {what}: {e}")
        response = getattr(e, 'response', None)
        if response is not None:
            logger.error(f"Response: {response.text}")


@dataclass(frozen=True)
class Region:
    name: str
    space_name: str
    project_id: str
    auth_token: str
    # The resource ID (the UUID on the resource's page in the Dashboard, not
    # its Fabric address) of the SWML echo script the voice steps dial; None
    # skips them.
    echo_resource_id: Optional[str]
    # The resource ID of a video room for the two video steps; None skips
    # them.
    video_room_resource_id: Optional[str]

    def client(self) -> SignalWireClient:
        return SignalWireClient(self.space_name, self.project_id, self.auth_token)


def _optional(raw: Dict, key: str) -> Optional[str]:
    value = raw.get(key)
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _resource_id(region_name: str, raw: Dict, key: str) -> Optional[str]:
    """A resource ID setting: a UUID, or None when unset. Anything else (a
    Fabric address pasted where the ID goes) is logged and treated as unset,
    so the mistake shows at startup rather than as a 404 on every run."""
    value = _optional(raw, key)
    if value is None:
        return None
    try:
        uuid.UUID(value)
    except ValueError:
        logger.error(f"Region {region_name!r}: {key} must be the resource's UUID, not {value!r}; ignoring it")
        return None
    return value


def _region_from(name: str, raw) -> Optional[Region]:
    if not isinstance(raw, dict):
        logger.error(f"Region {name!r} is not a JSON object")
        return None
    missing = [key for key in ('space_name', 'project_id', 'auth_token') if not str(raw.get(key) or '').strip()]
    if missing:
        logger.error(f"Region {name!r} is missing {missing}; not serving it")
        return None
    echo = _resource_id(name, raw, 'echo_resource_id')
    room = _resource_id(name, raw, 'video_room_resource_id')
    if not echo and not room:
        logger.error(f"Region {name!r} names neither echo_resource_id nor video_room_resource_id; not serving it")
        return None
    return Region(
        name=name,
        space_name=str(raw['space_name']).strip(),
        project_id=str(raw['project_id']).strip(),
        auth_token=str(raw['auth_token']).strip(),
        echo_resource_id=echo,
        video_room_resource_id=room,
    )


def load_regions() -> Dict[str, Region]:
    """The configured regions, by (lower-cased) name.

    NETWORK_TEST_REGIONS wins when set; otherwise the single-space variables
    make up the "global" region. Empty when nothing usable is configured (the
    endpoints then answer 503), and a region with a missing credential, or
    without a resource to dial, is dropped with a log line rather than served
    half-configured.
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
        'echo_resource_id': os.getenv('NETWORK_TEST_ECHO_RESOURCE_ID', ''),
        'video_room_resource_id': os.getenv('NETWORK_TEST_VIDEO_ROOM_RESOURCE_ID', ''),
    }
    if not any(single[key].strip() for key in ('space_name', 'project_id', 'auth_token')):
        return {}
    region = _region_from(DEFAULT_REGION, single)
    return {region.name: region} if region else {}


@dataclass(frozen=True)
class ResolvedAddresses:
    # Address UUIDs for the token's allowed_addresses: the echo script's
    # first, then the room's, at most MAX_ALLOWED_ADDRESSES.
    allowed_addresses: List[str]
    # Bare Fabric addresses for the page, which appends ?channel=... (for
    # example /private/network-test-echo); None when the region has no such
    # resource or none of its addresses carries the channel.
    echo_address: Optional[str]
    video_room_address: Optional[str]


# (region name, resource id) -> (monotonic expiry, the listing).
_address_cache: Dict[Tuple[str, str], Tuple[float, List[Dict]]] = {}


def _bare(address: str) -> str:
    """'/x?channel=audio' -> '/x'."""
    return address.split('?', 1)[0]


def _cached_resource_addresses(region: Region, client: SignalWireClient, resource_id: str) -> List[Dict]:
    key = (region.name, resource_id)
    cached = _address_cache.get(key)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    addresses = client.resource_addresses(resource_id)
    logger.info(f"Resolved {len(addresses)} address(es) for resource {resource_id} of region {region.name}")
    # An empty listing isn't kept: once the deployer fixes the resource, the
    # next run should see it.
    if addresses:
        _address_cache[key] = (time.monotonic() + ADDRESS_CACHE_TTL_S, addresses)
    return addresses


def resolve_addresses(region: Region) -> ResolvedAddresses:
    """What a run's guest token needs, from the region's configured
    resources: the address IDs the token may dial and the addresses the page
    dials. Raises when no address could be resolved at all."""
    client = region.client()
    allowed: List[str] = []
    dial: Dict[str, Optional[str]] = {'audio': None, 'video': None}
    for resource_id, channel in ((region.echo_resource_id, 'audio'), (region.video_room_resource_id, 'video')):
        if not resource_id:
            continue
        addresses = _cached_resource_addresses(region, client, resource_id)
        if not addresses:
            logger.error(f"Resource {resource_id} of region {region.name} has no address")
        for address in addresses:
            address_id = address.get('id')
            if not address_id:
                continue
            if len(allowed) >= MAX_ALLOWED_ADDRESSES:
                logger.warning(f"Region {region.name} has more than {MAX_ALLOWED_ADDRESSES} addresses; "
                               f"the token allows the first {MAX_ALLOWED_ADDRESSES}")
                break
            allowed.append(address_id)
            path = (address.get('channels') or {}).get(channel)
            if path and dial[channel] is None:
                dial[channel] = _bare(path)
        if addresses and dial[channel] is None:
            logger.warning(f"No allowed address of resource {resource_id} (region {region.name}) has a {channel} channel; "
                           f"its steps will be skipped")
    if not allowed:
        raise Exception(f"No address resolved for region {region.name}")
    return ResolvedAddresses(allowed_addresses=allowed, echo_address=dial['audio'], video_room_address=dial['video'])
