import { describe, expect, it } from 'vitest';

import {
  projectInputChromeRuntime,
  projectRuntimeExtensionUpdateNotice,
  shouldShowBuiltinSdkSlashCommands,
  shouldUseExternalRuntimeInputControls,
  supportsRuntimeConversationBranches,
} from './runtimeUiProjection';

describe('runtime UI projection', () => {
  it('exposes bundled DSH mutations without borrowing the Codex CLI version gate', () => {
    expect(supportsRuntimeConversationBranches('dsh', 'integrated', undefined)).toBe(true);
    expect(supportsRuntimeConversationBranches('builtin', undefined, undefined)).toBe(true);
    expect(supportsRuntimeConversationBranches('claude-code', 'system-cli', '0.146.0')).toBe(false);
    expect(supportsRuntimeConversationBranches('codex', 'system-cli', '0.142.9')).toBe(false);
    expect(supportsRuntimeConversationBranches('codex', 'system-cli', '0.143.0')).toBe(true);
    expect(supportsRuntimeConversationBranches('codex', 'managed-provider', undefined)).toBe(true);
  });
  it('keeps managed Codex execution hidden behind builtin provider chrome', () => {
    expect(projectInputChromeRuntime({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: true,
    })).toBe('builtin');
    expect(shouldUseExternalRuntimeInputControls({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: true,
    })).toBe(false);
  });

  it('keeps user-managed CLI runtimes in external runtime controls', () => {
    expect(projectInputChromeRuntime({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: false,
    })).toBe('codex');
    expect(shouldUseExternalRuntimeInputControls({
      currentRuntime: 'codex',
      managedProviderRuntimeActive: false,
    })).toBe(true);
  });

  it('keeps Integrated DSH on Product provider and extension controls', () => {
    expect(projectInputChromeRuntime({
      currentRuntime: 'dsh',
      managedProviderRuntimeActive: false,
    })).toBe('dsh');
    expect(shouldUseExternalRuntimeInputControls({
      currentRuntime: 'dsh',
      managedProviderRuntimeActive: false,
    })).toBe(false);
  });

  it('only exposes Claude Agent SDK system slash commands to builtin Sessions', () => {
    expect(shouldShowBuiltinSdkSlashCommands('builtin')).toBe(true);
    expect(shouldShowBuiltinSdkSlashCommands('dsh')).toBe(false);
    expect(shouldShowBuiltinSdkSlashCommands('codex')).toBe(false);
    expect(shouldShowBuiltinSdkSlashCommands('claude-code')).toBe(false);
  });

  it('only requests extension feedback when the user must wait or act', () => {
    expect(projectRuntimeExtensionUpdateNotice({
      desiredRevision: 'desired',
      effectiveRevision: null,
      state: 'pending_next_start',
      components: [],
    })).toBeNull();

    expect(projectRuntimeExtensionUpdateNotice({
      desiredRevision: 'desired',
      effectiveRevision: 'effective',
      state: 'deferred_until_idle',
      components: [],
    })).toBe('deferred');

    expect(projectRuntimeExtensionUpdateNotice({
      desiredRevision: 'desired',
      effectiveRevision: 'effective',
      state: 'applied',
      components: [{
        component: 'plugins',
        state: 'unsupported',
        code: 'plugin_hooks_unsupported',
      }],
    })).toBeNull();

    expect(projectRuntimeExtensionUpdateNotice({
      desiredRevision: 'desired',
      effectiveRevision: 'effective',
      state: 'applied',
      components: [{
        component: 'host_tools',
        state: 'unsupported',
        code: 'host_tools_connect_failed',
        requiresUserAction: true,
      }],
    })).toBe('unsupported');
  });
});
