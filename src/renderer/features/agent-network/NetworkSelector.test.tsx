import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { NetworkRegistry } from "@/api/agentNetwork";
const calls = vi.hoisted(() => ({
  select: vi.fn(),
  join: vi.fn(),
  remove: vi.fn(),
  accept: vi.fn(),
}));
vi.mock("@/api/agentNetwork", async (original) => ({
  ...(await original<typeof import("@/api/agentNetwork")>()),
  selectNetworkConnection: calls.select,
  joinNetworkConnection: calls.join,
  removeNetworkConnection: calls.remove,
}));
vi.mock("./store", () => ({ acceptNetworkRegistry: calls.accept }));
import { NetworkSelector } from "./NetworkSelector";
const registry: NetworkRegistry = {
  selected: "official",
  connections: ["official", "self-a", "self-b"].map((id) => ({
    id,
    name:
      id === "official" ? "MyAgents" : id === "self-a" ? "Team A" : "Team B",
    official: id === "official",
    url: null,
    removing: false,
    snapshot: {
      connectionId: id,
      state: "ready",
      principalId: id,
      networkId: id,
      error: null,
      revision: 1,
      authGeneration: 1,
    },
  })),
};
beforeEach(() => {
  vi.resetAllMocks();
  calls.select.mockResolvedValue({ ...registry, selected: "self-a" });
  calls.join.mockRejectedValue({ code: "ENROLLMENT_KEY_EXPIRED" });
});
it("switches only the selected view and never removes or reenrolls another connection", async () => {
  render(<NetworkSelector registry={registry} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /Team A/ }));
  await waitFor(() => expect(calls.select).toHaveBeenCalledWith("self-a"));
  expect(calls.remove).not.toHaveBeenCalled();
  expect(calls.join).not.toHaveBeenCalled();
  expect(calls.accept).toHaveBeenCalledWith(
    expect.objectContaining({
      selected: "self-a",
      connections: registry.connections,
    }),
  );
});
it("retains the URL but clears enrollment material after a refused join", async () => {
  render(<NetworkSelector registry={registry} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "加入自部署网络" }),
  );
  const url = screen.getByLabelText("服务 URL");
  const key = screen.getByLabelText("设备 key");
  fireEvent.change(url, { target: { value: "https://hub.example.test" } });
  fireEvent.change(key, { target: { value: "ephemeral-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "加入网络" }));
  await screen.findByRole("alert");
  expect(url).toHaveValue("https://hub.example.test");
  expect(key).toHaveValue("");
  expect(calls.join).toHaveBeenCalledWith(
    "https://hub.example.test",
    "ephemeral-test-key",
  );
  expect(calls.accept).not.toHaveBeenCalled();
});
