import { useSyncExternalStore } from 'react';
import { isBrowserResourceReady, type BrowserResourceStatus } from '../../src/shared/browserTools';
const listeners = new Set<() => void>();
let revision = 0;
export let resource: BrowserResourceStatus = { state: 'never_installed', requiredRevision: 'test', installAuthorized: false, retryable: true, automaticRetryCount: 0, statusRevision: 1, updatedAt: '' };
export function changeResource(patch: Partial<BrowserResourceStatus>) {
  resource = { ...resource, ...patch, statusRevision: ++revision }; listeners.forEach(fn => fn());
}
export function useBrowserResourceStatus() {
  useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => revision);
  return resource;
}
export const CliToolsSection = () => null;
export const useBrowserResourceReady = () => isBrowserResourceReady(useBrowserResourceStatus());
