import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isModelQaBuild } from '../../shared/updaterQa';
import type { Provider } from '../../shared/config-types';
import { getProviderExecutionConstraint } from '../../shared/integrated-runtimes/provider-constraints';
import type { RuntimeSource } from '../../shared/types/runtime';
import type { SessionEngine } from '../session-engine/types';
import type { RuntimeProcess, RuntimeTextUtilityTask } from '../runtimes/types';
import { createPromptSuggestionService } from '../session-prompt-suggestion';
import { generateCodexTextUtility } from '../runtimes/codex-text-utility';
import { generateClaudeTextUtility } from '../runtimes/claude-text-utility';
import { DshRuntime } from '../integrated-runtimes/dsh/runtime';
import { findEffectiveProvider, loadConfig, resolveProviderEnv, type AdminAppConfig } from '../utils/admin-config';

interface Selection {
  runtime: 'codex' | 'claude-code' | 'dsh';
  runtimeSource: RuntimeSource;
  providerId?: string;
  model: string;
}
let active = false;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const error = (code: string, status: number) => json({ error: code }, status);

function selection(value: unknown): Selection | null {
  const row = record(value);
  if (Object.keys(row).some(key => !['runtime', 'runtimeSource', 'providerId', 'model'].includes(key))) return null;
  if (!['codex', 'claude-code', 'dsh'].includes(String(row.runtime))) return null;
  if (typeof row.model !== 'string' || !row.model.trim() || row.model.length > 160 || /[\r\n\0]/.test(row.model)) return null;
  const runtime = row.runtime as Selection['runtime'];
  const runtimeSource = row.runtimeSource ?? (runtime === 'dsh' ? 'integrated' : 'system-cli');
  if (runtime === 'codex' ? !['system-cli', 'managed-provider'].includes(String(runtimeSource))
    : runtimeSource !== (runtime === 'dsh' ? 'integrated' : 'system-cli')) return null;
  if (runtime !== 'dsh' && row.providerId !== undefined) return null; // CLI authentication is native, never an SDK Provider projection.
  if (runtime === 'dsh' && (typeof row.providerId !== 'string' || !row.providerId || row.providerId.length > 160)) return null;
  return { runtime, runtimeSource: runtimeSource as RuntimeSource, model: row.model, ...(runtime === 'dsh' ? { providerId: row.providerId as string } : {}) };
}

/** Dedicated modelqa config is the explicit authorization list; no inferred SDK/native identity substitutions. */
function configuredSelections(config: AdminAppConfig): Selection[] {
  const values = Array.isArray(config.modelqaNextPromptRuntimes) ? config.modelqaNextPromptRuntimes.slice(0, 32) : [];
  return values.flatMap(value => {
    const option = selection(value);
    if (!option) return [];
    if (option.runtime === 'dsh') {
      const provider = findEffectiveProvider(option.providerId!, config) as Provider | null;
      try {
        if (!provider || provider.enabled === false || !provider.models.some(model => model.model === option.model)
          || getProviderExecutionConstraint(provider).kind !== 'portable' || !resolveProviderEnv(provider.id, config, option.model)) return [];
      } catch { return []; }
    }
    return [option];
  });
}

async function boundedJson(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) return null;
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2_048) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export async function modelqaNextPromptHandler(req: Request): Promise<Response | null> {
  if (new URL(req.url).pathname !== '/api/modelqa/next-prompt' || !isModelQaBuild()) return null;
  if (!['GET', 'POST'].includes(req.method)) return error('method_not_allowed', 405);
  let config: AdminAppConfig;
  let options: Selection[];
  try { config = loadConfig({ strict: true }); options = configuredSelections(config); }
  catch { return error('modelqa_config_unavailable', 503); }
  if (req.method === 'GET') return json({ runtimes: options.map(option => ({ ...option, label: `${option.runtime} / ${option.runtimeSource} / ${option.model}` })) });
  const selected = selection(await boundedJson(req));
  if (!selected) return error('invalid_selection', 400);
  const option = options.find(value => JSON.stringify(value) === JSON.stringify(selected));
  if (!option) return error('selection_not_authorized', 403);
  if (active) return error('generation_busy', 409);
  if (req.signal.aborted) return error('generation_cancelled', 499);
  active = true;
  const started = Date.now();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  req.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 60_000);
  let directory: string | undefined;
  let dsh: DshRuntime | undefined;
  let process: RuntimeProcess | undefined;
  let boundaryViolation = false;
  let retired = false;
  let generationSettled = true;
  let handlerCleanupComplete = false;
  let pendingNative = 0;
  const releaseWhenSettled = () => {
    if (handlerCleanupComplete && generationSettled && pendingNative === 0) active = false;
  };
  const trackNative = <T>(work: Promise<T>): Promise<T> => {
    pendingNative += 1;
    return work.finally(() => { pendingNative -= 1; releaseWhenSettled(); });
  };
  try {
    directory = await mkdtemp(join(tmpdir(), 'moxbots-modelqa-next-prompt-'));
    const workspacePath = await realpath(directory);
    const sessionId = randomUUID();
    const anchorMessageId = 'synthetic-csv-assistant';
    const messages = [
      { id: 'synthetic-csv-user', role: 'user', content: '请为CSV导入功能设计测试方案，重点验证空文件、缺失列和重复数据。', timestamp: '' },
      { id: anchorMessageId, role: 'assistant', content: '已列出CSV导入的正常场景与异常场景，接下来可以细化空文件、缺失列和重复数据的输入样例与预期结果。', timestamp: '', transcriptState: 'complete' },
    ];
    const runTextUtility = async (task: RuntimeTextUtilityTask) => {
      if (controller.signal.aborted || retired) return null;
      const input = { ...task, model: option.model, workspacePath, signal: controller.signal, timeoutMs: 60_000 };
      if (option.runtime === 'codex') return generateCodexTextUtility({ ...input, runtimeSource: option.runtimeSource });
      if (option.runtime === 'claude-code') return generateClaudeTextUtility(input);
      dsh = new DshRuntime();
      const runtime = dsh;
      const preparing = trackNative(runtime.startSession({ sessionId, workspacePath, model: option.model,
        runtimeSource: 'integrated', providerRoute: { kind: 'provider', providerId: option.providerId!, model: option.model },
        permissionMode: 'approval-required', scenario: { type: 'desktop' }, maxTurns: 1,
        // Deliberately no initialTurn, no Product extensions/MCP, no normal send.
      }, event => {
        if (['turn_started', 'text_delta', 'tool_use_start', 'permission_request'].includes(event.kind)) { boundaryViolation = true; controller.abort(); }
      }).then(async handle => {
        if (controller.signal.aborted || retired) { await runtime.stopSession(handle).catch(() => undefined); return null; }
        process = handle; return handle;
      })); // Tracks both admission and a late handle's complete stop, beyond the aborted race.
      const aborted = new Promise<null>(resolve => {
        if (controller.signal.aborted) resolve(null);
        else controller.signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      const ready = await Promise.race([preparing, aborted]);
      return ready && !boundaryViolation ? runtime.runTextUtility(ready, input) : null;
    };
    const engine = {
      getRuntimeIdentity: () => ({ kind: 'external', runtime: option.runtime, runtimeSource: option.runtimeSource, sessionId }),
      getLiveSessionState: () => ({ sessionState: 'idle', isBusy: false, waitingForUser: false }),
      getLiveSessionOverlay: () => ({ isActive: true, inMemoryMessages: messages }),
      getCurrentSessionContext: () => ({ sessionId, workspacePath }),
      getSessionCompletionTerminal: () => ({ sessionId, status: 'complete' }),
      getSessionConfigSnapshot: () => ({ model: option.model }),
      getHeldImConfigSnapshot: () => ({}), runTextUtility,
    } as unknown as SessionEngine;
    const cancelled = new Promise<null>(resolve => {
      if (controller.signal.aborted) resolve(null);
      else controller.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    generationSettled = false;
    const generation = createPromptSuggestionService()(engine, { sessionId, anchorMessageId }, controller.signal);
    const settled = () => { generationSettled = true; releaseWhenSettled(); };
    void generation.then(settled, settled);
    const response = await Promise.race([generation, cancelled]);
    if (boundaryViolation) return error('native_boundary_violation', 500);
    if (controller.signal.aborted) return error(req.signal.aborted ? 'generation_cancelled' : 'generation_timeout', req.signal.aborted ? 499 : 504);
    return json({ sessionId, anchorMessageId, suggestion: response?.suggestion ?? null, receipt: { ...option,
      syntheticPriorTranscript: true, normalTurnStarted: false, noTools: true, ...(option.runtime === 'dsh' ? { qaNativeArtifacts: 'isolated-profile-preparation' } : {}), elapsedMs: Date.now() - started } });
  } catch { return error(controller.signal.aborted ? 'generation_cancelled' : 'generation_failed', controller.signal.aborted ? 499 : 500); }
  finally {
    retired = true; clearTimeout(timer); controller.abort(); req.signal.removeEventListener('abort', cancel);
    if (dsh && process) await dsh.stopSession(process).catch(() => undefined);
    try { if (directory) await rm(directory, { recursive: true, force: true }); } catch { /* only an isolated synthetic workspace; never expose filesystem errors */ }
    finally { handlerCleanupComplete = true; releaseWhenSettled(); } // Admission, generation, and late-stop cleanup all retain the slot.
  }
}
