import { delimiter, dirname, isAbsolute, normalize } from "node:path";

const SAFE_INHERITED_ENVIRONMENT_KEYS = [
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
  const inheritedKeys: string[] = [];
  for (const key of SAFE_INHERITED_ENVIRONMENT_KEYS) {
    const value = safeEnvironmentValue(source[key]);
    if (value === undefined) continue;
    env[key] = value;
    inheritedKeys.push(key);
  }
  return Object.freeze({
    env: Object.freeze(env),
    inheritedKeys: Object.freeze(inheritedKeys),
    allowedKeys: Object.freeze(Object.keys(env)),
  });
}
