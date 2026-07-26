import { describe, expect, it } from 'vitest';

import { shouldLogHttpRequest } from './http-log-policy';

describe('HTTP request log policy', () => {
  it('silences health and session-state polling while retaining actionable routes', () => {
    expect(shouldLogHttpRequest('/health')).toBe(false);
    expect(shouldLogHttpRequest('/health/live')).toBe(false);
    expect(shouldLogHttpRequest('/health/ready')).toBe(false);
    expect(shouldLogHttpRequest('/health/functional')).toBe(false);
    expect(shouldLogHttpRequest('/api/session-state')).toBe(false);
    expect(shouldLogHttpRequest('/chat/send')).toBe(true);
  });
});
