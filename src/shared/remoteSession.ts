import { z } from 'zod';

/** Owned same-account session service. Paths, credentials, runtime overrides
 * and a caller identity cannot be supplied through this closed contract. */
const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const sessionId = z.string().min(1).max(99).regex(/^[A-Za-z0-9-]+$/);
const operationId = z.string().uuid().regex(/^[0-9a-f-]+$/);
const text = z.string().min(1).max(8000);
const base = { agentId: id };
const bound = { ...base, sessionId };
export const remoteSessionRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('capabilities') }).strict(),
  z.object({ ...base, kind: z.literal('list'), limit: z.number().int().min(1).max(30), before: z.string().max(256).optional() }).strict(),
  z.object({ ...bound, kind: z.literal('get'), limit: z.number().int().min(1).max(30), before: z.string().max(256).optional() }).strict(),
  z.object({ ...base, kind: z.literal('start'), operationId, text }).strict(),
  z.object({ ...bound, kind: z.literal('send'), operationId, text }).strict(),
  z.object({ ...base, kind: z.literal('receipt'), operationId }).strict(),
  z.object({ ...bound, kind: z.literal('respond'), operationId, generation: id, turnId: id, requestId: id,
    interaction: z.enum(['permission', 'plan', 'question']), approved: z.boolean(),
    answers: z.record(z.string().max(512), z.string().max(4000)).optional() }).strict(),
  z.object({ ...bound, kind: z.literal('stop'), operationId, generation: id, turnId: id }).strict(),
]);
export type RemoteSessionRequest = z.infer<typeof remoteSessionRequestSchema>;
export const remoteMessageSchema = z.object({ id, role: z.enum(['user', 'assistant']), timestamp: z.string().max(64),
  content: z.string().max(16000), truncated: z.boolean(), tools: z.array(z.object({ id, name: z.string().max(160), status: z.enum(['running', 'complete', 'error']), summary: z.string().max(2000) }).strict()).max(10) }).strict();
export const remoteInteractionSchema = z.object({ requestId: id, generation: id, turnId: id,
  interaction: z.enum(['permission', 'plan', 'question']), title: z.string().max(256), description: z.string().max(4000), actionable: z.boolean(),
  questions: z.array(z.object({ answerKey: z.string().max(512), question: z.string().max(512), options: z.array(z.string().max(256)).max(8), multiSelect: z.boolean() }).strict()).max(6) }).strict();
export const remoteSessionResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('capabilities'), version: z.literal(1), agentId: id, runtime: z.string().max(64), maxActiveSessions: z.number().int().min(1).max(100), liveUpdates: z.literal('snapshot') }).strict(),
  z.object({ kind: z.literal('list'), agentId: id, items: z.array(z.object({ sessionId, title: z.string().max(256), updatedAt: z.string().max(64), preview: z.string().max(512), runtime: z.string().max(64) }).strict()).max(30), hasMore: z.boolean(), nextBefore: z.string().max(256).nullable() }).strict(),
  z.object({ kind: z.literal('snapshot'), agentId: id, sessionId, generation: id.nullable(), turnId: id.nullable(),
    revision: z.string().max(128), state: z.enum(['idle', 'running', 'waiting_user_action', 'unavailable']),
    title: z.string().max(256), runtime: z.string().max(64), model: z.string().max(256).nullable(),
    terminal: z.enum(['complete', 'stopped', 'error', 'interrupted']).nullable(),
    messages: z.array(remoteMessageSchema).max(30), interactions: z.array(remoteInteractionSchema).max(8), hasMoreBefore: z.boolean(), nextBefore: z.string().max(256).nullable() }).strict(),
  z.object({ kind: z.literal('receipt'), agentId: id, operationId, sessionId: sessionId.nullable(),
    status: z.enum(['processing', 'accepted', 'rejected', 'unconfirmed', 'not-found']), code: z.string().regex(/^[A-Z0-9_]+$/).max(128).nullable() }).strict(),
  z.object({ kind: z.literal('error'), code: z.string().regex(/^[A-Z0-9_]+$/).max(128) }).strict(),
]);
export type RemoteSessionResult = z.infer<typeof remoteSessionResultSchema>;
export type RemoteSnapshot = Extract<RemoteSessionResult, { kind: 'snapshot' }>;
export type RemoteInteraction = z.infer<typeof remoteInteractionSchema>;
export type RemoteMessage = z.infer<typeof remoteMessageSchema>;
export const REMOTE_SESSION_BYTES = 48 * 1024;
export function isRemoteMutation(request: RemoteSessionRequest): boolean {
  return ['start', 'send', 'respond', 'stop'].includes(request.kind);
}
