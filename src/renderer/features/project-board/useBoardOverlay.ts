import { useSyncExternalStore } from 'react';
const QUERY = '(max-width: 700px)';
function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
const snapshot = () => window.matchMedia(QUERY).matches;
export function useBoardOverlay() { return useSyncExternalStore(subscribe, snapshot); }
