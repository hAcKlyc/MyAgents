import { networkConnections } from '@/api/agentNetwork';
import { openExternal } from '@/utils/openExternal';

/** Only the configured owned issuer may receive cloud navigation. */
export function canonicalOwnedIssuer(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function openOwnedCloudPage(page: 'community' | 'feedback'): Promise<void> {
  const registry = await networkConnections();
  const issuer = canonicalOwnedIssuer(registry.ownedServiceUrl);
  if (!issuer) throw new Error('OWNED_SERVICE_UNAVAILABLE');
  await openExternal(`${issuer}/${page}`);
}
