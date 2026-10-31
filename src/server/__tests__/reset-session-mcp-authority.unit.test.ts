import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sse')>();
  return {
    ...actual,
    broadcast: vi.fn(),
    broadcastLive: vi.fn(),
  };
});

import {
  getMcpServers,
  initializeAgent,
  resetSession,
} from '../agent-session';
import {
  resetConfigForTest,
  setCurrentMcpServers,
} from '../builtin-session/config';
import {
  getPreWarmTimer,
  resetLifecycleForTest,
  setPreWarmDisabled,
} from '../builtin-session/lifecycle';

let scratch: string;
let workspacePath: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

describe('#513 — reset uses current MCP authority before pre-warm', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    scratch = mkdtempSync(join(tmpdir(), 'myagents-reset-mcp-'));
    workspacePath = join(scratch, 'workspace');
    mkdirSync(join(scratch, '.myagents'), { recursive: true });
    mkdirSync(workspacePath, { recursive: true });

    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = scratch;
    process.env.USERPROFILE = scratch;

    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [
        {
          id: 'current',
          name: 'Current',
          type: 'stdio',
          command: 'current-command',
          isBuiltin: false,
        },
        {
          id: 'outgoing-only',
          name: 'Outgoing only',
          type: 'stdio',
          command: 'removed-command',
          isBuiltin: false,
        },
      ],
      mcpEnabledServers: ['current'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project',
      name: 'Project',
      path: workspacePath,
      mcpEnabledServers: ['current'],
    }]);

    resetLifecycleForTest();
    resetConfigForTest();
    await initializeAgent(workspacePath, null, undefined, { preWarmDisabled: true });
    setCurrentMcpServers([
      {
        id: 'current',
        name: 'Current',
        type: 'stdio',
        command: 'stale-command',
        isBuiltin: false,
      },
      {
        id: 'outgoing-only',
        name: 'Outgoing only',
        type: 'stdio',
        command: 'removed-command',
        isBuiltin: false,
      },
    ]);
    setPreWarmDisabled(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    resetLifecycleForTest();
    resetConfigForTest();
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    rmSync(scratch, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('replaces outgoing selection and definitions while the new pre-warm is still pending', async () => {
    await resetSession();

    expect(getPreWarmTimer()).not.toBeNull();
    expect(getMcpServers()).toEqual([
      expect.objectContaining({ id: 'current', command: 'current-command' }),
    ]);
  });

  it('resets from Agent defaults even when the compatibility Project selects a different server', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{ id: 'owner', name: 'Owner', workspacePath, mcpEnabledServers: ['agent-selected'] }],
      mcpServers: [
        { id: 'agent-selected', name: 'Agent', type: 'stdio', command: 'agent-command' },
        { id: 'project-selected', name: 'Project', type: 'stdio', command: 'project-command' },
      ],
      mcpEnabledServers: ['agent-selected', 'project-selected'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project', name: 'Project', path: workspacePath, agentId: 'owner', mcpEnabledServers: ['project-selected'],
    }]);
    await resetSession();
    expect(getMcpServers()).toEqual([expect.objectContaining({ id: 'agent-selected', command: 'agent-command' })]);
  });
});
