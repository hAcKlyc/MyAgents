import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkArchive, validateApproval } from './package-cliproxy-component.mjs';
import { assertPublicationRevision, publicationPlan } from './publish-cliproxy-component.mjs';
import { compareVersions, selectRelease, selectBundledRelease, mergeReleases } from './cliproxy-release-policy.mjs';
import { bundledArtifact, fetchArtifact } from './prepare-cliproxy.mjs';

const source = JSON.parse(readFileSync(new URL('../src/shared/managed-cliproxy-source.json', import.meta.url)));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const bytes = Buffer.from('synthetic packaging fixture, never an executable');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const record = platform => ({ platform, version: source.version, commit: source.commit, platformSigning: 'ad-hoc',
  artifact: { sourceSha256: source.platforms[platform].sha256, sha256, size: bytes.length,
    url: `https://download.myagents.io/runtimes/cliproxy/${source.version}-${platform}-${sha256}.zip` } });
const approval = () => ({ controls: { policyRevision: 1, providerMode: 'internal', revokedArtifacts: [], revokedVersions: [] },
  compatibility: { minAppVersion: '0.4.17', revision: 1, credentialCompatibleVersions: [] } });

test('source size and digest both gate packaging', () => {
  checkArchive(bytes, { size: bytes.length, sha256 });
  assert.throws(() => checkArchive(bytes, { size: bytes.length + 1, sha256 }));
  assert.throws(() => checkArchive(Buffer.from('modified'), { size: bytes.length, sha256 }));
});
test('component publication needs production artifacts but never model approvals', () => {
  const input = approval();
  const manifest = validateApproval(input, [record('darwin-arm64')]);
  assert.equal(manifest.releases[0].compatibility.models, undefined);
  input.controls.providerMode = 'enabled';
  assert.throws(() => validateApproval(input, [record('darwin-arm64')]));
  assert.doesNotThrow(() => validateApproval(input, Object.keys(source.platforms).map(platform => ({ ...record(platform), platformSigning: 'developer-id' }))));
});
test('duplicate platform and obsolete exact-version policies are rejected', () => {
  assert.throws(() => validateApproval(approval(), [record('darwin-arm64'), record('darwin-arm64')]));
  const input = approval(); input.compatibility.sdkVersion = '0.0.0';
  assert.throws(() => validateApproval(input, [record('darwin-arm64')]));
});
test('publication plans bind immutable URLs to the exact reviewed artifact bytes', () => {
  const manifest = validateApproval(approval(), [record('darwin-arm64')]);
  assert.equal(publicationPlan(manifest, () => bytes).files.length, 1);
  assert.throws(() => publicationPlan(manifest, () => Buffer.from('modified')));
  manifest.releases[0].artifacts['darwin-arm64'].url = 'https://other.test/artifact.zip';
  assert.throws(() => publicationPlan(manifest, () => bytes));
});
test('publication cannot undo a policy or silently replace a compatibility revision', () => {
  const old = validateApproval(approval(), [record('darwin-arm64')]);
  const next = structuredClone(old); next.controls.providerMode = 'disabled';
  assert.throws(() => assertPublicationRevision(old, next));
  next.controls.policyRevision++;
  assert.doesNotThrow(() => assertPublicationRevision(old, next));
  next.releases[0].compatibility.credentialCompatibleVersions = ['0.0.1'];
  assert.throws(() => assertPublicationRevision(old, next));
  next.releases[0].compatibility.revision++;
  assert.doesNotThrow(() => assertPublicationRevision(old, next));
  assert.throws(() => assertPublicationRevision(next, old));
});

function release(minimum, value = source.version) {
  const r = structuredClone(validateApproval(approval(), [record('darwin-arm64')]).releases[0]);
  r.compatibility.minAppVersion = minimum; r.version = value; r.tag = `v${value}`;
  return r;
}
test('minimum App policy routes old, boundary and future clients independent of array order', () => {
  const releases = [release('0.4.20', '7.3.0'), release('0.4.17')];
  for (const app of ['0.4.17', '0.4.18', '0.4.19']) assert.equal(selectRelease(releases, app).version, source.version);
  for (const app of ['0.4.20', '0.4.100', '1.0.0']) assert.equal(selectRelease(releases, app).version, '7.3.0');
  assert.equal(selectRelease(releases, '0.4.16'), undefined);
  assert.ok(compareVersions('0.4.10', '0.4.9') > 0);
  assert.throws(() => selectRelease([release('0.4.17'), release('0.4.17')], '0.4.20'));
  assert.throws(() => selectRelease([release('0.4.17-beta')], '0.4.20'));
});
test('upsert preserves higher thresholds and old clients keep their resource', () => {
  const old = [release('0.4.17')];
  const expanded = mergeReleases(old, [release('0.4.20', '7.3.0')]);
  assert.equal(selectRelease(expanded, '0.4.19').version, source.version);
  assert.equal(selectRelease(expanded, '0.4.20').version, '7.3.0');
  const replaced = mergeReleases(expanded, [release('0.4.17', '7.2.159')]);
  assert.equal(selectRelease(replaced, '0.4.19').version, '7.2.159');
  assert.equal(selectRelease(replaced, '0.4.20').version, '7.3.0');
  assert.equal(selectRelease(mergeReleases(old, [release('0.4.17', '7.3.0')]), '1.0.0').version, '7.3.0');
});
test('App and SDK bumps reuse the signed bundle while online selection remains independent', () => {
  const releases = [release('0.4.17'), release('0.4.20', '7.3.0')];
  assert.equal(selectBundledRelease(releases, '0.4.99', source).version, source.version);
  assert.equal(selectRelease(releases, '0.4.99').version, '7.3.0');
  const manifest = JSON.parse(readFileSync(new URL('../.github/cliproxy/manifest-v1.json', import.meta.url)));
  const bundled = selectBundledRelease(manifest.releases, pkg.version, source);
  for (const app of [bundled.compatibility.minAppVersion, pkg.version, '99.0.0']) {
    const future = { ...pkg, version: app, dependencies: { '@anthropic-ai/claude-agent-sdk': '99.0.0' } };
    for (const platform of Object.keys(source.platforms)) assert.equal(bundledArtifact(manifest, source, future, platform).sourceSha256, source.platforms[platform].sha256);
  }
});
test('component upgrade keeps the published minimum App version without a new client dependency', () => {
  const manifest = JSON.parse(readFileSync(new URL('../.github/cliproxy/manifest-v1.json', import.meta.url)));
  const current = selectRelease(manifest.releases, '0.4.17');
  assert.equal(current.version, source.version);
  assert.equal(current.compatibility.minAppVersion, '0.4.17');
  for (const app of ['0.4.18', '0.4.99', '0.5.0', '99.0.0']) {
    assert.equal(selectRelease(manifest.releases, app).version, source.version);
    assert.equal(selectBundledRelease(manifest.releases, app, source).version, source.version);
  }
  assert.equal(selectRelease(manifest.releases, '0.4.16'), undefined);
  // v8.0.79 has only had account-free local acceptance. Do not inherit the
  // previous release's real-account attestation transitively.
  assert.deepEqual(current.compatibility.credentialCompatibleVersions, []);
});
test('publication retains existing thresholds and immutable version bytes', () => {
  const old = validateApproval(approval(), [record('darwin-arm64')]);
  const next = structuredClone(old); next.releases = [release('0.4.20', '7.3.0')];
  assert.throws(() => assertPublicationRevision(old, next), /retained/);
  next.releases = [release('0.4.17', '7.2.157')];
  assert.throws(() => assertPublicationRevision(old, next), /downgrade/);
  next.releases = structuredClone(old.releases); next.releases[0].artifacts['darwin-arm64'].sha256 = 'f'.repeat(64);
  assert.throws(() => assertPublicationRevision(old, next), /immutable/);
});
test('CI download verifies bytes without executing them or requiring a signing key', async () => {
  const artifact = record('darwin-arm64').artifact;
  assert.deepEqual(await fetchArtifact(artifact, async () => new Response(bytes)), bytes);
  await assert.rejects(fetchArtifact(artifact, async () => new Response(Buffer.alloc(bytes.length))), /integrity/);
  await assert.rejects(fetchArtifact(artifact, async () => new Response(Buffer.alloc(bytes.length + 1))), /size/);
  await assert.rejects(fetchArtifact(artifact, async () => new Response('', { status: 404 })), /404/);
});

test('component versions remain immutable across new floors and replaced historical floors', () => {
  const old = validateApproval(approval(), [record('darwin-arm64')]);
  const next = structuredClone(old); next.releases.push(release('0.4.20'));
  assert.doesNotThrow(() => assertPublicationRevision(old, next));
  next.releases[1].artifacts['darwin-arm64'].sha256 = 'f'.repeat(64);
  assert.throws(() => assertPublicationRevision(old, next), /immutable/);
  assert.throws(() => publicationPlan(next, () => null), /immutable/);
  next.releases[0] = release('0.4.17', '7.3.0');
  assert.throws(() => assertPublicationRevision(old, next), /immutable/);
});
