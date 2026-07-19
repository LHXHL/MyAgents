import {
  DEFAULT_APPEARANCE_MODE,
  DEFAULT_THEME_ID,
  normalizeAppearanceMode,
  normalizeThemeId,
  resolveColorScheme,
  type ResolvedColorScheme,
  type ThemeSelection,
} from '../../shared/theme';

export const THEME_BOOTSTRAP_KEY = 'myagents:theme-bootstrap';
export const LEGACY_THEME_BOOTSTRAP_KEY = 'theme';
export const THEME_BOOTSTRAP_VERSION = 1;

export interface ThemeBootstrapSnapshot extends ThemeSelection {
  version: typeof THEME_BOOTSTRAP_VERSION;
}

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function parseThemeBootstrapSnapshot(raw: string | null): ThemeBootstrapSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== THEME_BOOTSTRAP_VERSION) return null;
    return {
      version: THEME_BOOTSTRAP_VERSION,
      themeId: normalizeThemeId(parsed.themeId),
      appearanceMode: normalizeAppearanceMode(parsed.appearanceMode),
    };
  } catch {
    return null;
  }
}

export function readThemeBootstrapSelection(storage: ThemeStorage | null): ThemeSelection {
  if (!storage) return { themeId: DEFAULT_THEME_ID, appearanceMode: DEFAULT_APPEARANCE_MODE };
  try {
    const current = parseThemeBootstrapSnapshot(storage.getItem(THEME_BOOTSTRAP_KEY));
    if (current) return { themeId: current.themeId, appearanceMode: current.appearanceMode };

    // One-release compatibility path. The durable runtime removes this key as
    // soon as it publishes the versioned non-sensitive snapshot.
    const legacy = storage.getItem(LEGACY_THEME_BOOTSTRAP_KEY);
    return {
      themeId: DEFAULT_THEME_ID,
      appearanceMode: normalizeAppearanceMode(legacy),
    };
  } catch {
    return { themeId: DEFAULT_THEME_ID, appearanceMode: DEFAULT_APPEARANCE_MODE };
  }
}

export function writeThemeBootstrapSnapshot(storage: ThemeStorage | null, selection: ThemeSelection): void {
  if (!storage) return;
  try {
    const snapshot: ThemeBootstrapSnapshot = {
      version: THEME_BOOTSTRAP_VERSION,
      themeId: normalizeThemeId(selection.themeId),
      appearanceMode: normalizeAppearanceMode(selection.appearanceMode),
    };
    storage.setItem(THEME_BOOTSTRAP_KEY, JSON.stringify(snapshot));
    storage.removeItem(LEGACY_THEME_BOOTSTRAP_KEY);
  } catch {
    // Storage may be disabled. Theme application must never block startup.
  }
}

export function resolveBootstrapScheme(
  selection: ThemeSelection,
  systemPrefersDark: boolean,
): ResolvedColorScheme {
  return resolveColorScheme(normalizeAppearanceMode(selection.appearanceMode), systemPrefersDark);
}
