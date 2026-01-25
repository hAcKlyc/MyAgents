
import type { AgentInput, SubagentToolCall, ToolUseSimple } from '@/types/chat';

import Markdown from '@/components/Markdown';
import { CheckCircle, Clock, Loader2, Terminal, Wrench, XCircle } from 'lucide-react';
import { useMemo } from 'react';

interface TaskToolProps {
  tool: ToolUseSimple;
}

// Task 结果的类型定义
interface TaskResultContent {
  type: 'text' | string;
  text?: string;
}

interface TaskResult {
  status?: 'completed' | 'pending' | 'error' | string;
  prompt?: string;
  agentId?: string;
  content?: TaskResultContent[];
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

// 格式化时间
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export default function TaskTool({ tool }: TaskToolProps) {
  const input = tool.parsedInput as AgentInput;

  if (!input) {
    return <div className="text-sm text-[var(--ink-muted)]">Initializing task...</div>;
  }

  // Helper to render nested subagent calls
  const renderSubagentCall = (call: SubagentToolCall) => {
    // Determine description
    const description =
      (call.parsedInput && typeof call.parsedInput === 'object' && 'description' in call.parsedInput)
        ? String(call.parsedInput.description ?? '')
        : typeof call.input === 'object' && call.input && 'description' in call.input
          ? String(call.input.description ?? '')
          : '';

    const inputText = call.inputJson ?? (call.input ? JSON.stringify(call.input, null, 2) : undefined);
    const isRunning = call.isLoading && !call.result;

    return (
      <div key={call.id} className="group flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex size-6 items-center justify-center rounded bg-[var(--accent-cool)]/10 text-[var(--accent-cool)]">
              <Terminal className="size-3.5" />
            </div>
            <span className="text-sm font-medium text-[var(--ink)]">{call.name}</span>
          </div>
          {isRunning && (
            <div className="flex items-center gap-1.5 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
              <Loader2 className="size-3 animate-spin" />
              <span>Running</span>
            </div>
          )}
        </div>

        {description && <div className="text-xs text-[var(--ink-muted)]">{description}</div>}

        {/* Input Preview (Collapsed by default logic in future? For now just show if short or formatted) */}
        {inputText && (
          <div className="relative overflow-hidden rounded-md bg-[var(--paper-contrast)] border border-[var(--line-subtle)]">
            <pre className="max-h-32 overflow-y-auto p-2 font-mono text-[10px] text-[var(--ink-secondary)] whitespace-pre-wrap word-break-break-word">
              {inputText}
            </pre>
          </div>
        )}

        {/* Result */}
        {call.result && (
          <div className="mt-1">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">Result</div>
            <pre className="max-h-48 overflow-y-auto rounded-md bg-[var(--paper-contrast)]/50 p-2 font-mono text-[10px] text-[var(--ink-secondary)] whitespace-pre-wrap">
              {call.result}
            </pre>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      {/* Prompt / Goal */}
      {input.prompt && (
        <div className="rounded-lg bg-[var(--accent-cool)]/10 p-3 italic text-[var(--ink-secondary)]">
          "{input.prompt}"
        </div>
      )}

      {/* Subagent Calls */}
      {tool.subagentCalls && tool.subagentCalls.length > 0 && (
        <div className="space-y-2">
          <div className="px-1 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
            Trace ({tool.subagentCalls.length})
          </div>
          <div className="space-y-2">
            {tool.subagentCalls.map(renderSubagentCall)}
          </div>
        </div>
      )}

      {/* Final Result */}
      {tool.result && <TaskResultDisplay result={tool.result} />}
    </div>
  );
}

// 分离出 Task 结果展示组件
function TaskResultDisplay({ result }: { result: string }) {
  // 尝试解析 JSON 结果
  const parsedResult = useMemo<TaskResult | null>(() => {
    try {
      const parsed = JSON.parse(result);
      // 验证是否是 Task 结果格式（至少有 status 或 content）
      if (parsed && (parsed.status || parsed.content)) {
        return parsed as TaskResult;
      }
      return null;
    } catch {
      return null;
    }
  }, [result]);

  // 无法解析时，显示原始内容
  if (!parsedResult) {
    return (
      <div className="mt-2 space-y-1.5">
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">Output</div>
        <pre className="overflow-x-auto rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-contrast)] p-3 font-mono text-sm text-[var(--ink)] whitespace-pre-wrap">
          {result}
        </pre>
      </div>
    );
  }

  // 提取文本内容
  const textContent = parsedResult.content
    ?.filter((item) => item.type === 'text' && item.text)
    .map((item) => item.text)
    .join('\n\n');

  const statusIcon =
    parsedResult.status === 'completed' ? (
      <CheckCircle className="size-3.5 text-[var(--success)]" />
    ) : parsedResult.status === 'error' ? (
      <XCircle className="size-3.5 text-[var(--error)]" />
    ) : (
      <Loader2 className="size-3.5 animate-spin text-[var(--accent)]" />
    );

  const statusLabel =
    parsedResult.status === 'completed' ? '完成' : parsedResult.status === 'error' ? '错误' : '进行中';

  return (
    <div className="mt-2 space-y-3">
      {/* 状态信息栏 */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--ink-muted)]">
        {/* 状态 */}
        <div className="flex items-center gap-1">
          {statusIcon}
          <span>{statusLabel}</span>
        </div>

        {/* 耗时 */}
        {parsedResult.totalDurationMs != null && (
          <div className="flex items-center gap-1">
            <Clock className="size-3.5" />
            <span>{formatDuration(parsedResult.totalDurationMs)}</span>
          </div>
        )}

        {/* 工具调用次数 */}
        {parsedResult.totalToolUseCount != null && parsedResult.totalToolUseCount > 0 && (
          <div className="flex items-center gap-1">
            <Wrench className="size-3.5" />
            <span>{parsedResult.totalToolUseCount} 次工具调用</span>
          </div>
        )}
      </div>

      {/* 内容输出 - 使用 Markdown 渲染 */}
      {textContent && (
        <div className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-contrast)]/50 p-3">
          <div className="text-sm text-[var(--ink)]">
            <Markdown>{textContent}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}
