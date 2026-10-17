import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let scratch: string;
let configPath: string;
let projectsPath: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-mcp-selection-'));
  vi.stubEnv('HOME', scratch);
  vi.stubEnv('USERPROFILE', scratch);
  mkdirSync(join(scratch, '.myagents'));
  configPath = join(scratch, '.myagents', 'config.json');
  projectsPath = join(scratch, '.myagents', 'projects.json');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe('MCP desired-state disk boundaries', () => {
  it('reads legacy IDs, keeps global disable effective, and persists under the existing lock', async () => {
    const { loadConfig, withConfigLock, getEffectiveMcpServers } = await import('../utils/admin-config');
    const original = {
      unrelated: { keep: true },
      mcpEnabledServers: '[]',
      agents: [{ id: 'legacy', name: 'Legacy', enabled: false, workspacePath: scratch, mcpEnabledServers: '[playwright,tavily-search]', mcpServersJson: '[]' }],
    };
    writeFileSync(configPath, JSON.stringify(original));
    writeFileSync(projectsPath, JSON.stringify([{ id: 'project', name: 'Project', path: scratch, agentId: 'legacy', mcpEnabledServers: '[playwright,tavily-search]' }]));
    expect(loadConfig().agents![0].mcpEnabledServers).toEqual(['playwright', 'tavily-search']);
    expect(getEffectiveMcpServers(scratch)).toEqual([]);
    // Reading projects/config does not overwrite the user's file outside a lock.
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(original);
    await withConfigLock(config => ({ ...config, marker: true }));
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(saved.agents[0].mcpEnabledServers).toEqual(['playwright', 'tavily-search']);
    expect(saved.agents[0].mcpServersJson).toBe('[]');
    expect(saved.mcpEnabledServers).toEqual([]);
    expect(saved.unrelated).toEqual({ keep: true });
  });

  it('normalizes backup reads and modifier output', async () => {
    const { loadConfig, withConfigLock } = await import('../utils/admin-config');
    writeFileSync(configPath, '{broken');
    writeFileSync(configPath + '.bak', JSON.stringify({ mcpEnabledServers: '[playwright,tavily-search]' }));
    expect(loadConfig().mcpEnabledServers).toEqual(['playwright', 'tavily-search']);
    await withConfigLock(config => ({ ...config, mcpEnabledServers: '[playwright]' as unknown as string[], marker: true }));
    expect(JSON.parse(readFileSync(configPath, 'utf8')).mcpEnabledServers).toEqual(['playwright']);
  });

  it('normalizes project read and locked write without losing lifecycle or concurrent fields', async () => {
    const { loadProjects, atomicModifyProjects } = await import('../utils/admin-config');
    writeFileSync(projectsPath, JSON.stringify([{ id: 'project', name: 'Project', path: scratch, archivedAt: 'fixture', mcpEnabledServers: '[playwright,tavily-search]', unrelated: 42 }]));
    expect(loadProjects()[0].mcpEnabledServers).toEqual(['playwright', 'tavily-search']);
    await atomicModifyProjects(projects => projects.map(project => ({ ...project, archivedAt: undefined })));
    const saved = JSON.parse(readFileSync(projectsPath, 'utf8'))[0];
    expect(saved.archivedAt).toBeUndefined();
    expect(saved.unrelated).toBe(42);
    expect(saved.mcpEnabledServers).toEqual(['playwright', 'tavily-search']);
    await atomicModifyProjects(projects => projects.map(project => ({ ...project, mcpEnabledServers: '[tavily-search]' as unknown as string[] })));
    expect(JSON.parse(readFileSync(projectsPath, 'utf8'))[0].mcpEnabledServers).toEqual(['tavily-search']);
  });
});
