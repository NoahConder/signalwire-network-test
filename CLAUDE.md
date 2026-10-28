# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A one-button WebRTC network test for SignalWire, carved from the public V4 Browser SDK All-In-One Example (github.com/NoahConder/V4-Browser-SDK-All-In-One-Example; this repo starts from one squashed commit, so fixes there are ported by hand). Two services:

- `backend/` — Flask on port **5001**. Mints a five-minute subscriber token per run and serves the page's configuration. It does **not** touch media or signaling.
- `frontend/` — Vite + React + TypeScript on port **5173**. One page. All WebRTC goes through the published npm package `@signalwire/js` (`^4.0.0-rc.5`; npm's `latest`/`rc` tag, there is no stable 4.0.0), resolved from `node_modules`. To read SDK internals, read `node_modules/@signalwire/js/dist/index.mjs` or clone `signalwire-js` at the matching tag. Never edit the SDK from here.

`README.md` is for whoever deploys and uses the page (what each step does, setup, configuration, deploying). There is no changelog; the git log is the history. This file is for working on the code.

## Rules

- The frontend never stores or caches tokens; the SDK calls the `credentialProvider` callbacks on demand. (Token source)
- Every `/api` route goes through `gate()`. Token minting is never open: the API key fails closed, and without `TURNSTILE_SECRET` the token endpoint refuses unless `NETWORK_TEST_ALLOW_NO_CAPTCHA=true`. (Backend)
- The runner's step functions stay instance members (`networkTestRunner.steps`): the Playwright suite replaces them. (The runner)
- A signaling failure skips the remaining steps; no other failure does. (The runner)
- The runner restores the SDK preferences it found and disconnects at the end of every run, stopped or not. (The runner)
- The camera is requested by the video steps only, the microphone by the voice steps only; nothing is requested or connected before Start. (The runner)
- Never call `client.connect()` on the SDK client: its constructor already connects, and a second connect mints a second token against the 5-per-10-minutes limit. (The runner)
- The report never carries TURN credentials: steps record URLs only. (The report)
- The WebRTC trace is recorded and kept in the browser only; never add an upload or a server for it. `services/rtcTrace` stays the first import in `main.tsx`, its buffer is never cleared or thinned, and a dump is scoped by whole connection, never by time alone. (The WebRTC trace)
- Upgrade rtcstats-js and rtcstats-shared together, to releases at least two weeks old, through the checklist. (Upgrading rtcstats)
- No bare `console.*`; use `utils/log.ts`. (Conventions)
- Never use the bare word `container` anywhere in `frontend/src`, comments included. (Styling)
- Colors, fonts and radii come from the semantic tokens in `globals.css` (`bg-surface`, `text-muted`, `border-edge`, `bg-accent`, `font-display`, `font-mono`, …); no raw palette utilities (`bg-white/x`, `text-gray-x`, `emerald-*`, …) in components. (Styling)
- The theme default is `dark`. (Styling)
- Preserve each file's line endings; the files inherited from the example are CRLF. (Conventions)
- Change frontend dependencies with `npx npm@11 install ...`, not npm 10. (Environment)
- Failed backend requests get their copy from `describeFetchError` in `services/api.ts`, not `err.message`. (Conventions)
- Changes to a step function need a real run against a space; the e2e suite drives stubs. (Testing)
- README edits stay audience-facing: no ticket numbers, customer names or internal links. (Conventions)

## Commands

Activate the venv at the repo root before running Python: `source venv/bin/activate`.

```bash
# Backend (from repo root)
source venv/bin/activate
cd backend && python app.py            # dev server on :5001

# Frontend
cd frontend
npm install
npm run dev                            # Vite dev server on :5173 (proxies /api → :5001)
npm run build                          # tsc + vite build
npm run lint                           # eslint
npm test                               # Playwright, phone + desktop projects (no credentials needed)

# Backend tests (from repo root, venv active; install requirements-dev.txt once)
pip install -r backend/requirements-dev.txt
python -m pytest backend/tests
```

## Environment

`backend/.env` is the only env file (`backend/.env.example` documents every variable). `vite.config.ts` loads it as well: `FRONTEND_URL`'s hostname goes into `allowedHosts`, and `NETWORK_TEST_API_KEY` and `TURNSTILE_SITE_KEY` are baked into the bundle via `define` (as `VITE_NETWORK_TEST_API_KEY` and `VITE_TURNSTILE_SITE_KEY`). A variable set in the process environment overrides the file, for Vite and for Flask (`load_dotenv` doesn't override). Restart `npm run dev` after changing a bundled variable.

Regions: `NETWORK_TEST_REGIONS` (JSON keyed by region name) wins; otherwise `SPACE_NAME`/`PROJECT_ID`/`AUTH_TOKEN` plus `NETWORK_TEST_ECHO_ADDRESS`/`NETWORK_TEST_VIDEO_ROOM_ADDRESS` become `global`. A region missing a credential is dropped with a log line, not served half-configured.

Vite 8 requires Node 20.19+. npm 10.8.x (what the devcontainer ships) crashes with `Cannot read properties of null (reading 'edgesOut')` when *changing* frontend dependencies; run those installs with `npx npm@11 install ...`. npm 11 rewrites `package-lock.json` with LF endings: convert it back to CRLF before committing.

Devcontainer quirks:
- Playwright's Chromium needs system libraries the image lacks (`libatk-1.0.so.0` and others). Install them once with `sudo env "PATH=$PATH" npx playwright install-deps chromium` from `frontend/`, as CI does with `--with-deps`. Run the suite with `npm test` (the local CLI); `npx playwright` can resolve a different Playwright and fail with "two different versions of @playwright/test".
- `pkill -f 'vite'` matches and kills the shell running it; use `pkill -f 'vit[e] --host'`.
- There is no `file` command. Check a file's line endings with `grep -c $'\r' <file>` (0 means LF).
- Scripted edits of CRLF files must open them with `newline=''` (Python) or the equivalent; a text-mode read/write silently converts the whole file to LF.

## Testing

`cd frontend && npm test` runs `frontend/e2e/` on the `phone` (390×844, touch) and `desktop` (1280×800) projects against the Vite dev server (`playwright.config.ts` starts or reuses it). No credentials: pages open with `?e2e=1`, a dev-server-only switch in `NetworkTest.tsx` (`E2E_SEAM`, gated on `import.meta.env.DEV`) under which the page never calls the token endpoint. Tests answer `GET /api/network-test/config` with `page.route` and replace the runner's step functions through `page.evaluate(import('/src/services/networkTest.ts'))` (`e2e/helpers.ts`: `openPage`, `evalInApp`, `stubSteps`, `PASSING_OUTCOMES`; a `null` outcome is a step that never resolves, for Stop). Specs: `stats` (`figuresFrom` on fixed samples: per-second loss and the worst second, loss that steps back, video loss, the warm-up left out of bitrates and RTT but not loss and the short-window fallback; RTT and path from the audio transport when video has its own; the WebRTC trace parsed with rtcstats' own reader, recording a page peer connection without its TURN credential, and scoped to each run with true timestamps), `network-test` (idle state and `?region=`, a passing run and the report's keys, signaling failure stops the run, later failures don't, warnings, Copy summary, Stop and a clean second run, the config error and Retry, a captcha the page can't show) and `a11y` (landmarks, labels, the dark default and the toggle, the live run status, each row's spoken state and its disclosure, focus order).

The dev server runs React in StrictMode, which mounts effects twice: the page's config fetch fires twice and keeps the second, so a `page.route` stub meant to fail "once" is consumed by the discarded first request. Stub by a flag the test flips (the config Retry test). Under software rendering in a GPU-less container every step of a run takes seconds even when stubbed; a test that does a full run plus many key presses is marked `test.slow()`.

Backend: `python -m pytest backend/tests`. `test_network_test.py` drives the Flask test client with fakes bound into `api.network_test`'s namespace (`monkeypatch.setattr(nt, 'load_regions', ...)`, `verify_turnstile`), resetting `utils.security._buckets` per test: the gate, the rate limit, the captcha modes, regions, the token's TTL and payload, and region loading from the environment.

CI (`.github/workflows/ci.yml`): `npm ci`, lint, `tsc --noEmit`, build, Playwright (Chromium with deps; traces uploaded on failure), then `py_compile` and pytest.

The e2e suite drives stubs. A change to a step function, to `signalwire.ts`'s connect/dial/stats code or to the token flow needs a real run against a space: start both servers with `NETWORK_TEST_ALLOW_NO_CAPTCHA=true` and an echo address, open the page, press Start, and read the rows and the report.

## Architecture notes

### The runner (`services/networkTest.ts`)
`networkTestRunner.start({ region, fetchToken })` walks `STEPS` in order, publishing a `TestRun` on `getRun$()` (a `BehaviorSubject`) after every change; `NetworkTest.tsx` renders it. Each step is a `StepFunction(ctx) → StepOutcome` in `runner.steps`, wrapped in `withTimeout` with its `STEP_TIMEOUT` (the call steps allow 90 s, enough for a permission prompt, which the SDK waits on inside `dial()`), and an exception becomes `failed` with the error as the result. `RunContext` carries what signaling learned (the ICE servers, the echo and room addresses from the token response) to the later steps. `stop()` aborts the run's `AbortController` (every `withTimeout`/`sleep` rejects with `StepAbortedError`, recorded as `skipped: Stopped`) and hangs up the current call. After the last step the runner hangs up, restores the preferences read after signaling, and disconnects.

- **Signaling** is `signalWireService.connect(fetchToken)`: a fresh `new SignalWire(credentialProvider, { skipRegister: true })` per run. The constructor connects by itself (rc.5 runs `init()`: authenticate, fetch the user, open the WebSocket, then register unless `skipRegister`), so the service never calls `client.connect()`; doing so tears the session down and connects again, minting a second token. The step waits for `ready$` or a failed token request, whichever comes first; the connect time runs from construction and includes the token request. No `reconnectAttachedCalls`. On failure the result is the token request's own message when that's what failed (`getLastTokenError()`), so a 429 or a captcha refusal reads as itself.
- **ICE servers** come from `client.session.iceServers`: what the platform returned in the authentication response (`ice_servers`), one entry with the TURN username and credential and a URL list. `iceServerForTransport()` splits it by URL: `turn:` (or `?transport=udp`) is UDP, `?transport=tcp` TCP, `turns:` TLS. At the time of writing the platform hands out a UDP and a TCP URL and no `turns:`, so the TLS row is normally skipped and says why.
- **TURN steps** (`checkTurnRelay`) don't use the SDK: two `RTCPeerConnection`s with `iceTransportPolicy: 'relay'` and the one-transport server, offer/answer and trickled candidates exchanged in-page, a data channel and a ping. Relay allocated + channel open + ping = passed; allocated but no channel = warning (the relay between two allocations of one browser isn't guaranteed); no relay candidate = failed. `relayProtocol` comes from the candidate and then from `getStats()`'s local candidate.
- **Voice steps** set `preferences.preferredAudioCodecs` to the one codec (and pass it on `dial()` too) with `relayOnly` off, dial `<echo address>?channel=audio`, wait for `connected` (15 s), sample for 10 s, hang up. Passing needs inbound audio bytes and the requested codec on the inbound RTP. A microphone the SDK couldn't open (it then carries on receive-only and reports it on `call.errors$`) turns a pass into a warning.
- **Video steps** set `relayOnly` (on for "through TURN", off for "direct") and `preferredAudioCodecs: []`, dial `<room>?channel=video` with audio, video and `receiveVideo`, sample for 8 s. "Through TURN" fails unless the selected pair's local candidate is a relay.
- **Figures** (`figuresFrom(samples, kind, warmupMs)`): the warm-up (`WARMUP_MS`: 1 s voice, 3 s video, so the video window of 8 s keeps 5 steady seconds; inbound video starts between seconds 2 and 3 on real calls) is left out of the bitrates and RTT but not the loss; when nothing would be left after it, the whole window is used and `warmupMs` reports 0. Bitrates from the byte counters of the step's media kind between the first sample after the warm-up and the last (and per interval for `series`, whose points carry `warmup`: true for every second up to the first steady sample), RTT per sample from the selected pair of the transport carrying audio (`getConnectionStats` finds it through the audio RTP stream's `transportId`; the SDK's `bundlePolicy: 'max-compat'` gives video its own transport, which read 230-250 ms in its first second on real calls), falling back to the SDK's `roundTripTime`, jitter from the SDK's samples (already ms), loss from the inbound counters of the step's media kind (audio on voice steps, video on video steps; `audioLossPct` alongside) over the window and per one-second interval (`worstSecondLossPct`; a negative `packetsLost` delta counts as none lost), the bandwidth estimate from the SDK's last `availableOutgoingBitrate`, MOS from `qualityScore$`. Opus runs well under its 30 kbps cap (the media server's `maxaveragebitrate=30000`) when the input is quiet; that is the codec, not a fault.

Why not `client.preflight()`: its signaling RTT is a hard-coded 0, its device phase prompts for the camera, its "download" figure copies upload, and it ignores `relayOnly`/`disableUdpIceServers` (rc.5's `PreflightRunner`).

### Token source
`POST /api/network-test/token` mints for `token_reference()` (`NETWORK_TEST_SUBSCRIBER_REFERENCE`, default `network-test`; SignalWire creates a subscriber per new reference, and subscribers are billed monthly, so a test space should name an existing one) with a 300 s TTL (`TOKEN_TTL_S`); the response adds `region`, `echo_address` and `video_room_address`. The page passes a fetcher into `signalWireService.connect()`, which hands it to the SDK as both `authenticate` and `refresh`; the token goes straight to the SDK and isn't kept. A run ends well before the SDK's refresh point (about 80% of the TTL). A Turnstile token is single-use, so the page clears it at Start and resets the widget after the run; a refresh would carry no captcha token and be refused in production, which is acceptable for a five-minute token.

### Backend
`utils/security.gate(request, scope, limit, window_sec)` checks `X-API-Key` against `NETWORK_TEST_API_KEY` (503 when unset, 401 when wrong) and applies a per-IP sliding window keyed by scope: `network-test` (the token, 5 per 600 s) and `network-test-config` (30 per minute). The limiter is in memory and per worker. `captcha_mode()` is `turnstile` (secret set), `disabled` (`NETWORK_TEST_ALLOW_NO_CAPTCHA=true`) or `unconfigured`, which refuses tokens with 503. `verify_turnstile` treats any network or parse failure as a refusal. `utils/signalwire.SignalWireClient(space, project, token)` is built per request from the chosen `Region`; every `requests` call has a 10 s timeout, and error bodies are generic.

### The page
`NetworkTest.tsx` loads the config (regions, default, `captcha_required`; Retry on failure), preselects `?region=` when it's a known region, renders the Turnstile widget when the backend wants one and the bundle has a site key (and an error when it wants one the bundle can't show), and subscribes to the run. Rows are `StepRow.tsx`: a disclosure button whose accessible name includes a visually hidden status, with the measurements in a `dl`. The run status line is the first `role=status` `aria-live=polite` element (the specs read it). The event log (`EventLog.tsx`) and the report both read `signalWireService.getEventLog$()` (a `ReplaySubject(500)`; the runner logs through `logEvent`). From 1024px wide the log sits in a column beside the steps (`useMediaQuery`). Remote media is attached to one muted `<audio id="sw-remote-audio">` so the echo is received and measured without feedback; `watchPeerConnection` also picks up tracks from the peer connection, since `remoteStream$` isn't always reliable. `App.tsx` disconnects on `beforeunload`.

### The report (`services/diagnostics.ts`)
`buildReport(run, events)`: `format` (`signalwire-network-test/1`), `generatedAt`, `page` (version from `package.json` via `VITE_APP_VERSION`, SDK version, URL), `browser`, `run`, `events` (text lines), `diagnostics` (`client.exportDiagnostics()`, `null` without a session, as in e2e mode, or once the run has disconnected). The steps' `details` carry TURN URLs only, never the username or credential; keep it that way. `summarizeRun` is the plain-text version for Copy summary. The report also carries `rtcstats` (entry count, truncated flag) and `rtcstatsDump` (below), and each call step's `series` (`SeriesPoint[]`, one per second, not shown in the row).

### The WebRTC trace (`services/rtcTrace.ts`)
rtcstats-js 2.5.0 (`@rtcstats/rtcstats-shared` held at 2.6.2 by `overrides` in `package.json`) wraps `RTCPeerConnection`, `getUserMedia` and `enumerateDevices` and records every call, event and a delta-compressed `getStats()` per second into an in-memory buffer, in rtcstats-js's own message shape. Nothing is uploaded: rtcstats-js's WebSocket trace and rtcstats-server aren't used, and the data leaves the browser only as a download. `main.tsx` imports it first, so the wrap is in place before anything creates a peer connection (the SDK reads the global `RTCPeerConnection` each time it makes one).

Each entry keeps its absolute time, its method and its connection id, with the message pre-serialized. `getRtcStatsDump(since, until)` writes an rtcstats dump (`RTCStatsDump` line, metadata JSON line with `startTime`/`endTime`, one message per line ending in the gap since the previous line, the first absolute) holding the hardware entry, the entries up to `until` of the connections created in the window, and client-level entries (devices, permissions) in the window. The report and the trace download pass the run's `startedAt` and `finishedAt`, so each covers its own run and nothing that happens between the end and the download (a device check 104 s after a run showed up before the end bound). Scoping is by whole connection, never by time alone: getStats entries are deltas against the same connection's previous sample (rtcstats-js keeps that state, and its stats id map, per connection), and the importer rejects a whole file whose first sample of a connection is a delta. That works because every run makes fresh connections and closes them all before it ends. The buffer itself is never cleared or thinned; it stops at 50,000 entries (`truncated` in the metadata) rather than dropping some. The `stats` spec parses the download with rtcstats-shared's `readRTCStatsDump` and checks a pre-run connection is left out, two runs on one page load each get only their own, the rebuilt timestamps are right, and activity after the run ends stays out. `rtcstats.d.ts` declares the few exports used (the packages ship no types).

### Upgrading rtcstats
rtcstats-js is pinned exactly and its shared package by an override, so `npm install` never moves them. Upgrade both together, to releases at least two weeks old, with `npx npm@11 install @rtcstats/rtcstats-js@<x.y.z>` and the matching `@rtcstats/rtcstats-shared` in `overrides` (the release published alongside it). Then:
1. Compare `PROTOCOL_VERSION` in `node_modules/@rtcstats/rtcstats-js/trace-websocket.js` with `CLIENT_PROTOCOL` in `rtcTrace.ts`, and the message shape of its `WebSocketTrace` (`[method, connection, value, ...extra, time delta]`, the method through `compressMethod`) with `trace` there. Both are copied by hand; a mismatch still builds but writes a file the importer misreads.
2. Check the signatures in `src/types/rtcstats.d.ts` against the new exports, and that `copyAndSanitizeConfig` in rtcstats-shared still deletes `credential`.
3. Run `npm test` (the `stats` spec parses a trace with the new reader) and one real run, then parse its report's `rtcstatsDump` with `readRTCStatsDump`.
4. Convert `package.json` and `package-lock.json` back to CRLF.

## Conventions

- Backend request failures are described by `describeFetchError` (429 run limit, 403 captcha, 401 key, 503 configuration with the server's message, 500 minting, 502/504/no response "Backend unreachable").
- App logging goes through `frontend/src/utils/log.ts`: `debug`/`info` print with `?debug` or localStorage `network_test_debug=1`, `warn`/`error` always. The SDK's own log level is set on the client (`warn`).
- Line endings are mixed and there's no `.gitattributes`. CRLF: the files inherited from the example — `signalwire.ts`, `api.ts`, `App.tsx`, `main.tsx`, `ErrorBoundary.tsx`, `types/index.ts`, `globals.css`, `index.html`, `package.json`, `package-lock.json`, the Vite/Tailwind/PostCSS/tsconfig/eslint configs, `backend/app.py`, `utils/signalwire.py`, `requirements.txt`. New files are LF, as are the docs and `.env.example`.
- Docs have audiences. `README.md` is for deployers and users; this file is for working on the code. When behavior changes, update the README's step table if a user would notice.
