import {
  BookOpen,
  Brain,
  FileEdit,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Search,
  SearchCode,
  Sparkles,
  Terminal,
  XCircle,
  Zap
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { SubagentToolCall, ToolInput, ToolUseSimple } from '@/types/chat';

// Type guards for safe property access
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Safe property extraction helpers
function getStringProp(input: ToolInput | undefined, key: string): string | undefined {
  if (!input || !isObject(input)) return undefined;
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function getArrayProp<T>(input: ToolInput | undefined, key: string): T[] | undefined {
  if (!input || !isObject(input)) return undefined;
  const value = input[key];
  return Array.isArray(value) ? value as T[] : undefined;
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
function getSubagentCallLabel(call: SubagentToolCall, maxLength = 35): string {
  const { name } = call;
  let label = name;

  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      const filePath = getSubagentStringProp(call, 'file_path');
      if (filePath) {
        const fileName = filePath.split('/').pop() || filePath;
        label = `${name} ${fileName}`;
      }
      break;
    }
    case 'Bash': {
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
        label = `Search "${pattern}"`;
      }
      break;
    }
    case 'Glob': {
      const pattern = getSubagentStringProp(call, 'pattern');
      if (pattern) {
        label = `Find ${pattern}`;
      }
      break;
    }
    case 'WebFetch': {
      const url = getSubagentStringProp(call, 'url');
      if (url) {
        try {
          const parsed = new URL(url);
          label = `Fetch ${parsed.hostname}`;
        } catch {
          label = `Fetch ${url}`;
        }
      }
      break;
    }
    case 'WebSearch': {
      const query = getSubagentStringProp(call, 'query');
      if (query) {
        label = `Search "${query}"`;
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

// Unified tool badge configuration - single source of truth
export function getToolBadgeConfig(toolName: string): ToolBadgeConfig {
  switch (toolName) {
    // File operations - Green/Emerald
    case 'Read':
      return {
        icon: <FileText className="size-2.5" />,
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
        icon: <FilePen className="size-2.5" />,
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
        icon: <FileEdit className="size-2.5" />,
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
        icon: <Terminal className="size-2.5" />,
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
        icon: <XCircle className="size-2.5" />,
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
        icon: <SearchCode className="size-2.5" />,
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
        icon: <Search className="size-2.5" />,
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
        icon: <Search className="size-2.5" />,
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
        icon: <Globe className="size-2.5" />,
        colors: {
          border: 'border-cyan-200/60 dark:border-cyan-500/30',
          bg: 'bg-cyan-50/80 dark:bg-cyan-500/10',
          text: 'text-cyan-600 dark:text-cyan-400',
          hoverBg: 'hover:bg-cyan-100/80 dark:hover:bg-cyan-500/20',
          chevron: 'text-cyan-400 dark:text-cyan-500',
          iconColor: 'text-cyan-500 dark:text-cyan-400'
        }
      };
    // Task management - Indigo
    case 'Task':
      return {
        icon: <Zap className="size-2.5" />,
        colors: {
          border: 'border-indigo-200/60 dark:border-indigo-500/30',
          bg: 'bg-indigo-50/80 dark:bg-indigo-500/10',
          text: 'text-indigo-600 dark:text-indigo-400',
          hoverBg: 'hover:bg-indigo-100/80 dark:hover:bg-indigo-500/20',
          chevron: 'text-indigo-400 dark:text-indigo-500',
          iconColor: 'text-indigo-500 dark:text-indigo-400'
        }
      };
    case 'TodoWrite':
      return {
        icon: <ListTodo className="size-2.5" />,
        colors: {
          border: 'border-indigo-200/60 dark:border-indigo-500/30',
          bg: 'bg-indigo-50/80 dark:bg-indigo-500/10',
          text: 'text-indigo-600 dark:text-indigo-400',
          hoverBg: 'hover:bg-indigo-100/80 dark:hover:bg-indigo-500/20',
          chevron: 'text-indigo-400 dark:text-indigo-500',
          iconColor: 'text-indigo-500 dark:text-indigo-400'
        }
      };
    // Skills - Pink/Rose
    case 'Skill':
      return {
        icon: <Sparkles className="size-2.5" />,
        colors: {
          border: 'border-rose-200/60 dark:border-rose-500/30',
          bg: 'bg-rose-50/80 dark:bg-rose-500/10',
          text: 'text-rose-600 dark:text-rose-400',
          hoverBg: 'hover:bg-rose-100/80 dark:hover:bg-rose-500/20',
          chevron: 'text-rose-400 dark:text-rose-500',
          iconColor: 'text-rose-500 dark:text-rose-400'
        }
      };
    // Notebook - Teal
    case 'NotebookEdit':
      return {
        icon: <BookOpen className="size-2.5" />,
        colors: {
          border: 'border-teal-200/60 dark:border-teal-500/30',
          bg: 'bg-teal-50/80 dark:bg-teal-500/10',
          text: 'text-teal-600 dark:text-teal-400',
          hoverBg: 'hover:bg-teal-100/80 dark:hover:bg-teal-500/20',
          chevron: 'text-teal-400 dark:text-teal-500',
          iconColor: 'text-teal-500 dark:text-teal-400'
        }
      };
    // Default - Blue (fallback)
    default:
      return {
        icon: null,
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
// For Task tool, returns the subagent_type (e.g., "Explore", "Plan")
// For other tools, returns the tool name
export function getToolMainLabel(tool: ToolUseSimple): string {
  if (tool.name === 'Task') {
    const subagentType = getStringProp(tool.parsedInput, 'subagent_type');
    return subagentType || 'Task';
  }
  return tool.name;
}

// Unified label generation logic - extracts compact label from tool
export function getToolLabel(tool: ToolUseSimple): string {
  if (!tool.parsedInput) {
    // Try to parse from inputJson if available
    if (tool.inputJson) {
      try {
        const parsed = JSON.parse(tool.inputJson);
        if (tool.name === 'Read' || tool.name === 'Write' || tool.name === 'Edit') {
          return parsed.file_path ? `${tool.name} ${parsed.file_path.split('/').pop()}` : tool.name;
        }
        if (tool.name === 'Bash') {
          return parsed.description || parsed.command ?
              parsed.description || parsed.command.split(' ')[0]
            : 'Run command';
        }
        if (tool.name === 'BashOutput') {
          return 'Bash Output';
        }
        if (tool.name === 'Skill') {
          return parsed.skill ? `Skill(${parsed.skill})` : 'Skill';
        }
        if (tool.name === 'Glob') {
          return 'Find';
        }
        if (tool.name === 'Grep') {
          return 'Search';
        }
        if (tool.name === 'WebSearch') {
          return 'Search';
        }
        if (tool.name === 'WebFetch') {
          return 'Fetch';
        }
        if (tool.name === 'TodoWrite') {
          return 'Todo List';
        }
        if (tool.name === 'KillShell') {
          return 'Kill Shell';
        }
      } catch {
        // Ignore parse errors
      }
    }
    return tool.name;
  }

  switch (tool.name) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      const filePath = getStringProp(tool.parsedInput, 'file_path');
      if (filePath) {
        const fileName = filePath.split('/').pop() || filePath;
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
      return 'Run command';
    }
    case 'BashOutput': {
      return 'Bash Output';
    }
    case 'Grep': {
      const pattern = getStringProp(tool.parsedInput, 'pattern');
      if (pattern) {
        const truncated = pattern.length > 15 ? `${pattern.substring(0, 12)}...` : pattern;
        return `Search "${truncated}"`;
      }
      return 'Search';
    }
    case 'Glob': {
      const pattern = getStringProp(tool.parsedInput, 'pattern');
      if (pattern) {
        const truncated = pattern.length > 15 ? `${pattern.substring(0, 12)}...` : pattern;
        return `Find ${truncated}`;
      }
      return 'Find';
    }
    case 'Task': {
      const description = getStringProp(tool.parsedInput, 'description');
      const subagentType = getStringProp(tool.parsedInput, 'subagent_type') || 'Task';
      const isTaskRunning = tool.isLoading && !tool.result;

      // When Task is running, show the latest subagent tool (running or most recent)
      if (isTaskRunning && tool.subagentCalls && tool.subagentCalls.length > 0) {
        // Prefer running tool, otherwise show the last tool
        const runningCall = tool.subagentCalls.find(c => c.isLoading);
        const latestCall = runningCall || tool.subagentCalls[tool.subagentCalls.length - 1];
        if (latestCall) {
          return getSubagentCallLabel(latestCall);
        }
      }
      // When Task completed or no subagent calls yet, show the Task description
      if (description) {
        return description.length > 25 ? `${description.substring(0, 22)}...` : description;
      }
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
      return 'Fetch';
    }
    case 'WebSearch': {
      const query = getStringProp(tool.parsedInput, 'query');
      if (query) {
        return query.length > 20 ? `${query.substring(0, 17)}...` : query;
      }
      return 'Search';
    }
    case 'TodoWrite': {
      const todos = getArrayProp<{ status?: string }>(tool.parsedInput, 'todos');
      if (todos && todos.length > 0) {
        const completedCount = todos.filter((t) => t.status === 'completed').length;
        return `Todo ${completedCount}/${todos.length}`;
      }
      return 'Todo List';
    }
    case 'Skill': {
      const skill = getStringProp(tool.parsedInput, 'skill');
      if (skill) {
        return `Skill(${skill})`;
      }
      return 'Skill';
    }
    default:
      return tool.name;
  }
}

// Unified expanded label generation logic - for ToolHeader in expanded state
// Returns the base semantic label (without pattern/file details) to match collapsed badge
export function getToolExpandedLabel(tool: ToolUseSimple): string {
  switch (tool.name) {
    case 'Glob':
      return 'Find';
    case 'Grep':
      return 'Search';
    case 'WebSearch':
      return 'Search';
    case 'WebFetch':
      return 'Fetch';
    case 'Bash': {
      const description = getStringProp(tool.parsedInput, 'description');
      return description || 'Run command';
    }
    case 'BashOutput':
      return 'Bash Output';
    case 'TodoWrite':
      return 'Todo List';
    case 'Task': {
      const description = getStringProp(tool.parsedInput, 'description');
      const subagentType = getStringProp(tool.parsedInput, 'subagent_type') || 'Task';
      return description || subagentType;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
      return tool.name;
    case 'Skill': {
      const skill = getStringProp(tool.parsedInput, 'skill');
      return skill ? `Skill(${skill})` : 'Skill';
    }
    case 'NotebookEdit': {
      const editMode = getStringProp(tool.parsedInput, 'edit_mode') || 'replace';
      return `${editMode.charAt(0).toUpperCase() + editMode.slice(1)} notebook cell`;
    }
    case 'KillShell':
      return 'Kill Shell';
    default:
      return tool.name;
  }
}

// Thinking badge configuration - single source of truth
export function getThinkingBadgeConfig(): ToolBadgeConfig {
  return {
    icon: <Brain className="size-2.5" />,
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
export function getThinkingLabel(isComplete: boolean, durationMs?: number): string {
  const durationSeconds =
    typeof durationMs === 'number' ? Math.max(1, Math.round(durationMs / 1000)) : null;

  if (isComplete && durationSeconds) {
    return `${durationSeconds}s`;
  }
  if (isComplete) {
    return 'Thought';
  }
  return 'Thinking';
}

// Get expanded thinking label (more descriptive)
export function getThinkingExpandedLabel(isComplete: boolean, durationMs?: number): string {
  const durationSeconds =
    typeof durationMs === 'number' ? Math.max(1, Math.round(durationMs / 1000)) : null;

  if (isComplete && durationSeconds) {
    const seconds = Math.round(durationMs! / 1000);
    return `Thought for ${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  if (isComplete) {
    return 'Thought';
  }
  return 'Thinking';
}
