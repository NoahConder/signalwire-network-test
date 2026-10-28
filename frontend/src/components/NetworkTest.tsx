import { useEffect, useRef, useState } from 'react';
import { Activity, Check, Copy, Download, Moon, Play, RefreshCw, Square, Sun } from 'lucide-react';
import EventLog from './EventLog';
import ErrorBanner from './ErrorBanner';
import StepRow from './StepRow';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { describeFetchError, networkTestAPI } from '../services/api';
import { TURNSTILE_SITE_KEY, loadTurnstile } from '../services/captcha';
import { buildReport, downloadJson, downloadRtcStatsDump, summarizeRun } from '../services/diagnostics';
import { networkTestRunner, type StepId, type TestRun } from '../services/networkTest';
import { signalWireService, type AppEvent, type TokenFetcher } from '../services/signalwire';
import { applyTheme, loadThemePreference, saveThemePreference, currentTheme, type ThemePreference } from '../services/theme';
import type { NetworkTestConfig } from '../types';

// Test seam, dev server only: `?e2e=1` keeps the page off the backend's
// token endpoint (the runner's steps are stubbed by the Playwright suite,
// see e2e/helpers.ts). The configuration request still goes out, so the
// suite answers it with a route.
const E2E_SEAM = import.meta.env.DEV && new URLSearchParams(window.location.search).has('e2e');

// Wide enough for the event log beside the steps instead of under them.
const SIDE_LOG_QUERY = '(min-width: 1024px)';

const EVENTS_KEPT = 500;

const queryRegion = (): string =>
  new URLSearchParams(window.location.search).get('region')?.trim().toLowerCase() ?? '';

const describeRun = (run: TestRun): string => {
  if (run.status === 'idle') return 'Ready. Nothing has run yet.';
  if (run.status === 'running') {
    const current = run.steps.find((step) => step.status === 'running');
    return current ? `Running ${current.name}…` : 'Starting…';
  }
  if (run.status === 'stopped') return 'Stopped.';
  const counts = { passed: 0, warning: 0, failed: 0, skipped: 0 };
  for (const step of run.steps) if (step.status in counts) counts[step.status as keyof typeof counts] += 1;
  const parts = [
    counts.passed ? `${counts.passed} passed` : '',
    counts.warning ? `${counts.warning} with warnings` : '',
    counts.failed ? `${counts.failed} failed` : '',
    counts.skipped ? `${counts.skipped} skipped` : '',
  ].filter(Boolean);
  const verdict = run.status === 'passed' ? 'Finished' : run.status === 'warning' ? 'Finished with warnings' : 'Finished with failures';
  return `${verdict}: ${parts.join(', ')}.`;
};

function NetworkTest() {
  const [config, setConfig] = useState<NetworkTestConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configAttempt, setConfigAttempt] = useState(0);
  const [region, setRegion] = useState<string>(queryRegion);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const [run, setRun] = useState<TestRun>(networkTestRunner.getRun());
  const [startError, setStartError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<StepId>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference);
  const sideLog = useMediaQuery(SIDE_LOG_QUERY);
  const captchaMount = useRef<HTMLDivElement>(null);
  const captchaWidget = useRef<string | null>(null);
  const events = useRef<AppEvent[]>([]);

  // The configuration: regions and whether a captcha token is needed.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const loaded = await networkTestAPI.config();
        if (cancelled) return;
        setConfig(loaded);
        setConfigError(null);
        // ?region= preselects a known region; anything else is the default.
        setRegion((current) => (current && loaded.regions.includes(current) ? current : loaded.default_region));
      } catch (err) {
        if (!cancelled) setConfigError(describeFetchError(err, 'Could not load the test configuration'));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [configAttempt]);

  useEffect(() => {
    const sub = networkTestRunner.getRun$().subscribe(setRun);
    return () => sub.unsubscribe();
  }, []);

  // The report needs the events too; EventLog keeps its own copy for display.
  useEffect(() => {
    const sub = signalWireService.getEventLog$().subscribe((event) => {
      events.current = [...events.current.slice(-(EVENTS_KEPT - 1)), event];
    });
    return () => sub.unsubscribe();
  }, []);

  // The captcha widget, when the backend wants one and the page has a site
  // key. The token it yields is single-use: start() clears it and resets the
  // widget for the next run.
  const captchaWanted = !!config?.captcha_required && !!TURNSTILE_SITE_KEY;
  useEffect(() => {
    if (!captchaWanted) return;
    let removed = false;
    loadTurnstile()
      .then((turnstile) => {
        if (removed || !captchaMount.current || !TURNSTILE_SITE_KEY) return;
        captchaWidget.current = turnstile.render(captchaMount.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: currentTheme(),
          size: 'flexible',
          callback: (token) => {
            setCaptchaToken(token);
            setCaptchaError(null);
          },
          'expired-callback': () => setCaptchaToken(null),
          'error-callback': () => setCaptchaError('The captcha could not be completed. Reload the page to try again.'),
        });
      })
      .catch((err: Error) => setCaptchaError(err.message));
    return () => {
      removed = true;
      if (captchaWidget.current && window.turnstile) {
        window.turnstile.remove(captchaWidget.current);
        captchaWidget.current = null;
      }
    };
  }, [captchaWanted]);

  const running = run.status === 'running';
  const finished = !running && run.status !== 'idle';
  const captchaMisconfigured = !!config?.captcha_required && !TURNSTILE_SITE_KEY;
  const canStart = !!config && !running && !captchaMisconfigured && (!config.captcha_required || !!captchaToken);

  const start = async () => {
    if (!config || !canStart) return;
    setStartError(null);
    setCopied(false);
    setExpanded(new Set());
    const token = captchaToken;
    setCaptchaToken(null);
    const fetchToken: TokenFetcher = E2E_SEAM
      ? async () => {
          throw new Error('No backend in e2e mode');
        }
      : async () => {
          try {
            return await networkTestAPI.token(region, token);
          } catch (err) {
            throw new Error(describeFetchError(err, 'Could not get a token'));
          }
        };
    try {
      await networkTestRunner.start({ region, fetchToken });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'The test could not start');
    }
    if (captchaWidget.current && window.turnstile) window.turnstile.reset(captchaWidget.current);
  };

  const toggleExpanded = (id: StepId) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const stamp = () => new Date(run.startedAt ?? Date.now()).toISOString().replace(/[:.]/g, '-');
  const download = () => downloadJson(`signalwire-network-test-${stamp()}.json`, buildReport(run, events.current));
  const downloadTrace = () => downloadRtcStatsDump(`signalwire-network-test-${stamp()}.rtcstats`, run);

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summarizeRun(run));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context); the rows are selectable.
    }
  };

  const toggleTheme = () => {
    const next: ThemePreference = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    saveThemePreference(next);
    setTheme(next);
  };
  const isDark = theme === 'dark' || (theme === 'system' && currentTheme() === 'dark');

  const regions = config?.regions ?? [];

  return (
    <div className="app-shell flex min-h-dvh flex-col">
      <header className="glass-bar pt-safe sticky top-0 z-10">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="font-display text-base font-semibold tracking-tight text-ink-strong">SignalWire</span>
            <span className="truncate text-sm text-muted">Network Test</span>
          </div>
          <div className="flex items-center gap-2">
            {region && (
              <span
                className="rounded-md bg-accent-soft px-2 py-0.5 font-mono text-xs text-accent-text"
                title="Region under test"
              >
                {region}
              </span>
            )}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={isDark ? 'Switch to the light theme' : 'Switch to the dark theme'}
              className="rounded-full p-2 text-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              {isDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </div>
      </header>

      <main className={`mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-safe ${sideLog ? 'grid grid-cols-[minmax(0,1fr)_22rem] gap-6' : ''}`}>
        <section aria-labelledby="test-title" className="min-w-0">
          <h1 id="test-title" className="text-2xl font-semibold">
            Network test
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Checks this browser's path to SignalWire the way a call would use it: signaling, TURN over each transport, a
            voice call on Opus and on PCMU, and a video room with and without TURN. Nothing runs until you start it; the
            microphone is requested when the voice calls begin, the camera when the video steps do.
          </p>

          {configError && (
            <div role="alert" className="glass-panel mt-4 flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-sm">
              <span className="min-w-0 flex-1 text-danger-text select-text">{configError}</span>
              <button
                type="button"
                onClick={() => setConfigAttempt((n) => n + 1)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-edge-strong bg-surface-2 px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-hover"
              >
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            </div>
          )}
          {captchaMisconfigured && (
            <ErrorBanner
              className="mt-4 w-full"
              message="The backend requires a captcha, but this page was built without TURNSTILE_SITE_KEY."
              onDismiss={() => undefined}
            />
          )}
          {captchaError && <ErrorBanner className="mt-4 w-full" message={captchaError} onDismiss={() => setCaptchaError(null)} />}
          {startError && <ErrorBanner className="mt-4 w-full" message={startError} onDismiss={() => setStartError(null)} />}

          <div className="glass-panel mt-4 rounded-xl p-4">
            <div className="flex flex-wrap items-end gap-3">
              {regions.length > 1 && (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                  Region
                  <select
                    value={region}
                    onChange={(event) => setRegion(event.target.value)}
                    disabled={running}
                    className="rounded-lg border border-edge-strong bg-surface-2 px-3 py-2 text-sm text-ink"
                  >
                    {regions.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {running ? (
                <button
                  type="button"
                  onClick={() => networkTestRunner.stop()}
                  className="inline-flex items-center gap-2 rounded-lg bg-hangup px-4 py-2 text-sm font-medium text-on-hangup transition-all hover:bg-hangup-hover active:scale-[0.98]"
                >
                  <Square size={14} aria-hidden="true" /> Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={!canStart}
                  className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-all hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Play size={14} aria-hidden="true" /> Start test
                </button>
              )}
              <p role="status" aria-live="polite" className="min-w-0 flex-1 basis-full text-sm text-muted sm:basis-auto">
                {config || configError ? describeRun(run) : 'Loading configuration…'}
              </p>
            </div>
            {captchaWanted && (
              <div className="mt-3">
                <div ref={captchaMount} aria-label="Captcha" />
                {!captchaToken && !captchaError && (
                  <p className="mt-1 text-xs text-faint">Complete the check above to enable the test.</p>
                )}
              </div>
            )}
          </div>

          <ol role="list" aria-label="Test steps" className="glass-panel mt-4 rounded-xl">
            {run.steps.map((step) => (
              <StepRow key={step.id} step={step} expanded={expanded.has(step.id)} onToggle={() => toggleExpanded(step.id)} />
            ))}
          </ol>

          {finished && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={download}
                className="inline-flex items-center gap-2 rounded-lg border border-edge-strong bg-surface-2 px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-hover"
              >
                <Download size={14} aria-hidden="true" /> Download report
              </button>
              <button
                type="button"
                onClick={() => void copySummary()}
                className="inline-flex items-center gap-2 rounded-lg border border-edge-strong bg-surface-2 px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-hover"
              >
                {copied ? <Check size={14} aria-hidden="true" className="text-success-text" /> : <Copy size={14} aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy summary'}
              </button>
              <button
                type="button"
                onClick={downloadTrace}
                title="Every peer connection's events and per-second stats, as an rtcstats dump"
                className="inline-flex items-center gap-2 rounded-lg border border-edge-strong bg-surface-2 px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-hover"
              >
                <Activity size={14} aria-hidden="true" /> Download WebRTC trace
              </button>
              <span role="status" aria-live="polite" className="sr-only">
                {copied ? 'Summary copied' : ''}
              </span>
              <p className="basis-full text-xs text-faint">
                The report and the trace cover this run and are kept only in this page. Download them before you reload or
                run the test again.
              </p>
            </div>
          )}

          <p className="mt-4 text-xs text-faint">
            TURN over TLS is tested only when the platform hands the session a <code className="font-mono">turns:</code> URL;
            otherwise that row says it wasn't advertised. The voice calls go to an echo that sends your audio straight
            back. The page measures what comes back but doesn't play it, so you won't hear yourself during the test. The
            report and the WebRTC trace are built in this browser and leave it only when you download them; they include
            IP addresses and device names.
          </p>
        </section>

        <aside aria-labelledby="events-title" className={`mt-8 min-w-0 ${sideLog ? 'mt-0 flex max-h-[calc(100dvh-6rem)] flex-col' : ''}`}>
          <h2 id="events-title" className="mb-2 text-sm font-semibold text-muted">
            Events
          </h2>
          <div className={`glass-panel rounded-xl p-3 ${sideLog ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
            <EventLog fill={sideLog} className="max-h-72" />
          </div>
        </aside>
      </main>
    </div>
  );
}

export default NetworkTest;
