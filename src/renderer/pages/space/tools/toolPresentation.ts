import type { SpaceToolRevision } from "@/api/spaceCloud";
import {
  formatPortableCommand,
  type PortableMcpManifestV1,
} from "../../../../shared/spaceToolManifest";

/*
 * Presentation-only derivations for Space Tools. They summarise a portable
 * MCP manifest into what a member needs to decide and prepare; the full
 * manifest stays available in the folded raw view. Nothing here changes how
 * an MCP is launched or installed.
 */

const PLACEHOLDER = /\{\{[A-Z][A-Z0-9_]{0,127}\}\}/g;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Package runners and the runtime a member must already have. `npx` maps to
 * null because `resolveNpxMcpInvocation` falls back to the bundled Node.
 */
const PACKAGE_RUNNERS: Record<string, { runtime: string | null; subcommand?: string }> = {
  npx: { runtime: null },
  bunx: { runtime: "Bun" },
  pnpm: { runtime: "pnpm", subcommand: "dlx" },
  uvx: { runtime: "uv" },
  pipx: { runtime: "pipx", subcommand: "run" },
};
const PACKAGE_VALUE_FLAGS = new Set(["--package", "-p", "--from"]);
const DOCKER_VALUE_FLAGS = new Set([
  "-e",
  "--env",
  "--env-file",
  "-v",
  "--volume",
  "--mount",
  "--name",
  "-p",
  "--publish",
  "--network",
  "--entrypoint",
  "-w",
  "--workdir",
  "-u",
  "--user",
  "--platform",
  "-l",
  "--label",
]);

export type ToolRunSummary =
  | { kind: "remote"; host: string; transport: "http" | "sse"; full: string }
  | { kind: "localService"; port: string; transport: "http" | "sse"; full: string }
  | { kind: "package"; runner: string; packageName: string; runtime: string | null; full: string }
  | { kind: "docker"; image: string; full: string }
  | { kind: "command"; command: string; full: string };

function parseTemplateUrl(template: string): URL | null {
  try {
    return new URL(template.replace(PLACEHOLDER, "placeholder"));
  } catch {
    return null;
  }
}

/** Host as written in the template, so `{{TENANT}}.example.com` stays readable. */
function templateHost(template: string): string | null {
  return template.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i)?.[1] ?? null;
}

function packageNameFrom(args: string[], subcommand?: string): string | null {
  // `pnpm` / `pipx` only run a package through their `dlx` / `run` subcommand.
  if (subcommand && args[0] !== subcommand) return null;
  const rest = subcommand ? args.slice(1) : args;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (PACKAGE_VALUE_FLAGS.has(arg)) return rest[index + 1] ?? null;
    const inline = arg.match(/^--(?:package|from)=(.+)$/);
    if (inline) return inline[1]!;
  }
  return rest.find((arg) => !arg.startsWith("-")) ?? null;
}

function dockerImageFrom(args: string[]): string | null {
  const start = args[0] === "run" ? 1 : 0;
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index]!;
    if (DOCKER_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

export function summarizeToolRun(manifest: PortableMcpManifestV1): ToolRunSummary {
  if (manifest.remote) {
    const transport = manifest.transport === "sse" ? "sse" : "http";
    const full = manifest.remote.urlTemplate;
    const url = parseTemplateUrl(full);
    if (url && LOCAL_HOSTS.has(url.hostname)) {
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      return { kind: "localService", port, transport, full };
    }
    return { kind: "remote", host: templateHost(full) ?? full, transport, full };
  }
  const command = manifest.stdio?.command ?? "";
  const args = manifest.stdio?.args ?? [];
  const full = formatPortableCommand(command, args);
  const runner = PACKAGE_RUNNERS[command];
  if (runner) {
    const packageName = packageNameFrom(args, runner.subcommand);
    if (packageName) {
      return { kind: "package", runner: command, packageName, runtime: runner.runtime, full };
    }
  }
  if (command === "docker") {
    const image = dockerImageFrom(args);
    if (image) return { kind: "docker", image, full };
  }
  return { kind: "command", command, full };
}

export type ToolConfigKeyUsage =
  | { kind: "header"; name: string }
  | { kind: "env" }
  | { kind: "url" }
  | { kind: "argument" };

export function configKeyUsage(
  manifest: PortableMcpManifestV1,
  key: string,
): ToolConfigKeyUsage {
  const token = `{{${key}}}`;
  if (manifest.remote) {
    const header = Object.entries(manifest.remote.headerTemplates).find(
      ([, value]) => value.includes(token),
    );
    if (header) return { kind: "header", name: header[0] };
    return { kind: "url" };
  }
  const env = Object.values(manifest.stdio?.envTemplates ?? {}).some((value) =>
    value.includes(token),
  );
  return env ? { kind: "env" } : { kind: "argument" };
}

export type ToolRevisionChangeField =
  | "name"
  | "description"
  | "credentials"
  | "run"
  | "instruction";

export type ToolRevisionChange =
  | { kind: "first" }
  | { kind: "unknown" }
  | { kind: "unchanged" }
  | { kind: "changed"; fields: ToolRevisionChangeField[] };

function runIdentity(manifest: PortableMcpManifestV1 | null | undefined): string {
  if (!manifest) return "";
  return JSON.stringify({
    transport: manifest.transport,
    command: manifest.stdio
      ? [manifest.stdio.command, ...manifest.stdio.args]
      : null,
    url: manifest.remote?.urlTemplate ?? null,
  });
}

/**
 * What changed in `revision` relative to the next older loaded revision.
 * Revision 1 is the first publish; an older page that is not loaded yet
 * yields `unknown` instead of guessing.
 */
export function describeRevisionChange(
  revision: SpaceToolRevision,
  previous: SpaceToolRevision | undefined,
): ToolRevisionChange {
  if (revision.revision === 1) return { kind: "first" };
  if (!previous) return { kind: "unknown" };
  const fields: ToolRevisionChangeField[] = [];
  if (revision.name !== previous.name) fields.push("name");
  if ((revision.description ?? "") !== (previous.description ?? "")) {
    fields.push("description");
  }
  const current = revision.portableMcpManifest;
  const older = previous.portableMcpManifest;
  if (current || older) {
    if (
      JSON.stringify(current?.requiredConfigKeys ?? []) !==
      JSON.stringify(older?.requiredConfigKeys ?? [])
    ) {
      fields.push("credentials");
    }
    if (runIdentity(current) !== runIdentity(older)) fields.push("run");
    // Env / header template edits have no field of their own; never report
    // a changed manifest as "unchanged".
    if (
      !fields.includes("credentials") &&
      !fields.includes("run") &&
      JSON.stringify(current ?? null) !== JSON.stringify(older ?? null)
    ) {
      fields.push("run");
    }
  }
  if (
    (revision.customInstallInstruction ?? "") !==
    (previous.customInstallInstruction ?? "")
  ) {
    fields.push("instruction");
  }
  return fields.length ? { kind: "changed", fields } : { kind: "unchanged" };
}

/** Theme tokens for monogram tool icons; every production Theme defines them. */
const MONOGRAM_TONES = [
  "var(--accent-warm)",
  "var(--accent-cool)",
  "var(--info)",
  "var(--success)",
  "var(--heartbeat)",
] as const;

export function toolMonogram(name: string): { character: string; color: string } {
  const character =
    name.trim().match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() ?? "?";
  let hash = 0;
  for (const unit of name) hash = (hash * 31 + unit.codePointAt(0)!) >>> 0;
  return { character, color: MONOGRAM_TONES[hash % MONOGRAM_TONES.length]! };
}
