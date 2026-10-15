// Explicit, bounded real-provider acceptance. Never runs in CI or production.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, realpath, chmod, stat, symlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { appBuildDefines } from '../../scripts/app-build-profile.mjs';
import { networkProfile } from '../title-session-acceptance/sandbox.mjs';

const diagnostic = process.argv[2] === '--local-diagnostic';
assert.ok(diagnostic || process.argv[2] === '--approved-real-provider');
assert.equal(process.argv.length, diagnostic ? 3 : 5);
if (!diagnostic) assert.equal(process.argv[3], '--credential-config');
const root = resolve(import.meta.dirname, '../..');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['diff', '--name-only', '--', 'src'], { cwd: root, encoding: 'utf8' }).trim(), '');
const home = await realpath(await mkdtemp(join(tmpdir(), 'moxbots-project-context-provider-')));
await chmod(home, 0o700);
const data = join(home, '.moxbot');
const workspaceA = join(home, 'project-a'), workspaceB = join(home, 'project-b');
const catalogText = await readFile(join(root, 'src/server/sdk-builtin-tools.ts'), 'utf8');
const declaration = catalogText.match(/export const SDK_BUILTIN_TOOLS = \[([\s\S]*?)\] as const;/);
assert.ok(declaration);
const catalog = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
assert.ok(catalog.length > 20 && new Set(catalog).size === catalog.length);
for (const workspace of [workspaceA, workspaceB]) {
  await mkdir(join(workspace, '.claude'), { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['*', ...catalog] } }), { mode: 0o600 });
}
await mkdir(data, { mode: 0o700 });
await mkdir(join(home, '.claude'), { mode: 0o700 });
await symlink(await realpath(join(root, 'node_modules')), join(home, 'node_modules'));
const bundle = join(home, 'child.mjs');
await build({ entryPoints: [join(import.meta.dirname, 'provider-child.ts')], outfile: bundle,
  bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm',
  alias: { '@myagents/agent-network-protocol': join(root, 'node_modules/@myagents/agent-network-protocol/src/index.ts') },
  define: appBuildDefines({ MYAGENTS_BUILD_PROFILE: 'moxbot' }),
  banner: { js: 'import {createRequire as __qaRequire} from "node:module"; const require=__qaRequire(import.meta.url);' },
});
let key;
if (!diagnostic) {
  const configPath = await realpath(process.argv[4]);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  key = JSON.parse(await readFile(configPath, 'utf8')).providerApiKeys?.['moonshot-coding'];
  assert.ok(typeof key === 'string' && key.length > 10);
}
const localToken = randomBytes(32).toString('hex');
const decision = `PCD-${randomBytes(8).toString('hex')}`;
const providerId = 'qa-project-context-057';
const calls = [], violations = [], cases = [], expectedProtocolDenials = [];
let activeCase, failure = null, expectedProgress;
const proxy = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['x-api-key'], localToken);
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v1/messages/count_tokens') {
      expectedProtocolDenials.push({ case: activeCase, path, status: 404, forwarded: false });
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'COUNT_TOKENS_NOT_FORWARDED' } }));
      return;
    }
    assert.equal(path, '/v1/messages');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; assert.ok(size < 524288); chunks.push(chunk); }
    const body = Buffer.concat(chunks), parsed = JSON.parse(body.toString());
    assert.equal(parsed.model, 'k3'); assert.deepEqual(parsed.tools ?? [], []);
    assert.ok(calls.length < (diagnostic ? 1 : 4));
    assert.ok(!calls.some(call => call.case === activeCase), 'one upstream attempt per case; no automatic retry');
    const wire = JSON.stringify(parsed.messages);
    const entry = { case: activeCase, model: parsed.model, toolCount: 0,
      bodySha256: createHash('sha256').update(body).digest('hex'),
      hasContext: wire.includes('<PROJECT_CONTEXT>'), hasDecision: wire.includes(decision),
      hasProgress: Boolean(expectedProgress && wire.includes(expectedProgress)), forwarded: false, status: null };
    calls.push(entry);
    await writeFile(join(home, `${activeCase}-wire.json`), body, { mode: 0o600 });
    if (diagnostic) {
      entry.status = 401;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'LOCAL_DIAGNOSTIC_ONLY' } }));
      return;
    }
    if (activeCase === 'same-project') {
      assert.equal(entry.hasContext, true); assert.equal(entry.hasDecision, true); assert.equal(entry.hasProgress, true);
    } else if (activeCase !== 'source') {
      assert.equal(entry.hasContext, false); assert.equal(entry.hasDecision, false); assert.equal(entry.hasProgress, false);
    }
    const started = Date.now();
    entry.forwarded = true;
    const reply = await fetch('https://api.kimi.com/coding/v1/messages', {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', 'x-api-key': key,
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}) },
    });
    entry.status = reply.status;
    res.writeHead(reply.status, { 'Content-Type': reply.headers.get('content-type') || 'application/json' });
    let responseText = '';
    if (reply.body) for await (const chunk of reply.body) { responseText += Buffer.from(chunk).toString(); res.write(chunk); }
    res.end(); entry.elapsedMs = Date.now() - started;
    await writeFile(join(home, `${activeCase}-upstream.txt`), responseText, { mode: 0o600 });
    entry.usage = [];
    try { const message = JSON.parse(responseText); if (message.usage) entry.usage.push(message.usage); }
    catch { /* Streaming response: read typed usage events below. */ }
    for (const line of responseText.split('\n')) if (line.startsWith('data:')) {
      try { const event = JSON.parse(line.slice(5).trim()); const usage = event.usage ?? event.message?.usage;
        if (usage) entry.usage.push(usage); } catch { /* SSE control line */ }
    }
  } catch (error) {
    violations.push(String(error));
    if (!res.headersSent) res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'ACCEPTANCE_GATE_REFUSED' } }));
  }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const dummy = createServer((_req, res) => { violations.push('unexpected auxiliary network'); res.writeHead(403); res.end(); });
await new Promise(resolve => dummy.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${proxy.address().port}`;
const provider = { id: providerId, name: 'Bounded Project Context 057 acceptance', type: 'api', enabled: true,
  isBuiltin: false, config: { baseUrl }, authType: 'api_key', apiProtocol: 'anthropic', primaryModel: 'k3', models: [{ model: 'k3', modelName: 'Kimi K3' }] };
await mkdir(join(data, 'providers'), { mode: 0o700 });
await writeFile(join(data, 'providers', `${providerId}.json`), JSON.stringify(provider), { mode: 0o600 });
await writeFile(join(data, 'config.json'), JSON.stringify({ availableProvidersJson: JSON.stringify([provider]),
  providerApiKeys: { [providerId]: localToken }, defaultProviderId: providerId, defaultModel: 'k3',
  providerPrimaryModels: { [providerId]: 'k3' }, agents: [], cliToolRegistryEnabled: false,
  defaultPermissionMode: 'plan', backgroundAgentPermissionMode: 'inherit', autoStart: false,
  floatingBallEnabled: false, liteLLMModelDataRefresh: false }), { mode: 0o600 });
await writeFile(join(data, 'projects.json'), JSON.stringify([
  { id: 'project-a', name: 'Synthetic Project A', path: workspaceA },
  { id: 'project-b', name: 'Synthetic Project B', path: workspaceB },
]), { mode: 0o600 });
const env = { HOME: home, USER: 'project-context-qa', LOGNAME: 'project-context-qa', TMPDIR: home,
  PATH: '/opt/homebrew/opt/node@24/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8',
  CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
async function runCase(name, workspace, text, disableProject = false) {
  activeCase = name;
  await writeFile(join(home, 'case.json'), JSON.stringify({ name, workspace, text, disableProject,
    diagnostic, providerId, baseUrl, localToken }), { mode: 0o600 });
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const inbound = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn('/usr/bin/sandbox-exec', ['-p', networkProfile(inbound, [proxy.address().port, dummy.address().port]),
    process.execPath, bundle], { cwd: home, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(home, `${name}.log`), { mode: 0o600 });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ } }, 105000);
  const killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }, 110000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally {
    clearTimeout(timer); clearTimeout(killTimer);
    const members = () => execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' }).trim().split('\n')
      .map(row => row.trim().split(/\s+/)).filter(row => Number(row[1]) === child.pid && !row[2].startsWith('Z'));
    const before = members();
    if (before.length) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }
    let after = members();
    for (let i = 0; after.length && i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 100)); after = members();
    }
    await writeFile(join(home, `${name}-cleanup.json`), JSON.stringify({ groupId: child.pid,
      remainingBeforeFinalCleanup: before, remainingAfterFinalCleanup: after }), { mode: 0o600 });
    assert.equal(after.length, 0, 'all owned processes must exit');
  }
  const saved = JSON.parse(await readFile(join(home, `${name}-result.json`), 'utf8'));
  assert.equal(code, 0, saved.failure ?? `${name} failed; inspect private log`);
  assert.equal(saved.failure, null);
  assert.equal(saved.result.visibleText, text);
  cases.push({ name, ...saved.result });
  return saved.result;
}
function object(text) {
  const match = text.match(/\{[\s\S]*\}/); assert.ok(match, 'JSON answer required'); return JSON.parse(match[0]);
}
const question = '仅根据当前项目其他会话可用背景，回复JSON，字段decision（既定方案编号）、progressCode（最近进展编号）、status（进展及是否发布）、release（发布版本）、owner（发布职责）。没有背景的字段必须用null，不猜测，不使用工具，不读取文件，不执行操作。只输出JSON。';
try {
  if (diagnostic) {
    const result = await runCase('diagnostic', workspaceA, '仅回复本地权限预检。不要使用工具。');
    assert.deepEqual(result.init.tools, []); assert.equal(calls.length, 1); assert.equal(calls[0].status, 401);
  } else {
    const sourceResult = await runCase('source', workspaceA,
      `本次全部是合成联调数据，不代表真实产品进展。用户决策：确定采用方案编号${decision}，仅用于本次验收；发布版本0.5.7，发布职责交给统一发布会话。合成进展：设计评审通过，尚未发布。请为这条进展自行生成一个全新的8位字母数字编号。只用一行自然语言回复，格式为“确认采用方案编号${decision}；进展编号：你新生成的8位编号；设计评审通过，尚未发布；0.5.7由统一发布会话发布。”不要使用工具，禁止JSON、Markdown或代码块。`);
    assert.ok(sourceResult.response.includes(decision));
    assert.ok(!sourceResult.response.includes('```'));
    const progressMatch = sourceResult.response.match(/进展编号[：:\s]*([A-Za-z0-9]{8})(?![A-Za-z0-9])/);
    assert.ok(progressMatch, 'source assistant must create its own unique progress marker in prose');
    expectedProgress = progressMatch[1];
    assert.ok(!cases[0].visibleText.includes(expectedProgress));
    const same = await runCase('same-project', workspaceA, question);
    const sameAnswer = object(same.response);
    assert.equal(sameAnswer.decision, decision); assert.equal(sameAnswer.progressCode, expectedProgress);
    assert.equal(sameAnswer.release, '0.5.7'); assert.match(sameAnswer.status, /尚未发布/); assert.match(sameAnswer.owner, /统一发布/);
    assert.ok(same.projectContext.sources.some(source => source.sessionId === sourceResult.sessionId && source.role === 'assistant' && source.text.includes(expectedProgress)));
    for (const [name, workspace, disabled] of [['other-project', workspaceB, false], ['disabled', workspaceA, true]]) {
      const result = await runCase(name, workspace, question, disabled);
      assert.equal(result.projectContext, null);
      const answer = object(result.response);
      for (const field of ['decision', 'progressCode', 'status', 'release', 'owner']) assert.equal(answer[field], null);
    }
    assert.equal(calls.length, 4); assert.ok(calls.every(call => call.status === 200));
  }
  assert.equal(violations.length, 0);
} catch (error) { failure = String(error); }
finally {
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  dummy.closeAllConnections(); await new Promise(resolve => dummy.close(resolve));
}
const receipt = { kind: diagnostic ? 'local-only-permission-diagnostic' : 'real-provider-project-context',
  at: new Date().toISOString(), source, targetRelease: '0.5.7', home,
  bundleSha256: createHash('sha256').update(await readFile(bundle)).digest('hex'),
  provider: 'Kimi Coding', model: 'k3', realUpstreamRequests: calls.filter(call => call.forwarded).length,
  decision, expectedProgress, calls, cases, violations, expectedProtocolDenials, failure, passed: !failure,
  boundary: `${diagnostic ? 'Local-only SDK/wire permission diagnostic; no real upstream or credential.' : 'Real SessionEngine facade + builtin adapter + SDK + persisted SessionStore + real Provider; synthetic project facts.'} No HTTP/renderer/native lifecycle/other runtimes or production release acceptance.`,
};
await writeFile(join(home, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ receipt: join(home, 'receipt.json'), passed: receipt.passed, realUpstreamRequests: receipt.realUpstreamRequests, failure }));
if (failure) process.exitCode = 1;
