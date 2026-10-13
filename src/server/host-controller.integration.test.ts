import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configureHost, createHostConfigMutationOwner, readConfigReceipt, withHostConfigurationLocks, withHostSnapshotLocks, type HostConfig, type HostConfigOwner } from '../host/management';

let child: ChildProcess | undefined;
let scratch: string | undefined;
async function stopChild(): Promise<void> {
  const target = child;
  if (!target || target.exitCode !== null || target.signalCode !== null) return;
  const waitForExit = (timeoutMs: number) => new Promise<boolean>(resolveExit => {
    const done = () => { clearTimeout(timer); target.off('exit', done); resolveExit(true); };
    const timer = setTimeout(() => { target.off('exit', done); resolveExit(false); }, timeoutMs);
    target.once('exit', done);
    if (target.exitCode !== null || target.signalCode !== null) done();
  });
  target.kill('SIGTERM');
  if (!await waitForExit(3000) && target.exitCode === null && target.signalCode === null) {
    target.kill('SIGKILL');
    if (!await waitForExit(3000) && target.exitCode === null && target.signalCode === null)
      throw new Error('Host controller child did not exit after SIGKILL');
  }
}
afterEach(async () => {
  await stopChild();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

it('preserves concurrent Bot/resource config projections during a Host configuration commit', async () => {
  let shared: HostConfig = {
    providerApiKeys: { 'other-provider': 'other-secret' },
    hostBotDelegationsV1: { revision: 4, bots: ['bot-ledger-latest'] },
    hostResourceIntents: { revision: 7, intents: ['resource-ledger-latest'] },
  };
  const owner: HostConfigOwner = createHostConfigMutationOwner({
    hostId: randomUUID(), defaultWorkspace: tmpdir(),
    readConfig: async () => structuredClone(shared),
    atomicModifyConfig: async modifier => { shared = modifier(shared); },
    workspacePath: async value => {
      // Model a Bot/resource owner committing after Host read but before its
      // commit. The Host writer must patch only its own fields into this latest
      // config rather than replacing the whole file with its stale read.
      shared = {
        ...shared,
        hostBotDelegationsV1: { revision: 5, bots: ['bot-ledger-newer'] },
        hostResourceIntents: { revision: 8, intents: ['resource-ledger-newer'] },
        providerApiKeys: { ...shared.providerApiKeys, 'other-provider': 'rotated-other-secret' },
      };
      return value;
    },
    busy: () => false,
    credentialReference: 'host-provider-credential:moonshot-coding',
  });
  const result = await configureHost(owner, {
    mutationId: randomUUID(), expectedRevision: 0, providerId: 'moonshot-coding',
    model: 'k3', executionAuthorized: false,
  });
  expect(result).toMatchObject({ status: 'persisted', revision: 1 });
  expect(shared).toMatchObject({
    hostBotDelegationsV1: { revision: 5, bots: ['bot-ledger-newer'] },
    hostResourceIntents: { revision: 8, intents: ['resource-ledger-newer'] },
    providerApiKeys: { 'other-provider': 'rotated-other-secret', 'moonshot-coding': 'host-provider-credential:moonshot-coding' },
    hostSettings: { revision: 1, model: 'k3' },
  });
});

it('uses registration-before-supervisor ordering for Bot runtime and Host snapshot inspection', async () => {
  const mutex = () => {
    let tail = Promise.resolve();
    return async <T,>(operation: () => Promise<T>): Promise<T> => {
      const prior = tail;
      let release!: () => void;
      tail = new Promise<void>(resolveRelease => { release = resolveRelease; });
      await prior;
      try { return await operation(); } finally { release(); }
    };
  };
  const registrationLock = mutex();
  const supervisorLock = mutex();
  const withRegistration = <T,>(operation: () => Promise<T>) => registrationLock(operation);
  const withSupervisor = <T,>(operation: () => Promise<T>) => supervisorLock(operation);
  const events: string[] = [];
  const botRuntime = withHostConfigurationLocks(withRegistration, withSupervisor, async () => {
    events.push('bot-runtime'); return 'ready';
  });
  const snapshot = withHostSnapshotLocks(
    () => withRegistration(async () => { events.push('resource-inspect'); return 'resource-snapshot'; }),
    withSupervisor,
    async resources => { events.push('host-snapshot'); return resources; },
  );
  const bounded = Promise.race([
    Promise.all([botRuntime, snapshot]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lock order deadlocked')), 1000)),
  ]);
  await expect(bounded).resolves.toEqual(['ready', 'resource-snapshot']);
  expect(events).toContain('resource-inspect');
  expect(events).toContain('host-snapshot');
  expect(events).toContain('bot-runtime');
});

it('persists Host identity and config CAS over a private Unix socket without model calls', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mah-host-'));
  const socket = join(scratch, 'control.sock');
  const entry = join(scratch, 'host-main.mjs');
  await build({ entryPoints: [resolve('src/host/main.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    // Match the shipped ESM bundle's CJS dependency bridge, required by the
    // actual registry owner now imported by Host main.
    banner: { js: 'import { createRequire as __myAgentsCreateRequire } from "module"; const require = __myAgentsCreateRequire(import.meta.url);' },
  });
  const call = (path: string, body: unknown = {}) => new Promise<{ ok: boolean; data: { hostId?: string; settings?: Record<string, unknown>; revision?: number; status?: string }; error?: string }>((resolveCall, reject) => {
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
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Host startup timeout: ${output.slice(-2000)}`)), 10000);
      const onData = (chunk: Buffer) => {
        output += String(chunk);
        if (output.includes('Host ready')) { clearTimeout(timer); resolveReady(); }
      };
      child!.stdout!.on('data', onData);
      child!.stderr!.on('data', chunk => { output += String(chunk); });
      child!.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Host exited before ready (code=${code}, signal=${signal}): ${output.slice(-2000)}`));
      });
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
  const conflictId = randomUUID();
  const conflict = await call('/host/configure', { ...config, mutationId: conflictId });
  expect(conflict).toMatchObject({ ok: true, data: { mutationId: conflictId, status: 'conflict', revision: 1, effect: 'none' } });
  const tracked = { ...config, expectedRevision: 1, mutationId: randomUUID() };
  const duplicate = await Promise.all([call('/host/configure', tracked), call('/host/configure', tracked)]);
  expect(duplicate[0]).toEqual(duplicate[1]);
  expect(duplicate[0]).toMatchObject({ ok: true, data: { status: 'persisted', revision: 2, effect: 'new-session' } });
  expect((await call('/host/configure', { ...tracked, model: 'different-model' })).ok).toBe(false);
  expect((await call('/host/configure', { ...tracked, expectedRevision: 2 })).ok).toBe(false);
  expect((await call('/host/configure', { ...tracked, mutationId: 'not-a-uuid' })).ok).toBe(false);
  expect((await call('/host/receipt', { mutationId: tracked.mutationId, apiKey: 'must-not-save' })).ok).toBe(false);
  const persistedPath = join(scratch, 'home', '.myagents', 'config.json');
  const trackedConfig = JSON.parse(await readFile(persistedPath, 'utf8'));
  expect(trackedConfig.hostSettings.revision).toBe(2);
  expect(trackedConfig.hostConfigReceipts.entries).toHaveLength(2);
  expect(trackedConfig.hostConfigReceipts.hostId).toBe(initial.hostId);
  expect(JSON.stringify(trackedConfig.hostConfigReceipts)).not.toContain('must-not-save');
  expect((await stat(persistedPath)).mode & 0o777).toBe(0o600);
  // Replaying a committed ID does not re-resolve a now-missing workspace.
  await rm(join(scratch, 'workspaces', 'default'), { recursive: true });
  expect(await call('/host/configure', { ...tracked, mutationId: tracked.mutationId.toUpperCase() })).toEqual(duplicate[0]);
  await stopChild();
  await start();
  const restored = (await call('/host/status')).data;
  expect(restored.hostId).toBe(initial.hostId);
  expect(restored.settings).toMatchObject({ revision: 2, model: 'k3', executionAuthorized: false });
  expect(await call('/host/receipt', { mutationId: tracked.mutationId })).toEqual(duplicate[0]);
  expect(await call('/host/receipt', { mutationId: conflictId })).toEqual(conflict);
  expect(await call('/host/configure', tracked)).toEqual(duplicate[0]);
  expect((await call('/host/receipt', { mutationId: randomUUID() })).data.status).toBe('not-found');
  // Full ledgers preserve every old receipt, and retain legacy local configure.
  const full = { ...trackedConfig, hostConfigReceipts: { ...trackedConfig.hostConfigReceipts,
    entries: Array.from({ length: 256 }, () => ({ ...trackedConfig.hostConfigReceipts.entries[0],
      receipt: { ...trackedConfig.hostConfigReceipts.entries[0].receipt, mutationId: randomUUID() } })),
  } };
  await writeFile(persistedPath, JSON.stringify(full));
  expect((await call('/host/configure', { ...tracked, expectedRevision: 2, mutationId: randomUUID() })).error).toContain('capacity');
  expect((await call('/host/receipt', { mutationId: full.hostConfigReceipts.entries[0].receipt.mutationId })).ok).toBe(true);
  expect((await call('/host/configure', { ...config, expectedRevision: 2 })).data.revision).toBe(3);
  const afterFull = JSON.parse(await readFile(persistedPath, 'utf8'));
  expect(afterFull.hostConfigReceipts).toEqual(full.hostConfigReceipts);
  await writeFile(persistedPath, JSON.stringify({ ...afterFull, hostConfigReceipts: { schemaVersion: 99 } }));
  expect((await call('/host/receipt', { mutationId: tracked.mutationId })).error).toContain('ledger is invalid');
  expect((await call('/host/configure', { ...config, expectedRevision: 3 })).error).toContain('ledger is invalid');
  expect(JSON.parse(await readFile(persistedPath, 'utf8')).hostSettings.revision).toBe(3);
});

it('recovers tracked configuration outcomes after commit faults and permits receipt replay while busy', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mah-receipt-fault-'));
  const path = join(scratch, 'config.json');
  await writeFile(path, '{}', { mode: 0o600 });
  let fault: 'before' | 'after' | null = 'before';
  let busy = false;
  let workspaceAvailable = true;
  const owner = {
    hostId: randomUUID(), defaultWorkspace: join(scratch, 'workspace'),
    readConfig: async () => JSON.parse(await readFile(path, 'utf8')) as HostConfig,
    writeConfig: async (config: HostConfig) => {
      if (fault === 'before') throw new Error('injected pre-commit failure');
      await writeFile(`${path}.tmp`, JSON.stringify(config));
      await rename(`${path}.tmp`, path);
      if (fault === 'after') throw new Error('injected post-rename notification failure');
    },
    workspacePath: async (value: string) => {
      if (!workspaceAvailable) throw new Error('Workspace is unavailable');
      return value;
    },
    busy: () => busy,
  };
  const patch = { mutationId: randomUUID(), expectedRevision: 0, providerId: 'moonshot-coding', model: 'k3', executionAuthorized: false };
  await expect(configureHost(owner, patch)).rejects.toThrow('outcome is unconfirmed');
  expect(readConfigReceipt(await owner.readConfig(), owner.hostId, { mutationId: patch.mutationId })).toMatchObject({ status: 'not-found' });
  expect((await owner.readConfig()).hostSettings).toBeUndefined();
  fault = 'after';
  await expect(configureHost(owner, patch)).rejects.toThrow('outcome is unconfirmed');
  const receipt = readConfigReceipt(await owner.readConfig(), owner.hostId, { mutationId: patch.mutationId });
  expect(receipt).toMatchObject({ status: 'persisted', revision: 1, effect: 'new-session' });
  // Same ID is recovered before both busy and filesystem admission checks.
  busy = true; workspaceAvailable = false;
  expect(await configureHost(owner, { ...patch, workspace: owner.defaultWorkspace })).toEqual(receipt);
  await expect(configureHost(owner, { ...patch, mutationId: randomUUID(), expectedRevision: 1 })).rejects.toThrow('Release the active Session');
  expect((await owner.readConfig()).hostSettings?.revision).toBe(1);
  expect(await configureHost(owner, patch)).toEqual(receipt);
  const wrongHost = { ...owner, hostId: randomUUID() };
  await expect(configureHost(wrongHost, patch)).rejects.toThrow('ledger is invalid');
});
