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
