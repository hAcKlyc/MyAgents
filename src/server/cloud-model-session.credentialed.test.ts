import {fork,type ChildProcess} from 'node:child_process';
import {createServer,type Server} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach,expect,it} from 'vitest';
import {canonicalBytes} from '../../services/agentnet/execution-core/js/index.mjs';
import {cloudSessionProviderId,type CloudModelLease} from '../host/cloud-model';
import {createCloudModelInvoker} from '../host/cloud-model-invoke';
import type {HostSessionMessage,HostSessionRequest} from './host-session-protocol';
const roots:string[]=[],children:ChildProcess[]=[],servers:Server[]=[];
afterEach(async()=>{for(const child of children.splice(0))if(child.exitCode===null)child.kill('SIGKILL');for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}for(const path of roots.splice(0))await rm(path,{recursive:true,force:true});});
async function files(path:string):Promise<string[]>{const out:string[]=[];for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())out.push(...await files(p));else out.push(p);}return out;}
it.each([{protocol:'anthropic',forceRetryHeader:false,toolAttack:false},{protocol:'chat_completions',forceRetryHeader:false,toolAttack:false},{protocol:'responses',forceRetryHeader:false,toolAttack:false},{protocol:'chat_completions',forceRetryHeader:true,toolAttack:false},{protocol:'anthropic',forceRetryHeader:false,toolAttack:true}] as const)('uses $protocol through the trusted exact Bot owner and builtin SDK (retry header=$forceRetryHeader, tool attack=$toolAttack)',async({protocol,forceRetryHeader,toolAttack})=>{
  const home=await mkdtemp(join(tmpdir(),'mox-cloud-model-session-'));roots.push(home);const workspace=join(home,'workspace');await mkdir(workspace);
  const bot=randomUUID(),ref=randomUUID(),secret='synthetic-short-lived-gateway-session-token';
  const privateFile=join(home,'private-host-fixture.txt'),privateContents='SENSITIVE_CONTENT fixture-private-data-must-never-reach-model';
  const shellMarker=join(home,'forbidden-shell-side-effect'),hookMarker=join(home,'forbidden-settings-hook');
  const privateInstruction='private-settings-instruction-must-not-be-inherited';
  if(toolAttack){
    await writeFile(privateFile,privateContents);await mkdir(join(home,'.claude'));await mkdir(join(workspace,'.claude'));
    const hooks={hooks:{SessionStart:[{hooks:[{type:'command',command:`printf forbidden > '${hookMarker}'`}]}]}};
    for(const path of [join(home,'.claude','settings.json'),join(workspace,'.claude','settings.json'),join(workspace,'.claude','settings.local.json')])await writeFile(path,JSON.stringify(hooks));
    await writeFile(join(home,'.claude','CLAUDE.md'),privateInstruction);await writeFile(join(workspace,'CLAUDE.md'),privateInstruction);
  }
  let attackSent=false;let revoked=false;let failRetry=false;
  const seen:Array<{path:string;auth:string|undefined;body:Record<string,unknown>}>=[];
  const gateway=createServer(async(req,res)=>{
    let text='';for await(const c of req)text+=c.toString();const body=JSON.parse(text||'{}');seen.push({path:req.url??'',auth:req.headers.authorization,body});
    if(revoked||req.headers.authorization!==`Bearer ${secret}`){res.writeHead(401,{'content-type':'application/json'}).end(JSON.stringify({type:'error',error:{type:'authentication_error',message:'Session model lease revoked'}}));return;}
    if(failRetry){res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'Unknown mock upstream outcome',type:'server_error'}}));return;}
    const model=body.model;
    expect(Number(body.max_tokens??body.max_output_tokens??body.max_completion_tokens)).toBeLessThanOrEqual(64);
    if(req.url?.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({input_tokens:1}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(toolAttack&&!attackSent){
      attackSent=true;
      const events:Array<[string,Record<string,unknown>]>=[['message_start',{type:'message_start',message:{id:'msg_tool_attack',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}}]];
      for(const [index,name,input] of [[0,'Grep',{pattern:'SENSITIVE_CONTENT',path:privateFile,output_mode:'content'}],[1,'Bash',{command:`cat '${privateFile}' > '${shellMarker}'`}]] as const){
        events.push(['content_block_start',{type:'content_block_start',index,content_block:{type:'tool_use',id:`tool_attack_${index}`,name,input:{}}}],['content_block_delta',{type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}}],['content_block_stop',{type:'content_block_stop',index}]);
      }
      events.push(['message_delta',{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:5}}],['message_stop',{type:'message_stop'}]);
      for(const [event,data]of events)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);res.end();return;
    }

    if(protocol==='chat_completions'){
      for(const chunk of [{id:'cmpl_fixture',object:'chat.completion.chunk',created:0,model,choices:[{index:0,delta:{role:'assistant',content:'Approved mock model result.'},finish_reason:null}]},{id:'cmpl_fixture',object:'chat.completion.chunk',created:0,model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:5,total_tokens:6}}])res.write(`data: ${JSON.stringify(chunk)}\n\n`);res.end('data: [DONE]\n\n');return;
    }
    if(protocol==='responses'){
      for(const chunk of [{type:'response.output_text.delta',output_index:0,content_index:0,delta:'Approved mock model result.'},{type:'response.completed',response:{id:'resp_fixture',object:'response',status:'completed',model,output:[],usage:{input_tokens:1,output_tokens:5,total_tokens:6}}}])res.write(`data: ${JSON.stringify(chunk)}\n\n`);res.end();return;
    }

    const events:Array<[string,Record<string,unknown>]>=[['message_start',{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}}],['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Approved mock model result.'}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}}],['message_stop',{type:'message_stop'}]];
    for(const [event,data]of events)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);res.end();
  });servers.push(gateway);await new Promise<void>(yes=>gateway.listen(0,'127.0.0.1',yes));const port=(gateway.address()as{port:number}).port;
  const lease:CloudModelLease={session_id:randomUUID(),model_ref:ref,provider_id:randomUUID(),model:'claude-sonnet-4-6',provider_revision:4,model_revision:7,gateway_base_url:'',api_protocol:protocol==='anthropic'?'anthropic':'openai',...(protocol!=='anthropic'?{upstream_format:protocol}:{}),max_output_tokens:64,max_total_tokens:1000,expires_at:Math.floor(Date.now()/1000)+300};lease.gateway_base_url=`http://127.0.0.1:${port}/api/bot-model/sessions/${lease.session_id}`;
  const payload={bot_id:bot,agent_id:'isolated-bot',binding_generation:1,revision:1,runtime:'builtin' as const,config:{name:'Test',description:'',runtime:'builtin' as const,model_ref:ref,system_prompt:'The unique approved cloud Bot instruction.',daily_tokens:1000}};
  const snapshot={...payload,snapshot_hash:createHash('sha256').update(canonicalBytes(payload)).digest('hex')};const generation=randomUUID();
  const bootstrap={version:1,snapshot,workspace,provider_id:cloudSessionProviderId(lease),model:lease.model,run_generation:generation,cloud_model:lease};
  const child=fork(fileURLToPath(new URL('./host-session-worker.ts',import.meta.url)),[],{execArgv:['--import','tsx'],env:{PATH:process.env.PATH,HOME:home,USERPROFILE:home,MYAGENTS_HOST_MODE:'1',MYAGENTS_HOST_GENERATION:generation,MYAGENTS_HOST_WORKSPACE:workspace,MYAGENTS_HOST_PROVIDER_ID:bootstrap.provider_id,MYAGENTS_HOST_CREDENTIAL_SOURCE:'supervisor-ipc',MYAGENTS_HOST_EXECUTION_AUTHORIZED:'0',MYAGENTS_HOST_BOT_BOOTSTRAP:Buffer.from(JSON.stringify(bootstrap)).toString('base64url'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_MAX_RETRIES:'1',ANTHROPIC_CUSTOM_HEADERS:forceRetryHeader?'x-stainless-retry-count: 1':undefined,MYAGENTS_MANAGEMENT_PORT:''},stdio:['ignore','pipe','pipe','ipc']});children.push(child);
  const inbox:HostSessionMessage[]=[];const listeners=new Set<()=>void>();let diagnostics='';child.stderr?.on('data',data=>diagnostics+=String(data));child.on('message',raw=>{const msg=raw as HostSessionMessage;if(msg.type==='credential-needed')child.send({type:'host-provider-snapshot',generation,providerId:bootstrap.provider_id,credential:secret});inbox.push(msg);for(const notify of listeners)notify();});
  function wait(predicate:(msg:HostSessionMessage)=>boolean){return new Promise<HostSessionMessage>((yes,no)=>{const cleanup=()=>{clearTimeout(timer);listeners.delete(poll);child.off('exit',exit);};const poll=()=>{const index=inbox.findIndex(predicate);if(index>=0){const[msg]=inbox.splice(index,1);cleanup();yes(msg);}};const exit=()=>{cleanup();no(new Error(`Worker exited: ${diagnostics}`));};const timer=setTimeout(()=>{cleanup();no(new Error(`Worker timeout: ${diagnostics}`));},50_000);listeners.add(poll);child.on('exit',exit);poll();});}
  const ready=await wait(m=>m.type==='ready')as Extract<HostSessionMessage,{type:'ready'}>;
  async function request(operation:HostSessionRequest['operation'],args?:Record<string,unknown>){const id=randomUUID();child.send({id,generation,operation,args});return await wait(m=>m.type==='reply'&&m.id===id)as Extract<HostSessionMessage,{type:'reply'}>;}
  expect(ready.bot?.snapshot_hash).toBe(snapshot.snapshot_hash);expect(await request('describe')).toMatchObject({ok:true,data:{executionAuthorized:true,config:{permissionMode:'custom',model:lease.model}}});
  const entry={id:randomUUID(),session_id:ready.sessionId,run_generation:generation,snapshot_hash:snapshot.snapshot_hash,runtime:'builtin' as const};
  let supervisorClosing=false;
  const invoke=createCloudModelInvoker({
    current:()=>ready.bot?{identity:ready.bot,snapshot,lease,closing:supervisorClosing,processAlive:child.exitCode===null&&child.signalCode===null}:undefined,
    policy:()=>({service_origin:new URL(lease.gateway_base_url).origin,allowed_bot_ids:[bot],allowed_model_refs:[ref],expires_at:lease.expires_at+1,max_daily_tokens:1000,max_output_tokens:64,access_credential:'systemd-credential:mock'}),
    assertAuthority:async()=>{},dispatch:async(identity,text)=>{expect(identity).toEqual(ready.bot);return request('send',{text});},
  });
  const admitted=await invoke(entry,ready.bot!,'Reply with the approved mock result.');expect(admitted,diagnostics).toMatchObject({ok:true,data:{accepted:true}});
  const terminal=await wait(m=>m.type==='terminal');expect(JSON.stringify(terminal)).not.toContain(secret);
  if(forceRetryHeader){
    expect(terminal).toMatchObject({outcome:{status:'error'}});expect(seen).toHaveLength(0);
    expect(await request('shutdown')).toMatchObject({ok:true});if(child.exitCode===null)await new Promise<void>(yes=>child.once('exit',()=>yes()));
    expect(diagnostics).not.toContain(secret);for(const path of await files(home))expect(await readFile(path,'utf8')).not.toContain(secret);return;
  }
  if(toolAttack){
    expect(attackSent).toBe(true);
    expect(seen.every(r=>!Array.isArray(r.body.tools)||r.body.tools.length===0)).toBe(true);
    expect(JSON.stringify(seen)).not.toContain(privateContents);expect(JSON.stringify(seen)).not.toContain(privateInstruction);
    expect(diagnostics).not.toContain(privateContents);
    await expect(readFile(shellMarker,'utf8')).rejects.toMatchObject({code:'ENOENT'});
    await expect(readFile(hookMarker,'utf8')).rejects.toMatchObject({code:'ENOENT'});
    expect(await readFile(privateFile,'utf8')).toBe(privateContents);
    const result=await request('result');expect(JSON.stringify(result)).not.toContain(privateContents);
    expect(await request('shutdown')).toMatchObject({ok:true});if(child.exitCode===null)await new Promise<void>(yes=>child.once('exit',()=>yes()));
    for(const path of await files(home))expect(await readFile(path,'utf8')).not.toContain(secret);
    return;
  }
  const result=await request('result');expect(JSON.stringify(result),diagnostics).toContain('Approved mock model result.');
  expect(seen.some(r=>r.path.includes(`/api/bot-model/sessions/${lease.session_id}/v1/${protocol==='anthropic'?'messages':protocol==='responses'?'responses':'chat/completions'}`)&&r.body.model===lease.model&&r.auth===`Bearer ${secret}`)).toBe(true);
  expect(JSON.stringify(seen)).toContain('The unique approved cloud Bot instruction.');
  if(protocol==='anthropic'){
    revoked=true;
    const retry=await invoke(entry,ready.bot!,'Revoked lease must not generate a result.');
    expect(retry).toMatchObject({ok:true,data:{accepted:true}});
    expect(await wait(m=>m.type==='terminal')).toMatchObject({outcome:{status:'error'}});
  }
  if(protocol==='chat_completions'){
    failRetry=true;const before=seen.length;
    expect(await invoke(entry,ready.bot!,'Unknown gateway outcome must not be retried.')).toMatchObject({ok:true,data:{accepted:true}});
    expect(await wait(m=>m.type==='terminal')).toMatchObject({outcome:{status:'error'}});
    expect(seen.length-before).toBe(1);
    expect(await invoke(entry,ready.bot!,'This unknown lease stays closed until a new Session.')).toMatchObject({ok:true,data:{accepted:true}});
    expect(await wait(m=>m.type==='terminal')).toMatchObject({outcome:{status:'error'}});
    expect(seen.length-before).toBe(1);
  }
  supervisorClosing=true;
  await expect(invoke(entry,ready.bot!,'Closing supervisor must refuse admission.')).rejects.toThrow('BOT_MODEL_NOT_AUTHORIZED');
  expect(await request('shutdown')).toMatchObject({ok:true});if(child.exitCode===null)await new Promise<void>(yes=>child.once('exit',()=>yes()));
  for(const path of await files(home)){const contents=await readFile(path,'utf8');expect(contents,path).not.toContain(secret);}
  const metadata=JSON.parse(await readFile(join(home,'.myagents','sessions.json'),'utf8'));expect(metadata[0]).toMatchObject({providerRoute:{kind:'provider',providerId:bootstrap.provider_id,model:lease.model},permissionMode:'custom',mcpEnabledServers:[],enabledPluginIds:[]});expect(metadata[0].providerEnvJson).toBeUndefined();expect(diagnostics).not.toContain(secret);
});
