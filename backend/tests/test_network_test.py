"""The token endpoint is the security boundary of this backend: it mints
call-capable SignalWire tokens, so the API-key gate must fail closed, the
captcha must be enforced unless the deployment opted out, the rate limit is
tight, and only a configured region is served.

Nothing here talks to SignalWire or Cloudflare: the REST client and the
Turnstile check are replaced by fakes bound into api.network_test's namespace.
"""
import json
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

import pytest

import api.network_test as nt
import utils.security as security
import utils.signalwire as sw
from app import app

KEY = {'X-API-Key': 'test-key'}

# Resource IDs (what a deployer configures) and the addresses SignalWire lists
# for them (what the token allows and the page dials).
ECHO_RES = 'aaaaaaaa-0000-4000-8000-000000000001'
ROOM_RES = 'aaaaaaaa-0000-4000-8000-000000000002'
ECHO_ADDRESS = {'id': 'addr-echo', 'name': 'network-test-echo', 'type': 'app',
                'channels': {'audio': '/private/network-test-echo?channel=audio',
                             'messaging': '/private/network-test-echo?channel=messaging'}}
ROOM_ADDRESS = {'id': 'addr-room', 'name': 'network-test-room', 'type': 'room',
                'channels': {'audio': '/public/network-test-room?channel=audio',
                             'video': '/public/network-test-room?channel=video'}}


class FakeSignalWire:
    def __init__(self, addresses=None, fail_with=None, list_fail_with=None):
        self.addresses = addresses if addresses is not None else {ECHO_RES: [ECHO_ADDRESS], ROOM_RES: [ROOM_ADDRESS]}
        self.listed = []  # resource ids asked for, in order
        self.minted = []  # (allowed_addresses, expires_in)
        self.fail_with = fail_with
        self.list_fail_with = list_fail_with

    def resource_addresses(self, resource_id):
        if self.list_fail_with:
            raise self.list_fail_with
        self.listed.append(resource_id)
        return list(self.addresses.get(resource_id, []))

    def create_guest_token(self, allowed_addresses, expires_in):
        if self.fail_with:
            raise self.fail_with
        self.minted.append((list(allowed_addresses), expires_in))
        return {'token': 'sat-token', 'expires_at': '2026-01-01T00:05:00+00:00', 'expires_in': expires_in}


class FakeRegion:
    def __init__(self, name, echo_resource_id=ECHO_RES, video_room_resource_id=None, fake=None):
        self.name = name
        self.echo_resource_id = echo_resource_id
        self.video_room_resource_id = video_room_resource_id
        self.fake = fake or FakeSignalWire()

    def client(self):
        return self.fake


@pytest.fixture
def regions(monkeypatch):
    configured = {
        'global': FakeRegion('global', video_room_resource_id=ROOM_RES),
        'eu': FakeRegion('eu'),
    }
    monkeypatch.setattr(nt, 'load_regions', lambda: configured)
    return configured


@pytest.fixture
def client(monkeypatch, regions):
    monkeypatch.setenv('NETWORK_TEST_API_KEY', 'test-key')
    monkeypatch.delenv('TURNSTILE_SECRET', raising=False)
    monkeypatch.setenv('NETWORK_TEST_ALLOW_NO_CAPTCHA', 'true')
    # Fresh rate-limit buckets and address cache per test.
    monkeypatch.setattr(security, '_buckets', defaultdict(deque))
    monkeypatch.setattr(sw, '_address_cache', {})
    app.config['TESTING'] = True
    return app.test_client()


def minted(regions, name='global'):
    return regions[name].fake.minted


def listed(regions, name='global'):
    return regions[name].fake.listed


BOTH = (['addr-echo', 'addr-room'], 300)


# --- the gate -----------------------------------------------------------------

def test_fails_closed_when_the_api_key_is_not_configured(monkeypatch, client, regions):
    monkeypatch.delenv('NETWORK_TEST_API_KEY')
    assert client.post('/api/network-test/token', json={}).status_code == 503
    assert client.post('/api/network-test/token', json={}, headers=KEY).status_code == 503
    assert client.get('/api/network-test/config', headers=KEY).status_code == 503
    assert minted(regions) == []


def test_rejects_a_missing_or_wrong_key(client, regions):
    assert client.post('/api/network-test/token', json={}).status_code == 401
    assert client.post('/api/network-test/token', json={}, headers={'X-API-Key': 'wrong'}).status_code == 401
    assert client.get('/api/network-test/config').status_code == 401
    assert minted(regions) == []


def test_the_token_endpoint_allows_five_per_ten_minutes(client, regions):
    for _ in range(5):
        assert client.post('/api/network-test/token', json={}, headers=KEY).status_code == 200
    response = client.post('/api/network-test/token', json={}, headers=KEY)
    assert response.status_code == 429
    assert len(minted(regions)) == 5
    # Its own scope: the config endpoint is unaffected.
    assert client.get('/api/network-test/config', headers=KEY).status_code == 200


# --- minting ------------------------------------------------------------------

def test_mints_a_five_minute_token_for_the_default_region(client, regions):
    response = client.post('/api/network-test/token', json={}, headers=KEY)
    assert response.status_code == 200
    data = response.get_json()['data']
    assert data['token'] == 'sat-token'
    assert data['expires_in'] == 300
    assert data['expires_at'] == '2026-01-01T00:05:00+00:00'
    assert data['region'] == 'global'
    # The addresses the page dials, bare: it appends ?channel=... itself.
    assert data['echo_address'] == '/private/network-test-echo'
    assert data['video_room_address'] == '/public/network-test-room'
    assert 'refresh_token' not in data
    assert listed(regions) == [ECHO_RES, ROOM_RES]
    assert minted(regions) == [BOTH]


def test_picks_the_requested_region(client, regions):
    response = client.post('/api/network-test/token', json={'region': 'EU'}, headers=KEY)
    assert response.status_code == 200
    data = response.get_json()['data']
    assert data['region'] == 'eu'
    assert data['echo_address'] == '/private/network-test-echo'
    assert data['video_room_address'] is None
    assert minted(regions, 'eu') == [(['addr-echo'], 300)]
    assert minted(regions, 'global') == []


@pytest.mark.parametrize('region', ['mars', 42, ''])
def test_an_unknown_region_is_400(client, regions, region):
    response = client.post('/api/network-test/token', json={'region': region}, headers=KEY)
    # '' falls back to the default region; anything else unknown is refused.
    if region == '':
        assert response.status_code == 200
    else:
        assert response.status_code == 400
        assert response.get_json()['error'] == 'Unknown region'
        assert minted(regions) == []


def test_a_minting_failure_is_500_with_a_generic_body(client, regions):
    regions['global'].fake.fail_with = Exception('upstream said 401 and leaked a secret')
    response = client.post('/api/network-test/token', json={}, headers=KEY)
    assert response.status_code == 500
    assert response.get_json() == {'success': False, 'error': 'Failed to generate token'}
    assert listed(regions) == [ECHO_RES, ROOM_RES]


def test_a_listing_failure_is_500_with_a_generic_body(client, regions):
    regions['global'].fake.list_fail_with = Exception('upstream said 404 and leaked a secret')
    response = client.post('/api/network-test/token', json={}, headers=KEY)
    assert response.status_code == 500
    assert response.get_json() == {'success': False, 'error': 'Failed to generate token'}
    assert minted(regions) == []


def test_resources_without_addresses_are_500_and_not_cached(client, regions):
    regions['global'].fake.addresses = {ECHO_RES: [], ROOM_RES: []}
    for _ in range(2):
        response = client.post('/api/network-test/token', json={}, headers=KEY)
        assert response.status_code == 500
        assert response.get_json() == {'success': False, 'error': 'Failed to generate token'}
    assert minted(regions) == []
    assert sw._address_cache == {}
    # Listed again on the second try, so a fixed resource is picked up.
    assert listed(regions) == [ECHO_RES, ROOM_RES, ECHO_RES, ROOM_RES]


def test_an_address_without_the_wanted_channel_is_allowed_but_not_dialed(client, regions):
    audio_only = {**ROOM_ADDRESS, 'channels': {'audio': '/public/network-test-room?channel=audio'}}
    regions['global'].fake.addresses = {ECHO_RES: [ECHO_ADDRESS], ROOM_RES: [audio_only]}
    data = client.post('/api/network-test/token', json={}, headers=KEY).get_json()['data']
    assert data['echo_address'] == '/private/network-test-echo'
    assert data['video_room_address'] is None
    assert minted(regions) == [BOTH]


def test_the_allowed_addresses_are_capped_at_ten_with_the_echo_first(client, regions):
    rooms = [{'id': f'room-{i}', 'channels': {'video': f'/public/room-{i}?channel=video'}} for i in range(12)]
    regions['global'].fake.addresses = {ECHO_RES: [ECHO_ADDRESS], ROOM_RES: rooms}
    data = client.post('/api/network-test/token', json={}, headers=KEY).get_json()['data']
    [(allowed, ttl)] = minted(regions)
    assert ttl == 300
    assert allowed == ['addr-echo'] + [f'room-{i}' for i in range(9)]
    assert data['echo_address'] == '/private/network-test-echo'
    assert data['video_room_address'] == '/public/room-0'


def test_resolved_addresses_are_cached_between_mints(client, regions):
    for _ in range(2):
        assert client.post('/api/network-test/token', json={}, headers=KEY).status_code == 200
    assert listed(regions) == [ECHO_RES, ROOM_RES]
    assert minted(regions) == [BOTH, BOTH]
    assert sorted(sw._address_cache) == [('global', ECHO_RES), ('global', ROOM_RES)]


def test_the_address_cache_expires(client, regions):
    stale = {'id': 'stale-echo', 'channels': {'audio': '/private/stale?channel=audio'}}
    seeded = {'id': 'seeded-room', 'channels': {'video': '/public/seeded?channel=video'}}
    sw._address_cache[('global', ECHO_RES)] = (0.0, [stale])                      # expired
    sw._address_cache[('global', ROOM_RES)] = (time.monotonic() + 60, [seeded])   # live
    data = client.post('/api/network-test/token', json={}, headers=KEY).get_json()['data']
    assert listed(regions) == [ECHO_RES]
    assert minted(regions) == [(['addr-echo', 'seeded-room'], 300)]
    assert data['echo_address'] == '/private/network-test-echo'
    assert data['video_room_address'] == '/public/seeded'


def test_no_region_configured_is_503(monkeypatch, client):
    monkeypatch.setattr(nt, 'load_regions', lambda: {})
    assert client.post('/api/network-test/token', json={}, headers=KEY).status_code == 503
    assert client.get('/api/network-test/config', headers=KEY).status_code == 503


# --- the captcha --------------------------------------------------------------

def test_requires_a_captcha_token_when_turnstile_is_configured(monkeypatch, client, regions):
    monkeypatch.setenv('TURNSTILE_SECRET', 'secret')
    for body in ({}, {'captcha_token': ''}, {'captcha_token': 7}):
        response = client.post('/api/network-test/token', json=body, headers=KEY)
        assert response.status_code == 403
        assert response.get_json()['error'] == 'Captcha required'
    assert minted(regions) == []


def test_verifies_the_captcha_token_before_minting(monkeypatch, client, regions):
    monkeypatch.setenv('TURNSTILE_SECRET', 'secret')
    seen = []

    def fake_verify(token, remote_ip):
        seen.append((token, remote_ip))
        return token == 'good'

    monkeypatch.setattr(nt, 'verify_turnstile', fake_verify)
    rejected = client.post('/api/network-test/token', json={'captcha_token': 'bad'}, headers=KEY)
    assert rejected.status_code == 403
    assert rejected.get_json()['error'] == 'Captcha rejected'
    assert minted(regions) == []
    assert listed(regions) == []

    accepted = client.post('/api/network-test/token', json={'captcha_token': 'good '}, headers=KEY)
    assert accepted.status_code == 200
    assert seen == [('bad', '127.0.0.1'), ('good', '127.0.0.1')]
    assert minted(regions) == [BOTH]


def test_refuses_when_no_captcha_is_configured_and_the_opt_out_is_off(monkeypatch, client, regions):
    monkeypatch.delenv('NETWORK_TEST_ALLOW_NO_CAPTCHA')
    response = client.post('/api/network-test/token', json={}, headers=KEY)
    assert response.status_code == 503
    assert response.get_json()['error'] == 'Captcha not configured'
    assert minted(regions) == []


def test_siteverify_failures_count_as_refusals(monkeypatch):

    def post(*args, **kwargs):
        raise nt.requests.exceptions.ConnectionError('down')

    monkeypatch.setattr(nt.requests, 'post', post)
    assert nt.verify_turnstile('token', '1.2.3.4') is False


# --- the config endpoint ------------------------------------------------------

def test_config_lists_the_regions_and_whether_a_captcha_is_required(monkeypatch, client):
    response = client.get('/api/network-test/config', headers=KEY)
    assert response.status_code == 200
    assert response.get_json()['data'] == {'regions': ['eu', 'global'], 'default_region': 'global', 'captcha_required': False}

    monkeypatch.setenv('TURNSTILE_SECRET', 'secret')
    assert client.get('/api/network-test/config', headers=KEY).get_json()['data']['captcha_required'] is True


def test_config_defaults_to_the_first_region_when_global_is_absent(monkeypatch, client):
    monkeypatch.setattr(nt, 'load_regions', lambda: {'us-west': FakeRegion('us-west'), 'eu': FakeRegion('eu')})
    assert client.get('/api/network-test/config', headers=KEY).get_json()['data']['default_region'] == 'eu'


# --- region loading -----------------------------------------------------------

def test_load_regions_prefers_the_json_form(monkeypatch):
    monkeypatch.setenv('NETWORK_TEST_REGIONS', json.dumps({
        'Global': {'space_name': 'a.example', 'project_id': 'p', 'auth_token': 't', 'echo_resource_id': ECHO_RES},
        'eu': {'space_name': 'b.example', 'project_id': 'p2', 'auth_token': 't2', 'echo_resource_id': ECHO_RES,
               'video_room_resource_id': ROOM_RES},
        'broken': {'space_name': 'c.example'},
        'nothing-to-dial': {'space_name': 'd.example', 'project_id': 'p', 'auth_token': 't'},
        'odd': 'not an object',
    }))
    monkeypatch.setenv('SPACE_NAME', 'single.example')
    regions = sw.load_regions()
    assert sorted(regions) == ['eu', 'global']
    assert regions['global'].space_name == 'a.example'
    assert regions['global'].echo_resource_id == ECHO_RES
    assert regions['global'].video_room_resource_id is None
    assert regions['eu'].video_room_resource_id == ROOM_RES
    assert regions['eu'].client().api_base == 'https://b.example/api/fabric'
    assert regions['eu'].client().auth == ('p2', 't2')


def test_load_regions_single_space_form(monkeypatch):
    monkeypatch.delenv('NETWORK_TEST_REGIONS', raising=False)
    monkeypatch.setenv('SPACE_NAME', 'single.example')
    monkeypatch.setenv('PROJECT_ID', 'p')
    monkeypatch.setenv('AUTH_TOKEN', 't')
    monkeypatch.setenv('NETWORK_TEST_ECHO_RESOURCE_ID', f' {ECHO_RES} ')
    monkeypatch.setenv('NETWORK_TEST_VIDEO_ROOM_RESOURCE_ID', '')
    regions = sw.load_regions()
    assert list(regions) == ['global']
    assert regions['global'].echo_resource_id == ECHO_RES
    assert regions['global'].video_room_resource_id is None


def test_a_region_with_neither_resource_is_dropped(monkeypatch):
    monkeypatch.delenv('NETWORK_TEST_REGIONS', raising=False)
    monkeypatch.setenv('SPACE_NAME', 'single.example')
    monkeypatch.setenv('PROJECT_ID', 'p')
    monkeypatch.setenv('AUTH_TOKEN', 't')
    for name in ('NETWORK_TEST_ECHO_RESOURCE_ID', 'NETWORK_TEST_VIDEO_ROOM_RESOURCE_ID'):
        monkeypatch.delenv(name, raising=False)
    assert sw.load_regions() == {}
    monkeypatch.setenv('NETWORK_TEST_VIDEO_ROOM_RESOURCE_ID', ROOM_RES)
    assert list(sw.load_regions()) == ['global']


def test_a_malformed_resource_id_is_ignored(monkeypatch):
    # A pasted address instead of the resource's UUID: logged and treated as
    # unset, so the region is served only if the other resource is fine.
    monkeypatch.setenv('NETWORK_TEST_REGIONS', json.dumps({
        'global': {'space_name': 'a.example', 'project_id': 'p', 'auth_token': 't',
                   'echo_resource_id': '/private/network-test-echo', 'video_room_resource_id': ROOM_RES},
        'eu': {'space_name': 'b.example', 'project_id': 'p', 'auth_token': 't',
               'echo_resource_id': '/private/network-test-echo'},
    }))
    regions = sw.load_regions()
    assert list(regions) == ['global']
    assert regions['global'].echo_resource_id is None
    assert regions['global'].video_room_resource_id == ROOM_RES


def test_load_regions_is_empty_when_nothing_or_nonsense_is_configured(monkeypatch):
    for name in ('NETWORK_TEST_REGIONS', 'SPACE_NAME', 'PROJECT_ID', 'AUTH_TOKEN'):
        monkeypatch.delenv(name, raising=False)
    assert sw.load_regions() == {}
    monkeypatch.setenv('SPACE_NAME', 'single.example')  # the other two missing
    assert sw.load_regions() == {}
    monkeypatch.setenv('NETWORK_TEST_REGIONS', '{not json')
    assert sw.load_regions() == {}
    monkeypatch.setenv('NETWORK_TEST_REGIONS', '["a list"]')
    assert sw.load_regions() == {}


# --- the REST client ----------------------------------------------------------

class FakeResponse:
    def __init__(self, payload, error=None):
        self.payload = payload
        self.error = error
        self.text = json.dumps(payload)

    def raise_for_status(self):
        if self.error:
            raise self.error

    def json(self):
        return self.payload


def test_the_rest_client_requires_every_credential():
    with pytest.raises(ValueError):
        sw.SignalWireClient('space', '', 'token')


def test_resource_addresses_gets_the_listing(monkeypatch):
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse({'data': [ECHO_ADDRESS], 'links': {}})

    monkeypatch.setattr(sw.requests, 'get', get)
    client = sw.SignalWireClient('space.example', 'p', 't')
    assert client.resource_addresses(ECHO_RES) == [ECHO_ADDRESS]
    [(url, kwargs)] = calls
    assert url == f'https://space.example/api/fabric/resources/{ECHO_RES}/addresses'
    assert kwargs['auth'] == ('p', 't')
    assert kwargs['timeout'] == 10


def test_create_guest_token_posts_the_allowed_addresses(monkeypatch):
    calls = []

    def post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse({'token': 'guest-sat', 'refresh_token': 'never-forwarded'})

    monkeypatch.setattr(sw.requests, 'post', post)
    before = int(time.time())
    result = sw.SignalWireClient('space.example', 'p', 't').create_guest_token(['addr-echo', 'addr-room'], 300)
    [(url, kwargs)] = calls
    assert url == 'https://space.example/api/fabric/guests/tokens'
    assert kwargs['auth'] == ('p', 't')
    assert kwargs['timeout'] == 10
    assert kwargs['json']['allowed_addresses'] == ['addr-echo', 'addr-room']
    expire_at = kwargs['json']['expire_at']
    assert before + 300 <= expire_at <= before + 301
    assert result == {
        'token': 'guest-sat',
        'expires_at': datetime.fromtimestamp(expire_at, tz=timezone.utc).isoformat(),
        'expires_in': 300,
    }


def test_rest_failures_are_generic(monkeypatch):
    error = sw.requests.exceptions.HTTPError('422 Client Error')
    error.response = FakeResponse({'errors': [{'code': 'must_belong_to_project', 'message': 'a detail'}]})
    monkeypatch.setattr(sw.requests, 'get', lambda *a, **k: FakeResponse({}, error=error))
    monkeypatch.setattr(sw.requests, 'post', lambda *a, **k: FakeResponse({}, error=error))
    client = sw.SignalWireClient('space.example', 'p', 't')
    with pytest.raises(Exception, match='^Failed to list resource addresses$'):
        client.resource_addresses(ECHO_RES)
    with pytest.raises(Exception, match='^Failed to create guest token$'):
        client.create_guest_token(['addr-echo'], 300)
