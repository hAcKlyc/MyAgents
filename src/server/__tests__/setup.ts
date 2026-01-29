/**
 * Test setup and utilities for SDK E2E tests
 */

import { createRequire } from 'module';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  query,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProviderConfig } from './fixtures/test-env';

const requireModule = createRequire(import.meta.url);

// ===== Type Guards for SDK Messages =====

/** Type guard for system init message */
function isSystemInitMessage(msg: SDKMessage): msg is SDKSystemMessage {
  return msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init';
}

/** Type guard for assistant message */
function isAssistantMessage(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === 'assistant' && 'message' in msg;
}

/** Type guard for result message */
function isResultMessage(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === 'result';
}

/** Content block type for assistant messages */
interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
}

// ===== SDK Path Resolution =====

/**
 * Resolve the path to Claude Agent SDK CLI
 * Same logic as agent-session.ts
 */
export function resolveClaudeCodeCli(): string {
  try {
    const cliPath = requireModule.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
    if (cliPath.includes('app.asar')) {
      const unpackedPath = cliPath.replace('app.asar', 'app.asar.unpacked');
      if (existsSync(unpackedPath)) {
        return unpackedPath;
      }
    }
    return cliPath;
  } catch (error) {
    // Fallback for bundled environment
    const bundledPath = join(process.cwd(), 'claude-agent-sdk', 'cli.js');
    if (existsSync(bundledPath)) {
      return bundledPath;
    }
    throw error;
  }
}

// ===== Environment Builder =====

/**
 * Build environment for SDK query based on provider config
 * Follows the same logic as agent-session.ts buildClaudeSessionEnv()
 */
export function buildTestEnv(provider: ProviderConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || '',
    USER: process.env.USER || '',
    PATH: process.env.PATH || '',
  };

  // For third-party providers, set API key and base URL
  if (!provider.isSubscription) {
    if (provider.baseUrl) {
      env.ANTHROPIC_BASE_URL = provider.baseUrl;
    }

    if (provider.apiKey) {
      const authType = provider.authType ?? 'both';

      switch (authType) {
        case 'auth_token':
          env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
          delete env.ANTHROPIC_API_KEY;
          break;
        case 'api_key':
          delete env.ANTHROPIC_AUTH_TOKEN;
          env.ANTHROPIC_API_KEY = provider.apiKey;
          break;
        case 'auth_token_clear_api_key':
          env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
          env.ANTHROPIC_API_KEY = '';
          break;
        case 'both':
        default:
          env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
          env.ANTHROPIC_API_KEY = provider.apiKey;
          break;
      }
    }
  } else {
    // Subscription mode - clear any third-party settings
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  }

  return env;
}

// ===== Test Query Builder =====

export interface TestQueryOptions {
  provider: ProviderConfig;
  prompt: string;
  cwd?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface TestQueryResult {
  sessionId: string | null;
  messages: SDKMessage[];
  hasError: boolean;
  errorMessage?: string;
  assistantResponse?: string;
  toolCalls: Array<{
    name: string;
    id: string;
  }>;
}

/**
 * Run a test query and collect results
 */
export async function runTestQuery(options: TestQueryOptions): Promise<TestQueryResult> {
  const {
    provider,
    prompt,
    cwd = process.cwd(),
    maxTurns = 1,
    timeoutMs = 60_000,
  } = options;

  const result: TestQueryResult = {
    sessionId: null,
    messages: [],
    hasError: false,
    toolCalls: [],
  };

  // Create a simple prompt generator
  async function* promptGenerator() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: prompt },
      parent_tool_use_id: null,
      session_id: 'test-session',
    };
  }

  const env = buildTestEnv(provider);
  const cliPath = resolveClaudeCodeCli();

  console.log(`[test] Starting query with provider: ${provider.name}, model: ${provider.model}`);

  // For subscription mode, we need 'user' setting source to read ~/.claude.json OAuth credentials
  // For API key mode, we don't need any setting sources
  const settingSources: ('user' | 'project')[] = provider.isSubscription ? ['user'] : [];

  const testQuery = query({
    prompt: promptGenerator(),
    options: {
      maxTurns,
      model: provider.model,
      settingSources,
      pathToClaudeCodeExecutable: cliPath,
      executable: 'bun',
      env,
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      stderr: (message: string) => {
        console.log(`[stderr] ${message}`);
      },
    },
  });

  // Wrap in timeout with proper cleanup
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Test query timeout')), timeoutMs);
  });

  try {
    const queryPromise = (async () => {
      for await (const message of testQuery) {
        result.messages.push(message);

        // Extract session ID from system init message
        if (isSystemInitMessage(message)) {
          result.sessionId = message.session_id;
        }

        // Extract assistant response and tool calls
        if (isAssistantMessage(message)) {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as ContentBlock;
              if (b.type === 'text' && b.text) {
                result.assistantResponse = (result.assistantResponse || '') + b.text;
              }
              if (b.type === 'tool_use' && b.name) {
                result.toolCalls.push({ name: b.name, id: b.id || '' });
              }
            }
          }
        }

        // Check for errors in result message
        if (isResultMessage(message)) {
          if (message.is_error) {
            result.hasError = true;
            // SDKResultMessage has 'result' field with error message when is_error is true
            result.errorMessage = 'result' in message ? String(message.result) : 'Unknown error';
          }
        }
      }
    })();

    await Promise.race([queryPromise, timeoutPromise]);
  } catch (error) {
    result.hasError = true;
    result.errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    // Clean up timeout to prevent resource leak
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }

  console.log(`[test] Query complete. Session: ${result.sessionId}, Error: ${result.hasError}`);

  return result;
}

// ===== Assertion Helpers =====

/**
 * Assert that a query completed successfully with a session ID
 */
export function assertQuerySuccess(result: TestQueryResult): void {
  if (result.hasError) {
    throw new Error(`Query failed: ${result.errorMessage}`);
  }
  if (!result.sessionId) {
    throw new Error('No session ID received');
  }
}

/**
 * Assert that assistant responded with expected text
 */
export function assertResponseContains(result: TestQueryResult, expected: string): void {
  if (!result.assistantResponse) {
    throw new Error('No assistant response received');
  }
  if (!result.assistantResponse.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(`Response does not contain "${expected}". Got: ${result.assistantResponse.slice(0, 200)}`);
  }
}

/**
 * Assert that a specific tool was called
 */
export function assertToolCalled(result: TestQueryResult, toolName: string): void {
  const called = result.toolCalls.some(t => t.name === toolName);
  if (!called) {
    const calledTools = result.toolCalls.map(t => t.name).join(', ') || 'none';
    throw new Error(`Tool "${toolName}" was not called. Called tools: ${calledTools}`);
  }
}
