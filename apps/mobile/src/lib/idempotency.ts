import { randomUUID } from 'expo-crypto';
import { useCallback, useRef } from 'react';

// One key per user INTENT, not per request: retries (manual or automatic)
// of the same transfer reuse it, so the server applies it at most once. A
// new key is minted only after the server confirmed the previous intent.
export function useIdempotencyKey(): { key: string; rotate: () => void } {
  const ref = useRef(randomUUID());
  const rotate = useCallback(() => {
    ref.current = randomUUID();
  }, []);
  return { key: ref.current, rotate };
}
