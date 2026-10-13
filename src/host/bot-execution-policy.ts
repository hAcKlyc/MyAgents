/** An operator-provisioned, private opt-in. No cloud API creates or widens it. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { canonicalBytes, validateScope, type ExecutionScope } from '../../services/agentnet/execution-core/js/index.mjs';
import type { HostBotLocalPolicy } from './bot-management';
export interface BotExecutionPolicy {
  version: 1; host_id: string; scope: ExecutionScope; jwks: Record<string,unknown>;
  ipc_socket: string; network_uid: number; management_gid: number; roots: Record<string,string>;
  local_policy: HostBotLocalPolicy; model_bindings: Record<string,{provider_id:string;model:string}>;
}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function protectedBytes(path:string) {
  if(!isAbsolute(path)||resolve(path)!==path||await realpath(dirname(path))!==dirname(path)) throw new Error('BOT_LOCAL_POLICY_UNSAFE');
  const parent=await lstat(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.geteuid?.()||(parent.mode&0o777)!==0o700) throw new Error('BOT_LOCAL_POLICY_UNSAFE');
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.geteuid?.()||(s.mode&0o7777)!==0o600||s.size<1||s.size>256*1024)throw new Error('BOT_LOCAL_POLICY_UNSAFE');const bytes=await f.readFile();if(bytes.length!==s.size)throw new Error('BOT_LOCAL_POLICY_CHANGED');return bytes;}finally{await f.close();}
}
export async function loadBotExecutionPolicy(path:string,hostId:string) {
  // Missing opt-in is off, even when the legacy state path has a canonical
  // alias (e.g. Darwin /var). Existing authority still requires every pin.
  try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  const bytes=await protectedBytes(path);
  const digest=createHash('sha256').update(bytes).digest('hex');const raw:unknown=JSON.parse(bytes.toString('utf8'));
  if(!exact(raw,['version','host_id','scope','jwks','ipc_socket','network_uid','management_gid','roots','local_policy','model_bindings'])||raw.version!==1||raw.host_id!==hostId||
     typeof raw.ipc_socket!=='string'||!isAbsolute(raw.ipc_socket)||!Number.isSafeInteger(raw.network_uid)||(raw.network_uid as number)<=0||
     !Number.isSafeInteger(raw.management_gid)||(raw.management_gid as number)<=0 ||
     !exact(raw.local_policy,['host_id','owner_principal_id','scope','allowed_bot_ids','allowed_root_ids','allowed_runtimes','allowed_model_refs','allowed_operations','max_daily_tokens','expires_at'])||
     !raw.roots||typeof raw.roots!=='object'||Array.isArray(raw.roots)||!raw.model_bindings||typeof raw.model_bindings!=='object'||Array.isArray(raw.model_bindings)||
     !raw.jwks||typeof raw.jwks!=='object'||Array.isArray(raw.jwks))throw new Error('BOT_LOCAL_POLICY_INVALID');
  validateScope(raw.scope);validateScope(raw.local_policy.scope);
  const policy=raw as unknown as BotExecutionPolicy;
  if(policy.local_policy.host_id!==hostId||policy.local_policy.owner_principal_id!==policy.scope.host_owner_id||!canonicalBytes(policy.local_policy.scope).equals(canonicalBytes(policy.scope))) throw new Error('BOT_LOCAL_POLICY_INVALID');
  if(Object.keys(policy.model_bindings).length>128)throw new Error('BOT_LOCAL_POLICY_INVALID');
  for(const [id,binding] of Object.entries(policy.model_bindings)) {
    if(!uuid.test(id)||!policy.local_policy.allowed_model_refs.includes(id)||!exact(binding,['provider_id','model'])||
       typeof binding.provider_id!=='string'||!binding.provider_id.trim()||binding.provider_id.length>256||typeof binding.model!=='string'||!binding.model.trim()||binding.model.length>256)throw new Error('BOT_LOCAL_POLICY_INVALID');
  }
  return {policy:structuredClone(policy),authorityFingerprint:digest,async assertCurrent(){const actual=await protectedBytes(path);if(createHash('sha256').update(actual).digest('hex')!==digest)throw new Error('BOT_LOCAL_POLICY_CHANGED');}};
}
