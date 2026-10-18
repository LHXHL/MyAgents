import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  GLOBAL_SIDEBAR_DEFAULT_WIDTH,
  GLOBAL_SIDEBAR_MIN_WIDTH,
  GLOBAL_SIDEBAR_MAX_WIDTH,
  normalizeGlobalSidebarWidth,
} from '@/utils/globalSidebarPreference';

interface SidebarResizeHandleProps {
  expanded: boolean;
  width: number;
  onCommit: (width: number) => void;
  onStart: () => void;
}

/** Owns one pointer transaction and its paint projection, never the saved preference. */
export function SidebarResizeHandle({ expanded, width, onCommit, onStart }: SidebarResizeHandleProps) {
  const { t } = useTranslation('app');
  const handleRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const stopRef = useRef<((commit: boolean, unmount?: boolean) => void) | null>(null);
  const callbacks = useRef({ onCommit, onStart });
  useLayoutEffect(() => { callbacks.current = { onCommit, onStart }; }, [onCommit, onStart]);
  const effectiveWidth = preview ?? width;

  // The immediate parent is the sidebar; its parent owns both sidebar and Tabs.
  // Publish before paint without sending per-frame state through the App tree.
  useLayoutEffect(() => {
    const shell = handleRef.current?.parentElement?.parentElement;
    if (!shell) return;
    const previous = shell.style.getPropertyValue('--global-sidebar-expanded-width');
    return () => {
      stopRef.current?.(false, true);
      if (previous) shell.style.setProperty('--global-sidebar-expanded-width', previous);
      else shell.style.removeProperty('--global-sidebar-expanded-width');
      shell.removeAttribute('data-sidebar-resizing');
    };
  }, []);
  useLayoutEffect(() => {
    const shell = handleRef.current?.parentElement?.parentElement;
    shell?.style.setProperty('--global-sidebar-expanded-width', `${effectiveWidth}px`);
  }, [effectiveWidth]);
  useLayoutEffect(() => {
    if (!expanded) stopRef.current?.(false);
  }, [expanded]);

  const beginDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !expanded || stopRef.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const shell = handle.parentElement?.parentElement;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = width;
    let nextWidth = width;
    let frame: number | null = null;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    shell?.setAttribute('data-sidebar-resizing', 'true');
    callbacks.current.onStart();
    setPreview(width);

    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      nextWidth = normalizeGlobalSidebarWidth(startWidth + e.clientX - startX);
      if (frame === null) frame = requestAnimationFrame(() => {
        frame = null;
        setPreview(nextWidth);
      });
    };
    const stop = (commit: boolean, unmount = false) => {
      if (stopRef.current !== stop) return;
      stopRef.current = null;
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', keydown, true);
      handle.removeEventListener('lostpointercapture', cancel);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      shell?.removeAttribute('data-sidebar-resizing');
      if (!unmount) {
        if (commit && nextWidth !== startWidth) callbacks.current.onCommit(nextWidth);
        setPreview(null);
      }
    };
    const up = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      move(e);
      stop(true);
    };
    const cancel = (e: globalThis.PointerEvent) => {
      if (e.pointerId === pointerId) stop(false);
    };
    const blur = () => stop(false);
    const keydown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stop(false);
    };
    stopRef.current = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', keydown, true);
    handle.addEventListener('lostpointercapture', cancel);
    handle.setPointerCapture(pointerId);
  };

  return <>
    <div
      ref={handleRef}
      hidden={!expanded}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('globalSidebar.resize')}
      aria-valuemin={GLOBAL_SIDEBAR_MIN_WIDTH}
      aria-valuemax={GLOBAL_SIDEBAR_MAX_WIDTH}
      aria-valuenow={effectiveWidth}
      tabIndex={expanded ? 0 : -1}
      title={t('globalSidebar.resizeHint')}
      data-no-drag
      className="global-sidebar-resize-handle"
      onPointerDown={beginDrag}
      onDoubleClick={() => { stopRef.current?.(false); onStart(); onCommit(GLOBAL_SIDEBAR_DEFAULT_WIDTH); }}
      onKeyDown={(event) => {
        if (stopRef.current || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
        const values: Record<string, number> = {
          ArrowLeft: width - 8, ArrowRight: width + 8,
          Home: GLOBAL_SIDEBAR_MIN_WIDTH, End: GLOBAL_SIDEBAR_MAX_WIDTH,
          Enter: GLOBAL_SIDEBAR_DEFAULT_WIDTH,
        };
        if (!(event.key in values)) return;
        event.preventDefault();
        event.stopPropagation();
        onStart();
        onCommit(normalizeGlobalSidebarWidth(values[event.key]));
      }}
    />
    {preview !== null && createPortal(
      <div data-sidebar-resize-shield data-suppress-browser data-no-drag className="fixed inset-0 z-[9999] cursor-col-resize" />,
      document.body,
    )}
  </>;
}
