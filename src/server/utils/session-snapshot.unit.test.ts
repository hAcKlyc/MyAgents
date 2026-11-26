import { describe, it, expect } from 'vitest';

import { snapshotForImRuntimeSwitch, snapshotForForkedSession, snapshotForOwnedSession, snapshotForImSession } from './session-snapshot';
import type { SessionMetadata } from '../types/session';
import type { AgentConfig } from '../../shared/types/agent';

// #324 regression (cross-review Critical): owned desktop/cron sessions must
// FREEZE reasoningEffort at creation, with the same runtime-aware dispatch as
// model (issue #224) — otherwise later agent-level effort changes silently
// change old sessions, violating the D1 ownership contract.
function makeAgent(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'a1',
    name: 'A',
    enabled: true,
    permissionMode: 'auto',
    channels: [],
    ...overrides,
  };
}

describe('snapshotForOwnedSession — reasoning effort capture (#324)', () => {
  it('DSH freezes an authoritative integrated binding and ordinary Provider route', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'dsh',
      providerId: 'anthropic-api',
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'default',
      permissionMode: 'plan',
      runtimeConfig: {
        model: 'stale-external-model',
        permissionMode: 'full-auto',
      },
    }));

    expect(snap).toMatchObject({
      runtime: 'dsh',
      runtimeSource: 'integrated',
      runtimeBinding: { family: 'integrated', id: 'dsh' },
      providerId: 'anthropic-api',
      providerRoute: {
        kind: 'provider',
        providerId: 'anthropic-api',
        model: 'claude-sonnet-4-6',
      },
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'default',
      permissionMode: 'plan',
    });
    expect(snap.providerEnvJson).toBeUndefined();
  });

  it('builtin: captures agent.reasoningEffort', () => {
    const snap = snapshotForOwnedSession(makeAgent({ reasoningEffort: 'max', model: 'claude-fable-5' }));
    expect(snap.reasoningEffort).toBe('max');
    expect(snap.model).toBe('claude-fable-5');
  });

  it('external: captures runtimeConfig.reasoningEffort, not the builtin field', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'codex',
      reasoningEffort: 'max', // stale builtin value must NOT leak (issue #224 class)
      runtimeConfig: { model: 'gpt-5.2-codex', reasoningEffort: 'xhigh' },
    }));
    expect(snap.reasoningEffort).toBe('xhigh');
    expect(snap.model).toBe('gpt-5.2-codex');
  });

  it("external: preserves literal 'default' to pin a session back to runtime defaults", () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'codex',
      reasoningEffort: 'max',
      runtimeConfig: { model: 'gpt-5.2-codex', reasoningEffort: 'default' },
    }));

    expect(snap.reasoningEffort).toBe('default');
  });

  it('runtime override snapshots the target runtime view instead of post-hoc mutating runtime', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'builtin',
      model: 'claude-opus-4-7',
      reasoningEffort: 'max',
      permissionMode: 'fullAgency',
      runtimeConfig: { model: 'claude-sonnet-4-5', reasoningEffort: 'xhigh', permissionMode: 'bypassPermissions' },
    }), { runtimeOverride: 'codex' });

    expect(snap.runtime).toBe('codex');
    expect(snap.model).toBeUndefined();
    expect(snap.reasoningEffort).toBeUndefined();
    expect(snap.permissionMode).toBeUndefined();
    expect(snap.configSnapshotAt).toBeTruthy();
  });

  it.each(['max', 'future-effort'])('external: preserves Codex effort %s while dropping foreign model and permission fields', (effort) => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'codex',
      runtimeConfig: {
        model: 'claude-opus-4-7',
        reasoningEffort: effort,
        permissionMode: 'fullAgency',
      },
    }));

    expect(snap.runtime).toBe('codex');
    expect(snap.model).toBeUndefined();
    // The model catalog validates execution; snapshot creation preserves intent.
    expect(snap.reasoningEffort).toBe(effort);
    expect(snap.permissionMode).toBeUndefined();
  });

  it('absent on both → undefined (resolver falls back to agent at read time)', () => {
    expect(snapshotForOwnedSession(makeAgent({})).reasoningEffort).toBeUndefined();
  });

  it('IM freezes effort with unattended permission', () => {
    const snap = snapshotForImSession(makeAgent({ reasoningEffort: 'max' }));
    expect(snap.reasoningEffort).toBe('max');
    expect(snap.permissionMode).toBe('fullAgency');
  });

  it('IM snapshots Antigravity with dangerously-skip-permissions while desktop owned sessions keep interactive config', () => {
    const agyAgent = makeAgent({
      runtime: 'antigravity',
      runtimePreference: { family: 'external', id: 'antigravity' },
      runtimeConfig: { permissionMode: 'accept-edits' },
    });
    expect(snapshotForImSession(agyAgent)).toMatchObject({
      runtime: 'antigravity',
      runtimeSource: 'system-cli',
      permissionMode: 'dangerously-skip-permissions',
    });
    expect(snapshotForOwnedSession(agyAgent)).toMatchObject({
      runtime: 'antigravity',
      runtimeSource: 'system-cli',
      permissionMode: 'accept-edits',
    });
  });
  it('uses desktop distribution and subscription constraints for IM template births', () => {
    const options = { runtimePolicy: { defaultIntegratedRuntime: 'dsh' } };
    expect(snapshotForImSession(makeAgent({ runtime: 'dsh', runtimePreference: { family: 'integrated', id: 'dsh' },
      providerId: 'anthropic-sub', model: 'claude-sonnet-4-6' }), options))
      .toMatchObject({ runtime: 'builtin', providerId: 'anthropic-sub', model: 'claude-sonnet-4-6', permissionMode: 'fullAgency' });
    expect(snapshotForImSession(makeAgent({ runtime: undefined, providerId: 'deepseek' }),
      { runtimePolicy: { defaultIntegratedRuntime: 'dsh' } }))
      .toMatchObject({ runtime: 'dsh', runtimeSource: 'integrated', permissionMode: 'full-autonomous' });
  });
  it('keeps an explicit SDK choice when the global default is DSH', () => {
    expect(snapshotForImSession(makeAgent({ runtime: 'builtin', providerId: 'deepseek' }),
      { runtimePolicy: { defaultIntegratedRuntime: 'dsh' } }))
      .toMatchObject({ runtime: 'builtin', permissionMode: 'fullAgency' });
  });
  it('rejects an unavailable Managed Codex template instead of publishing a partial identity', () => {
    expect(() => snapshotForImSession(makeAgent({ providerId: 'codex-sub', model: 'codex-live' }),
      { runtimePolicy: {}, managedCodexProviderReady: false }))
      .toThrow('not ready');
  });

  it('Managed Codex provider snapshots runtime-backed identity instead of builtin provider env', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      permissionMode: 'fullAgency',
      runtimeConfig: {
        model: 'stale-runtime-model',
        reasoningEffort: 'high',
      },
      mcpEnabledServers: ['myagents'],
    }), { managedCodexProviderReady: true });

    expect(snap).toMatchObject({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      providerExecutionIdentity: {
        kind: 'runtime-backed-provider',
        providerId: 'codex-sub',
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        model: 'gpt-5.4-codex',
      },
      permissionMode: 'no-restrictions',
      reasoningEffort: 'high',
      mcpEnabledServers: ['myagents'],
    });
    expect(snap.providerRoute).toBeUndefined();
    expect(snap.providerEnvJson).toBeUndefined();
  });

  it('Managed Codex provider defaults are ignored until readiness is explicit', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtimeConfig: {
        model: 'gpt-5.5-codex',
        source: 'managed-provider',
      },
      providerEnvJson: '{"apiKey":"stale"}',
    }));

    expect(snap.runtime).toBe('builtin');
    expect(snap.runtimeSource).toBeUndefined();
    expect(snap.providerId).toBeUndefined();
    expect(snap.providerRoute).toBeUndefined();
    expect(snap.providerExecutionIdentity).toBeUndefined();
    expect(snap.model).toBeUndefined();
    expect(snap.providerEnvJson).toBeUndefined();
  });

  it('explicit runtime override is not hijacked by stale Managed Codex provider defaults', () => {
    const builtinSnap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtimeConfig: { model: 'gpt-5.5-codex', source: 'system-cli' },
    }), { runtimeOverride: 'builtin' });

    expect(builtinSnap.runtime).toBe('builtin');
    expect(builtinSnap.runtimeSource).toBeUndefined();
    expect(builtinSnap.providerId).toBeUndefined();
    expect(builtinSnap.providerRoute).toBeUndefined();
    expect(builtinSnap.providerExecutionIdentity).toBeUndefined();
    expect(builtinSnap.model).toBeUndefined();
    expect(builtinSnap.providerEnvJson).toBeUndefined();

    const systemCliSnap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtimeConfig: { model: 'gpt-5.5-codex', source: 'system-cli' },
    }), { runtimeOverride: 'codex' });

    expect(systemCliSnap.runtime).toBe('codex');
    expect(systemCliSnap.runtimeSource).toBe('system-cli');
    expect(systemCliSnap.providerExecutionIdentity).toBeUndefined();
    expect(systemCliSnap.providerId).toBeUndefined();
    expect(systemCliSnap.model).toBeUndefined();
  });

  it('implicit system Codex identity is not hijacked by a dormant managed provider id', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtime: 'codex',
      runtimeConfig: {
        source: 'system-cli',
        model: 'gpt-5.6-sol',
        permissionMode: 'full-auto',
      },
    }), { managedCodexProviderReady: true });

    expect(snap.runtime).toBe('codex');
    expect(snap.runtimeSource).toBe('system-cli');
    expect(snap.providerExecutionIdentity).toBeUndefined();
    expect(snap.model).toBe('gpt-5.6-sol');
    expect(snap.permissionMode).toBe('full-auto');
  });

  it('explicit managed-provider runtime override preserves Managed Codex provider identity', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.5',
      runtime: 'builtin',
      runtimeConfig: {
        source: 'system-cli',
        model: 'stale-system-codex-model',
        permissionMode: 'no-restrictions',
      },
    }), {
      runtimeOverride: 'codex',
      runtimeSourceOverride: 'managed-provider',
      managedCodexProviderReady: true,
    });

    expect(snap).toMatchObject({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      providerId: 'codex-sub',
      model: 'gpt-5.5',
      providerExecutionIdentity: {
        kind: 'runtime-backed-provider',
        providerId: 'codex-sub',
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        model: 'gpt-5.5',
      },
    });
    expect(snap.providerRoute).toBeUndefined();
    expect(snap.providerEnvJson).toBeUndefined();
  });

  it('Managed Codex IM snapshot freezes full provider identity', () => {
    expect(snapshotForImSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      permissionMode: 'fullAgency',
    }), { managedCodexProviderReady: true })).toMatchObject({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      providerExecutionIdentity: { providerId: 'codex-sub', model: 'gpt-5.4-codex' },
      permissionMode: 'no-restrictions',
    });
  });

  it('Managed Codex IM snapshot also respects explicit runtime override', () => {
    expect(snapshotForImSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtimeConfig: { source: 'system-cli' },
    }), { runtimeOverride: 'codex' })).toMatchObject({
      runtime: 'codex',
      runtimeSource: 'system-cli',
    });
  });

  it('Managed Codex IM snapshot preserves explicit managed-provider runtime identity', () => {
    expect(snapshotForImSession(makeAgent({
      providerId: 'codex-sub',
      model: 'gpt-5.4-codex',
      runtimeConfig: { source: 'system-cli' },
    }), {
      runtimeOverride: 'codex',
      runtimeSourceOverride: 'managed-provider',
      managedCodexProviderReady: true,
    })).toMatchObject({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      providerExecutionIdentity: { providerId: 'codex-sub', model: 'gpt-5.4-codex' },
      permissionMode: 'no-restrictions',
    });
  });
});

describe('snapshotForForkedSession', () => {
  it('copies one authoritative Runtime identity without mixing fallback state', () => {
    const source = {
      runtime: 'builtin',
      runtimeBindingCompatibility: {
        state: 'incompatible',
        code: 'invalid-runtime-binding',
        message: 'invalid',
      },
    } as const satisfies Partial<SessionMetadata>;
    const fallback = {
      runtime: 'builtin',
      runtimeBinding: {
        family: 'integrated',
        id: 'claude-agent-sdk',
        implementationVersion: '0.3.233',
      },
      configSnapshotAt: '2026-08-30T00:00:00.000Z',
    } as const;

    const snapshot = snapshotForForkedSession(
      source as SessionMetadata,
      fallback,
    );
    expect(snapshot.runtimeBindingCompatibility).toEqual(
      source.runtimeBindingCompatibility,
    );
    expect(snapshot.runtimeBinding).toBeUndefined();
  });

  it('does not propagate legacy Managed Codex protocol or Host catalog gates', () => {
    const source = {
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      configSnapshotAt: '2026-08-08T00:00:00.000Z',
      managedCodexExtensionProtocolVersion: '0.146.0',
      managedCodexHostCatalogFingerprint: 'catalog-fingerprint',
    } as unknown as SessionMetadata & Record<string, unknown>;

    const snapshot = snapshotForForkedSession(source);

    expect(snapshot).toEqual({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      configSnapshotAt: '2026-08-08T00:00:00.000Z',
    });
    expect(snapshot).not.toHaveProperty('managedCodexExtensionProtocolVersion');
    expect(snapshot).not.toHaveProperty('managedCodexHostCatalogFingerprint');
  });
});


describe('explicit Team Runtime switch', () => {
  it('scrubs Managed Codex choices when switching the same Runtime to the native CLI owner', () => {
    const source: SessionMetadata = {id:'s',agentDir:'/w',title:'S',createdAt:'',lastActiveAt:'',runtime:'codex',runtimeSource:'managed-provider',providerId:'codex-sub',model:'managed-only',reasoningEffort:'xhigh'};
    expect(snapshotForImRuntimeSwitch(source,'codex')).toMatchObject({runtime:'codex',runtimeSource:'system-cli',model:undefined,providerId:undefined,reasoningEffort:undefined});
  });
  it.each([['builtin','dsh'],['dsh','builtin']] as const)('%s to %s carries Session choices without Agent defaults', (from,to) => {
    const source: SessionMetadata = {id:'s',agentDir:'/w',title:'S',createdAt:'',lastActiveAt:'',runtime:from,providerId:'session-provider',model:'session-model',reasoningEffort:'high',mcpEnabledServers:['m'],enabledPluginIds:['p']};
    expect(snapshotForImRuntimeSwitch(source,to)).toMatchObject({runtime:to,providerId:'session-provider',model:'session-model',reasoningEffort:'high',mcpEnabledServers:['m'],enabledPluginIds:['p']});
  });
  it('does not leak an integrated model into a native CLI birth', () => {
    const source: SessionMetadata = {id:'s',agentDir:'/w',title:'S',createdAt:'',lastActiveAt:'',runtime:'builtin',providerId:'session-provider',model:'claude-model',reasoningEffort:'high'};
    expect(snapshotForImRuntimeSwitch(source,'codex')).toMatchObject({runtime:'codex',runtimeSource:'system-cli',model:undefined,providerId:undefined,reasoningEffort:undefined});
  });
});
