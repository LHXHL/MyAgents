import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskNotificationSummary } from "./TaskNotificationSummary";
import type { Task } from "@/../shared/types/task";

const { operate, get } = vi.hoisted(() => ({ operate: vi.fn(), get: vi.fn() }));
vi.mock("@/api/taskCenter", () => ({
  taskNotificationOperate: operate,
  taskGet: get,
}));
vi.mock("@/hooks/useDeliveryChannels", () => ({
  useDeliveryChannels: () => ({ channels: [], getChannelInfo: () => null }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
const fixture = (state: string) =>
  ({
    id: "task-qa",
    workspacePath: "/fixture",
    notification: { version: 1, desktop: false, im: { type: "off" } },
    notificationDeliveries: [
      {
        id: "delivery-qa",
        state,
        updatedAt: 1,
        policy: { im: { type: "off" } },
        error: "Receipt unavailable",
      },
    ],
  }) as unknown as Task;
beforeEach(() => {
  operate.mockReset().mockResolvedValue({});
  get.mockReset().mockResolvedValue(fixture("cancelled"));
});
afterEach(cleanup);
describe("Task notification recovery controls", () => {
  it("requires explicit duplicate-risk confirmation before resending an unknown receipt", async () => {
    const changed = vi.fn();
    render(
      <TaskNotificationSummary task={fixture("unknown")} onChanged={changed} />,
    );
    fireEvent.click(screen.getByText(/notifications.latestDelivery/));
    expect(
      screen.queryByRole("button", { name: "notifications.retry" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "notifications.resend" }),
    );
    expect(screen.getByText("notifications.resendWarning")).toBeTruthy();
    expect(operate).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getAllByRole("button", { name: "notifications.resend" })[1],
    );
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(operate).toHaveBeenCalledWith("task-qa", "delivery-qa", "resend");
  });
  it.each(["waiting", "suppressed"] as const)("retries and cancels the delivery without invoking business execution (%s)", async (state) => {
    const changed = vi.fn();
    render(
      <TaskNotificationSummary task={fixture(state)} onChanged={changed} />,
    );
    fireEvent.click(screen.getByText(/notifications.latestDelivery/));
    fireEvent.click(
      screen.getByRole("button", { name: "notifications.retry" }),
    );
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(operate).toHaveBeenLastCalledWith("task-qa", "delivery-qa", "retry");
    if (state === "suppressed") return;
    fireEvent.click(
      screen.getByRole("button", { name: "notifications.cancel" }),
    );
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(operate).toHaveBeenLastCalledWith(
      "task-qa",
      "delivery-qa",
      "cancel",
    );
  });
});
