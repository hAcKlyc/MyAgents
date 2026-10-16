import { z } from 'zod';

import { managementApi } from './utils/management-api-client';

const connection = z.string().min(1).max(200).refine(value =>
  value === value.trim() && !/\p{Cc}/u.test(value),
);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(value => value.toLowerCase());
const schemas = {
  status: z.object({}).strict(),
  login: z.object({ connectionId: connection, expectedRevision: revision }).strict(),
  poll: z.object({ attemptId: uuid }).strict(),
  cancel: z.object({ attemptId: uuid }).strict(),
  restore: z.object({ connectionId: connection, expectedRevision: revision, operationId: uuid }).strict(),
  'cancel-restore': z.object({ operationId: uuid }).strict(),
};

/** Native registry/login/credential owners remain authoritative. This adapter
 * accepts only the public contract, never credentials, issuer or caller IDs.
 * Admission and Session scope are checked by the enclosing Admin API before
 * this handler; managementApi carries the App capability and generation. */
export async function handleNetworkCli(
  action: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!Object.hasOwn(schemas, action)) return {
    success: false, code: 'ARGUMENT_INVALID', error: 'Unknown network command.',
  };
  const parsed = schemas[action as keyof typeof schemas].safeParse(payload);
  if (!parsed.success) return {
    success: false, code: 'ARGUMENT_INVALID', error: 'Invalid network command arguments.',
  };
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (!sidecarId) return {
    success: false, code: 'NETWORK_CLI_OWNER_UNAVAILABLE',
    error: 'The network owner is unavailable; inspect network status before another action.',
  };
  const result = await managementApi('/api/agent-network/cli', 'POST', {
    sidecarId, action, ...parsed.data,
  }, { timeoutMs: action === 'restore' ? 40_000 : action === 'login' || action === 'poll' ? 80_000 : 10_000, parentSignal: signal })
    .catch((): Record<string, unknown> => ({ ok: false }));
  const native = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  if (native.ok === true && native.data !== undefined) return { success: true, data: native.data };
  const nativeError = native.error;
  const nativeCode = nativeError && typeof nativeError === 'object'
    ? (nativeError as Record<string, unknown>).code : native.code;
  const code = typeof nativeCode === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(nativeCode)
    ? nativeCode : 'NETWORK_CLI_OWNER_UNAVAILABLE';
  return {
    success: false, code,
    error: 'Network operation did not complete. Inspect network status and the operation or attempt ID; do not automatically repeat mutations.',
  };
}
