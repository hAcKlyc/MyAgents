/**
 * Anthropic Provider Tests
 *
 * Tests specific to Anthropic subscription mode.
 * Requires valid ~/.claude.json with OAuth account.
 *
 * Run: bun test src/server/__tests__/provider-anthropic.test.ts
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import {
  PROVIDERS,
  TEST_TIMEOUT,
  TIMEOUT_BUFFER,
  TOOL_TIMEOUT_MULTIPLIER,
  SIMPLE_PROMPT,
} from './fixtures/test-env';
import {
  runTestQuery,
  assertQuerySuccess,
  assertResponseContains,
} from './setup';

describe('Anthropic Provider Tests', () => {
  const provider = PROVIDERS.anthropic;
  const isAvailable = provider.available;

  beforeAll(() => {
    console.log(`[anthropic] Provider available: ${isAvailable}`);
    console.log(`[anthropic] Model: ${provider.config.model}`);
  });

  describe('Subscription Mode', () => {
    it.skipIf(!isAvailable)('should authenticate via subscription credentials', async () => {
      const result = await runTestQuery({
        provider: provider.config,
        prompt: SIMPLE_PROMPT,
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      expect(result.sessionId).toBeTruthy();
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);

    it.skipIf(!isAvailable)('should use Haiku model for cost efficiency', async () => {
      // Verify we're using the fast/cheap Haiku model
      expect(provider.config.model).toContain('haiku');

      const result = await runTestQuery({
        provider: provider.config,
        prompt: 'What model are you? Reply briefly.',
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      expect(result.assistantResponse).toBeTruthy();
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });

  describe('Response Quality', () => {
    it.skipIf(!isAvailable)('should follow instructions precisely', async () => {
      const result = await runTestQuery({
        provider: provider.config,
        prompt: 'Reply with exactly the word "HELLO" in uppercase, nothing else.',
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      assertResponseContains(result, 'HELLO');
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);

    it.skipIf(!isAvailable)('should handle code-related queries', async () => {
      const result = await runTestQuery({
        provider: provider.config,
        prompt: 'What is the output of: console.log(1 + 1) in JavaScript? Reply with just the number.',
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      assertResponseContains(result, '2');
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });

  describe('Session Management', () => {
    it.skipIf(!isAvailable)('should generate unique session IDs', async () => {
      const result1 = await runTestQuery({
        provider: provider.config,
        prompt: SIMPLE_PROMPT,
        timeoutMs: TEST_TIMEOUT,
      });

      const result2 = await runTestQuery({
        provider: provider.config,
        prompt: SIMPLE_PROMPT,
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result1);
      assertQuerySuccess(result2);

      // Each query should get a unique session ID
      expect(result1.sessionId).not.toBe(result2.sessionId);
    }, TEST_TIMEOUT * TOOL_TIMEOUT_MULTIPLIER + TIMEOUT_BUFFER);
  });
});
