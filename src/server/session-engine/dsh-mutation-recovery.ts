import {
  abortDshForkProduct,
  deleteCommittedDshProduct,
  commitDshForkProduct,
  commitDshRewindProduct,
  getSessionData,
  getSessionMetadata,
  recordPreparedDshFork,
  recordPreparedDshRewind,
  recordPreparedDshDelete,
  recordCommittedDshDelete,
  stageDshForkProduct,
  clearPendingDshMutation,
} from '../SessionStore';
import { createSessionMetadata, type PendingDshMutation } from '../types/session';
import { runtimeTypeForBinding } from '../../shared/integrated-runtimes/identity';
import {
  rewindBoundaryBeforeRuntimeTurn,
  type DshMutationController,
  type DshMutationResult,
} from '../integrated-runtimes/dsh/mutations';
import { snapshotForForkedSession } from '../utils/session-snapshot';

export type DshRecoveryBinding = Readonly<{
  state?: unknown;
  reason?: unknown;
  retryable?: unknown;
  unsettledMutations?: unknown;
}>;

function recoveryError(binding: DshRecoveryBinding): Error {
  const reason = typeof binding.reason === 'string' && binding.reason.length > 0
    ? binding.reason
    : 'unknown';
  const unsettled = Array.isArray(binding.unsettledMutations)
    ? binding.unsettledMutations.filter(value => typeof value === 'string')
    : [];
  if (unsettled.length > 0) {
    return new Error(
      `DSH has unsettled ${unsettled.join(', ')} recovery but Product has no matching mutation journal`,
    );
  }
  return new Error(
    `DSH Session recovery required: ${reason}${binding.retryable === true ? ' (retryable)' : ''}`,
  );
}

function mutationKind(intent: PendingDshMutation): 'fork' | 'rewind' | 'delete' {
  if (intent.kind === 'dsh-fork') return 'fork';
  if (intent.kind === 'dsh-rewind') return 'rewind';
  return 'delete';
}

function assertRecoveryAdmission(
  intent: PendingDshMutation,
  binding: DshRecoveryBinding,
): void {
  if (binding.state !== 'recovery_required') return;
  const unsettled = Array.isArray(binding.unsettledMutations)
    ? binding.unsettledMutations
    : [];
  if (!unsettled.includes(mutationKind(intent))) {
    throw new Error('DSH recovery inventory differs from the Product mutation journal');
  }
}

function requireStoreSuccess<T>(
  result: { success: true; value: T } | { success: false; error: string },
): T {
  if (!result.success) throw new Error(result.error);
  return result.value;
}

async function recoverFork(
  productSessionId: string,
  initialIntent: Extract<PendingDshMutation, { kind: 'dsh-fork' }>,
  controller: DshMutationController,
): Promise<void> {
  let intent = initialIntent;
  let mutation: DshMutationResult;
  if (intent.token) {
    mutation = await controller.forkStatus(intent.token);
  } else {
    const prepared = await controller.prepareFork({
      clientMutationId: intent.clientMutationId,
      sourceRuntimeTurnId: intent.sourceRuntimeTurnId,
      targetRuntimeHome: intent.targetRuntimeHome,
      targetPersistenceRef: intent.targetPersistenceRef,
      targetWorkspaceIdentity: intent.targetWorkspaceIdentity,
      targetRuntimeSessionId: intent.targetRuntimeSessionId,
    });
    intent = requireStoreSuccess(await recordPreparedDshFork({
      sourceSessionId: productSessionId,
      clientMutationId: intent.clientMutationId,
      token: prepared.mutation.token,
      sourceStableBoundaryId: prepared.boundary.stableBoundaryId,
    }));
    mutation = prepared.mutation;
  }

  if (mutation.state === 'aborted') {
    requireStoreSuccess(await abortDshForkProduct({
      sourceSessionId: productSessionId,
      clientMutationId: intent.clientMutationId,
    }));
    return;
  }
  if ((intent.settlement ?? 'commit') === 'abort' && mutation.state === 'prepared') {
    mutation = await controller.abortFork(intent.clientMutationId, mutation.token);
    if (mutation.state !== 'aborted') {
      throw new Error(`DSH fork abort recovery settled as ${mutation.state}`);
    }
    requireStoreSuccess(await abortDshForkProduct({
      sourceSessionId: productSessionId,
      clientMutationId: intent.clientMutationId,
    }));
    return;
  }
  if (mutation.state !== 'prepared' && mutation.state !== 'committed') {
    throw new Error(`DSH fork recovery cannot continue from ${mutation.state}`);
  }

  const source = getSessionMetadata(productSessionId);
  const sourceData = await getSessionData(productSessionId);
  if (!source || !sourceData || sourceData.messages.length !== intent.sourceMessageCount) {
    throw new Error('The Product fork source changed before recovery');
  }
  const forked = createSessionMetadata(source.agentDir, snapshotForForkedSession(source));
  forked.id = intent.targetProductSessionId;
  forked.runtimeSessionId = intent.targetRuntimeSessionId;
  forked.title = `🌿 ${source.title || 'Chat'}`;
  forked.titleSource = 'auto';
  forked.origin = { kind: 'desktop', surface: 'session_fork' };
  forked.materializationState = 'prepared';
  forked.materializationSourceSessionId = productSessionId;
  requireStoreSuccess(await stageDshForkProduct({
    sourceSessionId: productSessionId,
    clientMutationId: intent.clientMutationId,
    targetMetadata: forked,
    targetMessages: sourceData.messages.slice(0, intent.targetMessageCount),
  }));

  if (mutation.state === 'prepared') {
    mutation = await controller.commitFork(intent.clientMutationId, mutation.token);
  }
  if (mutation.state !== 'committed') {
    throw new Error(`DSH fork recovery settled as ${mutation.state}`);
  }
  requireStoreSuccess(await commitDshForkProduct({
    sourceSessionId: productSessionId,
    clientMutationId: intent.clientMutationId,
    token: mutation.token,
  }));
}

async function recoverRewind(
  productSessionId: string,
  initialIntent: Extract<PendingDshMutation, { kind: 'dsh-rewind' }>,
  controller: DshMutationController,
): Promise<void> {
  let intent = initialIntent;
  let mutation: DshMutationResult;
  if (intent.token) {
    mutation = await controller.rewindStatus(intent.token);
  } else {
    const history = await controller.readHistory();
    const boundary = rewindBoundaryBeforeRuntimeTurn(history, intent.targetRuntimeTurnId);
    mutation = await controller.prepareRewind({
      clientMutationId: intent.clientMutationId,
      target: boundary,
      sourceTranscriptPostcondition: history.transcriptPostcondition,
    });
    intent = requireStoreSuccess(await recordPreparedDshRewind({
      sessionId: productSessionId,
      clientMutationId: intent.clientMutationId,
      token: mutation.token,
      targetStableBoundaryId: boundary.stableBoundaryId,
      sourceTranscriptPostcondition: history.transcriptPostcondition,
      targetTranscriptPostcondition: boundary.transcriptPostcondition,
    }));
  }

  if (mutation.state === 'rolled_back') {
    requireStoreSuccess(await clearPendingDshMutation({
      sessionId: productSessionId,
      clientMutationId: intent.clientMutationId,
    }));
    return;
  }
  if (mutation.state === 'prepared') {
    mutation = await controller.commitRewind(intent.clientMutationId, mutation.token);
  }
  if (mutation.state !== 'committed') {
    throw new Error(`DSH rewind recovery cannot continue from ${mutation.state}`);
  }
  requireStoreSuccess(await commitDshRewindProduct({
    sessionId: productSessionId,
    clientMutationId: intent.clientMutationId,
    token: mutation.token,
  }));
}

async function recoverDelete(
  productSessionId: string,
  initialIntent: Extract<PendingDshMutation, { kind: 'dsh-delete' }>,
  controller: DshMutationController,
): Promise<void> {
  let intent = initialIntent;
  let mutation: DshMutationResult;
  if (intent.token) {
    mutation = await controller.deleteStatus(intent.token);
  } else {
    mutation = await controller.prepareDelete(intent.clientMutationId);
    intent = requireStoreSuccess(await recordPreparedDshDelete({
      sessionId: productSessionId,
      clientMutationId: intent.clientMutationId,
      token: mutation.token,
    }));
  }
  if (mutation.state === 'rolled_back') {
    requireStoreSuccess(await clearPendingDshMutation({
      sessionId: productSessionId,
      clientMutationId: intent.clientMutationId,
    }));
    return;
  }
  if (mutation.state === 'prepared') {
    mutation = await controller.commitDelete(intent.clientMutationId, mutation.token);
  }
  if (mutation.state === 'committed' || mutation.state === 'purged') {
    intent = requireStoreSuccess(await recordCommittedDshDelete({
      sessionId: productSessionId,
      clientMutationId: intent.clientMutationId,
      token: mutation.token,
    }));
    // A durable purge receipt may precede physical generation collection.
    mutation = await controller.purgeDelete(intent.clientMutationId, mutation.token);
  }
  if (mutation.state !== 'purged') {
    throw new Error(`DSH delete recovery cannot continue from ${mutation.state}`);
  }
  if (intent.runtimeCommitted !== true) {
    intent = requireStoreSuccess(await recordCommittedDshDelete({
      sessionId: productSessionId,
      clientMutationId: intent.clientMutationId,
      token: mutation.token,
    }));
  }
  requireStoreSuccess(await deleteCommittedDshProduct({
    sessionId: productSessionId,
    clientMutationId: intent.clientMutationId,
    token: mutation.token,
  }));
}

/**
 * Resolve one Product-owned DSH mutation before the Session can become ready.
 * Exact prepare replay recovers a token lost between Runtime and Product fsync.
 */
export async function recoverPendingDshMutation(input: {
  productSessionId: string;
  runtimeSessionId: string;
  binding: DshRecoveryBinding;
  controller: DshMutationController;
}): Promise<Readonly<{ recovered: boolean; productDeleted: boolean }>> {
  const metadata = getSessionMetadata(input.productSessionId);
  const intent = metadata?.pendingDshMutation;
  if (!intent) {
    if (input.binding.state === 'recovery_required') {
      throw recoveryError(input.binding);
    }
    return Object.freeze({ recovered: false, productDeleted: false });
  }
  if (
    intent.schemaVersion !== 1
    || !metadata?.runtimeBinding
    || runtimeTypeForBinding(metadata.runtimeBinding) !== 'dsh'
    || intent.sourceRuntimeSessionId !== input.runtimeSessionId
    || metadata.runtimeSessionId !== input.runtimeSessionId
  ) {
    throw new Error('The persisted DSH mutation journal has incompatible Session identity');
  }
  assertRecoveryAdmission(intent, input.binding);
  if (intent.kind === 'dsh-fork') {
    await recoverFork(input.productSessionId, intent, input.controller);
  } else if (intent.kind === 'dsh-rewind') {
    await recoverRewind(input.productSessionId, intent, input.controller);
  } else {
    await recoverDelete(input.productSessionId, intent, input.controller);
  }
  return Object.freeze({
    recovered: true,
    productDeleted: intent.kind === 'dsh-delete',
  });
}
