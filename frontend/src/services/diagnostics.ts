import type { SessionDiagnostics } from '@signalwire/js';
import { signalWireService, type AppEvent } from './signalwire';
import { getRtcStatsDump, getRtcTraceInfo, type RtcTraceInfo } from './rtcTrace';
import type { StepResult, TestRun } from './networkTest';

// The downloadable report: the run as the page showed it (with each call
// step's per-second series), the SDK's own session diagnostics, the event
// log, what browser this was, and the page's full WebRTC recording as an
// rtcstats dump (services/rtcTrace.ts). TURN credentials never appear in it:
// the steps record URLs only and rtcstats-js strips `credential` from the
// configurations it records. The dump does carry SDP and ICE candidates, so
// IP addresses, and device labels; it is built in the browser and only ever
// leaves it as this download.
export interface NetworkTestReport {
  format: 'signalwire-network-test/1';
  generatedAt: string;
  page: { version: string; sdkVersion: string; url: string };
  browser: { userAgent: string; language: string; platform: string };
  run: TestRun;
  events: string[];
  diagnostics: SessionDiagnostics | null;
  rtcstats: RtcTraceInfo;
  // This run's connections and device entries (see rtcTrace.ts).
  rtcstatsDump: string;
}

const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'dev';

// One line per event, in a shape that pastes into a ticket.
export const formatEventLine = (event: AppEvent): string =>
  `${new Date(event.at).toISOString()} [${event.kind}] ${event.message}${event.detail ? ` — ${event.detail}` : ''}`;

export const buildReport = (run: TestRun, events: AppEvent[]): NetworkTestReport => ({
  format: 'signalwire-network-test/1',
  generatedAt: new Date().toISOString(),
  page: { version: APP_VERSION, sdkVersion: signalWireService.getSdkVersion(), url: window.location.href },
  browser: { userAgent: navigator.userAgent, language: navigator.language, platform: navigator.platform },
  run,
  events: events.map(formatEventLine),
  diagnostics: signalWireService.exportDiagnostics(),
  rtcstats: getRtcTraceInfo(run.startedAt ?? undefined, run.finishedAt ?? undefined),
  rtcstatsDump: getRtcStatsDump(run.startedAt ?? undefined, run.finishedAt ?? undefined),
});

const STATUS_MARK: Record<StepResult['status'], string> = {
  pending: '·',
  running: '…',
  passed: 'PASS',
  warning: 'WARN',
  failed: 'FAIL',
  skipped: 'SKIP',
};

// Plain text for pasting into a ticket.
export const summarizeRun = (run: TestRun): string => {
  const when = run.startedAt ? new Date(run.startedAt).toISOString() : 'not run';
  const lines = [
    `SignalWire network test — ${when} — region ${run.region ?? '–'} — result: ${run.status}`,
    `${navigator.userAgent}`,
    `SDK ${signalWireService.getSdkVersion()} · page ${APP_VERSION}`,
    '',
    ...run.steps.map(
      (step) =>
        `${STATUS_MARK[step.status].padEnd(4)} ${step.name}${step.durationMs != null ? ` (${(step.durationMs / 1000).toFixed(1)} s)` : ''}: ${
          step.result || step.status
        }`,
    ),
  ];
  return lines.join('\n');
};

export const downloadJson = (filename: string, data: unknown) =>
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));

// The run's rtcstats dump on its own, for rtcstats' dump importer.
export const downloadRtcStatsDump = (filename: string, run: TestRun) =>
  downloadBlob(
    filename,
    new Blob([getRtcStatsDump(run.startedAt ?? undefined, run.finishedAt ?? undefined)], { type: 'text/plain' }),
  );

const downloadBlob = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
