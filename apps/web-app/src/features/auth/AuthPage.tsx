import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Lock, Store } from 'lucide-react';
import { LanguageSwitcher } from '../../i18n/LanguageSwitcher';
import { homePath } from '../../lib/session';
import { useLogin, useRegister } from './hooks';

const INPUT =
  'min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-base focus:border-teal-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600';

export function AuthPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [lockoutSeconds, setLockoutSeconds] = useState(0);

  const loginMutation = useLogin();
  const registerMutation = useRegister();
  const activeMutation = mode === 'login' ? loginMutation : registerMutation;

  useEffect(() => {
    if (activeMutation.error?.status === 429 && activeMutation.error.retryAfterSeconds) {
      setLockoutSeconds(activeMutation.error.retryAfterSeconds);
    }
  }, [activeMutation.error]);

  useEffect(() => {
    if (lockoutSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setLockoutSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [lockoutSeconds]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const payload = {
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      password,
    };
    const onSuccess = () => navigate(homePath(), { replace: true });
    if (mode === 'login') {
      loginMutation.mutate(payload, { onSuccess });
    } else {
      registerMutation.mutate(payload, { onSuccess });
    }
  };

  const tabClass = (active: boolean) =>
    `min-h-11 rounded-md text-sm font-medium ${
      active ? 'bg-white text-teal-800 shadow-xs' : 'text-slate-700'
    }`;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-teal-800">
          <Store className="h-6 w-6" aria-hidden="true" />
          <h1 className="text-xl font-bold">{t('common.appName')}</h1>
        </div>
        <LanguageSwitcher />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-6 grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1">
          <button
            type="button"
            aria-pressed={mode === 'login'}
            onClick={() => setMode('login')}
            className={tabClass(mode === 'login')}
          >
            {t('auth.signIn')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'register'}
            onClick={() => setMode('register')}
            className={tabClass(mode === 'register')}
          >
            {t('auth.registerTab')}
          </button>
        </div>

        {lockoutSeconds > 0 && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-semibold">{t('auth.lockedTitle')}</p>
              <p>{t('auth.lockedRetry', { seconds: lockoutSeconds })}</p>
            </div>
          </div>
        )}

        {activeMutation.error && lockoutSeconds === 0 && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">{activeMutation.error.detail}</p>
              {activeMutation.error.correlationId && (
                <p className="mt-1 font-mono text-xs text-red-700">
                  {t('common.ref', { id: activeMutation.error.correlationId })}
                </p>
              )}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="email">
              {t('auth.email')}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ramesh@kirana.in"
              className={INPUT}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="phone">
              {t('auth.phone')}
            </label>
            <input
              id="phone"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+919876543210"
              className={INPUT}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="password">
              {t('auth.password')}
            </label>
            <input
              id="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth.passwordPlaceholder')}
              className={INPUT}
            />
          </div>

          <button
            type="submit"
            disabled={activeMutation.isPending || lockoutSeconds > 0}
            className="min-h-12 w-full rounded-lg bg-teal-700 px-4 text-base font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {activeMutation.isPending
              ? t('auth.pleaseWait')
              : mode === 'login'
                ? t('auth.signIn')
                : t('auth.createAccount')}
          </button>
        </form>
      </div>
    </main>
  );
}
