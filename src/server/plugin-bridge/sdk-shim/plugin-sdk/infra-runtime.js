// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./infra-runtime.auto.js";
// === END AUTO-AUGMENT ===

// OpenClaw plugin-sdk/infra-runtime shim for MyAgents Plugin Bridge
// Provides filesystem utilities: temp dir resolution, file locking.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, lstatSync, rmdirSync, writeFileSync, unlinkSync } from 'node:fs';

// The compiled Bridge overwrites this before plugin import; capture once.
const appProfile = process.env.MYAGENTS_BRIDGE_APP_PROFILE ?? 'myagents';
if (appProfile !== 'myagents' && appProfile !== 'moxbot') {
  throw new Error('Unsupported Plugin Bridge application profile');
}
const appDataDirName = appProfile === 'moxbot' ? '.moxbot' : '.myagents';

/**
 * Resolve the preferred OpenClaw temp directory.
 * In real OpenClaw: tries XDG_RUNTIME_DIR → ~/.openclaw/tmp → os.tmpdir(), with permission checks.
 * Our shim: uses ~/.myagents/tmp (MyAgents convention, always writable).
 */
export function resolvePreferredOpenClawTmpDir(options) {
  const dir = join(homedir(), appDataDirName, 'tmp');
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

/**
 * Execute a function while holding an advisory file lock.
 * In real OpenClaw: uses proper-lockfile with retry/stale options.
 * Our shim: simplified mkdir-based lock (sufficient for single-instance Bridge).
 */
export async function withFileLock(filePath, options, fn) {
  const lockPath = filePath + '.lock';
  const staleMs = options?.stale || 10000;

  // Try to acquire lock via mkdir (atomic on most filesystems)
  let acquired = false;
  const retries = options?.retries?.retries || 3;
  const minTimeout = options?.retries?.minTimeout || 100;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      mkdirSync(lockPath);
      // Write PID for stale detection
      writeFileSync(join(lockPath, 'pid'), String(process.pid));
      acquired = true;
      break;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Check stale lock
        try {
          const stat = lstatSync(lockPath);
          const age = Date.now() - stat.mtimeMs;
          if (age > staleMs) {
            // Stale lock — force remove and retry
            try { unlinkSync(join(lockPath, 'pid')); } catch { /* ignore */ }
            try { rmdirSync(lockPath); } catch { /* ignore */ }
            continue;
          }
        } catch { /* stat failed, retry */ }

        if (attempt < retries) {
          const delay = minTimeout * Math.pow(options?.retries?.factor || 2, attempt);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      throw err;
    }
  }

  if (!acquired) {
    throw new Error(`Failed to acquire file lock: ${lockPath}`);
  }

  try {
    return await fn();
  } finally {
    // Release lock
    try { unlinkSync(join(lockPath, 'pid')); } catch { /* ignore */ }
    try { rmdirSync(lockPath); } catch { /* ignore */ }
  }
}

/**
 * Acquire a file lock (returns a handle with release()).
 */
export async function acquireFileLock(filePath, options) {
  const lockPath = filePath + '.lock';
  const staleMs = options?.stale || 10000;
  const retries = options?.retries?.retries || 3;
  const minTimeout = options?.retries?.minTimeout || 100;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'pid'), String(process.pid));
      return {
        lockPath,
        async release() {
          try { unlinkSync(join(lockPath, 'pid')); } catch { /* ignore */ }
          try { rmdirSync(lockPath); } catch { /* ignore */ }
        },
      };
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const stat = lstatSync(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            try { unlinkSync(join(lockPath, 'pid')); } catch { /* ignore */ }
            try { rmdirSync(lockPath); } catch { /* ignore */ }
            continue;
          }
        } catch { /* stat failed */ }
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, minTimeout * Math.pow(options?.retries?.factor || 2, attempt)));
          continue;
        }
      }
      throw err;
    }
  }
  throw new Error(`Failed to acquire file lock: ${lockPath}`);
}
