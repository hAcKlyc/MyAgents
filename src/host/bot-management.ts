/** Persistent Host-side owner for scoped Bot delegation commands. */
import { createHash } from 'node:crypto';
import {
  constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createBotDelegationVerifier, sameHostContext, type BotDelegationVerifierOptions } from './bot-delegation';
import { createBotRuntimeLane, type BotRuntimeAdapter, type BotRunEntry, type BotRunIdentity, type BotRuntimeConfig, type ImmutableBotSnapshot } from './bot-runtime';
import {
  canonicalBytes, validateCommand, validateConfig, validateGrant, validateHostObservation, validateReceipt, validateSnapshot,
  MAX_COLLECTION_ITEMS, type BotConfig, type BotSnapshot, type Command, type ExecutionScope, type Grant, type HostObservation, type Receipt,
} from '../../services/agentnet/execution-core/js/index.mjs';
import { atomicModifyConfig, loadConfig, loadProjects, type AdminAppConfig } from '../server/utils/admin-config';
import { withWorkspaceAgentRegistrationIntent } from '../server/utils/agent-workspace-identity';
import { getHomeDir } from '../server/utils/platform';

const FIELD = 'hostBotDelegationsV1';
const RESOURCE_FIELD = 'hostResourceIntents';
const LIMIT = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (code: string): never => { throw new HostBotError(code); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safeCounter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const allowed = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).every(key => fields.includes(key));

export class HostBotError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'HostBotError'; }
}

interface ResourceRequest { mutationId: string; expectedRevision: number; rootId: string; relativePath: string; operation: 'create'|'register' }
interface Resource { created: boolean; agentId: string; projectId: string; name: string; workspacePath: string; enabled: boolean; archived: false }
interface ResourceIntent { request: ResourceRequest; hash: string; receipt: { mutationId: string; revision: number; status: 'pending'|'persisted'|'conflict'; effect: 'none'|'registered-disabled-agent'|'existing-agent'; resource?: Resource } }
interface ResourceLedger { version: 1; hostId: string; roots: Record<string,string>; revision: number; intents: ResourceIntent[] }
interface StoredBot {
  snapshot: BotSnapshot; root_id: string; relative_path: string; grant: Grant; revoked: boolean;
  runtime_entry?: BotRunEntry; revocation_jti?: string;
}
interface LeaseAck { lease_id: string; acknowledged: boolean; policy_fingerprint?: string }
interface Mutation { command: Command; phase: 'prepared'|'complete'; receipt: Receipt; lease_acks: LeaseAck[] }
interface AcceptedGrant { grant: Grant; jti: string; accepted_at: number; revoked: boolean }
interface RevocationTombstone { scope: ExecutionScope; grant_id: string; revoked_generation: number; bot_id: string }
interface BotLedger {
  version: 1; host_id: string; scope: ExecutionScope; roots: Record<string,string>; revision: number;
  accepted_grants: AcceptedGrant[]; bots: StoredBot[]; mutations: Mutation[]; pending_mutation_id: string|null;
  revocation_tombstones: RevocationTombstone[];
}

export interface HostBotManagerOptions extends BotDelegationVerifierOptions {
  /** Local MyAgents Host ID, distinct from scope.host_device_id. */
  hostId: string;
  roots: Record<string,string>;
  /** Protected Host-local opt-in policy, provisioned by the local owner workflow. */
  localPolicy?: HostBotLocalPolicy;
  /** Durable digest of the operator-protected policy source; production Host supplies the pinned file hash. */
  authorityFingerprint?: string;
  /** Typed Host adapter injection point. Omit to fail closed as unsupported. */
  runtimeAdapter?: BotRuntimeAdapter;
}
export interface HostBotLocalPolicy {
  host_id: string; owner_principal_id: string; scope: ExecutionScope;
  allowed_bot_ids: string[]; allowed_root_ids: string[]; allowed_runtimes: string[];
  allowed_model_refs: string[]; allowed_operations: Grant['operations'];
  max_daily_tokens: number; expires_at: number;
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function resourceDigest(hostId: string, roots: Record<string,string>, request: ResourceRequest): string {
  return digest({hostId, root: roots[request.rootId], ...request});
}
function sortedRoots(input: Record<string,string>): Record<string,string> {
  if (!plain(input) || !Object.keys(input).length || Object.keys(input).length > 64) fail('BOT_ROOTS_INVALID');
  const roots: Record<string,string> = Object.create(null) as Record<string,string>;
  for (const rootId of Object.keys(input).sort()) {
    const path = input[rootId];
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(rootId) || typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('BOT_ROOTS_INVALID');
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o7000) !== 0) fail('BOT_ROOT_UNSAFE');
    roots[rootId] = path;
  }
  return roots;
}
function sameJson(a: unknown, b: unknown): boolean { return canonicalBytes(a).equals(canonicalBytes(b)); }
function exactKeys(value: unknown, fields: string[]): value is Record<string,unknown> {
  return plain(value) && allowed(value, fields) && fields.every(field => Object.hasOwn(value, field));
}

function validateResourceLedger(raw: unknown, hostId: string, roots: Record<string,string>): ResourceLedger {
  if (!exactKeys(raw, ['version','hostId','roots','revision','intents']) || raw.version !== 1 || raw.hostId !== hostId ||
      !sameJson(raw.roots, roots) || !safeCounter(raw.revision) || !Array.isArray(raw.intents) || raw.intents.length > LIMIT) fail('BOT_RESOURCE_LEDGER_CORRUPT');
  const value=raw as unknown as ResourceLedger;
  const ids = new Set<string>(); const revisions = new Set<number>();
  for (const item of value.intents) {
    if (!exactKeys(item, ['request','hash','receipt']) || !exactKeys(item.request, ['mutationId','expectedRevision','rootId','relativePath','operation']) ||
        !exactKeys(item.receipt, ['mutationId','revision','status','effect']) && !exactKeys(item.receipt, ['mutationId','revision','status','effect','resource'])) fail('BOT_RESOURCE_LEDGER_CORRUPT');
    const req = item.request as unknown as ResourceRequest; const receipt = item.receipt as Record<string,unknown>;
    if (!UUID.test(req.mutationId) || !safeCounter(req.expectedRevision) || !Object.hasOwn(roots,req.rootId) ||
        !req.relativePath.split('/').every(piece => /^[A-Za-z0-9_.-]{1,128}$/.test(piece) && piece !== '.' && piece !== '..') ||
        !['create','register'].includes(req.operation) || item.hash !== resourceDigest(hostId,roots,req) || ids.has(req.mutationId) ||
        receipt.mutationId !== req.mutationId || !safeCounter(receipt.revision) || receipt.revision > value.revision ||
        !['pending','persisted','conflict'].includes(String(receipt.status)) ||
        !['none','registered-disabled-agent','existing-agent'].includes(String(receipt.effect))) fail('BOT_RESOURCE_LEDGER_CORRUPT');
    if (receipt.status === 'conflict') {
      if (req.expectedRevision === receipt.revision || receipt.effect !== 'none' || receipt.resource !== undefined) fail('BOT_RESOURCE_LEDGER_CORRUPT');
    } else {
      if (receipt.revision !== req.expectedRevision + 1 || revisions.has(receipt.revision)) fail('BOT_RESOURCE_LEDGER_CORRUPT');
      revisions.add(receipt.revision as number);
    }
    if (receipt.status === 'pending') {
      if (receipt.effect !== 'none' || receipt.resource !== undefined) fail('BOT_RESOURCE_LEDGER_CORRUPT');
    } else if (receipt.status === 'persisted') {
      const resource = receipt.resource;
      if (!exactKeys(resource, ['created','agentId','projectId','name','workspacePath','enabled','archived']) ||
          typeof resource.created !== 'boolean' || typeof resource.agentId !== 'string' || !resource.agentId ||
          typeof resource.projectId !== 'string' || !resource.projectId || typeof resource.name !== 'string' ||
          typeof resource.enabled !== 'boolean' || resource.archived !== false ||
          resource.workspacePath !== join(roots[req.rootId],req.relativePath) ||
          receipt.effect !== (resource.created ? 'registered-disabled-agent' : 'existing-agent')) fail('BOT_RESOURCE_LEDGER_CORRUPT');
    }
    ids.add(req.mutationId);
  }
  if (revisions.size !== value.revision) fail('BOT_RESOURCE_LEDGER_CORRUPT');
  return value;
}

function validateLedger(raw: unknown, options: HostBotManagerOptions, roots: Record<string,string>): BotLedger {
  const fields = ['version','host_id','scope','roots','revision','accepted_grants','bots','mutations','pending_mutation_id'];
  const currentFields=[...fields,'revocation_tombstones'];
  if ((!exactKeys(raw,currentFields) && !exactKeys(raw,fields)) || raw.version !== 1 || raw.host_id !== options.hostId || !sameJson(raw.scope,options.scope) ||
      !sameJson(raw.roots,roots) || !safeCounter(raw.revision) || !Array.isArray(raw.accepted_grants) || raw.accepted_grants.length > LIMIT ||
      !Array.isArray(raw.bots) || raw.bots.length > LIMIT ||
      !Array.isArray(raw.mutations) || raw.mutations.length > LIMIT ||
      (Object.hasOwn(raw,'revocation_tombstones') && (!Array.isArray(raw.revocation_tombstones) || raw.revocation_tombstones.length>LIMIT)) ||
      !(raw.pending_mutation_id === null || (typeof raw.pending_mutation_id === 'string' && UUID.test(raw.pending_mutation_id)))) fail('BOT_LEDGER_CORRUPT');
  const value={...(raw as unknown as BotLedger),revocation_tombstones:(raw as unknown as {revocation_tombstones?:RevocationTombstone[]}).revocation_tombstones ?? [],
    mutations:(raw as unknown as BotLedger).mutations.map(item=>({...item,lease_acks:item.lease_acks ?? []}))};
  const tombstones=new Set<string>();
  for(const tombstone of value.revocation_tombstones) {
    if(!exactKeys(tombstone,['scope','grant_id','revoked_generation','bot_id']) || !sameJson(tombstone.scope,options.scope) ||
       !UUID.test(tombstone.grant_id) || !safeCounter(tombstone.revoked_generation) || tombstone.revoked_generation<1 || !UUID.test(tombstone.bot_id)) fail('BOT_LEDGER_CORRUPT');
    const key=`${digest(tombstone.scope)}:${tombstone.grant_id}:${tombstone.revoked_generation}:${tombstone.bot_id}`;
    if(tombstones.has(key)) fail('BOT_LEDGER_CORRUPT');
    tombstones.add(key);
  }
  const accepted=new Set<string>(); const acceptedBotGenerations=new Set<string>();
  for(const item of value.accepted_grants) {
    if(!exactKeys(item,['grant','jti','accepted_at','revoked']) || !plain(item.grant) || typeof item.jti!=='string' || !UUID.test(item.jti) ||
       !safeCounter(item.accepted_at) || typeof item.revoked!=='boolean') fail('BOT_LEDGER_CORRUPT');
    try { validateGrant(item.grant); } catch { fail('BOT_LEDGER_CORRUPT'); }
    const grant=item.grant as Grant; const key=`${grant.id}:${grant.generation}`; const botGeneration=`${grant.bot_id}:${grant.generation}`;
    if(accepted.has(key) || acceptedBotGenerations.has(botGeneration) || !sameJson(grant.scope,options.scope) || !Object.hasOwn(roots,grant.root_id)) fail('BOT_LEDGER_CORRUPT');
    accepted.add(key); acceptedBotGenerations.add(botGeneration);
  }
  const botIds = new Set<string>();
  for (const item of value.bots) {
    if ((!exactKeys(item,['snapshot','root_id','relative_path','grant','revoked']) &&
         !exactKeys(item,['snapshot','root_id','relative_path','grant','revoked','revocation_jti']) &&
         !exactKeys(item,['snapshot','root_id','relative_path','grant','revoked','runtime_entry']) &&
         !exactKeys(item,['snapshot','root_id','relative_path','grant','revoked','runtime_entry','revocation_jti'])) ||
        !plain(item.snapshot) || typeof item.root_id !== 'string' || !Object.hasOwn(roots,item.root_id) ||
        typeof item.relative_path !== 'string' || typeof item.revoked !== 'boolean' ||
        (item.revocation_jti !== undefined && (typeof item.revocation_jti !== 'string' || !UUID.test(item.revocation_jti))) || !plain(item.grant)) fail('BOT_LEDGER_CORRUPT');
    try { validateSnapshot(item.snapshot); } catch { fail('BOT_LEDGER_CORRUPT'); }
    try { validateGrant(item.grant); } catch { fail('BOT_LEDGER_CORRUPT'); }
    const savedSnapshot=item.snapshot as BotSnapshot; const savedGrant=item.grant as Grant;
    if(item.runtime_entry!==undefined && (!exactKeys(item.runtime_entry,['id','runtime','snapshot_hash','session_id','run_generation']) ||
       typeof item.runtime_entry.id!=='string' || !item.runtime_entry.id || item.runtime_entry.runtime!==savedSnapshot.config.runtime ||
       typeof item.runtime_entry.snapshot_hash!=='string' || !/^[a-f0-9]{64}$/.test(item.runtime_entry.snapshot_hash) ||
       !UUID.test(item.runtime_entry.session_id) || !UUID.test(item.runtime_entry.run_generation) ||
       item.runtime_entry.session_id!==item.snapshot.active_run?.session_id ||
       item.runtime_entry.run_generation!==item.snapshot.active_run?.run_generation)) fail('BOT_LEDGER_CORRUPT');
    if (botIds.has(savedSnapshot.bot_id) || savedGrant.bot_id !== savedSnapshot.bot_id || !value.accepted_grants.some(item=>item.grant.id===savedGrant.id && item.grant.generation===savedGrant.generation && sameJson(item.grant,savedGrant)) || !sameJson(savedGrant.scope,options.scope) ||
        savedGrant.root_id !== item.root_id || savedGrant.relative_path !== item.relative_path || savedSnapshot.revision > value.revision ||
        (savedSnapshot.active_run!=null && item.runtime_entry===undefined) ||
        (['running','stopping'].includes(savedSnapshot.activity) && savedSnapshot.active_run==null)) fail('BOT_LEDGER_CORRUPT');
    botIds.add((item.snapshot as BotSnapshot).bot_id);
  }
  const mutationIds = new Set<string>(); let prepared = 0;
  const leaseOwners = new Map<string,string>();
  for (const item of value.mutations) {
    if ((!exactKeys(item,['command','phase','receipt']) && !exactKeys(item,['command','phase','receipt','lease_acks'])) || !plain(item.command) || !plain(item.receipt) || !Array.isArray(item.lease_acks) || item.lease_acks.length>64 ||
        !['prepared','complete'].includes(String(item.phase))) fail('BOT_LEDGER_CORRUPT');
    try { validateCommand(item.command); validateReceipt(item.receipt); } catch { fail('BOT_LEDGER_CORRUPT'); }
    const cmd = item.command as Command; const receipt = item.receipt as Receipt;
    if (mutationIds.has(cmd.mutation_id) || receipt.mutation_id !== cmd.mutation_id || receipt.request_hash !== cmd.request_hash ||
        receipt.grant_id !== cmd.grant_id || receipt.grant_generation !== cmd.grant_generation || receipt.bot_id !== cmd.bot_id) fail('BOT_LEDGER_CORRUPT');
    mutationIds.add(cmd.mutation_id);
    const localLeaseIds=new Set<string>();
    for(const lease of item.lease_acks) {
      if((!exactKeys(lease,['lease_id','acknowledged']) && !exactKeys(lease,['lease_id','acknowledged','policy_fingerprint'])) ||
         !UUID.test(lease.lease_id) || typeof lease.acknowledged!=='boolean' ||
         (lease.policy_fingerprint!==undefined && (typeof lease.policy_fingerprint!=='string' || !/^[a-f0-9]{64}$/.test(lease.policy_fingerprint))) || localLeaseIds.has(lease.lease_id) ||
         leaseOwners.has(lease.lease_id) || (lease.acknowledged && item.phase!=='complete')) fail('BOT_LEDGER_CORRUPT');
      localLeaseIds.add(lease.lease_id); leaseOwners.set(lease.lease_id,cmd.mutation_id);
    }
    if(item.phase==='complete' && receipt.status==='unconfirmed' && item.lease_acks.some(lease=>lease.acknowledged)) fail('BOT_LEDGER_CORRUPT');
    if (item.phase === 'prepared') prepared++;
  }
  if (prepared > 1 || (value.pending_mutation_id !== null && (!mutationIds.has(value.pending_mutation_id) ||
      !value.mutations.some(item => item.command.mutation_id === value.pending_mutation_id && item.phase === 'prepared'))) ||
      (value.pending_mutation_id === null && prepared !== 0)) fail('BOT_LEDGER_CORRUPT');
  return value;
}

function emptyLedger(options: HostBotManagerOptions, roots: Record<string,string>): BotLedger {
  return {version:1,host_id:options.hostId,scope:options.scope,roots,revision:0,accepted_grants:[],bots:[],mutations:[],pending_mutation_id:null,revocation_tombstones:[]};
}
function loadLedger(config: AdminAppConfig, options: HostBotManagerOptions, roots: Record<string,string>): BotLedger {
  const raw = config[FIELD]; return raw === undefined ? emptyLedger(options,roots) : validateLedger(raw,options,roots);
}
function loadResourceLedger(config: AdminAppConfig, options: HostBotManagerOptions, roots: Record<string,string>): ResourceLedger {
  const raw = config[RESOURCE_FIELD];
  if (raw === undefined) return {version:1,hostId:options.hostId,roots,revision:0,intents:[]};
  return validateResourceLedger(raw,options.hostId,roots);
}

function resourceRequest(command: Command, grant: Grant): ResourceRequest {
  if (command.operation.method !== 'create') return fail('BOT_OPERATION_INVALID');
  return {mutationId:command.mutation_id,expectedRevision:command.operation.params.resource_expected_revision,
    rootId:grant.root_id,relativePath:grant.relative_path,operation:'create'};
}
function resourceReceipt(request: ResourceRequest, revision: number, status: ResourceIntent['receipt']['status']): ResourceIntent {
  return {request,hash:'',receipt:{mutationId:request.mutationId,revision,status,effect:'none'}};
}
function newSnapshot(botId: string, config: BotConfig, bindingGeneration: number, revision: number): BotSnapshot {
  const configured = config.model_ref !== null && config.system_prompt.trim().length > 0;
  return {bot_id:botId,binding_generation:bindingGeneration,revision,deleted:false,admission:'closed',activity:'idle',
    configured,runnable:false,unsupported_reason:'RUNTIME_ADAPTER_UNAVAILABLE',config};
}
function receiptFor(command: Command, revision: number, status: Receipt['status'], code?: string, snapshot?: BotSnapshot, agentId?: string): Receipt {
  const value: Receipt = {mutation_id:command.mutation_id,request_hash:command.request_hash,grant_id:command.grant_id,
    grant_generation:command.grant_generation,bot_id:command.bot_id,binding_generation:command.binding_generation,
    revision,status,...(agentId ? {agent_id:agentId} : {}),...(code ? {code} : {}),...(snapshot ? {snapshot} : {})};
  validateReceipt(value); return value;
}
function findBot(ledger: BotLedger, id: string): StoredBot | undefined { return ledger.bots.find(item => item.snapshot.bot_id === id); }
function uniqueName(ledger: BotLedger, name: string, except?: string): boolean {
  const normalized = name.trim().toLocaleLowerCase('en-US');
  return !ledger.bots.some(item => !item.snapshot.deleted && item.snapshot.bot_id !== except && item.snapshot.config.name.trim().toLocaleLowerCase('en-US') === normalized);
}
function methodNeedsExistingGrant(method: Command['operation']['method']): boolean {
  return method==='configure'||method==='enable'||method==='disable'||method==='delete';
}
function assertGrantAllows(grant: Grant, command: Command, config?: BotConfig): void {
  const method=command.operation.method;
  if(!grant.operations.includes(method)) fail('BOT_OPERATION_NOT_GRANTED');
  if(config && (!grant.allowed_runtimes.includes(config.runtime) ||
      (config.model_ref!==null && !grant.allowed_model_refs.includes(config.model_ref)) ||
      config.daily_tokens>grant.max_daily_tokens)) fail('BOT_CONFIG_NOT_GRANTED');
}
function recordMutation(ledger: BotLedger, mutation: Mutation): BotLedger {
  const index=ledger.mutations.findIndex(item=>item.command.mutation_id===mutation.command.mutation_id);
  if(index<0) {
    if (ledger.mutations.length >= LIMIT) fail('BOT_LEDGER_FULL');
    return {...ledger,mutations:[...ledger.mutations,{...mutation,lease_acks:mutation.lease_acks ?? []}]};
  }
  const old=ledger.mutations[index]!;
  if(old.command.request_hash!==mutation.command.request_hash || !sameJson(old.command,mutation.command)) fail('BOT_MUTATION_MISMATCH');
  const next={...ledger,mutations:ledger.mutations.map((item,i)=>i===index?{...mutation,lease_acks:old.lease_acks}:item)};
  if(mutation.phase==='complete' && next.pending_mutation_id===mutation.command.mutation_id) next.pending_mutation_id=null;
  return next;
}
function bindLease(mutations: Mutation[], command: Command, leaseId: string, policyFingerprint:string): Mutation[] {
  if(!UUID.test(leaseId)) fail('BOT_PROOF_BINDING_MISMATCH');
  const owner=mutations.find(item=>item.lease_acks.some(lease=>lease.lease_id===leaseId));
  if(owner && owner.command.mutation_id!==command.mutation_id) fail('BOT_LEASE_REPLAY_MISMATCH');
  const index=mutations.findIndex(item=>item.command.mutation_id===command.mutation_id);
  if(index<0) return mutations;
  const old=mutations[index]!;
  if(old.command.request_hash!==command.request_hash || !sameJson(old.command,command)) fail('BOT_MUTATION_MISMATCH');
  const priorLease=old.lease_acks.find(lease=>lease.lease_id===leaseId);
  if(priorLease) {
    if(priorLease.policy_fingerprint!==policyFingerprint) fail('BOT_LEASE_POLICY_MISMATCH');
    return mutations;
  }
  if(old.lease_acks.length>=64) fail('BOT_LEASE_ACK_CAPACITY');
  return mutations.map((item,i)=>i===index?{...item,lease_acks:[...item.lease_acks,{lease_id:leaseId,acknowledged:false,policy_fingerprint:policyFingerprint}]}:item);
}

interface WorkspaceHandle { path: string; verify: () => void; close: () => void; marker: string }
function workspace(root: string, relativePath: string, create: boolean, marker: string, recovering: boolean): WorkspaceHandle {
  if (process.platform !== 'linux') fail('BOT_RESOURCE_PLATFORM_UNSUPPORTED');
  const fds: number[] = []; const paths: string[] = [];
  const openDirectory = (target: string, canonical: string, isRoot: boolean) => {
    const fd = openSync(target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW); fds.push(fd); paths.push(canonical);
    const stat = fstatSync(fd);
    if (stat.uid !== process.geteuid?.() || (stat.mode & (isRoot ? 0o077 : 0o022)) !== 0 || (stat.mode & 0o7000) !== 0) fail('BOT_RESOURCE_PATH_UNSAFE');
    return fd;
  };
  const verify = () => {
    for (let i=0;i<fds.length;i++) {
      const stat=lstatSync(paths[i]); const pinned=fstatSync(fds[i]);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() ||
          (stat.mode & (i===0 ? 0o077 : 0o022)) !== 0 || (stat.mode & 0o7000) !== 0 ||
          stat.dev!==pinned.dev || stat.ino!==pinned.ino || realpathSync(paths[i])!==paths[i]) fail('BOT_RESOURCE_PATH_CHANGED');
    }
  };
  try {
    if (realpathSync(root)!==root) fail('BOT_RESOURCE_PATH_UNSAFE');
    let parent=openDirectory(root,root,true); let path=root; let finalWasExisting=false;
    const pieces=relativePath.split('/');
    for (let i=0;i<pieces.length;i++) {
      verify(); const target=`/proc/self/fd/${parent}/${pieces[i]}`; path=join(path,pieces[i]);
      if (create && i===pieces.length-1) {
        try { mkdirSync(target,{mode:0o700}); fsyncSync(parent); }
        catch (error) {
          if (!recovering || (error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
          finalWasExisting=true;
        }
      }
      parent=openDirectory(target,path,false);
    }
    const markerPath=`/proc/self/fd/${parent}/.moxbot-cloud-binding.json`;
    const readMarker=()=>{
      const fd=openSync(markerPath,constants.O_RDONLY|constants.O_NOFOLLOW);
      try {
        const stat=fstatSync(fd);
        if(!stat.isFile() || stat.nlink!==1 || stat.uid!==process.geteuid?.() || (stat.mode&0o777)!==0o600) fail('BOT_RESOURCE_MARKER_UNSAFE');
        return readFileSync(fd,'utf8');
      } finally { closeSync(fd); }
    };
    if (create) {
      if(finalWasExisting) {
        const existing=readMarker(); if (existing!==marker) fail('BOT_RESOURCE_MARKER_MISMATCH');
      } else {
        const fd=openSync(markerPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try { writeFileSync(fd,marker); fsyncSync(fd); } finally { closeSync(fd); }
        fsyncSync(parent);
      }
    } else {
      const existing=readMarker(); if (existing!==marker) fail('BOT_RESOURCE_MARKER_MISMATCH');
    }
    verify();
    return {path,marker,verify,close:()=>{for(const fd of fds.reverse())closeSync(fd);}};
  } catch(error) {
    for(const fd of fds.reverse()) { try { closeSync(fd); } catch { /* already closed */ } }
    if (error instanceof HostBotError) throw error;
    return fail('BOT_RESOURCE_PATH_UNAVAILABLE');
  }
}

export function createHostBotManager(input: HostBotManagerOptions) {
  if (!input.localPolicy) throw new HostBotError('HOST_EXECUTION_NOT_OPTED_IN');
  const policy=structuredClone(input.localPolicy);
  if (!UUID.test(input.hostId)) fail('BOT_HOST_ID_INVALID');
  const roots=sortedRoots(input.roots);
  const scope=input.scope;
  if (!UUID.test(policy.owner_principal_id) || policy.owner_principal_id!==scope.host_owner_id || policy.host_id!==input.hostId || !sameJson(policy.scope,scope) ||
      !Array.isArray(policy.allowed_bot_ids) || !policy.allowed_bot_ids.length || policy.allowed_bot_ids.length>MAX_COLLECTION_ITEMS ||
      policy.allowed_bot_ids.some(id=>!UUID.test(id)) || new Set(policy.allowed_bot_ids).size!==policy.allowed_bot_ids.length ||
      !Array.isArray(policy.allowed_root_ids) || !policy.allowed_root_ids.length || policy.allowed_root_ids.some(id=>!Object.hasOwn(roots,id)) ||
      policy.allowed_root_ids.length>MAX_COLLECTION_ITEMS || new Set(policy.allowed_root_ids).size!==policy.allowed_root_ids.length ||
      !Array.isArray(policy.allowed_runtimes) || !policy.allowed_runtimes.length || policy.allowed_runtimes.length>MAX_COLLECTION_ITEMS ||
      policy.allowed_runtimes.some(runtime=>!['builtin','codex'].includes(runtime)) || new Set(policy.allowed_runtimes).size!==policy.allowed_runtimes.length ||
      !Array.isArray(policy.allowed_model_refs) || policy.allowed_model_refs.length>MAX_COLLECTION_ITEMS ||
      policy.allowed_model_refs.some(id=>!UUID.test(id)) || new Set(policy.allowed_model_refs).size!==policy.allowed_model_refs.length ||
      !Array.isArray(policy.allowed_operations) || !policy.allowed_operations.length || policy.allowed_operations.some(op=>!['create','configure','enable','disable','delete','restore'].includes(op)) ||
      !safeCounter(policy.max_daily_tokens) || policy.max_daily_tokens<1 || !safeCounter(policy.expires_at)) fail('BOT_LOCAL_POLICY_INVALID');
  const assertPolicyBinding=()=>{
    if(!sameJson(input.localPolicy,policy) || !sameJson(input.scope,policy.scope) || policy.host_id!==input.hostId || !input.currentHostContext()) fail('BOT_LOCAL_POLICY_STALE');
  };
  const policyFingerprint=input.authorityFingerprint ?? createHash('sha256').update(canonicalBytes({
    host_id:input.hostId,scope,roots,jwks:input.jwks,local_policy:policy,
  })).digest('hex');
  if(!/^[a-f0-9]{64}$/.test(policyFingerprint)) fail('BOT_AUTHORITY_FINGERPRINT_INVALID');
  const newLeaseAck=(leaseId:string):LeaseAck=>({lease_id:leaseId,acknowledged:false,policy_fingerprint:policyFingerprint});
  const assertLocalPolicy=()=>{assertPolicyBinding();if(Math.floor(Date.now()/1000)>=policy.expires_at) fail('BOT_LOCAL_POLICY_STALE');};
  assertPolicyBinding();
  const authorityHome=resolve(getHomeDir());
  if (!authorityHome || !isAbsolute(authorityHome)) fail('BOT_AUTHORITY_HOME_INVALID');
  const options={...input,roots};
  const verifier=createBotDelegationVerifier(options);
  const assertAuthority=()=>{
    if (resolve(getHomeDir())!==authorityHome) fail('BOT_AUTHORITY_CHANGED');
    for (const path of Object.values(roots)) if (realpathSync(path)!==path) fail('BOT_ROOT_CHANGED');
  };
  const assertReconciliation=()=>{assertPolicyBinding();assertAuthority();};
  const runtimeLane=createBotRuntimeLane(input.runtimeAdapter);
  const identityFor=(snapshot:BotSnapshot, entry:BotRunEntry):BotRunIdentity=>({bot_id:snapshot.bot_id,
    agent_id:snapshot.agent_id!,binding_generation:snapshot.binding_generation,run_generation:entry.run_generation,
    session_id:entry.session_id,snapshot_hash:entry.snapshot_hash,runtime:snapshot.config.runtime as 'builtin'|'codex'});
  const snapshotForRuntime=(snapshot:BotSnapshot):ImmutableBotSnapshot=>{
    const agentId=snapshot.agent_id;
    if(typeof agentId!=='string' || !agentId) throw new HostBotError('BOT_AGENT_BINDING_MISSING');
    const config=snapshot.config;
    if(config.runtime!=='builtin' && config.runtime!=='codex') fail('BOT_RUNTIME_UNSUPPORTED');
    const runtimeConfig=config as BotRuntimeConfig;
    const payload={bot_id:snapshot.bot_id,agent_id:agentId,binding_generation:snapshot.binding_generation,
      revision:snapshot.revision,runtime:runtimeConfig.runtime,config:runtimeConfig};
    const snapshot_hash=createHash('sha256').update(canonicalBytes(payload)).digest('hex');
    return {...payload,snapshot_hash};
  };
  const sameRun=(a:BotRunIdentity,b:BotRunIdentity)=>a.bot_id===b.bot_id && a.agent_id===b.agent_id &&
    a.binding_generation===b.binding_generation && a.run_generation===b.run_generation && a.session_id===b.session_id &&
    a.snapshot_hash===b.snapshot_hash && a.runtime===b.runtime;
  const recoveredLedger=async(config:AdminAppConfig):Promise<BotLedger>=>{
    let ledger=loadLedger(config,options,roots); const active=runtimeLane.activeRun(); let changed=false;
    if(config[FIELD]!==undefined && !Object.hasOwn(config[FIELD] as object,'revocation_tombstones')) changed=true;
    const instant=input.now?.() ?? Math.floor(Date.now()/1000);
    const expiredIds=new Set(ledger.bots.filter(item=>instant>=item.grant.expires_at).map(item=>item.snapshot.bot_id));
    const expiredChanges=ledger.bots.filter(item=>expiredIds.has(item.snapshot.bot_id) &&
      (item.snapshot.admission!=='closed' || item.snapshot.runnable ||
       (item.snapshot.active_run && item.snapshot.activity!=='unknown')));
    if(expiredChanges.length) {
      const revision=ledger.revision+1;
      const bots=ledger.bots.map(item=>expiredIds.has(item.snapshot.bot_id)
        ? {...item,snapshot:{...item.snapshot,revision,admission:'closed' as const,
            activity:item.snapshot.active_run?'unknown' as const:item.snapshot.activity,
            runnable:false,unsupported_reason:item.snapshot.active_run?'BOT_RUN_OUTCOME_UNKNOWN':'BOT_GRANT_EXPIRED'}}
        : item);
      ledger={...ledger,revision,bots};
      await atomicModifyConfig(current=>({...current,[FIELD]:ledger}),{strict:true});
      changed=false;
    }
    const interruptedEnables=new Set(ledger.mutations.filter(item=>item.phase==='prepared' && item.command.operation.method==='enable')
      .map(item=>item.command.bot_id));
    const reconciled:StoredBot[]=[]; const changedBots=new Set<string>();
    for(const item of ledger.bots) {
      const run=item.snapshot.active_run; const entry=item.runtime_entry;
      if(interruptedEnables.has(item.snapshot.bot_id) && !run) {
        changed=true;
        changedBots.add(item.snapshot.bot_id);
        reconciled.push({...item,snapshot:{...item.snapshot,admission:'closed',activity:'unknown',runnable:false,
          unsupported_reason:'BOT_RUN_OUTCOME_UNKNOWN'}});
        continue;
      }
      if(!run || !entry || !item.snapshot.agent_id) { reconciled.push(item); continue; }
      const identity=identityFor(item.snapshot,entry);
      const laneWasExact=!!active && sameRun(active,identity);
      const inspection=await runtimeLane.inspect(identity,entry);
      let snapshot:BotSnapshot;
      let runClosureConfirmed=inspection.status==='stopped' && sameRun(inspection.identity,identity);
      if(expiredIds.has(item.snapshot.bot_id) && !(inspection.status==='stopped' && sameRun(inspection.identity,identity))) {
        const stopped=await runtimeLane.stop(identity);
        if(stopped.status==='ready' && sameRun(stopped.data,identity)) {
          runClosureConfirmed=true;
          snapshot={...item.snapshot,admission:'closed',activity:'stopped',active_run:null,runnable:false,
            unsupported_reason:'BOT_GRANT_EXPIRED'};
        } else {
          snapshot={...item.snapshot,admission:'closed',activity:'unknown',active_run:run,runnable:false,
            unsupported_reason:'BOT_RUN_OUTCOME_UNKNOWN'};
        }
      } else if(inspection.status==='stopped' && sameRun(inspection.identity,identity)) {
        snapshot={...item.snapshot,admission:'closed',activity:'stopped',active_run:null,runnable:false,
          unsupported_reason:expiredIds.has(item.snapshot.bot_id)?'BOT_GRANT_EXPIRED':'BOT_RUNTIME_UNSUPPORTED'};
      } else if(inspection.status==='running' && sameRun(inspection.identity,identity)) {
        const preserveOpen=!expiredIds.has(item.snapshot.bot_id) && laneWasExact && item.snapshot.admission==='open' && item.snapshot.runnable;
        snapshot={...item.snapshot,admission:preserveOpen?'open':'closed',activity:'running',active_run:run,runnable:true,
          unsupported_reason:null};
      } else {
        snapshot={...item.snapshot,admission:'closed',activity:'unknown',active_run:run,runnable:false,
          unsupported_reason:'BOT_RUN_OUTCOME_UNKNOWN'};
      }
      const nextItem:StoredBot=runClosureConfirmed
        ? (({runtime_entry:_runtimeEntry,...rest})=>({...rest,snapshot}))(item)
        : {...item,snapshot};
      if(!sameJson(nextItem,item)) { changed=true; changedBots.add(item.snapshot.bot_id); }
      reconciled.push(nextItem);
    }
    const mutations=ledger.mutations.map(item=>{
      if(item.phase==='prepared' && item.command.operation.method!=='create') {
        changed=true;
        const receipt={...item.receipt,status:'unconfirmed' as const,code:'BOT_RUN_OUTCOME_UNKNOWN'};
        delete receipt.snapshot;
        return {...item,phase:'complete' as const,receipt};
      }
      return item;
    });
    let pending=ledger.pending_mutation_id;
    if(pending && mutations.some(item=>item.command.mutation_id===pending && item.phase==='complete')) { pending=null; changed=true; }
    if(!changed) return ledger;
    const revision=ledger.revision+1;
    const bots=reconciled.map(item=>changedBots.has(item.snapshot.bot_id)?{...item,snapshot:{...item.snapshot,revision}}:item);
    const recovered={...ledger,revision,bots,mutations,pending_mutation_id:pending};
    validateLedger(recovered,options,roots);
    await atomicModifyConfig(current=>({...current,[FIELD]:recovered}),{strict:true});
    return recovered;
  };

  const acceptGrant=async(token:string):Promise<Grant>=>{
    const claims=verifier.verifyGrant(token); const grant=claims.grant;
    assertLocalPolicy(); assertAuthority();
    if(!sameJson(grant.scope,scope) || !policy.allowed_bot_ids.includes(grant.bot_id) || !policy.allowed_root_ids.includes(grant.root_id) ||
       !Object.hasOwn(roots,grant.root_id) || grant.relative_path.split('/').some(part=>part==='.'||part==='..') ||
       grant.max_daily_tokens>policy.max_daily_tokens || grant.expires_at>policy.expires_at ||
       grant.operations.some(op=>!policy.allowed_operations.includes(op)) || grant.allowed_runtimes.some(runtime=>!policy.allowed_runtimes.includes(runtime)) ||
       grant.allowed_model_refs.some(id=>!policy.allowed_model_refs.includes(id))) fail('BOT_GRANT_SCOPE_INVALID');
    return withWorkspaceAgentRegistrationIntent(async()=>{
      assertLocalPolicy(); assertAuthority(); const config=loadConfig({strict:true}); const ledger=loadLedger(config,options,roots);
      if(config[FIELD]!==undefined && !Object.hasOwn(config[FIELD] as object,'revocation_tombstones'))
        await atomicModifyConfig(current=>({...current,[FIELD]:ledger}),{strict:true});
      const tombstoned=ledger.revocation_tombstones.some(item=>item.bot_id===grant.bot_id && sameJson(item.scope,grant.scope) &&
        (item.grant_id===grant.id || grant.generation<=item.revoked_generation));
      if(tombstoned) fail('BOT_GRANT_TOMBSTONED');
      const existing=ledger.accepted_grants.find(item=>item.grant.id===grant.id);
      if(existing && existing.grant.generation>grant.generation) fail('BOT_GRANT_GENERATION_STALE');
      if(existing && existing.grant.generation===grant.generation) {
        if(!sameJson(existing.grant,grant)) fail('BOT_GRANT_REPLAY_MISMATCH');
        if(existing.revoked) fail('BOT_GRANT_ALREADY_REVOKED');
        if(existing.jti!==claims.jti) {
          const refreshed=ledger.accepted_grants.map(item=>item.grant.id===grant.id?{...item,jti:claims.jti}:item);
          await atomicModifyConfig(current=>({...current,[FIELD]:{...ledger,accepted_grants:refreshed}}),{strict:true});
        }
        return structuredClone(existing.grant);
      }
      if(existing) fail('BOT_GRANT_ID_IMMUTABLE');
      const priorForBot=ledger.accepted_grants.filter(item=>item.grant.bot_id===grant.bot_id)
        .sort((a,b)=>b.grant.generation-a.grant.generation)[0];
      if(priorForBot) {
        if(grant.generation<=priorForBot.grant.generation) fail('BOT_GRANT_GENERATION_STALE');
        const bot=findBot(ledger,grant.bot_id);
        if(!priorForBot.revoked || (bot && (!bot.revoked || bot.snapshot.admission!=='closed' ||
            !['stopped','idle'].includes(bot.snapshot.activity) || bot.snapshot.active_run || bot.runtime_entry || bot.snapshot.runnable ||
            grant.root_id!==bot.root_id || grant.relative_path!==bot.relative_path))) {
          fail('BOT_GRANT_PREVIOUS_NOT_EFFECTIVELY_CLOSED');
        }
      }
      if(ledger.accepted_grants.length>=LIMIT) fail('BOT_LEDGER_FULL');
      const accepted={grant,jti:claims.jti,accepted_at:Math.floor(Date.now()/1000),revoked:false};
      const next={...ledger,accepted_grants:[...ledger.accepted_grants,accepted]};
      await atomicModifyConfig(current=>({...current,[FIELD]:next}),{strict:true});
      return structuredClone(grant);
    },{strictPersistence:true,notify:false});
  };

  const snapshot=async (botId:string):Promise<BotSnapshot|undefined>=>{
    if (!UUID.test(botId)) fail('BOT_ID_INVALID');
    return withWorkspaceAgentRegistrationIntent(async()=>{
      assertLocalPolicy(); assertAuthority(); const ledger=await recoveredLedger(loadConfig({strict:true}));
      const bot=findBot(ledger,botId); return bot ? structuredClone(bot.snapshot) : undefined;
    },{strictPersistence:true,notify:false});
  };
  const status=async():Promise<HostObservation>=>withWorkspaceAgentRegistrationIntent(async()=>{
    const contextBefore=input.currentHostContext();
    assertLocalPolicy(); assertAuthority();
    if(!contextBefore) fail('BOT_HOST_CONTEXT_STALE');
    const config=loadConfig({strict:true});
    const ledger=await recoveredLedger(config);
    const currentConfig=loadConfig({strict:true});
    const resources=loadResourceLedger(currentConfig,options,roots);
    assertLocalPolicy(); assertAuthority();
    const contextAfter=input.currentHostContext();
    if(!contextAfter || !sameJson(contextBefore,contextAfter)) fail('BOT_HOST_CONTEXT_STALE');

    const observation:HostObservation={host_revision:ledger.revision,resource_revision:resources.revision,
      root_ids:[...policy.allowed_root_ids].sort(),
      supported_runtimes:input.runtimeAdapter && policy.allowed_runtimes.includes(input.runtimeAdapter.runtime)
        ? [input.runtimeAdapter.runtime] : [],
      allowed_bot_ids:[...policy.allowed_bot_ids].sort(),allowed_model_refs:[...policy.allowed_model_refs].sort(),
      max_daily_tokens:policy.max_daily_tokens,policy_expires_at:policy.expires_at,snapshots:[]};
    validateHostObservation(observation);
    for(const bot of [...ledger.bots].sort((a,b)=>a.snapshot.bot_id.localeCompare(b.snapshot.bot_id))) {
      const snapshot=bot.snapshot; const grant=bot.grant;
      if(!policy.allowed_bot_ids.includes(snapshot.bot_id) || !policy.allowed_root_ids.includes(bot.root_id) ||
         !grant.allowed_runtimes.includes(snapshot.config.runtime) || !policy.allowed_runtimes.includes(snapshot.config.runtime) ||
         (snapshot.config.model_ref!==null && (!grant.allowed_model_refs.includes(snapshot.config.model_ref) ||
           !policy.allowed_model_refs.includes(snapshot.config.model_ref))) ||
         snapshot.config.daily_tokens>policy.max_daily_tokens || snapshot.config.daily_tokens>grant.max_daily_tokens) continue;
      const candidate={...observation,snapshots:[...observation.snapshots,structuredClone(snapshot)]};
      if(candidate.snapshots.length>MAX_COLLECTION_ITEMS || Buffer.byteLength(JSON.stringify(candidate),'utf8')>64*1024) break;
      validateHostObservation(candidate);
      observation.snapshots=candidate.snapshots;
    }
    return structuredClone(validateHostObservation(observation));
  },{strictPersistence:true,notify:false});
  const receipt=async(mutationId:string,actorPrincipalId:string,actorSessionHandle:string):Promise<Receipt|undefined>=>{
    if (!UUID.test(mutationId)) fail('BOT_MUTATION_ID_INVALID');
    if (!UUID.test(actorPrincipalId)||!UUID.test(actorSessionHandle)) fail('BOT_ACTOR_INVALID');
    return withWorkspaceAgentRegistrationIntent(async()=>{
      assertLocalPolicy(); assertAuthority(); const ledger=await recoveredLedger(loadConfig({strict:true}));
      const mutation=ledger.mutations.find(item=>item.command.mutation_id===mutationId);
      if(mutation && (mutation.command.actor_principal_id!==actorPrincipalId || mutation.command.actor_session_handle!==actorSessionHandle)) fail('BOT_RECEIPT_FORBIDDEN');
      return mutation ? structuredClone(mutation.receipt) : undefined;
    },{strictPersistence:true,notify:false});
  };

  const pendingReceipts=async():Promise<Array<{lease_id:string;mutation_id:string;request_hash:string;receipt:Receipt}>>=>{
    return withWorkspaceAgentRegistrationIntent(async()=>{
      assertReconciliation();
      const ledger=loadLedger(loadConfig({strict:true}),options,roots);
      const out:Array<{lease_id:string;mutation_id:string;request_hash:string;receipt:Receipt}>=[];
      let bytes=128;
      for(const item of ledger.mutations) {
        if(item.phase!=='complete' || !['persisted','conflict','failed'].includes(item.receipt.status) ||
           !policy.allowed_bot_ids.includes(item.command.bot_id) || item.command.request_hash!==item.receipt.request_hash ||
           item.command.mutation_id!==item.receipt.mutation_id) continue;
        for(const lease of item.lease_acks) {
          if(lease.acknowledged || lease.policy_fingerprint!==policyFingerprint) continue;
          const row={lease_id:lease.lease_id,mutation_id:item.command.mutation_id,request_hash:item.command.request_hash,receipt:item.receipt};
          const next=Buffer.byteLength(JSON.stringify(row),'utf8')+1;
          if(out.length>=64 || bytes+next>900*1024) return out;
          out.push(structuredClone(row)); bytes+=next;
        }
      }
      return out;
    },{strictPersistence:true,notify:false});
  };

  const ackReceipt=async(leaseId:string,mutationId:string,requestHash:string):Promise<{lease_id:string}>=>{
    if(!UUID.test(leaseId)||!UUID.test(mutationId)||!/^[a-f0-9]{64}$/.test(requestHash)) fail('BOT_RECEIPT_ACK_INVALID');
    return withWorkspaceAgentRegistrationIntent(async()=>{
      assertReconciliation();
      const config=loadConfig({strict:true}); const ledger=loadLedger(config,options,roots);
      const index=ledger.mutations.findIndex(item=>item.command.mutation_id===mutationId);
      if(index<0) fail('BOT_RECEIPT_ACK_NOT_FOUND');
      const item=ledger.mutations[index]!;
      if(!policy.allowed_bot_ids.includes(item.command.bot_id) || item.command.request_hash!==requestHash ||
         item.receipt.mutation_id!==mutationId || item.receipt.request_hash!==requestHash || item.phase!=='complete' ||
         !['persisted','conflict','failed'].includes(item.receipt.status)) fail('BOT_RECEIPT_ACK_MISMATCH');
      const lease=item.lease_acks.find(value=>value.lease_id===leaseId) ?? fail('BOT_RECEIPT_ACK_NOT_FOUND');
      if(lease.policy_fingerprint!==policyFingerprint) fail('BOT_RECEIPT_ACK_MISMATCH');
      if(!lease.acknowledged) {
        const mutations=ledger.mutations.map((value,i)=>i===index?{...item,lease_acks:item.lease_acks.map(entry=>entry.lease_id===leaseId?{...entry,acknowledged:true}:entry)}:value);
        await atomicModifyConfig(current=>({...current,[FIELD]:{...ledger,mutations}}),{strict:true});
      }
      return {lease_id:leaseId};
    },{strictPersistence:true,notify:false});
  };

  async function mutate(intentToken:string,leaseToken:string):Promise<Receipt> {
    const proof=verifier.verifyCommand(intentToken,leaseToken);
    const command=proof.intent.command; validateCommand(command);
    let pendingCreate=false;
    let activeWorkspace:WorkspaceHandle|undefined;
    try {
      return await withWorkspaceAgentRegistrationIntent(async register=>{
        assertLocalPolicy(); assertAuthority(); verifier.assertCurrent(proof);
        const config=loadConfig({strict:true}); let ledger=await recoveredLedger(config);
        let resources=loadResourceLedger(config,options,roots);
        const old=ledger.mutations.find(item=>item.command.mutation_id===command.mutation_id);
        if(old) {
          if(old.command.request_hash!==command.request_hash || !sameJson(old.command,command)) fail('BOT_MUTATION_MISMATCH');
          const mutations=bindLease(ledger.mutations,command,proof.lease.lease_id,policyFingerprint);
          if(mutations!==ledger.mutations) {
            ledger={...ledger,mutations};
            await atomicModifyConfig(current=>({...current,[FIELD]:ledger}),{strict:true});
          }
          if(old.phase==='complete') return structuredClone(old.receipt);
          if(ledger.pending_mutation_id!==command.mutation_id) fail('BOT_LEDGER_CORRUPT');
          if(command.operation.method!=='create') return structuredClone(old.receipt);
          pendingCreate=true;
        } else {
          if(ledger.pending_mutation_id) fail('BOT_MUTATION_PENDING');
          if(ledger.mutations.length>=LIMIT) fail('BOT_LEDGER_FULL');
          if(command.expected_host_revision!==ledger.revision) {
            const conflict=receiptFor(command,ledger.revision,'conflict','HOST_REVISION_CONFLICT');
            ledger=recordMutation(ledger,{command,phase:'complete',receipt:conflict,lease_acks:[newLeaseAck(proof.lease.lease_id)]});
            await atomicModifyConfig(current=>({...current,[FIELD]:ledger}),{strict:true});
            return conflict;
          }
          if(command.operation.method==='enable') {
            const prepared:Mutation={command,phase:'prepared',receipt:receiptFor(command,ledger.revision,'unconfirmed'),
              lease_acks:[newLeaseAck(proof.lease.lease_id)]};
            ledger={...recordMutation(ledger,prepared),pending_mutation_id:command.mutation_id};
            await atomicModifyConfig(current=>({...current,[FIELD]:ledger}),{strict:true});
          }
        }
        const grant=proof.intent.grant;
        if (grant.bot_id!==command.bot_id || grant.id!==command.grant_id || grant.generation!==command.grant_generation) fail('BOT_GRANT_BINDING_MISMATCH');
        const accepted=ledger.accepted_grants.find(item=>item.grant.id===grant.id && item.grant.generation===grant.generation);
        if(!accepted || accepted.revoked || !sameJson(accepted.grant,grant)) fail('BOT_GRANT_NOT_ACCEPTED');
        if((input.now?.() ?? Math.floor(Date.now()/1000))>=grant.expires_at) fail('BOT_GRANT_EXPIRED');
        if(ledger.revocation_tombstones.some(item=>item.bot_id===grant.bot_id && sameJson(item.scope,grant.scope) &&
          (item.grant_id===grant.id || grant.generation<=item.revoked_generation))) fail('BOT_GRANT_TOMBSTONED');
        const commandConfig=command.operation.method==='create'||command.operation.method==='configure'
          ? command.operation.params as BotConfig : undefined;
        assertGrantAllows(grant,command,commandConfig);
        let bot=findBot(ledger,command.bot_id);
        const method=command.operation.method;
        const createConfig:BotConfig|undefined=method==='create'
          ? (({resource_expected_revision:_resourceExpectedRevision,...value})=>value)(command.operation.params)
          : undefined;
        if (bot && methodNeedsExistingGrant(method) &&
            (bot.revoked || bot.grant.id!==grant.id || bot.grant.generation!==grant.generation)) fail('BOT_GRANT_REVOKED_OR_STALE');
        if (bot && method==='restore' && grant.generation<=bot.grant.generation) fail('BOT_RESTORE_GRANT_REQUIRED');
        if(method==='create') {
          if(!createConfig) throw new HostBotError('BOT_OPERATION_INVALID');
          const newConfig=createConfig;
          if(!bot && !pendingCreate) {
            if(command.binding_generation!==1 || grant.root_id===undefined || !Object.hasOwn(roots,grant.root_id)) fail('BOT_BINDING_INVALID');
            const req=resourceRequest(command,grant);
            validateConfig(newConfig);
            if(newConfig.name!==newConfig.name.trim() || !uniqueName(ledger,newConfig.name)) fail('BOT_NAME_CONFLICT');
            if(req.expectedRevision!==resources.revision) {
              const conflict=receiptFor(command,ledger.revision,'conflict','RESOURCE_REVISION_CONFLICT');
              ledger=recordMutation(ledger,{command,phase:'complete',receipt:conflict,lease_acks:[newLeaseAck(proof.lease.lease_id)]});
              await atomicModifyConfig(current=>({...current,[FIELD]:ledger}),{strict:true}); return conflict;
            }
            if(resources.intents.length>=LIMIT || resources.intents.some(item=>item.request.mutationId===command.mutation_id)) fail('BOT_RESOURCE_LEDGER_CONFLICT');
            const target=join(roots[grant.root_id],grant.relative_path);
            try { lstatSync(target); fail('BOT_WORKSPACE_ALREADY_EXISTS'); }
            catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
            const prepared=resourceReceipt(req,resources.revision+1,'pending'); prepared.hash=resourceDigest(input.hostId,roots,req);
            resources={...resources,revision:resources.revision+1,intents:[...resources.intents,prepared]};
            const placeholder=receiptFor(command,ledger.revision,'unconfirmed');
            ledger=recordMutation(ledger,{command,phase:'prepared',receipt:placeholder,
              lease_acks:[newLeaseAck(proof.lease.lease_id)]});
            ledger={...ledger,pending_mutation_id:command.mutation_id}; pendingCreate=true;
            await atomicModifyConfig(current=>({...current,[FIELD]:ledger,[RESOURCE_FIELD]:resources}),{strict:true});
          } else if(!bot && pendingCreate) {
            const prior=ledger.mutations.find(item=>item.command.mutation_id===command.mutation_id);
            if(!prior || !sameJson(prior.command,command)) fail('BOT_MUTATION_MISMATCH');
            const resource=resources.intents.find(item=>item.request.mutationId===command.mutation_id);
            if(!resource || resource.receipt.status!=='pending') fail('BOT_RESOURCE_LEDGER_CORRUPT');
          } else fail('BOT_ALREADY_EXISTS');

          const req=resourceRequest(command,grant);
          const marker=JSON.stringify({version:1,host_id:input.hostId,bot_id:command.bot_id,binding_generation:command.binding_generation,
            mutation_id:command.mutation_id,root_id:grant.root_id,relative_path:grant.relative_path});
          const pinned=workspace(roots[grant.root_id],grant.relative_path,true,marker,pendingCreate); activeWorkspace=pinned;
          try {
            const resource=await register(pinned.path);
            pinned.verify();
            if(resource.enabled || resource.archived || !resource.agentId || !resource.projectId) fail('BOT_RESOURCE_NOT_DISABLED');
            const priorResource=loadResourceLedger(loadConfig({strict:true}),options,roots);
            const index=priorResource.intents.findIndex(item=>item.request.mutationId===command.mutation_id && item.hash===resourceDigest(input.hostId,roots,req));
            if(index<0 || priorResource.intents[index].receipt.status!=='pending') fail('BOT_RESOURCE_LEDGER_CORRUPT');
            const revision=ledger.revision+1; const botSnapshot=newSnapshot(command.bot_id,newConfig,command.binding_generation,revision);
            botSnapshot.agent_id=resource.agentId;
            const stored:StoredBot={snapshot:botSnapshot,root_id:grant.root_id,relative_path:grant.relative_path,grant,revoked:false};
            const finalizedResources=structuredClone(priorResource);
            finalizedResources.intents[index]={...finalizedResources.intents[index],receipt:{mutationId:command.mutation_id,
              revision:finalizedResources.intents[index].receipt.revision,status:'persisted',effect:resource.created?'registered-disabled-agent':'existing-agent',resource}};
            const savedReceipt=receiptFor(command,revision,'persisted',undefined,botSnapshot,resource.agentId);
            const updated={...ledger,revision,bots:[...ledger.bots,stored],pending_mutation_id:null,
              mutations:ledger.mutations.map(item=>item.command.mutation_id===command.mutation_id?{...item,phase:'complete' as const,receipt:savedReceipt}:item)};
            validateReceipt(savedReceipt);
            await atomicModifyConfig(current=>({...current,[FIELD]:updated,[RESOURCE_FIELD]:finalizedResources}),{strict:true});
            return savedReceipt;
          } finally { activeWorkspace=undefined; pinned.close(); }
        }

        if(!bot) throw new HostBotError('BOT_NOT_FOUND');
        if(bot.snapshot.deleted && method!=='restore') fail('BOT_DELETED');
        if(method==='restore') {
          if((!bot.snapshot.deleted && !bot.revoked) || grant.generation<=bot.grant.generation || grant.root_id!==bot.root_id || grant.relative_path!==bot.relative_path ||
             command.binding_generation<=bot.snapshot.binding_generation) fail('BOT_RESTORE_GRANT_REQUIRED');
          assertGrantAllows(grant,command,bot.snapshot.config);
          if(!uniqueName(ledger,bot.snapshot.config.name,command.bot_id)) fail('BOT_NAME_CONFLICT');
          const project=loadProjects({strict:true}).find(item=>item.agentId===bot!.snapshot.agent_id && item.path===join(roots[bot!.root_id],bot!.relative_path));
          if(!project) fail('BOT_AGENT_BINDING_MISSING');
          bot={...bot,grant,revoked:false,snapshot:{...bot.snapshot,binding_generation:command.binding_generation,revision:ledger.revision+1,
            deleted:false,admission:'closed',activity:'idle',runnable:false,unsupported_reason:'RUNTIME_ADAPTER_UNAVAILABLE'}};
        } else if (command.binding_generation!==bot.snapshot.binding_generation) fail('BOT_BINDING_GENERATION_CONFLICT');

        if(method==='configure') {
          if(bot.snapshot.admission==='open' || bot.snapshot.active_run || ['running','stopping','unknown'].includes(bot.snapshot.activity)) fail('BOT_DISABLE_BEFORE_CONFIGURE');
          const next=command.operation.params as BotConfig; validateConfig(next);
          if(!uniqueName(ledger,next.name,command.bot_id)) fail('BOT_NAME_CONFLICT');
          bot={...bot,snapshot:{...bot.snapshot,config:next,configured:next.model_ref!==null && next.system_prompt.trim().length>0,
            revision:ledger.revision+1,runnable:false,unsupported_reason:'RUNTIME_ADAPTER_UNAVAILABLE'}};
        } else if(method==='enable') {
          if(!bot.snapshot.configured || !bot.snapshot.config.model_ref || !bot.snapshot.config.system_prompt.trim()) {
            const failed=receiptFor(command,ledger.revision,'failed','BOT_CONFIGURATION_INCOMPLETE');
            const next=recordMutation(ledger,{command,phase:'complete',receipt:failed,lease_acks:[newLeaseAck(proof.lease.lease_id)]});
            await atomicModifyConfig(current=>({...current,[FIELD]:next}),{strict:true}); return failed;
          }
          if(ledger.bots.some(item=>item.snapshot.active_run!==undefined && item.snapshot.active_run!==null || item.snapshot.activity==='unknown')) {
            const failed=receiptFor(command,ledger.revision,'failed','HOST_BUSY');
            const next=recordMutation(ledger,{command,phase:'complete',receipt:failed,lease_acks:[newLeaseAck(proof.lease.lease_id)]});
            await atomicModifyConfig(current=>({...current,[FIELD]:next}),{strict:true}); return failed;
          }
          if(!runtimeLane.available()) {
            const failed=receiptFor(command,ledger.revision,'failed','BOT_RUNTIME_UNSUPPORTED');
            const next=recordMutation(ledger,{command,phase:'complete',receipt:failed,lease_acks:[newLeaseAck(proof.lease.lease_id)]});
            await atomicModifyConfig(current=>({...current,[FIELD]:next}),{strict:true}); return failed;
          }
          if(!bot.snapshot.agent_id || !['builtin','codex'].includes(bot.snapshot.config.runtime)) {
            const failed=receiptFor(command,ledger.revision,'failed','BOT_RUNTIME_UNSUPPORTED');
            const next=recordMutation(ledger,{command,phase:'complete',receipt:failed,lease_acks:[newLeaseAck(proof.lease.lease_id)]});
            await atomicModifyConfig(current=>({...current,[FIELD]:next}),{strict:true}); return failed;
          }
          const priorSnapshot=bot.snapshot;
          const preparedMutation:Mutation={command,phase:'prepared',receipt:receiptFor(command,ledger.revision,'unconfirmed'),lease_acks:[]};
          ledger={...recordMutation(ledger,preparedMutation),pending_mutation_id:command.mutation_id}; pendingCreate=true;
          await atomicModifyConfig(current=>({...current,[FIELD]:ledger}),{strict:true});

          const runtimeSnapshot=snapshotForRuntime(priorSnapshot);
          const prepared=await runtimeLane.prepare(runtimeSnapshot);
          if(prepared.status!=='ready') {
            const failed=receiptFor(command,ledger.revision,'failed',prepared.status==='busy'?'HOST_BUSY':'BOT_RUNTIME_UNSUPPORTED');
            const next={...ledger,pending_mutation_id:null,
              mutations:ledger.mutations.map(item=>item.command.mutation_id===command.mutation_id?{...item,phase:'complete' as const,receipt:failed}:item)};
            await atomicModifyConfig(current=>({...current,[FIELD]:next}),{strict:true}); pendingCreate=false; return failed;
          }
          const runIdentity=identityFor(priorSnapshot,prepared.data);
          const startingBot:StoredBot={...bot,runtime_entry:prepared.data,snapshot:{...priorSnapshot,revision:ledger.revision,
            admission:'closed',activity:'unknown',runnable:false,unsupported_reason:'BOT_RUN_OUTCOME_UNKNOWN',
            active_run:{session_id:runIdentity.session_id,run_generation:runIdentity.run_generation}}};
          const startingLedger={...ledger,bots:ledger.bots.map(item=>item.snapshot.bot_id===command.bot_id?startingBot:item)};
          await atomicModifyConfig(current=>({...current,[FIELD]:startingLedger}),{strict:true});
          ledger=startingLedger; bot=startingBot;

          const started=await runtimeLane.start(runtimeSnapshot,prepared.data,runIdentity);
          const revision=started.status==='ready'?ledger.revision+1:started.status==='unknown'?ledger.revision+1:ledger.revision;
          let finalBot:StoredBot; let outcome:Receipt;
          if(started.status==='ready') {
            finalBot={...bot,snapshot:{...bot.snapshot,revision,admission:'open',activity:'running',runnable:true,unsupported_reason:null,
              active_run:{session_id:runIdentity.session_id,run_generation:runIdentity.run_generation}}};
            outcome=receiptFor(command,revision,'persisted',undefined,finalBot.snapshot,finalBot.snapshot.agent_id ?? undefined);
          } else if(started.status==='unknown') {
            finalBot={...bot,snapshot:{...bot.snapshot,revision,admission:'closed',activity:'unknown',runnable:false,
              unsupported_reason:'BOT_RUN_OUTCOME_UNKNOWN',active_run:{session_id:runIdentity.session_id,run_generation:runIdentity.run_generation}}};
            outcome=receiptFor(command,revision,'unconfirmed','BOT_RUN_OUTCOME_UNKNOWN');
          } else {
            finalBot={...bot,runtime_entry:undefined,snapshot:{...priorSnapshot,revision:ledger.revision}};
            outcome=receiptFor(command,revision,'failed',started.status==='busy'?'HOST_BUSY':'BOT_RUN_BINDING_MISMATCH');
          }
          const finished={...ledger,revision,bots:ledger.bots.map(item=>item.snapshot.bot_id===command.bot_id?finalBot:item),pending_mutation_id:null,
            mutations:ledger.mutations.map(item=>item.command.mutation_id===command.mutation_id?{...item,phase:'complete' as const,receipt:outcome}:item)};
          validateReceipt(outcome); validateSnapshot(finalBot.snapshot);
          await atomicModifyConfig(current=>({...current,[FIELD]:finished}),{strict:true}); pendingCreate=false;
          return outcome;
        } else if(method==='disable') {
          const active=runtimeLane.activeRun();
          if(active && (active.bot_id!==command.bot_id || active.binding_generation!==command.binding_generation)) fail('BOT_RUN_BINDING_MISMATCH');
          let activity=bot.snapshot.activity;
          let activeRun=bot.snapshot.active_run;
          let runnable=bot.snapshot.runnable; let unsupportedReason=bot.snapshot.unsupported_reason;
          if(active) {
            const expected=bot.runtime_entry && bot.snapshot.active_run ? identityFor(bot.snapshot,bot.runtime_entry) : undefined;
            if(!expected || !sameRun(active,expected)) {
              activity='unknown'; runnable=false; unsupportedReason='BOT_RUN_OUTCOME_UNKNOWN';
            } else {
              const prepared:Mutation={command,phase:'prepared',receipt:receiptFor(command,ledger.revision,'unconfirmed'),
                lease_acks:[newLeaseAck(proof.lease.lease_id)]};
              ledger={...recordMutation(ledger,prepared),pending_mutation_id:command.mutation_id};
              await atomicModifyConfig(current=>({...current,[FIELD]:ledger}),{strict:true});
              const stopped=await runtimeLane.stop(expected);
              activity=stopped.status==='ready'?'stopped':'unknown';
              if(stopped.status==='ready') { activeRun=null; runnable=false; unsupportedReason='BOT_RUNTIME_UNSUPPORTED'; }
              else { runnable=false; unsupportedReason='BOT_RUN_OUTCOME_UNKNOWN'; }
            }
          } else if(activeRun || activity==='running' || activity==='stopping') {
            activity='unknown'; runnable=false; unsupportedReason='BOT_RUN_OUTCOME_UNKNOWN';
          }
          bot={...bot,...(activeRun===null?{runtime_entry:undefined}:{}),snapshot:{...bot.snapshot,admission:'closed',activity,active_run:activeRun,
            runnable,unsupported_reason:unsupportedReason,revision:ledger.revision+1}};
        } else if(method==='delete') {
          const confirmation=(command.operation.params as {confirmation:string}).confirmation;
          if(confirmation!==bot.snapshot.config.name) fail('BOT_DELETE_CONFIRMATION_MISMATCH');
          const active=runtimeLane.activeRun();
          if(bot.snapshot.admission!=='closed' || bot.snapshot.active_run || active?.bot_id===command.bot_id || ['running','stopping','unknown'].includes(bot.snapshot.activity)) fail('BOT_ACTIVITY_CLOSE_UNCONFIRMED');
          bot={...bot,runtime_entry:undefined,snapshot:{...bot.snapshot,deleted:true,admission:'closed',activity:'stopped',active_run:null,revision:ledger.revision+1,runnable:false,
            unsupported_reason:'RUNTIME_ADAPTER_UNAVAILABLE'}};
        } else if(method!=='restore') fail('BOT_OPERATION_UNSUPPORTED');

        const revision=ledger.revision+1; bot={...bot,snapshot:{...bot.snapshot,revision}};
        const outcomeUnknown=method==='disable' && bot.snapshot.activity==='unknown';
        const savedReceipt=outcomeUnknown
          ? receiptFor(command,revision,'unconfirmed','BOT_RUN_OUTCOME_UNKNOWN')
          : receiptFor(command,revision,'persisted',undefined,bot.snapshot,bot.snapshot.agent_id ?? undefined);
        let next=recordMutation(ledger,{command,phase:'complete',receipt:savedReceipt,
          lease_acks:[newLeaseAck(proof.lease.lease_id)]});
        next={...next,revision,bots:next.bots.map(item=>item.snapshot.bot_id===command.bot_id?bot!:item),pending_mutation_id:null};
        await atomicModifyConfig(current=>({...current,[FIELD]:next}),{strict:true});
        return savedReceipt;
      },{strictPersistence:true,notify:false,assertWorkspace:path=>{
        if(!activeWorkspace || activeWorkspace.path!==path) throw new HostBotError('BOT_RESOURCE_PATH_UNAVAILABLE');
        const pinned=activeWorkspace;
        pinned.verify();
      }});
    } catch(error) {
      if(error instanceof HostBotError && !pendingCreate) throw error;
      // Workspace registration may commit Project/Agent before the final Host ledger write.
      // Return the original mutation handle as unconfirmed; the caller must retry the same signed intent.
      const saved=await receipt(command.mutation_id,command.actor_principal_id,command.actor_session_handle).catch(()=>undefined);
      if(saved) return saved;
      if(error instanceof HostBotError) throw error;
      throw new HostBotError('BOT_MUTATION_UNCONFIRMED');
    }
  }

  async function revoke(token:string,target:{grant_id:string;bot_id:string;revoked_generation:number}):Promise<BotSnapshot> {
    const claims=verifier.verifyRevocation(token,target);
    return withWorkspaceAgentRegistrationIntent(async()=>{
      assertLocalPolicy(); assertAuthority(); const config=loadConfig({strict:true}); const ledger=await recoveredLedger(config);
      const bot=findBot(ledger,claims.bot_id);
      const accepted=ledger.accepted_grants.find(item=>item.grant.id===claims.grant_id && item.grant.generation===claims.revoked_generation);
      const current=input.currentHostContext(); if(!current || !sameHostContext(current,claims.host_context)) fail('BOT_HOST_CONTEXT_STALE');
      if(!sameJson(claims.scope,scope) || !policy.allowed_bot_ids.includes(claims.bot_id)) fail('BOT_REVOCATION_STALE');
      if(!accepted) {
        // A signed revocation can arrive before its grant was ever pulled. Persist
        // an exact append-only tombstone so that delayed grants/commands cannot
        // resurrect that generation. Never ACK an orphan if a Bot is mapped.
        if(bot) fail('BOT_REVOCATION_STALE');
        const existing=ledger.revocation_tombstones.find(item=>item.grant_id===claims.grant_id &&
          item.revoked_generation===claims.revoked_generation && item.bot_id===claims.bot_id && sameJson(item.scope,claims.scope));
        let revision=ledger.revision;
        if(!existing) {
          if(ledger.revocation_tombstones.length>=LIMIT) fail('BOT_LEDGER_FULL');
          revision=ledger.revision+1;
          const tombstone:RevocationTombstone={scope:claims.scope,grant_id:claims.grant_id,
            revoked_generation:claims.revoked_generation,bot_id:claims.bot_id};
          const next={...ledger,revision,revocation_tombstones:[...ledger.revocation_tombstones,tombstone]};
          await atomicModifyConfig(value=>({...value,[FIELD]:next}),{strict:true});
        }
        const snapshot:BotSnapshot={bot_id:claims.bot_id,binding_generation:0,revision,deleted:false,admission:'closed',
          activity:'idle',configured:false,runnable:false,unsupported_reason:'BOT_NOT_CREATED',
          config:{name:'uncreated',description:'',runtime:policy.allowed_runtimes[0] as 'builtin'|'codex',model_ref:null,system_prompt:'',daily_tokens:1}};
        validateSnapshot(snapshot); return snapshot;
      }
      if(!sameJson(accepted.grant.scope,claims.scope) || accepted.grant.bot_id!==claims.bot_id ||
         (bot && (bot.grant.id!==claims.grant_id || bot.grant.generation!==claims.revoked_generation) && !accepted.revoked)) fail('BOT_REVOCATION_STALE');
      // A replay for a historical, already-revoked grant remains answerable
      // after the Bot has been explicitly restored under a newer grant. Never
      // let that historical receipt revoke or stop the newer binding.
      if(bot && accepted.revoked && (bot.grant.id!==claims.grant_id || bot.grant.generation!==claims.revoked_generation)) {
        return structuredClone(bot.snapshot);
      }
      const accepted_grants=accepted.revoked?ledger.accepted_grants:ledger.accepted_grants.map(item=>item.grant.id===claims.grant_id && item.grant.generation===claims.revoked_generation
        ? {...item,revoked:true} : item);
      if(!bot) {
        const snapshot:BotSnapshot={bot_id:claims.bot_id,binding_generation:0,revision:ledger.revision+(accepted.revoked?0:1),deleted:false,admission:'closed',
          activity:'idle',configured:false,runnable:false,unsupported_reason:'BOT_NOT_CREATED',
          config:{name:'uncreated',description:'',runtime:accepted.grant.allowed_runtimes[0] as 'builtin'|'codex',model_ref:null,system_prompt:'',daily_tokens:1}};
        validateSnapshot(snapshot);
        if(!accepted.revoked) await atomicModifyConfig(value=>({...value,[FIELD]:{...ledger,revision:ledger.revision+1,accepted_grants}}),{strict:true});
        return snapshot;
      }

      // Close admission and persist the revoked grant before awaiting the exact
      // runtime stop. A crash or lost ACK leaves a retryable closed/unknown
      // record, never an apparently open Bot while stop is in flight.
      const active=runtimeLane.activeRun();
      const exactActive=!!active && !!bot.runtime_entry && !!bot.snapshot.active_run &&
        sameRun(active,identityFor(bot.snapshot,bot.runtime_entry));
      const hadRun=bot.snapshot.active_run!=null || ['running','stopping','unknown'].includes(bot.snapshot.activity);
      const preclosed:BotSnapshot={...bot.snapshot,admission:'closed',activity:hadRun?'unknown':bot.snapshot.activity,
        runnable:false,unsupported_reason:hadRun?'BOT_RUN_OUTCOME_UNKNOWN':'BOT_RUNTIME_UNSUPPORTED',revision:ledger.revision+1};
      validateSnapshot(preclosed);
      const preclosedBot:StoredBot={...bot,revoked:true,revocation_jti:claims.jti,snapshot:preclosed};
      const preclosedLedger={...ledger,revision:ledger.revision+1,accepted_grants,
        bots:ledger.bots.map(item=>item.snapshot.bot_id===claims.bot_id?preclosedBot:item)};
      if(!accepted.revoked || bot.snapshot.admission!=='closed' || bot.snapshot.activity!=='unknown' && hadRun ||
         bot.snapshot.runnable || bot.revocation_jti!==claims.jti) {
        await atomicModifyConfig(value=>({...value,[FIELD]:preclosedLedger}),{strict:true});
      }
      let stopped=false;
      if(exactActive && active) {
        const result=await runtimeLane.stop(active); stopped=result.status==='ready';
      }
      const unknown=hadRun && !stopped;
      const snapshot:BotSnapshot={...preclosed,activity:unknown?'unknown':(stopped?'stopped':preclosed.activity),
        ...(stopped?{active_run:null}:{}),runnable:false,unsupported_reason:unknown?'BOT_RUN_OUTCOME_UNKNOWN':'BOT_RUNTIME_UNSUPPORTED',
        revision:preclosed.revision};
      const nextBot:StoredBot={...bot,...(stopped || !snapshot.active_run?{runtime_entry:undefined}:{}),revoked:true,revocation_jti:claims.jti,snapshot};
      validateSnapshot(snapshot);
      const next={...preclosedLedger,bots:preclosedLedger.bots.map(item=>item.snapshot.bot_id===claims.bot_id?nextBot:item)};
      await atomicModifyConfig(value=>({...value,[FIELD]:next}),{strict:true}); return structuredClone(snapshot);
    },{strictPersistence:true,notify:false});
  }

  return {acceptGrant,snapshot,status,receipt,pendingReceipts,ackReceipt,mutate,revoke};
}
