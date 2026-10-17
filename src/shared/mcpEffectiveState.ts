import type { RuntimeSource, RuntimeType } from './types/runtime';

export type McpEffectiveServerState =
  | 'disabled'
  | 'queued'
  | 'starting'
  | 'ready'
  | 'stopped'
  | 'needs_auth'
  | 'failed';

export type McpDispatchState = 'waiting' | 'released' | 'settled';

export interface McpEffectiveServerSnapshot {
  id: string;
  desired: boolean;
  state: McpEffectiveServerState;
  toolCount: number;
  /** Bounded product error code; never a raw command, URL, path, or secret. */
  errorCode?: string;
  attemptGeneration: number;
  updatedAt: number;
}

/**
 * Runtime-neutral, secret-free projection of the MCP capability that is
 * actually callable by one Product Session generation.
 */
export interface McpEffectiveSnapshot {
  sessionId: string;
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  runtimeGeneration: number;
  configGeneration: number;
  configFingerprint: string;
  catalogGeneration: number;
  revision: number;
  observedAt: number;
  browserHostGeneration?: number;
  dispatch: {
    state: McpDispatchState;
    releaseReason?: 'ready' | 'timeout' | 'terminal_status' | 'status_read_failed' | 'cancelled';
  };
  servers: McpEffectiveServerSnapshot[];
  /** Only tools proven callable in this exact catalog generation. */
  tools: string[];
  observationStale?: boolean;
}

/** Invalidate capabilities with an ordered envelope so SSE replay cannot resurrect them. */
export function invalidateMcpEffectiveSnapshot(snapshot: McpEffectiveSnapshot): McpEffectiveSnapshot {
  return {
    ...snapshot,
    catalogGeneration: snapshot.catalogGeneration + 1,
    revision: snapshot.revision + 1,
    observedAt: Date.now(),
    servers: [],
    tools: [],
    dispatch: { state: 'released', releaseReason: 'cancelled' },
    observationStale: true,
  };
}

function compareGeneration(
  left: Pick<McpEffectiveSnapshot, 'runtimeGeneration' | 'configGeneration' | 'catalogGeneration' | 'revision'>,
  right: Pick<McpEffectiveSnapshot, 'runtimeGeneration' | 'configGeneration' | 'catalogGeneration' | 'revision'>,
): number {
  if (left.runtimeGeneration !== right.runtimeGeneration) {
    return left.runtimeGeneration - right.runtimeGeneration;
  }
  if (left.configGeneration !== right.configGeneration) {
    return left.configGeneration - right.configGeneration;
  }
  if (left.catalogGeneration !== right.catalogGeneration) {
    return left.catalogGeneration - right.catalogGeneration;
  }
  return left.revision - right.revision;
}

/** Latest-generation-wins reducer used by TabProvider and deterministic tests. */
export function reduceMcpEffectiveSnapshot(
  current: McpEffectiveSnapshot | null,
  incoming: McpEffectiveSnapshot,
): McpEffectiveSnapshot | null {
  if (!current) return incoming;
  if (incoming.sessionId !== current.sessionId) return current;
  return compareGeneration(incoming, current) > 0 ? incoming : current;
}

export function readyMcpToolCount(snapshot: McpEffectiveSnapshot | null): number {
  if (!snapshot) return 0;
  return snapshot.servers.reduce(
    (total, server) => total + (server.desired && server.state === 'ready' ? server.toolCount : 0),
    0,
  );
}

export function mcpServerState(
  snapshot: McpEffectiveSnapshot | null,
  serverId: string,
): McpEffectiveServerSnapshot | null {
  return snapshot?.servers.find(server => server.id === serverId) ?? null;
}
