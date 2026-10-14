import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
const fault=vi.hoisted(()=>({rename:false}));
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,rename:async(...args:Parameters<typeof actual.rename>)=>{
    if(fault.rename)throw Object.assign(new Error('fixture denied'),{code:'EACCES'});
    return actual.rename(...args);
  }};
});
import {createRemoteReceiptOwner} from './receipts';
let directory:string|undefined;
afterEach(async()=>{fault.rename=false;if(directory)await rm(directory,{recursive:true,force:true});directory=undefined});
it('cleans only its own failed temporaries and preserves the prior durable deduplication receipt',async()=>{
  directory=await mkdtemp(join(tmpdir(),'remote-receipt-failure-'));
  const owner=createRemoteReceiptOwner('fixture',directory,1);
  const request={kind:'send' as const,agentId:'agent',sessionId:'session',operationId:randomUUID(),text:'private'};
  fault.rename=true;
  for(let i=0;i<8;i++)await expect(owner.begin({...request,operationId:randomUUID()},'session')).rejects.toMatchObject({code:'EACCES'});
  expect((await readdir(directory)).filter(name=>name.endsWith('.tmp')||name.endsWith('.json'))).toEqual([]);
  fault.rename=false;await owner.begin(request,'session');
  fault.rename=true;await expect(owner.finish(request,'accepted','session')).rejects.toMatchObject({code:'EACCES'});
  fault.rename=false;
  expect(await owner.begin(request,'session')).toMatchObject({fresh:false,receipt:{status:'processing'}});
  expect((await readdir(directory)).filter(name=>name.endsWith('.tmp'))).toEqual([]);
});
