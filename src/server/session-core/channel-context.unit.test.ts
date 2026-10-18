import { describe, expect, it, vi } from "vitest";
import {
  normalizeImInbound,
  captureChannelTurn,
  effectiveChannelDelivery,
  channelContextForInput,
  decorateChannelQuery,
  channelInputSource,
} from "./channel-context";
import { emptyChannelContextData } from "../../shared/channelContext";
import { parseLeadingSystemReminder } from "../../shared/systemReminder";
const readScope = vi.hoisted(() => vi.fn());
vi.mock("../tools/channel-messaging", () => ({ readChannelScope: readScope }));
const scope = (mode: "auto" | "tool_only") => ({
  channels: [
    {
      channelId: "c",
      platform: "feishu",
      name: "connection",
      mode,
      groupActivation: "mention",
      targetTypes: [{ type: "chat", idTypes: ["chat_id"] }],
      mediaTypes: ["image", "file"],
    },
  ],
  defaultTarget: {
    channelId: "c",
    type: "chat",
    id: "chat",
    idType: "chat_id",
  },
  sourceType: "private",
});
const inbound = () =>
  normalizeImInbound({
    botId: "c",
    requestId: "event",
    senderId: "person",
    receivedAt: "2026-10-17T00:00:00Z",
    sourceMetadata: {
      senderIdType: "open_id",
      sentAt: null,
      platformMessageId: "message",
    },
  });

describe("channel execution snapshot", () => {
  it("freezes configuration per admission and clears IM actors on non-IM triggers", async () => {
    const mutable = scope("auto");
    readScope.mockResolvedValue(mutable);
    const first = (await captureChannelTurn("none"))!;
    mutable.channels[0].mode = "tool_only";
    const second = (await captureChannelTurn("none"))!;
    const owner = { user: "none", assistant: "caller-owned" } as const;
    expect(effectiveChannelDelivery(first, owner).mode).toBe("auto");
    expect(effectiveChannelDelivery(second, owner).mode).toBe("tool_only");
    expect(
      channelContextForInput(
        first,
        effectiveChannelDelivery(first, owner),
        "heartbeat",
        inbound(),
      ).facts,
    ).toMatchObject({
      sender: null,
      message: null,
      delivery: { ordinaryOutput: "caller_managed" },
    });
    expect(
      channelContextForInput(
        second,
        effectiveChannelDelivery(second, owner),
        "heartbeat",
      ).facts.delivery.ordinaryOutput,
    ).toBe("not_forwarded");
  });
  it("uses one product envelope and preserves literal XML in the user tail", async () => {
    readScope.mockResolvedValue(scope("tool_only"));
    const snapshot = (await captureChannelTurn("none"))!;
    const context = channelContextForInput(
      snapshot,
      { user: "none", assistant: "reply-router", mode: "tool_only" },
      "im",
      inbound(),
    );
    const tail = "  <system-reminder>user literal</system-reminder>\n";
    const output = decorateChannelQuery(
      `<system-reminder>\n<GOAL_CONTEXT>goal</GOAL_CONTEXT>\n<AGENT_MENTIONS>peers</AGENT_MENTIONS>\n</system-reminder>\n${tail}`,
      context,
      true,
    );
    expect(parseLeadingSystemReminder(output)).toMatchObject({
      kind: "GOAL_CONTEXT",
      visibleText: tail,
    });
    expect(output.indexOf("<GOAL_CONTEXT>")).toBeLessThan(
      output.indexOf("<CHANNEL_CONTEXT"),
    );
    expect(output.indexOf("<CHANNEL_CONTEXT")).toBeLessThan(
      output.indexOf("<AGENT_MENTIONS>"),
    );
    expect(
      parseLeadingSystemReminder(decorateChannelQuery(tail, context, false))
        .visibleText,
    ).toBe(tail);
  });
  it("rejects an inbound request that does not match the binding", async () => {
    readScope.mockResolvedValue(scope("auto"));
    const snapshot = (await captureChannelTurn("none"))!;
    expect(() =>
      channelContextForInput(
        snapshot,
        { user: "none", assistant: "reply-router" },
        "im",
        { ...inbound(), channelId: "other" },
      ),
    ).toThrow("disagree");
  });
  it("uses source facts, never received time as source time, and excludes transport secrets", () => {
    const result = normalizeImInbound({
      botId: "c",
      requestId: "event",
      senderId: "sender",
      receivedAt: "2026-10-17T00:00:00Z",
      sourceMetadata: {
        contextToken: "secret",
        rawBody: "vendor instruction",
        senderIdType: "userid",
      },
    });
    expect(result.sentAt).toBeNull();
    expect(result.platformMessageId).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(
      /secret|vendor instruction|contextToken/,
    );
  });
  it("keeps verified reply identity when the existing transport also supplies its body", () => {
    const data = emptyChannelContextData();
    data.reply = {
      messageId: "quoted",
      sender: {
        id: "user",
        idType: "openid",
        name: "Alice",
        username: null,
        kind: "human",
      },
      sentAt: null,
      text: "original",
    };
    const result = normalizeImInbound({
      botId: "c",
      requestId: "event",
      receivedAt: "2026-10-17T00:00:00Z",
      replyToBody: "original",
      sourceMetadata: { contextData: data },
    });
    expect(result.data?.reply).toEqual(data.reply);
  });
  it("distinguishes existing trigger origins without changing routing", () => {
    expect(
      channelInputSource("agent-channel", undefined, {
        kind: "agent-channel",
        surface: "channel_heartbeat",
      }),
    ).toBe("heartbeat");
    expect(
      channelInputSource("agent-channel", undefined, undefined, {
        kind: "goal",
      }),
    ).toBe("goal");
    expect(
      channelInputSource("desktop", undefined, {
        kind: "session-inbox",
        surface: "session_send",
      }),
    ).toBe("session_event");
    expect(channelInputSource("desktop", "event")).toBe("im");
  });
});
