import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalBytes } from '../../services/agentnet/execution-core/js/index.mjs';
import type { ImmutableBotSnapshot } from '../host/bot-runtime';
import type { HostSessionMessage, HostSessionRequest } from './host-session-protocol';
import { configureHost } from '../host/management';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function startBot(home: string, workspace: string, snapshot: ImmutableBotSnapshot, networkAttemptFile: string) {
  const generation=randomUUID(); const runGeneration=randomUUID();
  const bootstrap={version:1,snapshot,workspace,provider_id:'anthropic-sub',model:'claude-sonnet-4-6',run_generation:runGeneration};
  const encoded=Buffer.from(JSON.stringify(bootstrap)).toString('base64url');
  const noEgress=join(home,'no-egress.mjs');
  await writeFile(noEgress,`import fs from 'node:fs'; import net from 'node:net'; import http from 'node:http'; import https from 'node:https';
    import { syncBuiltinESMExports } from 'node:module';
    const deny=()=>{fs.appendFileSync(process.env.MYAGENTS_HOST_NETWORK_ATTEMPT_FILE,'attempt\\n');throw new Error('Integration worker network access is forbidden');};
    globalThis.fetch=deny; net.connect=deny; net.createConnection=deny; http.request=deny; http.get=deny; https.request=deny; https.get=deny;
    syncBuiltinESMExports();`);
  const child=fork(fileURLToPath(new URL('./host-session-worker.ts',import.meta.url)),[],{
    execArgv:['--import','tsx','--import',noEgress],
    env:{...process.env,HOME:home,USERPROFILE:home,MYAGENTS_HOST_GENERATION:generation,MYAGENTS_HOST_WORKSPACE:workspace,
      MYAGENTS_HOST_SESSION_ID:'',MYAGENTS_HOST_BOT_BOOTSTRAP:encoded,MYAGENTS_HOST_MODEL:'',MYAGENTS_HOST_PROVIDER_ID:'',
      MYAGENTS_HOST_EXECUTION_AUTHORIZED:'0',MYAGENTS_HOST_NETWORK_ATTEMPT_FILE:networkAttemptFile,
      ANTHROPIC_API_KEY:'',ANTHROPIC_AUTH_TOKEN:'',CLAUDE_CODE_OAUTH_TOKEN:'',MYAGENTS_MANAGEMENT_PORT:''},
    stdio:['ignore','pipe','pipe','ipc'],
  });
  children.push(child);
  const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  let diagnostics=''; child.stderr?.on('data',chunk=>{diagnostics+=String(chunk);});
  const inbox:HostSessionMessage[]=[]; const waiters=new Set<()=>void>();
  child.on('message',message=>{inbox.push(message as HostSessionMessage);for(const notify of waiters)notify();});
  function waitFor(predicate:(message:HostSessionMessage)=>boolean):Promise<HostSessionMessage>{
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(new Error(`Worker timeout: ${diagnostics}`));},30_000);
      const onExit=()=>{cleanup();reject(new Error(`Worker exited: ${diagnostics}`));};
      const poll=()=>{const index=inbox.findIndex(predicate);if(index>=0){const [message]=inbox.splice(index,1);cleanup();resolve(message);}};
      const cleanup=()=>{clearTimeout(timer);waiters.delete(poll);child.off('exit',onExit);};
      waiters.add(poll);child.on('exit',onExit);poll();
    });
  }
  const ready=await waitFor(message=>message.type==='ready') as Extract<HostSessionMessage,{type:'ready'}>;
  let sequence=0;
  async function request(operation:HostSessionRequest['operation'],args?:Record<string,unknown>){
    const id=String(++sequence);child.send({id,generation,operation,args});
    return await waitFor(message=>message.type==='reply'&&message.id===id) as Extract<HostSessionMessage,{type:'reply'}>;
  }
  return {ready,request,exit};
}

describe('Host Session worker Bot bootstrap integration',()=>{
  it('creates one exact Bot-local Session, denies invocation, and stops without network or inherited tools',async()=>{
    const home=await mkdtemp(join(tmpdir(),'myagents-host-bot-worker-'));roots.push(home);
    const workspace=join(home,'workspace');await mkdir(workspace);
    const configPath=join(home,'.myagents','config.json');await mkdir(join(home,'.myagents'));
    await configureHost({hostId:randomUUID(),defaultWorkspace:workspace,readConfig:async()=>({}),
      writeConfig:async value=>{await writeFile(configPath,JSON.stringify(value),{mode:0o600});},
      workspacePath:async value=>value,busy:()=>false},
    {mutationId:randomUUID(),expectedRevision:0,providerId:'moonshot-coding',model:'k3',executionAuthorized:false});
    const networkAttemptFile=join(home,'unexpected-network-attempt');
    const payload={bot_id:'30000000-0000-4000-8000-000000000099',agent_id:'agent-fixture-99',binding_generation:7,revision:23,
      runtime:'builtin' as const,config:{name:'worker integration Bot',description:'isolated lifecycle test',runtime:'builtin' as const,
        model_ref:'60000000-0000-4000-8000-000000000099',system_prompt:'Never invoke a model in this test.',daily_tokens:100}};
    const snapshot:ImmutableBotSnapshot={...payload,snapshot_hash:createHash('sha256').update(canonicalBytes(payload)).digest('hex')};
    const worker=await startBot(home,workspace,snapshot,networkAttemptFile);
    const expected={bot_id:snapshot.bot_id,agent_id:snapshot.agent_id,binding_generation:snapshot.binding_generation,
      run_generation:expect.any(String),session_id:expect.any(String),snapshot_hash:snapshot.snapshot_hash,runtime:'builtin'};
    expect(worker.ready.bot).toMatchObject(expected);
    expect(worker.ready.sessionId).toBe(worker.ready.bot?.session_id);
    expect(worker.ready.bot?.run_generation).toMatch(/^[0-9a-f-]{36}$/);

    const description=await worker.request('describe');
    expect(description).toMatchObject({ok:true,data:{executionAuthorized:false,runtime:'builtin',
      config:{mcpServerIds:[],enabledOfficialToolIds:[]}}});
    const metadata=JSON.parse(await readFile(join(home,'.myagents','sessions.json'),'utf8')) as Array<Record<string,unknown>>;
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({id:worker.ready.sessionId,mcpEnabledServers:[],enabledPluginIds:[],enabledOfficialToolIds:[]});

    expect(await worker.request('send',{text:'This must never reach a model'})).toMatchObject({ok:false,
      error:'Delegated Bot v1 supports lifecycle only; model invocation is not authorized'});
    expect(await worker.request('stop')).toMatchObject({ok:true});
    expect(await worker.request('shutdown')).toMatchObject({ok:true});
    await expect(worker.exit).resolves.toEqual({code:0,signal:null});
    await expect(readFile(networkAttemptFile,'utf8')).rejects.toMatchObject({code:'ENOENT'});
  });
});
