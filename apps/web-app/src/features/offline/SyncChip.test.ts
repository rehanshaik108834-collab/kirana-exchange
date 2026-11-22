import { describe, expect, it } from 'vitest';
import type { StoredEntry } from './queue';
import { summariseSync } from './SyncChip';

const entry = (status: StoredEntry['status']) => ({ status }) as StoredEntry;

describe('summariseSync', () => {
  it('reports the most urgent state first, in plain language', () => {
    expect(summariseSync('idle', [])).toEqual({ tone: 'ok', label: 'All saved' });
    expect(summariseSync('idle', [entry('pending'), entry('pending')]).label).toBe('2 waiting');
    expect(summariseSync('syncing', [entry('pending')]).label).toBe('Syncing…');
    expect(summariseSync('offline', [entry('pending')]).label).toBe('Offline · 1 waiting');
    expect(summariseSync('offline', []).label).toBe('Offline');
    expect(summariseSync('idle', [entry('conflict'), entry('blocked')]).label).toBe(
      '1 needs attention',
    );
    expect(summariseSync('signed-out', [entry('pending')]).label).toMatch(/sign in again/);
  });
});
