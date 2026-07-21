import { transformWithEsbuild } from 'vite';
import { describe, expect, it } from 'vitest';

import { absolutelyThemeManifest } from './absolutely';
import { codexThemeManifest } from './codex';
import { fjordThemeManifest } from './fjord';
import { inkThemeManifest } from './ink';
import { linearThemeManifest } from './linear';
import { mauveThemeManifest } from './mauve';
import { ochreThemeManifest } from './ochre';
import { createPresetTheme } from './preset-theme';
import { proofThemeManifest } from './proof';
import { raycastThemeManifest } from './raycast';
import { sageThemeManifest } from './sage';
import { wisteriaThemeManifest } from './wisteria';

const manifests = [
  inkThemeManifest,
  fjordThemeManifest,
  ochreThemeManifest,
  sageThemeManifest,
  mauveThemeManifest,
  wisteriaThemeManifest,
  absolutelyThemeManifest,
  linearThemeManifest,
  proofThemeManifest,
  codexThemeManifest,
  raycastThemeManifest,
] as const;

describe('preset Theme construction', () => {
  it.each(manifests)('constructs $id from production-minified inline CSS', async (manifest) => {
    const { code: minifiedStylesheetText } = await transformWithEsbuild(
      manifest.stylesheetText,
      `${manifest.id}.css`,
      { loader: 'css', minify: true },
    );

    // This is the serialization Vite emits for `?inline` CSS in production.
    // The Theme contract is semantic, so optional package construction must
    // not depend on source-only quotes or whitespace surviving this step.
    expect(minifiedStylesheetText).toContain(`html[data-theme-id=${manifest.id}]{`);

    const definition = createPresetTheme({
      ...manifest,
      stylesheetText: minifiedStylesheetText,
    });

    expect(definition.id).toBe(manifest.id);
    expect(definition.schemes.light.monaco.data.colors['editor.background']).toBeTruthy();
    expect(definition.schemes.dark.widget.variables['--widget-accent']).toBeTruthy();
  });
});
