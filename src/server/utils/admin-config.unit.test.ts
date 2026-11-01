import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAllMcpServers, getEffectiveMcpServers, resolveWorkspaceConfig } from './admin-config';

const scratchDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('server MCP catalogue merge', () => {
  it('uses Agent defaults rather than a divergent Project mirror for new and legacy execution', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'myagents-mcp-default-owner-'));
    scratchDirs.push(scratch);
    const configDir = join(scratch, '.myagents');
    mkdirSync(configDir);
    vi.stubEnv('HOME', scratch);
    const configPath = join(configDir, 'config.json');
    const config = {
      mcpServers: ['agent-only', 'project-only'].map(id => ({ id, name: id, type: 'stdio', command: 'node' })),
      mcpEnabledServers: ['agent-only', 'project-only'],
      agents: [{ id: 'owner', name: 'Owner', workspacePath: '/workspace', mcpEnabledServers: ['agent-only'] }],
    };
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(join(configDir, 'projects.json'), JSON.stringify([
      { id: 'project', path: '/workspace', agentId: 'owner', mcpEnabledServers: ['project-only'] },
    ]));
    expect(getEffectiveMcpServers('/workspace').map(server => server.id)).toEqual(['agent-only']);
    expect(resolveWorkspaceConfig('/workspace').mcpServers.map(server => server.id)).toEqual(['agent-only']);
    config.agents[0].mcpEnabledServers = [];
    writeFileSync(configPath, JSON.stringify(config));
    expect(getEffectiveMcpServers('/workspace')).toEqual([]);
  });

  it('preserves explicit Playwright args on the generic stdio preset', () => {
    const servers = getAllMcpServers({
      mcpServers: [],
      mcpEnabledServers: ['playwright'],
      mcpServerArgs: {
        playwright: ['--user-data-dir=/tmp/playwright-profile'],
      },
    });

    expect(servers.find((server) => server.id === 'playwright')).toMatchObject({
      command: 'npx',
      args: ['@playwright/mcp@0.0.68', '--user-data-dir=/tmp/playwright-profile'],
    });
    expect(servers.find((server) => server.id === 'myagents-browser')).toMatchObject({
      command: '__browser_host__',
      args: [],
    });
  });

  it('does not let persisted custom collisions shadow either built-in Browser preset', () => {
    const servers = getAllMcpServers({
      mcpServers: [
        { id: 'playwright', name: 'shadow', type: 'stdio', command: 'shadow', isBuiltin: false },
        { id: 'myagents-browser', name: 'shadow', type: 'stdio', command: 'shadow', isBuiltin: false },
      ],
      mcpEnabledServers: [],
    });

    expect(servers.find((server) => server.id === 'playwright')).toMatchObject({
      command: 'npx',
      isBuiltin: true,
    });
    expect(servers.find((server) => server.id === 'myagents-browser')).toMatchObject({
      command: '__browser_host__',
      isBuiltin: true,
    });
  });

  it('resolves owned Session IDs against current definitions and global enablement', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'myagents-admin-config-'));
    scratchDirs.push(scratch);
    const configDir = join(scratch, '.myagents');
    mkdirSync(configDir, { recursive: true });
    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', scratch);
    const configPath = join(configDir, 'config.json');
    const writeConfig = (enabledIds: string[], command: string): void => {
      writeFileSync(configPath, JSON.stringify({
        mcpServers: [
          { id: 'owned', name: 'Owned', type: 'stdio', command, isBuiltin: false },
          { id: 'workspace-default', name: 'Workspace default', type: 'stdio', command: 'workspace', isBuiltin: false },
        ],
        mcpEnabledServers: enabledIds,
      }), 'utf8');
    };
    const metadata = {
      configSnapshotAt: '2026-08-05T00:00:00.000Z',
      mcpEnabledServers: ['owned'],
    } as never;

    writeConfig(['owned', 'workspace-default'], 'current-command');
    expect(resolveWorkspaceConfig('/workspace', metadata, { includeMcp: true }).mcpServers)
      .toEqual([expect.objectContaining({ id: 'owned', command: 'current-command' })]);

    writeConfig(['workspace-default'], 'newer-but-disabled-command');
    expect(resolveWorkspaceConfig('/workspace', metadata, { includeMcp: true }).mcpServers)
      .toEqual([]);
  });
});
