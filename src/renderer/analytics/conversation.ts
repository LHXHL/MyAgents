import { runtimeSourceForRuntimeType, type RuntimeSource } from '../../shared/types/runtime';
import type { AnalyticsRuntime, EventParams } from './types';

export interface MessageCompletionTelemetry {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  tool_count?: number;
  duration_ms?: number;
}

/** Unknown measurements stay absent; a reported zero remains a real zero. */
export function messageCompletionParams(
  runtime: AnalyticsRuntime,
  runtimeSource: RuntimeSource | null | undefined,
  payload: MessageCompletionTelemetry | null | undefined,
): EventParams {
  const params: EventParams = {
    runtime,
    runtime_source: runtime === 'unknown'
      ? null
      : runtimeSourceForRuntimeType(runtime, runtimeSource) ?? null,
  };
  if (payload?.model) params.model = payload.model;
  for (const key of [
    'input_tokens', 'output_tokens', 'cache_read_tokens',
    'cache_creation_tokens', 'tool_count', 'duration_ms',
  ] as const) {
    const value = payload?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) params[key] = value;
  }
  return params;
}
