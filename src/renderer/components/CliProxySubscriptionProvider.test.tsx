import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CliProxyStatus } from '../../shared/cliproxy';
import { PRESET_PROVIDERS } from '../../shared/config-types';
import CliProxySubscriptionProvider from './CliProxySubscriptionProvider';

const native = vi.hoisted(() => ({ cancelCliProxy: vi.fn(), checkCliProxyUpdate: vi.fn(), connectCliProxy: vi.fn(),
  disconnectCliProxy: vi.fn(), discoverCliProxyModels: vi.fn(), retryCliProxyCleanup: vi.fn(), verifyCliProxy: vi.fn() }));
vi.mock('@/config/services/cliproxyService', () => native);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => vi.clearAllMocks());
const provider = PRESET_PROVIDERS.find(p => p.id === 'antigravity-sub')!;
const status = (): CliProxyStatus => ({ policy: { mode: 'internal', usable: true, revision: 1 }, component: {},
  update: { phase: 'idle' }, instances: { active: 'running', candidate: 'stopped' },
  active: { generation: 'active', email: 'active@example.test', status: 'verified' },
  models: [{ model: 'approved-model', modelName: 'Approved', modelSeries: 'approved-model' }], modelsStale: false });

it('reads local models on mount and starts discovery only on explicit refresh', async () => {
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), instances: { active: 'stopped', candidate: 'stopped' } }} refresh={vi.fn()} />);
  expect(native.discoverCliProxyModels).not.toHaveBeenCalled();
  expect(native.connectCliProxy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.refreshModels' }));
  await waitFor(() => expect(native.discoverCliProxyModels).toHaveBeenCalledWith('active'));
});

it('retries the recorded cleanup without disconnecting the active account', async () => {
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), cleanup: { scope: 'retired', failed: true } }} refresh={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.retryCleanup' }));
  await waitFor(() => expect(native.retryCliProxyCleanup).toHaveBeenCalledOnce());
  expect(native.disconnectCliProxy).not.toHaveBeenCalled();
  expect(screen.getByText(/active@example.test/)).toBeTruthy();
});

it('cancels only the displayed candidate while keeping the formal account visible', async () => {
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), candidate: {
    generation: 'candidate', attemptId: 'attempt', phase: 'authorizing',
  } }} refresh={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.cancel' }));
  await waitFor(() => expect(native.cancelCliProxy).toHaveBeenCalledWith('attempt'));
  expect(native.disconnectCliProxy).not.toHaveBeenCalled();
  expect(screen.getByText(/active@example.test/)).toBeTruthy();
});

it('disables verification for the active account while Rust is still verifying it', () => {
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), verification: {
    accountGeneration: 'active', model: 'approved-model', phase: 'running',
  } }} refresh={vi.fn()} />);
  expect((screen.getByRole('button', { name: 'providers.cliproxy.verify' }) as HTMLButtonElement).disabled).toBe(true);
  expect(native.verifyCliProxy).not.toHaveBeenCalled();
});
