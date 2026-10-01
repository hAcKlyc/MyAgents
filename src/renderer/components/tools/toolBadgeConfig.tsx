import {
  BookOpen,
  Brain,
  Clock,
  FileEdit,
  FilePen,
  FileText,
  Globe,
  ImageIcon,
  ListTodo,
  Palette,
  Plug,
  Search,
  SearchCode,
  Sparkles,
  Terminal,
  Volume2,
  Wrench,
  XCircle,
  Zap
} from 'lucide-react';
import type { ReactNode } from 'react';

import { i18n } from '@/i18n';
import type { SubagentToolCall, ToolInput, ToolUseSimple } from '@/types/chat';

import { getEffectiveTodoWriteTodos } from '@/utils/todoWriteState';
import { getTaskListSnapshot } from '@/utils/taskTodoState';
import {
  getFilePatchPrimaryPath,
  resolveFilePatchRenderModel,
  type FilePatchRenderModel,
} from '../../../shared/toolDisplay/filePatch';
import {
  isSubagentCallRunning,
  isSubagentContainerRunning,
} from './subagentActivity';

// ===== MCP Server Name Registry =====
// Module-level map updated by Chat.tsx when MCP config changes.
// Enables tool display to show user-configured server names instead of raw IDs.

const mcpServerNames = new Map<string, string>();

type ToolChromeTranslator = (key: string, options?: Record<string, unknown>) => string;

function tc(t: ToolChromeTranslator | undefined, key: string, options?: Record<string, unknown>): string {
  const fullKey = `shell.toolChrome.${key}`;
  if (t) return t(fullKey, options);
  return String(i18n.t(fullKey, { ns: 'chat', ...options }));
}

// Internal MCP servers (Context-injected, not in user config) — localized fallback names.
// User-configured MCP names remain data and are returned verbatim by getMcpServerDisplayName.
const INTERNAL_MCP_NAME_KEYS: Record<string, string> = {
  'im-cron': 'mcpServers.imCron',
  'cron-tools': 'mcpServers.cronTools',
  'im-media': 'mcpServers.imMedia',
  'im-bridge-tools': 'mcpServers.imBridgeTools',
};

/** Called by Chat.tsx when MCP server list changes */
export function syncMcpServerNames(servers: Array<{ id: string; name: string }>): void {
  mcpServerNames.clear();
  for (const s of servers) {
    mcpServerNames.set(s.id, s.name);
  }
}

/** Get display name for an MCP server ID */
function getMcpServerDisplayName(serverId: string, t?: ToolChromeTranslator): string {
  const configuredName = mcpServerNames.get(serverId);
  if (configuredName) return configuredName;
  const fallbackKey = INTERNAL_MCP_NAME_KEYS[serverId];
  return fallbackKey ? tc(t, fallbackKey) : serverId;
}

/** Extract server ID from MCP tool name: mcp__<server-id>__<tool-name> → server-id */
function extractMcpServerId(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  return parts.length >= 3 ? parts[1] : null;
}

// 格式化时间 - 共享函数
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

// Type guards for safe property access
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Safe property extraction helpers
function getStringProp(input: ToolInput | Record<string, unknown> | null | undefined, key: string): string | undefined {
  if (!input || !isObject(input)) return undefined;
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

// Helper to get string prop from either parsedInput or raw input
function getSubagentStringProp(call: SubagentToolCall, key: string): string | undefined {
  // Try parsedInput first
  const fromParsed = getStringProp(call.parsedInput, key);
  if (fromParsed) return fromParsed;
  // Fall back to raw input
  if (call.input && typeof call.input[key] === 'string') {
    return call.input[key] as string;
  }
  return undefined;
}

// Generate label for subagent tool call (used in Task tool display)
function getSubagentCallLabel(call: SubagentToolCall, t?: ToolChromeTranslator, maxLength = 35): string {
  const { name } = call;
  let label = name;

  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const filePath = getSubagentStringProp(call, 'file_path');
      if (filePath) {
        const fileName = filePath.split(/[/\\]/).pop() || filePath;
        label = `${name} ${fileName}`;
      }
      break;
    }
    case 'Bash':
    case 'PowerShell': {
      const desc = getSubagentStringProp(call, 'description');
      if (desc) {
        label = desc;
      } else {
        const cmd = getSubagentStringProp(call, 'command');
        if (cmd) {
          // Show first part of command
          const firstPart = cmd.split('\n')[0].substring(0, 30);
          label = firstPart.length < cmd.split('\n')[0].length ? `${firstPart}...` : firstPart;
        }
      }
      break;
    }
    case 'Grep': {
      const pattern = getSubagentStringProp(call, 'pattern');
      if (pattern) {
        label = tc(t, 'labels.searchWithQuery', { query: pattern });
      }
      break;
    }
    case 'CollabAgent': {
      const action = getSubagentStringProp(call, 'tool');
      label = action ? getCollabActionLabel(action, t) : tc(t, 'labels.subAgentControl');
      break;
    }
    case 'AgentMessage':
      label = tc(t, 'labels.agentMessage');
      break;
    case 'Thinking':
      label = tc(t, 'labels.thinking');
      break;
    case 'Glob': {
      const pattern = getSubagentStringProp(call, 'pattern');
      if (pattern) {
        label = tc(t, 'labels.findWithPattern', { pattern });
      }
      break;
    }
    case 'WebFetch': {
      const url = getSubagentStringProp(call, 'url');
      if (url) {
        try {
          const parsed = new URL(url);
          label = tc(t, 'labels.fetchTarget', { target: parsed.hostname });
        } catch {
          label = tc(t, 'labels.fetchTarget', { target: url });
        }
      }
      break;
    }
    case 'WebSearch': {
      const query = getSubagentStringProp(call, 'query');
      if (query) {
        label = tc(t, 'labels.searchWithQuery', { query });
      }
      break;
    }
    case 'Task': {
      const desc = getSubagentStringProp(call, 'description');
      if (desc) {
        label = desc;
      }
      break;
    }
    default: {
      // For unknown tools, try to use description if available
      const desc = getSubagentStringProp(call, 'description');
      if (desc) {
        label = `${name} ${desc}`;
      }
    }
  }

  return label.length > maxLength ? `${label.substring(0, maxLength - 3)}...` : label;
}

function getTodoWriteLabel(tool: ToolUseSimple, t?: ToolChromeTranslator): string {
  const todos = getEffectiveTodoWriteTodos(tool);
  if (todos && todos.length > 0) {
    const completedCount = todos.filter((t) => t.status === 'completed').length;
    return tc(t, 'labels.todoProgress', { completed: completedCount, total: todos.length });
  }
  return tc(t, 'labels.todoList');
}

function getFilePatchLabel(tool: ToolUseSimple): string | null {
  const display = resolveFilePatchRenderModel(tool);
  const filePath = display ? getFilePatchPrimaryPath(display) : null;
  if (!filePath) return null;
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  return fileName.length > 20 ? `${fileName.substring(0, 17)}...` : fileName;
}

// SDK 0.3.142+ incremental Task tools (TaskCreate/TaskUpdate/TaskGet/TaskList) —
// compact badge labels. Distinct from the sub-agent launcher 'Task'.
function getTaskTodoLabel(tool: ToolUseSimple, t?: ToolChromeTranslator): string {
  switch (tool.name) {
    case 'TaskCreate': {
      const subject = getStringProp(tool.parsedInput, 'subject');
      return subject ? tc(t, 'labels.newTaskWithSubject', { subject }) : tc(t, 'labels.newTask');
    }
    case 'TaskUpdate': {
      const status = getStringProp(tool.parsedInput, 'status');
      const subject = getStringProp(tool.parsedInput, 'subject');
      if (status === 'completed') return subject ? tc(t, 'labels.taskDoneWithSubject', { subject }) : tc(t, 'labels.taskDone');
      if (status === 'in_progress') return subject ? tc(t, 'labels.taskStartedWithSubject', { subject }) : tc(t, 'labels.taskStarted');
      if (status === 'deleted') return subject ? tc(t, 'labels.taskDroppedWithSubject', { subject }) : tc(t, 'labels.taskDropped');
      return subject ? tc(t, 'labels.updateTaskWithSubject', { subject }) : tc(t, 'labels.updateTask');
    }
    case 'TaskGet':
      return tc(t, 'labels.getTask');
    case 'TaskList': {
      const tasks = getTaskListSnapshot(tool);
      if (tasks && tasks.length > 0) {
        const completedCount = tasks.filter((t) => t.status === 'completed').length;
        return tc(t, 'labels.tasksProgress', { completed: completedCount, total: tasks.length });
      }
      return tc(t, 'labels.taskList');
    }
    default:
      return tool.name;
  }
}

export interface ToolBadgeConfig {
  icon: ReactNode;
  colors: {
    border: string;
    bg: string;
    text: string;
    hoverBg: string;
    chevron: string;
    iconColor: string;
  };
}

// Unified tool badge configuration - single source of truth.
//
// Icons carry a flat `size-4` class (16px) on the SVG itself. ProcessRow renders
// them inside a `[&>svg]:size-4` container, but that override compiles to native
// CSS nesting under Tailwind v4 — its specificity only wins on nesting-capable
// engines. On an older Windows WebView2 the nested rule didn't apply, so an
// authored `size-2.5` (10px) icon stayed small and looked off-center beside the
// flat-`size-4` spinner/brain icons. A flat size class is engine-independent.
// ToolHeader (utils.tsx) rewrites this size class to `size-3` for its denser
// header via regex, so the flat base size here does not change that view.
export function getToolBadgeConfig(toolName: string): ToolBadgeConfig {
  switch (toolName) {
    // File operations - Green/Emerald
    case 'Read':
      return {
        icon: <FileText className="size-4" />,
        colors: {
          border: 'border-emerald-200/60 dark:border-emerald-500/30',
          bg: 'bg-emerald-50/80 dark:bg-emerald-500/10',
          text: 'text-emerald-600 dark:text-emerald-400',
          hoverBg: 'hover:bg-emerald-100/80 dark:hover:bg-emerald-500/20',
          chevron: 'text-emerald-400 dark:text-emerald-500',
          iconColor: 'text-emerald-500 dark:text-emerald-400'
        }
      };
    case 'Write':
      return {
        icon: <FilePen className="size-4" />,
        colors: {
          border: 'border-emerald-200/60 dark:border-emerald-500/30',
          bg: 'bg-emerald-50/80 dark:bg-emerald-500/10',
          text: 'text-emerald-600 dark:text-emerald-400',
          hoverBg: 'hover:bg-emerald-100/80 dark:hover:bg-emerald-500/20',
          chevron: 'text-emerald-400 dark:text-emerald-500',
          iconColor: 'text-emerald-500 dark:text-emerald-400'
        }
      };
    case 'Edit':
      return {
        icon: <FileEdit className="size-4" />,
        colors: {
          border: 'border-emerald-200/60 dark:border-emerald-500/30',
          bg: 'bg-emerald-50/80 dark:bg-emerald-500/10',
          text: 'text-emerald-600 dark:text-emerald-400',
          hoverBg: 'hover:bg-emerald-100/80 dark:hover:bg-emerald-500/20',
          chevron: 'text-emerald-400 dark:text-emerald-500',
          iconColor: 'text-emerald-500 dark:text-emerald-400'
        }
      };
    // Terminal/Shell operations - Orange/Amber
    case 'Bash':
    case 'BashOutput':
      return {
        icon: <Terminal className="size-4" />,
        colors: {
          border: 'border-amber-200/60 dark:border-amber-500/30',
          bg: 'bg-amber-50/80 dark:bg-amber-500/10',
          text: 'text-amber-600 dark:text-amber-400',
          hoverBg: 'hover:bg-amber-100/80 dark:hover:bg-amber-500/20',
          chevron: 'text-amber-400 dark:text-amber-500',
          iconColor: 'text-amber-500 dark:text-amber-400'
        }
      };
    case 'KillShell':
      return {
        icon: <XCircle className="size-4" />,
        colors: {
          border: 'border-amber-200/60 dark:border-amber-500/30',
          bg: 'bg-amber-50/80 dark:bg-amber-500/10',
          text: 'text-amber-600 dark:text-amber-400',
          hoverBg: 'hover:bg-amber-100/80 dark:hover:bg-amber-500/20',
          chevron: 'text-amber-400 dark:text-amber-500',
          iconColor: 'text-amber-500 dark:text-amber-400'
        }
      };
    // Search operations - Purple/Violet
    case 'Grep':
      return {
        icon: <SearchCode className="size-4" />,
        colors: {
          border: 'border-violet-200/60 dark:border-violet-500/30',
          bg: 'bg-violet-50/80 dark:bg-violet-500/10',
          text: 'text-violet-600 dark:text-violet-400',
          hoverBg: 'hover:bg-violet-100/80 dark:hover:bg-violet-500/20',
          chevron: 'text-violet-400 dark:text-violet-500',
          iconColor: 'text-violet-500 dark:text-violet-400'
        }
      };
    case 'Glob':
      return {
        icon: <Search className="size-4" />,
        colors: {
          border: 'border-violet-200/60 dark:border-violet-500/30',
          bg: 'bg-violet-50/80 dark:bg-violet-500/10',
          text: 'text-violet-600 dark:text-violet-400',
          hoverBg: 'hover:bg-violet-100/80 dark:hover:bg-violet-500/20',
          chevron: 'text-violet-400 dark:text-violet-500',
          iconColor: 'text-violet-500 dark:text-violet-400'
        }
      };
    case 'WebSearch':
      return {
        icon: <Search className="size-4" />,
        colors: {
          border: 'border-violet-200/60 dark:border-violet-500/30',
          bg: 'bg-violet-50/80 dark:bg-violet-500/10',
          text: 'text-violet-600 dark:text-violet-400',
          hoverBg: 'hover:bg-violet-100/80 dark:hover:bg-violet-500/20',
          chevron: 'text-violet-400 dark:text-violet-500',
          iconColor: 'text-violet-500 dark:text-violet-400'
        }
      };
    // Web operations - Blue/Cyan
    case 'WebFetch':
      return {
        icon: <Globe className="size-4" />,
        colors: {
          border: 'border-cyan-200/60 dark:border-cyan-500/30',
          bg: 'bg-cyan-50/80 dark:bg-cyan-500/10',
          text: 'text-cyan-600 dark:text-cyan-400',
          hoverBg: 'hover:bg-cyan-100/80 dark:hover:bg-cyan-500/20',
          chevron: 'text-cyan-400 dark:text-cyan-500',
          iconColor: 'text-cyan-500 dark:text-cyan-400'
        }
      };
    // Task / Agent (sub-agent) - Indigo
    case 'Task':
    case 'Agent':
      return {
        icon: <Zap className="size-4" />,
        colors: {
          border: 'border-indigo-200/60 dark:border-indigo-500/30',
          bg: 'bg-indigo-50/80 dark:bg-indigo-500/10',
          text: 'text-indigo-600 dark:text-indigo-400',
          hoverBg: 'hover:bg-indigo-100/80 dark:hover:bg-indigo-500/20',
          chevron: 'text-indigo-400 dark:text-indigo-500',
          iconColor: 'text-indigo-500 dark:text-indigo-400'
        }
      };
    // SDK 0.3.142+ Task tools share the task-list family styling (indigo + ListTodo).
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskGet':
    case 'TaskList':
      return {
        icon: <ListTodo className="size-4" />,
        colors: {
          border: 'border-indigo-200/60 dark:border-indigo-500/30',
          bg: 'bg-indigo-50/80 dark:bg-indigo-500/10',
          text: 'text-indigo-600 dark:text-indigo-400',
          hoverBg: 'hover:bg-indigo-100/80 dark:hover:bg-indigo-500/20',
          chevron: 'text-indigo-400 dark:text-indigo-500',
          iconColor: 'text-indigo-500 dark:text-indigo-400'
        }
      };
    // Skills - Sky blue (friendly, non-error)
    case 'Skill':
      return {
        icon: <Sparkles className="size-4" />,
        colors: {
          border: 'border-sky-200/60 dark:border-sky-500/30',
          bg: 'bg-sky-50/80 dark:bg-sky-500/10',
          text: 'text-sky-600 dark:text-sky-400',
          hoverBg: 'hover:bg-sky-100/80 dark:hover:bg-sky-500/20',
          chevron: 'text-sky-400 dark:text-sky-500',
          iconColor: 'text-sky-500 dark:text-sky-400'
        }
      };
    // Notebook - Teal
    case 'NotebookEdit':
      return {
        icon: <BookOpen className="size-4" />,
        colors: {
          border: 'border-teal-200/60 dark:border-teal-500/30',
          bg: 'bg-teal-50/80 dark:bg-teal-500/10',
          text: 'text-teal-600 dark:text-teal-400',
          hoverBg: 'hover:bg-teal-100/80 dark:hover:bg-teal-500/20',
          chevron: 'text-teal-400 dark:text-teal-500',
          iconColor: 'text-teal-500 dark:text-teal-400'
        }
      };
    // Default - Blue (fallback for unknown tools like MCP tools, server_tool_use)
    default:
      // Gemini Image tools - Purple
      if (toolName.startsWith('mcp__gemini-image__')) {
        return {
          icon: <Palette className="size-4" />,
          colors: {
            border: 'border-purple-200/60 dark:border-purple-500/30',
            bg: 'bg-purple-50/80 dark:bg-purple-500/10',
            text: 'text-purple-600 dark:text-purple-400',
            hoverBg: 'hover:bg-purple-100/80 dark:hover:bg-purple-500/20',
            chevron: 'text-purple-400 dark:text-purple-500',
            iconColor: 'text-purple-500 dark:text-purple-400'
          }
        };
      }

      // Edge TTS tools - Rose/Pink
      if (toolName.startsWith('mcp__edge-tts__')) {
        return {
          icon: <Volume2 className="size-4" />,
          colors: {
            border: 'border-rose-200/60 dark:border-rose-500/30',
            bg: 'bg-rose-50/80 dark:bg-rose-500/10',
            text: 'text-rose-600 dark:text-rose-400',
            hoverBg: 'hover:bg-rose-100/80 dark:hover:bg-rose-500/20',
            chevron: 'text-rose-400 dark:text-rose-500',
            iconColor: 'text-rose-500 dark:text-rose-400'
          }
        };
      }

      // Cron/Scheduled task tools - Teal
      if (toolName.startsWith('mcp__im-cron__') || toolName.startsWith('mcp__cron-tools__')) {
        return {
          icon: <Clock className="size-4" />,
          colors: {
            border: 'border-teal-200/60 dark:border-teal-500/30',
            bg: 'bg-teal-50/80 dark:bg-teal-500/10',
            text: 'text-teal-600 dark:text-teal-400',
            hoverBg: 'hover:bg-teal-100/80 dark:hover:bg-teal-500/20',
            chevron: 'text-teal-400 dark:text-teal-500',
            iconColor: 'text-teal-500 dark:text-teal-400'
          }
        };
      }

      // IM Media tools - Indigo
      if (toolName.startsWith('mcp__im-media__')) {
        return {
          icon: <ImageIcon className="size-4" />,
          colors: {
            border: 'border-indigo-200/60 dark:border-indigo-500/30',
            bg: 'bg-indigo-50/80 dark:bg-indigo-500/10',
            text: 'text-indigo-600 dark:text-indigo-400',
            hoverBg: 'hover:bg-indigo-100/80 dark:hover:bg-indigo-500/20',
            chevron: 'text-indigo-400 dark:text-indigo-500',
            iconColor: 'text-indigo-500 dark:text-indigo-400'
          }
        };
      }

      // IM Bridge (OpenClaw plugin) tools - Cyan
      if (toolName.startsWith('mcp__im-bridge-tools__')) {
        return {
          icon: <Plug className="size-4" />,
          colors: {
            border: 'border-cyan-200/60 dark:border-cyan-500/30',
            bg: 'bg-cyan-50/80 dark:bg-cyan-500/10',
            text: 'text-cyan-600 dark:text-cyan-400',
            hoverBg: 'hover:bg-cyan-100/80 dark:hover:bg-cyan-500/20',
            chevron: 'text-cyan-400 dark:text-cyan-500',
            iconColor: 'text-cyan-500 dark:text-cyan-400'
          }
        };
      }

      // Playwright browser tools - Sky blue
      if (toolName.startsWith('mcp__playwright__')) {
        return {
          icon: <Globe className="size-4" />,
          colors: {
            border: 'border-sky-200/60 dark:border-sky-500/30',
            bg: 'bg-sky-50/80 dark:bg-sky-500/10',
            text: 'text-sky-600 dark:text-sky-400',
            hoverBg: 'hover:bg-sky-100/80 dark:hover:bg-sky-500/20',
            chevron: 'text-sky-400 dark:text-sky-500',
            iconColor: 'text-sky-500 dark:text-sky-400'
          }
        };
      }

      // Search tools (DuckDuckGo, Tavily, You.com, etc.) - Emerald
      if (
        toolName.startsWith('mcp__ddg-search__') ||
        toolName.startsWith('mcp__tavily-search__') ||
        toolName.startsWith('mcp__you-search__')
      ) {
        return {
          icon: <Search className="size-4" />,
          colors: {
            border: 'border-emerald-200/60 dark:border-emerald-500/30',
            bg: 'bg-emerald-50/80 dark:bg-emerald-500/10',
            text: 'text-emerald-600 dark:text-emerald-400',
            hoverBg: 'hover:bg-emerald-100/80 dark:hover:bg-emerald-500/20',
            chevron: 'text-emerald-400 dark:text-emerald-500',
            iconColor: 'text-emerald-500 dark:text-emerald-400'
          }
        };
      }

      // Default fallback for unknown MCP and other tools
      return {
        icon: <Wrench className="size-4" />,
        colors: {
          border: 'border-blue-200/60 dark:border-blue-500/30',
          bg: 'bg-blue-50/80 dark:bg-blue-500/10',
          text: 'text-blue-600 dark:text-blue-400',
          hoverBg: 'hover:bg-blue-100/80 dark:hover:bg-blue-500/20',
          chevron: 'text-blue-400 dark:text-blue-500',
          iconColor: 'text-blue-500 dark:text-blue-400'
        }
      };
  }
}

// Get main label for tool (displayed as primary text in ProcessRow)
// For MCP tools: uses server display name from config (e.g., "Playwright 浏览器", "天眼查")
// For Task tool: returns the subagent_type (e.g., "Explore", "Plan")
// Generic override: if parsedInput has `_displayName`, use it verbatim — this lets
// external runtimes (like Gemini) surface their real tool identifier (e.g.
// "run_shell_command") in the UI while internally still routing tool.name to a
// MyAgents-native component (BashTool/GrepTool/...) for rich body rendering.
export { isSubagentContainerTool } from './subagentActivity';

// Human-readable label for a Codex collab-agent card by its action + model.
const COLLAB_ACTION_LABEL_KEYS: Record<string, string> = {
  spawnAgent: 'labels.spawnAgent',
  wait: 'labels.waitAgent',
  closeAgent: 'labels.closeAgent',
  sendInput: 'labels.sendInput',
  resumeAgent: 'labels.resumeAgent',
};

function getCollabActionLabel(action: string, t?: ToolChromeTranslator): string {
  const key = COLLAB_ACTION_LABEL_KEYS[action];
  return key ? tc(t, key) : action;
}

function getCollabAgentLabel(tool: ToolUseSimple, t?: ToolChromeTranslator): string {
  const action = getStringProp(tool.parsedInput, 'tool');
  const model = getStringProp(tool.parsedInput, 'model');
  const base = action ? getCollabActionLabel(action, t) : tc(t, 'labels.subAgent');
  return model ? `${base} · ${model}` : base;
}

export function getToolMainLabel(tool: ToolUseSimple, t?: ToolChromeTranslator): string {
  const displayNameOverride = getStringProp(tool.parsedInput, '_displayName');
  if (displayNameOverride) return displayNameOverride;
  if (tool.name === 'CollabAgent') return tc(t, 'labels.subAgent');
  if (tool.name === 'Task' || tool.name === 'Agent') {
    const subagentType = getStringProp(tool.parsedInput, 'subagent_type');
    return subagentType || tool.name;
  }
  // MCP tools: use server display name
  const serverId = extractMcpServerId(tool.name);
  if (serverId) {
    return getMcpServerDisplayName(serverId, t);
  }
  return tool.name;
}

// Unified label generation logic - extracts compact label from tool
export function getToolLabel(tool: ToolUseSimple, t?: ToolChromeTranslator): string {
  if (tool.name === 'TodoWrite') {
    return getTodoWriteLabel(tool, t);
  }
  // Task tools read result (TaskList) / input that may be absent mid-stream —
  // handle before the `!parsedInput` early-return below.
  if (tool.name === 'TaskCreate' || tool.name === 'TaskUpdate' || tool.name === 'TaskGet' || tool.name === 'TaskList') {
    return getTaskTodoLabel(tool, t);
  }
  if (tool.name === 'Write' || tool.name === 'Edit') {
    const label = getFilePatchLabel(tool);
    if (label) return label;
  }

  if (!tool.parsedInput) {
    // Try to parse from inputJson if available
    if (tool.inputJson) {
      try {
        const parsed = JSON.parse(tool.inputJson);
        if (tool.name === 'Read' || tool.name === 'Write' || tool.name === 'Edit') {
          return parsed.file_path ? `${tool.name} ${parsed.file_path.split(/[/\\]/).pop()}` : tool.name;
        }
        if (tool.name === 'Bash') {
          return parsed.description || parsed.command ?
              parsed.description || parsed.command.split(' ')[0]
            : tc(t, 'labels.runCommand');
        }
        if (tool.name === 'BashOutput') {
          return tc(t, 'labels.bashOutput');
        }
        if (tool.name === 'Skill') {
          return parsed.skill ? tc(t, 'labels.skillWithName', { name: parsed.skill }) : tc(t, 'labels.skill');
        }
        if (tool.name === 'Glob') {
          return tc(t, 'labels.find');
        }
        if (tool.name === 'Grep') {
          return tc(t, 'labels.search');
        }
        if (tool.name === 'WebSearch') {
          return tc(t, 'labels.search');
        }
        if (tool.name === 'WebFetch') {
          return tc(t, 'labels.fetch');
        }
        if (tool.name === 'KillShell') {
          return tc(t, 'labels.killShell');
        }
      } catch {
        if (tool.name === 'Bash') {
          const raw = tool.inputJson.trim();
          if (raw) {
            const cmd = raw.split(' ')[0];
            return cmd.length > 15 ? `${cmd.substring(0, 12)}...` : cmd;
          }
        }
      }
    }
    return tool.name;
  }

  switch (tool.name) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      if (tool.name === 'Write' || tool.name === 'Edit') {
        const label = getFilePatchLabel(tool);
        if (label) return label;
      }
      const filePath = getStringProp(tool.parsedInput, 'file_path');
      if (filePath) {
        const fileName = filePath.split(/[/\\]/).pop() || filePath;
        return fileName.length > 20 ? `${fileName.substring(0, 17)}...` : fileName;
      }
      return tool.name;
    }
    case 'Bash': {
      const description = getStringProp(tool.parsedInput, 'description');
      if (description) return description;
      const command = getStringProp(tool.parsedInput, 'command');
      if (command) {
        const cmd = command.split(' ')[0];
        return cmd.length > 15 ? `${cmd.substring(0, 12)}...` : cmd;
      }
      return tc(t, 'labels.runCommand');
    }
    case 'BashOutput': {
      return tc(t, 'labels.bashOutput');
    }
    case 'Grep': {
      const pattern = getStringProp(tool.parsedInput, 'pattern');
      if (pattern) {
        const truncated = pattern.length > 15 ? `${pattern.substring(0, 12)}...` : pattern;
        return tc(t, 'labels.searchWithQuery', { query: truncated });
      }
      return tc(t, 'labels.search');
    }
    case 'Glob': {
      const pattern = getStringProp(tool.parsedInput, 'pattern');
      if (pattern) {
        const truncated = pattern.length > 15 ? `${pattern.substring(0, 12)}...` : pattern;
        return tc(t, 'labels.findWithPattern', { pattern: truncated });
      }
      return tc(t, 'labels.find');
    }
    case 'Task':
    case 'Agent':
    case 'CollabAgent': {
      const isTaskRunning = isSubagentContainerRunning(tool);
      // When running, show the latest subagent tool (running or most recent).
      if (isTaskRunning && tool.subagentCalls && tool.subagentCalls.length > 0) {
        // Prefer the latest running tool, otherwise show the last tool.
        const runningCall = [...tool.subagentCalls].reverse().find(isSubagentCallRunning);
        const latestCall = runningCall || tool.subagentCalls[tool.subagentCalls.length - 1];
        if (latestCall) {
          return getSubagentCallLabel(latestCall, t);
        }
      }
      // Codex collab card has no description/subagent_type — label by action + model.
      if (tool.name === 'CollabAgent') {
        return getCollabAgentLabel(tool, t);
      }
      // When completed or no subagent calls yet, show the description.
      // No JS truncation — CSS truncate handles overflow via max-width in ProcessRow.
      // No (后台) suffix — the 后台 badge tag already indicates background mode.
      const description = getStringProp(tool.parsedInput, 'description');
      const subagentType = getStringProp(tool.parsedInput, 'subagent_type') || tool.name;
      if (description) return description;
      return subagentType;
    }
    case 'WebFetch': {
      const urlStr = getStringProp(tool.parsedInput, 'url');
      if (urlStr) {
        try {
          const url = new URL(urlStr);
          return url.hostname.length > 20 ? `${url.hostname.substring(0, 17)}...` : url.hostname;
        } catch {
          return urlStr.length > 20 ? `${urlStr.substring(0, 17)}...` : urlStr;
        }
      }
      return tc(t, 'labels.fetch');
    }
    case 'WebSearch': {
      const query = getStringProp(tool.parsedInput, 'query');
      if (query) {
        return query.length > 20 ? `${query.substring(0, 17)}...` : query;
      }
      return tc(t, 'labels.search');
    }
    case 'TodoWrite': {
      return getTodoWriteLabel(tool, t);
    }
    case 'Skill': {
      const skill = getStringProp(tool.parsedInput, 'skill');
      if (skill) {
        return tc(t, 'labels.skillWithName', { name: skill });
      }
      return tc(t, 'labels.skill');
    }
    default:
      return tool.name;
  }
}

// Unified expanded label generation logic - for ToolHeader in expanded state
// Returns the base semantic label (without pattern/file details) to match collapsed badge
export function getToolExpandedLabel(tool: ToolUseSimple, t?: ToolChromeTranslator): string {
  // External-runtime display override — see getToolMainLabel for the rationale.
  const displayNameOverride = getStringProp(tool.parsedInput, '_displayName');
  if (displayNameOverride) return displayNameOverride;
  switch (tool.name) {
    case 'Glob':
      return tc(t, 'labels.find');
    case 'Grep':
      return tc(t, 'labels.search');
    case 'WebSearch':
      return tc(t, 'labels.search');
    case 'WebFetch':
      return tc(t, 'labels.fetch');
    case 'Bash': {
      const description = getStringProp(tool.parsedInput, 'description');
      return description || tc(t, 'labels.runCommand');
    }
    case 'BashOutput':
      return tc(t, 'labels.bashOutput');
    case 'TodoWrite':
      return tc(t, 'labels.todoList');
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskGet':
    case 'TaskList':
      return getTaskTodoLabel(tool, t);
    case 'Task':
    case 'Agent': {
      const description = getStringProp(tool.parsedInput, 'description');
      const subagentType = getStringProp(tool.parsedInput, 'subagent_type') || tool.name;
      return description || subagentType;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
      return tool.name;
    case 'Skill': {
      const skill = getStringProp(tool.parsedInput, 'skill');
      return skill ? tc(t, 'labels.skillWithName', { name: skill }) : tc(t, 'labels.skill');
    }
    case 'NotebookEdit': {
      const editMode = getStringProp(tool.parsedInput, 'edit_mode') || 'replace';
      const mode = editMode.charAt(0).toUpperCase() + editMode.slice(1);
      return tc(t, 'labels.notebookCell', { mode });
    }
    case 'KillShell':
      return tc(t, 'labels.killShell');
    default: {
      // MCP tools: show "ServerName: tool_action" or just ServerName
      const serverId = extractMcpServerId(tool.name);
      if (serverId) {
        const serverName = getMcpServerDisplayName(serverId, t);
        // Extract tool action name (after the last __)
        const parts = tool.name.split('__');
        const toolAction = parts.length >= 3 ? parts.slice(2).join('__') : '';

        // Special cases with richer labels
        if (serverId === 'gemini-image') {
          return toolAction === 'edit_image' ? tc(t, 'labels.editImage') : tc(t, 'labels.generateImage');
        }
        if (serverId === 'edge-tts') {
          return toolAction === 'list_voices' ? tc(t, 'labels.listVoices') : tc(t, 'labels.textToSpeech');
        }
        // Generic MCP: show action if distinct from server name
        if (toolAction && toolAction !== 'search' && toolAction !== 'cron') {
          return `${serverName}: ${toolAction.replace(/_/g, ' ')}`;
        }
        return serverName;
      }
      return tool.name;
    }
  }
}

/**
 * Parse Grep SDK result. Prefers SDK's authoritative `numMatches` / `numFiles`
 * fields (see `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts::GrepOutput`),
 * falls back to deriving from `content` for older payloads or `output_mode: "content"`
 * results that omit the count fields.
 */
export type GrepResultStats = {
  matches: number;
  files: number;
  returnedLines?: number;
  totalFiles?: number;
  totalLines?: number;
  appliedLimit?: number;
  appliedOffset?: number;
};

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function parseGrepStats(result: string | undefined): GrepResultStats | null {
  if (!result) return null;
  const trimmed = result.trimStart();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      numMatches?: number;
      numLines?: number;
      numFiles?: number;
      content?: string;
      totalFiles?: number;
      totalLines?: number;
      appliedLimit?: number;
      appliedOffset?: number;
    };
    if (!parsed || typeof parsed !== 'object') return null;
    const files = nonNegativeSafeInteger(parsed.numFiles) ?? 0;
    const sdkMatches =
      nonNegativeSafeInteger(parsed.numMatches)
      ?? nonNegativeSafeInteger(parsed.numLines)
      ?? null;
    const paginationValues = [
      parsed.numFiles,
      parsed.numLines,
      parsed.totalFiles,
      parsed.totalLines,
      parsed.appliedLimit,
      parsed.appliedOffset,
    ];
    const hasMalformedPagination = paginationValues.some(value => (
      value !== undefined && nonNegativeSafeInteger(value) === undefined
    ));
    const pagination = hasMalformedPagination ? {} : {
      returnedLines: nonNegativeSafeInteger(parsed.numLines),
      totalFiles: nonNegativeSafeInteger(parsed.totalFiles),
      totalLines: nonNegativeSafeInteger(parsed.totalLines),
      appliedLimit: nonNegativeSafeInteger(parsed.appliedLimit),
      appliedOffset: nonNegativeSafeInteger(parsed.appliedOffset),
    };
    if (sdkMatches !== null) return { matches: sdkMatches, files, ...pagination };
    // Fallback: derive from content (only valid for output_mode: 'content').
    const content = typeof parsed.content === 'string' ? parsed.content : '';
    if (!content) return { matches: 0, files, ...pagination };
    return {
      matches: content.split('\n').filter(Boolean).length,
      files,
      ...pagination,
    };
  } catch { /* not JSON */ }
  return null;
}

/**
 * Parse Glob SDK result. Prefers SDK's `numFiles` field
 * (see `GlobOutput` in `sdk-tools.d.ts`), falls back to `filenames.length`.
 */
function parseGlobStats(result: string | undefined): { files: number } | null {
  if (!result) return null;
  const trimmed = result.trimStart();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as { numFiles?: number; filenames?: unknown };
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.numFiles === 'number') return { files: parsed.numFiles };
    if (Array.isArray(parsed.filenames)) return { files: parsed.filenames.length };
  } catch { /* not JSON */ }
  return null;
}

function renderFilePatchSummary(display: FilePatchRenderModel, t?: ToolChromeTranslator): ReactNode {
  const { added, removed } = display.summary;
  const written = display.changes.reduce((total, change) => total + (change.written ?? 0), 0);
  if (written > 0 && added === 0 && removed === 0) {
    return (
      <span className="text-xs font-mono whitespace-nowrap text-[var(--ink-muted)]">
        {tc(t, 'labels.writeLines', { count: written })}
      </span>
    );
  }
  if (added === 0 && removed === 0) return null;
  const showRemoved =
    removed > 0 ||
    display.changes.some((change) => change.kind !== 'add' || change.removed > 0 || change.viewKind === 'old-new');

  if (!showRemoved) {
    return (
      <span className="text-xs font-mono whitespace-nowrap text-[var(--success)]">
        +{added}
      </span>
    );
  }

  return (
    <span className="text-xs font-mono whitespace-nowrap">
      <span className="text-[var(--success)]">+{added}</span>
      {' '}
      <span className="text-[var(--error)]">-{removed}</span>
    </span>
  );
}

/**
 * Outer ProcessRow summary chip — surfaces the most actionable result detail
 * next to the tool's main label (Edit `+5 -13`, Write `+25`, Grep `N matches in M files`).
 *
 * Returns a ReactNode (not a string) so each tool can pick its own color treatment.
 * The plain-text "A3" style: mono, no pill background, semantic color only.
 *
 * Returns `null` if the tool has no useful summary or the input/result hasn't
 * arrived yet (streaming-safe).
 */
export function getToolSummaryNode(tool: ToolUseSimple, t?: ToolChromeTranslator): ReactNode | null {
  switch (tool.name) {
    case 'Edit':
    case 'Write': {
      const display = resolveFilePatchRenderModel(tool);
      return display ? renderFilePatchSummary(display, t) : null;
    }
    case 'Grep': {
      const stats = parseGrepStats(tool.result);
      if (!stats) return null;
      const filesPart = stats.files > 0 ?
        ` ${tc(t, 'labels.filesPart', { count: stats.files })}`
        : '';
      return (
        <span className="text-xs font-mono text-[var(--ink-muted)]">
          {tc(t, 'labels.matches', { count: stats.matches })}{filesPart}
        </span>
      );
    }
    case 'Glob': {
      const stats = parseGlobStats(tool.result);
      if (!stats) return null;
      return (
        <span className="text-xs font-mono text-[var(--ink-muted)]">
          {tc(t, 'labels.files', { count: stats.files })}
        </span>
      );
    }
    default:
      return null;
  }
}

// Thinking badge configuration - single source of truth
export function getThinkingBadgeConfig(): ToolBadgeConfig {
  return {
    icon: <Brain className="size-4" />,
    colors: {
      border: 'border-purple-200/60 dark:border-purple-500/30',
      bg: 'bg-purple-50/80 dark:bg-purple-500/10',
      text: 'text-purple-600 dark:text-purple-400',
      hoverBg: 'hover:bg-purple-100/80 dark:hover:bg-purple-500/20',
      chevron: 'text-purple-400 dark:text-purple-500',
      iconColor: 'text-purple-500 dark:text-purple-400'
    }
  };
}

// Unified thinking label generation logic
export function getThinkingLabel(isComplete: boolean, durationMs?: number, t?: ToolChromeTranslator): string {
  const durationSeconds =
    typeof durationMs === 'number' ? Math.max(1, Math.round(durationMs / 1000)) : null;

  if (isComplete && durationSeconds) {
    return `${durationSeconds}s`;
  }
  if (isComplete) {
    return tc(t, 'labels.thinking');
  }
  return tc(t, 'labels.thinking');
}

// Get expanded thinking label (more descriptive)
export function getThinkingExpandedLabel(isComplete: boolean, durationMs?: number, t?: ToolChromeTranslator): string {
  const durationSeconds =
    typeof durationMs === 'number' ? Math.max(1, Math.round(durationMs / 1000)) : null;

  if (isComplete && durationSeconds) {
    const seconds = Math.round(durationMs! / 1000);
    return tc(t, 'thinking.completedWithSeconds', { seconds });
  }
  if (isComplete) {
    return tc(t, 'labels.thinking');
  }
  return tc(t, 'labels.thinking');
}
