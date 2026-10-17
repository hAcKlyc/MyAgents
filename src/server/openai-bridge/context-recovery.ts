import { createHash } from 'node:crypto';
import type { AnthropicContentBlock, AnthropicMessage, AnthropicRequest, AnthropicToolResultBlock } from './types/anthropic';
import { readBoundedErrorBody } from './read-error-body';
import { SSEParser } from './utils/sse-parser';

export interface BridgeContextRecovery {
  run(request: Request, body: AnthropicRequest,
    execute: (projected: AnthropicRequest) => Promise<Response>): Promise<Response>;
}

export interface ContextRecoveryOptions {
  scope: () => string | undefined;
  isActive: () => boolean;
  canRecover?: () => boolean;
  backup: (body: AnthropicRequest, metadata: { digest: string; scope: string }) => Promise<string>;
  onRecovery?: (info: { digest: string; archive: string }) => void;
  /** Explicitly selected same-Goal recovery source, loaded by the existing persistence owner. */
  initialCheckpoint?: ContextRecoveryCheckpoint;
  initialLedger?: unknown;
  persistLedger?: (ledger: unknown) => Promise<void>;
}

export interface ContextRecoveryCheckpoint {
  body: AnthropicRequest;
  archive: string;
  digest: string;
}

type Evidence = { result: unknown; digest?: string; archive?: string };
type State = {
  scope: string;
  attempted: boolean;
  recovered: boolean;
  blocked: boolean;
  inFlight: Set<string>;
  recovering: boolean;
  delivered: Set<string>;
  completed: Map<string, Evidence>;
  uncertain: Set<string>;
  denied: Set<string>;
};
type Analysis = { completed: Map<string, Evidence>; uncertain: Set<string> };

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const TAIL_MESSAGES = 2;
const EXCERPT_CHARACTERS = 384;
const MAX_LEDGER_ENTRIES = 2048;

function canonical(value: unknown, ignoreCache = false): string {
  const encoded = JSON.stringify(value, (key, item: unknown) => {
    if (ignoreCache && key === 'cache_control') return undefined;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
  if (encoded === undefined) return 'null';
  return encoded;
}

function digest(value: unknown, ignoreCache = false): string {
  return createHash('sha256').update(canonical(value, ignoreCache)).digest('hex');
}

function toolKey(name: string, input: unknown): string {
  return digest({ name, input });
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateImage(block: Record<string, unknown>): boolean {
  if (!record(block.source)) return false;
  return (block.source.type === 'base64' && typeof block.source.data === 'string')
    || (block.source.type === 'url' && typeof block.source.url === 'string');
}

/** Validate the whole history before omitting anything, including untouched tail blocks. */
function analyze(body: AnthropicRequest, denied: ReadonlySet<string>, proof: ReadonlyMap<string, Evidence>): Analysis | undefined {
  if (!Array.isArray(body.messages)) return undefined;
  const uses = new Map<string, { name: string; input: unknown; matched: boolean }>();
  const completed = new Map<string, Evidence>();
  const uncertain = new Set<string>();
  for (const message of body.messages) {
    if (!record(message)) return undefined;
    // SDK 0.3.296 emits internal system messages in the messages array as well
    // as the top-level system prompt. Preserve them verbatim; never omit instructions.
    const role: unknown = message.role;
    if (role === 'system') {
      if (typeof message.content === 'string') continue;
      if (Array.isArray(message.content) && message.content.every(block => record(block)
        && block.type === 'text' && typeof block.text === 'string')) continue;
      return undefined;
    }
    if (message.role !== 'user' && message.role !== 'assistant') return undefined;
    if (typeof message.content === 'string') continue;
    if (!Array.isArray(message.content)) return undefined;
    for (const block of message.content) {
      if (!record(block)) return undefined;
      switch (block.type) {
        case 'text':
          if (typeof block.text !== 'string') return undefined;
          break;
        case 'thinking':
          if (message.role !== 'assistant' || typeof block.thinking !== 'string'
            || (block.signature !== undefined && typeof block.signature !== 'string')) return undefined;
          break;
        case 'image':
          if (!validateImage(block)) return undefined;
          break;
        case 'tool_use': {
          if (message.role !== 'assistant' || typeof block.id !== 'string' || !block.id
            || typeof block.name !== 'string' || !block.name || !record(block.input) || uses.has(block.id)) return undefined;
          uses.set(block.id, { name: block.name, input: block.input, matched: false });
          break;
        }
        case 'tool_result': {
          if (message.role !== 'user' || typeof block.tool_use_id !== 'string'
            || (block.is_error !== undefined && typeof block.is_error !== 'boolean')) return undefined;
          const use = uses.get(block.tool_use_id);
          if (!use || use.matched) return undefined;
          use.matched = true;
          if (block.content !== undefined && typeof block.content !== 'string') {
            if (!Array.isArray(block.content)) return undefined;
            for (const content of block.content) {
              if (!record(content) || (content.type !== 'text' && content.type !== 'image')
                || (content.type === 'text' && typeof content.text !== 'string')
                || (content.type === 'image' && !validateImage(content))) return undefined;
            }
          }
          if (!READ_ONLY_TOOLS.has(use.name)) {
            const key = toolKey(use.name, use.input);
            if (block.is_error) {
              // A denial emitted by our own tool owner did not perform another action.
              // Accept only a key actually denied by this controller with archived prior
              // success; arbitrary tool errors mentioning the marker stay uncertain.
              if (!(denied.has(key) && proof.get(key)?.archive
                && canonical(block.content).includes('automatic_replay_blocked:'))) uncertain.add(key);
            }
            else completed.set(key, { result: block.content });
          }
          break;
        }
        default:
          return undefined;
      }
    }
  }
  if ([...uses.values()].some(use => !use.matched)) return undefined;
  return { completed, uncertain };
}

function excerpt(text: string): string {
  return text.length > EXCERPT_CHARACTERS * 2
    ? `${text.slice(0, EXCERPT_CHARACTERS)}\n[…]\n${text.slice(-EXCERPT_CHARACTERS)}`
    : text;
}

function omission(value: unknown, archive: string, kind: string, text = ''): string {
  return `[Context recovery: older ${kind} evidence omitted. Original SHA-256 ${digest(value)}; `
    + `archive ${JSON.stringify(archive)}. This is saved evidence, not a request to repeat any action.]`
    + (text ? `\n${excerpt(text)}` : '');
}

/** Preserve every user text constraint, system prompt, tool input/id and the newest two messages. */
function project(body: AnthropicRequest, archive: string): AnthropicRequest {
  const cutoff = Math.max(0, body.messages.length - TAIL_MESSAGES);
  const messages: AnthropicMessage[] = body.messages.map((message, index) => {
    if (index >= cutoff) return message;
    if (typeof message.content === 'string') {
      return message.role === 'assistant' && message.content.length > 4096
        ? { ...message, content: omission(message.content, archive, 'assistant', message.content) }
        : message;
    }
    const content = message.content.map((block): AnthropicContentBlock => {
      if (message.role === 'assistant' && block.type === 'text' && block.text.length > 4096) {
        return { ...block, text: omission(block.text, archive, 'assistant', block.text) };
      }
      if (block.type !== 'tool_result') return block;
      const result = block as AnthropicToolResultBlock;
      if (typeof result.content === 'string') {
        return result.content.length > 2048
          ? { ...result, content: omission(result.content, archive, 'tool result', result.content) }
          : result;
      }
      if (!result.content) return result;
      return { ...result, content: result.content.map(item => item.type === 'image'
        ? { type: 'text' as const, text: omission(item, archive, 'tool image') }
        : item.text.length > 2048
          ? { ...item, text: omission(item.text, archive, 'tool result', item.text) }
          : item) };
    });
    return { ...message, content };
  });
  return { ...body, messages };
}

function explicitlyOverflowed(text: string): boolean {
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!record(parsed)) return false;
    const error = record(parsed.error) ? parsed.error : parsed;
    if (error.code === 'context_length_exceeded' || error.type === 'context_length_exceeded') return true;
    message = typeof error.message === 'string' ? error.message : '';
  } catch {
    // A bounded plain error is accepted only with an explicit context diagnosis.
    if (text.length > 1024) return false;
  }
  return /\bcontext window is full\b|\bmaximum context length\b|\bprompt (?:is )?too long\b/i.test(message);
}

function required(message: string, status = 409): Response {
  return new Response(JSON.stringify({ type: 'error', error: {
    type: 'invalid_request_error', code: 'context_recovery_required', message: `context_recovery_required: ${message}`,
  } }), { status, headers: { 'content-type': 'application/json', 'x-should-retry': 'false',
    'x-moxbots-recovery': 'blocked' } });
}

function cancelled(): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', code: 'request_cancelled',
    message: 'Model request superseded or cancelled; progress was preserved.' } }), {
    status: 499, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
  });
}

/** Owned by one existing Query. Only retries inference; never executes or re-enqueues a tool. */
export class ContextRecoveryController implements BridgeContextRecovery {
  private state: State | undefined;
  private projectionActive = false;
  private completedLedger = new Map<string, Evidence>();
  private uncertainLedger = new Set<string>();
  private deniedLedger = new Set<string>();
  private ledgerBlocked = false;
  private persistenceTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ContextRecoveryOptions) {
    if (options.initialLedger !== undefined) this.restoreLedger(options.initialLedger);
    const checkpoint = options.initialCheckpoint;
    if (checkpoint) this.restoreCheckpoint(checkpoint.body, checkpoint.archive, checkpoint.digest);
  }

  // The Query still contains its original native history after a product turn ends.
  // Keep the projection and rescue ledger even after native compaction removes
  // old pairs. Only request replay guards are turn-scoped. A deliberate new Query
  // starts unarmed unless its owner explicitly restores this same-Goal checkpoint.
  endTurn(): void { this.state = undefined; }

  /** Rehydrate one or more archived sources without reading files or becoming a storage owner. */
  restoreCheckpoint(body: AnthropicRequest, archive: string, sourceDigest: string): void {
    if (this.state?.inFlight.size) throw new Error('context_recovery_required: Cannot restore during active inference.');
    this.projectionActive = true;
    const analysis = analyze(body, this.deniedLedger, this.completedLedger);
    if (!analysis || typeof archive !== 'string' || !archive.trim() || archive.length > 4096 || /[\r\n]/.test(archive)
      || createHash('sha256').update(JSON.stringify(body)).digest('hex') !== sourceDigest) {
      this.ledgerBlocked = true;
      throw new Error('context_recovery_required: Recovery checkpoint integrity or tool history validation failed.');
    }
    const completed = new Map([...analysis.completed].map(([key, value]) => [key, { ...value, archive, digest: sourceDigest }]));
    if (!this.mergeLedger(completed, analysis.uncertain)) {
      throw new Error('context_recovery_required: Recovery ledger capacity exceeded.');
    }
    this.state = undefined;
  }

  private restoreLedger(value: unknown): void {
    this.projectionActive = true;
    if (!record(value) || value.version !== 1 || !Array.isArray(value.completed)
      || !Array.isArray(value.uncertain) || !Array.isArray(value.denied)
      || typeof value.blocked !== 'boolean') throw new Error('context_recovery_required: Invalid recovery ledger');
    const validKey = (key: unknown): key is string => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
    if (value.completed.length + value.uncertain.length > MAX_LEDGER_ENTRIES
      || value.denied.length > MAX_LEDGER_ENTRIES
      || !value.uncertain.every(validKey) || !value.denied.every(validKey)
      || !value.completed.every(item => Array.isArray(item) && item.length === 2 && validKey(item[0]) && record(item[1]))) {
      throw new Error('context_recovery_required: Corrupt recovery ledger');
    }
    this.completedLedger = new Map(value.completed as [string, Evidence][]);
    this.uncertainLedger = new Set(value.uncertain as string[]);
    this.deniedLedger = new Set(value.denied as string[]);
    this.ledgerBlocked = value.blocked;
  }

  private async persist(): Promise<void> {
    if (!this.projectionActive || !this.options.persistLedger) return;
    const commit = this.persistenceTail.then(async () => {
      if (this.ledgerBlocked) throw new Error('Recovery ledger is blocked');
      await this.options.persistLedger!({ version: 1, completed: [...this.completedLedger],
        uncertain: [...this.uncertainLedger], denied: [...this.deniedLedger], blocked: this.ledgerBlocked });
    });
    this.persistenceTail = commit.catch(() => { this.ledgerBlocked = true; });
    try { await commit; }
    catch {
      this.ledgerBlocked = true;
      throw new Error('context_recovery_required: Recovery ledger could not be committed; business actions stopped.');
    }
  }

  /** Reserve before invoking a mutating tool: a crash leaves an uncertain action, never a replay. */
  async authorizeTool(name: string, input: unknown): Promise<string | undefined> {
    const denied = this.beforeTool(name, input);
    if (denied) {
      try { await this.persist(); } catch { /* execution is already denied */ }
      return denied;
    }
    if (READ_ONLY_TOOLS.has(name) || !this.projectionActive) return undefined;
    const state = this.current();
    if (!state) return 'automatic_replay_blocked: Recovery turn is not current.';
    const key = toolKey(name, input);
    state.uncertain.add(key);
    this.uncertainLedger.add(key);
    try { await this.persist(); }
    catch { return 'automatic_replay_blocked: Could not durably reserve this action; execution stopped.'; }
    return this.options.isActive() ? undefined : 'automatic_replay_blocked: Recovery turn was cancelled.';
  }

  async commitToolResult(name: string, input: unknown, result: unknown, failed = false): Promise<void> {
    this.recordToolResult(name, input, result, failed);
    await this.persist();
  }

  private mergeLedger(completed: ReadonlyMap<string, Evidence>, uncertain: ReadonlySet<string>): boolean {
    const keys = new Set([...this.completedLedger.keys(), ...this.uncertainLedger, ...completed.keys(), ...uncertain]);
    if (keys.size > MAX_LEDGER_ENTRIES) { this.ledgerBlocked = true; return false; }
    for (const [key, value] of completed) this.completedLedger.set(key, value);
    for (const key of uncertain) this.uncertainLedger.add(key);
    return true;
  }

  private current(): State | undefined {
    const scope = this.options.scope();
    if (!scope || !this.options.isActive()) return undefined;
    if (this.state?.scope !== scope) this.state = {
      scope, attempted: this.projectionActive, recovered: this.projectionActive, blocked: this.ledgerBlocked,
      inFlight: new Set(), recovering: false, delivered: new Set(), completed: new Map(this.completedLedger),
      uncertain: new Set(this.uncertainLedger), denied: new Set(this.deniedLedger),
    };
    return this.state;
  }

  beforeTool(name: string, input: unknown): string | undefined {
    if (READ_ONLY_TOOLS.has(name)) return undefined;
    const state = this.current();
    if (!state) return this.projectionActive || this.ledgerBlocked
      ? 'automatic_replay_blocked: Context recovery belongs to a retired or unbound turn; this action cannot run.' : undefined;
    if (state.blocked || this.ledgerBlocked) return 'automatic_replay_blocked: Context recovery stopped with preserved progress. Business actions are blocked until recovery is resolved.';
    if (!state.attempted) return undefined;
    const key = toolKey(name, input);
    if (state.uncertain.has(key)) return 'automatic_replay_blocked: The earlier action has an uncertain outcome. Automatic repetition is blocked; verify it read-only.';
    const evidence = state.completed.get(key);
    if (!evidence) return this.completedLedger.size + this.uncertainLedger.size >= MAX_LEDGER_ENTRIES
      ? 'automatic_replay_blocked: Recovery ledger capacity is exhausted; another business action cannot be safely recorded.' : undefined;
    state.denied.add(key);
    this.deniedLedger.add(key);
    return `automatic_replay_blocked: This exact action already completed successfully; do not execute it again. Prior evidence: `
      + `${excerpt(canonical(evidence.result))}. Archive: ${evidence.archive ?? 'pending durable evidence'}; `
      + `request SHA-256: ${evidence.digest ?? 'recorded by the current tool owner'}.`;
  }

  recordToolResult(name: string, input: unknown, result: unknown, failed = false): void {
    const state = this.current();
    if (!state || READ_ONLY_TOOLS.has(name)) return;
    const key = toolKey(name, input);
    if (failed) {
      if (!(state.denied.has(key) && state.completed.get(key)?.archive
        && canonical(result).includes('automatic_replay_blocked:'))) {
        state.uncertain.add(key);
        if (this.projectionActive && !this.mergeLedger(new Map(), new Set([key]))) state.blocked = true;
      }
    }
    else {
      state.uncertain.delete(key);
      this.uncertainLedger.delete(key);
      const evidence = { ...state.completed.get(key), result };
      state.completed.set(key, evidence);
      if (this.projectionActive && !this.mergeLedger(new Map([[key, evidence]]), new Set())) state.blocked = true;
    }
  }

  async run(request: Request, body: AnthropicRequest,
    execute: (projected: AnthropicRequest) => Promise<Response>): Promise<Response> {
    if (request.signal.aborted || !this.options.isActive()) return cancelled();
    if (this.ledgerBlocked) return required('Recovery ledger integrity or capacity requires explicit resolution.');
    const state = this.current();
    if (!state) return this.state || this.projectionActive ? cancelled() : execute(body);
    const live = () => !request.signal.aborted && this.options.isActive()
      && this.state === state && this.options.scope() === state.scope;
    let fingerprint: string;
    let originalDigest: string;
    try {
      fingerprint = digest({ model: body.model, system: body.system, messages: body.messages, tools: body.tools }, true);
      originalDigest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    }
    catch { return required('Request history cannot be safely fingerprinted.'); }
    if (state.blocked || this.ledgerBlocked || state.recovering || state.inFlight.has(fingerprint) || state.delivered.has(fingerprint)
      || (state.recovered && state.inFlight.size > 0)) {
      return required('This turn already has a delivered, concurrent or failed model request. Automatic replay is blocked.');
    }
    state.inFlight.add(fingerprint);
    const finish = () => {
      state.inFlight.delete(fingerprint);
      state.delivered.add(fingerprint);
    };
    const stop = (message: string) => { state.blocked = true; return required(message); };
    const prepare = async (initial: boolean): Promise<AnthropicRequest | Response> => {
      const analysis = analyze(body, state.denied, state.completed);
      if (!analysis || analysis.uncertain.size || state.uncertain.size) {
        return stop('History contains unknown, unpaired or uncertain tool actions. Progress was preserved; automatic recovery stopped.');
      }
      const before = Buffer.byteLength(canonical(body));
      let archive: string;
      try { archive = await this.options.backup(body, { digest: originalDigest, scope: state.scope }); }
      catch { return live() ? stop('The original history could not be durably archived. Automatic recovery stopped.') : cancelled(); }
      if (!live()) return cancelled();
      if (typeof archive !== 'string' || !archive.trim() || archive.length > 4096 || /[\r\n]/.test(archive)) {
        return stop('The original history archive reference is invalid. Automatic recovery stopped.');
      }
      const projected = project(body, archive);
      const after = Buffer.byteLength(canonical(projected));
      if (this.options.canRecover?.() === false && (initial || canonical(projected) !== canonical(body))) {
        return initial ? stop('Native background work became active during archival. Context reduction was refused.')
          : required('Native background work is active. Context reduction was refused; progress was preserved.');
      }
      if (initial && (before - after < 4096 || after > before * 0.85)) {
        return stop('Protected user constraints, tool inputs and recent evidence leave insufficient safe context reduction.');
      }
      // Native /compact can remove the bulky prefix entirely. Keep the guard without
      // requiring another omission in the already-small, now durably backed-up history.
      if (!initial && after > before) return stop('The archived history cannot be safely reduced further.');
      const completed = new Map([...analysis.completed].map(([key, value]) => [key, { ...value, archive, digest: originalDigest }]));
      if (!this.mergeLedger(completed, analysis.uncertain)) return stop('Recovery ledger capacity exceeded. Progress was preserved.');
      for (const [key, value] of completed) state.completed.set(key, value);
      state.recovered = true;
      this.projectionActive = true;
      try { await this.persist(); } catch { return stop('Recovery ledger could not be durably committed.'); }
      if (!live()) return cancelled();
      if (initial) try { this.options.onRecovery?.({ digest: originalDigest, archive }); } catch { /* observability cannot replay inference */ }
      return projected;
    };
    let streamOwnsFinish = false;
    let ownsRecovery = false;
    try {
      const input = state.recovered ? await prepare(false) : body;
      if (input instanceof Response) return input;
      if (!live()) return cancelled();
      let response = await execute(input);
      if (!live()) { void response.body?.cancel().catch(() => undefined); return cancelled(); }
      if (!response.ok && [400, 413, 422].includes(response.status)) {
        const text = await readBoundedErrorBody(response.body);
        if (!live()) return cancelled();
        if (text === undefined) return stop('The upstream error body was incomplete. Automatic recovery stopped.');
        if (!explicitlyOverflowed(text)) {
          return new Response(text, { status: response.status, headers: response.headers });
        }
        if (state.attempted) return stop('Context recovery was exhausted. Progress and archived evidence were preserved.');
        if (state.inFlight.size > 1 || this.options.canRecover?.() === false) {
          return required('Another native inference or background action is active. Context recovery was refused; existing work was preserved.');
        }
        state.recovering = true;
        ownsRecovery = true;
        state.attempted = true;
        const reduced = await prepare(true);
        if (reduced instanceof Response) return reduced;
        if (!live()) return cancelled();
        response = await execute(reduced);
        if (!live()) { void response.body?.cancel().catch(() => undefined); return cancelled(); }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          return stop('The single inference retry after context recovery failed. Progress and archived evidence were preserved.');
        }
      }
      if (!response.ok || !response.body) return response;
      // Hold request admission until the consumer finishes. A partial stream seals the whole
      // turn, including changed fingerprints, so native SDK stream rescue cannot replay tools.
      const reader = response.body.getReader();
      const isSse = response.headers.get('content-type')?.includes('text/event-stream') === true;
      const parser = new SSEParser();
      const decoder = new TextDecoder();
      let terminal = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            if (!live()) {
              state.blocked = true;
              void reader.cancel().catch(() => undefined);
              finish();
              output.error(new Error('Model request superseded or cancelled'));
              return;
            }
            const next = await reader.read();
            if (next.done) {
              if (isSse && !terminal) state.blocked = true;
              finish(); output.close(); return;
            }
            if (isSse) for (const event of parser.feed(decoder.decode(next.value, { stream: true }))) {
              let type = event.event;
              try { const payload: unknown = JSON.parse(event.data); if (record(payload) && typeof payload.type === 'string') type = payload.type; } catch { /* event name remains authoritative */ }
              if (type === 'message_stop') terminal = true;
              if (type === 'error') state.blocked = true;
            }
            output.enqueue(next.value);
          } catch (error) {
            if (!terminal) state.blocked = true;
            finish(); output.error(error);
          }
        },
        async cancel(reason) {
          if (!terminal) state.blocked = true;
          finish();
          try { await reader.cancel(reason); } catch { /* transport already retired */ }
        },
      });
      streamOwnsFinish = true;
      return new Response(stream, { status: response.status, headers: response.headers });
    } catch {
      if (!live()) return cancelled();
      return stop('The model transport failed. Automatic replay is blocked and progress was preserved.');
    } finally {
      if (ownsRecovery) state.recovering = false;
      if (!streamOwnsFinish) finish();
    }
  }
}
