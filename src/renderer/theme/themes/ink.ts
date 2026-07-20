import stylesheetText from './ink.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const inkThemeManifest = {
  id: 'ink',
  displayName: 'Ink',
  description: 'Warm black, bone white, and restrained editorial contrast',
  stylesheetText,
} satisfies PresetThemeManifest;
