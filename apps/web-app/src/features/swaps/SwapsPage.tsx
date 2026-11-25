import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  FileDown,
  KeyRound,
  Loader2,
  MapPin,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { formatMoney } from '../../i18n';
import { currentClaims } from '../../lib/session';
import { useProductsByIds } from '../catalog/hooks';
import { useBatches } from '../inventory/hooks';
import {
  type AnonymisedCandidate,
  downloadSwapInvoicePdf,
  type SwapOffer,
  type SwapSagaState,
  type SwapTransaction,
  useAcceptOffer,
  useCancelSaga,
  useConfirmHandover,
  useCreateListing,
  useCreateOffer,
  useMyListings,
  useMyOffers,
  useMySagas,
  useRejectOffer,
  useRiskDrafts,
  useSagaDetail,
  useSagaLiveStream,
  useSwapCandidates,
} from './hooks';

type SwapTab = 'nearby' | 'surplus' | 'activity';

type BannerState = {
  tone: 'ok' | 'error';
  text: string;
} | null;

const SAGA_BADGE: Record<SwapSagaState, string> = {
  INITIATED: 'bg-slate-100 text-slate-800',
  RESERVING_STOCK: 'bg-sky-100 text-sky-900',
  AWAITING_HANDOVER: 'bg-amber-100 text-amber-950',
  HANDOVER_CONFIRMED: 'bg-teal-100 text-teal-900',
  COMMITTING_TRANSFER: 'bg-teal-100 text-teal-900',
  COMPENSATING: 'bg-orange-100 text-orange-950',
  COMPLETED: 'bg-emerald-100 text-emerald-900',
  FAILED: 'bg-red-100 text-red-900',
  FAILED_NO_STOCK: 'bg-red-100 text-red-900',
  CANCELLED_COMPENSATED: 'bg-slate-200 text-slate-800',
};

const REP_BADGE: Record<AnonymisedCandidate['sellerReputationBand'], string> = {
  HIGH: 'bg-emerald-50 text-emerald-900',
  STANDARD: 'bg-slate-100 text-slate-800',
  CAUTION: 'bg-amber-100 text-amber-950',
};

export function SwapsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const shopId = currentClaims()?.shopId ?? null;
  const enabled = Boolean(shopId);

  const [tab, setTab] = useState<SwapTab>('nearby');
  const [radiusKm, setRadiusKm] = useState<number>(5);
  const [banner, setBanner] = useState<BannerState>(null);
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);

  const candidates = useSwapCandidates(enabled, radiusKm);
  const myListings = useMyListings(enabled);
  const riskDrafts = useRiskDrafts(enabled);
  const myOffers = useMyOffers(enabled);
  const mySagas = useMySagas(enabled);
  const batches = useBatches(shopId);

  const createListing = useCreateListing();
  const createOffer = useCreateOffer();
  const acceptOffer = useAcceptOffer();
  const rejectOffer = useRejectOffer();

  const productIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of candidates.data ?? []) ids.add(c.productId);
    for (const l of myListings.data ?? []) ids.add(l.productId);
    for (const d of riskDrafts.data ?? []) ids.add(d.productId);
    for (const tx of mySagas.data ?? []) ids.add(tx.productId);
    for (const b of batches.data ?? []) ids.add(b.productId);
    return [...ids];
  }, [candidates.data, myListings.data, riskDrafts.data, mySagas.data, batches.data]);

  const products = useProductsByIds(productIds);
  const nameOf = (productId: string) =>
    products.data?.get(productId)?.name ?? `SKU ${productId.slice(0, 8)}`;

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['swaps'] });
    void qc.invalidateQueries({ queryKey: ['sagas'] });
  };

  if (!shopId) {
    return <p className="text-sm text-slate-700">{t('swaps.notLinked')}</p>;
  }

  const tabClass = (active: boolean) =>
    `min-h-11 rounded-lg px-3 text-sm font-semibold transition-colors ${
      active
        ? 'bg-teal-700 text-white'
        : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
    }`;

  const availableBatches = (batches.data ?? []).filter((b) => b.qty - b.reservedQty > 0);
  const listedBatchIds = new Set(
    (myListings.data ?? [])
      .filter((l) => l.status === 'OPEN' || l.status === 'RESERVED')
      .map((l) => l.batchId),
  );

  const handleListBatch = async (
    batch: (typeof availableBatches)[number],
    suggestedQty?: number,
  ) => {
    setBanner(null);
    const available = batch.qty - batch.reservedQty;
    const qty = Math.min(available, Math.max(1, suggestedQty ?? available));
    try {
      await createListing.mutateAsync({
        batchId: batch.id,
        productId: batch.productId,
        qty,
        costPrice: Number(batch.costPrice),
        batchExpiryDate: batch.expiryDate,
        daysOfCover: batch.daysOfCover !== null ? Number(batch.daysOfCover) : undefined,
      });
      setBanner({
        tone: 'ok',
        text: t('swaps.surplus.listedOk', { name: nameOf(batch.productId) }),
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : t('swaps.actionFailed'),
      });
    }
  };

  const handleOfferSubmit = async (listingId: string, qty: number, offeredPrice: number) => {
    setBanner(null);
    try {
      await createOffer.mutateAsync({ listingId, qty, offeredPrice });
      setBanner({ tone: 'ok', text: t('swaps.nearby.offerSent') });
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : t('swaps.actionFailed'),
      });
    }
  };

  const handleAccept = async (offer: SwapOffer) => {
    setBanner(null);
    try {
      await acceptOffer.mutateAsync(offer.id);
      setBanner({ tone: 'ok', text: t('swaps.activity.offerAccepted') });
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : t('swaps.actionFailed'),
      });
    }
  };

  const handleReject = async (offer: SwapOffer) => {
    setBanner(null);
    try {
      await rejectOffer.mutateAsync(offer.id);
      setBanner({ tone: 'ok', text: t('swaps.activity.offerRejected') });
    } catch (err) {
      setBanner({
        tone: 'error',
        text: err instanceof Error ? err.message : t('swaps.actionFailed'),
      });
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{t('swaps.title')}</h1>
          <p className="text-xs text-slate-600">{t('swaps.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={refreshAll}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          {t('swaps.refresh')}
        </button>
      </div>

      {banner && (
        <div
          role={banner.tone === 'error' ? 'alert' : 'status'}
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
            banner.tone === 'ok'
              ? 'border-teal-200 bg-teal-50 text-teal-900'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {banner.tone === 'ok' ? (
            <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <p>{banner.text}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('swaps.title')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'nearby'}
          onClick={() => setTab('nearby')}
          className={tabClass(tab === 'nearby')}
        >
          {t('swaps.tabs.nearby', { count: candidates.data?.length ?? 0 })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'surplus'}
          onClick={() => setTab('surplus')}
          className={tabClass(tab === 'surplus')}
        >
          {t('swaps.tabs.surplus', { count: myListings.data?.length ?? 0 })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'activity'}
          onClick={() => setTab('activity')}
          className={tabClass(tab === 'activity')}
        >
          {t('swaps.tabs.activity', {
            count: (myOffers.data?.length ?? 0) + (mySagas.data?.length ?? 0),
          })}
        </button>
      </div>

      {tab === 'nearby' && (
        <section aria-labelledby="nearby-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="nearby-heading" className="text-base font-bold text-slate-900">
              {t('swaps.nearby.title')}
            </h2>
            <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
              <span>{t('swaps.nearby.radius', { km: radiusKm })}</span>
              <input
                type="range"
                min={1}
                max={10}
                value={radiusKm}
                onChange={(e) => setRadiusKm(Number(e.target.value))}
                className="accent-teal-700"
              />
            </label>
          </div>

          <p className="rounded-lg bg-slate-50 p-2.5 text-xs text-slate-700">
            {t('swaps.nearby.gstNotice')}
          </p>

          {candidates.isLoading && (
            <p className="flex items-center gap-2 text-sm text-slate-600">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              {t('common.loading')}
            </p>
          )}

          {!candidates.isLoading && (candidates.data?.length ?? 0) === 0 && (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-center text-sm text-slate-600">
              {t('swaps.nearby.empty')}
            </p>
          )}

          <ul className="space-y-3">
            {(candidates.data ?? []).map((candidate) => (
              <CandidateCard
                key={candidate.listingId}
                candidate={candidate}
                productName={nameOf(candidate.productId)}
                busy={createOffer.isPending}
                onOffer={(qty, price) => void handleOfferSubmit(candidate.listingId, qty, price)}
              />
            ))}
          </ul>
        </section>
      )}

      {tab === 'surplus' && (
        <section aria-labelledby="surplus-heading" className="space-y-4">
          <h2 id="surplus-heading" className="text-base font-bold text-slate-900">
            {t('swaps.surplus.title')}
          </h2>

          {(riskDrafts.data?.length ?? 0) > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-amber-950">
                {t('swaps.surplus.riskDraftsTitle')}
              </h3>
              <ul className="space-y-2">
                {(riskDrafts.data ?? []).map((draft) => {
                  const matchedBatch = availableBatches.find((b) => b.id === draft.batchId);
                  return (
                    <li
                      key={draft.batchId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3"
                    >
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {nameOf(draft.productId)}
                        </p>
                        <p className="text-xs text-amber-950">
                          {t('swaps.surplus.draftDetail', {
                            qty: draft.expectedUnsoldQty,
                            days: Math.round(Number(draft.daysOfCover)),
                          })}
                        </p>
                      </div>
                      {matchedBatch && !listedBatchIds.has(matchedBatch.id) && (
                        <button
                          type="button"
                          disabled={createListing.isPending}
                          onClick={() =>
                            void handleListBatch(matchedBatch, draft.expectedUnsoldQty)
                          }
                          className="min-h-11 rounded-lg bg-teal-700 px-3 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                        >
                          {t('swaps.surplus.listNow')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-800">
              {t('swaps.surplus.fromStockTitle')}
            </h3>
            {availableBatches.filter((b) => !listedBatchIds.has(b.id)).length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-600">
                {t('swaps.surplus.noBatches')}
              </p>
            ) : (
              <ul className="space-y-2">
                {availableBatches
                  .filter((b) => !listedBatchIds.has(b.id))
                  .slice(0, 10)
                  .map((batch) => (
                    <li
                      key={batch.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
                    >
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {nameOf(batch.productId)}
                        </p>
                        <p className="text-xs text-slate-600">
                          {t('swaps.surplus.batchMeta', {
                            qty: batch.qty - batch.reservedQty,
                            cost: formatMoney(batch.costPrice),
                            expiry: batch.expiryDate,
                          })}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={createListing.isPending}
                        onClick={() => void handleListBatch(batch)}
                        className="min-h-11 rounded-lg border border-teal-700 px-3 text-xs font-semibold text-teal-800 hover:bg-teal-50 disabled:opacity-50"
                      >
                        {t('swaps.surplus.listForSwap')}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-800">
              {t('swaps.surplus.myListingsTitle')}
            </h3>
            {(myListings.data?.length ?? 0) === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-600">
                {t('swaps.surplus.emptyListings')}
              </p>
            ) : (
              <ul className="space-y-2">
                {(myListings.data ?? []).map((listing) => (
                  <li
                    key={listing.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
                  >
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {nameOf(listing.productId)}
                      </p>
                      <p className="text-xs text-slate-600">
                        {t('swaps.surplus.listingLine', {
                          qty: listing.qty,
                          price: formatMoney(listing.price),
                          expiry: listing.batchExpiryDate,
                        })}
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-800">
                      {listing.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {tab === 'activity' && (
        <section aria-labelledby="activity-heading" className="space-y-5">
          <h2 id="activity-heading" className="text-base font-bold text-slate-900">
            {t('swaps.activity.offersTitle')}
          </h2>

          {(myOffers.data?.length ?? 0) === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-600">
              {t('swaps.activity.emptyOffers')}
            </p>
          ) : (
            <ul className="space-y-3">
              {(myOffers.data ?? []).map((offer) => {
                const isSeller = offer.sellerShopId === shopId;
                const canAccept =
                  (offer.status === 'PENDING' && isSeller) ||
                  (offer.status === 'COUNTERED' && !isSeller);
                const canReject = offer.status === 'PENDING' || offer.status === 'COUNTERED';

                return (
                  <li
                    key={offer.id}
                    className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {isSeller
                            ? t('swaps.activity.incomingOffer')
                            : t('swaps.activity.outgoingOffer')}
                        </p>
                        <p className="text-xs text-slate-600">
                          {t('swaps.activity.offerLine', {
                            qty: offer.qty,
                            price: formatMoney(offer.offeredPrice),
                          })}
                        </p>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-800">
                        {offer.status}
                      </span>
                    </div>

                    {(canAccept || canReject) && (
                      <div className="mt-3 flex gap-2">
                        {canAccept && (
                          <button
                            type="button"
                            disabled={acceptOffer.isPending}
                            onClick={() => void handleAccept(offer)}
                            className="min-h-11 flex-1 rounded-lg bg-teal-700 px-3 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                          >
                            {t('swaps.activity.accept')}
                          </button>
                        )}
                        {canReject && (
                          <button
                            type="button"
                            disabled={rejectOffer.isPending}
                            onClick={() => void handleReject(offer)}
                            className="min-h-11 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {t('swaps.activity.reject')}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="space-y-3">
            <h2 className="text-base font-bold text-slate-900">{t('swaps.activity.sagasTitle')}</h2>

            {(mySagas.data?.length ?? 0) === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-600">
                {t('swaps.activity.emptySagas')}
              </p>
            ) : (
              <ul className="space-y-3">
                {(mySagas.data ?? []).map((tx) => (
                  <SagaSummaryCard
                    key={tx.id}
                    tx={tx}
                    shopId={shopId}
                    productName={nameOf(tx.productId)}
                    expanded={selectedTxId === tx.id}
                    onToggle={() => setSelectedTxId((prev) => (prev === tx.id ? null : tx.id))}
                    onFeedback={setBanner}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </section>
  );
}

function CandidateCard({
  candidate,
  productName,
  busy,
  onOffer,
}: {
  candidate: AnonymisedCandidate;
  productName: string;
  busy: boolean;
  onOffer: (qty: number, price: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(candidate.qty);
  const [price, setPrice] = useState(candidate.price);

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900">{productName}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-600">
            <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-teal-700" />
            {t('swaps.nearby.distanceLine', {
              km: candidate.distanceKm.toFixed(1),
              state: candidate.state,
            })}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${REP_BADGE[candidate.sellerReputationBand]}`}
        >
          <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
          {t(`swaps.reputation.${candidate.sellerReputationBand}`)}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-600">{t('swaps.nearby.qty')}</dt>
          <dd className="text-base font-bold text-slate-900">{candidate.qty}</dd>
        </div>
        <div className="rounded-lg bg-teal-50 p-2 text-teal-900">
          <dt className="text-xs">{t('swaps.nearby.unitPrice')}</dt>
          <dd className="text-base font-bold">{formatMoney(candidate.price)}</dd>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-600">{t('swaps.nearby.expiry')}</dt>
          <dd className="text-xs font-semibold text-slate-900">{candidate.batchExpiryDate}</dd>
        </div>
      </dl>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-teal-700 px-3 text-sm font-semibold text-white hover:bg-teal-800"
        >
          <ArrowRightLeft aria-hidden="true" className="h-4 w-4" />
          {t('swaps.nearby.makeOffer')}
        </button>
      ) : (
        <form
          className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            onOffer(qty, price);
            setOpen(false);
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-medium text-slate-700">
              {t('swaps.nearby.offerQty')}
              <input
                type="number"
                min={1}
                max={candidate.qty}
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-slate-700">
              {t('swaps.nearby.offerPrice')}
              <input
                type="number"
                step="0.01"
                min={0.01}
                value={price}
                onChange={(e) => setPrice(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm"
              />
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="min-h-11 flex-1 rounded-lg bg-teal-700 px-3 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
            >
              {t('swaps.nearby.sendOffer')}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700"
            >
              {t('swaps.cancel')}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

function SagaSummaryCard({
  tx,
  shopId,
  productName,
  expanded,
  onToggle,
  onFeedback,
}: {
  tx: SwapTransaction;
  shopId: string;
  productName: string;
  expanded: boolean;
  onToggle: () => void;
  onFeedback: (banner: BannerState) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const detail = useSagaDetail(expanded ? tx.id : null);
  const confirmHandover = useConfirmHandover();
  const cancelSaga = useCancelSaga();

  const [pinInput, setPinInput] = useState('');
  const [downloading, setDownloading] = useState(false);

  const onStreamEvent = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['sagas', 'mine'] });
    void qc.invalidateQueries({ queryKey: ['sagas', 'detail', tx.id] });
  }, [qc, tx.id]);

  useSagaLiveStream(expanded ? tx.id : null, onStreamEvent);

  const liveTx = detail.data?.transaction ?? tx;
  const isSeller = liveTx.sellerShopId === shopId;
  const alreadyConfirmed = isSeller
    ? Boolean(liveTx.sellerConfirmedAt)
    : Boolean(liveTx.buyerConfirmedAt);

  const handleConfirmPin = async (e: React.FormEvent) => {
    e.preventDefault();
    onFeedback(null);
    try {
      await confirmHandover.mutateAsync({ txId: liveTx.id, handoverCode: pinInput.trim() });
      setPinInput('');
      onFeedback({ tone: 'ok', text: t('swaps.saga.pinConfirmed') });
    } catch (err) {
      onFeedback({
        tone: 'error',
        text: err instanceof Error ? err.message : t('swaps.actionFailed'),
      });
    }
  };

  const handleCancel = async () => {
    onFeedback(null);
    try {
      await cancelSaga.mutateAsync(liveTx.id);
      onFeedback({ tone: 'ok', text: t('swaps.saga.cancelRequested') });
    } catch (err) {
      onFeedback({
        tone: 'error',
        text: err instanceof Error ? err.message : t('swaps.actionFailed'),
      });
    }
  };

  const handleDownloadInvoice = async () => {
    setDownloading(true);
    onFeedback(null);
    try {
      await downloadSwapInvoicePdf(liveTx.id);
    } catch (err) {
      onFeedback({
        tone: 'error',
        text: err instanceof Error ? err.message : t('swaps.actionFailed'),
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900">{productName}</p>
          <p className="text-xs text-slate-600">
            {t('swaps.saga.summaryLine', {
              role: isSeller ? t('swaps.saga.seller') : t('swaps.saga.buyer'),
              qty: liveTx.qty,
              price: formatMoney(liveTx.price),
            })}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${SAGA_BADGE[liveTx.state]}`}
        >
          {t(`swaps.sagaState.${liveTx.state}`)}
        </span>
      </div>

      <button
        type="button"
        onClick={onToggle}
        className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 text-xs font-semibold text-slate-800 hover:bg-slate-100"
      >
        <PackageCheck aria-hidden="true" className="h-4 w-4 text-teal-700" />
        {expanded ? t('swaps.saga.hideTracker') : t('swaps.saga.openTracker')}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
          {detail.data?.handoverCode && liveTx.state === 'AWAITING_HANDOVER' && (
            <div className="rounded-lg border border-teal-200 bg-teal-50 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-teal-900">
                <KeyRound aria-hidden="true" className="h-4 w-4" />
                {t('swaps.saga.sellerPinLabel')}
              </p>
              <p className="mt-1 font-mono text-2xl font-bold tracking-widest text-teal-950">
                {detail.data.handoverCode}
              </p>
            </div>
          )}

          {liveTx.state === 'AWAITING_HANDOVER' && !alreadyConfirmed && (
            <form onSubmit={(e) => void handleConfirmPin(e)} className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">
                {t('swaps.saga.enterPinLabel')}
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  pattern="\d{6}"
                  placeholder="123456"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-base tracking-widest"
                />
              </label>
              <button
                type="submit"
                disabled={pinInput.length !== 6 || confirmHandover.isPending}
                className="min-h-11 w-full rounded-lg bg-teal-700 px-3 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
              >
                {t('swaps.saga.confirmHandover')}
              </button>
            </form>
          )}

          {liveTx.state === 'AWAITING_HANDOVER' && alreadyConfirmed && (
            <p className="rounded-lg bg-amber-50 p-2.5 text-xs font-medium text-amber-950">
              {t('swaps.saga.waitingOtherParty')}
            </p>
          )}

          {(liveTx.state === 'RESERVING_STOCK' || liveTx.state === 'AWAITING_HANDOVER') && (
            <button
              type="button"
              disabled={cancelSaga.isPending}
              onClick={() => void handleCancel()}
              className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 text-xs font-semibold text-red-800 hover:bg-red-50 disabled:opacity-50"
            >
              <XCircle aria-hidden="true" className="h-4 w-4" />
              {t('swaps.saga.cancelSwap')}
            </button>
          )}

          {liveTx.state === 'COMPLETED' && (
            <button
              type="button"
              disabled={downloading}
              onClick={() => void handleDownloadInvoice()}
              className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              <FileDown aria-hidden="true" className="h-4 w-4" />
              {t('swaps.saga.downloadInvoice')}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
