import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
/**
 * store.ts — High-level plugin lifecycle: install / uninstall / toggle / list.
 *
 * This is the single owner of the disk → AppConfig coupling for plugins.
 * Every mutating operation goes through `withConfigLock` to keep cross-process
 * writes serialized. Read-only operations (list, manifest) just touch disk.
 *
 * SSE broadcast and SDK restart are handled by the caller (admin-api.ts) —
 * keeping store.ts free of transport concerns makes it usable from the CLI
 * path too (which talks to the same admin API rather than reaching in here
 * directly, but the separation makes test seams obvious).
 */

import { join, resolve } from 'path';
import { existsSync, readFileSync, renameSync, lstatSync, realpathSync } from 'fs';
import { randomUUID } from 'crypto';
import { stripBom } from '../../shared/utils';
import { workspacePathsEqual } from '../../shared/workspacePath';

import {
  atomicModifyProjects,
  withAgentConfigIntentLock,
  withConfigLock,
  loadConfig,
  type AdminAppConfig,
} from '../utils/admin-config';
import { getHomeDirOrNull } from '../utils/platform';
import {
  makePluginId,
  sanitizePluginIdForPath,
  type PluginEntry,
  type PluginListItem,
} from '../../shared/types/plugin';
import { resolvePluginUrl, PluginUrlError } from './url-resolver';
import { fetchPluginTree, PluginFetchError } from './fetcher';
import {
  analysePluginTree,
  writePluginToDisk,
  removeInstallPath,
  clearBrokenSymlinkAt,
  makeInstallPath,
  PluginInstallError,
} from './installer';
import {
  scanPluginComponents,
  readPluginManifestFromDir,
  isPluginRootDir,
  PluginManifestError,
} from './manifest';

export class PluginStoreError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.name = 'PluginStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * In-process registry of installs currently in flight (keyed by plugin
 * name). Set entries are added under `withConfigLock` after the conflict
 * re-check; uninstall consults this set so it can refuse "uninstall during
 * install" with a clear error rather than the deceptively-idempotent
 * "nothing to remove" reply. Cleared in installPlugin's finally block.
 */
const installingNames = new Set<string>();

/**
 * Reserved plugin names — they would collide with `~/.myagents/plugins/`'s
 * own structural children (e.g. `data/` is `getPluginsDataRoot()`; anything
 * starting with `.tmp-` is the install-staging convention below). Reject at
 * manifest-validation time so the install never lays a finger on disk.
 */
function assertNameNotReserved(name: string): void {
  if (name === 'data' || name.startsWith('.tmp-') || name.startsWith('.')) {
    throw new PluginStoreError(
      `插件名 "${name}" 是保留名，请改名后重装`,
      'RESERVED_NAME',
      422,
    );
  }
}

/** Resolved plugins root: ~/.myagents/plugins/ */
export function getPluginsRoot(): string {
  const home = getHomeDirOrNull();
  if (!home) throw new PluginStoreError('Cannot determine home directory', 'NO_HOME', 500);
  return join(home, APP_DATA_DIR_NAME, 'plugins');
}

/** ~/.myagents/plugins/data/ (parent for ${CLAUDE_PLUGIN_DATA}) */
export function getPluginsDataRoot(): string {
  return join(getPluginsRoot(), 'data');
}

// -----------------------------------------------------------------------------
// Install
// -----------------------------------------------------------------------------

export interface InstallReport {
  entry: PluginEntry;
}

/**
 * Inspect a source WITHOUT writing anything — used by the renderer's
 * install dialog to decide "show direct install" vs "show picker for
 * multi-plugin batch". Returns the same PluginAnalysis the install path
 * uses internally, so the renderer can switch behaviour symmetrically.
 *
 * NB: this re-downloads the tarball when the user later commits to
 * install (the install path is a separate call). For 13-plugin repos the
 * waste is ~one extra full download — acceptable for v1; cache TTL could
 * be added in v0.2.18 if it becomes painful.
 */
export async function inspectPluginSource(
  rawInput: string,
): Promise<import('./installer').PluginAnalysis> {
  let source;
  try {
    source = resolvePluginUrl(rawInput);
  } catch (err) {
    if (err instanceof PluginUrlError) {
      throw new PluginStoreError(err.message, 'INVALID_SOURCE', 400);
    }
    throw err;
  }

  let tree;
  try {
    tree = await fetchPluginTree(source);
  } catch (err) {
    if (err instanceof PluginFetchError) {
      throw new PluginStoreError(err.message, 'FETCH_FAILED', err.statusCode);
    }
    throw err;
  }

  const subPathHint = source.kind === 'remote' ? source.subPath : undefined;
  try {
    return analysePluginTree(tree, subPathHint);
  } catch (err) {
    if (err instanceof PluginManifestError) {
      throw new PluginStoreError(err.message, 'INVALID_MANIFEST', 422);
    }
    throw err;
  }
}

/**
 * Two absolute paths point at the same directory. `resolve` normalizes
 * `.`/`..`/trailing slashes; we lower-case on win32 because NTFS is
 * case-insensitive (a `file://…/Test-Echo` source vs a `test-echo`
 * install dir must still match). Exported for unit coverage of the #239
 * register-in-place gate.
 */
export function pathsEqual(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  // Case-fold on the case-insensitive default file systems (NTFS on Windows,
  // APFS/HFS+ on macOS). Without darwin case-folding, a `file://…/Test-Echo`
  // source vs a `test-echo` install dir would miss sameDirInstall and then
  // collide on renameSync → the original #239 409 (cross-review W3).
  return process.platform === 'win32' || process.platform === 'darwin'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

/**
 * Pure orchestration:
 *   1. Resolve URL/path → ResolvedPluginSource
 *   2. Fetch → ExtractedTree
 *   3. Analyse → PluginAnalysis
 *   4. Check conflict (name already installed)
 *   5. Clear any broken symlink at install path (Pit of Success red-line)
 *   6. Write disk (skipped when the source already IS the install dir)
 *   7. Update AppConfig (atomic, locked)
 *
 * Caller is responsible for SSE progress events around steps 1-3.
 */
export async function installPlugin(
  rawInput: string,
  opts: {
    onProgress?: (phase: 'fetching' | 'extracting' | 'validating' | 'writing', message?: string) => void;
    /**
     * Optional subPath override. When the caller knows the source contains
     * multiple plugins (multi-plugin tree) and wants to install one
     * specific candidate, pass its rootPath here. Overrides any subPath
     * the URL resolver derived from the input — useful for the batch
     * install path where the renderer iterates candidates from inspect.
     */
    subPath?: string;
  } = {},
): Promise<InstallReport> {
  const { onProgress } = opts;

  // 1 — resolve URL
  let source;
  try {
    source = resolvePluginUrl(rawInput);
  } catch (err) {
    if (err instanceof PluginUrlError) {
      throw new PluginStoreError(err.message, 'INVALID_SOURCE', 400);
    }
    throw err;
  }

  // 2 — fetch
  onProgress?.('fetching', source.displayName);
  let tree;
  try {
    tree = await fetchPluginTree(source);
  } catch (err) {
    if (err instanceof PluginFetchError) {
      throw new PluginStoreError(err.message, 'FETCH_FAILED', err.statusCode);
    }
    throw err;
  }
  onProgress?.('extracting');

  // 3 — analyse
  onProgress?.('validating');
  // Explicit opts.subPath wins over URL-derived (lets the multi-plugin
  // batch install path target a specific rootPath without rewriting URLs).
  const subPathHint = opts.subPath ?? (source.kind === 'remote' ? source.subPath : undefined);
  let analysis;
  try {
    analysis = analysePluginTree(tree, subPathHint);
  } catch (err) {
    if (err instanceof PluginManifestError) {
      throw new PluginStoreError(err.message, 'INVALID_MANIFEST', 422);
    }
    throw err;
  }
  if (analysis.mode === 'no-plugin') {
    throw new PluginStoreError(
      '未找到 .claude-plugin/plugin.json — 来源不是有效的 Claude 插件',
      'NO_PLUGIN_FOUND',
      422,
    );
  }
  if (analysis.mode === 'marketplace') {
    const list = analysis.pluginNames.length
      ? `（包含 ${analysis.pluginNames.length} 个插件：${analysis.pluginNames.slice(0, 3).join(', ')}${analysis.pluginNames.length > 3 ? '…' : ''}）`
      : '';
    throw new PluginStoreError(
      `这是一个 marketplace${list}，v0.2.17 暂不支持。请改用指向单个插件子目录的链接`,
      'MARKETPLACE_NOT_SUPPORTED',
      422,
    );
  }
  if (analysis.mode === 'multi-plugin') {
    throw new PluginStoreError(
      `检测到 ${analysis.candidates.length} 个插件根目录，请用「先 inspect 再选装」流程，或传入 subPath 指向单个候选`,
      'MULTI_PLUGIN',
      422,
    );
  }
  // 'plugin' mode confirmed
  const { manifest, rootPath } = analysis;

  // 4 — name & conflict pre-check (best-effort, re-checked under lock below).
  // assertNameNotReserved blocks names that collide with `data/` /
  // `.tmp-*` structural children before any disk touch.
  assertNameNotReserved(manifest.name);

  const pluginsRoot = getPluginsRoot();
  const installPath = makeInstallPath(pluginsRoot, manifest.name);
  const stagingPath = join(pluginsRoot, `.tmp-${randomUUID()}`);

  // #239: a local `file://` source can already BE the install target —
  // the user dropped a valid plugin straight into
  // ~/.myagents/plugins/<name> and ran `cc-plugin install file://…/<name>`.
  // In that case source === dest, so the staging→rename dance below would
  // (a) waste a copy and (b) 409 on `existsSync(installPath)` ("目录已存在")
  // without ever registering the plugin — leaving a dir on disk that
  // `cc-plugin list` can't see. Detect this and register in place instead.
  // Guard on `rootPath` being the tree root: if the plugin lives in a
  // subdir of the source, dest is a different path and the normal extract
  // flow is correct.
  const sameDirInstall =
    source.kind === 'local' &&
    (rootPath === '' || rootPath === '.') &&
    pathsEqual(source.absolutePath, installPath);

  // 5 — write to STAGING (not final path) so concurrent same-name installs
  // can't overwrite each other's bytes between conflict-check and config
  // commit. The rename → final happens inside withConfigLock below.
  // Skipped for the register-in-place case (nothing to copy).
  onProgress?.('writing');
  let staged = false;
  // True once the staging dir has been renamed INTO installPath but before the
  // config write commits. If withConfigLock then fails to persist config.json
  // (the rename happens inside the modifier, the write happens after it), the
  // dir is on disk with no config row → a future install of the same name hits
  // TARGET_EXISTS forever. On failure we roll the rename back. Never set for the
  // sameDirInstall path (no rename — must not delete the user's own dir).
  let movedIntoPlace = false;
  try {
    if (!sameDirInstall) {
      writePluginToDisk(stagingPath, tree, rootPath);
      staged = true;
      if (!isPluginRootDir(stagingPath)) {
        throw new PluginStoreError(
          '写盘后未在目标目录找到 plugin.json',
          'POST_WRITE_INVALID',
          500,
        );
      }
    }

    // 6 — atomic register: claim the name + flip rename inside the lock.
    // Two concurrent installs of the same `manifest.name` will both stage
    // to distinct .tmp-<uuid>/ dirs (no collision there), but only one
    // wins this critical section; the loser's stagingPath gets GC'd in
    // the outer finally.
    const entry: PluginEntry = {
      id: makePluginId(manifest.name, 'local'),
      name: manifest.name,
      source: 'local',
      sourceUrl: source.sourceUrl,
      installPath,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author?.name,
      homepage: manifest.homepage,
      repository: manifest.repository,
      license: manifest.license,
      installedAt: new Date().toISOString(),
    };

    await withConfigLock(async cfg => {
      const next: AdminAppConfig = { ...cfg };
      const list = (cfg.plugins as PluginEntry[] | undefined)?.slice() ?? [];
      if (list.some(p => p.name === manifest.name)) {
        throw new PluginStoreError(
          `插件 "${manifest.name}" 已被并发安装`,
          'ALREADY_INSTALLED',
          409,
        );
      }
      if (installingNames.has(manifest.name)) {
        throw new PluginStoreError(
          `插件 "${manifest.name}" 正在被另一个安装任务写入`,
          'INSTALL_IN_FLIGHT',
          409,
        );
      }
      installingNames.add(manifest.name);
      try {
        if (sameDirInstall) {
          // Register the already-present directory in place. It IS the
          // source (validated as a plugin root via fetch+analyse above), so
          // there is nothing to move — do NOT 409 on "目录已存在". Re-verify
          // the dir still holds plugin.json under the lock.
          if (!isPluginRootDir(installPath)) {
            throw new PluginStoreError(
              '安装目录缺少 .claude-plugin/plugin.json',
              'POST_WRITE_INVALID',
              500,
            );
          }
        } else {
          // installPath should not exist; if it does, someone left an orphan.
          // We refuse rather than clobber — the user can manually clean up.
          // clearBrokenSymlinkAt handles the dangling-symlink red-line case
          // (Pit of Success — Node v24 cpSync C++ abort) before we ask
          // existsSync.
          clearBrokenSymlinkAt(installPath);
          if (existsSync(installPath)) {
            throw new PluginStoreError(
              `目录已存在：${installPath}。请手动清理或选择其它来源`,
              'TARGET_EXISTS',
              409,
            );
          }
          renameSync(stagingPath, installPath);
          staged = false; // staging dir is gone — don't double-GC
          movedIntoPlace = true; // installPath now exists; roll back if commit fails
        }
      } catch (err) {
        installingNames.delete(manifest.name);
        if (err instanceof PluginStoreError) throw err;
        throw new PluginStoreError(
          `重命名安装目录失败：${(err as Error).message}`,
          'RENAME_FAILED',
          500,
        );
      }
      list.push(entry);
      next.plugins = list;
      const enabled = { ...((cfg.enabledPlugins as Record<string, boolean> | undefined) ?? {}) };
      enabled[entry.id] = true; // new installs default to enabled
      next.enabledPlugins = enabled;
      return next;
    });
    installingNames.delete(manifest.name);
    return { entry };
  } catch (err) {
    installingNames.delete(manifest.name);
    // Translate inner errors into PluginStoreError shape and clean staging.
    if (staged) {
      try { removeInstallPath(stagingPath); } catch { /* best-effort */ }
    }
    // W4 rollback: the rename into installPath succeeded but the config commit
    // did not (withConfigLock is atomic, so reaching here means config.json was
    // NOT updated). Remove the orphaned dir so a retry isn't blocked by its own
    // half-finished prior attempt. Only fires on the rename path — sameDirInstall
    // never sets movedIntoPlace, so the user's own dir is never deleted.
    if (movedIntoPlace) {
      try { removeInstallPath(installPath); } catch { /* best-effort */ }
    }
    if (err instanceof PluginInstallError) {
      throw new PluginStoreError(err.message, err.code, err.statusCode);
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Uninstall
// -----------------------------------------------------------------------------

export interface UninstallOpts {
  purgeData?: boolean;
}

export async function uninstallPlugin(
  pluginId: string,
  opts: UninstallOpts = {},
): Promise<{ removed: PluginEntry | null; warning?: string }> {
  let removed: PluginEntry | null = null;
  await withConfigLock(async cfg => {
    const next: AdminAppConfig = { ...cfg };
    const list = (cfg.plugins as PluginEntry[] | undefined)?.slice() ?? [];
    const idx = list.findIndex(p => p.id === pluginId);
    if (idx === -1) {
      // Idempotent uninstall — return without error, UNLESS we know an
      // install is racing with this uninstall on the same name (would
      // otherwise let the install complete and re-add what the user
      // explicitly removed → "ghost install").
      const namePart = pluginId.split('@')[0];
      if (namePart && installingNames.has(namePart)) {
        throw new PluginStoreError(
          `插件 "${namePart}" 正在被安装；请等安装完成再卸载`,
          'INSTALL_IN_FLIGHT',
          409,
        );
      }
      return cfg;
    }
    // Outer `removed` capture — annotated assignment to defeat TS's
    // overly-aggressive narrowing inside async closures.
    removed = list[idx] as PluginEntry;
    list.splice(idx, 1);
    next.plugins = list;
    const enabled = { ...((cfg.enabledPlugins as Record<string, boolean> | undefined) ?? {}) };
    delete enabled[pluginId];
    next.enabledPlugins = enabled;
    if (opts.purgeData) {
      const configs = { ...((cfg.pluginConfigs as Record<string, unknown> | undefined) ?? {}) };
      delete configs[pluginId];
      next.pluginConfigs = configs;
    }
    return next;
  });

  // TS narrows `removed` to `null` based on the only synchronous assignment
  // it sees (the closure body executes asynchronously). The explicit cast
  // surfaces the real type that the awaited closure populated.
  const removedRef = removed as PluginEntry | null;
  const warnings: string[] = [];
  if (removedRef) {
    // Disk cleanup happens AFTER config write — if it fails, we re-removed
    // a stale entry rather than left an orphaned disk dir with no config row.
    // Surface failure in the response so the caller can show "manual cleanup
    // needed" — previously swallowed → permanent TARGET_EXISTS on reinstall.
    try {
      removeInstallPath(removedRef.installPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[plugins] uninstall: removeInstallPath failed:', err);
      warnings.push(`安装目录未能删除 (${msg})，需手动 rm -rf ${removedRef.installPath}`);
    }
    if (opts.purgeData) {
      try {
        const dataDir = join(getPluginsDataRoot(), sanitizePluginIdForPath(pluginId));
        removeInstallPath(dataDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[plugins] uninstall: purge data dir failed:', err);
        warnings.push(`数据目录未能删除 (${msg})`);
      }
    }
  }
  return warnings.length > 0
    ? { removed: removedRef, warning: warnings.join('; ') }
    : { removed: removedRef };
}

// -----------------------------------------------------------------------------
// Toggle
// -----------------------------------------------------------------------------

/**
 * Set the per-workspace enable list (Agent.enabledPluginIds preferred;
 * falls back to Project.enabledPluginIds if no Agent matches the path).
 * Used by both the Agent settings panel and the chat-input "插件" submenu
 * — single source of truth, two UI surfaces.
 *
 * Returns the final persisted list and which scope was written
 * ('agent' | 'project' | 'none' if neither matched). Caller should also
 * push to the active sidecar via setSessionEnabledPluginIds so changes
 * take effect immediately.
 */
export async function setWorkspaceEnabledPlugins(
  workspacePath: string,
  enabledIds: string[],
): Promise<{ scope: 'agent' | 'project' | 'none'; ids: string[] }> {
  if (!workspacePath) {
    throw new PluginStoreError('workspacePath 必填', 'INVALID_WORKSPACE', 400);
  }
  const dedup = Array.from(new Set(enabledIds));
  let scope: 'agent' | 'project' | 'none' = 'none';
  await withAgentConfigIntentLock(async () => {
    let agentId: string | undefined;
    await atomicModifyProjects(projects => {
      const matches = projects
        .map((project, index) => ({ project, index }))
        .filter(entry => workspacePathsEqual(entry.project.path, workspacePath));
      if (matches.length !== 1) return projects;
      const { project, index } = matches[0];
      agentId = project.agentId;
      const next = [...projects];
      next[index] = { ...project, enabledPluginIds: dedup };
      scope = agentId ? 'agent' : 'project';
      return next;
    });

    if (!agentId) return;
    await withConfigLock(async cfg => {
      const agents = cfg.agents ?? [];
      const idx = agents.findIndex(agent => agent.id === agentId);
      if (idx === -1) return cfg;
      const next = { ...cfg };
      const newAgents = agents.slice();
      newAgents[idx] = { ...agents[idx], enabledPluginIds: dedup };
      next.agents = newAgents;
      return next;
    });
  });
  return { scope, ids: dedup };
}

export async function togglePlugin(
  pluginId: string,
  enabled: boolean,
): Promise<{ entry: PluginEntry; enabled: boolean }> {
  let entry: PluginEntry | null = null;
  await withConfigLock(async cfg => {
    const next: AdminAppConfig = { ...cfg };
    const list = (cfg.plugins as PluginEntry[] | undefined) ?? [];
    const found = list.find(p => p.id === pluginId);
    if (!found) {
      throw new PluginStoreError(`插件未安装：${pluginId}`, 'NOT_FOUND', 404);
    }
    entry = found;
    const map = { ...((cfg.enabledPlugins as Record<string, boolean> | undefined) ?? {}) };
    map[pluginId] = enabled;
    next.enabledPlugins = map;
    return next;
  });
  if (!entry) {
    throw new PluginStoreError(`插件未安装：${pluginId}`, 'NOT_FOUND', 404);
  }
  return { entry, enabled };
}

// -----------------------------------------------------------------------------
// List / read
// -----------------------------------------------------------------------------

/** Quick read — no deep disk scans. Includes a lightweight `mcpServerNames`
 *  field per entry so the chat-input plugin submenu can show "包含 N 个 MCP
 *  server" without a second round-trip. The scan is bounded by
 *  scanPluginComponents and only touches a handful of files per plugin. */
export function listInstalledPlugins(): PluginListItem[] {
  const cfg = loadConfig();
  const entries = (cfg.plugins as PluginEntry[] | undefined) ?? [];
  const enabledMap = (cfg.enabledPlugins as Record<string, boolean> | undefined) ?? {};
  return entries.map(entry => {
    let status: 'ok' | 'missing' | 'invalid' = 'ok';
    let warning: string | undefined;
    let mcpServerNames: string[] | undefined;
    if (!existsSync(entry.installPath)) {
      status = 'missing';
      warning = '安装目录已被外部删除';
    } else if (!isPluginRootDir(entry.installPath)) {
      status = 'invalid';
      warning = '安装目录缺少 .claude-plugin/plugin.json';
    } else {
      // Cheap: just scan .mcp.json (avoids the full component walk).
      try {
        const comp = scanPluginComponents(entry.installPath);
        if (comp.mcpServers.length > 0) mcpServerNames = comp.mcpServers;
      } catch {
        /* non-fatal — leave mcpServerNames undefined */
      }
    }
    return {
      ...entry,
      dataPath: join(getPluginsDataRoot(), sanitizePluginIdForPath(entry.id)),
      enabled: enabledMap[entry.id] === true,
      status,
      warning,
      mcpServerNames,
    };
  });
}

/** Resolve a plugin id → PluginListItem (with live components inventory). */
export function getPluginDetail(pluginId: string): PluginListItem | null {
  const items = listInstalledPlugins();
  const item = items.find(p => p.id === pluginId);
  if (!item) return null;
  // Refresh manifest from disk for the detail panel
  try {
    if (item.status === 'ok') {
      const fresh = readPluginManifestFromDir(item.installPath);
      if (fresh) {
        item.version = fresh.version ?? item.version;
        item.description = fresh.description ?? item.description;
        item.author = fresh.author?.name ?? item.author;
        item.homepage = fresh.homepage ?? item.homepage;
        item.repository = fresh.repository ?? item.repository;
        item.license = fresh.license ?? item.license;
      }
      item.components = scanPluginComponents(item.installPath);
    }
  } catch {
    /* surface as warning rather than throwing */
    item.warning = item.warning ?? 'manifest 读取失败';
  }
  return item;
}

/**
 * Compute the list of SDK plugin paths to inject as `Options.plugins`.
 * Two-layer filter (mirrors MCP):
 *
 *   1. Layer 1 — global visibility gate (AppConfig.enabledPlugins[id] === true)
 *   2. Layer 2 — per-context enable list (caller passes the IDs)
 *      - For builtin Sidecar: pass the current session's enabled plugin IDs
 *        (initially derived from Agent.enabledPluginIds; per-Tab UI can
 *        override transiently)
 *      - Pass `null` / undefined to skip Layer 2 (all globally visible plugins
 *        load) — only used in unit tests and the `/api/cc-plugin/list` debug
 *        path.
 *
 * Path safety: skips entries that (a) don't exist on disk, (b) lack
 * .claude-plugin/plugin.json, or (c) are symlinks (defends against
 * post-install symlink-swap attack).
 */
export function getEnabledPluginSdkConfigs(
  contextEnabledIds?: readonly string[] | null,
): { type: 'local'; path: string }[] {
  const cfg = loadConfig();
  const entries = (cfg.plugins as PluginEntry[] | undefined) ?? [];
  const visibilityMap = (cfg.enabledPlugins as Record<string, boolean> | undefined) ?? {};
  const contextSet = contextEnabledIds == null ? null : new Set(contextEnabledIds);
  const out: { type: 'local'; path: string }[] = [];
  for (const p of entries) {
    // Layer 1: visibility gate
    if (visibilityMap[p.id] !== true) continue;
    // Layer 2: per-context enable
    if (contextSet !== null && !contextSet.has(p.id)) continue;
    if (!existsSync(p.installPath)) continue;
    if (!isPluginRootDir(p.installPath)) continue;
    // Post-install symlink-swap defense: lstat (not stat) rejects a path
    // where someone replaced the install dir with a symlink. realpath the
    // canonical install path and refuse mismatches — if an attacker swapped
    // ~/.myagents/plugins/foo → /tmp/evil, we won't hand /tmp/evil to SDK.
    try {
      const lst = lstatSync(p.installPath);
      if (lst.isSymbolicLink()) {
        console.warn(`[plugins] skip ${p.id}: installPath is a symlink`);
        continue;
      }
      const canon = realpathSync(p.installPath);
      if (canon !== p.installPath) {
        console.warn(`[plugins] skip ${p.id}: installPath canonical (${canon}) ≠ stored (${p.installPath})`);
        continue;
      }
    } catch {
      continue;
    }
    out.push({ type: 'local' as const, path: p.installPath });
  }
  return out;
}

/**
 * Resolve the default enabled-plugin IDs for a workspace path by looking up
 * the matching Agent (preferred) or Project (fallback). Returns an empty
 * array when neither has the field set — UI is the source of truth for
 * per-workspace selection. Layer 1 visibility gate is NOT applied here
 * (caller decides when to gate).
 */
export function getDefaultEnabledPluginIdsForWorkspace(workspacePath: string): string[] {
  if (!workspacePath) return [];
  try {
    const cfg = loadConfig();
    const home = getHomeDirOrNull();
    if (!home) return [];
    const projectsPath = resolve(home, APP_DATA_DIR_NAME, 'projects.json');
    if (!existsSync(projectsPath)) return [];
    const projects = JSON.parse(stripBom(readFileSync(projectsPath, 'utf-8'))) as Array<{
      agentId?: string;
      path?: string;
      enabledPluginIds?: string[];
    }>;
    const project = Array.isArray(projects)
      ? projects.find(p => workspacePathsEqual(p.path, workspacePath))
      : null;
    const agent = project?.agentId
      ? (cfg.agents ?? []).find(candidate => candidate.id === project.agentId)
      : undefined;
    if (agent?.enabledPluginIds) return [...agent.enabledPluginIds];
    return project?.enabledPluginIds ? [...project.enabledPluginIds] : [];
  } catch {
    return [];
  }
}
