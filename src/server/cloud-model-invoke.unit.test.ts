import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {createCloudModelInvoker,type ActiveCloudModelRun} from '../host/cloud-model-invoke';
import {rejectCloudModelRetry,type CloudModelPolicy} from '../host/cloud-model';
import type {BotRunEntry} from '../host/bot-runtime';
function fixture(){
  const bot=randomUUID(),modelRef=randomUUID(),hash='a'.repeat(64),session=randomUUID(),generation=randomUUID();
  const entry:BotRunEntry={id:randomUUID(),session_id:session,run_generation:generation,runtime:'builtin',snapshot_hash:hash};
  const identity={bot_id:bot,agent_id:'approved-agent',binding_generation:1,session_id:session,run_generation:generation,snapshot_hash:hash,runtime:'builtin' as const};
  const expires=Math.floor(Date.now()/1000)+300;
  let current:ActiveCloudModelRun|undefined={identity,snapshot:{bot_id:bot,agent_id:identity.agent_id,binding_generation:1,revision:1,runtime:'builtin',snapshot_hash:hash,config:{name:'Approved',description:'',runtime:'builtin',model_ref:modelRef,system_prompt:'Approved prompt',daily_tokens:1000}},lease:{session_id:randomUUID(),model_ref:modelRef,provider_id:randomUUID(),model:'approved-model',provider_revision:1,model_revision:1,gateway_base_url:'https://fixed.example.test',api_protocol:'anthropic',max_output_tokens:100,max_total_tokens:1000,expires_at:expires},closing:false,processAlive:true};
  let policy:CloudModelPolicy|undefined={service_origin:'https://fixed.example.test',allowed_bot_ids:[bot],allowed_model_refs:[modelRef],expires_at:expires+10,max_daily_tokens:1000,max_output_tokens:100,access_credential:'systemd-credential:fixture'};
  const dispatch=vi.fn(async()=>({accepted:true}));const assertAuthority=vi.fn(async()=>{});
  const invoke=createCloudModelInvoker({current:()=>current,policy:()=>policy,assertAuthority,dispatch});
  return{invoke,entry,identity,dispatch,assertAuthority,get current(){return current;},set current(value){current=value;},get policy(){return policy;},set policy(value){policy=value;}};
}
describe('trusted exact Bot owner invocation',()=>{
  it('admits one matching live run and dispatches exactly once',async()=>{const f=fixture();await expect(f.invoke(f.entry,f.identity,'approved turn')).resolves.toEqual({accepted:true});expect(f.dispatch).toHaveBeenCalledOnce();expect(f.dispatch).toHaveBeenCalledWith(f.identity,'approved turn');});
  it('rejects wrong Bot/agent/run/Session/binding/snapshot/entry before dispatch',async()=>{const f=fixture();for(const identity of [{...f.identity,bot_id:randomUUID()},{...f.identity,agent_id:'another'},{...f.identity,run_generation:randomUUID()},{...f.identity,session_id:randomUUID()},{...f.identity,binding_generation:2},{...f.identity,snapshot_hash:'b'.repeat(64)}])await expect(f.invoke(f.entry,identity,'turn')).rejects.toThrow('BOT_MODEL_NOT_AUTHORIZED');await expect(f.invoke({...f.entry,session_id:randomUUID()},f.identity,'turn')).rejects.toThrow();expect(f.dispatch).not.toHaveBeenCalled();});
  it('rejects absent policy, closed/dead/replaced owner and expired lease',async()=>{
    for(const reason of ['off','closing','dead','expired','missing'] as const){const f=fixture();if(reason==='off')f.policy=undefined;else if(reason==='missing')f.current=undefined;else if(reason==='closing')f.current={...f.current!,closing:true};else if(reason==='dead')f.current={...f.current!,processAlive:false};else f.current={...f.current!,lease:{...f.current!.lease,expires_at:1}};await expect(f.invoke(f.entry,f.identity,'turn')).rejects.toThrow();expect(f.dispatch).not.toHaveBeenCalled();}
  });
  it('rechecks the owner after protected policy IO and never retries uncertain dispatch',async()=>{const replaced=fixture();replaced.assertAuthority.mockImplementation(async()=>{replaced.current=undefined;});await expect(replaced.invoke(replaced.entry,replaced.identity,'turn')).rejects.toThrow();expect(replaced.dispatch).not.toHaveBeenCalled();const unknown=fixture();unknown.dispatch.mockRejectedValue(new Error('Outcome unknown'));await expect(unknown.invoke(unknown.entry,unknown.identity,'turn')).rejects.toThrow('Outcome unknown');expect(unknown.dispatch).toHaveBeenCalledOnce();});
  it('rejects chargeable SDK retries only for the cloud Session namespace',()=>{for(const count of ['1','2','999','-1','bad',['1']])expect(rejectCloudModelRetry(`cloud-session:${randomUUID()}`,count)).toBe(true);for(const count of [undefined,'0'])expect(rejectCloudModelRetry(`cloud-session:${randomUUID()}`,count)).toBe(false);expect(rejectCloudModelRetry('private-provider','1')).toBe(false);});
});
