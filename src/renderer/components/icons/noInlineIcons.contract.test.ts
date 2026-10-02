import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Hand-copied <svg> glyphs bypass the product icon set (and the lucide-react
// lint guard), so they silently keep a different grid and weight. Only the
// icon sets themselves and data charts may draw SVG directly.
const RENDERER = resolve(import.meta.dirname, '../..');
const ALLOWED = new Set([
  'components/icons/AppIcons.tsx',
  'components/file-icon/FileIcon.tsx',
  'components/file-icon/fileIconGlyphs.tsx',
  'assets/workspace-icons/glyphs.tsx',
  'components/launcher/WorkspaceIcon.tsx',
  // Data visualisations, not icons.
  'components/UsageStatsPanel.tsx',
  'components/ContextUsageIndicator.tsx',
]);

function collect(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collect(path);
    return entry.name.endsWith('.tsx') && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}

describe('renderer icon sources', () => {
  it('draws UI glyphs only through the MyAgents icon sets', () => {
    const offenders = collect(RENDERER)
      .map((path) => relative(RENDERER, path).replaceAll('\\', '/'))
      .filter((path) => !ALLOWED.has(path))
      .filter((path) => /<svg[\s>]/.test(readFileSync(join(RENDERER, path), 'utf8')));

    expect(offenders, 'Use a component from @/components/icons (add one to AppIcons.tsx if missing)').toEqual([]);
  });
});
