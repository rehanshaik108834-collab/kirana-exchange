import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SHOP_ID = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('../../lib/session', () => ({
  currentClaims: () => ({ sub: 'u-1', role: 'shop_owner', shopId: SHOP_ID }),
}));

vi.mock('../../lib/api-client', () => ({
  apiClient: {
    defaults: { baseURL: 'http://localhost:3001/v1' },
    get: mocks.apiGet,
    post: mocks.apiPost,
  },
  ApiProblemError: class ApiProblemError extends Error {},
}));

import { NotificationBell } from './NotificationBell';

describe('NotificationBell (Phase 10, Slice 4)', () => {
  beforeEach(() => {
    mocks.apiGet.mockReset();
    mocks.apiPost.mockReset();
    mocks.apiGet.mockResolvedValue({
      data: {
        unreadCount: 1,
        notifications: [
          {
            id: 'notif-1',
            shopId: SHOP_ID,
            type: 'saga.handover.ready.v1',
            channel: 'EMAIL',
            payload: { title: 'Swap handover PIN ready', body: 'Share PIN 482910 at pickup.' },
            readAt: null,
            sentAt: '2026-04-01T10:00:00Z',
          },
        ],
      },
    });
    mocks.apiPost.mockResolvedValue({ data: { updated: 1 } });
  });

  it('shows unread badge, opens alert drawer, and marks alerts read', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <NotificationBell />
      </QueryClientProvider>,
    );

    const bell = await screen.findByRole('button', { name: 'Notifications (1 unread)' });
    fireEvent.click(bell);

    expect(await screen.findByText('Swap handover PIN ready')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));

    await waitFor(() => {
      expect(mocks.apiPost).toHaveBeenCalledWith('/notifications/read-all');
    });
  });
});
