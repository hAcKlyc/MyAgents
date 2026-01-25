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

import type { ToolUseSimple } from '@/types/chat';

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
      const input = tool.parsedInput as { file_path?: string };
      if (input.file_path) {
        const fileName = input.file_path.split('/').pop() || input.file_path;
        return fileName.length > 20 ? `${fileName.substring(0, 17)}...` : fileName;
      }
      return tool.name;
    }
    case 'Bash': {
      const input = tool.parsedInput as { command?: string; description?: string };
      if (input.description) return input.description;
      if (input.command) {
        const cmd = input.command.split(' ')[0];
        return cmd.length > 15 ? `${cmd.substring(0, 12)}...` : cmd;
      }
      return 'Run command';
    }
    case 'BashOutput': {
      return 'Bash Output';
    }
    case 'Grep': {
      const input = tool.parsedInput as { pattern?: string };
      if (input.pattern) {
        const pattern =
          input.pattern.length > 15 ? `${input.pattern.substring(0, 12)}...` : input.pattern;
        return `Search "${pattern}"`;
      }
      return 'Search';
    }
    case 'Glob': {
      const input = tool.parsedInput as { pattern?: string };
      if (input.pattern) {
        const pattern =
          input.pattern.length > 15 ? `${input.pattern.substring(0, 12)}...` : input.pattern;
        return `Find ${pattern}`;
      }
      return 'Find';
    }
    case 'Task': {
      const input = tool.parsedInput as { description?: string };
      if (input.description) {
        return input.description.length > 25 ?
            `${input.description.substring(0, 22)}...`
          : input.description;
      }
      return 'Task';
    }
    case 'WebFetch': {
      const input = tool.parsedInput as { url?: string };
      if (input.url) {
        try {
          const url = new URL(input.url);
          return url.hostname.length > 20 ? `${url.hostname.substring(0, 17)}...` : url.hostname;
        } catch {
          return input.url.length > 20 ? `${input.url.substring(0, 17)}...` : input.url;
        }
      }
      return 'Fetch';
    }
    case 'WebSearch': {
      const input = tool.parsedInput as { query?: string };
      if (input.query) {
        return input.query.length > 20 ? `${input.query.substring(0, 17)}...` : input.query;
      }
      return 'Search';
    }
    case 'TodoWrite': {
      const input = tool.parsedInput as { todos?: Array<{ status?: string }> };
      if (input.todos && input.todos.length > 0) {
        const completedCount = input.todos.filter((t) => t.status === 'completed').length;
        return `Todo ${completedCount}/${input.todos.length}`;
      }
      return 'Todo List';
    }
    case 'Skill': {
      const input = tool.parsedInput as { skill?: string };
      if (input.skill) {
        return `Skill(${input.skill})`;
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
      const input = tool.parsedInput as { description?: string };
      return input?.description || 'Run command';
    }
    case 'BashOutput':
      return 'Bash Output';
    case 'TodoWrite':
      return 'Todo List';
    case 'Task': {
      const input = tool.parsedInput as { description?: string };
      return input?.description || 'Task';
    }
    case 'Read':
    case 'Write':
    case 'Edit':
      return tool.name;
    case 'Skill': {
      const input = tool.parsedInput as { skill?: string };
      return input?.skill ? `Skill(${input.skill})` : 'Skill';
    }
    case 'NotebookEdit': {
      const input = tool.parsedInput as { edit_mode?: string };
      const editMode = input?.edit_mode || 'replace';
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
