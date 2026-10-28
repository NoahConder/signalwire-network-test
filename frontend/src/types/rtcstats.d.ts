// rtcstats ships plain JavaScript without type declarations. These cover the
// calls services/rtcTrace.ts makes (rtcstats-js 2.5.0, rtcstats-shared 2.6.2).
declare module '@rtcstats/rtcstats-js' {
  export type RTCStatsTrace = (...args: unknown[]) => void;
  export function wrapRTCPeerConnection(
    trace: RTCStatsTrace,
    target: typeof globalThis,
    config: { getStatsInterval: number },
  ): void;
  export function wrapGetUserMedia(trace: RTCStatsTrace, target: typeof globalThis): void;
  export function wrapEnumerateDevices(trace: RTCStatsTrace, target: typeof globalThis): void;
}

declare module '@rtcstats/rtcstats-shared' {
  export function compressMethod(method: string): string | number;
}
