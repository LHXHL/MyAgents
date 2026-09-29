export const CODEX_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isCanonicalCodexVersion(value) {
  return typeof value === 'string'
    && value.trim() === value
    && CODEX_VERSION_RE.test(value);
}

export function resolveManagedCodexPackageIdentity({
  lockedVersion,
  requestedVersion,
  allowUnsigned,
}) {
  if (!isCanonicalCodexVersion(lockedVersion)) {
    throw new Error('Managed Codex runtime lock requires a canonical semver version');
  }
  if (!isCanonicalCodexVersion(requestedVersion)) {
    throw new Error(`Invalid Codex version: ${requestedVersion}`);
  }
  if (!allowUnsigned && requestedVersion !== lockedVersion) {
    throw new Error(
      `Signed Managed Codex packages must use locked version ${lockedVersion}; `
      + 'version overrides are only allowed with --allow-unsigned',
    );
  }
  return {
    codexVersion: requestedVersion,
    runtimeSet: `codex-${requestedVersion}`,
  };
}

export function shouldSignManagedCodexPackage({ allowUnsigned }) {
  return allowUnsigned !== true;
}

// This is an exact inventory of the pinned upstream package, not a directory
// allowlist. Voice dylibs are executable code and must retain OpenAI signatures.
export function macNativePathPolicy(platform) {
  if (platform !== 'darwin-arm64' && platform !== 'darwin-x64') {
    throw new Error(`Unsupported Managed Codex macOS platform: ${platform}`);
  }
  const vendorTriple = platform === 'darwin-arm64'
    ? 'aarch64-apple-darwin'
    : 'x86_64-apple-darwin';
  const root = `vendor/${vendorTriple}`;
  const codexPath = `${root}/bin/codex`;
  const voicePaths = [
    'bin/codex-voice-host',
    'lib/libffi.8.dylib',
    'lib/libgio-2.0.0.dylib',
    'lib/libglib-2.0.0.dylib',
    'lib/libgmodule-2.0.0.dylib',
    'lib/libgobject-2.0.0.dylib',
    'lib/libgstapp-1.0.0.dylib',
    'lib/libgstaudio-1.0.0.dylib',
    'lib/libgstbase-1.0.0.dylib',
    'lib/libgstnet-1.0.0.dylib',
    'lib/libgstpbutils-1.0.0.dylib',
    'lib/libgstreamer-1.0.0.dylib',
    'lib/libgstrtp-1.0.0.dylib',
    'lib/libgsttag-1.0.0.dylib',
    'lib/libgstvideo-1.0.0.dylib',
    'lib/libintl.8.dylib',
    'lib/libopus.0.dylib',
    'lib/libpcre2-8.0.dylib',
    'lib/libz.1.dylib',
    'plugins/libgstapp.dylib',
    'plugins/libgstaudioconvert.dylib',
    'plugins/libgstaudioresample.dylib',
    'plugins/libgstcoreelements.dylib',
    'plugins/libgstopus.dylib',
    'plugins/libgstrtp.dylib',
    'plugins/libgstrtpmanager.dylib',
  ];
  return {
    codexPath,
    openAiSignedPaths: new Set([
      codexPath,
      `${root}/bin/codex-code-mode-host`,
      ...voicePaths.map(path => `${root}/codex-resources/voice/${path}`),
    ]),
    helperPaths: new Set([
      `${root}/codex-path/rg`,
      `${root}/codex-resources/zsh/bin/zsh`,
    ]),
  };
}

export function windowsNativePathPolicy() {
  const vendorTriple = 'x86_64-pc-windows-msvc';
  const root = `vendor/${vendorTriple}`;
  const codexPath = `${root}/bin/codex.exe`;
  // Extracted from the pinned official package. DLLs are executable payload,
  // so new files still require an explicit inventory and publisher review.
  const voicePaths = [
    'codex-voice-host.exe',
    'gio-2.0-0.dll',
    'glib-2.0-0.dll',
    'gmodule-2.0-0.dll',
    'gobject-2.0-0.dll',
    'gstapp-1.0-0.dll',
    'gstapp.dll',
    'gstaudio-1.0-0.dll',
    'gstaudioconvert.dll',
    'gstaudioresample.dll',
    'gstbase-1.0-0.dll',
    'gstcoreelements.dll',
    'gstnet-1.0-0.dll',
    'gstopus.dll',
    'gstpbutils-1.0-0.dll',
    'gstreamer-1.0-0.dll',
    'gstrtp-1.0-0.dll',
    'gstrtp.dll',
    'gstrtpmanager.dll',
    'gsttag-1.0-0.dll',
    'gstvideo-1.0-0.dll',
    'intl-8.dll',
    'libffi-8.dll',
    'opus.dll',
    'pcre2-8.dll',
    'z.dll',
  ];
  return {
    codexPath,
    openAiSignedPaths: new Set([
      codexPath,
      `${root}/bin/codex-code-mode-host.exe`,
      `${root}/codex-resources/codex-command-runner.exe`,
      `${root}/codex-resources/codex-windows-sandbox-setup.exe`,
      ...voicePaths.map(path => `${root}/codex-resources/voice/bin/${path}`),
    ]),
    microsoftSignedPaths: new Set([
      `${root}/codex-resources/voice/bin/vcruntime140.dll`,
    ]),
    unsignedHelperPaths: new Set([
      `${root}/codex-path/rg.exe`,
    ]),
  };
}

/** The Microsoft CRT retains its own trust chain, not the Codex EXE's signer. */
export function windowsNativeSigningForPath(relativePath, openAiSigning) {
  const policy = windowsNativePathPolicy();
  if (policy.openAiSignedPaths.has(relativePath)) return openAiSigning;
  if (policy.microsoftSignedPaths.has(relativePath)) {
    return openAiSigning ? { type: 'authenticode', publisher: 'Microsoft Corporation' } : undefined;
  }
  throw new Error(`Managed Codex win32-x64 contains an unrecognized signed native file: ${relativePath}`);
}

export function validateManagedCodexNativePaths(platform, nativePaths) {
  const policy = platform.startsWith('darwin-')
    ? macNativePathPolicy(platform)
    : platform === 'win32-x64' ? windowsNativePathPolicy() : null;
  if (!policy) throw new Error(`Unsupported Managed Codex platform: ${platform}`);
  const expectedPaths = new Set([
    ...policy.openAiSignedPaths,
    ...(policy.microsoftSignedPaths ?? []),
    ...(policy.helperPaths ?? policy.unsignedHelperPaths),
  ]);
  if (
    nativePaths.length !== expectedPaths.size
    || new Set(nativePaths).size !== expectedPaths.size
    || nativePaths.some(path => !expectedPaths.has(path))
  ) {
    throw new Error(`Managed Codex ${platform} native file set changed: ${nativePaths.join(', ')}`);
  }
}

export function managedCodexMacHelperSigningCandidates({ teamId, signingIdentity }) {
  return [
    {
      action: 'preserved-upstream-openai-signature',
      signing: { type: 'codesign', teamId, signingIdentity },
    },
    {
      action: 'preserved-upstream-ad-hoc-signature',
      signing: { type: 'codesign', teamId: 'not set' },
    },
  ];
}

export function managedCodexSignerEnv(baseEnv) {
  const env = { ...baseEnv };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  delete env.TAURI_PRIVATE_KEY;
  const password = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? env.TAURI_PRIVATE_KEY_PASSWORD;
  if (password) env.TAURI_PRIVATE_KEY_PASSWORD = password;
  return env;
}
