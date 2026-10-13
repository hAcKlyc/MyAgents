import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { getMyAgentsNpmGlobalBinDir } from './npm-prefix-env';
import { getCrossPlatformEnv } from './platform';
import { getBundledNodeDir, getSystemNodeDirs } from './runtime';

export interface SessionExecutablePath {
  key: 'PATH' | 'Path';
  value: string;
  entries: string[];
  bundledNodeDir: string | null;
}

/**
 * Build the executable search path shared by real Agent sessions and probes.
 * GUI-launched processes do not inherit a login shell PATH, so app-owned and
 * conventional system runtime directories must be supplied explicitly.
 */
export function buildSessionExecutablePath(
  parentEnv: NodeJS.ProcessEnv = process.env,
): SessionExecutablePath {
  const { home } = getCrossPlatformEnv();
  const isWindows = process.platform === 'win32';
  const separator = isWindows ? ';' : ':';
  const key = isWindows ? 'Path' : 'PATH';
  const bundledNodeDir = getBundledNodeDir();
  const essentialPaths: string[] = [];

  // Product-owned launchers and registered tool shims are authoritative over
  // stale npm/AppData/inherited commands with the same name.
  if (home) {
    essentialPaths.push(isWindows
      ? resolve(home, APP_DATA_DIR_NAME, 'bin')
      : `${home}/${APP_DATA_DIR_NAME}/bin`);
  }

  for (const dir of getSystemNodeDirs()) {
    if (existsSync(dir)) essentialPaths.push(dir);
  }
  if (bundledNodeDir) essentialPaths.push(bundledNodeDir);

  const npmGlobalBinDir = getMyAgentsNpmGlobalBinDir(home);
  if (npmGlobalBinDir) essentialPaths.push(npmGlobalBinDir);

  if (isWindows) {
    if (home) essentialPaths.push(resolve(home, '.bun', 'bin'));
    const programFiles = parentEnv.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = parentEnv['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = parentEnv.LOCALAPPDATA || '';
    essentialPaths.push(
      resolve(programFiles, 'Git', 'cmd'),
      resolve(programFilesX86, 'Git', 'cmd'),
      ...(localAppData ? [resolve(localAppData, 'Programs', 'Git', 'cmd')] : []),
    );
  } else {
    if (home) essentialPaths.push(`${home}/.bun/bin`);
    essentialPaths.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  }

  const existingPath = parentEnv[key] || parentEnv.PATH || '';
  const inheritedEntries = existingPath ? existingPath.split(separator).filter(Boolean) : [];
  const pathEquals = (left: string, right: string): boolean => isWindows
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
  const authoritativeEntries = essentialPaths.filter((candidate, index) => (
    candidate.length > 0
      && essentialPaths.findIndex(entry => pathEquals(entry, candidate)) === index
  ));
  // Remove inherited duplicates before prepending. Merely skipping a candidate
  // that already appeared later in PATH would preserve the stale shadow order.
  const entries = [
    ...authoritativeEntries,
    ...inheritedEntries.filter(entry => (
      !authoritativeEntries.some(candidate => pathEquals(candidate, entry))
    )),
  ];

  return {
    key,
    value: entries.join(separator),
    entries,
    bundledNodeDir,
  };
}
