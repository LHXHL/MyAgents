import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { CopyIcon, LogOutIcon, MonitorIcon } from "@/components/icons";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import {
  DEFAULT_WORKSPACE_ICON,
  resolveWorkspaceIconId,
} from "@/assets/workspace-icons";
import type { NetworkAgent, NetworkDevice } from "@/api/agentNetwork";
import { relativeTime } from "@/utils/taskCenterUtils";

/** One device's Agent catalog as the page last read it. */
export type DeviceCatalog =
  | { status: "ready"; items: NetworkAgent[]; complete: boolean }
  | { status: "error"; error: string };

export function osName(platform: string): string {
  if (/darwin|macos/i.test(platform)) return "macOS";
  if (/win/i.test(platform)) return "Windows";
  if (/linux/i.test(platform)) return "Linux";
  return platform || "—";
}

/** Connection wording only means something once the device is in the network. */
export function deviceStatusText(t: TFunction, device: NetworkDevice): string {
  if (!device.joined) return t("agentNetwork.notJoined");
  if (device.connectionState === "ready") return t("agentNetwork.online");
  if (device.connectionState === "syncing") return t("agentNetwork.syncing");
  return device.lastNetworkSeenAt
    ? t("agentNetwork.offlineSince", {
        time: relativeTime(device.lastNetworkSeenAt),
      })
    : t("agentNetwork.offline");
}

/** Remote catalogs may carry unknown or legacy values; never render them as text. */
export function agentIconId(icon: string | null | undefined): string {
  return resolveWorkspaceIconId(icon) ?? DEFAULT_WORKSPACE_ICON;
}

export function sortAgents(items: NetworkAgent[]): NetworkAgent[] {
  return [...items].sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      a.name.localeCompare(b.name) ||
      a.mountId.localeCompare(b.mountId),
  );
}

export function DeviceIcon({ device }: { device: NetworkDevice }) {
  const dot =
    device.connectionState === "ready"
      ? "bg-[var(--success)]"
      : device.connectionState === "syncing"
        ? "bg-[var(--accent)]"
        : "bg-[var(--ink-faint)]";
  return (
    <span
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--paper-inset)] text-[var(--ink-secondary)] ${device.joined ? "" : "opacity-60"}`}
    >
      <MonitorIcon className="h-[18px] w-[18px]" />
      {device.joined && (
        <span
          aria-hidden
          className={`absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] rounded-full border-2 border-[var(--paper-elevated)] ${dot}`}
        />
      )}
    </span>
  );
}

export function LocalTag() {
  const { t } = useTranslation("app");
  return (
    <span className="shrink-0 rounded-full border border-[var(--accent-cool)]/30 bg-[var(--accent-cool)]/10 px-2 text-xs font-medium leading-[18px] text-[var(--accent-cool)]">
      {t("agentNetwork.local")}
    </span>
  );
}

/** Secondary device actions; leaving is destructive, so it sits last. */
export function DeviceMenu({
  busy,
  onCopyId,
  onLeave,
}: {
  busy: boolean;
  onCopyId: () => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation("app");
  return (
    <DropdownMenu
      size="md"
      minWidth={168}
      disabled={busy}
      sections={[
        {
          items: [
            {
              icon: <CopyIcon className="h-3.5 w-3.5" />,
              label: t("agentNetwork.copyDeviceId"),
              onClick: onCopyId,
            },
          ],
        },
        {
          items: [
            {
              icon: <LogOutIcon className="h-3.5 w-3.5" />,
              label: t("agentNetwork.leave"),
              onClick: onLeave,
              danger: true,
            },
          ],
        },
      ]}
    />
  );
}
