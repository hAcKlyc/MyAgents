import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const installer = new URL('./install.sh', import.meta.url).pathname;
const digest = path => createHash('sha256').update(require('node:fs').readFileSync(path)).digest('hex');
function packageFixture(t, mode = 'valid') {
  const root = mkdtempSync(join(tmpdir(), 'myagents-host-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, 'tree/myagents-host-test/releases/test-1');
  mkdirSync(join(release, 'resources/nodejs/bin'), { recursive: true });
  mkdirSync(join(release, 'resources/claude-agent-sdk'), { recursive: true });
  for (const path of ['resources/nodejs/bin/node', 'resources/claude-agent-sdk/claude']) {
    const file = join(release, path); writeFileSync(file, '#!/bin/sh\nexit 0\n'); chmodSync(file, 0o755);
  }
  const files = ['resources/nodejs/bin/node', 'resources/claude-agent-sdk/claude'].map(path => {
    const bytes = require('node:fs').readFileSync(join(release, path));
    return { path, size: bytes.length, mode: 0o755, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  writeFileSync(join(release, 'manifest.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'test-1', target: 'linux-x64-glibc', files }));
  if (mode === 'tampered') writeFileSync(join(release, files[0].path), 'tampered');
  if (mode === 'unlisted') writeFileSync(join(release, 'extra'), 'extra');
  const archive = join(root, 'package.tar.gz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', join(root, 'tree'), 'myagents-host-test']);
  assert.equal(tar.status, 0, tar.stderr?.toString());
  return { root, archive };
}
function run(archive, sha = digest(archive)) {
  return spawnSync('/bin/bash', [installer, '--dry-run', archive, '--sha256', sha], { encoding: 'utf8' });
}

test('installer dry-run verifies caller digest and package manifest before any privileged action', t => {
  const { archive } = packageFixture(t);
  const result = run(archive);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Verified unsigned test package test-1/);
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
