import stylesheetText from './mauve.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const mauveThemeManifest = {
  id: 'mauve',
  displayName: 'Mauve',
  description: 'Community muted mauve with a mature document character',
  stylesheetText,
} satisfies PresetThemeManifest;
