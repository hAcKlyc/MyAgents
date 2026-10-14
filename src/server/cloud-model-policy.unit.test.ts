import {randomUUID,createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {assertCloudModelAdmission,obtainCloudModelLease,validateCloudModelPolicy,parseCloudModelLease,cloudSessionProviderId,type CloudModelPolicy,type CloudModelLease} from '../host/cloud-model';
import {parseHostBotBootstrap} from '../host/bot-session-bootstrap';
import {canonicalBytes} from '../../services/agentnet/execution-core/js/index.mjs';
const bot=randomUUID(),ref=randomUUID();
const policy:CloudModelPolicy={service_origin:'https://cloud.example.test',allowed_bot_ids:[bot],allowed_model_refs:[ref],expires_at:Math.floor(Date.now()/1000)+3600,max_daily_tokens:1000,max_output_tokens:100,access_credential:'systemd-credential:bot-model-access'};
const lease:CloudModelLease={session_id:randomUUID(),model_ref:ref,provider_id:randomUUID(),model:'mock-model-v1',provider_revision:1,model_revision:1,gateway_base_url:'',api_protocol:'anthropic',max_output_tokens:100,max_total_tokens:1000,expires_at:Math.floor(Date.now()/1000)+600};
lease.gateway_base_url=`${policy.service_origin}/api/bot-model/sessions/${lease.session_id}`;
describe('finite platform model admission',()=>{
  it('is default off and preserves exact Host/Bot/model scope, expiry and token caps',()=>{
    const parent={...policy};validateCloudModelPolicy(policy,parent);
    for(const denied of [undefined,{...policy,expires_at:1},{...policy,allowed_bot_ids:[randomUUID()]},{...policy,allowed_model_refs:[randomUUID()]}])expect(()=>assertCloudModelAdmission(denied,bot,ref,100)).toThrow('BOT_MODEL_NOT_AUTHORIZED');
    expect(()=>assertCloudModelAdmission(policy,bot,ref,1001)).toThrow();
    expect(()=>validateCloudModelPolicy({...policy,allowed_model_refs:[randomUUID()]},parent)).toThrow();
    expect(()=>validateCloudModelPolicy({...policy,service_origin:'http://cloud.example.test'},parent)).toThrow();
    expect(()=>validateCloudModelPolicy({...policy,access_credential:'actual-key-in-policy'},parent)).toThrow();
  });
  it('requests only finite limits and retains only an immutable public lease outside secret IPC',async()=>{
    const access='synthetic-scoped-access';const sessionToken='synthetic-short-session-token';
    const transport=vi.fn(async()=>new Response(JSON.stringify({...lease,access_token:sessionToken})));
    const result=await obtainCloudModelLease({policy,bot_id:bot,host_id:randomUUID(),model_ref:ref,daily_tokens:1000,access_token:access,fetch:transport as typeof fetch});
    expect(result.access_token).toBe(sessionToken);expect(JSON.stringify(result.lease)).not.toContain(sessionToken);expect(Object.isFrozen(result.lease)).toBe(true);
    const request=transport.mock.calls[0] as unknown as [string,RequestInit];expect(request[0]).toBe(`${policy.service_origin}/api/bot-model/sessions`);expect(request[1].redirect).toBe('error');
    expect(JSON.parse(request[1].body as string)).toMatchObject({bot_id:bot,model_ref:ref,max_output_tokens:100,max_total_tokens:1000});
    for(const modified of [{...lease,gateway_base_url:'https://evil.test'},{...lease,model_ref:randomUUID()},{...lease,expires_at:Math.floor(Date.now()/1000)+1801},{...lease,max_total_tokens:1001},{...lease,upstream_api_key:'must-never-cross'}]){
      await expect(obtainCloudModelLease({policy,bot_id:bot,host_id:randomUUID(),model_ref:ref,daily_tokens:1000,access_token:access,fetch:async()=>new Response(JSON.stringify({...modified,access_token:sessionToken}))})).rejects.toThrow('BOT_MODEL_LEASE_INVALID');
    }
    await expect(obtainCloudModelLease({policy,bot_id:bot,host_id:randomUUID(),model_ref:ref,daily_tokens:1000,access_token:access,fetch:async()=>new Response('secret echoed',{status:401})})).rejects.toThrow('BOT_MODEL_GATEWAY_REJECTED');
  });
  it('freezes the model/provider revisions in new Session bootstrap, refuses bearer insertion and never changes an old model',()=>{
    const payload={bot_id:bot,agent_id:'test-agent',binding_generation:1,revision:1,runtime:'builtin' as const,config:{name:'Test',description:'',runtime:'builtin' as const,model_ref:ref,system_prompt:'Use the approved model.',daily_tokens:1000}};
    const snapshot={...payload,snapshot_hash:createHash('sha256').update(canonicalBytes(payload)).digest('hex')};
    const input={version:1,snapshot,workspace:'/tmp/test-bot',run_generation:randomUUID(),provider_id:cloudSessionProviderId(lease),model:lease.model,cloud_model:lease};
    const bootstrap=parseHostBotBootstrap(input);const next={...lease,session_id:randomUUID(),model:'mock-model-v2',model_revision:2};next.gateway_base_url=`${policy.service_origin}/api/bot-model/sessions/${next.session_id}`;
    const newBootstrap=parseHostBotBootstrap({...input,provider_id:cloudSessionProviderId(next),model:next.model,cloud_model:next});
    expect(bootstrap.model).toBe('mock-model-v1');expect(newBootstrap.model).toBe('mock-model-v2');
    expect(()=>parseHostBotBootstrap({...input,cloud_model:{...lease,access_token:'leak'}})).toThrow();
    expect(()=>parseCloudModelLease({...lease,api_protocol:'openai'},policy.service_origin)).toThrow();
  });
});
