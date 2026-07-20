import stylesheetText from './ochre.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const ochreThemeManifest = {
  id: 'ochre',
  displayName: 'Ochre',
  description: 'Ochre gold, parchment, and deep brown workbench',
  stylesheetText,
} satisfies PresetThemeManifest;
