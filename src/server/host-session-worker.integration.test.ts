import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostSessionMessage, HostSessionRequest } from './host-session-protocol';
import { configureHost, configureProviderHost } from '../host/management';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function start(home: string, workspace: string, sessionId?: string, credential?: string, portable?: {id:string;model:string}) {
  const generation = `generation-${Math.random()}`;
  const child = fork(fileURLToPath(new URL('./host-session-worker.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx', '--import', join(home, 'no-egress.mjs')],
    env: { ...process.env, HOME: home, USERPROFILE: home, MYAGENTS_HOST_MODE: '1',
      MYAGENTS_HOST_GENERATION: generation, MYAGENTS_HOST_WORKSPACE: workspace,
      MYAGENTS_HOST_SESSION_ID: sessionId ?? '', MYAGENTS_HOST_MODEL: portable?.model ?? (credential ? 'k3' : 'claude-sonnet-4-6'),
      MYAGENTS_HOST_PROVIDER_ID: portable?.id ?? (credential ? 'moonshot-coding' : 'anthropic-sub'), MYAGENTS_HOST_EXECUTION_AUTHORIZED: '0',
      MYAGENTS_HOST_CREDENTIAL_SOURCE: credential ? 'supervisor-ipc' : 'systemd',
      ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
      MYAGENTS_MANAGEMENT_PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  let diagnostics = '';
  child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  const inbox: HostSessionMessage[] = [];
  const waiters = new Set<() => void>();
  child.on('message', message => {
    if ((message as HostSessionMessage).type === 'credential-needed') {
      expect((message as HostSessionMessage).generation).toBe(generation);
      child.send({ type: 'host-provider-snapshot', generation, providerId: portable?.id ?? 'moonshot-coding', credential });
    }
    inbox.push(message as HostSessionMessage); for (const notify of waiters) notify();
  });
  function waitFor(predicate: (message: HostSessionMessage) => boolean): Promise<HostSessionMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker timeout: ${diagnostics}`)); }, 30_000);
      const onExit = () => { cleanup(); reject(new Error(`Worker exited: ${diagnostics}`)); };
      const poll = () => {
        const index = inbox.findIndex(predicate);
        if (index >= 0) { const [message] = inbox.splice(index, 1); cleanup(); resolve(message); }
      };
      const cleanup = () => { clearTimeout(timer); waiters.delete(poll); child.off('exit', onExit); };
      waiters.add(poll); child.on('exit', onExit); poll();
    });
  }
  const ready = await waitFor(message => message.type === 'ready') as Extract<HostSessionMessage, { type: 'ready' }>;
  let sequence = 0;
  async function request(operation: HostSessionRequest['operation'], args?: Record<string, unknown>, selectedGeneration = generation) {
    const id = String(++sequence);
    child.send({ id, generation: selectedGeneration, operation, args });
    const reply = await waitFor(message => message.type === 'reply' && message.id === id) as Extract<HostSessionMessage, { type: 'reply' }>;
    if (operation === 'shutdown' && reply.ok && child.exitCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()));
    return reply;
  }
  return { ready, request, diagnostics: () => diagnostics };
}

describe('headless Host Session worker bootstrap', () => {
  it('receives a private credential birth snapshot without persisting it or executing a model', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myagents-host-private-credential-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    await writeFile(join(home, 'no-egress.mjs'), `
      import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
      import { syncBuiltinESMExports } from 'node:module';
      const deny = () => { throw new Error('Integration worker network access is forbidden'); };
      globalThis.fetch = deny; net.connect = deny; net.createConnection = deny;
      http.request = deny; http.get = deny; https.request = deny; https.get = deny;
      syncBuiltinESMExports();
    `);
    const configPath = join(home, '.myagents', 'config.json');
    await mkdir(join(home, '.myagents'));
    await configureHost({
      hostId: randomUUID(), defaultWorkspace: workspace, credentialReference: 'host-provider-credential:moonshot-coding',
      readConfig: async () => ({}),
      writeConfig: async value => { await writeFile(configPath, JSON.stringify(value), { mode: 0o600 }); },
      workspacePath: async value => value, busy: () => false,
    }, { mutationId: randomUUID(), expectedRevision: 0, providerId: 'moonshot-coding', model: 'k3', executionAuthorized: false });
    const secret = 'synthetic-session-private-credential-not-for-network';
    const worker = await start(home, workspace, undefined, secret);
    expect(await worker.request('send', { text: 'Must never execute' })).toMatchObject({ ok: false, error: expect.stringContaining('authorization') });
    const describe = await worker.request('describe');
    expect(describe).toMatchObject({ ok: true, data: { runtime: 'builtin', executionAuthorized: false } });
    expect(JSON.stringify(describe)).not.toContain(secret);
    expect(await worker.request('shutdown')).toMatchObject({ ok: true });
    expect(worker.diagnostics()).not.toContain(secret);
    for (const path of ['config.json', 'sessions.json']) {
      const text = await readFile(join(home, '.myagents', path), 'utf8');
      expect(text).not.toContain(secret);
    }
    const rows = JSON.parse(await readFile(join(home, '.myagents', 'sessions.json'), 'utf8'));
    expect(rows[0]).toMatchObject({ providerRoute: { kind: 'provider', providerId: 'moonshot-coding', model: 'k3' } });
    expect(rows[0].providerEnvJson).toBeUndefined();
  });
  it('uses the real facade/store to persist birth, reject unauthorized execution and resume the same product identity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myagents-host-session-'));
    roots.push(home);
    const workspace = join(home, 'workspace');
    await mkdir(workspace);
    // The child is outside Vitest's no-egress hook. Enforce the same boundary
    // at process bootstrap; this test never calls a model or mocks its success.
    await writeFile(join(home, 'no-egress.mjs'), `
      import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
      import { syncBuiltinESMExports } from 'node:module';
      const deny = () => { throw new Error('Integration worker network access is forbidden'); };
      globalThis.fetch = deny; net.connect = deny; net.createConnection = deny;
      http.request = deny; http.get = deny; https.request = deny; https.get = deny;
      syncBuiltinESMExports();
    `);
    const configPath = join(home, '.myagents', 'config.json');
    await mkdir(join(home, '.myagents'));
    await configureHost({
      hostId: randomUUID(), defaultWorkspace: workspace,
      readConfig: async () => ({}),
      writeConfig: async value => { await writeFile(configPath, JSON.stringify(value), { mode: 0o600 }); },
      workspacePath: async value => value, busy: () => false,
    }, { mutationId: randomUUID(), expectedRevision: 0, providerId: 'moonshot-coding', model: 'k3', executionAuthorized: false });
    const hostConfig = JSON.parse(await readFile(configPath, 'utf8'));
    const first = await start(home, workspace);
    expect(first.ready.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    const persisted = JSON.parse(await readFile(join(home, '.myagents', 'sessions.json'), 'utf8'));
    const metadata = persisted.find((row: { id: string }) => row.id === first.ready.sessionId);
    expect(metadata).toMatchObject({ id: first.ready.sessionId, transcriptFormat: 2,
      permissionMode: 'custom', providerId: 'anthropic-sub',
      providerRoute: { kind: 'subscription', providerId: 'anthropic-sub', model: 'claude-sonnet-4-6' } });
    expect(metadata.providerEnvJson).toBeUndefined();
    expect(await first.request('send', { text: 'This must never execute' })).toMatchObject({ ok: false, error: expect.stringContaining('authorization') });
    expect(await first.request('stop', undefined, 'old-generation')).toMatchObject({ ok: false, error: 'Stale Host generation' });
    expect(await first.request('state')).toMatchObject({ ok: true, data: { sessionId: first.ready.sessionId, isBusy: false, terminal: null } });
    expect(await first.request('permission', { requestId: 'not-pending', decision: 'allow_once' })).toMatchObject({ ok: false });
    expect(await first.request('shutdown')).toMatchObject({ ok: true });
    const resumed = await start(home, workspace, first.ready.sessionId);
    expect(resumed.ready.sessionId).toBe(first.ready.sessionId);
    expect(await resumed.request('describe')).toMatchObject({ ok: true, data: { executionAuthorized: false, runtime: 'builtin' } });
    expect(await resumed.request('shutdown')).toMatchObject({ ok: true });
    const after = JSON.parse(await readFile(join(home, '.myagents', 'sessions.json'), 'utf8'));
    expect(after).toHaveLength(1);
    expect(after[0].sdkSessionId).toBeUndefined();
    const afterConfig = JSON.parse(await readFile(configPath, 'utf8'));
    expect(afterConfig.hostSettings).toEqual(hostConfig.hostSettings);
    expect(afterConfig.hostConfigReceipts).toEqual(hostConfig.hostConfigReceipts);
  });
});

it('boots a portable OpenAI route using provider-bound private credentials without authorizing execution', async()=> {
  const home=await mkdtemp(join(tmpdir(),'mox-host-portable-session-'));roots.push(home);const workspace=join(home,'客户 工作区');await mkdir(workspace);await mkdir(join(home,'.myagents'));
  await writeFile(join(home,'no-egress.mjs'),`import net from 'node:net';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';const deny=()=>{throw new Error('No network in fixture');};globalThis.fetch=deny;net.connect=deny;net.createConnection=deny;http.request=deny;https.request=deny;syncBuiltinESMExports();`);
  const configPath=join(home,'.myagents','config.json');const id='portable-session-test';const model='vendor/model';
  await configureProviderHost({hostId:randomUUID(),defaultWorkspace:workspace,readConfig:async()=>({}),writeConfig:async c=>{await writeFile(configPath,JSON.stringify(c));},workspacePath:async()=>workspace,busy:()=>false,selectWorkspace:async()=>({path:workspace,verify:()=>{},close:()=>{}})}, {provider:{id,name:'Portable test',apiProtocol:'openai',baseUrl:'https://api.example.test/v1',authType:'api_key'},model,workspace:{rootId:'workspaces',relativePath:'客户 工作区'},executionAuthorized:false,expectedRevision:0,mutationId:randomUUID()});
  const secret='synthetic-portable-key-never-network';const worker=await start(home,workspace,undefined,secret,{id,model});
  expect(await worker.request('describe')).toMatchObject({ok:true,data:{executionAuthorized:false,supportedProviderProtocols:['anthropic','openai']}});
  expect(await worker.request('send',{text:'must remain unauthorized'})).toMatchObject({ok:false,error:expect.stringContaining('authorization')});
  await worker.request('shutdown');
  const rows=JSON.parse(await readFile(join(home,'.myagents','sessions.json'),'utf8'));expect(rows[0]).toMatchObject({providerRoute:{kind:'provider',providerId:id,model}});expect(rows[0].providerEnvJson).toBeUndefined();
  expect(await readFile(configPath,'utf8')).not.toContain(secret);expect(JSON.stringify(rows)).not.toContain(secret);expect(worker.diagnostics()).not.toContain(secret);
  await configureProviderHost({hostId:JSON.parse(await readFile(configPath,'utf8')).hostProviderConfigReceipts.hostId,defaultWorkspace:workspace,readConfig:async()=>JSON.parse(await readFile(configPath,'utf8')),writeConfig:async c=>{await writeFile(configPath,JSON.stringify(c));},workspacePath:async()=>workspace,busy:()=>false,selectWorkspace:async()=>({path:workspace,verify:()=>{},close:()=>{}})}, {provider:{id:'portable-session-version-2',name:'Portable version 2',apiProtocol:'openai',baseUrl:'https://other.example.test/v1',authType:'api_key'},model:'vendor/new-model',workspace:{rootId:'workspaces',relativePath:'客户 工作区'},executionAuthorized:false,expectedRevision:1,mutationId:randomUUID()});
  const resumed=await start(home,workspace,rows[0].id,secret,{id,model:'vendor/new-model'});
  expect(resumed.ready.sessionId).toBe(rows[0].id);
  expect(await resumed.request('send',{text:'still unauthorized'})).toMatchObject({ok:false,error:expect.stringContaining('authorization')});
  await resumed.request('shutdown');
  const after=JSON.parse(await readFile(join(home,'.myagents','sessions.json'),'utf8'));expect(after[0]).toMatchObject({providerRoute:{kind:'provider',providerId:id,model}});
  expect(after[0].providerEnvJson).toBeUndefined();expect(JSON.stringify(after)).not.toContain(secret);expect(resumed.diagnostics()).not.toContain(secret);
});
