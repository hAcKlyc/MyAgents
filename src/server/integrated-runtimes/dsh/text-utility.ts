import { randomUUID } from 'node:crypto';
import type { RuntimeTextUtilityTask } from '../../runtimes/types';
import type { DshRuntimeProcessHost } from './process-host';

interface UtilityProcess {
  readonly exited: boolean;
  readonly activeOperationId?: string;
  readonly configuration: { readonly profile: { readonly revision: string } };
  readonly host: Pick<DshRuntimeProcessHost, 'request'>;
}
/** Reuses native DSH utility/run (tools:[], no root turn/session mutation). */
export async function runDshTextUtility(process: UtilityProcess, task: RuntimeTextUtilityTask): Promise<string | null> {
  if (task.signal?.aborted || process.exited || process.activeOperationId) return null;
  const revision = process.configuration.profile.revision;
  const signal = AbortSignal.any([AbortSignal.timeout(task.timeoutMs ?? 30_000), ...(task.signal ? [task.signal] : [])]);
  try {
    const result = await process.host.request('utility/run', {
      clientOperationId: randomUUID(), prompt: task.prompt, systemPrompt: task.systemPrompt,
      modelProfileRevision: revision, maxTokens: 512,
    }, { signal });
    return !signal.aborted && !process.exited && process.configuration.profile.revision === revision
      && result.state === 'succeeded' && typeof result.text === 'string' ? result.text : null;
  } catch { return null; }
}
