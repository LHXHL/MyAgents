const FAILURE_THRESHOLD = 3;
const FAILURE_GRACE_MS = 30_000;
const NOTICE_COOLDOWN_MS = 5 * 60_000;

interface FailureStreak {
  count: number;
  firstFailedAt: number;
  lastNotifiedAt: number | null;
}

/** One background-request scope owns this policy. Other requests cannot reset
 * a failing request, and presentation never changes the original API outcome. */
export class BackgroundFailureFeedback {
  private readonly failures = new Map<string, FailureStreak>();

  succeeded(requestKey: string): void {
    this.failures.delete(requestKey);
  }

  failed(requestKey: string, now: number): boolean {
    const streak = this.failures.get(requestKey) ?? {
      count: 0,
      firstFailedAt: now,
      lastNotifiedAt: null,
    };
    streak.count += 1;
    this.failures.set(requestKey, streak);
    if (
      streak.count < FAILURE_THRESHOLD ||
      now - streak.firstFailedAt < FAILURE_GRACE_MS ||
      (streak.lastNotifiedAt !== null &&
        now - streak.lastNotifiedAt < NOTICE_COOLDOWN_MS)
    )
      return false;
    streak.lastNotifiedAt = now;
    return true;
  }
}
