import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Use fetch and Dispatcher from the same undici version (Node's bundled fetch is a different major).
import { EnvHttpProxyAgent, fetch, Headers } from 'undici';
import type { RuntimeEnvPolicy, RuntimeSource } from '../../shared/types/runtime';
import { spawn, type Subprocess } from '../utils/subprocess';
import { buildCodexAppServerLaunchConfig, initializeCodexRpc, JsonRpcClient } from './codex';
import { resolveCodexCommandContext } from './codex-command-context';
import { killWithEscalation } from './utils/kill-with-escalation';

const MAX_BYTES = 1_048_576;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const textItem = (value: unknown): boolean => {
  const item = object(value);
  if (item.type === 'reasoning') return !Array.isArray(item.summary) || item.summary.every(part => object(part).type === 'summary_text');
  return item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)
    && item.content.every(part => ['output_text', 'refusal'].includes(String(object(part).type)));
};
const responseIsText = (value: unknown): boolean => {
  const response = object(value);
  return Array.isArray(response.output) && response.output.every(textItem);
};

/** Reject unknown event types as well as every tool type, before replaying any bytes to Codex. */
export function validateCodexUtilityResponse(body: string, sse: boolean): boolean {
  try {
    if (!sse) {
      const response = object(JSON.parse(body));
      return response.status === 'completed' && responseIsText(response);
    }
    let completed = false;
    const allowed = new Set(['response.created', 'response.in_progress', 'response.completed',
      'response.output_item.added', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done',
      'response.output_text.delta', 'response.output_text.done', 'response.refusal.delta', 'response.refusal.done',
      'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
      'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
      'response.reasoning_text.delta', 'response.reasoning_text.done']);
    for (const frame of body.replace(/\r\n/g, '\n').split('\n\n')) {
      const payload = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!payload || payload === '[DONE]') continue;
      const event = object(JSON.parse(payload));
      if (completed || !allowed.has(String(event.type))) return false;
      if (event.item !== undefined && !textItem(event.item)) return false;
      if (event.part !== undefined && !['output_text', 'refusal', 'summary_text', 'reasoning_text'].includes(String(object(event.part).type))) return false;
      if (event.response !== undefined && !responseIsText(event.response)) return false;
      if (event.type === 'response.completed') {
        if (object(event.response).status !== 'completed') return false;
        completed = true;
      }
    }
    return completed;
  } catch { return false; }
}

/** Only metadata is inspected; credential values remain entirely owned by native Codex. */
export function resolveCodexUtilityEndpoint(configValue: unknown, accountValue: unknown, env: Record<string, string | undefined> = {}): { providerId: string; endpoint: string } | null {
  const config = object(configValue);
  const providerId = typeof config.model_provider === 'string' ? config.model_provider : 'openai';
  if (!/^[A-Za-z0-9_-]+$/.test(providerId)) return null;
  const provider = object(object(config.model_providers)[providerId]);
  if (provider.wire_api !== undefined && provider.wire_api !== 'responses') return null;
  // SigV4 signatures bind the original URL; query-bearing providers need a separate, exact URL contract.
  if (provider.aws || Object.keys(object(provider.query_params)).length) return null;
  const accountType = object(object(accountValue).account).type;
  let base = typeof provider.base_url === 'string' ? provider.base_url : undefined;
  // The built-in OpenAI provider receives cfg.openai_base_url before auth-dependent defaults.
  if (!base && providerId === 'openai' && typeof config.openai_base_url === 'string' && config.openai_base_url) base = config.openai_base_url;
  if (!base && (providerId === 'openai' || provider.requires_openai_auth === true)) {
    if (accountType === 'chatgpt') {
      const chatgptBase = typeof config.chatgpt_base_url === 'string' ? config.chatgpt_base_url : 'https://chatgpt.com/backend-api/';
      base = chatgptBase.replace(/\/+$/, '') + (chatgptBase.replace(/\/+$/, '').endsWith('/codex') ? '' : '/codex');
    } else if (accountType === 'apiKey') {
      base = typeof config.openai_base_url === 'string' ? config.openai_base_url : 'https://api.openai.com/v1';
    }
  }
  if (!base) return null;
  // Native 0.160/0.162 derive inference from config, not this legacy SDK environment variable.
  // Unknown versions may interpret it: disagreement is ambiguous, so never send credentials to a guess.
  if (env.OPENAI_BASE_URL?.trim() && env.OPENAI_BASE_URL.replace(/\/+$/, '') !== base.replace(/\/+$/, '')) return null;
  try {
    const url = new URL(base.replace(/\/+$/, '') + '/responses');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { providerId, endpoint: url.href };
  } catch { return null; }
}

async function boundedBody(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) throw new Error('Missing utility body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Utility body exceeds bound');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Resolve only the proxy used for the fixed upstream scheme, preserving reqwest scheme-over-ALL precedence. */
export function resolveCodexUtilityProxy(endpoint: string, env: Record<string, string | undefined>) {
  const scheme = new URL(endpoint).protocol;
  const value = (lower: string, upper: string) => env[lower]?.trim() || env[upper]?.trim() || '';
  const selected = (scheme === 'https:' ? value('https_proxy', 'HTTPS_PROXY') : value('http_proxy', 'HTTP_PROXY'))
    || value('all_proxy', 'ALL_PROXY');
  if (selected && !['http:', 'https:'].includes(new URL(selected).protocol)) throw new Error('Unsupported native proxy protocol');
  return { httpProxy: scheme === 'http:' ? selected : '', httpsProxy: scheme === 'https:' ? selected : '', noProxy: value('no_proxy', 'NO_PROXY') };
}

/** One-use loopback gate. Native authentication headers are forwarded without inspecting or logging values. */
export async function createCodexUtilityGateway(endpoint: string, model: string, signal: AbortSignal, networkEnv: Record<string, string | undefined> = {}, onDiagnostic?: (stage: string) => void) {
  const diagnostic = (code: string) => { try { onDiagnostic?.(code); } catch { /* diagnostics cannot change execution */ } };
  if (['SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_TLS_REJECT_UNAUTHORIZED'].some(key => networkEnv[key])) {
    diagnostic('network_policy_unsupported');
    throw new Error('Native Codex network policy cannot be preserved by the utility gateway');
  }
  const dispatcher = new EnvHttpProxyAgent(resolveCodexUtilityProxy(endpoint, networkEnv));
  const nonce = randomUUID();
  const path = `/${nonce}/responses`;
  let used = false;
  let failed = false;
  const server = createServer(async (req: IncomingMessage, res) => {
    diagnostic('gateway_request_received');
    const reject = (code = 'gateway_rejected') => { diagnostic(code); failed = true; if (!res.headersSent) res.writeHead(502); res.end(); };
    try {
      // Native model-catalog, telemetry and websocket warmups are not inference.
      // Reject locally without poisoning the one authorized POST or forwarding any auth.
      if (req.method !== 'POST' || req.url !== path) {
        diagnostic(req.url === path ? 'gateway_non_post_rejected' : 'gateway_other_path_rejected');
        res.writeHead(404); res.end(); return;
      }
      if (signal.aborted || used) return reject('gateway_request_rejected');
      used = true;
      diagnostic(req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity' ? 'gateway_encoded_body_rejected' : 'gateway_plain_body');
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return reject('gateway_encoded_body_rejected');
      let payload: Record<string, unknown>;
      try { payload = object(JSON.parse(await boundedBody(req))); } catch { return reject('gateway_invalid_json_rejected'); }
      if (payload.model !== model) return reject('gateway_model_rejected');
      payload.tools = [];
      payload.tool_choice = 'none';
      // No native history, remote tool result, or previous response can enter this isolated request.
      delete payload.previous_response_id;
      delete payload.conversation;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'accept-encoding'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(part => headers.append(key, part));
        else if (value !== undefined) headers.set(key, value);
      }
      headers.set('content-type', 'application/json');
      const upstream = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal, redirect: 'error', ...{ dispatcher } });
      const body = await boundedBody(upstream.body);
      const contentType = upstream.headers.get('content-type') ?? '';
      if (!upstream.ok) { diagnostic(`gateway_upstream_http_${upstream.status}`); return reject('gateway_upstream_http_rejected'); }
      // Some native-compatible providers label valid SSE as plain text/JSON.
      // Recognize framing, then apply the same complete positive event validation.
      const sse = contentType.toLowerCase().includes('text/event-stream') || /^(?:event:|data:|:)/.test(body.trimStart());
      if (!validateCodexUtilityResponse(body, sse)) return reject('gateway_upstream_shape_rejected');
      diagnostic('gateway_response_admitted');
      res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store' });
      res.end(body);
    } catch (error) {
      const code = object(object(error).cause).code;
      const safeCode = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_INVALID_ARG'].find(value => value === code);
      if (safeCode) diagnostic(`network_${safeCode.toLowerCase()}`);
      reject('gateway_transport_failed');
    }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) { await dispatcher.destroy(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { server.closeAllConnections(); server.close(); await dispatcher.destroy(); throw new Error('Utility gateway unavailable'); }
  let closing: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/${nonce}`,
    get failed() { return failed; },
    get used() { return used; },
    close: () => closing ??= (async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await dispatcher.destroy(); })(),
  };
}

export interface CodexTextUtilityInput {
  prompt: string;
  systemPrompt: string;
  model: string;
  runtimeSource?: RuntimeSource;
  envPolicy?: RuntimeEnvPolicy;
  signal?: AbortSignal;
  timeoutMs?: number;
  workspacePath?: string;
  /** Fixed stage codes only; never receives URLs, account details, provider bodies or credentials. */
  onDiagnostic?: (stage: string) => void;
}

export async function generateCodexTextUtility(input: CodexTextUtilityInput): Promise<string | null> {
  if (input.signal?.aborted || !input.model.trim() || !input.prompt.trim()) return null;
  const diagnostic = (code: string) => { try { input.onDiagnostic?.(code); } catch { /* observer only */ } };
  let stage = 'identity_resolve';
  const controller = new AbortController();
  const abort = () => { diagnostic('cancelled'); controller.abort(); };
  input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { diagnostic('timeout'); controller.abort(); }, Math.max(1, Math.min(input.timeoutMs ?? 30_000, 60_000)));
  const children: Subprocess[] = [];
  let directory: string | undefined;
  let gateway: Awaited<ReturnType<typeof createCodexUtilityGateway>> | undefined;
  const aborted = new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
  const kills = new Map<Subprocess, Promise<unknown>>();
  const kill = (proc: Subprocess): Promise<unknown> => {
    const previous = kills.get(proc);
    if (previous) return previous;
    const killing = killWithEscalation({ pid: proc.pid, kill: signal => proc.kill(signal), waitForExit: () => proc.exited },
      { gracefulMs: 250, hardMs: 500, killTree: true });
    kills.set(proc, killing);
    return killing;
  };
  try {
    return await Promise.race([(async (): Promise<string | null> => {
      const context = await resolveCodexCommandContext({ source: input.runtimeSource, envPolicy: input.envPolicy });
      if (controller.signal.aborted) return null;
      const createdDirectory = await mkdtemp(join(tmpdir(), 'moxbots-codex-utility-'));
      if (controller.signal.aborted) { await rm(createdDirectory, { recursive: true, force: true }); return null; }
      directory = createdDirectory;
      const launch = (extra: string[] = [], cwd = directory) => {
        if (controller.signal.aborted) throw new Error('Utility cancelled');
        const config = buildCodexAppServerLaunchConfig({ commandPath: context.commandPath, runtimeSource: context.source, codexEnv: context.env, mcpServers: [] });
        const args = [...config.args.slice(0, -1), '-c', 'features.hooks=false', '-c', 'notify=[]', '-c', 'features.apps=false', '-c', 'features.connectors=false', ...extra, 'app-server'];
        const noProxy = [context.env.no_proxy ?? context.env.NO_PROXY, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
        const proc = spawn(args, { cwd, env: { ...context.env, PWD: cwd, NO_PROXY: noProxy, no_proxy: noProxy }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: process.platform !== 'win32', windowsHide: true });
        children.push(proc);
        // Drain without retaining native logs, which may contain provider/authentication details.
        if (proc.stderr) void boundedBody(proc.stderr).catch(() => undefined);
        const rpc = new JsonRpcClient(proc);
        void rpc.startReading();
        return { proc, rpc };
      };
      stage = 'discovery_start'; diagnostic(stage);
      const discovery = launch([], input.workspacePath ?? directory);
      await initializeCodexRpc(discovery.rpc, 15_000, true);
      stage = 'discovery_account'; diagnostic(stage);
      const account = await discovery.rpc.call('account/read', { refreshToken: false }, 15_000);
      stage = 'discovery_config'; diagnostic(stage);
      const result = object(await discovery.rpc.call('config/read', { cwd: input.workspacePath ?? directory, includeLayers: false }, 15_000));
      const config = object(result.config);
      const target = resolveCodexUtilityEndpoint(config, account, context.env);
      await kill(discovery.proc);
      if (!target || controller.signal.aborted) { if (!target) diagnostic('endpoint_unsupported'); return null; }
      stage = 'gateway_start'; diagnostic(stage);
      const createdGateway = await createCodexUtilityGateway(target.endpoint, input.model, controller.signal, context.env, diagnostic);
      if (controller.signal.aborted) { await createdGateway.close(); return null; }
      gateway = createdGateway;
      diagnostic('gateway_ready');
      // Built-in IDs are reserved in native Codex: override its documented global base,
      // never insert a model_providers.openai entry or replace native authentication.
      const builtInOpenAi = target.providerId === 'openai';
      const extra = ['-c', `model_provider=${JSON.stringify(target.providerId)}`,
        ...(builtInOpenAi ? ['-c', `openai_base_url=${JSON.stringify(gateway.baseUrl)}`] : [
          '-c', `model_providers.${target.providerId}.base_url=${JSON.stringify(gateway.baseUrl)}`,
          '-c', `model_providers.${target.providerId}.supports_websockets=false`]),
        '-c', 'features.enable_request_compression=false', '-c', 'features.responses_websockets=false', '-c', 'features.responses_websockets_v2=false',
        '-c', 'web_search="disabled"', '-c', 'features.shell_tool=false', '-c', 'features.collab=false', '-c', 'features.multi_agent_v2=false',
        '-c', 'features.code_mode=false', '-c', 'features.js_repl=false', '-c', 'features.skill_env_var_dependency_prompt=false'];
      // Native -c paths split literally on dots; quotes are not a TOML key parser.
      // Refuse unrepresentable names rather than leave an inherited MCP enabled.
      for (const name of Object.keys(object(config.mcp_servers))) {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) { diagnostic('mcp_identity_unsupported'); return null; }
        extra.push('-c', `mcp_servers.${name}.enabled=false`);
      }
      const utility = launch(extra);
      const originalProvider = object(object(config.model_providers)[target.providerId]);
      // Native config/read is the authority. Pass its provider snapshot only over RPC,
      // never argv or disk: provider headers may themselves contain authentication.
      const frozenProvider = { ...originalProvider, base_url: gateway.baseUrl, supports_websockets: false };
      if (!Object.keys(originalProvider).length && target.providerId !== 'openai') return null;
      let finish: (text: string | null) => void = () => {};
      const terminal = new Promise<string | null>(resolve => { finish = resolve; });
      let collected = '';
      let rejected = false;
      utility.rpc.setServerRequestHandler((id) => { diagnostic('native_server_request_rejected'); rejected = true; utility.rpc.respondError(id, -32601, 'Text utility forbids server requests'); finish(null); });
      utility.rpc.setNotificationHandler((method, value) => {
        const params = object(value);
        const item = object(params.item);
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          collected += params.delta;
          if (Buffer.byteLength(collected) > MAX_BYTES) { rejected = true; finish(null); }
        } else if ((method === 'item/started' || method === 'item/completed')
          && !['agentMessage', 'reasoning', 'userMessage'].includes(String(item.type))) {
          diagnostic('native_tool_rejected'); rejected = true; finish(null);
        } else if (method === 'turn/completed') {
          diagnostic(object(params.turn).status === 'completed' ? 'native_turn_completed' : 'native_turn_failed');
          finish(!rejected && !gateway?.failed && gateway?.used && object(params.turn).status === 'completed' ? collected.trim() || null : null);
        }
      });
      void utility.proc.exited.then(() => finish(null));
      stage = 'utility_initialize'; diagnostic(stage);
      await initializeCodexRpc(utility.rpc, 15_000, true);
      stage = 'thread_start'; diagnostic(stage);
      const started = object(await utility.rpc.call('thread/start', { cwd: directory, model: input.model, modelProvider: target.providerId,
        config: builtInOpenAi ? { openai_base_url: gateway.baseUrl } : { [`model_providers.${target.providerId}`]: frozenProvider },
        ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: input.systemPrompt, dynamicTools: [], environments: [] }, 15_000));
      const threadId = object(started.thread).id;
      if (typeof threadId !== 'string' || controller.signal.aborted) return null;
      stage = 'turn_start'; diagnostic(stage);
      await utility.rpc.call('turn/start', { threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] }], effort: 'low' }, 15_000);
      return await terminal;
    })(), aborted]);
  } catch (error) {
    diagnostic(`${stage}_failed`);
    const message = error instanceof Error ? error.message : '';
    if (/timed? out|timeout/i.test(message)) diagnostic('rpc_timeout');
    else if (/process exited/.test(message)) diagnostic('native_process_exited');
    else diagnostic('native_rpc_rejected');
    return null;
  }
  finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
    controller.abort();
    await Promise.all(children.map(kill));
    await gateway?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
