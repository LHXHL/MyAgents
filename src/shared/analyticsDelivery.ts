/** Receipt/status policy shared by the two existing in-memory queue owners. */
export class AnalyticsDeliveryError extends Error {
  constructor(
    readonly reason: 'http_error' | 'invalid_receipt',
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(reason);
  }
}

export function assertAnalyticsStatus(ok: boolean, status: number): void {
  if (!ok) {
    throw new AnalyticsDeliveryError('http_error',
      !(status >= 400 && status < 500 && status !== 408 && status !== 429), status);
  }
}

export function assertAnalyticsReceipt(value: unknown, count: number): void {
  if (typeof value !== 'object' || value === null ||
      !('success' in value) || value.success !== true ||
      !('received' in value) || value.received !== count) {
    throw new AnalyticsDeliveryError('invalid_receipt', true);
  }
}

export function analyticsRetryDelay(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 6));
}

/** Never log raw transport errors: they may contain URLs, keys or event data. */
export function analyticsFailureDetails(error: unknown): { reason: string; status?: number } {
  return error instanceof AnalyticsDeliveryError
    ? { reason: error.reason, status: error.status }
    : { reason: 'transport_or_response_error' };
}
