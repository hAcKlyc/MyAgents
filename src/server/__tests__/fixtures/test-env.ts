/**
 * Test environment configuration for SDK E2E tests
 *
 * Provider configurations for testing:
 * - Anthropic: Uses subscription credentials from ~/.claude.json
 * - Moonshot: Uses API key from ~/.myagents/config.json
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ===== Provider Types =====

export type AuthType = 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  authType?: AuthType;
  model: string;
  isSubscription: boolean;
}

// ===== Configuration Loaders =====

/**
 * Load Moonshot API key from ~/.myagents/config.json
 */
function loadMoonshotApiKey(): string | undefined {
  const configPath = join(homedir(), '.myagents', 'config.json');

  if (!existsSync(configPath)) {
    console.warn('[test-env] ~/.myagents/config.json not found');
    return undefined;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as {
      providerApiKeys?: Record<string, string>;
    };
    return config.providerApiKeys?.moonshot;
  } catch (error) {
    // Only log error message, not full stack trace which may expose file paths
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[test-env] Failed to load Moonshot API key:', message);
    return undefined;
  }
}

/**
 * Check if Anthropic subscription is available
 */
function hasAnthropicSubscription(): boolean {
  const claudeJsonPath = join(homedir(), '.claude.json');

  if (!existsSync(claudeJsonPath)) {
    return false;
  }

  try {
    const content = readFileSync(claudeJsonPath, 'utf-8');
    const config = JSON.parse(content) as {
      oauthAccount?: { accountUuid?: string };
    };
    return !!(config.oauthAccount?.accountUuid);
  } catch {
    return false;
  }
}

// ===== Provider Configurations =====

/**
 * Anthropic subscription provider config
 * Uses default Claude credentials from ~/.claude.json
 * Model IDs should match src/renderer/config/types.ts
 */
export const ANTHROPIC_CONFIG: ProviderConfig = {
  id: 'anthropic-sub',
  name: 'Anthropic (Subscription)',
  model: 'claude-haiku-4-5-20251001', // Haiku 4.5 - fast and cheap for testing
  isSubscription: true,
  // No baseUrl/apiKey - uses subscription auth
};

/**
 * Moonshot provider config
 * Uses API key from ~/.myagents/config.json
 * authType: 'auth_token' matches src/renderer/config/types.ts
 */
export const MOONSHOT_CONFIG: ProviderConfig = {
  id: 'moonshot',
  name: 'Moonshot',
  baseUrl: 'https://api.moonshot.cn/anthropic',
  apiKey: loadMoonshotApiKey(),
  authType: 'auth_token', // Moonshot uses AUTH_TOKEN header
  model: 'kimi-k2.5',
  isSubscription: false,
};

// ===== Provider Availability =====

export const PROVIDERS = {
  anthropic: {
    config: ANTHROPIC_CONFIG,
    available: hasAnthropicSubscription(),
  },
  moonshot: {
    config: MOONSHOT_CONFIG,
    available: !!MOONSHOT_CONFIG.apiKey,
  },
};

/**
 * Get available providers for testing
 */
export function getAvailableProviders(): ProviderConfig[] {
  const available: ProviderConfig[] = [];

  if (PROVIDERS.anthropic.available) {
    available.push(PROVIDERS.anthropic.config);
  }

  if (PROVIDERS.moonshot.available) {
    available.push(PROVIDERS.moonshot.config);
  }

  return available;
}

/**
 * Skip test if provider is not available
 */
export function skipIfUnavailable(providerId: 'anthropic' | 'moonshot'): void {
  const provider = PROVIDERS[providerId];
  if (!provider.available) {
    console.log(`[test] Skipping: ${provider.config.name} not configured`);
  }
}

// ===== Test Helpers =====

/** Base timeout for API calls (60 seconds) */
export const TEST_TIMEOUT = 60_000;

/** Extra time buffer for test setup/teardown (5 seconds) */
export const TIMEOUT_BUFFER = 5_000;

/** Multiplier for tool-related tests that need more time */
export const TOOL_TIMEOUT_MULTIPLIER = 2;

/** Current working directory for tests */
export const TEST_CWD = process.cwd();

/**
 * Simple test prompt that should complete quickly
 */
export const SIMPLE_PROMPT = 'Reply with exactly "OK" and nothing else.';

/**
 * Tool use test prompt
 */
export const TOOL_PROMPT = 'Use the Read tool to read the file at ./package.json and tell me the project name.';
