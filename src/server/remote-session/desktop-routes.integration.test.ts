import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {build} from 'esbuild';
import {afterEach,expect,it} from 'vitest';
let dir:string|undefined;const children:ChildProcess[]=[];
afterEach(async()=>{
  for(const child of children.splice(0))if(child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done}
  if(dir)await rm(dir,{recursive:true,force:true});dir=undefined;
});
async function freePort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();const port=typeof address==='object'&&address?address.port:0;await new Promise<void>(done=>server.close(()=>done()));return port}
it('serves real authenticated Global routes, freezes hidden birth and keeps private Bot sessions excluded without creating a worker',async()=>{
  dir=await mkdtemp(join(tmpdir(),'remote-desktop-routes-'));const state=join(dir,'.moxbot-updaterqa'),workspace=join(dir,'work');
  await mkdir(state,{mode:0o700});await mkdir(workspace,{mode:0o700});
  const agent={id:'agent-route',name:'Route Agent',enabled:true,projectId:'project-route',workspacePath:workspace,agentDir:workspace,runtime:'builtin',permissionMode:'plan',model:'frozen-model'};
  await writeFile(join(state,'config.json'),JSON.stringify({agents:[agent],providers:[],mcpServers:[],defaultIntegratedRuntime:'claude-agent-sdk'}));
  await writeFile(join(state,'projects.json'),JSON.stringify([{id:'project-route',name:'Route Project',path:workspace,agentId:agent.id}]));
  const time=new Date().toISOString();
  await writeFile(join(state,'sessions.json'),JSON.stringify([{id:'private-bot',agentDir:workspace,title:'Private',createdAt:time,lastActiveAt:time,hostBotBinding:{botId:'bot',runGeneration:'run'}},{id:'visible',agentDir:workspace,title:'Existing',createdAt:time,lastActiveAt:time,runtime:'builtin'}]));
  const entry=join(dir,'server.mjs');
  await symlink(resolve('node_modules'),join(dir,'node_modules'));
  await build({entryPoints:[resolve('src/server/index.ts')],outfile:entry,bundle:true,platform:'node',target:'node24',format:'esm',logLevel:'silent',define:{__MYAGENTS_BUILD_PROFILE__:'"moxbot-updaterqa"',__MYAGENTS_UPDATER_QA__:'true'},external:['@playwright/mcp','@playwright/mcp/*','playwright','playwright/*','playwright-core','playwright-core/*','fsevents','chromium-bidi/*'],banner:{js:'import {createRequire as __remoteRequire} from "node:module";const require=__remoteRequire(import.meta.url);'}});
  const token=randomUUID(),port=await freePort();
  const env={...process.env,HOME:dir,USERPROFILE:dir,MYAGENTS_SIDECAR_GENERATION:'4242',MYAGENTS_INTERNAL_CLI_TOKEN:token};
  for(const key of Object.keys(env))if(/API_KEY|AUTH_TOKEN|ACCESS_TOKEN/.test(key))delete env[key as keyof typeof env];
  const child=spawn(process.execPath,[entry,'--sidecar-role','global','--agent-dir',workspace,'--port',String(port),'--no-pre-warm'],{env,stdio:['ignore','pipe','pipe']});children.push(child);
  let diagnostics='';child.stdout?.on('data',data=>{diagnostics=(diagnostics+String(data)).slice(-4000)});child.stderr?.on('data',data=>{diagnostics=(diagnostics+String(data)).slice(-4000)});
  const base=`http://127.0.0.1:${port}`;
  await expect.poll(async()=>{
    if(child.exitCode!==null)throw new Error(`Global fixture exited ${child.exitCode}; ${diagnostics}`);
    try{return (await fetch(base+'/health/ready')).status}catch{return 0}
  },{timeout:30_000,interval:100}).toBe(200);
  const post=async(path:string,body:unknown,auth=true)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(auth?{'x-myagents-internal-cli-token':token}:{})},body:JSON.stringify(body)});
  const list={request:{kind:'list',agentId:agent.id,limit:30},generation:'4242'};
  expect((await post('/api/remote-session',list,false)).status).toBe(401);
  expect(await (await post('/api/remote-session',list)).json()).toMatchObject({success:true,data:{kind:'list',items:[{sessionId:'visible'}]}});
  expect(await (await post('/api/remote-session',{request:{kind:'get',agentId:agent.id,sessionId:'private-bot',limit:30},generation:'4242'})).json()).toMatchObject({success:false,code:'REMOTE_SESSION_NOT_FOUND'});
  const request={kind:'start',agentId:agent.id,operationId:randomUUID(),text:'frozen birth'};
  const prepared=await (await post('/api/remote-session/prepare',{request})).json() as {success:boolean;data:{sessionId:string}};
  expect(prepared.success).toBe(true);
  const sessions=JSON.parse(await readFile(join(state,'sessions.json'),'utf8'));
  expect(sessions.find((s:{id:string})=>s.id===prepared.data.sessionId)).toMatchObject({runtime:'builtin',model:'frozen-model',permissionMode:'plan',materializationState:'prepared',materializationSourceSessionId:request.operationId});
  expect(await (await post('/api/remote-session/prepare',{request})).json()).toMatchObject({success:true,data:{receipt:{status:'processing',sessionId:prepared.data.sessionId}}});
  expect(await (await post('/api/remote-session',list)).json()).toMatchObject({data:{items:[{sessionId:'visible'}]}});
  expect(await (await post('/api/remote-session',{request:{kind:'send',agentId:agent.id,sessionId:'visible',operationId:randomUUID(),text:'no Global execution'},generation:'4242'})).json()).toMatchObject({success:false,code:'REMOTE_SESSION_OWNER_REQUIRED'});
  const lifecycleToken=randomUUID();
  const quiesce=async(action:string)=>fetch(base+'/api/process/update-quiesce',{method:'POST',headers:{'content-type':'application/json','x-myagents-internal-cli-token':token,'x-myagents-sidecar-generation':'4242'},body:JSON.stringify({action,token:lifecycleToken})});
  expect(await (await quiesce('freeze')).json()).toEqual({success:true});
  const beforeFrozenWrite=await readFile(join(state,'sessions.json'),'utf8');
  const blocked={kind:'start',agentId:agent.id,operationId:randomUUID(),text:'must not write while updating'};
  expect(await (await post('/api/remote-session/prepare',{request:blocked})).json()).toMatchObject({success:false,code:'REMOTE_SESSION_OPERATION_UNCONFIRMED'});
  expect(await readFile(join(state,'sessions.json'),'utf8')).toBe(beforeFrozenWrite);
  expect(await (await quiesce('release')).json()).toEqual({success:true});
  expect(await (await post('/api/remote-session/prepare',{request:blocked})).json()).toMatchObject({success:true,data:{agentId:agent.id}});
  const unauthorized = await fetch(base+'/api/process/update-quiesce', {method:'POST',headers:{'content-type':'application/json','x-myagents-sidecar-generation':'4242'},body:JSON.stringify({action:'interrupt-and-freeze',token:lifecycleToken})});
  expect(unauthorized.status).toBe(401);
  expect(await (await quiesce('interrupt-and-freeze')).json()).toEqual({success:true});
  expect(await (await quiesce('release')).json()).toEqual({success:true});


},60_000);
