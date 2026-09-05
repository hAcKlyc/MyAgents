import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import type { ProviderEnv } from '../provider-types';
import {
  findProvider,
  isProviderDisabled,
  resolveProviderEnv,
} from './admin-config';

export type TaskProviderRoutingOwner =
  | { kind: 'task'; taskId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'session'; sessionId: string };

export function taskProviderRoutingRecovery(owner: TaskProviderRoutingOwner): string {
  switch (owner.kind) {
    case 'task':
      return `Task '${owner.taskId}' owns this override. Run 'myagents task update ${owner.taskId} --providerId <providerId> --model <model>'.`;
    case 'agent':
      return `Agent '${owner.agentId}' supplied this default. Run 'myagents agent set ${owner.agentId} providerId <providerId>' and then set its model.`;
    case 'session':
      return `Session '${owner.sessionId}' owns this frozen route. Change that Session's provider/model or create a new Session.`;
  }
}

/** Materialize a Task's durable provider identity against current config. */
export function resolveTaskProviderRouting(
  providerId: string,
  owner: TaskProviderRoutingOwner,
  model?: string,
): ProviderEnv | 'subscription' {
  const recovery = taskProviderRoutingRecovery(owner);
  const provider = findProvider(providerId);
  if (!provider) {
    throw new Error(
      `Provider '${providerId}' not found in config. ${recovery}`,
    );
  }
  if (isProviderDisabled(providerId)) {
    throw new Error(
      `Provider '${providerId}' is disabled. Re-enable it in 设置 → 模型供应商 → 启用和排序, or update the owning configuration. ${recovery}`,
    );
  }
  if (providerId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
    throw new Error(
      `Provider '${providerId}' is runtime-backed and cannot execute through builtin routing. ${recovery}`,
    );
  }
  if (provider.type === 'subscription') {
    return (resolveProviderEnv(providerId, undefined, model) as ProviderEnv | undefined) ?? 'subscription';
  }
  const env = resolveProviderEnv(providerId, undefined, model);
  if (!env) {
    throw new Error(
      `Provider '${providerId}' has no API Key. Configure it in 设置 → 模型供应商, or update the owning configuration. ${recovery}`,
    );
  }
  return env;
}
