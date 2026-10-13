import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalBytes, commandHash, intentHash, type Command, type ExecutionScope, type Grant,
  type BotSnapshot, type HostContext, type IntentClaims, type LeaseClaims, type RevocationClaims, type Receipt,
  MAX_JWT_BYTES,
} from '../../services/agentnet/execution-core/js/index.mjs';
import { createBotDelegationVerifier } from '../host/bot-delegation';
import { createHostBotManager, type HostBotManagerOptions } from '../host/bot-management';
import type { BotRunEntry, BotRuntimeAdapter } from '../host/bot-runtime';
import { atomicModifyConfig, loadConfig } from './utils/admin-config';

const scope:ExecutionScope={issuer:'https://agentnet.example',service_id:'10000000-0000-4000-8000-000000000001',environment:'production',
  network_id:'10000000-0000-4000-8000-000000000002',host_owner_id:'10000000-0000-4000-8000-000000000003',
  host_device_id:'10000000-0000-4000-8000-000000000004',host_key_generation:1,identity_binding_id:'10000000-0000-4000-8000-000000000005'};
const context:HostContext={challenge_nonce:'20000000-0000-4000-8000-000000000001',local_auth_generation:1,
  boot_epoch:'20000000-0000-4000-8000-000000000002',connection_epoch:'20000000-0000-4000-8000-000000000003',membership_revision:1};
const botId='30000000-0000-4000-8000-000000000001';
const grantId='30000000-0000-4000-8000-000000000002';
const now=1_800_000_000;

function signedFixture() {
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const exported=publicKey.export({format:'jwk'});
  const jwks={keys:[{...exported,kid:'pinned-service-key',alg:'ES256',use:'sig'}]};
  const jwt=(type:string,claims:unknown)=>{
    const head=Buffer.from(JSON.stringify({alg:'ES256',typ:type,kid:'pinned-service-key'})).toString('base64url');
    const body=Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input=`${head}.${body}`;
    const signature=cryptoSign('sha256',Buffer.from(input),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
    return `${input}.${signature}`;
  };
  return {jwks,jwt};
}
function grant():Grant {
  return {id:grantId,generation:1,scope,bot_id:botId,root_id:'bots',relative_path:'delegated/demo',
    operations:['create','configure','enable','disable','delete','restore'],allowed_runtimes:['builtin'],allowed_model_refs:[],max_daily_tokens:1000,expires_at:now+1000};
}
function command():Command {
  const value:Command={mutation_id:'40000000-0000-4000-8000-000000000001',request_hash:'',actor_principal_id:'40000000-0000-4000-8000-000000000002',
    actor_session_handle:'40000000-0000-4000-8000-000000000003',grant_id:grantId,grant_generation:1,bot_id:botId,binding_generation:1,
    expected_host_revision:0,operation:{method:'create',params:{name:'demo',description:'',runtime:'builtin',model_ref:null,system_prompt:'',daily_tokens:100,
      resource_expected_revision:0}}};
  value.request_hash=commandHash(value); return value;
}
function claims() {
  const g=grant(); const c=command();
  const intent:IntentClaims={iss:scope.issuer,aud:'moxbot-host-bots/v1',namespace:'moxbot.bot.execution/v1',iat:now,nbf:now,exp:now+90,
    jti:'50000000-0000-4000-8000-000000000001',scope,grant:g,command:c};
  const lease:LeaseClaims={iss:scope.issuer,aud:'moxbot-host-bots/v1',namespace:'moxbot.bot.execution/v1',iat:now,nbf:now,exp:now+10,
    jti:'50000000-0000-4000-8000-000000000002',scope,grant_id:grantId,grant_generation:1,bot_id:botId,binding_generation:1,
    mutation_id:c.mutation_id,request_hash:c.request_hash,intent_hash:intentHash(intent),host_context:context,
    lease_id:'50000000-0000-4000-8000-000000000003'};
  const revocation:RevocationClaims={iss:scope.issuer,aud:'moxbot-host-bots/v1',namespace:'moxbot.bot.execution/v1',iat:now,nbf:now,exp:now+10,
    jti:'50000000-0000-4000-8000-000000000004',scope,grant_id:grantId,revoked_generation:1,bot_id:botId,host_context:context};
  return {g,intent,lease,revocation};
}

describe('Host Bot delegation uses real pinned ES256 proofs',()=>{
  it('requires a protected Host-local opt-in policy before construction',()=>{
    const base={hostId:'10000000-0000-4000-8000-000000000006',roots:{bots:'/var/lib/moxbots/bots'},jwks:{keys:[]},scope,
      currentHostContext:()=>context};
    expect(()=>createHostBotManager(base as HostBotManagerOptions)).toThrow('HOST_EXECUTION_NOT_OPTED_IN');
  });

  it('returns bounded allowlisted HostObservation and compares closed objects canonically',async()=>{
    const {jwks}=signedFixture(); const home=mkdtempSync(join(tmpdir(),'host-bot-status-')); const root=join(home,'bots');
    const previousHome=process.env.HOME; const previousUserProfile=process.env.USERPROFILE;
    try {
      vi.stubEnv('HOME',home); vi.stubEnv('USERPROFILE',home); syncBuiltinESMExports();
      mkdirSync(join(home,'.myagents'),{mode:0o700}); mkdirSync(root,{mode:0o700});
      let current:HostContext|undefined=context;
      const reorderedScope={identity_binding_id:scope.identity_binding_id,host_key_generation:scope.host_key_generation,
        host_device_id:scope.host_device_id,host_owner_id:scope.host_owner_id,network_id:scope.network_id,
        environment:scope.environment,service_id:scope.service_id,issuer:scope.issuer} satisfies ExecutionScope;
      const localPolicy={host_id:'70000000-0000-4000-8000-000000000001',owner_principal_id:scope.host_owner_id,scope,
        allowed_bot_ids:[botId],allowed_root_ids:['bots'],allowed_runtimes:['builtin'],allowed_model_refs:[],
        allowed_operations:['create','configure','enable','disable','delete','restore'],max_daily_tokens:1000,expires_at:now+900};
      const manager=createHostBotManager({hostId:localPolicy.host_id,roots:{bots:realpathSync(root)},jwks,scope:reorderedScope,
        currentHostContext:()=>current,now:()=>now,localPolicy} as HostBotManagerOptions);
      const observation=await manager.status();
      expect(observation).toEqual({host_revision:0,resource_revision:0,root_ids:['bots'],supported_runtimes:[],
        allowed_bot_ids:[botId],allowed_model_refs:[],max_daily_tokens:1000,policy_expires_at:now+900,snapshots:[]});
      current=undefined;
      await expect(manager.status()).rejects.toThrow('BOT_LOCAL_POLICY_STALE');
    } finally {
      vi.unstubAllEnvs(); syncBuiltinESMExports();
      if(previousHome===undefined) delete process.env.HOME; else process.env.HOME=previousHome;
      if(previousUserProfile===undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE=previousUserProfile;
      rmSync(home,{recursive:true,force:true});
    }
  });

  it('caps HostObservation at whole-snapshot boundaries without leaking paths or truncating prompts',async()=>{
    const {jwks}=signedFixture(); const home=mkdtempSync(join(tmpdir(),'host-bot-status-bound-')); const root=join(home,'bots');
    const previousHome=process.env.HOME; const previousUserProfile=process.env.USERPROFILE;
    try {
      vi.stubEnv('HOME',home); vi.stubEnv('USERPROFILE',home); syncBuiltinESMExports();
      mkdirSync(join(home,'.myagents'),{mode:0o700}); mkdirSync(root,{mode:0o700});
      const botIds=Array.from({length:5},(_,index)=>`30000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`);
      const localPolicy={host_id:'70000000-0000-4000-8000-000000000001',owner_principal_id:scope.host_owner_id,scope,
        allowed_bot_ids:botIds,allowed_root_ids:['bots'],allowed_runtimes:['builtin'],allowed_model_refs:[],
        allowed_operations:['create','configure','enable','disable','delete','restore'],max_daily_tokens:1000,expires_at:now+900};
      const hostId=localPolicy.host_id;
      const bots=botIds.map((id,index)=>{
        const grantValue:Grant={...grant(),id:`40000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,bot_id:id,
          relative_path:`delegated/bot-${index+1}`};
        const snapshot:BotSnapshot={bot_id:id,binding_generation:1,revision:0,deleted:false,admission:'closed',activity:'idle',
          configured:false,runnable:false,unsupported_reason:'BOT_RUNTIME_UNSUPPORTED',
          config:{name:`bot-${index+1}`,description:'',runtime:'builtin',model_ref:null,system_prompt:'x'.repeat(16_384),daily_tokens:1}};
        return {grantValue,snapshot,stored:{snapshot,root_id:'bots',relative_path:grantValue.relative_path,grant:grantValue,revoked:false}};
      });
      const ledger={version:1,host_id:hostId,scope,roots:{bots:realpathSync(root)},revision:0,
        accepted_grants:bots.map(item=>({grant:item.grantValue,jti:randomUUID(),accepted_at:now,revoked:false})),
        bots:bots.map(item=>item.stored),mutations:[],pending_mutation_id:null};
      await atomicModifyConfig(config=>({...config,hostBotDelegationsV1:ledger}),{strict:true});
      const manager=createHostBotManager({hostId,roots:{bots:realpathSync(root)},jwks,scope,currentHostContext:()=>context,now:()=>now,
        localPolicy} as HostBotManagerOptions);
      const observation=await manager.status();
      expect((loadConfig({strict:true}).hostBotDelegationsV1 as {revocation_tombstones?:unknown}).revocation_tombstones).toEqual([]);
      expect(observation.snapshots.length).toBeGreaterThan(0);
      expect(observation.snapshots.length).toBeLessThan(botIds.length);
      expect(observation.snapshots.every(snapshot=>snapshot.config.system_prompt.length===16_384)).toBe(true);
      expect(observation.snapshots.every(snapshot=>botIds.includes(snapshot.bot_id))).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(observation),'utf8')).toBeLessThanOrEqual(64*1024);
      expect(JSON.stringify(observation)).not.toContain(home);
    } finally {
      vi.unstubAllEnvs(); syncBuiltinESMExports();
      if(previousHome===undefined) delete process.env.HOME; else process.env.HOME=previousHome;
      if(previousUserProfile===undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE=previousUserProfile;
      rmSync(home,{recursive:true,force:true});
    }
  });

  it('accepts signed grant, command intent and context-bound lease, then rechecks owner context',()=>{
    const {jwks,jwt}=signedFixture(); const value=claims(); let current=context;
    const verifier=createBotDelegationVerifier({jwks,scope,currentHostContext:()=>current,now:()=>now});
    const grantToken=jwt('moxbot-execution-grant+jwt',{iss:scope.issuer,aud:'moxbot-host-bots/v1',namespace:'moxbot.bot.execution/v1',
      iat:now,nbf:now,exp:now+90,jti:'50000000-0000-4000-8000-000000000005',grant:value.g});
    expect(verifier.verifyGrant(grantToken).grant).toEqual(value.g);
    const intentToken=jwt('moxbot-execution-intent+jwt',value.intent);
    const leaseToken=jwt('moxbot-execution-lease+jwt',value.lease);
    const proof=verifier.verifyCommand(intentToken,leaseToken);
    expect(proof.intent.command.mutation_id).toBe(value.intent.command.mutation_id);
    expect(Object.isFrozen(proof.intent.command)).toBe(true);
    expect(()=>verifier.assertCurrent(proof)).not.toThrow();
    current={...context,connection_epoch:'20000000-0000-4000-8000-000000000099'};
    expect(()=>verifier.assertCurrent(proof)).toThrow('BOT_HOST_CONTEXT_STALE');
  });

  it('rejects wrong JWT domain, tampered signature, wrong scope and expired lease',()=>{
    const {jwks,jwt}=signedFixture(); const value=claims();
    const verifier=createBotDelegationVerifier({jwks,scope,currentHostContext:()=>context,now:()=>now});
    const wrongType=jwt('moxbot-execution-grant+jwt',value.intent);
    expect(()=>verifier.verifyCommand(wrongType,jwt('moxbot-execution-lease+jwt',value.lease))).toThrow();
    const valid=jwt('moxbot-execution-intent+jwt',value.intent);
    const lease=jwt('moxbot-execution-lease+jwt',value.lease);
    expect(()=>verifier.verifyCommand(`${valid.slice(0,-1)}x`,lease)).toThrow();
    const wrongScope={...scope,host_device_id:'10000000-0000-4000-8000-000000000099'};
    expect(()=>createBotDelegationVerifier({jwks,scope:wrongScope,currentHostContext:()=>context,now:()=>now}).verifyCommand(valid,lease)).toThrow();
    const expired={...value.lease,exp:now};
    expect(()=>verifier.verifyCommand(valid,jwt('moxbot-execution-lease+jwt',expired))).toThrow();
  });

  it('accepts a valid proof larger than the former local 32 KiB cutoff up to execution-core limits',()=>{
    const {jwks,jwt}=signedFixture(); const value=claims();
    value.g.allowed_model_refs=Array.from({length:64},(_,i)=>`60000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`);
    value.intent.grant=value.g;
    const command=value.intent.command;
    if(command.operation.method!=='create') throw new Error('fixture operation mismatch');
    command.operation.params.description='d'.repeat(4_096);
    command.operation.params.system_prompt='x'.repeat(16_384);
    command.request_hash=commandHash(command);
    value.lease.intent_hash=intentHash(value.intent);
    value.lease.request_hash=command.request_hash;
    const intentToken=jwt('moxbot-execution-intent+jwt',value.intent);
    const leaseToken=jwt('moxbot-execution-lease+jwt',value.lease);
    expect(Buffer.byteLength(intentToken)).toBeGreaterThan(32_768);
    expect(Buffer.byteLength(intentToken)).toBeLessThan(MAX_JWT_BYTES);
    expect(()=>createBotDelegationVerifier({jwks,scope,currentHostContext:()=>context,now:()=>now})
      .verifyCommand(intentToken,leaseToken)).not.toThrow();
  });

  it('accepts only signed revocation for the exact grant generation and Host context',()=>{
    const {jwks,jwt}=signedFixture(); const value=claims();
    const verifier=createBotDelegationVerifier({jwks,scope,currentHostContext:()=>context,now:()=>now});
    const token=jwt('moxbot-execution-revocation+jwt',value.revocation);
    expect(verifier.verifyRevocation(token,{grant_id:grantId,bot_id:botId,revoked_generation:1}).jti).toBe(value.revocation.jti);
    expect(()=>verifier.verifyRevocation(token,{grant_id:grantId,bot_id:botId,revoked_generation:2})).toThrow();
    expect(()=>verifier.verifyRevocation(token,{grant_id:grantId,bot_id:'30000000-0000-4000-8000-000000000009',revoked_generation:1})).toThrow();
  });

  it('replays only durable terminal receipts by exact lease tuple, including expired-policy read-only recovery',async()=>{
    const {jwks}=signedFixture(); const home=mkdtempSync(join(tmpdir(),'host-bot-receipt-outbox-')); const root=join(home,'bots');
    const hostId='70000000-0000-4000-8000-000000000001'; const previousHome=process.env.HOME; const previousUserProfile=process.env.USERPROFILE;
    try {
      vi.stubEnv('HOME',home); vi.stubEnv('USERPROFILE',home); syncBuiltinESMExports();
      mkdirSync(join(home,'.myagents'),{mode:0o700}); mkdirSync(root,{mode:0o700});
      const localPolicy={host_id:hostId,owner_principal_id:scope.host_owner_id,scope,allowed_bot_ids:[botId],allowed_root_ids:['bots'],
        allowed_runtimes:['builtin'],allowed_model_refs:[],allowed_operations:['create','configure','enable','disable','delete','restore'],
        max_daily_tokens:1000,expires_at:0};
      const fingerprint='a'.repeat(64);
      const makeMutation=(mutationId:string,status:'persisted'|'unconfirmed',leaseId?:string):
        {command:Command;phase:'complete';receipt:Receipt;lease_acks?:Array<{lease_id:string;acknowledged:boolean;policy_fingerprint?:string}>}=>{
        const cmd={...command(),mutation_id:mutationId}; cmd.request_hash=commandHash(cmd);
        const saved:Receipt={mutation_id:cmd.mutation_id,request_hash:cmd.request_hash,grant_id:cmd.grant_id,grant_generation:cmd.grant_generation,
          bot_id:cmd.bot_id,binding_generation:cmd.binding_generation,revision:0,status,...(status==='unconfirmed'?{code:'BOT_RUN_OUTCOME_UNKNOWN'}:{})};
        return {command:cmd,phase:'complete',receipt:saved,...(leaseId?{lease_acks:[{lease_id:leaseId,acknowledged:false}]}:{})};
      };
      const oldMutation=makeMutation('40000000-0000-4000-8000-000000000011','persisted','50000000-0000-4000-8000-000000000010');
      const queuedMutation=makeMutation('40000000-0000-4000-8000-000000000012','persisted');
      queuedMutation.lease_acks=[{lease_id:'50000000-0000-4000-8000-000000000011',acknowledged:false,policy_fingerprint:fingerprint}];
      const uncertainMutation=makeMutation('40000000-0000-4000-8000-000000000013','unconfirmed');
      uncertainMutation.lease_acks=[{lease_id:'50000000-0000-4000-8000-000000000012',acknowledged:false,policy_fingerprint:fingerprint}];
      const ledger={version:1,host_id:hostId,scope,roots:{bots:realpathSync(root)},revision:0,accepted_grants:[],bots:[],
        mutations:[oldMutation,queuedMutation,uncertainMutation],pending_mutation_id:null,revocation_tombstones:[]};
      await atomicModifyConfig(config=>({...config,hostBotDelegationsV1:ledger}),{strict:true});
      const manager=createHostBotManager({hostId,roots:{bots:realpathSync(root)},jwks,scope,currentHostContext:()=>context,now:()=>now,localPolicy,
        authorityFingerprint:fingerprint} as HostBotManagerOptions);
      expect(await manager.pendingReceipts()).toMatchObject([{lease_id:'50000000-0000-4000-8000-000000000011',
        mutation_id:queuedMutation.command.mutation_id,request_hash:queuedMutation.command.request_hash,receipt:{status:'persisted'}}]);
      const replacedPolicyManager=createHostBotManager({hostId,roots:{bots:realpathSync(root)},jwks,scope,currentHostContext:()=>context,now:()=>now,localPolicy,
        authorityFingerprint:'b'.repeat(64)} as HostBotManagerOptions);
      expect(await replacedPolicyManager.pendingReceipts()).toEqual([]);
      await expect(replacedPolicyManager.ackReceipt('50000000-0000-4000-8000-000000000011',queuedMutation.command.mutation_id,
        queuedMutation.command.request_hash)).rejects.toThrow('BOT_RECEIPT_ACK_MISMATCH');
      expect(await manager.ackReceipt('50000000-0000-4000-8000-000000000011',queuedMutation.command.mutation_id,queuedMutation.command.request_hash))
        .toEqual({lease_id:'50000000-0000-4000-8000-000000000011'});
      expect(await manager.ackReceipt('50000000-0000-4000-8000-000000000011',queuedMutation.command.mutation_id,queuedMutation.command.request_hash))
        .toEqual({lease_id:'50000000-0000-4000-8000-000000000011'});
      expect(await manager.pendingReceipts()).toEqual([]);
      const stored=loadConfig({strict:true}).hostBotDelegationsV1 as {mutations:Array<{command:Command;
        lease_acks:Array<{lease_id:string;acknowledged:boolean;policy_fingerprint?:string}>}>};
      expect(stored.mutations.find(item=>item.command.mutation_id===oldMutation.command.mutation_id)?.lease_acks)
        .toEqual([{lease_id:'50000000-0000-4000-8000-000000000010',acknowledged:false}]);
      expect(stored.mutations.find(item=>item.command.mutation_id===uncertainMutation.command.mutation_id)?.lease_acks)
        .toMatchObject([{lease_id:'50000000-0000-4000-8000-000000000012',acknowledged:false,policy_fingerprint:fingerprint}]);
    } finally {
      vi.unstubAllEnvs(); syncBuiltinESMExports();
      if(previousHome===undefined) delete process.env.HOME; else process.env.HOME=previousHome;
      if(previousUserProfile===undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE=previousUserProfile;
      rmSync(home,{recursive:true,force:true});
    }
  });

  it('does not stop a same-Bot same-binding runtime whose persisted run identity differs',async()=>{
    const {jwks,jwt}=signedFixture(); const home=mkdtempSync(join(tmpdir(),'host-bot-exact-stop-')); const root=join(home,'bots');
    const hostId='70000000-0000-4000-8000-000000000001'; const modelRef='60000000-0000-4000-8000-000000000010';
    const previousHome=process.env.HOME; const previousUserProfile=process.env.USERPROFILE; let stopCalls=0;
    try {
      vi.stubEnv('HOME',home); vi.stubEnv('USERPROFILE',home); syncBuiltinESMExports();
      mkdirSync(join(home,'.myagents'),{mode:0o700}); mkdirSync(root,{mode:0o700});
      const localPolicy={host_id:hostId,owner_principal_id:scope.host_owner_id,scope,allowed_bot_ids:[botId],allowed_root_ids:['bots'],
        allowed_runtimes:['builtin'],allowed_model_refs:[modelRef],allowed_operations:['create','configure','enable','disable','delete','restore'],
        max_daily_tokens:1000,expires_at:now+900};
      const grantValue:Grant={...grant(),allowed_model_refs:[modelRef]};
      const snapshot:BotSnapshot={bot_id:botId,binding_generation:1,revision:0,deleted:false,admission:'closed',activity:'idle',agent_id:'bound-agent',
        configured:true,runnable:false,unsupported_reason:'BOT_RUNTIME_UNSUPPORTED',
        config:{name:'bound bot',description:'',runtime:'builtin',model_ref:modelRef,system_prompt:'prompt',daily_tokens:10}};
      const ledger={version:1,host_id:hostId,scope,roots:{bots:realpathSync(root)},revision:0,
        accepted_grants:[{grant:grantValue,jti:randomUUID(),accepted_at:now,revoked:false}],
        bots:[{snapshot,root_id:'bots',relative_path:grantValue.relative_path,grant:grantValue,revoked:false}],mutations:[],pending_mutation_id:null,
        revocation_tombstones:[]};
      await atomicModifyConfig(config=>({...config,hostBotDelegationsV1:ledger}),{strict:true});
      const runSession='80000000-0000-4000-8000-000000000001'; const runGeneration='80000000-0000-4000-8000-000000000002';
      const adapter:BotRuntimeAdapter={runtime:'builtin',prepare:async frozen=>({id:'prepared-exact',runtime:'builtin',snapshot_hash:frozen.snapshot_hash,
        session_id:runSession,run_generation:runGeneration}),start:async request=>({status:'running',identity:request.identity}),
        inspect:async input=>({status:'running',identity:input.identity}),stop:async request=>{stopCalls++;return {status:'stopped',identity:request.identity};}};
      const manager=createHostBotManager({hostId,roots:{bots:realpathSync(root)},jwks,scope,currentHostContext:()=>context,now:()=>now,localPolicy,runtimeAdapter:adapter} as HostBotManagerOptions);
      const common={iss:scope.issuer,aud:'moxbot-host-bots/v1',namespace:'moxbot.bot.execution/v1',iat:now,nbf:now,exp:now+90};
      const sign=(value:Command)=>{
        value.request_hash=commandHash(value);
        const intent:IntentClaims={...common,jti:randomUUID(),scope,grant:grantValue,command:value};
        const lease:LeaseClaims={...common,jti:randomUUID(),exp:now+10,scope,grant_id:grantValue.id,grant_generation:grantValue.generation,
          bot_id:botId,binding_generation:value.binding_generation,mutation_id:value.mutation_id,request_hash:value.request_hash,intent_hash:intentHash(intent),
          host_context:context,lease_id:randomUUID()};
        return {intent:jwt('moxbot-execution-intent+jwt',intent),lease:jwt('moxbot-execution-lease+jwt',lease)};
      };
      const enable:Command={...command(),mutation_id:randomUUID(),grant_id:grantValue.id,grant_generation:grantValue.generation,
        operation:{method:'enable',params:{}}};
      const enableProof=sign(enable);
      expect(await manager.mutate(enableProof.intent,enableProof.lease)).toMatchObject({status:'persisted',snapshot:{activity:'running',admission:'open'}});
      await atomicModifyConfig(config=>{
        const stored=config.hostBotDelegationsV1 as typeof ledger & {bots:Array<{snapshot:BotSnapshot;runtime_entry:BotRunEntry}>};
        const changedSnapshot={...stored.bots[0]!.snapshot,active_run:{session_id:'80000000-0000-4000-8000-000000000011',run_generation:'80000000-0000-4000-8000-000000000012'}};
        const changedEntry={...stored.bots[0]!.runtime_entry,session_id:changedSnapshot.active_run.session_id,
          run_generation:changedSnapshot.active_run.run_generation};
        return {...config,hostBotDelegationsV1:{...stored,bots:[{...stored.bots[0]!,snapshot:changedSnapshot,runtime_entry:changedEntry}]}};
      },{strict:true});
      expect(await manager.snapshot(botId)).toMatchObject({activity:'unknown',admission:'closed',runnable:false,
        active_run:{session_id:'80000000-0000-4000-8000-000000000011',run_generation:'80000000-0000-4000-8000-000000000012'}});
      const current=loadConfig({strict:true}).hostBotDelegationsV1 as {revision:number};
      const disable:Command={...command(),mutation_id:randomUUID(),grant_id:grantValue.id,grant_generation:grantValue.generation,
        expected_host_revision:current.revision,operation:{method:'disable',params:{policy:'cancel'}}};
      const disableProof=sign(disable);
      expect(await manager.mutate(disableProof.intent,disableProof.lease)).toMatchObject({status:'unconfirmed',code:'BOT_RUN_OUTCOME_UNKNOWN'});
      expect(stopCalls).toBe(0);
      expect(await manager.snapshot(botId)).toMatchObject({activity:'unknown',admission:'closed',runnable:false,
        active_run:{session_id:'80000000-0000-4000-8000-000000000011',run_generation:'80000000-0000-4000-8000-000000000012'}});
    } finally {
      vi.unstubAllEnvs(); syncBuiltinESMExports();
      if(previousHome===undefined) delete process.env.HOME; else process.env.HOME=previousHome;
      if(previousUserProfile===undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE=previousUserProfile;
      rmSync(home,{recursive:true,force:true});
    }
  });

  it.runIf(process.platform==='linux')('persists a real disabled Agent and reopens interrupted Bot activity as unknown',async()=>{
    const {jwks,jwt}=signedFixture(); const home=mkdtempSync(join(tmpdir(),'host-bot-persist-'));
    const root=join(home,'bots'); const botId='30000000-0000-4000-8000-000000000011';
    const modelRef='60000000-0000-4000-8000-000000000010'; const hostId='70000000-0000-4000-8000-000000000001';
    const principal=scope.host_owner_id; let nowSeconds=now;
    const previousHome=process.env.HOME; const previousUserProfile=process.env.USERPROFILE;
    try {
      vi.stubEnv('HOME',home); vi.stubEnv('USERPROFILE',home); syncBuiltinESMExports();
      mkdirSync(join(home,'.myagents'),{mode:0o700}); mkdirSync(root,{mode:0o700}); mkdirSync(join(root,'delegated'),{mode:0o700});
      const localPolicy={host_id:hostId,owner_principal_id:principal,scope,allowed_bot_ids:[botId],allowed_root_ids:['bots'],
        allowed_runtimes:['builtin'],allowed_model_refs:[modelRef],allowed_operations:['create','configure','enable','disable','delete','restore'],
        max_daily_tokens:1000,expires_at:now+2_000};
      const expectedAuthorityFingerprint=createHash('sha256').update(canonicalBytes({host_id:hostId,scope,
        roots:{bots:realpathSync(root)},jwks,local_policy:localPolicy})).digest('hex');
      let currentHostContext:HostContext|undefined=context;
      const options={hostId,roots:{bots:root},jwks,scope,currentHostContext:()=>currentHostContext,now:()=>nowSeconds,localPolicy};
      const grantValue:Grant={...grant(),bot_id:botId,allowed_model_refs:[modelRef]};
      const common={iss:scope.issuer,aud:'moxbot-host-bots/v1',namespace:'moxbot.bot.execution/v1',iat:now,nbf:now,exp:now+90};
      const grantToken=jwt('moxbot-execution-grant+jwt',{...common,jti:randomUUID(),grant:grantValue});
      let manager=createHostBotManager(options as HostBotManagerOptions);
      await manager.acceptGrant(grantToken);
      const rewrittenGrantToken=jwt('moxbot-execution-grant+jwt',{...common,jti:randomUUID(),grant:{...grantValue,generation:2}});
      await expect(manager.acceptGrant(rewrittenGrantToken)).rejects.toThrow('BOT_GRANT_ID_IMMUTABLE');

      const createCommand:Command={...command(),bot_id:botId,grant_id:grantId,operation:{method:'create',params:{name:'persisted bot',description:'',runtime:'builtin',
        model_ref:modelRef,system_prompt:'local prompt',daily_tokens:100,resource_expected_revision:0}}};
      createCommand.request_hash=commandHash(createCommand);
      const intent:IntentClaims={...common,jti:randomUUID(),exp:now+80,scope,grant:grantValue,command:createCommand};
      const intentToken=jwt('moxbot-execution-intent+jwt',intent);
      const lease:LeaseClaims={...common,jti:randomUUID(),exp:now+10,scope,grant_id:grantId,grant_generation:1,bot_id:botId,
        binding_generation:1,mutation_id:createCommand.mutation_id,request_hash:createCommand.request_hash,intent_hash:intentHash(intent),
        host_context:context,lease_id:randomUUID()};
      const leaseToken=jwt('moxbot-execution-lease+jwt',lease);
      const created=await manager.mutate(intentToken,leaseToken);
      expect(created).toMatchObject({status:'persisted',snapshot:{activity:'idle',admission:'closed'},agent_id:expect.any(String)});
      expect(loadConfig({strict:true}).agents?.[0].enabled).toBe(false);
      const replayManager=createHostBotManager(options as HostBotManagerOptions);
      expect(await replayManager.mutate(intentToken,leaseToken)).toEqual(created);
      const secondLease={...lease,jti:randomUUID(),lease_id:randomUUID()};
      const secondLeaseToken=jwt('moxbot-execution-lease+jwt',secondLease);
      expect(await replayManager.mutate(intentToken,secondLeaseToken)).toEqual(created);
      const pendingAfterRestart=await replayManager.pendingReceipts();
      expect(pendingAfterRestart).toHaveLength(2);
      expect(pendingAfterRestart.map(item=>item.lease_id)).toEqual([lease.lease_id,secondLease.lease_id]);
      expect(pendingAfterRestart.every(item=>item.mutation_id===createCommand.mutation_id &&
        item.request_hash===createCommand.request_hash && item.receipt.status==='persisted')).toBe(true);
      const expiredReadManager=createHostBotManager({hostId,roots:{bots:realpathSync(root)},jwks,scope,currentHostContext:()=>context,now:()=>now,
        localPolicy} as HostBotManagerOptions);
      const dateNowSpy=vi.spyOn(Date,'now').mockReturnValue((localPolicy.expires_at+1)*1000);
      try {
        expect(await expiredReadManager.pendingReceipts()).toHaveLength(2);
        await expect(expiredReadManager.mutate(intentToken,leaseToken)).rejects.toThrow('BOT_LOCAL_POLICY_STALE');
        await expect(expiredReadManager.ackReceipt(lease.lease_id,createCommand.mutation_id,'f'.repeat(64)))
          .rejects.toThrow('BOT_RECEIPT_ACK_MISMATCH');
        expect(await expiredReadManager.ackReceipt(lease.lease_id,createCommand.mutation_id,createCommand.request_hash))
          .toEqual({lease_id:lease.lease_id});
        expect(await expiredReadManager.ackReceipt(lease.lease_id,createCommand.mutation_id,createCommand.request_hash))
          .toEqual({lease_id:lease.lease_id});
        expect(await expiredReadManager.pendingReceipts().then(rows=>rows.map(item=>item.lease_id)))
          .toEqual([secondLease.lease_id]);
        expect(await replayManager.ackReceipt(secondLease.lease_id,createCommand.mutation_id,createCommand.request_hash))
          .toEqual({lease_id:secondLease.lease_id});
        expect(await replayManager.pendingReceipts()).toEqual([]);
      } finally {
        dateNowSpy.mockRestore();
      }
      const savedAfterAcks=loadConfig({strict:true}).hostBotDelegationsV1 as {mutations:Array<{receipt:Receipt;
        lease_acks:Array<{lease_id:string;acknowledged:boolean;policy_fingerprint:string}>}>};
      const acknowledgedLeaseAcks=savedAfterAcks.mutations.find(item=>item.receipt.mutation_id===createCommand.mutation_id)?.lease_acks;
      expect(acknowledgedLeaseAcks).toEqual([
        {lease_id:lease.lease_id,acknowledged:true,policy_fingerprint:expectedAuthorityFingerprint},
        {lease_id:secondLease.lease_id,acknowledged:true,policy_fingerprint:expectedAuthorityFingerprint},
      ]);
      expect(new Set(acknowledgedLeaseAcks?.map(item=>item.policy_fingerprint)).size).toBe(1);

      const signCommand=(value:Command, commandGrant:Grant=grantValue)=>{
        value.request_hash=commandHash(value);
        const proof:IntentClaims={...common,jti:randomUUID(),exp:now+80,scope,grant:commandGrant,command:value};
        const intentJwt=jwt('moxbot-execution-intent+jwt',proof);
        const leaseClaims:LeaseClaims={...common,jti:randomUUID(),exp:now+10,scope,grant_id:commandGrant.id,grant_generation:commandGrant.generation,bot_id:botId,
          binding_generation:value.binding_generation,mutation_id:value.mutation_id,request_hash:value.request_hash,intent_hash:intentHash(proof),
          host_context:context,lease_id:randomUUID()};
        return {intent:intentJwt,lease:jwt('moxbot-execution-lease+jwt',leaseClaims)};
      };
      const signRevocation=()=>jwt('moxbot-execution-revocation+jwt',{iss:scope.issuer,aud:'moxbot-host-bots/v1',
        namespace:'moxbot.bot.execution/v1',iat:now,nbf:now,exp:now+10,jti:randomUUID(),scope,grant_id:grantId,
        revoked_generation:1,bot_id:botId,host_context:context} satisfies RevocationClaims);
      let stopStatus:'stopped'|'unknown'='unknown'; let startStatus:'running'|'unknown'='running';
      let inspectionStatus:'running'|'stopped'|'unknown'='running'; let changeContextOnInspect=false;
      const runtimeAdapter:BotRuntimeAdapter={runtime:'builtin',
        prepare:async frozen=>({id:'prepared-entry',runtime:'builtin',snapshot_hash:frozen.snapshot_hash,
          session_id:'80000000-0000-4000-8000-000000000001',run_generation:'80000000-0000-4000-8000-000000000002'}),
        start:async request=>{inspectionStatus=startStatus;return startStatus==='running'?{status:'running',identity:request.identity}:{status:'unknown'};},
        stop:async request=>{inspectionStatus=stopStatus;return stopStatus==='stopped'?{status:'stopped',identity:request.identity}:{status:'unknown'};},
        inspect:async input=>{if(changeContextOnInspect) currentHostContext={...context,challenge_nonce:'20000000-0000-4000-8000-000000000099'};
          return {status:inspectionStatus,identity:input.identity};}};
      manager=createHostBotManager({...options,runtimeAdapter} as HostBotManagerOptions);
      const enableCommand:Command={...createCommand,mutation_id:randomUUID(),expected_host_revision:1,operation:{method:'enable',params:{}}};
      const enableProof=signCommand(enableCommand);
      const enabled=await manager.mutate(enableProof.intent,enableProof.lease);
      expect(enabled).toMatchObject({status:'persisted',snapshot:{activity:'running',admission:'open',runnable:true,
        active_run:{session_id:'80000000-0000-4000-8000-000000000001',run_generation:'80000000-0000-4000-8000-000000000002'}}});
      const observation=await manager.status();
      expect(observation).toMatchObject({host_revision:2,resource_revision:1,root_ids:['bots'],supported_runtimes:['builtin'],
        allowed_bot_ids:[botId],allowed_model_refs:[modelRef],snapshots:[{bot_id:botId,activity:'running',admission:'open'}]});
      expect(JSON.stringify(observation)).not.toContain(home);
      changeContextOnInspect=true;
      await expect(manager.status()).rejects.toThrow('BOT_HOST_CONTEXT_STALE');
      changeContextOnInspect=false; currentHostContext=context;

      const restartedWhileRunning=createHostBotManager(options as HostBotManagerOptions);
      expect(await restartedWhileRunning.snapshot(botId)).toMatchObject({activity:'unknown',admission:'closed',runnable:false,
        active_run:{session_id:'80000000-0000-4000-8000-000000000001',run_generation:'80000000-0000-4000-8000-000000000002'}});
      expect(await restartedWhileRunning.receipt(enableCommand.mutation_id,enableCommand.actor_principal_id,enableCommand.actor_session_handle))
        .toMatchObject({status:'persisted',snapshot:{activity:'running',admission:'open',runnable:true}});

      // The adapter-less manager reports the active process as unknown and closes admission.
      // Reconcile again through the original manager before issuing a new CAS-bound mutation.
      const originalManagerObservation=await manager.status();
      expect(originalManagerObservation).toMatchObject({snapshots:[{bot_id:botId,activity:'running',admission:'closed',runnable:true}]});
      const staleDisable:Command={...createCommand,mutation_id:randomUUID(),expected_host_revision:observation.host_revision,
        operation:{method:'disable',params:{policy:'cancel'}}};
      const staleDisableProof=signCommand(staleDisable);
      expect(await manager.mutate(staleDisableProof.intent,staleDisableProof.lease))
        .toMatchObject({status:'conflict',code:'HOST_REVISION_CONFLICT'});
      expect(await manager.receipt(enableCommand.mutation_id,enableCommand.actor_principal_id,enableCommand.actor_session_handle))
        .toMatchObject({status:'persisted',snapshot:{activity:'running',admission:'open',runnable:true}});
      const disableCommand:Command={...createCommand,mutation_id:randomUUID(),expected_host_revision:originalManagerObservation.host_revision,
        operation:{method:'disable',params:{policy:'cancel'}}};
      const disableProof=signCommand(disableCommand);
      const uncertainStop=await manager.mutate(disableProof.intent,disableProof.lease);
      expect(uncertainStop).toMatchObject({status:'unconfirmed',code:'BOT_RUN_OUTCOME_UNKNOWN'});
      expect(await manager.snapshot(botId)).toMatchObject({activity:'unknown',admission:'closed',runnable:false,active_run:{session_id:expect.any(String)}});

      stopStatus='stopped';
      const beforeConfirmStop=await manager.status();
      expect(beforeConfirmStop).toMatchObject({snapshots:[{bot_id:botId,activity:'unknown',admission:'closed',runnable:false}]});
      const confirmStop:Command={...disableCommand,mutation_id:randomUUID(),expected_host_revision:beforeConfirmStop.host_revision};
      const stoppedProof=signCommand(confirmStop);
      expect(await manager.mutate(stoppedProof.intent,stoppedProof.lease)).toMatchObject({status:'persisted',snapshot:{activity:'stopped',admission:'closed',active_run:null}});

      const busyAdapter:BotRuntimeAdapter={runtime:'builtin',prepare:async()=>{throw new Error('HOST_BUSY');},
        start:async request=>({status:'running',identity:request.identity}),stop:async request=>({status:'stopped',identity:request.identity}),
        inspect:async input=>({status:'running',identity:input.identity})};
      const busyManager=createHostBotManager({...options,runtimeAdapter:busyAdapter} as HostBotManagerOptions);
      const busyObservation=await busyManager.status();
      expect(busyObservation).toMatchObject({snapshots:[{bot_id:botId,activity:'stopped',admission:'closed',active_run:null}]});
      const busyCommand:Command={...enableCommand,mutation_id:randomUUID(),expected_host_revision:busyObservation.host_revision};
      const busyProof=signCommand(busyCommand);
      expect(await busyManager.mutate(busyProof.intent,busyProof.lease)).toMatchObject({status:'failed',code:'HOST_BUSY'});
      expect(await busyManager.snapshot(botId)).toMatchObject({activity:'stopped',admission:'closed',active_run:null});

      startStatus='unknown';
      const beforeInterrupted=await manager.status();
      const interrupted:Command={...enableCommand,mutation_id:randomUUID(),expected_host_revision:beforeInterrupted.host_revision};
      const interruptedProof=signCommand(interrupted);
      const unknownStart=await manager.mutate(interruptedProof.intent,interruptedProof.lease);
      expect(unknownStart).toMatchObject({status:'unconfirmed',code:'BOT_RUN_OUTCOME_UNKNOWN'});

      manager=createHostBotManager(options as HostBotManagerOptions);
      const recovered=await manager.snapshot(botId);
      expect(recovered).toMatchObject({activity:'unknown',admission:'closed',runnable:false,
        active_run:{session_id:'80000000-0000-4000-8000-000000000001',run_generation:'80000000-0000-4000-8000-000000000002'}});
      expect(await manager.receipt(interrupted.mutation_id,interrupted.actor_principal_id,interrupted.actor_session_handle))
        .toMatchObject({status:'unconfirmed',code:'BOT_RUN_OUTCOME_UNKNOWN'});
      expect(await manager.mutate(interruptedProof.intent,interruptedProof.lease)).toMatchObject({status:'unconfirmed',code:'BOT_RUN_OUTCOME_UNKNOWN'});
      expect((JSON.parse(readFileSync(join(home,'.myagents','config.json'),'utf8')).hostBotDelegationsV1).pending_mutation_id).toBeNull();

      // Reconnect the exact runtime adapter and reconcile before testing revoke retries.
      manager=createHostBotManager({...options,runtimeAdapter} as HostBotManagerOptions);
      await manager.snapshot(botId);
      stopStatus='unknown';
      const firstRevocation=await manager.revoke(signRevocation(),{grant_id:grantId,bot_id:botId,revoked_generation:1});
      expect(firstRevocation).toMatchObject({activity:'unknown',admission:'closed',runnable:false,
        active_run:{session_id:'80000000-0000-4000-8000-000000000001'}});
      stopStatus='stopped';
      const retriedRevocation=await manager.revoke(signRevocation(),{grant_id:grantId,bot_id:botId,revoked_generation:1});
      expect(retriedRevocation).toMatchObject({activity:'stopped',admission:'closed',runnable:false,active_run:null});

      const nextGrant:Grant={...grantValue,id:'30000000-0000-4000-8000-000000000019',generation:2};
      const nextGrantToken=jwt('moxbot-execution-grant+jwt',{...common,jti:randomUUID(),grant:nextGrant});
      await manager.acceptGrant(nextGrantToken);
      const beforeRestore=await manager.status();
      expect(beforeRestore).toMatchObject({snapshots:[{bot_id:botId,activity:'stopped',admission:'closed',active_run:null}]});
      const restoredCommand:Command={...createCommand,mutation_id:randomUUID(),grant_id:nextGrant.id,grant_generation:2,
        binding_generation:2,expected_host_revision:beforeRestore.host_revision,operation:{method:'restore',params:{}}};
      const restoredProof=signCommand(restoredCommand,nextGrant);
      const restored=await manager.mutate(restoredProof.intent,restoredProof.lease);
      expect(restored).toMatchObject({status:'persisted',snapshot:{deleted:false,binding_generation:2,activity:'idle',admission:'closed',runnable:false}});
      expect(await manager.revoke(signRevocation(),{grant_id:grantId,bot_id:botId,revoked_generation:1})).toEqual(restored.snapshot);

      const currentLedger=loadConfig({strict:true}).hostBotDelegationsV1 as {revision:number};
      startStatus='running';
      const expiryEnable:Command={...enableCommand,mutation_id:randomUUID(),grant_id:nextGrant.id,grant_generation:nextGrant.generation,
        binding_generation:2,expected_host_revision:currentLedger.revision};
      const expiryProof=signCommand(expiryEnable,nextGrant);
      expect(await manager.mutate(expiryProof.intent,expiryProof.lease)).toMatchObject({status:'persisted',snapshot:{activity:'running',admission:'open'}});
      nowSeconds=nextGrant.expires_at+1;
      stopStatus='unknown';
      expect(await manager.status()).toMatchObject({snapshots:[{bot_id:botId,activity:'unknown',admission:'closed',runnable:false,
        active_run:{session_id:'80000000-0000-4000-8000-000000000001'}}]});
      stopStatus='stopped';
      expect(await manager.status()).toMatchObject({snapshots:[{bot_id:botId,activity:'stopped',admission:'closed',runnable:false,active_run:null}]});
      expect(await manager.receipt(expiryEnable.mutation_id,expiryEnable.actor_principal_id,expiryEnable.actor_session_handle))
        .toMatchObject({status:'persisted',snapshot:{activity:'running',admission:'open',runnable:true}});
    } finally {
      vi.unstubAllEnvs(); syncBuiltinESMExports();
      if(previousHome===undefined) delete process.env.HOME; else process.env.HOME=previousHome;
      if(previousUserProfile===undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE=previousUserProfile;
      rmSync(home,{recursive:true,force:true});
    }
  });

  it.runIf(process.platform==='linux')('persists pre-accept revocation tombstones and rejects a late grant of the revoked generation',async()=>{
    const {jwks,jwt}=signedFixture(); const home=mkdtempSync(join(tmpdir(),'host-bot-tombstone-')); const root=join(home,'bots');
    const hostId='70000000-0000-4000-8000-000000000001'; const bot='30000000-0000-4000-8000-000000000021';
    const previousHome=process.env.HOME; const previousUserProfile=process.env.USERPROFILE;
    try {
      vi.stubEnv('HOME',home); vi.stubEnv('USERPROFILE',home); syncBuiltinESMExports();
      mkdirSync(join(home,'.myagents'),{mode:0o700}); mkdirSync(root,{mode:0o700});
      const localPolicy={host_id:hostId,owner_principal_id:scope.host_owner_id,scope,allowed_bot_ids:[bot],allowed_root_ids:['bots'],
        allowed_runtimes:['builtin'],allowed_model_refs:[],allowed_operations:['create','configure','enable','disable','delete','restore'],
        max_daily_tokens:1000,expires_at:now+900};
      const manager=createHostBotManager({hostId,roots:{bots:root},jwks,scope,currentHostContext:()=>context,now:()=>now,localPolicy} as HostBotManagerOptions);
      const revocation=(jti:string)=>jwt('moxbot-execution-revocation+jwt',{iss:scope.issuer,aud:'moxbot-host-bots/v1',
        namespace:'moxbot.bot.execution/v1',iat:now,nbf:now,exp:now+10,jti,scope,grant_id:grantId,revoked_generation:1,bot_id:bot,host_context:context});
      const target={grant_id:grantId,bot_id:bot,revoked_generation:1};
      const first=await manager.revoke(revocation(randomUUID()),target);
      expect(first).toMatchObject({bot_id:bot,binding_generation:0,activity:'idle',admission:'closed'});
      const reread=await manager.revoke(revocation(randomUUID()),target);
      expect(reread).toEqual(first);
      const stored=loadConfig({strict:true}).hostBotDelegationsV1 as {revocation_tombstones:unknown[]};
      expect(stored.revocation_tombstones).toHaveLength(1);
      const staleGrant:Grant={...grant(),bot_id:bot,expires_at:now+800};
      await expect(manager.acceptGrant(jwt('moxbot-execution-grant+jwt',{iss:scope.issuer,aud:'moxbot-host-bots/v1',
        namespace:'moxbot.bot.execution/v1',iat:now,nbf:now,exp:now+90,jti:randomUUID(),grant:staleGrant})))
        .rejects.toThrow('BOT_GRANT_TOMBSTONED');
      const freshGrant:Grant={...staleGrant,id:'30000000-0000-4000-8000-000000000022',generation:2};
      await expect(manager.acceptGrant(jwt('moxbot-execution-grant+jwt',{iss:scope.issuer,aud:'moxbot-host-bots/v1',
        namespace:'moxbot.bot.execution/v1',iat:now,nbf:now,exp:now+90,jti:randomUUID(),grant:freshGrant}))).resolves.toEqual(freshGrant);
    } finally {
      vi.unstubAllEnvs(); syncBuiltinESMExports();
      if(previousHome===undefined) delete process.env.HOME; else process.env.HOME=previousHome;
      if(previousUserProfile===undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE=previousUserProfile;
      rmSync(home,{recursive:true,force:true});
    }
  });
});
