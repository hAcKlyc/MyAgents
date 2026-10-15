import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../../shared/types/session-message';
import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
import { createLegacySession, createPublishedSession } from '../__tests__/fixtures/session-store';

const state = vi.hoisted(() => ({ home: '/__project-context-fixture-only__' }));
vi.mock('os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }));
vi.mock('../utils/platform', async (original) => ({ ...await original<typeof import('../utils/platform')>(),
  getHomeDir: () => state.home, getHomeDirOrNull: () => state.home }));
type Store = typeof import('../SessionStore');
let store: Store;
let context: typeof import('./project-context');
let prepare: typeof import('./query-reminder');
let projectPath: string;
let registry: string;
const request = () => ({ sessionId: 'new-chat', workspacePath: projectPath, text: '继续项目', scenario: { type: 'desktop' as const } });
function projects(value: unknown) { writeFileSync(registry, JSON.stringify(Array.isArray(value)
  ? value.map(row => ({ name: 'Fixture Project', ...row })) : value)); }
const msg = (id: string, role: 'user' | 'assistant', content: string): SessionMessage =>
  ({ id, role, content, timestamp: '2026-10-16T01:00:00Z' });
async function source(messages: SessionMessage[], v2 = true, path = projectPath, extra = {}) {
  const metadata = v2 ? await createPublishedSession(store, path, extra) : await createLegacySession(store, path, extra);
  const cursor = (await store.loadSessionTranscript(metadata.id)).cursor;
  expect((await store.appendSessionMessages(metadata.id, cursor, messages)).ok).toBe(true);
  return metadata;
}
beforeEach(async () => {
  state.home = mkdtempSync(join(tmpdir(), 'moxbots-project-context-'));
  mkdirSync(join(state.home, APP_DATA_DIR_NAME), { recursive: true });
  projectPath = join(state.home, 'workspace');
  registry = join(state.home, APP_DATA_DIR_NAME, 'projects.json');
  projects([{ id: 'project', name: 'Project', path: projectPath }]);
  vi.resetModules();
  store = await import('../SessionStore');
  context = await import('./project-context');
  prepare = await import('./query-reminder');
});
afterEach(async () => {
  await store.drainSessionTranscripts();
  rmSync(state.home, { recursive: true, force: true });
});

describe('project context through real persisted history and desktop query preparation', () => {
  it.each([false, true])('carries a one-turn decision and progress from V2=%s without a model call', async (v2) => {
    const a = await source([msg('decision', 'user', '确定采用方案B，发布交给统一发布会话'),
      msg('progress', 'assistant', '实现完成，测试通过，尚未发布。')], v2);
    const result = await prepare.prepareDesktopQuery(request());
    expect(result.request.text).toContain('确定采用方案B');
    expect(result.request.text).toContain('尚未发布');
    expect(result.request.desktopQuery?.projectContext?.sources[0].sessionId).toBe(a.id);
    expect(result.request.desktopQuery?.visibleText).toBe('继续项目');
  });
  it('reads updates made after new-chat preparation/prewarm, not a persistent prompt cache', async () => {
    const a = await source([msg('old', 'user', '采用方案A')]);
    expect((await prepare.prepareDesktopQuery(request())).request.text).toContain('采用方案A');
    const cursor = (await store.loadSessionTranscript(a.id)).cursor;
    await store.appendSessionMessages(a.id, cursor, [msg('new', 'user', '取消方案A，改为方案B')]);
    const latest = await prepare.prepareDesktopQuery(request());
    expect(latest.request.desktopQuery?.projectContext?.sources[0].messageId).toBe('new');
    expect(latest.request.text).toContain('取消方案A，改为方案B');
  });
  it('includes background in an empty prepared target, before its first message is materialized', async () => {
    await source([msg('decision', 'user', '确定采用方案B')]);
    const target = await store.createSession(projectPath);
    const result = await prepare.prepareDesktopQuery({ ...request(), sessionId: target.id });
    expect(result.request.text).toContain('确定采用方案B');
  });
  it('does not repeat background on later turns and retains exact stored visible text', async () => {
    await source([msg('other-user', 'user', '采用B')]);
    const first = await prepare.prepareDesktopQuery(request());
    const target = await source([{ ...msg('target-user', 'user', first.request.text), desktopQuery: first.request.desktopQuery }]);
    const next = await prepare.prepareDesktopQuery({ ...request(), sessionId: target.id, text: '下一步' });
    expect(next.request.text).toBe('下一步');
    expect(next.request.desktopQuery).toBeUndefined();
  });
  it('uses only the same project and excludes archived, channel and delegated histories', async () => {
    await source([msg('keep', 'user', '确定共享方案B')]);
    await source([msg('other', 'user', 'other-project-secret')], true, join(state.home, 'other'));
    const archived = await source([msg('archived', 'user', 'archived-secret')]);
    await store.updateSessionMetadata(archived.id, { archived: true });
    const channel = await source([msg('channel', 'user', 'channel-secret')]);
    await store.updateSessionMetadata(channel.id, { source: 'feishu_group', origin: { kind: 'agent-channel', surface: 'channel_message' } });
    await source([msg('bot', 'user', 'bot-secret')], true, projectPath,
      { hostBotBinding: { botId: 'bot', runGeneration: 'generation' } });
    const text = (await prepare.prepareDesktopQuery(request())).request.text;
    expect(text).toContain('确定共享方案B');
    expect(text).not.toMatch(/other-project-secret|archived-secret|channel-secret|bot-secret/);
  });
  it('honors opt-out and ambiguous/deleted project identities without blocking the query', async () => {
    await source([msg('keep', 'user', '采用B')]);
    for (const rows of [[{ id: 'p', path: projectPath, projectContextEnabled: false }], [],
      [{ id: 'p1', path: projectPath }, { id: 'p2', path: projectPath }]]) {
      projects(rows);
      expect((await prepare.prepareDesktopQuery(request())).request.text).toBe('继续项目');
    }
    writeFileSync(registry, '{broken');
    expect((await prepare.prepareDesktopQuery(request())).request.text).toBe('继续项目');
  });
  it('skips corrupt and deleted source history instead of injecting a stale cached decision', async () => {
    const a = await source([msg('a', 'user', '确定方案A')], false);
    expect((await context.readProjectContext(request()))?.sources).toHaveLength(1);
    // External deletion of the history/index is observed on the next read.
    const indexPath = join(state.home, APP_DATA_DIR_NAME, 'sessions.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { id: string }[];
    writeFileSync(indexPath, JSON.stringify(index.filter(row => row.id !== a.id)));
    expect(await context.readProjectContext(request())).toBeUndefined();
    projects([{ id: 'project', path: projectPath, archivedAt: '2026-10-16T02:00:00Z' }]);
    expect(await context.readProjectContext(request())).toBeUndefined();
  });
  it('excludes damaged V2 history and reports incomplete coverage', async () => {
    await source([msg('healthy', 'user', '确定采用方案B')]);
    const damaged = await source([msg('damaged', 'user', 'damaged-source-secret')]);
    await store.releaseSessionTranscriptForBinding(damaged.id);
    appendFileSync(join(state.home, APP_DATA_DIR_NAME, 'sessions-v2', `${damaged.id}.jsonl`), '{broken\n');
    const result = await context.readProjectContext(request());
    expect(result?.unavailableSessions).toBe(1);
    expect(result?.sources.some(s => s.text.includes('damaged-source-secret'))).toBe(false);
  });
  it('allows parallel fresh chats to read the same committed state without writing any source', async () => {
    await source([msg('one', 'user', '决定采用方案B'), msg('two', 'assistant', '测试通过，未发布')]);
    const indexPath = join(state.home, APP_DATA_DIR_NAME, 'sessions.json');
    const before = readFileSync(indexPath, 'utf8');
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => prepare.prepareDesktopQuery({ ...request(), sessionId: `new-${i}` })));
    expect(results.every(r => r.request.text.includes('决定采用方案B'))).toBe(true);
    expect(readFileSync(indexPath, 'utf8')).toBe(before);
    vi.resetModules();
    const reloaded = await import('./project-context');
    expect((await reloaded.readProjectContext(request()))?.sources[0].messageId).toBe('one');
  });
});
