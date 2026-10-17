import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { build } from 'esbuild';
import { dshBuildDefines } from '../integrated-runtimes/dsh-build-selection.mjs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const node24 = process.env.MYAGENTS_HOST_TEST_NODE || process.execPath;
const root = resolve(import.meta.dirname, '../..');

test('Host build, bootstrap and installers agree on the two closed profile namespaces', () => {
  const buildSource = readFileSync(join(root, 'scripts/host/build.mjs'), 'utf8');
  const installSource = readFileSync(join(root, 'scripts/host/install.sh'), 'utf8');
  const networkSource = readFileSync(join(root, 'scripts/host/network-install.py'), 'utf8');
  const unifiedSource = readFileSync(join(root, 'scripts/host/unified-install.py'), 'utf8');
  for (const profile of ['myagents-test', 'moxbot-test']) {
    assert.ok(buildSource.includes(`'${profile}':`));
    assert.ok(installSource.includes(`${profile})`));
    assert.ok(networkSource.includes(`"${profile}"`));
    assert.ok(unifiedSource.includes(`"${profile}"`));
  }
  assert.match(buildSource, /MYAGENTS_HOST_PROFILE/);
  assert.match(installSource, /Profile must be myagents-test or moxbot-test/);
  assert.match(networkSource, /choices=\("myagents-test", "moxbot-test"\)/);
  assert.match(unifiedSource, /choices=\("myagents-test", "moxbot-test"\)/);
  assert.match(installSource, /manifest_profile != expected_profile/);
  assert.match(installSource, /expected_profile == 'myagents-test'/);
});
const runnerVersion = execFileSync(node24, ['--version'], { encoding: 'utf8' }).trim();
test('Node 24 ESM worker bundle starts without credentials, persists Session v2, and shuts down', { skip: !/^v24\./.test(runnerVersion) }, async t => {
  const runtime = resolve(node24);
  const version = execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim();
  assert.match(version, /^v24\./);
  const temp = mkdtempSync(join(tmpdir(), 'myagents-host-worker-boot-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const bundle = join(temp, 'resources/host-session-worker.mjs');
  mkdirSync(dirname(bundle), { recursive: true });
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  await build({
    entryPoints: [join(root, 'src/server/host-session-worker.ts')], outfile: bundle, bundle: true,
    platform: 'node', format: 'esm', target: 'node24',
    banner: { js: 'import { createRequire as __myAgentsCreateRequire } from "module"; const require = __myAgentsCreateRequire(import.meta.url);' },
    external: ['playwright', 'playwright/*', 'playwright-core', 'playwright-core/*', '@playwright/mcp', '@playwright/mcp/*'],
    define: {
      ...dshBuildDefines(root), __MYAGENTS_VERSION__: JSON.stringify(packageJson.version),
      __MYAGENTS_BUILD_IDENTITY__: JSON.stringify({ version: packageJson.version, mode: 'bundle', capturedAt: new Date().toISOString(), commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0 }),
    },
  });
  const home = join(temp, 'home');
  const workspace = join(temp, 'workspace');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: home, MYAGENTS_HOST_MODE: '1', MYAGENTS_HOST_WORKSPACE: workspace,
    MYAGENTS_HOST_SESSION_ID: '', MYAGENTS_HOST_PROVIDER_ID: 'anthropic-sub', MYAGENTS_HOST_MODEL: 'claude-sonnet-4-6',
    MYAGENTS_HOST_GENERATION: randomUUID(), MYAGENTS_HOST_EXECUTION_AUTHORIZED: '0',
    MYAGENTS_HOST_MAX_TURNS: '1', MYAGENTS_HOST_MAX_BUDGET_USD: '0.05' };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CREDENTIALS_DIRECTORY']) delete env[key];
  const generation = env.MYAGENTS_HOST_GENERATION;
  const child = fork(bundle, [], { cwd: dirname(bundle), execPath: runtime, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const messages = [];
  child.on('message', message => messages.push(message));
  const waitFor = async predicate => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const match = messages.find(predicate);
      if (match) return match;
      if (child.exitCode !== null) throw new Error(`worker exited ${child.exitCode}: ${stderr}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    throw new Error(`timed out waiting for worker IPC: ${stderr}`);
  };
  try {
    const ready = await waitFor(message => message?.type === 'ready');
    assert.equal(ready.generation, generation);
    assert.match(ready.sessionId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    const requestId = randomUUID();
    child.send({ id: requestId, generation, operation: 'shutdown', args: {} });
    const reply = await waitFor(message => message?.type === 'reply' && message.id === requestId);
    assert.equal(reply.ok, true);
    let exitTimer;
    const exitResult = await Promise.race([exited, new Promise((_, rejectExit) => {
      exitTimer = setTimeout(() => rejectExit(new Error(`worker did not exit after shutdown: ${stderr}`)), 30_000);
    })]);
    clearTimeout(exitTimer);
    assert.deepEqual(exitResult, { code: 0, signal: null }, stderr);
    const sessionFiles = readdirSync(join(home, '.myagents', 'sessions-v2'));
    const transcript = sessionFiles.find(name => name.startsWith(ready.sessionId));
    assert.ok(transcript, 'worker must persist its created Session in sessions-v2');
    const lines = readFileSync(join(home, '.myagents', 'sessions-v2', transcript), 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'persisted Session v2 transcript must contain an event');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
