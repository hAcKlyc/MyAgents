import type { TurnTerminalOutcome } from './session-core/turn-queue';

export type HostSessionOperation = 'describe' | 'send' | 'state' | 'result' | 'permission' | 'stop' | 'shutdown';
export type HostSessionRequest = {
  id: string;
  generation: string;
  operation: HostSessionOperation;
  args?: Record<string, unknown>;
};
export type HostSessionReply = { type: 'reply'; id: string; generation: string; ok: boolean; data?: unknown; error?: string };
export type HostSessionMessage =
  | { type: 'credential-needed'; generation: string }
  | { type: 'ready'; generation: string; sessionId: string }
  | HostSessionReply
  | { type: 'terminal'; generation: string; sessionId: string; outcome: TurnTerminalOutcome };

const operations = new Set<HostSessionOperation>(['describe', 'send', 'state', 'result', 'permission', 'stop', 'shutdown']);

export function isHostSessionRequest(value: unknown): value is HostSessionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return typeof request.id === 'string' && request.id.length > 0 && request.id.length <= 128
    && typeof request.generation === 'string' && request.generation.length > 0
    && typeof request.operation === 'string' && operations.has(request.operation as HostSessionOperation)
    && (request.args === undefined || (request.args !== null && typeof request.args === 'object' && !Array.isArray(request.args)));
}
