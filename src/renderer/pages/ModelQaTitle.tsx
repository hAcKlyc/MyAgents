import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/api/apiFetch';
import { isModelQaBuild } from '../../shared/updaterQa';

type Receipt = {
  requestId: string; fixtureId: string; providerId: string; modelId: string;
  runtime: 'builtin'; title: string; generatedAt: string;
  kind: 'modelqa-title-utility'; automaticSessionTitle: false; toolsEnabled: false;
};
type Metadata = {
  profile: 'moxbot-modelqa'; runtime: 'builtin';
  providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
  fixtures: Array<{ id: string; label: string; object: string; action: string; user: string; assistant: string }>;
  receipt: Receipt | null;
};
type Active = { requestId: string; epoch: number; controller: AbortController };
const ENDPOINT = '/api/modelqa/title';
const messages: Record<string, string> = {
  MODEL_NOT_AUTHORIZED: '此 Provider 与模型尚未在隔离配置中授权。',
  UTILITY_BUSY: '已有标题调用进行中，请等待完成。',
  CANCELLED: '本次生成已取消。',
  TITLE_GENERATION_FAILED: '模型未返回有效概要标题，请检查隔离环境的模型状态。',
  REQUEST_ALREADY_COMPLETED: '此请求已完成，请重新读取验收记录。',
  MODELQA_UNAVAILABLE: '隔离配置或验收记录暂不可用。',
  MODELQA_PROFILE_MISMATCH: '当前环境与标题验收配置不一致。',
};
async function payload(response: Response) {
  const data = await response.json() as { ok?: boolean; error?: string; receipt?: Receipt; status?: string } & Partial<Metadata>;
  if (!response.ok || data.ok !== true) throw new Error(messages[data.error ?? ''] ?? `标题验收请求失败（${response.status}）。`);
  return data;
}

export default function ModelQaTitle() {
  const enabled = isModelQaBuild();
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [fixtureId, setFixtureId] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const mounted = useRef(false);
  const epoch = useRef(0);
  const active = useRef<Active | null>(null);

  const refresh = useCallback(async () => {
    const generation = ++epoch.current;
    setLoading(true); setError('');
    try {
      const data = await payload(await apiFetch(ENDPOINT));
      if (!mounted.current || generation !== epoch.current) return;
      if (data.profile !== 'moxbot-modelqa' || !Array.isArray(data.providers) || !Array.isArray(data.fixtures)) throw new Error('标题验收配置不完整。');
      const next = data as Metadata; setMetadata(next); setReceipt(next.receipt);
      setProviderId(previous => next.providers.some(p => p.id === previous) ? previous : next.providers[0]?.id ?? '');
      setModelId(previous => next.providers.some(p => p.models.some(m => m.id === previous)) ? previous : next.providers[0]?.models[0]?.id ?? '');
      setFixtureId(previous => next.fixtures.some(f => f.id === previous) ? previous : next.fixtures[0]?.id ?? '');
    } catch (failure) {
      if (mounted.current && generation === epoch.current) setError(failure instanceof Error ? failure.message : '无法读取标题验收配置。');
    } finally { if (mounted.current && generation === epoch.current) setLoading(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (enabled) void refresh(); else setLoading(false);
    return () => {
      mounted.current = false; epoch.current += 1;
      const pending = active.current; active.current = null;
      if (pending) {
        pending.controller.abort();
        // Tauri invoke cannot be interrupted by a JS AbortSignal alone.
        void apiFetch(`${ENDPOINT}?requestId=${pending.requestId}`, { method: 'DELETE' }).catch(() => {});
      }
    };
  }, [enabled, refresh]);

  const generate = async () => {
    if (active.current || !metadata || !providerId || !modelId || !fixtureId) return;
    const operation: Active = { requestId: crypto.randomUUID(), epoch: ++epoch.current, controller: new AbortController() };
    active.current = operation; setBusy(true); setCancelling(false); setError(''); setStatus('正在生成概要标题…');
    try {
      const data = await payload(await apiFetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: operation.controller.signal,
        body: JSON.stringify({ providerId, modelId, fixtureId, requestId: operation.requestId }),
      }));
      if (!mounted.current || operation.epoch !== epoch.current) return;
      if (!data.receipt) throw new Error('调用完成但未返回验收记录。');
      setReceipt(data.receipt); setStatus('概要标题已保存到隔离验收记录。');
    } catch (failure) {
      if (!mounted.current || operation.epoch !== epoch.current) return;
      if (operation.controller.signal.aborted) setStatus('本次生成已取消。');
      else { setStatus(''); setError(failure instanceof Error ? failure.message : '标题生成失败。'); }
    } finally {
      if (active.current === operation) active.current = null;
      if (mounted.current && operation.epoch === epoch.current) { setBusy(false); setCancelling(false); }
    }
  };
  const cancel = async () => {
    const operation = active.current;
    if (!operation || cancelling) return;
    setCancelling(true); setError('');
    try {
      const data = await payload(await apiFetch(`${ENDPOINT}?requestId=${operation.requestId}`, { method: 'DELETE' }));
      if (!mounted.current || active.current !== operation) return;
      if (data.status === 'completed' && data.receipt) {
        // Completion won the race. Do not label a durable result cancelled.
        epoch.current += 1; active.current = null; setReceipt(data.receipt);
        setStatus('调用已完成，概要标题已保存。'); setBusy(false); setCancelling(false);
      } else if (data.status === 'cancelling') {
        operation.controller.abort(); setStatus('已请求取消，等待调用结束…');
      } else throw new Error('服务未确认取消状态。');
    } catch (failure) {
      if (mounted.current && active.current === operation) {
        setError(failure instanceof Error ? failure.message : '取消未获确认，请等待调用结束。'); setCancelling(false);
      }
    }
  };

  if (!enabled) return <main role="alert" className="p-6">此页面仅用于独立标题验收环境。</main>;
  const provider = metadata?.providers.find(p => p.id === providerId);
  const fixture = metadata?.fixtures.find(f => f.id === fixtureId);
  const canGenerate = Boolean(provider?.models.some(m => m.id === modelId) && fixture && !busy && !loading);
  return <main className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-y-auto p-6 text-[var(--text-primary)]">
    <header>
      <h1 className="text-xl font-semibold">任务标题验收</h1>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">使用固定合成任务和已授权模型生成简短概要，结果保存于本隔离环境。</p>
    </header>
    {loading && <p role="status">正在读取验收配置…</p>}
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {metadata && metadata.providers.length === 0 && <p role="status">请由验收负责人配置明确授权的 Provider 与模型。</p>}
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1">Provider
        <select aria-label="Provider" className="rounded border p-2" value={providerId} disabled={busy || loading} onChange={event => {
          setProviderId(event.target.value); setModelId(metadata?.providers.find(p => p.id === event.target.value)?.models[0]?.id ?? '');
        }}>
          {!providerId && <option value="">未配置</option>}
          {metadata?.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">模型
        <select aria-label="模型" className="rounded border p-2" value={modelId} disabled={busy || loading} onChange={event => setModelId(event.target.value)}>
          {!modelId && <option value="">未配置</option>}
          {provider?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
    </div>
    <label className="flex flex-col gap-1">验收任务
      <select aria-label="验收任务" className="rounded border p-2" value={fixtureId} disabled={busy || loading} onChange={event => setFixtureId(event.target.value)}>
        {metadata?.fixtures.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
    </label>
    {fixture && <section className="rounded border p-4">
      <p>任务对象：{fixture.object}</p><p>目标：{fixture.action}</p>
      <details className="mt-3"><summary>查看合成任务上下文</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm">{fixture.user}</p></details>
    </section>}
    <div className="flex flex-wrap gap-3">
      <button type="button" className="rounded border px-4 py-2 disabled:opacity-50" disabled={!canGenerate} onClick={() => void generate()}>生成概要标题</button>
      {busy && <button type="button" className="rounded border px-4 py-2 disabled:opacity-50" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消生成'}</button>}
      <button type="button" className="rounded border px-4 py-2 disabled:opacity-50" disabled={busy || loading} onClick={() => void refresh()}>重新读取记录</button>
    </div>
    {status && <p role="status">{status}</p>}
    {receipt && <section aria-label="最近保存的标题" className="rounded border p-4">
      <h2 className="text-sm text-[var(--text-secondary)]">最近保存的概要标题</h2>
      <p className="mt-2 break-words text-lg font-semibold">{receipt.title}</p>
      <p className="mt-2 text-sm">{receipt.providerId} / {receipt.modelId} / {receipt.runtime}</p>
      <p className="text-sm">{new Date(receipt.generatedAt).toLocaleString('zh-CN')}</p>
    </section>}
    <p className="text-sm text-[var(--text-secondary)]">记录类型为隔离 utility 验收。普通会话的自动触发与标题持久化须在对应链路分别验证。</p>
  </main>;
}
