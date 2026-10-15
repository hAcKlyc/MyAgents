// Manual, explicitly authorized real-provider acceptance. Not a production route.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, stat, chmod, realpath, lstat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const root = resolve(import.meta.dirname, '../..');
const frozenSource = '01deb0b1adc8970389ab2e79553cfab4a521ab3b';
execFileSync('git', ['merge-base', '--is-ancestor', frozenSource, 'HEAD'], { cwd: root });
execFileSync('git', ['diff', '--exit-code', frozenSource, '--', 'src', 'scripts', 'src-tauri', 'package.json', 'package-lock.json', 'vendor', 'bundled-agents', 'bundled-workspaces'],
  { cwd: root, stdio: 'pipe' }); // Later commits may record evidence, never alter runtime source.
assert.equal(process.argv[2], '--approved-real-session-once');
assert.equal(process.argv[3], '--qa-goal-token-file');
assert.equal(process.argv.length, 5);
const goalTokenFile = await realpath(process.argv[4]);
assert.ok(goalTokenFile.startsWith('/Users/zhangshaohua/Documents/WPS Cloud/【项目】目录/MoxBot/work/unified-055-20261015/'));
assert.equal((await lstat(process.argv[4])).isSymbolicLink(), false);
assert.equal((await stat(goalTokenFile)).mode & 0o777, 0o600);
const qaGoalToken = (await readFile(goalTokenFile, 'utf8')).trim();
assert.ok(qaGoalToken.length >= 32);
const qaGoalPort = 53050;
const qaPid = 94448;
const listeners = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${qaGoalPort}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' });
assert.equal(listeners.trim(), `p${qaPid}`, 'only the Root-designated isolated Rust owner may serve goals');
const sourceConfig = '/private/tmp/moxbots-modelqa-home-055-v2-4tv4sn5d/.moxbot-modelqa/config.json';
assert.equal((await stat(sourceConfig)).mode & 0o777, 0o600);
const source = JSON.parse(await readFile(sourceConfig, 'utf8'));
const upstreamKey = source.providerApiKeys?.['moonshot-coding'];
assert.ok(typeof upstreamKey === 'string' && upstreamKey.trim());
const preflight = JSON.parse(await readFile('/var/folders/34/45h5k_sd5z134tmnzl7499n00000gn/T/moxbots-title-permission-IIqCFE/receipt.json', 'utf8'));
assert.equal(preflight.passed, true);
assert.deepEqual(preflight.init.tools, []);
assert.deepEqual(preflight.wireTools, []);
const home = await realpath(await mkdtemp(join(tmpdir(), 'moxbots-title-session-')));
await chmod(home, 0o700);
const cwd = join(home, 'workspace');
const data = join(home, '.moxbot');
for (const dir of [join(cwd, '.claude'), data, join(home, '.claude')]) await mkdir(dir, { recursive: true, mode: 0o700 });
await writeFile(join(cwd, '.claude/settings.json'), JSON.stringify({ permissions: preflight.settings.permissions }), { mode: 0o600 });
const localToken = randomBytes(32).toString('hex');
const attempts = [];
const violations = [];
const events = [];
const goalReads = [];
let allowedGoalSessionId;
let sessionId;
let title;
let init;
let failure;
let sidecar;
let sidecarPort;
let reloaded;
let ordinaryChatSendCount = 0;
let ordinaryChatSendAttemptCount = 0;
let terminal;
let actualSdk;
const startedAt = new Date().toISOString();
const goalLocalToken = randomBytes(32).toString('hex');
// This adapter does not emulate management responses or forward execution.
const goalAdapter = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(req.method, 'GET');
    assert.equal(url.pathname, '/api/goal/get');
    assert.equal(req.headers['x-myagents-internal-cli-token'], goalLocalToken);
    assert.deepEqual([...url.searchParams.keys()].sort(), ['sessionId', 'workspacePath']);
    assert.ok(allowedGoalSessionId && /^[a-f0-9-]{36}$/.test(allowedGoalSessionId));
    assert.equal(url.searchParams.get('sessionId'), allowedGoalSessionId);
    assert.equal(url.searchParams.get('workspacePath'), cwd);
    const reply = await fetch(`http://127.0.0.1:${qaGoalPort}${url.pathname}${url.search}`, {
      headers: { 'x-myagents-internal-cli-token': qaGoalToken }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    const bytes = Buffer.from(await reply.arrayBuffer());
    const actual = JSON.parse(bytes.toString());
    assert.equal(reply.status, 200);
    assert.equal(actual.ok, true);
    assert.equal(actual.goal, null, 'the real isolated store must confirm there is no attached goal');
    goalReads.push({ method: 'GET', path: '/api/goal/get', sessionId: allowedGoalSessionId,
      workspacePath: cwd, status: reply.status, realGoalStore: true, mutation: false });
    res.writeHead(reply.status, { 'Content-Type': reply.headers.get('content-type') || 'application/json' });
    res.end(bytes); // Exact real GoalStore response, never a synthesized null.
  } catch (e) {
    violations.push(`goal adapter:${String(e)}`);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'QA_GOAL_READ_SCOPE_REFUSED' }));
  }
});
await new Promise(r => goalAdapter.listen(0, '127.0.0.1', r));
const proxy = createServer(async (req, res) => {
  const started = Date.now();
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    assert.equal(req.method, 'POST');
    assert.equal(u.pathname, '/v1/messages');
    assert.equal(req.headers['x-api-key'], localToken);
    const chunks = [];
    let length = 0;
    for await (const chunk of req) { length += chunk.length; assert.ok(length < 524288); chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    const parsed = JSON.parse(body.toString());
    assert.equal(parsed.model, 'k3');
    assert.deepEqual(parsed.tools ?? [], []);
    assert.ok(attempts.length < 2, 'upstream attempt limit');
    const entry = { sequence: attempts.length + 1, method: 'POST', model: 'k3', toolCount: 0, status: null, elapsedMs: null };
    attempts.push(entry); // Failed attempts consume the same quota.
    const headers = { 'Content-Type': 'application/json', 'x-api-key': upstreamKey,
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01' };
    // Preserve SDK protocol headers, never local Authorization or local auth token.
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
    if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
    const reply = await fetch('https://api.kimi.com/coding/v1/messages', {
      method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(60000),
    });
    entry.status = reply.status;
    res.writeHead(reply.status, { 'Content-Type': reply.headers.get('content-type') || 'application/json' });
    if (reply.body) for await (const chunk of Readable.fromWeb(reply.body)) res.write(chunk);
    res.end();
    entry.elapsedMs = Date.now() - started;
  } catch (e) {
    violations.push(String(e));
    if (!res.headersSent) res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'ACCEPTANCE_GATE_REFUSED' } }));
  }
});
await new Promise(r => proxy.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${proxy.address().port}`;
const provider = { id: 'moonshot-coding', name: 'Kimi bounded title acceptance', type: 'api',
  enabled: true, isBuiltin: false, baseUrl, authType: 'api_key', apiProtocol: 'anthropic',
  primaryModel: 'k3', models: [{ model: 'k3', modelName: 'Kimi K3' }] };
await writeFile(join(data, 'config.json'), JSON.stringify({
  availableProvidersJson: JSON.stringify([provider]), providerApiKeys: { 'moonshot-coding': localToken },
  defaultProviderId: 'moonshot-coding', defaultModel: 'k3', providerPrimaryModels: { 'moonshot-coding': 'k3' },
  agents: [], cliToolRegistryEnabled: false, defaultPermissionMode: 'plan',
  backgroundAgentPermissionMode: 'inherit', workspacesDir: cwd, defaultWorkspacePath: cwd,
  autoStart: false, floatingBallEnabled: false, liteLLMModelDataRefresh: false,
}), { mode: 0o600 });
const env = {
  HOME: home, USER: 'title-qa', LOGNAME: 'title-qa', TMPDIR: home,
  PATH: '/opt/homebrew/opt/node@24/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8',
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '',
  CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MYAGENTS_MANAGEMENT_PORT: String(goalAdapter.address().port),
  MYAGENTS_INTERNAL_CLI_TOKEN: goalLocalToken,
};
const node = '/opt/homebrew/opt/node@24/bin/node';
const bundle = join(root, 'src-tauri/resources/server-dist.js');
const bundleSha = createHash('sha256').update(await readFile(bundle)).digest('hex');
const sseAbort = new AbortController();
const wait = ms => new Promise(r => setTimeout(r, ms));
async function api(path, options) {
  const response = await fetch(`http://127.0.0.1:${sidecarPort}${path}`, { ...options, signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  assert.ok(response.ok, `HTTP ${response.status} ${path}: ${typeof body.error === 'string' ? body.error : 'request rejected'}`);
  return body;
}
async function start(id) {
  const reservation = createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  sidecarPort = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const args = [bundle, '--agent-dir', cwd, '--port', String(sidecarPort), '--sidecar-role', 'session', '--no-pre-warm',
    ...(id ? ['--session-id', id] : [])];
  sidecar = spawn(node, args, { env, cwd: join(root, 'src-tauri/resources'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(home, id ? 'reload.log' : 'sidecar.log'), { mode: 0o600 });
  sidecar.stdout.pipe(log); sidecar.stderr.pipe(log);
  await writeFile(join(home, id ? 'reload-owner.json' : 'owner.json'), JSON.stringify({ pid: sidecar.pid, args, port: sidecarPort }), { mode: 0o600 });
  for (let i = 0; i < 150; i++) {
    assert.ok(sidecar.exitCode === null && sidecar.signalCode === null, 'own sidecar exited during startup');
    try { await api('/health/ready'); return; } catch { await wait(200); }
  }
  throw new Error('sidecar not ready');
}
async function stop() {
  if (!sidecar || sidecar.exitCode !== null || sidecar.signalCode !== null) return;
  // This is a new detached process group owned solely by this harness.
  const pid = sidecar.pid;
  process.kill(-pid, 'SIGTERM');
  await Promise.race([new Promise(r => sidecar.once('exit', r)), wait(5000)]);
  assert.ok(sidecar.exitCode !== null || sidecar.signalCode !== null, 'own sidecar group did not exit');
  for (let i = 0; i < 50; i++) {
    try { process.kill(-pid, 0); } catch (e) { if (e.code === 'ESRCH') return; throw e; }
    await wait(100);
  }
  throw new Error('SDK/process group remains');
}
try {
  await start();
  const beforeSend = await api('/api/session-state');
  assert.ok(/^[a-f0-9-]{36}$/.test(beforeSend.sessionId));
  assert.equal(beforeSend.isBusy, false);
  assert.equal(violations.length, 0, 'no unauthorized management request during startup');
  allowedGoalSessionId = beforeSend.sessionId;
  await writeFile(join(home, 'new-session-identity.json'), JSON.stringify(beforeSend), { mode: 0o600 });
  const stream = await fetch(`http://127.0.0.1:${sidecarPort}/chat/stream`, { signal: sseAbort.signal });
  assert.ok(stream.ok);
  const reading = (async () => {
    let buffer = '';
    for await (const chunk of stream.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const name = frame.match(/^event: *(.*)$/m)?.[1];
        const raw = frame.match(/^data: *(.*)$/m)?.[1];
        if (!name || !raw) continue;
        const value = JSON.parse(raw);
        if (name === 'chat:system-init') {
          init = { tools: value.info?.tools, mcp_servers: value.info?.mcp_servers, model: value.info?.model };
          assert.deepEqual(init.tools, []); assert.deepEqual(init.mcp_servers, []); assert.equal(init.model, 'k3');
        }
        if (name === 'chat:session-title-changed') { sessionId = value.sessionId; title = value.title; }
        if (['chat:system-init', 'chat:session-title-changed', 'chat:status', 'chat:complete', 'chat:agent-error'].includes(name))
          events.push({ event: name, value, at: new Date().toISOString() });
      }
    }
  })();
  reading.catch(e => { if (!sseAbort.signal.aborted) failure = String(e); });
  const text = '以下是一次仅讨论方案的普通会话，请不要调用工具、读取文件或执行任何操作。背景：公司已经有费用包编辑页，各金额字段目前单位不一致。需求：把预算、已用金额和余额统一按万元展示并保留两位小数，同时在保存前校验预计毛利是否低于目标；只用一句中文概述实施建议，不需要写代码。';
  ordinaryChatSendAttemptCount++;
  const sent = await api('/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    clientRequestId: randomUUID(), text, model: 'k3', permissionMode: 'plan',
    providerRoute: { kind: 'provider', providerId: 'moonshot-coding', model: 'k3' },
    providerEnv: { providerId: 'moonshot-coding', baseUrl, apiKey: localToken, authType: 'api_key', apiProtocol: 'anthropic' },
  }) });
  assert.equal(sent.success, true);
  ordinaryChatSendCount++;
  for (let i = 0; i < 450 && !title; i++) { if (failure) throw new Error(failure); assert.equal(violations.length, 0); await wait(200); }
  assert.ok(init && title && sessionId, 'real automatic title SSE required');
  assert.equal(sessionId, allowedGoalSessionId, 'fresh canonical identity must stay unchanged');
  assert.ok([...title].length <= 30 && [...title].length >= 6);
  assert.ok(!text.startsWith(title));
  assert.ok(/费用|毛利|万元/.test(title));
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(a => a.status === 200));
  const result = await api(`/sessions/${sessionId}`);
  assert.ok(result.session.messages.some(m => m.role === 'assistant' && m.transcriptState === 'complete'));
  assert.ok(result.session.messages.every(m => !m.toolCount), 'real product transcript must have zero tool executions');
  terminal = await api('/api/session-state');
  assert.equal(terminal.isBusy, false);
  assert.ok(terminal.completionTerminal, 'real successful completion receipt required');
  assert.equal(terminal.completionTerminal.status, 'complete');
  await writeFile(join(home, 'session-readback.json'), JSON.stringify(result), { mode: 0o600 });
  const index = JSON.parse(await readFile(join(data, 'sessions.json'), 'utf8'));
  const metadata = index.find(m => m.id === sessionId);
  assert.equal(metadata.titleSource, 'auto'); assert.equal(metadata.title, title); assert.equal(metadata.titleGenAttempts, 1);
  const transcript = await readFile(join(data, 'sessions-v2', `${sessionId}.jsonl`));
  await writeFile(join(home, 'transcript-sha256.txt'), createHash('sha256').update(transcript).digest('hex'), { mode: 0o600 });
  sseAbort.abort();
  await stop();
  await start(sessionId); // no new prompt; real persisted Session restore.
  reloaded = await api(`/sessions/${sessionId}`);
  await writeFile(join(home, 'session-reloaded.json'), JSON.stringify(reloaded), { mode: 0o600 });
  const reindex = JSON.parse(await readFile(join(data, 'sessions.json'), 'utf8'));
  assert.equal(reindex.find(m => m.id === sessionId)?.title, title);
  assert.equal(attempts.length, 2, 'reload must not send another model request');
  assert.equal(violations.length, 0);
  const normalLog = await readFile(join(home, 'sidecar.log'), 'utf8');
  const resolvedSdk = normalLog.match(/Claude native binary resolved via (?:node_modules|bundled path).*?: (\/[^\n]+)/);
  assert.ok(resolvedSdk, 'actual ordinary SDK resolution must be observable');
  const sdkPath = await realpath(resolvedSdk[1]);
  actualSdk = { path: sdkPath, sha256: createHash('sha256').update(await readFile(sdkPath)).digest('hex') };
  assert.equal(actualSdk.sha256, preflight.sdkSha256, 'ordinary executable must match tested source dependency');
} catch (e) { failure = String(e); }
finally {
  sseAbort.abort();
  try { await stop(); } catch (e) { failure = `${failure ?? ''} cleanup:${String(e)}`; }
  proxy.closeAllConnections(); await new Promise(r => proxy.close(r));
  goalAdapter.closeAllConnections(); await new Promise(r => goalAdapter.close(r));
}
const receipt = { kind: 'ordinary-session-auto-title-backend', startedAt, endedAt: new Date().toISOString(),
  source: '01deb0b1adc8970389ab2e79553cfab4a521ab3b', home, bundleSha, sessionId, title,
  profile: 'moxbot', sidecarRole: 'session', ordinaryChatSendCount, ordinaryChatSendAttemptCount, terminal,
  manualTitleEndpointCalls: 0, init, actualSdk, attempts, violations, events,
  managementDependency: { isolatedQaPid: qaPid, role: 'actual read-only A6 GoalStore', reads: goalReads,
    allowedPaths: ['GET /api/goal/get'], mutations: 0, executionForwarded: false, normalDesktopSdkCircuitAccepted: false },
  persistedTitleSource: title ? 'auto' : null, reloaded: !!reloaded,
  passed: !failure && !!title && !!reloaded, failure: failure ?? null,
  nativeSidebarAccepted: false, manualTitleRaceAccepted: false, formal055Published: false,
};
await writeFile(join(home, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ receipt: join(home, 'receipt.json'), passed: receipt.passed, title, calls: attempts.length, failure }));
if (!receipt.passed) process.exitCode = 1;
