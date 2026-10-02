import { describe, expect, it } from 'vitest';
import { dshCanonicalWebTransportError } from './canonical-web-errors';

describe('known Web transport failures', () => {
  it.each(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED'])('explains %s without inventing a DNS failure', code => {
    const cause = Object.assign(new Error('private upstream detail'), { code });
    for (const route of ['direct', 'proxy'] as const) {
      const error = dshCanonicalWebTransportError(new TypeError('fetch failed', { cause }), route, 'response_headers');
      expect(error).toMatchObject({ code: 'web_connect_failed', systemErrorClass: code, phase: 'response_headers' });
      expect(error.message).toContain(code === 'ECONNREFUSED' ? 'was refused' : 'closed before the response completed');
      expect(error.message.includes('proxy')).toBe(route === 'proxy');
      expect(error.message).not.toMatch(/DNS|private upstream detail/);
    }
  });

  it('preserves the response body phase and known DNS classification', () => {
    expect(dshCanonicalWebTransportError(Object.assign(new Error(), { code: 'UND_ERR_SOCKET' }), 'proxy', 'response_body'))
      .toMatchObject({ code: 'web_request_failed', phase: 'response_body', systemErrorClass: 'UND_ERR_SOCKET' });
    expect(dshCanonicalWebTransportError(Object.assign(new Error(), { code: 'ENOTFOUND' }), 'proxy'))
      .toMatchObject({ code: 'web_dns_failed', phase: 'dns', systemErrorClass: 'ENOTFOUND' });
  });
});
