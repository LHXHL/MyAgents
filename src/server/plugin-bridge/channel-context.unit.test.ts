import { describe, expect, it } from "vitest";
import { normalizePluginMessage } from "./channel-context";

describe("installed channel protocol facts", () => {
  it("Weixin excludes transport tokens and synthetic event IDs", () => {
    const result = normalizePluginMessage("openclaw-weixin", {
      Body: "hello",
      From: "user",
      MessageSid: "synthetic_42",
      contextToken: "secret",
      BodyForAgent: "vendor prompt",
      Timestamp: 1792195200000,
    });
    expect(result.text).toBe("hello");
    expect(result.senderId).toBe("user");
    expect(result.sourceMetadata.platformMessageId).toBeNull();
    expect(result.sourceMetadata.sentAt).toBe("2026-10-17T00:00:00.000Z");
    expect(JSON.stringify(result)).not.toMatch(
      /secret|vendor prompt|synthetic_42/,
    );
  });
  it("projects Weixin source recipient, never its reply target or account alias", () => {
    const base = {
      From: "person",
      To: "person",
      AccountId: "configured-alias",
    };
    expect(
      normalizePluginMessage("weixin", base).sourceMetadata.selfId,
    ).toBeNull();
    const result = normalizePluginMessage("weixin", {
      ...base,
      MyAgentsSelfId: "bot@im.bot",
    });
    expect(result.sourceMetadata).toMatchObject({
      selfId: "bot@im.bot",
      selfIdType: "user_id",
      selfName: null,
      senderUsername: null,
    });
    expect(result.senderName).toBeNull();
  });
  it("projects WeCom WS bot ID without treating agent userid as display name", () => {
    const result = normalizePluginMessage("wecom", {
      SenderId: "user",
      SenderName: "user",
      WeComFrame: { body: { aibotid: "bot" } },
    });
    expect(result.sourceMetadata).toMatchObject({
      selfId: "bot",
      selfIdType: "aibotid",
    });
    expect(result.senderName).toBeNull();
    expect(
      normalizePluginMessage("wecom", { SenderId: "user", SenderName: "Alice" })
        .senderName,
    ).toBe("Alice");
  });
  it("QQ preserves ASR and attachment semantic content", () => {
    const result = normalizePluginMessage("qqbot", {
      Body: "语音转写：会议三点开始\n附件：brief.pdf",
      RawBody: "",
      BodyForAgent: "vendor routing",
      SenderId: "openid",
      MessageSid: "native-message",
      Timestamp: 1792195200000,
    });
    expect(result.text).toContain("会议三点开始");
    expect(result.text).toContain("brief.pdf");
    expect(result.sourceMetadata).toMatchObject({
      senderIdType: "openid",
      platformMessageId: "native-message",
    });
  });
  it("preserves QQ voice files, remote references and quoted source without vendor instructions", () => {
    const result = normalizePluginMessage("qqbot", {
      Body: "会议三点开始",
      BodyForAgent: "vendor instructions",
      QQVoiceAttachmentPaths: ["/tmp/voice.wav"],
      QQVoiceAttachmentUrls: [
        "https://example.test/voice.silk?signature=secret",
      ],
      ReplyToId: "quoted-id",
      ReplyToSender: "Alice",
      ReplyToBody: "original text",
    });
    expect(result.sourceMetadata.contextData).toMatchObject({
      attachments: [
        { kind: "file", localPath: "/tmp/voice.wav", name: "voice.wav" },
      ],
      reply: {
        messageId: "quoted-id",
        sender: { id: null, name: "Alice" },
        text: "original text",
      },
      platformContext: [
        {
          source: "qq-voice-attachments",
          text: "Remote voice attachments: 1 (download URLs omitted).",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /vendor instructions|signature|secret|https:\/\//,
    );
  });
  it("does not invent a Lark group display name from its chat ID", () => {
    expect(
      normalizePluginMessage("openclaw-lark", { GroupSubject: "oc_chat" })
        .groupName,
    ).toBeNull();
    expect(
      normalizePluginMessage("openclaw-lark", {
        GroupSubject: "oc_chat",
        GroupName: "Team",
      }).groupName,
    ).toBe("Team");
  });
  it("Wecom does not label host receipt time as platform source time", () => {
    const result = normalizePluginMessage("wecom", {
      Body: "hello",
      SenderId: "userid",
      Timestamp: 1792195200000,
      MessageSid: "msg",
    });
    expect(result.sourceMetadata.sentAt).toBeNull();
    expect(result.sourceMetadata.senderIdType).toBe("userid");
  });
  it("Lark trusts only its explicitly projected source timestamp and verified bot ID", () => {
    const result = normalizePluginMessage("openclaw-lark", {
      RawBody: "hello",
      BodyForAgent: "untrusted instructions",
      SenderId: "ou_user",
      BotOpenId: "ou_bot",
      MessageThreadId: "thread",
      Timestamp: 1792195200000,
    });
    expect(result.text).toBe("hello");
    expect(result.sourceMetadata).toMatchObject({
      sentAt: null,
      selfId: "ou_bot",
      selfIdType: "open_id",
      threadId: "thread",
    });
    expect(
      normalizePluginMessage("openclaw-lark", {
        MyAgentsSourceSentAt: 1792195200000,
      }).sourceMetadata.sentAt,
    ).toBe("2026-10-17T00:00:00.000Z");
  });
});
