import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function rendererSourceFiles(directory = resolve(root, 'src/renderer')): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return rendererSourceFiles(path);
    if (!/\.(?:ts|tsx|css)$/.test(entry.name) || /\.test\./.test(entry.name)) return [];
    return [path];
  });
}

function ruleBodyAfter(css: string, selector: string): string {
  const selectorIndex = css.indexOf(selector);
  expect(selectorIndex).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', selectorIndex);
  const close = css.indexOf('}', open);
  expect(open).toBeGreaterThan(selectorIndex);
  expect(close).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

function sourceSection(contents: string, startMarker: string, endMarker: string): string {
  const start = contents.indexOf(startMarker);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return contents.slice(start, end);
}

describe('Theme architecture guardrails', () => {
  it.each([
    'src/renderer/components/TerminalPanel.tsx',
    'src/renderer/components/MonacoEditor.tsx',
    'src/renderer/components/markdown/MermaidDiagram.tsx',
    'src/renderer/components/markdown/CodeBlock.tsx',
    'src/renderer/components/tools/WidgetRenderer.tsx',
  ])('%s consumes the public Theme runtime and does not infer scheme from DOM mutations', (file) => {
    const contents = source(file);
    expect(contents).toContain("from '@/theme'");
    expect(contents).not.toContain('MutationObserver');
  });

  it('keeps palette ownership out of embedded visual consumers', () => {
    expect(source('src/renderer/components/TerminalPanel.tsx')).not.toMatch(/TERMINAL_(LIGHT|DARK)_THEME/);
    expect(source('src/renderer/components/MonacoEditor.tsx')).not.toMatch(/(LIGHT|DARK)_THEME/);
    expect(source('src/renderer/components/markdown/MermaidDiagram.tsx')).not.toMatch(/(LIGHT|DARK)_COLORS/);
    expect(source('src/renderer/components/markdown/CodeBlock.tsx')).not.toContain('oneDark');
  });

  it('keeps the test-only synthetic Theme out of the production registry and entry graph', () => {
    expect(source('src/renderer/theme/registry.ts')).not.toContain('synthetic-test-theme');
    expect(source('src/renderer/theme/index.ts')).not.toContain('syntheticTheme');
  });

  it('keeps the Space scoped Theme exclusion intact', () => {
    const css = source('src/renderer/index.css');
    expect(css).toContain('[data-ui-theme="space-mono"]');
    expect(css).toContain('.dark [data-ui-theme="space-mono"]');
  });

  it('keeps a complete default visual fallback for unknown pre-React Theme IDs', () => {
    const css = source('src/renderer/theme/themes/myagents-default.css');
    expect(css).toContain(":root,\nhtml[data-theme-id='myagents-default']");
    expect(css).toContain('--font-body:');
    expect(css).toContain('--theme-radius-full:');
    expect(css).toContain("html[data-color-scheme='light']");
    expect(css).toContain("html[data-color-scheme='dark']");
    expect(css.match(/--theme-shadow-2xl:/g)).toHaveLength(2);
  });

  it('keeps Tailwind utility generation bridged to runtime Theme tokens', () => {
    const entry = source('src/renderer/index.css');
    const theme = source('src/renderer/theme/themes/myagents-default.css');
    expect(entry).toContain('@theme inline');
    expect(entry).toContain('--font-mono: var(--font-code)');
    expect(entry).toContain('--radius-full: var(--theme-radius-full)');
    expect(entry).toContain('--shadow-sm: var(--theme-shadow-sm)');
    expect(entry).toContain('--transition-duration-150: var(--duration-fast)');
    expect(theme).not.toContain('@theme');
  });

  it('keeps the restored warm default action palette independent from Space mono', () => {
    const theme = source('src/renderer/theme/themes/myagents-default.css');
    const space = source('src/renderer/index.css');
    const themeLight = ruleBodyAfter(theme, "html[data-color-scheme='light'],");
    const themeDark = ruleBodyAfter(theme, "html[data-color-scheme='dark'],");
    const spaceLight = ruleBodyAfter(space, '[data-ui-theme="space-mono"]');
    const spaceDark = ruleBodyAfter(space, '.dark [data-ui-theme="space-mono"]');
    const expectedThemeByScheme = {
      light: [
        '--hover-bg: rgba(194, 109, 58, 0.07)',
        '--accent: #c26d3a', '--accent-warm: #c26d3a', '--accent-warm-hover: #e18a58',
        '--accent-warm-subtle: rgba(194, 109, 58, 0.08)',
        '--accent-warm-muted: rgba(194, 109, 58, 0.15)',
        '--accent-warm-subtle-a0: rgba(194, 109, 58, 0)', '--on-accent: #ffffff',
        '--button-primary-bg: #c26d3a', '--button-primary-bg-hover: #b05e2d',
        '--button-primary-text: var(--on-accent)', '--focus-border: #1c1612', '--toggle-thumb: #ffffff',
      ],
      dark: [
        '--hover-bg: rgba(194, 109, 58, 0.12)',
        '--accent: #d4803f', '--accent-warm: #d4803f', '--accent-warm-hover: #e89860',
        '--accent-warm-subtle: rgba(212, 128, 63, 0.12)',
        '--accent-warm-muted: rgba(212, 128, 63, 0.20)',
        '--accent-warm-subtle-a0: rgba(212, 128, 63, 0)', '--on-accent: #ffffff',
        '--button-primary-bg: #d4803f', '--button-primary-bg-hover: #c27030',
        '--button-primary-text: var(--on-accent)', '--focus-border: var(--accent)', '--toggle-thumb: #e4dcd4',
      ],
    } as const;
    const expectedSpaceByScheme = {
      light: [
        '--accent: #1c1612', '--accent-warm: #1c1612', '--accent-warm-hover: #2e2825',
        '--accent-warm-subtle: rgb(28 22 18 / 0.08)', '--accent-warm-muted: rgb(28 22 18 / 0.16)',
        '--accent-warm-subtle-a0: rgb(28 22 18 / 0)', '--on-accent: #ffffff',
        '--hover-bg: rgb(28 22 18 / 0.07)', '--button-primary-bg: #1c1612',
        '--button-primary-bg-hover: #2e2825', '--button-primary-text: var(--on-accent)',
        '--focus-border: #1c1612',
      ],
      dark: [
        '--accent: #e4dcd4', '--accent-warm: #e4dcd4', '--accent-warm-hover: #ffffff',
        '--accent-warm-subtle: rgb(228 220 212 / 0.12)',
        '--accent-warm-muted: rgb(228 220 212 / 0.20)',
        '--accent-warm-subtle-a0: rgb(228 220 212 / 0)', '--on-accent: #1a1614',
        '--hover-bg: rgb(228 220 212 / 0.10)', '--button-primary-bg: #e4dcd4',
        '--button-primary-bg-hover: #ffffff', '--button-primary-text: var(--on-accent)',
        '--focus-border: #e4dcd4',
      ],
    } as const;
    for (const declaration of expectedThemeByScheme.light) {
      expect(themeLight).toContain(declaration);
    }
    for (const declaration of expectedThemeByScheme.dark) {
      expect(themeDark).toContain(declaration);
    }
    expect(themeDark).not.toContain('--accent: #c26d3a');
    expect(themeLight).not.toContain('--accent: #d4803f');
    for (const declaration of expectedSpaceByScheme.light) {
      expect(spaceLight).toContain(declaration);
    }
    for (const declaration of expectedSpaceByScheme.dark) {
      expect(spaceDark).toContain(declaration);
    }

    const adapters = source('src/renderer/theme/themes/myagents-default.ts');
    const lightWidget = sourceSection(adapters, 'const lightWidgetVariables', 'const darkWidgetVariables');
    const darkWidget = sourceSection(adapters, 'const darkWidgetVariables', 'const light: ThemeSchemeDefinition');
    const lightAdapter = sourceSection(adapters, 'const light: ThemeSchemeDefinition', 'const dark: ThemeSchemeDefinition');
    const darkAdapter = sourceSection(adapters, 'const dark: ThemeSchemeDefinition', 'const noHeroBackground');
    for (const declaration of [
      "'--widget-accent': '#c26d3a'", "'--widget-accent-hover': '#e18a58'",
      "'--widget-accent-subtle': 'rgba(194, 109, 58, 0.08)'", "'--widget-primary-text': '#ffffff'",
    ]) expect(lightWidget).toContain(declaration);
    for (const declaration of [
      "'--widget-accent': '#d4803f'", "'--widget-accent-hover': '#e89860'",
      "'--widget-accent-subtle': 'rgba(212, 128, 63, 0.12)'", "'--widget-primary-text': '#ffffff'",
    ]) expect(darkWidget).toContain(declaration);
    for (const declaration of [
      "cursor: '#c26d3a'", "selectionBackground: 'rgba(194, 109, 58, 0.18)'",
      "selectionInactiveBackground: 'rgba(194, 109, 58, 0.10)'",
    ]) expect(lightAdapter).toContain(declaration);
    for (const declaration of [
      "cursor: '#c26d3a'", "selectionBackground: 'rgba(194, 109, 58, 0.25)'",
      "selectionInactiveBackground: 'rgba(194, 109, 58, 0.15)'",
    ]) expect(darkAdapter).toContain(declaration);
  });

  it('keeps action surfaces paired with their Theme-owned foreground tokens', () => {
    const forbiddenPairs = [
      /bg-\[var\(--(?:accent|accent-warm)\)\][^'"`]*\btext-white\b/,
      /\btext-white\b[^'"`]*bg-\[var\(--(?:accent|accent-warm)\)\]/,
      /bg-\[var\(--button-primary-bg\)\][^'"`]*text-\[var\(--button-dark-text\)\]/,
      /bg-\[var\(--button-dark-bg\)\][^'"`]*text-\[var\(--button-primary-text\)\]/,
      /background(?:-color)?\s*:\s*var\(--accent\)\s*;[^}]*color\s*:\s*#(?:fff|ffffff)\b/is,
      /background(?:-color)?\s*:\s*var\(--button-dark-bg\)[^}]*color\s*:\s*var\(--button-primary-text\)/is,
    ];
    const violations = rendererSourceFiles()
      .filter(file => !file.includes('/pages/space/') && !file.endsWith('/pages/Space.tsx'))
      .filter(file => forbiddenPairs.some(pattern => pattern.test(readFileSync(file, 'utf8'))));
    expect(violations).toEqual([]);

    const statusNames = ['success', 'error', 'warning', 'info'] as const;
    const statusViolations = rendererSourceFiles()
      .filter(file => !file.includes('/pages/space/') && !file.endsWith('/pages/Space.tsx'))
      .filter(file => {
        const contents = readFileSync(file, 'utf8');
        return statusNames.some(status => {
          const wrongForeground = `(?:white|\\[var\\(--on-(?!${status}\\b)[a-z-]+\\)\\])`;
          return new RegExp(`bg-\\[var\\(--${status}\\)\\][^'"\\x60]*text-${wrongForeground}`).test(contents)
            || new RegExp(`text-${wrongForeground}[^'"\\x60]*bg-\\[var\\(--${status}\\)\\]`).test(contents)
            || new RegExp(`background(?:-color)?\\s*:\\s*var\\(--${status}\\)\\s*;[^}]*color\\s*:\\s*var\\(--on-(?!${status}\\b)[a-z-]+\\)`, 'is').test(contents);
        });
      });
    expect(statusViolations).toEqual([]);

    expect(source('src/renderer/hooks/useChatSearch.ts')).toContain('color: var(--on-accent)');
    expect(source('src/renderer/index.css')).toContain('color: var(--button-dark-text)');
    const tip = source('src/renderer/components/Tip.tsx');
    expect(tip).toContain('text-[var(--button-dark-text)]/70');
    expect(tip).not.toContain('text-white');
    const floatingBall = source('src/renderer/floating-ball/fb.css');
    expect(floatingBall).toContain('color-mix(in srgb, var(--core-c) 45%, var(--fb-highlight-strong))');
    expect(floatingBall).toContain('background: var(--success);\n  color: var(--on-success);');
    expect(floatingBall).toContain('.fbw-inputrow .send.stop { background: var(--button-dark-bg); color: var(--button-dark-text); }');
    expect(floatingBall).toContain('.fbw-inputrow .send.stop:hover { background: var(--button-dark-bg-hover); }');
    expect(source('src/renderer/components/SettingsHelperInbox.tsx')).toContain('bg-[var(--ink)]/70 text-[var(--paper)]');
  });

  it('keeps Settings on the disk-first appearanceMode write path', () => {
    const settings = source('src/renderer/pages/settings/SettingsPage.tsx');
    expect(settings).toContain('updateConfig({ appearanceMode: mode })');
    expect(settings).not.toContain('updateConfig({ theme:');
  });
});
