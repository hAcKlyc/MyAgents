import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
import { isModelQaBuild } from '../../shared/updaterQa';
import { generateTitle, type TitleRound } from '../title-generator';
import { getAllEffectiveProviders, loadConfig, resolveProviderEnv } from '../utils/admin-config';

const PATH = '/api/modelqa/title';
const LIMIT = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
const fixtures = [
  {
    id: 'expense-summary', label: '费用包金额展示与校验', object: '费用包', action: '万元展示与毛利校验',
    user: '恢复一下前面的讨论，以下只是验收背景。' + '这段背景不代表新的执行请求，请从后面的任务说明提炼概要。'.repeat(32) + '\n【需求：费用包编辑页】把金额改为万元展示，补齐毛利校验和保存提示。',
    assistant: '任务对象是费用包编辑页，目标是万元展示、毛利校验和保存提示；这里只生成简短任务标题。',
  },
  {
    id: 'goal-summary', label: '公司目标承接界面', object: '公司目标', action: '部门分解与负责人选择',
    user: '请先理解一下，我想继续此前的工作。' + '这是合成验收背景，不是标题本身。'.repeat(40) + '\n恢复：承接公司目标界面，补齐部门目标分解与负责人选择，并使层级关系更清晰。',
    assistant: '需要完善公司目标承接界面中的部门分解、负责人选择与层级展示。',
  },
] as const;

type Receipt = {
  kind: 'modelqa-title-utility'; requestId: string; fixtureId: string; providerId: string;
  modelId: string; runtime: 'builtin'; title: string; generatedAt: string;
  automaticSessionTitle: false; toolsEnabled: false;
};
type Operation = { requestId: string; controller: AbortController };
let active: Operation | null = null;

function response(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function failure(status: number, error: string): Response { return response(status, { ok: false, error }); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function statePath(): string {
  if (APP_DATA_DIR_NAME !== '.moxbot-modelqa') throw new Error('MODELQA_PROFILE_MISMATCH');
  const dir = join(homedir(), APP_DATA_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('MODELQA_STATE_UNAVAILABLE');
  return join(dir, 'title-utility-receipt.json');
}
function validReceipt(value: unknown): value is Receipt {
  return record(value) && value.kind === 'modelqa-title-utility' && value.runtime === 'builtin'
    && typeof value.requestId === 'string' && UUID.test(value.requestId)
    && fixtures.some(f => f.id === value.fixtureId)
    && typeof value.providerId === 'string' && ID.test(value.providerId)
    && typeof value.modelId === 'string' && ID.test(value.modelId)
    && typeof value.title === 'string' && value.title.trim().length > 0 && [...value.title].length <= 30
    && typeof value.generatedAt === 'string' && Number.isFinite(Date.parse(value.generatedAt))
    && value.automaticSessionTitle === false && value.toolsEnabled === false
    && Object.keys(value).every(k => ['kind', 'requestId', 'fixtureId', 'providerId', 'modelId', 'runtime', 'title', 'generatedAt', 'automaticSessionTitle', 'toolsEnabled'].includes(k));
}
function readReceipt(): Receipt | null {
  const path = statePath();
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) throw new Error('MODELQA_STATE_UNAVAILABLE');
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return validReceipt(parsed) ? parsed : null;
  } catch { return null; }
}
function persistReceipt(receipt: Receipt): void {
  const path = statePath();
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('MODELQA_STATE_UNAVAILABLE');
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    // Small synchronous commit fences cancellation: DELETE observes either an
    // active operation or its complete receipt, never a cancelled late write.
    writeFileSync(temp, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

function catalog() {
  const config = loadConfig({ strict: true });
  const authorizations = config.modelqaTitleUtilities;
  if (authorizations === undefined) return { config, pairs: [], providers: [] };
  if (!Array.isArray(authorizations) || authorizations.length > 8 || authorizations.some(a => !record(a)
    || Object.keys(a).some(k => k !== 'providerId' && k !== 'modelId')
    || typeof a.providerId !== 'string' || !ID.test(a.providerId)
    || typeof a.modelId !== 'string' || !ID.test(a.modelId))) throw new Error('MODELQA_AUTHORIZATION_INVALID');
  const configured = getAllEffectiveProviders(config);
  const pairs = authorizations.flatMap(a => {
    const provider = configured.find(p => p.id === a.providerId);
    if (!provider || provider.type !== 'api' || provider.enabled === false || provider.id.startsWith('cloud-session:')) return [];
    if (provider.execution !== undefined && (!record(provider.execution) || provider.execution.kind !== 'builtin')) return [];
    const models = Array.isArray(provider.models) ? provider.models : [];
    const model = models.find(m => record(m) && m.model === a.modelId);
    if (!record(model)) return [];
    const env = resolveProviderEnv(provider.id, config, a.modelId);
    if (!env?.apiKey?.trim() || env.providerId !== provider.id || env.credentialSource || env.endpointSource) return [];
    if (env.apiProtocol !== undefined && env.apiProtocol !== 'anthropic' && env.apiProtocol !== 'openai') return [];
    if (!env.baseUrl) return [];
    const url = new URL(env.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return [];
    return [{ providerId: provider.id, modelId: a.modelId as string,
      providerName: typeof provider.name === 'string' ? provider.name : provider.id,
      modelName: typeof model.modelName === 'string' ? model.modelName : a.modelId as string, env }];
  });
  const providers = [...new Set(pairs.map(p => p.providerId))].map(id => ({
    id, name: pairs.find(p => p.providerId === id)!.providerName,
    models: pairs.filter(p => p.providerId === id).map(p => ({ id: p.modelId, name: p.modelName })),
  }));
  return { config, pairs, providers };
}

async function boundedJson(req: Request): Promise<unknown> {
  const size = req.headers.get('Content-Length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > LIMIT)) throw new Error('BODY_TOO_LARGE');
  if (!req.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new Error('JSON_REQUIRED');
  if (!req.body) throw new Error('INVALID_REQUEST');
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > LIMIT) { await reader.cancel(); throw new Error('BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('INVALID_REQUEST'); }
}

async function hasEmptyBody(req: Request): Promise<boolean> {
  const length = req.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== 0)) return false;
  if (!req.body) return true;
  const reader = req.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (value.byteLength > 0) { await reader.cancel(); return false; }
    }
  } finally { reader.releaseLock(); }
}

export async function modelqaTitleHandler(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== PATH) return null;
  if (!isModelQaBuild()) return failure(404, 'NOT_FOUND');
  if (APP_DATA_DIR_NAME !== '.moxbot-modelqa') return failure(503, 'MODELQA_PROFILE_MISMATCH');
  try {
    if (req.method === 'DELETE') {
      const keys = [...url.searchParams.keys()]; const id = url.searchParams.get('requestId');
      if (keys.length !== 1 || keys[0] !== 'requestId' || !id || !UUID.test(id) || !await hasEmptyBody(req)) return failure(400, 'INVALID_REQUEST');
      if (active?.requestId === id) { active.controller.abort(); return response(202, { ok: true, status: 'cancelling', requestId: id }); }
      const receipt = readReceipt();
      return receipt?.requestId === id ? response(200, { ok: true, status: 'completed', receipt }) : failure(404, 'OPERATION_NOT_FOUND');
    }
    if (url.search || !['GET', 'POST'].includes(req.method)) return failure(req.method === 'GET' || req.method === 'POST' ? 400 : 405, 'INVALID_REQUEST');
    const { providers, pairs } = catalog();
    if (req.method === 'GET') return response(200, { ok: true, profile: 'moxbot-modelqa', runtime: 'builtin',
      providers, fixtures: fixtures.map(f => ({ id: f.id, label: f.label, object: f.object, action: f.action, user: f.user, assistant: f.assistant })),
      receipt: readReceipt(), operation: active ? { requestId: active.requestId, status: 'running' } : null });
    let input: unknown;
    try { input = await boundedJson(req); }
    catch (error) { const code = error instanceof Error ? error.message : 'INVALID_REQUEST'; return failure(code === 'BODY_TOO_LARGE' ? 413 : 400, code); }
    if (!record(input) || Object.keys(input).length !== 4 || Object.keys(input).some(k => !['providerId', 'modelId', 'fixtureId', 'requestId'].includes(k))
      || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
      || typeof input.providerId !== 'string' || typeof input.modelId !== 'string') return failure(400, 'INVALID_REQUEST');
    const fixture = fixtures.find(f => f.id === input.fixtureId);
    if (!fixture) return failure(400, 'UNKNOWN_FIXTURE');
    const pair = pairs.find(p => p.providerId === input.providerId && p.modelId === input.modelId);
    if (!pair) return failure(403, 'MODEL_NOT_AUTHORIZED');
    if (active) return failure(409, 'UTILITY_BUSY');
    if (readReceipt()?.requestId === input.requestId) return failure(409, 'REQUEST_ALREADY_COMPLETED');
    if (req.signal.aborted) return failure(499, 'CANCELLED');
    const operation: Operation = { requestId: input.requestId, controller: new AbortController() }; active = operation;
    const abort = () => operation.controller.abort(); req.signal.addEventListener('abort', abort, { once: true });
    try {
      const rounds: TitleRound[] = [{ user: fixture.user, assistant: fixture.assistant }];
      const title = await generateTitle(rounds, pair.modelId, pair.env, operation.requestId, operation.controller.signal);
      if (operation.controller.signal.aborted) return failure(499, 'CANCELLED');
      if (!title) return failure(502, 'TITLE_GENERATION_FAILED');
      const receipt: Receipt = { kind: 'modelqa-title-utility', requestId: operation.requestId, fixtureId: fixture.id,
        providerId: pair.providerId, modelId: pair.modelId, runtime: 'builtin', title, generatedAt: new Date().toISOString(),
        automaticSessionTitle: false, toolsEnabled: false };
      if (!validReceipt(receipt)) return failure(502, 'TITLE_GENERATION_FAILED');
      persistReceipt(receipt);
      return response(200, { ok: true, status: 'completed', receipt });
    } finally {
      req.signal.removeEventListener('abort', abort);
      if (active === operation) active = null;
    }
  } catch { return failure(503, 'MODELQA_UNAVAILABLE'); }
}
