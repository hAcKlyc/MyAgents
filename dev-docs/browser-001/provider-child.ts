// Explicit manual acceptance: production SessionEngine/SDK and Browser Host.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeAgent, getSessionId, setAgents, setMcpServers, setSessionEnabledOfficialToolIds,
  setSessionEnabledPluginIds, getSystemInitInfo, getBuiltinSessionCompletionTerminal,
  getLastBuiltinAssistantText, stopBuiltinSessionForUpdate } from '../../src/server/agent-session';
import { getSessionEngine } from '../../src/server/session-engine';
import { drainSessionTranscripts, flushSessionTranscriptsForUpdate, getSessionData } from '../../src/server/SessionStore';
const home = process.env.HOME!;
assert.ok(home.startsWith('/private/tmp/moxbots-browser-'));
const input = JSON.parse(await readFile(join(home, 'case.json'), 'utf8'));
let failure: string | null = null;
let result;
try {
  await initializeAgent(input.workspace, undefined, undefined, { preWarmDisabled: true });
  setAgents({});
  setMcpServers([{ id: 'myagents-browser', name: 'Agent browser', type: 'stdio', command: '__browser_host__', args: [], isBuiltin: true }]);
  setSessionEnabledOfficialToolIds([]); setSessionEnabledPluginIds([]);
  const admission = await getSessionEngine().sendDesktopMessage({
    sessionId: getSessionId(), workspacePath: input.workspace, text: input.text,
    scenario: { type: 'desktop' }, permissionMode: 'fullAgency', model: 'k3',
    providerRoute: { kind: 'provider', providerId: input.providerId, model: 'k3' },
    providerEnv: { providerId: input.providerId, baseUrl: input.baseUrl,
      apiKey: input.localToken, authType: 'api_key', apiProtocol: 'anthropic' },
  });
  assert.equal(admission.success, true);
  if (admission.dispatchAcceptance) assert.equal((await admission.dispatchAcceptance).accepted, true);
  const deadline = Date.now() + 210000;
  while (!getBuiltinSessionCompletionTerminal() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const terminal = getBuiltinSessionCompletionTerminal();
  assert.ok(terminal, 'real terminal required');
  await flushSessionTranscriptsForUpdate();
  const stored = await getSessionData(getSessionId());
  const init = getSystemInitInfo();
  result = { terminal, response: getLastBuiltinAssistantText(), init: { tools: init?.tools, mcp_servers: init?.mcp_servers, model: init?.model }, persistedMessages: stored?.messages.length };
  assert.equal(terminal.status, 'complete');
  assert.ok(result.response?.includes(input.expected), 'final answer must recover the live page receipt');
} catch (error) { failure = String(error); }
finally {
  await stopBuiltinSessionForUpdate().catch(() => undefined);
  await drainSessionTranscripts().catch(() => undefined);
  await writeFile(join(home, 'provider-result.json'), JSON.stringify({ failure, result }, null, 2), { mode: 0o600 });
}
process.exit(failure ? 1 : 0);
