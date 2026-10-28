import { AlertTriangle, CheckCircle2, ChevronDown, Circle, Loader2, MinusCircle, XCircle } from 'lucide-react';
import type { StepResult, StepStatus } from '../services/networkTest';

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  passed: 'Passed',
  warning: 'Warning',
  failed: 'Failed',
  skipped: 'Skipped',
};

const STATUS_ICON: Record<StepStatus, typeof Circle> = {
  pending: Circle,
  running: Loader2,
  passed: CheckCircle2,
  warning: AlertTriangle,
  failed: XCircle,
  skipped: MinusCircle,
};

const STATUS_CLASS: Record<StepStatus, string> = {
  pending: 'text-faint',
  running: 'text-accent-text',
  passed: 'text-success-text',
  warning: 'text-warn-text',
  failed: 'text-danger-text',
  skipped: 'text-faint',
};

// "firstRelayCandidateMs" → "First relay candidate ms".
const labelOf = (key: string): string => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const formatValue = (value: unknown): string => {
  if (value == null || value === '') return '–';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length ? value.map(formatValue).join(', ') : '–';
  return JSON.stringify(value);
};

const formatDuration = (durationMs: number | null): string =>
  durationMs == null ? '' : `${(durationMs / 1000).toFixed(1)} s`;

interface StepRowProps {
  step: StepResult;
  expanded: boolean;
  onToggle: () => void;
}

// One step: status icon, name, the one-line result (or what the step does
// while it has none) and a disclosure with every measurement. The status is
// also spoken, since the icon alone carries it visually.
function StepRow({ step, expanded, onToggle }: StepRowProps) {
  const Icon = STATUS_ICON[step.status];
  const detailsId = `${step.id}-details`;
  const entries = Object.entries(step.details).filter(([, value]) => value !== undefined);
  return (
    <li className="border-b border-edge last:border-b-0" data-step={step.id} data-status={step.status}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={detailsId}
        className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-surface-hover"
      >
        <span className={`mt-0.5 shrink-0 ${STATUS_CLASS[step.status]}`} aria-hidden="true">
          <Icon size={18} className={step.status === 'running' ? 'motion-safe:animate-spin' : ''} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="font-medium text-ink">{step.name}</span>
            <span className="shrink-0 text-xs tabular-nums text-faint">{formatDuration(step.durationMs)}</span>
          </span>
          <span className="block break-words text-sm text-muted select-text">
            <span className="sr-only">{STATUS_LABEL[step.status]}: </span>
            {step.result || step.summary}
          </span>
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`mt-1 shrink-0 text-faint transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      <div id={detailsId} hidden={!expanded} className="px-3 pb-3 pl-11">
        <p className="mb-2 text-xs text-muted">{step.summary}</p>
        {entries.length ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-xs select-text">
            {entries.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-faint">{labelOf(key)}</dt>
                <dd className="break-words text-ink">{formatValue(value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-faint">No measurements recorded.</p>
        )}
      </div>
    </li>
  );
}

export default StepRow;
