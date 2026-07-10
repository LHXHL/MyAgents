import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from './types';
import { ConfigProvider } from './ConfigProvider';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    loadAppConfig: vi.fn(),
    loadProjects: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn(async () => {}) }));
vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(async () => ({ models: [] })) }));

vi.mock('./services/appConfigService', () => ({
    loadAppConfig: mocks.loadAppConfig,
    atomicModifyConfig: vi.fn(async (modify: (config: object) => object) => modify({})),
    ensureBundledWorkspace: vi.fn(async () => {}),
    ensureManagedCodexProviderDevGateDefault: vi.fn(async () => {}),
    mergePresetCustomModels: vi.fn((providers: unknown[]) => providers),
}));

vi.mock('./services/providerService', () => ({
    getAllProviders: vi.fn(async () => []),
    loadApiKeys: vi.fn(async () => ({})),
    saveApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    loadProviderVerifyStatus: vi.fn(async () => ({})),
    saveProviderVerifyStatus: vi.fn(),
    saveCustomProvider: vi.fn(),
    deleteCustomProvider: vi.fn(),
    rebuildAndPersistAvailableProviders: vi.fn(async () => {}),
}));

vi.mock('./services/projectService', () => ({
    loadProjects: mocks.loadProjects,
    saveProjects: vi.fn(async () => {}),
    addProject: vi.fn(),
    updateProject: vi.fn(),
    patchProject: vi.fn(),
    removeOrHideProject: vi.fn(),
    touchProject: vi.fn(),
}));

vi.mock('./services/agentConfigService', () => ({
    addAgentConfig: vi.fn(),
    buildAgentForProject: vi.fn(),
    configureMemoryAutoUpdateTaskForAgent: vi.fn(),
    configureMemoryEvolutionTasksForAgent: vi.fn(),
    ensureAllProjectsHaveAgent: vi.fn(() => ({ changed: false })),
    migrateImBotConfigsToAgents: vi.fn((config: object) => config),
    persistAgents: vi.fn(async () => {}),
}));

describe('ConfigProvider Managed Codex startup update lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.loadProjects.mockResolvedValue([]);
        mocks.loadAppConfig.mockImplementation(async () => ({
            ...DEFAULT_CONFIG,
            agents: [],
            managedCodexProviderDevGate: true,
            managedCodexRuntimeInstall: {
                status: 'error',
                usable: true,
                installedVersion: '0.0.0-previous',
            },
            managedCodexAuth: {
                status: 'valid',
                authMethod: 'chatgpt',
            },
        }));
        mocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'cmd_managed_codex_download') {
                throw new Error('offline');
            }
            return undefined;
        });
    });

    it('attempts once per App module, without looping after refresh or React remount', async () => {
        const first = render(<ConfigProvider><div>child</div></ConfigProvider>);

        await waitFor(() => {
            expect(mocks.invoke.mock.calls.filter(([command]) => (
                command === 'cmd_managed_codex_download'
            ))).toHaveLength(1);
        });
        const invokedCommands = mocks.invoke.mock.calls.map(([command]) => command);
        expect(invokedCommands.indexOf('cmd_managed_codex_status'))
            .toBeLessThan(invokedCommands.indexOf('cmd_managed_codex_download'));
        await waitFor(() => expect(mocks.loadAppConfig.mock.calls.length).toBeGreaterThanOrEqual(3));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(1);

        first.unmount();
        const loadsBeforeRemount = mocks.loadAppConfig.mock.calls.length;
        render(<ConfigProvider><div>child</div></ConfigProvider>);

        await waitFor(() => expect(mocks.loadAppConfig.mock.calls.length).toBeGreaterThan(loadsBeforeRemount));
        expect(mocks.invoke.mock.calls.filter(([command]) => (
            command === 'cmd_managed_codex_download'
        ))).toHaveLength(1);
    });
});
