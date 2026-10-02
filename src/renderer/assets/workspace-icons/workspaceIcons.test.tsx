// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { getSystemPresetProjectMetadata, PRESET_TEMPLATES } from '../../../shared/config-types';

import {
  ALL_WORKSPACE_ICON_IDS,
  DEFAULT_WORKSPACE_ICON,
  LEGACY_WORKSPACE_ICON_IDS,
  WORKSPACE_ICON_GLYPHS,
  WORKSPACE_ICON_HUES,
  resolveWorkspaceIconId,
} from './index';

// Every ID the previous Phosphor set could have written into a saved config.
const PREVIOUS_IDS = [
  'robot', 'brain', 'sparkle', 'lightning', 'atom', 'cpu', 'detective',
  'cat', 'dog', 'bird', 'butterfly', 'fish', 'paw-print', 'bug', 'bug-beetle',
  'sun', 'moon-stars', 'star', 'planet', 'globe', 'cloud', 'rainbow', 'meteor',
  'lightbulb', 'rocket', 'compass', 'palette', 'music-note', 'guitar', 'camera', 'headphones',
  'flower-lotus', 'leaf', 'plant', 'tree', 'mountains', 'fire', 'umbrella',
  'heart', 'crown', 'diamond', 'trophy', 'gift', 'balloon', 'ghost', 'alien', 'game-controller', 'puzzle-piece',
  'folder-open', 'cube',
];

describe('workspace identity icons', () => {
  it('resolves every previously stored icon ID to a current glyph', () => {
    for (const id of PREVIOUS_IDS) {
      const resolved = resolveWorkspaceIconId(id);
      expect(resolved, id).toBeDefined();
      expect(WORKSPACE_ICON_GLYPHS).toHaveProperty(resolved!);
    }
    for (const target of Object.values(LEGACY_WORKSPACE_ICON_IDS)) {
      expect(ALL_WORKSPACE_ICON_IDS).toContain(target);
    }
  });

  it('shows the neutral project folder for unset and old default icons, and Mino keeps lightning', () => {
    expect(DEFAULT_WORKSPACE_ICON).toBe('project');
    expect(ALL_WORKSPACE_ICON_IDS[0]).toBe('project');
    expect(WORKSPACE_ICON_GLYPHS.project.hue).toBe('brand');
    for (const unset of [undefined, null, '', 'cube', 'folder-open']) {
      expect(resolveWorkspaceIconId(unset), String(unset)).toBe('project');
    }
    // Robot stays a selectable identity, no longer the fallback.
    expect(resolveWorkspaceIconId('robot')).toBe('robot');
    expect(resolveWorkspaceIconId(getSystemPresetProjectMetadata('mino').icon)).toBe('lightning');
    expect(resolveWorkspaceIconId(PRESET_TEMPLATES.find(t => t.name === 'Mino')?.icon)).toBe('lightning');
  });

  it('binds the default project hue to the Theme accent', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../index.css'), 'utf8');
    expect(css).toContain('--agent-icon-brand: var(--accent);');
  });

  it('leaves emoji icons to the text fallback', () => {
    expect(resolveWorkspaceIconId('🚀')).toBeUndefined();
    const { container } = render(<WorkspaceIcon icon="🚀" size={16} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container).toHaveTextContent('🚀');
  });

  it('renders legacy IDs as the mapped glyph coloured by its hue token', () => {
    const { container } = render(<WorkspaceIcon icon="moon-stars" size={20} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('data-workspace-icon', 'moon');
    expect(svg).toHaveAttribute('width', '20');
    expect(svg.style.color).toBe(`var(--agent-icon-${WORKSPACE_ICON_GLYPHS.moon.hue})`);
  });

  it('defines every hue token for both color schemes', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../index.css'), 'utf8');
    for (const scheme of [':root', "html[data-color-scheme='dark']"]) {
      const start = css.indexOf(`${scheme} {\n  /* agent-icon hues */`);
      expect(start, scheme).toBeGreaterThanOrEqual(0);
      const block = css.slice(start, css.indexOf('}', start));
      for (const hue of WORKSPACE_ICON_HUES) {
        expect(block, `${scheme} ${hue}`).toContain(`--agent-icon-${hue}:`);
      }
    }
  });
});
