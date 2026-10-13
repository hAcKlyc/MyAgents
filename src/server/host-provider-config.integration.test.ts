import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,it,expect,vi} from 'vitest';
import {configureProviderHost,configureHost,readProviderConfigReceipt,readConfigReceipt,extendedHostSettings,selectedHostProviderProfile,legacyHostRepresentable,type HostConfig} from '../host/management';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup() {
 const root=await mkdtemp(join(tmpdir(),'mox-host-profile-'));roots.push(root);const path=join(root,'config.json');const workspace=join(root,'客户 工作区');await mkdir(workspace);
 await writeFile(path,'{}');
 const owner={hostId:'00000000-0000-4000-8000-000000000101',defaultWorkspace:workspace,readConfig:async()=>JSON.parse(await readFile(path,'utf8')) as HostConfig,writeConfig:async(config:HostConfig)=>{await writeFile(path,JSON.stringify(config));},workspacePath:async()=>workspace,busy:()=>false,selectWorkspace:async()=>({path:workspace,verify:vi.fn(),close:vi.fn()})};
 const body={provider:{id:'custom-host',name:'Portable',apiProtocol:'openai',baseUrl:'https://api.example.test/v1',authType:'both'},model:'vendor/model',workspace:{rootId:'workspaces',relativePath:'客户 工作区'},executionAuthorized:false,expectedRevision:0,mutationId:randomUUID()};
 return {owner,body,path};
}
it('persists profile, provider-bound reference and restart receipts without implicit authorization or plaintext',async()=> {
 const {owner,body,path}=await setup();const receipt=await configureProviderHost(owner,body);expect(receipt).toMatchObject({status:'persisted',revision:1,settings:{workspace:body.workspace,executionAuthorized:false}});
 const config=JSON.parse(await readFile(path,'utf8'));expect(config.providerApiKeys).toEqual({'custom-host':'host-provider-credential:custom-host'});expect(legacyHostRepresentable(config)).toBe(false);
 expect(readProviderConfigReceipt(config,owner.hostId,'custom-host',body.mutationId)).toEqual(receipt);
 expect(readProviderConfigReceipt(config,owner.hostId,'other',body.mutationId)).toMatchObject({status:'not-found'});
 expect(await configureProviderHost({...owner,busy:()=>true,selectWorkspace:async()=>{throw new Error('directory unavailable');}},body)).toEqual(receipt);
 await expect(configureProviderHost(owner,{...body,model:'different'})).rejects.toThrow('different');
 await expect(configureHost(owner,{providerId:'moonshot-coding',model:'k3',executionAuthorized:false,expectedRevision:1,mutationId:randomUUID()})).rejects.toMatchObject({code:'HOST_MANAGEMENT_UPGRADE_REQUIRED'});
 expect(()=>readConfigReceipt(config,owner.hostId,{mutationId:body.mutationId})).toThrow('HOST_MANAGEMENT_UPGRADE_REQUIRED');
 const conflict=await configureProviderHost(owner,{...body,mutationId:randomUUID()});expect(conflict).toMatchObject({status:'conflict',revision:1});
 expect(readProviderConfigReceipt(await owner.readConfig(),owner.hostId,'custom-host',conflict.mutationId)).toEqual(conflict);
});
it('preserves original Kimi receipt and rejects implicit execution grants',async()=> {
 const {owner,body}=await setup();
 await expect(configureProviderHost(owner,{...body,provider:{...body.provider,id:'xai-sub'}})).rejects.toThrow('Invalid portable');
 await expect(configureProviderHost(owner,{...body,executionAuthorized:true})).rejects.toThrow('cannot authorize');expect(await owner.readConfig()).toEqual({});
 const legacy=await configureHost(owner,{providerId:'moonshot-coding',model:'k3',executionAuthorized:false,expectedRevision:0,mutationId:randomUUID()});
 expect(extendedHostSettings(await owner.readConfig(),{workspaces:owner.defaultWorkspace})).toMatchObject({workspace:{rootId:'workspaces',relativePath:''}});
 await configureProviderHost(owner,{...body,expectedRevision:1});expect(readConfigReceipt(await owner.readConfig(),owner.hostId,{mutationId:'mutationId' in legacy?legacy.mutationId:''})).toEqual(legacy);
});
it('reports uncertain persistence and recovers original committed receipt',async()=> {
 const {owner,body}=await setup();
 await expect(configureProviderHost({...owner,writeConfig:async c=>{await owner.writeConfig(c);throw new Error('fsync after rename');}},body)).rejects.toMatchObject({code:'HOST_MANAGEMENT_UNCONFIRMED'});
 expect(readProviderConfigReceipt(await owner.readConfig(),owner.hostId,'custom-host',body.mutationId)).toMatchObject({status:'persisted'});
});

it('materializes a real portable route with provider-bound credentials through the actual Host registry',async()=> {
 const {owner,body}=await setup();const config=await configureProviderHost(owner,body);expect(config.status).toBe('persisted');
 const {installHostSessionCredential}=await import('./utils/host-credentials');const {materializeProviderRouteEnv}=await import('./utils/admin-config');const {createConcreteProviderRoute}=await import('../shared/providerRoute');
 vi.stubEnv('MYAGENTS_HOST_MODE','1');installHostSessionCredential('synthetic-owner-env-key',body.provider.id);
 try {
   const first=await owner.readConfig();const route=createConcreteProviderRoute(body.provider.id,body.model);
   expect(materializeProviderRouteEnv(route,first)).toMatchObject({providerId:body.provider.id,apiProtocol:'openai',baseUrl:body.provider.baseUrl,apiKey:'synthetic-owner-env-key',authType:'both'});
   await expect(configureProviderHost(owner,{...body,model:'vendor/new-model',provider:{...body.provider,baseUrl:'https://other.example.test/v1'},expectedRevision:1,mutationId:randomUUID()})).rejects.toThrow('immutable');
   await expect(configureProviderHost(owner,{...body,model:'vendor/new-model',expectedRevision:1,mutationId:randomUUID()})).rejects.toThrow('immutable');
   const second=await configureProviderHost(owner,{...body,model:'vendor/new-model',provider:{...body.provider,id:'custom-host-version-2',baseUrl:'https://other.example.test/v1'},expectedRevision:1,mutationId:randomUUID()});expect(second.status).toBe('persisted');
   const next=await owner.readConfig();
   // The old route keeps immutable metadata and explicit frozen aliases,
   // independently of the newly selected version's default Provider/model.
   expect(materializeProviderRouteEnv(route,next)).toMatchObject({baseUrl:body.provider.baseUrl,apiKey:'synthetic-owner-env-key',modelAliases:{fable:body.model,sonnet:body.model,opus:body.model,haiku:body.model}});
   expect(route.model).toBe('vendor/model');expect(next.hostSettings?.model).toBe('vendor/new-model');
   vi.stubEnv('MYAGENTS_HOST_MODE','');expect(materializeProviderRouteEnv(route,next)).toBeUndefined();
 } finally {vi.unstubAllEnvs();}
});

it('preserves immutable explicit aliases when a direct caller selects another model under the same ID',async()=> {
 const {owner,body}=await setup();const modelAliases={fable:'vendor/fable',sonnet:'vendor/sonnet',opus:'vendor/opus',haiku:'vendor/haiku'};
 const first=await configureProviderHost(owner,{...body,provider:{...body.provider,modelAliases}});expect(first.status).toBe('persisted');
 const config=await owner.readConfig();
 await expect(configureProviderHost(owner,{...body,provider:{...body.provider,modelAliases:{...modelAliases,fable:'changed/fable'}},expectedRevision:1,mutationId:randomUUID()})).rejects.toThrow('immutable');
 expect(await owner.readConfig()).toEqual(config);
 const second=await configureProviderHost(owner,{...body,provider:{...body.provider,modelAliases},model:'vendor/new-model',expectedRevision:1,mutationId:randomUUID()});expect(second.status).toBe('persisted');
 expect((await owner.readConfig()).hostProviderProfiles).toEqual(config.hostProviderProfiles);
});

it('hydrates only validated selected owner metadata and preserves source identity without exposing keys',async()=> {
 const {owner,body}=await setup();expect(selectedHostProviderProfile(await owner.readConfig())).toBeNull();
 const profile={...body.provider,sourceProviderId:'original-source-id'};
 await configureProviderHost(owner,{...body,provider:profile});const config=await owner.readConfig();
 const hydrated=selectedHostProviderProfile({...config,providerApiKeys:{...config.providerApiKeys,irrelevant:'synthetic-key-marker'}});
 expect(hydrated).toMatchObject({...profile,modelAliases:{fable:body.model,sonnet:body.model,opus:body.model,haiku:body.model}});
 expect(JSON.stringify(hydrated)).not.toContain('synthetic-key-marker');expect(JSON.stringify(hydrated)).not.toContain('host-provider-credential:');
 hydrated!.name='local presentation change';expect(selectedHostProviderProfile(config)?.name).toBe(profile.name);
 expect(()=>selectedHostProviderProfile({...config,hostProviderProfiles:{[profile.id]:{...profile,apiKey:'synthetic-key-marker'}}})).toThrow('profile is invalid');
 await expect(configureProviderHost(owner,{...body,provider:{...profile,sourceProviderId:'different-origin'},expectedRevision:1,mutationId:randomUUID()})).rejects.toThrow('immutable');
});
it('hydrates legacy Kimi from known preset facts and selected-model alias defaults',async()=> {
 const {owner}=await setup();await configureHost(owner,{providerId:'moonshot-coding',model:'k3',executionAuthorized:false,expectedRevision:0,mutationId:randomUUID()});
 const config=await owner.readConfig();const before=JSON.stringify(config);const profile=selectedHostProviderProfile({...config,providerApiKeys:{'moonshot-coding':'synthetic-legacy-key'}});
 expect(profile).toMatchObject({id:'moonshot-coding',sourceProviderId:'moonshot-coding',name:'Kimi Code',baseUrl:'https://api.kimi.com/coding/',apiProtocol:'anthropic',authType:'api_key',modelAliases:{fable:'k3',sonnet:'k3',opus:'k3',haiku:'k3'}});
 expect(JSON.stringify(profile)).not.toContain('synthetic-legacy-key');expect(JSON.stringify(config)).toBe(before);expect(legacyHostRepresentable(config)).toBe(true);
});
