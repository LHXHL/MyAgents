import type { TranscriptBlock, TranscriptMessage, TranscriptObject, TranscriptOperation, TranscriptProjection } from '../../shared/sessionTranscript';

const APPEND_CHUNK_CHARS = 32 * 1024;
type TextAppend = Extract<TranscriptOperation, { kind: 'text-append' }>;

/** Merge only identical, contiguous targets; never change the meaning of an offset check. */
export function mergeAdjacentTextAppends(previous: TranscriptOperation, next: TranscriptOperation): TextAppend | null {
  if (previous.kind !== 'text-append' || next.kind !== 'text-append'
    || previous.messageId !== next.messageId || previous.field !== next.field
    || previous.blockId !== next.blockId || previous.subagentToolId !== next.subagentToolId
    || next.offset !== previous.offset + previous.text.length
    || previous.text.length + next.text.length > APPEND_CHUNK_CHARS) return null;
  return { ...previous, text: previous.text + next.text };
}

/** Called only after wire validation; stays inside one batch and leaves its source untouched. */
export function coalesceTranscriptBatchOperations(operations: readonly TranscriptOperation[]): readonly TranscriptOperation[] {
  let result: TranscriptOperation[] | null = null;
  for (let index = 1; index < operations.length; index++) {
    const operation = operations[index];
    const merged = mergeAdjacentTextAppends(result?.at(-1) ?? operations[index - 1], operation);
    if (merged) {
      result ??= operations.slice(0, index);
      result[result.length - 1] = merged;
    } else if (result) result.push(operation);
  }
  return result ?? operations;
}

function asObject(value: unknown): TranscriptObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as TranscriptObject : undefined;
}

/** Baseline encoding chunks large strings without duplicating accumulated text. */
export function* appendTextParts(target: Omit<Extract<TranscriptOperation, { kind: 'text-append' }>, 'kind' | 'offset' | 'text'>, text: string, baseOffset = 0): Generator<TranscriptOperation> {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + APPEND_CHUNK_CHARS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    yield { kind: 'text-append', ...target, offset: baseOffset + offset, text: text.slice(offset, end) };
    offset = end;
  }
}

function* blockBaseline(messageId: string, block: TranscriptBlock): Generator<TranscriptOperation> {
  const skeleton: TranscriptBlock = { ...block };
  const streams: Array<{ target: Parameters<typeof appendTextParts>[0]; text: string }> = [];
  for (const field of ['text', 'thinking'] as const) {
    if (typeof block[field] === 'string') {
      skeleton[field] = '';
      streams.push({ target: { messageId, blockId: block.id, field }, text: block[field] });
    }
  }
  const originalTool = asObject(block.tool);
  if (originalTool) {
    const tool = { ...originalTool };
    skeleton.tool = tool;
    for (const field of ['inputJson', 'result'] as const) {
      if (typeof originalTool[field] === 'string') {
        tool[field] = '';
        streams.push({ target: { messageId, blockId: block.id, field }, text: originalTool[field] });
      }
    }
    if (Array.isArray(originalTool.subagentCalls)) {
      tool.subagentCalls = originalTool.subagentCalls.map(value => {
        const original = asObject(value);
        if (!original || typeof original.id !== 'string') return value;
        const call = { ...original };
        for (const field of ['inputJson', 'result'] as const) {
          if (typeof original[field] === 'string') {
            call[field] = '';
            streams.push({ target: { messageId, blockId: block.id, subagentToolId: original.id, field }, text: original[field] });
          }
        }
        return call;
      });
    }
  }
  yield { kind: 'block-upsert', messageId, block: skeleton };
  for (const stream of streams) yield* appendTextParts(stream.target, stream.text);
}

/** The same bounded encoding is used for live user admission and imported baselines. */
export function* transcriptMessageOperations(message: TranscriptMessage): Generator<TranscriptOperation> {
  yield { kind: 'message-create', message: { ...message, content: typeof message.content === 'string' ? '' : [] } };
  if (typeof message.content === 'string') {
    yield* appendTextParts({ messageId: message.id, field: 'text' }, message.content);
  } else {
    for (const block of message.content) yield* blockBaseline(message.id, block);
  }
}

export function* transcriptBaselineOperations(projection: TranscriptProjection): Generator<TranscriptOperation> {
  for (const message of projection.messages.values()) yield* transcriptMessageOperations(message);
  for (const turn of projection.turns.values()) yield { kind: 'turn-update', turn };
}
