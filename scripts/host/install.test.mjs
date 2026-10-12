import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const installer = new URL('./install.sh', import.meta.url).pathname;
const digest = path => createHash('sha256').update(require('node:fs').readFileSync(path)).digest('hex');
const source = readFileSync(installer, 'utf8');
const lockHelper = source.split('# BEGIN_SHARED_TRANSACTION_LOCK\n')[1]?.split('# END_SHARED_TRANSACTION_LOCK')[0];
assert.ok(lockHelper, 'shared transaction lock helper markers exist');
const releaseVerifier = source.split('# BEGIN_RELEASE_VERIFIER\n')[1]?.split('# END_RELEASE_VERIFIER')[0];
assert.ok(releaseVerifier, 'release verifier markers exist');
function packageFixture(t, mode = 'valid', profile = 'myagents-test') {
  const root = mkdtempSync(join(tmpdir(), 'myagents-host-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = profile === 'moxbot-test' ? 'moxbot-host-test' : 'myagents-host-test';
  const release = join(root, `tree/${packageRoot}/releases/test-1`);
  mkdirSync(join(release, 'resources/nodejs/bin'), { recursive: true });
  mkdirSync(join(release, 'resources/claude-agent-sdk'), { recursive: true });
  for (const path of ['resources/nodejs/bin/node', 'resources/claude-agent-sdk/claude']) {
    const file = join(release, path); writeFileSync(file, '#!/bin/sh\nexit 0\n'); chmodSync(file, 0o755);
  }
  const files = ['resources/nodejs/bin/node', 'resources/claude-agent-sdk/claude'].map(path => {
    const bytes = require('node:fs').readFileSync(join(release, path));
    return { path, size: bytes.length, mode: 0o755, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const manifest = { schemaVersion: 1, releaseId: 'test-1', target: 'linux-x64-glibc', files };
  if (mode !== 'legacy-manifest') manifest.profile = profile;
  writeFileSync(join(release, 'manifest.json'), JSON.stringify(manifest));
  if (mode === 'tampered') writeFileSync(join(release, files[0].path), 'tampered');
  if (mode === 'unlisted') writeFileSync(join(release, 'extra'), 'extra');
  const archive = join(root, 'package.tar.gz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', join(root, 'tree'), packageRoot]);
  assert.equal(tar.status, 0, tar.stderr?.toString());
  return { root, archive, release };
}
function run(archive, sha = digest(archive), profile = 'myagents-test') {
  return spawnSync('/bin/bash', [installer, '--dry-run', archive, '--sha256', sha, '--profile', profile], { encoding: 'utf8' });
}

test('installer dry-run verifies caller digest and package manifest before any privileged action', t => {
  const { archive } = packageFixture(t);
  const result = run(archive);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Verified unsigned test package test-1/);
});

test('fixed moxbot profile verifies only the moxbot package namespace', t => {
  const { archive } = packageFixture(t, 'valid', 'moxbot-test');
  const accepted = run(archive, digest(archive), 'moxbot-test');
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const mismatched = run(archive, digest(archive), 'myagents-test');
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /Unsafe archive path|Unsupported package manifest/);
});

test('legacy unmarked archive remains limited to the original MyAgents namespace', t => {
  const { archive } = packageFixture(t, 'legacy-manifest');
  assert.equal(run(archive).status, 0);
  const mox = run(archive, digest(archive), 'moxbot-test');
  assert.notEqual(mox.status, 0);
});

test('installer refuses an open-ended profile name', t => {
  const { archive } = packageFixture(t);
  const result = spawnSync('/bin/bash', [installer, '--dry-run', archive, '--sha256', digest(archive), '--profile', '/tmp/arbitrary'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Profile must be myagents-test or moxbot-test/);
});

test('installer rejects digest mismatch before archive processing', t => {
  const { archive } = packageFixture(t);
  const result = run(archive, '0'.repeat(64));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match caller-supplied/);
});

for (const scenario of ['tampered', 'unlisted']) {
  test(`installer rejects ${scenario} files against manifest`, t => {
    const { archive } = packageFixture(t, scenario);
    const result = run(archive);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Manifest hash\/size mismatch|unlisted or missing/);
  });
}

function require(name) { return process.getBuiltinModule(name); }

test('installer rejects archive traversal entries before extraction', t => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-host-unsafe-tar-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, 'unsafe.tar.gz');
  const script = "import io,tarfile,sys; t=tarfile.open(sys.argv[1],'w:gz'); i=tarfile.TarInfo('../outside'); d=b'x'; i.size=len(d); t.addfile(i,io.BytesIO(d)); t.close()";
  const built = spawnSync('python3', ['-c', script, archive], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const result = run(archive);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsafe archive path/);
});

test('standalone lock contender is rejected and the unified inherited FD 20 lock can reenter', t => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-host-transaction-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = join(root, 'transaction.lock');
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
  const gid = spawnSync('id', ['-g'], { encoding: 'utf8' }).stdout.trim();
  const script = `set -euo pipefail\n${lockHelper}\n` +
    `acquire_install_transaction_lock "$LOCK_PATH" "${uid}" "${gid}"\n` +
    `exec 20>&9\nMYAGENTS_HOST_TRANSACTION_LOCK_FD=20 acquire_install_transaction_lock "$LOCK_PATH" "${uid}" "${gid}"\n` +
    `if (unset MYAGENTS_HOST_TRANSACTION_LOCK_FD; acquire_install_transaction_lock "$LOCK_PATH" "${uid}" "${gid}"); then exit 71; fi\n` +
    `exec 21<"$LOCK_PATH"\nif MYAGENTS_HOST_TRANSACTION_LOCK_FD=21 acquire_install_transaction_lock "$LOCK_PATH" "${uid}" "${gid}"; then exit 72; fi\n` +
    `printf 'same-fd-ok\\n'`;
  const result = spawnSync('/bin/bash', ['-c', script], {
    encoding: 'utf8', env: { ...process.env, LOCK_PATH: lock },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /same-fd-ok/);
  assert.match(result.stderr, /Another installation or rollback transaction is active/);
});

test('transaction lock rejects an inherited descriptor for a different inode', t => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-host-transaction-foreign-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = join(root, 'transaction.lock');
  const foreign = join(root, 'foreign.lock');
  writeFileSync(foreign, ''); chmodSync(foreign, 0o600);
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
  const gid = spawnSync('id', ['-g'], { encoding: 'utf8' }).stdout.trim();
  const script = `set -u\n${lockHelper}\nexec 8<>"$FOREIGN_PATH"\nMYAGENTS_HOST_TRANSACTION_LOCK_FD=8 acquire_install_transaction_lock "$LOCK_PATH" "${uid}" "${gid}"`;
  const result = spawnSync('/bin/bash', ['-c', script], {
    encoding: 'utf8', env: { ...process.env, LOCK_PATH: lock, FOREIGN_PATH: foreign },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsafe inherited installation transaction lock descriptor|Unsafe installation transaction lock descriptor/);
});

function installedReleaseFixture(t) {
  const { root, release } = packageFixture(t);
  const prefix = join(root, 'installed');
  const releases = join(prefix, 'releases');
  const installed = join(releases, 'test-1');
  mkdirSync(releases, { recursive: true, mode: 0o755 });
  chmodSync(prefix, 0o755); chmodSync(releases, 0o755);
  cpSync(release, installed, { recursive: true, preserveTimestamps: true });
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
  const gid = spawnSync('id', ['-g'], { encoding: 'utf8' }).stdout.trim();
  const verify = (expectedUid = uid, expectedGid = gid) => spawnSync('python3', ['-c', releaseVerifier, release, installed, String(expectedUid), String(expectedGid)], { encoding: 'utf8' });
  return { root, release, prefix, releases, installed, verify, uid, gid };
}

test('an existing release is reusable only when manifest and every installed file match safely', t => {
  const fixture = installedReleaseFixture(t);
  const matching = fixture.verify();
  assert.equal(matching.status, 0, matching.stdout + matching.stderr);

  writeFileSync(join(fixture.installed, 'resources/nodejs/bin/node'), '#!/bin/sh\nexit 9\n');
  const differentBytes = fixture.verify();
  assert.notEqual(differentBytes.status, 0);

  const extraFile = installedReleaseFixture(t);
  writeFileSync(join(extraFile.installed, 'unexpected'), 'unlisted');
  assert.notEqual(extraFile.verify().status, 0);
});

test('release verifier rejects changed modes, symlink entries, and unexpected owner', t => {
  const changedMode = installedReleaseFixture(t);
  chmodSync(join(changedMode.installed, 'resources/claude-agent-sdk/claude'), 0o700);
  assert.notEqual(changedMode.verify().status, 0);

  const symlink = installedReleaseFixture(t);
  const binary = join(symlink.installed, 'resources/claude-agent-sdk/claude');
  rmSync(binary);
  writeFileSync(join(symlink.root, 'replacement'), '#!/bin/sh\n');
  const link = spawnSync('ln', ['-s', join(symlink.root, 'replacement'), binary]);
  assert.equal(link.status, 0, link.stderr?.toString());
  assert.notEqual(symlink.verify().status, 0);

  const wrongOwner = installedReleaseFixture(t);
  assert.notEqual(wrongOwner.verify(Number(wrongOwner.uid) + 1, wrongOwner.gid).status, 0);
});
