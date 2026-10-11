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
const releaseMetadata = () => ({
  tag_name: releaseTag, draft: false, target_commitish: sourceCommit,
  assets: [{ id: 12345, name: archiveName, state: 'uploaded' }],
});

async function runCase({ corruptArchive = false, corruptInstaller = false, metadata = releaseMetadata() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'host-bootstrap-test-'));
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const archive = join(dir, 'archive');
    const installer = join(dir, 'installer');
    const metadataPath = join(dir, 'metadata.json');
    const marker = join(dir, 'installer-ran');
    const requests = join(dir, 'requests.log');
    await writeFile(archive, corruptArchive ? 'wrong archive' : 'pinned archive bytes');
    const installerBody = `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$BOOTSTRAP_TEST_MARKER"\n`;
    await writeFile(installer, corruptInstaller ? `${installerBody}# tampered\n` : installerBody, { mode: 0o700 });
    await writeFile(metadataPath, JSON.stringify(metadata));
    // Compute immutable pins from known reference bytes; fixture damage affects only download output.
    const pinnedArchive = join(dir, 'pinned-archive');
    const pinnedInstaller = join(dir, 'pinned-installer');
    await writeFile(pinnedArchive, 'pinned archive bytes');
    await writeFile(pinnedInstaller, installerBody);
    const bootstrap = renderBootstrap({
      sourceCommit, releaseTag, archiveName,
      archiveSha256: await sha256File(pinnedArchive), installerSha256: await sha256File(pinnedInstaller),
    });
    const bootstrapPath = join(dir, 'bootstrap.sh');
    await writeFile(bootstrapPath, bootstrap, { mode: 0o700 });
    await writeFile(join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
    await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n', { mode: 0o755 });
    await writeFile(join(bin, 'getconf'), '#!/bin/sh\necho "glibc 2.39"\n', { mode: 0o755 });
    await writeFile(join(bin, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
    await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(bin, 'curl'), `#!/bin/sh
set -eu
out= url= accept_octet=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out=$2; shift 2;;
    --header) [ "$2" = 'Accept: application/octet-stream' ] && accept_octet=1; shift 2;;
    https://*) url=$1; shift;;
    *) shift;;
  esac
done
printf '%s\\n' "$url" >> "$BOOTSTRAP_TEST_REQUESTS"
case "$url" in
  https://api.github.com/repos/heavenzhang/MyAgents/releases/tags/*) cp "$BOOTSTRAP_TEST_METADATA" "$out";;
  https://api.github.com/repos/heavenzhang/MyAgents/releases/assets/12345) [ "$accept_octet" -eq 1 ] || exit 8; cp "$BOOTSTRAP_TEST_ARCHIVE" "$out";;
  https://raw.githubusercontent.com/heavenzhang/MyAgents/*/scripts/host/install.sh) cp "$BOOTSTRAP_TEST_INSTALLER" "$out";;
  *) exit 9;;
esac
`, { mode: 0o755 });
    const result = spawnSync('bash', [bootstrapPath], {
      encoding: 'utf8', env: {
        ...process.env, PATH: `${bin}:/usr/bin:/bin`, BOOTSTRAP_TEST_ARCHIVE: archive,
        BOOTSTRAP_TEST_INSTALLER: installer, BOOTSTRAP_TEST_METADATA: metadataPath,
        BOOTSTRAP_TEST_MARKER: marker, BOOTSTRAP_TEST_REQUESTS: requests,
      },
    });
    return {
      result,
      markerExists: await readFile(marker).then(() => true, () => false),
      requestLog: await readFile(requests, 'utf8').catch(() => ''),
      dir,
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

test('GitHub API pinned bootstrap validates metadata and both downloads before invoking installer', async t => {
  assert.throws(() => renderBootstrap({
    sourceCommit: 'fedcba9876543210fedcba9876543210fedcba98', releaseTag, archiveName,
    archiveSha256: 'a'.repeat(64), installerSha256: 'b'.repeat(64),
  }), /source commit/);

  const cases = [
    { name: 'accepts matching release and fixed asset ID', options: {}, succeeds: true },
    { name: 'rejects archive digest mismatch', options: { corruptArchive: true }, error: /archive SHA-256 mismatch/ },
    { name: 'rejects installer digest mismatch', options: { corruptInstaller: true }, error: /installer SHA-256 mismatch/ },
    { name: 'rejects wrong tag metadata', options: { metadata: { ...releaseMetadata(), tag_name: 'host-test-wrong' } }, metadataInvalid: true, error: /release metadata validation failed/ },
    { name: 'rejects draft release', options: { metadata: { ...releaseMetadata(), draft: true } }, metadataInvalid: true, error: /release metadata validation failed/ },
    { name: 'rejects wrong source commit', options: { metadata: { ...releaseMetadata(), target_commitish: 'f'.repeat(40) } }, metadataInvalid: true, error: /release metadata validation failed/ },
    { name: 'rejects missing archive asset', options: { metadata: { ...releaseMetadata(), assets: [] } }, metadataInvalid: true, error: /release metadata validation failed/ },
    { name: 'rejects wrong archive asset name', options: { metadata: { ...releaseMetadata(), assets: [{ id: 12345, name: 'other.tar.gz', state: 'uploaded' }] } }, metadataInvalid: true, error: /release metadata validation failed/ },
    { name: 'rejects duplicate named asset', options: { metadata: { ...releaseMetadata(), assets: [...releaseMetadata().assets, { id: 12346, name: archiveName, state: 'uploaded' }] } }, metadataInvalid: true, error: /release metadata validation failed/ },
    { name: 'rejects non-positive or non-integer asset ID', options: { metadata: { ...releaseMetadata(), assets: [{ id: '12345', name: archiveName, state: 'uploaded' }] } }, metadataInvalid: true, error: /release metadata validation failed/ },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const outcome = await runCase(item.options);
      if (item.succeeds) {
        assert.equal(outcome.result.status, 0, outcome.result.stderr);
        assert.equal(outcome.markerExists, true);
        assert.match(outcome.requestLog, /api\.github\.com\/repos\/heavenzhang\/MyAgents\/releases\/assets\/12345/);
        assert.doesNotMatch(outcome.requestLog, /github\.com\/.*releases\/download/);
      } else {
        assert.notEqual(outcome.result.status, 0);
        assert.match(outcome.result.stderr, item.error);
        assert.equal(outcome.markerExists, false);
        if (item.metadataInvalid) assert.doesNotMatch(outcome.requestLog, /releases\/assets\//);
      }
      await rm(outcome.dir, { recursive: true, force: true });
    });
  }
});
