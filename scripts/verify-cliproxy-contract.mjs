#!/usr/bin/env node
// Explicit native contract smoke. Uses a temporary empty auth directory and
// synthetic keys; it neither opens a browser nor accesses existing accounts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node scripts/verify-cliproxy-contract.mjs <verified-native-executable>');
const root = await mkdtemp(join(tmpdir(), 'myagents-cliproxy-contract-'));
const reserve = (port = 0) => new Promise((accept, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => accept(server));
});
const reserved = await reserve();
const port = reserved.address().port;
await new Promise(resolve => reserved.close(resolve));
const modelKey = randomBytes(32).toString('hex');
const managementKey = randomBytes(32).toString('hex');
const auth = join(root, 'auth');
// v8.0.79 enables its local bbolt KV store under auth-dir by default.
// Keep the native default: this cache shares the account directory lifecycle.
const assertNoCredentials = async () => {
  assert.deepEqual(await readdir(auth), ['kv.db']);
  const database = join(auth, 'kv.db');
  const metadata = await lstat(database);
  assert(metadata.isFile(), 'native KV must be a regular file');
  if (process.platform !== 'win32') assert.equal(metadata.mode & 0o777, 0o600);
  const bytes = await readFile(database);
  for (const value of [modelKey, managementKey, 'synthetic-late-code', 'synthetic-body-must-not-be-logged']) {
    assert(!bytes.includes(Buffer.from(value)), 'native KV must not retain smoke secrets or the rejected request body');
  }
};
await mkdir(auth, { mode: 0o700 });
const config = {
  host: '127.0.0.1', port, 'auth-dir': auth, 'api-keys': [modelKey],
  'remote-management': { 'allow-remote': false, 'secret-key': managementKey, 'disable-control-panel': true },
  plugins: { enabled: false }, pprof: { enable: false }, 'commercial-mode': true,
  'logging-to-file': false, 'request-log': false, 'usage-statistics-enabled': false, 'request-retry': 0,
  streaming: { 'keepalive-seconds': 15, 'bootstrap-retries': 0 },
  'claude-code': { 'disable-cloaking-model-list': true },
  'quota-exceeded': { 'switch-project': false, 'switch-preview-model': false, 'antigravity-credits': false },
};
// JSON is valid YAML; no serializer-specific behavior in the native harness.
await writeFile(join(root, 'config.yaml'), JSON.stringify(config), { mode: 0o600 });
const child = spawn(resolve(executable), ['-config', join(root, 'config.yaml'), '-local-model'], {
  cwd: root,
  env: Object.fromEntries(['HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'TMPDIR']
    .flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])),
  stdio: 'ignore',
});
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
const checks = [];
const request = (path, key, method = 'GET', body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5_000), redirect: 'error',
});
try {
  let ready = false;
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try { if ((await request('/healthz')).ok) { ready = true; break; } } catch { /* booting */ }
    await delay(100);
  }
  assert(ready, 'native health endpoint must start'); checks.push('health');
  assert.equal((await request('/v0/management/auth-files')).status, 401);
  assert.equal((await request('/v0/management/auth-files', modelKey)).status, 401);
  assert.deepEqual((await (await request('/v0/management/auth-files', managementKey)).json()).files, []);
  assert.equal((await request('/v1/models', managementKey)).status, 401);
  assert.deepEqual((await (await request('/v1/models', modelKey)).json()).data, []);
  checks.push('management-and-model-key-isolation');
  assert.equal((await request('/management.html')).status, 404); checks.push('no-management-webpage');
  const definitions = await (await request('/v0/management/model-definitions/antigravity', managementKey)).json();
  assert(Array.isArray(definitions.models) && definitions.models.length > 0);
  assert(definitions.models.every(model => typeof model.id === 'string'));
  checks.push('native-model-definitions');
  // Holding the callback port proves no webui/CLI forwarder is started by
  // this route. Rust, not the upstream process, will own this listener.
  const callback = await reserve(51121);
  try {
    const authorization = await (await request('/v0/management/antigravity-auth-url', managementKey)).json();
    assert(typeof authorization.state === 'string' && authorization.state.length > 0);
    const url = new URL(authorization.url);
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('state'), authorization.state);
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:51121/oauth-callback');
    const stateQuery = `?state=${encodeURIComponent(authorization.state)}`;
    assert.equal((await (await request(`/v0/management/get-auth-status${stateQuery}`, managementKey)).json()).status, 'wait');
    assert((await request(`/v0/management/oauth-session${stateQuery}`, managementKey, 'DELETE')).ok);
    const late = await request('/v0/management/oauth-callback', managementKey, 'POST', {
      provider: 'antigravity', state: authorization.state, code: 'synthetic-late-code',
    });
    assert(!late.ok, 'cancelled authorization must reject a late callback');
    checks.push('oauth-url-without-forwarder', 'exact-state-status-and-cancellation', 'late-callback-rejected');
    // A callback HTTP 200 acknowledges delivery, not a completed authorization.
    // Synthetic denial exercises the pinned native failure envelope offline.
    const denied = await (await request('/v0/management/antigravity-auth-url', managementKey)).json();
    const delivered = await request('/v0/management/oauth-callback', managementKey, 'POST', {
      provider: 'antigravity', state: denied.state, code: '', error: 'access_denied',
    });
    assert.equal(delivered.status, 200);
    let terminal;
    for (let i = 0; i < 30; i++) {
      terminal = await (await request(`/v0/management/get-auth-status?state=${encodeURIComponent(denied.state)}`, managementKey)).json();
      if (terminal.status !== 'wait') break;
      await delay(100);
    }
    assert.deepEqual(terminal, { status: 'error', error: 'Authentication failed' });
    assert.deepEqual((await (await request('/v0/management/auth-files', managementKey)).json()).files, []);
    checks.push('callback-accepted-before-native-failure', 'native-oauth-error-category');
  } finally { await new Promise(resolve => callback.close(resolve)); }
  const rejected = await request('/v1/messages', modelKey, 'POST', { model: 'synthetic-unavailable', max_tokens: 1,
    messages: [{ role: 'user', content: 'synthetic-body-must-not-be-logged' }] });
  assert(rejected.status >= 400, 'an account-free request for the synthetic model must fail');
  await delay(250);
  assert.deepEqual(await readdir(root), ['auth', 'config.yaml']);
  await assertNoCredentials();
  checks.push('no-error-body-or-credential-residue');
  console.log(JSON.stringify({ success: true, checks }, null, 2));
} finally {
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  await rm(root, { recursive: true, force: true });
}
