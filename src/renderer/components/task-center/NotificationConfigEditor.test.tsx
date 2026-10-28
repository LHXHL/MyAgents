import { useState } from "react";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NotificationConfigEditor from "./NotificationConfigEditor";
import type { NotificationConfig } from "@/../shared/types/task";
const { loadPeers, changed } = vi.hoisted(() => ({
  loadPeers: vi.fn(),
  changed: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params?.name
        ? `${key}:${params.name}`
        : params?.id
          ? `${key}:${params.id}`
          : key,
  }),
}));
vi.mock("@/features/team-ai/client", () => ({ teamChannels: loadPeers }));
vi.mock("@/hooks/useDeliveryChannels", () => ({
  useDeliveryChannels: () => ({
    options: [
      { value: "", label: "desktop" },
      { value: "c", label: "Feishu" },
    ],
    channels: [
      {
        botId: "c",
        agentId: "a",
        agentName: "Agent",
        name: "Feishu",
        status: "stopped",
      },
    ],
  }),
}));
function Editor({ initial }: { initial: NotificationConfig }) {
  const [value, setValue] = useState(initial);
  return (
    <NotificationConfigEditor
      value={value}
      onChange={(next) => {
        changed(next);
        setValue(next);
      }}
    />
  );
}
beforeEach(() => {
  changed.mockClear();
  loadPeers.mockResolvedValue({
    channels: [
      {
        channelId: "c",
        peers: [
          {
            sessionKey: "group:1",
            name: "Project group",
            sourceType: "group",
            sourceId: "g",
          },
          { sessionKey: null, name: "Not yet routable", sourceType: "private", sourceId: "u" },
        ],
      },
    ],
  });
});
afterEach(cleanup);
describe("shared Task notification editor", () => {
  it("keeps an offline selected conversation and changes desktop independently", async () => {
    render(
      <Editor
        initial={{
          version: 1,
          desktop: true,
          im: { type: "conversation", channelId: "c", sessionKey: "group:1" },
        }}
      />,
    );
    await screen.findByText("Project group · notifications.group");
    fireEvent.click(screen.getByText("Project group · notifications.group"));
    expect(screen.queryByText(/Not yet routable/)).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(
      screen.getByRole("switch", { name: "notifications.desktopAria" }),
    );
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        desktop: false,
        im: { type: "conversation", channelId: "c", sessionKey: "group:1" },
      }),
    );
  });
  it("preserves a missing selected peer and makes off an explicit user choice", async () => {
    render(
      <Editor
        initial={{
          version: 1,
          desktop: true,
          im: { type: "conversation", channelId: "c", sessionKey: "missing" },
        }}
      />,
    );
    await waitFor(() => expect(loadPeers).toHaveBeenCalled());
    expect(screen.getByText("notifications.unavailable:missing")).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("notifications.conversation"));
    fireEvent.click(await screen.findByText("notifications.off"));
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ im: { type: "off" } }),
    );
    expect(screen.queryByText("notifications.unavailable:missing")).toBeNull();
  });
});
