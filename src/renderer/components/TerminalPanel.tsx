import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useResolvedTheme } from '@/theme';


interface TerminalPanelProps {
  workspacePath: string;
  terminalId: string | null;
  onTerminalCreated: (id: string) => void;
  onTerminalExited: () => void;
  /** Whether this panel is currently the visible view (for fit-on-show) */
  isVisible?: boolean;
  /** Session ID for this Tab — used to resolve sidecar port for MYAGENTS_PORT env var */
  sessionId?: string | null;
}

export function TerminalPanel({
  workspacePath,
  terminalId,
  onTerminalCreated,
  onTerminalExited,
  isVisible = true,
  sessionId: sessionIdProp,
}: TerminalPanelProps) {
  const { adapters } = useResolvedTheme();
  const xtermTheme = adapters.xterm;
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(terminalId);
  useEffect(() => { terminalIdRef.current = terminalId; }, [terminalId]);


  // Stable callbacks via refs to avoid effect re-runs
  const onTerminalCreatedRef = useRef(onTerminalCreated);
  const onTerminalExitedRef = useRef(onTerminalExited);
  useEffect(() => { onTerminalCreatedRef.current = onTerminalCreated; }, [onTerminalCreated]);
  useEffect(() => { onTerminalExitedRef.current = onTerminalExited; }, [onTerminalExited]);

  // Mounted guard to prevent stale async callbacks
  const isMountedRef = useRef(true);
  // Store unlisten functions from create flow so they can be cleaned up on unmount.
  // Without this, each terminal open/close cycle leaks two Tauri event listeners.
  const unlistenDataRef = useRef<(() => void) | null>(null);
  const unlistenExitRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
    };
  }, []);

  // 1. Initialize xterm.js instance (once on mount)
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: xtermTheme.palette,
      fontFamily: xtermTheme.fontFamily,
      fontSize: xtermTheme.fontSize,
      lineHeight: xtermTheme.lineHeight,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      // macOS key handling
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      // Right-click: select word + show native context menu (Copy/Paste)
      rightClickSelectsWord: true,
      // Visual
      drawBoldTextInBrightColors: true,
      customGlyphs: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);

    // Initial fit (next frame to ensure container has dimensions)
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    return () => {
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  // Theme changes update options in effect 1b without recreating the PTY.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1b. Dynamically update xterm theme when app theme changes (without recreating terminal)
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = xtermTheme.palette;
      xtermRef.current.options.fontFamily = xtermTheme.fontFamily;
      xtermRef.current.options.fontSize = xtermTheme.fontSize;
      xtermRef.current.options.lineHeight = xtermTheme.lineHeight;
    }
  }, [xtermTheme]);

  // 2. Create PTY — "listeners first" pattern to prevent exit event loss.
  //    Frontend generates the terminal ID, registers listeners, THEN creates the PTY.
  //    This closes the race where a fast-exiting shell beats listener registration.
  const creatingRef = useRef(false); // In-flight guard prevents double creation

  useEffect(() => {
    if (terminalId !== null) return; // Already created
    if (!fitAddonRef.current) return; // xterm not ready yet
    if (creatingRef.current) return; // Creation already in flight
    creatingRef.current = true;

    // Clear xterm buffer before creating new PTY — prevents zsh PROMPT_EOL_MARK (%)
    // from appearing when reusing the xterm instance after a previous shell exited
    if (xtermRef.current) {
      xtermRef.current.reset();
    }

    const dims = fitAddonRef.current.proposeDimensions();
    const rows = dims?.rows ?? 24;
    const cols = dims?.cols ?? 80;

    // Generate ID frontend-side so we can register listeners before PTY creation
    const preId = crypto.randomUUID();
    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const create = async () => {
      // Step 1: Register listeners FIRST (before PTY exists)
      unlistenData = await listen<number[]>(`terminal:data:${preId}`, (event) => {
        if (xtermRef.current && event.payload) {
          xtermRef.current.write(new Uint8Array(event.payload));
        }
      });
      if (cancelled) { unlistenData(); creatingRef.current = false; return; }

      unlistenExit = await listen(`terminal:exit:${preId}`, () => {
        xtermRef.current?.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
        onTerminalExitedRef.current();
      });
      if (cancelled) { unlistenExit(); unlistenData?.(); creatingRef.current = false; return; }

      // Step 2: Resolve sidecar port
      let port: number | null = null;
      if (sessionIdProp) {
        try {
          const mod = await import('@/api/tauriClient');
          port = await mod.getSessionPort(sessionIdProp);
        } catch { /* port stays null */ }
      }
      if (cancelled) { unlistenData?.(); unlistenExit?.(); creatingRef.current = false; return; }

      // Step 3: Create PTY with pre-generated ID
      const id = await invoke<string>('cmd_terminal_create', {
        workspacePath, rows, cols,
        sidecarPort: port ?? null,
        terminalId: preId,
      });

      creatingRef.current = false;

      if (!isMountedRef.current || cancelled) {
        invoke('cmd_terminal_close', { terminalId: id }).catch(() => {});
        unlistenData?.();
        unlistenExit?.();
        return;
      }
      // Store unlisten functions in refs for cleanup on unmount (prevents listener leak)
      unlistenDataRef.current = unlistenData;
      unlistenExitRef.current = unlistenExit;
      onTerminalCreatedRef.current(id);
      // Auto-focus terminal after creation
      requestAnimationFrame(() => { xtermRef.current?.focus(); });
    };

    create().catch((err) => {
      creatingRef.current = false;
      // Clean up pre-registered listeners on failure to prevent leaks
      unlistenData?.();
      unlistenExit?.();
      console.error('[TerminalPanel] Failed to create terminal:', err);
      xtermRef.current?.write(`\r\nFailed to create terminal: ${err}\r\n`);
    });

    return () => {
      cancelled = true;
      // Listeners cleaned up inside create() on cancel, or will be cleaned up
      // by the next effect cycle when terminalId becomes non-null
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionIdProp: one-time env injection at creation
  }, [terminalId, workspacePath]);

  // 3. User input → PTY write
  useEffect(() => {
    if (!terminalId || !xtermRef.current) return;

    const disposable = xtermRef.current.onData((data: string) => {
      const encoded = Array.from(new TextEncoder().encode(data));
      invoke('cmd_terminal_write', { terminalId, data: encoded }).catch((err) => {
        console.error('[TerminalPanel] Write error:', err);
      });
    });

    return () => disposable.dispose();
  }, [terminalId]);

  // 5. Unified resize with transition-aware suppression.
  //
  // ROOT CAUSE of prompt truncation: the left panel has `transition-[width] duration-300`
  // (300ms CSS transition). During this transition, the terminal container width changes
  // continuously from 0 to its final width. Without suppression, ResizeObserver fires
  // repeatedly during transition, each time calling fit() at a different intermediate width,
  // sending multiple SIGWINCH to the shell → prompt redrawn at wrong widths → garbled text.
  //
  // Fix: suppress ALL resizes during a 400ms window after becoming visible (covers the
  // full 300ms CSS transition + margin). Only send a single resize at the final stable width.
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastColsRef = useRef<number>(0);
  const lastRowsRef = useRef<number>(0);
  const transitionGuardRef = useRef(false); // true = suppress resize (CSS transition in progress)

  const doFitAndResize = useCallback(() => {
    if (!fitAddonRef.current || !containerRef.current) return;
    // Skip if container is too narrow — still in CSS transition or hidden
    if (containerRef.current.clientWidth < 100) return;
    fitAddonRef.current.fit();
    const dims = fitAddonRef.current.proposeDimensions();
    if (!dims || !terminalIdRef.current) return;
    // Only send resize to PTY if dimensions actually changed
    if (dims.cols === lastColsRef.current && dims.rows === lastRowsRef.current) return;
    lastColsRef.current = dims.cols;
    lastRowsRef.current = dims.rows;
    invoke('cmd_terminal_resize', {
      terminalId: terminalIdRef.current,
      rows: dims.rows,
      cols: dims.cols,
    }).catch(() => {});
  }, []);

  // ResizeObserver — fires on container size changes (drag resize, window resize)
  // Suppressed during the visibility transition window to prevent intermediate resizes.
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver(() => {
      if (transitionGuardRef.current) return; // Suppress during CSS transition
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(doFitAndResize, 100);
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [doFitAndResize]);

  // Visibility change — waits for CSS transition to complete (400ms > 300ms transition)
  // before sending a single fit+resize. Suppresses ResizeObserver during this window.
  useEffect(() => {
    if (!isVisible) return;
    transitionGuardRef.current = true;
    const timer = setTimeout(() => {
      transitionGuardRef.current = false;
      doFitAndResize();
      // Auto-focus when terminal becomes visible (switching from file view, or reopening panel)
      xtermRef.current?.focus();
    }, 400);
    return () => {
      clearTimeout(timer);
      transitionGuardRef.current = false;
    };
  }, [isVisible, doFitAndResize]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full px-2 pb-1"
      style={{ background: xtermTheme.palette.background }}
    />
  );
}
