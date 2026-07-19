import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ThemeRegistry, ThemeRuntimeProvider } from '@/theme';
import { syntheticTheme } from '@/theme/__tests__/syntheticTheme';
import { myAgentsDefaultTheme } from '@/theme/themes/myagents-default';

const xtermCapture = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    dispose = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    reset = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xtermCapture.instances.push(this);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ rows: 24, cols: 80 }));
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => vi.fn()) }));

import { TerminalPanel } from './TerminalPanel';

describe('TerminalPanel Theme adapter', () => {
  it('updates the existing xterm instance in place when the resolved scheme changes', () => {
    const registry = new ThemeRegistry([myAgentsDefaultTheme, syntheticTheme]);
    const view = render(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'light' }}
      >
        <TerminalPanel
          workspacePath="/tmp/theme-test"
          terminalId="existing-pty"
          onTerminalCreated={vi.fn()}
          onTerminalExited={vi.fn()}
        />
      </ThemeRuntimeProvider>,
    );

    expect(xtermCapture.instances).toHaveLength(1);
    const terminal = xtermCapture.instances[0];
    expect((terminal.options.theme as Record<string, string>).background).toBe('#fff0ff');
    expect(terminal.options.fontFamily).toBe("'synthetic-light-xterm-font', monospace");

    view.rerender(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'dark' }}
      >
        <TerminalPanel
          workspacePath="/tmp/theme-test"
          terminalId="existing-pty"
          onTerminalCreated={vi.fn()}
          onTerminalExited={vi.fn()}
        />
      </ThemeRuntimeProvider>,
    );

    expect(xtermCapture.instances).toHaveLength(1);
    expect((terminal.options.theme as Record<string, string>).background).toBe('#120012');
    expect(terminal.options.fontSize).toBe(19);
  });
});
