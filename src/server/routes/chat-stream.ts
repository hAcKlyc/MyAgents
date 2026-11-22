import { getSessionEngine } from '../session-engine';
import { getActiveSessionTranscript } from '../SessionStore';

type SseClient = {
  send(event: string, data: unknown): void;
};

export type ChatStreamRouteDeps = {
  createSseClient(onClose: () => void): { client: SseClient; response: Response };
  getLogLines(): string[];
};

export async function handleChatStreamRoute(
  pathname: string,
  request: Request,
  deps: ChatStreamRouteDeps,
): Promise<Response | null> {
  if (pathname !== '/chat/stream' || request.method !== 'GET') {
    return null;
  }

  // Capture and flush the coherent runtime snapshot before registering the new
  // client. Both operations are synchronous, so no event-loop gap exists; a
  // buffered live chunk cannot reach this client before chat:init clears it.
  const snapshot = getSessionEngine().getStreamReplaySnapshot({ includeHistory: false });
  const transcript = getActiveSessionTranscript(snapshot.sessionId);
  // No onClose turn-interrupt: SSE disconnect is not a cancellation authority.
  const { client, response } = deps.createSseClient(() => {});
  client.send('chat:init', {
    ...snapshot.initState,
    sessionId: snapshot.sessionId,
    snapshotRevision: snapshot.snapshotRevision,
    liveStreamingMessage: snapshot.liveStreamingMessage ?? null,
    ...(transcript ? { transcriptFormat: 2, transcriptSaveStatus: transcript.writer.status } : {}),
  });

  // History is fetched through the existing paginated Session snapshot endpoint.
  // Replaying it here would queue a second full transcript behind any async ref
  // read, before a restored consumer can even reject the redundant messages.

  client.send('chat:logs', { lines: deps.getLogLines() });

  if (snapshot.systemInitPayload) {
    client.send('chat:system-init', {
      ...snapshot.systemInitPayload as Record<string, unknown>,
      sessionId: snapshot.sessionId,
      snapshotRevision: snapshot.snapshotRevision,
    });
  }

  if (snapshot.mcpEffectiveSnapshot) {
    client.send('chat:mcp-effective-snapshot', snapshot.mcpEffectiveSnapshot);
  }

  if (snapshot.agentPlan) {
    client.send('chat:agent-plan-update', { sessionId: snapshot.sessionId, todos: snapshot.agentPlan });
  }

  for (const pending of snapshot.pendingInteractiveRequests) {
    client.send(pending.type, pending.data);
  }

  return response;
}
