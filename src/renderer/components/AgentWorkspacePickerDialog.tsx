import { FloatingFocusManager, useFloating } from "@floating-ui/react";
import { useId } from "react";
import { CloseIcon } from "@/components/icons";
import { useTranslation } from "react-i18next";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { WorkspaceRow } from "@/components/launcher/WorkspaceSelector";
import type { Project } from "@/config/types";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { isImeComposingEvent } from "@/utils/imeKeyboard";

interface AgentWorkspacePickerDialogProps {
  projects: readonly Project[];
  title: string;
  description: string;
  emptyLabel: string;
  onSelect: (project: Project) => void;
  onClose: () => void;
}

export default function AgentWorkspacePickerDialog({
  projects,
  title,
  description,
  emptyLabel,
  onSelect,
  onClose,
}: AgentWorkspacePickerDialogProps) {
  const { t } = useTranslation("common");
  const titleId = useId();
  const descriptionId = useId();
  const { refs, context } = useFloating({ open: true });
  useCloseLayer(() => {
    onClose();
    return true;
  }, 210);

  return (
    <OverlayBackdrop portal onClose={onClose} className="z-[210]">
      <FloatingFocusManager context={context}>
        <div
          ref={node => { refs.setFloating(node); }}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onKeyDown={(event) => {
            if (isImeComposingEvent(event)) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          className="w-[min(92vw,26rem)] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper)] shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
            <div>
              <h3
                id={titleId}
                className="text-sm font-semibold text-[var(--ink)]"
              >
                {title}
              </h3>
              <p
                id={descriptionId}
                className="mt-0.5 text-xs text-[var(--ink-muted)]"
              >
                {description}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("actions.cancel")}
              className="rounded-lg p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto py-1">
            {projects.map((project) => (
              <WorkspaceRow
                key={project.id}
                project={project}
                isDefault={false}
                isSelected={false}
                showDefaultBadge={false}
                onSelect={onSelect}
              />
            ))}
            {projects.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                {emptyLabel}
              </p>
            )}
          </div>
        </div>
      </FloatingFocusManager>
    </OverlayBackdrop>
  );
}
