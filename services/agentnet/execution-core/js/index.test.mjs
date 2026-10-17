import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as e from './index.mjs';
const f=JSON.parse(readFileSync(new URL('../fixtures/wire-v1.json',import.meta.url)));
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const jwks={keys:[{...publicKey.export({format:'jwk'}),kid:'execution-fixture',alg:'ES256',use:'sig'}]};
const clone=(v)=>structuredClone(v);
function jwt(typ,claims,key=privateKey,extra={}) {
  const head=Buffer.from(JSON.stringify({alg:'ES256',typ,kid:'execution-fixture',...extra})).toString('base64url');
  const body=Buffer.from(typeof claims==='string'?claims:JSON.stringify(claims)).toString('base64url');
  const input=head+'.'+body;
  return input+'.'+sign('sha256',Buffer.from(input),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
const opt={jwks,scope:f.scope,now:f.now};
const leaseOpt={...opt,intent:f.intent,host_context:f.lease.host_context};
const revOpt={...opt,host_context:f.revocation.host_context,grant_id:f.grant.id,bot_id:f.grant.bot_id,revoked_generation:1};
const tokens={grant:jwt('moxbot-execution-grant+jwt',f.grant_claims),intent:jwt('moxbot-execution-intent+jwt',f.intent),lease:jwt('moxbot-execution-lease+jwt',f.lease),revocation:jwt('moxbot-execution-revocation+jwt',f.revocation)};
// Explicit generator stores only public fixture material, never the private key.
if(process.argv.includes('--write-public-fixture'))writeFileSync(new URL('../fixtures/signed-v1.json',import.meta.url),JSON.stringify({jwks,tokens},null,2)+'\n');
test('Rust/Node shared canonical bytes and hashes, full closed DTO fixtures',()=>{
  assert.equal(e.canonicalBytes(f.canonical_input).toString(),f.canonical_output);
  assert.equal(e.commandHash(f.command),f.command_hash);assert.equal(e.intentHash(f.intent),f.intent_hash);
  e.validateGrant(f.grant);e.validateCommand(f.command);e.validateSnapshot(f.snapshot);e.validateReceipt(f.receipt);
});
test('real ES256 verifies all four domains from pinned public JWK',()=>{
  assert.deepEqual(JSON.parse(JSON.stringify(e.verifyGrant(tokens.grant,opt))),f.grant_claims);
  e.verifyIntent(tokens.intent,opt);e.verifyLease(tokens.lease,leaseOpt);e.verifyRevocation(tokens.revocation,revOpt);
  const publicFixture=JSON.parse(readFileSync(new URL('../fixtures/signed-v1.json',import.meta.url)));
  e.verifyIntent(publicFixture.tokens.intent,{...opt,jwks:publicFixture.jwks});
  e.verifyLease(publicFixture.tokens.lease,{...leaseOpt,jwks:publicFixture.jwks});
});
test('rejects wrong signature, domain, attacker key and malformed/ambiguous JSON',()=>{
  const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  assert.throws(()=>e.verifyIntent(jwt('moxbot-execution-intent+jwt',f.intent,other.privateKey),opt));
  assert.throws(()=>e.verifyGrant(tokens.intent,opt));
  assert.throws(()=>e.verifyIntent(jwt('moxbot-execution-intent+jwt',f.intent,privateKey,{jwk:jwks.keys[0]}),opt));
  assert.throws(()=>e.verifyIntent(jwt('moxbot-execution-intent+jwt','{"iss":"wrong",'+JSON.stringify(f.intent).slice(1)),opt));
  assert.throws(()=>e.verifyIntent(jwt('moxbot-execution-intent+jwt',f.intent,privateKey,{alg:'HS256'}),opt));
  const bad=clone(f.intent);bad.command.expected_host_revision=1;
  assert.throws(()=>e.verifyIntent(jwt('moxbot-execution-intent+jwt',bad),opt));
  assert.throws(()=>e.strictParse('{"x":0,"x":1}'));assert.throws(()=>e.strictParse('{"x":1.0}'));assert.throws(()=>e.strictParse('{"x":1e0}'));
  assert.throws(()=>e.strictParse('{"x":9007199254740992}'));assert.throws(()=>e.strictParse('"\\ud800"'));
});
test('signed but wrong scope, authority, expiry, grant or secret DTO fields fail',()=>{
  for(const mutate of [
    c=>{c.aud='other';},c=>{c.namespace='other';},c=>{c.iss='https://other.invalid';},
    c=>{c.scope.host_key_generation=2;},c=>{c.grant.operations=['enable'];},
    c=>{c.command.operation.params.provider_secret='forbidden';},
    c=>{c.exp=f.now;},c=>{c.iat=f.now+1;c.nbf=c.iat;},
  ]){const c=clone(f.intent);mutate(c);assert.throws(()=>e.verifyIntent(jwt('moxbot-execution-intent+jwt',c),opt));}
  const bad=clone(f.command);bad.extra=true;assert.throws(()=>e.validateCommand(bad));
  const badSnapshot=clone(f.snapshot);badSnapshot.admission='open';assert.throws(()=>e.validateSnapshot(badSnapshot));
  const badReceipt=clone(f.receipt);badReceipt.status='unconfirmed';assert.throws(()=>e.validateReceipt(badReceipt));
});
test('lease and revocation require current nonce/generations and exact Bot target',()=>{
  for(const field of ['challenge_nonce','local_auth_generation','boot_epoch','connection_epoch','membership_revision']){
    const context=clone(f.lease.host_context);context[field]=typeof context[field]==='number'?context[field]+1:f.scope.service_id;
    assert.throws(()=>e.verifyLease(tokens.lease,{...leaseOpt,host_context:context}));
    assert.throws(()=>e.verifyRevocation(tokens.revocation,{...revOpt,host_context:context}));
  }
  assert.throws(()=>e.verifyRevocation(tokens.revocation,{...revOpt,bot_id:f.scope.service_id}));
  assert.throws(()=>e.verifyRevocation(tokens.revocation,{...revOpt,revoked_generation:2}));
  const lease=clone(f.lease);lease.exp=lease.iat+16;assert.throws(()=>e.verifyLease(jwt('moxbot-execution-lease+jwt',lease),leaseOpt));
  const rev=clone(f.revocation);rev.exp=rev.iat+16;assert.throws(()=>e.verifyRevocation(jwt('moxbot-execution-revocation+jwt',rev),revOpt));
  const lease2=clone(f.lease);lease2.intent_hash='0'.repeat(64);assert.throws(()=>e.verifyLease(jwt('moxbot-execution-lease+jwt',lease2),leaseOpt));
});
test('Host observations share closed bounded metadata and never imply model invocation',()=>{
  e.validateHostObservation(f.observation);
  for(const mutate of [o=>{o.provider_secret='bad';},o=>{o.allowed_bot_ids=[];},o=>{o.snapshots.push(clone(o.snapshots[0]));},o=>{o.host_revision=Number.MAX_SAFE_INTEGER+1;},o=>{o.supported_runtimes=['builtin','builtin'];}]) {
    const o=clone(f.observation);mutate(o);assert.throws(()=>e.validateHostObservation(o));
  }
  const o=clone(f.observation);o.snapshots=[];o.allowed_bot_ids=[];
  for(let n=1;n<=4;n++){const s=clone(f.snapshot);s.bot_id=`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;s.config.system_prompt='x'.repeat(16384);o.snapshots.push(s);o.allowed_bot_ids.push(s.bot_id);}
  assert.throws(()=>e.validateHostObservation(o));o.snapshots.pop();e.validateHostObservation(o);
});
test('canonical object keys retain exact ASCII restriction without control regex',()=>{
  assert.equal(e.canonicalBytes({'\u0000':'ok','\u007f':0}).toString(),'{"\\u0000":"ok","\u007f":0}');
  assert.throws(()=>e.canonicalBytes({'\u0080':0}));assert.throws(()=>e.canonicalBytes({'😀':0}));
});
