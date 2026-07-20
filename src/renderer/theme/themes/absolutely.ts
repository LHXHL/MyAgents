import stylesheetText from './absolutely.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const absolutelyThemeManifest = {
  id: 'absolutely',
  displayName: 'Absolutely',
  description: 'Codex-inspired terracotta with soft neutral surfaces',
  stylesheetText,
} satisfies PresetThemeManifest;
