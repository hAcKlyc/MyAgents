import { describe, expect, it } from 'vitest';

import {
  isExistingSessionSwitch,
  isResetSessionBirth,
  resolveBuiltinPermissionMode,
  resolveLauncherProvider,
  shouldDegradedLoad,
  shouldCommitSessionSwitch,
} from './optionResolve';

describe('resolveBuiltinPermissionMode (#244)', () => {
  it('falls back to the agent config before the project sync runs (the bug)', () => {
    // Fresh tab: state still holds the mount-time 'auto' default, config has
    // just loaded with fullAgency. Must NOT ship 'auto'.
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        agentPermissionMode: 'fullAgency',
        projectPermissionMode: 'plan',
        defaultPermissionMode: 'auto',
      }),
    ).toBe('fullAgency');
  });

  it('prefers project, then global default, when agent has none', () => {
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        agentPermissionMode: undefined,
        projectPermissionMode: 'plan',
      }),
    ).toBe('plan');
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        defaultPermissionMode: 'fullAgency',
      }),
    ).toBe('fullAgency');
  });

  it('trusts state once synced (covers user toggle + session snapshot)', () => {
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: true,
        statePermissionMode: 'plan',
        agentPermissionMode: 'fullAgency',
      }),
    ).toBe('plan');
  });

  it('falls back to state when nothing is configured', () => {
    expect(
      resolveBuiltinPermissionMode({ projectSynced: false, statePermissionMode: 'auto' }),
    ).toBe('auto');
  });
});

describe('resolveLauncherProvider (#234)', () => {
  it('uses the agent default when it diverges from the stale cache (the bug)', () => {
    // User changed Agent default MiniMax → DeepSeek; launcherLastUsed still
    // remembers MiniMax. Agent default must win, and the stale MiniMax model
    // must be dropped.
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'minimax',
      lastUsedModel: 'MiniMax-M2.7',
      agentProviderId: 'deepseek',
      agentModel: 'deepseek-v4-flash',
    });
    expect(r.providerId).toBe('deepseek');
    expect(r.model).toBe('deepseek-v4-flash');
  });

  it('keeps the cached provider+model when consistent with the agent', () => {
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'deepseek',
      lastUsedModel: 'deepseek-v4-pro',
      agentProviderId: 'deepseek',
      agentModel: 'deepseek-v4-flash',
    });
    expect(r.providerId).toBe('deepseek');
    // user's explicit launcher model choice survives within the same provider
    expect(r.model).toBe('deepseek-v4-pro');
  });

  it('honors the cache when the agent has no explicit provider', () => {
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'minimax',
      lastUsedModel: 'MiniMax-M2.7',
      agentProviderId: undefined,
      workspaceProviderId: 'deepseek',
    });
    expect(r.providerId).toBe('minimax');
    expect(r.model).toBe('MiniMax-M2.7');
  });

  it('falls back agent → workspace → cache → global when no cache match', () => {
    expect(
      resolveLauncherProvider({ agentProviderId: 'openai' }).providerId,
    ).toBe('openai');
    expect(
      resolveLauncherProvider({ workspaceProviderId: 'deepseek' }).providerId,
    ).toBe('deepseek');
    expect(
      resolveLauncherProvider({ defaultProviderId: 'anthropic' }).providerId,
    ).toBe('anthropic');
  });
});

describe('shouldDegradedLoad (#235)', () => {
  const base = {
    mounted: true,
    currentSessionId: 's1',
    target: 's1',
    connectedSseSessionId: null as string | null,
    alreadyLoaded: false,
    prevSessionId: 's0' as string | null | undefined,
    sessionActiveOrStreaming: false,
  };

  it('fires when SSE never attached and the session is unchanged (the bug)', () => {
    expect(shouldDegradedLoad(base)).toBe(true);
  });

  it('does not fire while the session is mid-turn (active/streaming)', () => {
    expect(shouldDegradedLoad({ ...base, sessionActiveOrStreaming: true })).toBe(false);
  });

  it('can fire during an explicit history switch even if the previous session looked active', () => {
    expect(shouldDegradedLoad({
      ...base,
      sessionActiveOrStreaming: true,
      allowWhileActive: true,
    })).toBe(true);
  });

  it('does not fire after unmount', () => {
    expect(shouldDegradedLoad({ ...base, mounted: false })).toBe(false);
  });

  it('does not fire if the user switched sessions while waiting', () => {
    expect(shouldDegradedLoad({ ...base, currentSessionId: 's2' })).toBe(false);
  });

  it('does not fire if SSE attached after all', () => {
    expect(shouldDegradedLoad({ ...base, connectedSseSessionId: 's1' })).toBe(false);
  });

  it('does not fire if the session was already loaded', () => {
    expect(shouldDegradedLoad({ ...base, alreadyLoaded: true, prevSessionId: 's1' })).toBe(false);
  });

  it('still fires if alreadyLoaded but for a different prior session', () => {
    expect(shouldDegradedLoad({ ...base, alreadyLoaded: true, prevSessionId: 's0' })).toBe(true);
  });
});

describe('session-load transition classification (#255)', () => {
  it('recognizes only the exact backend-minted reset session as reset birth', () => {
    expect(isResetSessionBirth({
      resetBirthSessionId: 'new-session',
      sessionId: 'new-session',
    })).toBe(true);

    // Regression: a stale new-session flag must not make a history click look
    // like resetSession's own id upgrade.
    expect(isResetSessionBirth({
      resetBirthSessionId: 'new-session',
      sessionId: 'history-session',
    })).toBe(false);
  });

  it('preserves reset birth after sendMessage clears the stale-event guard', () => {
    const resetBirth = isResetSessionBirth({
      resetBirthSessionId: 'new-session',
      sessionId: 'new-session',
    });
    expect(resetBirth).toBe(true);
    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: false,
      isPendingSession: false,
      isResetSessionBirth: resetBirth,
    })).toBe(false);
  });

  it('treats persisted real-to-real transitions as existing-session switches', () => {
    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: false,
      isPendingSession: false,
      isResetSessionBirth: false,
    })).toBe(true);
  });

  it('does not treat pending upgrades or reset births as history switches', () => {
    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: true,
      isPendingSession: false,
      isResetSessionBirth: false,
    })).toBe(false);

    expect(isExistingSessionSwitch({
      sessionChanged: true,
      wasPendingSession: false,
      isPendingSession: false,
      isResetSessionBirth: true,
    })).toBe(false);
  });
});

describe('shouldCommitSessionSwitch (#294)', () => {
  it('allows only the latest requested session switch to commit', () => {
    expect(shouldCommitSessionSwitch({
      requestedToken: 2,
      latestToken: 2,
      requestedSessionId: 'session-b',
      latestSessionId: 'session-b',
      tabStillPresent: true,
    })).toBe(true);
  });

  it('rejects an older switch completion after the user clicked another session', () => {
    expect(shouldCommitSessionSwitch({
      requestedToken: 1,
      latestToken: 2,
      requestedSessionId: 'session-a',
      latestSessionId: 'session-b',
      tabStillPresent: true,
    })).toBe(false);
  });

  it('rejects commits after the tab disappeared', () => {
    expect(shouldCommitSessionSwitch({
      requestedToken: 2,
      latestToken: 2,
      requestedSessionId: 'session-b',
      latestSessionId: 'session-b',
      tabStillPresent: false,
    })).toBe(false);
  });
});
