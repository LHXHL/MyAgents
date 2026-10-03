import { useEffect, useRef, useState } from "react";
import { FloatingFocusManager, useFloating } from "@floating-ui/react";
import { useTranslation } from "react-i18next";
import { CloseIcon } from '@/components/icons';
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import {
  allDeviceAgents,
  networkErrorKey,
  type NetworkAgent,
  type NetworkDevice,
} from "@/api/agentNetwork";
import { AgentRow } from "./AgentRow";
import { currentNetworkGeneration } from "./store";

export function DeviceDetails({
  device,
  isLocal,
  onClose,
  onChanged,
  onJoin,
  membershipBusy,
  membershipError,
}: {
  device: NetworkDevice;
  isLocal: boolean;
  onClose: () => void;
  onChanged: () => void;
  onJoin: () => void;
  membershipBusy: boolean;
  membershipError: string | null;
}) {
  const { t } = useTranslation("app");
  const {
    refs: { setFloating },
    context,
  } = useFloating({ open: true });
  const close = useRef<HTMLButtonElement>(null);
  const [agents, setAgents] = useState<NetworkAgent[]>([]);
  const [complete, setComplete] = useState(true),
    [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  const requestKey = `${device.deviceId}/${device.membershipRevision}/${refresh}`;
  const loading = loadedKey !== requestKey;
  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);
  useEffect(() => {
    let cancelled = false;
    const generation = currentNetworkGeneration();
    void allDeviceAgents(device.deviceId)
      .then((page) => {
        if (cancelled || generation !== currentNetworkGeneration()) return;
        setAgents(
          page.items.sort(
            (a, b) =>
              a.name.localeCompare(b.name) ||
              a.mountId.localeCompare(b.mountId),
          ),
        );
        setComplete(page.complete);
        setError(null);
      })
      .catch((failure) => {
        if (!cancelled && generation === currentNetworkGeneration())
          setError(t(`agentNetwork.errors.${networkErrorKey(failure)}`));
      })
      .finally(() => {
        if (!cancelled && generation === currentNetworkGeneration())
          setLoadedKey(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [device.deviceId, requestKey, t]);
  const changed = () => {
    setRefresh((value) => value + 1);
    onChanged();
  };
  const details = [
    [
      t("agentNetwork.connectionStatus"),
      t(
        device.connectionState === "offline"
          ? "agentNetwork.offline"
          : device.connectionState === "ready"
            ? "agentNetwork.online"
            : "agentNetwork.syncing",
      ),
    ],
    [t("agentNetwork.computerName"), device.name],
    [
      t("agentNetwork.ownership"),
      t(isLocal ? "agentNetwork.localDevice" : "agentNetwork.remoteDevice"),
    ],
    [t("agentNetwork.platform"), device.platform],
    [t("agentNetwork.osVersion"), device.osVersion],
    [t("agentNetwork.clientVersion"), device.appVersion],
    [t("agentNetwork.deviceId"), device.deviceId],
    [
      t("agentNetwork.lastSeen"),
      device.lastNetworkSeenAt
        ? new Date(device.lastNetworkSeenAt).toLocaleString()
        : "—",
    ],
  ];
  return (
    <OverlayBackdrop portal onClose={onClose} className="z-[220] p-4">
      <FloatingFocusManager context={context} initialFocus={close} returnFocus>
        <section
          ref={setFloating}
          role="dialog"
          aria-modal="true"
          aria-labelledby="network-device-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !isImeComposingEvent(event)) {
              event.stopPropagation();
              onClose();
            }
          }}
          className="flex max-h-[min(760px,90dvh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl"
        >
          <header className="flex items-center justify-between gap-4 border-b border-[var(--line)] px-6 py-4">
            <h2
              id="network-device-title"
              className="min-w-0 truncate text-lg font-semibold text-[var(--ink)]"
            >
              {device.name}
            </h2>
            <button
              ref={close}
              type="button"
              onClick={onClose}
              aria-label={t("agentNetwork.close")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 overflow-y-auto px-6 py-5">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 rounded-lg bg-[var(--paper-inset)] p-4 text-xs">
              {details.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-[var(--ink-muted)]">{label}</dt>
                  <dd
                    className="min-w-0 break-words text-[var(--ink)]"
                    title={value}
                  >
                    {value || "—"}
                  </dd>
                </div>
              ))}
            </dl>
            {!device.joined && (
              <div className="mt-4 flex items-center justify-end">
                <button
                  type="button"
                  onClick={onJoin}
                  disabled={membershipBusy}
                  aria-busy={membershipBusy}
                  className="rounded-md bg-[var(--button-primary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-60"
                >
                  {t("agentNetwork.join")}
                </button>
              </div>
            )}
            {membershipError && (
              <p role="alert" className="mt-3 text-xs text-[var(--error)]">
                {membershipError}
              </p>
            )}
            <h3 className="mb-1 mt-6 text-sm font-semibold text-[var(--ink-muted)]">
              {t("agentNetwork.agents")}
            </h3>
            {loading && agents.length === 0 ? (
              <div aria-busy="true" className="space-y-4 py-4">
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="h-10 animate-pulse rounded-md bg-[var(--paper-inset)]"
                  />
                ))}
              </div>
            ) : (
              <ul className="divide-y divide-[var(--line)]">
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.mountId}
                    agent={agent}
                    device={device}
                    onChanged={changed}
                  />
                ))}
              </ul>
            )}
            {!loading && error && (
              <p role="alert" className="py-4 text-sm text-[var(--error)]">
                {error}{" "}
                <button
                  type="button"
                  onClick={() => setRefresh((value) => value + 1)}
                  className="underline"
                >
                  {t("agentNetwork.retry")}
                </button>
              </p>
            )}
            {!loading && !error && agents.length === 0 && (
              <p className="py-5 text-sm text-[var(--ink-muted)]">
                {t(
                  device.catalogSyncedAt === null
                    ? "agentNetwork.unsynced"
                    : "agentNetwork.noAgents",
                )}
              </p>
            )}
            {!complete && (
              <p className="py-3 text-xs text-[var(--ink-muted)]">
                {t("agentNetwork.partial")}
              </p>
            )}
          </div>
        </section>
      </FloatingFocusManager>
    </OverlayBackdrop>
  );
}
