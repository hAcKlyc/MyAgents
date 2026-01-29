/**
 * Moonshot Provider Tests
 *
 * Tests specific to Moonshot API mode.
 * Requires valid API key in ~/.myagents/config.json.
 *
 * Run: bun test src/server/__tests__/provider-moonshot.test.ts
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import {
  PROVIDERS,
  TEST_TIMEOUT,
  TIMEOUT_BUFFER,
  SIMPLE_PROMPT,
} from './fixtures/test-env';
import {
  runTestQuery,
  assertQuerySuccess,
  assertResponseContains,
} from './setup';

describe('Moonshot Provider Tests', () => {
  const provider = PROVIDERS.moonshot;
  const isAvailable = provider.available;

  beforeAll(() => {
    console.log(`[moonshot] Provider available: ${isAvailable}`);
    console.log(`[moonshot] Model: ${provider.config.model}`);
    console.log(`[moonshot] Base URL: ${provider.config.baseUrl}`);
    if (!isAvailable) {
      console.warn('[moonshot] API key not found in ~/.myagents/config.json');
    }
  });

  describe('API Key Mode', () => {
    it.skipIf(!isAvailable)('should authenticate via API key', async () => {
      const result = await runTestQuery({
        provider: provider.config,
        prompt: SIMPLE_PROMPT,
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      expect(result.sessionId).toBeTruthy();
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);

    it.skipIf(!isAvailable)('should use kimi-k2.5 model', async () => {
      // Verify we're using the K2.5 model
      expect(provider.config.model).toBe('kimi-k2.5');

      const result = await runTestQuery({
        provider: provider.config,
        prompt: 'Reply with exactly "OK" and nothing else.',
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      expect(result.assistantResponse).toBeTruthy();
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });

  describe('Anthropic Compatibility', () => {
    it.skipIf(!isAvailable)('should work with Anthropic-compatible API', async () => {
      // Verify base URL is Anthropic-compatible endpoint
      expect(provider.config.baseUrl).toContain('/anthropic');

      const result = await runTestQuery({
        provider: provider.config,
        prompt: 'What is 1 + 1? Reply with just the number.',
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      assertResponseContains(result, '2');
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });

  describe('Response Quality', () => {
    it.skipIf(!isAvailable)('should follow instructions', async () => {
      const result = await runTestQuery({
        provider: provider.config,
        prompt: 'Reply with exactly the word "HELLO" in uppercase, nothing else.',
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      assertResponseContains(result, 'HELLO');
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);

    it.skipIf(!isAvailable)('should handle Chinese prompts', async () => {
      const result = await runTestQuery({
        provider: provider.config,
        prompt: '用中文回复"你好"两个字，不要其他内容。',
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      assertResponseContains(result, '你好');
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });

  describe('Error Handling', () => {
    it('should handle invalid API key error gracefully', async () => {
      // Test with invalid API key - this should always run regardless of provider availability
      const result = await runTestQuery({
        provider: {
          ...provider.config,
          apiKey: 'invalid-api-key-12345',
        },
        prompt: SIMPLE_PROMPT,
        timeoutMs: TEST_TIMEOUT,
      });

      // Should error with authentication failure
      expect(result.hasError).toBe(true);
      expect(result.errorMessage).toBeDefined();
      // The error message should indicate authentication issue
      expect(
        result.errorMessage?.toLowerCase().includes('auth') ||
        result.errorMessage?.toLowerCase().includes('401') ||
        result.errorMessage?.toLowerCase().includes('invalid') ||
        result.errorMessage?.toLowerCase().includes('unauthorized')
      ).toBe(true);
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });
});
