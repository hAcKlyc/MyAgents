import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { downloadBuildResource } from '../build-resource-download.mjs';

// Same portable compiler distribution used by Tauri's Windows bundler:
// https://github.com/tauri-apps/tauri/blob/94ffd77664759f38111bde3e85802841da80c3eb/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs#L32-L38
// Size and SHA-256 are pinned from the publisher's GitHub release asset digest.
export const NSIS_ARCHIVE = Object.freeze({
  version: '3.13',
  url: 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip',
  size: 2363925,
  sha256: 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8',
});

export function verifyNsisArchive(bytes, expected = NSIS_ARCHIVE) {
  if (bytes.length !== expected.size) {
    throw new Error(`NSIS archive size mismatch: expected ${expected.size}, received ${bytes.length}`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected.sha256) {
    throw new Error(`NSIS archive SHA-256 mismatch: expected ${expected.sha256}, received ${digest}`);
  }
}

export async function downloadNsisArchive(destination, { download = downloadBuildResource } = {}) {
  const bytes = await download(NSIS_ARCHIVE.url, {
    maxBytes: NSIS_ARCHIVE.size,
    redirect: 'follow',
  });
  verifyNsisArchive(bytes);
  // CI owns a fresh RUNNER_TEMP path. Never publish an unverified archive.
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  console.log(`[NSIS] Verified portable ${NSIS_ARCHIVE.version}: ${bytes.length} bytes, SHA-256 ${NSIS_ARCHIVE.sha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/ci/download-nsis.mjs <archive-path>');
  await downloadNsisArchive(resolve(process.argv[2]));
}
