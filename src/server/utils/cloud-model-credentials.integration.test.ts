import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {cloudSessionProviderId,type CloudModelLease} from '../../host/cloud-model';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.resetModules();});
it('resolves only the immutable Session provider and refuses missing/expired authority without global private key fallback',async()=>{
  vi.resetModules();vi.stubEnv('MYAGENTS_HOST_MODE','1');vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
  const credentials=await import('./host-credentials');const config=await import('./admin-config');
  const lease:CloudModelLease={session_id:randomUUID(),model_ref:randomUUID(),provider_id:randomUUID(),model:'approved-model',provider_revision:1,model_revision:1,gateway_base_url:'https://cloud.example.test/api/bot-model/sessions/placeholder',api_protocol:'openai',upstream_format:'responses',max_output_tokens:100,max_total_tokens:1000,expires_at:Math.floor(Date.now()/1000)+60};
  lease.gateway_base_url=`https://cloud.example.test/api/bot-model/sessions/${lease.session_id}`;
  const id=cloudSessionProviderId(lease);const privateKey='synthetic-private-owner-key';const token='synthetic-session-only-token';
  const privateConfig={providerApiKeys:{[id]:privateKey}};
  expect(()=>config.resolveProviderEnv(id,privateConfig,lease.model)).toThrow('BOT_MODEL_NOT_AUTHORIZED');
  credentials.installHostCloudModelCredential(lease,token);
  expect(config.resolveProviderEnv(id,privateConfig,lease.model)).toMatchObject({apiKey:token,baseUrl:`${lease.gateway_base_url}/v1`,apiProtocol:'openai',upstreamFormat:'responses'});
  expect(()=>config.resolveProviderEnv(id,privateConfig,'other-model')).toThrow();
  expect(()=>credentials.installHostCloudModelCredential({...lease,model:'replacement'},token)).toThrow();
  vi.setSystemTime(Date.now()+60_000);
  expect(()=>config.resolveProviderEnv(id,privateConfig,lease.model)).toThrow('BOT_MODEL_NOT_AUTHORIZED');
});
