import type { ReactNode } from "react";

import { CloseIcon } from "@/components/icons";
import OverlayBackdrop from "@/components/OverlayBackdrop";

/**
 * Right-side resource drawer shared by Space resource details (Skills, Tools),
 * so both open, dismiss and layer the same way. Content owns its own scroller.
 */
export function SpaceDetailDrawer({
  onClose,
  closeLabel,
  closeDisabled = false,
  widthClassName,
  children,
}: {
  onClose: () => void;
  closeLabel: string;
  closeDisabled?: boolean;
  widthClassName: string;
  children: ReactNode;
}) {
  return (
    <OverlayBackdrop
      portal
      onClose={closeDisabled ? undefined : onClose}
      className="z-[230] items-stretch justify-end bg-black/20 backdrop-blur-sm"
    >
      <aside
        className={`relative h-full border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl ${widthClassName}`}
      >
        <header className="absolute right-4 top-4 z-10 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={closeLabel}
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>
        {children}
      </aside>
    </OverlayBackdrop>
  );
}
