import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { DshCanonicalWebError } from './canonical-web-errors';
import {
  DshSafeHttpClient,
  createDshPinnedLookup,
  type DshDnsAnswer,
  type DshRawHttpResponse,
  type DshSafeHttpPolicy,
  type DshSafeHttpTransport,
} from './safe-http';

const policy: DshSafeHttpPolicy = Object.freeze({
  allowedHosts: Object.freeze([]),
  allowedPorts: Object.freeze([80, 443]),
  deniedHosts: Object.freeze(['metadata.google.internal']),
  maxCompressedBytes: 1024,
  maxCompressionRatio: 20,
  maxConcurrent: 2,
  maxDecompressedBytes: 4096,
  maxQueued: 2,
  maxRedirects: 2,
  timeoutMs: 5000,
});

function raw(
  statusCode: number,
  bytes: Uint8Array = new Uint8Array(),
  headers: DshRawHttpResponse['headers'] = {},
): DshRawHttpResponse {
  return Object.freeze({ statusCode, bytes, headers: Object.freeze(headers) });
}

function publicLookup(address = '93.184.216.34') {
  return vi.fn(async (): Promise<readonly DshDnsAnswer[]> => (
    Object.freeze([{ address, family: 4 as const }])
  ));
}

describe('DshSafeHttpClient', () => {
  it('implements both Node 24 pinned lookup callback shapes', async () => {
    const answer = Object.freeze({ address: '93.184.216.34', family: 4 as const });
    const lookup = createDshPinnedLookup(answer);
    await new Promise<void>((resolve, reject) => {
      lookup('example.com', { all: true }, (error, addresses, family) => {
        try {
          expect(error).toBeNull();
          expect(addresses).toEqual([answer]);
          expect(family).toBeUndefined();
          resolve();
        } catch (assertion) {
          reject(assertion);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      lookup('example.com', { all: false }, (error, address, family) => {
        try {
          expect(error).toBeNull();
          expect(address).toBe(answer.address);
          expect(family).toBe(answer.family);
          resolve();
        } catch (assertion) {
          reject(assertion);
        }
      });
    });
  });

  it('pins the validated address and decodes a bounded compressed response', async () => {
    const compressed = gzipSync(Buffer.from('hello canonical web'));
    const dispatch = vi.fn(async (_url: URL, address: DshDnsAnswer) => {
      expect(address).toEqual({ address: '93.184.216.34', family: 4 });
      return raw(200, compressed, {
        'content-encoding': 'gzip',
        'content-type': 'text/plain; charset=utf-8',
      });
    });
    const client = new DshSafeHttpClient(policy, {
      lookup: publicLookup(),
      transport: { dispatch } as DshSafeHttpTransport,
    });

    const result = await client.request('https://example.com/page#fragment', {
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(Buffer.from(result.bytes).toString('utf8')).toBe('hello canonical web');
    expect(result.contentType).toBe('text/plain');
    expect(result.finalUrl).toBe('https://example.com/page');
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('revalidates every redirect and refuses a redirect that resolves privately', async () => {
    const dispatch = vi.fn(async () => raw(302, new Uint8Array(), {
      location: 'http://private.example/secret',
    }));
    const lookup = vi.fn(async (hostname: string): Promise<readonly DshDnsAnswer[]> => (
      hostname === 'private.example'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }]
    ));
    const client = new DshSafeHttpClient(policy, {
      lookup,
      transport: { dispatch } as DshSafeHttpTransport,
    });

    await expect(client.request('https://example.com/start', {
      method: 'GET',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'unsafe_destination' } satisfies Partial<DshCanonicalWebError>);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenNthCalledWith(2, 'private.example', expect.any(AbortSignal));
  });

  it('fails closed when any DNS answer or embedded IPv4 destination is non-public', async () => {
    const dispatch = vi.fn();
    const mixed = new DshSafeHttpClient(policy, {
      lookup: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
        { address: '10.0.0.2', family: 4 as const },
      ]),
      transport: { dispatch } as DshSafeHttpTransport,
    });
    await expect(mixed.request('https://example.com', {
      method: 'GET',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'unsafe_destination' } satisfies Partial<DshCanonicalWebError>);

    const embedded = new DshSafeHttpClient(policy, {
      lookup: vi.fn(async (hostname: string) => hostname === 'ipv4only.arpa'
        ? []
        : [{ address: '::ffff:127.0.0.1', family: 6 as const }]),
      transport: { dispatch } as DshSafeHttpTransport,
    });
    await expect(embedded.request('https://example.com', {
      method: 'GET',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'unsafe_destination' } satisfies Partial<DshCanonicalWebError>);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('propagates caller cancellation through the owned transport', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled by test');
    const client = new DshSafeHttpClient(policy, {
      lookup: publicLookup(),
      transport: {
        dispatch: vi.fn(async (_url, _address, _request, signal) => await new Promise<DshRawHttpResponse>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })),
      },
    });
    const pending = client.request('https://example.com', { method: 'GET', signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
