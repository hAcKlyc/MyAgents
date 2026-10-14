import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {createHostRemoteSessionService,HostRemoteError,assertOrdinaryRemoteAgent,type HostRemotePorts} from '../host/remote-session';
import {createRemoteReceiptOwner} from './remote-session/receipts';
import type {RemoteSnapshot} from '../shared/remoteSession';

const directories:string[]=[];
it('refuses delegated Bot workspaces after exit/restart and fails closed on damaged private owner records',()=>{
  expect(()=>assertOrdinaryRemoteAgent('private',{bots:[{snapshot:{agent_id:'private'}}]})).toThrow('REMOTE_SESSION_PRIVATE');
  expect(()=>assertOrdinaryRemoteAgent('ordinary',{bots:[{snapshot:{agent_id:'private'}}]})).not.toThrow();
  expect(()=>assertOrdinaryRemoteAgent('ordinary',{bots:[{}]})).toThrow('REMOTE_SESSION_PRIVATE_OWNER_UNAVAILABLE');
  expect(()=>assertOrdinaryRemoteAgent('ordinary',undefined)).not.toThrow();
});
afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true});});
async function fixture() {
  const directory=await mkdtemp(join(tmpdir(),'host-remote-receipts-'));directories.push(directory);
  const owner=createRemoteReceiptOwner('host:fixture',directory);
  const snapshot:RemoteSnapshot={kind:'snapshot',agentId:'agent',sessionId:'session',generation:null,turnId:null,revision:'1',state:'idle',title:'History',runtime:'builtin',model:null,terminal:null,messages:[],interactions:[],hasMoreBefore:false,nextBefore:null};
  const ports:HostRemotePorts={
    resolveAgent:vi.fn(async()=>({workspacePath:'/controlled/agent',runtime:'builtin'})),
    validateSession:vi.fn(async(sessionId,workspace)=>{if(sessionId!=='session'||workspace!=='/controlled/agent')throw new HostRemoteError('REMOTE_SESSION_TARGET_CHANGED');}),
    list:vi.fn(async()=>({kind:'list' as const,agentId:'agent',items:[],hasMore:false,nextBefore:null})),
    snapshot:vi.fn(async()=>snapshot),
    ensure:vi.fn(async()=>({sessionId:'session',generation:'generation'})),
    active:()=>({sessionId:'session',generation:'generation'}),
    execute:vi.fn(async()=>({accepted:true})),
    receipts:{begin:owner.begin,read:owner.read,update:owner.finish},
  };
  return {ports,owner,directory,service:createHostRemoteSessionService(ports)};
}
it('keeps scoped history reads cold and rejects disabled/unknown Agent, workspace misrouting and forged fields',async()=>{
  const {ports,service}=await fixture();
  expect(await service.request({kind:'list',agentId:'agent',limit:3})).toMatchObject({kind:'list'});
  expect(await service.request({kind:'get',agentId:'agent',sessionId:'session',limit:3})).toMatchObject({kind:'snapshot'});
  expect(ports.ensure).not.toHaveBeenCalled();expect(ports.execute).not.toHaveBeenCalled();
  expect(await service.request({kind:'get',agentId:'agent',sessionId:'another-workspace',limit:3})).toEqual({kind:'error',code:'REMOTE_SESSION_TARGET_CHANGED'});
  expect(await service.request({kind:'start',agentId:'agent',operationId:randomUUID(),text:'hello',workspace:'/arbitrary',callerIdentity:'forged'})).toEqual({kind:'error',code:'REMOTE_SESSION_REQUEST_INVALID'});
  ports.resolveAgent=async()=>{throw new HostRemoteError('REMOTE_SESSION_AGENT_UNAVAILABLE');};
  expect(await service.request({kind:'capabilities',agentId:'agent'})).toEqual({kind:'error',code:'REMOTE_SESSION_AGENT_UNAVAILABLE'});
});
it('persists one stable dispatch and original receipt without replay, and rejects changed operation intent',async()=>{
  const {ports,service,owner}=await fixture();
  const request={kind:'start' as const,agentId:'agent',operationId:randomUUID(),text:'first'};
  expect(await service.request(request)).toMatchObject({status:'processing',sessionId:null});await service.drain();
  expect(ports.ensure).toHaveBeenCalledWith('/controlled/agent',undefined);
  expect(ports.execute).toHaveBeenCalledWith({...request,kind:'send',sessionId:'session'},{sessionId:'session',generation:'generation'});
  expect(await service.request(request)).toMatchObject({status:'accepted',sessionId:'session'});
  expect(ports.execute).toHaveBeenCalledTimes(1);
  expect(await service.request({...request,text:'changed'})).toEqual({kind:'error',code:'REMOTE_OPERATION_CONFLICT'});
  expect(await owner.read('agent',request.operationId)).toMatchObject({status:'accepted'});
});
it('returns promptly while admission is pending and allows stop on the original generation',async()=>{
  const {ports,service,owner}=await fixture();
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  ports.execute=vi.fn(async request=>{if(request.kind==='send')await pending;return {accepted:true};});
  const send={kind:'send' as const,agentId:'agent',sessionId:'session',operationId:randomUUID(),text:'hello'};
  expect(await service.request(send)).toMatchObject({status:'processing'});
  await vi.waitFor(()=>expect(ports.execute).toHaveBeenCalledTimes(1));
  const stop={kind:'stop' as const,agentId:'agent',sessionId:'session',operationId:randomUUID(),generation:'generation',turnId:'turn'};
  expect(await service.request(stop)).toMatchObject({status:'processing'});
  await vi.waitFor(async()=>expect(await owner.read('agent',stop.operationId)).toMatchObject({status:'accepted'}));
  expect(await owner.read('agent',send.operationId)).toMatchObject({status:'processing'});
  release();await service.drain();
});
it('retains unconfirmed after crash or IPC loss, rejects stale approval without spawning and cannot auto replay',async()=>{
  const {ports,service,owner,directory}=await fixture();
  const interrupted={kind:'send' as const,agentId:'agent',sessionId:'session',operationId:randomUUID(),text:'unknown'};
  await owner.begin(interrupted,'session');
  const restarted=createRemoteReceiptOwner('host:fixture',directory);
  expect(await restarted.read('agent',interrupted.operationId)).toMatchObject({status:'unconfirmed'});
  expect(await restarted.begin(interrupted,'session')).toMatchObject({fresh:false,receipt:{status:'unconfirmed'}});
  const expired={kind:'respond' as const,agentId:'agent',sessionId:'session',operationId:randomUUID(),generation:'old',turnId:'turn',requestId:'approval',interaction:'permission' as const,approved:true};
  await service.request(expired);await service.drain();
  expect(await owner.read('agent',expired.operationId)).toMatchObject({status:'rejected',code:'REMOTE_SESSION_INTERACTION_EXPIRED'});
  expect(ports.ensure).not.toHaveBeenCalled();expect(ports.execute).not.toHaveBeenCalled();
  ports.execute=vi.fn(async()=>{throw new Error('process exited after dispatch');});
  const lost={...interrupted,operationId:randomUUID()};await service.request(lost);await service.drain();
  expect(await service.request(lost)).toMatchObject({status:'unconfirmed'});expect(ports.execute).toHaveBeenCalledTimes(1);
});
it('rechecks Agent before irreversible handoff and preserves busy rejection',async()=>{
  const {ports,service,owner}=await fixture();
  ports.ensure=vi.fn(async()=>{ports.resolveAgent=async()=>{throw new HostRemoteError('REMOTE_SESSION_AGENT_UNAVAILABLE');};return {sessionId:'session',generation:'generation'};});
  const changed={kind:'start' as const,agentId:'agent',operationId:randomUUID(),text:'must not dispatch'};
  await service.request(changed);await service.drain();expect(ports.execute).not.toHaveBeenCalled();
  expect(await owner.read('agent',changed.operationId)).toMatchObject({status:'rejected'});
  ports.resolveAgent=async()=>({workspacePath:'/controlled/agent',runtime:'builtin'});
  ports.ensure=async()=>{throw new HostRemoteError('REMOTE_SESSION_HOST_BUSY');};
  const busy={...changed,operationId:randomUUID()};await service.request(busy);await service.drain();
  expect(await owner.read('agent',busy.operationId)).toMatchObject({status:'rejected',code:'REMOTE_SESSION_HOST_BUSY'});
});
it('bounds pending sends while preserving reserved control slots for stop and receipt recovery',async()=>{
  const {ports,service,owner}=await fixture();let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  ports.execute=vi.fn(async request=>{if(request.kind==='send')await held;return {accepted:true};});
  for(let index=0;index<16;index++)expect(await service.request({kind:'send',agentId:'agent',sessionId:'session',operationId:randomUUID(),text:'queued'})).toMatchObject({status:'processing'});
  expect(await service.request({kind:'send',agentId:'agent',sessionId:'session',operationId:randomUUID(),text:'overflow'})).toEqual({kind:'error',code:'REMOTE_SESSION_CAPACITY'});
  const stop={kind:'stop' as const,agentId:'agent',sessionId:'session',operationId:randomUUID(),generation:'generation',turnId:'turn'};
  expect(await service.request(stop)).toMatchObject({status:'processing'});
  await vi.waitFor(async()=>expect(await owner.read('agent',stop.operationId)).toMatchObject({status:'accepted'}));
  release();await service.drain();
});
