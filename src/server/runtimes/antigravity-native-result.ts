import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const NATIVE_SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const decoder = new TextDecoder();

/** The launcher's brain and conversation DB directories share one AGY home. */
export function openAntigravityConversation(brainDirectory: string, sessionId: string): DatabaseSync | undefined {
  if (!NATIVE_SESSION_ID.test(sessionId)) return;
  try {
    const home = realpathSync(dirname(brainDirectory));
    const conversations = realpathSync(join(home, 'conversations'));
    if (dirname(conversations) !== home) return;
    const name = `${sessionId}.db`;
    const file = realpathSync(join(conversations, name));
    if (dirname(file) !== conversations || basename(file) !== name) return;
    // A live agy writer uses WAL. SQLite's ordinary read-only connection sees
    // committed updates without bypassing the WAL or writing product state.
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return undefined;
  }
}

function readVarint(data: Uint8Array, start: number): { value: number; end: number } | undefined {
  let value = 0;
  for (let shift = 0; shift <= 63 && start < data.length; shift += 7) {
    const byte = data[start++];
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) return { value, end: start };
  }
}

/** Read a length-delimited field without guessing text boundaries in a BLOB. */
function* fields(data: Uint8Array, number: number): Generator<Uint8Array> {
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    if (!tag || tag.value > 0xffffffff || tag.value < 8) return;
    offset = tag.end;
    switch (tag.value % 8) {
      case 0: {
        const value = readVarint(data, offset);
        if (!value) return;
        offset = value.end;
        break;
      }
      case 1:
        offset += 8;
        break;
      case 2: {
        const length = readVarint(data, offset);
        if (!length || length.value > data.length - length.end) return;
        offset = length.end + length.value;
        if (Math.floor(tag.value / 8) === number) yield data.subarray(length.end, offset);
        break;
      }
      case 5:
        offset += 4;
        break;
      default:
        return;
    }
  }
}

function field(data: Uint8Array, number: number): Uint8Array | undefined {
  return fields(data, number).next().value ?? undefined;
}

function stringField(data: Uint8Array, number: number): string | undefined {
  const value = field(data, number);
  return value && decoder.decode(value);
}

export interface AntigravityToolCall {
  id: string;
  name: string;
  argumentsJson?: string;
}

function decodeToolCall(call: Uint8Array): AntigravityToolCall | undefined {
  const id = stringField(call, 1);
  const name = stringField(call, 2);
  if (id && name) return { id, name, argumentsJson: stringField(call, 3) };
}

/** agy 1.5.14 steps.metadata contains its own ToolCall as field 4. */
export function decodeAntigravityToolCall(metadata: Uint8Array): AntigravityToolCall | undefined {
  const call = field(metadata, 4);
  return call && decodeToolCall(call);
}

/** A native PlannerResponse carries the exact requested ToolCalls. */
export function decodeAntigravityPlannerToolCalls(payload: Uint8Array): AntigravityToolCall[] {
  const planner = field(payload, 20);
  if (!planner) return [];
  return [...fields(planner, 7)].map(decodeToolCall).filter(call => call !== undefined);
}

/** agy 1.5.14 PlannerResponse (20) stores assistant text (1) and thought (3). */
export function decodeAntigravityPlannerText(payload: Uint8Array): { text?: string; thinking?: string } {
  const planner = field(payload, 20);
  if (!planner) return {};
  return { text: stringField(planner, 1), thinking: stringField(planner, 3) };
}

/** agy 1.5.14 SystemMessage (114) stores the received message (4), with its ID (1) and recipient (2). */
export function decodeAntigravitySystemMessage(payload: Uint8Array): { id: string; recipient: string } | undefined {
  const system = field(payload, 114);
  const message = system && field(system, 4);
  if (!message) return;
  const id = stringField(message, 1);
  const recipient = stringField(message, 2);
  if (id && recipient) return { id, recipient };
}

/** agy 1.5.14 step_payload GenericStep (140) holds the displayed text at 2.1. */
export function decodeAntigravityGenericResult(payload: Uint8Array): string | undefined {
  const generic = field(payload, 140);
  const display = generic && field(generic, 2);
  return display && stringField(display, 1);
}

/** ACP reports Read completion while its actual read snapshot lives in the bound native conversation. */
export function readAntigravityFileResult(
  brainDirectory: string,
  nativeSessionId: string,
  toolCallId: string,
): string | undefined {
  const database = openAntigravityConversation(brainDirectory, nativeSessionId);
  if (!database) return;
  try {
    const query = database.prepare(`
      SELECT metadata, step_payload FROM steps
      WHERE step_type = 132 AND status = 3 AND instr(metadata, ?) > 0
      ORDER BY idx DESC
    `);
    for (const row of query.iterate(Buffer.from(toolCallId))) {
      if (!(row.metadata instanceof Uint8Array) || !(row.step_payload instanceof Uint8Array)) continue;
      const call = decodeAntigravityToolCall(row.metadata);
      if (call?.id === toolCallId && call.name === 'read_file') {
        return decodeAntigravityGenericResult(row.step_payload);
      }
    }
  } catch {
    // A read can precede the native DB transaction by one frame. The adapter
    // visits it again at the next actual model or prompt boundary.
    return undefined;
  } finally {
    database.close();
  }
}
