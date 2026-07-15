export type FileChangeKind =
  | string
  | {
      type?: string | null;
      move_path?: string | null;
    }
  | null
  | undefined;

export interface FileChangeLike {
  path?: string;
  kind?: FileChangeKind;
  diff?: string;
}

export interface FileChangeDiffStats {
  added: number;
  removed: number;
}

export interface FileChangeSummary extends FileChangeDiffStats {
  files: number;
}

export type ToolInputRecord = Record<string, unknown>;
export type FilePatchViewKind = 'old-new' | 'content' | 'unified-diff';
export type FilePatchSource = 'builtin' | 'codex' | 'external' | 'unknown';

export interface FilePatchChangeDescriptor extends FileChangeDiffStats {
  kind: string;
  path?: string;
  movePath?: string;
  written?: number;
  view: {
    kind: FilePatchViewKind;
  };
}

export interface FilePatchDisplayDescriptor {
  kind: 'file_patch';
  version: 1;
  source: FilePatchSource;
  status?: string;
  replaceAll?: boolean;
  userModified?: boolean;
  writeMode?: FilePatchWriteMode;
  summary: FileChangeSummary;
  changes: FilePatchChangeDescriptor[];
}

export interface FilePatchOldNewView {
  kind: 'old-new';
  oldText: string;
  newText: string;
}

export interface FilePatchContentView {
  kind: 'content';
  content: string;
}

export interface FilePatchUnifiedDiffView {
  kind: 'unified-diff';
  diff: string;
}

export type FilePatchMaterializedView =
  | FilePatchOldNewView
  | FilePatchContentView
  | FilePatchUnifiedDiffView;

export interface FilePatchChange extends FileChangeDiffStats {
  kind: string;
  path?: string;
  movePath?: string;
  view: FilePatchMaterializedView;
}

export interface FilePatchDisplay {
  kind: 'file_patch';
  version: 1;
  source: FilePatchSource;
  status?: string;
  replaceAll?: boolean;
  userModified?: boolean;
  writeMode?: FilePatchWriteMode;
  summary: FileChangeSummary;
  changes: FilePatchChange[];
}

export type DiffRowKind = 'context' | 'add' | 'remove' | 'hunk' | 'omission';

export interface DiffRow {
  key: string;
  kind: DiffRowKind;
  oldLine?: number;
  newLine?: number;
  marker: '' | '+' | '-';
  text: string;
}

export type FilePatchLineNumbers = 'exact' | 'relative' | 'unavailable';
export type FilePatchWriteMode = 'create' | 'update' | 'unknown';

export interface FilePatchRenderChange extends FileChangeDiffStats {
  kind: string;
  path?: string;
  movePath?: string;
  viewKind: FilePatchViewKind;
  rows: DiffRow[];
  rawPatch: string;
  lineNumbers: FilePatchLineNumbers;
  /** Number of target-content lines when Write semantics are unknown. */
  written?: number;
  detailUnavailable?: boolean;
}

export interface FilePatchRenderModel {
  kind: 'file_patch_render';
  source: FilePatchSource;
  status?: string;
  replaceAll?: boolean;
  userModified?: boolean;
  writeMode?: FilePatchWriteMode;
  summary: FileChangeSummary;
  changes: FilePatchRenderChange[];
}

export type ToolDisplayPayload = FilePatchDisplayDescriptor;

export interface FilePatchToolLike {
  name?: string;
  input?: unknown;
  inputJson?: string;
  parsedInput?: unknown;
  result?: string;
  isError?: boolean;
  resultMeta?: {
    status?: unknown;
  } | null;
  display?: unknown;
}

interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface SdkFilePatchResult {
  filePath?: string;
  oldString?: string;
  newString?: string;
  content?: string;
  originalFile?: string | null;
  structuredPatch: StructuredPatchHunk[];
  type?: 'create' | 'update';
  userModified?: boolean;
  replaceAll?: boolean;
  gitDiffPatch?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasInputFields(input: ToolInputRecord): boolean {
  return Object.keys(input).length > 0;
}

export function isToolInputRecord(value: unknown): value is ToolInputRecord {
  return isRecord(value);
}

function pushInputCandidate(candidates: ToolInputRecord[], seen: Set<ToolInputRecord>, value: unknown): void {
  if (!isToolInputRecord(value) || !hasInputFields(value) || seen.has(value)) return;
  seen.add(value);
  candidates.push(value);
}

export function resolveToolInputRecords(tool: FilePatchToolLike): ToolInputRecord[] {
  const candidates: ToolInputRecord[] = [];
  const seen = new Set<ToolInputRecord>();
  if (typeof tool.inputJson === 'string') {
    const raw = tool.inputJson.trim();
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        pushInputCandidate(candidates, seen, parsed);
      } catch {
        // Keep falling through to the raw input object.
      }
    }
  }
  pushInputCandidate(candidates, seen, tool.parsedInput);
  pushInputCandidate(candidates, seen, tool.input);
  return candidates;
}

export function resolveToolInputRecord(tool: FilePatchToolLike): ToolInputRecord | null {
  return resolveToolInputRecords(tool)[0] ?? null;
}

export function getInputStringProp(input: ToolInputRecord | null | undefined, key: string): string | undefined {
  if (!input) return undefined;
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function getBooleanProp(input: ToolInputRecord | null | undefined, key: string): boolean | undefined {
  if (!input) return undefined;
  const value = input[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function coerceFileChanges(value: unknown): FileChangeLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => ({
      ...(typeof item.path === 'string' ? { path: item.path } : {}),
      kind: item.kind as FileChangeKind,
      ...(typeof item.diff === 'string' ? { diff: item.diff } : {}),
    }));
}

export function fileChangeKindType(kind: FileChangeKind): string {
  if (typeof kind === 'string' && kind.trim()) return kind;
  if (kind && typeof kind === 'object' && typeof kind.type === 'string' && kind.type.trim()) {
    return kind.type;
  }
  return 'change';
}

export function fileChangeKindLabel(kind: FileChangeKind): string {
  if (fileChangeMovePath(kind)) return 'move';
  switch (fileChangeKindType(kind)) {
    case 'add':
      return 'add';
    case 'update':
      return 'update';
    case 'delete':
      return 'delete';
    case 'move':
      return 'move';
    default:
      return fileChangeKindType(kind);
  }
}

export function fileChangeMovePath(kind: FileChangeKind): string | null {
  if (kind && typeof kind === 'object' && typeof kind.move_path === 'string' && kind.move_path.trim()) {
    return kind.move_path;
  }
  return null;
}

export function countContentLines(content: string): number {
  if (!content) return 0;
  const parts = content.split('\n');
  return content.endsWith('\n') ? parts.length - 1 : parts.length;
}

export function countFileChangeDiffLines(change: FileChangeLike): FileChangeDiffStats {
  const diff = typeof change.diff === 'string' ? change.diff : '';
  if (!diff) return { added: 0, removed: 0 };
  const parsed = parseUnifiedDiffRows(diff, fileChangeKindLabel(change.kind));
  return { added: parsed.added, removed: parsed.removed };
}

export function summarizeFileChanges(changes: readonly FileChangeLike[] | undefined): FileChangeSummary | null {
  if (!changes || changes.length === 0) return null;
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const stats = countFileChangeDiffLines(change);
    added += stats.added;
    removed += stats.removed;
  }
  return { files: changes.length, added, removed };
}

export function formatFileChangeForResult(change: FileChangeLike): string {
  const label = fileChangeKindLabel(change.kind);
  const path = change.path || '(unknown path)';
  const movePath = fileChangeMovePath(change.kind);
  const pathLabel = movePath ? `${path} -> ${movePath}` : path;
  return change.diff ? `${label}: ${pathLabel}\n${change.diff}` : `${label}: ${pathLabel}`;
}

function resolvePatchStatus(tool: FilePatchToolLike): string | undefined {
  const metaStatus = tool.resultMeta?.status;
  if (typeof metaStatus === 'string' && metaStatus.trim()) return metaStatus;
  const match = typeof tool.result === 'string' ? tool.result.match(/^\[([^\]]+)\]\n/) : null;
  if (match?.[1]) return match[1];
  return tool.isError ? 'failed' : undefined;
}

function summaryFromChangeDescriptors(changes: readonly FilePatchChangeDescriptor[]): FileChangeSummary {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    added += change.added;
    removed += change.removed;
  }
  return { files: changes.length, added, removed };
}

function summaryFromChanges(changes: readonly FilePatchChange[]): FileChangeSummary {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    added += change.added;
    removed += change.removed;
  }
  return { files: changes.length, added, removed };
}

function cleanStatus(status: string | undefined): string | undefined {
  return status && status !== 'completed' ? status : status === 'completed' ? 'completed' : undefined;
}

function isFilePatchDescriptor(value: unknown): value is FilePatchDisplayDescriptor {
  if (!isRecord(value)) return false;
  return value.kind === 'file_patch' && value.version === 1 && Array.isArray(value.changes);
}

function normalizeDescriptor(value: unknown): FilePatchDisplayDescriptor | null {
  if (!isFilePatchDescriptor(value)) return null;
  const changes: FilePatchChangeDescriptor[] = value.changes
    .filter(isRecord)
    .map((change) => {
      const rawViewKind = isRecord(change.view) ? change.view.kind : undefined;
      const viewKind: FilePatchViewKind = rawViewKind === 'old-new'
        || rawViewKind === 'content'
        || rawViewKind === 'unified-diff'
        ? rawViewKind
        : 'unified-diff';
      return {
        kind: typeof change.kind === 'string' ? change.kind : 'change',
        ...(typeof change.path === 'string' ? { path: change.path } : {}),
        ...(typeof change.movePath === 'string' ? { movePath: change.movePath } : {}),
        ...(typeof change.written === 'number' && change.written >= 0 ? { written: change.written } : {}),
        added: typeof change.added === 'number' ? change.added : 0,
        removed: typeof change.removed === 'number' ? change.removed : 0,
        view: { kind: viewKind },
      };
    });
  if (changes.length === 0) return null;
  const source =
    value.source === 'builtin' || value.source === 'codex' || value.source === 'external' || value.source === 'unknown'
      ? value.source
      : 'unknown';
  return {
    kind: 'file_patch',
    version: 1,
    source,
    ...(typeof value.status === 'string' && value.status ? { status: value.status } : {}),
    ...(value.replaceAll === true ? { replaceAll: true } : {}),
    ...(value.userModified === true ? { userModified: true } : {}),
    ...(value.writeMode === 'create' || value.writeMode === 'update' || value.writeMode === 'unknown'
      ? { writeMode: value.writeMode }
      : {}),
    summary: summaryFromChangeDescriptors(changes),
    changes,
  };
}

function contentLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

function diffStatsFromRows(rows: readonly DiffRow[]): FileChangeDiffStats {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added += 1;
    else if (row.kind === 'remove') removed += 1;
  }
  return { added, removed };
}

function summaryFromRenderChanges(changes: readonly FilePatchRenderChange[]): FileChangeSummary {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    added += change.added;
    removed += change.removed;
  }
  return { files: changes.length, added, removed };
}

function hunkHeader(hunk: StructuredPatchHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

function rowKey(scope: string, index: number): string {
  return `${scope}:${index}`;
}

function rowsFromStructuredPatch(hunks: readonly StructuredPatchHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const hunk = hunks[hunkIndex];
    rows.push({
      key: rowKey(`h${hunkIndex}`, rows.length),
      kind: 'hunk',
      marker: '',
      text: hunkHeader(hunk),
    });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const rawLine of hunk.lines) {
      const key = rowKey(`h${hunkIndex}`, rows.length);
      if (rawLine.startsWith('+')) {
        rows.push({ key, kind: 'add', newLine, marker: '+', text: rawLine.slice(1) });
        newLine += 1;
      } else if (rawLine.startsWith('-')) {
        rows.push({ key, kind: 'remove', oldLine, marker: '-', text: rawLine.slice(1) });
        oldLine += 1;
      } else if (rawLine.startsWith(' ')) {
        rows.push({ key, kind: 'context', oldLine, newLine, marker: '', text: rawLine.slice(1) });
        oldLine += 1;
        newLine += 1;
      } else if (rawLine.startsWith('\\ No newline at end of file')) {
        rows.push({ key, kind: 'omission', marker: '', text: rawLine });
      } else {
        // A malformed structured line must not inherit exact counters.
        rows.push({ key, kind: 'omission', marker: '', text: rawLine });
      }
    }
  }
  return rows;
}

function rawPatchFromStructuredPatch(hunks: readonly StructuredPatchHunk[]): string {
  return hunks.flatMap((hunk) => [hunkHeader(hunk), ...hunk.lines]).join('\n');
}

function parseHunkHeader(line: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
} | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
}

export interface ParsedUnifiedDiffRows extends FileChangeDiffStats {
  rows: DiffRow[];
  lineNumbers: FilePatchLineNumbers;
  valid: boolean;
}

function unavailableRows(lines: readonly string[]): ParsedUnifiedDiffRows {
  return {
    added: 0,
    removed: 0,
    rows: lines.map((text, index): DiffRow => ({
      key: rowKey('flat', index),
      kind: 'context',
      marker: '',
      text,
    })),
    lineNumbers: 'unavailable',
    valid: false,
  };
}

/**
 * Parse one already-delimited file patch. This deliberately does not split a
 * multi-file result string; callers must provide a structured change boundary.
 */
export function parseUnifiedDiffRows(diff: string, changeKind: string): ParsedUnifiedDiffRows {
  const lines = contentLines(diff);

  // Codex add/delete payloads are whole-file contents, not git patches. A new
  // source file may legitimately contain a line that looks exactly like a hunk
  // header, so content semantics must win before any hunk detection.
  if (changeKind === 'add' || changeKind === 'delete') {
    const isAdd = changeKind === 'add';
    const rows = lines.map((text, index): DiffRow => ({
      key: rowKey('flat', index),
      kind: isAdd ? 'add' : 'remove',
      ...(isAdd ? { newLine: index + 1 } : { oldLine: index + 1 }),
      marker: isAdd ? '+' : '-',
      text,
    }));
    return { ...diffStatsFromRows(rows), rows, lineNumbers: 'exact', valid: true };
  }

  const hasHunk = lines.some((line) => parseHunkHeader(line) !== null);
  if (!hasHunk) {
    return unavailableRows(lines);
  }

  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let expectedOldLines = 0;
  let expectedNewLines = 0;
  let consumedOldLines = 0;
  let consumedNewLines = 0;
  let inHunk = false;
  let valid = true;

  const finishHunk = () => {
    if (!inHunk) return;
    if (consumedOldLines !== expectedOldLines || consumedNewLines !== expectedNewLines) valid = false;
  };

  for (const line of lines) {
    const header = parseHunkHeader(line);
    if (header) {
      finishHunk();
      inHunk = true;
      oldLine = header.oldStart;
      newLine = header.newStart;
      expectedOldLines = header.oldLines;
      expectedNewLines = header.newLines;
      consumedOldLines = 0;
      consumedNewLines = 0;
      rows.push({ key: rowKey('unified', rows.length), kind: 'hunk', marker: '', text: line });
      continue;
    }
    if (!inHunk) {
      // File headers and git metadata are protocol chrome, not code rows.
      continue;
    }

    const key = rowKey('unified', rows.length);
    if (line.startsWith('+')) {
      rows.push({ key, kind: 'add', newLine, marker: '+', text: line.slice(1) });
      newLine += 1;
      consumedNewLines += 1;
    } else if (line.startsWith('-')) {
      rows.push({ key, kind: 'remove', oldLine, marker: '-', text: line.slice(1) });
      oldLine += 1;
      consumedOldLines += 1;
    } else if (line.startsWith(' ')) {
      rows.push({ key, kind: 'context', oldLine, newLine, marker: '', text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
      consumedOldLines += 1;
      consumedNewLines += 1;
    } else if (line.startsWith('\\ No newline at end of file')) {
      rows.push({ key, kind: 'omission', marker: '', text: line });
    } else {
      valid = false;
      rows.push({ key, kind: 'omission', marker: '', text: line });
    }
  }
  finishHunk();

  if (!valid) return unavailableRows(lines);
  return { ...diffStatsFromRows(rows), rows, lineNumbers: 'exact', valid: true };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseStructuredPatch(value: unknown): StructuredPatchHunk[] | null {
  if (!Array.isArray(value)) return null;
  const hunks: StructuredPatchHunk[] = [];
  for (const item of value) {
    if (
      !isRecord(item)
      || !isNonNegativeInteger(item.oldStart)
      || !isNonNegativeInteger(item.oldLines)
      || !isNonNegativeInteger(item.newStart)
      || !isNonNegativeInteger(item.newLines)
      || !Array.isArray(item.lines)
      || !item.lines.every((line) => typeof line === 'string')
    ) {
      return null;
    }
    const lines = item.lines as string[];
    let consumedOld = 0;
    let consumedNew = 0;
    for (const line of lines) {
      if (line.startsWith('+')) consumedNew += 1;
      else if (line.startsWith('-')) consumedOld += 1;
      else if (line.startsWith(' ')) {
        consumedOld += 1;
        consumedNew += 1;
      } else if (!line.startsWith('\\ No newline at end of file')) {
        return null;
      }
    }
    if (consumedOld !== item.oldLines || consumedNew !== item.newLines) return null;

    hunks.push({
      oldStart: item.oldStart,
      oldLines: item.oldLines,
      newStart: item.newStart,
      newLines: item.newLines,
      lines,
    });
  }
  return hunks;
}

function parseResultRecord(result: string | undefined): Record<string, unknown> | null {
  if (!result?.trimStart().startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseSdkFilePatchResult(tool: FilePatchToolLike): SdkFilePatchResult | null {
  const result = parseResultRecord(tool.result);
  if (!result) return null;
  const structuredPatch = parseStructuredPatch(result.structuredPatch);
  if (!structuredPatch) return null;

  const type = result.type === 'create' || result.type === 'update' ? result.type : undefined;
  const hasCommonFields = typeof result.filePath === 'string'
    && (result.originalFile === null || typeof result.originalFile === 'string');
  const isCompleteEdit = tool.name === 'Edit'
    && hasCommonFields
    && typeof result.oldString === 'string'
    && typeof result.newString === 'string'
    && typeof result.userModified === 'boolean'
    && typeof result.replaceAll === 'boolean';
  const isCompleteWrite = tool.name === 'Write'
    && hasCommonFields
    && type !== undefined
    && typeof result.content === 'string'
    && (result.userModified === undefined || typeof result.userModified === 'boolean')
    && (type !== 'create' || result.originalFile === null)
    && (type !== 'update' || typeof result.originalFile === 'string');
  if (!isCompleteEdit && !isCompleteWrite) return null;

  const gitDiff = isRecord(result.gitDiff) ? result.gitDiff : null;
  return {
    ...(typeof result.filePath === 'string' ? { filePath: result.filePath } : {}),
    ...(typeof result.oldString === 'string' ? { oldString: result.oldString } : {}),
    ...(typeof result.newString === 'string' ? { newString: result.newString } : {}),
    ...(typeof result.content === 'string' ? { content: result.content } : {}),
    ...(result.originalFile === null || typeof result.originalFile === 'string'
      ? { originalFile: result.originalFile }
      : {}),
    structuredPatch,
    ...(type ? { type } : {}),
    ...(typeof result.userModified === 'boolean' ? { userModified: result.userModified } : {}),
    ...(typeof result.replaceAll === 'boolean' ? { replaceAll: result.replaceAll } : {}),
    ...(gitDiff && typeof gitDiff.patch === 'string' ? { gitDiffPatch: gitDiff.patch } : {}),
  };
}

function firstInputPath(tool: FilePatchToolLike): string | undefined {
  for (const input of resolveToolInputRecords(tool)) {
    const path = getInputStringProp(input, 'file_path');
    if (path) return path;
  }
  return undefined;
}

function renderChangeFromRows(params: {
  kind: string;
  path?: string;
  movePath?: string;
  viewKind: FilePatchViewKind;
  rows: DiffRow[];
  rawPatch: string;
  lineNumbers: FilePatchLineNumbers;
  written?: number;
  detailUnavailable?: boolean;
}): FilePatchRenderChange {
  const stats = diffStatsFromRows(params.rows);
  return {
    kind: params.kind,
    ...(params.path ? { path: params.path } : {}),
    ...(params.movePath ? { movePath: params.movePath } : {}),
    viewKind: params.viewKind,
    ...stats,
    rows: params.rows,
    rawPatch: params.rawPatch,
    lineNumbers: params.lineNumbers,
    ...(params.written !== undefined ? { written: params.written } : {}),
    ...(params.detailUnavailable ? { detailUnavailable: true } : {}),
  };
}

function renderModelFromSdkResult(tool: FilePatchToolLike, result: SdkFilePatchResult): FilePatchRenderModel {
  const path = result.filePath ?? firstInputPath(tool);
  const writeMode: FilePatchWriteMode | undefined = tool.name === 'Write' ? result.type ?? 'unknown' : undefined;
  const parsedGitDiff = result.gitDiffPatch
    ? parseUnifiedDiffRows(result.gitDiffPatch, 'update')
    : null;
  let change: FilePatchRenderChange;

  if (result.structuredPatch.length > 0) {
    const rows = rowsFromStructuredPatch(result.structuredPatch);
    change = renderChangeFromRows({
      kind: result.type === 'create' ? 'add' : 'update',
      path,
      viewKind: 'unified-diff',
      rows,
      rawPatch: rawPatchFromStructuredPatch(result.structuredPatch),
      lineNumbers: 'exact',
    });
  } else if (result.gitDiffPatch && parsedGitDiff?.valid) {
    change = renderChangeFromRows({
      kind: result.type === 'create' ? 'add' : 'update',
      path,
      viewKind: 'unified-diff',
      rows: parsedGitDiff.rows,
      rawPatch: result.gitDiffPatch,
      lineNumbers: parsedGitDiff.lineNumbers,
      detailUnavailable: parsedGitDiff.rows.length === 0,
    });
  } else if (result.type === 'create' && result.content !== undefined) {
    const rows = contentLines(result.content).map((text, index): DiffRow => ({
      key: rowKey('create', index),
      kind: 'add',
      newLine: index + 1,
      marker: '+',
      text,
    }));
    change = renderChangeFromRows({
      kind: 'add',
      path,
      viewKind: 'content',
      rows,
      rawPatch: result.content,
      lineNumbers: 'exact',
    });
  } else if (result.oldString !== undefined && result.newString !== undefined) {
    const rows: DiffRow[] = result.oldString === result.newString ? [] : [
      ...contentLines(result.oldString).map((text, index): DiffRow => ({
        key: rowKey('old', index), kind: 'remove', marker: '-', text,
      })),
      ...contentLines(result.newString).map((text, index): DiffRow => ({
        key: rowKey('new', index), kind: 'add', marker: '+', text,
      })),
    ];
    change = renderChangeFromRows({
      kind: 'update',
      path,
      viewKind: 'old-new',
      rows,
      rawPatch: '',
      lineNumbers: 'unavailable',
    });
  } else if (result.type === 'update' && !result.gitDiffPatch && result.originalFile === result.content) {
    change = renderChangeFromRows({
      kind: 'update',
      path,
      viewKind: 'unified-diff',
      rows: [],
      rawPatch: '',
      lineNumbers: 'exact',
    });
  } else {
    change = renderChangeFromRows({
      kind: result.type === 'create' ? 'add' : 'update',
      path,
      viewKind: 'unified-diff',
      rows: [],
      rawPatch: '',
      lineNumbers: 'unavailable',
      detailUnavailable: true,
    });
  }

  return {
    kind: 'file_patch_render',
    source: 'builtin',
    ...(cleanStatus(resolvePatchStatus(tool)) ? { status: cleanStatus(resolvePatchStatus(tool)) } : {}),
    ...(result.replaceAll !== undefined ? { replaceAll: result.replaceAll } : {}),
    ...(result.userModified !== undefined ? { userModified: result.userModified } : {}),
    ...(writeMode ? { writeMode } : {}),
    summary: summaryFromRenderChanges([change]),
    changes: [change],
  };
}

function renderModelFromCodexInput(tool: FilePatchToolLike, input: ToolInputRecord): FilePatchRenderModel | null {
  if (!Array.isArray(input.changes)) return null;
  const rawChanges = input.changes.filter(isRecord);
  const fileChanges = coerceFileChanges(input.changes);
  if (fileChanges.length === 0 || rawChanges.length !== input.changes.length) return null;
  const isMultiFile = fileChanges.length > 1;
  if (isMultiFile && rawChanges.some((change) => (
    typeof change.path !== 'string'
    || !change.path.trim()
    || typeof change.diff !== 'string'
  ))) return null;

  const changes: FilePatchRenderChange[] = [];
  for (const fileChange of fileChanges) {
    const kind = fileChangeKindLabel(fileChange.kind);
    const movePath = fileChangeMovePath(fileChange.kind) ?? undefined;
    if (!isMultiFile && fileChange.diff === undefined && !movePath) return null;
    const rawPatch = fileChange.diff ?? '';
    const parsed = parseUnifiedDiffRows(rawPatch, kind);
    if (rawPatch && (kind === 'update' || kind === 'move') && !parsed.valid) return null;
    changes.push(renderChangeFromRows({
      kind,
      path: fileChange.path,
      movePath,
      viewKind: 'unified-diff',
      rows: parsed.rows,
      rawPatch,
      lineNumbers: parsed.lineNumbers,
      detailUnavailable: rawPatch.length === 0,
    }));
  }
  return {
    kind: 'file_patch_render',
    source: 'codex',
    ...(cleanStatus(resolvePatchStatus(tool)) ? { status: cleanStatus(resolvePatchStatus(tool)) } : {}),
    summary: summaryFromRenderChanges(changes),
    changes,
  };
}

function parseCompleteInputJson(tool: FilePatchToolLike): ToolInputRecord | null {
  if (typeof tool.inputJson !== 'string' || !tool.inputJson.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(tool.inputJson);
    return isToolInputRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function codexInputCandidates(tool: FilePatchToolLike): ToolInputRecord[] {
  const completeInputJson = parseCompleteInputJson(tool);
  if (completeInputJson) return [completeInputJson];
  // A non-empty but incomplete inputJson is the live protocol authority. Its
  // parsePartialJson snapshot may contain one complete early change while a
  // later file is still streaming, so publishing that snapshot would silently
  // under-report a multi-file patch.
  if (typeof tool.inputJson === 'string' && tool.inputJson.trim()) return [];
  const candidates: ToolInputRecord[] = [];
  const seen = new Set<ToolInputRecord>();
  pushInputCandidate(candidates, seen, tool.parsedInput);
  pushInputCandidate(candidates, seen, tool.input);
  return candidates;
}

function codexModelRichness(model: FilePatchRenderModel): number {
  const bodySize = model.changes.reduce((total, change) => total + change.rawPatch.length, 0);
  const detailedFiles = model.changes.filter((change) => !change.detailUnavailable).length;
  return model.changes.length * 1_000_000_000 + detailedFiles * 1_000_000 + bodySize;
}

function resolveBestCodexModel(tool: FilePatchToolLike): FilePatchRenderModel | null {
  let best: FilePatchRenderModel | null = null;
  let bestScore = -1;
  for (const input of codexInputCandidates(tool)) {
    const candidate = renderModelFromCodexInput(tool, input);
    if (!candidate) continue;
    const score = codexModelRichness(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function renderModelFromGeminiResult(tool: FilePatchToolLike, input: ToolInputRecord): FilePatchRenderModel | null {
  const displayName = getInputStringProp(input, '_displayName');
  const geminiKind = getInputStringProp(input, '_geminiKind');
  if ((displayName !== 'write_file' && displayName !== 'replace') || geminiKind !== 'edit') return null;
  if (!tool.result) return null;

  const lines = contentLines(tool.result);
  if (lines.length < 2 || !lines[0].startsWith('--- ') || !lines[1].startsWith('+++ ')) return null;
  const oldPath = lines[0].slice(4);
  const newPath = lines[1].slice(4);
  if (!oldPath || oldPath !== newPath) return null;

  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const line of lines.slice(2)) {
    const key = rowKey('gemini', rows.length);
    if (line.startsWith('+')) {
      rows.push({ key, kind: 'add', newLine, marker: '+', text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith('-')) {
      rows.push({ key, kind: 'remove', oldLine, marker: '-', text: line.slice(1) });
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      rows.push({ key, kind: 'context', oldLine, newLine, marker: '', text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    } else {
      return null;
    }
  }

  const change = renderChangeFromRows({
    kind: displayName === 'write_file' ? 'write' : 'update',
    path: getInputStringProp(input, 'file_path') ?? newPath,
    viewKind: 'unified-diff',
    rows,
    rawPatch: tool.result,
    lineNumbers: 'relative',
  });
  return {
    kind: 'file_patch_render',
    source: 'external',
    ...(displayName === 'write_file' ? { writeMode: 'unknown' as const } : {}),
    ...(cleanStatus(resolvePatchStatus(tool)) ? { status: cleanStatus(resolvePatchStatus(tool)) } : {}),
    summary: summaryFromRenderChanges([change]),
    changes: [change],
  };
}

function renderModelFromBuiltinInput(tool: FilePatchToolLike, input: ToolInputRecord): FilePatchRenderModel | null {
  if (tool.name === 'Edit') {
    const oldText = getInputStringProp(input, 'old_string');
    const newText = getInputStringProp(input, 'new_string');
    if (oldText === undefined || newText === undefined) return null;
    const rows: DiffRow[] = [
      ...contentLines(oldText).map((text, index): DiffRow => ({
        key: rowKey('old', index), kind: 'remove', marker: '-', text,
      })),
      ...contentLines(newText).map((text, index): DiffRow => ({
        key: rowKey('new', index), kind: 'add', marker: '+', text,
      })),
    ];
    const change = renderChangeFromRows({
      kind: 'update',
      path: getInputStringProp(input, 'file_path'),
      viewKind: 'old-new',
      rows,
      rawPatch: '',
      lineNumbers: 'unavailable',
    });
    return {
      kind: 'file_patch_render',
      source: 'builtin',
      ...(cleanStatus(resolvePatchStatus(tool)) ? { status: cleanStatus(resolvePatchStatus(tool)) } : {}),
      ...(getBooleanProp(input, 'replace_all') ? { replaceAll: true } : {}),
      summary: summaryFromRenderChanges([change]),
      changes: [change],
    };
  }

  if (tool.name === 'Write') {
    const content = getInputStringProp(input, 'content');
    if (content === undefined) return null;
    const rows = contentLines(content).map((text, index): DiffRow => ({
      key: rowKey('write', index), kind: 'context', marker: '', text,
    }));
    const change = renderChangeFromRows({
      kind: 'write',
      path: getInputStringProp(input, 'file_path'),
      viewKind: 'content',
      rows,
      rawPatch: content,
      lineNumbers: 'unavailable',
      written: rows.length,
    });
    return {
      kind: 'file_patch_render',
      source: 'builtin',
      writeMode: 'unknown',
      ...(cleanStatus(resolvePatchStatus(tool)) ? { status: cleanStatus(resolvePatchStatus(tool)) } : {}),
      summary: summaryFromRenderChanges([change]),
      changes: [change],
    };
  }

  return null;
}

function renderModelFromDescriptor(descriptor: FilePatchDisplayDescriptor): FilePatchRenderModel {
  const changes = descriptor.changes.map((change): FilePatchRenderChange => ({
    kind: change.kind,
    ...(change.path ? { path: change.path } : {}),
    ...(change.movePath ? { movePath: change.movePath } : {}),
    viewKind: change.view.kind,
    added: change.added,
    removed: change.removed,
    rows: [],
    rawPatch: '',
    lineNumbers: 'unavailable',
    ...(change.written !== undefined ? { written: change.written } : {}),
    detailUnavailable: true,
  }));
  return {
    kind: 'file_patch_render',
    source: descriptor.source,
    ...(descriptor.status ? { status: descriptor.status } : {}),
    ...(descriptor.replaceAll ? { replaceAll: true } : {}),
    ...(descriptor.userModified ? { userModified: true } : {}),
    ...(descriptor.writeMode ? { writeMode: descriptor.writeMode } : {}),
    summary: summaryFromRenderChanges(changes),
    changes,
  };
}

function mergeDescriptorMetadata(
  model: FilePatchRenderModel,
  descriptor: FilePatchDisplayDescriptor | null,
  preferModelResultMetadata: boolean,
): FilePatchRenderModel {
  if (!descriptor) return model;
  const changes = !preferModelResultMetadata && descriptor.changes.length === model.changes.length
    ? model.changes.map((change, index): FilePatchRenderChange => {
        const metadata = descriptor.changes[index];
        const { written: _derivedWritten, ...baseChange } = change;
        const descriptorOwnsUnknownWriteCount = descriptor.writeMode === 'unknown'
          && metadata.written !== undefined;
        return {
          ...baseChange,
          kind: metadata.kind,
          ...(metadata.path ? { path: metadata.path } : {}),
          ...(metadata.movePath ? { movePath: metadata.movePath } : {}),
          added: metadata.added,
          removed: metadata.removed,
          ...(descriptorOwnsUnknownWriteCount ? { written: metadata.written } : {}),
        };
      })
    : model.changes;
  const writeMode = preferModelResultMetadata
    ? model.writeMode ?? descriptor.writeMode
    : descriptor.writeMode ?? model.writeMode;
  const userModified = preferModelResultMetadata
    ? model.userModified ?? descriptor.userModified
    : descriptor.userModified ?? model.userModified;
  const replaceAll = preferModelResultMetadata
    ? model.replaceAll ?? descriptor.replaceAll
    : descriptor.replaceAll ?? model.replaceAll;
  const status = model.status ?? descriptor.status;
  return {
    ...model,
    source: descriptor.source === 'unknown' ? model.source : descriptor.source,
    ...(status ? { status } : {}),
    ...(replaceAll ? { replaceAll: true } : {}),
    ...(userModified ? { userModified: true } : {}),
    ...(writeMode ? { writeMode } : {}),
    summary: summaryFromRenderChanges(changes),
    changes,
  };
}

/**
 * Resolve the renderer-facing projection. Result-side SDK structure wins over
 * input previews; Codex multi-file boundaries only come from input.changes[].
 */
export function resolveFilePatchRenderModel(tool: FilePatchToolLike): FilePatchRenderModel | null {
  const descriptor = normalizeDescriptor(tool.display);
  const sdkResult = parseSdkFilePatchResult(tool);
  if (sdkResult) return mergeDescriptorMetadata(renderModelFromSdkResult(tool, sdkResult), descriptor, true);

  const codexModel = resolveBestCodexModel(tool);
  if (codexModel) return mergeDescriptorMetadata(codexModel, descriptor, false);

  for (const input of resolveToolInputRecords(tool)) {
    const gemini = renderModelFromGeminiResult(tool, input);
    if (gemini) return mergeDescriptorMetadata(gemini, descriptor, false);

    const candidate = renderModelFromBuiltinInput(tool, input);
    if (candidate) return mergeDescriptorMetadata(candidate, descriptor, false);
  }

  return descriptor ? renderModelFromDescriptor(descriptor) : null;
}

export function buildFilePatchDisplayDescriptor(tool: FilePatchToolLike): FilePatchDisplayDescriptor | null {
  const model = resolveFilePatchRenderModel(tool);
  if (!model) return null;
  const changes = model.changes.map((change): FilePatchChangeDescriptor => ({
    kind: change.kind,
    ...(change.path ? { path: change.path } : {}),
    ...(change.movePath ? { movePath: change.movePath } : {}),
    ...(change.written !== undefined ? { written: change.written } : {}),
    added: change.added,
    removed: change.removed,
    view: { kind: change.viewKind },
  }));
  return {
    kind: 'file_patch',
    version: 1,
    source: model.source,
    ...(model.status ? { status: model.status } : {}),
    ...(model.replaceAll ? { replaceAll: true } : {}),
    ...(model.userModified ? { userModified: true } : {}),
    ...(model.writeMode ? { writeMode: model.writeMode } : {}),
    summary: summaryFromChangeDescriptors(changes),
    changes,
  };
}

function findCompleteBuiltinInput(tool: FilePatchToolLike): ToolInputRecord | null {
  for (const input of resolveToolInputRecords(tool)) {
    if (
      tool.name === 'Edit'
      && getInputStringProp(input, 'old_string') !== undefined
      && getInputStringProp(input, 'new_string') !== undefined
    ) return input;
    if (tool.name === 'Write' && getInputStringProp(input, 'content') !== undefined) return input;
  }
  return null;
}

function legacyViewForRenderChange(
  change: FilePatchRenderChange,
  sdkResult: SdkFilePatchResult | null,
  builtinInput: ToolInputRecord | null,
): FilePatchMaterializedView {
  if (change.viewKind === 'old-new') {
    const oldText = sdkResult?.oldString ?? getInputStringProp(builtinInput, 'old_string');
    const newText = sdkResult?.newString ?? getInputStringProp(builtinInput, 'new_string');
    if (oldText !== undefined && newText !== undefined) {
      return { kind: 'old-new', oldText, newText };
    }
  }
  if (change.viewKind === 'content') {
    const content = sdkResult?.content ?? getInputStringProp(builtinInput, 'content');
    if (content !== undefined) return { kind: 'content', content };
  }
  return { kind: 'unified-diff', diff: change.rawPatch };
}

/** Backward-compatible projection for the current FilePatchTool during rollout. */
export function resolveFilePatchDisplay(tool: FilePatchToolLike): FilePatchDisplay | null {
  const model = resolveFilePatchRenderModel(tool);
  if (!model) return null;
  const sdkResult = parseSdkFilePatchResult(tool);
  const builtinInput = findCompleteBuiltinInput(tool);
  const changes = model.changes.map((change): FilePatchChange => ({
    kind: change.kind,
    ...(change.path ? { path: change.path } : {}),
    ...(change.movePath ? { movePath: change.movePath } : {}),
    added: change.added,
    removed: change.removed,
    view: legacyViewForRenderChange(change, sdkResult, builtinInput),
  }));
  return {
    kind: 'file_patch',
    version: 1,
    source: model.source,
    ...(model.status ? { status: model.status } : {}),
    ...(model.replaceAll ? { replaceAll: true } : {}),
    ...(model.userModified ? { userModified: true } : {}),
    ...(model.writeMode ? { writeMode: model.writeMode } : {}),
    summary: summaryFromChanges(changes),
    changes,
  };
}

export function getFilePatchPrimaryPath(
  display: FilePatchDisplay | FilePatchDisplayDescriptor | FilePatchRenderModel,
): string | undefined {
  return display.changes.find((change) => change.path)?.path;
}
