import type { SessionMessage } from '../types/session';

type Block = Record<string, unknown>;
function blocks(message: SessionMessage): Block[] {
  try {
    const value: unknown = JSON.parse(message.content);
    if (Array.isArray(value)) return value as Block[];
  } catch { /* Legacy plain text is one displayed block. */ }
  return message.content ? [{ type: 'text', text: message.content }] : [];
}

/** Keep already displayed V2 segments and remove their exact native prefix
 * from the recovery tail. A conflicting prefix is never silently duplicated. */
export function recoverDshSegmentTail(assistant: SessionMessage, prior: readonly SessionMessage[]): string {
  const remaining = structuredClone(blocks(assistant));
  for (const message of prior) for (const block of blocks(message)) {
    if (block.type === 'text' || block.type === 'thinking') {
      const field = block.type === 'text' ? 'text' : 'thinking';
      const text = String(block[field] ?? '');
      if (!text) continue;
      const first = remaining[0];
      if (first?.type !== block.type || typeof first[field] !== 'string' || !first[field].startsWith(text)) {
        throw new Error('The saved DSH segment differs from its native recovery prefix');
      }
      first[field] = first[field].slice(text.length);
      if (!first[field]) remaining.shift();
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      const id = (block.tool as Block | undefined)?.id;
      if (remaining[0]?.type !== block.type || (remaining[0]?.tool as Block | undefined)?.id !== id) {
        throw new Error('The saved DSH tool differs from its native recovery prefix');
      }
      remaining.shift();
    }
  }
  return JSON.stringify(remaining);
}

/** Runtime confirms the terminal identity; SessionStore retains display IDs,
 * segmentation and already observed tool/attachment presentation. */
export function reconcileDshV2Assistant(
  messages: SessionMessage[], assistant: SessionMessage,
  root: { origin?: 'collaboration'; clientUserMessageId: string; productTurnId: string; consumedUserMessageIds?: readonly string[] },
): boolean | undefined {
  const users = new Set([root.clientUserMessageId, ...(root.consumedUserMessageIds ?? [])]);
  const rootIndex = root.origin === 'collaboration' ? -1 : messages.findIndex(message => message.id === root.clientUserMessageId && message.role === 'user');
  if (root.origin !== 'collaboration' && rootIndex < 0) throw new Error('Missing DSH V2 root user');
  const nextRoot = rootIndex < 0 ? -1 : messages.findIndex((message, index) => index > rootIndex && message.role === 'user' && !users.has(message.id));
  const anchored = messages.find(message => message.runtimeTurnAnchor?.turnId === root.productTurnId);
  const turnId = anchored?.turnId ?? (root.origin === 'collaboration' ? root.productTurnId : messages[rootIndex]?.turnId ?? root.clientUserMessageId);
  const segments = messages.flatMap((message, index) => message.role === 'assistant'
    && (message.turnId === turnId || message.runtimeTurnAnchor?.turnId === root.productTurnId)
    ? [{ message, index }] : []);
  if (!segments.length) return undefined;
  if (root.origin !== 'collaboration' && segments.some(segment => segment.index <= rootIndex || (nextRoot >= 0 && segment.index >= nextRoot))) {
    throw new Error('DSH V2 segments cross another root operation');
  }
  if (segments.slice(0, -1).some(segment => segment.message.runtimeTurnAnchor)) throw new Error('An intermediate DSH segment carries a terminal anchor');
  let appendedTail = false;
  const lastUserIndex = messages.reduce((last, message, index) => message.role === 'user' && users.has(message.id) ? index : last, -1);
  if (segments.at(-1)!.index < lastUserIndex) {
    if (messages.some(message => message.id === assistant.id)) throw new Error('The recovered DSH tail identity is already owned');
    const tail = { ...assistant, content: '[]', turnId, runtimeTurnAnchor: undefined, transcriptState: 'interrupted' as const };
    messages.splice(lastUserIndex + 1, 0, tail);
    segments.push({ message: tail, index: lastUserIndex + 1 });
    appendedTail = true;
  }
  const final = segments.at(-1)!;
  const settled = final.message.runtimeTurnAnchor?.turnId === root.productTurnId && final.message.transcriptState === 'complete';
  const recovered = settled ? undefined : JSON.parse(recoverDshSegmentTail(assistant, segments.slice(0, -1).map(segment => segment.message))) as Block[];
  const priorBlocks = blocks(final.message);
  const content = recovered ? JSON.stringify(recovered.map((block, index) => {
    const tool = block.tool as Block | undefined;
    const prior = tool ? priorBlocks.find(candidate => candidate.type === block.type
      && (candidate.tool as Block | undefined)?.id === tool.id) : priorBlocks[index];
    if (!prior || prior.type !== block.type) return block;
    const priorTool = prior.tool as Block | undefined;
    return { ...block, ...(typeof prior.id === 'string' ? { id: prior.id } : {}),
      ...(tool && priorTool?.attachments ? { tool: { ...tool, attachments: priorTool.attachments } } : {}) };
  })) : final.message.content;
  let changed = appendedTail;
  if (!settled) {
    const nativeTools = new Map(blocks(assistant).flatMap(block => {
      const tool = block.tool as Block | undefined;
      return typeof tool?.id === 'string' ? [[tool.id, tool] as const] : [];
    }));
    for (const segment of segments.slice(0, -1)) {
      const confirmed = blocks(segment.message).map(block => {
        const tool = block.tool as Block | undefined;
        const native = typeof tool?.id === 'string' ? nativeTools.get(tool.id) : undefined;
        return native ? { ...block, tool: { ...tool, ...native, isLoading: false } } : block;
      });
      const content = JSON.stringify(confirmed);
      if (content !== segment.message.content) {
        messages[segment.index] = { ...segment.message, content };
        changed = true;
      }
    }
  }
  const repaired: SessionMessage = {
    ...assistant, id: final.message.id, timestamp: final.message.timestamp, turnId,
    content, transcriptState: 'complete',
    completedAt: final.message.completedAt ?? assistant.completedAt,
  };
  if (JSON.stringify(repaired) === JSON.stringify(final.message)) return changed;
  messages[final.index] = repaired;
  return true;
}
