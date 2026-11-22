import { lazy, type ReactNode, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { UpdatePrompt } from './features/shell/UpdatePrompt';
import { queryClient } from './lib/query-client';
import { homePath } from './lib/session';

// Route-level code splitting: each page downloads only when first visited
// (Leaflet loads only on shop setup), keeping the first load small for slow mobile data.
const AuthPage = lazy(() =>
  import('./features/auth/AuthPage').then((m) => ({ default: m.AuthPage })),
);
const ShopSetupPage = lazy(() =>
  import('./features/shop-setup/ShopSetupPage').then((m) => ({ default: m.ShopSetupPage })),
);
const InventoryPage = lazy(() =>
  import('./features/inventory/InventoryPage').then((m) => ({ default: m.InventoryPage })),
);
const AddBatchPage = lazy(() =>
  import('./features/inventory/AddBatchPage').then((m) => ({ default: m.AddBatchPage })),
);
const SyncIssuesPage = lazy(() =>
  import('./features/offline/SyncIssuesPage').then((m) => ({ default: m.SyncIssuesPage })),
);
const AppShell = lazy(() =>
  import('./features/shell/AppShell').then((m) => ({ default: m.AppShell })),
);

function PageLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center text-slate-600" role="status">
      <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  );
}

/** Routes are UX only: the gateway and services enforce auth and shop ownership on every call. */
function Guard({ need, children }: { need: 'auth' | 'no-shop' | 'shop'; children: ReactNode }) {
  const home = homePath();
  if (home === '/login') return <Navigate to="/login" replace />;
  if (need === 'no-shop' && home === '/inventory') return <Navigate to="/inventory" replace />;
  if (need === 'shop' && home === '/shop-setup') return <Navigate to="/shop-setup" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/login" element={<AuthPage />} />
            <Route
              path="/shop-setup"
              element={
                <Guard need="no-shop">
                  <ShopSetupPage />
                </Guard>
              }
            />
            <Route
              path="/inventory"
              element={
                <Guard need="shop">
                  <AppShell>
                    <InventoryPage />
                  </AppShell>
                </Guard>
              }
            />
            <Route
              path="/inventory/add"
              element={
                <Guard need="shop">
                  <AppShell>
                    <AddBatchPage />
                  </AppShell>
                </Guard>
              }
            />
            <Route
              path="/sync-issues"
              element={
                <Guard need="shop">
                  <AppShell>
                    <SyncIssuesPage />
                  </AppShell>
                </Guard>
              }
            />
            <Route path="*" element={<Navigate to={homePath()} replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
      <UpdatePrompt />
    </QueryClientProvider>
  );
}

export default App;
