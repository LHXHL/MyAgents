// Shared create/edit policy editor. Channel and peer data remain owner projections.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeliveryChannels } from "@/hooks/useDeliveryChannels";
import { teamChannels } from "@/features/team-ai/client";
import CustomSelect from "@/components/CustomSelect";
import type { SelectOption } from "@/components/CustomSelect";
import type {
  NotificationConfig,
  NotificationTarget,
} from "@/../shared/types/task";
import type { TeamPeer } from "@/../shared/teamAi";
import { Toggle } from "./editors/PanelChrome";

interface Props {
  value?: NotificationConfig;
  onChange: (next: NotificationConfig) => void;
  workspacePath?: string;
}
export function NotificationConfigEditor({
  value,
  onChange,
  workspacePath,
}: Props) {
  const { t } = useTranslation("task");
  const { options, channels } = useDeliveryChannels(workspacePath);
  const im = value?.im ?? { type: "off" as const };
  const channelId = "channelId" in im ? im.channelId : "";
  const channel = channels.find((ch) => ch.botId === channelId);
  const agentId = channel?.agentId;
  const [peerResult, setPeerResult] = useState<{
    key: string;
    peers: TeamPeer[];
    error?: string;
  }>();
  const queryKey = `${agentId ?? ""}:${channelId}`;
  const peers = peerResult?.key === queryKey ? peerResult.peers : [];
  const peerError = peerResult?.key === queryKey ? peerResult.error : undefined;
  const loading = !!agentId && !!channelId && peerResult?.key !== queryKey;
  useEffect(() => {
    if (!agentId || !channelId) return;
    let disposed = false;
    void teamChannels(agentId)
      .then((result) => {
        if (disposed) return;
        const row = result.channels.find((ch) => ch.channelId === channelId);
        setPeerResult({
          key: queryKey,
          peers: row?.peers ?? [],
          error: row?.loadError ?? undefined,
        });
      })
      .catch((error) => {
        if (!disposed)
          setPeerResult({ key: queryKey, peers: [], error: String(error) });
      });
    return () => {
      disposed = true;
    };
  }, [agentId, channelId, queryKey]);
  const patch = (next: Partial<NotificationConfig>) =>
    onChange({
      ...value,
      desktop: value?.desktop ?? true,
      version: 1,
      botChannelId: undefined,
      botThread: undefined,
      ...next,
    });
  const select = (target: NotificationTarget) =>
    patch({ im: target, error: undefined });
  const targetValue =
    im.type === "recent-private"
      ? `${im.scope}:${im.scope === "channel" ? im.channelId : im.agentId}`
      : im.type;
  const destinations: SelectOption[] = [
    { value: "off", label: t("notifications.off") },
    { value: "conversation", label: t("notifications.conversation") },
  ];
  const seen = new Set<string>();
  for (const option of options) {
    if (!option.value) continue;
    if (option.isSeparator) {
      destinations.push(option);
      continue;
    }
    destinations.push({
      ...option,
      value: `channel:${option.value}`,
      label: t("notifications.recentChannel", { name: option.label }),
    });
    const info = channels.find((ch) => ch.botId === option.value);
    if (info?.agentId && !seen.has(info.agentId)) {
      seen.add(info.agentId);
      destinations.push({
        value: `agent:${info.agentId}`,
        label: t("notifications.recentAgent", { name: info.agentName }),
      });
    }
  }
  if (!destinations.some((option) => option.value === targetValue))
    destinations.push({
      value: targetValue,
      label: t("notifications.unavailable", { id: targetValue }),
    });
  const selectedKey = im.type === "conversation" ? im.sessionKey : "";
  const peerOptions: SelectOption[] = peers.filter((peer): peer is TeamPeer & { sessionKey: string } => peer.sessionKey !== null).map((peer) => ({
    value: peer.sessionKey,
    label: `${peer.name || peer.sourceId} · ${peer.sourceType === "group" ? t("notifications.group") : t("notifications.private")}`,
  }));
  if (
    selectedKey &&
    !peerOptions.some((option) => option.value === selectedKey)
  )
    peerOptions.push({
      value: selectedKey,
      label: t("notifications.unavailable", { id: selectedKey }),
    });
  const channelOptions = options.filter((option) => option.value);
  if (channelId && !channelOptions.some((option) => option.value === channelId))
    channelOptions.push({
      value: channelId,
      label: t("notifications.unavailable", { id: channelId }),
    });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
        <div className="min-w-0 pr-3">
          <div className="text-sm text-[var(--ink)]">
            {t("notifications.desktopTitle")}
          </div>
          <div className="mt-0.5 text-xs text-[var(--ink-muted)]">
            {t("notifications.desktopDescription")}
          </div>
        </div>
        <Toggle
          checked={value?.desktop !== false}
          onChange={(desktop) => patch({ desktop })}
          ariaLabel={t("notifications.desktopAria")}
        />
      </div>
      <div className="space-y-2">
        <label className="block text-sm font-medium text-[var(--ink-secondary)]">
          {t("notifications.imBot")}
        </label>
        <CustomSelect
          value={targetValue}
          options={destinations}
          size="md"
          onChange={(choice) => {
            if (choice === "conversation") {
              select({ type: "conversation", channelId, sessionKey: "" });
              return;
            }
            if (choice === "off") select({ type: "off" });
            else if (choice.startsWith("channel:"))
              select({
                type: "recent-private",
                scope: "channel",
                channelId: choice.slice(8),
              });
            else if (choice.startsWith("agent:"))
              select({
                type: "recent-private",
                scope: "agent",
                agentId: choice.slice(6),
              });
          }}
        />
        {im.type === "conversation" && (
          <div className="space-y-2 pl-3 border-l border-[var(--line)]">
            <CustomSelect
              value={channelId}
              options={channelOptions}
              placeholder={t("notifications.chooseChannel")}
              onChange={(id) =>
                select({ type: "conversation", channelId: id, sessionKey: "" })
              }
            />
            {channelId && (
              <CustomSelect
                value={selectedKey}
                options={peerOptions}
                placeholder={
                  loading
                    ? t("notifications.loadingPeers")
                    : t("notifications.choosePeer")
                }
                onChange={(sessionKey) =>
                  select({ type: "conversation", channelId, sessionKey })
                }
              />
            )}
            {peerError && (
              <p role="alert" className="text-xs text-[var(--error)]">
                {peerError}
              </p>
            )}
            {!loading && channelId && !peerOptions.length && !peerError && (
              <p className="text-xs text-[var(--ink-muted)]">
                {t("notifications.noPeers")}
              </p>
            )}
          </div>
        )}
        {value?.error && (
          <p role="alert" className="text-xs text-[var(--error)]">
            {value.error}
          </p>
        )}
        <p className="text-xs text-[var(--ink-muted)]">
          {t("notifications.futureOnly")}
        </p>
      </div>
    </div>
  );
}
export default NotificationConfigEditor;
