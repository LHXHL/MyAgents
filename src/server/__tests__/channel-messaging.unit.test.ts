import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("../utils/management-api-client", () => ({ managementApi: api }));
import { readChannelPromptOptions, sendChannelMessage } from "../tools/channel-messaging";
import { attachProductHostTools } from "../runtimes/product-extensions/host-dispatcher";
import type { ProductHostToolInventory } from "../runtimes/product-extensions/contracts";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  api.mockReset();
});
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), "channel-message-"));
  dirs.push(dir);
  return dir;
};

describe("unified channel send capability", () => {
  it.each([
    { channels: [], defaultTarget: null, bound: false },
    { channels: [{}], defaultTarget: null, bound: false },
    { channels: [{}], defaultTarget: { channelId: "c", id: "peer" }, bound: true },
  ])("projects capabilities from the current Session binding: $bound", async ({ channels, defaultTarget, bound }) => {
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "sidecar");
    api.mockResolvedValueOnce({ ok: true, channels, defaultTarget });
    expect(await readChannelPromptOptions()).toEqual({ channelBound: bound });
    expect(api).toHaveBeenCalledExactlyOnceWith("/api/im/channel-context", "POST", { sidecarId: "sidecar" });
  });

  it('explains malformed cross-conversation targets before contacting any transport', async () => {
    const result = await sendChannelMessage({ target: { id: 'user' }, text: 'hello', context: 'background' }, workspace());
    expect(result).toMatchObject({ status: 'failed', code: 'CHANNEL_TARGET_INVALID' });
    expect(result.error).toContain('目标 Session');
    expect(result.error).toContain('myagents im send-message --help');
    expect(api).not.toHaveBeenCalled();
  });

  it("validates every attachment before requesting any send", async () => {
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "sidecar");
    const dir = workspace();
    const valid = join(dir, "valid.txt");
    writeFileSync(valid, "hello");
    expect(
      await sendChannelMessage(
        {
          text: "do not send",
          attachments: [{ path: valid }, { path: join(dir, "missing.txt") }],
        },
        dir,
      ),
    ).toMatchObject({ status: "failed" });
    expect(api).not.toHaveBeenCalled();
    expect(
      await sendChannelMessage({ text: "test", sessionId: "forged" }, dir),
    ).toMatchObject({ status: "failed" });
    expect(api).not.toHaveBeenCalled();
  });
  it("preserves uncertain and partial outcomes without retrying", async () => {
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "sidecar");
    api.mockResolvedValueOnce({
      ok: false,
      code: "transport_outcome_unknown",
      error: "timeout",
    });
    expect(
      await sendChannelMessage({ text: "hello" }, workspace()),
    ).toMatchObject({ status: "unknown" });
    expect(api).toHaveBeenCalledTimes(1);
    api.mockResolvedValueOnce({
      ok: true,
      result: {
        status: "partial",
        connection: { channelId: "c", platform: "weixin" },
        target: { type: "user", id: "recipient", idType: "user_id" },
        items: [
          { kind: "text", index: 0, status: "sent", messageIds: ["m"] },
          { kind: "attachment", index: 0, status: "unknown" },
        ],
      },
    });
    expect(
      await sendChannelMessage({ text: "hello" }, workspace()),
    ).toMatchObject({
      status: "partial",
      items: [{ status: "sent" }, { status: "unknown" }],
    });
    expect(api).toHaveBeenCalledTimes(2);
  });
  it("does not register a separate native channel tool", async () => {
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "sidecar");
    const attached = await attachProductHostTools<ProductHostToolInventory>({
      sessionId: "session", workspacePath: workspace(), snapshot: {mcpServers:[],dynamicTools:[],components:[]},
    });
    expect(attached.dynamicTools.some(tool => tool.name.includes("send_channel_message"))).toBe(false);
    expect(api).not.toHaveBeenCalled();
    attached.hostToolDispatcher?.dispose("done");
  });
});
