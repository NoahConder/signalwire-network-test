import { BehaviorSubject } from 'rxjs';
import type { Observable, Subscription } from 'rxjs';
import type { Call, NetworkMetrics } from '@signalwire/js';
import {
  describeCandidatePair,
  formatCodec,
  signalWireService,
  type CallPreferences,
  type CandidatePairSnapshot,
  type ConnectionStatsSnapshot,
  type TokenFetcher,
} from './signalwire';
import { log } from '../utils/log';

// The runner: the steps in order, each time-boxed, reported through run$ as
// they go. Signaling connects the SDK and reads the platform's ICE servers;
// the TURN steps use plain RTCPeerConnections in this page; the voice and
// video steps are real calls through the SDK. The step functions are
// instance members (see `steps`) so the Playwright suite can replace them.

export type StepId =
  | 'signaling'
  | 'turn-udp'
  | 'turn-tcp'
  | 'turn-tls'
  | 'voice-opus'
  | 'voice-pcmu'
  | 'video-turn'
  | 'video-direct';

export type StepStatus = 'pending' | 'running' | 'passed' | 'warning' | 'failed' | 'skipped';

export interface StepDefinition {
  id: StepId;
  name: string;
  // One sentence on what the step does, shown until it has a result and in
  // its details.
  summary: string;
}

export const STEPS: readonly StepDefinition[] = [
  {
    id: 'signaling',
    name: 'Signaling',
    summary: 'Connect to SignalWire over WebSocket and authenticate with a short-lived token minted by the backend.',
  },
  {
    id: 'turn-udp',
    name: 'TURN over UDP',
    summary:
      "Allocate a relay on the platform's TURN server over UDP and pass data through it between two peers in this page.",
  },
  {
    id: 'turn-tcp',
    name: 'TURN over TCP',
    summary: 'The same relay check over TCP, the path a call takes where UDP is blocked.',
  },
  {
    id: 'turn-tls',
    name: 'TURN over TLS',
    summary: 'The same relay check over TLS. Runs only when the platform advertises a turns: URL.',
  },
  {
    id: 'voice-opus',
    name: 'Voice call (Opus)',
    summary:
      "A ten-second call to an echo that returns your own audio, with Opus preferred. The echo is measured, not played, so you won't hear yourself. Reports bitrate up and down, round-trip time, jitter, loss, the media path and a MOS estimate.",
  },
  {
    id: 'voice-pcmu',
    name: 'Voice call (PCMU)',
    summary: "The same call with G.711 μ-law preferred, the codec of calls to phone numbers. Again measured, not played.",
  },
  {
    id: 'video-turn',
    name: 'Video room through TURN',
    summary: 'Join a video room with media forced through TURN (relay-only). The camera prompt happens here.',
  },
  {
    id: 'video-direct',
    name: 'Video room, direct',
    summary: 'Join the same room again with the default media path.',
  },
];

export interface StepResult extends StepDefinition {
  status: StepStatus;
  // One line for the row.
  result: string;
  // The measurements, for the expandable details and the report.
  details: Record<string, unknown>;
  // The call steps' per-second measurements, for the report (not shown in
  // the row).
  series?: SeriesPoint[];
  startedAt: number | null;
  durationMs: number | null;
}

export type RunStatus = 'idle' | 'running' | 'passed' | 'warning' | 'failed' | 'stopped';

export interface TestRun {
  status: RunStatus;
  region: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  steps: StepResult[];
}

export interface StepOutcome {
  status: 'passed' | 'warning' | 'failed' | 'skipped';
  result: string;
  details?: Record<string, unknown>;
  series?: SeriesPoint[];
}

// Shared by the steps of one run. Signaling fills in what it learned from
// the token response and the SDK session; the later steps read it.
export interface RunContext {
  region: string;
  fetchToken: TokenFetcher;
  signal: AbortSignal;
  iceServers: RTCIceServer[];
  echoAddress: string | null;
  videoRoomAddress: string | null;
}

export type StepFunction = (ctx: RunContext) => Promise<StepOutcome>;

export interface RunOptions {
  region: string;
  fetchToken: TokenFetcher;
}

export const TIMEOUTS = {
  // Connect and authenticate.
  signaling: 15_000,
  // Relay candidate, data channel open and a ping.
  turn: 12_000,
  // From dial() resolving to 'connected'.
  connect: 15_000,
  voiceSample: 10_000,
  videoSample: 8_000,
} as const;

// The start of each sampling window left out of the bitrates and RTT (not
// the loss): the first second of a voice call, while the first RTT checks
// settle, and three of a video call, where the bandwidth estimate is still
// ramping from ~100 kbps and inbound video starts only between seconds 2 and
// 3 (0 kbps in second 2 on real calls). Measured on a real call: video
// download read ~670 kbps over the whole 5 s against 1,300-1,550 kbps steady,
// and 1,100 kbps with a 2 s warm-up.
export const WARMUP_MS = { voice: 1_000, video: 3_000 } as const;

// A whole step may not run longer than this. The call steps leave room for a
// microphone or camera permission prompt, which the SDK waits on inside
// dial().
const STEP_TIMEOUT: Record<StepId, number> = {
  signaling: 20_000,
  'turn-udp': 15_000,
  'turn-tcp': 15_000,
  'turn-tls': 15_000,
  'voice-opus': 90_000,
  'voice-pcmu': 90_000,
  'video-turn': 90_000,
  'video-direct': 90_000,
};

export class StepAbortedError extends Error {
  constructor() {
    super('Stopped');
    this.name = 'StepAbortedError';
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const idleRun = (): TestRun => ({
  status: 'idle',
  region: null,
  startedAt: null,
  finishedAt: null,
  steps: STEPS.map((step) => ({ ...step, status: 'pending', result: '', details: {}, startedAt: null, durationMs: null })),
});

// Rejects with a timeout message after `ms`, or with StepAbortedError when
// the run is stopped, whichever comes first.
function withTimeout<T>(promise: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    const onAbort = () => reject(new StepAbortedError());
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
  });
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new StepAbortedError());
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });

// --- ICE servers ------------------------------------------------------------

export type TurnTransport = 'udp' | 'tcp' | 'tls';

export const TURN_TRANSPORTS: readonly TurnTransport[] = ['udp', 'tcp', 'tls'];

const urlsOf = (server: RTCIceServer): string[] => (Array.isArray(server.urls) ? server.urls : [server.urls]);

// turn:host (optionally ?transport=udp) is UDP, turn:host?transport=tcp is
// TCP, turns:host is TLS; stun: and anything else is none of them.
export const transportOfUrl = (url: string): TurnTransport | null => {
  const lower = url.trim().toLowerCase();
  if (lower.startsWith('turns:')) return 'tls';
  if (!lower.startsWith('turn:')) return null;
  return /[?&]transport=tcp\b/.test(lower) ? 'tcp' : 'udp';
};

// One RTCIceServer per transport from the platform's entries: the same
// username and credential, only that transport's URLs. null when none is
// advertised, which is the expected case for TLS.
export function iceServerForTransport(servers: RTCIceServer[], transport: TurnTransport): RTCIceServer | null {
  for (const server of servers) {
    const urls = urlsOf(server).filter((url) => transportOfUrl(url) === transport);
    if (urls.length) return { urls, username: server.username, credential: server.credential };
  }
  return null;
}

// Every URL, without the credentials: safe for the report.
export const iceUrls = (servers: RTCIceServer[]): string[] => servers.flatMap(urlsOf);

// --- TURN relay check -------------------------------------------------------

// Two local RTCPeerConnections restricted to relay candidates, offer/answer
// exchanged in-page with trickled candidates, a data channel between them.
// Passing means a relay was allocated over `transport` AND data went through
// it (the platform's TURN relays between the two allocations); an allocation
// without an open channel is a warning, no relay candidate at all a failure.
export async function checkTurnRelay(
  server: RTCIceServer,
  transport: TurnTransport,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StepOutcome> {
  const config: RTCConfiguration = { iceServers: [server], iceTransportPolicy: 'relay' };
  const a = new RTCPeerConnection(config);
  const b = new RTCPeerConnection(config);
  const started = performance.now();
  const since = () => Math.round(performance.now() - started);
  let relayCandidates = 0;
  let firstRelayMs: number | null = null;
  let relayProtocol: string | null = null;

  const trickle = (to: RTCPeerConnection) => (event: RTCPeerConnectionIceEvent) => {
    const candidate = event.candidate;
    if (!candidate) return;
    if (candidate.type === 'relay') {
      relayCandidates += 1;
      firstRelayMs ??= since();
      relayProtocol ??= (candidate as RTCIceCandidate & { relayProtocol?: string }).relayProtocol ?? null;
    }
    to.addIceCandidate(candidate).catch((error) => log.debug('[turn] addIceCandidate (ignored):', error));
  };
  a.onicecandidate = trickle(b);
  b.onicecandidate = trickle(a);

  const channel = a.createDataChannel('ping');
  const opened = new Promise<number>((resolve, reject) => {
    channel.onopen = () => resolve(since());
    a.oniceconnectionstatechange = () => {
      if (a.iceConnectionState === 'failed') reject(new Error('ICE failed'));
    };
  });
  b.ondatachannel = ({ channel: remote }) => {
    remote.onmessage = (message) => remote.send(message.data);
  };

  const details: Record<string, unknown> = { transport, urls: urlsOf(server) };
  try {
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);

    const openMs = await withTimeout(opened, timeoutMs, 'TURN relay', signal);
    const pingMs = await withTimeout(
      new Promise<number>((resolve) => {
        const sent = performance.now();
        channel.onmessage = () => resolve(Math.round((performance.now() - sent) * 10) / 10);
        channel.send('ping');
      }),
      5_000,
      'Ping through the relay',
      signal,
    );

    // The relay protocol as the browser reports it on the selected pair.
    const report = await a.getStats();
    report.forEach((stat: RTCStats) => {
      if (stat.type === 'local-candidate') {
        const candidate = stat as RTCStats & { candidateType?: string; relayProtocol?: string };
        if (candidate.candidateType === 'relay' && candidate.relayProtocol) relayProtocol = candidate.relayProtocol;
      }
    });
    Object.assign(details, { relayCandidates, firstRelayCandidateMs: firstRelayMs, channelOpenMs: openMs, pingRttMs: pingMs, relayProtocol });
    return {
      status: 'passed',
      result: `Relay over ${transport.toUpperCase()}: allocated in ${firstRelayMs ?? openMs} ms, data channel open in ${openMs} ms, ping ${pingMs} ms`,
      details,
    };
  } catch (error) {
    if (error instanceof StepAbortedError) throw error;
    Object.assign(details, { relayCandidates, firstRelayCandidateMs: firstRelayMs, relayProtocol, error: errorText(error) });
    if (relayCandidates > 0) {
      return {
        status: 'warning',
        result: `TURN allocation OK over ${transport.toUpperCase()} (relay candidate in ${firstRelayMs} ms), but the relay between the two peers was not confirmed (${errorText(error)})`,
        details,
      };
    }
    return {
      status: 'failed',
      result: `No TURN relay candidate over ${transport.toUpperCase()} within ${Math.round(timeoutMs / 1000)} s`,
      details,
    };
  } finally {
    channel.close();
    a.close();
    b.close();
  }
}

// --- call measurements --------------------------------------------------------

export interface Sample {
  at: number;
  stats: ConnectionStatsSnapshot | null;
  metrics: NetworkMetrics | null;
}

// getStats() once a second for `durationMs`, with the SDK's latest metrics
// sample and MOS alongside.
async function sampleCall(call: Call, durationMs: number, signal: AbortSignal): Promise<{ samples: Sample[]; mos: number | null }> {
  const latest: { metrics: NetworkMetrics | null; mos: number | null } = { metrics: null, mos: null };
  const subs: Subscription[] = [
    signalWireService.getNetworkMetrics$(call).subscribe((list) => {
      latest.metrics = list[list.length - 1] ?? null;
    }),
    signalWireService.getQualityScore$(call).subscribe((score) => {
      latest.mos = score;
    }),
  ];
  const samples: Sample[] = [];
  try {
    const started = performance.now();
    for (;;) {
      samples.push({ at: performance.now(), stats: await signalWireService.getConnectionStats(call), metrics: latest.metrics });
      if (performance.now() - started >= durationMs) break;
      await sleep(1_000, signal);
    }
  } finally {
    subs.forEach((sub) => sub.unsubscribe());
  }
  return { samples, mos: latest.mos };
}

// One second of a call, between two consecutive samples: what the report's
// per-step `series` holds. Bitrates and loss are for the step's media kind
// (audio on the voice steps, video on the video steps).
export interface SeriesPoint {
  // Since the first sample.
  tMs: number;
  // Inside the warm-up: shown, but left out of the bitrates and RTT.
  warmup: boolean;
  upKbps: number;
  downKbps: number;
  // Packets lost out of those expected in this interval; null when none
  // arrived or were lost.
  lossPct: number | null;
  rttMs: number | null;
  jitterMs: number | null;
}

export interface Figures {
  // The steady window the bitrates and RTT cover, after the warm-up.
  seconds: number;
  warmupMs: number;
  uploadKbps: number;
  downloadKbps: number;
  rttAvgMs: number | null;
  rttMaxMs: number | null;
  jitterAvgMs: number | null;
  jitterMaxMs: number | null;
  // Over the whole window, for the step's media kind.
  lossPct: number | null;
  // The worst one-second interval, so a burst isn't averaged away.
  worstSecondLossPct: number | null;
  // Inbound audio loss over the window; on the voice steps it equals lossPct.
  audioLossPct: number | null;
  availableOutgoingKbps: number | null;
  path: string;
  candidatePair: CandidatePairSnapshot | null;
  series: SeriesPoint[];
}

const average = (values: number[]): number | null =>
  values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;
const maximum = (values: number[]): number | null => (values.length ? Math.max(...values) : null);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round1 = (value: number): number => Math.round(value * 10) / 10;

// lost / (lost + received) as a percentage. The counters are cumulative and
// packetsLost can step back (late packets are recounted as received), so a
// negative interval delta counts as none lost.
const lossOf = (lost: number, received: number): number | null => {
  const lostClamped = Math.max(0, lost);
  const total = lostClamped + Math.max(0, received);
  return total > 0 ? round1((lostClamped / total) * 100) : null;
};

const rttOf = (sample: Sample): number | null => {
  const value = sample.stats?.candidatePair?.currentRoundTripTimeMs ?? sample.metrics?.roundTripTime;
  return isNumber(value) ? value : null;
};

// Bitrates from the byte deltas between the first sample after the warm-up
// and the last (and per interval for the series), RTT from the audio
// transport's candidate pair after the warm-up (the SDK's own RTT sample where
// the browser doesn't report one), jitter from the SDK's samples (ms), loss
// from the inbound counters of the step's media kind over the whole window and
// per interval, the bandwidth estimate from the last sample. When the window is
// too short to leave anything after the warm-up, the whole window is used.
// Exported for the stats spec.
export function figuresFrom(samples: Sample[], kind: 'audio' | 'video', warmupMs = 0): Figures {
  const withStats = samples.filter((sample): sample is Sample & { stats: ConnectionStatsSnapshot } => sample.stats !== null);
  const start = withStats[0];
  const last = withStats[withStats.length - 1];
  const steadyFrom = (list: Sample[]) => {
    const after = start ? list.filter((sample) => sample.at - start.at >= warmupMs) : list;
    return after.length >= 2 ? after : list;
  };
  const steady = steadyFrom(withStats) as Array<Sample & { stats: ConnectionStatsSnapshot }>;
  const first = steady[0];
  const seconds = first && last && last !== first ? (last.at - first.at) / 1000 : 0;
  const sent = (stats: ConnectionStatsSnapshot) => (kind === 'audio' ? stats.audioBytesSent : stats.videoBytesSent);
  const received = (stats: ConnectionStatsSnapshot) => (kind === 'audio' ? stats.audioBytesReceived : stats.videoBytesReceived);
  const packetsLost = (stats: ConnectionStatsSnapshot) => (kind === 'audio' ? stats.audioPacketsLost : stats.videoPacketsLost);
  const packetsReceived = (stats: ConnectionStatsSnapshot) =>
    kind === 'audio' ? stats.audioPacketsReceived : stats.videoPacketsReceived;
  const kbpsOver = (bytes: number, secs: number) => (secs > 0 ? Math.round((Math.max(0, bytes) * 8) / 1000 / secs) : 0);
  const rtts = steadyFrom(samples).map(rttOf).filter(isNumber);
  const jitters = samples.map((sample) => sample.metrics?.audio.jitter).filter(isNumber);
  const lastMetrics = [...samples].reverse().find((sample) => sample.metrics)?.metrics ?? null;

  const lossPct = last
    ? lossOf(packetsLost(last.stats), packetsReceived(last.stats))
    : kind === 'audio' && lastMetrics
      ? lossOf(lastMetrics.audio.packetsLost, lastMetrics.audio.packetsReceived)
      : null;
  const audioLossPct = last
    ? lossOf(last.stats.audioPacketsLost, last.stats.audioPacketsReceived)
    : lastMetrics
      ? lossOf(lastMetrics.audio.packetsLost, lastMetrics.audio.packetsReceived)
      : null;

  const series: SeriesPoint[] = [];
  for (let i = 1; i < withStats.length; i++) {
    const prev = withStats[i - 1];
    const cur = withStats[i];
    const secs = (cur.at - prev.at) / 1000;
    const rtt = rttOf(cur);
    const jitter = cur.metrics?.audio.jitter;
    series.push({
      tMs: Math.round(cur.at - start.at),
      // Every second up to the first steady sample, the baseline the
      // bitrates start from (samples land a few ms after each second).
      warmup: steady !== withStats && cur.at <= first.at,
      upKbps: kbpsOver(sent(cur.stats) - sent(prev.stats), secs),
      downKbps: kbpsOver(received(cur.stats) - received(prev.stats), secs),
      lossPct: lossOf(
        packetsLost(cur.stats) - packetsLost(prev.stats),
        packetsReceived(cur.stats) - packetsReceived(prev.stats),
      ),
      rttMs: rtt,
      jitterMs: isNumber(jitter) ? jitter : null,
    });
  }

  return {
    seconds: round1(seconds),
    warmupMs: steady === withStats ? 0 : warmupMs,
    uploadKbps: first && last ? kbpsOver(sent(last.stats) - sent(first.stats), seconds) : 0,
    downloadKbps: first && last ? kbpsOver(received(last.stats) - received(first.stats), seconds) : 0,
    rttAvgMs: average(rtts),
    rttMaxMs: maximum(rtts),
    jitterAvgMs: average(jitters),
    jitterMaxMs: maximum(jitters),
    lossPct,
    worstSecondLossPct: maximum(series.map((point) => point.lossPct).filter(isNumber)),
    audioLossPct,
    availableOutgoingKbps: isNumber(lastMetrics?.availableOutgoingBitrate)
      ? Math.round(lastMetrics.availableOutgoingBitrate / 1000)
      : null,
    path: describeCandidatePair(last?.stats.candidatePair ?? null),
    candidatePair: last?.stats.candidatePair ?? null,
    series,
  };
}

const ms = (value: number | null): string => (value == null ? '–' : `${Math.round(value)} ms`);

// "loss 0.4% (worst second 3%)": the worst second only when it says more
// than the overall figure.
const lossText = (figures: Omit<Figures, 'series'>): string => {
  if (figures.lossPct == null) return 'loss –';
  const worst = figures.worstSecondLossPct;
  return `loss ${figures.lossPct}%${worst != null && worst > figures.lossPct ? ` (worst second ${worst}%)` : ''}`;
};

export const figuresLine = (figures: Omit<Figures, 'series'>, mos: number | null): string =>
  `↑ ${figures.uploadKbps} kbps ↓ ${figures.downloadKbps} kbps · RTT ${ms(figures.rttAvgMs)} (max ${ms(figures.rttMaxMs)}) · jitter ${ms(
    figures.jitterAvgMs,
  )} · ${lossText(figures)} · ${figures.path}${mos != null ? ` · MOS ${mos.toFixed(1)}` : ''}`;

// A Fabric address with the channel the step needs, whatever the backend's
// address already carried.
export const withChannel = (address: string, channel: 'audio' | 'video'): string =>
  `${address.replace(/\?.*$/, '')}?channel=${channel}`;

// --- the runner -------------------------------------------------------------

class NetworkTestRunner {
  private readonly run$ = new BehaviorSubject<TestRun>(idleRun());
  private abortController: AbortController | null = null;

  // The step functions by id. The Playwright suite replaces these through
  // the ?e2e=1 seam; nothing else should.
  steps: Record<StepId, StepFunction> = {
    signaling: (ctx) => this.signalingStep(ctx),
    'turn-udp': (ctx) => this.turnStep(ctx, 'udp'),
    'turn-tcp': (ctx) => this.turnStep(ctx, 'tcp'),
    'turn-tls': (ctx) => this.turnStep(ctx, 'tls'),
    'voice-opus': (ctx) => this.voiceStep(ctx, 'opus'),
    'voice-pcmu': (ctx) => this.voiceStep(ctx, 'PCMU'),
    'video-turn': (ctx) => this.videoStep(ctx, true),
    'video-direct': (ctx) => this.videoStep(ctx, false),
  };

  getRun$(): Observable<TestRun> {
    return this.run$.asObservable();
  }

  getRun(): TestRun {
    return this.run$.value;
  }

  isRunning(): boolean {
    return this.run$.value.status === 'running';
  }

  // Runs every step in order. A signaling failure skips the rest; any other
  // failure moves on. Resolves with the finished run once the SDK has been
  // disconnected again.
  async start(options: RunOptions): Promise<TestRun> {
    if (this.isRunning()) throw new Error('A test is already running');
    const controller = new AbortController();
    this.abortController = controller;
    const ctx: RunContext = {
      region: options.region,
      fetchToken: options.fetchToken,
      signal: controller.signal,
      iceServers: [],
      echoAddress: null,
      videoRoomAddress: null,
    };
    this.run$.next({ ...idleRun(), status: 'running', region: options.region, startedAt: Date.now() });
    signalWireService.logEvent('test', 'Test started', `region ${options.region}`);

    let savedPreferences: CallPreferences | null = null;
    let signalingFailed = false;
    for (const step of STEPS) {
      if (controller.signal.aborted || signalingFailed) {
        this.setStep(step.id, {
          status: 'skipped',
          result: controller.signal.aborted ? 'Stopped' : 'Skipped: signaling failed',
        });
        continue;
      }
      this.setStep(step.id, { status: 'running', result: '', details: {}, series: undefined, startedAt: Date.now(), durationMs: null });
      signalWireService.logEvent('test', `${step.name}: started`);
      const startedAt = performance.now();
      let outcome: StepOutcome;
      try {
        outcome = await withTimeout(this.steps[step.id](ctx), STEP_TIMEOUT[step.id], step.name, controller.signal);
      } catch (error) {
        if (error instanceof StepAbortedError) {
          outcome = { status: 'skipped', result: 'Stopped' };
        } else {
          log.warn(`[network-test] ${step.id} failed:`, error);
          outcome = { status: 'failed', result: errorText(error) };
        }
      }
      if (step.id === 'signaling' && signalWireService.isConnected()) {
        savedPreferences = signalWireService.getCallPreferences();
      }
      this.setStep(step.id, { ...outcome, details: outcome.details ?? {}, durationMs: Math.round(performance.now() - startedAt) });
      signalWireService.logEvent(
        outcome.status === 'failed' ? 'error' : outcome.status === 'warning' ? 'warning' : 'test',
        `${step.name}: ${outcome.status}`,
        outcome.result || undefined,
      );
      if (step.id === 'signaling' && outcome.status === 'failed') signalingFailed = true;
    }

    // Leave the SDK as it was found: no call, the preferences the page
    // started with, no session.
    try {
      await signalWireService.hangupCurrent();
      if (savedPreferences && signalWireService.isConnected()) signalWireService.setCallPreferences(savedPreferences);
      await signalWireService.disconnect();
    } catch (error) {
      log.debug('[network-test] cleanup (ignored):', error);
    }

    const steps = this.run$.value.steps;
    const status: RunStatus = controller.signal.aborted
      ? 'stopped'
      : steps.some((step) => step.status === 'failed')
        ? 'failed'
        : steps.some((step) => step.status === 'warning')
          ? 'warning'
          : 'passed';
    const finished: TestRun = { ...this.run$.value, status, finishedAt: Date.now() };
    this.run$.next(finished);
    signalWireService.logEvent('test', `Test finished: ${status}`);
    this.abortController = null;
    return finished;
  }

  // Ends the running step and skips the rest; the running call is hung up
  // and the session closed by start()'s cleanup.
  stop() {
    if (!this.abortController) return;
    signalWireService.logEvent('test', 'Stop requested');
    this.abortController.abort();
    void signalWireService.hangupCurrent();
  }

  private setStep(id: StepId, patch: Partial<StepResult>) {
    const run = this.run$.value;
    this.run$.next({ ...run, steps: run.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)) });
  }

  private async signalingStep(ctx: RunContext): Promise<StepOutcome> {
    let connectMs: number;
    try {
      ({ connectMs } = await withTimeout(signalWireService.connect(ctx.fetchToken), TIMEOUTS.signaling, 'Connecting', ctx.signal));
    } catch (error) {
      if (error instanceof StepAbortedError) throw error;
      const tokenError = signalWireService.getLastTokenError();
      return { status: 'failed', result: tokenError ?? `Could not connect: ${errorText(error)}` };
    }
    const info = signalWireService.getSessionInfo();
    ctx.iceServers = signalWireService.getIceServers();
    ctx.echoAddress = info?.echoAddress ?? null;
    ctx.videoRoomAddress = info?.videoRoomAddress ?? null;
    const urls = iceUrls(ctx.iceServers);
    const transports = TURN_TRANSPORTS.filter((transport) => iceServerForTransport(ctx.iceServers, transport));
    const details = {
      connectMs,
      region: info?.region ?? ctx.region,
      sdkVersion: signalWireService.getSdkVersion(),
      iceServerUrls: urls,
      turnTransports: transports,
      echoAddress: ctx.echoAddress,
      videoRoomAddress: ctx.videoRoomAddress,
    };
    if (!urls.length) {
      return {
        status: 'warning',
        result: `Connected and authenticated in ${connectMs} ms, but the platform advertised no TURN servers`,
        details,
      };
    }
    return {
      status: 'passed',
      result: `Connected and authenticated in ${connectMs} ms · TURN over ${transports.map((t) => t.toUpperCase()).join(', ')}`,
      details,
    };
  }

  private async turnStep(ctx: RunContext, transport: TurnTransport): Promise<StepOutcome> {
    const server = iceServerForTransport(ctx.iceServers, transport);
    if (!server) {
      return {
        status: 'skipped',
        result:
          transport === 'tls'
            ? 'Not advertised: the platform handed this session no turns: URL, so TURN over TLS was not tested'
            : `Not advertised: the platform handed this session no ${transport.toUpperCase()} TURN URL`,
        details: { transport, iceServerUrls: iceUrls(ctx.iceServers) },
      };
    }
    return checkTurnRelay(server, transport, TIMEOUTS.turn, ctx.signal);
  }

  private async voiceStep(ctx: RunContext, codec: 'opus' | 'PCMU'): Promise<StepOutcome> {
    if (!ctx.echoAddress) {
      return { status: 'skipped', result: 'No echo address is configured for this region' };
    }
    signalWireService.setCallPreferences({ preferredAudioCodecs: [codec], relayOnly: false });
    const destination = withChannel(ctx.echoAddress, 'audio');
    const call = await withTimeout(
      signalWireService.dial(destination, { audio: true, video: false, preferredAudioCodecs: [codec] }),
      STEP_TIMEOUT['voice-opus'],
      'Dialing',
      ctx.signal,
    );
    try {
      const connectMs = await withTimeout(
        signalWireService.waitForConnected(call, TIMEOUTS.connect),
        TIMEOUTS.connect + 1_000,
        'Connecting',
        ctx.signal,
      );
      const { samples, mos } = await sampleCall(call, TIMEOUTS.voiceSample, ctx.signal);
      const { series, ...figures } = figuresFrom(samples, 'audio', WARMUP_MS.voice);
      const last = [...samples].reverse().find((sample) => sample.stats)?.stats ?? null;
      const inbound = last?.audioInboundCodec ?? null;
      const outbound = last?.audioOutboundCodec ?? null;
      const mediaErrors = signalWireService.getMediaErrors();
      const details = {
        destination,
        callId: call.id,
        codecRequested: codec,
        codecInbound: formatCodec(inbound),
        codecOutbound: formatCodec(outbound),
        connectMs,
        ...figures,
        mos,
        samples: samples.length,
        mediaErrors,
      };
      if (figures.downloadKbps <= 0 || !inbound) {
        return { status: 'failed', result: 'Connected, but no audio came back from the echo', details, series };
      }
      if (inbound.name.toLowerCase() !== codec.toLowerCase()) {
        return { status: 'failed', result: `Negotiated ${formatCodec(inbound)} instead of ${codec}`, details, series };
      }
      const line = `${formatCodec(inbound)} · ${figuresLine(figures, mos)}`;
      if (mediaErrors.length) {
        return { status: 'warning', result: `${mediaErrors[0]}, so the call was measured receive-only · ${line}`, details, series };
      }
      return { status: 'passed', result: line, details, series };
    } finally {
      await signalWireService.hangup(call);
    }
  }

  private async videoStep(ctx: RunContext, relayOnly: boolean): Promise<StepOutcome> {
    if (!ctx.videoRoomAddress) {
      return { status: 'skipped', result: 'No video room is configured for this region' };
    }
    signalWireService.setCallPreferences({ preferredAudioCodecs: [], relayOnly });
    const destination = withChannel(ctx.videoRoomAddress, 'video');
    const call = await withTimeout(
      signalWireService.dial(destination, { audio: true, video: true, receiveVideo: true }),
      STEP_TIMEOUT['video-turn'],
      'Dialing',
      ctx.signal,
    );
    try {
      const connectMs = await withTimeout(
        signalWireService.waitForConnected(call, TIMEOUTS.connect),
        TIMEOUTS.connect + 1_000,
        'Connecting',
        ctx.signal,
      );
      const { samples, mos } = await sampleCall(call, TIMEOUTS.videoSample, ctx.signal);
      const { series, ...figures } = figuresFrom(samples, 'video', WARMUP_MS.video);
      const last = [...samples].reverse().find((sample) => sample.stats)?.stats ?? null;
      const mediaErrors = signalWireService.getMediaErrors();
      const details = {
        destination,
        callId: call.id,
        relayOnly,
        videoCodecOutbound: formatCodec(last?.videoOutboundCodec ?? null),
        videoCodecInbound: formatCodec(last?.videoInboundCodec ?? null),
        audioCodec: formatCodec(last?.audioInboundCodec ?? null),
        connectMs,
        ...figures,
        mos,
        samples: samples.length,
        mediaErrors,
      };
      const pair = figures.candidatePair;
      if (relayOnly && pair && pair.localType !== 'relay') {
        return { status: 'failed', result: `Media went ${figures.path}, not through TURN`, details, series };
      }
      if (!pair) {
        return { status: 'failed', result: 'Connected, but no media path was selected', details, series };
      }
      const line = `video ${details.videoCodecOutbound} ↑ / ${details.videoCodecInbound} ↓ · ${figuresLine(figures, mos)}`;
      if (mediaErrors.length) {
        return { status: 'warning', result: `${mediaErrors[0]}, so the room was joined receive-only · ${line}`, details, series };
      }
      return { status: 'passed', result: line, details, series };
    } finally {
      await signalWireService.hangup(call);
    }
  }
}

export const networkTestRunner = new NetworkTestRunner();
