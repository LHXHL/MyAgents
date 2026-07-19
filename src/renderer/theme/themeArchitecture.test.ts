import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
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
    expect(css).toContain("html[data-color-scheme='light']");
    expect(css).toContain("html[data-color-scheme='dark']");
  });

  it('keeps Settings on the disk-first appearanceMode write path', () => {
    const settings = source('src/renderer/pages/settings/SettingsPage.tsx');
    expect(settings).toContain('updateConfig({ appearanceMode: mode })');
    expect(settings).not.toContain('updateConfig({ theme:');
  });
});
