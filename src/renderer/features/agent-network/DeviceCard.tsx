import { useTranslation } from "react-i18next";
import WorkspaceIcon from "@/components/launcher/WorkspaceIcon";
import type { NetworkDevice } from "@/api/agentNetwork";
import {
  agentIconId,
  DeviceIcon,
  DeviceMenu,
  deviceStatusText,
  LocalTag,
  osName,
  sortAgents,
  type DeviceCatalog,
} from "./deviceDisplay";

const VISIBLE_AGENTS = 3;

export function DeviceCard({
  device,
  catalog,
  isLocal,
  busy,
  error,
  onOpen,
  onJoin,
  onLeave,
  onCopyId,
}: {
  device: NetworkDevice;
  /** `undefined` while the catalog is still loading. */
  catalog: DeviceCatalog | undefined;
  isLocal: boolean;
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onJoin: () => void;
  onLeave: () => void;
  onCopyId: () => void;
}) {
  const { t } = useTranslation("app");
  const heading = (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <h2
          className="min-w-0 truncate text-sm font-semibold text-[var(--ink)]"
          title={device.name}
        >
          {device.name}
        </h2>
        {isLocal && <LocalTag />}
      </div>
      <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
        {osName(device.platform)} · {deviceStatusText(t, device)}
      </p>
    </div>
  );
  // The full-card button sits underneath; real controls stay above it.
  const openLayer = (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("agentNetwork.openDevice", { name: device.name })}
      className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    />
  );
  const errorLine = error && (
    <p
      role="alert"
      className="pointer-events-none relative mt-3 text-xs text-[var(--error)]"
    >
      {error}
    </p>
  );

  if (!device.joined) {
    return (
      <article className="relative rounded-xl border border-dashed border-[var(--line-strong)] p-[18px] transition-colors hover:bg-[var(--paper-elevated)]">
        {openLayer}
        <div className="pointer-events-none relative flex items-center gap-3">
          <DeviceIcon device={device} />
          {heading}
          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={onJoin}
            className="pointer-events-auto shrink-0 rounded-lg bg-[var(--button-primary-bg)] px-2.5 py-1.5 text-xs font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-60"
          >
            {t(busy ? "agentNetwork.saving" : "agentNetwork.join")}
          </button>
        </div>
        {errorLine}
      </article>
    );
  }

  const opened =
    catalog?.status === "ready"
      ? sortAgents(catalog.items).filter((agent) => agent.enabled)
      : [];
  let agents;
  if (catalog === undefined) {
    agents = (
      <span
        aria-hidden
        className="h-[26px] w-40 animate-pulse rounded-full bg-[var(--paper-inset)]"
      />
    );
  } else if (opened.length > 0) {
    agents = (
      <>
        {opened.slice(0, VISIBLE_AGENTS).map((agent) => (
          <span
            key={agent.mountId}
            className="inline-flex h-[26px] max-w-[12rem] items-center gap-1.5 rounded-full border border-[var(--line)] pl-2 pr-2.5 text-xs text-[var(--ink-secondary)]"
          >
            <WorkspaceIcon icon={agentIconId(agent.icon)} size={16} />
            <span className="truncate">{agent.name}</span>
          </span>
        ))}
        {opened.length > VISIBLE_AGENTS && (
          <span className="inline-flex h-[26px] items-center rounded-full border border-[var(--line)] px-2.5 text-xs text-[var(--ink-muted)]">
            {t("agentNetwork.moreAgents", {
              count: opened.length - VISIBLE_AGENTS,
            })}
          </span>
        )}
      </>
    );
  } else {
    agents = (
      <span className="text-xs text-[var(--ink-subtle)]">
        {catalog.status === "error"
          ? catalog.error
          : device.catalogSyncedAt === null
            ? t("agentNetwork.unsyncedShort")
            : t("agentNetwork.noOpenAgents")}
      </span>
    );
  }
  return (
    <article className="relative flex flex-col gap-3.5 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)] p-[18px] transition-[box-shadow,border-color] hover:border-[var(--line)] hover:shadow-sm">
      {openLayer}
      <div className="pointer-events-none relative flex items-start gap-3">
        <DeviceIcon device={device} />
        {heading}
        <div className="pointer-events-auto -mr-1 -mt-1 shrink-0">
          <DeviceMenu busy={busy} onCopyId={onCopyId} onLeave={onLeave} />
        </div>
      </div>
      <div className="pointer-events-none relative flex min-h-[26px] flex-wrap items-center gap-1.5">
        {agents}
      </div>
      <p className="pointer-events-none relative border-t border-[var(--line-subtle)] pt-3 text-xs text-[var(--ink-muted)]">
        {catalog?.status === "ready"
          ? t("agentNetwork.openCount", {
              open: opened.length,
              total: catalog.items.length,
            })
          : "—"}
      </p>
      {errorLine}
    </article>
  );
}
