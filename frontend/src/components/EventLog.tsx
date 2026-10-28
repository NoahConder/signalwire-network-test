import { useEffect, useRef, useState } from 'react';
import { Copy, Eraser } from 'lucide-react';
import { signalWireService, type AppEvent, type AppEventKind } from '../services/signalwire';
import { formatEventLine } from '../services/diagnostics';

type KindFilter = AppEventKind | 'all';

// "Errors" also shows warnings; the rest map one-to-one.
const FILTERS: Array<{ key: KindFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'test', label: 'Test' },
  { key: 'call', label: 'Calls' },
  { key: 'media', label: 'Media' },
  { key: 'client', label: 'Client' },
  { key: 'error', label: 'Errors' },
];

const KIND_CLASS: Record<AppEventKind, string> = {
  test: 'bg-surface-2 text-muted',
  call: 'bg-grass-soft text-grass-text',
  media: 'bg-accent-soft text-accent-text',
  client: 'bg-accent-soft text-accent-text',
  warning: 'bg-warn-soft text-warn-text',
  error: 'bg-danger-soft text-danger-text',
};

// Matches the service's replay depth; older rows fall off the top.
const MAX_ROWS = 500;

const formatClock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const matchesFilter = (event: AppEvent, filter: KindFilter): boolean =>
  filter === 'all' || event.kind === filter || (filter === 'error' && event.kind === 'warning');

interface EventLogProps {
  // Height of the scrolling list when not filling.
  className?: string;
  // Fill the parent flex column instead (the side column on wide screens).
  fill?: boolean;
}

// What the SDK and the runner did, in order (signalwire.ts's getEventLog$):
// the steps, token minting, connection changes, call status, errors and
// warnings, ICE and recovery. Subscribes directly to the service; follows the
// newest entry unless the user has scrolled up.
function EventLog({ className = 'max-h-56', fill = false }: EventLogProps) {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [filter, setFilter] = useState<KindFilter>('all');
  // "Clear" hides what's been logged so far rather than emptying the
  // service's buffer, which the report still wants.
  const [clearedAt, setClearedAt] = useState(0);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const isPinnedRef = useRef(true);

  useEffect(() => {
    const sub = signalWireService.getEventLog$().subscribe((event) => {
      setEvents((prev) => [...prev.slice(-(MAX_ROWS - 1)), event]);
    });
    return () => sub.unsubscribe();
  }, []);

  const visible = events.filter((event) => event.at > clearedAt && matchesFilter(event, filter));

  useEffect(() => {
    const list = listRef.current;
    if (list && isPinnedRef.current) list.scrollTop = list.scrollHeight;
  }, [visible.length]);

  const handleScroll = () => {
    const list = listRef.current;
    if (!list) return;
    isPinnedRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
  };

  const copyVisible = async () => {
    try {
      await navigator.clipboard.writeText(visible.map(formatEventLine).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context); the rows are selectable.
    }
  };

  return (
    <div className={fill ? 'flex min-h-0 flex-1 flex-col' : ''}>
      <div className="mb-2 flex shrink-0 items-center gap-1" role="group" aria-label="Filter events">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                filter === f.key ? 'bg-accent-soft text-accent-text' : 'text-muted hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={copyVisible}
          aria-label="Copy event log"
          title={copied ? 'Copied' : 'Copy the visible entries'}
          className={`shrink-0 rounded-full p-2 transition-colors hover:bg-surface-hover hover:text-ink ${
            copied ? 'text-success-text' : 'text-muted'
          }`}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          onClick={() => setClearedAt(Date.now())}
          aria-label="Clear event log"
          title="Hide the entries so far"
          className="shrink-0 rounded-full p-2 text-muted transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <Eraser size={13} />
        </button>
      </div>

      {/* aria-live is off: this is for reading, not listening. */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        role="log"
        aria-live="off"
        className={`overflow-y-auto ${fill ? 'min-h-0 flex-1' : className}`}
      >
        {visible.length === 0 ? (
          <div className="py-3 text-sm text-muted">No events yet.</div>
        ) : (
          <ol className="font-mono text-xs">
            {visible.map((event, index) => (
              <li key={`${event.at}-${index}`} className="flex items-start gap-2 py-1 select-text">
                <span className="shrink-0 tabular-nums text-faint">{formatClock(event.at)}</span>
                <span
                  className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                    KIND_CLASS[event.kind]
                  }`}
                >
                  {event.kind}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{event.message}</span>
                  {event.detail && (
                    <span className="block break-words text-faint" title={event.detail}>
                      {event.detail}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? 'Event log copied' : ''}
      </span>
    </div>
  );
}

export default EventLog;
