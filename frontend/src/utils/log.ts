// This app's own logging (the SDK's is separate: its logLevel is set on the
// client). debug/info trace the run and are off unless the page was opened
// with ?debug or localStorage network_test_debug is "1"; warn/error always
// print. The page's event log (signalwire.ts's getEventLog$) is the tester's
// timeline; this is for developers.
const readDebugFlag = (): boolean => {
  try {
    if (new URLSearchParams(window.location.search).has('debug')) return true;
    return localStorage.getItem('network_test_debug') === '1';
  } catch {
    return false;
  }
};

let debugEnabled: boolean | null = null;

const isDebugEnabled = (): boolean => {
  if (debugEnabled === null) debugEnabled = readDebugFlag();
  return debugEnabled;
};

export const log = {
  debug: (...args: unknown[]) => {
    if (isDebugEnabled()) console.debug(...args);
  },
  info: (...args: unknown[]) => {
    if (isDebugEnabled()) console.info(...args);
  },
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};
