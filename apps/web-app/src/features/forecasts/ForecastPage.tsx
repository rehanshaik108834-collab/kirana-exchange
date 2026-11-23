import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRightLeft,
  Info,
  Loader2,
  PackagePlus,
  RefreshCw,
  ShoppingCart,
  Tag,
  Undo2,
} from 'lucide-react';
import { formatTime } from '../../i18n';
import { currentClaims } from '../../lib/session';
import { useProductsByIds } from '../catalog/hooks';
import { AccuracyChart } from './AccuracyChart';
import {
  type ForecastOrderItem,
  type ForecastRiskItem,
  type RecommendedAction,
  type RiskType,
  useShopForecasts,
} from './hooks';

type ViewTab = 'all' | 'order' | 'clear';

const RISK_BADGE: Record<RiskType, string> = {
  EXPIRY: 'bg-red-100 text-red-900',
  DEAD_STOCK: 'bg-amber-100 text-amber-950',
};

const ACTION_BADGE: Record<RecommendedAction, string> = {
  SWAP_TO_NEIGHBOUR: 'border-teal-200 bg-teal-50 text-teal-900',
  BUNDLE_DISCOUNT: 'border-amber-200 bg-amber-50 text-amber-950',
  RETURN_TO_DISTRIBUTOR: 'border-slate-300 bg-slate-100 text-slate-800',
};

const DEMAND_CLASS_BADGE: Record<string, string> = {
  SMOOTH: 'bg-teal-50 text-teal-900',
  ERRATIC: 'bg-sky-50 text-sky-900',
  INTERMITTENT: 'bg-amber-50 text-amber-950',
  LUMPY: 'bg-purple-50 text-purple-900',
};

function ActionIcon({ action }: { action: RecommendedAction }) {
  if (action === 'SWAP_TO_NEIGHBOUR') {
    return <ArrowRightLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />;
  }
  if (action === 'BUNDLE_DISCOUNT') {
    return <Tag aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />;
  }
  return <Undo2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />;
}

export function ForecastPage() {
  const { t } = useTranslation();
  const shopId = currentClaims()?.shopId ?? null;
  const forecasts = useShopForecasts(shopId);
  const [tab, setTab] = useState<ViewTab>('all');

  const productIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of forecasts.data?.orderThis ?? []) ids.add(item.productId);
    for (const item of forecasts.data?.clearThis ?? []) ids.add(item.productId);
    return [...ids];
  }, [forecasts.data]);

  const products = useProductsByIds(productIds);
  const nameOf = (productId: string) =>
    products.data?.get(productId)?.name ??
    (products.isLoading ? t('inventory.loadingProduct') : `SKU ${productId.slice(0, 8)}`);

  if (!shopId) {
    return <p className="text-sm text-slate-700">{t('forecasts.notLinked')}</p>;
  }

  const data = forecasts.data;
  const orderItems = data?.orderThis ?? [];
  const clearItems = data?.clearThis ?? [];

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
          <h1 className="text-xl font-bold text-slate-900">{t('forecasts.title')}</h1>
          <p className="text-xs text-slate-600">{t('forecasts.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => void forecasts.refetch()}
          disabled={forecasts.isFetching}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${forecasts.isFetching ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          {t('forecasts.refresh')}
        </button>
      </div>

      {data?.fallbackActive && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
        >
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t('forecasts.fallbackBanner')}</p>
        </div>
      )}

      {data && (forecasts.fetchStatus === 'paused' || forecasts.isRefetchError) && (
        <p role="status" className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
          {t('forecasts.offlineSnapshot', { time: formatTime(forecasts.dataUpdatedAt) })}
        </p>
      )}

      {forecasts.isLoading && (
        <p className="flex items-center gap-2 text-sm text-slate-600">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> {t('forecasts.loading')}
        </p>
      )}

      {forecasts.error && !data && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{forecasts.error.detail}</p>
        </div>
      )}

      {data && (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <dt className="text-xs text-slate-600">{t('forecasts.kpi.toOrderSkus')}</dt>
              <dd className="mt-1 text-2xl font-bold text-teal-800">
                {data.summary.orderThisCount}
              </dd>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <dt className="text-xs text-slate-600">{t('forecasts.kpi.unitsToOrder')}</dt>
              <dd className="mt-1 text-2xl font-bold text-slate-900">
                {data.summary.totalReorderUnits}
              </dd>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <dt className="text-xs text-slate-600">{t('forecasts.kpi.atRiskBatches')}</dt>
              <dd className="mt-1 text-2xl font-bold text-red-800">
                {data.summary.clearThisCount}
              </dd>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
              <dt className="text-xs text-slate-600">{t('forecasts.kpi.atRiskUnits')}</dt>
              <dd className="mt-1 text-2xl font-bold text-amber-900">
                {data.summary.totalAtRiskUnits}
              </dd>
            </div>
          </dl>

          <p className="text-xs text-slate-600">
            {t('forecasts.updatedAt', {
              time: formatTime(new Date(data.generatedAt).getTime()),
              model: data.modelUsed,
            })}
          </p>

          <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('forecasts.title')}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'all'}
              onClick={() => setTab('all')}
              className={tabClass(tab === 'all')}
            >
              {t('forecasts.tabs.all')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'order'}
              onClick={() => setTab('order')}
              className={tabClass(tab === 'order')}
            >
              {t('forecasts.tabs.orderThis', { count: data.summary.orderThisCount })}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'clear'}
              onClick={() => setTab('clear')}
              className={tabClass(tab === 'clear')}
            >
              {t('forecasts.tabs.clearThis', { count: data.summary.clearThisCount })}
            </button>
          </div>

          {(tab === 'all' || tab === 'order') && (
            <section aria-labelledby="order-this-heading" className="space-y-3">
              <h2
                id="order-this-heading"
                className="flex items-center gap-2 text-base font-bold text-slate-900"
              >
                <ShoppingCart aria-hidden="true" className="h-4 w-4 text-teal-700" />
                {t('forecasts.orderThis.title')}
              </h2>

              {orderItems.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-center text-sm text-slate-600">
                  {t('forecasts.orderThis.empty')}
                </p>
              ) : (
                <ul className="space-y-3">
                  {orderItems.map((item) => (
                    <OrderCard
                      key={`${item.productId}-${item.forecastDate}`}
                      item={item}
                      productName={nameOf(item.productId)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {(tab === 'all' || tab === 'clear') && (
            <section aria-labelledby="clear-this-heading" className="space-y-3">
              <h2
                id="clear-this-heading"
                className="flex items-center gap-2 text-base font-bold text-slate-900"
              >
                <AlertTriangle aria-hidden="true" className="h-4 w-4 text-red-700" />
                {t('forecasts.clearThis.title')}
              </h2>

              {clearItems.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-center text-sm text-slate-600">
                  {t('forecasts.clearThis.empty')}
                </p>
              ) : (
                <ul className="space-y-3">
                  {clearItems.map((item) => (
                    <ClearCard
                      key={`${item.batchId}-${item.riskType}`}
                      item={item}
                      productName={nameOf(item.productId)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === 'all' && <AccuracyChart series={data.accuracySeries} />}
        </>
      )}
    </section>
  );
}

function OrderCard({ item, productName }: { item: ForecastOrderItem; productName: string }) {
  const { t } = useTranslation();
  const demandClassBadge = DEMAND_CLASS_BADGE[item.demandClass] ?? 'bg-slate-100 text-slate-800';
  const demandClassLabel = t(`forecasts.demandClass.${item.demandClass}`, {
    defaultValue: item.demandClass,
  });

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900">{productName}</p>
          <p className="text-xs text-slate-600">
            {t('forecasts.orderThis.range', {
              low: Math.round(item.lowerBound),
              high: Math.round(item.upperBound),
            })}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${demandClassBadge}`}
        >
          {demandClassLabel}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-700">{t('forecasts.orderThis.inStock')}</dt>
          <dd className="text-lg font-bold text-slate-900">{item.availableQty}</dd>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-700">{t('forecasts.orderThis.next7Days')}</dt>
          <dd className="text-lg font-bold text-slate-900">{Math.round(item.predictedQty)}</dd>
        </div>
        <div
          className={`rounded-lg p-2 ${
            item.reorderQty > 0 ? 'bg-teal-50 text-teal-900' : 'bg-slate-50 text-slate-700'
          }`}
        >
          <dt className="text-xs">{t('forecasts.orderThis.suggestedOrder')}</dt>
          <dd className="text-lg font-bold">
            {item.reorderQty > 0 ? `+${item.reorderQty}` : t('forecasts.orderThis.wellStocked')}
          </dd>
        </div>
      </dl>

      {item.reorderQty > 0 && (
        <Link
          to="/inventory/add"
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-teal-700 px-3 text-sm font-semibold text-teal-800 hover:bg-teal-50"
        >
          <PackagePlus aria-hidden="true" className="h-4 w-4" />
          {t('forecasts.orderThis.addStockCta')}
        </Link>
      )}
    </li>
  );
}

function ClearCard({ item, productName }: { item: ForecastRiskItem; productName: string }) {
  const { t } = useTranslation();

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900">{productName}</p>
          {item.expiryDate && (
            <p className="text-xs text-slate-600">
              {t('forecasts.clearThis.expiresOn', { date: item.expiryDate })}
            </p>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${RISK_BADGE[item.riskType]}`}
        >
          {t(`forecasts.risk.${item.riskType}`)}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-700">{t('forecasts.clearThis.available')}</dt>
          <dd className="text-lg font-bold text-slate-900">{item.availableQty}</dd>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <dt className="text-xs text-slate-700">{t('forecasts.clearThis.daysOfCover')}</dt>
          <dd className="text-lg font-bold text-slate-900">
            {item.daysOfCover >= 999 ? '999+' : Math.round(item.daysOfCover)}
          </dd>
        </div>
        <div className="rounded-lg bg-red-50 p-2 text-red-900">
          <dt className="text-xs">{t('forecasts.clearThis.unsoldRisk')}</dt>
          <dd className="text-lg font-bold">{item.expectedUnsoldQty}</dd>
        </div>
      </dl>

      <div
        className={`mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ${ACTION_BADGE[item.recommendedAction]}`}
      >
        <ActionIcon action={item.recommendedAction} />
        <span>{t(`forecasts.action.${item.recommendedAction}`)}</span>
      </div>
    </li>
  );
}
