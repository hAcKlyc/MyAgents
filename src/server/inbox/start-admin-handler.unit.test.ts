import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancellableFetch: vi.fn(),
  resolvePersistedAgentWorkspaceRegistry: vi.fn(),
  agentWorkspaceIdentityFailure: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  })),
  getSessionMetadata: vi.fn(),
  getAllEffectiveProviders: vi.fn(),
  getProviderSelectionError: vi.fn(),
  isManagedCodexProviderReady: vi.fn(),
  detectRuntimeInstallation: vi.fn(),
  queryRuntimeModels: vi.fn(),
}));

vi.mock('../utils/cancellation', () => ({ cancellableFetch: mocks.cancellableFetch }));
vi.mock('../utils/agent-workspace-identity', () => ({
  resolvePersistedAgentWorkspaceRegistry: mocks.resolvePersistedAgentWorkspaceRegistry,
  agentWorkspaceIdentityFailure: mocks.agentWorkspaceIdentityFailure,
}));
vi.mock('../SessionStore', () => ({ getSessionMetadata: mocks.getSessionMetadata }));
vi.mock('../utils/admin-config', () => ({
  getAllEffectiveProviders: mocks.getAllEffectiveProviders,
  getProviderSelectionError: mocks.getProviderSelectionError,
}));
vi.mock('../utils/managed-codex-readiness', () => ({
  isManagedCodexProviderReady: mocks.isManagedCodexProviderReady,
}));
vi.mock('../session-engine/runtime-inspection', () => ({
  detectRuntimeInstallation: mocks.detectRuntimeInstallation,
  queryRuntimeModels: mocks.queryRuntimeModels,
}));

import { handleAdminSessionStart } from './start-admin-handler';

function registry(options: {
  archived?: boolean;
  agent?: Record<string, unknown>;
  project?: Record<string, unknown>;
  config?: Record<string, unknown>;
} = {}) {
  const identity = {
    agentId: 'agent-1',
    workspacePath: '/target/workspace',
    agent: {
      id: 'agent-1',
      name: 'Target',
      enabled: false,
      runtime: 'builtin',
      permissionMode: 'auto',
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      ...(options.agent ?? {}),
    },
    projectId: 'project-1',
    association: 'project-linked',
    canMutateProjectLifecycle: true,
    project: {
      id: 'project-1',
      name: 'Target',
      path: '/target/workspace',
      agentId: 'agent-1',
      ...(options.archived ? { archivedAt: '2026-08-01T00:00:00.000Z' } : {}),
      ...(options.project ?? {}),
    },
  };
  return {
    config: {
      defaultProviderId: 'deepseek',
      defaultPermissionMode: 'auto',
      ...(options.config ?? {}),
    },
    identities: [identity],
    agentProjections: [identity],
    diagnostics: [],
  };
}

function acceptedFetchResponse(replyBack = true) {
  return new Response(JSON.stringify({
    ok: true,
    outcome: {
      status: 'accepted',
      agentId: 'agent-1',
      sessionId: 'fresh-session',
      messageId: 'message-1',
      replyBack,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('handleAdminSessionStart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MYAGENTS_MANAGEMENT_PORT = '43123';
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry());
    mocks.getSessionMetadata.mockReturnValue({ title: 'Source chat', agentDir: '/source' });
    mocks.getAllEffectiveProviders.mockReturnValue([
      {
        id: 'deepseek',
        type: 'api',
        apiProtocol: 'anthropic',
        enabled: true,
        primaryModel: 'deepseek-v4-pro',
        models: [{ model: 'deepseek-v4-pro' }, { model: 'deepseek-flash' }],
        config: { baseUrl: 'https://api.deepseek.com/anthropic' },
      },
      {
        id: 'anthropic-sub',
        type: 'subscription',
        subscriptionAuth: 'sdk-native',
        apiProtocol: 'anthropic',
        enabled: true,
        primaryModel: 'claude-opus-5-5',
        models: [{ model: 'claude-opus-5-5' }, { model: 'claude-sonnet-5-5' }],
        config: {},
      },
      {
        id: 'openai-compat',
        type: 'api',
        apiProtocol: 'openai',
        enabled: true,
        primaryModel: 'gpt-5.4',
        models: [{ model: 'gpt-5.4' }],
        config: { baseUrl: 'https://api.example.com/v1' },
      },
    ]);
    mocks.getProviderSelectionError.mockReturnValue(null);
    mocks.isManagedCodexProviderReady.mockReturnValue(true);
    mocks.detectRuntimeInstallation.mockResolvedValue(true);
    mocks.queryRuntimeModels.mockResolvedValue([
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'gpt-5.4', label: 'GPT-5.4' },
    ]);
  });

  it('returns a non-blocking accepted receipt with effectiveConfig and omits birthOverrides when none passed', async () => {
    mocks.cancellableFetch.mockResolvedValue(acceptedFetchResponse(true));

    const result = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
      replyBack: true,
    }, 'internal-session');

    expect(result).toEqual({
      status: 200,
      response: {
        accepted: true,
        asynchronous: true,
        agentId: 'agent-1',
        sessionId: 'fresh-session',
        messageId: 'message-1',
        replyBack: true,
        resultDelivery: 'send.result',
        effectiveConfig: {
          runtime: 'builtin',
          providerId: 'deepseek',
          model: 'deepseek-v4-pro',
          permissionMode: 'auto',
        },
      },
    });
    expect(mocks.cancellableFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/api/inbox/start-session',
      expect.objectContaining({
        method: 'POST',
        body: expect.not.stringContaining('birthOverrides'),
      }),
      { timeoutMs: 180_000 },
    );
  });

  it('forwards one-shot local birthOverrides with unrestricted 1-to-1 permission alignment without mutating Agent config', async () => {
    const reg = registry({
      agent: {
        runtime: 'antigravity',
        runtimeConfig: {
          source: 'system-cli',
          model: 'gemini-4-neon',
          permissionMode: 'dangerously-skip-permissions',
        },
        providerId: 'codex-sub',
      },
    });
    const agentBefore = JSON.stringify(reg.identities[0].agent);
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(reg);
    mocks.cancellableFetch.mockResolvedValue(acceptedFetchResponse(true));

    const result = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Cross-review this diff',
      runtime: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    }, 'internal-session');

    expect(result).toEqual({
      status: 200,
      response: {
        accepted: true,
        asynchronous: true,
        agentId: 'agent-1',
        sessionId: 'fresh-session',
        messageId: 'message-1',
        replyBack: true,
        resultDelivery: 'send.result',
        effectiveConfig: {
          runtime: 'codex',
          runtimeSource: 'system-cli',
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          permissionMode: 'no-restrictions',
        },
      },
    });
    const body = JSON.parse(String((mocks.cancellableFetch.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.birthOverrides).toEqual({
      runtime: 'codex',
      runtimeSource: 'system-cli',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      permissionMode: 'no-restrictions',
    });
    expect(JSON.stringify(reg.identities[0].agent)).toBe(agentBefore);
  });

  it('allows one-shot overrides for external CLI with forced one-way delivery', async () => {
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry({
      agent: {
        runtime: 'builtin',
        permissionMode: 'fullAgency',
      },
    }));
    mocks.cancellableFetch.mockResolvedValue(acceptedFetchResponse(false));

    const result = await handleAdminSessionStart('', {
      agentId: 'agent-1',
      prompt: 'External work',
      replyBack: true,
      runtime: 'dsh',
      providerId: 'deepseek',
      model: 'deepseek-flash',
    }, 'external-cli');

    expect(result.status).toBe(200);
    expect(result.response).toMatchObject({
      accepted: true,
      replyBack: false,
      effectiveConfig: {
        runtime: 'dsh',
        runtimeSource: 'integrated',
        providerId: 'deepseek',
        model: 'deepseek-flash',
        permissionMode: 'full-autonomous',
      },
    });
    const body = JSON.parse(String((mocks.cancellableFetch.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      sourceKind: 'external-cli',
      fromLabel: 'External CLI',
      replyBack: false,
      birthOverrides: {
        runtime: 'dsh',
        runtimeSource: 'integrated',
        providerId: 'deepseek',
        model: 'deepseek-flash',
        permissionMode: 'full-autonomous',
      },
    });
    expect(body).not.toHaveProperty('fromSessionId');
  });

  it('allows explicit permission downgrade and rejects escalation before delivery', async () => {
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry({
      agent: { runtime: 'builtin', permissionMode: 'fullAgency' },
    }));
    mocks.cancellableFetch.mockResolvedValue(acceptedFetchResponse(true));

    const downgraded = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Read-only audit',
      runtime: 'codex',
      permissionMode: 'suggest',
    }, 'internal-session');
    expect(downgraded.status).toBe(200);
    expect(downgraded.response.effectiveConfig?.permissionMode).toBe('suggest');

    // Escalation from builtin:auto (tier 1) -> dsh:full-autonomous (tier 3)
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry({
      agent: { runtime: 'builtin', permissionMode: 'auto' },
    }));
    mocks.cancellableFetch.mockClear();
    const escalated = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Try escalate',
      runtime: 'dsh',
      permissionMode: 'full-autonomous',
    }, 'internal-session');
    expect(escalated).toMatchObject({
      status: 400,
      response: { error: { code: 'PERMISSION_ESCALATION_FORBIDDEN' } },
    });
    expect(mocks.cancellableFetch).not.toHaveBeenCalled();
  });

  it('fails closed when target is read-only (Tier 0) and requested runtime has no read-only mode (DSH)', async () => {
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry({
      agent: { runtime: 'builtin', permissionMode: 'plan' },
    }));

    const result = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Switch read-only to dsh',
      runtime: 'dsh',
    }, 'internal-session');

    expect(result).toMatchObject({
      status: 400,
      response: { error: { code: 'PERMISSION_CEILING_UNSATISFIABLE' } },
    });
    expect(mocks.cancellableFetch).not.toHaveBeenCalled();
  });

  it('rejects capability overrides, remote overrides, uninstalled runtime, and invalid model before delivery', async () => {
    const capOverride = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
      mcpEnabledServers: ['playwright'],
    }, 'internal-session');
    expect(capOverride).toMatchObject({
      status: 400,
      response: { error: { code: 'target_config_override_forbidden' } },
    });

    const remoteOverride = await handleAdminSessionStart('source-session', {
      agentId: 'ma-agent:1:s:n:m',
      prompt: 'Remote work',
      runtime: 'codex',
    }, 'internal-session');
    expect(remoteOverride).toMatchObject({
      status: 400,
      response: { error: { code: 'REMOTE_TARGET_CONFIG_OVERRIDE_FORBIDDEN' } },
    });

    mocks.detectRuntimeInstallation.mockResolvedValue(false);
    const notInstalled = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
      runtime: 'codex',
    }, 'internal-session');
    expect(notInstalled).toMatchObject({
      status: 400,
      response: { error: { code: 'RUNTIME_NOT_INSTALLED' } },
    });

    const badModel = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
      providerId: 'deepseek',
      model: 'non-existent-model',
    }, 'internal-session');
    expect(badModel).toMatchObject({
      status: 400,
      response: { error: { code: 'INVALID_MODEL' } },
    });

    const providerOnExternal = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
      runtime: 'codex',
      providerId: 'deepseek',
    }, 'internal-session');
    expect(providerOnExternal).toMatchObject({
      status: 400,
      response: { error: { code: 'PROVIDER_NOT_SUPPORTED_FOR_RUNTIME' } },
    });

    expect(mocks.cancellableFetch).not.toHaveBeenCalled();
  });

  it('honors project.permissionMode ceiling, rejects external-CLI --providerId without --runtime, validates external models, and accepts valid DSH/OpenAI reasoningEffort', async () => {
    // 1. project.permissionMode='plan' wins over config.defaultPermissionMode='fullAgency' when agent.permissionMode is unset
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry({
      agent: { runtime: 'builtin', permissionMode: undefined },
      project: { permissionMode: 'plan' },
      config: { defaultProviderId: 'deepseek', defaultPermissionMode: 'fullAgency' },
    }));
    const escalatedProject = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Try escalate',
      runtime: 'dsh',
    }, 'internal-session');
    expect(escalatedProject).toMatchObject({
      status: 400,
      response: { error: { code: 'PERMISSION_CEILING_UNSATISFIABLE' } },
    });

    // 2. Passing --providerId on an external system-cli Agent without --runtime fails closed
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry({
      agent: {
        runtime: 'antigravity',
        runtimeConfig: { source: 'system-cli', permissionMode: 'dangerously-skip-permissions' },
      },
    }));
    const implicitExternalProvider = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Ambiguous provider',
      providerId: 'deepseek',
    }, 'internal-session');
    expect(implicitExternalProvider).toMatchObject({
      status: 400,
      response: { error: { code: 'PROVIDER_NOT_SUPPORTED_FOR_RUNTIME' } },
    });

    // 3. External CLI model validation rejects cross-family or unlisted models
    const badExternalModel = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Wrong model',
      runtime: 'codex',
      model: 'claude-opus-4-7',
    }, 'internal-session');
    expect(badExternalModel).toMatchObject({
      status: 400,
      response: { error: { code: 'INVALID_MODEL' } },
    });

    // 4. Managed Codex rejects full-auto and maps Tier 2 down to auto-edit
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry({
      agent: {
        runtime: 'codex',
        runtimeConfig: { source: 'system-cli', permissionMode: 'full-auto' },
      },
    }));
    const badManagedPerm = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Managed codex invalid perm',
      providerId: 'codex-sub',
      model: 'gpt-5.5',
      permissionMode: 'full-auto',
    }, 'internal-session');
    expect(badManagedPerm).toMatchObject({
      status: 400,
      response: { error: { code: 'INVALID_PERMISSION_MODE' } },
    });

    mocks.cancellableFetch.mockResolvedValue(acceptedFetchResponse(true));
    const tier2Managed = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Managed codex tier2',
      providerId: 'codex-sub',
      model: 'gpt-5.5',
    }, 'internal-session');
    expect(tier2Managed.status).toBe(200);
    expect(tier2Managed.response.effectiveConfig).toMatchObject({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      permissionMode: 'auto-edit',
    });

    // 5. Official DeepSeek on DSH accepts --reasoningEffort high, and OpenAI-protocol on builtin accepts minimal
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry({
      agent: { runtime: 'builtin', permissionMode: 'fullAgency' },
    }));
    mocks.cancellableFetch.mockResolvedValue(acceptedFetchResponse(true));
    const dshEffort = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'DSH deepseek high',
      runtime: 'dsh',
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    }, 'internal-session');
    expect(dshEffort.status).toBe(200);
    expect(dshEffort.response.effectiveConfig?.reasoningEffort).toBe('high');

    mocks.cancellableFetch.mockResolvedValue(acceptedFetchResponse(true));
    const openaiMinimal = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'OpenAI minimal',
      runtime: 'builtin',
      providerId: 'openai-compat',
      model: 'gpt-5.4',
      reasoningEffort: 'minimal',
    }, 'internal-session');
    expect(openaiMinimal.status).toBe(200);
    expect(openaiMinimal.response.effectiveConfig?.reasoningEffort).toBe('minimal');

    // 6. Inherited codex-sub as defaultProviderId cannot silently run on builtin/dsh
    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry({
      agent: {
        runtime: 'antigravity',
        providerId: undefined,
        runtimeConfig: { source: 'system-cli', permissionMode: 'dangerously-skip-permissions' },
      },
      config: { defaultProviderId: 'codex-sub', defaultPermissionMode: 'auto' },
    }));
    const inheritedCodexSub = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Switch to dsh',
      runtime: 'dsh',
    }, 'internal-session');
    expect(inheritedCodexSub).toMatchObject({
      status: 400,
      response: { error: { code: 'PROVIDER_NOT_SUPPORTED_FOR_RUNTIME' } },
    });
  });

  it('preserves IDs and warns against automatic retry when admission is unconfirmed', async () => {
    mocks.cancellableFetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      outcome: {
        status: 'unconfirmed',
        agentId: 'agent-1',
        sessionId: 'fresh-session',
        messageId: 'message-1',
        replyBack: true,
        reason: 'ACK lost',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
    }, 'internal-session');

    expect(result.status).toBe(502);
    expect(result.response).toMatchObject({
      accepted: null,
      unconfirmed: true,
      sessionId: 'fresh-session',
      messageId: 'message-1',
      error: { code: 'admission_unconfirmed' },
      recoveryHint: {
        recoveryCommand: 'myagents session list --agent agent-1',
        message: expect.stringContaining('do not automatically resend'),
      },
    });
  });

  it('treats a management transport failure as admission unconfirmed', async () => {
    mocks.cancellableFetch.mockRejectedValue(new Error('timeout'));

    const result = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
    }, 'internal-session');

    expect(result).toMatchObject({
      status: 502,
      response: {
        accepted: null,
        unconfirmed: true,
        error: { code: 'admission_unconfirmed' },
      },
    });
  });

  it('treats an incomplete success receipt as admission unconfirmed', async () => {
    mocks.cancellableFetch.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      outcome: { status: 'accepted' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
    }, 'internal-session');

    expect(result).toMatchObject({
      status: 502,
      response: {
        accepted: null,
        unconfirmed: true,
        error: { code: 'admission_unconfirmed' },
      },
    });
  });

  it('requires a source Session and rejects archived targets', async () => {
    const missingSource = await handleAdminSessionStart('', {
      agentId: 'agent-1',
      prompt: 'Review this',
    }, 'internal-session');
    expect(missingSource.response).toMatchObject({
      error: { code: 'caller_session_required' },
    });

    mocks.resolvePersistedAgentWorkspaceRegistry.mockResolvedValue(registry({ archived: true }));
    const archived = await handleAdminSessionStart('source-session', {
      agentId: 'agent-1',
      prompt: 'Review this',
    }, 'internal-session');
    expect(archived.response).toMatchObject({ error: { code: 'agent_archived' } });
    expect(mocks.cancellableFetch).not.toHaveBeenCalled();
  });
});
