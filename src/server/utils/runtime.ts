/**
 * Runtime Path Utilities
 *
 * Provides functions to locate bundled bun or fallback to system runtimes.
 * This ensures the app can run without requiring users to have Node.js installed.
 */

import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Get script directory at runtime (not compile-time).
 * IMPORTANT: bun build hardcodes __dirname at compile time, breaking production builds.
 * This function uses import.meta.url which is evaluated at runtime.
 */
export function getScriptDir(): string {
  // For ESM modules: use import.meta.url
  if (typeof import.meta?.url === 'string') {
    return dirname(fileURLToPath(import.meta.url));
  }
  // Fallback for bundled environments - use cwd
  // NOTE: In production, sidecar.rs sets cwd to Resources directory
  console.warn('[getScriptDir] import.meta.url unavailable, falling back to cwd:', process.cwd());
  return process.cwd();
}

/**
 * Check if running on Windows
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Historical note: v0.1.x shipped with bundled Bun; this file used to expose
 * `getBundledBunPaths()`, `getBundledBunDir()`, `getSystemBunPaths()`, and
 * `isBunRuntime()`. v0.2.0 removed Bun from the app bundle — all runtime
 * lookups now go through Node.js helpers below (`getBundledNodePath`,
 * `getBundledNodeDir`, `getSystemNpxPaths`, etc.).
 *
 * Directory structure:
 * - Windows: Flat structure, bun.exe and server-dist.js in same directory
 *   C:\Users\xxx\AppData\Local\MyAgents\
 *   ├── bun.exe
 *   ├── server-dist.js
 *   └── myagents.exe
 *
 * - macOS: App bundle structure
 *   MyAgents.app/Contents/
 *   ├── MacOS/bun         <- bundled bun
 *   └── Resources/server-dist.js  <- scriptDir
 */
// v0.2.0: Bun path-discovery helpers removed. MyAgents no longer bundles Bun;
// the SDK's own native binary contains its embedded Bun (SDK-team managed,
// unreachable to us). All bundled-runtime lookups now go through
// getBundledNodePath() / getBundledNodeDir() below.

/**
 * Get system node paths (user-installed).
 */
/**
 * Get system Node.js directories where node/npm/npx are co-located.
 * Single source of truth — node, npm, npx share the same directories.
 */
export function getSystemNodeDirs(): string[] {
  if (isWindows()) {
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env['PROGRAMFILES(X86)'];
    const localAppData = process.env.LOCALAPPDATA;
    const dirs: string[] = [];
    // Standard Node.js installer
    if (programFiles) dirs.push(resolve(programFiles, 'nodejs'));
    if (programFilesX86) dirs.push(resolve(programFilesX86, 'nodejs'));
    // nvm-windows: symlinks active version to NVM_SYMLINK (default: Program Files\nodejs)
    const nvmSymlink = process.env.NVM_SYMLINK;
    if (nvmSymlink) dirs.push(nvmSymlink);
    // Volta: shims live in %LOCALAPPDATA%\Volta\bin
    if (localAppData) dirs.push(resolve(localAppData, 'Volta', 'bin'));
    // fnm: session-specific path via env var
    const fnmPath = process.env.FNM_MULTISHELL_PATH;
    if (fnmPath) dirs.push(fnmPath);
    return dirs;
  }

  const home = process.env.HOME || '';
  return [
    '/opt/homebrew/bin',      // macOS Homebrew (Apple Silicon)
    '/usr/local/bin',         // macOS Homebrew (Intel) / Linux manual install
    '/usr/bin',               // Linux apt/yum
    ...(home ? [
      `${home}/.volta/bin`,   // Volta
      `${home}/.nvm/current/bin`,  // nvm
      `${home}/.fnm/current/bin`,  // fnm
    ] : []),
  ];
}

function getSystemNodePaths(): string[] {
  const exe = isWindows() ? 'node.exe' : 'node';
  return getSystemNodeDirs().map(d => resolve(d, exe));
}

function getSystemNpmPaths(): string[] {
  const exe = isWindows() ? 'npm.cmd' : 'npm';
  return getSystemNodeDirs().map(d => resolve(d, exe));
}

export function getSystemNpxPaths(): string[] {
  const exe = isWindows() ? 'npx.cmd' : 'npx';
  return getSystemNodeDirs().map(d => resolve(d, exe));
}

/**
 * Find the first existing path from a list.
 */
export function findExistingPath(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Get the directory containing the bundled Node.js distribution.
 * Returns the directory that should be added to PATH so that `node`, `npm`, `npx`
 * are all available. Returns null if bundled Node.js is not found.
 *
 * Directory structure:
 * - macOS (prod):  Contents/Resources/nodejs/bin/  (contains node, npm, npx)
 * - macOS (dev):   src-tauri/resources/nodejs/bin/
 * - Windows (prod): <install_dir>/nodejs/           (contains node.exe, npm.cmd, npx.cmd)
 * - Windows (dev):  src-tauri/resources/nodejs/
 */
export function getBundledNodeDir(): string | null {
  const scriptDir = getScriptDir();

  if (isWindows()) {
    // Windows prod: nodejs/ is alongside server-dist.js
    const winDir = resolve(scriptDir, 'nodejs');
    if (existsSync(resolve(winDir, 'node.exe'))) {
      return winDir;
    }
  } else {
    // macOS prod: Contents/Resources/nodejs/bin/
    // scriptDir = Contents/Resources, so nodejs/bin/ is a subdirectory
    const macDir = resolve(scriptDir, 'nodejs', 'bin');
    if (existsSync(resolve(macDir, 'node'))) {
      return macDir;
    }
  }

  // Development: walk up from scriptDir to find src-tauri/resources/nodejs/
  let dir = scriptDir;
  for (let i = 0; i < 6; i++) {
    const devBinDir = resolve(dir, 'src-tauri', 'resources', 'nodejs', 'bin');
    const devWinDir = resolve(dir, 'src-tauri', 'resources', 'nodejs');
    if (!isWindows() && existsSync(resolve(devBinDir, 'node'))) {
      return devBinDir;
    }
    if (isWindows() && existsSync(resolve(devWinDir, 'node.exe'))) {
      return devWinDir;
    }
    dir = dirname(dir);
  }

  return null;
}

/**
 * Get the absolute path to the bundled Node.js binary.
 * Returns null if bundled Node.js is not found.
 */
export function getBundledNodePath(): string | null {
  const nodeDir = getBundledNodeDir();
  if (!nodeDir) return null;

  const nodeBin = isWindows() ? resolve(nodeDir, 'node.exe') : resolve(nodeDir, 'node');
  return existsSync(nodeBin) ? nodeBin : null;
}

/**
 * Get the path to the JavaScript runtime used to execute our own scripts
 * (sidecar entrypoint, plugin bridge, etc.).
 *
 * Priority:
 *   1. Bundled Node.js (app-local — guarantees a matching version)
 *   2. System Node.js (user-maintained, usually newer patch version)
 *   3. Literal "node" (last resort — relies on $PATH)
 *
 * v0.2.0+: Bun is no longer a candidate. The SDK carries its own runtime
 * inside the native binary; everything else runs on Node.js.
 */
export function getBundledRuntimePath(): string {
  const bundledNode = getBundledNodePath();
  if (bundledNode) {
    return bundledNode;
  }

  const systemNode = findExistingPath(getSystemNodePaths());
  if (systemNode) {
    return systemNode;
  }

  return 'node';
}

/**
 * Get the absolute path to the bundled sharp module's CommonJS entry (`lib/index.js`).
 *
 * sharp ships per-platform native addons (`@img/sharp-<triple>/sharp.node`) that
 * esbuild cannot bundle, so we install sharp into a dedicated `sharp-runtime/`
 * node_modules tree and load it at runtime via absolute-path dynamic import.
 * Sharp's internal `require('./libvips')` and `require('@img/sharp-<triple>/sharp.node')`
 * both resolve correctly because Node walks up from the loaded entry file to
 * find `sharp-runtime/node_modules/`.
 *
 * Search order:
 * 1. Production (macOS):   Contents/Resources/sharp-runtime/node_modules/sharp/lib/index.js
 * 2. Production (Windows): <install-dir>/sharp-runtime/node_modules/sharp/lib/index.js
 * 3. Development:          <project-root>/node_modules/sharp/lib/index.js  (top-level dep)
 *
 * @returns Absolute path to sharp's lib/index.js, or null if not found.
 */
export function getBundledSharpEntryPoint(): string | null {
  const relBundled = join('sharp-runtime', 'node_modules', 'sharp', 'lib', 'index.js');
  const scriptDir = getScriptDir();

  // Production layout: sharp-runtime is alongside server-dist.js in Resources
  const prodPath = resolve(scriptDir, relBundled);
  if (existsSync(prodPath)) return prodPath;

  // Development: use the top-level node_modules install from `npm install sharp`.
  // Walk up from scriptDir to project root.
  const relDev = join('node_modules', 'sharp', 'lib', 'index.js');
  let dir = scriptDir;
  for (let i = 0; i < 6; i++) {
    const devPath = resolve(dir, relDev);
    if (existsSync(devPath)) return devPath;
    // Also check for sharp-runtime under src-tauri/resources/ during dev builds
    const devBundled = resolve(dir, 'src-tauri', 'resources', relBundled);
    if (existsSync(devBundled)) return devBundled;
    dir = dirname(dir);
  }

  return null;
}

/**
 * Get the path to a package manager for installing npm packages.
 *
 * Priority order:
 * 1. Bundled bun (can install npm packages via `bun add`)
 * 2. System bun
 * 3. System npm (if user has Node.js)
 *
 * @returns { command: string, installArgs: (pkg: string) => string[], type: 'npm' }
 */
export function getPackageManagerPath(): {
  command: string;
  installArgs: (packageName: string) => string[];
  type: 'npm';
} {
  // Priority: bundled npm → system npm → fallback to PATH.
  // v0.2.0+: Bun removed from bundle; `bun add` path no longer considered.
  const bundledNodeDir = getBundledNodeDir();
  if (bundledNodeDir) {
    const npmExe = isWindows() ? 'npm.cmd' : 'npm';
    const bundledNpm = resolve(bundledNodeDir, npmExe);
    if (existsSync(bundledNpm)) {
      console.log(`[runtime] Using bundled npm: ${bundledNpm}`);
      return {
        command: bundledNpm,
        installArgs: (pkg) => ['install', pkg],
        type: 'npm' as const,
      };
    }
  }

  const systemNpm = findExistingPath(getSystemNpmPaths());
  if (systemNpm) {
    console.log(`[runtime] Using system npm: ${systemNpm}`);
    return {
      command: systemNpm,
      installArgs: (pkg) => ['install', pkg],
      type: 'npm' as const,
    };
  }

  console.warn('[runtime] No bundled or system npm found, falling back to "npm" from PATH');
  return {
    command: 'npm',
    installArgs: (pkg) => ['install', pkg],
    type: 'npm' as const,
  };
}
