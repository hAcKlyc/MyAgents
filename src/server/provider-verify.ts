/**
 * Provider verification utilities
 * Verifies API key validity by sending a test request
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeCodeCli, buildClaudeSessionEnv } from './agent-session';
// Subscription types (keep in sync with src/renderer/types/subscription.ts)
export interface SubscriptionInfo {
  accountUuid?: string;
  email?: string;
  displayName?: string;
  organizationName?: string;
}

export interface SubscriptionStatus {
  available: boolean;
  path?: string;
  info?: SubscriptionInfo;
}

// Shared error message parser for subscription verification
function parseSubscriptionError(errorText: string): string {
  if (errorText.includes('authentication') || errorText.includes('login') || errorText.includes('/login')) {
    return '登录已过期，请重新登录 (claude --login)';
  } else if (errorText.includes('forbidden') || errorText.includes('403')) {
    return '登录已过期，请重新登录 (claude --login)';
  } else if (errorText.includes('rate limit') || errorText.includes('429')) {
    return '请求频率限制，请稍后再试';
  } else if (errorText.includes('network') || errorText.includes('connect')) {
    return '网络连接失败';
  }
  return errorText.slice(0, 100) || '验证失败';
}

/**
 * Verify an API key by sending a test message to the provider
 * Uses the same authentication method as the Anthropic SDK:
 * - For Anthropic official: x-api-key header
 * - For third-party compatible APIs: Authorization Bearer header
 */
export async function verifyApiKey(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    // Build the API endpoint URL
    // Handle different baseUrl formats:
    // - https://api.anthropic.com -> /v1/messages
    // - https://api.xxx.com/anthropic -> /v1/messages (Anthropic-compatible)
    // - https://api.xxx.com/v1 -> /messages
    let messagesUrl: string;
    if (baseUrl.endsWith('/v1')) {
      messagesUrl = `${baseUrl}/messages`;
    } else if (baseUrl.endsWith('/v1/')) {
      messagesUrl = `${baseUrl}messages`;
    } else if (baseUrl.endsWith('/anthropic')) {
      // Anthropic-compatible endpoints like zhipu, moonshot
      messagesUrl = `${baseUrl}/v1/messages`;
    } else {
      messagesUrl = `${baseUrl}/v1/messages`;
    }

    console.log(`[api/provider/verify] Testing API key for ${messagesUrl} with model ${model}`);
    console.log(`[api/provider/verify] Request headers: Authorization: Bearer ${apiKey.slice(0, 8)}...`);

    // Third-party Anthropic-compatible APIs use Authorization: Bearer
    // Official Anthropic API uses x-api-key
    // We use Authorization: Bearer as it's the standard for third-party providers
    const requestBody = {
      model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'It\'s a test, directly reply "1"' }],
    };
    console.log(`[api/provider/verify] Request body:`, JSON.stringify(requestBody));

    const response = await fetch(messagesUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    console.log(`[api/provider/verify] Response status: ${response.status}`);

    if (response.ok) {
      return { success: true };
    }

    // Try to extract error message
    let errorMsg = `HTTP ${response.status}`;
    try {
      const responseText = await response.text();
      console.log(`[api/provider/verify] Error response body:`, responseText);
      try {
        const errorBody = JSON.parse(responseText) as { error?: { message?: string; type?: string }; message?: string };
        if (errorBody?.error?.message) {
          errorMsg = errorBody.error.message;
        } else if (errorBody?.message) {
          errorMsg = errorBody.message;
        }
        console.log(`[api/provider/verify] Parsed error:`, errorBody);
      } catch {
        // Not JSON, use raw text
        if (responseText) {
          errorMsg = responseText.slice(0, 200);
        }
      }
    } catch {
      // Ignore read errors
    }

    return { success: false, error: errorMsg };
  } catch (error) {
    console.error(`[api/provider/verify] Fetch error:`, error);
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return { success: false, error: '请求超时' };
      }
      return { success: false, error: error.message };
    }
    return { success: false, error: '未知错误' };
  }
}

/**
 * Check if Anthropic subscription credentials exist locally
 * Claude CLI stores OAuth account info in ~/.claude.json file
 */
export function checkAnthropicSubscription(): SubscriptionStatus {
  const claudeJsonPath = join(homedir(), '.claude.json');

  if (!existsSync(claudeJsonPath)) {
    return { available: false };
  }

  // Check if ~/.claude.json has oauthAccount field (indicates logged in)
  try {
    const content = readFileSync(claudeJsonPath, 'utf-8');
    const config = JSON.parse(content);

    if (config.oauthAccount && config.oauthAccount.accountUuid) {
      return {
        available: true,
        path: claudeJsonPath,
        info: {
          accountUuid: config.oauthAccount.accountUuid,
          email: config.oauthAccount.emailAddress,
          displayName: config.oauthAccount.displayName,
          organizationName: config.oauthAccount.organizationName,
        }
      };
    }
  } catch {
    // File exists but can't read/parse
  }

  return { available: false };
}

/**
 * Verify Anthropic subscription by sending a test request via SDK
 * Uses the same SDK path as normal chat requests
 * Returns success if the subscription is valid, or error message if not
 */
export async function verifySubscription(): Promise<{ success: boolean; error?: string }> {
  const TIMEOUT_MS = 30000; // 30 second timeout

  try {
    console.log('[subscription/verify] Starting SDK verification...');

    // Build environment for SDK (without provider override = use default Anthropic auth)
    const env = buildClaudeSessionEnv();
    console.log('[subscription/verify] Environment built');

    // Resolve SDK CLI path
    const cliPath = resolveClaudeCodeCli();
    console.log('[subscription/verify] CLI path:', cliPath);

    // Create a simple async generator that yields one message
    async function* simplePrompt() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: 'It\'s a test, directly reply "1"' },
        parent_tool_use_id: null,
        session_id: 'verify-session'
      };
    }

    // Use SDK query function with full configuration
    // Same settings as agent-session.ts for consistency
    const testQuery = query({
      prompt: simplePrompt(),
      options: {
        maxTurns: 1,
        settingSources: ['user'], // Only user settings (no project dir for verification)
        pathToClaudeCodeExecutable: cliPath,
        executable: 'bun',
        env,
      },
    });

    // Wrap in timeout with cleanup
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) => {
      timeoutId = setTimeout(() => resolve({ success: false, error: '验证超时，请检查网络连接' }), TIMEOUT_MS);
    });

    const verifyPromise = (async (): Promise<{ success: boolean; error?: string }> => {
      // Iterate through SDK messages to get result
      for await (const message of testQuery) {
        console.log(`[subscription/verify] SDK message type: ${message.type}`);

        // Check for error in any message type
        const msgAny = message as { error?: string; is_error?: boolean };

        if (message.type === 'result') {
          if (msgAny.is_error || msgAny.error) {
            const errorText = msgAny.error || '验证失败';
            console.log(`[subscription/verify] SDK error result: ${errorText}`);
            return { success: false, error: parseSubscriptionError(errorText) };
          }

          // Success - got a valid response
          console.log('[subscription/verify] SDK verification successful');
          return { success: true };
        }

        // Also check assistant message for errors
        if (message.type === 'assistant' && msgAny.error) {
          console.log(`[subscription/verify] SDK assistant error: ${msgAny.error}`);
          return { success: false, error: parseSubscriptionError(msgAny.error) };
        }
      }

      // If we get here without a result, something went wrong
      return { success: false, error: '验证未返回结果' };
    })();

    try {
      return await Promise.race([verifyPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

  } catch (error) {
    console.error('[subscription/verify] SDK error:', error);
    const errorMsg = error instanceof Error ? error.message : '验证失败';
    return { success: false, error: parseSubscriptionError(errorMsg) };
  }
}

/**
 * Get the current git branch for a directory
 * Returns undefined if not a git repository
 */
export function getGitBranch(cwd: string): string | undefined {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], // Suppress stderr
    });
    return branch.trim() || undefined;
  } catch {
    // Not a git repository or git not available
    return undefined;
  }
}
