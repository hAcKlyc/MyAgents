import { describe, expect, it, vi } from 'vitest';

import { reasoningEffortAfterModelChange } from '../../../shared/reasoningEffort';
import { resolveAgentConfigMutation } from '../../../shared/agentConfigMutation';
import type { AgentConfig } from '../../../shared/types/agent';
import { persistInputOptionChange } from '../persistInputOption';

function makeMocks() {
  const patchProject = vi.fn().mockResolvedValue(undefined);
  const patchAgentConfig = vi.fn().mockResolvedValue(undefined);
  return {
    patchProject,
    patchAgentConfig,
    patchAgentProjectConfig: vi.fn(async (
      agentId: string,
      agentPatch: Record<string, unknown>,
      projectId: string,
      projectPatch: Record<string, unknown>,
    ) => {
      await patchAgentConfig(agentId, agentPatch);
      await patchProject(projectId, projectPatch);
    }),
    patchSnapshot: vi.fn().mockResolvedValue(undefined),
    pushMcpToSidecar: vi.fn().mockResolvedValue(undefined),
    pushRuntimeConfigToSidecar: vi.fn().mockResolvedValue(undefined),
    getAllMcpServers: vi.fn().mockResolvedValue([]),
    getGlobalMcpEnabled: vi.fn().mockResolvedValue([]),
  };
}

describe('persistInputOptionChange — disk write fanout', () => {
  it('writes provider+builtinModel to project, agent, and snapshot when builtin', async () => {
    const m = makeMocks();
    const res = await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { providerId: 'deepseek', builtinModel: 'deepseek-chat' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });

    expect(res.ok).toBe(true);
    expect(m.patchProject).toHaveBeenCalledWith('ws-1', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
    });
    // #300: a providerId change also clears the frozen providerEnvJson so the
    // sidecar re-resolves the env live from the new providerId (no stale creds).
    expect(m.patchSnapshot).toHaveBeenCalledWith({
      providerId: 'deepseek',
      providerRoute: null,
      providerExecutionIdentity: null,
      model: 'deepseek-chat',
      providerEnvJson: null,
    });
  });

  it('Session-only mode (Team AI) writes the snapshot and live push but no Project/Agent defaults', async () => {
    const m = makeMocks();
    const res = await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { providerId: 'deepseek', builtinModel: 'deepseek-chat', mcpEnabledServers: ['browser'] },
      defaultsWriteMode: 'disabled',
      snapshotWriteMode: 'required',
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
      pushMcpToSidecar: m.pushMcpToSidecar,
      getAllMcpServers: m.getAllMcpServers,
      getGlobalMcpEnabled: m.getGlobalMcpEnabled,
    });

    expect(res.ok).toBe(true);
    expect(m.patchSnapshot).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-chat', mcpEnabledServers: ['browser'] }));
    expect(m.patchProject).not.toHaveBeenCalled();
    expect(m.patchAgentConfig).not.toHaveBeenCalled();
    expect(m.patchAgentProjectConfig).not.toHaveBeenCalled();
    expect(m.pushMcpToSidecar).toHaveBeenCalled();
  });

  it('required snapshot mode stops before project/agent writes when the session snapshot fails', async () => {
    const m = makeMocks();
    m.patchSnapshot.mockRejectedValue(new Error('session not materialized'));

    const res = await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { permissionMode: 'plan' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
      snapshotWriteMode: 'required',
    });

    expect(res.ok).toBe(false);
    expect(res.snapshotWriteFailed).toBe(true);
    expect(res.errors[0]).toContain('session snapshot: session not materialized');
    expect(m.patchProject).not.toHaveBeenCalled();
    expect(m.patchAgentConfig).not.toHaveBeenCalled();
  });

  it('optional snapshot mode keeps launcher-style project/agent writes after snapshot failure', async () => {
    const m = makeMocks();
    m.patchSnapshot.mockRejectedValue(new Error('snapshot unavailable'));

    const res = await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { permissionMode: 'plan' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });

    expect(res.ok).toBe(false);
    expect(res.snapshotWriteFailed).toBe(true);
    expect(m.patchProject).toHaveBeenCalledWith('ws-1', { permissionMode: 'plan' });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', { permissionMode: 'plan' });
  });

  it('#300: clears snapshot providerEnvJson when providerId changes', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      // Switching to skywork-ai: the old session's frozen deepseek env must not
      // survive under the new providerId (the inconsistency behind the 402 bug).
      fields: { providerId: 'skywork-ai', builtinModel: 'skywork-ai/skyclaw-v1' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({
      providerId: 'skywork-ai',
      providerRoute: null,
      providerExecutionIdentity: null,
      model: 'skywork-ai/skyclaw-v1',
      providerEnvJson: null,
    });
  });

  it('#401: writes provider-scoped builtinSelection atomically as providerRoute', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: {
        builtinSelection: { providerId: 'zhipu', model: 'glm-4.7-air' },
        builtinProviderEnvPolicy: 'preserve-provider-env',
        permissionMode: 'fullAgency',
      },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });

    expect(m.patchProject).toHaveBeenCalledWith('ws-1', {
      providerId: 'zhipu',
      model: 'glm-4.7-air',
      permissionMode: 'fullAgency',
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      providerId: 'zhipu',
      model: 'glm-4.7-air',
      permissionMode: 'fullAgency',
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({
      providerId: 'zhipu',
      providerRoute: { kind: 'provider', providerId: 'zhipu', model: 'glm-4.7-air' },
      providerExecutionIdentity: null,
      model: 'glm-4.7-air',
      permissionMode: 'fullAgency',
      providerEnvJson: null,
    });
  });

  it('#401: clears providerEnvJson when builtin selection writes a concrete route', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: {
        builtinSelection: { providerId: 'deepseek', model: 'deepseek-v4-pro' },
        builtinProviderEnvPolicy: 'clear-stale-provider-env',
      },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });

    expect(m.patchSnapshot).toHaveBeenCalledWith({
      providerId: 'deepseek',
      providerRoute: { kind: 'provider', providerId: 'deepseek', model: 'deepseek-v4-pro' },
      providerExecutionIdentity: null,
      model: 'deepseek-v4-pro',
      providerEnvJson: null,
    });
  });

  it('writes Anthropic subscription selection as subscription route', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: {
        builtinSelection: { providerId: 'anthropic-sub', model: 'claude-sonnet-4-6' },
      },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });

    expect(m.patchSnapshot).toHaveBeenCalledWith({
      providerId: 'anthropic-sub',
      providerRoute: { kind: 'subscription', providerId: 'anthropic-sub', model: 'claude-sonnet-4-6' },
      providerExecutionIdentity: null,
      model: 'claude-sonnet-4-6',
      providerEnvJson: null,
    });
  });

  it('writes runtime-backed provider selection without switching the agent to legacy Codex runtime', async () => {
    const m = makeMocks();
    const identity = {
      kind: 'runtime-backed-provider' as const,
      providerId: 'codex-sub' as const,
      runtime: 'codex' as const,
      runtimeSource: 'managed-provider' as const,
      model: 'gpt-5.4-codex',
    };

    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: {
        runtimeBackedProviderSelection: identity,
        permissionMode: 'fullAgency',
      },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
      pushRuntimeConfigToSidecar: m.pushRuntimeConfigToSidecar,
    });

    expect(m.patchProject).toHaveBeenCalledWith('ws-1', {
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      runtimeBackedProviderSelection: identity,
      permissionMode: 'fullAgency',
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({
      providerId: 'codex-sub',
      providerRoute: null,
      providerExecutionIdentity: identity,
      model: 'gpt-5.4-codex',
      providerEnvJson: null,
      permissionMode: 'no-restrictions',
    });
    expect(m.pushRuntimeConfigToSidecar).toHaveBeenCalledWith({
      model: 'gpt-5.4-codex',
      permissionMode: 'no-restrictions',
    });
  });

  it('keeps managed codex as a provider default when selected from the builtin provider picker', async () => {
    const m = makeMocks();
    const identity = {
      kind: 'runtime-backed-provider' as const,
      providerId: 'codex-sub' as const,
      runtime: 'codex' as const,
      runtimeSource: 'managed-provider' as const,
      model: 'gpt-5.4-codex',
    };

    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: {
        runtimeBackedProviderSelection: identity,
        permissionMode: 'plan',
      },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });

    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      runtimeBackedProviderSelection: identity,
      permissionMode: 'plan',
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'suggest',
    }));
  });

  it('clears stale managed Codex runtime projection when switching back to an ordinary provider', async () => {
    const m = makeMocks();

    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: {
        builtinSelection: { providerId: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
      },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });

    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
    });
  });

  it('preserves DSH as the base Integrated Runtime when leaving Managed Codex', async () => {
    const m = makeMocks();

    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: {
        builtinSelection: { providerId: 'zhipu', model: 'glm-5.3' },
      },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });

    const intent = m.patchAgentConfig.mock.calls[0][1];
    expect(intent).toEqual({
      providerId: 'zhipu',
      model: 'glm-5.3',
    });
    const resolved = resolveAgentConfigMutation({
      id: 'agent-1', providerId: 'codex-sub', runtime: 'builtin', runtimePreference: { family: 'integrated', id: 'dsh' },
      runtimeConfig: { source: 'managed-provider', model: 'gpt-5.5-codex', envPolicy: { proxy: 'terminal' } },
    } as AgentConfig, intent);
    expect(resolved.runtime).toBe('dsh');
    expect(resolved.runtimeConfig).toEqual({ envPolicy: { proxy: 'terminal' } });
  });

  it('writes ordinary provider fields as builtin defaults even when the current session is managed Codex', async () => {
    const m = makeMocks();

    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: {
        builtinSelection: { providerId: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
        permissionMode: 'full-auto',
      },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });

    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      permissionMode: 'full-auto',
    });
  });

  it('#300 legacy loose field: does NOT touch providerEnvJson on a model-only change', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { builtinModel: 'deepseek-v4-pro' }, // no providerId → provider unchanged
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });
    const snapshotArg = m.patchSnapshot.mock.calls[0][0];
    expect(snapshotArg).toEqual({ model: 'deepseek-v4-pro' });
    expect('providerEnvJson' in snapshotArg).toBe(false);
  });

  it('writes builtin permission to agent.permissionMode (NOT runtimeConfig)', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { permissionMode: 'plan' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      permissionMode: 'plan',
    });
    expect(m.patchProject).toHaveBeenCalledWith('ws-1', {
      permissionMode: 'plan',
    });
  });

  it('writes external permission to agent.runtimeConfig (NOT permissionMode)', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: { permissionMode: 'plan' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
    });

    // Project does NOT get permissionMode for external runtimes.
    expect(m.patchProject).not.toHaveBeenCalled();
    // Agent gets it nested in runtimeConfig, with existing keys preserved.
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      runtimeConfigPatch: { permissionMode: 'plan' },
    });
  });

  it('writes external permission to session snapshot', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: { permissionMode: 'full-auto' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });

    expect(m.patchSnapshot).toHaveBeenCalledWith({ permissionMode: 'full-auto' });
  });

  it('writes runtimeModel to agent.runtimeConfig.model when external', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: { runtimeModel: 'sonnet' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
    });
    // Project doesn't track runtimeModel — only the agent does.
    expect(m.patchProject).not.toHaveBeenCalled();
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      runtimeConfigPatch: { model: 'sonnet' },
    });
  });

  it('writes runtimeModel to session snapshot when external (cross-review fix)', async () => {
    // Regression check: the helper used to skip snapshot.model for external
    // runtimes entirely, dropping `handleRuntimeModelChange`'s update on the
    // floor. Cross-review (CC perspective) caught this; the fix routes
    // runtimeModel into snapshot.model when isExternalRuntime is true.
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: { runtimeModel: 'sonnet' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({ model: 'sonnet' });
  });

  it('does NOT write builtinModel to snapshot when on external runtime', async () => {
    // Symmetric guard: a stale builtinModel sneaking through (e.g. caller
    // passes both fields by accident) must not pollute snapshot.model.
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: { builtinModel: 'deepseek-chat', runtimeModel: 'sonnet' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({ model: 'sonnet' });
  });

  it('writes mcpEnabledServers to project + agent + snapshot', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { mcpEnabledServers: ['playwright', 'im-cron'] },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });
    expect(m.patchProject).toHaveBeenCalledWith('ws-1', {
      mcpEnabledServers: ['playwright', 'im-cron'],
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      mcpEnabledServers: ['playwright', 'im-cron'],
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({
      mcpEnabledServers: ['playwright', 'im-cron'],
    });
  });

  it('writes Claude plugin enabled ids to project + agent + snapshot', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { enabledPluginIds: ['planner@local', 'reviewer@local'] },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });
    expect(m.patchProject).toHaveBeenCalledWith('ws-1', {
      enabledPluginIds: ['planner@local', 'reviewer@local'],
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      enabledPluginIds: ['planner@local', 'reviewer@local'],
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({
      enabledPluginIds: ['planner@local', 'reviewer@local'],
    });
  });

  it('skips snapshot write when patchSnapshot is omitted (launcher mode)', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { providerId: 'p1' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      // no patchSnapshot
    });
    // patchSnapshot was never wired, so calling it counts as 0.
    expect(m.patchSnapshot).not.toHaveBeenCalled();
  });

  it('skips agent write when agentId is null', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: null,
      isExternalRuntime: false,
      fields: { providerId: 'p1' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
    });
    expect(m.patchProject).toHaveBeenCalled();
    expect(m.patchAgentConfig).not.toHaveBeenCalled();
  });

  it('returns ok=false with error string when a writer throws', async () => {
    const m = makeMocks();
    m.patchProject.mockRejectedValueOnce(new Error('disk full'));
    const res = await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { providerId: 'p1' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
    });
    expect(res.ok).toBe(false);
    expect(res.snapshotWriteFailed).toBe(false);
    expect(res.errors[0]).toContain('disk full');
    // Other writers still run — failure isolated.
    expect(m.patchAgentConfig).toHaveBeenCalled();
  });

  it('pushes resolved MCP set to sidecar when wired', async () => {
    const m = makeMocks();
    m.getAllMcpServers.mockResolvedValueOnce([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ]);
    m.getGlobalMcpEnabled.mockResolvedValueOnce(['a', 'b']);

    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { mcpEnabledServers: ['a', 'c'] },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      pushMcpToSidecar: m.pushMcpToSidecar,
      getAllMcpServers: m.getAllMcpServers,
      getGlobalMcpEnabled: m.getGlobalMcpEnabled,
    });
    // Only 'a' is in BOTH workspace-enabled (a,c) AND global-enabled (a,b).
    expect(m.pushMcpToSidecar).toHaveBeenCalledWith([{ id: 'a', name: 'A' }]);
  });

  it('does NOT push to sidecar in launcher mode (no pushMcpToSidecar wired)', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { mcpEnabledServers: ['a'] },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      // no sidecar push trio
    });
    expect(m.pushMcpToSidecar).not.toHaveBeenCalled();
  });

  it('pushes external runtime model and permission changes to sidecar when wired', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: { runtimeModel: 'gpt-5.2-codex', permissionMode: 'no-restrictions' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      pushRuntimeConfigToSidecar: m.pushRuntimeConfigToSidecar,
    });
    expect(m.pushRuntimeConfigToSidecar).toHaveBeenCalledWith({
      model: 'gpt-5.2-codex',
      permissionMode: 'no-restrictions',
    });
  });

  it('keeps DSH Provider fields product-owned while pushing the live runtime config', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      usesProductConfiguration: true,
      fields: {
        builtinSelection: { providerId: 'deepseek', model: 'deepseek-v4-flash' },
        permissionMode: 'fullAgency',
        reasoningEffort: 'high',
      },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
      pushRuntimeConfigToSidecar: m.pushRuntimeConfigToSidecar,
    });

    expect(m.patchProject).toHaveBeenCalledWith('ws-1', {
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      permissionMode: 'fullAgency',
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      permissionMode: 'fullAgency',
      reasoningEffort: 'high',
    });
    expect(m.pushRuntimeConfigToSidecar).toHaveBeenCalledWith({
      model: 'deepseek-v4-flash',
      permissionMode: 'fullAgency',
      reasoningEffort: 'high',
    });
  });

  it('does not push runtime config for builtin changes', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { builtinModel: 'claude-sonnet-4-6', permissionMode: 'auto' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      pushRuntimeConfigToSidecar: m.pushRuntimeConfigToSidecar,
    });
    expect(m.pushRuntimeConfigToSidecar).not.toHaveBeenCalled();
  });
});

describe('persistInputOptionChange — reasoning effort routing (#324)', () => {
  it('pushes model and default together for A/ultra → B/default → A/default', async () => {
    const m = makeMocks();
    let effort = 'ultra';
    const targets = [
      { value: 'model-b', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      { value: 'model-a', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] },
    ];
    for (const target of targets) {
      effort = reasoningEffortAfterModelChange(effort, target);
      await persistInputOptionChange({
        workspaceId: 'ws', agentId: 'agent', isExternalRuntime: true,
        fields: { runtimeBackedProviderSelection: { kind: 'runtime-backed-provider', providerId: 'codex-sub', runtime: 'codex', runtimeSource: 'managed-provider', model: target.value }, reasoningEffort: effort },
        patchProject: m.patchProject, patchAgentConfig: m.patchAgentConfig, patchAgentProjectConfig: m.patchAgentProjectConfig,
        patchSnapshot: m.patchSnapshot, pushRuntimeConfigToSidecar: m.pushRuntimeConfigToSidecar,
      });
    }
    expect(m.pushRuntimeConfigToSidecar.mock.calls.map(([patch]) => patch)).toEqual([
      { model: 'model-b', reasoningEffort: 'default' },
      { model: 'model-a', reasoningEffort: 'default' },
    ]);
    expect(m.patchSnapshot.mock.calls.map(([patch]) => patch.reasoningEffort)).toEqual(['default', 'default']);
    expect(m.patchAgentConfig).toHaveBeenLastCalledWith('agent', expect.objectContaining({ reasoningEffort: 'default' }));
  });

  it('builtin: writes agent.reasoningEffort + snapshot.reasoningEffort, never the project', async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { reasoningEffort: 'max' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', { reasoningEffort: 'max' });
    expect(m.patchSnapshot).toHaveBeenCalledWith({ reasoningEffort: 'max' });
    // No project-level storage for effort — the agent is the only default source.
    expect(m.patchProject).not.toHaveBeenCalled();
  });

  it.each(['xhigh', 'ultra', 'future-tier'])('external: persists %s in agent and Session without an enum gate', async (effort) => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: true,
      fields: { reasoningEffort: effort },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', {
      runtimeConfigPatch: { reasoningEffort: effort },
    });
    expect(m.patchSnapshot).toHaveBeenCalledWith({ reasoningEffort: effort });
  });

  it("persists the literal 'default' (a session can pin back to default over a non-default agent value)", async () => {
    const m = makeMocks();
    await persistInputOptionChange({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      isExternalRuntime: false,
      fields: { reasoningEffort: 'default' },
      patchProject: m.patchProject,
      patchAgentConfig: m.patchAgentConfig,
      patchAgentProjectConfig: m.patchAgentProjectConfig,
      patchSnapshot: m.patchSnapshot,
    });
    expect(m.patchAgentConfig).toHaveBeenCalledWith('agent-1', { reasoningEffort: 'default' });
    expect(m.patchSnapshot).toHaveBeenCalledWith({ reasoningEffort: 'default' });
  });
});
