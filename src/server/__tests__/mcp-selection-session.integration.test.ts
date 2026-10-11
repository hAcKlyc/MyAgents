import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSessionMetadata } from '../types/session';

let scratch: string;
let store: typeof import('../SessionStore');
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-mcp-session-'));
  vi.stubEnv('HOME', scratch);
  vi.stubEnv('USERPROFILE', scratch);
  vi.resetModules();
  store = await import('../SessionStore');
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe('historical Session MCP selection authority', () => {
  it('repairs frozen IDs on read/write without adopting changed Agent defaults', async () => {
    const configDir = join(scratch, '.myagents');
    mkdirSync(configDir, { recursive: true });
    const metadata = createSessionMetadata(scratch, {
      mcpEnabledServers: '[playwright,tavily-search]' as unknown as string[],
      configSnapshotAt: 'frozen',
    });
    delete metadata.transcriptFormat;
    const path = join(configDir, 'sessions.json');
    const configPath = join(configDir, 'config.json');
    const desired = JSON.stringify({ agents: [{ workspacePath: scratch, mcpEnabledServers: ['different'] }] });
    writeFileSync(configPath, desired);
    writeFileSync(path, JSON.stringify([metadata]));
    expect(store.getSessionMetadata(metadata.id)?.mcpEnabledServers).toEqual(['playwright', 'tavily-search']);
    // Pure reads never write a derived Session view back to desired state.
    expect(JSON.parse(readFileSync(path, 'utf8'))[0].mcpEnabledServers).toBe('[playwright,tavily-search]');
    await store.updateSessionMetadata(metadata.id, { title: 'Renamed' });
    const saved = JSON.parse(readFileSync(path, 'utf8'))[0];
    expect(saved.mcpEnabledServers).toEqual(['playwright', 'tavily-search']);
    expect(saved.configSnapshotAt).toBe('frozen');
    expect(readFileSync(configPath, 'utf8')).toBe(desired);
    await store.updateSessionMetadata(metadata.id, { mcpEnabledServers: [] });
    expect(store.getSessionMetadata(metadata.id)?.mcpEnabledServers).toEqual([]);
  });

  it('normalizes new V2 birth and active metadata patches in the Session owner', async () => {
    const session = await store.createSession(scratch, {
      mcpEnabledServers: '[playwright,tavily-search]' as unknown as string[],
      configSnapshotAt: 'frozen',
    });
    expect(session.mcpEnabledServers).toEqual(['playwright', 'tavily-search']);
    expect(await store.publishSessionForHandoff(session.id)).toBe(true);
    await store.activateSessionTranscript(session.id);
    const updated = await store.updateSessionMetadata(session.id, {
      mcpEnabledServers: '[tavily-search]' as unknown as string[],
    });
    expect(updated?.mcpEnabledServers).toEqual(['tavily-search']);
    expect(await store.publishSessionForHandoff(session.id)).toBe(true);
    const rows = JSON.parse(readFileSync(join(scratch, '.myagents', 'sessions.json'), 'utf8'));
    expect(rows.find((row: { id: string }) => row.id === session.id).mcpEnabledServers).toEqual(['tavily-search']);
  });
});
