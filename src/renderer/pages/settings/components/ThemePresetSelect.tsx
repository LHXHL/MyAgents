import { useCallback, useState } from 'react';

import CustomSelect from '@/components/CustomSelect';
import { themeRegistry } from '@/theme';

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
  const [isSaving, setIsSaving] = useState(false);
  const options = themeRegistry.getAcceptedDefinitions().map(definition => ({
    value: definition.id,
    label: definition.displayName,
  }));

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
