import stylesheetText from './fjord.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const fjordThemeManifest = {
  id: 'fjord',
  displayName: 'Fjord',
  description: 'Deep fjord teal with cool mist surfaces',
  stylesheetText,
} satisfies PresetThemeManifest;
