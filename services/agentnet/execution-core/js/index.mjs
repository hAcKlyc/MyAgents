// Shared execution verifier. No remote keys, bearer material, or arbitrary claims signer.
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
export const NAMESPACE = 'moxbot.bot.execution/v1';
export const AUDIENCE = 'moxbot-host-bots/v1';
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const MAX_OBJECT_BYTES = 64 * 1024;
export const MAX_JWT_BYTES = 128 * 1024;
export const MAX_COLLECTION_ITEMS = 64;
export const MAX_PROOF_SECONDS = 300;
export const MAX_LEASE_SECONDS = 15;
export class ExecutionError extends Error {
  constructor(code = 'EXECUTION_INVALID') { super(code); this.name = 'ExecutionError'; this.code = code; }
}
const require = (ok) => { if (!ok) throw new ExecutionError(); };
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const id = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
const hash = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const safe = (n, positive = false) => Number.isSafeInteger(n) && n >= 0 && (!positive || n > 0);
const identifier = (s, max = 128) => typeof s === 'string' && bytes(s) <= max && /^[A-Za-z0-9_.-]+$/.test(s);
function validUnicode(s) {
  for (let i=0;i<s.length;i++) {
    const c=s.charCodeAt(i);
    if (c>=0xd800&&c<=0xdbff) { const next=s.charCodeAt(++i); if (!(next>=0xdc00&&next<=0xdfff)) return false; }
    else if (c>=0xdc00&&c<=0xdfff) return false;
  }
  return true;
}
const text = (s,max) => typeof s === 'string' && bytes(s)<=max && !s.includes('\0') && validUnicode(s);
const methods = ['create','configure','enable','disable','delete','restore'];
const unique = (a, nonempty = true) => Array.isArray(a) && a.length<=MAX_COLLECTION_ITEMS && (!nonempty||a.length>0) && new Set(a).size===a.length;
function object(v, fields, optional = []) {
  require(v!==null && typeof v==='object' && !Array.isArray(v));
  require(Object.keys(v).every(k=>fields.includes(k)||optional.includes(k)) && fields.every(k=>Object.hasOwn(v,k)));
}
function equal(a,b) { return canonicalBytes(a).equals(canonicalBytes(b)); }

// Decode without JSON.parse's duplicate-key overwrite or floating-point coercion.
export function strictParse(input) {
  require(typeof input==='string' && bytes(input)<=MAX_JWT_BYTES);
  let at=0;
  function ws(){ while(/[\t\n\r ]/.test(input[at]??'!'))at++; }
  function string() {
    const start=at++; let escaped=false;
    while(at<input.length) {
      const c=input[at++];
      if (c==='"'&&!escaped) { const s=JSON.parse(input.slice(start,at)); require(validUnicode(s)); return s; }
      if(c==='\\'&&!escaped)escaped=true; else escaped=false;
    }
    throw new ExecutionError();
  }
  function value(depth=0) {
    require(depth<=32); ws(); const c=input[at];
    if(c==='"')return string();
    if(c==='{') {
      at++; ws(); const out=Object.create(null); const seen=new Set();
      if(input[at]==='}') {at++; return out;}
      for(;;){ws(); require(input[at]==='"'); const k=string(); require(!seen.has(k)); seen.add(k); ws(); require(input[at++]===':'); out[k]=value(depth+1); ws(); if(input[at]==='}') {at++; return out;} require(input[at++]===',');}
    }
    if(c==='[') {
      at++; ws(); const out=[]; if(input[at]===']'){at++;return out;}
      for(;;){out.push(value(depth+1));ws();if(input[at]===']'){at++;return out;}require(input[at++]===',');}
    }
    for(const [word,result] of [['true',true],['false',false],['null',null]]) {if(input.startsWith(word,at)){at+=word.length;return result;}}
    const match=/^(0|[1-9][0-9]*)/.exec(input.slice(at)); require(!!match); at+=match[0].length;
    require(!/[.eE0-9]/.test(input[at]??'!')); const n=Number(match[0]); require(safe(n)); return n;
  }
  try {const v=value();ws();require(at===input.length);return v;} catch {throw new ExecutionError();}
}
export function canonicalBytes(value) {
  function canonical(v,depth=0) {
    require(depth<=32);
    if(v===null||typeof v==='boolean')return JSON.stringify(v);
    if(typeof v==='number'){require(safe(v));return JSON.stringify(v);}
    if(typeof v==='string'){require(validUnicode(v));return JSON.stringify(v);}
    if(Array.isArray(v))return '['+v.map(x=>canonical(x,depth+1)).join(',')+']';
    require(v!==null&&typeof v==='object'); const keys=Object.keys(v).sort(); require(keys.every(k=>[...k].every(c=>c.codePointAt(0)<=0x7f)));
    return '{'+keys.map(k=>JSON.stringify(k)+':'+canonical(v[k],depth+1)).join(',')+'}';
  }
  const out=Buffer.from(canonical(value));require(out.length<=MAX_OBJECT_BYTES);return out;
}
export function commandHash(command) {
  const value={...command};delete value.request_hash;
  return createHash('sha256').update(canonicalBytes(value)).digest('hex');
}
export function intentHash(intent) {return createHash('sha256').update(canonicalBytes(intent)).digest('hex');}
export function validateScope(s) {
  object(s,['issuer','service_id','environment','network_id','host_owner_id','host_device_id','host_key_generation','identity_binding_id']);
  let url;try{url=new URL(s.issuer);}catch{throw new ExecutionError();}
  require(bytes(s.issuer)<=2048&&url.protocol==='https:'&&url.origin===s.issuer&&url.pathname==='/'&&!url.username&&!url.password&&!url.search&&!url.hash);
  require(['production','development'].includes(s.environment)&&['service_id','network_id','host_owner_id','host_device_id','identity_binding_id'].every(k=>id(s[k]))&&safe(s.host_key_generation,true));return s;
}
export function validateGrant(g) {
  object(g,['id','generation','scope','bot_id','root_id','relative_path','operations','allowed_runtimes','allowed_model_refs','max_daily_tokens','expires_at']);validateScope(g.scope);
  require(id(g.id)&&id(g.bot_id)&&safe(g.generation,true)&&identifier(g.root_id,64)&&text(g.relative_path,1024)&&g.relative_path.split('/').every(p=>identifier(p,128)&&p!=='.'&&p!=='..'));
  require(unique(g.operations)&&g.operations.every(m=>methods.includes(m))&&unique(g.allowed_runtimes)&&g.allowed_runtimes.every(r=>identifier(r,64))&&unique(g.allowed_model_refs,false)&&g.allowed_model_refs.every(id)&&safe(g.max_daily_tokens,true)&&safe(g.expires_at,true));return g;
}
export function validateConfig(c) {
  object(c,['name','description','runtime','model_ref','system_prompt','daily_tokens']);
  require(text(c.name,240)&&c.name.trim().length>0&&[...c.name].length<=60&&text(c.description,4096)&&identifier(c.runtime,64)&&(c.model_ref===null||id(c.model_ref))&&text(c.system_prompt,16384)&&safe(c.daily_tokens,true));return c;
}
export function validateCommand(c) {
  object(c,['mutation_id','request_hash','actor_principal_id','actor_session_handle','grant_id','grant_generation','bot_id','binding_generation','expected_host_revision','operation']);
  require(['mutation_id','actor_principal_id','actor_session_handle','grant_id','bot_id'].every(k=>id(c[k]))&&hash(c.request_hash)&&safe(c.grant_generation,true)&&safe(c.binding_generation)&&safe(c.expected_host_revision));
  object(c.operation,['method','params']);const {method,params}=c.operation;require(methods.includes(method));
  if(method==='create') {
    object(params,['name','description','runtime','model_ref','system_prompt','daily_tokens','resource_expected_revision']);require(safe(params.resource_expected_revision));
    const {resource_expected_revision:_,...config}=params;validateConfig(config);
  }else if(method==='configure')validateConfig(params);
  else if(method==='disable'){object(params,['policy']);require(params.policy==='cancel');}
  else if(method==='delete'){object(params,['confirmation']);require(text(params.confirmation,240)&&params.confirmation.trim().length>0&&[...params.confirmation].length<=60);}
  else object(params,[]);
  require(commandHash(c)===c.request_hash);return c;
}
function authorized(c,g) {
  validateCommand(c);validateGrant(g);
  require(c.grant_id===g.id&&c.grant_generation===g.generation&&c.bot_id===g.bot_id&&g.operations.includes(c.operation.method));
  if(['create','configure'].includes(c.operation.method)) {
    const p=c.operation.params;require(g.allowed_runtimes.includes(p.runtime)&&(p.model_ref===null||g.allowed_model_refs.includes(p.model_ref))&&p.daily_tokens<=g.max_daily_tokens);
  }
}
export function validateHostContext(c) {
  object(c,['challenge_nonce','local_auth_generation','boot_epoch','connection_epoch','membership_revision']);
  require(['challenge_nonce','boot_epoch','connection_epoch'].every(k=>id(c[k]))&&safe(c.local_auth_generation,true)&&safe(c.membership_revision,true));return c;
}
export function validateSnapshot(s) {
  object(s,['bot_id','binding_generation','revision','deleted','admission','activity','configured','runnable','config'],['agent_id','unsupported_reason','active_run']);validateConfig(s.config);
  require(id(s.bot_id)&&safe(s.binding_generation)&&safe(s.revision)&&typeof s.deleted==='boolean'&&typeof s.configured==='boolean'&&typeof s.runnable==='boolean'&&['closed','open'].includes(s.admission)&&['idle','running','stopping','stopped','unknown'].includes(s.activity));
  require(s.agent_id==null||(text(s.agent_id,256)&&s.agent_id.length>0));require(s.unsupported_reason==null||identifier(s.unsupported_reason,128));
  if(s.active_run!=null){object(s.active_run,['session_id','run_generation']);require(id(s.active_run.session_id)&&id(s.active_run.run_generation));}
  require(!s.runnable||(s.configured&&s.agent_id!=null&&s.binding_generation>0&&!s.deleted&&s.unsupported_reason==null));
  require(s.admission!=='open'||s.runnable);require(s.activity!=='running'||(s.runnable&&s.active_run!=null));require(s.activity!=='stopped'||(s.admission==='closed'&&s.active_run==null));require(!s.deleted||(s.admission==='closed'&&s.active_run==null&&s.activity==='stopped'));return s;
}
export function validateReceipt(r) {
  object(r,['mutation_id','request_hash','grant_id','grant_generation','bot_id','binding_generation','revision','status'],['agent_id','code','snapshot']);
  require(['mutation_id','grant_id','bot_id'].every(k=>id(r[k]))&&hash(r.request_hash)&&safe(r.grant_generation,true)&&safe(r.binding_generation)&&safe(r.revision)&&['persisted','conflict','failed','unconfirmed'].includes(r.status));
  require(r.agent_id==null||(text(r.agent_id,256)&&r.agent_id.length>0));require(r.code==null||identifier(r.code,128));
  if(r.snapshot!=null){validateSnapshot(r.snapshot);require(r.snapshot.bot_id===r.bot_id&&(r.snapshot.agent_id??null)===(r.agent_id??null)&&r.snapshot.binding_generation===r.binding_generation&&r.snapshot.revision===r.revision);}
  require(r.status!=='unconfirmed'||r.snapshot==null);return r;
}
export function validateHostObservation(o) {
  object(o,['host_revision','resource_revision','root_ids','supported_runtimes','allowed_bot_ids','allowed_model_refs','max_daily_tokens','policy_expires_at','snapshots']);
  require(safe(o.host_revision)&&safe(o.resource_revision)&&safe(o.max_daily_tokens)&&safe(o.policy_expires_at,true));
  require(unique(o.root_ids,false)&&o.root_ids.every(s=>identifier(s,64))&&unique(o.supported_runtimes,false)&&o.supported_runtimes.every(s=>identifier(s,64)));
  require(unique(o.allowed_bot_ids,false)&&o.allowed_bot_ids.every(id)&&unique(o.allowed_model_refs,false)&&o.allowed_model_refs.every(id));
  require(Array.isArray(o.snapshots)&&o.snapshots.length<=MAX_COLLECTION_ITEMS&&new Set(o.snapshots.map(s=>s?.bot_id)).size===o.snapshots.length);
  for(const s of o.snapshots){validateSnapshot(s);require(o.allowed_bot_ids.includes(s.bot_id));}
  canonicalBytes(o);return o;
}
const common=['iss','aud','namespace','iat','nbf','exp','jti'];
function time(c,scope,now,ttl) {
  validateScope(scope);require(c.iss===scope.issuer&&c.aud===AUDIENCE&&c.namespace===NAMESPACE&&id(c.jti)&&[c.iat,c.nbf,c.exp,now].every(n=>safe(n))&&c.nbf===c.iat&&c.iat<=now&&now<c.exp&&c.exp>c.iat&&c.exp-c.iat<=ttl);
}
export function validateGrantClaims(c,{scope,now}) {
  object(c,[...common,'grant']);validateGrant(c.grant);time(c,scope,now,MAX_PROOF_SECONDS);require(equal(c.grant.scope,scope)&&c.exp<=c.grant.expires_at);return c;
}
export function validateIntentClaims(c,{scope,now}) {
  object(c,[...common,'scope','grant','command']);authorized(c.command,c.grant);time(c,scope,now,MAX_PROOF_SECONDS);require(equal(c.scope,scope)&&equal(c.grant.scope,scope)&&c.exp<=c.grant.expires_at);return c;
}
export function validateLeaseClaims(c,{scope,now,intent,host_context}) {
  object(c,[...common,'scope','grant_id','grant_generation','bot_id','binding_generation','mutation_id','request_hash','intent_hash','host_context','lease_id']);
  time(c,scope,now,MAX_LEASE_SECONDS);validateHostContext(c.host_context);validateHostContext(host_context);validateIntentClaims(intent,{scope,now});
  require(equal(c.scope,scope)&&['grant_id','bot_id','mutation_id','lease_id'].every(k=>id(c[k]))&&safe(c.grant_generation,true)&&safe(c.binding_generation)&&hash(c.request_hash)&&hash(c.intent_hash));
  require(c.intent_hash===intentHash(intent)&&c.exp<=intent.exp&&c.exp<=intent.grant.expires_at&&equal(c.host_context,host_context));
  require(['grant_id','grant_generation','bot_id','binding_generation','mutation_id','request_hash'].every(k=>c[k]===intent.command[k]));return c;
}
export function validateRevocationClaims(c,{scope,now,host_context,grant_id,bot_id,revoked_generation}) {
  object(c,[...common,'scope','grant_id','revoked_generation','bot_id','host_context']);time(c,scope,now,MAX_LEASE_SECONDS);validateHostContext(c.host_context);validateHostContext(host_context);
  require(equal(c.scope,scope)&&id(c.grant_id)&&id(c.bot_id)&&safe(c.revoked_generation,true)&&c.grant_id===grant_id&&c.bot_id===bot_id&&c.revoked_generation===revoked_generation&&equal(c.host_context,host_context));return c;
}
function segment(s) {
  require(typeof s==='string'&&s.length>0&&/^[A-Za-z0-9_-]+$/.test(s));const b=Buffer.from(s,'base64url');require(b.toString('base64url')===s);return b;
}
function proof(token,jwks,typ) {
  try {
    require(typeof token==='string'&&bytes(token)<=MAX_JWT_BYTES);const parts=token.split('.');require(parts.length===3);
    const head=strictParse(new TextDecoder('utf-8',{fatal:true}).decode(segment(parts[0])));object(head,['alg','typ','kid']);require(head.alg==='ES256'&&head.typ===typ&&identifier(head.kid,128));
    object(jwks,['keys']);require(Array.isArray(jwks.keys)&&jwks.keys.length<=MAX_COLLECTION_ITEMS);
    const matches=jwks.keys.filter(k=>k.kid===head.kid);require(matches.length===1);const jwk=matches[0];
    require(jwk.kty==='EC'&&jwk.crv==='P-256'&&(jwk.alg===undefined||jwk.alg==='ES256')&&(jwk.use===undefined||jwk.use==='sig')&&!Object.hasOwn(jwk,'d'));
    const signature=segment(parts[2]);require(signature.length===64);
    const key=createPublicKey({key:jwk,format:'jwk'});
    require(cryptoVerify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key,dsaEncoding:'ieee-p1363'},signature));
    const claims=strictParse(new TextDecoder('utf-8',{fatal:true}).decode(segment(parts[1])));require(canonicalBytes(claims).length<=MAX_OBJECT_BYTES);return claims;
  } catch {throw new ExecutionError('EXECUTION_PROOF_REJECTED');}
}
export function verifyGrant(token,options) {return validateGrantClaims(proof(token,options.jwks,'moxbot-execution-grant+jwt'),options);}
export function verifyIntent(token,options) {return validateIntentClaims(proof(token,options.jwks,'moxbot-execution-intent+jwt'),options);}
export function verifyLease(token,options) {return validateLeaseClaims(proof(token,options.jwks,'moxbot-execution-lease+jwt'),options);}
export function verifyRevocation(token,options) {return validateRevocationClaims(proof(token,options.jwks,'moxbot-execution-revocation+jwt'),options);}
