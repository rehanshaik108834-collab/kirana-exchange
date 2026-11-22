import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CloudUpload, Loader2, PackagePlus } from 'lucide-react';
import { formatMoney, formatTime } from '../../i18n';
import { currentClaims } from '../../lib/session';
import { useProductsByIds } from '../catalog/hooks';
import { projectBatches, type ProjectedBatch } from '../offline/project';
import { enqueueSale, useQueueEntries } from '../offline/runtime';
import { expiryStatus, type ExpiryLevel } from './expiry';
import { useBatches } from './hooks';

const BADGE: Record<ExpiryLevel, string> = {
  expired: 'bg-red-700 text-white',
  critical: 'bg-red-100 text-red-800',
  warning: 'bg-amber-100 text-amber-900',
  ok: 'bg-slate-100 text-slate-700',
};

/** Stored as a key + values so it re-renders in the new language after a switch. */
type Feedback = {
  tone: 'ok' | 'error';
  key: string;
  values?: Record<string, string | number>;
} | null;

export function InventoryPage() {
  const { t } = useTranslation();
  const shopId = currentClaims()?.shopId ?? null;
  const batches = useBatches(shopId);
  const entries = useQueueEntries();
  const projected = useMemo(
    () => projectBatches(batches.data ?? [], entries),
    [batches.data, entries],
  );
  const products = useProductsByIds(
    projected.filter((b) => !b.pendingSync).map((b) => b.productId),
  );
  const [busyBatchId, setBusyBatchId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const rows = projected.filter(
    (b) => b.qty > 0 || b.reservedQty > 0 || b.pendingSync || b.needsAttention,
  );
  const nameOf = (b: ProjectedBatch) =>
    b.productName ?? products.data?.get(b.productId)?.name ?? t('inventory.loadingProduct');

  const sell = async (batch: ProjectedBatch) => {
    const name = nameOf(batch);
    setBusyBatchId(batch.id);
    setFeedback(null);
    try {
      // Committed to the device first: never lost, synced exactly once (same Idempotency-Key).
      await enqueueSale(batch, name);
      const left = batch.qty - batch.reservedQty - 1;
      setFeedback({
        tone: 'ok',
        key: navigator.onLine ? 'inventory.soldOnline' : 'inventory.soldOffline',
        values: { name, left },
      });
    } catch {
      setFeedback({
        tone: 'error',
        key: 'inventory.saveFailed',
      });
    } finally {
      setBusyBatchId(null);
    }
  };

  if (!shopId) {
    return <p className="text-sm text-slate-700">{t('inventory.notLinked')}</p>;
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-900">{t('inventory.title')}</h1>
        <Link
          to="/inventory/add"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-teal-700 px-3 text-sm font-semibold text-white hover:bg-teal-800"
        >
          <PackagePlus className="h-4 w-4" aria-hidden="true" />
          {t('inventory.addStock')}
        </Link>
      </div>

      {feedback && (
        <div
          role="status"
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
            feedback.tone === 'ok'
              ? 'border-teal-200 bg-teal-50 text-teal-900'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {feedback.tone === 'ok' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <p className="flex-1">{t(feedback.key, feedback.values ?? {})}</p>
        </div>
      )}

      {batches.data && (batches.fetchStatus === 'paused' || batches.isRefetchError) && (
        <p role="status" className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
          {t('inventory.offlineSnapshot', { time: formatTime(batches.dataUpdatedAt) })}
        </p>
      )}

      {batches.isLoading && (
        <p className="flex items-center gap-2 text-sm text-slate-600">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t('inventory.loading')}
        </p>
      )}
      {/* With saved stock on screen, the amber offline note explains the state; no raw error. */}
      {batches.error && !batches.data && (
        <p className="text-sm text-red-700">{batches.error.detail}</p>
      )}

      {!batches.isLoading && rows.length === 0 && !(batches.error && !batches.data) && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">
          <Trans i18nKey="inventory.empty" components={{ strong: <strong /> }} />
        </div>
      )}

      <ul className="space-y-3">
        {rows.map((batch) => (
          <BatchCard
            key={batch.id}
            batch={batch}
            productName={nameOf(batch)}
            busy={busyBatchId === batch.id}
            onSell={() => void sell(batch)}
          />
        ))}
      </ul>
    </section>
  );
}

function BatchCard({
  batch,
  productName,
  busy,
  onSell,
}: {
  batch: ProjectedBatch;
  productName: string;
  busy: boolean;
  onSell: () => void;
}) {
  const { t } = useTranslation();
  const available = batch.qty - batch.reservedQty;
  const expiry = expiryStatus(batch.expiryDate);
  const canSell = !batch.pendingSync && available > 0 && expiry.level !== 'expired';
  const buttonLabel = batch.pendingSync
    ? t('inventory.waitingToSync')
    : available <= 0
      ? t('inventory.soldOut')
      : expiry.level === 'expired'
        ? t('inventory.expired')
        : t('inventory.sell1');

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900">{productName}</p>
          <p className="text-xs text-slate-600">
            {t('inventory.batchLine', {
              code: batch.batchCode,
              cost: formatMoney(batch.costPrice),
            })}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${BADGE[expiry.level]}`}
        >
          {expiry.label}
        </span>
      </div>

      {(batch.pendingSync || batch.unsentSales > 0 || batch.needsAttention) && (
        <p
          className={`mt-2 inline-flex items-center gap-1 text-xs font-medium ${
            batch.needsAttention ? 'text-red-700' : 'text-amber-900'
          }`}
        >
          {batch.needsAttention ? (
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <CloudUpload className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {batch.needsAttention ? (
            <Link to="/sync-issues" className="underline">
              {t('inventory.needsAttention')}
            </Link>
          ) : batch.pendingSync ? (
            t('inventory.newBatchWaiting')
          ) : (
            t('inventory.unsentSales', { count: batch.unsentSales })
          )}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-700">{t('inventory.canSell')}</dt>
          <dd className="text-lg font-bold text-slate-900">{available}</dd>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-700">{t('inventory.reserved')}</dt>
          <dd className="text-lg font-bold text-slate-900">{batch.reservedQty}</dd>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-700">{t('inventory.daysOfCover')}</dt>
          <dd className="text-lg font-bold text-slate-900">
            {batch.daysOfCover === null ? '—' : Number(batch.daysOfCover).toFixed(0)}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={onSell}
        disabled={!canSell || busy}
        aria-label={
          canSell
            ? t('inventory.sellAria', { name: productName })
            : `${buttonLabel}: ${productName}`
        }
        className="mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 text-base font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : null}
        {buttonLabel}
      </button>
    </li>
  );
}
