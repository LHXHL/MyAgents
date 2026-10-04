import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckIcon, InfoIcon, LockIcon } from "@/components/icons";
import { metadataSchemas } from "@myagents/agent-network-protocol";
import {
  spaceGetSession,
  spaceLogout,
  type SpaceSessionView,
} from "@/api/spaceCloud";
import {
  allDeviceAgents,
  allNetworkDevices,
  networkErrorKey,
  networkRequest,
  type NetworkDevice,
  type NetworkSnapshot,
} from "@/api/agentNetwork";
import { useMyAgentsLogin } from "@/hooks/useMyAgentsLogin";
import { SpaceLogin } from "@/pages/space/SpaceChrome";
import Popover from "@/components/ui/Popover";
import ConfirmDialog from "@/components/ConfirmDialog";
import { getDeviceId, preloadDeviceId } from "@/identity/deviceIdentity";
import { useToastOptional } from "@/components/Toast";
import { copyPlainText } from "@/utils/clipboard";
import { DeviceCard } from "@/features/agent-network/DeviceCard";
import { DeviceDetails } from "@/features/agent-network/DeviceDetails";
import type { DeviceCatalog } from "@/features/agent-network/deviceDisplay";
import {
  currentNetworkGeneration,
  useAgentNetworkSnapshot,
} from "@/features/agent-network/store";

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
  const [devices, setDevices] = useState<NetworkDevice[]>([]),
    [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null),
    [complete, setComplete] = useState(true);
  const [refresh, setRefresh] = useState(0),
    [selected, setSelected] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<NetworkDevice | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({}),
    [errors, setErrors] = useState<Record<string, string>>({});
  const [catalogs, setCatalogs] = useState<Record<string, DeviceCatalog>>({});
  const flight = useRef(new Set<string>());
  const toast = useToastOptional();
  // Never throws: one device's unreadable catalog must not hide the others.
  const readCatalog = useCallback(
    async (deviceId: string): Promise<DeviceCatalog> => {
      try {
        const page = await allDeviceAgents(deviceId);
        return { status: "ready", items: page.items, complete: page.complete };
      } catch (failure) {
        return {
          status: "error",
          error: t(`agentNetwork.errors.${networkErrorKey(failure)}`),
        };
      }
    },
    [t],
  );
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
    const current = () =>
      !cancelled && generation === currentNetworkGeneration();
    setLoading(true);
    setLoadError(null);
    void Promise.all([networkRequest({ kind: "network" }), allNetworkDevices()])
      .then(async ([info, page]) => {
        if (!current()) return;
        metadataSchemas.network.parse(info);
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
        setLoading(false);
        // Cards show which Agents each device opens, so catalogs are read with
        // the device list; the previous catalogs stay visible until replaced.
        const entries = await Promise.all(
          page.items.map(
            async (device) =>
              [device.deviceId, await readCatalog(device.deviceId)] as const,
          ),
        );
        if (current()) setCatalogs(Object.fromEntries(entries));
      })
      .catch((failure) => {
        if (!current()) return;
        setLoadError(t(`agentNetwork.errors.${networkErrorKey(failure)}`));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isActive,
    snapshot.state,
    snapshot.revision,
    session?.state,
    refresh,
    readCatalog,
    t,
  ]);
  async function retryCatalog(deviceId: string) {
    const generation = currentNetworkGeneration();
    setCatalogs((current) => {
      const next = { ...current };
      delete next[deviceId];
      return next;
    });
    const catalog = await readCatalog(deviceId);
    if (generation === currentNetworkGeneration())
      setCatalogs((current) => ({ ...current, [deviceId]: catalog }));
  }
  async function copyDeviceId(device: NetworkDevice) {
    try {
      await copyPlainText(device.deviceId);
      toast?.success(t("agentNetwork.copied"));
    } catch {
      toast?.error(t("agentNetwork.copyFailed"));
    }
  }
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
      // Joining leads straight to choosing which workspaces to open.
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
  const localId = getDeviceId();
  const joinedDevices = devices.filter((device) => device.joined);
  const pendingDevices = devices.filter((device) => !device.joined);
  const joinedCatalogs = joinedDevices.map(
    (device) => catalogs[device.deviceId],
  );
  const catalogsKnown = joinedCatalogs.every(
    (catalog) => catalog?.status === "ready",
  );
  const openAgents = joinedCatalogs.reduce(
    (sum, catalog) =>
      sum +
      (catalog?.status === "ready"
        ? catalog.items.filter((agent) => agent.enabled).length
        : 0),
    0,
  );
  // The guide only states facts already read: it stays hidden while unknown.
  const setupStep =
    loading || loadError || snapshot.state !== "ready"
      ? null
      : !joinedDevices.some((device) => device.deviceId === localId)
        ? 1
        : catalogsKnown && openAgents === 0
          ? 2
          : null;
  const selectedDevice = devices.find((device) => device.deviceId === selected);
  const card = (device: NetworkDevice) => (
    <DeviceCard
      key={device.deviceId}
      device={device}
      catalog={catalogs[device.deviceId]}
      isLocal={device.deviceId === localId}
      busy={busy[device.deviceId] ?? false}
      error={errors[device.deviceId] || null}
      onOpen={() => setSelected(device.deviceId)}
      onJoin={() => {
        void membership(device, true);
      }}
      onLeave={() => setLeaving(device)}
      onCopyId={() => {
        void copyDeviceId(device);
      }}
    />
  );
  return (
    <main className="h-full overflow-y-auto bg-[var(--paper)] text-[var(--ink)]">
      <div className="mx-auto max-w-5xl px-8 pb-12 pt-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-semibold">
              {t("agentNetwork.networkName")}
            </h1>
            <button
              type="button"
              ref={infoButton}
              aria-label={t("agentNetwork.networkInfo")}
              aria-expanded={infoOpen}
              aria-controls="agent-network-explanation"
              onClick={() => setInfoOpen((value) => !value)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
              <InfoIcon className="h-4 w-4" />
            </button>
            <Popover
              open={infoOpen}
              onClose={() => setInfoOpen(false)}
              anchorRef={infoButton}
              className="max-w-xs space-y-1.5 px-4 py-3 text-xs leading-relaxed text-[var(--ink-secondary)]"
            >
              <div id="agent-network-explanation">
                <p>{t("agentNetwork.infoIntro")}</p>
                <p className="mt-1.5 flex items-center gap-1.5 font-medium text-[var(--ink)]">
                  <LockIcon className="h-3.5 w-3.5" />
                  {t("agentNetwork.infoTitle")}
                </p>
                <p className="mt-1.5">{t("agentNetwork.infoRelay")}</p>
                <p className="mt-1.5">{t("agentNetwork.infoLocal")}</p>
              </div>
            </Popover>
          </div>
          {devices.length > 0 && (
            <dl className="flex gap-6">
              <div>
                <dd className="text-xl font-semibold leading-tight">
                  {joinedDevices.length}
                </dd>
                <dt className="text-xs text-[var(--ink-muted)]">
                  {t("agentNetwork.statDevices")}
                </dt>
              </div>
              <div>
                <dd className="text-xl font-semibold leading-tight">
                  {catalogsKnown ? openAgents : "—"}
                </dd>
                <dt className="text-xs text-[var(--ink-muted)]">
                  {t("agentNetwork.statAgents")}
                </dt>
              </div>
            </dl>
          )}
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
        {setupStep !== null && <SetupGuide step={setupStep} />}
        {loading && devices.length === 0 && snapshot.state === "ready" ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {[0, 1].map((index) => (
              <div
                key={index}
                aria-busy="true"
                className="h-40 animate-pulse rounded-xl bg-[var(--paper-inset)]"
              />
            ))}
          </div>
        ) : (
          <>
            {joinedDevices.length > 0 && (
              <section className="mb-7">
                <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-[var(--ink-muted)]">
                  {t("agentNetwork.joinedDevices")}
                  <span className="font-normal text-[var(--ink-subtle)]">
                    {joinedDevices.length}
                  </span>
                </h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {joinedDevices.map(card)}
                </div>
              </section>
            )}
            {pendingDevices.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-[var(--ink-muted)]">
                  {t("agentNetwork.pendingDevices")}
                  <span className="font-normal text-[var(--ink-subtle)]">
                    {pendingDevices.length}
                  </span>
                </h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {pendingDevices.map(card)}
                </div>
              </section>
            )}
          </>
        )}
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
          catalog={catalogs[selectedDevice.deviceId]}
          isLocal={selectedDevice.deviceId === localId}
          membershipBusy={busy[selectedDevice.deviceId] ?? false}
          membershipError={errors[selectedDevice.deviceId] || null}
          onJoin={() => {
            void membership(selectedDevice, true);
          }}
          onLeave={() => setLeaving(selectedDevice)}
          onCopyId={() => {
            void copyDeviceId(selectedDevice);
          }}
          onRetry={() => {
            void retryCatalog(selectedDevice.deviceId);
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

/** First-use path from the product story: join, open workspaces, then just talk. */
function SetupGuide({ step }: { step: 1 | 2 }) {
  const { t } = useTranslation("app");
  return (
    <ol className="mb-7 grid grid-cols-1 overflow-hidden rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)] md:grid-cols-3">
      {([1, 2, 3] as const).map((index) => {
        const done = index < step;
        const current = index === step;
        return (
          <li
            key={index}
            aria-current={current ? "step" : undefined}
            className="flex gap-3 border-[var(--line-subtle)] px-[18px] py-4 [&:not(:first-child)]:border-t md:[&:not(:first-child)]:border-l md:[&:not(:first-child)]:border-t-0"
          >
            <span
              className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border text-xs ${
                done
                  ? "border-[var(--success)] bg-[var(--success)] text-[var(--on-success)]"
                  : current
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-[var(--line-strong)] text-[var(--ink-muted)]"
              }`}
            >
              {done ? <CheckIcon className="h-3 w-3" /> : index}
            </span>
            <div className="min-w-0">
              <p
                className={`text-sm font-semibold ${done ? "text-[var(--ink-muted)]" : "text-[var(--ink)]"}`}
              >
                {t(`agentNetwork.guide.step${index}Title`)}
              </p>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                {t(`agentNetwork.guide.step${index}Body`)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
