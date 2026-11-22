import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Lock, Store } from 'lucide-react';
import { homePath } from '../../lib/session';
import { useLogin, useRegister } from './hooks';

type Lang = 'en' | 'te' | 'hi';

const LABELS: Record<
  Lang,
  { title: string; login: string; register: string; submitLogin: string; submitRegister: string }
> = {
  en: {
    title: 'Kirana Exchange',
    login: 'Sign In',
    register: 'Register Shop Owner',
    submitLogin: 'Sign In',
    submitRegister: 'Create Account',
  },
  te: {
    title: 'కిరాణా ఎక్స్ఛేంజ్',
    login: 'లాగిన్',
    register: 'కొత్త ఖాతా',
    submitLogin: 'లాగిన్ అవ్వండి',
    submitRegister: 'ఖాతా సృష్టించండి',
  },
  hi: {
    title: 'किराना एक्सचेंज',
    login: 'लॉग इन',
    register: 'नया खाता',
    submitLogin: 'लॉग इन करें',
    submitRegister: 'खाता बनाएं',
  },
};

export function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [lang, setLang] = useState<Lang>('en');
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

    if (mode === 'login') {
      loginMutation.mutate(payload, {
        onSuccess: () => navigate(homePath(), { replace: true }),
      });
    } else {
      registerMutation.mutate(payload, {
        onSuccess: () => navigate(homePath(), { replace: true }),
      });
    }
  };

  const t = LABELS[lang];

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-teal-700">
          <Store className="h-6 w-6" />
          <h1 className="text-xl font-bold">{t.title}</h1>
        </div>
        <div className="flex gap-1 rounded-md border border-slate-200 bg-white p-1 text-xs">
          {(['en', 'te', 'hi'] as Lang[]).map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setLang(code)}
              className={`rounded px-2 py-1 font-medium ${
                lang === code ? 'bg-teal-700 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {code.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-6 grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => setMode('login')}
            className={`rounded-md py-2 text-sm font-medium ${
              mode === 'login' ? 'bg-white text-teal-700 shadow-xs' : 'text-slate-600'
            }`}
          >
            {t.login}
          </button>
          <button
            type="button"
            onClick={() => setMode('register')}
            className={`rounded-md py-2 text-sm font-medium ${
              mode === 'register' ? 'bg-white text-teal-700 shadow-xs' : 'text-slate-600'
            }`}
          >
            {t.register}
          </button>
        </div>

        {lockoutSeconds > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">Account temporarily locked (HTTP 429)</p>
              <p>Try again in {lockoutSeconds}s.</p>
            </div>
          </div>
        )}

        {activeMutation.error && lockoutSeconds === 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">{activeMutation.error.detail}</p>
              {activeMutation.error.correlationId && (
                <p className="mt-1 font-mono text-xs text-red-600">
                  Ref: {activeMutation.error.correlationId}
                </p>
              )}
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ramesh@kirana.in"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="phone">
              Phone (optional if email provided)
            </label>
            <input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+919876543210"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimum 8 characters"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={activeMutation.isPending || lockoutSeconds > 0}
            className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {activeMutation.isPending
              ? 'Please wait...'
              : mode === 'login'
                ? t.submitLogin
                : t.submitRegister}
          </button>
        </form>
      </div>
    </main>
  );
}
