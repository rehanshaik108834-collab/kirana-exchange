import { AlertTriangle, CheckCircle2, CloudOff, Loader2, UploadCloud } from 'lucide-react';
import type { StoredEntry } from './queue';
import type { SyncState } from './sync-engine';

export interface SyncSummary {
  tone: 'ok' | 'busy' | 'offline' | 'attention' | 'waiting';
  label: string;
}

/** Single plain-language sync status (US-13), most urgent first. */
export function summariseSync(state: SyncState, entries: StoredEntry[]): SyncSummary {
  const conflicts = entries.filter((e) => e.status === 'conflict').length;
  const waiting = entries.length - conflicts;
  if (conflicts > 0) {
    return {
      tone: 'attention',
      label: conflicts === 1 ? '1 needs attention' : `${conflicts} need attention`,
    };
  }
  if (state === 'offline') {
    return { tone: 'offline', label: waiting > 0 ? `Offline · ${waiting} waiting` : 'Offline' };
  }
  if (state === 'signed-out' && waiting > 0) {
    return { tone: 'attention', label: `${waiting} waiting · sign in again` };
  }
  if (state === 'syncing' && waiting > 0) return { tone: 'busy', label: 'Syncing…' };
  if (waiting > 0) return { tone: 'waiting', label: `${waiting} waiting` };
  return { tone: 'ok', label: 'All saved' };
}

const STYLES: Record<SyncSummary['tone'], string> = {
  ok: 'bg-teal-50 text-teal-800',
  busy: 'bg-sky-50 text-sky-800',
  waiting: 'bg-amber-50 text-amber-900',
  offline: 'bg-slate-200 text-slate-800',
  attention: 'bg-red-100 text-red-800',
};

export function SyncChip({ state, entries }: { state: SyncState; entries: StoredEntry[] }) {
  const summary = summariseSync(state, entries);
  const Icon =
    summary.tone === 'ok'
      ? CheckCircle2
      : summary.tone === 'busy'
        ? Loader2
        : summary.tone === 'offline'
          ? CloudOff
          : summary.tone === 'attention'
            ? AlertTriangle
            : UploadCloud;
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${STYLES[summary.tone]}`}
    >
      <Icon
        className={`h-3.5 w-3.5 ${summary.tone === 'busy' ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      {summary.label}
    </span>
  );
}
