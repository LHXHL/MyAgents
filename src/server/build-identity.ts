import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import packageJson from '../../package.json';

export type SidecarBuildIdentity = Readonly<{
  version: string;
  mode: 'bundle' | 'source';
  capturedAt: string;
  commit: string | null;
  dirty: boolean | null;
}>;

declare const __MYAGENTS_BUILD_IDENTITY__: SidecarBuildIdentity | undefined;

// Capture source identity once at startup. Reading HEAD in a diagnostic request
// would misidentify an existing process after a checkout or commit.
function sourceIdentity(): SidecarBuildIdentity {
  let commit: string | null = null;
  let dirty: boolean | null = null;
  const entry = process.argv[1];
  if (entry && /[/\\]src[/\\]server[/\\]index\.ts$/.test(entry)) {
    const cwd = resolve(dirname(entry), '../..');
    try {
      const git = (args: string[]) => execFileSync('git', args, {
        cwd, encoding: 'utf8', timeout: 2_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      commit = git(['rev-parse', 'HEAD']);
      dirty = git(['status', '--porcelain']).length > 0;
    } catch { /* A source distribution need not include Git metadata. */ }
  }
  return Object.freeze({ version: packageJson.version, mode: 'source', capturedAt: new Date().toISOString(), commit, dirty });
}

export const SIDECAR_BUILD_IDENTITY: SidecarBuildIdentity = Object.freeze(
  typeof __MYAGENTS_BUILD_IDENTITY__ !== 'undefined' ? __MYAGENTS_BUILD_IDENTITY__ : sourceIdentity(),
);
export const SIDECAR_STARTED_AT = new Date().toISOString();
export const APP_BUILD_IDENTITY = Object.freeze({
  version: process.env.MYAGENTS_APP_VERSION ?? null,
  mode: process.env.MYAGENTS_APP_BUILD_MODE ?? null,
});
