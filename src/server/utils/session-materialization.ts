import type { AgentConfig } from '../../shared/types/agent';
import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import type { SessionBirthOverrides } from '../../shared/sessionPermissionCeiling';
import { originFromMaterializationScenario } from '../../shared/session-origin';
import type { SessionOrigin } from '../../shared/session-origin';
import { createSessionMetadata, type SessionMetadata } from '../types/session';
import { snapshotForImSession, snapshotForOwnedSession, snapshotForRegisteredAgentSession, snapshotRuntimeIdentity } from './session-snapshot';

export type SessionMaterializationScenario = 'desktop' | 'cron' | 'im' | 'agent-channel' | 'registeredAgent';

export function isLiveFollowScenario(scenario: SessionMaterializationScenario): boolean {
  return scenario === 'registeredAgent';
}

export function snapshotForMaterializedSession(
  agent: AgentConfig,
  scenario: SessionMaterializationScenario,
  options?: {
    runtimePolicy?: { defaultIntegratedRuntime?: unknown };
    runtimeOverride?: RuntimeType;
    runtimeSourceOverride?: RuntimeSource;
    managedCodexProviderReady?: boolean;
    birthOverrides?: SessionBirthOverrides;
  },
): Partial<SessionMetadata> {
  if (scenario === 'registeredAgent') return snapshotForRegisteredAgentSession(agent, options);
  if (scenario === 'im' || scenario === 'agent-channel') return snapshotForImSession(agent, options);
  return snapshotForOwnedSession(agent, options);
}

export function bindOwnedSnapshotToRuntimeIdentity(
  snapshot: Partial<SessionMetadata>,
  identity: { runtime: RuntimeType; runtimeSource?: RuntimeSource },
): Partial<SessionMetadata> {
  return {
    ...snapshot,
    ...snapshotRuntimeIdentity(identity.runtime, identity.runtimeSource),
  };
}

export function createMaterializedSessionMetadata(params: {
  agentDir: string;
  sessionId: string;
  scenario: SessionMaterializationScenario;
  agent?: AgentConfig;
  runtimePolicy?: { defaultIntegratedRuntime?: unknown };
  runtimeOverride?: RuntimeType;
  runtimeSourceOverride?: RuntimeSource;
  managedCodexProviderReady?: boolean;
  birthOverrides?: SessionBirthOverrides;
  fallbackRuntime?: RuntimeType;
  title?: string;
  origin?: SessionOrigin;
}): SessionMetadata {
  const snapshot = params.agent
    ? snapshotForMaterializedSession(params.agent, params.scenario, {
        runtimePolicy: params.runtimePolicy,
        runtimeOverride: params.runtimeOverride,
        runtimeSourceOverride: params.runtimeSourceOverride,
        managedCodexProviderReady: params.managedCodexProviderReady,
        birthOverrides: params.birthOverrides,
      })
    : undefined;
  const fallbackRuntime = params.runtimeOverride ?? params.fallbackRuntime;
  const fallbackSnapshot = !params.agent && fallbackRuntime
    ? snapshotRuntimeIdentity(fallbackRuntime, params.runtimeSourceOverride)
    : undefined;
  const meta = createSessionMetadata(params.agentDir, snapshot ?? fallbackSnapshot);
  meta.id = params.sessionId;
  meta.title = params.scenario === 'registeredAgent'
    ? (params.agent?.name.trim() || 'New Chat')
    : (params.title ?? 'New Chat');
  meta.origin = params.origin ?? originFromMaterializationScenario(params.scenario);
  return meta;
}
