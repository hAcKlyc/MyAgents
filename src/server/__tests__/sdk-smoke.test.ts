/**
 * SDK Smoke Tests
 *
 * Basic functionality tests for Claude Agent SDK.
 * Tests run with Anthropic subscription (default provider).
 *
 * Run: bun test src/server/__tests__/sdk-smoke.test.ts
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import {
  PROVIDERS,
  TEST_TIMEOUT,
  TIMEOUT_BUFFER,
  TOOL_TIMEOUT_MULTIPLIER,
  SIMPLE_PROMPT,
  TOOL_PROMPT,
} from './fixtures/test-env';
import {
  runTestQuery,
  assertQuerySuccess,
  assertResponseContains,
  assertToolCalled,
} from './setup';

describe('SDK Smoke Tests', () => {
  const provider = PROVIDERS.anthropic;
  const isAvailable = provider.available;

  beforeAll(() => {
    if (!isAvailable) {
      console.warn('[sdk-smoke] Anthropic subscription not available, tests will be skipped');
    }
  });

  describe('Session Initialization', () => {
    it.skipIf(!isAvailable)('should create a session and receive session_id', async () => {
      const result = await runTestQuery({
        provider: provider.config,
        prompt: SIMPLE_PROMPT,
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      expect(result.sessionId).toBeTruthy();
      expect(typeof result.sessionId).toBe('string');
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });

  describe('Message Send/Receive', () => {
    it.skipIf(!isAvailable)('should send a message and receive a response', async () => {
      const result = await runTestQuery({
        provider: provider.config,
        prompt: SIMPLE_PROMPT,
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      expect(result.assistantResponse).toBeTruthy();
      // The response should contain "OK" as requested
      assertResponseContains(result, 'OK');
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);

    it.skipIf(!isAvailable)('should handle longer prompts', async () => {
      const longPrompt = 'What is 2 + 2? Reply with just the number.';

      const result = await runTestQuery({
        provider: provider.config,
        prompt: longPrompt,
        timeoutMs: TEST_TIMEOUT,
      });

      assertQuerySuccess(result);
      expect(result.assistantResponse).toBeTruthy();
      assertResponseContains(result, '4');
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });

  describe('Tool Calls', () => {
    it.skipIf(!isAvailable)('should execute Read tool and return result', async () => {
      const toolTimeout = TEST_TIMEOUT * TOOL_TIMEOUT_MULTIPLIER;

      const result = await runTestQuery({
        provider: provider.config,
        prompt: TOOL_PROMPT,
        maxTurns: 3, // Allow multiple turns for tool execution
        timeoutMs: toolTimeout,
      });

      assertQuerySuccess(result);

      // Should have called the Read tool
      assertToolCalled(result, 'Read');

      // Response should mention the project name from package.json
      expect(result.assistantResponse).toBeTruthy();
      assertResponseContains(result, 'myagents');
    }, TEST_TIMEOUT * TOOL_TIMEOUT_MULTIPLIER + TIMEOUT_BUFFER);
  });

  describe('Error Handling', () => {
    it.skipIf(!isAvailable)('should handle invalid model gracefully', async () => {
      const result = await runTestQuery({
        provider: {
          ...provider.config,
          model: 'invalid-model-name-12345',
        },
        prompt: SIMPLE_PROMPT,
        timeoutMs: TEST_TIMEOUT,
      });

      // Should error with model not found
      expect(result.hasError).toBe(true);
      expect(result.messages.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT + TIMEOUT_BUFFER);
  });
});
