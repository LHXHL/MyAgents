/**
 * Process-neutral Theme selection semantics.
 *
 * Keep this module free of renderer/Node/Rust dependencies: config readers in
 * every process use the same migration rules, while visual Theme definitions
 * remain renderer-owned.
 */

export const DEFAULT_THEME_ID = 'myagents-default';
export const DEFAULT_APPEARANCE_MODE = 'system';

export type AppearanceMode = 'system' | 'light' | 'dark';
export type ResolvedColorScheme = 'light' | 'dark';
export type ThemeId = string;

export interface ThemeSelection {
  themeId: ThemeId;
  appearanceMode: AppearanceMode;
}

export function normalizeAppearanceMode(value: unknown): AppearanceMode {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : DEFAULT_APPEARANCE_MODE;
}

export function normalizeThemeId(value: unknown): ThemeId {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : DEFAULT_THEME_ID;
}

/** Resolve an appearance preference against this window's media-query state. */
export function resolveColorScheme(
  appearanceMode: AppearanceMode,
  systemPrefersDark: boolean,
): ResolvedColorScheme {
  if (appearanceMode === 'light' || appearanceMode === 'dark') return appearanceMode;
  return systemPrefersDark ? 'dark' : 'light';
}

/**
 * Migrate/normalize Theme selection fields without writing them.
 *
 * `theme` is the pre-0.3.2 name for AppearanceMode. The current field wins
 * when valid; otherwise a valid legacy value is preserved. The legacy key is
 * always removed so the next real locked config write heals disk naturally.
 * Unknown Theme IDs are deliberately preserved here: the renderer registry
 * performs whole-Theme fallback and emits a diagnostic without destroying a
 * value that may become available again in another build.
 */
export function normalizeThemeConfigRecord<T extends object>(value: T): T & ThemeSelection {
  const record = value as Record<string, unknown>;
  const appearanceMode = (
    record.appearanceMode === 'light'
    || record.appearanceMode === 'dark'
    || record.appearanceMode === 'system'
  )
    ? record.appearanceMode
    : normalizeAppearanceMode(record.theme);

  const normalized = {
    ...value,
    appearanceMode,
    themeId: normalizeThemeId(record.themeId),
  } as T & ThemeSelection & { theme?: unknown };
  delete normalized.theme;
  return normalized;
}
