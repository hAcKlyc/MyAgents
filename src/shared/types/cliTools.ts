import { APP_DATA_DIR_NAME } from '../appProfile';
/**
 * CLI 工具注册体系的共享类型与纯校验逻辑（PRD 0.2.36 cli_first_tool_registry）。
 *
 * 真相源分层：
 * - `tool.json`（CliToolManifest）随工具目录走，是工具自身的单一真相源；
 * - `~/.myagents/tools/registry.json`（CliToolRegistryFile）只存产品侧状态
 *   （enabled / registeredAt）+ description 缓存，损坏可丢弃重扫。
 *
 * 该文件保持纯净（无 fs / 进程依赖），renderer 与 sidecar 共同消费。
 */

export interface CliToolManifest {
  /** kebab-case 工具名，同时是 shim 文件名（进 PATH） */
  name: string;
  version?: string;
  /**
   * 触发描述（"什么情况下该想起我"）。注入 system prompt + 设置页列表行。
   * 注册时硬校验 ≤ CLI_TOOL_DESCRIPTION_MAX_CHARS，超长直接打回（不做加载时截断，
   * 截断会产生残句指令污染 prompt）。
   */
  description: string;
  /** 入口脚本文件名（相对工具目录），v1 仅支持 Node 单文件 */
  entry: string;
  runtime?: 'node';
  /** 工具需要的环境变量名（API key 等），值经 `myagents tool env` 存 config.cliToolEnv */
  envKeys?: string[];
  /** 依赖的外部二进制（ffmpeg 等），工具启动时自检 */
  deps?: string[];
  /** 预留：后续期 global/project/agent 三层作用域（v1 全局） */
  scope?: string;
}

export interface CliToolRegistryEntry {
  name: string;
  /** manifest.description 的注册时缓存（注入 prompt 用，避免热路径逐目录读 manifest） */
  description: string;
  version?: string;
  envKeys?: string[];
  deps?: string[];
  /** 工具目录绝对路径（规范位置 ~/.myagents/tools/<name>） */
  dir: string;
  /** 入口脚本绝对路径 */
  entryPath: string;
  /** 是否注入 AI 上下文（工具本体始终在 PATH，开关只控发现性） */
  enabled: boolean;
  registeredAt: string;
  /** 预留：v1 不写入，后续期清理建议用 */
  lastUsedAt?: string;
}

export interface CliToolRegistryFile {
  version: 1;
  tools: CliToolRegistryEntry[];
}

/** description 注册时硬上限（写进 tool-creator skill 与校验两处的单一常量） */
export const CLI_TOOL_DESCRIPTION_MAX_CHARS = 800;

/** 注入 prompt 的工具数保险丝，超出部分降级为一行 `myagents tool list` 指引 */
export const CLI_TOOL_PROMPT_MAX_TOOLS = 20;

/** kebab-case，3–30 字符 */
export const CLI_TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/**
 * 保证危险的保留名黑名单。`~/.myagents/bin` 在 PATH 中先于系统路径，
 * 重名工具会在所有 Agent session 与内嵌终端里静默遮蔽系统命令。
 * 这里只收"必然存在/必然灾难"的核心命令；其余安装态命令靠注册时的
 * PATH 碰撞动态检测兜底（server 侧 findPathCollision）。
 */
export const CLI_TOOL_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'myagents', 'moxbot',
  // 外部 Runtime 的 CLI：重名工具会被 resolveCommand 解析到（~/.myagents/bin
  // 在 fallback PATH 前列），导致 spawn 的是注册工具而不是真 runtime——必然灾难级。
  'claude', 'codex',
  'node', 'npm', 'npx', 'corepack', 'bun', 'uv', 'uvx',
  'sh', 'bash', 'zsh', 'env', 'echo', 'test',
  'ls', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'chmod', 'chown', 'ln',
  'grep', 'sed', 'awk', 'find', 'which', 'sort', 'head', 'tail', 'tee', 'xargs',
  'curl', 'wget', 'git', 'ssh', 'scp', 'tar', 'zip', 'unzip',
  'ps', 'kill', 'open', 'date', 'uname', 'diff', 'patch',
  'python', 'python3', 'pip', 'pip3', 'brew',
]);

export type CliToolValidationResult =
  | { ok: true }
  | { ok: false; code: string; error: string; recovery?: string };

export function validateCliToolName(name: unknown): CliToolValidationResult {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, code: 'NAME_MISSING', error: 'tool.json missing "name"' };
  }
  // 保留名先于格式检查：像 "rm" 这种短保留名也要给出"会遮蔽系统命令"的真实原因，
  // 而不是一个误导性的"格式不对"
  if (CLI_TOOL_RESERVED_NAMES.has(name)) {
    return {
      ok: false,
      code: 'NAME_RESERVED',
      error: `Tool name "${name}" is reserved: ~/${APP_DATA_DIR_NAME}/bin precedes system paths on PATH, so it would silently shadow the system command in every agent session and terminal`,
      recovery: 'Pick a different name with a domain prefix (e.g. "img-curl" instead of "curl").',
    };
  }
  if (!CLI_TOOL_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      code: 'NAME_INVALID',
      error: `Invalid tool name "${name}": must be kebab-case, 3-30 chars (e.g. "md-merge")`,
      recovery: 'Rename the tool (prefer a domain prefix, e.g. "md-merge" not "merge") and update tool.json.',
    };
  }
  return { ok: true };
}

/**
 * 校验 manifest 对象（来自 tool.json 的 JSON.parse 结果）。
 * 只做纯校验；entry 文件存在性等 fs 检查在 server 侧。
 */
export function validateCliToolManifest(raw: unknown): CliToolValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'MANIFEST_INVALID', error: 'tool.json must be a JSON object' };
  }
  const m = raw as Record<string, unknown>;

  const nameResult = validateCliToolName(m.name);
  if (!nameResult.ok) return nameResult;

  if (typeof m.description !== 'string' || m.description.trim().length === 0) {
    return {
      ok: false,
      code: 'DESCRIPTION_MISSING',
      error: 'tool.json missing "description" — it is what future AI sessions see in their context',
      recovery: 'Write the trigger description (when to use + quick reference); see the tool-creator skill template.',
    };
  }
  if (m.description.length > CLI_TOOL_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      code: 'DESCRIPTION_TOO_LONG',
      error: `description is ${m.description.length} chars, max ${CLI_TOOL_DESCRIPTION_MAX_CHARS} (it is injected into every session's system prompt)`,
      recovery: 'Shorten the description; move details into the tool\'s `readme` subcommand output.',
    };
  }
  // description 会被原文包进 <myagents-user-tools> 段注入 system prompt——
  // 含该 token 的文本能闭合包裹标签、把后续内容伪装成 prompt 指令。
  // 注册时直接打回（该 token 在工具描述里没有任何合法用途）。
  if (/myagents-user-tools/i.test(m.description)) {
    return {
      ok: false,
      code: 'DESCRIPTION_FORBIDDEN_TOKEN',
      error: 'description must not contain "myagents-user-tools" — it could break out of the prompt section that wraps tool descriptions',
      recovery: 'Remove that token from the description.',
    };
  }

  if (typeof m.entry !== 'string' || m.entry.trim().length === 0) {
    return { ok: false, code: 'ENTRY_MISSING', error: 'tool.json missing "entry" (entry script filename)' };
  }
  if (m.entry.includes('..') || m.entry.startsWith('/') || m.entry.includes('\\')) {
    return {
      ok: false,
      code: 'ENTRY_INVALID',
      error: `"entry" must be a plain filename inside the tool directory, got "${String(m.entry)}"`,
    };
  }

  if (m.runtime !== undefined && m.runtime !== 'node') {
    return {
      ok: false,
      code: 'RUNTIME_UNSUPPORTED',
      error: `runtime "${String(m.runtime)}" not supported (v1 supports "node" only)`,
      recovery: 'Rewrite the entry as a Node single-file script (bundled Node v24 is always available).',
    };
  }

  for (const [field, label] of [['envKeys', 'envKeys'], ['deps', 'deps']] as const) {
    const v = m[field];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
      return { ok: false, code: 'FIELD_INVALID', error: `"${label}" must be an array of strings` };
    }
  }

  return { ok: true };
}

/** 派生：工具的类型徽章（设置页用）。envKeys 非空 = API 包装型 */
export function deriveCliToolKind(envKeys: string[] | undefined): 'api' | 'local' {
  return envKeys && envKeys.length > 0 ? 'api' : 'local';
}
