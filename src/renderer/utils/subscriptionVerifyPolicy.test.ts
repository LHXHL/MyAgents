import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderVerifyStatus } from '@/config/types';
import type { SubscriptionStatus } from '@/types/subscription';
import {
  shouldSkipSubscriptionAutoVerify,
  shouldUseCachedValidSubscriptionVerify,
} from './subscriptionVerifyPolicy';

const fixedNow = new Date('2026-07-03T00:00:00.000Z');
const recent = '2026-07-02T00:00:00.000Z';
const expired = '2026-05-01T00:00:00.000Z';
const status: SubscriptionStatus = { available: true, info: { email: 'user@example.com' } };

describe('subscription verify policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses fresh cached valid status for the same account', () => {
    const cached: ProviderVerifyStatus = {
      status: 'valid',
      verifiedAt: recent,
      accountEmail: 'user@example.com',
    };

    expect(shouldUseCachedValidSubscriptionVerify(status, cached)).toBe(true);
  });

  it('skips auto verify for fresh auth-required invalid status', () => {
    const cached: ProviderVerifyStatus = {
      status: 'invalid',
      verifiedAt: recent,
      accountEmail: 'user@example.com',
      invalidReason: 'auth_required',
    };

    expect(shouldSkipSubscriptionAutoVerify(status, cached)).toBe(true);
  });

  it('does not skip transient or expired invalid status', () => {
    expect(shouldSkipSubscriptionAutoVerify(status, {
      status: 'invalid',
      verifiedAt: recent,
      accountEmail: 'user@example.com',
      invalidReason: 'network',
    })).toBe(false);
    expect(shouldSkipSubscriptionAutoVerify(status, {
      status: 'invalid',
      verifiedAt: expired,
      accountEmail: 'user@example.com',
      invalidReason: 'auth_required',
    })).toBe(false);
  });

  it('does not reuse cached status when the account changed', () => {
    expect(shouldSkipSubscriptionAutoVerify(status, {
      status: 'invalid',
      verifiedAt: recent,
      accountEmail: 'other@example.com',
      invalidReason: 'auth_required',
    })).toBe(false);
  });
});
