import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '../../shared/types/agent';
import { IMAGE_UNDERSTANDING_TOOL_ID } from '../../shared/official-tools';
import {
  bindOwnedSnapshotToRuntimeIdentity,
  createMaterializedSessionMetadata,
  isLiveFollowScenario,
} from './session-materialization';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Agent',
    enabled: true,
    permissionMode: 'fullAgency',
    model: 'claude-sonnet-4-6',
    mcpEnabledServers: ['fs'],
    channels: [],
    runtime: 'codex',
    runtimeConfig: {
      model: 'gpt-5.1-codex',
      permissionMode: 'full-auto',
    },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('createMaterializedSessionMetadata', () => {
  describe.each([
    ['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64'],
  ] as const)('DSH on %s-%s', (platform, arch) => {
    it.each(['desktop', 'cron', 'im', 'agent-channel', 'registeredAgent'] as const)(
      'freezes the accepted platform for %s births', (scenario) => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
        vi.spyOn(process, 'arch', 'get').mockReturnValue(arch);
        const meta = createMaterializedSessionMetadata({
          agentDir: '/tmp/workspace', sessionId: 'dsh-platform', scenario,
          agent: makeAgent({ runtime: 'dsh', providerId: 'deepseek', model: 'deepseek-flash' }),
        });
        expect(meta.runtimeBinding).toMatchObject({
          family: 'integrated', id: 'dsh', platformTarget: `${platform}-${arch}`,
        });
        expect(meta.runtimeSource).toBe('integrated');
        if (scenario !== 'registeredAgent') expect(meta.providerId).toBe('deepseek');
      },
    );

    it('uses the same platform for fallback births and Task identity rebinding', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      vi.spyOn(process, 'arch', 'get').mockReturnValue(arch);
      const fallback = createMaterializedSessionMetadata({
        agentDir: '/tmp/workspace', sessionId: 'dsh-fallback', scenario: 'desktop', fallbackRuntime: 'dsh',
      });
      const rebound = bindOwnedSnapshotToRuntimeIdentity({ runtime: 'builtin' }, { runtime: 'dsh' });
      expect(fallback.runtimeBinding).toMatchObject({ platformTarget: `${platform}-${arch}` });
      expect(rebound.runtimeBinding).toEqual(fallback.runtimeBinding);
    });
  });

  it('materializes DSH with an authoritative binding while retaining ordinary Provider facts', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'dsh-session-id',
      scenario: 'desktop',
      agent: makeAgent({
        runtime: 'dsh',
        providerId: 'anthropic-api',
        model: 'claude-sonnet-4-6',
        permissionMode: 'plan',
      }),
      runtimeOverride: 'dsh',
      runtimeSourceOverride: 'integrated',
    });

    expect(meta.runtime).toBe('dsh');
    expect(meta.runtimeSource).toBe('integrated');
    expect(meta.runtimeBinding).toMatchObject({ family: 'integrated', id: 'dsh' });
    expect(meta.providerRoute).toEqual({
      kind: 'provider',
      providerId: 'anthropic-api',
      model: 'claude-sonnet-4-6',
    });
    expect(meta.permissionMode).toBe('plan');
  });

  it('binds owned metadata to the live Sidecar identity after Agent config drifts', () => {
    const staleAgentSnapshot = {
      runtime: 'builtin' as const,
      model: 'claude-sonnet-4-6',
    };

    expect(bindOwnedSnapshotToRuntimeIdentity(staleAgentSnapshot, {
      runtime: 'codex',
      runtimeSource: 'managed-provider',
    })).toMatchObject({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
    });
  });

  it('materializes published IM reset ids as complete owned sessions', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'fixed-session-id',
      scenario: 'agent-channel',
      agent: makeAgent(),
    });

    expect(meta.id).toBe('fixed-session-id');
    expect(meta.title).toBe('New Chat');
    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBe('gpt-5.1-codex');
    expect(meta.permissionMode).toBe('no-restrictions');
    expect(meta.configSnapshotAt).toBeTruthy();
    expect(meta.origin).toEqual({ kind: 'agent-channel', surface: 'channel_message' });
  });

  it('keeps desktop materialization owned and self-contained', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'desktop-session-id',
      scenario: 'desktop',
      agent: makeAgent({ enabledPluginIds: ['planner@local'] }),
      title: 'First prompt',
    });

    expect(meta.id).toBe('desktop-session-id');
    expect(meta.title).toBe('First prompt');
    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBe('gpt-5.1-codex');
    expect(meta.permissionMode).toBe('full-auto');
    expect(meta.enabledPluginIds).toEqual(['planner@local']);
    expect(meta.configSnapshotAt).toBeTruthy();
  });

  it('materializes a runtime switch using the target runtime snapshot view', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'runtime-switch-session-id',
      scenario: 'desktop',
      agent: makeAgent({
        runtime: 'builtin',
        model: 'claude-opus-4-7',
        permissionMode: 'fullAgency',
        runtimeConfig: {
          model: 'claude-sonnet-4-5',
          permissionMode: 'bypassPermissions',
        },
      }),
      runtimeOverride: 'codex',
    });

    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBeUndefined();
    expect(meta.permissionMode).toBeUndefined();
    expect(meta.configSnapshotAt).toBeTruthy();
  });

  it('uses the active runtime fallback when no agent config is available', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/unregistered-workspace',
      sessionId: 'external-reset-session-id',
      scenario: 'agent-channel',
      fallbackRuntime: 'codex',
    });

    expect(meta.id).toBe('external-reset-session-id');
    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBeUndefined();
  });

  it('persists an explicit birth origin when the caller owns the surface fact', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'launcher-session-id',
      scenario: 'desktop',
      agent: makeAgent(),
      origin: { kind: 'desktop', surface: 'launcher_input' },
    });

    expect(meta.origin).toEqual({ kind: 'desktop', surface: 'launcher_input' });
  });

  it('materializes owned managed Codex as provider-backed runtime identity', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'managed-codex-session-id',
      scenario: 'agent-channel',
      agent: makeAgent({
        providerId: 'codex-sub',
        model: 'gpt-5.4-codex',
        runtime: 'builtin',
        runtimeConfig: { source: 'system-cli' },
      }),
      runtimeOverride: 'codex',
      runtimeSourceOverride: 'managed-provider',
      managedCodexProviderReady: true,
    });

    expect(meta.runtime).toBe('codex');
    expect(meta.runtimeSource).toBe('managed-provider');
    expect(meta.model).toBe('gpt-5.4-codex');
    expect(meta.providerExecutionIdentity).toMatchObject({ providerId: 'codex-sub', model: 'gpt-5.4-codex' });
    expect(meta.configSnapshotAt).toBeTruthy();
  });

  it('only classifies registeredAgent as live-follow', () => {
    expect(isLiveFollowScenario('im')).toBe(false);
    expect(isLiveFollowScenario('agent-channel')).toBe(false);
    expect(isLiveFollowScenario('registeredAgent')).toBe(true);
    expect(isLiveFollowScenario('desktop')).toBe(false);
    expect(isLiveFollowScenario('cron')).toBe(false);
  });

  it('materializes registeredAgent sessions as live-follow sessions', () => {
    const meta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'registered-agent-session-id',
      scenario: 'registeredAgent',
      agent: makeAgent(),
      title: 'Issue title must not own this session',
    });

    expect(meta.id).toBe('registered-agent-session-id');
    expect(meta.runtime).toBe('codex');
    expect(meta.model).toBeUndefined();
    expect(meta.permissionMode).toBeUndefined();
    expect(meta.configSnapshotAt).toBeUndefined();
    expect(meta.title).toBe('Agent');
  });

  it('applies one-shot birthOverrides to SessionMetadata without mutating the source AgentConfig', () => {
    const sourceAgent = makeAgent({
      runtime: 'antigravity',
      providerId: 'codex-sub',
      model: 'claude-opus-4-7',
      permissionMode: 'fullAgency',
      mcpEnabledServers: ['playwright'],
      enabledPluginIds: ['my-plugin@local'],
      enabledOfficialToolIds: [IMAGE_UNDERSTANDING_TOOL_ID],
      runtimeConfig: {
        source: 'system-cli',
        model: 'gemini-4-neon',
        permissionMode: 'dangerously-skip-permissions',
      },
    });
    const beforeSnapshot = JSON.stringify(sourceAgent);

    const dshMeta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'dsh-override-session',
      scenario: 'desktop',
      agent: sourceAgent,
      runtimeOverride: 'dsh',
      runtimeSourceOverride: 'integrated',
      birthOverrides: {
        runtime: 'dsh',
        runtimeSource: 'integrated',
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
        permissionMode: 'full-autonomous',
      },
    });

    expect(dshMeta.runtime).toBe('dsh');
    expect(dshMeta.runtimeSource).toBe('integrated');
    expect(dshMeta.providerId).toBe('deepseek');
    expect(dshMeta.model).toBe('deepseek-v4-pro');
    expect(dshMeta.providerRoute).toMatchObject({ providerId: 'deepseek', model: 'deepseek-v4-pro' });
    expect(dshMeta.reasoningEffort).toBe('high');
    expect(dshMeta.permissionMode).toBe('full-autonomous');
    expect(dshMeta.mcpEnabledServers).toEqual(['playwright']);
    expect(dshMeta.enabledPluginIds).toEqual(['my-plugin@local']);
    expect(dshMeta.enabledOfficialToolIds).toEqual([IMAGE_UNDERSTANDING_TOOL_ID]);
    expect(dshMeta.configSnapshotAt).toBeTruthy();
    expect(JSON.stringify(sourceAgent)).toBe(beforeSnapshot);

    const codexMeta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'codex-override-session',
      scenario: 'desktop',
      agent: sourceAgent,
      runtimeOverride: 'codex',
      runtimeSourceOverride: 'system-cli',
      birthOverrides: {
        runtime: 'codex',
        runtimeSource: 'system-cli',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        permissionMode: 'no-restrictions',
      },
    });

    expect(codexMeta.runtime).toBe('codex');
    expect(codexMeta.runtimeSource).toBe('system-cli');
    expect(codexMeta.providerId).toBeUndefined();
    expect(codexMeta.providerRoute).toBeUndefined();
    expect(codexMeta.model).toBe('gpt-5.5');
    expect(codexMeta.reasoningEffort).toBe('high');
    expect(codexMeta.permissionMode).toBe('no-restrictions');
    expect(codexMeta.mcpEnabledServers).toEqual(['playwright']);
    expect(JSON.stringify(sourceAgent)).toBe(beforeSnapshot);
  });

  it('scrubs stale reasoningEffort and dormant model when birthOverrides switches runtimes without specifying them', () => {
    const builtinAgent = makeAgent({
      runtime: 'builtin',
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      permissionMode: 'fullAgency',
      runtimeConfig: { reasoningEffort: 'xhigh' },
    });

    const dshMeta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'dsh-no-effort-leak',
      scenario: 'desktop',
      agent: builtinAgent,
      runtimeOverride: 'dsh',
      runtimeSourceOverride: 'integrated',
      birthOverrides: {
        runtime: 'dsh',
        runtimeSource: 'integrated',
        providerId: 'deepseek',
        model: 'deepseek-v4-pro',
        permissionMode: 'full-autonomous',
      },
    });
    expect(dshMeta.reasoningEffort).toBeUndefined();

    const managedCodexMeta = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'managed-codex-no-effort-leak',
      scenario: 'desktop',
      agent: builtinAgent,
      runtimeOverride: 'codex',
      runtimeSourceOverride: 'managed-provider',
      managedCodexProviderReady: true,
      birthOverrides: {
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        providerId: 'codex-sub',
        model: 'gpt-5.5',
        permissionMode: 'no-restrictions',
      },
    });
    expect(managedCodexMeta.reasoningEffort).toBeUndefined();
    expect(managedCodexMeta.permissionMode).toBe('no-restrictions');

    const externalAgentWithDormantModel = makeAgent({
      runtime: 'antigravity',
      providerId: 'custom-p',
      model: 'stale-dormant-model',
      reasoningEffort: 'high',
      runtimeConfig: { source: 'system-cli', model: 'gemini-4-neon', permissionMode: 'dangerously-skip-permissions' },
    });
    const switchedToBuiltin = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'builtin-no-dormant-leak',
      scenario: 'desktop',
      agent: externalAgentWithDormantModel,
      runtimeOverride: 'builtin',
      birthOverrides: {
        runtime: 'builtin',
        providerId: 'custom-p',
        permissionMode: 'fullAgency',
      },
    });
    expect(switchedToBuiltin.model).toBeUndefined();
    expect(switchedToBuiltin.reasoningEffort).toBeUndefined();

    // Implicit defaultIntegratedRuntime='dsh' Agent (agent.runtime undefined) switching to builtin
    // must treat the switch as a cross-runtime switch and scrub DSH reasoningEffort & providerEnvJson.
    const implicitDshAgent = makeAgent({
      runtime: undefined,
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      providerEnvJson: '{"ANTHROPIC_BASE_URL":"https://api.deepseek.com"}',
    });
    const switchedFromImplicitDsh = createMaterializedSessionMetadata({
      agentDir: '/tmp/workspace',
      sessionId: 'implicit-dsh-to-builtin',
      scenario: 'desktop',
      agent: implicitDshAgent,
      runtimePolicy: { defaultIntegratedRuntime: 'dsh' },
      runtimeOverride: 'builtin',
      birthOverrides: {
        runtime: 'builtin',
        providerId: 'xai-sub',
        model: 'grok-4.3',
        permissionMode: 'fullAgency',
      },
    });
    expect(switchedFromImplicitDsh.runtime).toBe('builtin');
    expect(switchedFromImplicitDsh.providerId).toBe('xai-sub');
    expect(switchedFromImplicitDsh.model).toBe('grok-4.3');
    expect(switchedFromImplicitDsh.reasoningEffort).toBeUndefined();
    expect(switchedFromImplicitDsh.providerEnvJson).toBeUndefined();
  });
});
