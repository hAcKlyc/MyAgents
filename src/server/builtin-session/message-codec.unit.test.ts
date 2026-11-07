import { describe, expect, it } from "vitest";
import {
  messageWireToSessionMessage,
  sessionMessageToMessageWire,
} from "./message-codec";
import {
  toStoredTranscriptMessage,
  fromStoredTranscriptMessage,
} from "../../shared/sessionTranscript";
import type { MessageWire } from "./types";

describe("desktop mention query annotations", () => {
  it("retains the successful completion instant across wire, disk and cold projection", () => {
    const message: MessageWire = { id: 'answer', role: 'assistant', content: 'done',
      timestamp: '2026-11-07T05:00:00Z', completedAt: '2026-11-07T05:00:05Z' };
    expect(sessionMessageToMessageWire(toStoredTranscriptMessage(fromStoredTranscriptMessage(messageWireToSessionMessage(message)))))
      .toMatchObject(message);
  });
  it("preserves an independent diagnostic through both builtin codecs and stored transcript", () => {
    const message: MessageWire = {
      id: "diagnostic", role: "assistant", content: "Error: runtime exited",
      timestamp: "2026-10-05T00:00:00Z", turnId: "turn", transcriptState: "complete",
      messageKind: "diagnostic",
    };
    const stored = messageWireToSessionMessage(message);
    expect(sessionMessageToMessageWire(toStoredTranscriptMessage(fromStoredTranscriptMessage(stored))))
      .toMatchObject(message);
  });
  it("survives original builtin and transcript persistence without exposing the hidden context as visible text", () => {
    const message: MessageWire = {
      id: "user",
      role: "user",
      timestamp: "2026-10-01T00:00:00Z",
      content:
        "<system-reminder><AGENT_MENTIONS>hidden</AGENT_MENTIONS></system-reminder>\nAsk @Agent-id:local",
      desktopQuery: { visibleText: "Ask @Agent-id:local", agentMentions: [] },
    };
    const stored = messageWireToSessionMessage(message);
    const transcript = toStoredTranscriptMessage(
      fromStoredTranscriptMessage(stored),
    );
    expect(sessionMessageToMessageWire(transcript)).toMatchObject(message);
    expect(transcript.desktopQuery?.visibleText).toBe("Ask @Agent-id:local");
  });
});
