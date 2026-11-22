import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const TRANSCRIPT_TAIL_BYTES = 128 * 1024;
const OPEN_READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export interface AntigravityChildSnapshot {
  toolCallId: string;
  sessionId: string;
  role?: string;
  agentType?: string;
  startedAt: number;
  status: 'running' | 'completed' | 'interrupted';
  deliveredAt?: number;
  reportId?: string;
  finishedAt?: number;
  parentRead?: boolean;
  result?: string;
}

/** agy is launched with its default Gemini home and application data directory. */
export function antigravityBrainDirectory(env: NodeJS.ProcessEnv): string {
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
  return join(home, '.gemini', 'antigravity-cli', 'brain');
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

function fileNotPresent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP';
}

function withinBrain(brainRoot: string, candidate: string): boolean {
  const fromRoot = relative(brainRoot, candidate);
  return !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
}

async function jsonDirectory(brainRoot: string, ...parts: string[]): Promise<string[]> {
  try {
    const directory = join(brainRoot, ...parts);
    const resolvedDirectory = await realpath(directory);
    if (!withinBrain(brainRoot, resolvedDirectory)) return [];
    const entries = await readdir(resolvedDirectory, { withFileTypes: true });
    return entries.flatMap(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'read.json'
      ? [join(resolvedDirectory, entry.name)] : []);
  } catch (error) {
    if (fileNotPresent(error)) return [];
    throw error;
  }
}

async function readRecord(path: string): Promise<RecordValue | undefined> {
  try {
    const file = await open(path, OPEN_READ_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_MESSAGE_BYTES) return;
      return record(JSON.parse(await file.readFile('utf8')));
    } finally {
      await file.close();
    }
  } catch (error) {
    // The runtime creates these records while we observe them. Read again on
    // the next observation if a file was replaced or is not complete yet.
    if (fileNotPresent(error) || error instanceof SyntaxError) return;
    throw error;
  }
}

type NativeMessage = {
  messageId?: string;
  sender: string;
  recipient: string;
  timestamp: number;
  toolSessionId: string;
  toolName: string;
  toolCallId: string;
  stepIndex?: number;
  content?: string;
};

async function readMessage(path: string): Promise<NativeMessage | undefined> {
  const value = await readRecord(path);
  if (!value || typeof value.sender !== 'string' || typeof value.recipient !== 'string'
    || typeof value.timestamp !== 'string') return;
  const timestamp = Date.parse(value.timestamp);
  const tool = record(record(value.sourceMetadata)?.tool);
  const call = record(tool?.toolCall);
  if (!Number.isFinite(timestamp) || typeof tool?.conversationId !== 'string'
    || typeof call?.name !== 'string' || typeof call.id !== 'string') return;
  return {
    ...(typeof value.id === 'string' && value.id === basename(path, '.json') ? { messageId: value.id } : {}),
    sender: value.sender,
    recipient: value.recipient,
    timestamp,
    toolSessionId: tool.conversationId,
    toolName: call.name,
    toolCallId: call.id,
    ...(typeof tool.stepIndex === 'number' && Number.isSafeInteger(tool.stepIndex) ? { stepIndex: tool.stepIndex } : {}),
    ...(typeof value.content === 'string' ? { content: value.content } : {}),
  };
}

async function latestNativeStep(brainRoot: string, childSessionId: string): Promise<RecordValue | undefined> {
  const path = join(brainRoot, childSessionId, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    if (!withinBrain(brainRoot, await realpath(path))) return;
    const file = await open(path, OPEN_READ_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return;
      const buffer = Buffer.alloc(Math.min(stat.size, TRANSCRIPT_TAIL_BYTES));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, stat.size - buffer.length);
      const tail = buffer.subarray(0, bytesRead).toString('utf8').trimEnd();
      const lastLine = tail.slice(tail.lastIndexOf('\n') + 1);
      return lastLine ? record(JSON.parse(lastLine)) : undefined;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (fileNotPresent(error) || error instanceof SyntaxError) return;
    throw error;
  }
}

/**
 * Detached children don't send individual ACP lifecycle events in agy 1.5.
 * Read only the bound parent's child index and correlate the original launch
 * with the exact ACP tool ID in the child's native inbox. A report is display
 * data. Antigravity already delivers it to the native parent.
 */
export async function readAntigravityChildren(
  brainDirectory: string,
  parentSessionId: string,
  launchToolIds: ReadonlySet<string>,
): Promise<AntigravityChildSnapshot[]> {
  if (!NATIVE_ID.test(parentSessionId) || launchToolIds.size === 0) return [];
  let brainRoot: string;
  try {
    brainRoot = await realpath(brainDirectory);
  } catch (error) {
    if (fileNotPresent(error)) return [];
    throw error;
  }
  const parentDirectory = [parentSessionId, '.system_generated'];
  const descriptors = await jsonDirectory(brainRoot, ...parentDirectory, 'subagents');
  if (descriptors.length === 0) return [];
  const children = new Map<string, AntigravityChildSnapshot[]>();
  for (const path of descriptors) {
    const descriptor = await readRecord(path);
    const sessionId = descriptor?.conversationId;
    if (typeof sessionId !== 'string' || !NATIVE_ID.test(sessionId)
      || sessionId === parentSessionId || basename(path) !== `${sessionId}.json`
      || (descriptor?.state !== 'SUBAGENT_STATE_ALIVE' && descriptor?.state !== 'SUBAGENT_STATE_KILLED')) continue;

    const inbox = await jsonDirectory(brainRoot, sessionId, '.system_generated', 'messages');
    for (const path of inbox) {
      const launch = await readMessage(path);
      if (!launch || launch.sender !== parentSessionId || launch.recipient !== sessionId
        || launch.toolSessionId !== parentSessionId || launch.toolName !== 'invoke_subagent'
        || !launchToolIds.has(launch.toolCallId)) continue;

      const details = record(descriptor?.subagentDescriptor);
      const snapshots = children.get(launch.toolCallId) ?? [];
      snapshots.push({
        toolCallId: launch.toolCallId,
        sessionId,
        startedAt: launch.timestamp,
        status: descriptor?.state === 'SUBAGENT_STATE_KILLED' ? 'interrupted' : 'running',
        ...(typeof details?.role === 'string' ? { role: details.role } : {}),
        ...(typeof details?.typeName === 'string' ? { agentType: details.typeName } : {}),
      });
      children.set(launch.toolCallId, snapshots);
      break;
    }
  }

  const exactChildren = [...children.values()].flatMap(matches => matches.length === 1 ? matches : []);
  if (exactChildren.length === 0) return [];
  const inbound = await jsonDirectory(brainRoot, ...parentDirectory, 'messages');
  if (inbound.length === 0) return exactChildren;
  const reports = new Map<string, NativeMessage>();
  const childIds = new Set(exactChildren.map(child => child.sessionId));
  for (const path of inbound) {
    const report = await readMessage(path);
    if (!report || report.recipient !== parentSessionId || !childIds.has(report.sender)
      || report.toolSessionId !== report.sender || report.toolName !== 'send_message') continue;
    const previous = reports.get(report.sender);
    if (!previous || previous.timestamp < report.timestamp) reports.set(report.sender, report);
  }
  const readReceipts = await readRecord(join(dirname(inbound[0]), 'read.json'));
  return Promise.all(exactChildren.map(async (child): Promise<AntigravityChildSnapshot> => {
    const report = reports.get(child.sessionId);
    if (!report || report.timestamp < child.startedAt) return child;
    const delivery = {
      ...child,
      deliveredAt: report.timestamp,
      result: report.content,
      ...(report.messageId ? { reportId: report.messageId, parentRead: readReceipts?.[report.messageId] === true } : {}),
    };
    if (report.stepIndex === undefined) return delivery;

    // A send_message may be an interim progress report. The tool's exact
    // step index precedes the child model's final text-only response.
    const terminal = await latestNativeStep(brainRoot, child.sessionId);
    const finishedAt = typeof terminal?.created_at === 'string' ? Date.parse(terminal.created_at) : NaN;
    if (terminal?.type !== 'PLANNER_RESPONSE' || terminal.status !== 'DONE'
      || typeof terminal.step_index !== 'number' || terminal.step_index <= report.stepIndex
      || typeof terminal.content !== 'string' || terminal.content.trim() === ''
      || (Array.isArray(terminal.tool_calls) && terminal.tool_calls.length > 0)
      || !Number.isFinite(finishedAt)) return delivery;
    // The transcript timestamps are rounded down to seconds while inbox
    // records use fractional seconds. Step order proves which came first.
    return { ...delivery, status: 'completed', finishedAt: Math.max(finishedAt, report.timestamp) };
  }));
}
