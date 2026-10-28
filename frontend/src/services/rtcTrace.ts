import { wrapEnumerateDevices, wrapGetUserMedia, wrapRTCPeerConnection } from '@rtcstats/rtcstats-js';
import { compressMethod } from '@rtcstats/rtcstats-shared';

// A full WebRTC recording of the page, kept in memory: rtcstats-js wraps
// RTCPeerConnection, getUserMedia and enumerateDevices and records every API
// call and event plus a delta-compressed getStats() every second, for every
// peer connection (the SDK's calls and the TURN checks alike). rtcstats-js
// normally streams this to an rtcstats-server; here the same messages are
// kept in the page and saved as an rtcstats dump file, which rtcstats'
// dump importer opens like a webrtc-internals dump. Nothing leaves the
// browser unless the tester downloads it.
//
// Imported first in main.tsx: only peer connections created after the wrap
// are recorded. The SDK looks up the global RTCPeerConnection each time it
// builds one, so wrapping at load covers every call.
//
// A dump covers one run: getRtcStatsDump(since, until) keeps the connections
// created at or after `since` (every run makes fresh connections and closes them
// all before it ends) and the device entries from then on, up to `until`, the
// run's end, so device activity between the end and the download stays out.
// Connections are chosen whole from their start, never from a time window:
// getStats entries are deltas against the same connection's previous sample
// (rtcstats-js keeps that state per connection), and the importer rejects a
// whole file whose first sample of a connection is a delta. Cutting a
// connection's tail at `until` is safe; its earlier samples keep their
// baselines. The buffer itself is never cleared or thinned.

// rtcstats-js 2.5.0's wire protocol (trace-websocket.js PROTOCOL_VERSION);
// the dump's metadata names it, as rtcstats-server writes it. Check it on
// every rtcstats upgrade (CLAUDE.md, Upgrading rtcstats).
const CLIENT_PROTOCOL = 'rtcstats#5.0';
const GET_STATS_INTERVAL_MS = 1000;
// Far above a session's worth (a run records a few hundred entries). Past it
// the recording stops rather than dropping entries, which would corrupt the
// deltas.
const MAX_ENTRIES = 50_000;

interface Entry {
  // When it was recorded (Date.now()). The file stores the gap since the
  // previous line instead, computed when a dump is written, so lines can be
  // left out without shifting the times after them.
  at: number;
  method: string;
  // rtcstats-js's connection id ("PC_0"), or null for client-level entries
  // (devices, permissions, the hardware entry).
  connection: string | null;
  // The message without its time, as JSON: [method (compressed), connection,
  // value, ...extra]. Serialized now so later changes to the objects don't
  // leak into it.
  json: string;
}

const entries: Entry[] = [];
const pageLoadedAt = Date.now();
let truncatedAt: number | null = null;
let installed = false;

// rtcstats-js's trace function: the same message as its WebSocketTrace sends.
const trace = (...args: unknown[]) => {
  if (truncatedAt !== null) return;
  const at = Date.now();
  if (entries.length >= MAX_ENTRIES) {
    truncatedAt = at;
    return;
  }
  if (args[1] instanceof RTCPeerConnection) {
    args[1] = (args[1] as RTCPeerConnection & { __rtcStatsId?: string }).__rtcStatsId;
  }
  const method = String(args[0]);
  const connection = typeof args[1] === 'string' ? args[1] : null;
  args[0] = compressMethod(method);
  try {
    entries.push({ at, method, connection, json: JSON.stringify(args) });
  } catch {
    // An unserializable value would otherwise end the recording; skip it.
  }
};

function install() {
  if (installed || typeof RTCPeerConnection === 'undefined') return;
  installed = true;
  wrapRTCPeerConnection(trace, globalThis, { getStatsInterval: GET_STATS_INTERVAL_MS });
  wrapGetUserMedia(trace, globalThis);
  wrapEnumerateDevices(trace, globalThis);
  // The client-level entry rtcstats-js's WebSocketTrace writes on connect:
  // hardware hints that matter for call quality (CPU count, memory). Kept in
  // every dump.
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: unknown };
  trace('create', null, {
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    userAgentData: nav.userAgentData,
    screen: { width: window.screen?.availWidth, height: window.screen?.availHeight, devicePixelRatio: window.devicePixelRatio },
    window: { width: window.innerWidth, height: window.innerHeight },
  });
}

install();

const isClientCreate = (entry: Entry) => entry.connection === null && entry.method === 'create';

// The entries a dump for [since, until] holds: the hardware entry, the
// connections created in the window (their entries up to `until`), and
// client-level entries in the window. Everything when `since` is undefined;
// no end bound when `until` is undefined (a run still going).
function selectEntries(since?: number, until?: number): Entry[] {
  if (since === undefined) return entries;
  const end = until ?? Infinity;
  const connections = new Set(
    entries
      .filter((e) => e.method === 'create' && e.connection !== null && e.at >= since && e.at <= end)
      .map((e) => e.connection),
  );
  return entries.filter((e) => {
    if (isClientCreate(e)) return true;
    if (e.at > end) return false;
    return e.connection === null ? e.at >= since : connections.has(e.connection);
  });
}

export interface RtcTraceInfo {
  // Entries in the dump: the run's, when it is scoped to one.
  entries: number;
  // The recording hit its cap; entries after `truncatedAt` are missing.
  truncated: boolean;
  pageLoadedAt: number;
  since: number | null;
  until: number | null;
}

export const getRtcTraceInfo = (since?: number, until?: number): RtcTraceInfo => ({
  entries: selectEntries(since, until).length,
  truncated: truncatedAt !== null,
  pageLoadedAt,
  since: since ?? null,
  until: until ?? null,
});

// The recording as an rtcstats dump: a 'RTCStatsDump' line, a JSON metadata
// line, then one JSON message per line ending in the milliseconds since the
// previous one (the first is absolute), as rtcstats-shared's readRTCStatsDump
// reads it. `since` and `until` scope it to one run (see above).
export function getRtcStatsDump(since?: number, until?: number): string {
  const selected = selectEntries(since, until);
  const metadata = {
    url: window.location.href,
    origin: window.location.origin,
    userAgent: navigator.userAgent,
    startTime: since ?? pageLoadedAt,
    endTime: until ?? null,
    pageLoadedAt,
    clientProtocol: CLIENT_PROTOCOL,
    application: 'signalwire-network-test',
    truncated: truncatedAt !== null,
  };
  let previous = 0;
  const lines = selected.map((entry) => {
    const line = `${entry.json.slice(0, -1)},${entry.at - previous}]`;
    previous = entry.at;
    return line;
  });
  return `RTCStatsDump\n${JSON.stringify(metadata)}\n${lines.join('\n')}\n`;
}
