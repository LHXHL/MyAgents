import { delimiter, dirname, isAbsolute, normalize } from "node:path";
import { isCliProductSessionId } from '../../../shared/cli-session-scope';
import { INTERNAL_CLI_TOKEN_ENV } from '../../../shared/externalCliCapabilities';
import { PROXY_ENV_KEYS } from '../../../shared/proxyScope';

const SAFE_INHERITED_ENVIRONMENT_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

export type DshChildEnvironment = Readonly<{
  env: Readonly<NodeJS.ProcessEnv>;
  inheritedKeys: readonly string[];
  allowedKeys: readonly string[];
}>;

function safeEnvironmentValue(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.includes("\0")
  ) {
    return undefined;
  }
  return value;
}

/** Build the complete environment for the DSH child; never spread process.env. */
export function buildDshChildEnvironment(options: {
  nodeExecutablePath: string;
  commandDirectories?: readonly string[];
  inheritedEnvironment?: Readonly<NodeJS.ProcessEnv>;
  proxyEnvironment?: Readonly<NodeJS.ProcessEnv>;
  platform?: string;
  sessionCli: Readonly<{ productSessionId: string; sidecarPort: number; internalCliToken: string }> | null;
}): DshChildEnvironment {
  if (!isAbsolute(options.nodeExecutablePath)) {
    throw new Error("DSH bundled Node path must be absolute");
  }
  const pathEntries = [
    dirname(normalize(options.nodeExecutablePath)),
    ...(options.commandDirectories ?? []),
  ];
  if (pathEntries.some((entry) => !isAbsolute(entry))) {
    throw new Error("DSH sealed command directories must be absolute");
  }
  const uniquePathEntries = [...new Set(pathEntries.map(normalize))];
  const source = options.inheritedEnvironment ?? process.env;
  const env: NodeJS.ProcessEnv = {
    PATH: uniquePathEntries.join(delimiter),
  };
  if (options.sessionCli !== null) {
    const { productSessionId, sidecarPort, internalCliToken } = options.sessionCli;
    if (!isCliProductSessionId(productSessionId)
      || !Number.isSafeInteger(sidecarPort) || sidecarPort < 1 || sidecarPort > 65_535) {
      throw new Error('DSH Product Session CLI route is missing or invalid');
    }
    if (safeEnvironmentValue(internalCliToken)?.trim() !== internalCliToken) {
      throw new Error('DSH internal CLI capability is missing or invalid');
    }
    // The Session owner supplies the App-lifecycle internal CLI capability;
    // ambient or external CLI credentials cannot select this command surface.
    env.MYAGENTS_PORT = String(sidecarPort);
    env.MYAGENTS_SESSION_ID = productSessionId;
    env[INTERNAL_CLI_TOKEN_ENV] = internalCliToken;
  }
  const inheritedKeys: string[] = [];
  for (const key of SAFE_INHERITED_ENVIRONMENT_KEYS) {
    const value = safeEnvironmentValue(source[key]);
    if (value === undefined) continue;
    env[key] = value;
    inheritedKeys.push(key);
  }
  // The Host selects general scope explicitly; ambient or Provider-owned env
  // must never become the authority for Shell network access.
  for (const key of PROXY_ENV_KEYS) {
    const value = safeEnvironmentValue(options.proxyEnvironment?.[key]);
    if (value !== undefined) env[key] = value;
  }
  // Windows process creation treats environment names case-insensitively. Node
  // keeps one spelling when spawning, while DSH checks the declared keys with
  // exact casing. Seal the same key set that the child can actually receive.
  const sealedEnv: NodeJS.ProcessEnv = {};
  const windows = (options.platform ?? process.platform) === 'win32';
  const seenWindowsKeys = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    const foldedKey = key.toUpperCase();
    if (windows && seenWindowsKeys.has(foldedKey)) continue;
    seenWindowsKeys.add(foldedKey);
    sealedEnv[key] = value;
  }
  return Object.freeze({
    env: Object.freeze(sealedEnv),
    inheritedKeys: Object.freeze(inheritedKeys.filter(key => Object.hasOwn(sealedEnv, key))),
    allowedKeys: Object.freeze(Object.keys(sealedEnv)),
  });
}
