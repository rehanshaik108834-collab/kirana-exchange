import i18n from '../../i18n';

export type ExpiryLevel = 'expired' | 'critical' | 'warning' | 'ok';

export interface ExpiryStatus {
  level: ExpiryLevel;
  daysLeft: number;
  label: string;
}

/** Whole calendar days from `today` to `expiryDate` (YYYY-MM-DD), independent of time of day. */
export function daysUntil(expiryDate: string, today: Date = new Date()): number {
  const [y, m, d] = expiryDate.slice(0, 10).split('-').map(Number);
  const expiryUtc = Date.UTC(y, m - 1, d);
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((expiryUtc - todayUtc) / 86_400_000);
}

/** Near-expiry badge rules for US-11: red when expired or 7 days or less, amber at 30 days or less. */
export function expiryStatus(expiryDate: string, today: Date = new Date()): ExpiryStatus {
  const daysLeft = daysUntil(expiryDate, today);
  if (daysLeft < 0) return { level: 'expired', daysLeft, label: i18n.t('expiry.expired') };
  if (daysLeft === 0) return { level: 'critical', daysLeft, label: i18n.t('expiry.today') };
  if (daysLeft <= 7)
    return { level: 'critical', daysLeft, label: i18n.t('expiry.inDays', { count: daysLeft }) };
  if (daysLeft <= 30)
    return { level: 'warning', daysLeft, label: i18n.t('expiry.inDays', { count: daysLeft }) };
  return { level: 'ok', daysLeft, label: i18n.t('expiry.left', { count: daysLeft }) };
}

/** Local YYYY-MM-DD for `today + days` (default expiry from the product shelf life). */
export function addDaysIso(days: number, today: Date = new Date()): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
