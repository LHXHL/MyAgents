import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { DEFAULT_CONFIG } from '@/config/types';
import { atomicModifyConfig } from '@/config/configService';
import { invoke } from '@tauri-apps/api/core';
import { buildCustomProvider, EMPTY_CUSTOM_FORM, type CustomProviderForm } from '../providerForms';
import CustomProviderDialog from './CustomProviderDialog';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/config/configService', () => ({ atomicModifyConfig: vi.fn(), rebuildAndPersistAvailableProviders: vi.fn() }));

function open(initial: Partial<CustomProviderForm> = {}) {
  const submit = vi.fn(); const cancel = vi.fn();
  function Host() {
    const [form, setForm] = useState({ ...EMPTY_CUSTOM_FORM, name: 'Draft Provider', baseUrl: 'https://example.invalid/v1', ...initial });
    return <CustomProviderDialog form={form} onChange={setForm} config={DEFAULT_CONFIG}
      onCancel={cancel} onSubmit={() => submit(buildCustomProvider(form, 'created'))} />;
  }
  render(<Host />);
  return { submit, cancel };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en-US');
  vi.mocked(invoke).mockResolvedValue({ data: [{ id: 'api-model', context_length: 32768 }] });
});

describe('custom provider model draft', () => {
  it('uses one manager, preserves manually configured metadata, and only submits on final Add', async () => {
    const user = userEvent.setup(); const { submit } = open();
    const creation = screen.getByRole('dialog', { name: 'Add Custom Provider' });
    expect(within(creation).queryByPlaceholderText(/model ID/i)).not.toBeInTheDocument();
    expect(within(creation).getByRole('button', { name: 'Add' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Manage models' }));
    await user.type(screen.getByPlaceholderText('Enter a model ID, press Enter to configure and add'), 'manual-model{enter}');
    const editor = await screen.findByRole('dialog', { name: 'Model Parameters' });
    fireEvent.change(within(editor).getByLabelText('Display name'), { target: { value: 'My model' } });
    fireEvent.change(within(editor).getByLabelText('Context window'), { target: { value: '128k' } });
    await user.click(within(editor).getByRole('button', { name: 'Image' }));
    await user.click(within(editor).getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Selected models: 1')).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
    expect(atomicModifyConfig).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    await user.click(within(creation).getByRole('button', { name: 'Add' }));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      id: 'created', primaryModel: 'manual-model', models: [expect.objectContaining({
        model: 'manual-model', modelName: 'My model', contextLength: 128000, inputModalities: ['text', 'image'],
      })],
    }));
  });

  it('fetches the draft endpoint using the optional key and keeps API models local until creation', async () => {
    const user = userEvent.setup(); const { submit, cancel } = open({ apiKey: 'fixture-key' });
    await user.click(screen.getByRole('button', { name: 'Manage models' }));
    const model = await screen.findByText('api-model');
    await user.click(within(model.closest('[data-model-row]') ?? model.parentElement!.parentElement!).getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByText('Selected models: 1')).toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith('cmd_fetch_provider_models', expect.objectContaining({ url: 'https://example.invalid/v1/models', authHeaderValue: 'Bearer fixture-key' }));
    expect(submit).not.toHaveBeenCalled();
    expect(atomicModifyConfig).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });
  it('keeps manual entry usable after a catalog error and retries only on request', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('catalog unavailable'));
    const user = userEvent.setup(); open({ apiKey: 'fixture-key' });
    await user.click(screen.getByRole('button', { name: 'Manage models' }));
    expect(await screen.findByText('catalog unavailable')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('api-model');
    expect(invoke).toHaveBeenCalledTimes(2);
    await user.type(screen.getByPlaceholderText('Enter a model ID, press Enter to configure and add'), 'manual-after-retry{enter}');
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Selected models: 1')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

});
