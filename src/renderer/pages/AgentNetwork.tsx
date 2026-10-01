import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, Laptop, Monitor, Server } from "lucide-react";
import { metadataSchemas } from "@myagents/agent-network-protocol";
import {
  spaceGetSession,
  spaceLogout,
  type SpaceSessionView,
} from "@/api/spaceCloud";
import {
  allNetworkDevices,
  networkErrorKey,
  networkRequest,
  type NetworkDevice,
  type NetworkInfo,
  type NetworkSnapshot,
} from "@/api/agentNetwork";
import { useMyAgentsLogin } from "@/hooks/useMyAgentsLogin";
import { SpaceLogin } from "@/pages/space/SpaceChrome";
import Popover from "@/components/ui/Popover";
import ConfirmDialog from "@/components/ConfirmDialog";
import { getDeviceId, preloadDeviceId } from "@/identity/deviceIdentity";
import { DeviceDetails } from "@/features/agent-network/DeviceDetails";
import {
  currentNetworkGeneration,
  useAgentNetworkSnapshot,
} from "@/features/agent-network/store";

function osName(platform: string): string {
  if (/darwin|macos/i.test(platform)) return "macOS";
  if (/win/i.test(platform)) return "Windows";
  if (/linux/i.test(platform)) return "Linux";
  return platform || "—";
}
function DeviceCard({
  device,
  isLocal,
  busy,
  error,
  onOpen,
  onMembership,
}: {
  device: NetworkDevice;
  isLocal: boolean;
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onMembership: () => void;
}) {
  const { t } = useTranslation("app");
  const OsIcon = /darwin|macos/i.test(device.platform)
    ? Laptop
    : /win/i.test(device.platform)
      ? Monitor
      : Server;
  return (
    <article className="relative rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-5 transition-shadow hover:shadow-sm">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("agentNetwork.openDevice", { name: device.name })}
        className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      />
      <div className="pointer-events-none relative pr-16">
        <div className="flex items-center gap-2 text-xs text-[var(--ink-muted)]">
          <OsIcon className="h-4 w-4 shrink-0" />
          <span>{osName(device.platform)}</span>
          <span aria-hidden>·</span>
          <span>
            {t(
              device.connectionState === "offline"
                ? "agentNetwork.offline"
                : device.connectionState === "ready"
                  ? "agentNetwork.online"
                  : "agentNetwork.syncing",
            )}
          </span>
        </div>
        <div className="mt-3 flex min-w-0 items-center gap-2">
          <h2
            className="min-w-0 truncate text-base font-medium text-[var(--ink)]"
            title={device.name}
          >
            {device.name}
          </h2>
          {isLocal && (
            <span className="shrink-0 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
              {t("agentNetwork.local")}
            </span>
          )}
        </div>
        <p
          className={`mt-6 flex items-center gap-2 text-sm ${device.onlineAgentCount && device.onlineAgentCount > 0 ? "text-[var(--success)]" : "text-[var(--ink-muted)]"}`}
        >
          {device.onlineAgentCount !== null && (
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
          )}
          {device.onlineAgentCount === null
            ? t("agentNetwork.unsyncedShort")
            : t("agentNetwork.onlineAgents", {
                count: device.onlineAgentCount,
              })}
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onMembership}
        aria-busy={busy}
        className={`absolute right-4 top-4 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-60 ${
          device.joined
            ? "bg-[var(--button-secondary-bg)] text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]"
            : "bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
        }`}
      >
        {t(
          busy
            ? "agentNetwork.saving"
            : device.joined
              ? "agentNetwork.leave"
              : "agentNetwork.join",
        )}
      </button>
      {error && (
        <p
          role="alert"
          className="pointer-events-none relative mt-3 text-xs text-[var(--error)]"
        >
          {error}
        </p>
      )}
    </article>
  );
}
export default function AgentNetwork({
  isActive = true,
}: {
  isActive?: boolean;
}) {
  const snapshot = useAgentNetworkSnapshot();
  // An account boundary creates a fresh UI scope immediately, including dialogs
  // and mutations; old completions only hold the discarded component instance.
  return (
    <AgentNetworkContent
      key={snapshot.authGeneration}
      isActive={isActive}
      snapshot={snapshot}
    />
  );
}
function AgentNetworkContent({
  isActive,
  snapshot,
}: {
  isActive: boolean;
  snapshot: NetworkSnapshot;
}) {
  const { t } = useTranslation("app");
  const [session, setSession] = useState<SpaceSessionView | null>(null),
    [authLoading, setAuthLoading] = useState(true);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [devices, setDevices] = useState<NetworkDevice[]>([]),
    [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null),
    [complete, setComplete] = useState(true);
  const [refresh, setRefresh] = useState(0),
    [selected, setSelected] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<NetworkDevice | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({}),
    [errors, setErrors] = useState<Record<string, string>>({});
  const flight = useRef(new Set<string>());
  const reloadAccount = useCallback(async () => {
    const generation = currentNetworkGeneration();
    setAuthLoading(true);
    setAccountError(null);
    try {
      const result = await spaceGetSession();
      if (generation !== currentNetworkGeneration()) return;
      setSession(result);
      await preloadDeviceId();
    } catch (failure) {
      if (generation === currentNetworkGeneration())
        setAccountError(t(`agentNetwork.errors.${networkErrorKey(failure)}`));
    } finally {
      if (generation === currentNetworkGeneration()) setAuthLoading(false);
    }
  }, [t]);
  const { authBusy, authFlow, startLogin } = useMyAgentsLogin(
    isActive,
    reloadAccount,
  );
  useEffect(() => {
    void reloadAccount();
  }, [reloadAccount, snapshot.authGeneration]);
  useEffect(() => {
    if (
      !isActive ||
      snapshot.state !== "ready" ||
      session?.state !== "authenticated"
    )
      return;
    let cancelled = false;
    const generation = currentNetworkGeneration();
    setLoading(true);
    setLoadError(null);
    void Promise.all([networkRequest({ kind: "network" }), allNetworkDevices()])
      .then(([info, page]) => {
        if (cancelled || generation !== currentNetworkGeneration()) return;
        setNetwork(metadataSchemas.network.parse(info));
        const localId = getDeviceId();
        setDevices(
          page.items.sort(
            (a, b) =>
              Number(b.deviceId === localId) - Number(a.deviceId === localId) ||
              a.name.localeCompare(b.name) ||
              a.deviceId.localeCompare(b.deviceId),
          ),
        );
        setComplete(page.complete);
      })
      .catch((failure) => {
        if (!cancelled && generation === currentNetworkGeneration())
          setLoadError(t(`agentNetwork.errors.${networkErrorKey(failure)}`));
      })
      .finally(() => {
        if (!cancelled && generation === currentNetworkGeneration())
          setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isActive, snapshot.state, snapshot.revision, session?.state, refresh, t]);
  async function membership(device: NetworkDevice, joined: boolean) {
    if (flight.current.has(device.deviceId)) return;
    flight.current.add(device.deviceId);
    setBusy((current) => ({ ...current, [device.deviceId]: true }));
    setErrors((current) => ({ ...current, [device.deviceId]: "" }));
    const generation = currentNetworkGeneration();
    try {
      metadataSchemas.membership.parse(
        await networkRequest({
          kind: "membership",
          networkId: device.networkId,
          deviceId: device.deviceId,
          joined,
          expectedMembershipRevision: device.membershipRevision,
          mutationId: crypto.randomUUID(),
        }),
      );
      if (generation !== currentNetworkGeneration()) return;
      setLeaving(null);
      setRefresh((value) => value + 1);
      if (joined) setSelected(device.deviceId);
    } catch (failure) {
      if (generation !== currentNetworkGeneration()) return;
      setLeaving(null);
      setErrors((current) => ({
        ...current,
        [device.deviceId]: t(
          `agentNetwork.errors.${networkErrorKey(failure, "mutation")}`,
        ),
      }));
      setRefresh((value) => value + 1);
    } finally {
      flight.current.delete(device.deviceId);
      setBusy((current) => ({ ...current, [device.deviceId]: false }));
    }
  }
  const infoButton = useRef<HTMLButtonElement>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  if (authLoading)
    return (
      <div
        className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]"
        aria-busy="true"
      >
        {t("agentNetwork.loading")}
      </div>
    );
  if (accountError)
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]">
        <p role="alert">
          {accountError}{" "}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => {
              void reloadAccount();
            }}
          >
            {t("agentNetwork.retry")}
          </button>
        </p>
      </div>
    );
  if (!session || session.state === "reauth_required") {
    const accountName =
      session?.state === "reauth_required"
        ? (session.account.user.name ?? session.account.user.email)
        : null;
    return (
      <SpaceLogin
        authBusy={authBusy}
        authFlow={authFlow}
        onLogin={() => {
          void startLogin();
        }}
        reauthRequired={session?.state === "reauth_required"}
        accountName={accountName}
        onForgetAccount={() => {
          void spaceLogout().then(reloadAccount);
        }}
      />
    );
  }
  const selectedDevice = devices.find((device) => device.deviceId === selected);
  return (
    <main className="h-full overflow-y-auto bg-[var(--paper)] text-[var(--ink)]">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <header className="mb-8 flex items-center gap-2">
          <h1 className="text-xl font-semibold">
            {network?.name || t("agentNetwork.networkName")}
          </h1>
          <div>
            <button
              type="button"
              ref={infoButton}
              aria-label={t("agentNetwork.networkInfo")}
              aria-expanded={infoOpen}
              aria-controls="agent-network-explanation"
              onClick={() => setInfoOpen((value) => !value)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
            >
              <Info className="h-4 w-4" />
            </button>
            <Popover
              open={infoOpen}
              onClose={() => setInfoOpen(false)}
              anchorRef={infoButton}
              className="max-w-sm px-4 py-3 text-xs leading-relaxed text-[var(--ink-muted)]"
            >
              <p id="agent-network-explanation">
                {t("agentNetwork.encryptionHint")}
              </p>
            </Popover>
          </div>
        </header>
        {(loadError || accountError) && (
          <p role="alert" className="mb-4 text-sm text-[var(--error)]">
            {loadError || accountError}{" "}
            <button
              type="button"
              className="underline"
              onClick={() => {
                setRefresh((value) => value + 1);
                if (accountError) void reloadAccount();
              }}
            >
              {t("agentNetwork.retry")}
            </button>
          </p>
        )}
        {snapshot.state !== "ready" && (
          <p role="status" className="mb-4 text-sm text-[var(--ink-muted)]">
            {t(
              snapshot.state === "connecting"
                ? "agentNetwork.connecting"
                : snapshot.state === "disconnected"
                  ? "agentNetwork.reconnecting"
                  : `agentNetwork.errors.${networkErrorKey(snapshot.error)}`,
            )}
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {loading && devices.length === 0 && snapshot.state === "ready"
            ? [0, 1].map((index) => (
                <div
                  key={index}
                  aria-busy="true"
                  className="h-40 animate-pulse rounded-lg bg-[var(--paper-inset)]"
                />
              ))
            : devices.map((device) => (
                <DeviceCard
                  key={device.deviceId}
                  device={device}
                  isLocal={device.deviceId === getDeviceId()}
                  busy={busy[device.deviceId] ?? false}
                  error={errors[device.deviceId] || null}
                  onOpen={() => setSelected(device.deviceId)}
                  onMembership={() => {
                    if (device.joined) setLeaving(device);
                    else void membership(device, true);
                  }}
                />
              ))}
        </div>
        {!loading &&
          !loadError &&
          snapshot.state === "ready" &&
          devices.length === 0 && (
            <p className="py-8 text-sm text-[var(--ink-muted)]">
              {t("agentNetwork.noDevices")}
            </p>
          )}
        {!complete && (
          <p className="mt-4 text-xs text-[var(--ink-muted)]">
            {t("agentNetwork.partial")}
          </p>
        )}
      </div>
      {selectedDevice && (
        <DeviceDetails
          device={selectedDevice}
          isLocal={selectedDevice.deviceId === getDeviceId()}
          membershipBusy={busy[selectedDevice.deviceId] ?? false}
          membershipError={errors[selectedDevice.deviceId] || null}
          onJoin={() => {
            void membership(selectedDevice, true);
          }}
          onClose={() => setSelected(null)}
          onChanged={() => setRefresh((value) => value + 1)}
        />
      )}
      {leaving && (
        <ConfirmDialog
          title={t("agentNetwork.leaveTitle")}
          message={t("agentNetwork.leaveMessage")}
          confirmText={t("agentNetwork.leaveConfirm")}
          confirmVariant="danger"
          loading={busy[leaving.deviceId]}
          onCancel={() => setLeaving(null)}
          onConfirm={() => {
            void membership(leaving, false);
          }}
        />
      )}
    </main>
  );
}
