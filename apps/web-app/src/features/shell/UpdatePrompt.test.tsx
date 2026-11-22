import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { swState } from '../../test/pwa-register-stub';
import { UpdatePrompt } from './UpdatePrompt';

afterEach(() => {
  swState.initialNeedRefresh = false;
  vi.restoreAllMocks();
});

describe('UpdatePrompt', () => {
  it('renders nothing when no update is waiting', () => {
    const { container } = render(<UpdatePrompt />);
    expect(container.innerHTML).toBe('');
  });

  it('asks before activating a new version and reloads only on confirm', () => {
    swState.initialNeedRefresh = true;
    const update = vi.spyOn(swState, 'updateServiceWorker');
    render(<UpdatePrompt />);
    expect(screen.getByRole('status').textContent).toMatch(/new version/i);
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(update).toHaveBeenCalledWith(true);
  });

  it('can be dismissed without reloading', () => {
    swState.initialNeedRefresh = true;
    const update = vi.spyOn(swState, 'updateServiceWorker');
    render(<UpdatePrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
