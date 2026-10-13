import { APP_CLI_NAME, APP_DATA_DIR_NAME } from '../../shared/appProfile';
/**
 * CLI 工具注册表（PRD 0.2.36 cli_first_tool_registry）。
 *
 * 磁盘布局：
 *   ~/.myagents/tools/<name>/          工具目录（tool.json + entry，自包含）
 *   ~/.myagents/tools/registry.json    产品侧状态（enabled/registeredAt）+ description 缓存
 *   ~/.myagents/bin/<name>             POSIX 启动器（shim，已在所有 runtime 与终端的 PATH 上）
 *   ~/.myagents/bin/<name>.cmd         Windows 启动器（+ <name>.launcher.cjs）
 *
 * 关键设计：
 * - registry.json 是单写者文件 → 所有写入走 withFileLock（pit_of_success.md#withfilelock）。
 * - shim 是运行时读 config.json 注入 per-tool env 的薄启动器：env 变更不需要
 *   重写 shim、密钥不烤进脚本文件（config.json 本就是本地明文，不扩大暴露面）。
 * - prompt 注入走 mtime 缓存的同步读（buildSystemPromptAppend 是同步函数，
 *   模式照抄 model-capabilities 的 mtime 缓存）。
 */
import {
  closeSync, chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import {
  CLI_TOOL_PROMPT_MAX_TOOLS,
  validateCliToolManifest,
  type CliToolManifest,
  type CliToolRegistryEntry,
  type CliToolRegistryFile,
} from '../../shared/types/cliTools';
import { withFileLock } from './file-lock';
import { getHomeDirOrNull } from './platform';
import { getBundledNodePath } from './runtime';

// ===== 路径 =====

function getMyAgentsDir(): string {
  const home = getHomeDirOrNull();
  if (!home) throw new Error('Cannot determine home directory');
  return resolve(home, APP_DATA_DIR_NAME);
}

export function getCliToolsDir(): string {
  return join(getMyAgentsDir(), 'tools');
}

export function getCliToolsRegistryPath(): string {
  return join(getCliToolsDir(), 'registry.json');
}

export function getCliToolsBinDir(): string {
  return join(getMyAgentsDir(), 'bin');
}

// ===== Registry 读写 =====

// 每次返回新对象：共享常量会被未来调用方的原地 mutation 污染成跨调用幽灵状态
const emptyRegistry = (): CliToolRegistryFile => ({ version: 1, tools: [] });

/** 单条目结构校验：手工损坏的 registry 不能让 prompt 构建热路径抛 TypeError */
function isValidRegistryEntry(t: unknown): t is CliToolRegistryEntry {
  if (!t || typeof t !== 'object') return false;
  const e = t as Record<string, unknown>;
  return typeof e.name === 'string'
    && typeof e.description === 'string'
    && typeof e.dir === 'string'
    && typeof e.entryPath === 'string'
    && typeof e.enabled === 'boolean';
}

/** 容错读：文件缺失/损坏 → 空注册表；坏条目逐条丢弃（registry 只是缓存+状态，可重建） */
export function readCliToolsRegistry(): CliToolRegistryFile {
  try {
    const raw = readFileSync(getCliToolsRegistryPath(), 'utf-8');
    const parsed = JSON.parse(raw) as CliToolRegistryFile;
    if (!parsed || !Array.isArray(parsed.tools)) return emptyRegistry();
    return { version: 1, tools: parsed.tools.filter(isValidRegistryEntry) };
  } catch {
    return emptyRegistry();
  }
}

/**
 * 串行修改 registry（单写者文件红线：withFileLock 内 fresh-read → modify → 原子写）。
 * modifier 返回 null 表示放弃写入。
 */
export async function modifyCliToolsRegistry(
  modifier: (registry: CliToolRegistryFile) => CliToolRegistryFile | null,
): Promise<CliToolRegistryFile> {
  const registryPath = getCliToolsRegistryPath();
  mkdirSync(getCliToolsDir(), { recursive: true });
  return await withFileLock({ lockPath: registryPath + '.lock' }, async () => {
    const current = readCliToolsRegistry();
    const next = modifier(current);
    if (next === null) return current;
    // fsync 后 rename（writeFileAtomic 内做）：registry 是 prompt 注入的数据源，
    // 半写状态会让所有新 session 的工具清单静默消失
    writeFileAtomic(registryPath, JSON.stringify(next, null, 2));
    // 写侧顺手清本进程 prompt 缓存：粗粒度 mtime 文件系统上同尺寸快写可能骗过
    // mtime+size 检查（跨 sidecar 本就靠下次 session start，单进程内消除窗口）
    promptCache = null;
    return next;
  });
}

// ===== Manifest 读取 =====

export type ManifestReadResult =
  | { ok: true; manifest: CliToolManifest }
  | { ok: false; code: string; error: string; recovery?: string };

export function readCliToolManifest(toolDir: string): ManifestReadResult {
  const manifestPath = join(toolDir, 'tool.json');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch {
    return {
      ok: false,
      code: 'MANIFEST_NOT_FOUND',
      error: `tool.json not found in ${toolDir}`,
      recovery: 'A registerable tool dir must contain tool.json + the entry script. See the tool-creator skill.',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, code: 'MANIFEST_PARSE_ERROR', error: `tool.json is not valid JSON: ${(e as Error).message}` };
  }
  const valid = validateCliToolManifest(parsed);
  if (!valid.ok) return { ok: false, code: valid.code, error: valid.error, recovery: valid.recovery };
  const manifest = parsed as CliToolManifest;
  const entryPath = join(toolDir, manifest.entry);
  // lstat（不跟随 symlink）：entry 是 symlink 时实际代码体在工具目录之外，
  // 事后可被静默替换、绕过注册时刻的审查——"自包含"承诺被打破，直接打回
  let entryStat;
  try {
    entryStat = lstatSync(entryPath);
  } catch {
    return { ok: false, code: 'ENTRY_NOT_FOUND', error: `entry script "${manifest.entry}" not found in ${toolDir}` };
  }
  if (entryStat.isSymbolicLink()) {
    return {
      ok: false,
      code: 'ENTRY_SYMLINK',
      error: `entry script "${manifest.entry}" is a symlink — the tool must be self-contained (real files inside the tool dir)`,
      recovery: 'Replace the symlink with the actual file and re-run tool add.',
    };
  }
  return { ok: true, manifest };
}

/**
 * CLI tools must be self-contained real files. A symlink anywhere in the tree
 * can either escape the source directory during copy or turn into a mutable
 * runtime dependency after registration.
 */
export function assertCliToolTreeSelfContained(toolDir: string): void {
  const root = resolve(toolDir);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`tool dir is a symlink: ${root}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`tool dir is not a directory: ${root}`);
  }

  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        throw new Error(`tool dir contains symlink: ${p}`);
      }
      if (st.isDirectory()) visit(p);
    }
  };
  visit(root);
}

// ===== 命名遮蔽检测 =====

/**
 * 扫 PATH 找同名可执行（排除我们自己的 bin 目录）。
 * ~/.myagents/bin 在 PATH 中先于系统路径（buildClaudeSessionEnv），
 * 命中即意味着注册会静默遮蔽既有命令 → 必须打回。
 *
 * effectivePath：调用方 MUST 传 agent session 实际生效的 PATH（`ensureShellPath()`）。
 * sidecar 由 Tauri/Finder 启动时 process.env.PATH 是 launchd 最小集（不含
 * /opt/homebrew/bin 等），裸用它会让 brew 安装的命令（ffmpeg/jq/gh）全部漏检。
 * 动态检测是 best-effort，保底是保留名黑名单。
 */
export function findPathCollision(name: string, effectivePath?: string): string | null {
  const ownBin = resolve(getCliToolsBinDir());
  const pathEnv = effectivePath ?? process.env.PATH ?? '';
  const candidates = process.platform === 'win32'
    ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
    : [name];
  // 显式补上 MyAgents 自有的 AI 自装 CLI 落点，防止注册工具遮蔽 AI 装过的命令
  const extraDirs = [join(getMyAgentsDir(), 'npm-global', 'bin')];
  for (const dir of [...pathEnv.split(delimiter), ...extraDirs]) {
    if (!dir) continue;
    let resolved: string;
    try {
      resolved = resolve(dir);
    } catch {
      continue;
    }
    if (resolved === ownBin) continue;
    for (const candidate of candidates) {
      if (existsSync(join(resolved, candidate))) return join(resolved, candidate);
    }
  }
  return null;
}

// ===== Shim（启动器）=====

/**
 * 启动器内容（CJS）：运行时读 config.json 的 cliToolEnv 注入 env，再 spawn 入口。
 * - CJS 而非 ESM：POSIX shim 是无扩展名文件，node 按 CJS 解释（bin 目录无 package.json）。
 * - process.execPath：用启动 shim 的那个 node 跑入口，天然解决 node 定位。
 */
export function buildLauncherSource(name: string, entryPath: string): string {
  return `#!/usr/bin/env node
// Auto-generated by \`${APP_CLI_NAME} tool add\` — do not edit (re-running tool add regenerates it).
// Launcher for ${JSON.stringify(name)}: injects per-tool env from ~/${APP_DATA_DIR_NAME}/config.json
// (cliToolEnv[${JSON.stringify(name)}]) at runtime, then runs the tool entry.
'use strict';
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const TOOL_NAME = ${JSON.stringify(name)};
const ENTRY = ${JSON.stringify(entryPath)};

let toolEnv = {};
try {
  const cfg = JSON.parse(readFileSync(join(homedir(), ${JSON.stringify(APP_DATA_DIR_NAME)}, 'config.json'), 'utf8'));
  if (cfg && cfg.cliToolEnv && cfg.cliToolEnv[TOOL_NAME]) toolEnv = cfg.cliToolEnv[TOOL_NAME];
} catch {
  // config 缺失/损坏：不带注入 env 直接跑（工具自己会对缺 key 给出退出码 3 + remediation）
}

const result = spawnSync(process.execPath, [ENTRY, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ...toolEnv },
});
if (result.error) {
  console.error('[myagents-tool] failed to launch ' + TOOL_NAME + ': ' + result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
`;
}

export function buildWindowsCmdSource(name: string, bundledNodePath: string | null): string {
  // pin-with-fallback（用户工具 shim 容忍外部安装位漂移；官方 myagents
  // launcher 由 Rust bundle authority 管理，不复用这条 fallback）：
  // 优先用 shim 写入时的内置 node 绝对路径（裸终端无 node 也能跑）；
  // 该路径随更新失效时回落 PATH 上的 node（Agent session / 内嵌终端必有）。
  if (bundledNodePath) {
    return `@echo off\r\nif exist "${bundledNodePath}" ("${bundledNodePath}" "%~dp0${name}.launcher.cjs" %*) else (node "%~dp0${name}.launcher.cjs" %*)\r\n`;
  }
  return `@echo off\r\nnode "%~dp0${name}.launcher.cjs" %*\r\n`;
}

/** 写 shim（幂等覆盖）。POSIX: bin/<name>；Windows: bin/<name>.cmd + bin/<name>.launcher.cjs */
export function writeCliToolShim(name: string, entryPath: string): void {
  const binDir = getCliToolsBinDir();
  mkdirSync(binDir, { recursive: true });
  const launcher = buildLauncherSource(name, entryPath);
  if (process.platform === 'win32') {
    writeFileAtomic(join(binDir, `${name}.launcher.cjs`), launcher);
    writeFileAtomic(join(binDir, `${name}.cmd`), buildWindowsCmdSource(name, getBundledNodePath()));
  } else {
    const shimPath = join(binDir, name);
    writeFileAtomic(shimPath, launcher);
    chmodSync(shimPath, 0o755);
  }
}

export function removeCliToolShim(name: string): void {
  const binDir = getCliToolsBinDir();
  for (const file of [name, `${name}.cmd`, `${name}.launcher.cjs`]) {
    const p = join(binDir, file);
    try {
      // lstat 探针（不跟随 symlink）：断链 symlink 用 existsSync 会误判为不存在（pit_of_success.md#fs-utils）
      lstatSync(p);
      unlinkSync(p);
    } catch {
      // 不存在即跳过
    }
  }
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, content);
    fsyncSync(fd); // 落盘后再 rename，防崩溃留半写文件顶替原文件
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** 删除工具目录（purge）。目录本身是 symlink 时只解链，不进目标删除 */
export function removeCliToolDir(name: string): void {
  const dir = join(getCliToolsDir(), name);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    unlinkSync(dir);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

// ===== Prompt 注入（同步 + mtime 缓存）=====

let promptCache: { mtimeMs: number; size: number; text: string } | null = null;

/**
 * 构建 `<myagents-user-tools>` 段（纯函数，单测覆盖保险丝行为）。
 * 超过 CLI_TOOL_PROMPT_MAX_TOOLS 的部分降级为一行 list 指引，防 registry 膨胀吃爆 prompt。
 */
export function buildUserToolsSectionText(tools: ReadonlyArray<{ name: string; description: string }>): string {
  if (tools.length === 0) return '';
  const shown = tools.slice(0, CLI_TOOL_PROMPT_MAX_TOOLS);
  const overflow = tools.length - shown.length;
  const blocks = shown.map((t) => `## ${t.name}\n${t.description.trim()}`);
  const overflowLine = overflow > 0
    ? `\n\n…and ${overflow} more registered tool(s) — run \`${APP_CLI_NAME} tool list\` to see all.`
    : '';
  return `<myagents-user-tools>
The user has registered the following CLI tools in MyAgents. They are on PATH —
invoke them directly from your shell tool. Before first use in a session, run
\`<tool> readme\` for the full usage doc; \`<tool> --help\` shows arguments.
Pass --json for machine-readable output. Non-zero exit = failure; stderr carries
a JSON error with a "remediation" field telling you how to fix it.

${blocks.join('\n\n')}${overflowLine}
</myagents-user-tools>`;
}

/**
 * 同步取注入段（buildSystemPromptAppend 是同步函数）。
 * mtime+size 缓存：registry 没变不重读盘（模式照抄 model-capabilities）。
 */
export function getUserToolsPromptSection(): string {
  const registryPath = getCliToolsRegistryPath();
  let st;
  try {
    st = statSync(registryPath);
  } catch {
    promptCache = null;
    return '';
  }
  if (promptCache && promptCache.mtimeMs === st.mtimeMs && promptCache.size === st.size) {
    return promptCache.text;
  }
  const registry = readCliToolsRegistry();
  const enabled = registry.tools.filter((t) => t.enabled);
  const text = buildUserToolsSectionText(enabled);
  promptCache = { mtimeMs: st.mtimeMs, size: st.size, text };
  return text;
}

/** 测试用：清缓存 */
export function __resetUserToolsPromptCacheForTest(): void {
  promptCache = null;
}

// ===== 派生态 =====

/** envKeys 已声明但 config.cliToolEnv 未配齐的 key（设置页"需要配置 API Key"警告 + CLI 提示） */
export function findMissingEnvKeys(
  entry: Pick<CliToolRegistryEntry, 'name' | 'envKeys'>,
  cliToolEnv: Record<string, Record<string, string>> | undefined,
): string[] {
  const declared = entry.envKeys ?? [];
  if (declared.length === 0) return [];
  const configured = cliToolEnv?.[entry.name] ?? {};
  return declared.filter((k) => !configured[k] || configured[k].length === 0);
}
