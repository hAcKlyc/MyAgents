import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
import { existsSync, lstatSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'fs';
import type { Stats } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

import { isCliToolRegistryEnabled, loadConfig as loadAdminConfig } from './admin-config';
import { ensureDirSync } from './fs-utils';
import { getCrossPlatformEnv } from './platform';
import type { EffectiveProjectCapabilitySnapshot } from '../../shared/projectCapabilities';
import { workspacePathsEqual } from '../../shared/workspacePath';
import {
  createGlobalSkillInventorySnapshot,
  type GlobalSkillInventorySnapshot,
} from '../global-skill-inventory';

const MYAGENTS_USER_DIR = APP_DATA_DIR_NAME;

/**
 * Get the MyAgents user directory path.
 * All user configs (MCP, providers, projects, etc.) are stored here.
 */
export function getMyAgentsUserDir(): string {
  const { home, temp } = getCrossPlatformEnv();
  const homeDir = home || temp;
  return join(homeDir, MYAGENTS_USER_DIR);
}

export interface ProjectUserConfigSyncOptions {
  cliToolRegistryEnabled?: boolean;
  /** Reuse the exact inventory admitted by the capability resolver. */
  globalSkillInventory?: GlobalSkillInventorySnapshot;
  /** Keep the shared disk projection aligned with project-over-global winners. */
  capabilitySnapshot?: EffectiveProjectCapabilitySnapshot;
}

export interface ProjectUserConfigSyncResult {
  changed: boolean;
  /** Canonical names whose project disk entry could not be made unambiguous. */
  unavailableSkillNames: string[];
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function removeSymlinkPath(path: string): void {
  // Unlink the directory entry itself. A recursive path operation could delete
  // a real project directory if another process replaces the proven link.
  unlinkSync(path);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function resolvedSymlinkTarget(linkPath: string): string | null {
  try {
    const target = readlinkSync(linkPath);
    return resolve(join(linkPath, '..'), target);
  } catch {
    return null;
  }
}

export function isManagedSymlink(linkPath: string, managedRoot: string): boolean {
  const meta = lstatIfPresent(linkPath);
  if (!meta?.isSymbolicLink()) return false;
  const target = resolvedSymlinkTarget(linkPath);
  return target !== null && isInside(managedRoot, target);
}

function symlinkPointsTo(linkPath: string, expectedTarget: string): boolean {
  const target = resolvedSymlinkTarget(linkPath);
  return target !== null && workspacePathsEqual(target, resolve(expectedTarget));
}

function handleProjectionFailure(message: string, error?: unknown): void {
  const reason = error instanceof Error ? error.message : error ? String(error) : '';
  if (reason) console.warn(`${message}: ${reason}`);
  else console.warn(message);
}

function isMissingPathError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

export function trySyncProjectUserConfigFiles(
  projectDir: string,
  options: ProjectUserConfigSyncOptions = {},
  logPrefix = 'project-user-config-sync',
): ProjectUserConfigSyncResult {
  try {
    return syncProjectUserConfigFiles(projectDir, options);
  } catch (err) {
    console.warn(
      `[${logPrefix}] project user config sync failed; continuing without refreshed .claude config:`,
      err instanceof Error ? err.message : String(err),
    );
    return {
      changed: false,
      unavailableSkillNames: [...new Set(
        options.capabilitySnapshot?.enabledSkills.map(skill => skill.canonicalName)
        ?? options.globalSkillInventory?.projectableEntries.map(skill => skill.name)
        ?? [],
      )].sort(),
    };
  }
}

/**
 * Sync user-level skills and commands into a project's .claude/ as symlinks.
 *
 * This is the shared disk bridge used by builtin Claude SDK sessions and
 * external runtimes that want to consume the same MyAgents-managed project
 * protocol. It only mutates symlinks that point back into ~/.myagents and
 * never overwrites real project skill/command entries.
 */
export function syncProjectUserConfigFiles(
  projectDir: string,
  options: ProjectUserConfigSyncOptions = {},
): ProjectUserConfigSyncResult {
  const myagentsDir = getMyAgentsUserDir();
  const isWin = process.platform === 'win32';
  let changed = false;
  const unavailableSkillNames = new Set<string>();

  const userSkillsDir = join(myagentsDir, 'skills');
  const projectSkillsDir = join(projectDir, '.claude', 'skills');
  const cliToolRegistryEnabled = options.cliToolRegistryEnabled ?? isCliToolRegistryEnabled(loadAdminConfig());
  const globalSkillInventory = options.globalSkillInventory
    ?? createGlobalSkillInventorySnapshot({ rootPath: userSkillsDir, cliToolRegistryEnabled });
  if (!workspacePathsEqual(globalSkillInventory.rootPath, userSkillsDir)) {
    throw new Error('Global Skill inventory does not belong to the configured Skill root');
  }
  const admittedGlobalSkillFolders = options.capabilitySnapshot
    ? new Set(options.capabilitySnapshot.candidates
        .filter(candidate => candidate.kind === 'skill' && candidate.source === 'global')
        .map(candidate => candidate.sourceLocalId))
    : null;
  const projectableGlobalSkills = globalSkillInventory.projectableEntries.filter(entry => (
    !admittedGlobalSkillFolders || admittedGlobalSkillFolders.has(entry.folderName)
  ));
  const globalSkillNameByFolder = new Map(
    globalSkillInventory.entries.map(entry => [entry.folderName, entry.name]),
  );

  if (existsSync(userSkillsDir) || existsSync(projectSkillsDir)) {
    ensureDirSync(projectSkillsDir);
    const managedSkillNames = new Set(
      projectableGlobalSkills.map(entry => entry.folderName),
    );

    for (const entry of projectableGlobalSkills) {
      const target = join(userSkillsDir, entry.folderName);
      const linkPath = join(projectSkillsDir, entry.folderName);

      try {
        const linkMeta = lstatIfPresent(linkPath);
        if (linkMeta) {
          if (!linkMeta.isSymbolicLink()) continue;
          if (!isManagedSymlink(linkPath, userSkillsDir)) {
            handleProjectionFailure(`[skill-sync] Foreign project symlink blocks global Skill ${entry.folderName}`);
            unavailableSkillNames.add(entry.name);
            continue;
          }
          if (symlinkPointsTo(linkPath, target)) continue;
          removeSymlinkPath(linkPath);
          changed = true;
        }
      } catch (error) {
        handleProjectionFailure(`[skill-sync] Failed to prepare Skill link ${entry.folderName}`, error);
        unavailableSkillNames.add(entry.name);
      }

      try {
        symlinkSync(target, linkPath, isWin ? 'junction' : undefined);
        changed = true;
      } catch (err) {
        // Another Sidecar may have won the same create race. Convergence on
        // the exact managed target is success; any other occupant still fails.
        if (!symlinkPointsTo(linkPath, target)) {
          handleProjectionFailure(`[skill-sync] Failed to symlink Skill ${entry.folderName}`, err);
          unavailableSkillNames.add(entry.name);
        }
      }
    }

    try {
      for (const entry of readdirSync(projectSkillsDir, { withFileTypes: true })) {
        const linkPath = join(projectSkillsDir, entry.name);
        try {
          if (!lstatSync(linkPath).isSymbolicLink()) continue;
          const target = readlinkSync(linkPath);
          const resolvedTarget = resolve(projectSkillsDir, target);
          if (!isInside(userSkillsDir, resolvedTarget)) {
            // Project-owned Skill links are valid project candidates. They are
            // preserved here; capability resolution decides their canonical
            // winner exactly like a real project directory.
            continue;
          }
          if (isInside(userSkillsDir, resolvedTarget) && !managedSkillNames.has(entry.name)) {
            removeSymlinkPath(linkPath);
            changed = true;
          }
        } catch (error) {
          if (!isMissingPathError(error)) {
            handleProjectionFailure(`[skill-sync] Failed to clean stale Skill link ${entry.name}`, error);
            const canonicalName = globalSkillNameByFolder.get(entry.name);
            if (canonicalName) unavailableSkillNames.add(canonicalName);
          }
        }
      }
    } catch (error) {
      handleProjectionFailure('[skill-sync] Failed to inspect project Skill links', error);
      for (const entry of projectableGlobalSkills) {
        unavailableSkillNames.add(entry.name);
      }
    }
  }

  const userCommandsDir = join(myagentsDir, 'commands');
  const projectCommandsDir = join(projectDir, '.claude', 'commands');

  if (existsSync(userCommandsDir)) {
    try {
      ensureDirSync(projectCommandsDir);
      const managedCommandFiles = new Set<string>();

      for (const entry of readdirSync(userCommandsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        if (entry.name.startsWith('.')) continue;

        managedCommandFiles.add(entry.name);
        const linkPath = join(projectCommandsDir, entry.name);
        const target = join(userCommandsDir, entry.name);

        try {
          const linkMeta = lstatIfPresent(linkPath);
          if (linkMeta) {
            if (!linkMeta.isSymbolicLink()) continue;
            if (!isManagedSymlink(linkPath, userCommandsDir)) {
              handleProjectionFailure(`[command-sync] Foreign project symlink blocks global Command ${entry.name}`);
              continue;
            }
            if (symlinkPointsTo(linkPath, target)) continue;
            removeSymlinkPath(linkPath);
            changed = true;
          }
        } catch (error) {
          handleProjectionFailure(`[command-sync] Failed to prepare Command link ${entry.name}`, error);
        }

        try {
          symlinkSync(target, linkPath);
          changed = true;
        } catch (err) {
          if (!symlinkPointsTo(linkPath, target)) {
            handleProjectionFailure(`[command-sync] Failed to symlink Command ${entry.name}`, err);
          }
        }
      }

      try {
        for (const entry of readdirSync(projectCommandsDir, { withFileTypes: true })) {
          const linkPath = join(projectCommandsDir, entry.name);
          try {
            if (!lstatSync(linkPath).isSymbolicLink()) continue;
            const target = readlinkSync(linkPath);
            const resolvedTarget = resolve(projectCommandsDir, target);
            if (!isInside(userCommandsDir, resolvedTarget)) {
              handleProjectionFailure(`[command-sync] Foreign project Command symlink is not a trusted capability: ${entry.name}`);
              continue;
            }
            if (isInside(userCommandsDir, resolvedTarget) && !managedCommandFiles.has(entry.name)) {
              removeSymlinkPath(linkPath);
              changed = true;
            }
          } catch (error) {
            if (!isMissingPathError(error)) {
              handleProjectionFailure(`[command-sync] Failed to clean stale Command link ${entry.name}`, error);
            }
          }
        }
      } catch (error) {
        handleProjectionFailure('[command-sync] Failed to inspect project Command links', error);
      }
    } catch (error) {
      handleProjectionFailure('[command-sync] Failed to reconcile project Commands', error);
    }
  }

  if (changed) console.info('[project-user-config-sync] reconcile=changed');
  return { changed, unavailableSkillNames: [...unavailableSkillNames].sort() };
}
