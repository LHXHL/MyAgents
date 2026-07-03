import { describe, expect, it } from 'vitest';

import {
  classifySubscriptionVerifyFailureKind,
  isUserActionRequiredSubscriptionFailure,
} from './subscription';

describe('subscription verify failure classification', () => {
  it('classifies expired or missing OAuth credentials as auth-required', () => {
    expect(classifySubscriptionVerifyFailureKind('API Error: 401 Invalid authentication credentials')).toBe('auth_required');
    expect(classifySubscriptionVerifyFailureKind('Failed to authenticate. Please /login')).toBe('auth_required');
  });

  it('classifies subscription or permission failures as user-action required entitlement failures', () => {
    expect(classifySubscriptionVerifyFailureKind('API Error: 403 forbidden')).toBe('entitlement_required');
    expect(classifySubscriptionVerifyFailureKind('Subscription required to use this model')).toBe('entitlement_required');
  });

  it('keeps transient failures out of the terminal user-action bucket', () => {
    expect(isUserActionRequiredSubscriptionFailure(classifySubscriptionVerifyFailureKind('429 rate limit'))).toBe(false);
    expect(isUserActionRequiredSubscriptionFailure(classifySubscriptionVerifyFailureKind('network timeout'))).toBe(false);
    expect(isUserActionRequiredSubscriptionFailure('auth_required')).toBe(true);
  });
});
