import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type SessionStoreModule = typeof import("../SessionStore");

let testHome: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let store: SessionStoreModule;
let sessionsPath: string;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), "myagents-runtime-binding-migration-"));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  const myAgentsDir = join(testHome, ".myagents");
  mkdirSync(myAgentsDir, { recursive: true });
  sessionsPath = join(myAgentsDir, "sessions.json");
  writeFileSync(
    sessionsPath,
    JSON.stringify([
      {
        id: "builtin",
        agentDir: "/workspace",
        runtime: "builtin",
      },
      {
        id: "managed",
        agentDir: "/workspace",
        runtime: "codex",
        runtimeSource: "managed-provider",
      },
      {
        id: "illegal",
        agentDir: "/workspace",
        runtime: "gemini",
        runtimeSource: "managed-provider",
      },
      {
        id: "invalid-authoritative",
        agentDir: "/workspace",
        runtime: "builtin",
        runtimeBinding: {
          family: "integrated",
          id: "dsh",
          implementationVersion: "incomplete",
        },
      },
    ]),
    "utf8",
  );
  vi.resetModules();
  store = await import("../SessionStore");
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(testHome, { recursive: true, force: true });
});

describe("Session Runtime binding migration", () => {
  it("is atomic, semantic-preserving and restart-idempotent", async () => {
    expect(await store.migrateSessionRuntimeBindings()).toEqual({
      migratedSessions: 3,
      incompatibleSessions: 2,
    });
    const rows = JSON.parse(readFileSync(sessionsPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(rows[0]).toMatchObject({
      runtime: "builtin",
      runtimeBinding: { family: "integrated", id: "claude-agent-sdk" },
    });
    expect(rows[1]).toMatchObject({
      runtime: "codex",
      runtimeSource: "managed-provider",
      runtimeBinding: { family: "managed-provider", id: "managed-codex" },
    });
    expect(rows[2]).toMatchObject({
      runtime: "gemini",
      runtimeSource: "managed-provider",
      runtimeBindingCompatibility: {
        state: "incompatible",
        code: "unknown-legacy-runtime",
      },
    });
    expect(rows[3]).toMatchObject({
      runtime: "builtin",
      runtimeBindingCompatibility: {
        state: "incompatible",
        code: "invalid-runtime-binding",
      },
    });
    expect(rows[3].runtimeBinding).toEqual({
      family: "integrated",
      id: "dsh",
      implementationVersion: "incomplete",
    });

    expect(await store.migrateSessionRuntimeBindings()).toEqual({
      migratedSessions: 0,
      incompatibleSessions: 2,
    });
  });
});
