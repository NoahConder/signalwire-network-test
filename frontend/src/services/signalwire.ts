import {
  SignalWire,
  TokenRefreshError,
  InvalidCredentialsError,
  MediaAccessError,
  MediaTrackError,
  version as sdkVersion,
} from '@signalwire/js';
import type { Call, CallStatus, DialOptions, NetworkMetrics, SessionDiagnostics } from '@signalwire/js';
import { ReplaySubject, filter, firstValueFrom } from 'rxjs';
import type { Observable, Subscription } from 'rxjs';
import type { TokenData } from '../types';
import { log } from '../utils/log';

// One line of the page's event log: what the SDK and the runner did, in
// order, for a tester reading along. Kept in a bounded ReplaySubject here and
// read straight from getEventLog$() by EventLog.tsx and the report.
export type AppEventKind = 'test' | 'call' | 'media' | 'client' | 'error' | 'warning';

export interface AppEvent {
  at: number;
  kind: AppEventKind;
  message: string;
  // Short secondary text: an error message, a call id, a destination.
  detail?: string;
}

const EVENT_LOG_SIZE = 500;

// Fetches a fresh token from the backend. The SDK calls it through its
// credentialProvider (authenticate, and refresh if a run ever outlives a
// token); nothing here stores the token.
export type TokenFetcher = () => Promise<TokenData>;

// What the token response says about the run, minus the token itself.
export interface SessionInfo {
  region: string;
  echoAddress: string | null;
  videoRoomAddress: string | null;
  expiresAt: string;
}

// The two SDK preferences a step sets before dialing (client.preferences):
// the SDK reorders the SDP offer by preferredAudioCodecs and creates the
// peer connection with iceTransportPolicy 'relay' when relayOnly is set.
export interface CallPreferences {
  preferredAudioCodecs: string[];
  relayOnly: boolean;
}

// getStats() record shapes this TypeScript version's lib.dom doesn't declare.
interface IceCandidateStats extends RTCStats {
  candidateType: string;
  protocol?: string;
  relayProtocol?: string;
}

interface CodecStats extends RTCStats {
  mimeType: string;
  clockRate?: number;
  payloadType: number;
}

export interface CodecInfo {
  // The mime subtype as negotiated: "opus", "PCMU", "VP8", ...
  name: string;
  clockRate: number | null;
  payloadType: number;
}

export interface CandidatePairSnapshot {
  localType: string;
  remoteType: string;
  protocol: string | null;
  // udp, tcp or tls when the local candidate is a TURN relay.
  relayProtocol: string | null;
  currentRoundTripTimeMs: number | null;
}

// What RTCPeerConnection.getStats() says about the transport, the codecs and
// the byte and packet counters at one instant -- see getConnectionStats().
export interface ConnectionStatsSnapshot {
  candidatePair: CandidatePairSnapshot | null;
  audioOutboundCodec: CodecInfo | null;
  audioInboundCodec: CodecInfo | null;
  videoOutboundCodec: CodecInfo | null;
  videoInboundCodec: CodecInfo | null;
  audioBytesSent: number;
  audioBytesReceived: number;
  videoBytesSent: number;
  videoBytesReceived: number;
  audioPacketsReceived: number;
  audioPacketsLost: number;
  videoPacketsReceived: number;
  videoPacketsLost: number;
}

export const formatCodec = (codec: CodecInfo | null): string =>
  codec ? `${codec.name}${codec.clockRate ? ` ${codec.clockRate / 1000}k` : ''}` : 'none';

// "srflx → host over udp", "relay (tcp) → relay over udp".
export const describeCandidatePair = (pair: CandidatePairSnapshot | null): string => {
  if (!pair) return 'no candidate pair';
  const relay = pair.localType === 'relay' && pair.relayProtocol ? ` (${pair.relayProtocol})` : '';
  return `${pair.localType}${relay} → ${pair.remoteType}${pair.protocol ? ` over ${pair.protocol}` : ''}`;
};

const TERMINAL_STATUSES: readonly CallStatus[] = ['disconnecting', 'disconnected', 'failed', 'destroyed'];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const describeMediaError = (error: MediaAccessError | MediaTrackError): string =>
  error instanceof MediaAccessError
    ? error.denied
      ? `${error.media} access was denied`
      : `Couldn't access your ${error.media}`
    : `A problem occurred with your ${error.kind} device`;

const REMOTE_SINK_ID = 'sw-remote-audio';

class SignalWireService {
  private client: InstanceType<typeof SignalWire> | null = null;
  private clientSubs: Subscription[] = [];
  private callSubs: Subscription[] = [];
  private currentCall: Call | null = null;
  private sessionInfo: SessionInfo | null = null;
  private isReady = false;
  // The message of the last failed token request, so a failed connect can
  // report the backend's reason rather than the SDK's wrapper.
  private lastTokenError: string | null = null;
  // Non-fatal media errors reported on the current call's errors$ (a denied
  // microphone or camera: the SDK then carries on receive-only).
  private mediaErrors: string[] = [];
  // The SDK's session diagnostics, taken just before disconnect(): the runner
  // disconnects at the end of every run, before anyone presses Download.
  private lastDiagnostics: SessionDiagnostics | null = null;
  private eventLog$ = new ReplaySubject<AppEvent>(EVENT_LOG_SIZE);
  private pcListenerDisposer: (() => void) | null = null;
  private pcPollTimer: ReturnType<typeof setInterval> | null = null;

  getEventLog$(): Observable<AppEvent> {
    return this.eventLog$.asObservable();
  }

  // Public: the runner logs its own steps through it.
  logEvent(kind: AppEventKind, message: string, detail?: string) {
    this.eventLog$.next({ at: Date.now(), kind, message, detail });
  }

  getSdkVersion(): string {
    return sdkVersion;
  }

  isConnected(): boolean {
    return this.client !== null && this.isReady;
  }

  getSessionInfo(): SessionInfo | null {
    return this.sessionInfo;
  }

  getLastTokenError(): string | null {
    return this.lastTokenError;
  }

  // Builds the client, which connects by itself (rc.5's constructor runs
  // init(): authenticate through the credentialProvider, fetch the user,
  // open the WebSocket). Resolves with the time from construction to ready$
  // -- the token request included -- and rejects as soon as the token
  // request fails rather than waiting out the step's timeout. skipRegister:
  // the page only dials out, so the subscriber is never put online, and no
  // call is reattached across reloads (reconnectAttachedCalls defaults off).
  async connect(fetchToken: TokenFetcher): Promise<{ connectMs: number }> {
    if (this.client) await this.disconnect();
    this.lastDiagnostics = null;
    let rejectTokenFailure: (error: Error) => void = () => undefined;
    const tokenFailure = new Promise<never>((_, reject) => {
      rejectTokenFailure = reject;
    });
    // A refresh can fail after connect() has returned; nothing awaits it then.
    tokenFailure.catch(() => undefined);
    const fetchCredential = async (event: string) => {
      let data: TokenData;
      try {
        data = await fetchToken();
      } catch (error) {
        this.lastTokenError = errorText(error);
        this.logEvent('error', 'Token request failed', this.lastTokenError);
        rejectTokenFailure(error instanceof Error ? error : new Error(this.lastTokenError));
        throw error;
      }
      this.lastTokenError = null;
      this.sessionInfo = {
        region: data.region,
        echoAddress: data.echo_address,
        videoRoomAddress: data.video_room_address,
        expiresAt: data.expires_at,
      };
      this.logEvent('client', event, `region ${data.region} · expires ${new Date(data.expires_at).toLocaleTimeString()}`);
      return { token: data.token, expiry_at: Date.parse(data.expires_at) };
    };
    const credentialProvider = {
      // `context.fingerprint` (DPoP) is available here but unused: the
      // backend mints a plain SAT.
      authenticate: () => fetchCredential('Token minted'),
      // Typed `() => Promise<SDKCredential>`: the SDK never hands refresh a
      // fingerprint. A run ends well before the token's 80% mark, so this
      // only ever runs on a very slow network; a captcha token is single-use,
      // so in production it would be refused.
      refresh: () => fetchCredential('Token refreshed'),
    };

    const started = performance.now();
    const client = new SignalWire(credentialProvider, { logLevel: 'warn', skipRegister: true });
    this.client = client;

    this.clientSubs.push(
      client.errors$.subscribe((error) => {
        log.error('SignalWire error:', error);
        this.logEvent('error', 'Client error', errorText(error));
        if (error instanceof TokenRefreshError || error instanceof InvalidCredentialsError) {
          this.logEvent('warning', 'The session credentials could not be refreshed');
        }
      }),
      client.warnings$.subscribe((warning) => {
        log.warn('SignalWire warning:', warning.code, warning.message);
        this.logEvent('warning', warning.code, warning.message);
      }),
      client.ready$.subscribe((ready) => {
        const changed = ready !== this.isReady;
        this.isReady = ready;
        // The initial false is just "not yet": log the first true and every
        // change after it.
        if (changed && (ready || this.client === client)) {
          this.logEvent('client', ready ? 'Connected and ready' : 'Connection lost');
        }
      }),
    );

    await Promise.race([firstValueFrom(client.ready$.pipe(filter((ready) => ready))), tokenFailure]);
    return { connectMs: Math.round(performance.now() - started) };
  }

  // The ICE servers the platform handed this session at authentication:
  // the TURN username and credential plus a URL per transport. Empty until
  // connected.
  getIceServers(): RTCIceServer[] {
    return this.client?.session.iceServers ?? [];
  }

  getCallPreferences(): CallPreferences {
    const preferences = this.requireClient().preferences;
    return { preferredAudioCodecs: [...preferences.preferredAudioCodecs], relayOnly: preferences.relayOnly };
  }

  // Read by the SDK at the next offer (codecs) and peer-connection creation
  // (relay-only), so set before each dial.
  setCallPreferences(prefs: CallPreferences) {
    const preferences = this.requireClient().preferences;
    preferences.preferredAudioCodecs = prefs.preferredAudioCodecs;
    preferences.relayOnly = prefs.relayOnly;
    this.logEvent(
      'test',
      'Call preferences set',
      `codecs ${prefs.preferredAudioCodecs.join(', ') || 'default'} · relay-only ${prefs.relayOnly ? 'on' : 'off'}`,
    );
  }

  // Places a call and follows it: status, errors, recovery, ICE state and
  // the remote media, which is attached to a muted sink (see
  // attachRemoteStream). One call at a time.
  async dial(destination: string, options: DialOptions): Promise<Call> {
    const client = this.requireClient();
    if (this.currentCall) await this.hangup(this.currentCall);
    this.mediaErrors = [];
    this.logEvent('call', 'Dialing', destination);
    let call: Call;
    try {
      call = await client.dial(destination, options);
    } catch (error) {
      this.logEvent('error', 'Dial failed', errorText(error));
      throw error;
    }
    this.currentCall = call;
    this.logEvent('call', 'Call created', call.id);

    this.callSubs.push(
      call.status$.subscribe((status) => this.logEvent('call', `Status: ${status}`)),
      // call.errors$ is where the SDK reports media failures that don't end
      // the call: a denied microphone, after which it carries on receive-only.
      call.errors$.subscribe((callError) => {
        this.logEvent(
          'error',
          `Call error (${callError.kind}${callError.fatal ? ', fatal' : ''})`,
          errorText(callError.error),
        );
        const { error } = callError;
        if (!callError.fatal && (error instanceof MediaAccessError || error instanceof MediaTrackError)) {
          this.mediaErrors.push(describeMediaError(error));
        }
      }),
      call.remoteStream$.subscribe((stream) => {
        if (stream) this.attachRemoteStream(stream);
      }),
      call.recoveryEvent$.subscribe((event) =>
        this.logEvent('media', `Recovery ${event.action}`, event.reason),
      ),
    );
    this.watchPeerConnection(call);
    return call;
  }

  // Resolves with the time to 'connected'; rejects if the call ends first or
  // the time runs out.
  async waitForConnected(call: Call, timeoutMs: number): Promise<number> {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Not connected after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    });
    try {
      const status = await Promise.race([
        firstValueFrom(
          call.status$.pipe(filter((s) => s === 'connected' || TERMINAL_STATUSES.includes(s))),
        ),
        timeout,
      ]);
      if (status !== 'connected') throw new Error(`The call ended before it connected (${status})`);
      return Math.round(performance.now() - started);
    } finally {
      clearTimeout(timer);
    }
  }

  getMediaErrors(): string[] {
    return [...this.mediaErrors];
  }

  // The SDK's 1 Hz metrics ring buffer: RTT and jitter already in ms,
  // cumulative packet counters, the bandwidth estimate.
  getNetworkMetrics$(call: Call): Observable<NetworkMetrics[]> {
    return call.networkMetrics$;
  }

  // The SDK's E-model MOS estimate (1-5) from the latest sample.
  getQualityScore$(call: Call): Observable<number> {
    return call.qualityScore$;
  }

  // Snapshot of the selected ICE candidate pair, the negotiated codecs and
  // the counters -- what the voice and video steps sample once a second.
  async getConnectionStats(call: Call): Promise<ConnectionStatsSnapshot | null> {
    const pc = call.rtcPeerConnection;
    if (!pc) return null;
    const report = await pc.getStats();
    const byId = new Map<string, RTCStats>();
    report.forEach((stat: RTCStats) => byId.set(stat.id, stat));

    // The transport names the pair in use; older/other engines only mark it
    // nominated + succeeded. The SDK uses bundlePolicy 'max-compat', so audio
    // and video get a transport each: read the one carrying audio, whose RTT
    // isn't inflated by video's keyframe bursts (a video call's video
    // transport read 230-250 ms in its first second against ~35 ms after).
    const rtpOf = (type: string, kind: string) =>
      [...byId.values()].find((stat) => stat.type === type && (stat as RTCRtpStreamStats).kind === kind) as
        | RTCRtpStreamStats
        | undefined;
    const audioTransportId =
      rtpOf('outbound-rtp', 'audio')?.transportId ?? rtpOf('inbound-rtp', 'audio')?.transportId;
    const selectedPairOf = (transport: RTCStats | undefined) => {
      const id = (transport as RTCTransportStats | undefined)?.selectedCandidatePairId;
      return id ? (byId.get(id) as RTCIceCandidatePairStats | undefined) : undefined;
    };
    let pair = audioTransportId ? selectedPairOf(byId.get(audioTransportId)) : undefined;
    if (!pair) {
      for (const stat of byId.values()) {
        if (stat.type === 'transport') pair = selectedPairOf(stat) ?? pair;
      }
    }
    if (!pair) {
      for (const stat of byId.values()) {
        if (stat.type === 'candidate-pair') {
          const candidate = stat as RTCIceCandidatePairStats;
          if (candidate.nominated && candidate.state === 'succeeded') pair = candidate;
        }
      }
    }
    const local = pair ? (byId.get(pair.localCandidateId) as IceCandidateStats | undefined) : undefined;
    const remote = pair ? (byId.get(pair.remoteCandidateId) as IceCandidateStats | undefined) : undefined;

    const codecOf = (codecId?: string): CodecInfo | null => {
      const codec = codecId ? (byId.get(codecId) as CodecStats | undefined) : undefined;
      if (!codec) return null;
      return {
        name: codec.mimeType.replace(/^(audio|video)\//i, ''),
        clockRate: codec.clockRate ?? null,
        payloadType: codec.payloadType,
      };
    };

    const snapshot: ConnectionStatsSnapshot = {
      candidatePair:
        pair && local && remote
          ? {
              localType: local.candidateType,
              remoteType: remote.candidateType,
              protocol: local.protocol ?? remote.protocol ?? null,
              relayProtocol: local.relayProtocol ?? null,
              currentRoundTripTimeMs:
                pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
            }
          : null,
      audioOutboundCodec: null,
      audioInboundCodec: null,
      videoOutboundCodec: null,
      videoInboundCodec: null,
      audioBytesSent: 0,
      audioBytesReceived: 0,
      videoBytesSent: 0,
      videoBytesReceived: 0,
      audioPacketsReceived: 0,
      audioPacketsLost: 0,
      videoPacketsReceived: 0,
      videoPacketsLost: 0,
    };
    for (const stat of byId.values()) {
      if (stat.type === 'outbound-rtp') {
        const rtp = stat as RTCOutboundRtpStreamStats;
        if (rtp.kind === 'audio') {
          snapshot.audioBytesSent += rtp.bytesSent ?? 0;
          snapshot.audioOutboundCodec = codecOf(rtp.codecId);
        } else if (rtp.kind === 'video') {
          snapshot.videoBytesSent += rtp.bytesSent ?? 0;
          snapshot.videoOutboundCodec = codecOf(rtp.codecId);
        }
      } else if (stat.type === 'inbound-rtp') {
        const rtp = stat as RTCInboundRtpStreamStats;
        if (rtp.kind === 'audio') {
          snapshot.audioBytesReceived += rtp.bytesReceived ?? 0;
          snapshot.audioPacketsReceived += rtp.packetsReceived ?? 0;
          snapshot.audioPacketsLost += rtp.packetsLost ?? 0;
          snapshot.audioInboundCodec = codecOf(rtp.codecId);
        } else if (rtp.kind === 'video') {
          snapshot.videoBytesReceived += rtp.bytesReceived ?? 0;
          snapshot.videoPacketsReceived += rtp.packetsReceived ?? 0;
          snapshot.videoPacketsLost += rtp.packetsLost ?? 0;
          snapshot.videoInboundCodec = codecOf(rtp.codecId);
        }
      }
    }
    return snapshot;
  }

  async hangup(call: Call): Promise<void> {
    if (this.currentCall === call) {
      this.logEvent('call', 'Hanging up', call.id);
      this.releaseCall();
    }
    try {
      await call.hangup();
    } catch (error) {
      log.debug('Hangup (ignored):', error);
    }
  }

  async hangupCurrent(): Promise<void> {
    if (this.currentCall) await this.hangup(this.currentCall);
  }

  // The live session's diagnostics, or the last session's once disconnected.
  // Holds connection events, call summaries and device changes; no
  // credentials.
  exportDiagnostics(): SessionDiagnostics | null {
    return this.client?.exportDiagnostics() ?? this.lastDiagnostics;
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.releaseCall();
    try {
      this.lastDiagnostics = client.exportDiagnostics();
    } catch (error) {
      log.debug('exportDiagnostics before disconnect (ignored):', error);
    }
    this.clientSubs.forEach((sub) => sub.unsubscribe());
    this.clientSubs = [];
    this.client = null;
    this.isReady = false;
    try {
      await client.disconnect();
      this.logEvent('client', 'Disconnected');
    } catch (error) {
      log.debug('Disconnect (ignored):', error);
    }
  }

  private requireClient(): InstanceType<typeof SignalWire> {
    if (!this.client) throw new Error('Not connected to SignalWire');
    return this.client;
  }

  private releaseCall() {
    this.callSubs.forEach((sub) => sub.unsubscribe());
    this.callSubs = [];
    this.pcListenerDisposer?.();
    this.pcListenerDisposer = null;
    if (this.pcPollTimer) {
      clearInterval(this.pcPollTimer);
      this.pcPollTimer = null;
    }
    const sink = document.getElementById(REMOTE_SINK_ID) as HTMLAudioElement | null;
    if (sink) sink.srcObject = null;
    this.currentCall = null;
  }

  // Remote media goes to one <audio> element, muted: the echo returns this
  // browser's own audio, which is received and measured but not played, so
  // a laptop's microphone doesn't feed back into the test. remoteStream$ and
  // the peer-connection fallback deliver the same track in different
  // MediaStream wrappers, so a track already attached is left alone.
  private attachRemoteStream(stream: MediaStream) {
    let sink = document.getElementById(REMOTE_SINK_ID) as HTMLAudioElement | null;
    if (!sink) {
      sink = document.createElement('audio');
      sink.id = REMOTE_SINK_ID;
      sink.autoplay = true;
      sink.muted = true;
      document.body.appendChild(sink);
    }
    const current = sink.srcObject as MediaStream | null;
    const incoming = stream.getTracks();
    if (current && incoming.length > 0 && incoming.every((track) => current.getTrackById(track.id))) return;
    sink.srcObject = stream;
    sink.play().catch((error) => log.debug('Remote sink play() refused (ignored):', error));
    this.logEvent('media', 'Remote media attached', incoming.map((track) => track.kind).join(', '));
  }

  // remoteStream$ isn't always reliable, so also listen on the peer
  // connection itself (which may not exist yet when dial() resolves), and
  // log its ICE state for the timeline.
  private watchPeerConnection(call: Call) {
    const attach = (pc: RTCPeerConnection) => {
      const onTrack = (event: RTCTrackEvent) => {
        if (this.currentCall !== call) return;
        this.attachRemoteStream(event.streams[0] ?? new MediaStream([event.track]));
      };
      let lastIce: RTCIceConnectionState | null = null;
      const onIce = () => {
        if (this.currentCall !== call || pc.iceConnectionState === lastIce) return;
        lastIce = pc.iceConnectionState;
        this.logEvent('media', `ICE ${lastIce}`, `peer connection ${pc.connectionState}`);
      };
      pc.addEventListener('track', onTrack);
      pc.addEventListener('iceconnectionstatechange', onIce);
      this.pcListenerDisposer = () => {
        pc.removeEventListener('track', onTrack);
        pc.removeEventListener('iceconnectionstatechange', onIce);
      };
      const live = pc
        .getReceivers()
        .map((receiver) => receiver.track)
        .filter((track): track is MediaStreamTrack => !!track && track.readyState === 'live');
      if (live.length) this.attachRemoteStream(new MediaStream(live));
    };
    if (call.rtcPeerConnection) {
      attach(call.rtcPeerConnection);
      return;
    }
    let attempts = 0;
    this.pcPollTimer = setInterval(() => {
      attempts += 1;
      const pc = call.rtcPeerConnection;
      if (pc || attempts > 40 || this.currentCall !== call) {
        if (this.pcPollTimer) clearInterval(this.pcPollTimer);
        this.pcPollTimer = null;
        if (pc && this.currentCall === call) attach(pc);
      }
    }, 250);
  }
}

export const signalWireService = new SignalWireService();
