import { useSyncExternalStore } from 'react';
import { session } from '@/lib/session-instance';

export function useSessionStatus() {
  return useSyncExternalStore(
    (onChange) => session.subscribe(onChange),
    () => session.currentStatus,
  );
}
