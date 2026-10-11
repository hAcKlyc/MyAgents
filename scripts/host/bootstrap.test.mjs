import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { renderBootstrap, sha256File } from './bootstrap.mjs';

const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const releaseId = '20261012123456-0123456789ab';
const releaseTag = `host-test-${releaseId}`;
const archiveName = `myagents-host-test-${releaseId}.tar.gz`;

async function runCase({ corruptArchive = false, corruptInstaller = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'host-bootstrap-test-'));
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const archive = join(dir, 'archive');
    const installer = join(dir, 'installer');
    const marker = join(dir, 'installer-ran');
    await writeFile(archive, corruptArchive ? 'wrong archive' : 'pinned archive bytes');
    const installerBody = `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$BOOTSTRAP_TEST_MARKER"\n`;
    await writeFile(installer, corruptInstaller ? `${installerBody}# tampered\n` : installerBody, { mode: 0o700 });
    // Compute immutable pins from known reference bytes; fixture damage affects only download output.
    const pinnedArchive = join(dir, 'pinned-archive');
    const pinnedInstaller = join(dir, 'pinned-installer');
    await writeFile(pinnedArchive, 'pinned archive bytes');
    await writeFile(pinnedInstaller, installerBody);
    const pinnedBootstrap = renderBootstrap({
      sourceCommit, releaseTag, archiveName,
      archiveSha256: await sha256File(pinnedArchive), installerSha256: await sha256File(pinnedInstaller),
    });
    const bootstrapPath = join(dir, 'bootstrap.sh');
    await writeFile(bootstrapPath, pinnedBootstrap, { mode: 0o700 });
    await writeFile(join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
    await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n', { mode: 0o755 });
    await writeFile(join(bin, 'getconf'), '#!/bin/sh\necho "glibc 2.39"\n', { mode: 0o755 });
    await writeFile(join(bin, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
    await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(bin, 'curl'), `#!/bin/sh\nset -eu\nwhile [ "$#" -gt 0 ]; do case "$1" in --output) out=$2; shift 2;; https://*) url=$1; shift;; *) shift;; esac; done\ncase "$url" in *releases/download/*) cp "$BOOTSTRAP_TEST_ARCHIVE" "$out";; *raw.githubusercontent.com*) cp "$BOOTSTRAP_TEST_INSTALLER" "$out";; *) exit 9;; esac\n`, { mode: 0o755 });
    const result = spawnSync('bash', [bootstrapPath], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, BOOTSTRAP_TEST_ARCHIVE: archive, BOOTSTRAP_TEST_INSTALLER: installer, BOOTSTRAP_TEST_MARKER: marker },
    });
    return { result, markerExists: await readFile(marker).then(() => true, () => false), dir };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

test('pinned bootstrap verifies both downloads before invoking the installer', async () => {
  assert.throws(() => renderBootstrap({
    sourceCommit: 'fedcba9876543210fedcba9876543210fedcba98', releaseTag, archiveName,
    archiveSha256: 'a'.repeat(64), installerSha256: 'b'.repeat(64),
  }), /source commit/);

  const ok = await runCase();
  assert.equal(ok.result.status, 0, ok.result.stderr);
  assert.equal(ok.markerExists, true);
  await rm(ok.dir, { recursive: true, force: true });

  const badArchive = await runCase({ corruptArchive: true });
  assert.notEqual(badArchive.result.status, 0);
  assert.match(badArchive.result.stderr, /archive SHA-256 mismatch/);
  assert.equal(badArchive.markerExists, false);
  await rm(badArchive.dir, { recursive: true, force: true });

  const badInstaller = await runCase({ corruptInstaller: true });
  assert.notEqual(badInstaller.result.status, 0);
  assert.match(badInstaller.result.stderr, /installer SHA-256 mismatch/);
  assert.equal(badInstaller.markerExists, false);
  await rm(badInstaller.dir, { recursive: true, force: true });
});
