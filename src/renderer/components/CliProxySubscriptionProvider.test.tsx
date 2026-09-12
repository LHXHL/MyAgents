import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CliProxyStatus } from '../../shared/cliproxy';
import { PRESET_PROVIDERS } from '../../shared/config-types';
import CliProxySubscriptionProvider from './CliProxySubscriptionProvider';

const native = vi.hoisted(() => ({ cancelCliProxy: vi.fn(), checkCliProxyUpdate: vi.fn(), connectCliProxy: vi.fn(),
  disconnectCliProxy: vi.fn(), discoverCliProxyModels: vi.fn(), retryCliProxyCleanup: vi.fn() }));
vi.mock('@/config/services/cliproxyService', () => native);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => vi.resetAllMocks());
const provider = PRESET_PROVIDERS.find(p => p.id === 'antigravity-sub')!;
const status = (): CliProxyStatus => ({ policy: { mode: 'internal', usable: true, revision: 1 }, component: {},
  update: { phase: 'idle' }, instances: { active: 'running', candidate: 'stopped' },
  active: { generation: 'active', email: 'active@example.test', status: 'connected' },
  models: [{ model: 'approved-model', modelName: 'Approved', modelSeries: 'approved-model' }], modelsStale: false });

it('reads local models on mount and starts discovery only on explicit refresh', async () => {
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), instances: { active: 'stopped', candidate: 'stopped' } }} refresh={vi.fn()} />);
  expect(native.discoverCliProxyModels).not.toHaveBeenCalled();
  expect(native.connectCliProxy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTitle('providers.cliproxy.refreshModels'));
  await waitFor(() => expect(native.discoverCliProxyModels).toHaveBeenCalledWith('active'));
});

it('retries the recorded cleanup without disconnecting the active account', async () => {
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), cleanup: { scope: 'retired', failed: true } }} refresh={vi.fn()} />);
  fireEvent.click(screen.getByTitle('providers.cliproxy.moreActions'));
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.retryCleanup' }));
  await waitFor(() => expect(native.retryCliProxyCleanup).toHaveBeenCalledOnce());
  expect(native.disconnectCliProxy).not.toHaveBeenCalled();
  expect(screen.getByText(/active@example.test/)).toBeTruthy();
});

it('cancels only the displayed candidate while keeping the formal account visible', async () => {
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), candidate: {
    generation: 'candidate', attemptId: 'attempt', phase: 'authorizing',
  } }} refresh={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.continueConnection' }));
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.cancel' }));
  await waitFor(() => expect(native.cancelCliProxy).toHaveBeenCalledWith('attempt'));
  expect(native.disconnectCliProxy).not.toHaveBeenCalled();
  expect(screen.getByText(/active@example.test/)).toBeTruthy();
});

it('shows a retained account instead of disconnected while login resumes', () => {
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), active: null, candidate: {
    generation: 'candidate', attemptId: 'attempt', phase: 'stored', email: 'candidate@example.test',
  } }} refresh={vi.fn()} />);
  expect(screen.queryByText('providers.cliproxy.disconnected')).toBeNull();
});

it('keeps manual update failure out of account errors and renders it only in component details', async () => {
  native.checkCliProxyUpdate.mockRejectedValue({ code: 'update_unpublished', message: 'Update not published' });
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), active: null,
    error: { code: 'catalog_unavailable', message: 'Catalog unavailable' },
    update: { phase: 'failed', error: { code: 'update_unpublished', message: 'Update not published' } },
  }} refresh={vi.fn()} />);
  expect(screen.queryByText('Update not published')).toBeNull();
  fireEvent.click(screen.getByTitle('providers.cliproxy.moreActions'));
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.componentDetails' }));
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.checkUpdate' }));
  await waitFor(() => expect(native.checkCliProxyUpdate).toHaveBeenCalledOnce());
  expect(screen.getByRole('alert').textContent).toBe('Catalog unavailable');
  expect(screen.getAllByText('Update not published')).toHaveLength(1);
});

it('does not disable account connection while checking component updates', async () => {
  let finish!: () => void;
  native.checkCliProxyUpdate.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), active: null }} refresh={vi.fn()} />);
  fireEvent.click(screen.getByTitle('providers.cliproxy.moreActions'));
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.componentDetails' }));
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.checkUpdate' }));
  expect((screen.getByRole('button', { name: 'providers.login' }) as HTMLButtonElement).disabled).toBe(false);
  finish();
  await waitFor(() => expect((screen.getByRole('button', { name: 'providers.cliproxy.checkUpdate' }) as HTMLButtonElement).disabled).toBe(false));
});

it('keeps a Rust-owned candidate on dismissal and never reopens a completed dialog after disconnect', () => {
  const candidate = { generation: 'candidate', attemptId: 'attempt', phase: 'authorizing' as const };
  const { rerender } = render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), candidate }} refresh={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.continueConnection' }));
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.close' }));
  expect(native.cancelCliProxy).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.continueConnection' }));
  rerender(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), active: { generation: 'candidate', status: 'connected' } }} refresh={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(native.cancelCliProxy).not.toHaveBeenCalled();
  rerender(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), active: null }} refresh={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'providers.login' })).toBeTruthy();
});

it('keeps confirmed login usable with an empty or failed model catalog and has no model verification action', () => {
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), models: [], modelsStale: true,
    active: { generation: 'active', status: 'connected', error: { code: 'catalog_unavailable', message: 'Catalog temporarily unavailable' } },
  }} refresh={vi.fn()} />);
  expect(screen.getByText('providers.cliproxy.connected')).toBeTruthy();
  expect(screen.queryByText('providers.cliproxy.verify')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(native.connectCliProxy).not.toHaveBeenCalled();
});

it('resumes a retained native account through connect without requesting a model test', async () => {
  const current = { ...status(), active: null, candidate: { generation: 'retained', attemptId: 'attempt', phase: 'stored' as const } };
  native.connectCliProxy.mockResolvedValue(current);
  render(<CliProxySubscriptionProvider provider={provider} status={current} refresh={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'providers.cliproxy.continueConnection' }));
  await waitFor(() => expect(native.connectCliProxy).toHaveBeenCalledOnce());
  expect(screen.queryByText('providers.cliproxy.verify')).toBeNull();
});

it('never reports logged in when connection fails before an account is created', async () => {
  native.connectCliProxy.mockRejectedValue({ code: 'storage', message: 'Cannot save account' });
  render(<CliProxySubscriptionProvider provider={provider} status={{ ...status(), active: null }} refresh={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'providers.login' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Cannot save account'));
  expect(screen.queryByText('providers.cliproxy.connected')).toBeNull();
});
