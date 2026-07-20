import stylesheetText from './wisteria.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const wisteriaThemeManifest = {
  id: 'wisteria',
  displayName: 'Wisteria',
  description: 'Community airy wisteria with cool reading surfaces',
  stylesheetText,
} satisfies PresetThemeManifest;
