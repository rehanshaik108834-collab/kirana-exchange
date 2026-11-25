import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Layers, Loader2, RefreshCw, Truck } from 'lucide-react';
import { formatMoney, formatTime } from '../../i18n';
import { currentClaims } from '../../lib/session';
import { useProductsByIds } from '../catalog/hooks';
import {
  type GroupBuyWindow,
  type GroupBuyWindowStatus,
  useGroupBuyWindowDetail,
  useGroupBuyWindows,
  useMyGroupBuyAllocations,
  useRemoveCommitment,
  useUpsertCommitment,
} from './hooks';

type GroupBuyTab = 'windows' | 'allocations';
type BannerState = { tone: 'ok' | 'error'; text: string } | null;

const STATUS_BADGE: Record<GroupBuyWindowStatus, string> = {
  OPEN: 'bg-teal-100 text-teal-900',
  EXTENDED: 'bg-amber-100 text-amber-950',
  ALLOCATING: 'bg-sky-100 text-sky-900',
  COMPLETED: 'bg-emerald-100 text-emerald-900',
  CANCELLED: 'bg-slate-200 text-slate-800',
};

export function GroupBuyPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const shopId = currentClaims()?.shopId ?? null;
  const enabled = Boolean(shopId);

  const [tab, setTab] = useState<GroupBuyTab>('windows');
  const [expandedWindowId, setExpandedWindowId] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerState>(null);

  const windows = useGroupBuyWindows(enabled);
  const allocations = useMyGroupBuyAllocations(enabled);

  const productIds = useMemo(() => {
    const ids = new Set<string>();
    for (const w of windows.data ?? []) {
      for (const tier of w.priceTiers) ids.add(tier.productId);
    }
    for (const a of allocations.data ?? []) ids.add(a.productId);
    return [...ids];
  }, [windows.data, allocations.data]);

  const products = useProductsByIds(productIds);
  const nameOf = (productId: string) =>
    products.data?.get(productId)?.name ?? `SKU ${productId.slice(0, 8)}`;

  if (!shopId) {
    return <p className="text-sm text-slate-700">{t('groupbuy.notLinked')}</p>;
  }

  const tabClass = (active: boolean) =>
    `min-h-11 rounded-lg px-3 text-sm font-semibold transition-colors ${
      active
        ? 'bg-teal-700 text-white'
        : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
    }`;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{t('groupbuy.title')}</h1>
          <p className="text-xs text-slate-600">{t('groupbuy.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => void qc.invalidateQueries({ queryKey: ['groupbuy'] })}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          {t('groupbuy.refresh')}
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

      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('groupbuy.title')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'windows'}
          onClick={() => setTab('windows')}
          className={tabClass(tab === 'windows')}
        >
          {t('groupbuy.tabs.windows', { count: windows.data?.length ?? 0 })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'allocations'}
          onClick={() => setTab('allocations')}
          className={tabClass(tab === 'allocations')}
        >
          {t('groupbuy.tabs.allocations', { count: allocations.data?.length ?? 0 })}
        </button>
      </div>

      {tab === 'windows' && (
        <div className="space-y-3">
          {windows.isLoading && (
            <p className="flex items-center gap-2 text-sm text-slate-600">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              {t('common.loading')}
            </p>
          )}
          {!windows.isLoading && (windows.data?.length ?? 0) === 0 && (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-center text-sm text-slate-600">
              {t('groupbuy.windows.empty')}
            </p>
          )}
          <ul className="space-y-3">
            {(windows.data ?? []).map((win) => (
              <WindowCard
                key={win.id}
                win={win}
                expanded={expandedWindowId === win.id}
                onToggle={() => setExpandedWindowId((prev) => (prev === win.id ? null : win.id))}
                nameOf={nameOf}
                onFeedback={setBanner}
              />
            ))}
          </ul>
        </div>
      )}

      {tab === 'allocations' && (
        <section aria-labelledby="alloc-heading" className="space-y-3">
          <h2 id="alloc-heading" className="text-base font-bold text-slate-900">
            {t('groupbuy.allocations.title')}
          </h2>
          {(allocations.data?.length ?? 0) === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-center text-sm text-slate-600">
              {t('groupbuy.allocations.empty')}
            </p>
          ) : (
            <ul className="space-y-3">
              {(allocations.data ?? []).map((alloc) => (
                <li
                  key={alloc.id}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold text-slate-900">{nameOf(alloc.productId)}</p>
                    <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-900">
                      {alloc.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-700">
                    {t('groupbuy.allocations.line', {
                      qty: alloc.qty,
                      tier: formatMoney(alloc.unitTierPrice),
                      delivery: formatMoney(alloc.deliveryShare),
                      landed: formatMoney(alloc.landedCost),
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}

function WindowCard({
  win,
  expanded,
  onToggle,
  nameOf,
  onFeedback,
}: {
  win: GroupBuyWindow;
  expanded: boolean;
  onToggle: () => void;
  nameOf: (productId: string) => string;
  onFeedback: (banner: BannerState) => void;
}) {
  const { t } = useTranslation();
  const detail = useGroupBuyWindowDetail(expanded ? win.id : null);
  const upsert = useUpsertCommitment();
  const remove = useRemoveCommitment();
  const [qtyDrafts, setQtyDrafts] = useState<Record<string, number>>({});

  const liveWin = detail.data?.window ?? win;
  const isOpen = liveWin.status === 'OPEN' || liveWin.status === 'EXTENDED';

  const commitProduct = async (productId: string, qty: number) => {
    onFeedback(null);
    try {
      await upsert.mutateAsync({
        windowId: liveWin.id,
        productId,
        qty,
        shopState: liveWin.state,
      });
      onFeedback({ tone: 'ok', text: t('groupbuy.windows.committedOk') });
    } catch (err) {
      onFeedback({
        tone: 'error',
        text: err instanceof Error ? err.message : t('groupbuy.actionFailed'),
      });
    }
  };

  const withdrawProduct = async (productId: string) => {
    onFeedback(null);
    try {
      await remove.mutateAsync({ windowId: liveWin.id, productId });
      onFeedback({ tone: 'ok', text: t('groupbuy.windows.withdrawnOk') });
    } catch (err) {
      onFeedback({
        tone: 'error',
        text: err instanceof Error ? err.message : t('groupbuy.actionFailed'),
      });
    }
  };

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 font-semibold text-slate-900">
            <Truck aria-hidden="true" className="h-4 w-4 text-teal-700" />
            {liveWin.distributorId} · {liveWin.state}
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            {t('groupbuy.windows.minOrder', { amount: formatMoney(liveWin.minOrderValue) })} ·{' '}
            {t('groupbuy.windows.deliveryFee', { amount: formatMoney(liveWin.deliveryFee) })}
          </p>
          <p className="text-xs text-slate-500">
            {t('groupbuy.windows.cutoff', { time: formatTime(Date.parse(liveWin.cutoffAt)) })}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_BADGE[liveWin.status]}`}
        >
          {t(`groupbuy.status.${liveWin.status}`)}
        </span>
      </div>

      <button
        type="button"
        onClick={onToggle}
        className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 text-xs font-semibold text-slate-800 hover:bg-slate-100"
      >
        <Layers aria-hidden="true" className="h-4 w-4 text-teal-700" />
        {expanded ? t('groupbuy.windows.hideDetail') : t('groupbuy.windows.openDetail')}
      </button>

      {expanded && detail.data && (
        <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
          <div>
            <div className="flex justify-between text-xs font-medium text-slate-700">
              <span>
                {t('groupbuy.windows.progress', {
                  current: formatMoney(detail.data.currentTotalValue),
                  target: formatMoney(liveWin.minOrderValue),
                  pct: detail.data.progressPct,
                })}
              </span>
              <span>
                {t('groupbuy.windows.participants', { count: detail.data.participatingShops })}
              </span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-teal-700"
                style={{ width: `${detail.data.progressPct}%` }}
              />
            </div>
          </div>

          {!isOpen && (
            <p className="rounded-lg bg-slate-100 p-2 text-xs text-slate-700">
              {t('groupbuy.windows.closedNotice')}
            </p>
          )}

          <ul className="space-y-2">
            {liveWin.priceTiers.map((tier) => {
              const existing = detail.data.myCommitments.find(
                (c) => c.productId === tier.productId,
              );
              const qtyVal = qtyDrafts[tier.productId] ?? existing?.qty ?? 10;
              const pooled = detail.data.pooledQtyByProduct[tier.productId] ?? 0;
              const currentUnit =
                detail.data.unitTierPriceByProduct[tier.productId] ?? tier.baseUnitPrice;

              return (
                <li
                  key={tier.productId}
                  className="rounded-lg border border-slate-200 bg-slate-50 p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {nameOf(tier.productId)}
                      </p>
                      <p className="text-xs text-slate-600">
                        {t('groupbuy.windows.basePrice', {
                          price: formatMoney(tier.baseUnitPrice),
                        })}{' '}
                        ·{' '}
                        {t('groupbuy.windows.currentTier', {
                          price: formatMoney(currentUnit),
                        })}{' '}
                        · {t('groupbuy.windows.pooledQty', { qty: pooled })}
                      </p>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <label className="text-xs font-medium text-slate-700">
                        {t('groupbuy.windows.qtyLabel')}
                        <input
                          type="number"
                          min={1}
                          value={qtyVal}
                          onChange={(e) =>
                            setQtyDrafts((prev) => ({
                              ...prev,
                              [tier.productId]: Math.max(1, Number(e.target.value)),
                            }))
                          }
                          className="mt-1 block w-24 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={upsert.isPending}
                        onClick={() => void commitProduct(tier.productId, qtyVal)}
                        className="min-h-11 rounded-lg bg-teal-700 px-3 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                      >
                        {t('groupbuy.windows.commit')}
                      </button>
                      {existing && (
                        <button
                          type="button"
                          disabled={remove.isPending}
                          onClick={() => void withdrawProduct(tier.productId)}
                          className="min-h-11 rounded-lg border border-red-300 bg-white px-3 text-xs font-semibold text-red-800 hover:bg-red-50 disabled:opacity-50"
                        >
                          {t('groupbuy.windows.withdraw')}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </li>
  );
}
