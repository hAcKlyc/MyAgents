import { randomUUID } from 'node:crypto';

import { runtimeTypeForBinding } from '../../shared/integrated-runtimes/identity';
import {
  beginDshDeleteMutation,
  deleteSession,
  deleteCommittedDshProduct,
  getSessionMetadata,
  recordCommittedDshDelete,
  recordPreparedDshDelete,
  type SessionDeleteResult,
} from '../SessionStore';
import { startDshStorageManagement } from '../integrated-runtimes/dsh/runtime';
import { DshMutationController } from '../integrated-runtimes/dsh/mutations';
import type { DshRuntimeProcessHost } from '../integrated-runtimes/dsh/process-host';
import { redactDshDiagnosticLine } from '../integrated-runtimes/dsh/process-host';
import { withLogContext } from '../logger-context';

function failedDelete(reason: Exclude<SessionDeleteResult, { deleted: true }>['reason']): SessionDeleteResult {
  return { deleted: false, reason };
}

function requireStoreSuccess<T>(
  result: { success: true; value: T } | { success: false; error: string },
): T {
  if (!result.success) throw new Error(result.error);
  return result.value;
}

/**
 * Execute DSH tombstone/purge before removing Product-owned metadata and JSONL.
 * Rust has already fenced Session owners before this global-sidecar entry runs.
 */
export async function deleteDshProductSession(sessionId: string): Promise<SessionDeleteResult> {
  const metadata = getSessionMetadata(sessionId);
  if (!metadata) return failedDelete('not-found');
  if (!metadata.runtimeBinding || runtimeTypeForBinding(metadata.runtimeBinding) !== 'dsh') {
    return failedDelete('precondition-failed');
  }
  if (!metadata.runtimeSessionId) return failedDelete('precondition-failed');

  let host: DshRuntimeProcessHost | undefined;
  try {
    const existing = getSessionMetadata(sessionId)?.pendingDshMutation;
    const clientMutationId = existing?.kind === 'dsh-delete'
      ? existing.clientMutationId
      : `dsh-delete-${randomUUID()}`;
    let intent = requireStoreSuccess(await beginDshDeleteMutation({
      sessionId,
      clientMutationId,
    }));
    host = await startDshStorageManagement({ sessionId, workspacePath: metadata.agentDir });
    const controller = new DshMutationController(host, intent.sourceRuntimeSessionId);
    // Replaying prepare also reserves this new process for the exact stored
    // identity; the native journal returns prepared/committed/purged receipts.
    let mutation = await controller.prepareStoredDelete(clientMutationId);
    if (intent.token && intent.token !== mutation.token) throw new Error('DSH stored delete token changed');
    if (!intent.token) {
      intent = requireStoreSuccess(await recordPreparedDshDelete({
        sessionId,
        clientMutationId,
        token: mutation.token,
      }));
    }
    if (mutation.state === 'prepared') {
      mutation = await controller.commitDelete(clientMutationId, mutation.token);
    }
    if (mutation.state === 'committed' || mutation.state === 'purged') {
      intent = requireStoreSuccess(await recordCommittedDshDelete({
        sessionId,
        clientMutationId,
        token: mutation.token,
      }));
      // Native status can be purged before physical generation collection has
      // finished. Always replay purge before removing the Product journal.
      mutation = await controller.purgeDelete(clientMutationId, mutation.token);
    }
    if (mutation.state !== 'purged') {
      throw new Error(`DSH delete settled as ${mutation.state}`);
    }
    if (intent.runtimeCommitted !== true) {
      requireStoreSuccess(await recordCommittedDshDelete({
        sessionId,
        clientMutationId,
        token: mutation.token,
      }));
    }
    requireStoreSuccess(await deleteCommittedDshProduct({
      sessionId,
      clientMutationId,
      token: mutation.token,
    }));
    return { deleted: true };
  } catch (error) {
    withLogContext({ sessionId, runtime: 'dsh' }, () => {
      console.error(`[dsh] phase=storage-delete failed: ${redactDshDiagnosticLine(error instanceof Error ? error.message : String(error))}`);
    });
    return failedDelete('io-error');
  } finally {
    await host?.stop('storage_management_complete').catch(() => undefined);
  }
}

/** Single SessionEngine deletion entry: routes never branch on Runtime family. */
export async function deleteProductSessionWithRuntime(
  sessionId: string,
): Promise<SessionDeleteResult> {
  const metadata = getSessionMetadata(sessionId);
  if (
    metadata?.runtimeBinding
    && runtimeTypeForBinding(metadata.runtimeBinding) === 'dsh'
  ) {
    return deleteDshProductSession(sessionId);
  }
  return deleteSession(sessionId, { kind: 'user-delete' });
}
