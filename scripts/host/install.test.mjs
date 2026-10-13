import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const rollbackHelpers = source.split('# BEGIN_ROLLBACK_HELPERS\n')[1]?.split('# END_ROLLBACK_HELPERS')[0];
assert.ok(rollbackHelpers, 'rollback helper markers exist');
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

function rollbackFixture(t, { stopExit = 0, showExit = 0, showOutput = 'ActiveState=inactive\nMainPID=0\n', previousUnit = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'myagents-host-rollback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, 'prefix');
  const release = join(prefix, 'releases/test-1');
  const previousRelease = join(prefix, 'releases/test-previous');
  const unit = join(root, 'service/myagents-host-test.service');
  const stage = join(root, 'stage');
  const bin = join(root, 'bin');
  mkdirSync(release, { recursive: true });
  if (previousUnit) mkdirSync(previousRelease, { recursive: true });
  mkdirSync(join(root, 'service'), { recursive: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(release, 'artifact'), 'new release');
  if (previousUnit) writeFileSync(join(previousRelease, 'artifact'), 'previous release');
  writeFileSync(unit, 'new unit');
  writeFileSync(join(stage, 'recovery-note'), 'private recovery data');
  symlinkSync('releases/test-1', join(prefix, 'current'));
  const backupLink = join(stage, 'previous-link');
  if (previousUnit) {
    writeFileSync(join(stage, 'previous-unit'), 'previous unit');
    symlinkSync('releases/test-previous', backupLink);
  }
  writeFileSync(join(bin, 'systemctl'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$COMMAND_LOG"',
    'case "$1" in',
    '  stop) exit "$STOP_EXIT" ;;',
    '  show) printf \'%s\' "$SHOW_OUTPUT"; exit "$SHOW_EXIT" ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'systemctl'), 0o755);
  writeFileSync(join(bin, 'install'), '#!/bin/sh\ncp "$7" "$8"\nchmod 0644 "$8"\n');
  chmodSync(join(bin, 'install'), 0o755);
  writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nshift 3\nexec "$@"\n');
  chmodSync(join(bin, 'timeout'), 0o755);
  writeFileSync(join(bin, 'mv'), '#!/usr/bin/python3\nimport os,sys\na=sys.argv[1:]\nif a[0]=="-Tf": a=a[1:]\nos.replace(a[0],a[1])\n');
  chmodSync(join(bin, 'mv'), 0o755);
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'sleep'), 0o755);
  const script = `set -euo pipefail\n${rollbackHelpers}\n` +
    'SERVICE=myagents-host-test.service\nUNIT="$UNIT_PATH"\nPREFIX="$PREFIX_PATH"\nSTAGE="$STAGE_PATH"\n' +
    'BACKUP_LINK="$BACKUP_PATH"\nLINK_CHANGED=1\nCREATED_RELEASE="$RELEASE_PATH"\nUNIT_CHANGED=1\n' +
    'PREVIOUS_ENABLED="$WAS_ENABLED"\nPREVIOUS_ACTIVE=0\nROLLBACK_CONFIRMED=0\nPRESERVE_STAGE=0\n' +
    'if rollback_failed_install 1; then printf "confirmed=%s\\npreserve=%s\\n" "$ROLLBACK_CONFIRMED" "$PRESERVE_STAGE"; ' +
    'else printf "confirmed=%s\\npreserve=%s\\n" "$ROLLBACK_CONFIRMED" "$PRESERVE_STAGE"; exit 9; fi';
  const run = spawnSync('/bin/bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      COMMAND_LOG: join(root, 'commands.log'),
      STOP_EXIT: String(stopExit),
      SHOW_EXIT: String(showExit),
      SHOW_OUTPUT: showOutput,
      UNIT_PATH: unit,
      PREFIX_PATH: prefix,
      STAGE_PATH: stage,
      RELEASE_PATH: release,
      BACKUP_PATH: previousUnit ? backupLink : '',
      WAS_ENABLED: previousUnit ? '1' : '0',
    },
  });
  return { root, prefix, release, unit, stage, run, commands: () => readFileSync(join(root, 'commands.log'), 'utf8') };
}

test('fresh-install rollback removes its unit and release only after stop and inactive confirmation', t => {
  const fixture = rollbackFixture(t);
  assert.equal(fixture.run.status, 0, fixture.run.stdout + fixture.run.stderr);
  assert.match(fixture.run.stdout, /confirmed=1/);
  assert.match(fixture.run.stdout, /preserve=0/);
  assert.equal(require('node:fs').existsSync(join(fixture.prefix, 'current')), false);
  assert.equal(require('node:fs').existsSync(fixture.unit), false);
  assert.equal(require('node:fs').existsSync(fixture.release), false);
  assert.deepEqual(fixture.commands().trim().split('\n'), [
    'disable myagents-host-test.service',
    'stop myagents-host-test.service',
    'show myagents-host-test.service --property=ActiveState --property=MainPID --no-pager',
    'daemon-reload',
  ]);
});

test('rollback restores the prior unit, link, and enabled-but-inactive service state', t => {
  const fixture = rollbackFixture(t, { previousUnit: true });
  assert.equal(fixture.run.status, 0, fixture.run.stdout + fixture.run.stderr);
  assert.match(fixture.run.stdout, /confirmed=1/);
  assert.equal(require('node:fs').readlinkSync(join(fixture.prefix, 'current')), 'releases/test-previous');
  assert.equal(readFileSync(fixture.unit, 'utf8'), 'previous unit');
  assert.equal(require('node:fs').existsSync(fixture.release), false);
  assert.match(fixture.commands(), /enable myagents-host-test\.service/);
  assert.doesNotMatch(fixture.commands(), /start myagents-host-test\.service/);
});

for (const [label, options] of [
  ['stop failure', { stopExit: 1, previousUnit: true }],
  ['stop timeout', { stopExit: 124 }],
  ['non-inactive status', { showOutput: 'ActiveState=failed\nMainPID=0\n' }],
  ['duplicate status field', { showOutput: 'ActiveState=inactive\nActiveState=inactive\nMainPID=0\n' }],
]) {
  test(`rollback preserves fresh install files and diagnostics on ${label}`, t => {
    const fixture = rollbackFixture(t, options);
    assert.notEqual(fixture.run.status, 0);
    assert.match(fixture.run.stdout, /confirmed=0/);
    assert.match(fixture.run.stdout, /preserve=1/);
    assert.match(fixture.run.stderr, /Rollback unconfirmed/);
    assert.equal(require('node:fs').readlinkSync(join(fixture.prefix, 'current')), 'releases/test-1');
    assert.equal(readFileSync(fixture.unit, 'utf8'), 'new unit');
    assert.equal(readFileSync(join(fixture.release, 'artifact'), 'utf8'), 'new release');
    assert.equal(readFileSync(join(fixture.stage, 'recovery-note'), 'utf8'), 'private recovery data');
    const calls = fixture.commands();
    assert.match(calls, /disable myagents-host-test\.service/);
    assert.match(calls, /stop myagents-host-test\.service/);
    if (options.previousUnit) assert.match(calls, /enable myagents-host-test\.service/);
    assert.doesNotMatch(calls, /daemon-reload/);
  });
}
