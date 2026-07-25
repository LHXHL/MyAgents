import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import type { SettingsSection } from '../settingsSections';
import { SettingsSidebar } from './SettingsSidebar';

function SidebarProbe() {
  const [section, setSection] = useState<SettingsSection>('general');
  return (
    <SettingsSidebar
      activeSection={section}
      setActiveSection={setSection}
      showDevTools
      onShowLogs={() => {}}
    />
  );
}

describe('SettingsSidebar i18n', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('renders navigation labels from the settings namespace', () => {
    render(<SidebarProbe />);

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Model Providers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desktop Pet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skills' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Plugins' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tools' })).not.toBeInTheDocument();
    expect(screen.getByTitle('View Rust logs')).toBeInTheDocument();
  });
});
