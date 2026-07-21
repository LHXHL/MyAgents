import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import { themeRegistry } from '@/theme';

export const THEME_PRESET_GROUPS = [
  { key: 'baseline', ids: ['myagents-default', 'default-black'] },
  { key: 'original', ids: ['ink', 'fjord', 'ochre'] },
  { key: 'community', ids: ['sage', 'mauve', 'wisteria'] },
  { key: 'references', ids: ['absolutely', 'linear', 'proof', 'codex', 'raycast'] },
] as const;

interface ThemePresetSelectProps {
  value: string;
  onPersistTheme: (themeId: string) => Promise<void>;
  onPersistError: (error: unknown) => void;
}

export function ThemePresetSelect({
  value,
  onPersistTheme,
  onPersistError,
}: ThemePresetSelectProps) {
  const { t } = useTranslation('settings');
  const [isSaving, setIsSaving] = useState(false);
  const acceptedDefinitions = themeRegistry.getAcceptedDefinitions();

  const options = useMemo(() => {
    const acceptedById = new Map(acceptedDefinitions.map(definition => [definition.id, definition]));
    return THEME_PRESET_GROUPS.flatMap<SelectOption>(group => {
      const definitions = group.ids.flatMap(id => {
        const definition = acceptedById.get(id);
        return definition ? [definition] : [];
      });
      if (definitions.length === 0) return [];
      return [
        {
          value: `separator-${group.key}`,
          label: t(`about.developer.themeGroups.${group.key}`),
          isSeparator: true,
        },
        ...definitions.map(definition => ({
          value: definition.id,
          label: definition.displayName,
        })),
      ];
    });
  }, [acceptedDefinitions, t]);

  const persistTheme = useCallback((themeId: string) => {
    if (themeId === value || isSaving) return;
    setIsSaving(true);
    void onPersistTheme(themeId)
      .catch(onPersistError)
      .finally(() => setIsSaving(false));
  }, [isSaving, onPersistError, onPersistTheme, value]);

  return (
    <CustomSelect
      value={value}
      options={options}
      onChange={persistTheme}
      disabled={isSaving}
      size="toolbar"
      className="w-52 shrink-0"
    />
  );
}
