// A synthetic prompt goes only to a loopback trap. No real credential/upstream.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const catalogSource = await readFile(join(root, 'src/server/sdk-builtin-tools.ts'), 'utf8');
const declaration = catalogSource.match(/export const SDK_BUILTIN_TOOLS = \[([\s\S]*?)\] as const;/);
assert.ok(declaration, 'exact product catalog declaration required');
const catalog = [...declaration[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
assert.equal(catalog.length, 29);
assert.equal(new Set(catalog).size, catalog.length);
assert.ok(catalog.every(tool => /^[A-Za-z][A-Za-z0-9_]*$/.test(tool)));
for (const tool of ['Read', 'Bash', 'Agent', 'Task']) assert.ok(catalog.includes(tool));
const home = await mkdtemp(join(tmpdir(), 'moxbots-title-permission-'));
await (await import('node:fs/promises')).chmod(home, 0o700);
const cwd = join(home, 'workspace');
await mkdir(join(cwd, '.claude'), { recursive: true, mode: 0o700 });
await mkdir(join(home, '.claude'), { mode: 0o700 });
const settings = { permissions: { deny: ['*', ...catalog] } };
await writeFile(join(cwd, '.claude/settings.json'), JSON.stringify(settings), { mode: 0o600 });
const sdk = await realpath(require.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'));
let requests = 0;
let wireTools;
let localRequestPath;
const wire = Promise.withResolvers();
const trap = createServer(async (req, res) => {
  requests++;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    localRequestPath = new URL(req.url, 'http://127.0.0.1').pathname;
    assert.equal(localRequestPath, '/v1/messages');
    wireTools = body.tools ?? [];
    assert.deepEqual(wireTools, []);
    assert.equal(requests, 1);
    wire.resolve();
  } catch (e) { wire.reject(e); }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'LOCAL_PREFLIGHT_ONLY' } }));
});
await new Promise(r => trap.listen(0, '127.0.0.1', r));
const port = trap.address().port;
const controller = new AbortController();
const env = {
  HOME: home, USER: 'title-qa', LOGNAME: 'title-qa', TMPDIR: home,
  PATH: '/opt/homebrew/opt/node@24/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8',
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  ANTHROPIC_API_KEY: 'non-secret-no-network-preflight',
  ANTHROPIC_AUTH_TOKEN: 'non-secret-no-network-preflight',
  CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};
let client;
let init;
let error;
let initialized = false;
let agents = [];
const initReady = Promise.withResolvers();
const deadline = Promise.withResolvers();
const timeout = setTimeout(() => { controller.abort(); deadline.reject(new Error('preflight timeout')); }, 15000);
try {
  client = query({ prompt: '仅回复：受控本地权限预检。', options: {
    cwd, model: 'k3', env, pathToClaudeCodeExecutable: sdk,
    abortController: controller, permissionMode: 'default',
    tools: catalog, allowedTools: ['Grep', 'Glob'],
    settingSources: ['project'], settings: { cleanupPeriodDays: 99999 },
    mcpServers: {}, strictMcpConfig: true, plugins: [], skills: [], agents: {},
    persistSession: false, maxTurns: 1,
  } });
  const control = await client.initializationResult();
  initialized = true;
  // Do not save account metadata returned by the SDK control response.
  agents = control.agents.map(a => ({ name: a.name, description: a.description }));
  const drain = (async () => {
    for await (const message of client) {
      if (message.type === 'system' && message.subtype === 'init') {
        init = { tools: message.tools, mcp_servers: message.mcp_servers, model: message.model };
        initReady.resolve();
      }
    }
  })();
  drain.catch(e => initReady.reject(e));
  await Promise.race([Promise.all([initReady.promise, wire.promise]), deadline.promise]);
  assert.ok(init, 'SDK must publish real system:init');
  assert.deepEqual(init.tools, []);
  assert.deepEqual(init.mcp_servers, []);
  assert.equal(requests, 1);
} catch (e) { error = String(e); }
finally {
  clearTimeout(timeout);
  client?.close();
  controller.abort();
  await new Promise(r => trap.close(r));
}
const receipt = {
  kind: 'ordinary-session-permission-preflight', at: new Date().toISOString(),
  home, cwd, sdk, sdkSha256: createHash('sha256').update(await readFile(sdk)).digest('hex'),
  settings, initialized, agents, init: init ?? null, syntheticLocalPromptInputs: 1,
  localTrapRequests: requests, localRequestPath, wireTools: wireTools ?? null, realUpstreamRequests: 0,
  usedRealCredential: false, ordinarySessionTitleAccepted: false,
  passed: !error && !!init && requests === 1, error: error ?? null,
};
await writeFile(join(home, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ receipt: join(home, 'receipt.json'), passed: receipt.passed, agents: agents.map(a => a.name), init, localTrapRequests: requests, realUpstreamRequests: 0, error }));
if (!receipt.passed) process.exitCode = 1;
