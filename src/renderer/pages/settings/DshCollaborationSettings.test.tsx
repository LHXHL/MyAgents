import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { DshCollaborationSettings } from './DshCollaborationSettings';
import type { Provider } from '../../../shared/config-types';

afterEach(cleanup);
const provider: Provider = { id: 'ordinary-provider', name: 'Fixture Provider', vendor: 'custom', cloudProvider: 'fixture', type: 'api', isBuiltin: false, apiProtocol: 'openai',
  config: { baseUrl: 'https://fixture.invalid' }, enabled: true, primaryModel: 'fixture-model',
  models: [{ model: 'fixture-model', modelName: 'Fixture', modelSeries: 'fixture' }], authType: 'auth_token' };

describe('DSH collaboration settings', () => {
  beforeEach(async () => { await i18n.changeLanguage('en-US'); });
  it('commits complete numeric input at blur through the shared config owner', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(<DshCollaborationSettings value={undefined} providers={[]} updateConfig={update} />);
    const inputs = screen.getAllByRole('spinbutton');
    expect(inputs[0]).toHaveValue(2);
    fireEvent.change(inputs[0]!, { target: { value: '3' } });
    expect(update).not.toHaveBeenCalled();
    fireEvent.blur(inputs[0]!);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ dshCollaboration: { maxDepth: 3 } }));
    expect(document.querySelector('select')).toBeNull();
  });

  it('selects an ordinary Provider route with the shared styled control', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(<DshCollaborationSettings value={undefined} providers={[provider]} updateConfig={update} />);
    // The first inherited-model control is the default strategy; the other
    // controls independently configure roles.
    const labels = screen.getAllByRole('button');
    fireEvent.click(labels[0]!);
    const fixed = await screen.findByText('Use a specific model');
    fireEvent.click(fixed);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ dshCollaboration: {
      modelPolicy: 'fixed', fixedModel: { providerId: 'ordinary-provider', modelId: 'fixture-model' },
    } }));
  });
});
