import { useCallback, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

/**
 * One Idempotency-Key per logical submission (phase-1 §5.3):
 * - Reused on every retry of the same submission, so a request that reached the server but
 *   whose response was lost can never create a second batch.
 * - Call `rotate()` only after a confirmed success (or when the user starts a new entry).
 */
export function useIdempotencyKey(): { key: string; rotate: () => void } {
  const [key, setKey] = useState(() => uuidv4());
  const rotate = useCallback(() => setKey(uuidv4()), []);
  return { key, rotate };
}
