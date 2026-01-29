/**
 * Runtime Path Utilities
 *
 * Provides functions to locate bundled bun or fallback to system runtimes.
 * This ensures the app can run without requiring users to have Node.js installed.
 */

import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
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
 * Get the bun executable name based on platform
 */
function getBunExecutableName(): string {
  return isWindows() ? 'bun.exe' : 'bun';
}

/**
 * Get bundled bun paths inside the app bundle.
 * These are the primary paths we check first.
 */
function getBundledBunPaths(): string[] {
  const scriptDir = getScriptDir();
  const bunExe = getBunExecutableName();

  if (isWindows()) {
    // Windows: bun.exe is in the same directory as the main executable
    // scriptDir = .../<app>/resources (where server-dist.js is)
    // Bun should be at .../<app>/bun.exe or .../<app>/bun-x86_64-pc-windows-msvc.exe
    return [
      resolve(scriptDir, '..', bunExe),
      resolve(scriptDir, '..', 'bun-x86_64-pc-windows-msvc.exe'),
    ];
  }

  // macOS: bun is in Contents/MacOS
  // In bundled app: scriptDir = .../Contents/Resources
  // So MacOS is at .../Contents/MacOS
  return [
    resolve(scriptDir, '..', 'MacOS', 'bun'),
  ];
}

/**
 * Get system bun paths (user-installed).
 */
function getSystemBunPaths(): string[] {
  const paths: string[] = [];

  if (isWindows()) {
    // Windows paths
    const userProfile = process.env.USERPROFILE;
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.PROGRAMFILES;

    if (userProfile) {
      paths.push(resolve(userProfile, '.bun', 'bin', 'bun.exe'));
    }
    if (localAppData) {
      paths.push(resolve(localAppData, 'bun', 'bin', 'bun.exe'));
    }
    if (programFiles) {
      paths.push(resolve(programFiles, 'bun', 'bun.exe'));
    }
  } else {
    // Unix paths (macOS/Linux)
    const homeDir = process.env.HOME;

    // User's bun installation
    if (homeDir) {
      paths.push(`${homeDir}/.bun/bin/bun`);
    }

    // macOS Homebrew paths
    paths.push('/opt/homebrew/bin/bun');

    // Linux paths
    paths.push('/usr/local/bin/bun');
    paths.push('/usr/bin/bun');
  }

  return paths;
}

/**
 * Get system node paths (user-installed).
 */
function getSystemNodePaths(): string[] {
  if (isWindows()) {
    const programFiles = process.env.PROGRAMFILES;
    const paths: string[] = [];
    if (programFiles) {
      paths.push(resolve(programFiles, 'nodejs', 'node.exe'));
    }
    return paths;
  }

  return [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
}

/**
 * Get system npm paths (user-installed).
 */
function getSystemNpmPaths(): string[] {
  if (isWindows()) {
    const programFiles = process.env.PROGRAMFILES;
    const paths: string[] = [];
    if (programFiles) {
      paths.push(resolve(programFiles, 'nodejs', 'npm.cmd'));
    }
    return paths;
  }

  return [
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
    '/usr/bin/npm',
  ];
}

/**
 * Find the first existing path from a list.
 */
function findExistingPath(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Check if a path is a bun executable (not just contains 'bun' in path).
 */
export function isBunRuntime(runtimePath: string): boolean {
  // Get the executable name from the path (handle both / and \ separators)
  const separator = isWindows() ? /[\\/]/ : /\//;
  const parts = runtimePath.split(separator);
  const execName = (parts.pop() || '').toLowerCase();
  // Check if the executable name is 'bun' or 'bun.exe' or starts with 'bun-'
  return execName === 'bun' || execName === 'bun.exe' || execName.startsWith('bun-');
}

/**
 * Get the path to a JavaScript runtime (bun or node).
 *
 * Priority order:
 * 1. Bundled bun (inside app bundle /Contents/MacOS/bun)
 * 2. System bun (~/.bun/bin/bun, /opt/homebrew/bin/bun)
 * 3. System node (various paths)
 *
 * This ensures MCP and other features work without requiring Node.js.
 *
 * @returns Absolute path to the runtime, or 'node' as fallback
 */
export function getBundledRuntimePath(): string {
  // Try bundled bun first
  const bundledBun = findExistingPath(getBundledBunPaths());
  if (bundledBun) {
    return bundledBun;
  }

  // Try system bun
  const systemBun = findExistingPath(getSystemBunPaths());
  if (systemBun) {
    return systemBun;
  }

  // Try system node
  const systemNode = findExistingPath(getSystemNodePaths());
  if (systemNode) {
    return systemNode;
  }

  // Last resort fallback - rely on PATH
  return 'node';
}

/**
 * Get the path to a package manager for installing npm packages.
 *
 * Priority order:
 * 1. Bundled bun (can install npm packages via `bun add`)
 * 2. System bun
 * 3. System npm (if user has Node.js)
 *
 * @returns { command: string, installArgs: (pkg: string) => string[], type: 'bun' | 'npm' }
 */
export function getPackageManagerPath(): {
  command: string;
  installArgs: (packageName: string) => string[];
  type: 'bun' | 'npm';
} {
  // Try bundled bun first
  const bundledBun = findExistingPath(getBundledBunPaths());
  if (bundledBun) {
    console.log(`[runtime] Using bundled bun: ${bundledBun}`);
    return {
      command: bundledBun,
      installArgs: (pkg) => ['add', pkg],
      type: 'bun' as const,
    };
  }

  // Try system bun
  const systemBun = findExistingPath(getSystemBunPaths());
  if (systemBun) {
    console.log(`[runtime] Using system bun: ${systemBun}`);
    return {
      command: systemBun,
      installArgs: (pkg) => ['add', pkg],
      type: 'bun' as const,
    };
  }

  // Fallback to npm (requires Node.js)
  const systemNpm = findExistingPath(getSystemNpmPaths());
  if (systemNpm) {
    console.log(`[runtime] Using system npm: ${systemNpm}`);
    return {
      command: systemNpm,
      installArgs: (pkg) => ['install', pkg],
      type: 'npm' as const,
    };
  }

  // Last resort - try npm from PATH
  console.warn('[runtime] No bundled runtime found, falling back to npm from PATH');
  return {
    command: 'npm',
    installArgs: (pkg) => ['install', pkg],
    type: 'npm' as const,
  };
}
