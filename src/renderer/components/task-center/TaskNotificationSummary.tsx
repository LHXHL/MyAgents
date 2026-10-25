import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BellIcon } from "@/components/icons";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useDeliveryChannels } from "@/hooks/useDeliveryChannels";
import { taskNotificationOperate, taskGet } from "@/api/taskCenter";
import type { Task, NotificationTarget } from "@/../shared/types/task";

export function TaskNotificationSummary({
  task,
  onChanged,
}: {
  task: Task;
  onChanged: (task: Task) => void;
}) {
  const { t, i18n } = useTranslation("task");
  const { getChannelInfo, channels } = useDeliveryChannels(task.workspacePath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendId, setResendId] = useState<string | null>(null);
  const targetLabel = (target?: NotificationTarget) => {
    if (!target || target.type === "off") return t("notifications.off");
    if (target.type === "current") return t("notifications.conversation");
    if (target.type === "recent-private" && target.scope === "agent")
      return t("notifications.recentAgent", {
        name:
          channels.find((ch) => ch.agentId === target.agentId)?.agentName ??
          target.agentId,
      });
    const name = getChannelInfo(target.channelId)?.name ?? target.channelId;
    return target.type === "conversation"
      ? `${name} · ${target.sessionKey}`
      : t("notifications.recentChannel", { name });
  };
  const act = async (id: string, action: "retry" | "resend" | "cancel") => {
    setBusy(true);
    setError(null);
    try {
      await taskNotificationOperate(task.id, id, action);
      const fresh = await taskGet(task.id);
      if (fresh) onChanged(fresh);
      setResendId(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  const deliveries = [...(task.notificationDeliveries ?? [])].reverse();
  return (
    <div className="space-y-2 min-w-0">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-[var(--ink)]">
        <BellIcon className="h-3.5 w-3.5" />
        {t("detail.notification")}
      </div>
      <p className="text-xs text-[var(--ink-secondary)]">
        {t(
          task.notification?.desktop === false
            ? "detail.desktopOff"
            : "detail.desktopOn",
        )}{" "}
        ·{" "}
        {task.notification?.im?.type === "conversation"
          ? (task.notificationDestination?.label ??
            targetLabel(task.notification.im))
          : targetLabel(task.notification?.im)}
      </p>
      {task.notification?.error && (
        <p role="alert" className="text-xs text-[var(--error)]">
          {task.notification.error}
        </p>
      )}
      {!!deliveries.length && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--ink-secondary)]">
            {t("notifications.latestDelivery")} ·{" "}
            {t(`notifications.states.${deliveries[0].state}`)}
          </summary>
          <div className="mt-2 max-h-72 overflow-y-auto space-y-3">
            {deliveries.map((delivery) => (
              <div
                key={delivery.id}
                className="border-l border-[var(--line)] pl-3 space-y-1"
              >
                <p className="font-medium">
                  {t(`notifications.states.${delivery.state}`)} ·{" "}
                  {new Date(delivery.updatedAt).toLocaleString(i18n.language)}
                </p>
                <p className="break-all text-[var(--ink-muted)]">
                  {delivery.target
                    ? targetLabel({ type: "conversation", ...delivery.target })
                    : targetLabel(delivery.policy.im)}
                </p>
                {delivery.error && (
                  <p className="text-[var(--ink-muted)] break-words">
                    {delivery.error}
                  </p>
                )}
                <div className="flex gap-3">
                  {(delivery.state === "failed" ||
                    delivery.state === "waiting") && (
                    <button
                      type="button"
                      disabled={busy}
                      className="text-[var(--accent)] disabled:opacity-50"
                      onClick={() => void act(delivery.id, "retry")}
                    >
                      {t("notifications.retry")}
                    </button>
                  )}
                  {(delivery.state === "unknown" ||
                    delivery.state === "partial") && (
                    <button
                      type="button"
                      disabled={busy}
                      className="text-[var(--accent)] disabled:opacity-50"
                      onClick={() => setResendId(delivery.id)}
                    >
                      {t("notifications.resend")}
                    </button>
                  )}
                  {[
                    "waiting",
                    "preparing",
                    "prepared",
                    "failed",
                    "unknown",
                    "partial",
                  ].includes(delivery.state) && (
                    <button
                      type="button"
                      disabled={busy}
                      className="text-[var(--ink-muted)] disabled:opacity-50"
                      onClick={() => void act(delivery.id, "cancel")}
                    >
                      {t("notifications.cancel")}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--error)]">
          {error}
        </p>
      )}
      {resendId !== null && (
        <ConfirmDialog
          loading={busy}
          title={t("notifications.resend")}
          message={t("notifications.resendWarning")}
          confirmText={t("notifications.resend")}
          onConfirm={() => {
            if (resendId) void act(resendId, "resend");
          }}
          onCancel={() => setResendId(null)}
        />
      )}
    </div>
  );
}
