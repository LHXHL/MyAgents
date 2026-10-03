import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRow } from "./AgentRow";
import type { NetworkAgent, NetworkDevice } from "@/api/agentNetwork";
import {
  clearDescriptionDraft,
  descriptionDraftKey,
  getDescriptionDraft,
} from "./store";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/api/agentNetwork", async (original) => ({
  ...(await original<typeof import("@/api/agentNetwork")>()),
  networkRequest: mocks.request,
}));
const principalId = "account-fixture";
const networkId = "11111111-1111-4111-8111-111111111111",
  deviceId = "22222222-2222-4222-8222-222222222222";
const mountId = "33333333-3333-4333-8333-333333333333";
const agent: NetworkAgent = {
  principalId,
  networkId,
  deviceId,
  mountId,
  localAgentId: "agent-fixture",
  localWorkspaceId: "workspace-fixture",
  name: "Research",
  path: "/fixture/research",
  lifecycle: "active",
  catalogRevision: 1,
  enabled: false,
  enableRevision: 2,
  description: null,
  descriptionRevision: 3,
};
const device: NetworkDevice = {
  principalId,
  networkId,
  deviceId,
  name: "Studio",
  platform: "darwin-aarch64",
  osVersion: "macOS",
  appVersion: "0.4.22",
  lastNetworkSeenAt: null,
  lastAccountSeenAt: "2026-10-01T00:00:00Z",
  rosterRevision: "fixture",
  catalogEpoch: null,
  catalogSeq: 1,
  catalogSyncedAt: 1,
  joined: true,
  membershipRevision: 4,
  connectionState: "ready",
  onlineAgentCount: 0,
};
const key = descriptionDraftKey(principalId, networkId, mountId);
const mount = {
  principalId,
  networkId,
  deviceId,
  mountId,
  localAgentId: agent.localAgentId,
  enabled: false,
  enableRevision: 2,
  description: "Handles research",
  descriptionRevision: 4,
};
describe("network Agent inline description and independent field CAS", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    clearDescriptionDraft(key);
  });
  afterEach(() => clearDescriptionDraft(key));
  it("IME Enter does not save; final Enter and blur submit once with description and membership CAS", async () => {
    let resolve!: (value: unknown) => void;
    mocks.request.mockImplementation(
      () =>
        new Promise((value) => {
          resolve = value;
        }),
    );
    const changed = vi.fn();
    render(<AgentRow agent={agent} device={device} onChanged={changed} />);
    fireEvent.click(
      screen.getByRole("button", { name: "为 Research 添加简介" }),
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Handles research" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "description",
        description: "Handles research",
        expectedDescriptionRevision: 3,
        expectedMembershipRevision: 4,
        networkId,
        mountId,
      }),
    );
    expect(mocks.request.mock.calls[0][0]).not.toHaveProperty(
      "expectedEnableRevision",
    );
    await act(async () => {
      resolve(mount);
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(getDescriptionDraft(key)).toBeUndefined();
  });
  it("failed description survives unmount, while Escape discards only that field draft", async () => {
    mocks.request.mockRejectedValue({
      code: "REVISION_CONFLICT",
      retryable: false,
    });
    const changed = vi.fn();
    const first = render(
      <AgentRow agent={agent} device={device} onChanged={changed} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "为 Research 添加简介" }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Unsent draft" },
    });
    fireEvent.blur(screen.getByRole("textbox"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "设置已在其他客户端改变",
      ),
    );
    expect(getDescriptionDraft(key)).toBe("Unsent draft");
    first.unmount();
    render(
      <AgentRow
        agent={{ ...agent, description: "New server value" }}
        device={device}
        onChanged={changed}
      />,
    );
    fireEvent.click(screen.getByText("Unsent draft"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(getDescriptionDraft(key)).toBeUndefined();
    expect(screen.getByText("New server value")).toBeInTheDocument();
    expect(mocks.request).toHaveBeenCalledOnce();
  });
  it("unjoined devices cannot enable Agents; multibyte descriptions are bounded by bytes", async () => {
    render(
      <AgentRow
        agent={agent}
        device={{ ...device, joined: false }}
        onChanged={vi.fn()}
      />,
    );
    const switchButton = screen.getByRole("switch");
    expect(switchButton).toBeDisabled();
    fireEvent.mouseEnter(switchButton.parentElement!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("加入网络后才能启用");
    fireEvent.click(switchButton);
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.mouseLeave(switchButton.parentElement!);
    fireEvent.click(
      screen.getByRole("button", { name: "为 Research 添加简介" }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "汉".repeat(1366) },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("4096");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("Shift+Enter keeps editing, and an open Agent without a description asks for one", () => {
    render(
      <AgentRow
        agent={{ ...agent, enabled: true, path: "/Users/fixture/research" }}
        device={device}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("~/research")).toHaveAttribute(
      "title",
      "/Users/fixture/research",
    );
    expect(screen.getByText("已开放")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "添加简介，让其他 Agent 知道该找它做什么",
      }),
    );
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      shiftKey: true,
    });
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
