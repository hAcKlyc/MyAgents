// Explicit real-provider/browser test. Never runs as part of automatic CI.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdtemp, realpath, mkdir, chmod, readFile, writeFile, symlink, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { appBuildDefines } from '../../scripts/app-build-profile.mjs';
import { networkProfile } from '../title-session-acceptance/sandbox.mjs';
const [mode, credentialPath, executablePath] = process.argv.slice(2);
assert.equal(mode, '--approved-real-provider');
assert.ok(credentialPath && executablePath);
const root = resolve(import.meta.dirname, '../..');
const home = await realpath(await mkdtemp('/private/tmp/moxbots-browser-'));
await chmod(home, 0o700);
const workspace = join(home, 'workspace'), data = join(home, '.moxbot');
await mkdir(workspace, { mode: 0o700 }); await mkdir(data, { mode: 0o700 });
await mkdir(join(home, '.claude'), { mode: 0o700 });
await mkdir(join(workspace, '.claude', 'skills'), { recursive: true });
await cp(join(root, 'bundled-skills/moxbots-browser'), join(workspace, '.claude/skills/moxbots-browser'), { recursive: true });
await writeFile(join(workspace, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Bash', 'Write', 'Edit', 'MultiEdit', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'NotebookEdit'] } }), { mode: 0o600 });
await symlink(await realpath(join(root, 'node_modules')), join(home, 'node_modules'));
const config = JSON.parse(await readFile(credentialPath, 'utf8'));
const key = config.providerApiKeys?.['moonshot-coding'];
assert.ok(typeof key === 'string' && key.length > 10);
const localToken = randomBytes(32).toString('hex'), capability = randomBytes(16).toString('hex');
const marker = 'BROWSER-' + randomBytes(5).toString('hex');
const calls = [], toolCalls = [], management = [];
let pageReceipt = null, browserHost, registry, failure = null, restoredCookie = false, secondSession = null;
let binding = { productSessionId: 'browser-test-session', workspacePath: workspace, hostGeneration: 1 };
let identity = { revision: 0, state: { cookies: [], origins: [] } };
const upstream = createServer(async (req, res) => {
  try {
    assert.equal(req.headers['x-api-key'], localToken);
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/v1/messages/count_tokens') { res.writeHead(404); res.end('{}'); return; }
    assert.equal(path, '/v1/messages'); assert.ok(calls.length < 24, 'bounded inference requests');
    const chunks = []; let size = 0;
    for await (const part of req) { size += part.length; assert.ok(size < 2000000); chunks.push(part); }
    const body = Buffer.concat(chunks), parsed = JSON.parse(body);
    assert.equal(parsed.model, 'k3');
    const row = { index: calls.length, tools: parsed.tools?.map(t => t.name) ?? [], status: null };
    calls.push(row);
    const reply = await fetch('https://api.kimi.com/coding/v1/messages', { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(90000), headers: {
      'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}),
    } });
    row.status = reply.status;
    res.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') || 'application/json' });
    let replyText = '';
    if (reply.body) for await (const chunk of reply.body) { replyText += Buffer.from(chunk).toString(); res.write(chunk); }
    res.end();
    row.usage = [];
    for (const line of replyText.split('\n')) if (line.startsWith('data:')) { try { const e = JSON.parse(line.slice(5)); const usage = e.usage ?? e.message?.usage; if (usage) row.usage.push(usage); } catch { /* SSE control line or an already exited owned process. */ } }
    await writeFile(join(home, `upstream-${row.index}.txt`), replyText, { mode: 0o600 });
  } catch (error) { failure ??= String(error); if (!res.headersSent) res.writeHead(403); res.end('{}'); }
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const app = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/form') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'browser_qa=synthetic; HttpOnly; SameSite=Lax; Path=/' });
      res.end(`<title>MoXBots browser acceptance</title><h1>Browser test</h1><form action="/done"><label>Test phrase <input name="phrase" required></label><button>Submit test</button></form>`); return;
    }
    if (url.pathname === '/cookie-check') {
      restoredCookie = req.headers.cookie?.includes('browser_qa=synthetic') === true;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<title>Cookie recovery</title><h1>' + (restoredCookie ? 'RESTORED' : 'MISSING') + '</h1>'); return;
    }
    if (url.pathname === '/done') {
      assert.equal(url.searchParams.get('phrase'), '浏览器完整流程验证');
      pageReceipt = { phrase: url.searchParams.get('phrase'), marker, hasSyntheticCookie: req.headers.cookie?.includes('browser_qa=synthetic') === true };
      await writeFile(join(home, 'page-receipt.json'), JSON.stringify(pageReceipt), { mode: 0o600 });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<title>Accepted</title><h1>Accepted</h1><p>Receipt: ${marker}</p>`); return;
    }
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = Buffer.concat(chunks);
    if (url.pathname.startsWith('/api/browser/')) {
      res.setHeader('content-type', 'application/json');
      const input = JSON.parse(body.length ? body : '{}'); management.push(url.pathname);
      if (url.pathname.endsWith('/session/adopt')) { binding = { ...binding, productSessionId: input.productSessionId }; res.end(JSON.stringify({ ok: true, adopted: true })); return; }
      if (url.pathname.endsWith('/capability/acquire')) { res.end(JSON.stringify({ ok: true, url: `http://127.0.0.1:${app.address().port}/mcp/browser`, token: capability, hostGeneration: 1 })); return; }
      res.writeHead(404); res.end('{}'); return;
    }
    if (url.pathname === '/mcp/browser') {
      if (body.length) { const input = JSON.parse(body); if (input.method === 'tools/call') toolCalls.push({ name: input.params.name, arguments: input.params.arguments }); }
      const response = await browserHost.handleRequest(new Request(`http://127.0.0.1:${app.address().port}${url.pathname}`, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    res.writeHead(403); res.end('Only the local test site is allowed.');
  } catch (error) { failure ??= String(error); if (!res.headersSent) res.writeHead(500); res.end('{}'); }
});
await new Promise(r => app.listen(0, '127.0.0.1', r));
// Bundle production Host/Registry; only Rust resource/identity/capability authorities are test doubles.
const hostBundle = join(home, 'host.mjs');
await build({ stdin: { contents: `export { PlaywrightBrowserHost } from './src/server/browser-host/browser-host'; export { BrowserContextRegistry } from './src/server/browser-host/context-registry';`, resolveDir: root }, outfile: hostBundle, bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm' });
const { PlaywrightBrowserHost, BrowserContextRegistry } = await import(hostBundle);
const { chromium } = await import('playwright');
registry = new BrowserContextRegistry({
  loadBrowserType: async () => ({ ...chromium, launch: opts => chromium.launch({ ...opts, headless: true, proxy: { server: `http://127.0.0.1:${app.address().port}`, bypass: '127.0.0.1' } }) }),
  resolveResource: async () => ({ executablePath, revision: executablePath.includes('/runtime/') ? 'official-chromium-1212' : 'unlocked-diagnostic' }),
  readIdentity: async () => structuredClone(identity),
  checkpointIdentity: async (_id, _base, _observed, state) => { identity = { revision: identity.revision + 1, state }; await writeFile(join(home, 'synthetic-identity.json'), JSON.stringify(identity), { mode: 0o600 }); return { ...structuredClone(identity), conflictCount: 0 }; },
});
browserHost = new PlaywrightBrowserHost(app.address().port, { registry, verifyCapability: async token => { assert.equal(token, capability); return binding; } });
const providerId = 'browser-acceptance'; const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
const provider = { id: providerId, name: 'Browser test provider', type: 'api', enabled: true, isBuiltin: false, config: { baseUrl }, authType: 'api_key', apiProtocol: 'anthropic', primaryModel: 'k3', models: [{ model: 'k3', modelName: 'Kimi K3' }] };
await mkdir(join(data, 'providers'));
await writeFile(join(data, 'providers', `${providerId}.json`), JSON.stringify(provider), { mode: 0o600 });
await writeFile(join(data, 'config.json'), JSON.stringify({ availableProvidersJson: JSON.stringify([provider]), providerApiKeys: { [providerId]: localToken }, defaultProviderId: providerId, defaultModel: 'k3', providerPrimaryModels: { [providerId]: 'k3' }, mcpEnabledServers: ['myagents-browser'], agents: [], defaultPermissionMode: 'custom', cliToolRegistryEnabled: false, floatingBallEnabled: false, liteLLMModelDataRefresh: false }), { mode: 0o600 });
await writeFile(join(data, 'projects.json'), JSON.stringify([{ id: 'browser-test', name: 'Browser acceptance', path: workspace, mcpEnabledServers: ['myagents-browser'] }]), { mode: 0o600 });
await writeFile(join(home, 'case.json'), JSON.stringify({ workspace, providerId, baseUrl, localToken, expected: marker, text: `用 moxbots-browser 技能完成一次受控网页测试。先调用该技能，然后只通过 myagents-browser 打开 http://127.0.0.1:${app.address().port}/form ，读取页面快照，在 Test phrase 中填写「浏览器完整流程验证」，点击 Submit test（本地测试表单，已授权提交），读取回执并截图保存到工作区。不要用 Bash、脚本、外网或直接 HTTP 代替浏览器，不读取其他文件。结束时回复页面上实际显示的回执编号与截图路径。` }), { mode: 0o600 });
const bundle = join(home, 'child.mjs');
await build({ entryPoints: [join(import.meta.dirname, 'provider-child.ts')], outfile: bundle, bundle: true, packages: 'external', platform: 'node', target: 'node24', format: 'esm', alias: { '@myagents/agent-network-protocol': join(root, 'node_modules/@myagents/agent-network-protocol/src/index.ts') }, define: appBuildDefines({ MYAGENTS_BUILD_PROFILE: 'moxbot' }), banner: { js: 'import {createRequire as __qaRequire} from "node:module"; const require=__qaRequire(import.meta.url);' } });
const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r)); const inbound = reservation.address().port; await new Promise(r => reservation.close(r));
const child = spawn('/usr/bin/sandbox-exec', ['-p', networkProfile(inbound, [upstream.address().port, app.address().port]), process.execPath, bundle], { cwd: home, detached: true, env: { HOME: home, USER: 'browser-qa', LOGNAME: 'browser-qa', TMPDIR: home, PATH: '/Applications/MoXBots.app/Contents/Resources/nodejs/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', MYAGENTS_MANAGEMENT_PORT: String(app.address().port), MYAGENTS_SIDECAR_ID: 'browser-test-sidecar' }, stdio: ['ignore','pipe','pipe'] });
const log = createWriteStream(join(home, 'child.log'), { mode: 0o600 }); child.stdout.pipe(log); child.stderr.pipe(log);
const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* SSE control line or an already exited owned process. */ } }, 240000);
let code;
try { code = await new Promise((r, reject) => { child.once('error', reject); child.once('close', r); }); }
finally {
 clearTimeout(timer); try { process.kill(-child.pid, 'SIGKILL'); } catch { /* SSE control line or an already exited owned process. */ }
 if (code === 0 && pageReceipt) {
   await registry.closeSessionContext(binding.productSessionId);
   binding = { ...binding, productSessionId: 'browser-test-second-session' };
   const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
   const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
   const client = new Client({ name: 'browser-cookie-recovery', version: '1' });
   try {
     await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.address().port}/mcp/browser`), { requestInit: { headers: { Authorization: `Bearer ${capability}` } } }));
     const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${app.address().port}/cookie-check` } });
     secondSession = { restoredCookie, success: navigation.isError !== true && JSON.stringify(navigation.content).includes('RESTORED') };
     assert.equal(secondSession.success, true);
   } finally { await client.close(); }
 }
 await browserHost.shutdown();
 for (const s of [app,upstream]) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
}
let result; try { result = JSON.parse(await readFile(join(home, 'provider-result.json'), 'utf8')); } catch (error) { failure ??= String(error); }
const receipt = { home, code, failure: failure ?? result?.failure, result: result?.result, pageReceipt, secondSession, calls, toolCalls, management, boundaries: { realProvider: 'Kimi Coding k3', realBrowser: true, lockedChromium: executablePath.includes('/runtime/'), headless: true, rustAuthority: 'synthetic', nativeUI: false, production: false, isolatedHome: true, realCredentialsInChild: false } };
await writeFile(join(home, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ receipt: join(home, 'receipt.json'), code, failure: receipt.failure, modelRequests: calls.length, toolCalls: toolCalls.map(x => x.name), pageReceipt }));
assert.equal(code, 0); assert.equal(receipt.failure, null); assert.equal(pageReceipt?.marker, marker); assert.ok(toolCalls.some(x => x.name === 'browser_take_screenshot'));
