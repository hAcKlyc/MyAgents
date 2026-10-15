import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Message from '@/components/Message';
import { ThemeRuntimeProvider } from '@/theme';
import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
import { ChatRowLayoutProvider } from '@/context/ChatRowLayoutContext';
import { i18n } from '@/i18n';
import type { ContentBlock, Message as MessageType } from '@/types/chat';
import '@/index.css';

void i18n.changeLanguage('zh-CN');
function tool(id: string, name: string, input: Record<string, unknown>, patch: Record<string, unknown> = {}): ContentBlock {
  return { type: 'tool_use', tool: { id, name, input, parsedInput: input, inputJson: JSON.stringify(input), result: 'fixture result', isLoading: false, streamIndex: 0, ...patch } } as ContentBlock;
}
function Fixture() {
  const [dark, setDark] = useState(false);
  const [state, setState] = useState<'running' | 'completed' | 'failed' | 'history'>('running');
  const [extra, setExtra] = useState(false);
  const content: ContentBlock[] = [
    { type: 'text', text: '后端上一轮测试通过：core、hrm 构建成功，228 项测试通过。接下来补充数据库隔离与多主体流程验证。新增修改仍需重新测试，真实 API、页面和发布验收尚未完成。' },
    tool('read-1', 'Read', { file_path: '/fixture/salary-carry-forward-subject-isolation.ts' }, { result: 'export function isolateSubject(subjectId: string) { return subjectId; }' }),
    tool('grep-1', 'Grep', { pattern: 'subjectId', path: '/fixture' }, { result: 'salary.ts:4: subjectId', resultMeta: { durationMs: 164 } }),
    tool('read-2', 'Read', { file_path: '/fixture/transaction-rollback.ts' }, { result: 'export const rollback = true;' }),
    tool('edit-1', 'Edit', { file_path: '/fixture/subject-isolation.ts', old_string: 'const isolated = false;', new_string: 'const isolated = true;' }, { result: 'The file /fixture/subject-isolation.ts has been updated successfully.' }),
    tool('edit-2', 'Write', { file_path: '/fixture/salary-rollback.test.ts', content: 'test("rollback", () => true);' }, { result: 'File created successfully at: /fixture/salary-rollback.test.ts' }),
    { type: 'text', text: '本轮修改已写入，正在重新执行针对性检查。执行统计仅反映当前工具调用的返回状态。' },
    tool('test-1', 'Bash', { command: 'npm run test:unit', description: '复验工资结转的主体隔离与失败回滚，确保重试后不会跨主体重复入账' }, {
      result: state === 'running' || state === 'history' ? undefined : state === 'failed' ? 'AssertionError: rollback invariant failed' : 'Tests 24 passed',
      isLoading: state === 'running' || state === 'history',
      isError: state === 'failed',
      resultMeta: state === 'completed' ? { exitCode: 0, durationMs: 2430 } : state === 'failed' ? { exitCode: 1, durationMs: 1940 } : undefined,
    }),
    ...(extra ? [tool('test-2', 'Bash', { command: 'npm run typecheck', description: '检查本次修改的类型约束与相关调用方' }, { result: '', resultMeta: { exitCode: 0, durationMs: 860 } })] : []),
    ...(state === 'completed' ? [{ type: 'text', text: '本轮针对性检查已返回结果。后续还需完成真实 API、页面和发布验收。' } as ContentBlock] : []),
  ];
  const message: MessageType = { id: 'output-fixture', role: 'assistant', timestamp: new Date('2026-10-15T06:00:00Z'), content };
  return <ThemeRuntimeProvider selection={{ themeId: 'myagents-default', appearanceMode: dark ? 'dark' : 'light' }}>
    <ImagePreviewProvider>
      <main className="min-h-screen overflow-x-hidden bg-[var(--paper)] text-[var(--ink)]">
        <div className="mx-auto max-w-4xl px-3 py-6">
          <p className="mb-3 text-xs text-[var(--ink-secondary)]">MOXBOTS-OUTPUT-001 · 合成验收数据 · 生产 Message / BlockGroup / ProcessRow 组件</p>
          <div className="mb-5 flex flex-wrap gap-2">
            {(['running', 'completed', 'failed', 'history'] as const).map(s => <button key={s} type="button" className="rounded border px-2 py-1 text-sm" onClick={() => setState(s)}>{s}</button>)}
            <button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => setExtra(!extra)}>追加检查</button>
            <button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => setDark(!dark)}>切换明暗</button>
            <button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => void i18n.changeLanguage(i18n.language === 'zh-CN' ? 'en-US' : 'zh-CN')}>中 / EN</button>
          </div>
          <ChatRowLayoutProvider messageId={message.id} onRowLayoutChanged={(_id, reason) => { document.documentElement.dataset.lastLayoutReason = reason; }}>
            <Message message={message} isLoading={state === 'running'} />
          </ChatRowLayoutProvider>
        </div>
      </main>
    </ImagePreviewProvider>
  </ThemeRuntimeProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
