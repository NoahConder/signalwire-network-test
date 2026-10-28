# SignalWire Network Test

A one-button connectivity test for WebRTC calling on SignalWire. Open the page, press **Start test**, and in under three minutes it reports whether this browser, on this network, can reach SignalWire the way a call would: signaling, TURN relays over UDP, TCP and TLS, a voice call on Opus and on G.711 μ-law (PCMU) with real bitrate, round-trip, jitter and loss figures, and a video room with and without TURN. The result can be downloaded as JSON or copied as plain text for a support ticket.

Everything runs in the browser with the SignalWire Browser SDK (`@signalwire/js` v4). The small Flask backend only mints a short-lived subscriber token for each run.

This project was carved from the [SignalWire Browser SDK v4 All-In-One Example](https://github.com/NoahConder/V4-Browser-SDK-All-In-One-Example), a web dialer, and keeps its SDK wiring, styling and backend gate.

## What it tests

The steps run in order. Each one is time-boxed and ends as **passed**, **warning**, **failed** or **skipped**, with a one-line result and the measurements behind it (open a row to see them). A signaling failure skips everything after it; any other failure moves on to the next step.

| Step | How it works | Passes when |
|---|---|---|
| **Signaling** | Mints a five-minute subscriber token through the backend, opens the SDK's WebSocket to SignalWire and authenticates. Reads the ICE servers the platform hands the session. | The client is connected and ready within 15 s. Reports the connect time (token request included) and which TURN transports were advertised. A warning means no TURN servers were advertised. |
| **TURN over UDP** | Builds an ICE server from the session's TURN credentials with only the UDP URL. Two peer connections in the page, both restricted to relay candidates, exchange an offer and answer and open a data channel through the relay. A ping goes through it. | A relay was allocated and the data channel opened and echoed the ping within 12 s. Reports allocation time, channel open time, ping round-trip and the relay protocol. A **warning** means a relay was allocated but data didn't pass between the two peers; a **failure** means no relay candidate at all, usually a firewall blocking that transport. |
| **TURN over TCP** | The same check with only the `?transport=tcp` URL: the path a call falls back to where UDP is blocked. | As above. |
| **TURN over TLS** | The same check with a `turns:` URL. | As above. **Skipped** when the platform hands the session no `turns:` URL, which is the normal case today; the row says so. |
| **Voice call (Opus)** | Dials an echo script (see Setup) audio-only with Opus as the only preferred codec, waits for it to connect, then samples `getStats()` and the SDK's `networkMetrics$` once a second for 10 s before hanging up. The echo returns the browser's own audio, so the download figures come from real inbound RTP. The page measures that audio but doesn't play it, so the tester doesn't hear themselves and there's no feedback. | Connected within 15 s, audio came back, and Opus was negotiated. Reports upload and download kbps from byte counters, the bandwidth estimate, average and maximum RTT, jitter, loss (over the call and its worst second), the ICE path (`host`, `srflx` or `relay`, and over what), and the SDK's MOS estimate. A **warning** means the microphone was unavailable and the call was measured receive-only. |
| **Voice call (PCMU)** | The same call with PCMU preferred, the codec of calls to and from phone numbers. | As above, with PCMU negotiated. |
| **Video room through TURN** | Joins a video room with audio and camera, with the SDK's relay-only mode on (`iceTransportPolicy: 'relay'`), and samples for 8 s. The camera prompt appears here, not earlier. | Connected and the selected candidate pair is a relay. Reports video codecs, video bitrates and video packet loss, RTT, jitter and the path. |
| **Video room, direct** | The same with the default media path. | Connected with a selected candidate pair. |

The two video steps are skipped when no room is configured for the region. Nothing is requested or connected until **Start test** is pressed, and the page disconnects when the run ends.

What the numbers mean, and don't:

- **Bitrates are the codec's, not your link's capacity.** A voice call sends what its codec needs: PCMU a steady 64 kbps, Opus up to 30 kbps on average (the platform's media server caps it with `maxaveragebitrate=30000`), and well under that in quiet moments, since Opus spends bits only on sound. The figures count the media payload, not packet headers. The bandwidth estimate (`availableOutgoingBitrate`) is the browser's congestion-control estimate on that connection, also not a speed test.
- **RTT is to the media server**, measured on the candidate pair of the transport carrying audio, not to the far end of a real call. Video calls open a separate transport for video, whose first seconds read high while keyframes go out.
- **The first seconds are a warm-up.** The bitrates and RTT leave out the first second of a voice call and the first three of a video call, when inbound video hasn't started and the browser is still ramping up its send rate. Loss still counts them. The report's per-second `series` keeps every second and marks the warm-up ones.
- **MOS is an estimate** the SDK computes from RTT, jitter and loss (an E-model score from 1 to 5).
- **A TURN warning is ambiguous by design.** The relay check needs the platform's TURN server to relay between two allocations from the same browser; if it doesn't, the step can only prove the allocation.

## Setup

### Prerequisites

- Node.js 20.19+ and npm (Vite 8 requires it; the devcontainer provides it)
- Python 3 (the devcontainer uses 3.12)
- A SignalWire space, with a Project ID and an API token from its Dashboard (the token needs the **Voice** scope; it only mints subscriber tokens)
- A browser with WebRTC support. The page must be served over HTTPS (or from `localhost`) for microphone and camera access.

### 1. The echo script

The voice steps dial a SWML script that answers and echoes the caller's audio back. Create a SWML script resource in your space (Dashboard → Resources → Add → Script → SWML, or the Fabric REST API) named `network-test-echo` with:

```json
{
  "version": "1.0.0",
  "sections": {
    "main": [
      { "answer": {} },
      { "echo": { "timeout": 20 } },
      { "hangup": {} }
    ]
  }
}
```

Its Fabric address (shown on the resource, for example `/private/network-test-echo`) is the echo address below. A run's two voice calls last about 12 s each; `timeout` must stay longer than that.

### 2. Optional: a video room

For the two video steps, create a video room (Dashboard → Resources → Add → Video Room) and note its address, for example `/public/network-test-room`. Without one those steps are skipped.

### 3. Backend

```bash
# From the repo root
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
cp backend/.env.example backend/.env    # then edit it
cd backend && python app.py             # :5001
```

### 4. Frontend

```bash
cd frontend
npm install
npm run dev                             # :5173, proxies /api to :5001
```

Open http://localhost:5173. `?region=<name>` preselects a region.

## Configuration

`backend/.env` is the only env file. `vite.config.ts` reads it too, so restart `npm run dev` (or rebuild) after changing a variable marked *bundle*.

| Variable | Purpose |
|---|---|
| `NETWORK_TEST_API_KEY` | Required. Every `/api` route checks it (`X-API-Key`) and fails closed with 503 when it's unset. *Bundle*: it ships in the page, so it is a bot deterrent paired with the rate limit and the captcha, not a secret. |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key. *Bundle*: shows the captcha widget. |
| `TURNSTILE_SECRET` | Turnstile secret. When set, every token request must carry a valid captcha token (`siteverify`). |
| `NETWORK_TEST_ALLOW_NO_CAPTCHA` | `true` lets the token endpoint run without a captcha. Local development only: without either this or `TURNSTILE_SECRET` the token endpoint answers 503. |
| `NETWORK_TEST_REGIONS` | One JSON object keyed by region name, each with `space_name`, `project_id`, `auth_token`, `echo_address` and optionally `video_room_address`. The page offers the keys; `global` is the default. |
| `SPACE_NAME`, `PROJECT_ID`, `AUTH_TOKEN`, `NETWORK_TEST_ECHO_ADDRESS`, `NETWORK_TEST_VIDEO_ROOM_ADDRESS` | The single-space alternative to `NETWORK_TEST_REGIONS`: they become the `global` region. `SPACE_NAME` is the full hostname (`example.signalwire.com`). Ignored when `NETWORK_TEST_REGIONS` is set. |
| `NETWORK_TEST_SUBSCRIBER_REFERENCE` | The subscriber every run's token belongs to. SignalWire creates one per reference on the first mint, and subscribers are billed per month; set this to an existing subscriber's email to reuse it. Default `network-test`. |
| `PORT` | Backend port (default 5001). |
| `FRONTEND_URL` | The page's origin when it isn't served through the Vite proxy (CORS); its hostname also joins Vite's allowed hosts for tunneled development. |
| `FLASK_DEBUG` | Leave it off: the Werkzeug debugger allows code execution and the server listens on all interfaces. |

Each region's API token belongs to the project that pays for the test calls. Use a dedicated project with a prepaid balance and an API token scoped to Voice only.

### Backend API

| Route | Purpose |
|---|---|
| `GET /api/network-test/config` | The regions, the default and whether a captcha is required. 30 per minute per IP. |
| `POST /api/network-test/token` | `{"region", "captcha_token"}` → a five-minute subscriber token (for `NETWORK_TEST_SUBSCRIBER_REFERENCE`, default `network-test`), plus the region's echo and room addresses. 5 per 10 minutes per IP. |
| `GET /health` | The configured regions, whether the API key is set and the captcha mode. |

## Deploying

1. Build the page: `cd frontend && npm ci && npm run build`. The output in `frontend/dist/` is static. `NETWORK_TEST_API_KEY` and `TURNSTILE_SITE_KEY` are baked in at build time.
2. Run the backend behind a WSGI server, for example `gunicorn -w 1 -b 127.0.0.1:5001 app:app` from `backend/`. The rate limit is in memory, per worker: with more than one worker, or more than one instance, enforce a limit at the edge too.
3. Serve `dist/` and reverse-proxy `/api` to the backend on one HTTPS origin. If they're on different origins, set `FRONTEND_URL` to the page's origin for CORS.
4. Set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` and leave `NETWORK_TEST_ALLOW_NO_CAPTCHA` unset. Add the page's hostname to the Turnstile widget's allowed domains.
5. Check `GET /health`: it answers 200 only when a region, the API key and the captcha are all configured.

## The report

**Download report** saves `signalwire-network-test-<time>.json`:

| Key | Contents |
|---|---|
| `format` | `signalwire-network-test/1` |
| `generatedAt`, `page`, `browser` | When, the page and SDK versions, the page URL, the user agent and language |
| `run` | The run: region, status, start and finish times, and every step with its status, one-line result, measurements and duration. The call steps also carry `series`: one entry per second with upload and download kbps, loss, RTT and jitter. |
| `events` | The event log as text lines |
| `diagnostics` | The SDK's `client.exportDiagnostics()`, kept from the run's session |
| `rtcstats`, `rtcstatsDump` | The run's full WebRTC recording (see below) and its size |

**Download WebRTC trace** saves the same recording on its own as `signalwire-network-test-<time>.rtcstats`. Both cover only the run on screen, and both are held only in the page: download them before reloading or starting another run. The recording is made by [rtcstats-js](https://github.com/rtcstats/rtcstats/tree/main/packages/rtcstats-js) (MIT), which wraps the browser's `RTCPeerConnection`, `getUserMedia` and `enumerateDevices`: every peer connection the page creates (the SDK's calls and the TURN checks) with every API call and event, its SDP and ICE candidates, and `getStats()` once a second. The file is an rtcstats dump, the format rtcstats' dump importer opens alongside `chrome://webrtc-internals` dumps, and it works in every browser, not only Chrome. rtcstats-js normally streams to a server; here nothing is sent anywhere. The recording stays in the page and leaves the browser only when the tester downloads it.

**What the downloads contain.** TURN credentials never appear: the steps record TURN URLs only, and rtcstats-js removes the credential from the configurations it records. Both downloads do contain the tester's IP addresses (in the ICE candidates and SDP), the names of their microphones, cameras and speakers, and hardware hints (CPU count, memory, screen size). Share them with that in mind.

**Copy summary** puts a plain-text version (one line per step) on the clipboard.

## Development

```bash
cd frontend
npm run lint
npm run build          # tsc + vite build
npm test               # Playwright, phone and desktop viewports; no credentials needed

# From the repo root, venv active
pip install -r backend/requirements-dev.txt
python -m pytest backend/tests
```

The Playwright suite opens the page with `?e2e=1`, a dev-server-only switch that keeps the page off the token endpoint, and replaces the runner's step functions with stubs. It checks the row states, that a signaling failure stops the run, Stop, the report's keys, the summary, focus order and labels. The step functions themselves need a real run against a space.

```text
backend/
  app.py                     Flask app, /health
  api/network_test.py        /api/network-test/config and /token, the Turnstile check
  utils/security.py          gate(): the API key and the per-IP rate limit
  utils/signalwire.py        regions from the environment, subscriber token minting
  tests/                     pytest
frontend/src/
  services/networkTest.ts    the runner and every step
  services/signalwire.ts     the SDK client: connect, ICE servers, dial, getStats(), event log
  services/api.ts            backend requests and their error copy
  services/diagnostics.ts    the report and the summary
  services/captcha.ts        Turnstile loader
  components/NetworkTest.tsx the page
  components/StepRow.tsx     one step's row and details
  components/EventLog.tsx    the live event log
frontend/e2e/                Playwright specs
```

## Security

- The backend holds each region's API token and mints call-capable subscriber tokens. The token endpoint is gated three ways: the API key, a per-IP limit of 5 requests per 10 minutes, and the Turnstile captcha in production. Tokens expire after five minutes and all belong to one subscriber (`network-test` unless `NETWORK_TEST_SUBSCRIBER_REFERENCE` names another), which is never registered for incoming calls.
- Error responses are generic; details go to the server log only.
- In development both servers listen on all interfaces (Flask on `0.0.0.0`, Vite with `host: true`). To test from a phone, use an HTTPS tunnel, set `FRONTEND_URL` to it, and close it when you're done.

## Technology

Frontend: React 18, TypeScript, Vite 8, Tailwind CSS 4, `@signalwire/js` 4.0.0-rc.5, RxJS, lucide-react. Backend: Flask, Flask-CORS, requests, python-dotenv.
