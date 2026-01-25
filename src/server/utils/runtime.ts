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
 * Get bundled bun paths inside the app bundle.
 * These are the primary paths we check first.
 */
function getBundledBunPaths(): string[] {
  const scriptDir = getScriptDir();
  return [
    // In bundled app: scriptDir = .../Contents/Resources
    // So MacOS is at .../Contents/MacOS
    scriptDir.replace('/Resources', '/MacOS') + '/bun',
    // Use resolve() to normalize the path
    resolve(scriptDir, '..', 'MacOS', 'bun'),
  ];
}

/**
 * Get system bun paths (user-installed).
 */
function getSystemBunPaths(): string[] {
  const homeDir = process.env.HOME;
  const paths: string[] = [];

  // User's bun installation
  if (homeDir) {
    paths.push(`${homeDir}/.bun/bin/bun`);
  }

  // macOS Homebrew paths
  paths.push('/opt/homebrew/bin/bun');

  // Linux paths
  paths.push('/usr/local/bin/bun');
  paths.push('/usr/bin/bun');

  return paths;
}

/**
 * Get system node paths (user-installed).
 */
function getSystemNodePaths(): string[] {
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
  // Check if the executable name is 'bun'
  const execName = runtimePath.split('/').pop() || '';
  return execName === 'bun';
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
