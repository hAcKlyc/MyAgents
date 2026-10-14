/** Finite, operator-owned model authority. Lifecycle grants never imply this permission. */
export interface CloudModelPolicy {
  service_origin: string;
  allowed_bot_ids: string[];
  allowed_model_refs: string[];
  expires_at: number;
  max_daily_tokens: number;
  max_output_tokens: number;
  access_credential: string;
}
export interface CloudModelLease {
  session_id: string;
  model_ref: string;
  provider_id: string;
  model: string;
  provider_revision: number;
  model_revision: number;
  gateway_base_url: string;
  api_protocol: 'anthropic' | 'openai';
  upstream_format?: 'chat_completions' | 'responses';
  max_output_tokens: number;
  max_output_tokens_param_name?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  max_total_tokens: number;
  expires_at: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const bounded = (value: unknown, limit = 256): value is string => typeof value === 'string' && value.trim() === value && !!value && Buffer.byteLength(value) <= limit && [...value].every(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)!==127);
export const cloudSessionProviderId = (lease: Pick<CloudModelLease, 'session_id'>) => `cloud-session:${lease.session_id}`;
export const isCloudSessionProviderId = (id: string) => id.startsWith('cloud-session:');
/** Unknown SDK retry outcomes must not cause a second chargeable bridge request. */
export function rejectCloudModelRetry(providerId: string, retryCount: string | string[] | undefined): boolean {
  return isCloudSessionProviderId(providerId) && retryCount !== undefined &&
    (typeof retryCount !== 'string' || !/^0$/.test(retryCount));
}
export function validateCloudModelPolicy(raw: unknown, parent: {allowed_bot_ids: string[]; allowed_model_refs: string[]; expires_at: number; max_daily_tokens: number}): asserts raw is CloudModelPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('BOT_MODEL_POLICY_INVALID');
  const p = raw as CloudModelPolicy;
  const fields = ['service_origin','allowed_bot_ids','allowed_model_refs','expires_at','max_daily_tokens','max_output_tokens','access_credential'];
  if (Object.keys(p).length !== fields.length || fields.some(k => !Object.hasOwn(p,k))) throw new Error('BOT_MODEL_POLICY_INVALID');
  let url: URL; try { url = new URL(p.service_origin); } catch { throw new Error('BOT_MODEL_POLICY_INVALID'); }
  if (url.protocol !== 'https:' || url.origin !== p.service_origin || url.username || url.password ||
    !positive(p.expires_at) || p.expires_at > parent.expires_at || !positive(p.max_daily_tokens) || p.max_daily_tokens > parent.max_daily_tokens ||
    !positive(p.max_output_tokens) || p.max_output_tokens > p.max_daily_tokens ||
    typeof p.access_credential !== 'string' || !/^systemd-credential:[A-Za-z0-9_-]{1,64}$/.test(p.access_credential)) throw new Error('BOT_MODEL_POLICY_INVALID');
  for (const [ids, allowed] of [[p.allowed_bot_ids,parent.allowed_bot_ids],[p.allowed_model_refs,parent.allowed_model_refs]]) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 128 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !uuid.test(id) || !allowed.includes(id))) throw new Error('BOT_MODEL_POLICY_INVALID');
  }
}
export function assertCloudModelAdmission(policy: CloudModelPolicy | undefined, botId: string, modelRef: string, dailyTokens: number, now = Date.now()/1000): CloudModelPolicy {
  if (!policy || now >= policy.expires_at || !policy.allowed_bot_ids.includes(botId) || !policy.allowed_model_refs.includes(modelRef) || !positive(dailyTokens) || dailyTokens > policy.max_daily_tokens) throw new Error('BOT_MODEL_NOT_AUTHORIZED');
  return policy;
}
export function parseCloudModelLease(raw: unknown, origin: string): CloudModelLease {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('BOT_MODEL_LEASE_INVALID');
  const l = raw as CloudModelLease;
  const fields = ['session_id','model_ref','provider_id','model','provider_revision','model_revision','gateway_base_url','api_protocol','max_output_tokens','max_total_tokens','expires_at'];
  if (fields.some(k => !Object.hasOwn(l,k)) || Object.keys(l).some(k => !fields.includes(k) && k !== 'upstream_format' && k !== 'max_output_tokens_param_name') ||
    !uuid.test(l.session_id) || !uuid.test(l.model_ref) || !bounded(l.provider_id) || !bounded(l.model) || !positive(l.provider_revision) || !positive(l.model_revision) ||
    !positive(l.max_output_tokens) || !positive(l.max_total_tokens) || l.max_output_tokens > l.max_total_tokens || !positive(l.expires_at) ||
    (l.max_output_tokens_param_name !== undefined && !['max_tokens','max_completion_tokens','max_output_tokens'].includes(l.max_output_tokens_param_name)) ||
    !['anthropic','openai'].includes(l.api_protocol) || (l.api_protocol === 'openai' && !['chat_completions','responses'].includes(l.upstream_format ?? '')) ||
    (l.api_protocol === 'anthropic' && (l.upstream_format !== undefined || (l.max_output_tokens_param_name !== undefined && l.max_output_tokens_param_name !== 'max_tokens'))) ||
    (l.upstream_format === 'responses' && l.max_output_tokens_param_name !== undefined && l.max_output_tokens_param_name !== 'max_output_tokens') ||
    (l.upstream_format === 'chat_completions' && l.max_output_tokens_param_name === 'max_output_tokens')) throw new Error('BOT_MODEL_LEASE_INVALID');
  const expected = `${origin}/api/bot-model/sessions/${l.session_id}`;
  if (l.gateway_base_url !== expected && l.gateway_base_url !== `${expected}/v1`) throw new Error('BOT_MODEL_LEASE_INVALID');
  return Object.freeze(structuredClone(l));
}
export function validateCloudModelToken(value: unknown): asserts value is string {
  if (!bounded(value, 16*1024)) throw new Error('BOT_MODEL_CREDENTIAL_INVALID');
}
/** Only the scoped Bot access credential is sent; response errors never expose bodies or bearers. */
export async function obtainCloudModelLease(input: {policy: CloudModelPolicy; bot_id: string; host_id: string; model_ref: string; daily_tokens: number; access_token: string; fetch?: typeof fetch}): Promise<{lease: CloudModelLease; access_token: string}> {
  const p = assertCloudModelAdmission(input.policy,input.bot_id,input.model_ref,input.daily_tokens);
  validateCloudModelToken(input.access_token);
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(`${p.service_origin}/api/bot-model/sessions`, {method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
      headers:{'content-type':'application/json',authorization:`Bearer ${input.access_token}`},body:JSON.stringify({bot_id:input.bot_id,host_id:input.host_id,model_ref:input.model_ref,max_output_tokens:Math.min(p.max_output_tokens,input.daily_tokens),max_total_tokens:input.daily_tokens})});
  } catch { throw new Error('BOT_MODEL_GATEWAY_UNAVAILABLE'); }
  if (!response.ok) throw new Error('BOT_MODEL_GATEWAY_REJECTED');
  let body='';
  const reader=response.body?.getReader();
  if(!reader)throw new Error('BOT_MODEL_LEASE_INVALID');
  let size=0;const parts:Uint8Array[]=[];
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>32*1024){await reader.cancel();throw new Error('BOT_MODEL_LEASE_INVALID');}parts.push(chunk.value);}}catch{throw new Error('BOT_MODEL_LEASE_INVALID');}finally{reader.releaseLock();}
  body=Buffer.concat(parts).toString('utf8');
  let raw: Record<string,unknown>; try { raw = JSON.parse(body); } catch { throw new Error('BOT_MODEL_LEASE_INVALID'); }
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('BOT_MODEL_LEASE_INVALID');
  const {access_token,...publicLease} = raw;
  validateCloudModelToken(access_token);
  const lease = parseCloudModelLease(publicLease,p.service_origin);
  if (lease.model_ref !== input.model_ref || lease.expires_at <= Date.now()/1000 || lease.expires_at > Math.min(p.expires_at,Date.now()/1000+1800) || lease.max_total_tokens > input.daily_tokens || lease.max_output_tokens > p.max_output_tokens) throw new Error('BOT_MODEL_LEASE_INVALID');
  return {lease,access_token};
}
