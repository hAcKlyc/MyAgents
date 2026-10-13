import { APP_CLI_NAME } from '../../shared/appProfile';
import { cancellableFetch } from './cancellation';
import { readLoopbackJson } from './loopback-response';
import {
  INTERNAL_CLI_TOKEN_ENV,
  INTERNAL_CLI_TOKEN_HEADER,
} from '../../shared/externalCliCapabilities';

export const ADMIN_LOOPBACK_TIMEOUT_MS = 10_000;

const MGMT_PORT = process.env.MYAGENTS_MANAGEMENT_PORT;
const SIDECAR_GENERATION = process.env.MYAGENTS_SIDECAR_GENERATION;

export function managementRequestHeaders(): Record<string, string> {
  const internalToken = process.env[INTERNAL_CLI_TOKEN_ENV]?.trim();
  return {
    'Content-Type': 'application/json',
    ...(internalToken ? { [INTERNAL_CLI_TOKEN_HEADER]: internalToken } : {}),
    ...(SIDECAR_GENERATION
      ? { 'X-MyAgents-Sidecar-Generation': SIDECAR_GENERATION }
      : {}),
  };
}

export async function managementApi(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
  requestOptions?: { timeoutMs?: number; parentSignal?: AbortSignal },
): Promise<Record<string, unknown>> {
  if (!MGMT_PORT) {
    return {
      ok: false,
      code: 'management_unavailable',
      error: 'Management API not available (app may still be starting)',
      recoveryHint: {
        recoveryCommand: `${APP_CLI_NAME} status`,
        message: 'Check whether the app backend is fully up; if not, retry in a few seconds.',
      },
    };
  }
  const url = `http://127.0.0.1:${MGMT_PORT}${path}`;
  const options: RequestInit = {
    method,
    headers: managementRequestHeaders(),
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }
  try {
    const resp = await cancellableFetch(url, options, {
      timeoutMs: requestOptions?.timeoutMs ?? ADMIN_LOOPBACK_TIMEOUT_MS,
      parentSignal: requestOptions?.parentSignal,
    });
    return await readLoopbackJson(resp, 'Management API');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: method === 'POST' ? 'transport_outcome_unknown' : 'management_unavailable',
      error: `Management API unreachable: ${msg}`,
      recoveryHint: {
        recoveryCommand: `${APP_CLI_NAME} status`,
        message: 'Check backend health; restart the app if the problem persists.',
      },
    };
  }
}

export type ManagedOAuthResolveIntent =
  | { reason: 'request' }
  | { reason: 'auth_recovery'; rejectedCredentialVersion: number }
  | { reason: 'reject'; rejectedCredentialVersion: number }
  | { reason: 'report'; rejectedCredentialVersion: number; httpStatus: number };

export type ManagedOAuthCredential = {
  accessToken: string;
  credentialVersion: number;
};

export type ManagedOAuthPurpose =
  | { purpose: 'execution' }
  | { purpose: 'verification'; expectedLineage: string };

const MANAGED_OAUTH_TIMEOUT_MS = 90_000;

function managementErrorMessage(result: Record<string, unknown>): string {
  const error = result.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return 'Managed OAuth credential is unavailable';
}

export async function resolveManagedOAuthCredential(
  providerId: string,
  intent: ManagedOAuthResolveIntent,
  parentSignal?: AbortSignal,
  purpose: ManagedOAuthPurpose = { purpose: 'execution' },
): Promise<ManagedOAuthCredential | undefined> {
  if (providerId !== 'xai-sub') {
    throw new Error(`Unsupported managed OAuth provider: ${providerId}`);
  }
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (!sidecarId) {
    throw new Error('Managed OAuth requires a Sidecar process identity');
  }
  const result = await managementApi(
    '/api/grok/bearer',
    'POST',
    {
      sidecarId,
      reason: intent.reason,
      ...purpose,
      ...('rejectedCredentialVersion' in intent
        ? { rejectedCredentialVersion: intent.rejectedCredentialVersion }
        : {}),
      ...('httpStatus' in intent ? { httpStatus: intent.httpStatus } : {}),
    },
    { timeoutMs: MANAGED_OAUTH_TIMEOUT_MS, parentSignal },
  );
  if (result.ok !== true) {
    throw new Error(managementErrorMessage(result));
  }
  if (intent.reason === 'reject' || intent.reason === 'report') return undefined;
  if (typeof result.accessToken !== 'string' || !result.accessToken) {
    throw new Error('Managed OAuth response did not include an access token');
  }
  if (typeof result.credentialVersion !== 'number' || result.credentialVersion <= 0) {
    throw new Error('Managed OAuth response did not include a credential version');
  }
  return {
    accessToken: result.accessToken,
    credentialVersion: result.credentialVersion,
  };
}
