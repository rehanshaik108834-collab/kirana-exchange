// Test stand-in for `virtual:pwa-register/react` (only exists in the Vite build); see vitest.config.ts.
import { useState } from 'react';

export const swState = {
  initialNeedRefresh: false,
  updateServiceWorker: (_reload?: boolean): Promise<void> => Promise.resolve(),
};

export function useRegisterSW() {
  const needRefresh = useState(swState.initialNeedRefresh);
  const offlineReady = useState(false);
  return { needRefresh, offlineReady, updateServiceWorker: swState.updateServiceWorker };
}
