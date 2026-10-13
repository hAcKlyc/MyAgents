import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, renameSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withWorkspaceAgentRegistrationIntent } from './utils/agent-workspace-identity';
import { createHostResourceOwner, type HostResourceRequest } from '../host/resources';
import { atomicModifyConfig, atomicModifyProjects, withConfigLock, loadConfig, loadProjects } from './utils/admin-config';

let home: string;
let root: string;
let config: string;
let projects: string;
let owner: ReturnType<typeof createHostResourceOwner>;
const hostId = '53a286cf-bfa4-41e9-a14d-4cb5b7f19224';
function body(relativePath = 'workspace', operation: 'create' | 'register' = 'register'): HostResourceRequest {
  return {mutationId: randomUUID(), expectedRevision: 0, rootId: 'local', relativePath, operation};
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mah-resources-'));
  root = join(home, 'workspaces'); mkdirSync(root, {mode: 0o700});
  mkdirSync(join(home, '.myagents'), {mode: 0o700});
  config = join(home, '.myagents', 'config.json'); projects = join(home, '.myagents', 'projects.json');
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  owner = createHostResourceOwner({hostId, roots: {local: root}});
});
afterEach(() => {vi.unstubAllEnvs(); vi.restoreAllMocks(); syncBuiltinESMExports(); rmSync(home, {recursive: true, force: true});});

it('inspects only persisted linked Agents in admitted roots without exposing config secrets or repairing disk', async () => {
  const inside = randomUUID(); const outside = randomUUID();
  writeFileSync(config, JSON.stringify({providerApiKeys: {private: 'nonsecret-test-sentinel'}, agents: [
    {id: inside, name: 'Inside', enabled: false, channels: [{botToken: 'nonsecret-test-sentinel'}]},
    {id: outside, name: 'Outside', enabled: true},
  ]}));
  writeFileSync(projects, JSON.stringify([
    {id: 'inside-project', name: 'Inside', path: join(root, 'nested/work'), agentId: inside},
    {id: 'outside-project', name: 'Outside', path: root + '-neighbor/work', agentId: outside},
  ]));
  const beforeConfig = readFileSync(config, 'utf8'); const beforeProjects = readFileSync(projects, 'utf8');
  const result = await owner.inspect();
  expect(result).toEqual({version: 1, revision: 0, roots: [{rootId: 'local', workspacePath: root}], agents: [
    {agentId: inside, projectId: 'inside-project', name: 'Inside', workspacePath: join(root, 'nested/work'), enabled: false, archived: false},
  ]});
  expect(JSON.stringify(result)).not.toContain('nonsecret-test-sentinel');
  expect(readFileSync(config, 'utf8')).toBe(beforeConfig); expect(readFileSync(projects, 'utf8')).toBe(beforeProjects);
  expect(await createHostResourceOwner({hostId, roots: {local: root}}).inspect()).toEqual(result);
});
it('refuses ambiguous or oversized inspection instead of silently returning an incomplete registry', async () => {
  const id = randomUUID();
  writeFileSync(config, JSON.stringify({agents: [{id, name: 'Agent', enabled: false}]}));
  writeFileSync(projects, JSON.stringify([
    {id: 'p1', name: 'Agent', path: join(root, 'one'), agentId: id},
    {id: 'p2', name: 'Agent', path: join(root, 'two'), agentId: id},
  ]));
  const before = readFileSync(projects, 'utf8');
  await expect(owner.inspect()).rejects.toThrow('RESOURCE_REGISTRY_AMBIGUOUS');
  expect(readFileSync(projects, 'utf8')).toBe(before);
  const agents = Array.from({length: 300}, (_, index) => ({id: randomUUID(), name: 'x'.repeat(256), enabled: false, index}));
  writeFileSync(config, JSON.stringify({agents}));
  writeFileSync(projects, JSON.stringify(agents.map(agent => ({id: `p${agent.index}`, name: agent.name, path: join(root, `a${agent.index}`), agentId: agent.id}))));
  await expect(owner.inspect()).rejects.toThrow('RESOURCE_PROJECTION_TOO_LARGE');
});

it('strict config/projects reads refuse malformed disk authority and never use backups', async () => {
  writeFileSync(config, '{'); writeFileSync(config + '.bak', '{"agents":[]}');
  await expect(owner.snapshot()).rejects.toThrow('REGISTRY_CORRUPT');
  await expect(atomicModifyConfig(() => ({agents: []}), {strict: true})).rejects.toThrow('REGISTRY_CORRUPT');
  expect(readFileSync(config, 'utf8')).toBe('{');
  writeFileSync(config, '{"agents":{}}');
  expect(() => loadConfig({strict: true})).toThrow('REGISTRY_CORRUPT');
  writeFileSync(config, '{}'); writeFileSync(projects, '{}');
  await expect(atomicModifyProjects(() => [], {strict: true})).rejects.toThrow('REGISTRY_CORRUPT');
  expect(readFileSync(projects, 'utf8')).toBe('{}');
  writeFileSync(projects, '[{"id":"p","name":"n","path":"/x"},{"id":"p","name":"n","path":"/y"}]');
  expect(() => loadProjects({strict: true})).toThrow('REGISTRY_CORRUPT');
});
it('strict mutation rereads authority only after acquiring the original config lock', async () => {
  writeFileSync(config, '{}');
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holder = withConfigLock(async value => { entered(); await gate; return value; });
  await inside;
  const mutation = atomicModifyConfig(value => ({...value, marker: true}), {strict: true});
  writeFileSync(config, '{'); release(); await holder;
  await expect(mutation).rejects.toThrow('REGISTRY_CORRUPT');
  expect(readFileSync(config, 'utf8')).toBe('{');
});
it('strict persistence refuses symlink authority and never truncates a temp symlink target', async () => {
  const victim = join(home, 'victim'); writeFileSync(victim, 'unchanged');
  symlinkSync(victim, config);
  await expect(owner.snapshot()).rejects.toThrow('REGISTRY_CORRUPT');
  rmSync(config); writeFileSync(config, '{}'); symlinkSync(victim, config + '.tmp');
  await atomicModifyConfig(value => ({...value, marker: true}), {strict: true});
  expect(readFileSync(victim, 'utf8')).toBe('unchanged');
  expect(lstatSync(config).isSymbolicLink()).toBe(false);
});
it('CAS conflicts persist exact receipts, are read-only on replay, and reject same ID different body', async () => {
  const request = {...body(), expectedRevision: 1};
  const result = await owner.mutate(request);
  expect(result).toMatchObject({status: 'conflict', revision: 0, effect: 'none'});
  const disk = readFileSync(config, 'utf8');
  expect(await owner.mutate({...request, mutationId: request.mutationId.toUpperCase()})).toEqual(result);
  expect(await owner.receipt(request.mutationId)).toEqual(result);
  expect(readFileSync(config, 'utf8')).toBe(disk);
  await expect(owner.mutate({...request, relativePath: 'different'})).rejects.toThrow('RESOURCE_MUTATION_MISMATCH');
  expect(await owner.snapshot()).toEqual({version: 1, revision: 0});
});
it('keeps all 256 receipts and refuses new tracked mutations when full', async () => {
  for (let i = 0; i < 256; i++) await owner.mutate({...body(), expectedRevision: 1});
  const first = JSON.parse(readFileSync(config, 'utf8')).hostResourceIntents.intents[0].request;
  const disk = readFileSync(config, 'utf8');
  await expect(owner.mutate({...body(), expectedRevision: 1})).rejects.toThrow('RESOURCE_LEDGER_FULL');
  expect((await owner.mutate(first)).status).toBe('conflict');
  expect(readFileSync(config, 'utf8')).toBe(disk);
});
it('rejects owner/scope changes, tampered ledgers and unsafe request paths', async () => {
  await owner.mutate({...body(), expectedRevision: 1});
  await expect(createHostResourceOwner({hostId: randomUUID(), roots: {local: root}}).snapshot()).rejects.toThrow('RESOURCE_LEDGER_CORRUPT');
  for (const relativePath of ['../escape', '/absolute', '.', 'a//b', 'a/../b', 'a\\b']) {
    await expect(owner.mutate({...body(), relativePath})).rejects.toThrow('RESOURCE_REQUEST_INVALID');
  }
  const value = JSON.parse(readFileSync(config, 'utf8')); value.hostResourceIntents.intents[0].hash = 'bad';
  writeFileSync(config, JSON.stringify(value));
  await expect(owner.receipt(value.hostResourceIntents.intents[0].request.mutationId)).rejects.toThrow('RESOURCE_LEDGER_CORRUPT');
});
it('fails closed on unexpected ledger, intent, receipt and resource fields without exposing or rewriting them', async () => {
  const request = body('missing'); expect((await owner.mutate(request)).status).toBe('unconfirmed');
  const base = JSON.parse(readFileSync(config, 'utf8'));
  for (const layer of ['ledger','intent','receipt','resource','status-shape']) {
    const value = structuredClone(base); const ledger = value.hostResourceIntents;
    const intent = ledger.intents[0];
    if (layer === 'ledger') ledger.unexpected = 'nonsecret-sentinel';
    if (layer === 'intent') intent.unexpected = 'nonsecret-sentinel';
    if (layer === 'receipt') intent.receipt.unexpected = 'nonsecret-sentinel';
    if (layer === 'status-shape') intent.receipt.status = ['pending'];
    if (layer === 'resource') {
      // Deliberately corrupted shape fixture; this does not simulate successful registration.
      intent.receipt.status = 'persisted'; intent.receipt.effect = 'registered-disabled-agent';
      intent.receipt.resource = {created:true,agentId:randomUUID(),projectId:randomUUID(),name:'n',
        workspacePath:join(root,'missing'),enabled:false,archived:false,unexpected:'nonsecret-sentinel'};
    }
    writeFileSync(config, JSON.stringify(value)); const disk = readFileSync(config,'utf8');
    await expect(owner.receipt(request.mutationId)).rejects.toThrow('RESOURCE_LEDGER_CORRUPT');
    await expect(owner.mutate(request)).rejects.toThrow('RESOURCE_LEDGER_CORRUPT');
    expect(readFileSync(config,'utf8')).toBe(disk);
  }
});
it('scoped registration drains real Project-first failures before unlocking and cannot escape its intent lifetime', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.mah-resource-registration-'));
  try {
    const unrelatedId = randomUUID();
    writeFileSync(projects, JSON.stringify([{id:unrelatedId,name:'Unrelated',path:join(root,'unrelated')} ]));
    mkdirSync(config + '.tmp');
    await expect(withWorkspaceAgentRegistrationIntent(async register => {
      void register(workspace); // Even a mistakenly un-awaited registration must drain and report failure.
      return 'callback-ended';
    }, {strictPersistence:true,notify:false})).rejects.toMatchObject({code:'AGENT_MATERIALIZATION_DEFERRED'});
    const claim = loadProjects({strict:true}).find(item => item.path === workspace)!; expect(claim.agentId).toBeTruthy();
    expect(loadConfig({strict:true}).agents).toBeUndefined();
    rmSync(config + '.tmp',{recursive:true});
    const result = await withWorkspaceAgentRegistrationIntent(register => register(workspace), {strictPersistence:true,notify:false});
    expect(result).toMatchObject({projectId:claim.id,agentId:claim.agentId,enabled:false});
    expect(loadConfig({strict:true}).agents).toHaveLength(1);
    expect(loadConfig({strict:true}).agents![0].channels).toEqual([]);
    expect(loadProjects({strict:true}).find(item => item.id === unrelatedId)?.agentId).toBeUndefined();
    const closed = await withWorkspaceAgentRegistrationIntent(async register => register);
    expect(() => closed(workspace)).toThrow('REGISTRATION_INTENT_CLOSED');
  } finally { rmSync(workspace,{recursive:true,force:true}); }
});
it('generic intent still drains and throws an explicitly caught real registration failure', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.mah-resource-registration-'));
  let caught: unknown;
  try {
    mkdirSync(config + '.tmp');
    const result = withWorkspaceAgentRegistrationIntent(async register => {
      try { await register(workspace); }
      catch (error) { caught = error; return {status:'unconfirmed'}; }
      return {status:'persisted'};
    }, {strictPersistence:true,notify:false});
    await expect(result).rejects.toMatchObject({code:'AGENT_MATERIALIZATION_DEFERRED'});
    await expect(result).rejects.toBe(caught);
    expect(loadProjects({strict:true})[0].agentId).toBeTruthy();
    expect(loadConfig({strict:true}).agents).toBeUndefined();
    expect(fs.existsSync(join(home,'.myagents','agent-config-intent.lock'))).toBe(false);
  } finally { rmSync(workspace,{recursive:true,force:true}); }
});
it.runIf(process.platform !== 'linux')('never uses a weaker string-path mkdir fallback on non-Linux', async () => {
  const request = body('new', 'create');
  expect(await owner.mutate(request)).toMatchObject({status: 'unconfirmed'});
  expect(await owner.receipt(request.mutationId)).toMatchObject({status: 'pending', revision: 1});
  expect(() => lstatSync(join(root, 'new'))).toThrow();
});

describe.runIf(process.platform === 'linux')('Linux real fd-anchored workspace authority', () => {
  it('creates and fsyncs private missing ancestors for a nested Agent while retaining exclusive leaf and mutation identity', async () => {
    const request = body('parent/nested/workspace', 'create');
    const result = await owner.mutate(request);
    expect(result).toMatchObject({ status: 'persisted', revision: 1,
      resource: { workspacePath: join(root, 'parent/nested/workspace'), enabled: false } });
    for (const path of ['parent', 'parent/nested', 'parent/nested/workspace'])
      expect(lstatSync(join(root, path)).mode & 0o777).toBe(0o700);
    const restarted = createHostResourceOwner({ hostId, roots: { local: root } });
    expect(await restarted.mutate(request)).toEqual(result);
    expect(await restarted.receipt(request.mutationId)).toEqual(result);
    await expect(restarted.mutate({ ...body('parent/nested/workspace', 'create'), expectedRevision: 1 }))
      .rejects.toThrow('RESOURCE_ALREADY_EXISTS');
    expect(loadProjects({ strict: true })).toHaveLength(1);
    expect(loadConfig({ strict: true }).agents).toHaveLength(1);
  });
  it('creates disabled Agent through the original registry; duplicates/restart retain identity and exact receipt', async () => {
    const request = body('new', 'create');
    const results = await Promise.all([owner.mutate(request), owner.mutate(request)]);
    expect(results[0]).toMatchObject({status: 'persisted', revision: 1, resource: {enabled: false}});
    expect(results[1]).toEqual(results[0]);
    const agents = loadConfig({strict:true}).agents!; const registry = loadProjects({strict:true});
    expect(agents).toHaveLength(1); expect(registry).toHaveLength(1);
    expect(agents[0].channels).toEqual([]); expect(agents[0].id).toBe(registry[0].agentId);
    expect(lstatSync(join(root, 'new')).mode & 0o777).toBe(0o700);
    const restarted = createHostResourceOwner({hostId, roots: {local: root}});
    expect(await restarted.mutate(request)).toEqual(results[0]);
    expect(await restarted.inspect()).toMatchObject({version: 1, revision: 1,
      roots: [{rootId: 'local', workspacePath: root}], agents: [{agentId: agents[0].id,
        projectId: registry[0].id, workspacePath: join(root, 'new'), enabled: false, archived: false}]});
    const again = await restarted.mutate({...body('new'), expectedRevision:1});
    expect(again).toMatchObject({status:'persisted', resource:{agentId:agents[0].id, projectId:registry[0].id, created:false}});
  });
  it('preserves an existing enabled legacy Agent and never labels it as a newly disabled resource', async () => {
    const path = join(root, 'existing'); mkdirSync(path, {mode:0o700});
    const agentId = randomUUID();
    writeFileSync(config, JSON.stringify({agents:[{id:agentId,name:'Existing',enabled:true,channels:[],workspacePath:path}]}));
    const result = await owner.mutate(body('existing'));
    expect(result).toMatchObject({status:'persisted',effect:'existing-agent',resource:{agentId,created:false,enabled:true}});
    expect(loadConfig({strict:true}).agents![0].enabled).toBe(true);
    expect((await owner.receipt(result.mutationId))?.status).toBe('persisted');
  });
  it('serializes distinct CAS requests without minting a second Agent', async () => {
    mkdirSync(join(root, 'existing'), {mode:0o700});
    const results = await Promise.all([owner.mutate(body('existing')), owner.mutate(body('existing'))]);
    expect(results.map(result => result.status).sort()).toEqual(['conflict','persisted']);
    expect(loadProjects({strict:true})).toHaveLength(1); expect(loadConfig({strict:true}).agents).toHaveLength(1);
  });
  it('retains original Project claim after actual config temp IO failure and explicitly resumes original mutation', async () => {
    mkdirSync(join(root, 'existing'), {mode:0o700});
    const request = body('existing');
    // A persisted pending intent is a real precommit restart boundary, not a mocked success.
    // First force a path failure to persist the intent without creating any Project.
    rmSync(join(root, 'existing'), {recursive:true});
    expect((await owner.mutate(request)).status).toBe('unconfirmed');
    mkdirSync(join(root, 'existing'), {mode:0o700});
    mkdirSync(config + '.tmp'); // config materialization must fail after the real Project claim commits.
    expect(await owner.mutate(request)).toEqual({mutationId:request.mutationId,status:'unconfirmed',errorCode:'RESOURCE_UNCONFIRMED'});
    const claim = loadProjects({strict:true})[0]; expect(claim.agentId).toBeTruthy();
    expect(loadConfig({strict:true}).agents).toBeUndefined();
    expect((await owner.receipt(request.mutationId))?.status).toBe('pending');
    rmSync(config + '.tmp', {recursive:true});
    expect(await createHostResourceOwner({hostId, roots:{local:root}}).mutate(request)).toMatchObject({
      status:'persisted', revision:1, resource:{projectId:claim.id,agentId:claim.agentId,enabled:false}});
    expect(loadProjects({strict:true})).toHaveLength(1);
  });
  it('refuses symlink escape and writable intermediate directories without creating outside the admitted root', async () => {
    const outside = join(home, 'outside'); mkdirSync(outside, {mode:0o700});
    symlinkSync(outside, join(root, 'alias'));
    expect((await owner.mutate(body('alias/escape', 'create'))).status).toBe('unconfirmed');
    expect(() => lstatSync(join(outside, 'escape'))).toThrow();
    mkdirSync(join(root, 'unsafe'), {mode:0o700});
    chmodSync(join(root, 'unsafe'), 0o770);
    expect((await owner.mutate({...body('unsafe/new','create'),expectedRevision:1})).status).toBe('unconfirmed');
    expect(() => lstatSync(join(root, 'unsafe/new'))).toThrow();
    expect(loadProjects({strict:true})).toHaveLength(0);
  });
  it('reports an unknown final write outcome and reads the original durable receipt after real rename/fsync', async () => {
    mkdirSync(join(root, 'existing'), {mode:0o700});
    const request = body('existing'); const original = fs.fsyncSync;
    let injected = false;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      original(fd);
      if (!injected && fs.existsSync(config)) {
        const state = JSON.parse(readFileSync(config, 'utf8')).hostResourceIntents;
        if (state?.intents[0]?.receipt.status === 'persisted') {
          injected = true; throw Object.assign(new Error('injected after real fsync'), {code:'EIO'});
        }
      }
    });
    syncBuiltinESMExports();
    expect((await owner.mutate(request)).status).toBe('unconfirmed');
    expect(injected).toBe(true);
    const saved = await owner.receipt(request.mutationId); expect(saved?.status).toBe('persisted');
    const disk = readFileSync(config, 'utf8');
    expect(await owner.mutate(request)).toEqual(saved); expect(readFileSync(config,'utf8')).toBe(disk);
    expect(loadProjects({strict:true})).toHaveLength(1);
  });
  it('detects a namespace switch after fd mkdir and refuses to register the replacement outside path', async () => {
    const outside = join(home,'outside'); mkdirSync(outside,{mode:0o700});
    const original = fs.fsyncSync; let switched = false;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      original(fd);
      if (!switched && fs.existsSync(join(root,'new'))) {
        switched = true; renameSync(join(root,'new'), join(root,'moved'));
        symlinkSync(outside,join(root,'new'));
      }
    });
    syncBuiltinESMExports();
    expect((await owner.mutate(body('new','create'))).status).toBe('unconfirmed');
    expect(switched).toBe(true); expect(loadProjects({strict:true})).toHaveLength(0);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it('refuses group/other-write or public root directories', async () => {
    chmodSync(root,0o755);
    expect((await owner.mutate(body('new','create'))).status).toBe('unconfirmed');
    expect(() => lstatSync(join(root,'new'))).toThrow();
  });
  it('never writes Projects or creates a directory when authority is corrupt; repair requires explicit same request', async () => {
    writeFileSync(projects, '{'); const request = body('new','create');
    await expect(owner.mutate(request)).rejects.toThrow('REGISTRY_CORRUPT');
    expect(() => lstatSync(join(root,'new'))).toThrow();
    expect(await owner.receipt(request.mutationId)).toBeUndefined();
    writeFileSync(projects, '[]');
    expect((await owner.mutate(request)).status).toBe('persisted');
    const disk = readFileSync(projects,'utf8'); writeFileSync(projects,'{');
    expect((await owner.receipt(request.mutationId))?.status).toBe('persisted');
    expect((await owner.mutate(request)).status).toBe('persisted');
    expect(readFileSync(projects,'utf8')).toBe('{'); writeFileSync(projects,disk);
  });
});

it.skipIf(process.platform !== 'linux')('browses only safe directories with Unicode, bounded pages and location-bound refresh cursors', async () => {
  mkdirSync(join(root,'客户 文件夹'),{mode:0o700});
  for(let i=0;i<140;i++)mkdirSync(join(root,`目录 ${i}`),{mode:0o700});
  symlinkSync(home,join(root,'outside-link'));writeFileSync(join(root,'file.txt'),'not a directory');
  const first=await owner.listDirectory({rootId:'local',relativePath:''});expect(first.entries).toHaveLength(128);expect(first.nextCursor).not.toBeNull();
  expect(first.entries.some(e=>e.name==='outside-link')).toBe(false);expect(first.entries.some(e=>e.name==='file.txt')).toBe(false);
  const second=await owner.listDirectory({rootId:'local',relativePath:'',cursor:first.nextCursor!});expect(second.nextCursor).toBeNull();
  expect(new Set([...first.entries,...second.entries].map(e=>e.name)).size).toBe(141);
  expect([...first.entries,...second.entries].some(e=>e.name==='客户 文件夹')).toBe(true);
  await expect(owner.listDirectory({rootId:'local',relativePath:'客户 文件夹',cursor:first.nextCursor!})).rejects.toThrow('RESOURCE_DIRECTORY_CHANGED');
  mkdirSync(join(root,'new directory'),{mode:0o700});
  await expect(owner.listDirectory({rootId:'local',relativePath:'',cursor:first.nextCursor!})).rejects.toThrow('RESOURCE_DIRECTORY_CHANGED');
  await expect(owner.listDirectory({rootId:'local',relativePath:'outside-link'})).rejects.toThrow('RESOURCE_PATH_UNAVAILABLE');
});
it.skipIf(process.platform !== 'linux')('registers an existing Unicode child disabled and recovers the same ledger receipt',async()=> {
  mkdirSync(join(root,'客户 项目'),{mode:0o700});const request=body('客户 项目');const result=await owner.mutate(request);
  expect(result).toMatchObject({status:'persisted',effect:'registered-disabled-agent',resource:{enabled:false,workspacePath:join(root,'客户 项目')}});
  expect(await createHostResourceOwner({hostId,roots:{local:root}}).mutate(request)).toEqual(result);
  expect(await owner.receipt(request.mutationId)).toEqual(result);
});
it('directory extension refuses unsafe requests and unsupported non-Linux path authority',async()=> {
  await expect(owner.listDirectory({rootId:'local',relativePath:'../escape'})).rejects.toThrow('RESOURCE_REQUEST_INVALID');
  await expect(owner.listDirectory({rootId:'unknown',relativePath:''})).rejects.toThrow('RESOURCE_ROOT_UNKNOWN');
  if(process.platform !== 'linux')await expect(owner.listDirectory({rootId:'local',relativePath:''})).rejects.toThrow('RESOURCE_PLATFORM_UNSUPPORTED');
});
it.skipIf(process.platform !== 'linux')('refuses a directory replacement during an fd-anchored browse',async()=> {
  mkdirSync(join(root,'original child'),{mode:0o700});const outside=join(home,'outside');mkdirSync(outside,{mode:0o700});mkdirSync(join(outside,'escaped child'),{mode:0o700});
  const original=fs.lstatSync;let replaced=false;
  vi.spyOn(fs,'lstatSync').mockImplementation(((...args:Parameters<typeof fs.lstatSync>)=> {
    if(!replaced && String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/original child')) {
      replaced=true;renameSync(root,join(home,'old workspaces'));symlinkSync(outside,root);
    }
    return original(...args);
  }) as typeof fs.lstatSync);syncBuiltinESMExports();
  await expect(owner.listDirectory({rootId:'local',relativePath:''})).rejects.toThrow('RESOURCE_PATH_CHANGED');expect(replaced).toBe(true);
});
