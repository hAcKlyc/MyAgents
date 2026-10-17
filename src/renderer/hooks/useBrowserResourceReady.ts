import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import {
  isBrowserResourceReady,
  selectLatestBrowserResourceStatus,
  type BrowserResourceStatus,
} from '../../shared/browserTools';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';

/** Read-only renderer projection of the Rust-owned Browser resource state. */
// null = initial read pending, undefined = read failed. Neither is ready.
export function useBrowserResourceStatus(): BrowserResourceStatus | null | undefined {
  const [status, setStatus] = useState<BrowserResourceStatus | null | undefined>(null);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const controller = new AbortController();
    const accept = (incoming: BrowserResourceStatus) => {
      setStatus(current => selectLatestBrowserResourceStatus(current, incoming));
    };
    void listenWithCleanup<BrowserResourceStatus>(
      'browser-resource-status',
      event => accept(event.payload),
      controller.signal,
    );
    void invoke<BrowserResourceStatus>('cmd_browser_resource_status')
      .then(accept)
      .catch(() => { if (!controller.signal.aborted) setStatus(current => current ?? undefined); });
    return () => controller.abort();
  }, []);

  return status;
}

export function useBrowserResourceReady(): boolean {
  return isBrowserResourceReady(useBrowserResourceStatus());
}
