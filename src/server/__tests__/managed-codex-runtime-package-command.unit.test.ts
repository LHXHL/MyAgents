import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The publish helper lives under scripts/ because it is an operator entrypoint,
// but its Windows process-spawn behavior is part of the managed runtime contract.
import {
  formatCommandFailure,
  resolveSpawnInvocation,
} from '../../../scripts/package-managed-codex-spawn.js';
import {
  managedCodexMacHelperSigningCandidates,
  managedCodexSignerEnv,
  resolveManagedCodexPackageIdentity,
  shouldSignManagedCodexPackage,
  macNativePathPolicy,
  windowsNativePathPolicy,
  validateManagedCodexNativePaths,
} from '../../../scripts/package-managed-codex-policy.js';

describe('managed Codex package command spawning', () => {
  it.each(['darwin-arm64', 'darwin-x64'])('requires upstream signatures for the %s voice host and dylibs', (platform) => {
    const policy = macNativePathPolicy(platform);
    const root = policy.codexPath.replace('/bin/codex', '');
    const paths = [...policy.openAiSignedPaths, ...policy.helperPaths];
    expect(paths).toHaveLength(30);
    expect(policy.openAiSignedPaths.has(`${root}/codex-resources/voice/bin/codex-voice-host`)).toBe(true);
    expect(policy.openAiSignedPaths.has(`${root}/codex-resources/voice/lib/libglib-2.0.0.dylib`)).toBe(true);
    expect(policy.openAiSignedPaths.has(`${root}/codex-resources/voice/plugins/libgstapp.dylib`)).toBe(true);
    expect([...policy.helperPaths]).toEqual([`${root}/codex-path/rg`, `${root}/codex-resources/zsh/bin/zsh`]);
    expect(() => validateManagedCodexNativePaths(platform, paths)).not.toThrow();
    // A new library must not gain trust merely by being under voice/lib.
    expect(() => validateManagedCodexNativePaths(platform, [...paths, `${root}/codex-resources/voice/lib/unreviewed.dylib`])).toThrow('native file set changed');
    expect(() => validateManagedCodexNativePaths(platform, paths.filter(path => !path.endsWith('/libglib-2.0.0.dylib')))).toThrow('native file set changed');
    expect(() => validateManagedCodexNativePaths(platform, [...paths.slice(1), paths[1]])).toThrow('native file set changed');
  });

  it('retains the Windows signed binaries and unsigned rg boundary', () => {
    const policy = windowsNativePathPolicy();
    const paths = [...policy.openAiSignedPaths, ...policy.unsignedHelperPaths];
    expect(() => validateManagedCodexNativePaths('win32-x64', paths)).not.toThrow();
    expect([...policy.unsignedHelperPaths]).toEqual(['vendor/x86_64-pc-windows-msvc/codex-path/rg.exe']);
    expect(() => validateManagedCodexNativePaths('win32-x64', [...paths, 'vendor/x86_64-pc-windows-msvc/bin/unknown.exe'])).toThrow('native file set changed');
    expect(() => validateManagedCodexNativePaths('darwin-unknown', paths)).toThrow('Unsupported');
  });

  it('keeps signed releases pinned to the shared lock', () => {
    expect(() => resolveManagedCodexPackageIdentity({
      lockedVersion: '0.144.1',
      requestedVersion: '0.145.0',
      allowUnsigned: false,
    })).toThrow('Signed Managed Codex packages must use locked version');
    expect(resolveManagedCodexPackageIdentity({
      lockedVersion: '0.144.1',
      requestedVersion: '0.145.0',
      allowUnsigned: true,
    })).toEqual({
      codexVersion: '0.145.0',
      runtimeSet: 'codex-0.145.0',
    });
  });

  it('never emits MyAgents signatures for unsigned probe packages', () => {
    expect(shouldSignManagedCodexPackage({ allowUnsigned: true })).toBe(false);
    expect(shouldSignManagedCodexPackage({ allowUnsigned: false })).toBe(true);
  });

  it('accepts official OpenAI helper signatures before the legacy ad-hoc shape', () => {
    expect(managedCodexMacHelperSigningCandidates({
      teamId: '2DC432GLL2',
      signingIdentity: 'Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)',
    })).toEqual([
      {
        action: 'preserved-upstream-openai-signature',
        signing: {
          type: 'codesign',
          teamId: '2DC432GLL2',
          signingIdentity: 'Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)',
        },
      },
      {
        action: 'preserved-upstream-ad-hoc-signature',
        signing: { type: 'codesign', teamId: 'not set' },
      },
    ]);
  });

  it('passes signer key material through exactly one authority', () => {
    expect(managedCodexSignerEnv({
      TAURI_SIGNING_PRIVATE_KEY: 'inline-key',
      TAURI_PRIVATE_KEY: 'legacy-inline-key',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password',
      PATH: '/usr/bin',
    })).toEqual({
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password',
      TAURI_PRIVATE_KEY_PASSWORD: 'password',
      PATH: '/usr/bin',
    });
  });

  it('does not expose runtime version overrides from official publish entrypoints', () => {
    const bash = readFileSync('publish_managed_codex_runtime.sh', 'utf8');
    const powershell = readFileSync('publish_managed_codex_runtime.ps1', 'utf8');

    expect(bash).not.toContain('--runtime-set');
    expect(bash).not.toContain('--codex-version');
    expect(bash).not.toContain('--skip-package');
    expect(powershell).not.toMatch(/\[string\]\$(?:RuntimeSet|CodexVersion)\b/);
    expect(powershell).not.toMatch(/\[switch\]\$SkipPackage\b/);
  });

  it('runs npm through npm-cli.js on Windows instead of spawning the shim', () => {
    const invocation = resolveSpawnInvocation('npm', ['view', '@openai/codex@0.0.0-test-win32-x64'], {
      platform: 'win32',
      nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      fileExists: (path: string) => path.endsWith('\\node_modules\\npm\\bin\\npm-cli.js'),
    });

    expect(invocation.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(invocation.args[0]).toBe('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');
    expect(invocation.args.slice(1)).toEqual(['view', '@openai/codex@0.0.0-test-win32-x64']);
    expect(invocation.displayCommand).toBe('npm');
    expect(invocation.displayArgs).toEqual(['view', '@openai/codex@0.0.0-test-win32-x64']);
  });

  it('runs npx through npx-cli.js on Windows instead of spawning the shim', () => {
    const invocation = resolveSpawnInvocation('npx', ['tauri', 'signer'], {
      platform: 'win32',
      nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      fileExists: (path: string) => path.endsWith('\\node_modules\\npm\\bin\\npx-cli.js'),
    });

    expect(invocation.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(invocation.args[0]).toBe('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js');
    expect(invocation.args.slice(1)).toEqual(['tauri', 'signer']);
    expect(invocation.displayCommand).toBe('npx');
  });

  it('keeps spawn errors visible while redacting sensitive args', () => {
    const message = formatCommandFailure('npm', ['view', '--token=secret-value'], {
      error: new Error('spawnSync npm ENOENT'),
      stdout: '',
      stderr: '',
    });

    expect(message).toContain('Command failed: npm view <redacted>');
    expect(message).toContain('spawnSync npm ENOENT');
    expect(message).not.toContain('secret-value');
  });
});
