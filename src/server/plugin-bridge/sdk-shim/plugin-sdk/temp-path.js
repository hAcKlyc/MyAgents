// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./temp-path.auto.js";
// === END AUTO-AUGMENT ===

/** Shim for openclaw/plugin-sdk/temp-path */

import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';

// SDK relocation: keep the same root as released infra-runtime consumers.
export { resolvePreferredOpenClawTmpDir } from './infra-runtime.js';

function sanitizePrefix(prefix) {
  const normalized = prefix.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'tmp';
}

function sanitizeExtension(extension) {
  if (!extension) return '';
  const normalized = extension.startsWith('.') ? extension : `.${extension}`;
  const suffix = normalized.match(/[a-zA-Z0-9._-]+$/)?.[0] ?? '';
  const token = suffix.replace(/^[._-]+/, '');
  if (!token) return '';
  return `.${token}`;
}

function sanitizeTempFileName(fileName) {
  const base = path.basename(fileName.replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const normalized = base.replace(/^-+|-+$/g, '');
  return !normalized || normalized === '.' || normalized === '..' ? 'download.bin' : normalized;
}

function resolveTempRoot(tmpDir) {
  const root = tmpDir ?? path.join(tmpdir(), 'myagents-bridge-media');
  mkdirSync(root, { recursive: true });
  return root;
}

function buildRandomTempFilePath(params) {
  const prefix = sanitizePrefix(params.prefix || 'tmp');
  const extension = sanitizeExtension(params.extension);
  const now = typeof params.now === 'number' && Number.isFinite(params.now) ? Math.trunc(params.now) : Date.now();
  const uuid = params.uuid?.trim() || crypto.randomUUID();
  const root = resolveTempRoot(params.tmpDir);
  return path.join(root, `${prefix}-${now}-${uuid}${extension}`);
}

async function createTempDownloadTarget(params) {
  const tempRoot = resolveTempRoot(params.tmpDir);
  const prefix = `${sanitizePrefix(params.prefix || 'tmp')}-`;
  const dir = mkdtempSync(path.join(tempRoot, prefix));
  const file = (fileName) => path.join(dir, sanitizeTempFileName(fileName ?? params.fileName ?? 'download.bin'));
  const cleanup = async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn(`temp-path cleanup failed for ${dir}: ${String(err)}`);
      }
    }
  };
  return { dir, path: file(), file, cleanup, [Symbol.asyncDispose]: cleanup };
}

async function withTempDownloadPath(params, fn) {
  const target = await createTempDownloadTarget(params);
  try {
    return await fn(target.path);
  } finally {
    await target.cleanup();
  }
}

export {
  buildRandomTempFilePath,
  createTempDownloadTarget,
  sanitizeTempFileName,
  withTempDownloadPath,
};
