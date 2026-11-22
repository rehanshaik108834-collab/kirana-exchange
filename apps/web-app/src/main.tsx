import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { queryClient } from './lib/query-client';
import { restorePersistedQueries, startPersistingQueries } from './lib/query-persistence';
import './index.css';

async function bootstrap() {
  try {
    // Show the last known stock immediately, even after an offline reload.
    // Bounded so a slow or broken IndexedDB never blocks the app from starting.
    await Promise.race([
      restorePersistedQueries(queryClient),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // IndexedDB unavailable (private mode): run online-only.
  }
  startPersistingQueries(queryClient);

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
