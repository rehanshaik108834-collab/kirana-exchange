import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { type AccuracyPoint, computeSeriesWapePct } from './hooks';

function shortDate(iso: string): string {
  const parts = iso.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}`;
  return iso;
}

export function AccuracyChart({ series }: { series: AccuracyPoint[] }) {
  const { t } = useTranslation();
  const wapePct = useMemo(() => computeSeriesWapePct(series), [series]);
  const chartData = useMemo(
    () =>
      series.map((pt) => ({
        ...pt,
        label: shortDate(pt.date),
      })),
    [series],
  );

  return (
    <section
      aria-labelledby="forecast-accuracy-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="forecast-accuracy-heading" className="text-base font-bold text-slate-900">
            {t('forecasts.accuracy.title')}
          </h2>
          <p className="text-xs text-slate-600">{t('forecasts.accuracy.subtitle')}</p>
        </div>
        {wapePct !== null && (
          <span className="rounded-full bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-900">
            {t('forecasts.accuracy.wape', { pct: wapePct.toFixed(1) })}
          </span>
        )}
      </div>

      {chartData.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-sm text-slate-600">
          {t('forecasts.accuracy.empty')}
        </p>
      ) : (
        <div className="mt-4 h-60 w-full" role="img" aria-label={t('forecasts.accuracy.chartAria')}>
          <ResponsiveContainer width="100%" height="100%" minHeight={220} minWidth={240}>
            <LineChart data={chartData} margin={{ top: 8, right: 12, left: -12, bottom: 4 }}>
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#475569' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#475569' }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="actualQty"
                name={t('forecasts.accuracy.actual')}
                stroke="#0f766e"
                strokeWidth={2.5}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
              <Line
                type="monotone"
                dataKey="predictedQty"
                name={t('forecasts.accuracy.predicted')}
                stroke="#d97706"
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
