import { APP_DATA_DIR_NAME } from '../shared/appProfile';
import { isUpdaterQaBuild } from '../shared/updaterQa';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildClaudeSessionEnv, resolveClaudeCodeCli } from './agent-session';
import type { ProviderEnv } from './provider-types';
import { ensureDirSync } from './utils/fs-utils';
import { createGuardedSdkQuery } from './utils/sdk-child-launch-guard';
import { sdkSubprocessUserMessage } from './utils/sdk-subprocess-diagnostics';
import { parseClaudeOAuthCallbackInput } from './subscription-auth-parser';
import { SUBSCRIPTION_PROVIDER_ID } from '../shared/config-types';

export type SubscriptionLoginStatus = 'idle' | 'starting' | 'waiting' | 'succeeded' | 'cancelled' | 'error';

export interface SubscriptionLoginState {
  status: SubscriptionLoginStatus;
  loginUrl?: string | null;
  manualUrl?: string | null;
  automaticUrl?: string | null;
  startedAt?: string | null;
  error?: string | null;
}

type ClaudeAuthStartResult = {
  // Verified against @anthropic-ai/claude-agent-sdk 0.3.220 runtime:
  // Query.claudeAuthenticate(true) resolves to `{ manualUrl, automaticUrl }`.
  // The installed sdk.d.ts currently omits this control-plane method.
  manualUrl?: unknown;
  automaticUrl?: unknown;
};

type ClaudeAuthQuery = Query & {
  claudeAuthenticate?: (loginWithClaudeAi: boolean) => Promise<ClaudeAuthStartResult>;
  claudeOAuthCallback?: (authorizationCode: string, state: string) => Promise<unknown>;
  claudeOAuthWaitForCompletion?: () => Promise<unknown>;
  close?: () => void;
};

type ActiveLoginAttempt = {
  query: ClaudeAuthQuery;
  stopPrompt: () => void;
};

const AUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const EMPTY_LOGIN_STATE: SubscriptionLoginState = {
  status: 'idle',
  loginUrl: null,
  manualUrl: null,
  automaticUrl: null,
  startedAt: null,
  error: null,
};

let currentState: SubscriptionLoginState = { ...EMPTY_LOGIN_STATE };
let activeAttempt: ActiveLoginAttempt | null = null;

function setState(next: SubscriptionLoginState): SubscriptionLoginState {
  currentState = { ...next };
  return getSubscriptionLoginState();
}

export function getSubscriptionLoginState(): SubscriptionLoginState {
  return { ...currentState };
}

function errorMessage(error: unknown): string {
  return sdkSubprocessUserMessage(error)
    ?? (error instanceof Error ? error.message : String(error));
}

function isActiveStatus(status: SubscriptionLoginStatus): boolean {
  return status === 'starting' || status === 'waiting';
}

function isAllowedClaudeLoginUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '::1'
      || hostname === '[::1]';
  } catch {
    return false;
  }
}

function pickLoginUrl(result: ClaudeAuthStartResult): {
  manualUrl: string | null;
  automaticUrl: string | null;
  loginUrl: string | null;
} {
  const manualUrl = isAllowedClaudeLoginUrl(result.manualUrl) ? result.manualUrl : null;
  const automaticUrl = isAllowedClaudeLoginUrl(result.automaticUrl) ? result.automaticUrl : null;
  const loginUrl = automaticUrl ?? manualUrl;
  return { manualUrl, automaticUrl, loginUrl };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function cleanupAttempt(attempt: ActiveLoginAttempt): void {
  attempt.stopPrompt();
  try { attempt.query.close?.(); } catch { /* ignore */ }
  try { void attempt.query.return(undefined as never); } catch { /* ignore */ }
}

function finishAttemptWithError(attempt: ActiveLoginAttempt, message: string): void {
  if (activeAttempt !== attempt) return;
  if (!isActiveStatus(currentState.status)) return;
  setState({
    ...currentState,
    status: 'error',
    error: message,
  });
  cleanupAttempt(attempt);
  activeAttempt = null;
}

function finishAttemptSucceeded(attempt: ActiveLoginAttempt): void {
  if (activeAttempt !== attempt) return;
  setState({
    ...currentState,
    status: 'succeeded',
    error: null,
  });
  cleanupAttempt(attempt);
  activeAttempt = null;
}

async function drainAuthMessages(attempt: ActiveLoginAttempt): Promise<void> {
  try {
    for await (const message of attempt.query) {
      if (!message || typeof message !== 'object') continue;
      const record = message as Record<string, unknown>;
      if (record.type !== 'auth_status') continue;
      const errorText = typeof record.error === 'string' ? record.error : undefined;
      if (errorText) {
        const outputText = Array.isArray(record.output)
          ? record.output.filter((item): item is string => typeof item === 'string').join('\n')
          : '';
        finishAttemptWithError(attempt, outputText ? `${errorText}\n${outputText}` : errorText);
        break;
      }
    }
  } catch (error) {
    if (activeAttempt === attempt && isActiveStatus(currentState.status)) {
      finishAttemptWithError(attempt, errorMessage(error));
    }
  }
}

async function waitForLoginCompletion(attempt: ActiveLoginAttempt): Promise<void> {
  try {
    if (!attempt.query.claudeOAuthWaitForCompletion) {
      throw new Error('当前 AgentSDK 不支持等待 Claude OAuth 登录完成。');
    }

    await withTimeout(
      attempt.query.claudeOAuthWaitForCompletion(),
      AUTH_WAIT_TIMEOUT_MS,
      'Claude 登录超时，请重新发起登录。',
    );

    finishAttemptSucceeded(attempt);
  } catch (error) {
    if (activeAttempt === attempt) {
      setState({
        ...currentState,
        status: 'error',
        error: errorMessage(error),
      });
    }
  } finally {
    if (activeAttempt === attempt) {
      cleanupAttempt(attempt);
      activeAttempt = null;
    }
  }
}

export async function startSubscriptionLogin(): Promise<SubscriptionLoginState> {
  if (isUpdaterQaBuild()) return { ...EMPTY_LOGIN_STATE, status: 'error', error: 'UPDATER_QA_EXECUTION_DISABLED' };
  if (activeAttempt && isActiveStatus(currentState.status)) {
    return getSubscriptionLoginState();
  }

  if (activeAttempt) {
    cleanupAttempt(activeAttempt);
    activeAttempt = null;
  }

  const startedAt = new Date().toISOString();
  setState({
    status: 'starting',
    loginUrl: null,
    manualUrl: null,
    automaticUrl: null,
    startedAt,
    error: null,
  });

  let shouldStopPrompt = false;
  const stopPrompt = () => {
    shouldStopPrompt = true;
  };

  // Auth control-plane APIs need a live SDK session without sending a user prompt.
  // eslint-disable-next-line require-yield
  async function* parkedPrompt(): AsyncGenerator<SDKUserMessage> {
    while (!shouldStopPrompt) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  try {
    const cliPath = resolveClaudeCodeCli();
    const cwd = join(homedir(), APP_DATA_DIR_NAME, 'projects');
    ensureDirSync(cwd);
    const officialSubscriptionProvider: ProviderEnv = { providerId: SUBSCRIPTION_PROVIDER_ID };
    const authQuery = await createGuardedSdkQuery(cliPath, () => query({
      prompt: parkedPrompt(),
      options: {
        maxTurns: 1,
        sessionId: randomUUID(),
        cwd,
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: cliPath,
        env: buildClaudeSessionEnv(officialSubscriptionProvider, undefined, {
          providerId: SUBSCRIPTION_PROVIDER_ID,
        }),
        systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
        includePartialMessages: false,
        persistSession: false,
        mcpServers: {},
        tools: [],
      },
    })) as ClaudeAuthQuery;

    const attempt: ActiveLoginAttempt = { query: authQuery, stopPrompt };
    activeAttempt = attempt;

    await withTimeout(
      authQuery.initializationResult(),
      30000,
      'AgentSDK 登录进程启动超时。',
    );

    if (!authQuery.claudeAuthenticate) {
      throw new Error('当前 AgentSDK 未暴露 Claude OAuth 登录入口。');
    }

    void drainAuthMessages(attempt);
    const loginResult = await authQuery.claudeAuthenticate(true);
    const urls = pickLoginUrl(loginResult);
    if (!urls.loginUrl) {
      throw new Error('AgentSDK 没有返回可用的 Claude 登录地址。');
    }

    setState({
      status: 'waiting',
      ...urls,
      startedAt,
      error: null,
    });
    void waitForLoginCompletion(attempt);
    return getSubscriptionLoginState();
  } catch (error) {
    if (activeAttempt) {
      cleanupAttempt(activeAttempt);
      activeAttempt = null;
    } else {
      stopPrompt();
    }
    return setState({
      status: 'error',
      loginUrl: null,
      manualUrl: null,
      automaticUrl: null,
      startedAt,
      error: errorMessage(error),
    });
  }
}

export async function submitSubscriptionLoginCode(input: string): Promise<SubscriptionLoginState> {
  if (isUpdaterQaBuild()) return { ...EMPTY_LOGIN_STATE, status: 'error', error: 'UPDATER_QA_EXECUTION_DISABLED' };
  const attempt = activeAttempt;
  if (!attempt || !isActiveStatus(currentState.status)) {
    return setState({
      ...currentState,
      status: 'error',
      error: '没有正在进行的 Claude 登录，请重新发起登录。',
    });
  }

  if (!attempt.query.claudeOAuthCallback) {
    return setState({
      ...currentState,
      status: 'error',
      error: '当前 AgentSDK 不支持提交 Claude OAuth 授权码。',
    });
  }

  let callbackInput: { authorizationCode: string; state: string };
  try {
    callbackInput = parseClaudeOAuthCallbackInput(
      input,
      currentState.automaticUrl ?? currentState.loginUrl ?? currentState.manualUrl,
    );
  } catch (error) {
    return setState({
      ...currentState,
      error: errorMessage(error),
    });
  }

  try {
    await withTimeout(
      attempt.query.claudeOAuthCallback(callbackInput.authorizationCode, callbackInput.state),
      30000,
      '提交 Claude 登录授权码超时，请重新发起登录。',
    );
    if (activeAttempt === attempt && isActiveStatus(currentState.status)) {
      setState({
        ...currentState,
        status: 'waiting',
        error: null,
      });
    }
    return getSubscriptionLoginState();
  } catch (error) {
    if (activeAttempt === attempt) {
      cleanupAttempt(attempt);
      activeAttempt = null;
    }
    return setState({
      ...currentState,
      status: 'error',
      error: errorMessage(error),
    });
  }
}

export function cancelSubscriptionLogin(expectedStartedAt?: string | null): SubscriptionLoginState {
  if (expectedStartedAt && currentState.startedAt !== expectedStartedAt) {
    return getSubscriptionLoginState();
  }

  if (activeAttempt && isActiveStatus(currentState.status)) {
    const attempt = activeAttempt;
    cleanupAttempt(attempt);
    activeAttempt = null;
    return setState({
      ...currentState,
      status: 'cancelled',
      error: null,
    });
  }

  if (isActiveStatus(currentState.status)) {
    return setState({
      ...currentState,
      status: 'cancelled',
      error: null,
    });
  }

  return getSubscriptionLoginState();
}
