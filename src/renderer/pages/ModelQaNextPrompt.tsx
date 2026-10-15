import { useEffect, useRef, useState } from 'react';
import CustomSelect from '@/components/CustomSelect';
import SimpleChatInput from '@/components/SimpleChatInput';
import { apiFetch } from '@/api/apiFetch';
import { isModelQaBuild } from '../../shared/updaterQa';
import type { NextPromptDraft } from '@/hooks/useNextPromptSuggestion';

type Choice = { runtime: 'codex' | 'claude-code' | 'dsh'; runtimeSource: string; model: string; providerId?: string; label?: string };
type Result = { sessionId: string; anchorMessageId: string; suggestion: string | null; receipt: Record<string, unknown> };

/** Only mounted by the compile-time modelqa entry. Prior messages are explicitly synthetic. */
export default function ModelQaNextPrompt() {
  const [choices, setChoices] = useState<Choice[]>([]);
  const [selection, setSelection] = useState(0);
  const [result, setResult] = useState<Result>();
  const [sendAttempts, setSendAttempts] = useState(0);
  const [composerEpoch, setComposerEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!isModelQaBuild()) return;
    const abort = new AbortController();
    void apiFetch('/api/modelqa/next-prompt', { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('metadata_unavailable');
      const data = await response.json() as { runtimes: Choice[] };
      if (!abort.signal.aborted) setChoices(data.runtimes);
    }).catch(() => { if (!abort.signal.aborted) setError('metadata_unavailable'); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, []);
  if (!isModelQaBuild()) return null;
  const choice = choices[selection];
  const draft: NextPromptDraft | undefined = result ? { key: result.anchorMessageId, sessionId: result.sessionId, text: result.suggestion } : undefined;
  async function run() {
    if (!choice || busy) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setResult(undefined); setSendAttempts(0); setComposerEpoch(0); setError('');
    try {
      const { runtime, runtimeSource, model, providerId } = choice;
      const response = await apiFetch('/api/modelqa/next-prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtime, runtimeSource, model, ...(providerId ? { providerId } : {}) }), signal: abort.signal });
      if (!response.ok) throw new Error(`generation_failed_${response.status}`);
      const data = await response.json() as Result;
      if (!abort.signal.aborted) { setResult(data); if (!data.suggestion) setError('本次模型未返回有效建议'); }
    } catch { if (!abort.signal.aborted) setError('真实生成失败，请查看受控验收记录'); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl p-8 space-y-6" data-testid="modelqa-next-prompt">
    <h1 className="text-xl font-semibold">下一步任务建议 · 独立模型验收</h1>
    <p>下面的前序对话为合成测试数据。建议由所选 Runtime 真实生成；此页面只验收可编辑草稿，发送已禁用。</p>
    <section aria-label="合成前序对话" className="space-y-2 rounded border p-4">
      <p>用户：请为CSV导入功能设计测试方案，重点验证空文件、缺失列和重复数据。</p>
      <p>助手：已列出CSV导入的正常场景与异常场景，接下来可以细化空文件、缺失列和重复数据的输入样例与预期结果。</p>
    </section>
    <div className="flex gap-3">
      <CustomSelect ariaLabel="验收 Runtime" disabled={busy} value={String(selection)} options={choices.map((item, index) => ({ value: String(index), label: item.label ?? `${item.runtime} · ${item.runtimeSource} · ${item.model}` }))} onChange={value => { setSelection(Number(value)); setResult(undefined); setError(''); }} />
      <button type="button" disabled={busy || !choice} onClick={() => void run()}>{busy ? '真实生成中…' : '生成真实建议'}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {result && <>
      <SimpleChatInput key={`${result.anchorMessageId}:${composerEpoch}`} runtime={choice?.runtime} isLoading={false} sessionState="idle" providerAvailable sessionId={result.sessionId} nextPromptSuggestion={draft} onSend={() => { setSendAttempts(count => count + 1); return false; }} />
      <p>Enter 采纳为草稿，Escape 忽略；再次发送也不会执行任务。</p>
      <p role="status" aria-live="polite" data-testid="intercepted-send-attempts">已拦截发送尝试：{sendAttempts}</p>
      {result.suggestion && <div>
        <button type="button" onClick={() => { setComposerEpoch(epoch => epoch + 1); setSendAttempts(0); }}>重置草稿与建议（复用本次结果）</button>
        <p>仅复用本次生成的建议，清空验收草稿与计数；不重新请求模型，回执保持不变。</p>
      </div>}
      <pre data-testid="generation-receipt" className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(result.receipt, null, 2)}</pre>
    </>}
  </main>;
}
