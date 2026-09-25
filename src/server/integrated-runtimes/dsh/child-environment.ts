import { delimiter, dirname, isAbsolute, normalize } from "node:path";
import { isCliProductSessionId } from '../../../shared/cli-session-scope';
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
  sessionCli: Readonly<{ productSessionId: string; sidecarPort: number }> | null;
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
    const { productSessionId, sidecarPort } = options.sessionCli;
    if (!isCliProductSessionId(productSessionId)
      || !Number.isSafeInteger(sidecarPort) || sidecarPort < 1 || sidecarPort > 65_535) {
      throw new Error('DSH Product Session CLI route is missing or invalid');
    }
    // DSH admits these route identifiers into its Shell environment. Its
    // process policy rejects credential variables, so no CLI token crosses
    // into the Runtime or its Shell children.
    env.MYAGENTS_PORT = String(sidecarPort);
    env.MYAGENTS_SESSION_ID = productSessionId;
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
  return Object.freeze({
    env: Object.freeze(env),
    inheritedKeys: Object.freeze(inheritedKeys),
    allowedKeys: Object.freeze(Object.keys(env)),
  });
}
