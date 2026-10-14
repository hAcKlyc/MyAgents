import {expect,it} from 'vitest';
import {settleHostSessionAdmission} from '../host/remote-admission';
import type {DesktopAdmissionResult} from './session-engine/types';

it('acknowledges the real remote queue admission while native dispatch awaits prior-turn approval',async()=>{
  let reject!:(reason:Error)=>void;
  const dispatchAcceptance=new Promise<{accepted:boolean}>( (_,rejectPromise)=>{reject=rejectPromise;});
  const result:DesktopAdmissionResult={success:true,queued:true,queueId:'queued-turn',dispatchAcceptance};
  expect(await settleHostSessionAdmission(true,result)).toEqual({accepted:true,queued:true,queueId:'queued-turn'});
  reject(new Error('later cancellation'));await Promise.resolve();
});
it('keeps local and Bot dispatch waits and rejection semantics unchanged',async()=>{
  let resolve!:(value:{accepted:boolean;error?:string})=>void;
  const dispatchAcceptance=new Promise<{accepted:boolean;error?:string}>(resolvePromise=>{resolve=resolvePromise;});
  let completed=false;const waiting=settleHostSessionAdmission(false,{success:true,queued:true,queueId:'local-turn',dispatchAcceptance}).finally(()=>{completed=true;});
  await Promise.resolve();expect(completed).toBe(false);resolve({accepted:false,error:'denied'});
  await expect(waiting).rejects.toThrow('Session dispatch was rejected');
});
it('requires an actual queue identity and rejects failed admissions before returning an acknowledgment',async()=>{
  await expect(settleHostSessionAdmission(true,{success:false,queued:true,queueId:'invalid'})).rejects.toThrow('Session message admission failed');
  await expect(settleHostSessionAdmission(true,{success:true,queued:false,queueId:'active-turn',dispatchAcceptance:Promise.resolve({accepted:false,error:'REMOTE_SESSION_AGENT_UNAVAILABLE'})})).rejects.toThrow('REMOTE_SESSION_AGENT_UNAVAILABLE');
  await expect(settleHostSessionAdmission(true,{success:true,queued:true,dispatchAcceptance:Promise.resolve({accepted:false})})).rejects.toThrow('Session dispatch was rejected');
});
