import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Loader2, PackagePlus, RotateCcw } from 'lucide-react';
import { ApiProblemError } from '../../lib/api-client';
import { problemKind, saleErrorMessage } from '../../lib/problems';
import { currentClaims } from '../../lib/session';
import { useProductsByIds } from '../catalog/hooks';
import { expiryStatus, type ExpiryLevel } from './expiry';
import {
  type InventoryBatch,
  newSaleInput,
  type SaleInput,
  useBatches,
  useRecordSale,
} from './hooks';

const BADGE: Record<ExpiryLevel, string> = {
  expired: 'bg-red-700 text-white',
  critical: 'bg-red-100 text-red-800',
  warning: 'bg-amber-100 text-amber-900',
  ok: 'bg-slate-100 text-slate-700',
};

type Feedback = { tone: 'ok' | 'error'; text: string; retry?: SaleInput } | null;

export function InventoryPage() {
  const shopId = currentClaims()?.shopId ?? null;
  const batches = useBatches(shopId);
  const products = useProductsByIds((batches.data ?? []).map((b) => b.productId));
  const sale = useRecordSale(shopId ?? 'none');
  const [pendingBatchId, setPendingBatchId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const rows = useMemo(
    () => [...(batches.data ?? [])].filter((b) => b.qty > 0 || b.reservedQty > 0),
    [batches.data],
  );

  const submitSale = (input: SaleInput, productName: string) => {
    setPendingBatchId(input.batchId);
    setFeedback(null);
    sale.mutate(input, {
      onSuccess: ({ batch }) =>
        setFeedback({
          tone: 'ok',
          text: `Sold 1 × ${productName}. ${batch.qty - batch.reservedQty} left to sell.`,
        }),
      onError: (error: ApiProblemError) =>
        setFeedback({
          tone: 'error',
          text: saleErrorMessage(error),
          // A network failure may have reached the server: retry with the SAME key.
          retry: problemKind(error) === 'network' ? input : undefined,
        }),
      onSettled: () => setPendingBatchId(null),
    });
  };

  if (!shopId) {
    return (
      <p className="text-sm text-slate-700">Your shop is not linked yet. Please sign in again.</p>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-900">My stock</h1>
        <Link
          to="/inventory/add"
          className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800"
        >
          <PackagePlus className="h-4 w-4" />
          Add stock
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
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <p className="flex-1">{feedback.text}</p>
          {feedback.retry && (
            <button
              type="button"
              onClick={() =>
                submitSale(
                  feedback.retry!,
                  products.data?.get(
                    rows.find((r) => r.id === feedback.retry!.batchId)?.productId ?? '',
                  )?.name ?? 'item',
                )
              }
              className="inline-flex items-center gap-1 rounded-md bg-red-700 px-2.5 py-1 text-xs font-semibold text-white"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </button>
          )}
        </div>
      )}

      {batches.isLoading && (
        <p className="flex items-center gap-2 text-sm text-slate-600">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading stock…
        </p>
      )}
      {batches.error && <p className="text-sm text-red-700">{batches.error.detail}</p>}

      {!batches.isLoading && rows.length === 0 && !batches.error && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">
          No stock yet. Tap <strong>Add stock</strong> to enter your first batch.
        </div>
      )}

      <ul className="space-y-3">
        {rows.map((batch) => (
          <BatchCard
            key={batch.id}
            batch={batch}
            productName={products.data?.get(batch.productId)?.name}
            pending={pendingBatchId === batch.id}
            disabled={pendingBatchId !== null}
            onSell={(name) => submitSale(newSaleInput(batch), name)}
          />
        ))}
      </ul>
    </section>
  );
}

function BatchCard({
  batch,
  productName,
  pending,
  disabled,
  onSell,
}: {
  batch: InventoryBatch;
  productName?: string;
  pending: boolean;
  disabled: boolean;
  onSell: (productName: string) => void;
}) {
  const available = batch.qty - batch.reservedQty;
  const expiry = expiryStatus(batch.expiryDate);
  const name = productName ?? 'Loading product…';

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900">{name}</p>
          <p className="text-xs text-slate-600">
            Batch {batch.batchCode} · Cost ₹{Number(batch.costPrice).toFixed(2)}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${BADGE[expiry.level]}`}
        >
          {expiry.label}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-600">Can sell</dt>
          <dd className="text-lg font-bold text-slate-900">{available}</dd>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-600">Reserved</dt>
          <dd className="text-lg font-bold text-slate-900">{batch.reservedQty}</dd>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-600">Days of cover</dt>
          <dd className="text-lg font-bold text-slate-900">
            {batch.daysOfCover === null ? '—' : Number(batch.daysOfCover).toFixed(0)}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={() => onSell(name)}
        disabled={disabled || available <= 0 || expiry.level === 'expired'}
        aria-label={`Sell 1 ${name}`}
        className="mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 text-base font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
        {available <= 0 ? 'Sold out' : expiry.level === 'expired' ? 'Expired' : 'Sell 1'}
      </button>
    </li>
  );
}
