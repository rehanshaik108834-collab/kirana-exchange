import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';
import { LogOut, PackagePlus, Store, Warehouse } from 'lucide-react';
import { apiClient, ApiProblemError } from '../../lib/api-client';
import { signOut } from '../../lib/session';
import type { ShopResponse } from '../auth/hooks';

export function useMyShop() {
  return useQuery<ShopResponse, ApiProblemError>({
    queryKey: ['shops', 'me'],
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<ShopResponse>('/shops/me', { signal })).data,
  });
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  `inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${
    isActive ? 'bg-teal-700 text-white' : 'text-slate-700 hover:bg-slate-100'
  }`;

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const shop = useMyShop();

  const handleSignOut = async () => {
    await signOut();
    queryClient.clear(); // drop cached private shop data
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-[1000] border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-teal-700">
            <Store className="h-5 w-5 shrink-0" />
            <span className="truncate font-semibold">{shop.data?.name ?? 'Kirana Exchange'}</span>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
        <nav className="mx-auto flex max-w-3xl gap-2 px-4 pb-3" aria-label="Main">
          <NavLink to="/inventory" end className={navClass}>
            <Warehouse className="h-4 w-4" />
            Stock
          </NavLink>
          <NavLink to="/inventory/add" className={navClass}>
            <PackagePlus className="h-4 w-4" />
            Add stock
          </NavLink>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
    </div>
  );
}
