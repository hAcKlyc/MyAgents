import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostSessionRequest, HostSessionMessage, HostSessionOperation } from '../server/host-session-protocol';
import { configureHost, configureProviderHost, readProviderConfigReceipt, extendedHostSettings, selectedHostProviderProfile, legacyHostRepresentable, HostManagementUpgradeRequired, readConfigReceipt, type HostConfig } from './management';
import { readNetworkStatus } from './network-status';
import { createHostResourceOwner, HostResourceError, type HostResourceRequest } from './resources';
import { connectHostManagementIpc } from './management-ipc';
import { createHostProviderCredentialOwner, HostProviderCredentialError, type ProviderCredentialInput } from './provider-credentials';
import { HOST_PROVIDER_REFERENCE, readHostSystemdCredential, resolveHostProviderCredential } from '../server/utils/host-credentials';

const stateDir = resolve(process.env.MYAGENTS_HOST_STATE_DIR ?? '/var/lib/myagents-host-test');
const socket = process.env.MYAGENTS_HOST_SOCKET ?? '/run/myagents-host-test/control.sock';
const home = join(stateDir, 'home');
const configPath = join(home, '.myagents', 'config.json');
const workspaceRoot = join(stateDir, 'workspaces');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 1024 * 1024;
type Active = { child: ChildProcess; generation: string; sessionId: string; closing: boolean };

async function jsonFile<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function workspacePath(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error('Workspace must be absolute');
  const root = await realpath(workspaceRoot);
  const target = await realpath(value);
  const subpath = relative(root, target);
  if (subpath === '..' || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)
    || !(await lstat(target)).isDirectory()) throw new Error('Workspace is outside the Host workspace root');
  return target;
}

async function serve(): Promise<void> {
  if (process.getuid?.() === 0) throw new Error('Run Host as the dedicated non-root service user');
  if (process.env.HOME !== home) throw new Error('Host HOME must match its isolated state directory');
  // --no-fork makes flock exec this Node process, preserving the locked fd.
  // Verify the kernel fact rather than trusting an environment flag. macOS is
  // used only for local controller tests; the installer only supports Linux.
  if (process.platform === 'linux') {
    const stat = await lstat(join(stateDir, 'host.lock'), { bigint: true });
    const major = ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & 0xfffff000n);
    const minor = (stat.dev & 0xffn) | ((stat.dev >> 12n) & 0xffffff00n);
    const locks = (await readFile('/proc/locks', 'utf8')).split('\n');
    const held = locks.some(line => {
      const fields = line.trim().split(/\s+/);
      if (fields[1] !== 'FLOCK' || fields[3] !== 'WRITE' || fields[4] !== String(process.pid)) return false;
      const device = fields[5]?.split(':');
      return device?.length === 3 && BigInt(`0x${device[0]}`) === major && BigInt(`0x${device[1]}`) === minor && BigInt(device[2]) === stat.ino;
    });
    if (!held) throw new Error('Start Host with flock --no-fork holding its state/host.lock');
  }
  process.umask(0o077);
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await mkdir(join(workspaceRoot, 'default'), { recursive: true, mode: 0o700 });
  const identityPath = join(stateDir, 'host-identity.json');
  let identity = await jsonFile<{ hostId: string; schemaVersion: number } | null>(identityPath, null);
  if (!identity) { identity = { hostId: randomUUID(), schemaVersion: 1 }; await atomicJson(identityPath, identity); }
  if (identity.schemaVersion !== 1 || !uuidPattern.test(identity.hostId)) throw new Error('Unsupported Host identity');
  let active: Active | null = null;
  let shuttingDown = false;
  let managementIpc: { close(): Promise<void> } | undefined;
  const resourceOwner = createHostResourceOwner({
    hostId: identity.hostId,
    roots: { workspaces: workspaceRoot },
  });
  let credentialOwner: ReturnType<typeof createHostProviderCredentialOwner> | undefined;
  if (process.env.MYAGENTS_HOST_PROVIDER_KEY_CREDENTIAL !== undefined) {
    if (process.env.MYAGENTS_HOST_PROVIDER_KEY_CREDENTIAL !== 'provider-key')
      throw new HostProviderCredentialError('HOST_PROVIDER_CREDENTIAL_KEY_INVALID');
    const storePath = join(stateDir, 'provider-credentials');
    let created = false;
    try { await mkdir(storePath, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    credentialOwner = createHostProviderCredentialOwner({
      hostId: identity.hostId, storePath,
      loadMasterKey: () => readHostSystemdCredential('provider-key', 32),
    });
    if (created) {
      // Initialization is allowed only for this just-created directory; losing
      // an established encrypted store is an error, never a revision reset.
      await credentialOwner.initialize();
      const parent = await open(stateDir, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
    credentialOwner.inspect();
  }
  let mutationTail: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, { active: Active; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'host-session-worker.mjs');

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => {});
    return result;
  }

  function workerCall(target: Active, operation: HostSessionOperation, args: Record<string, unknown> = {}): Promise<unknown> {
    if (target.closing && operation !== 'shutdown') return Promise.reject(new Error('Session is closing'));
    return new Promise((resolveCall, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Session request outcome is unconfirmed; inspect state, do not resend automatically')); }, 60000);
      pending.set(id, { active: target, resolve: resolveCall, reject, timer });
      target.child.send({ id, generation: target.generation, operation, args } as HostSessionRequest, (error) => {
        if (!error) return;
        const entry = pending.get(id);
        if (entry) { clearTimeout(entry.timer); pending.delete(id); entry.reject(new Error('Session transport failed; outcome is unconfirmed')); }
      });
    });
  }

  async function ensureSession(sessionId?: string): Promise<Active> {
    if (shuttingDown) throw new Error('Host is stopping');
    if (active) {
      if (sessionId && active.sessionId === sessionId && !active.closing) return active;
      throw new Error('First version allows one active Session; release it before opening another');
    }
    const config = await jsonFile<HostConfig>(configPath, {});
    const settings = config.hostSettings;
    if (!settings) throw new Error('Configure the Host before creating a Session');
    let workspace = await workspacePath(settings.workspace);
    if (sessionId) {
      if (!uuidPattern.test(sessionId)) throw new Error('Invalid Session ID');
      const rows = await jsonFile<Array<{ id: string; agentDir: string; runtime?: string }>>(join(home, '.myagents', 'sessions.json'), []);
      const row = rows.find(value => value.id === sessionId);
      if (!row || (row.runtime && row.runtime !== 'builtin')) throw new Error('Unknown or unsupported Session');
      workspace = await workspacePath(row.agentDir);
    }
    const generation = randomUUID();
    const childEnvironment = { ...process.env };
    let sessionProviderId=settings.providerId;
    if (sessionId) {
      const rows=await jsonFile<Array<{id:string;providerId?:string;providerRoute?:{kind:string;providerId:string}}>>(join(home,'.myagents','sessions.json'),[]);
      const meta=rows.find(row=>row.id===sessionId);
      if (meta?.providerRoute?.kind === 'provider') sessionProviderId=meta.providerRoute.providerId;
      else if (meta?.providerId) sessionProviderId=meta.providerId;
      else throw new Error('Session Provider identity is unavailable');
    }
    const hasDynamicCredential = config.providerApiKeys?.[sessionProviderId] === `host-provider-credential:${sessionProviderId}`;
    let credential = hasDynamicCredential ? credentialOwner?.readForExecution(sessionProviderId) : undefined;
    if (hasDynamicCredential && !credentialOwner) throw new HostProviderCredentialError('HOST_PROVIDER_CREDENTIAL_KEY_UNAVAILABLE');
    if (!hasDynamicCredential && sessionProviderId === 'moonshot-coding' && process.env.CREDENTIALS_DIRECTORY) {
      try { credential = resolveHostProviderCredential('systemd-credential:kimi'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    delete childEnvironment.MYAGENTS_HOST_PROVIDER_KEY_CREDENTIAL;
    delete childEnvironment.CREDENTIALS_DIRECTORY;
    const child = fork(workerPath, [], {
      cwd: dirname(workerPath),
      env: { ...childEnvironment, HOME: home, MYAGENTS_HOST_MODE: '1', MYAGENTS_HOST_WORKSPACE: workspace,
        MYAGENTS_HOST_CREDENTIAL_SOURCE: 'supervisor-ipc',
        MYAGENTS_HOST_SESSION_ID: sessionId ?? '', MYAGENTS_HOST_PROVIDER_ID: sessionProviderId,
        MYAGENTS_HOST_MODEL: settings.model, MYAGENTS_HOST_GENERATION: generation,
        MYAGENTS_HOST_EXECUTION_AUTHORIZED: settings.executionAuthorized ? '1' : '0' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const target: Active = { child, generation, sessionId: sessionId ?? '', closing: false };
    let credentialDelivered = false;
    active = target;
    child.on('exit', () => {
      if (active === target) active = null;
      for (const [id, entry] of pending) if (entry.active === target) {
        clearTimeout(entry.timer); pending.delete(id); entry.reject(new Error('Session process exited; inspect persisted state before retrying'));
      }
    });
    child.on('message', raw => {
      const reply = raw as HostSessionMessage;
      if (reply?.type === 'credential-needed') {
        if (credentialDelivered || reply.generation !== generation || Object.keys(reply).length !== 2) {
          child.kill('SIGTERM'); return;
        }
        credentialDelivered = true;
        child.send({ type: 'host-provider-snapshot', generation,
          providerId: sessionProviderId, credential: credential ?? null }, error => {
          if (error) child.kill('SIGTERM');
        });
        credential = undefined;
        return;
      }
      if (!reply || reply.generation !== generation || reply.type !== 'reply') return;
      const entry = pending.get(reply.id);
      if (!entry || entry.active !== target) return;
      clearTimeout(entry.timer); pending.delete(reply.id);
      if (reply.ok) entry.resolve(reply.data); else entry.reject(new Error(reply.error ?? 'Session request failed'));
    });
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => { target.closing = true; child.kill('SIGTERM'); reject(new Error('Session startup timed out')); }, 60000);
      const onMessage = (raw: unknown) => {
        const value = raw as { type?: string; generation?: string; sessionId?: string };
        if (value?.type !== 'ready' || value.generation !== generation || !value.sessionId || !uuidPattern.test(value.sessionId)) return;
        target.sessionId = value.sessionId; finish(); resolveReady();
      };
      const onExit = () => { finish(); reject(new Error('Session initialization failed')); };
      function finish() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); }
      const onError = () => { finish(); reject(new Error('Session process could not start')); };
      child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
    });
    return target;
  }

  async function release(target: Active): Promise<void> {
    target.closing = true;
    const exited = new Promise<void>(resolveExit => target.child.once('exit', () => resolveExit()));
    await workerCall(target, 'shutdown');
    await Promise.race([exited, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Session exit unconfirmed; owner remains held')), 15000); timer.unref();
    })]);
  }

  async function dispatch(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (path === '/host/status') {
      const config = await jsonFile<HostConfig>(configPath, {});
      return { hostId: identity!.hostId, version: 1, configured: Boolean(config.hostSettings),
        settings: config.hostSettings ?? null, activeSession: active ? { sessionId: active.sessionId, generation: active.generation, closing: active.closing } : null,
        stopping: shuttingDown, capabilities: ['local-session', 'permission', 'stop', 'persistent-history', 'local-config-receipt'],
        agentNet: await readNetworkStatus(process.env.MYAGENTS_HOST_NETWORK_STATUS,
          /^\d+$/.test(process.env.MYAGENTS_HOST_NETWORK_UID ?? '')
            ? Number(process.env.MYAGENTS_HOST_NETWORK_UID) : undefined, identity!.hostId),
        runtime: { node: process.versions.node, sdkBinaryPresent: existsSync(join(dirname(workerPath), 'claude-agent-sdk', 'claude')) } };
    }
    if (path === '/host/configure') return exclusive(() => configureHost({
      hostId: identity!.hostId, defaultWorkspace: join(workspaceRoot, 'default'),
      readConfig: () => jsonFile<HostConfig>(configPath, {}), writeConfig: config => atomicJson(configPath, config),
      workspacePath, busy: () => Boolean(active) || shuttingDown,
      credentialReference: credentialOwner ? HOST_PROVIDER_REFERENCE : undefined,
    }, body));
    if (path === '/host/receipt') return exclusive(async () => readConfigReceipt(await jsonFile<HostConfig>(configPath, {}), identity!.hostId, body));
    if (path === '/session/create') return exclusive(async () => {
      if (Object.keys(body).length) throw new Error('Session creation accepts no overrides');
      const target = await ensureSession();
      return { sessionId: target.sessionId, generation: target.generation };
    });
    if (path === '/session/list') {
      const rows = await jsonFile<Array<Record<string, unknown>>>(join(home, '.myagents', 'sessions.json'), []);
      return rows.map(row => ({ id: row.id, title: row.title, agentDir: row.agentDir, createdAt: row.createdAt, updatedAt: row.updatedAt }));
    }
    const match = /^\/session\/([0-9a-f-]+)\/(describe|send|state|result|permission|stop|release)$/.exec(path);
    if (!match || !uuidPattern.test(match[1])) throw new Error('Unknown Host operation');
    if (match[2] === 'release') return exclusive(async () => {
      const target = await ensureSession(match[1]);
      await release(target); return { released: true };
    });
    // Only lifecycle resolution holds the owner lock. Interactive responses
    // and Stop must not wait behind a send's dispatch acknowledgement.
    const target = await exclusive(() => ensureSession(match[1]));
    return workerCall(target, match[2] as HostSessionOperation, body);
  }

  async function dispatchManagement(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (shuttingDown) throw new Error('Host is stopping');
    return exclusive(async () => {
      if (shuttingDown) throw new Error('Host is stopping');
      if (method === 'host.capabilities') return {kind:'capabilities',version:1,methods:['host.snapshot','config.set','credential.set','resources.create','receipt.get','host.capabilities','host.inspect','config.provider.set','credential.provider.set','receipt.provider.get','resources.directory.list','resources.register'],providerKinds:['anthropic','openai'],limits:{directoryEntries:128,pathBytes:4096}};
      if (method === 'resources.directory.list') return resourceOwner.listDirectory(params as {rootId:string;relativePath:string;cursor?:string});
      if (method === 'config.provider.set') return configureProviderHost({
        hostId:identity!.hostId,defaultWorkspace:join(workspaceRoot,'default'),readConfig:()=>jsonFile<HostConfig>(configPath,{}),writeConfig:config=>atomicJson(configPath,config),workspacePath,busy:()=>Boolean(active)||shuttingDown,selectWorkspace:selection=>resourceOwner.selectWorkspace(selection),
      },params);
      if (method === 'credential.provider.set') {
        if (!credentialOwner) throw new HostProviderCredentialError('HOST_PROVIDER_CREDENTIAL_KEY_UNAVAILABLE');
        return {kind:'provider-credential-receipt',...await credentialOwner.write(params as unknown as ProviderCredentialInput)};
      }
      if (method === 'receipt.provider.get') {
        const id=params.mutationId as string;const provider=params.providerId as string;
        const receipt=params.owner === 'config' ? readProviderConfigReceipt(await jsonFile<HostConfig>(configPath,{}),identity!.hostId,provider,id) : credentialOwner?.receipt(id,provider);
        if (!receipt && !credentialOwner) throw new HostProviderCredentialError('HOST_PROVIDER_CREDENTIAL_KEY_UNAVAILABLE');
        return !receipt || receipt.status === 'not-found' ? {kind:'receipt-not-found',mutationId:id,owner:params.owner} : params.owner === 'config' ? receipt : {kind:'provider-credential-receipt',...receipt};
      }
      if (method === 'host.snapshot' || method === 'host.inspect') {
        const config=await jsonFile<HostConfig>(configPath,{});
        if (method === 'host.snapshot' && !legacyHostRepresentable(config)) throw new HostManagementUpgradeRequired();
        const value = (await dispatch('/host/status', {})) as Record<string, unknown>;
        return {
          kind: method === 'host.inspect' ? 'extended-snapshot' : 'snapshot',
          version: 1,
          hostId: value.hostId,
          configured: value.configured,
          settings: method === 'host.inspect' ? extendedHostSettings(config,{workspaces:workspaceRoot}) : value.settings,
          ...(method === 'host.inspect' ? {provider:selectedHostProviderProfile(config)} : {}),
          activeSession: value.activeSession,
          stopping: value.stopping,
          capabilities: value.capabilities,
          agentNet: value.agentNet,
          runtime: value.runtime,
          credentials: credentialOwner
            ? { ...credentialOwner.inspect(method === 'host.inspect' ? config.hostSettings?.providerId ?? 'moonshot-coding' : 'moonshot-coding'), writeAvailable: true }
            : { providerId: method === 'host.inspect' ? config.hostSettings?.providerId ?? 'moonshot-coding' : 'moonshot-coding', configured: false, revision: 0, writeAvailable: false },
          resources: await resourceOwner.inspect(),
        };
      }
      if (method === 'config.set') {
        const receipt = await configureHost(
          {
            hostId: identity!.hostId,
            defaultWorkspace: join(workspaceRoot, 'default'),
            readConfig: () => jsonFile<HostConfig>(configPath, {}),
            writeConfig: config => atomicJson(configPath, config),
            workspacePath,
            busy: () => Boolean(active) || shuttingDown,
            credentialReference: credentialOwner ? HOST_PROVIDER_REFERENCE : undefined,
          },
          params,
        );
        if (!('status' in receipt)) throw new Error('Untracked configuration result');
        if (receipt.status === 'persisted')
          return {
            kind: 'config-receipt',
            status: 'persisted',
            mutationId: receipt.mutationId,
            revision: receipt.revision,
            effect: receipt.effect,
            settings: receipt.settings,
          };
        return {
          kind: 'config-receipt',
          status: 'conflict',
          mutationId: receipt.mutationId,
          revision: receipt.revision,
          effect: receipt.effect,
        };
      }
      if (method === 'resources.create' || method === 'resources.register') {
        if (params.rootId !== 'workspaces') throw new HostResourceError('RESOURCE_ROOT_UNKNOWN');
        const result = await resourceOwner.mutate((method === 'resources.register' ? {...params,operation:'register'} : params) as unknown as HostResourceRequest);
        if (result.status === 'unconfirmed') return { kind: 'error', code: 'RESOURCE_UNCONFIRMED' };
        return { kind: 'resource-receipt', ...result };
      }
      if (method === 'credential.set') {
        if (!credentialOwner) throw new HostProviderCredentialError('HOST_PROVIDER_CREDENTIAL_KEY_UNAVAILABLE');
        return { kind: 'credential-receipt', ...await credentialOwner.write(params as unknown as ProviderCredentialInput) };
      }
      if (method === 'receipt.get') {
        const id = params.mutationId as string;
        if (params.owner === 'credentials') {
          if (!credentialOwner) throw new HostProviderCredentialError('HOST_PROVIDER_CREDENTIAL_KEY_UNAVAILABLE');
          const receipt = credentialOwner.receipt(id);
          return receipt.status === 'not-found'
            ? { kind: 'receipt-not-found', mutationId: id, owner: 'credentials' }
            : { kind: 'credential-receipt', ...receipt };
        }
        if (params.owner === 'config') {
          const receipt = await readConfigReceipt(await jsonFile<HostConfig>(configPath, {}), identity!.hostId, { mutationId: id });
          if (!receipt)
            return {
              kind: 'config-receipt',
              status: 'not-found',
              mutationId: id,
            };
          if (receipt.status === 'not-found')
            return {
              kind: 'config-receipt',
              status: 'not-found',
              mutationId: id,
            };
          return receipt.status === 'persisted'
            ? {
                kind: 'config-receipt',
                status: receipt.status,
                mutationId: receipt.mutationId,
                revision: receipt.revision,
                effect: receipt.effect,
                settings: receipt.settings,
              }
            : {
                kind: 'config-receipt',
                status: receipt.status,
                mutationId: receipt.mutationId,
                revision: receipt.revision,
                effect: receipt.effect,
              };
        }
        const receipt = await resourceOwner.receipt(id);
        return receipt ? { kind: 'resource-receipt', ...receipt } : { kind: 'receipt-not-found', mutationId: id, owner: 'resources' };
      }
      throw new Error('Unsupported management request');
    });
  }

  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.method !== 'POST' || incoming.url?.includes('?')) throw new Error('Only typed POST control operations are supported');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > MAX_BODY) throw new Error('Control request is too large');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid control request');
      const data = await dispatch(incoming.url ?? '', body as Record<string, unknown>);
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      outgoing.writeHead(409, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Host request failed' }));
    }
  });
  server.requestTimeout = 65000; server.headersTimeout = 10000;
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  // The installer holds flock across the entire process lifetime. Never unlink
  // a socket without that lock, which would admit two configuration owners.
  if (existsSync(socket)) {
    if (process.env.MYAGENTS_HOST_LOCK_HELD !== '1') throw new Error('Existing socket requires the service lock');
    const stat = await lstat(socket);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('Unsafe existing socket');
    await unlink(socket);
  }
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(socket, () => resolveListen()); });
  await chmod(socket, 0o600);
  const managementPath = process.env.MYAGENTS_HOST_MANAGEMENT_IPC;
  const managementUid = process.env.MYAGENTS_HOST_MANAGEMENT_NETWORK_UID;
  const managementGid = process.env.MYAGENTS_HOST_MANAGEMENT_GID;
  if (managementPath !== undefined || managementUid !== undefined || managementGid !== undefined) {
    try {
      if (managementPath === undefined || !managementUid || !managementGid || !/^[1-9][0-9]{0,9}$/.test(managementUid) || !/^[1-9][0-9]{0,9}$/.test(managementGid)) {
        throw new Error('Incomplete Host management IPC configuration');
      }
      managementIpc = await connectHostManagementIpc({
        socketPath: managementPath,
        expectedUid: Number(managementUid),
        expectedGid: Number(managementGid),
        dispatch: dispatchManagement,
        isShuttingDown: () => shuttingDown,
        onFailure: code => console.error(`Host management IPC stopped: ${code}`),
      });
    } catch (error) {
      server.close();
      await unlink(socket).catch(() => {});
      throw error;
    }
  }
  console.log(`MyAgents Host ready (local Unix socket${managementIpc ? ', management IPC connected' : ''})`);
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await managementIpc?.close();
    server.close();
    try { await exclusive(async () => { if (active) await release(active); }); }
    catch { process.exitCode = 1; }
    await unlink(socket).catch(() => {});
    process.exit(process.exitCode ?? 0);
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
}

async function control(path: string, body: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolveCall, reject) => {
    const call = request({ socketPath: socket, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8 * MAX_BODY) { response.destroy(); reject(new Error('Host reply too large')); } else chunks.push(chunk); });
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (!value.ok) throw new Error(value.error);
          console.log(JSON.stringify(value.data, null, 2)); resolveCall();
        } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    call.setTimeout(65000, () => call.destroy(new Error('Host request outcome unconfirmed; inspect state before retrying')));
    call.on('error', reject); call.end(JSON.stringify(body));
  });
}

async function stdinText(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > MAX_BODY) throw new Error('Input too large'); }
  return text;
}

async function main(): Promise<void> {
  const [command, sessionId, arg, decision] = process.argv.slice(2);
  if (command === '--serve') return serve();
  if (command === 'status' || command === 'doctor') return control('/host/status', {});
  if (command === 'configure') return control('/host/configure', JSON.parse(await stdinText()));
  if (command === 'receipt' && sessionId) return control('/host/receipt', { mutationId: sessionId });
  if (command === 'create') return control('/session/create', {});
  if (command === 'list') return control('/session/list', {});
  if (command && ['describe', 'state', 'result', 'stop', 'release'].includes(command) && sessionId) return control(`/session/${sessionId}/${command}`, {});
  if (command === 'send' && sessionId) return control(`/session/${sessionId}/send`, { text: await stdinText() });
  if (command === 'respond' && sessionId) return control(`/session/${sessionId}/permission`, JSON.parse(await stdinText()));
  if (command === 'permission' && sessionId && arg && ['allow_once', 'deny'].includes(decision)) return control(`/session/${sessionId}/permission`, { requestId: arg, decision });
  throw new Error('Usage: myagents-host status|doctor|configure < config.json|receipt MUTATION_UUID|create|list|send SESSION < prompt.txt|state/result/stop/release SESSION|permission SESSION REQUEST allow_once/deny');
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Host operation failed'); process.exitCode = 1; });
