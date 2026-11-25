import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, CheckCircle2, FlaskConical, RefreshCw, ShieldAlert } from 'lucide-react';
import { formatMoney } from '../../i18n';
import { currentClaims } from '../../lib/session';
import {
  type PairedExperimentResult,
  useNetworkMap,
  useNetworkMetrics,
  useOpenDisputes,
  useResolveDispute,
  useRunPairedSimulation,
  useSimulations,
} from './hooks';

const DEFAULT_CENTER: [number, number] = [17.385, 78.4867];

export function AdminDashboardPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isAdmin = currentClaims()?.role === 'admin';

  const mapData = useNetworkMap(isAdmin);
  const metrics = useNetworkMetrics(isAdmin, 30);
  const simulations = useSimulations(isAdmin);
  const disputes = useOpenDisputes(isAdmin);
  const runSim = useRunPairedSimulation();
  const resolveDispute = useResolveDispute();

  const [seed, setSeed] = useState(42);
  const [shopCount, setShopCount] = useState(12);
  const [acceptanceRate, setAcceptanceRate] = useState(0.5);
  const [radiusKm, setRadiusKm] = useState(5);
  const [lastSim, setLastSim] = useState<PairedExperimentResult | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  if (!isAdmin) {
    return <p className="text-sm text-red-700">{t('admin.adminOnly')}</p>;
  }

  const shops = mapData.data?.shops ?? [];
  const center: [number, number] = shops.length > 0 ? [shops[0].lat, shops[0].lng] : DEFAULT_CENTER;

  const totals = metrics.data?.totals;
  const daily = metrics.data?.daily ?? [];

  const handleRunSim = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    try {
      const res = await runSim.mutateAsync({
        seed,
        shop_count: shopCount,
        acceptance_rate: acceptanceRate,
        radius_km: radiusKm,
        days: 60,
      });
      setLastSim(res);
    } catch (err) {
      setFeedback({
        tone: 'error',
        text: err instanceof Error ? err.message : t('admin.actionFailed'),
      });
    }
  };

  const handleDisputeAction = async (id: string, status: 'RESOLVED' | 'DISMISSED') => {
    setFeedback(null);
    try {
      await resolveDispute.mutateAsync({
        id,
        status,
        resolutionNotes:
          status === 'RESOLVED' ? 'Resolved by platform admin' : 'Dismissed by admin',
        penaltyPoints: status === 'RESOLVED' ? 5 : 0,
      });
      setFeedback({ tone: 'ok', text: t('admin.disputes.resolvedOk') });
    } catch (err) {
      setFeedback({
        tone: 'error',
        text: err instanceof Error ? err.message : t('admin.actionFailed'),
      });
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{t('admin.title')}</h1>
          <p className="text-xs text-slate-600">{t('admin.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            void qc.invalidateQueries({ queryKey: ['analytics'] });
            void qc.invalidateQueries({ queryKey: ['shops', 'disputes'] });
          }}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          {t('admin.refresh')}
        </button>
      </div>

      {feedback && (
        <div
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
            feedback.tone === 'ok'
              ? 'border-teal-200 bg-teal-50 text-teal-900'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {feedback.tone === 'ok' ? (
            <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <p>{feedback.text}</p>
        </div>
      )}

      {/* KPI Summary Grid */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <dt className="text-xs text-slate-600">{t('admin.kpi.shops')}</dt>
          <dd className="mt-1 text-2xl font-bold text-slate-900">
            {mapData.data?.totalShops ?? 0}
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <dt className="text-xs text-slate-600">{t('admin.kpi.activeListings')}</dt>
          <dd className="mt-1 text-2xl font-bold text-teal-800">
            {mapData.data?.totalActiveListings ?? 0}
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <dt className="text-xs text-slate-600">{t('admin.kpi.stockoutsAvoided')}</dt>
          <dd className="mt-1 text-2xl font-bold text-slate-900">
            {totals?.stockoutsAvoided ?? 0}
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <dt className="text-xs text-slate-600">{t('admin.kpi.cashReleased')}</dt>
          <dd className="mt-1 text-lg font-bold text-emerald-800">
            {formatMoney(totals?.cashReleased ?? 0)}
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <dt className="text-xs text-slate-600">{t('admin.kpi.deadStockReduced')}</dt>
          <dd className="mt-1 text-lg font-bold text-teal-900">
            {formatMoney(totals?.deadStockValueReduced ?? 0)}
          </dd>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <dt className="text-xs text-slate-600">{t('admin.kpi.groupbuySavings')}</dt>
          <dd className="mt-1 text-lg font-bold text-amber-900">
            {formatMoney(totals?.groupbuySavings ?? 0)}
          </dd>
        </div>
      </dl>

      {/* Live Network Map (Leaflet reading analytics_db shop_map_projection) */}
      <section
        aria-labelledby="admin-map-heading"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <h2 id="admin-map-heading" className="text-base font-bold text-slate-900">
          {t('admin.map.title')}
        </h2>
        {shops.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-sm text-slate-600">
            {t('admin.map.empty')}
          </p>
        ) : (
          <div className="mt-3 h-72 w-full overflow-hidden rounded-lg border border-slate-200">
            <MapContainer
              center={center}
              className="h-full w-full"
              scrollWheelZoom={false}
              zoom={12}
            >
              <TileLayer
                attribution="&copy; OpenStreetMap contributors"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {shops.map((shop) => (
                <CircleMarker
                  key={shop.shopId}
                  center={[shop.lat, shop.lng]}
                  radius={shop.activeListingsCount > 0 ? 9 : 6}
                  pathOptions={{
                    color: shop.reputationScore >= 85 ? '#0f766e' : '#d97706',
                    fillOpacity: 0.75,
                  }}
                >
                  <Popup>
                    <strong>{shop.name}</strong>
                    <br />
                    {t('admin.map.popupMeta', {
                      state: shop.state,
                      rep: shop.reputationScore.toFixed(0),
                      listings: shop.activeListingsCount,
                    })}
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>
        )}
      </section>

      {/* Daily Impact Metrics Chart (Recharts) */}
      <section
        aria-labelledby="admin-chart-heading"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <h2 id="admin-chart-heading" className="text-base font-bold text-slate-900">
          {t('admin.chart.title')}
        </h2>
        <p className="text-xs text-slate-600">{t('admin.chart.subtitle')}</p>
        {daily.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-sm text-slate-600">
            {t('admin.chart.empty')}
          </p>
        ) : (
          <div className="mt-4 h-60 w-full" role="img" aria-label={t('admin.chart.chartAria')}>
            <ResponsiveContainer width="100%" height="100%" minWidth={240} minHeight={220}>
              <BarChart data={daily} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#475569' }} />
                <YAxis tick={{ fontSize: 11, fill: '#475569' }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar
                  dataKey="cashReleased"
                  name={t('admin.chart.cashSeries')}
                  fill="#0f766e"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="groupbuySavings"
                  name={t('admin.chart.groupbuySeries')}
                  fill="#d97706"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* Seeded Paired With/Without-Exchange Simulator */}
      <section
        aria-labelledby="admin-sim-heading"
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2
              id="admin-sim-heading"
              className="flex items-center gap-1.5 text-base font-bold text-slate-900"
            >
              <FlaskConical aria-hidden="true" className="h-4 w-4 text-teal-700" />
              {t('admin.sim.title')}
            </h2>
            <p className="text-xs text-slate-600">{t('admin.sim.subtitle')}</p>
          </div>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
            {t('admin.sim.runsCount', { count: simulations.data?.length ?? 0 })}
          </span>
        </div>

        <form
          onSubmit={(e) => void handleRunSim(e)}
          className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        >
          <label className="text-xs font-medium text-slate-700">
            {t('admin.sim.seed')}
            <input
              type="number"
              min={0}
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
            />
          </label>
          <label className="text-xs font-medium text-slate-700">
            {t('admin.sim.shops')}
            <input
              type="number"
              min={2}
              max={100}
              value={shopCount}
              onChange={(e) => setShopCount(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
            />
          </label>
          <label className="text-xs font-medium text-slate-700">
            {t('admin.sim.acceptance')}
            <input
              type="number"
              step="0.05"
              min={0}
              max={1}
              value={acceptanceRate}
              onChange={(e) => setAcceptanceRate(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
            />
          </label>
          <label className="text-xs font-medium text-slate-700">
            {t('admin.sim.radius')}
            <input
              type="number"
              step="0.5"
              min={0.5}
              max={15}
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={runSim.isPending}
            className="col-span-2 min-h-11 rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50 sm:col-span-4"
          >
            {runSim.isPending ? t('admin.sim.running') : t('admin.sim.run')}
          </button>
        </form>

        {lastSim && (
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-teal-200 bg-teal-50 p-3 text-xs text-teal-950 sm:grid-cols-4">
            <p className="font-semibold">
              {t('admin.sim.deadStockDelta', {
                pct: lastSim.deltas.deadStockReductionPct.toFixed(1),
              })}
            </p>
            <p className="font-semibold">
              {t('admin.sim.stockoutDelta', {
                pct: lastSim.deltas.stockoutReductionPct.toFixed(1),
              })}
            </p>
            <p className="font-semibold">
              {t('admin.sim.cashDelta', { amount: formatMoney(lastSim.deltas.cashReleasedInr) })}
            </p>
            <p className="font-semibold">
              {t('admin.sim.savingsDelta', {
                amount: formatMoney(lastSim.deltas.groupbuySavingsInr),
              })}
            </p>
          </div>
        )}
      </section>

      {/* Open Swap Disputes Queue */}
      <section
        aria-labelledby="admin-disputes-heading"
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <h2
          id="admin-disputes-heading"
          className="flex items-center gap-1.5 text-base font-bold text-slate-900"
        >
          <ShieldAlert aria-hidden="true" className="h-4 w-4 text-red-700" />
          {t('admin.disputes.title')}
        </h2>

        {(disputes.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-slate-600">{t('admin.disputes.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {(disputes.data ?? []).map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-900">{d.reason}</p>
                  <p className="text-xs text-slate-600">
                    {t('admin.disputes.txLine', { tx: d.transactionId.slice(0, 8) })}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={resolveDispute.isPending}
                    onClick={() => void handleDisputeAction(d.id, 'RESOLVED')}
                    className="min-h-10 rounded-lg bg-teal-700 px-3 text-xs font-semibold text-white hover:bg-teal-800"
                  >
                    {t('admin.disputes.resolve')}
                  </button>
                  <button
                    type="button"
                    disabled={resolveDispute.isPending}
                    onClick={() => void handleDisputeAction(d.id, 'DISMISSED')}
                    className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {t('admin.disputes.dismiss')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
