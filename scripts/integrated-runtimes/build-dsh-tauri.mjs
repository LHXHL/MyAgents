#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { currentTarget, prepareDshRuntime } from "./prepare-dsh-runtime.mjs";

const args = process.argv.slice(2);
const targetIndex = args.indexOf("--target");
const triple = targetIndex < 0 ? undefined : args[targetIndex + 1];
const requestedTarget = triple?.includes("apple-darwin")
  ? `darwin-${triple.startsWith("aarch64") ? "arm64" : "x64"}`
  : triple?.includes("windows") ? "win32-x64"
    : triple?.includes("linux") ? "linux-x64" : currentTarget();

try {
  if (targetIndex >= 0 && (!triple || requestedTarget !== currentTarget())) {
    throw new Error("Cross-target DSH builds must use the platform build script, which stages target-specific Node and native resources");
  }
  await prepareDshRuntime({ source: "release", target: requestedTarget });
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "tauri:build:prepared", "--", ...args], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
