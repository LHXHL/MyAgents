import { useRef, useState } from "react";
import { FloatingFocusManager, useFloating } from "@floating-ui/react";
import { useTranslation } from "react-i18next";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { CloseIcon, LoaderIcon } from "@/components/icons";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
export function JoinNetworkDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (url: string, key: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("app"),
    { t: common } = useTranslation("common");
  const [url, setUrl] = useState(""),
    [key, setKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null),
    flight = useRef(false);
  const { refs, context } = useFloating({ open: true });
  const close = () => {
    if (!flight.current) {
      setKey("");
      onCancel();
    }
  };
  useCloseLayer(() => {
    close();
    return true;
  }, 260);
  async function submit() {
    if (flight.current || !url.trim() || !key.trim()) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(url.trim(), key.trim());
      setKey("");
      onCancel();
    } catch (failure) {
      setKey("");
      setError(
        failure instanceof Error
          ? failure.message
          : t("agentNetwork.errors.failed"),
      );
      setBusy(false);
    } finally {
      flight.current = false;
    }
  }
  return (
    <OverlayBackdrop
      portal
      className="z-[260] px-4"
      onClose={busy ? undefined : close}
    >
      <FloatingFocusManager context={context} initialFocus={input}>
        <section
          ref={refs.setFloating}
          role="dialog"
          aria-modal="true"
          aria-labelledby="join-network-title"
          className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !isImeComposingEvent(e)) {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id="join-network-title" className="text-lg font-semibold">
              {t("agentNetwork.joinSelfhost")}
            </h2>
            <button
              type="button"
              onClick={close}
              disabled={busy}
              aria-label={common("actions.close")}
              className="rounded-lg p-2 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label
              htmlFor="network-url"
              className="mb-2 block text-sm font-medium"
            >
              {t("agentNetwork.serviceUrl")}
            </label>
            <input
              ref={input}
              id="network-url"
              type="url"
              autoComplete="off"
              placeholder="https://your-network.workers.dev"
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              className="mb-4 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
            <label
              htmlFor="network-key"
              className="mb-2 block text-sm font-medium"
            >
              {t("agentNetwork.deviceKey")}
            </label>
            <input
              id="network-key"
              type="password"
              autoComplete="off"
              maxLength={256}
              value={key}
              disabled={busy}
              onChange={(e) => setKey(e.target.value)}
              className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
            <p className="mt-3 text-xs leading-relaxed text-[var(--ink-muted)]">
              {t("agentNetwork.selfhostHint")}
            </p>
            {error && (
              <p role="alert" className="mt-3 text-sm text-[var(--error)]">
                {error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="rounded-lg px-4 py-2 text-sm hover:bg-[var(--paper-inset)]"
              >
                {common("actions.cancel")}
              </button>
              <button
                type="submit"
                disabled={busy || !url.trim() || !key.trim()}
                className="flex items-center gap-2 rounded-lg bg-[var(--ink)] px-4 py-2 text-sm text-[var(--paper)] disabled:opacity-50"
              >
                {busy && <LoaderIcon className="h-4 w-4 animate-spin" />}
                {t(busy ? "agentNetwork.joiningSelfhost" : "agentNetwork.join")}
              </button>
            </div>
          </form>
        </section>
      </FloatingFocusManager>
    </OverlayBackdrop>
  );
}
