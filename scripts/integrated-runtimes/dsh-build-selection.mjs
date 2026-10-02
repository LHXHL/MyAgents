import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const buildSelectionPath = (repoRoot) => resolve(
  repoRoot,
  "src-tauri/resources/integrated-runtimes/dsh-build-selection-v1.json",
);

export function readDshBuildSelection(repoRoot) {
  const path = buildSelectionPath(repoRoot);
  if (!existsSync(path)) return null;
  const selection = JSON.parse(readFileSync(path, "utf8"));
  if (selection.schemaVersion !== 1 || !["release", "local"].includes(selection.source)
    || !selection.lock || !selection.compatibility) {
    throw new Error(`Invalid DSH build selection: ${path}`);
  }
  return selection;
}

export function dshBuildDefines(repoRoot) {
  const selection = readDshBuildSelection(repoRoot);
  if (!selection) return {};
  return {
    __MYAGENTS_DSH_BUILD_LOCK__: JSON.stringify(selection.lock),
    __MYAGENTS_DSH_BUILD_COMPATIBILITY__: JSON.stringify(selection.compatibility),
  };
}
