/** Display telemetry is optional and must not decide whether an operation succeeded. */
export function telemetryRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function readDshUsage(value: unknown) {
  const row = telemetryRecord(value);
  const inputTokens = tokenCount(row?.inputTokens);
  const outputTokens = tokenCount(row?.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheReadTokens = tokenCount(row?.cacheReadTokens);
  const cacheWriteTokens = tokenCount(row?.cacheWriteTokens);
  const costUsd = row?.costUsd;
  return {
    inputTokens, outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(costUsd === null || (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0)
      ? { costUsd } : {}),
  };
}

export function readDshUsageTotals(value: unknown) {
  const usage = readDshUsage(value);
  const totalTokens = tokenCount(telemetryRecord(value)?.totalTokens);
  if (!usage || usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined
    || totalTokens === undefined) return undefined;
  return { ...usage, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens, costUsd: usage.costUsd ?? null };
}
