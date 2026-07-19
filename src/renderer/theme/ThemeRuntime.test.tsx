import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeRegistry } from './registry';
import { myAgentsDefaultTheme } from './themes/myagents-default';
import { ThemeRuntimeProvider, useResolvedTheme } from './ThemeRuntime';
import { THEME_BOOTSTRAP_KEY } from './bootstrap';
import { SYNTHETIC_THEME_ID, syntheticTheme } from './__tests__/syntheticTheme';

let mediaMatches = false;
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();

function installMatchMedia(): void {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: mediaMatches,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

function Probe({ onTheme }: { onTheme?: (key: string) => void }) {
  const theme = useResolvedTheme();
  useEffect(() => onTheme?.(theme.key), [onTheme, theme.key]);
  return (
    <output data-testid="theme-probe">
      {[
        theme.key,
        theme.hero.productName,
        theme.adapters.xterm.palette.background,
        theme.adapters.monaco.name,
        theme.adapters.mermaid.themeVariables.primaryColor,
        theme.adapters.prism['code[class*="language-"]']?.color,
        theme.adapters.widget.variables['--widget-text'],
      ].join('|')}
    </output>
  );
}

describe('ThemeRuntimeProvider', () => {
  const registry = new ThemeRegistry([myAgentsDefaultTheme, syntheticTheme]);

  beforeEach(() => {
    localStorage.clear();
    mediaMatches = false;
    mediaListeners.clear();
    installMatchMedia();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    document.documentElement.className = '';
    delete document.documentElement.dataset.themeId;
    delete document.documentElement.dataset.colorScheme;
    document.documentElement.style.colorScheme = '';
  });

  it('fails fast when a Theme consumer is mounted outside the runtime owner', () => {
    expect(() => render(<Probe />)).toThrow('useResolvedTheme must be used within ThemeRuntimeProvider');
  });

  it('updates root identity, scheme, dark compatibility and every synthetic adapter as one projection', () => {
    const view = render(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: SYNTHETIC_THEME_ID, appearanceMode: 'light' }}
      >
        <Probe />
      </ThemeRuntimeProvider>,
    );

    expect(document.documentElement.dataset.themeId).toBe(SYNTHETIC_THEME_ID);
    expect(document.documentElement.dataset.colorScheme).toBe('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(screen.getByTestId('theme-probe')).toHaveTextContent(
      'synthetic-test-theme:light|Synthetic Agents|#fff0ff|synthetic-light-monaco|#efd0f5|#21002f|#21002f',
    );

    view.rerender(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: SYNTHETIC_THEME_ID, appearanceMode: 'dark' }}
      >
        <Probe />
      </ThemeRuntimeProvider>,
    );

    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(screen.getByTestId('theme-probe')).toHaveTextContent('#120012');
  });

  it('tracks OS changes in system mode without replacing the provider', () => {
    const onTheme = vi.fn();
    render(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: SYNTHETIC_THEME_ID, appearanceMode: 'system' }}
      >
        <Probe onTheme={onTheme} />
      </ThemeRuntimeProvider>,
    );

    expect(document.documentElement.dataset.colorScheme).toBe('light');
    act(() => {
      mediaMatches = true;
      for (const listener of mediaListeners) listener({ matches: true } as MediaQueryListEvent);
    });
    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    expect(screen.getByTestId('theme-probe')).toHaveTextContent('synthetic-test-theme:dark');
    expect(onTheme).toHaveBeenLastCalledWith('synthetic-test-theme:dark');
  });

  it('removes synthetic root state on fallback and snapshots the resolved default ID', () => {
    const view = render(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: SYNTHETIC_THEME_ID, appearanceMode: 'dark' }}
      >
        <Probe />
      </ThemeRuntimeProvider>,
    );
    view.rerender(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: 'unknown-theme', appearanceMode: 'light' }}
      >
        <Probe />
      </ThemeRuntimeProvider>,
    );

    expect(document.documentElement.dataset.themeId).toBe('myagents-default');
    expect(document.documentElement.dataset.colorScheme).toBe('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(screen.getByTestId('theme-probe').textContent).not.toContain('synthetic-');
    const activeStylesheet = document.getElementById('myagents-active-theme-stylesheet');
    expect(activeStylesheet).toHaveAttribute('data-theme-id', 'myagents-default');
    expect(activeStylesheet?.textContent).not.toContain(SYNTHETIC_THEME_ID);
    expect(JSON.parse(localStorage.getItem(THEME_BOOTSTRAP_KEY) ?? '{}')).toMatchObject({
      themeId: 'myagents-default',
      appearanceMode: 'light',
    });
  });
});
