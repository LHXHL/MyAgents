export type SpaceMetricName =
  | 'space_boot_start'
  | 'space_boot_end'
  | 'space_event_sync_start'
  | 'space_event_sync_end'
  | 'space_issue_detail_open'
  | 'space_issue_list_render_count'
  | 'space_tab_visible_revalidate_start'
  | 'space_tab_visible_revalidate_end'
  | 'space_delivery_wake'
  | 'space_mutation_latency';

export interface SpaceMetricPayload {
  operation?: string;
  durationMs?: number;
  count?: number;
  ok?: boolean;
  error?: string;
}

export function nowForSpaceMetric(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function recordSpaceMetric(name: SpaceMetricName, payload: SpaceMetricPayload = {}): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try {
      performance.mark(name, { detail: payload });
    } catch {
      performance.mark(name);
    }
  }
  const debugEnabled =
    import.meta.env.DEV
    && typeof window !== 'undefined'
    && window.localStorage?.getItem('myagents.space.metrics') === '1';
  if (debugEnabled) {
    console.debug('[Space metric]', name, payload);
  }
}

export async function withSpaceMutationMetric<T>(operation: string, task: () => Promise<T>): Promise<T> {
  const startedAt = nowForSpaceMetric();
  try {
    const result = await task();
    recordSpaceMetric('space_mutation_latency', {
      operation,
      durationMs: Math.round(nowForSpaceMetric() - startedAt),
      ok: true,
    });
    return result;
  } catch (error) {
    recordSpaceMetric('space_mutation_latency', {
      operation,
      durationMs: Math.round(nowForSpaceMetric() - startedAt),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
