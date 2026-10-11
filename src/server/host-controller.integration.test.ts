import { spawn, type ChildProcess } from 'node:child_process';
import { build } from 'esbuild';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

let child: ChildProcess | undefined;
let scratch: string | undefined;
afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolveExit => child!.once('exit', resolveExit));
    child.kill('SIGTERM'); await exited;
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

it('persists Host identity and config CAS over a private Unix socket without model calls', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mah-host-'));
  const socket = join(scratch, 'control.sock');
  const entry = join(scratch, 'host-main.mjs');
  await build({ entryPoints: [resolve('src/host/main.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const call = (path: string, body: unknown = {}) => new Promise<{ ok: boolean; data: { hostId?: string; settings?: Record<string, unknown> }; error?: string }>((resolveCall, reject) => {
    const req = request({ socketPath: socket, path, method: 'POST' }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolveCall(JSON.parse(text))); res.on('error', reject);
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const start = async () => {
    const linux = process.platform === 'linux';
    child = spawn(linux ? '/usr/bin/flock' : process.execPath,
      linux ? ['--no-fork', '-n', join(scratch!, 'host.lock'), process.execPath, entry, '--serve'] : [entry, '--serve'],
      { env: { PATH: process.env.PATH, HOME: join(scratch!, 'home'),
        MYAGENTS_HOST_STATE_DIR: scratch, MYAGENTS_HOST_SOCKET: socket }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Host startup timeout')), 10000);
      child!.stdout!.on('data', chunk => { if (String(chunk).includes('Host ready')) { clearTimeout(timer); resolveReady(); } });
      child!.once('exit', () => { clearTimeout(timer); reject(new Error('Host exited before ready')); });
    });
  };
  await start();
  const initial = (await call('/host/status')).data;
  expect(initial).toMatchObject({ configured: false, agentNet: { available: false }, activeSession: null });
  const config = { expectedRevision: 0, providerId: 'moonshot-coding', model: 'k3', executionAuthorized: false };
  const updates = await Promise.all([call('/host/configure', config), call('/host/configure', config)]);
  expect(updates.filter(value => value.ok)).toHaveLength(1);
  expect(updates.filter(value => !value.ok)[0].error).toContain('conflict');
  const stored = JSON.parse(await readFile(join(scratch, 'home', '.myagents', 'config.json'), 'utf8'));
  expect(stored.hostSettings.revision).toBe(1);
  expect(stored.providerApiKeys).toEqual({ 'moonshot-coding': 'systemd-credential:kimi' });
  expect((await call('/host/configure', { ...config, expectedRevision: 1, apiKey: 'must-not-save' })).ok).toBe(false);
  expect((await call('/host/configure', { ...config, expectedRevision: 1, workspace: tmpdir() })).ok).toBe(false);
  const outside = join(scratch, 'outside'); await mkdir(outside);
  await symlink(outside, join(scratch, 'workspaces', 'escape'));
  expect((await call('/host/configure', { ...config, expectedRevision: 1, workspace: join(scratch, 'workspaces', 'escape') })).ok).toBe(false);
  expect((await call('/host/arbitrary-shell', { command: 'echo unsafe' })).ok).toBe(false);
  expect((await call('/session/list')).data).toEqual([]);
  const exited = new Promise(resolveExit => child!.once('exit', resolveExit)); child!.kill('SIGTERM'); await exited;
  await start();
  const restored = (await call('/host/status')).data;
  expect(restored.hostId).toBe(initial.hostId);
  expect(restored.settings).toMatchObject({ revision: 1, model: 'k3', executionAuthorized: false });
});
