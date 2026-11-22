import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
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
