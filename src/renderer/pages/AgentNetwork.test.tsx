import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkDevice, NetworkSnapshot } from "@/api/agentNetwork";
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  logout: vi.fn(),
  request: vi.fn(),
  devices: vi.fn(),
  agents: vi.fn(),
  login: vi.fn(),
  snapshot: {
    state: "ready",
    principalId: "account",
    networkId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    authGeneration: 1,
    error: null,
  } as NetworkSnapshot,
}));
vi.mock("@/api/spaceCloud", async (original) => ({
  ...(await original<typeof import("@/api/spaceCloud")>()),
  spaceGetSession: mocks.session,
  spaceLogout: mocks.logout,
}));
vi.mock("@/api/agentNetwork", async (original) => ({
  ...(await original<typeof import("@/api/agentNetwork")>()),
  networkRequest: mocks.request,
  allNetworkDevices: mocks.devices,
  allDeviceAgents: mocks.agents,
}));
vi.mock("@/hooks/useMyAgentsLogin", () => ({
  useMyAgentsLogin: () => ({
    authBusy: false,
    authFlow: null,
    startLogin: mocks.login,
  }),
}));
vi.mock("@/features/agent-network/store", async (original) => ({
  ...(await original<typeof import("@/features/agent-network/store")>()),
  useAgentNetworkSnapshot: () => mocks.snapshot,
  currentNetworkGeneration: () => mocks.snapshot.authGeneration,
}));
vi.mock("@/identity/deviceIdentity", () => ({
  getDeviceId: () => "22222222-2222-4222-8222-222222222222",
  preloadDeviceId: async () => undefined,
}));
import AgentNetwork from "./AgentNetwork";
const device: NetworkDevice = {
  deviceId: "22222222-2222-4222-8222-222222222222",
  principalId: "account",
  networkId: "11111111-1111-4111-8111-111111111111",
  name: "Fixture Mac",
  platform: "darwin-aarch64",
  osVersion: "macOS 15",
  appVersion: "0.4.22",
  lastNetworkSeenAt: null,
  lastAccountSeenAt: "2026-10-01T00:00:00Z",
  rosterRevision: "1",
  catalogEpoch: null,
  catalogSeq: 0,
  catalogSyncedAt: null,
  joined: false,
  membershipRevision: 0,
  connectionState: "ready",
  onlineAgentCount: null,
};
const membership = {
  networkId: device.networkId,
  principalId: device.principalId,
  deviceId: device.deviceId,
  joined: true,
  membershipRevision: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot = {
    state: "ready",
    principalId: "account",
    networkId: device.networkId,
    revision: 1,
    authGeneration: 1,
    error: null,
  };
  mocks.session.mockResolvedValue({
    state: "authenticated",
    session: { user: { id: "account" } },
  });
  mocks.devices.mockResolvedValue({ items: [device], complete: true });
  mocks.agents.mockResolvedValue({ items: [], complete: true });
  mocks.request.mockImplementation(async (request) =>
    request.kind === "network"
      ? {
          serviceId: "33333333-3333-4333-8333-333333333333",
          networkId: device.networkId,
          principalId: "account",
          environment: "development",
          name: "我的 Agent 网络",
          revision: 1,
          protocol: 1,
          capabilities: [],
        }
      : membership,
  );
});
describe("Agent network account and device management", () => {
  it("reports a connection failure with automatic recovery and no save claim", async () => {
    mocks.snapshot = {
      ...mocks.snapshot,
      state: "disconnected",
      error: { code: "NETWORK_TRANSPORT_FAILED", retryable: false },
    };
    render(<AgentNetwork />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "网络连接失败，正在自动重连",
    );
    expect(screen.queryByText(/尚未确认保存结果/)).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("offers read retry without claiming an uncertain save", async () => {
    mocks.devices.mockRejectedValueOnce({ code: "NETWORK_TRANSPORT_FAILED" });
    render(<AgentNetwork />);
    expect(await screen.findByRole("alert")).not.toHaveTextContent("保存结果");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(
      await screen.findByRole("button", {
        name: "查看 Fixture Mac 的设备详情",
      }),
    ).toBeInTheDocument();
  });
  it("keeps a real membership write uncertain when its transport result is lost", async () => {
    render(<AgentNetwork />);
    await screen.findByRole("button", { name: "加入网络" });
    mocks.request.mockRejectedValueOnce({ code: "NETWORK_TRANSPORT_FAILED" });
    fireEvent.click(screen.getByRole("button", { name: "加入网络" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "尚未确认保存结果",
    );
  });
  it("reports a details read failure without a save claim", async () => {
    mocks.agents.mockRejectedValueOnce({ code: "NETWORK_REQUEST_UNCONFIRMED" });
    render(<AgentNetwork />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "查看 Fixture Mac 的设备详情",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).not.toHaveTextContent(
      "保存结果",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.agents).toHaveBeenCalledTimes(2));
  });
  it("uses the shared account login screen without querying network metadata while signed out", async () => {
    mocks.snapshot = { ...mocks.snapshot, state: "signedOut" };
    mocks.session.mockResolvedValue(null);
    render(<AgentNetwork />);
    const login = await screen.findByRole("button", {
      name: "继续使用 Google",
    });
    expect(login).toHaveClass("h-10");
    fireEvent.click(login);
    expect(mocks.login).toHaveBeenCalledOnce();
    expect(mocks.devices).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("groups an unjoined device apart and keeps membership separate from the whole-card details action", async () => {
    render(<AgentNetwork />);
    const details = await screen.findByRole("button", {
      name: "查看 Fixture Mac 的设备详情",
    });
    expect(screen.getByText("同账号下未加入的设备")).toBeInTheDocument();
    expect(screen.queryByText("网络中的设备")).not.toBeInTheDocument();
    expect(screen.getByText("macOS · 未加入网络")).toBeInTheDocument();
    fireEvent.click(details);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("darwin-aarch64")).toBeInTheDocument();
    expect(mocks.request).toHaveBeenCalledTimes(1); // Read network only; opening details cannot join.
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "加入网络" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "membership",
          joined: true,
          expectedMembershipRevision: 0,
        }),
      ),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
  it("opens the explanation by click and dismisses it by Escape or outside click", async () => {
    render(<AgentNetwork />);
    const button = await screen.findByRole("button", { name: "网络说明" });
    const hint =
      "设备之间的任务、响应和结果都在设备端加密，MyAgents 服务器只转发密文。";
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText(hint)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
    fireEvent.click(button);
    await screen.findByText(hint);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
    expect(screen.queryByText("我的设备")).not.toBeInTheDocument();
  });
  it("shows actual network last-seen and joins an unjoined device inside details", async () => {
    const seen = Date.UTC(2026, 8, 29, 10);
    mocks.devices.mockResolvedValue({
      items: [
        { ...device, lastNetworkSeenAt: seen, connectionState: "offline" },
      ],
      complete: true,
    });
    render(<AgentNetwork />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "查看 Fixture Mac 的设备详情",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("macOS · 未加入网络")).toBeInTheDocument();
    expect(
      within(dialog).getByText(new Date(seen).toLocaleString()),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "加入网络" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "membership", joined: true }),
      ),
    );
  });
  it("confirms leave and fences a late result when the account changes", async () => {
    mocks.devices.mockResolvedValue({
      items: [
        { ...device, joined: true, onlineAgentCount: 2, catalogSyncedAt: 1 },
      ],
      complete: true,
    });
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementation(async (request) =>
      request.kind === "network"
        ? {
            serviceId: "33333333-3333-4333-8333-333333333333",
            networkId: device.networkId,
            principalId: "account",
            environment: "development",
            name: "我的 Agent 网络",
            revision: 1,
            protocol: 1,
            capabilities: [],
          }
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const view = render(<AgentNetwork />);
    fireEvent.click(await screen.findByTitle("更多操作"));
    fireEvent.click(await screen.findByRole("button", { name: "退出网络" }));
    const confirmation = (
      await screen.findByText("退出网络？")
    ).closest<HTMLElement>(".glass-panel")!;
    expect(confirmation).toHaveTextContent("重新加入后，需要重新开启");
    expect(
      mocks.request.mock.calls.filter(
        ([request]) => request.kind === "membership",
      ),
    ).toHaveLength(0);
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "退出网络" }),
    );
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    mocks.snapshot = {
      ...mocks.snapshot,
      state: "signedOut",
      authGeneration: 2,
      revision: 2,
      principalId: null,
      networkId: null,
    };
    mocks.session.mockResolvedValue(null);
    view.rerender(<AgentNetwork />);
    await screen.findByRole("button", { name: "继续使用 Google" });
    await act(async () => {
      finish({ ...membership, joined: false });
    });
    expect(screen.queryByText("Fixture Mac")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("shows each joined device's open Agents and guides first use from facts already read", async () => {
    const remote = {
      ...device,
      deviceId: "44444444-4444-4444-8444-444444444444",
      name: "Fixture PC",
      platform: "windows-x86_64",
      joined: true,
      catalogSyncedAt: 1,
    };
    const agent = (name: string, enabled: boolean, index: number) => ({
      principalId: "account",
      networkId: device.networkId,
      deviceId: remote.deviceId,
      mountId: `55555555-5555-4555-8555-55555555555${index}`,
      localAgentId: `agent-${index}`,
      localWorkspaceId: `workspace-${index}`,
      name,
      path: `C:\\Users\\fixture\\${name}`,
      lifecycle: "active" as const,
      catalogRevision: 1,
      enabled,
      enableRevision: 1,
      description: null,
      descriptionRevision: 1,
      icon: index === 1 ? "not-a-glyph" : null,
    });
    mocks.devices.mockResolvedValue({
      items: [device, remote],
      complete: true,
    });
    mocks.agents.mockImplementation(async (deviceId: string) =>
      deviceId === remote.deviceId
        ? {
            items: [agent("Builder", true, 1), agent("Docs", false, 2)],
            complete: true,
          }
        : { items: [], complete: true },
    );
    render(<AgentNetwork />);
    const card = (
      await screen.findByRole("button", { name: "查看 Fixture PC 的设备详情" })
    ).closest("article")!;
    expect(await within(card).findByText("Builder")).toBeInTheDocument();
    expect(within(card).queryByText("Docs")).not.toBeInTheDocument();
    expect(within(card).getByText("已开放 1 / 2 个 Agent")).toBeInTheDocument();
    // An unknown remote icon falls back to the neutral glyph, never raw text.
    expect(within(card).queryByText("not-a-glyph")).not.toBeInTheDocument();
    // This device has not joined, so the guide points at step one.
    const guide = screen.getByRole("list");
    expect(
      within(guide).getByText("让设备加入网络").closest("li"),
    ).toHaveAttribute("aria-current", "step");
    // Leaving is reachable from the details header and still asks first.
    fireEvent.click(
      within(card).getByRole("button", { name: "查看 Fixture PC 的设备详情" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("~\\Builder"),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByTitle("更多操作"));
    fireEvent.click(await screen.findByRole("button", { name: "退出网络" }));
    expect(await screen.findByText("退出网络？")).toBeInTheDocument();
    expect(
      mocks.request.mock.calls.filter(
        ([request]) => request.kind === "membership",
      ),
    ).toHaveLength(0);
  });
  it("hides the guide once this device is in and an Agent is open", async () => {
    mocks.devices.mockResolvedValue({
      items: [{ ...device, joined: true, catalogSyncedAt: 1 }],
      complete: true,
    });
    mocks.agents.mockResolvedValue({
      items: [
        {
          principalId: "account",
          networkId: device.networkId,
          deviceId: device.deviceId,
          mountId: "66666666-6666-4666-8666-666666666666",
          localAgentId: "agent",
          localWorkspaceId: "workspace",
          name: "Mino",
          path: "/Users/fixture/mino",
          lifecycle: "active",
          catalogRevision: 1,
          enabled: true,
          enableRevision: 1,
          description: "Daily helper",
          descriptionRevision: 1,
        },
      ],
      complete: true,
    });
    render(<AgentNetwork />);
    expect(await screen.findByText("Mino")).toBeInTheDocument();
    expect(screen.getByText("本机")).toBeInTheDocument();
    expect(screen.queryByText("让设备加入网络")).not.toBeInTheDocument();
    expect(screen.queryByText("开放 Agent 工作区")).not.toBeInTheDocument();
  });
});
