import { isModelFailoverStatus } from '../../shared/modelFailover';
import type { UpstreamConfig } from './types/bridge';
import { classifyOpenAiUpstreamFailure } from './translate/errors';
import { readBoundedErrorBody } from './read-error-body';
import { SSEParser } from './utils/sse-parser';

export interface BridgeModelFailover {
  run(request: Request, primary: UpstreamConfig,
    execute: (target: UpstreamConfig) => Promise<Response>, requestKey?: string): Promise<Response>;
}

/** Query-token owned; never re-enqueues input or invokes tools. */
export class ModelFailoverController implements BridgeModelFailover {
  private state: { scope: string; backup?: boolean; blocked?: boolean; delivered: Set<string>; inFlight: Set<string> } | undefined;

  constructor(private readonly options: {
    /** Stable logical turn and selected primary route. Undefined disables recovery. */
    scope: () => string | undefined;
    resolveBackup: () => UpstreamConfig | undefined;
    onSwitch: (target: UpstreamConfig, status: number) => void;
    onTurnEnd?: () => void;
    canSwitch?: () => boolean;
    isActive?: () => boolean;
  }) {}

  endTurn(): void {
    this.state = undefined;
    this.options.onTurnEnd?.();
  }

  async run(request: Request, primary: UpstreamConfig,
    execute: (target: UpstreamConfig) => Promise<Response>, requestKey?: string): Promise<Response> {
    const scope = this.options.scope();
    if (request.signal.aborted || this.options.isActive?.() === false || (!scope && this.state)) return cancelled();
    if (!scope) return execute(primary);
    if (scope !== this.state?.scope) this.state = { scope, delivered: new Set(), inFlight: new Set() };
    const state = this.state!;
    const live = () => !request.signal.aborted && this.state === state && this.options.scope() === scope;
    if (state.blocked || (requestKey && (state.delivered.has(requestKey) || state.inFlight.has(requestKey)))) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
        message: 'This model request was already delivered or failed. Progress is preserved; automatic replay is blocked.' } }),
      { status: 409, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } });
    }
    if (requestKey) state.inFlight.add(requestKey);
    const recover = async (): Promise<Response> => {
      // Once switched, every later inference in this turn uses the backup.
      // An exhausted chain never starts again because the SDK retries HTTP.
      const useBackup = () => {
        const target = this.options.resolveBackup();
        return target && live() ? execute(target) : Promise.resolve(cancelled());
      };
      if (state.backup) return useBackup();
      const firstResult = await execute(primary);
      if (!live()) { void firstResult.body?.cancel().catch(() => undefined); return cancelled(); }
      if (this.options.canSwitch?.() === false) return firstResult;
      const first = await inspectFailure(firstResult);
      if (!live()) { void first.response.body?.cancel().catch(() => undefined); return cancelled(); }
      if (!first.recoverable || this.options.canSwitch?.() === false) return first.response;
      await first.response.body?.cancel();
      if (!live()) return cancelled();
      if (state.backup) return useBackup();
      const retryResult = await execute(primary);
      if (!live()) { void retryResult.body?.cancel().catch(() => undefined); return cancelled(); }
      const retry = await inspectFailure(retryResult);
      if (!live()) { void retry.response.body?.cancel().catch(() => undefined); return cancelled(); }
      if (!retry.recoverable || this.options.canSwitch?.() === false) return retry.response;
      if (state.backup) { await retry.response.body?.cancel(); return useBackup(); }
      const status = retry.response.status;
      await retry.response.body?.cancel();
      if (!live() || this.options.canSwitch?.() === false) return cancelled();
      if (state.backup) return useBackup();
      const backup = this.options.resolveBackup();
      if (!backup) return cancelled();
      // CAS without an await: concurrent child requests can adopt this winner,
      // but cannot publish another switch or mutate a later turn's state.
      state.backup = true;
      this.options.onSwitch(backup, status);
      return execute(backup);
    };
    try {
      const response = await recover();
      if (!live()) { void response.body?.cancel().catch(() => undefined); return cancelled(); }
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
      const reader = response.body.getReader();
      const parser = new SSEParser();
      const decoder = new TextDecoder();
      let terminal = false;
      // Native SDKs may have their own stream-recovery loops. Once output is
      // delivered, a failed/truncated stream seals this entire logical turn.
      const stream = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            const next = await reader.read();
            if (next.done) { if (!terminal) state.blocked = true; output.close(); return; }
            for (const event of parser.feed(decoder.decode(next.value, { stream: true }))) {
              if (event.event === 'message_stop') terminal = true;
              if (event.event === 'error') state.blocked = true;
            }
            output.enqueue(next.value);
          } catch (error) { if (!terminal) state.blocked = true; output.error(error); }
        },
        async cancel(reason) {
          if (!terminal) state.blocked = true;
          try { await reader.cancel(reason); } catch { /* transport may already be aborted */ }
        },
      });
      return new Response(stream, { status: response.status, headers: response.headers });
    }
    finally {
      if (requestKey) { state.inFlight.delete(requestKey); state.delivered.add(requestKey); }
    }
  }
}

async function inspectFailure(response: Response): Promise<{ response: Response; recoverable: boolean }> {
  if (!isModelFailoverStatus(response.status) || response.headers.get('x-moxbots-recovery') === 'blocked') return { response, recoverable: false };
  // Some suppliers use HTTP 429 for exhausted credits rather than throttling.
  // Such failures are not a license to spend against a different account.
  const body = await readBoundedErrorBody(response.body);
  return { response: new Response(body ?? JSON.stringify({ type: 'error', error: {
    type: 'api_error', message: 'Upstream error response was incomplete; automatic recovery stopped.' } }),
  { status: response.status, headers: response.headers }),
  recoverable: body !== undefined && classifyOpenAiUpstreamFailure(response.status, body).kind !== 'permanent_billing' };
}

function cancelled(): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Model request superseded or cancelled' } }),
    { status: 499, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } });
}
