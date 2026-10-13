/** Private reverse IPC. The Rust network UID owns the listener and authenticates Node's UID. */
import { createConnection, type Socket } from 'node:net';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { canonicalBytes, validateHostContext, validateScope, type ExecutionScope, type HostContext } from '../../services/agentnet/execution-core/js/index.mjs';
import { randomUUID } from 'node:crypto';
import type { createHostBotManager } from './bot-management';
const NS='moxbot.bot.execution.ipc/v1';
const MAX=1024*1024;
type Manager=ReturnType<typeof createHostBotManager>;
export interface BotExecutionIpcOptions {
  socket: string; networkUid: number; managementGid: number; scope: ExecutionScope;
  assertAuthority(): Promise<void>;
  manager(context:()=>HostContext|undefined): Manager;
}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v) &&
  Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const same=(a:unknown,b:unknown)=>canonicalBytes(a).equals(canonicalBytes(b));
export async function connectBotExecutionIpc(options: BotExecutionIpcOptions) {
  validateScope(options.scope);
  if(!isAbsolute(options.socket)||resolve(options.socket)!==options.socket || !Number.isSafeInteger(options.networkUid) ||
     options.networkUid<=0 || options.networkUid===process.geteuid?.() || !Number.isSafeInteger(options.managementGid)||options.managementGid<=0) throw new Error('BOT_IPC_CONFIG_INVALID');
  let socket:Socket|undefined; let closed=false; let current:HostContext|undefined; let currentUntil=0;
  let manager:Manager|undefined; let tail=Promise.resolve(); let reconnect:NodeJS.Timeout|undefined;
  const context=()=>current && Date.now()<currentUntil ? structuredClone(current) : undefined;
  const clear=()=>{current=undefined;currentUntil=0;};
  async function validateSocket() {
    const parent=dirname(options.socket);
    if(await realpath(parent)!==parent) throw new Error('BOT_IPC_PATH_INVALID');
    let path=parent;
    while(true){const st=await lstat(path);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o022)!==0||![0,options.networkUid].includes(st.uid)) throw new Error('BOT_IPC_PATH_INVALID');const next=dirname(path);if(next===path)break;path=next;}
    const p=await lstat(parent); const st=await lstat(options.socket);
    if(p.uid!==options.networkUid||p.gid!==options.managementGid||(p.mode&0o777)!==0o750 ||
       !st.isSocket()||st.isSymbolicLink()||st.uid!==options.networkUid||st.gid!==options.managementGid||st.nlink!==1||(st.mode&0o777)!==0o660) throw new Error('BOT_IPC_PATH_INVALID');
    return {dev:st.dev,ino:st.ino};
  }
  async function handle(raw:unknown):Promise<Record<string,unknown>> {
    if(!exact(raw,['namespace','version','request_id','payload'])||raw.namespace!==NS||raw.version!==1||
       typeof raw.request_id!=='string'||!/^[0-9a-f-]{36}$/.test(raw.request_id)||!raw.payload||typeof raw.payload!=='object') throw new Error('BOT_IPC_FRAME_INVALID');
    try {await options.assertAuthority();} catch {clear();throw new Error("BOT_LOCAL_POLICY_CHANGED");}
    const p=raw.payload as Record<string,unknown>; let result:unknown;
    if(p.method==='context') {
      if(!exact(p,['method','scope','host_context'])) throw new Error('BOT_IPC_FRAME_INVALID');
      validateScope(p.scope);if(!same(p.scope,options.scope)||!exact(p.host_context,['local_auth_generation','boot_epoch','connection_epoch','membership_revision'])) throw new Error('BOT_IPC_SCOPE_MISMATCH');
      const proposed={...p.host_context,challenge_nonce:randomUUID()} as unknown as HostContext;validateHostContext(proposed);
      clear();current=Object.freeze(proposed);currentUntil=Date.now()+30_000;
      manager ??= options.manager(context);
      result={method:'challenge',host_context:context()};
    }else if(p.method==='invalidate') {
      if(!exact(p,['method','reason'])||!['connection_closed','account_changed','membership_changed','lease_expired'].includes(String(p.reason))) throw new Error('BOT_IPC_FRAME_INVALID');
      clear();result={method:'invalidated'};
    }else {
      if(!context()||!manager) throw new Error('HOST_EXECUTION_NOT_CONNECTED');
      if(p.method==='status'&&exact(p,['method'])) {
        result={method:'status',observation:await manager.status()};
      }else if(p.method==='pending_receipts'&&exact(p,['method'])) {
        result={method:'pending_receipts',receipts:await manager.pendingReceipts()};
      }else if(p.method==='ack_receipt'&&exact(p,['method','lease_id','mutation_id','request_hash'])&&
          typeof p.lease_id==='string'&&typeof p.mutation_id==='string'&&typeof p.request_hash==='string') {
        const ack=await manager.ackReceipt(p.lease_id,p.mutation_id,p.request_hash);
        result={method:'receipt_ack',lease_id:ack.lease_id};
      }else if(p.method==='grant'&&exact(p,['method','token'])&&typeof p.token==='string') {
        const grant=await manager.acceptGrant(p.token);result={method:'grant',grant_id:grant.id,generation:grant.generation};
      }else if(p.method==='execute'&&exact(p,['method','intent_token','lease_token'])&&typeof p.intent_token==='string'&&typeof p.lease_token==='string') {
        result={method:'receipt',receipt:await manager.mutate(p.intent_token,p.lease_token)};
      }else if(p.method==='revoke'&&exact(p,['method','revocation_token','grant_id','bot_id','revoked_generation'])&&typeof p.revocation_token==='string'&&typeof p.grant_id==='string'&&typeof p.bot_id==='string'&&typeof p.revoked_generation==='number') {
        result={method:'snapshot',snapshot:await manager.revoke(p.revocation_token,{grant_id:p.grant_id,bot_id:p.bot_id,revoked_generation:p.revoked_generation})};
      }else throw new Error('BOT_IPC_FRAME_INVALID');
    }
    return {namespace:NS,version:1,request_id:raw.request_id,payload:result};
  }
  async function connect() {
    if(closed)return;
    try {
      const pin=await validateSocket();const selected=createConnection(options.socket);socket=selected;
      let bytes=Buffer.alloc(0);let pending=0;
      selected.on('connect',()=>{void validateSocket().then(now=>{if(now.dev!==pin.dev||now.ino!==pin.ino)selected.destroy();}).catch(()=>{selected.destroy();});});
      selected.on('data',data=>{
        if(bytes.length+data.length>MAX+4){selected.destroy();return;}
        bytes=Buffer.concat([bytes,data]);
        while(bytes.length>=4){const size=bytes.readUInt32BE(0);if(size<2||size>MAX){selected.destroy();return;}if(bytes.length<size+4)break;
          const frame=bytes.subarray(4,4+size);bytes=bytes.subarray(4+size);if(++pending>1){selected.destroy();return;}
          tail=tail.then(async()=>{
            if(closed||selected!==socket||selected.destroyed){pending--;return;}
            let raw:unknown;let response:unknown;
            try{raw=JSON.parse(frame.toString('utf8'));response=await handle(raw);}catch(error){
              const id=(raw as {request_id?:unknown}|undefined)?.request_id;
              if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id)){selected.destroy();pending--;return;}
              const code=error instanceof Error&&/^[A-Z_]{1,80}$/.test(error.message)?error.message:'BOT_IPC_REQUEST_REJECTED';
              response={namespace:NS,version:1,request_id:id,payload:{method:'error',code}};
            }
            pending--;if(selected.destroyed||closed)return;
            const body=Buffer.from(JSON.stringify(response));if(body.length>MAX-4){selected.destroy();return;}const head=Buffer.alloc(4);head.writeUInt32BE(body.length);selected.write(Buffer.concat([head,body]));
          }).catch(()=>{selected.destroy();});
        }
      });
      selected.on('error',()=>{});
      selected.on('close',()=>{if(socket===selected){socket=undefined;clear();}if(!closed){reconnect=setTimeout(()=>void connect(),2000);reconnect.unref();}});
    }catch{clear();if(!closed){reconnect=setTimeout(()=>void connect(),2000);reconnect.unref();}}
  }
  void connect();
  return {async close(){closed=true;clear();if(reconnect)clearTimeout(reconnect);socket?.destroy();await tail;}};
}
