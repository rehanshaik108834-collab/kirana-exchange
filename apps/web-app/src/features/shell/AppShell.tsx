import { type ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRightLeft,
  LogOut,
  PackagePlus,
  Store,
  TrendingUp,
  Warehouse,
} from 'lucide-react';
import { LanguageSwitcher } from '../../i18n/LanguageSwitcher';
import { apiClient, ApiProblemError } from '../../lib/api-client';
import { signOut } from '../../lib/session';
import type { ShopResponse } from '../auth/hooks';
import { SyncChip } from '../offline/SyncChip';
import { useQueueEntries, useSyncState, useSyncTriggers } from '../offline/runtime';

export function useMyShop() {
  return useQuery<ShopResponse, ApiProblemError>({
    queryKey: ['shops', 'me'],
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<ShopResponse>('/shops/me', { signal })).data,
  });
}

// Primary navigation: 48 px tall targets (thumb use on a small phone).
const navClass = ({ isActive }: { isActive: boolean }) =>
  `inline-flex min-h-12 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 ${
    isActive ? 'bg-teal-700 text-white' : 'text-slate-700 hover:bg-slate-100'
  }`;

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const shop = useMyShop();
  useSyncTriggers();
  const syncState = useSyncState();
  const queueEntries = useQueueEntries();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const doSignOut = async () => {
    setSigningOut(true);
    await signOut(); // revokes server-side, then wipes IndexedDB (queue + caches)
    queryClient.clear(); // drop cached private shop data held in memory
    navigate('/login', { replace: true });
  };

  // US-05: unsent entries would be wiped with the device data, so ask first.
  const handleSignOut = () => {
    if (queueEntries.length > 0) setConfirmSignOut(true);
    else void doSignOut();
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-[1000] border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 pt-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-teal-700">
            <Store aria-hidden="true" className="h-5 w-5 shrink-0" />
            <span className="truncate font-semibold">{shop.data?.name ?? t('common.appName')}</span>
          </div>
          <SyncChip entries={queueEntries} state={syncState} />
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <LogOut aria-hidden="true" className="h-4 w-4" />
            {t('common.signOut')}
          </button>
        </div>
        <nav
          className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 px-4 py-2"
          aria-label={t('nav.main')}
        >
          <NavLink className={navClass} end to="/inventory">
            <Warehouse aria-hidden="true" className="h-4 w-4" />
            {t('nav.stock')}
          </NavLink>
          <NavLink className={navClass} to="/inventory/add">
            <PackagePlus aria-hidden="true" className="h-4 w-4" />
            {t('nav.addStock')}
          </NavLink>
          <NavLink className={navClass} to="/forecasts">
            <TrendingUp aria-hidden="true" className="h-4 w-4" />
            {t('nav.forecasts')}
          </NavLink>
          <NavLink className={navClass} to="/swaps">
            <ArrowRightLeft aria-hidden="true" className="h-4 w-4" />
            {t('nav.swaps')}
          </NavLink>
          <LanguageSwitcher className="ml-auto" />
        </nav>
        {confirmSignOut && (
          <div
            role="alertdialog"
            aria-labelledby="signout-title"
            aria-describedby="signout-body"
            className="mx-auto max-w-3xl px-4 pb-3"
          >
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
              <p id="signout-title" className="flex items-start gap-2 font-semibold">
                <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                {t('signOutConfirm.title', { count: queueEntries.length })}
              </p>
              <p id="signout-body" className="mt-1">
                {t('signOutConfirm.body')}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  autoFocus
                  onClick={() => setConfirmSignOut(false)}
                  className="min-h-12 flex-1 rounded-lg bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800"
                >
                  {t('signOutConfirm.stay')}
                </button>
                <button
                  type="button"
                  disabled={signingOut}
                  onClick={() => void doSignOut()}
                  className="min-h-12 flex-1 rounded-lg border border-red-300 bg-white px-4 font-semibold text-red-800 hover:bg-red-50 disabled:opacity-50"
                >
                  {t('signOutConfirm.anyway')}
                </button>
              </div>
            </div>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
    </div>
  );
}
