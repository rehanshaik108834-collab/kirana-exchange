import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthPage } from './features/auth/AuthPage';
import { AddBatchPage } from './features/inventory/AddBatchPage';
import { InventoryPage } from './features/inventory/InventoryPage';
import { AppShell } from './features/shell/AppShell';
import { ShopSetupPage } from './features/shop-setup/ShopSetupPage';
import { homePath } from './lib/session';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
    mutations: {
      // Never auto-retry writes: retries are explicit and reuse the same Idempotency-Key.
      retry: false,
    },
  },
});

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
          <Route path="*" element={<Navigate to={homePath()} replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
