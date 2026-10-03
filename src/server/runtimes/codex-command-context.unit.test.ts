import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureShellPath } from '../utils/shell';

vi.mock('../utils/shell', () => ({
  ensureShellPath: vi.fn(async () => process.env.Path ?? process.env.PATH ?? ''),
  getShellPath: () => process.env.Path ?? process.env.PATH ?? '',
  getShellEnv: () => ({ ...process.env }),
  getDetectedTerminalProxyEnv: () => ({}),
}));

import { MANAGED_CODEX_REQUIRED_RUNTIME } from '../../shared/config-types';
import {
  getManagedCodexHome,
  resolveCodexCommandContext,
} from './codex-command-context';

function platformKey(): string | null {
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') return 'darwin-arm64';
    if (process.arch === 'x64') return 'darwin-x64';
  }
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  return null;
}

function verifiedInstalledMetadata(platform: string, version = MANAGED_CODEX_REQUIRED_RUNTIME.version) {
  return {
    version,
    platform,
    manifestSignature: 'verified-manifest-signature',
    artifactSignatureVerified: true,
    platformSignature: process.platform === 'win32'
      ? { type: 'authenticode', certificateSha256: 'ab'.repeat(32) }
      : { type: 'codesign', teamId: '2DC432GLL2' },
  };
}

describe('codex command context', () => {
  let tempHome: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  });

  it('keeps system-cli on PATH resolution semantics', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'myagents-cli-selection-'));
    const selected = join(tempHome, 'selected');
    const fallback = join(tempHome, 'fallback');
    mkdirSync(selected);
    mkdirSync(fallback);
    const name = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    for (const dir of [selected, fallback]) {
      writeFileSync(join(dir, name), '');
      chmodSync(join(dir, name), 0o755);
    }
    vi.stubEnv(process.platform === 'win32' ? 'Path' : 'PATH', [selected, fallback].join(delimiter));
    // A first model request must wait for shell discovery before picking a CLI.
    let finishDiscovery!: () => void;
    vi.mocked(ensureShellPath).mockImplementationOnce(() => new Promise<string>(resolve => {
      finishDiscovery = () => resolve(process.env.Path ?? process.env.PATH ?? '');
    }));
    let settled = false;
    const resolving = resolveCodexCommandContext({ source: 'system-cli' }).then(value => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishDiscovery();
    const context = await resolving;
    expect(context.commandPath).toBe(join(selected, name));
    expect(context.env.Path ?? context.env.PATH).toBe([selected, fallback].join(delimiter));
    expect(context.source).toBe('system-cli');
    expect(context.codexHome).toBeUndefined();
    expect(context.commandPath).toBeTruthy();
  });

  it('keeps the desired update target out of Managed Codex launch admission', () => {
    const adapterSource = readFileSync(new URL('codex.ts', import.meta.url), 'utf8');

    expect(adapterSource).not.toContain('MANAGED_CODEX_REQUIRED_RUNTIME');
    expect(adapterSource).not.toContain('assertManagedCodexRuntimeConformanceVersion');
  });

  it('uses managed runtime path and isolated CODEX_HOME for managed-provider', async () => {
    const platform = platformKey();
    if (!platform) {
      await expect(resolveCodexCommandContext({ source: 'managed-provider' }))
        .rejects.toThrow(/not supported/i);
      return;
    }

    tempHome = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);
    vi.stubEnv('OPENAI_API_KEY', 'must-not-leak');
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'must-not-leak');
    vi.stubEnv('CODEX_HOME', '/tmp/user-codex-home');
    vi.stubEnv('MYAGENTS_PORT', '31415');
    vi.stubEnv('MYAGENTS_MANAGEMENT_PORT', '27182');
    vi.stubEnv('MYAGENTS_VERSION', '9.9.9-test');
    vi.stubEnv('MYAGENTS_INTERNAL_CLI_TOKEN', 'internal-sidecar-capability');

    const installDir = join(
      tempHome,
      '.myagents',
      'runtimes',
      'codex',
      MANAGED_CODEX_REQUIRED_RUNTIME.version,
      platform,
    );
    mkdirSync(installDir, { recursive: true });
    const binary = join(installDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    writeFileSync(binary, '');
    const root = join(tempHome, '.myagents', 'runtimes', 'codex');
    writeFileSync(join(root, 'installed.json'), JSON.stringify({
      ...verifiedInstalledMetadata(platform),
      executableRelativePath: process.platform === 'win32' ? 'codex.exe' : 'codex',
    }));

    const context = await resolveCodexCommandContext({ source: 'managed-provider' });

    expect(context.source).toBe('managed-provider');
    expect(context.commandPath).toBe(binary);
    expect(context.codexHome).toBe(getManagedCodexHome());
    expect(context.env.CODEX_HOME).toBe(getManagedCodexHome());
    expect(context.env.OPENAI_API_KEY).toBeUndefined();
    expect(context.env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(context.env.MYAGENTS_PORT).toBe('31415');
    expect(context.env.MYAGENTS_MANAGEMENT_PORT).toBe('27182');
    expect(context.env.MYAGENTS_VERSION).toBe('9.9.9-test');
    expect(context.env.MYAGENTS_INTERNAL_CLI_TOKEN).toBe('internal-sidecar-capability');
    const rules = readFileSync(join(getManagedCodexHome(), 'rules', 'myagents.rules'), 'utf-8');
    expect(rules).toContain('prefix_rule(pattern=["myagents"], decision="allow")');
    expect(rules).toContain(JSON.stringify(join(tempHome, '.myagents', 'bin', process.platform === 'win32' ? 'myagents.cmd' : 'myagents')));
  });

  it('prefers executableRelativePath from managed installed metadata', async () => {
    const platform = platformKey();
    if (!platform) return;

    tempHome = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);

    const root = join(tempHome, '.myagents', 'runtimes', 'codex');
    const installDir = join(root, MANAGED_CODEX_REQUIRED_RUNTIME.version, platform);
    const nestedDir = join(installDir, 'package', 'bin');
    mkdirSync(nestedDir, { recursive: true });
    const binary = join(nestedDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    writeFileSync(binary, '');
    writeFileSync(join(root, 'installed.json'), JSON.stringify({
      ...verifiedInstalledMetadata(platform),
      executableRelativePath: process.platform === 'win32' ? 'package/bin/codex.exe' : 'package/bin/codex',
    }));

    const context = await resolveCodexCommandContext({ source: 'managed-provider' });

    expect(context.commandPath).toBe(binary);
  });

  it('keeps a verified stale runtime available until a new Sidecar starts after update', async () => {
    const platform = platformKey();
    if (!platform) return;

    tempHome = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);

    const staleVersion = '0.146.0';
    const root = join(tempHome, '.myagents', 'runtimes', 'codex');
    const installDir = join(root, staleVersion, platform);
    mkdirSync(installDir, { recursive: true });
    const binary = join(installDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    writeFileSync(binary, '');
    writeFileSync(join(root, 'installed.json'), JSON.stringify({
      ...verifiedInstalledMetadata(platform, staleVersion),
      executableRelativePath: process.platform === 'win32' ? 'codex.exe' : 'codex',
    }));

    const context = await resolveCodexCommandContext({ source: 'managed-provider' });

    expect(staleVersion).not.toBe(MANAGED_CODEX_REQUIRED_RUNTIME.version);
    expect(context.commandPath).toBe(binary);
    expect(context.version).toBe(staleVersion);
  });

  it('does not launch an unverified stale runtime', async () => {
    const platform = platformKey();
    if (!platform) return;

    tempHome = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);

    const staleVersion = '0.0.0-unverified';
    const root = join(tempHome, '.myagents', 'runtimes', 'codex');
    const installDir = join(root, staleVersion, platform);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, process.platform === 'win32' ? 'codex.exe' : 'codex'), '');
    writeFileSync(join(root, 'installed.json'), JSON.stringify({
      version: staleVersion,
      platform,
      executableRelativePath: process.platform === 'win32' ? 'codex.exe' : 'codex',
    }));

    await expect(resolveCodexCommandContext({ source: 'managed-provider' }))
      .rejects.toThrow(/not installed/i);
  });

  it.runIf(process.platform === 'win32')('accepts legacy Windows separators in managed installed metadata', async () => {
    const platform = platformKey();
    if (!platform) return;

    tempHome = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);

    const root = join(tempHome, '.myagents', 'runtimes', 'codex');
    const installDir = join(root, MANAGED_CODEX_REQUIRED_RUNTIME.version, platform);
    const nestedDir = join(installDir, 'vendor', 'x86_64-pc-windows-msvc', 'bin');
    mkdirSync(nestedDir, { recursive: true });
    const binary = join(nestedDir, 'codex.exe');
    writeFileSync(binary, '');
    writeFileSync(join(root, 'installed.json'), JSON.stringify({
      ...verifiedInstalledMetadata(platform),
      executableRelativePath: 'vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
    }));

    const context = await resolveCodexCommandContext({ source: 'managed-provider' });

    expect(context.commandPath).toBe(binary);
  });

  it.runIf(process.platform === 'win32')('rejects traversal in legacy Windows metadata paths', async () => {
    const platform = platformKey();
    if (!platform) return;

    tempHome = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);

    const root = join(tempHome, '.myagents', 'runtimes', 'codex');
    const installDir = join(root, MANAGED_CODEX_REQUIRED_RUNTIME.version, platform);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(root, 'installed.json'), JSON.stringify({
      ...verifiedInstalledMetadata(platform),
      executableRelativePath: '..\\codex.exe',
    }));

    await expect(resolveCodexCommandContext({ source: 'managed-provider' }))
      .rejects.toThrow(/not installed/i);
  });

  it('rejects traversal in the installed runtime version', async () => {
    const platform = platformKey();
    if (!platform) return;

    tempHome = mkdtempSync(join(tmpdir(), 'myagents-managed-codex-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);

    const root = join(tempHome, '.myagents', 'runtimes', 'codex');
    const escapedDir = join(root, '..', platform);
    mkdirSync(escapedDir, { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(escapedDir, process.platform === 'win32' ? 'codex.exe' : 'codex'), '');
    writeFileSync(join(root, 'installed.json'), JSON.stringify({
      ...verifiedInstalledMetadata(platform, '..'),
      executableRelativePath: process.platform === 'win32' ? 'codex.exe' : 'codex',
    }));

    await expect(resolveCodexCommandContext({ source: 'managed-provider' }))
      .rejects.toThrow(/not installed/i);
  });
});
