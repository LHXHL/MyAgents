import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelUsageEntry } from '../../shared/types/session-message';

/**
 * SDK 0.3.274 coalesces queued task notifications into one model turn. Earlier
 * notifications receive empty zero-turn receipts before the final real result.
 * They do not own the product turn, usage, pending send or rewind boundary.
 * Origin is required: a zero-turn human/local/error result is not this receipt.
 */
export function isCoalescedTaskNotificationReceipt(message: SDKResultMessage): boolean {
  return message.subtype === 'success' && !message.is_error
    && message.origin?.kind === 'task-notification'
    && message.num_turns === 0 && message.result === ''
    // Native 0.3.276 receipts omit terminal_reason (verified with queued Bash
    // completions). Never ignore an explicitly interrupted/failed terminal.
    && (message.terminal_reason === undefined || message.terminal_reason === 'completed');
}

export interface EmptySuccessfulSdkResultInput {
  isError?: boolean;
  result?: string | null;
  terminalReason?: string | null;
  hasVisibleOutput: boolean;
  toolCount: number;
  outputTokens?: number | null;
}

export function isEmptySuccessfulSdkResult(input: EmptySuccessfulSdkResultInput): boolean {
  return input.isError !== true
    && input.terminalReason === 'completed'
    && !input.hasVisibleOutput
    && input.toolCount === 0
    && (input.result ?? '').trim() === ''
    && (input.outputTokens ?? 0) === 0;
}

export interface SuccessfulCompactControlTurnInput {
  emptySuccessfulResult: boolean;
  compactResult?: 'success' | 'failed' | null;
  sawCompactBoundary: boolean;
}

/**
 * `/compact` is an SDK-owned control turn: the useful output is the compacted
 * context itself, not assistant text. The SDK proves success either via the
 * terminal status payload (`compact_result:'success'`) or, on older/alternate
 * streams, by emitting the `compact_boundary` system message before an otherwise
 * empty successful result.
 */
export function isSuccessfulCompactControlTurn(input: SuccessfulCompactControlTurnInput): boolean {
  if (!input.emptySuccessfulResult) return false;
  if (input.compactResult === 'failed') return false;
  return input.compactResult === 'success' || input.sawCompactBoundary;
}

export interface RecoveredAssistantMessageErrorInput {
  hadAssistantMessageError: boolean;
  isError?: boolean;
  terminalReason?: string | null;
  emptySuccessfulResult: boolean;
}

export function isRecoveredAssistantMessageError(input: RecoveredAssistantMessageErrorInput): boolean {
  return input.hadAssistantMessageError
    && input.isError !== true
    && input.terminalReason === 'completed'
    && !input.emptySuccessfulResult;
}

/**
 * #331 — pick which message a completed turn's usage belongs to.
 *
 * The turn's usage (input/output/cache, tool count, duration) is a property of
 * the assistant response that just finished, NOT of "whatever element happens to
 * be last in `messages[]` when persistence runs". Persistence used the latter
 * (`absoluteIndex === messages.length - 1 && role === 'assistant'`), which loses
 * the usage whenever something is appended after the assistant before the
 * fire-and-forget turn-end persist executes — a queued user message surfaced at
 * turn end, or the next turn's messages pushed while the persist waits on the
 * file lock. Because the JSONL writer is append-only and session stats are summed
 * incrementally at append time, a usage-less append is permanent → the stats
 * panel shows 0 tokens (issue #331).
 *
 * This returns the index of the trailing assistant message within the
 * not-yet-persisted range `[fromIndex, messages.length)`, but only if that
 * assistant has NOT already been stamped (`usage === undefined`); otherwise -1.
 *
 * Two guards, both required:
 *  - `fromIndex` (the persist cursor) keeps us from re-selecting a prior turn's
 *    ALREADY-PERSISTED assistant.
 *  - the `usage === undefined` check keeps us from re-stamping a prior turn's
 *    STAMPED-BUT-NOT-YET-PERSISTED assistant. The cursor alone is insufficient:
 *    the turn-end persist is fire-and-forget and can sit blocked on the file lock
 *    while the next turn runs, so `fromIndex` may still sit behind an
 *    already-stamped assistant. If that next turn completes producing no new
 *    assistant of its own (empty / error / aborted result), the trailing
 *    assistant in range is the prior turn's — and overwriting its usage with this
 *    turn's (often empty) usage is exactly the corruption we must avoid. A
 *    stamped trailing assistant ⇒ this turn produced no assistant ⇒ return -1.
 *    (Cross-review by Codex caught this race.)
 */
export function findTurnUsageStampIndex(
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; usage?: unknown }>,
  fromIndex: number,
): number {
  for (let i = messages.length - 1; i >= Math.max(0, fromIndex); i--) {
    if (messages[i].role === 'assistant') {
      return messages[i].usage === undefined ? i : -1;
    }
  }
  return -1;
}

/**
 * #358 — pure extraction of usage fields from an SDK `result` message.
 *
 * The SDK puts a per-model breakdown in `modelUsage` (camelCase, preferred —
 * lets `byModel` stats show separate rows per provider/upstream model) and
 * falls back to the flat `usage` aggregate (snake_case). `modelUsage` is a
 * cumulative snapshot and must be converted before it becomes Product turn
 * usage. Both shapes can be partial — fields are independently optional and
 * missing entries are 0.
 *
 * Why extract this from the inline result handler:
 *  - Lets the result handler stamp the assistant message with usage *before*
 *    deciding which terminal branch to take (success / empty-success / error),
 *    instead of only on the success branch via handleMessageComplete. Coupling
 *    usage persistence to chat:message-complete dispatch was the architectural
 *    flaw behind #358 — any short-circuit in the dispatch path (mid-turn
 *    persist race, empty-success branch firing despite real usage in result,
 *    silent broadcast skip) silently zeroed `/sessions/:id/stats`.
 *  - Makes the model-id-key invariant testable in isolation. Stats aggregation
 *    keys on whatever string the SDK put in modelUsage — including suffixes
 *    like `mimo-v2.5-pro[1m]`. We don't normalize that key here; the byModel
 *    breakdown surfaces it verbatim to the UI.
 */
export interface SdkResultUsageRaw {
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface ModelUsageEntryLike {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface TurnUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Highest-token model id (verbatim, including any `[1m]` suffix). */
  model: string | undefined;
  /** Per-model breakdown, undefined when SDK only emits aggregate `usage`. */
  modelUsage: Record<string, ModelUsageEntryLike> | undefined;
}

export function extractTurnUsageFromSdkResult(input: SdkResultUsageRaw): TurnUsageBreakdown {
  if (input.modelUsage && Object.keys(input.modelUsage).length > 0) {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;
    let primaryModel: string | undefined;
    let maxModelTokens = 0;
    const modelUsageMap: Record<string, ModelUsageEntryLike> = {};

    for (const [model, stats] of Object.entries(input.modelUsage)) {
      const modelInput = stats.inputTokens ?? 0;
      const modelOutput = stats.outputTokens ?? 0;
      const modelCacheRead = stats.cacheReadInputTokens ?? 0;
      const modelCacheCreation = stats.cacheCreationInputTokens ?? 0;

      totalInput += modelInput;
      totalOutput += modelOutput;
      totalCacheRead += modelCacheRead;
      totalCacheCreation += modelCacheCreation;

      modelUsageMap[model] = {
        inputTokens: modelInput,
        outputTokens: modelOutput,
        cacheReadTokens: modelCacheRead || undefined,
        cacheCreationTokens: modelCacheCreation || undefined,
      };

      const modelTotal = modelInput + modelOutput;
      if (modelTotal > maxModelTokens) {
        maxModelTokens = modelTotal;
        primaryModel = model;
      }
    }

    return {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      model: primaryModel,
      modelUsage: modelUsageMap,
    };
  }

  if (input.usage) {
    return {
      inputTokens: input.usage.input_tokens ?? 0,
      outputTokens: input.usage.output_tokens ?? 0,
      cacheReadTokens: input.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: input.usage.cache_creation_input_tokens ?? 0,
      model: undefined,
      modelUsage: undefined,
    };
  }

  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: undefined,
    modelUsage: undefined,
  };
}

/** SDK result.modelUsage is a cumulative snapshot, including across a resumed Query.
 * Product transcript usage is per turn, so conversion belongs at this boundary.
 * The last raw snapshot is stored with the product turn for an exact resume baseline.
 */
export function createSdkCumulativeUsageTracker(seed: {
  resumed: boolean;
  previous?: Record<string, ModelUsageEntry>;
}): {
  preview: (result: SdkResultUsageRaw) => {
    usage: TurnUsageBreakdown;
    cumulative?: Record<string, ModelUsageEntry>;
  };
  commit: (result: SdkResultUsageRaw) => void;
  reset: () => void;
} {
  let previous = seed.previous ?? {};
  // Pre-upgrade Product transcripts have no raw SDK snapshot. Their first
  // resumed result includes history that cannot be reconstructed exactly.
  let unknownHistoricalBaseline = seed.resumed && !seed.previous;
  let resetBaseline = false;

  const readCumulative = (result: SdkResultUsageRaw) => {
    const extracted = extractTurnUsageFromSdkResult(result);
    if (!extracted.modelUsage || Object.keys(extracted.modelUsage).length === 0) return null;
    // A startup/crash result may list models with all counters zero. It is
    // not a new baseline and must not erase the last accounted snapshot.
    if (extracted.inputTokens === 0 && extracted.outputTokens === 0
      && extracted.cacheReadTokens === 0 && extracted.cacheCreationTokens === 0
      && (result.usage?.input_tokens ?? 0) === 0
      && (result.usage?.output_tokens ?? 0) === 0
      && (result.usage?.cache_read_input_tokens ?? 0) === 0
      && (result.usage?.cache_creation_input_tokens ?? 0) === 0) return null;
    return extracted;
  };

  return {
    preview(result) {
      const cumulative = readCumulative(result);
      if (!cumulative?.modelUsage) {
        return {
          usage: extractTurnUsageFromSdkResult({ usage: result.usage }),
          cumulative: resetBaseline ? {} : undefined,
        };
      }
      const snapshot = cumulative.modelUsage;
      if (unknownHistoricalBaseline) {
        // The flat result is main-loop only, but avoids charging all prior
        // history to one turn. After this result the raw snapshot is exact.
        return { usage: extractTurnUsageFromSdkResult({ usage: result.usage }), cumulative: snapshot };
      }
      const reset = Object.entries(previous).some(([model, prior]) => {
        const next = snapshot[model];
        return !next || next.inputTokens < prior.inputTokens
          || next.outputTokens < prior.outputTokens
          || (next.cacheReadTokens ?? 0) < (prior.cacheReadTokens ?? 0)
          || (next.cacheCreationTokens ?? 0) < (prior.cacheCreationTokens ?? 0);
      });
      const baseline = reset ? {} : previous;
      const modelUsage: Record<string, ModelUsageEntry> = {};
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheCreationTokens = 0;
      let model: string | undefined;
      let maxModelTokens = 0;
      for (const [key, next] of Object.entries(snapshot)) {
        const prior = baseline[key];
        const entry = {
          inputTokens: next.inputTokens - (prior?.inputTokens ?? 0),
          outputTokens: next.outputTokens - (prior?.outputTokens ?? 0),
          cacheReadTokens: (next.cacheReadTokens ?? 0) - (prior?.cacheReadTokens ?? 0),
          cacheCreationTokens: (next.cacheCreationTokens ?? 0) - (prior?.cacheCreationTokens ?? 0),
        };
        modelUsage[key] = entry;
        inputTokens += entry.inputTokens;
        outputTokens += entry.outputTokens;
        cacheReadTokens += entry.cacheReadTokens;
        cacheCreationTokens += entry.cacheCreationTokens;
        if (entry.inputTokens + entry.outputTokens > maxModelTokens) {
          maxModelTokens = entry.inputTokens + entry.outputTokens;
          model = key;
        }
      }
      return { usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, model, modelUsage }, cumulative: snapshot };
    },
    commit(result) {
      const cumulative = readCumulative(result);
      if (!cumulative?.modelUsage) return; // Startup/crash results can be zeroed.
      previous = cumulative.modelUsage;
      unknownHistoricalBaseline = false;
      resetBaseline = false;
    },
    reset() {
      previous = {};
      unknownHistoricalBaseline = false;
      resetBaseline = true;
    },
  };
}
