import type { Page } from '@playwright/test';

declare global {
  interface Window {
    __log: unknown[][];
  }
}

// What the page gets from GET /api/network-test/config unless a test says
// otherwise: two regions, no captcha.
export const E2E_CONFIG = {
  success: true,
  data: { regions: ['global', 'eu'], default_region: 'global', captcha_required: false },
};

export const stubConfig = (page: Page, body: unknown = E2E_CONFIG, status = 200) =>
  page.route('**/api/network-test/config', (route) => route.fulfill({ status, json: body }));

// Open the page through the dev-only `?e2e=1` seam: the runner never asks the
// backend for a token, and the tests replace its step functions.
export async function openPage(page: Page, path = '/', config: unknown = E2E_CONFIG) {
  await stubConfig(page, config);
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}e2e=1`);
  await page.getByRole('button', { name: 'Start test' }).waitFor();
  await page.evaluate(() => {
    window.__log = [];
  });
}

// Run JS in the page with `runner` (the NetworkTestRunner singleton), `STEPS`,
// `s` (the SignalWire service) and `log(...entry)` (appends to window.__log)
// in scope.
export function evalInApp<T = unknown>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(async () => {
    const { networkTestRunner: runner, STEPS } = await import('/src/services/networkTest.ts');
    const { signalWireService: s } = await import('/src/services/signalwire.ts');
    const log = (...entry) => window.__log.push(entry);
    ${body}
  })()`) as Promise<T>;
}

export const drainLog = (page: Page) => page.evaluate(() => window.__log.splice(0));

export interface FakeOutcome {
  status: 'passed' | 'warning' | 'failed' | 'skipped';
  result: string;
  details?: Record<string, unknown>;
}

// A run where everything passes, with the shape of the real details.
export const PASSING_OUTCOMES: Record<string, FakeOutcome> = {
  signaling: {
    status: 'passed',
    result: 'Connected and authenticated in 312 ms · TURN over UDP, TCP',
    details: { connectMs: 312, region: 'global', sdkVersion: '4.0.0-rc.5', iceServerUrls: ['turn:turn.example:3478', 'turn:turn.example:3478?transport=tcp'], turnTransports: ['udp', 'tcp'] },
  },
  'turn-udp': {
    status: 'passed',
    result: 'Relay over UDP: allocated in 140 ms, data channel open in 420 ms, ping 38.5 ms',
    details: { transport: 'udp', relayCandidates: 2, firstRelayCandidateMs: 140, channelOpenMs: 420, pingRttMs: 38.5, relayProtocol: 'udp' },
  },
  'turn-tcp': {
    status: 'passed',
    result: 'Relay over TCP: allocated in 210 ms, data channel open in 610 ms, ping 41 ms',
    details: { transport: 'tcp', relayCandidates: 2, firstRelayCandidateMs: 210, channelOpenMs: 610, pingRttMs: 41, relayProtocol: 'tcp' },
  },
  'turn-tls': {
    status: 'passed',
    result: 'Relay over TLS: allocated in 260 ms, data channel open in 700 ms, ping 44 ms',
    details: { transport: 'tls', relayCandidates: 2, firstRelayCandidateMs: 260, channelOpenMs: 700, pingRttMs: 44, relayProtocol: 'tls' },
  },
  'voice-opus': {
    status: 'passed',
    result: 'opus 48k · ↑ 62 kbps ↓ 61 kbps · RTT 42 ms (max 55 ms) · jitter 3 ms · loss 0% · srflx → host over udp · MOS 4.4',
    details: { codecRequested: 'opus', codecInbound: 'opus 48k', uploadKbps: 62, downloadKbps: 61, rttAvgMs: 42, rttMaxMs: 55, jitterAvgMs: 3, lossPct: 0, mos: 4.4, callId: 'call-opus-1' },
  },
  'voice-pcmu': {
    status: 'passed',
    result: 'PCMU 8k · ↑ 84 kbps ↓ 83 kbps · RTT 43 ms (max 51 ms) · jitter 2 ms · loss 0% · srflx → host over udp · MOS 4.3',
    details: { codecRequested: 'PCMU', codecInbound: 'PCMU 8k', uploadKbps: 84, downloadKbps: 83, rttAvgMs: 43, rttMaxMs: 51, jitterAvgMs: 2, lossPct: 0, mos: 4.3, callId: 'call-pcmu-1' },
  },
  'video-turn': {
    status: 'passed',
    result: 'video VP8 ↑ / VP8 ↓ · ↑ 980 kbps ↓ 1120 kbps · RTT 47 ms (max 60 ms) · jitter 4 ms · loss 0% · relay (udp) → relay over udp · MOS 4.3',
    details: { relayOnly: true, videoCodecOutbound: 'VP8', uploadKbps: 980, downloadKbps: 1120, path: 'relay (udp) → relay over udp', callId: 'call-video-1' },
  },
  'video-direct': {
    status: 'passed',
    result: 'video VP8 ↑ / VP8 ↓ · ↑ 1010 kbps ↓ 1150 kbps · RTT 41 ms (max 52 ms) · jitter 3 ms · loss 0% · srflx → host over udp · MOS 4.4',
    details: { relayOnly: false, videoCodecOutbound: 'VP8', uploadKbps: 1010, downloadKbps: 1150, path: 'srflx → host over udp', callId: 'call-video-2' },
  },
};

// Replace every step with a stub that records its id and returns the given
// outcome after a tick. A `null` override installs a step that never
// resolves (for the Stop test).
export const stubSteps = (page: Page, overrides: Record<string, FakeOutcome | null> = {}) =>
  evalInApp(
    page,
    `
    const outcomes = ${JSON.stringify({ ...PASSING_OUTCOMES, ...overrides })};
    for (const id of Object.keys(outcomes)) {
      const outcome = outcomes[id];
      runner.steps[id] = async () => {
        log('step', id);
        if (outcome === null) await new Promise(() => {});
        await new Promise((resolve) => setTimeout(resolve, 20));
        return outcome;
      };
    }
  `,
  );

export const stepRows = (page: Page) => page.getByRole('list', { name: 'Test steps' }).getByRole('listitem');

export const runStatus = (page: Page) => page.locator('[role="status"][aria-live="polite"]').first();

export const startRun = async (page: Page) => {
  await page.getByRole('button', { name: 'Start test' }).click();
  await page.getByRole('button', { name: 'Download report' }).waitFor();
};
