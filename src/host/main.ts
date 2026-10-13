import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostSessionRequest, HostSessionMessage, HostSessionOperation } from '../server/host-session-protocol';
import { configureHost, createHostConfigMutationOwner, readConfigReceipt, withHostConfigurationLocks, withHostSnapshotLocks, type ConfigReceipt, type HostConfig } from './management';
import { readNetworkStatus } from './network-status';
import { parseHostBotBootstrap, type HostBotBootstrap } from './bot-session-bootstrap';
import type { BotRunIdentity } from './bot-runtime';
import { createBotSessionAdapter } from './bot-session-adapter';
import { loadBotExecutionPolicy } from './bot-execution-policy';
import { connectBotExecutionIpc } from './bot-execution-ipc';
import { createHostBotManager } from './bot-management';
import { stopBotChild } from './bot-child-stop';
import { atomicModifyConfig, loadConfig, loadProjects, materializeProviderRouteEnv } from '../server/utils/admin-config';
import { createConcreteProviderRoute } from '../shared/providerRoute';
import { createHostResourceOwner, HostResourceError, type HostResourceRequest } from './resources';
import { connectHostManagementIpc } from './management-ipc';
import { createHostProviderCredentialOwner, HostProviderCredentialError, type ProviderCredentialInput } from './provider-credentials';
import { HOST_PROVIDER_REFERENCE, readHostSystemdCredential, resolveHostProviderCredential } from '../server/utils/host-credentials';
import { withWorkspaceAgentRegistrationIntent } from '../server/utils/agent-workspace-identity';

const stateDir = resolve(process.env.MYAGENTS_HOST_STATE_DIR ?? '/var/lib/myagents-host-test');
const socket = process.env.MYAGENTS_HOST_SOCKET ?? '/run/myagents-host-test/control.sock';
const home = join(stateDir, 'home');
const configPath = join(home, '.myagents', 'config.json');
const workspaceRoot = join(stateDir, 'workspaces');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 1024 * 1024;
type Active = { child: ChildProcess; generation: string; sessionId: string; closing: boolean; bot?: BotRunIdentity };

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
  const exitedBots = new Map<string,BotRunIdentity>();
  let botExecutionIpc: Awaited<ReturnType<typeof connectBotExecutionIpc>> | undefined;
  let botPolicyTimer:NodeJS.Timeout|undefined;
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

  async function configureHostOwned(body: Record<string, unknown>): Promise<ConfigReceipt | { persisted: true; revision: number; effect: 'new-session'; settings: NonNullable<HostConfig['hostSettings']> }> {
    return withHostConfigurationLocks(
      operation => withWorkspaceAgentRegistrationIntent(() => operation(), { strictPersistence: true, notify: false }),
      exclusive,
      async () => configureHost(createHostConfigMutationOwner({
        hostId: identity!.hostId,
        defaultWorkspace: join(workspaceRoot, 'default'),
        readConfig: async () => loadConfig({ strict: true }) as HostConfig,
        atomicModifyConfig: async modify => { await atomicModifyConfig(current => modify(current as HostConfig) as typeof current, { strict: true }); },
        workspacePath,
        busy: () => Boolean(active) || shuttingDown,
        credentialReference: credentialOwner ? HOST_PROVIDER_REFERENCE : undefined,
      }), body),
    );
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

  async function ensureSession(sessionId?: string, botBootstrap?: HostBotBootstrap): Promise<Active> {
    if (shuttingDown) throw new Error('Host is stopping');
    if (active) {
      if (sessionId && active.sessionId === sessionId && !active.closing) return active;
      throw new Error('First version allows one active Session; release it before opening another');
    }
    const bot = botBootstrap ? parseHostBotBootstrap(botBootstrap) : undefined;
    if (bot && sessionId) throw new Error('BOT_PRIVATE_SESSION_FORBIDDEN');
    const config = await jsonFile<HostConfig>(configPath, {});
    const settings = bot ? undefined : config.hostSettings;
    if (!bot && !settings) throw new Error('Configure the Host before creating a Session');
    let workspace = await workspacePath(bot?.workspace ?? settings!.workspace);
    if (sessionId) {
      if (!uuidPattern.test(sessionId)) throw new Error('Invalid Session ID');
      const rows = await jsonFile<Array<{ id: string; agentDir: string; runtime?: string }>>(join(home, '.myagents', 'sessions.json'), []);
      const row = rows.find(value => value.id === sessionId);
      if (!row || (row.runtime && row.runtime !== 'builtin')) throw new Error('Unknown or unsupported Session');
      workspace = await workspacePath(row.agentDir);
    }
    const generation = bot?.run_generation ?? randomUUID();
    const childEnvironment: NodeJS.ProcessEnv = bot ? {PATH:process.env.PATH,LANG:process.env.LANG,TMPDIR:process.env.TMPDIR,USERPROFILE:home} : {...process.env};
    const hasDynamicCredential = !bot && config.providerApiKeys?.['moonshot-coding'] === HOST_PROVIDER_REFERENCE;
    let credential = hasDynamicCredential ? credentialOwner?.readForExecution('moonshot-coding') : undefined;
    if (hasDynamicCredential && !credentialOwner) throw new HostProviderCredentialError('HOST_PROVIDER_CREDENTIAL_KEY_UNAVAILABLE');
    if (!bot && !hasDynamicCredential && process.env.CREDENTIALS_DIRECTORY) {
      try { credential = resolveHostProviderCredential('systemd-credential:kimi'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    delete childEnvironment.MYAGENTS_HOST_PROVIDER_KEY_CREDENTIAL;
    delete childEnvironment.CREDENTIALS_DIRECTORY;
    const child = fork(workerPath, [], {
      cwd: dirname(workerPath),
      env: { ...childEnvironment, HOME: home, MYAGENTS_HOST_MODE: '1', MYAGENTS_HOST_WORKSPACE: workspace,
        MYAGENTS_HOST_CREDENTIAL_SOURCE: 'supervisor-ipc',
        MYAGENTS_HOST_SESSION_ID: sessionId ?? '', MYAGENTS_HOST_PROVIDER_ID: bot?.provider_id ?? settings!.providerId,
        MYAGENTS_HOST_MODEL: bot?.model ?? settings!.model, MYAGENTS_HOST_GENERATION: generation,
        MYAGENTS_HOST_EXECUTION_AUTHORIZED: !bot && settings?.executionAuthorized ? '1' : '0',
        ...(bot ? {MYAGENTS_HOST_BOT_BOOTSTRAP:Buffer.from(JSON.stringify(bot)).toString('base64url')} : {}) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const target: Active = { child, generation, sessionId: sessionId ?? '', closing: false };
    let credentialDelivered = false;
    active = target;
    child.on('exit', () => {
      if (target.bot) {exitedBots.set(target.bot.run_generation,{...target.bot});if(exitedBots.size>256)exitedBots.delete(exitedBots.keys().next().value!);}
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
          providerId: 'moonshot-coding', credential: credential ?? null }, error => {
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
        const value = raw as { type?: string; generation?: string; sessionId?: string; bot?: BotRunIdentity };
        if (value?.type !== 'ready' || value.generation !== generation || !value.sessionId || !uuidPattern.test(value.sessionId)) return;
        if (bot && (!value.bot || value.bot.bot_id!==bot.snapshot.bot_id || value.bot.agent_id!==bot.snapshot.agent_id ||
            value.bot.binding_generation!==bot.snapshot.binding_generation || value.bot.session_id!==value.sessionId ||
            value.bot.run_generation!==generation || value.bot.snapshot_hash!==bot.snapshot.snapshot_hash || value.bot.runtime!=='builtin')) {
          target.closing=true; child.kill('SIGTERM'); finish(); reject(new Error('BOT_RUN_BINDING_MISMATCH')); return;
        }
        if (!bot && value.bot) {target.closing=true; child.kill('SIGTERM'); finish(); reject(new Error('BOT_RUN_BINDING_MISMATCH')); return;}
        target.bot=value.bot; target.sessionId = value.sessionId; finish(); resolveReady();
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
    if(target.bot){await stopBotChild(target.child,()=>workerCall(target,'shutdown'));return;}
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
    if (path === '/host/configure') return configureHostOwned(body);
    if (path === '/host/receipt') return readConfigReceipt(loadConfig({ strict: true }) as HostConfig, identity!.hostId, body);
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
    if (active?.bot && active.sessionId===match[1]) throw new Error('Delegated Bot Session requires its exact Bot owner; private Session endpoints are unavailable');
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
    if (method === 'host.snapshot') {
      return withHostSnapshotLocks(
        () => resourceOwner.inspect(),
        exclusive,
        async resources => {
        if (shuttingDown) throw new Error('Host is stopping');
        const value = (await dispatch('/host/status', {})) as Record<string, unknown>;
        return {
          kind: 'snapshot',
          version: 1,
          hostId: value.hostId,
          configured: value.configured,
          settings: value.settings,
          activeSession: value.activeSession,
          stopping: value.stopping,
          capabilities: value.capabilities,
          agentNet: value.agentNet,
          runtime: value.runtime,
          credentials: credentialOwner
            ? { ...credentialOwner.inspect(), writeAvailable: true }
            : { providerId: 'moonshot-coding', configured: false, revision: 0, writeAvailable: false },
          resources,
        };
        },
      );
    }
    if (method === 'config.set') {
      const receipt = await configureHostOwned(params);
      if (!('status' in receipt)) throw new Error('Untracked configuration result');
      return receipt.status === 'persisted'
        ? { kind: 'config-receipt', status: receipt.status, mutationId: receipt.mutationId,
            revision: receipt.revision, effect: receipt.effect, settings: receipt.settings }
        : { kind: 'config-receipt', status: receipt.status, mutationId: receipt.mutationId,
            revision: receipt.revision, effect: receipt.effect };
    }
    if (method === 'resources.create') {
      if (params.rootId !== 'workspaces') throw new HostResourceError('RESOURCE_ROOT_UNKNOWN');
      const result = await resourceOwner.mutate(params as unknown as HostResourceRequest);
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
        const receipt = await readConfigReceipt(loadConfig({ strict: true }) as HostConfig, identity!.hostId, { mutationId: id });
        return receipt.status === 'not-found'
          ? { kind: 'config-receipt', status: 'not-found', mutationId: id }
          : { kind: 'config-receipt', ...receipt };
      }
      const receipt = await resourceOwner.receipt(id);
      return receipt ? { kind: 'resource-receipt', ...receipt } : { kind: 'receipt-not-found', mutationId: id, owner: 'resources' };
    }
    throw new Error('Unsupported management request');
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
  let policyPin: Awaited<ReturnType<typeof loadBotExecutionPolicy>>;
  try { policyPin = await loadBotExecutionPolicy(join(stateDir,'bot-execution-policy.json'),identity.hostId); }
  catch(error) {
    await managementIpc?.close();
    await new Promise<void>(resolveClose=>server.close(()=>resolveClose()));
    await unlink(socket).catch(()=>{});
    throw error;
  }
  if (policyPin) {
    const {policy}=policyPin;
    const sameRun=(a:BotRunIdentity,b:BotRunIdentity)=>a.bot_id===b.bot_id && a.agent_id===b.agent_id &&
      a.binding_generation===b.binding_generation && a.run_generation===b.run_generation && a.session_id===b.session_id &&
      a.snapshot_hash===b.snapshot_hash && a.runtime===b.runtime;
    const adapter=createBotSessionAdapter({
      async resolve(snapshot) {
        await policyPin.assertCurrent();
        const binding=snapshot.config.model_ref ? policy.model_bindings[snapshot.config.model_ref] : undefined;
        if(snapshot.runtime!=='builtin'||!binding)throw new Error('BOT_RUNTIME_UNSUPPORTED');
        const project=loadProjects({strict:true}).find(p=>p.agentId===snapshot.agent_id);
        if(!project)throw new Error('BOT_AGENT_BINDING_MISSING');
        const workspace=await workspacePath(project.path);
        const markerPath=join(workspace,'.moxbot-cloud-binding.json');
        const markerInfo=await lstat(markerPath);
        if(!markerInfo.isFile()||markerInfo.isSymbolicLink()||markerInfo.uid!==process.geteuid?.()||markerInfo.nlink!==1||(markerInfo.mode&0o777)!==0o600||markerInfo.size>4096)throw new Error('BOT_AGENT_BINDING_MISSING');
        const marker=JSON.parse(await readFile(markerPath,'utf8')) as {host_id?:string;bot_id?:string};
        if(marker.host_id!==identity!.hostId||marker.bot_id!==snapshot.bot_id)throw new Error('BOT_AGENT_BINDING_MISSING');
        const route=createConcreteProviderRoute(binding.provider_id,binding.model);
        const materialized=materializeProviderRouteEnv(route,loadConfig({strict:true}));
        if(route.kind==='provider'&&(!materialized?.apiKey||materialized.apiProtocol!=='anthropic'))throw new Error('BOT_RUNTIME_UNSUPPORTED');
        return {workspace,provider_id:binding.provider_id,model:binding.model};
      },
      prepare:bootstrap=>exclusive(async()=>{
        await policyPin.assertCurrent();if(active||shuttingDown)throw new Error('HOST_BUSY');
        const target=await ensureSession(undefined,bootstrap);
        if(!target.bot)throw new Error('BOT_RUN_BINDING_MISMATCH');
        return {session_id:target.sessionId,run_generation:target.bot.run_generation};
      }),
      inspect:run=>exclusive(async()=>{
        if(active?.bot&&sameRun(active.bot,run))return {status:active.closing||active.child.exitCode!==null||active.child.signalCode!==null?'unknown' as const:'running' as const,identity:run};
        const exited=exitedBots.get(run.run_generation);
        return {status:exited&&sameRun(exited,run)?'stopped' as const:'unknown' as const,identity:run};
      }),
      stop:run=>exclusive(async()=>{
        const exited=exitedBots.get(run.run_generation);
        if(exited&&sameRun(exited,run))return {status:'stopped' as const,identity:run};
        if(!active?.bot||!sameRun(active.bot,run))return {status:'unknown' as const,identity:run};
        const target=active;
        try{await release(target);return {status:'stopped' as const,identity:run};}catch{return {status:'unknown' as const,identity:run};}
      }),
    });
    botExecutionIpc=await connectBotExecutionIpc({socket:policy.ipc_socket,networkUid:policy.network_uid,managementGid:policy.management_gid,
      scope:policy.scope,assertAuthority:()=>policyPin.assertCurrent(),manager:currentHostContext=>createHostBotManager({hostId:identity!.hostId,
        roots:policy.roots,scope:policy.scope,jwks:policy.jwks,localPolicy:policy.local_policy,authorityFingerprint:policyPin.authorityFingerprint,currentHostContext,runtimeAdapter:adapter})});
    let expirationClosing=false;
    botPolicyTimer=setInterval(()=>{
      if(expirationClosing)return;
      expirationClosing=true;
      void (async()=>{
        let changed=false;
        const expired=Date.now()/1000>=policy.local_policy.expires_at;
        try{await policyPin.assertCurrent();}catch{changed=true;}
        if(expired||changed){
          // The protected opt-in deadline/revocation closes only this Bot's
          // exact supervisor-owned worker, never a private Session.
          await exclusive(async()=>{if(active?.bot){try{await release(active);}catch{/* retain closing/unknown; never infer stopped */}}});
          // Expired, unchanged authority permits only original receipt ACKs.
          // Removing/changing the protected file closes the channel entirely.
          if(changed)await botExecutionIpc?.close();
        }
      })().catch(()=>{console.error('BOT_POLICY_STOP_UNCONFIRMED');}).finally(()=>{expirationClosing=false;});
    },1000);botPolicyTimer.unref();
  }
  console.log(`MyAgents Host ready (private Unix control${managementIpc ? ', management IPC connected' : ''}; finite Bot delegation requires protected opt-in)`);
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await managementIpc?.close();
    server.close();
    if(botPolicyTimer)clearInterval(botPolicyTimer);
    await botExecutionIpc?.close();
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
