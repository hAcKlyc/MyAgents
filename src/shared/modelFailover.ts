export interface ModelFailoverSettings {
  enabled: boolean;
  /** The selected conversation model remains primary. No credentials here. */
  backup?: { providerId: string; modelId: string };
}

/** Native subscription/runtime credentials cannot be borrowed by an API bridge. */
export function isModelFailoverProvider(provider: { id: string; type?: unknown; execution?: unknown; enabled?: unknown }): boolean {
  const execution = provider.execution;
  return provider.type === 'api' && provider.enabled !== false
    && (!execution || (typeof execution === 'object' && 'kind' in execution && execution.kind === 'builtin'))
    && !provider.id.startsWith('cloud-session:');
}

/** Fail over on availability failures only, never auth, billing or bad input. */
export function isModelFailoverStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502
    || status === 503 || status === 504 || status === 529;
}
