import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Message from '@/components/Message';
import { ThemeRuntimeProvider } from '@/theme';
import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
import { ToastProvider } from '@/components/Toast';
import { ChatRowLayoutProvider } from '@/context/ChatRowLayoutContext';
import { i18n } from '@/i18n';
import type { ContentBlock, Message as MessageType } from '@/types/chat';
import '@/index.css';

void i18n.changeLanguage('zh-CN');
const start = Date.parse('2026-10-16T12:11:21Z');
function tool(id: string, name: string, input: Record<string, unknown>, result: string | undefined, patch: Record<string, unknown> = {}): ContentBlock {
  return { id, type: 'tool_use', tool: { id, name, input, parsedInput: input, inputJson: JSON.stringify(input), result, isLoading: false, streamIndex: 0,
    executionTiming: { startedAt: start, finishedAt: start + 1, source: 'observed' }, ...patch } } as ContentBlock;
}
function Fixture() {
  const [dark, setDark] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const [extra, setExtra] = useState(false);
  const [complete, setComplete] = useState(false);
  const [clock] = useState(() => Date.now());
  const blocks: ContentBlock[] = [
    { type: 'thinking', id: 'reasoning', thinking: '先核对主体隔离，再检查失败回滚。这里只展示已有分析记录，不据此宣称测试通过。', isComplete: true, thinkingDurationMs: 1,
      executionTiming: { startedAt: start, finishedAt: start + 1, source: 'observed' } },
    tool('grep-single', 'Grep', { pattern: 'subjectId', path: '/fixture/payroll' }, JSON.stringify({ numLines: 11, content: 'PayrollService.ts:21: subjectId\nPayrollService.ts:36: assertSubject(subjectId)' })),
    ...(extra ? [tool('grep-added', 'Grep', { pattern: 'rollback', path: '/fixture/payroll' }, 'PayrollTransaction.ts:44: rollback()')] : []),
    { type: 'thinking', id: 'empty-reasoning', thinking: '', isComplete: true, executionTiming: { startedAt: start + 5000, finishedAt: start + 5000, source: 'observed' } },
    tool('read-single', 'Read', { file_path: '/fixture/payroll/PayrollService.ts' }, 'export function assertSubject(subjectId: string) {\n  if (!subjectId) throw new Error("subject required");\n  return subjectId;\n}'),
    tool('verify-runtime', 'Bash', { command: 'npm test', description: '验证主体隔离与失败回滚' }, 'Tests 24 passed', { resultMeta: { exitCode: 0, durationMs: 2340 } }),
    tool('empty-result', 'Grep', { pattern: 'no-match' }, JSON.stringify({ numLines: 0, content: '' })),
    tool('zero-runtime', 'Bash', { command: 'npm run typecheck' }, '', { resultMeta: { exitCode: 0, durationMs: 0 } }),
    tool('history', 'Read', {}, undefined, { executionTiming: undefined, isLoading: false }),
    tool('failed', 'Bash', { command: 'npm test' }, 'AssertionError: rollback invariant failed', { isError: true, resultMeta: { exitCode: 1 } }),
    tool('stopped', 'Read', { file_path: '/fixture/stopped.ts' }, undefined, { isStopped: true }),
    tool('edit-1', 'Edit', { file_path: '/fixture/payroll/isolation.ts', old_string: 'const isolated = false;', new_string: 'const isolated = true;' }, 'File updated successfully'),
    tool('edit-2', 'Edit', { file_path: '/fixture/payroll/isolation.ts', old_string: 'const checked = false;', new_string: 'const checked = true;' }, 'File updated successfully'),
    { type: 'text', text: '以下是独立的当前执行项，用于检查展开状态在执行完成后是否保留。' },
    tool('active', 'Read', { file_path: '/fixture/payroll/CurrentCheck.ts', description: '核对当前工资汇总与主体隔离' }, complete ? 'CurrentCheck: subject isolation verified in fixture' : 'CurrentCheck: partial fixture output', {
      isLoading: !complete, executionTiming: { startedAt: clock - 8000, ...(complete ? { finishedAt: clock + 1000 } : {}), lastActivityAt: clock - 4000, source: 'observed' },
    }),
  ];
  const message: MessageType = { id: 'expanded-fixture', role: 'assistant', timestamp: new Date(start), content: blocks };
  return <ThemeRuntimeProvider selection={{ themeId: 'myagents-default', appearanceMode: dark ? 'dark' : 'light' }}>
    <ToastProvider><ImagePreviewProvider>
      <main className="h-screen overflow-y-auto overflow-x-hidden bg-[var(--paper)] text-[var(--ink)]">
        <div className="mx-auto px-3 py-5" style={{ maxWidth: narrow ? 380 : 896 }}>
          <p className="mb-3 text-xs text-[var(--ink-secondary)]">MOXBOTS-OUTPUT-003 · 合成验收 · 生产 Message / BlockGroup / ProcessRow</p>
          <div className="mb-4 flex flex-wrap gap-2">
            <button className="rounded border px-2 py-1 text-sm" onClick={() => setDark(!dark)}>切换明暗</button>
            <button className="rounded border px-2 py-1 text-sm" onClick={() => setNarrow(!narrow)}>切换380窄栏</button>
            <button className="rounded border px-2 py-1 text-sm" onClick={() => void i18n.changeLanguage(i18n.language === 'zh-CN' ? 'en-US' : 'zh-CN')}>中 / EN</button>
            <button className="rounded border px-2 py-1 text-sm" onClick={() => setExtra(!extra)}>追加同类结果</button>
            <button className="rounded border px-2 py-1 text-sm" onClick={() => setComplete(!complete)}>切换执行完成</button>
          </div>
          <ChatRowLayoutProvider messageId={message.id} onRowLayoutChanged={(_id, reason) => { document.documentElement.dataset.layoutReason = reason; }}>
            <Message message={message} isLoading={!complete} />
          </ChatRowLayoutProvider>
        </div>
      </main>
    </ImagePreviewProvider></ToastProvider>
  </ThemeRuntimeProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
