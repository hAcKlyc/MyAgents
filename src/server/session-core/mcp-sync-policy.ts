import { createHash } from 'node:crypto';
import type { McpServerDefinition } from '../../shared/config-types';

export type McpAuthority = 'tab' | 'self-resolve';

export function getMcpAuthorityForScenario(scenario: 'desktop' | 'cron' | 'im' | 'agent-channel' | 'registeredAgent'): McpAuthority {
  return scenario === 'desktop' ? 'tab' : 'self-resolve';
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, stableObject(nested)]),
  );
}

export function mcpConfigFingerprint(servers: readonly McpServerDefinition[]): string {
  return JSON.stringify(
    servers
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(s => ({
        id: s.id,
        type: s.type,
        command: s.command,
        args: stableObject(s.args),
        url: s.url,
        env: stableObject(s.env),
        headers: stableObject(s.headers),
        runtimeConfigRevision: s.runtimeConfigRevision,
      })),
  );
}

export function decideMcpSync(params: {
  previousServers: readonly McpServerDefinition[];
  nextServers: readonly McpServerDefinition[];
  hasQuerySession: boolean;
}): {
  changed: boolean;
  shouldRestart: boolean;
  reason?: 'unchanged' | 'no-active-session' | 'fingerprint-changed';
} {
  const changed = mcpConfigFingerprint(params.previousServers) !== mcpConfigFingerprint(params.nextServers);
  if (!changed) return { changed: false, shouldRestart: false, reason: 'unchanged' };
  if (!params.hasQuerySession) return { changed: true, shouldRestart: false, reason: 'no-active-session' };
  return { changed: true, shouldRestart: true, reason: 'fingerprint-changed' };
}

export function shouldDeferLiveMcpMutation(params: {
  promotedItemInFlight: boolean;
  turnInFlight: boolean;
  sdkCommandInFlight: boolean;
  backgroundTasksActive?: boolean;
}): boolean {
  return params.promotedItemInFlight
    || params.turnInFlight
    || params.sdkCommandInFlight
    || params.backgroundTasksActive === true;
}

export function fingerprintSessionMcp(servers: readonly McpServerDefinition[]): string {
  return createHash('sha256').update(mcpConfigFingerprint(servers)).digest('hex');
}
