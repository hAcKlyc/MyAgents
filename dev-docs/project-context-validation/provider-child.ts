// Manual acceptance entry: real production facade/adapter/SDK, isolated HOME.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeAgent, getSessionId, setAgents, setMcpServers,
  setSessionEnabledOfficialToolIds, setSessionEnabledPluginIds, getSystemInitInfo,
  getBuiltinSessionCompletionTerminal, getLastBuiltinAssistantText,
  stopBuiltinSessionForUpdate } from '../../src/server/agent-session';
import { getSessionEngine } from '../../src/server/session-engine';
import { drainSessionTranscripts, flushSessionTranscriptsForUpdate, getSessionData } from '../../src/server/SessionStore';
import { atomicModifyProjects, loadProjects } from '../../src/server/utils/admin-config';
import { APP_DATA_DIR_NAME } from '../../src/shared/appProfile';

const home = process.env.HOME!;
const input = JSON.parse(await readFile(join(home, 'case.json'), 'utf8'));
assert.ok(home.includes('/moxbots-project-context-provider-'));
assert.ok(input.workspace.startsWith(home + '/'));
const output = join(home, `${input.name}-result.json`);
let failure: string | null = null;
let result;
try {
  if (input.disableProject) {
    await atomicModifyProjects(rows => rows.map(row => row.id === 'project-a'
      ? { ...row, projectContextEnabled: false } : row), { strict: true });
    assert.equal(loadProjects({ strict: true }).find(row => row.id === 'project-a')?.projectContextEnabled, false);
  }
  await initializeAgent(input.workspace, undefined, undefined, { preWarmDisabled: true });
  setAgents({}); setMcpServers([]);
  setSessionEnabledOfficialToolIds([]); setSessionEnabledPluginIds([]);
  const sessionId = getSessionId();
  const admission = await getSessionEngine().sendDesktopMessage({
    sessionId, workspacePath: input.workspace, text: input.text,
    scenario: { type: 'desktop' }, permissionMode: 'plan', model: 'k3',
    providerRoute: { kind: 'provider', providerId: input.providerId, model: 'k3' },
    providerEnv: { providerId: input.providerId, baseUrl: input.baseUrl,
      apiKey: input.localToken, authType: 'api_key', apiProtocol: 'anthropic' },
  });
  assert.equal(admission.success, true);
  if (admission.dispatchAcceptance) assert.equal((await admission.dispatchAcceptance).accepted, true);
  const deadline = Date.now() + 90000;
  while (!getBuiltinSessionCompletionTerminal() && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 100));
  const terminal = getBuiltinSessionCompletionTerminal();
  assert.ok(terminal, 'actual terminal required, not idle alone');
  const init = getSystemInitInfo();
  assert.ok(init);
  assert.deepEqual(init.tools, []);
  assert.deepEqual(init.mcp_servers, []);
  if (!input.diagnostic) assert.equal(terminal.status, 'complete');
  // Draining revokes the active writer; readback must precede shutdown.
  await flushSessionTranscriptsForUpdate();
  const stored = await getSessionData(getSessionId());
  if (!input.diagnostic) assert.ok(stored);
  const user = stored?.messages.find(message => message.role === 'user');
  if (!input.diagnostic) assert.ok(user);
  assert.ok(stored?.messages.every(message => !message.toolCount) ?? input.diagnostic);
  const context = user?.desktopQuery?.projectContext;
  result = { sessionId: getSessionId(), preparedSessionId: sessionId, terminal, response: getLastBuiltinAssistantText(),
    init: { tools: init.tools, mcp_servers: init.mcp_servers, model: init.model },
    projectContext: context ?? null,
    visibleText: user?.desktopQuery?.visibleText ?? user?.content ?? input.text,
    persistedMessages: stored?.messages.length ?? 0, dataDir: APP_DATA_DIR_NAME };
} catch (error) { failure = String(error); }
finally {
  try { await stopBuiltinSessionForUpdate(); await drainSessionTranscripts(); }
  catch (error) { failure = `${failure ?? ''} cleanup:${String(error)}`; }
}
await writeFile(output, JSON.stringify({ result, failure }, null, 2), { mode: 0o600 });
process.exit(failure ? 1 : 0);
