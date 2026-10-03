import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Tip from "@/components/Tip";
import { LoaderIcon } from '@/components/icons';
import {
  metadataSchemas,
  NETWORK_BUDGETS,
} from "@myagents/agent-network-protocol";
import {
  networkErrorKey,
  networkRequest,
  type NetworkAgent,
  type NetworkDevice,
} from "@/api/agentNetwork";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import {
  clearDescriptionDraft,
  currentNetworkGeneration,
  descriptionDraftKey,
  getDescriptionDraft,
  setDescriptionDraft,
} from "./store";

export function AgentRow({
  agent,
  device,
  onChanged,
}: {
  agent: NetworkAgent;
  device: NetworkDevice;
  onChanged: () => void;
}) {
  const { t } = useTranslation("app");
  const key = descriptionDraftKey(
    agent.principalId,
    agent.networkId,
    agent.mountId,
  );
  const [description, setDescription] = useState(
    () => getDescriptionDraft(key) ?? agent.description ?? "",
  );
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const inFlight = useRef(false),
    switchFlight = useRef(false),
    escaped = useRef(false);
  const descriptionRef = useRef(description);
  descriptionRef.current = description;
  useEffect(() => {
    if (getDescriptionDraft(key) === undefined)
      setDescription(agent.description ?? "");
  }, [agent.description, key]);
  async function saveDescription() {
    if (escaped.current) {
      escaped.current = false;
      return;
    }
    if (inFlight.current) return;
    const value = descriptionRef.current.trim() || null;
    if (value === agent.description) {
      clearDescriptionDraft(key);
      setEditing(false);
      return;
    }
    setDescriptionDraft(key, descriptionRef.current);
    if (
      new TextEncoder().encode(value ?? "").length >
      NETWORK_BUDGETS.descriptionBytes
    ) {
      setError(t("agentNetwork.errors.descriptionTooLong"));
      return;
    }
    const generation = currentNetworkGeneration();
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      metadataSchemas.mount.parse(
        await networkRequest({
          kind: "description",
          networkId: agent.networkId,
          mountId: agent.mountId,
          description: value,
          expectedDescriptionRevision: agent.descriptionRevision,
          expectedMembershipRevision: device.membershipRevision,
          mutationId: crypto.randomUUID(),
        }),
      );
      if (generation !== currentNetworkGeneration()) return;
      clearDescriptionDraft(key);
      setEditing(false);
      onChanged();
    } catch (failure) {
      if (generation !== currentNetworkGeneration()) return;
      setError(
        t(`agentNetwork.errors.${networkErrorKey(failure, "mutation")}`),
      );
      onChanged();
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  async function toggle() {
    if (switchFlight.current || !device.joined) return;
    const generation = currentNetworkGeneration();
    switchFlight.current = true;
    setSwitchBusy(true);
    setSwitchError(null);
    try {
      metadataSchemas.mount.parse(
        await networkRequest({
          kind: "enabled",
          networkId: agent.networkId,
          mountId: agent.mountId,
          enabled: !agent.enabled,
          expectedEnableRevision: agent.enableRevision,
          expectedMembershipRevision: device.membershipRevision,
          mutationId: crypto.randomUUID(),
        }),
      );
      if (generation === currentNetworkGeneration()) onChanged();
    } catch (failure) {
      if (generation === currentNetworkGeneration()) {
        setSwitchError(
          t(`agentNetwork.errors.${networkErrorKey(failure, "mutation")}`),
        );
        onChanged();
      }
    } finally {
      switchFlight.current = false;
      setSwitchBusy(false);
    }
  }
  return (
    <li className="flex items-start gap-4 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-[var(--ink)]">
            {agent.name}
          </span>
          <span
            className="min-w-0 truncate text-xs text-[var(--ink-muted)]"
            title={agent.path}
          >
            {agent.path}
          </span>
        </div>
        <div className="mt-1 min-h-6 text-xs text-[var(--ink-muted)]">
          {editing ? (
            <input
              autoFocus
              disabled={saving}
              value={description}
              aria-label={t("agentNetwork.descriptionFor", {
                name: agent.name,
              })}
              className="h-7 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              placeholder={t("agentNetwork.descriptionPlaceholder")}
              onChange={(event) => {
                setDescription(event.target.value);
                setDescriptionDraft(key, event.target.value);
              }}
              onBlur={() => {
                void saveDescription();
              }}
              onKeyDown={(event) => {
                if (isImeComposingEvent(event)) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  void saveDescription();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  escaped.current = true;
                  clearDescriptionDraft(key);
                  setDescription(agent.description ?? "");
                  setError(null);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="max-w-full truncate text-left hover:text-[var(--ink)]"
              onClick={() => {
                escaped.current = false;
                setEditing(true);
              }}
            >
              {description || t("agentNetwork.descriptionPlaceholder")}
            </button>
          )}
          {saving && (
            <span className="ml-2" role="status">
              {t("agentNetwork.saving")}
            </span>
          )}
          {error && (
            <p className="mt-1 text-[var(--error)]" role="alert">
              {error}{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  void saveDescription();
                }}
              >
                {t("agentNetwork.retry")}
              </button>
            </p>
          )}
          {switchError && (
            <p className="mt-1 text-[var(--error)]" role="alert">
              {switchError}
            </p>
          )}
        </div>
      </div>
      <Tip
        label={t("agentNetwork.joinToEnable")}
        disabled={device.joined}
        className="mt-1 shrink-0"
      >
        <button
          type="button"
          role="switch"
          aria-checked={agent.enabled}
          aria-label={t("agentNetwork.enableAgent", { name: agent.name })}
          aria-busy={switchBusy}
          disabled={!device.joined || switchBusy}
          onClick={() => {
            void toggle();
          }}
          className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${agent.enabled ? "bg-[var(--accent)]" : "bg-[var(--line)]"}`}
        >
          {switchBusy ? (
            <LoaderIcon className="mx-auto h-3.5 w-3.5 animate-spin text-[var(--ink-muted)]" />
          ) : (
            <span
              className={`h-4 w-4 rounded-full bg-[var(--paper-elevated)] shadow-sm transition-transform ${agent.enabled ? "translate-x-4" : ""}`}
            />
          )}
        </button>
      </Tip>
    </li>
  );
}
