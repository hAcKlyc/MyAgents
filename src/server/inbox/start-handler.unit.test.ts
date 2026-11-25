import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '../../shared/types/agent';
import type { PendingInboxMessage } from './types';

const mocks = vi.hoisted(() => ({
  claimPreparedSessionForTurnAdmission: vi.fn(),
  deleteSession: vi.fn(),
  getSessionMetadata: vi.fn(),
  saveSessionMetadata: vi.fn(),
  createMaterializedSessionMetadata: vi.fn(),
}));

vi.mock('../SessionStore', () => ({
  claimPreparedSessionForTurnAdmission: mocks.claimPreparedSessionForTurnAdmission,
  deleteSession: mocks.deleteSession,
  getSessionMetadata: mocks.getSessionMetadata,
  saveSessionMetadata: mocks.saveSessionMetadata,
}));

vi.mock('../utils/session-materialization', () => ({
  createMaterializedSessionMetadata: mocks.createMaterializedSessionMetadata,
}));

import { handleFreshSessionStart, type FreshSessionInjector } from './start-handler';

const message: PendingInboxMessage = {
  messageId: 'message-1',
  fromSessionId: 'source-session',
  fromLabel: 'Source Agent',
  toSessionId: 'fresh-session',
  text: 'Review this change',
  replyBack: true,
  kind: 'request',
};

const context = {
  sessionId: 'fresh-session',
  workspacePath: '/target/workspace',
  agent: { id: 'agent-1', name: 'Target' } as AgentConfig,
  runtime: 'codex' as const,
  runtimeSource: 'system-cli' as const,
};

describe('handleFreshSessionStart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionMetadata.mockReturnValue(null);
    mocks.saveSessionMetadata.mockResolvedValue(undefined);
    mocks.createMaterializedSessionMetadata.mockReturnValue({
      id: 'fresh-session',
      agentDir: '/target/workspace',
      title: 'Review this change',
      createdAt: '2026-08-01T00:00:00.000Z',
      lastActiveAt: '2026-08-01T00:00:00.000Z',
    });
    mocks.claimPreparedSessionForTurnAdmission.mockResolvedValue({ status: 'claimed' });
    mocks.deleteSession.mockResolvedValue({ deleted: true });
  });

  it('commits prepared metadata at dispatch acceptance and returns without terminal output', async () => {
    const inject = vi.fn<FreshSessionInjector>(async (_text, options) => {
      const acceptance = await options.beforeDispatch();
      return {
        queued: true,
        queueId: options.queueId,
        dispatchAcceptance: Promise.resolve(acceptance),
      };
    });

    const result = await handleFreshSessionStart(message, context, inject);

    expect(result).toEqual({ accepted: true });
    expect(mocks.saveSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({
      id: 'fresh-session',
      materializationState: 'prepared',
      materializationSourceSessionId: 'message-1',
    }));
    expect(mocks.claimPreparedSessionForTurnAdmission).toHaveBeenCalledWith(
      'fresh-session',
      'message-1',
      expect.objectContaining({ lastMessagePreview: undefined }),
    );
    expect(inject).toHaveBeenCalledWith(
      expect.stringContaining('Review this change'),
      expect.objectContaining({
        queueId: 'message-1',
        inboxMeta: expect.objectContaining({
          fromSessionId: 'source-session',
          originalMessageId: 'message-1',
        }),
      }),
    );
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it('materializes a DSH Inbox Session with its Integrated frozen identity', async () => {
    const dshContext = {
      ...context,
      runtime: 'dsh' as const,
      runtimeSource: 'integrated' as const,
    };
    const inject = vi.fn<FreshSessionInjector>(async (_text, options) => ({
      queued: true,
      dispatchAcceptance: Promise.resolve(await options.beforeDispatch()),
    }));

    await handleFreshSessionStart(message, dshContext, inject);

    expect(mocks.createMaterializedSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOverride: 'dsh',
        runtimeSourceOverride: 'integrated',
      }),
    );
  });

  it('forwards one-shot birthOverrides into createMaterializedSessionMetadata', async () => {
    const birthOverrides = {
      runtime: 'codex' as const,
      runtimeSource: 'system-cli' as const,
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      permissionMode: 'no-restrictions',
    };
    const inject = vi.fn<FreshSessionInjector>(async (_text, options) => ({
      queued: true,
      dispatchAcceptance: Promise.resolve(await options.beforeDispatch()),
    }));

    await handleFreshSessionStart(message, { ...context, birthOverrides }, inject);

    expect(mocks.createMaterializedSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        birthOverrides,
      }),
    );
  });

  it('rolls back prepared metadata on an explicit Runtime dispatch rejection', async () => {
    mocks.claimPreparedSessionForTurnAdmission.mockResolvedValue({
      status: 'conflict',
      error: 'not owner',
    });
    const inject: FreshSessionInjector = async (_text, options) => ({
      queued: true,
      dispatchAcceptance: Promise.resolve(await options.beforeDispatch()),
    });

    const result = await handleFreshSessionStart(message, context, inject);

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('prepared admission conflict');
    expect(mocks.deleteSession).toHaveBeenCalledWith('fresh-session', {
      kind: 'prepared-materialization-rollback',
      sourceSessionId: 'message-1',
    });
  });

  it('keeps an irreversibly admitted Session accepted when the adapter later reports an error', async () => {
    const inject: FreshSessionInjector = async (_text, options) => {
      const acceptance = await options.beforeDispatch();
      return {
        queued: false,
        error: 'runtime startup failed after admission',
        dispatchAcceptance: Promise.resolve(acceptance),
      };
    };

    const result = await handleFreshSessionStart(message, context, inject);

    expect(result).toEqual({ accepted: true });
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it('preserves an unconfirmed dispatch without rolling back or inviting retry', async () => {
    const inject: FreshSessionInjector = async () => ({
      queued: false,
      error: 'runtime termination could not be confirmed',
      terminationUnconfirmed: true,
      dispatchAcceptance: Promise.resolve({ accepted: false, error: 'ACK unavailable' }),
    });

    const result = await handleFreshSessionStart(message, context, inject);

    expect(result).toEqual({
      accepted: null,
      unconfirmed: true,
      reason: 'runtime termination could not be confirmed',
    });
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it('uses the committed Session row as authority when the adapter throws after admission', async () => {
    mocks.getSessionMetadata
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ id: 'fresh-session', materializationState: undefined });
    const inject: FreshSessionInjector = async (_text, options) => {
      await options.beforeDispatch();
      throw new Error('adapter failed after the claim');
    };

    await expect(handleFreshSessionStart(message, context, inject)).resolves.toEqual({ accepted: true });
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it('rejects a pre-existing target Session without modifying persistence', async () => {
    mocks.getSessionMetadata.mockReturnValue({ id: 'fresh-session' });
    const inject = vi.fn<FreshSessionInjector>();

    const result = await handleFreshSessionStart(message, context, inject);

    expect(result).toEqual({
      accepted: false,
      reason: 'target Session metadata already exists',
    });
    expect(mocks.saveSessionMetadata).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
  });

  it('re-validates birthOverrides permission ceiling against freshly persisted Agent/Project/Config before writing metadata', async () => {
    const inject = vi.fn<FreshSessionInjector>();
    const result = await handleFreshSessionStart(
      message,
      {
        ...context,
        runtime: 'codex',
        runtimeSource: 'system-cli',
        agent: { ...context.agent, runtime: 'builtin', permissionMode: 'plan' },
        config: { defaultPermissionMode: 'auto' },
        birthOverrides: {
          runtime: 'codex',
          runtimeSource: 'system-cli',
          permissionMode: 'no-restrictions',
        },
      },
      inject,
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/ceiling|exceed/i);
    expect(mocks.saveSessionMetadata).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
  });

  it('forwards config.defaultIntegratedRuntime into birth snapshot so implicit-DSH to builtin switches scrub reasoningEffort', async () => {
    const inject: FreshSessionInjector = async (_text, options) => {
      await options.beforeDispatch();
      return {
        queued: true,
        dispatchAcceptance: Promise.resolve({ accepted: true }),
      };
    };
    const result = await handleFreshSessionStart(
      message,
      {
        ...context,
        runtime: 'builtin',
        agent: {
          ...context.agent,
          runtime: undefined,
          providerId: 'deepseek',
          model: 'deepseek-v4-pro',
          permissionMode: 'full-autonomous',
          reasoningEffort: 'max',
        } as unknown as typeof context.agent,
        config: { defaultIntegratedRuntime: 'dsh', defaultPermissionMode: 'auto' },
        birthOverrides: {
          runtime: 'builtin',
          providerId: 'xai-sub',
          model: 'grok-4.3',
          permissionMode: 'fullAgency',
        },
      },
      inject,
    );

    expect(result).toEqual({ accepted: true });
    expect(mocks.createMaterializedSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePolicy: { defaultIntegratedRuntime: 'dsh' },
        runtimeOverride: 'builtin',
        birthOverrides: expect.objectContaining({
          runtime: 'builtin',
          providerId: 'xai-sub',
          model: 'grok-4.3',
          permissionMode: 'fullAgency',
        }),
      }),
    );
  });
});
