import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ qa: true, fetch: vi.fn() }));
vi.mock('../../shared/updaterQa', () => ({ isModelQaBuild: () => mocks.qa }));
vi.mock('@/api/apiFetch', () => ({ apiFetch: mocks.fetch }));
import ModelQaTitle from './ModelQaTitle';

const receipt = { kind: 'modelqa-title-utility', requestId: 'a', fixtureId: 'expense-summary', providerId: 'qa-kimi', modelId: 'k3',
  runtime: 'builtin', title: '费用包万元展示与毛利校验', generatedAt: '2026-10-15T00:00:00Z', automaticSessionTitle: false, toolsEnabled: false };
const metadata = () => ({ ok: true, profile: 'moxbot-modelqa', runtime: 'builtin',
  providers: [{ id: 'qa-kimi', name: 'QA Kimi', models: [{ id: 'k3', name: 'K3' }] }],
  fixtures: [{ id: 'expense-summary', label: '费用包金额展示与校验', object: '费用包', action: '万元展示与毛利校验', user: '恢复：费用包编辑页万元展示与毛利校验', assistant: '提炼费用包任务概要。' }],
  receipt: null as typeof receipt | null,
});
const json = (value: unknown, status = 200) => Response.json(value, { status });
beforeEach(() => { mocks.qa = true; mocks.fetch.mockReset(); mocks.fetch.mockImplementation(async (_path, options?: RequestInit) =>
  options?.method === 'POST' ? json({ ok: true, status: 'completed', receipt }) : json(metadata())); });
afterEach(cleanup);

it('production does not fetch QA metadata or execute a model', () => {
  mocks.qa = false; render(<ModelQaTitle />);
  expect(screen.getByRole('alert')).toHaveTextContent('独立标题验收'); expect(mocks.fetch).not.toHaveBeenCalled();
});
it('requires explicit action, sends only the fixed pair/fixture and renders a persisted title', async () => {
  render(<ModelQaTitle />); await waitFor(() => expect(screen.getByRole('button', { name: '生成概要标题' })).toBeEnabled());
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '生成概要标题' }));
  expect(await screen.findByText(receipt.title)).toBeVisible();
  const call = mocks.fetch.mock.calls.find(([, options]) => options?.method === 'POST');
  const body = JSON.parse(call![1].body);
  expect(Object.keys(body).sort()).toEqual(['fixtureId', 'modelId', 'providerId', 'requestId']);
  expect(body).toMatchObject({ providerId: 'qa-kimi', modelId: 'k3', fixtureId: 'expense-summary' });
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/); expect(call![1].signal).toBeInstanceOf(AbortSignal);
  const reread = metadata(); reread.receipt = receipt; mocks.fetch.mockResolvedValueOnce(json(reread));
  fireEvent.click(screen.getByRole('button', { name: '重新读取记录' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '生成概要标题' })).toBeEnabled());
  expect(screen.getByText(receipt.title)).toBeVisible();
  expect(mocks.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
it('no authorized models leaves generation disabled', async () => {
  mocks.fetch.mockResolvedValueOnce(json({ ...metadata(), providers: [] })); render(<ModelQaTitle />);
  expect(await screen.findByText(/明确授权的 Provider/)).toBeVisible();
  expect(screen.getByRole('button', { name: '生成概要标题' })).toBeDisabled();
});
it('shows a failed generation without overwriting the preceding receipt or retrying', async () => {
  const old = metadata(); old.receipt = receipt;
  mocks.fetch.mockResolvedValueOnce(json(old)).mockResolvedValueOnce(json({ ok: false, error: 'TITLE_GENERATION_FAILED' }, 502));
  render(<ModelQaTitle />); await screen.findByText(receipt.title);
  fireEvent.click(screen.getByRole('button', { name: '生成概要标题' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('有效概要标题'); expect(screen.getByText(receipt.title)).toBeVisible();
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});
it('cancels through DELETE and waits for the POST terminal instead of only hiding the UI', async () => {
  let finish!: (response: Response) => void;
  mocks.fetch.mockImplementation(async (_path, options?: RequestInit) => {
    if (options?.method === 'POST') return new Promise<Response>(resolve => { finish = resolve; });
    if (options?.method === 'DELETE') return json({ ok: true, status: 'cancelling' }, 202);
    return json(metadata());
  });
  render(<ModelQaTitle />); await waitFor(() => expect(screen.getByRole('button', { name: '生成概要标题' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '生成概要标题' })); fireEvent.click(await screen.findByRole('button', { name: '取消生成' }));
  await screen.findByText('已请求取消，等待调用结束…');
  const post = mocks.fetch.mock.calls.find(([, options]) => options?.method === 'POST')!;
  const id = JSON.parse(post[1].body).requestId;
  expect(mocks.fetch).toHaveBeenCalledWith(`/api/modelqa/title?requestId=${id}`, { method: 'DELETE' });
  expect(post[1].signal.aborted).toBe(true); expect(screen.getByRole('button', { name: '生成概要标题' })).toBeDisabled();
  finish(json({ ok: false, error: 'CANCELLED' }, 499));
  expect(await screen.findByText('本次生成已取消。')).toBeVisible();
  await waitFor(() => expect(screen.getByRole('button', { name: '生成概要标题' })).toBeEnabled());
  expect(screen.queryByText(receipt.title)).not.toBeInTheDocument();
});
it('completion winning the cancel race remains a completed durable receipt', async () => {
  let finish!: (response: Response) => void;
  mocks.fetch.mockImplementation(async (_path, options?: RequestInit) => {
    if (options?.method === 'POST') return new Promise<Response>(resolve => { finish = resolve; });
    if (options?.method === 'DELETE') return json({ ok: true, status: 'completed', receipt });
    return json(metadata());
  });
  render(<ModelQaTitle />); await waitFor(() => expect(screen.getByRole('button', { name: '生成概要标题' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '生成概要标题' })); fireEvent.click(await screen.findByRole('button', { name: '取消生成' }));
  expect(await screen.findByText('调用已完成，概要标题已保存。')).toBeVisible();
  finish(json({ ok: false, error: 'CANCELLED' }, 499));
  await waitFor(() => expect(screen.getByText(receipt.title)).toBeVisible());
  expect(screen.queryByText('本次生成已取消。')).not.toBeInTheDocument();
});
it('unmount dispatches server cancellation and never starts an ordinary turn', async () => {
  mocks.fetch.mockImplementation(async (_path, options?: RequestInit) => options?.method === 'POST'
    ? new Promise<Response>(() => {}) : options?.method === 'DELETE' ? json({ ok: true, status: 'cancelling' }, 202) : json(metadata()));
  const view = render(<ModelQaTitle />); await waitFor(() => expect(screen.getByRole('button', { name: '生成概要标题' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '生成概要标题' })); view.unmount();
  expect(mocks.fetch.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(true);
  expect(mocks.fetch.mock.calls.every(([path]) => path.startsWith('/api/modelqa/title'))).toBe(true);
});
it('refresh keeps model selection within its selected Provider', async () => {
  const first = metadata(); first.providers.push({ id: 'second', name: 'Second', models: [{ id: 'second-model', name: 'Second Model' }] });
  mocks.fetch.mockResolvedValueOnce(json(first)).mockResolvedValueOnce(json(first));
  render(<ModelQaTitle />); await waitFor(() => expect(screen.getByRole('button', { name: '生成概要标题' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Provider' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Second' }));
  expect(screen.getByRole('button', { name: '模型' })).toHaveTextContent('Second Model');
  fireEvent.click(screen.getByRole('button', { name: '重新读取记录' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '生成概要标题' })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Provider' })).toHaveTextContent('Second');
  expect(screen.getByRole('button', { name: '模型' })).toHaveTextContent('Second Model');
});
