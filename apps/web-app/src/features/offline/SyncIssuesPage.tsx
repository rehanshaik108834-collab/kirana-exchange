import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CloudOff, Loader2 } from 'lucide-react';
import type { StoredEntry } from './queue';
import { countOnCurrentStock, countReducedQty, describeConflict, discardEntry } from './resolve';
import { useQueueEntries } from './runtime';

/** US-14: plain-language fixes for entries the server could not accept. */
export function SyncIssuesPage() {
  const entries = useQueueEntries();
  const conflicts = entries.filter((e) => e.status === 'conflict');
  const blocked = entries.filter((e) => e.status === 'blocked').length;

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-bold text-slate-900">Entries that need attention</h1>

      {conflicts.length === 0 ? (
        <div className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm text-teal-900">
          <p className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> Nothing needs your attention.
          </p>
          <Link to="/inventory" className="mt-2 inline-block font-medium underline">
            Back to my stock
          </Link>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-700">
            These entries were saved on this phone but could not be added to your shop yet.
            {blocked > 0 &&
              ` ${blocked} more ${blocked === 1 ? 'sale is' : 'sales are'} waiting behind them.`}
          </p>
          <ul className="space-y-3">
            {conflicts.map((entry) => (
              <IssueCard key={entry.seq} entry={entry} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function IssueCard({ entry }: { entry: StoredEntry }) {
  const view = describeConflict(entry);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    if (!navigator.onLine) {
      setError('Connect to the internet to fix this. The entry stays saved on this phone.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError('Could not reach the shop server. Please try again when you are online.');
    } finally {
      setBusy(false);
    }
  };

  const soldWhen =
    entry.kind === 'sale'
      ? new Date(entry.payload.soldAt).toLocaleString([], {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : null;

  return (
    <li className="space-y-3 rounded-xl border border-red-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-700" aria-hidden="true" />
        <div>
          <p className="font-semibold text-slate-900">{view.title}</p>
          {soldWhen && <p className="text-xs text-slate-600">Sold on {soldWhen}</p>}
          <p className="mt-1 text-sm text-slate-800">{view.message}</p>
        </div>
      </div>

      {error && (
        <p className="flex items-center gap-1.5 rounded-lg bg-slate-100 p-2 text-xs text-slate-800">
          <CloudOff className="h-4 w-4" aria-hidden="true" /> {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {view.kind === 'version-conflict' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => countOnCurrentStock(entry))}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />}
            Count this sale on the current stock
          </button>
        )}
        {view.kind === 'insufficient-stock' && (view.available ?? 0) > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => countReducedQty(entry, view.available!))}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />}
            Count {view.available} instead
          </button>
        )}
        {!confirmDiscard ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmDiscard(true)}
            className="min-h-12 rounded-lg border border-slate-300 px-4 font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
          >
            Discard this entry
          </button>
        ) : (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            <p>Discard it? It will not be added to your stock records.</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => discardEntry(entry))}
                className="min-h-11 flex-1 rounded-lg bg-red-700 px-3 font-semibold text-white disabled:opacity-50"
              >
                Yes, discard
              </button>
              <button
                type="button"
                onClick={() => setConfirmDiscard(false)}
                className="min-h-11 flex-1 rounded-lg border border-slate-300 bg-white px-3 font-medium text-slate-800"
              >
                Keep it
              </button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}
