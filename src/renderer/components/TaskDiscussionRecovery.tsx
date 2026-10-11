import { copyPlainText } from "@/utils/clipboard";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import ConfirmDialog from "@/components/ConfirmDialog";
import type { Message } from "@/types/chat";
import type { TaskDiscussionInput } from "../../shared/taskDiscussion";
import { desktopContextOf } from "../../shared/agentMentions";

/** Original input is an artifact, never an accepted transcript or an auto-replay. */
export default function TaskDiscussionRecovery({
  discussionId,
  messages,
  active,
  onRestore,
  onRetryStartup,
}: {
  discussionId: string;
  messages: readonly Message[];
  active: boolean;
  onRestore: (input: TaskDiscussionInput) => void;
  onRetryStartup?: () => Promise<void | undefined>;
}) {
  const { t } = useTranslation("chat");
  const [result, setResult] = useState<{
    id: string;
    input?: TaskDiscussionInput;
    error?: string;
  }>();
  const [revision, setRevision] = useState(0);
  const [confirmRestore, setConfirmRestore] = useState<string>();
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    let disposed = false;
    void invoke<TaskDiscussionInput | null>("cmd_task_read_discussion_input", {
      discussionId,
    })
      .then((input) => {
        if (!disposed)
          setResult({ id: discussionId, ...(input ? { input } : {}) });
      })
      .catch((error) => {
        if (!disposed) setResult({ id: discussionId, error: String(error) });
      });
    return () => {
      disposed = true;
    };
  }, [discussionId, revision]);
  const input = result?.id === discussionId ? result.input : undefined;
  const committed =
    input &&
    messages.some((message) => {
      if (
        message.role !== "user" ||
        message.deliveryStatus !== undefined ||
        message.content === ""
      )
        return false;
      const context = desktopContextOf(message.desktopQuery?.primaryContext);
      return (
        message.metadata?.clientRequestId === input.clientRequestId ||
        (context?.kind === "task-discussion" &&
          context.input.candidatesDir ===
            input.primaryContext.input.candidatesDir)
      );
    });
  if (!active || committed || result?.id !== discussionId) return null;
  return (
    <div className="mx-4 my-2 rounded-lg border border-[var(--line)] bg-[var(--paper-subtle)] p-3 text-sm">
      <p>
        {input
          ? t("discussionRecovery.saved")
          : result.error
            ? t("discussionRecovery.readFailed")
            : t("discussionRecovery.unavailable")}
      </p>
      {result.error && (
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          {t("discussionRecovery.reload")}
        </button>
      )}
      {input && (
        <>
          <p className="mt-1 text-[var(--ink-secondary)]">
            {t("discussionRecovery.unconfirmed")}
          </p>
          <details className="mt-2">
            <summary>{t("discussionRecovery.view")}</summary>
            <textarea
              aria-label={t("discussionRecovery.view")}
              readOnly
              value={input.text}
              className="mt-2 max-h-64 w-full rounded border border-[var(--line)] bg-[var(--paper)] p-2"
              rows={6}
            />
          </details>
          <div className="mt-2 flex gap-4 [&>button]:min-h-8 [&>button]:px-2 [&>button]:text-[var(--accent)]">
            <button
              type="button"
              onClick={() => {
                void copyPlainText(input.text)
                  .then(() => setCopied(discussionId))
                  .catch(() => setCopied(undefined));
              }}
            >
              {t(
                copied === discussionId
                  ? "discussionRecovery.copied"
                  : "discussionRecovery.copy",
              )}
            </button>
            {onRetryStartup && (
              <button
                type="button"
                onClick={() => {
                  void onRetryStartup();
                }}
              >
                {t("discussionRecovery.retryStartup")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirmRestore(discussionId)}
            >
              {t("discussionRecovery.restore")}
            </button>
          </div>
          {confirmRestore === discussionId && (
            <ConfirmDialog
              title={t("discussionRecovery.restore")}
              message={t("discussionRecovery.confirm")}
              confirmText={t("discussionRecovery.restore")}
              disableEnterShortcut
              onCancel={() => setConfirmRestore(undefined)}
              onConfirm={() => {
                setConfirmRestore(undefined);
                onRestore(input);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
