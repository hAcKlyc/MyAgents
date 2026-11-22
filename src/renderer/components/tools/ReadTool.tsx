import { useTranslation } from 'react-i18next';
import type { ReadInput, ToolUseSimple } from '@/types/chat';

import { ExpandableResult, FilePath } from './utils';

interface ReadToolProps {
  tool: ToolUseSimple;
}

export default function ReadTool({ tool }: ReadToolProps) {
  const { t } = useTranslation('chat');
  const input = tool.parsedInput as ReadInput | undefined;
  const firstLine = input?.offset ?? (input?.limit ? 1 : undefined);
  const lastLine = firstLine && input?.limit ? firstLine + input.limit - 1 : undefined;
  const lineLabel = lastLine === undefined ? 'startLine' : lastLine === firstLine ? 'line' : 'lines';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <FilePath path={typeof input?.file_path === 'string' ? input.file_path : undefined} lineNumber={firstLine} />
        {firstLine !== undefined && (
          <span className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
            {t(`shell.toolChrome.filePath.${lineLabel}`, { line: firstLine, from: firstLine, to: lastLine })}
          </span>
        )}
      </div>

      {tool.result && tool.result !== '""' ? (
        <ExpandableResult
          content={tool.result}
          className="rounded bg-[var(--paper-inset)]/50 px-2 py-1 wrap-break-word text-[var(--ink-secondary)]"
        />
      ) : (
        <p className="text-xs text-[var(--ink-muted)]">
          {t(tool.isLoading ? 'shell.toolChrome.common.running' : 'shell.toolChrome.filePath.noReadContent')}
        </p>
      )}
    </div>
  );
}
