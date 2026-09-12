import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { SessionMetadata } from '../../types/session';
import type { SessionDeleteResult } from '../../SessionStore';
import { isSystemMaintenanceSession } from '../../../shared/managedScheduledJob';
import { parseEffectiveRuntimeBinding } from '../../../shared/integrated-runtimes/identity';
import { isCliProductSessionId } from '../../../shared/cli-session-scope';
import { dshSessionOwnedPaths } from './owned-paths';

type Binding = NonNullable<SessionMetadata['runtimeBinding']>;
type ResetEntry = Readonly<{
  id: string;
  binding: Binding;
  remove: readonly string[];
  preserveShared: readonly string[];
}>;
export type DshDevelopmentResetPlan = Readonly<{
  version: 1;
  target: '0.1.5-rc.2';
  dataRoot: string;
  indexSha256: string;
  sessions: readonly ResetEntry[];
  sha256: string;
}>;
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const absent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const stat = async (path: string) => lstat(path).catch(error => { if (absent(error)) return undefined; throw error; });

/** Offline maintenance only. Reject links and mounts before any recursive removal. */
async function verifyPath(dataRoot: string, path: string, recursive = true): Promise<void> {
  const rel = relative(dataRoot, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Development reset path escapes its owned root');
  const root = await stat(dataRoot);
  if (!root) return;
  if (!root.isDirectory() || root.isSymbolicLink() || await realpath(dataRoot) !== dataRoot) throw new Error('Development reset data root is not canonical');
  let current = dataRoot;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    const entry = await stat(current);
    if (!entry) return;
    if (entry.isSymbolicLink() || entry.dev !== root.dev) throw new Error('Development reset refuses links or mounted paths');
  }
  if (!recursive) return;
  let remaining = 100_000;
  const visit = async (entryPath: string): Promise<void> => {
    if (--remaining < 0) throw new Error('Development reset tree exceeds its inspection bound');
    const entry = await lstat(entryPath);
    if (entry.isSymbolicLink() || entry.dev !== root.dev) throw new Error('Development reset refuses links or mounted paths');
    if (entry.isDirectory()) for (const child of await readdir(entryPath)) await visit(join(entryPath, child));
    else if (!entry.isFile()) throw new Error('Development reset refuses non-file owned data');
  };
  await visit(path);
}

async function boundedText(path: string): Promise<string | undefined> {
  const entry = await stat(path);
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 8 * 1024 * 1024) throw new Error('Development reset input is not a bounded regular file');
  return readFile(path, 'utf8');
}

/** Inspect only for shared attachment references; no text is logged or copied into the plan. */
async function sharedAttachmentRoots(dataRoot: string, survivors: readonly SessionMetadata[], roots: readonly string[]): Promise<Set<string>> {
  const shared = new Set<string>();
  if (roots.length === 0) return shared;
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      const normalized = value.replaceAll('\\', '/');
      for (const root of roots) {
        const suffix = relative(dataRoot, root).replaceAll('\\', '/');
        if (normalized.includes(`${suffix}/`) || normalized.endsWith(suffix)) shared.add(root);
      }
    } else if (Array.isArray(value)) for (const child of value) scan(child);
    else if (value && typeof value === 'object') for (const child of Object.values(value)) scan(child);
  };
  for (const session of survivors) {
    if (!isCliProductSessionId(session.id)) return new Set(roots);
    for (const extension of ['jsonl', 'json']) {
      const path = join(dataRoot, 'sessions', `${session.id}.${extension}`);
      try {
        await verifyPath(dataRoot, path, false);
        const text = await boundedText(path);
        if (text === undefined) continue;
        if (extension === 'json') scan(JSON.parse(text) as unknown);
        else for (const line of text.split('\n')) if (line.trim()) scan(JSON.parse(line) as unknown);
      } catch { return new Set(roots); } // Ambiguous reference ownership preserves all shared candidates.
    }
  }
  return shared;
}

export async function planDshDevelopmentReset(dataRoot: string): Promise<DshDevelopmentResetPlan> {
  if (!isAbsolute(dataRoot)) throw new Error('Development reset requires an absolute data root');
  for (const name of ['sessions.json', 'sessions.json.tmp', 'sessions.lock']) await verifyPath(dataRoot, join(dataRoot, name), false);
  const index = await boundedText(join(dataRoot, 'sessions.json'));
  const parsed: unknown = index === undefined ? [] : JSON.parse(index);
  if (!Array.isArray(parsed) || parsed.length > 10_000) throw new Error('Development reset requires a valid bounded Session index');
  const sessions = parsed as SessionMetadata[];
  const ids = new Set<string>();
  const selected: SessionMetadata[] = [];
  for (const session of sessions) {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || ids.has(session.id)) throw new Error('Development reset found invalid or duplicate Session identity');
    ids.add(session.id);
    const binding = session.runtimeBinding;
    if (binding?.family === 'integrated' && binding.id === 'dsh') {
      if (!isCliProductSessionId(session.id) || typeof binding.protocolVersion !== 'string') throw new Error('Development reset found an invalid DSH identity');
      if (/^[234]\./u.test(binding.protocolVersion)) {
        const parsedBinding = parseEffectiveRuntimeBinding(binding);
        if (!parsedBinding || isSystemMaintenanceSession(session)) throw new Error('Development reset found a protected or invalid DSH binding');
        selected.push({ ...session, runtimeBinding: parsedBinding });
      }
      else if (!/^5\./u.test(binding.protocolVersion)) throw new Error('Development reset found an unknown DSH protocol');
    } else if (session.runtime === 'dsh') throw new Error('Development reset requires an explicit authoritative DSH binding');
  }
  const selectedIds = new Set(selected.map(session => session.id));
  const hasReference = (value: unknown): boolean => typeof value === 'string' ? selectedIds.has(value)
    : Array.isArray(value) ? value.some(hasReference)
    : !!value && typeof value === 'object' && Object.entries(value).some(([key, child]) => selectedIds.has(key) || hasReference(child));
  if (selected.length) for (const name of ['session_goals.json', 'tasks.jsonl']) {
    const path = join(dataRoot, name);
    await verifyPath(dataRoot, path, false);
    const text = await boundedText(path);
    if (text === undefined) continue;
    const value: unknown = name.endsWith('.jsonl') ? text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as unknown) : JSON.parse(text);
    if (hasReference(value)) throw new Error('Development reset requires selected Sessions to have no retained Task or Goal reference');
  }
  const possibleCandidates = selected.flatMap(session => [join(dataRoot, 'attachments', session.id), join(dataRoot, 'generated', 'tool-attachments', session.id)]);
  const existingCandidates = await Promise.all(possibleCandidates.map(async path => await stat(path) ? path : undefined));
  const candidates = existingCandidates.filter((path): path is string => path !== undefined);
  const shared = selected.length ? await sharedAttachmentRoots(dataRoot, sessions.filter(session => !selectedIds.has(session.id)), candidates) : new Set<string>();
  const entries: ResetEntry[] = [];
  for (const session of selected.sort((a, b) => a.id.localeCompare(b.id))) {
    const owned = dshSessionOwnedPaths(dataRoot, session.id);
    const attachmentCandidates = [join(dataRoot, 'attachments', session.id), join(dataRoot, 'generated', 'tool-attachments', session.id)];
    const remove = [owned.runtimeHome, owned.attachmentRoot, ...attachmentCandidates.filter(path => !shared.has(path))];
    // SessionStore owns actual transcript deletion and the file-lock -> index-lock order.
    for (const path of [...remove, join(dataRoot, 'sessions', `${session.id}.jsonl`), join(dataRoot, 'sessions', `${session.id}.json`), join(dataRoot, 'session-locks', `${session.id}.jsonl.lock`)]) await verifyPath(dataRoot, path);
    entries.push(Object.freeze({ id: session.id, binding: Object.freeze({ ...session.runtimeBinding! }), remove: Object.freeze(remove), preserveShared: Object.freeze(attachmentCandidates.filter(path => shared.has(path))) }));
  }
  const content = { version: 1 as const, target: '0.1.5-rc.2' as const, dataRoot, indexSha256: digest(index ?? ''), sessions: Object.freeze(entries) };
  return Object.freeze({ ...content, sha256: digest(JSON.stringify(content)) });
}

export async function applyDshDevelopmentReset(
  plan: DshDevelopmentResetPlan,
  resetSession: (id: string, binding: Binding, removeOwnedData: () => Promise<void>) => Promise<SessionDeleteResult>,
  assertStopped: () => Promise<void>,
): Promise<Readonly<{ deleted: number; preservedSharedRoots: number }>> {
  await assertStopped();
  const current = await planDshDevelopmentReset(plan.dataRoot);
  if (current.sha256 !== plan.sha256) throw new Error('Development reset plan changed; inspect a fresh plan');
  let deleted = 0;
  for (const session of current.sessions) {
    const result = await resetSession(session.id, session.binding, async () => {
      await assertStopped();
      for (const path of session.remove) await verifyPath(plan.dataRoot, path);
      for (const path of session.remove) await rm(path, { recursive: true, force: true });
    });
    if (!result.deleted && result.reason !== 'not-found') throw new Error(`Development reset stopped after ${deleted} Sessions: ${result.reason}`);
    if (result.deleted) deleted += 1;
  }
  return Object.freeze({ deleted, preservedSharedRoots: current.sessions.reduce((count, session) => count + session.preserveShared.length, 0) });
}

/** Known app, production/development Sidecar and packed Runtime entrypoints. */
export function isDshDevelopmentWriterCommand(command: string): boolean {
  return /(?:^|[/\\])(?:myagents(?:[-_]desktop)?)(?:\.exe)?(?:\s|$)|runtime-server-process\.artifact\.mjs|[/\\](?:src[/\\]server[/\\]index\.ts|(?:dist[/\\])?server(?:-dist)?(?:[/\\]index)?\.[cm]?[jt]s)(?:\s|$)/iu.test(command);
}
