import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SDK_BUILTIN_TOOLS, SDK_EXCLUDED_BUILTIN_TOOLS } from './sdk-builtin-tools';

describe('Claude Agent SDK builtin catalog', () => {
  it('keeps the product-owned 29-tool catalog exact and duplicate-free', () => {
    expect(SDK_BUILTIN_TOOLS).toEqual([
      'Read',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Glob',
      'Grep',
      'Bash',
      'PowerShell',
      'WebFetch',
      'WebSearch',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
      'Skill',
      'Agent',
      'Task',
      'TaskStop',
      'SendMessage',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'Monitor',
      'ReportFindings',
      'Workflow',
      'ScheduleWakeup',
      'EnterWorktree',
      'ExitWorktree',
    ]);
    expect(new Set(SDK_BUILTIN_TOOLS).size).toBe(29);
    expect(SDK_BUILTIN_TOOLS).not.toContain('TaskOutput');
  });

  it('does not expose any product-excluded builtin', () => {
    expect(SDK_EXCLUDED_BUILTIN_TOOLS).toHaveLength(5);
    for (const tool of SDK_EXCLUDED_BUILTIN_TOOLS) {
      expect(SDK_BUILTIN_TOOLS).not.toContain(tool);
    }
  });

  it('keeps control-plane queries tool-free and preserves the catalog fallback for ordinary product sessions', () => {
    for (const relativePath of [
      'provider-verify.ts',
      'subscription-auth.ts',
      'title-generator.ts',
      'official-tools/vision.ts',
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      const queryCount = source.match(/\bquery\(\{/g)?.length ?? 0;
      const disabledToolCount = source.match(/\btools:\s*\[\]/g)?.length ?? 0;
      expect(queryCount, `${relativePath} should contain a production SDK query`).toBeGreaterThan(0);
      expect(disabledToolCount, `${relativePath} must disable tools on every control query`).toBeGreaterThanOrEqual(queryCount);
    }

    const sessionSource = readFileSync(new URL('agent-session.ts', import.meta.url), 'utf8');
    expect(sessionSource).toMatch(/\btools:\s*launchModelOnlyCloudBot\s*\?\s*\[\s*\]\s*:\s*\[\s*\.\.\.SDK_BUILTIN_TOOLS\s*\]/);
  });

  it('closes the validated cloud-model Bot tool surface before inherited permission rules', () => {
    const sessionSource = readFileSync(new URL('agent-session.ts', import.meta.url), 'utf8');
    expect(sessionSource).toMatch(/const launchModelOnlyCloudBot\s*=\s*launchHostBotBootstrap\?\.cloud_model\s*!==\s*undefined/);
    expect(sessionSource).toMatch(/\ballowedTools:\s*launchModelOnlyCloudBot\s*\?\s*\[\s*\]\s*:/);
    expect(sessionSource).toMatch(/canUseTool:\s*async[^]*?=>\s*\{\s*if\s*\(launchModelOnlyCloudBot\)\s*return\s*\{\s*behavior:\s*'deny'[^}]*interrupt:\s*true/);
  });
});
