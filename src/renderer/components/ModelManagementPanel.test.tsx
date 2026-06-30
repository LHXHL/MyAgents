import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { DEFAULT_CONFIG, type AppConfig, type Provider } from '@/config/types';
import ModelManagementPanel from './ModelManagementPanel';

vi.mock('@/hooks/useCloseLayer', () => ({
  useCloseLayer: vi.fn(),
}));

vi.mock('@/config/configService', () => ({
  atomicModifyConfig: vi.fn(async updater => updater({})),
  rebuildAndPersistAvailableProviders: vi.fn(async () => undefined),
}));

const baseConfig: AppConfig = DEFAULT_CONFIG;

function customProvider(models: Provider['models'] = []): Provider {
  return {
    id: 'fox',
    name: 'fox',
    vendor: 'Fox',
    cloudProvider: 'Custom',
    type: 'api',
    primaryModel: models[0]?.model ?? '',
    isBuiltin: false,
    config: { baseUrl: 'https://example.test' },
    models,
  };
}

function renderPanel(overrides: Partial<{
  provider: Provider;
  onUpdateCustomProvider: (provider: Provider) => Promise<void>;
  onRefresh: () => Promise<void>;
}> = {}) {
  const onUpdateCustomProvider = overrides.onUpdateCustomProvider ?? vi.fn(async () => undefined);
  const onRefresh = overrides.onRefresh ?? vi.fn(async () => undefined);

  render(
    <ModelManagementPanel
      provider={overrides.provider ?? customProvider()}
      apiKey={undefined}
      config={baseConfig}
      onClose={vi.fn()}
      onSaveCustomModels={vi.fn(async () => undefined)}
      onUpdateCustomProvider={onUpdateCustomProvider}
      onSetPrimaryModel={vi.fn(async () => undefined)}
      onRefresh={onRefresh}
    />,
  );

  return { onUpdateCustomProvider, onRefresh };
}

describe('ModelManagementPanel custom model add flow', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    await i18n.changeLanguage('en-US');
  });

  it('opens the model settings popover instead of saving immediately', async () => {
    const user = userEvent.setup();
    const { onUpdateCustomProvider } = renderPanel();

    await user.type(
      screen.getByPlaceholderText('Enter a model ID, press Enter to configure and add'),
      'gpt-5.5{enter}',
    );

    expect(screen.getByText('Model Parameters')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.5')).toBeInTheDocument();
    expect(onUpdateCustomProvider).not.toHaveBeenCalled();
  });

  it('does not let a second Enter replace the pending model editor', async () => {
    const user = userEvent.setup();
    renderPanel();

    const input = screen.getByPlaceholderText('Enter a model ID, press Enter to configure and add');
    await user.type(input, 'model-a{enter}');
    fireEvent.change(input, { target: { value: 'model-b' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('model-a')).toBeInTheDocument();
    expect(screen.queryByText('model-b')).not.toBeInTheDocument();
  });

  it('persists the model only after the settings form is saved', async () => {
    const user = userEvent.setup();
    const onUpdateCustomProvider = vi.fn(async () => undefined);
    const onRefresh = vi.fn(async () => undefined);
    renderPanel({ onUpdateCustomProvider, onRefresh });

    await user.type(
      screen.getByPlaceholderText('Enter a model ID, press Enter to configure and add'),
      'gpt-5.5',
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Context window'), { target: { value: '1m' } });
    await user.click(screen.getByRole('button', { name: 'Image' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdateCustomProvider).toHaveBeenCalledTimes(1));
    expect(onUpdateCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'fox',
      models: [expect.objectContaining({
        model: 'gpt-5.5',
        modelName: 'gpt-5.5',
        contextLength: 1_000_000,
        inputModalities: ['text', 'image'],
        source: 'manual',
      })],
    }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
