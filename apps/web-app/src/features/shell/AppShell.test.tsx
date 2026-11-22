import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  entries: [] as unknown[],
  signOut: vi.fn(async () => undefined),
}));

vi.mock('../offline/runtime', () => ({
  useSyncTriggers: () => undefined,
  useSyncState: () => 'idle',
  useQueueEntries: () => mocks.entries,
}));
vi.mock('../../lib/session', () => ({ signOut: mocks.signOut }));
vi.mock('../../lib/api-client', () => ({
  apiClient: { get: () => new Promise(() => undefined) },
  ApiProblemError: class extends Error {},
}));

import { AppShell } from './AppShell';

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/inventory']}>
        <Routes>
          <Route path="/inventory" element={<AppShell>stock</AppShell>} />
          <Route path="/login" element={<p>login page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const pending = (seq: number) => ({ seq, status: 'pending', kind: 'sale' });

describe('AppShell sign-out (US-05)', () => {
  beforeEach(() => {
    mocks.entries = [];
    mocks.signOut.mockClear();
  });

  it('signs out straight away when nothing is waiting to sync', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('login page');
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it('asks first when entries are not synced, and "Stay signed in" keeps everything', async () => {
    mocks.entries = [pending(1), pending(2), pending(3)];
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('3 entries are not saved to your shop yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('"Sign out anyway" signs out (which wipes device data)', async () => {
    mocks.entries = [pending(1)];
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('1 entry is not saved');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(1));
    await screen.findByText('login page');
  });
});
