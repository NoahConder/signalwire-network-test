"""The token endpoint is the security boundary of this backend: it mints
call-capable SignalWire tokens, so the API-key gate must fail closed, the
captcha must be enforced unless the deployment opted out, the rate limit is
tight, and only a configured region is served.

Nothing here talks to SignalWire or Cloudflare: the REST client and the
Turnstile check are replaced by fakes bound into api.network_test's namespace.
"""
import json
from collections import defaultdict, deque

import pytest

import api.network_test as nt
import utils.security as security
import utils.signalwire as sw
from app import app

KEY = {'X-API-Key': 'test-key'}


class FakeSignalWire:
    def __init__(self, fail_with=None):
        self.minted = []
        self.fail_with = fail_with

    def create_subscriber_token(self, reference, expires_in):
        if self.fail_with:
            raise self.fail_with
        self.minted.append((reference, expires_in))
        return {'token': 'sat-token', 'expires_at': '2026-01-01T00:05:00+00:00', 'expires_in': expires_in}


class FakeRegion:
    def __init__(self, name, echo_address='/public/network-test-echo', video_room_address=None, fake=None):
        self.name = name
        self.echo_address = echo_address
        self.video_room_address = video_room_address
        self.fake = fake or FakeSignalWire()

    def client(self):
        return self.fake


@pytest.fixture
def regions(monkeypatch):
    configured = {
        'global': FakeRegion('global', video_room_address='/public/network-test-room'),
        'eu': FakeRegion('eu'),
    }
    monkeypatch.setattr(nt, 'load_regions', lambda: configured)
    return configured


@pytest.fixture
def client(monkeypatch, regions):
    monkeypatch.setenv('NETWORK_TEST_API_KEY', 'test-key')
    monkeypatch.delenv('TURNSTILE_SECRET', raising=False)
    monkeypatch.setenv('NETWORK_TEST_ALLOW_NO_CAPTCHA', 'true')
    monkeypatch.delenv('NETWORK_TEST_SUBSCRIBER_REFERENCE', raising=False)
    # Fresh rate-limit buckets per test.
    monkeypatch.setattr(security, '_buckets', defaultdict(deque))
    app.config['TESTING'] = True
    return app.test_client()


def minted(regions, name='global'):
    return regions[name].fake.minted


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
    assert data['echo_address'] == '/public/network-test-echo'
    assert data['video_room_address'] == '/public/network-test-room'
    assert minted(regions) == [('network-test', 300)]


def test_the_subscriber_reference_can_name_an_existing_subscriber(monkeypatch, client, regions):
    monkeypatch.setenv('NETWORK_TEST_SUBSCRIBER_REFERENCE', '  someone@example.com ')
    assert client.post('/api/network-test/token', json={}, headers=KEY).status_code == 200
    monkeypatch.setenv('NETWORK_TEST_SUBSCRIBER_REFERENCE', '')
    assert client.post('/api/network-test/token', json={}, headers=KEY).status_code == 200
    assert minted(regions) == [('someone@example.com', 300), ('network-test', 300)]


def test_picks_the_requested_region(client, regions):
    response = client.post('/api/network-test/token', json={'region': 'EU'}, headers=KEY)
    assert response.status_code == 200
    data = response.get_json()['data']
    assert data['region'] == 'eu'
    assert data['video_room_address'] is None
    assert minted(regions, 'eu') == [('network-test', 300)]
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

    accepted = client.post('/api/network-test/token', json={'captcha_token': 'good '}, headers=KEY)
    assert accepted.status_code == 200
    assert seen == [('bad', '127.0.0.1'), ('good', '127.0.0.1')]
    assert minted(regions) == [('network-test', 300)]


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
        'Global': {'space_name': 'a.example', 'project_id': 'p', 'auth_token': 't', 'echo_address': '/public/echo'},
        'eu': {'space_name': 'b.example', 'project_id': 'p2', 'auth_token': 't2', 'echo_address': '/public/echo',
               'video_room_address': '/public/room'},
        'broken': {'space_name': 'c.example'},
        'odd': 'not an object',
    }))
    monkeypatch.setenv('SPACE_NAME', 'single.example')
    regions = sw.load_regions()
    assert sorted(regions) == ['eu', 'global']
    assert regions['global'].space_name == 'a.example'
    assert regions['global'].video_room_address is None
    assert regions['eu'].video_room_address == '/public/room'
    assert regions['eu'].client().api_base == 'https://b.example/api/fabric'
    assert regions['eu'].client().auth == ('p2', 't2')


def test_load_regions_single_space_form(monkeypatch):
    monkeypatch.delenv('NETWORK_TEST_REGIONS', raising=False)
    monkeypatch.setenv('SPACE_NAME', 'single.example')
    monkeypatch.setenv('PROJECT_ID', 'p')
    monkeypatch.setenv('AUTH_TOKEN', 't')
    monkeypatch.setenv('NETWORK_TEST_ECHO_ADDRESS', '/public/echo')
    monkeypatch.setenv('NETWORK_TEST_VIDEO_ROOM_ADDRESS', '')
    regions = sw.load_regions()
    assert list(regions) == ['global']
    assert regions['global'].echo_address == '/public/echo'
    assert regions['global'].video_room_address is None


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


def test_the_rest_client_requires_every_credential():
    with pytest.raises(ValueError):
        sw.SignalWireClient('space', '', 'token')
