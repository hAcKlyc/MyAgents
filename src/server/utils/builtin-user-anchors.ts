/** SDK user-role frames also carry tool results and projected queued inputs.
 * Only an ordinary root user record can supply a human input's native anchor.
 * A replay UUID is a consumption receipt until that record is read from SDK history.
 */
export function isBuiltinNativeUserRecord(value: unknown): value is { uuid: string } {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.type !== 'user' || typeof row.uuid !== 'string' || !row.uuid
    || row.parent_tool_use_id || row.isReplay || row.isQueuedCommand || row.isCompletedLocalCommand
    || row.isCompactSummary || row.isMeta || row.is_meta || row.isSynthetic
    || row.isVisibleInTranscriptOnly) return false;
  const message = row.message as { content?: unknown } | undefined;
  const content = message?.content;
  const isLocalOutput = (text: unknown) => typeof text === 'string'
    && /^(?:<local-command-stdout>|<local-command-stderr>)/.test(text.trimStart());
  if (typeof content === 'string') return !isLocalOutput(content);
  return Array.isArray(content) && content.length > 0
    && !content.some(block => block && typeof block === 'object'
      && (block.type === 'tool_result' || (block.type === 'text' && isLocalOutput(block.text))));
}

/** Reconcile at the existing history-operation boundary, without rewriting the
 * source or aligning Product rows positionally with native messages. Missing,
 * tool-result and queued-alias user anchors are optional and remain unbound.
 * Assistant boundaries retain the strict native remap/rewind validation.
 */
export function resolveBuiltinUserAnchors<T extends {
  role: string; sdkUuid?: string; sdkInputUuid?: string;
}>(messages: readonly T[], nativeMessages: readonly unknown[]): (T & { sdkUuid?: string })[] {
  const nativeUsers = new Set(nativeMessages.filter(isBuiltinNativeUserRecord).map(row => row.uuid));
  return messages.map(message => {
    if (message.role !== 'user') return message;
    const candidate = message.sdkInputUuid ?? message.sdkUuid;
    return { ...message, sdkUuid: candidate && nativeUsers.has(candidate) ? candidate : undefined };
  });
}
