import { useEffect, useRef, useState } from "react";
import { FloatingFocusManager, useFloating } from "@floating-ui/react";
import { useTranslation } from "react-i18next";
import { deviceDisplayNameSchema } from "@myagents/agent-network-protocol";
import { CloseIcon, LoaderIcon } from "@/components/icons";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { isImeComposingEvent } from "@/utils/imeKeyboard";

export function DeviceRenameDialog({
  currentName,
  onConfirm,
  onCancel,
}: {
  currentName: string;
  onConfirm: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("app");
  const { t: common } = useTranslation("common");
  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const { refs, context } = useFloating({ open: true });
  const normalized = name.trim();
  const valid = deviceDisplayNameSchema.safeParse(normalized).success;
  const canSave = valid && normalized !== currentName && !saving;
  useEffect(() => {
    input.current?.select();
  }, []);
  useCloseLayer(() => {
    if (!submitting.current) onCancel();
    return true;
  }, 260);
  async function submit() {
    if (!canSave || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(normalized);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : t("agentNetwork.errors.failed"),
      );
      setSaving(false);
    } finally {
      submitting.current = false;
    }
  }
  return (
    <OverlayBackdrop
      portal
      className="z-[260] px-4"
      onClose={saving ? undefined : onCancel}
    >
      <FloatingFocusManager context={context} initialFocus={input}>
        <section
          ref={refs.setFloating}
          role="dialog"
          aria-modal="true"
          aria-labelledby="device-rename-title"
          className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl"
          onKeyDown={(event) => {
            if (isImeComposingEvent(event)) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (!submitting.current) onCancel();
            }
          }}
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2
              id="device-rename-title"
              className="text-lg font-semibold text-[var(--ink)]"
            >
              {t("agentNetwork.renameDevice")}
            </h2>
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              aria-label={common("actions.close")}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:opacity-50"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
          <label
            htmlFor="device-rename-input"
            className="mb-2 block text-sm font-medium text-[var(--ink)]"
          >
            {t("agentNetwork.deviceName")}
          </label>
          <input
            ref={input}
            id="device-rename-input"
            type="text"
            maxLength={160}
            value={name}
            disabled={saving}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (isImeComposingEvent(event)) return;
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            aria-invalid={Boolean(error) || (normalized.length > 0 && !valid)}
            aria-describedby="device-rename-hint"
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 disabled:opacity-60"
          />
          <p
            id="device-rename-hint"
            className="mt-2 text-xs text-[var(--ink-muted)]"
          >
            {t("agentNetwork.renameHint")}
          </p>
          {error && (
            <p role="alert" className="mt-2 text-xs text-[var(--error)]">
              <span className="block break-words">
                {t("agentNetwork.currentDeviceName", { name: currentName })}
              </span>
              <span className="mt-1 block">{error}</span>
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:opacity-50"
            >
              {common("actions.cancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                void submit();
              }}
              disabled={!canSave}
              aria-busy={saving}
              className="action-button inline-flex min-w-20 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {saving && (
                <LoaderIcon className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {common("actions.save")}
            </button>
          </div>
        </section>
      </FloatingFocusManager>
    </OverlayBackdrop>
  );
}
