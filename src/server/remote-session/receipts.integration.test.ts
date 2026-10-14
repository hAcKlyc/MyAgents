import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRemoteReceiptOwner } from './receipts';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})))});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'remote-receipts-'));dirs.push(dir);return {dir,owner:createRemoteReceiptOwner('desktop',dir)}}
const send=()=>({kind:'send' as const,agentId:'agent',sessionId:'session',operationId:randomUUID(),text:'private prompt'});
it('linearizes concurrent attempts and permanently fences changed intent without storing prompt',async()=>{
  const {dir,owner}=await fixture(),request=send();
  const attempts=await Promise.all(Array.from({length:8},()=>owner.begin(request,'session')));
  expect(attempts.filter(v=>v.fresh)).toHaveLength(1);
  await expect(owner.begin({...request,text:'different'},'session')).rejects.toMatchObject({code:'REMOTE_OPERATION_CONFLICT'});
  await owner.finish(request,'accepted','session');
  const reopened=createRemoteReceiptOwner('desktop',dir);
  expect(await reopened.begin(request,'session')).toMatchObject({fresh:false,receipt:{status:'accepted'}});
  const contents=await readFile(join(dir,(await readdir(dir)).find(p=>p.endsWith('.json'))!),'utf8');
  expect(contents).not.toContain(request.text);
});
it('separates identical operation IDs across Agents and closed scopes',async()=>{
  const {dir,owner}=await fixture(),request=send();
  await owner.begin(request,'session');
  await owner.begin({...request,agentId:'other'},'session');
  await owner.finish(request,'accepted','session');
  expect(await owner.read('other',request.operationId)).toMatchObject({status:'processing'});
  expect(await createRemoteReceiptOwner('other-device',dir).read('agent',request.operationId)).toMatchObject({status:'not-found'});
});
it('adopts the prepared birth exactly once; dead owner reads unconfirmed and cannot replay',async()=>{
  const {dir,owner}=await fixture(),request={kind:'start' as const,agentId:'agent',operationId:randomUUID(),text:'hello'};
  await owner.begin(request,null);await owner.finish(request,'processing','session');
  expect(await owner.adoptPrepared(request,'session')).toBe(true);
  expect(await owner.adoptPrepared(request,'session')).toBe(false);
  const path=join(dir,(await readdir(dir)).find(p=>p.endsWith('.json'))!);
  const entry=JSON.parse(await readFile(path,'utf8'));entry.ownerPid=2147483647;
  await writeFile(path,JSON.stringify(entry),{mode:0o600});
  expect(await owner.read('agent',request.operationId)).toMatchObject({status:'unconfirmed'});
  expect(await owner.begin(request,'session')).toMatchObject({fresh:false,receipt:{status:'unconfirmed'}});
});
it('rejects public permissions and symlink stores before mutation',async()=>{
  const {dir,owner}=await fixture();await chmod(dir,0o755);
  await expect(owner.begin(send(),'session')).rejects.toMatchObject({code:'REMOTE_RECEIPT_STORAGE_UNSAFE'});
  const parent=await mkdtemp(join(tmpdir(),'remote-symlink-'));dirs.push(parent);await symlink(dir,join(parent,'alias'));
  await expect(createRemoteReceiptOwner('desktop',join(parent,'alias')).begin(send(),'session')).rejects.toMatchObject({code:'REMOTE_RECEIPT_STORAGE_UNSAFE'});
});
it('caps concurrent new records without erasing terminal or unknown deduplication identities',async()=>{
  const {dir}=await fixture(),owner=createRemoteReceiptOwner('desktop',dir,2);
  const requests=[send(),send(),send(),send()];
  const results=await Promise.allSettled(requests.map(request=>owner.begin(request,'session')));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
  const accepted=requests.find((_,i)=>results[i].status==='fulfilled')!;
  await owner.finish(accepted,'accepted','session');
  expect(await owner.begin(accepted,'session')).toMatchObject({fresh:false,receipt:{status:'accepted'}});
  await expect(owner.begin(send(),'session')).rejects.toMatchObject({code:'REMOTE_RECEIPT_CAPACITY'});
});
it('does not infer a processing job from a reused live PID with a stale incarnation lease',async()=>{
  const {dir,owner}=await fixture(),request=send();await owner.begin(request,'session');
  const path=join(dir,(await readdir(dir)).find(p=>p.endsWith('.json'))!);
  const entry=JSON.parse(await readFile(path,'utf8'));
  entry.ownerPid=process.ppid;entry.ownerToken=randomUUID();entry.updatedAt=Date.now()-20_000;
  await writeFile(path,JSON.stringify(entry),{mode:0o600});
  expect(await owner.read(request.agentId,request.operationId)).toMatchObject({status:'unconfirmed'});
  expect(await owner.begin(request,'session')).toMatchObject({fresh:false});
});
