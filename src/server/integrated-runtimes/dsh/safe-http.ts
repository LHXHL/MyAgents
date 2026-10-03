import { Resolver } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { ProxyAgent, request as undiciRequest } from 'undici';

import { DshCanonicalWebError, dshCanonicalWebTransportError } from './canonical-web-errors';

export type DshDnsAnswer = Readonly<{ address: string; family: 4 | 6 }>;

export type DshSafeHttpPolicy = Readonly<{
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
  deniedHosts: readonly string[];
  maxCompressedBytes: number;
  maxCompressionRatio: number;
  maxConcurrent: number;
  maxDecompressedBytes: number;
  maxQueued: number;
  maxRedirects: number;
  timeoutMs: number;
}>;

export type DshSafeHttpRequest = Readonly<{
  method: 'GET' | 'POST';
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  signal: AbortSignal;
}>;

export type DshSafeHttpResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
  redirectOrigins: readonly string[];
}>;

export type DshRawHttpResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  bytes: Uint8Array;
}>;

export interface DshSafeHttpTransport {
  dispatch(
    url: URL,
    address: DshDnsAnswer,
    request: Omit<DshSafeHttpRequest, 'signal'>,
    signal: AbortSignal,
  ): Promise<DshRawHttpResponse>;
}

export interface DshSafeHttpProxyTransport {
  dispatch(
    url: URL,
    request: Omit<DshSafeHttpRequest, 'signal'>,
    signal: AbortSignal,
    proxy: string,
  ): Promise<DshRawHttpResponse>;
  close?(): Promise<void>;
}

export type DshSafeHttpConfig = Readonly<{
  lookup?: (hostname: string, signal: AbortSignal) => Promise<readonly DshDnsAnswer[]>;
  proxyForUrl?: (url: string) => string | undefined;
  proxyTransport?: DshSafeHttpProxyTransport;
  transport?: DshSafeHttpTransport;
}>;

type Pref64 = Readonly<{ length: 32 | 40 | 48 | 56 | 64 | 96; prefix: Uint8Array }>;

const blockedAddresses = new BlockList();
const nonGlobalIpv4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const;
for (const [network, prefix] of nonGlobalIpv4) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
  blockedAddresses.addSubnet(`::ffff:${network}`, 96 + prefix, 'ipv6');
}
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001:2::', 48],
  ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32], ['3fff::', 20],
  ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

function hostMatches(hostname: string, rule: string): boolean {
  return hostname === rule || hostname.endsWith(`.${rule}`);
}

function parseSafeUrl(rawUrl: string, policy: DshSafeHttpPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DshCanonicalWebError('unsafe_destination', 'Web destination URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DshCanonicalWebError('unsafe_destination', 'Web destination must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new DshCanonicalWebError('unsafe_destination', 'Web destination must not contain credentials');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home')
    || hostname.endsWith('.lan')
    || policy.deniedHosts.some(rule => hostMatches(hostname, rule))
    || (policy.allowedHosts.length > 0 && !policy.allowedHosts.some(rule => hostMatches(hostname, rule)))
  ) {
    throw new DshCanonicalWebError('unsafe_destination', 'Web destination host is denied');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isSafeInteger(port) || !policy.allowedPorts.includes(port)) {
    throw new DshCanonicalWebError('unsafe_destination', 'Web destination port is denied');
  }
  url.hostname = hostname;
  url.hash = '';
  return url;
}

function isDnsNoData(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && ('code' in error)
    && (error.code === 'ENODATA' || error.code === 'ENOTFOUND');
}

async function settleDnsLookups(
  ipv4: Promise<readonly DshDnsAnswer[]>,
  ipv6: Promise<readonly DshDnsAnswer[]>,
): Promise<readonly DshDnsAnswer[]> {
  const [v4, v6] = await Promise.allSettled([ipv4, ipv6]);
  if (v4.status === 'rejected') throw v4.reason;
  if (v6.status === 'rejected') throw v6.reason;
  return Object.freeze([...v4.value, ...v6.value]);
}

async function systemLookup(hostname: string, signal: AbortSignal): Promise<readonly DshDnsAnswer[]> {
  signal.throwIfAborted();
  const literal = hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(literal);
  if (literalFamily === 4 || literalFamily === 6) {
    return Object.freeze([{ address: literal, family: literalFamily }]);
  }
  const resolver = new Resolver();
  const abort = (): void => resolver.cancel();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const resolve = async (family: 4 | 6): Promise<readonly DshDnsAnswer[]> => {
    try {
      const values = family === 4
        ? await resolver.resolve4(hostname)
        : await resolver.resolve6(hostname);
      return values.map(address => Object.freeze({ address, family }));
    } catch (error) {
      if (isDnsNoData(error)) return [];
      throw error;
    }
  };
  try {
    const answers = await settleDnsLookups(resolve(4), resolve(6));
    signal.throwIfAborted();
    return answers;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function ipv6Parts(address: string): readonly number[] | undefined {
  const normalized = address.toLowerCase().split('%')[0] ?? address;
  const sides = normalized.split('::');
  if (sides.length > 2) return undefined;
  const parseSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const result: number[] = [];
    for (const token of side.split(':')) {
      if (token.includes('.')) {
        const bytes = token.split('.').map(Number);
        if (bytes.length !== 4 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
          return undefined;
        }
        result.push(((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0));
        result.push(((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0));
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(token)) return undefined;
        result.push(Number.parseInt(token, 16));
      }
    }
    return result;
  };
  const left = parseSide(sides[0] ?? '');
  const right = parseSide(sides[1] ?? '');
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (sides.length === 1 && missing !== 0) || (sides.length === 2 && missing < 1)) {
    return undefined;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function ipv6Bytes(parts: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const value = parts[index] ?? 0;
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function ipv4FromBytes(bytes: Uint8Array): string {
  return `${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 0}.${bytes[3] ?? 0}`;
}

function extractRfc6052(bytes: Uint8Array, prefixLength: Pref64['length']): Uint8Array | undefined {
  if (prefixLength === 96) return bytes.slice(12, 16);
  if (bytes[8] !== 0) return undefined;
  const prefixBytes = prefixLength / 8;
  const beforeU = 8 - prefixBytes;
  const result = new Uint8Array(4);
  result.set(bytes.slice(prefixBytes, 8), 0);
  result.set(bytes.slice(9, 9 + 4 - beforeU), beforeU);
  if (bytes.slice(9 + 4 - beforeU).some(byte => byte !== 0)) return undefined;
  return result;
}

function discoverPref64(answers: readonly DshDnsAnswer[]): readonly Pref64[] {
  const found = new Map<string, Pref64>();
  for (const answer of answers) {
    if (answer.family !== 6) continue;
    const parts = ipv6Parts(answer.address);
    if (!parts) continue;
    const bytes = ipv6Bytes(parts);
    for (const length of [32, 40, 48, 56, 64, 96] as const) {
      const extracted = extractRfc6052(bytes, length);
      if (!extracted) continue;
      const ipv4 = ipv4FromBytes(extracted);
      if (ipv4 !== '192.0.0.170' && ipv4 !== '192.0.0.171') continue;
      const prefix = bytes.slice(0, length / 8);
      found.set(`${length}:${Buffer.from(prefix).toString('hex')}`, { length, prefix });
    }
  }
  return Object.freeze([...found.values()]);
}

function embeddedIpv4(address: string, pref64s: readonly Pref64[]): string | undefined {
  const parts = ipv6Parts(address);
  if (!parts) return undefined;
  const bytes = ipv6Bytes(parts);
  for (const pref64 of pref64s) {
    if (!pref64.prefix.every((byte, index) => bytes[index] === byte)) continue;
    const extracted = extractRfc6052(bytes, pref64.length);
    if (extracted) return ipv4FromBytes(extracted);
  }
  const [p0, p1, p2, p3, p4, p5, p6, p7] = parts as [number, number, number, number, number, number, number, number];
  let value: number | undefined;
  if (
    (p0 === 0x64 && p1 === 0xff9b && parts.slice(2, 6).every(part => part === 0))
    || (parts.slice(0, 5).every(part => part === 0) && (p5 === 0 || p5 === 0xffff))
    || (parts.slice(0, 4).every(part => part === 0) && p4 === 0xffff && p5 === 0)
    || (p4 === 0 && p5 === 0x5efe)
  ) {
    value = p6 * 0x10000 + p7;
  } else if (p0 === 0x2002) {
    value = p1 * 0x10000 + p2;
  } else if (p0 === 0x2001 && p1 === 0) {
    value = (p6 * 0x10000 + p7) ^ 0xffffffff;
  } else if (p0 === 0x64 && p1 === 0xff9b && p2 === 1 && (p4 >>> 8) === 0
    && (p5 & 0xff) === 0 && p6 === 0 && p7 === 0) {
    value = p3 * 0x10000 + ((p4 & 0xff) * 0x100) + (p5 >>> 8);
  }
  if (value === undefined) return undefined;
  const normalized = value >>> 0;
  return `${normalized >>> 24}.${(normalized >>> 16) & 0xff}.${(normalized >>> 8) & 0xff}.${normalized & 0xff}`;
}

function selectPublicAddresses(
  answers: readonly DshDnsAnswer[],
  pref64s: readonly Pref64[],
): readonly DshDnsAnswer[] {
  if (answers.length === 0) {
    throw new DshCanonicalWebError('unsafe_destination', 'Web destination has no DNS address');
  }
  for (const answer of answers) {
    const normalizedAddress = answer.address.split('%')[0] ?? answer.address;
    if (isIP(normalizedAddress) !== answer.family) {
      throw new DshCanonicalWebError('unsafe_destination', 'Web destination returned malformed DNS data');
    }
    const family = answer.family === 4 ? 'ipv4' : 'ipv6';
    const embedded = answer.family === 6 ? embeddedIpv4(normalizedAddress, pref64s) : undefined;
    if (
      blockedAddresses.check(normalizedAddress, family)
      || (embedded && blockedAddresses.check(embedded, 'ipv4'))
    ) {
      throw new DshCanonicalWebError('unsafe_destination', 'Web destination resolved to a non-public address');
    }
  }
  return answers;
}

function normalizeHeaders(headers: IncomingHttpHeaders): DshRawHttpResponse['headers'] {
  return Object.freeze(Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  ));
}

class NodePinnedHttpTransport implements DshSafeHttpTransport {
  constructor(private readonly maxCompressedBytes: number) {}

  dispatch(
    url: URL,
    address: DshDnsAnswer,
    request: Omit<DshSafeHttpRequest, 'signal'>,
    signal: AbortSignal,
  ): Promise<DshRawHttpResponse> {
    return new Promise((resolve, reject) => {
      const pinnedLookup = createDshPinnedLookup(address);
      const makeRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const client = makeRequest(url, {
        method: request.method,
        headers: request.headers,
        lookup: pinnedLookup,
        signal,
      }, (response) => {
        const chunks: Uint8Array[] = [];
        let total = 0;
        let settled = false;
        const fail = (error: unknown): void => {
          if (settled) return;
          settled = true;
          response.destroy();
          reject(error);
        };
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > this.maxCompressedBytes) {
            fail(new DshCanonicalWebError(
              'unsupported_content',
              'Web response exceeds its compressed byte bound',
            ));
            return;
          }
          chunks.push(Uint8Array.from(chunk));
        });
        response.once('error', fail);
        response.once('end', () => {
          if (settled) return;
          settled = true;
          resolve(Object.freeze({
            statusCode: response.statusCode ?? 0,
            headers: normalizeHeaders(response.headers),
            bytes: Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total),
          }));
        });
      });
      client.once('error', reject);
      if (request.body) client.end(request.body);
      else client.end();
    });
  }

}

type ProxyDispatcherEntry = {
  readonly proxy: string;
  readonly dispatcher: ProxyAgent;
  active: number;
  retired: boolean;
  closing?: Promise<void>;
};

export class DshNodeProxyHttpTransport implements DshSafeHttpProxyTransport {
  private current: ProxyDispatcherEntry | undefined;
  private readonly entries = new Set<ProxyDispatcherEntry>();
  private closed = false;

  constructor(private readonly maxCompressedBytes: number) {}

  async dispatch(
    url: URL,
    request: Omit<DshSafeHttpRequest, 'signal'>,
    signal: AbortSignal,
    proxy: string,
  ): Promise<DshRawHttpResponse> {
    signal.throwIfAborted();
    const entry = this.acquire(proxy);
    let responseStarted = false;
    try {
      const response = await undiciRequest(url, {
        dispatcher: entry.dispatcher,
        method: request.method,
        // Undici's ProxyAgent adds Host. The immutable description belongs to
        // the caller; each dispatch owns its own mutable transport headers.
        headers: { ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal,
      });
      responseStarted = true;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        const bytes = Uint8Array.from(chunk);
        total += bytes.byteLength;
        if (total > this.maxCompressedBytes) {
          throw new DshCanonicalWebError(
            'unsupported_content',
            'Web response exceeds its compressed byte bound',
          );
        }
        chunks.push(bytes);
      }
      return Object.freeze({
        statusCode: response.statusCode,
        headers: Object.freeze(response.headers),
        bytes: Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total),
      });
    } catch (error) {
      signal.throwIfAborted();
      throw dshCanonicalWebTransportError(error, 'proxy', responseStarted ? 'response_body' : undefined);
    } finally {
      this.release(entry);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.current = undefined;
    const closing = [...this.entries].map(entry => {
      entry.retired = true;
      return this.closeEntry(entry, true);
    });
    await Promise.all(closing);
  }

  private acquire(proxy: string): ProxyDispatcherEntry {
    if (this.closed) throw new DshCanonicalWebError('web_request_failed', 'Web transport is closed', { phase: 'request' });
    if (this.current?.proxy === proxy && !this.current.retired) {
      this.current.active += 1;
      return this.current;
    }
    if (this.current) {
      this.current.retired = true;
      void this.closeEntry(this.current, false);
    }
    const entry: ProxyDispatcherEntry = {
      proxy,
      dispatcher: new ProxyAgent(proxy),
      active: 1,
      retired: false,
    };
    this.entries.add(entry);
    this.current = entry;
    return entry;
  }

  private release(entry: ProxyDispatcherEntry): void {
    entry.active -= 1;
    if (entry.retired) void this.closeEntry(entry, false);
  }

  private closeEntry(entry: ProxyDispatcherEntry, force: boolean): Promise<void> {
    if (entry.closing) return entry.closing;
    if (!force && entry.active > 0) return Promise.resolve();
    entry.closing = (force ? entry.dispatcher.destroy() : entry.dispatcher.close())
      .catch(() => undefined)
      .finally(() => this.entries.delete(entry));
    return entry.closing;
  }
}

export function createDshPinnedLookup(address: DshDnsAnswer): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function oneHeader(
  headers: DshRawHttpResponse['headers'],
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : value?.length === 1 ? value[0] : undefined;
}

function decompress(
  bytes: Uint8Array,
  encoding: string | undefined,
  policy: DshSafeHttpPolicy,
): Uint8Array {
  const normalized = encoding?.trim().toLowerCase();
  let output: Uint8Array;
  try {
    const decompressionOptions = { maxOutputLength: policy.maxDecompressedBytes + 1 };
    if (!normalized || normalized === 'identity') output = bytes;
    else if (normalized === 'gzip' || normalized === 'x-gzip') output = gunzipSync(bytes, decompressionOptions);
    else if (normalized === 'deflate') output = inflateSync(bytes, decompressionOptions);
    else if (normalized === 'br') output = brotliDecompressSync(bytes, decompressionOptions);
    else throw new DshCanonicalWebError('unsupported_content', 'Web response encoding is unsupported');
  } catch (error) {
    if (error instanceof DshCanonicalWebError) throw error;
    throw new DshCanonicalWebError('unsupported_content', 'Web response decompression failed', { cause: error });
  }
  const ratioLimit = Math.max(bytes.byteLength, 1) * policy.maxCompressionRatio;
  if (output.byteLength > policy.maxDecompressedBytes || output.byteLength > ratioLimit) {
    throw new DshCanonicalWebError('unsupported_content', 'Web response exceeds decompression bounds');
  }
  return Uint8Array.from(output);
}

export class DshSafeHttpClient {
  private active = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];
  private readonly lookup: NonNullable<DshSafeHttpConfig['lookup']>;
  private readonly proxyForUrl: DshSafeHttpConfig['proxyForUrl'];
  private readonly proxyTransport: DshSafeHttpProxyTransport;
  private readonly transport: DshSafeHttpTransport;

  constructor(
    private readonly policy: DshSafeHttpPolicy,
    config: DshSafeHttpConfig = {},
  ) {
    this.lookup = config.lookup ?? systemLookup;
    this.proxyForUrl = config.proxyForUrl;
    this.proxyTransport = config.proxyTransport ?? new DshNodeProxyHttpTransport(policy.maxCompressedBytes);
    this.transport = config.transport ?? new NodePinnedHttpTransport(policy.maxCompressedBytes);
  }

  async request(rawUrl: string, request: DshSafeHttpRequest): Promise<DshSafeHttpResponse> {
    const release = await this.acquire(request.signal);
    const deadline = AbortSignal.timeout(this.policy.timeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);
    try {
      let current = parseSafeUrl(rawUrl, this.policy);
      const redirectOrigins: string[] = [];
      for (let redirectCount = 0; ; redirectCount += 1) {
        signal.throwIfAborted();
        let response: DshRawHttpResponse | undefined;
        const proxy = this.proxyForUrl?.(current.toString());
        const requestWithoutSignal = {
          method: request.method,
          headers: request.headers,
          body: request.body,
        } as const;
        if (proxy) {
          const literal = current.hostname.replace(/^\[|\]$/g, '');
          const family = isIP(literal);
          if (family === 4 || family === 6) {
            selectPublicAddresses([{ address: literal, family }], []);
          }
          try {
            response = await this.proxyTransport.dispatch(
              current,
              requestWithoutSignal,
              signal,
              proxy,
            );
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof DshCanonicalWebError) throw error;
            throw dshCanonicalWebTransportError(error, 'proxy');
          }
        } else {
          const answers = await this.lookup(current.hostname.replace(/^\[|\]$/g, ''), signal);
          if (!Array.isArray(answers) || answers.length > 64) {
            throw new DshCanonicalWebError('unsafe_destination', 'Web destination returned invalid DNS data');
          }
          signal.throwIfAborted();
          const pref64s = answers.some(answer => answer.family === 6) && isIP(current.hostname) === 0
            ? discoverPref64(await this.lookup('ipv4only.arpa', signal).catch((error: unknown) => {
                if (isDnsNoData(error)) return [];
                throw error;
              }))
            : [];
          const addresses = selectPublicAddresses(answers, pref64s);
          let lastConnectionError: unknown;
          for (const address of addresses) {
            const attemptDeadline = addresses.length > 1 ? AbortSignal.timeout(15_000) : undefined;
            const attemptSignal = attemptDeadline === undefined
              ? signal
              : AbortSignal.any([signal, attemptDeadline]);
            try {
              response = await this.transport.dispatch(current, address, requestWithoutSignal, attemptSignal);
              break;
            } catch (error) {
              signal.throwIfAborted();
              if (error instanceof DshCanonicalWebError) throw error;
              lastConnectionError = error;
            }
          }
          if (response === undefined) throw lastConnectionError ?? new Error('Web connection failed');
        }
        signal.throwIfAborted();
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          if (request.method !== 'GET' || redirectCount >= this.policy.maxRedirects) {
            throw new DshCanonicalWebError('unsafe_destination', 'Web response redirect is denied');
          }
          const location = oneHeader(response.headers, 'location');
          if (!location) {
            throw new DshCanonicalWebError('unsafe_destination', 'Web response redirect has no Location header');
          }
          const next = parseSafeUrl(new URL(location, current).toString(), this.policy);
          if (next.origin !== current.origin) redirectOrigins.push(next.origin);
          current = next;
          continue;
        }
        const declaredLength = oneHeader(response.headers, 'content-length');
        if (declaredLength !== undefined) {
          const length = Number(declaredLength);
          if (!Number.isSafeInteger(length) || length < 0 || length > this.policy.maxCompressedBytes) {
            throw new DshCanonicalWebError('unsupported_content', 'Web response length exceeds its bound');
          }
        }
        if (response.bytes.byteLength > this.policy.maxCompressedBytes) {
          throw new DshCanonicalWebError('unsupported_content', 'Web response exceeds its compressed byte bound');
        }
        const bytes = decompress(response.bytes, oneHeader(response.headers, 'content-encoding'), this.policy);
        const contentType = (oneHeader(response.headers, 'content-type')?.split(';', 1)[0]
          ?? 'application/octet-stream').trim().toLowerCase();
        return Object.freeze({
          statusCode: response.statusCode,
          headers: response.headers,
          bytes,
          contentType,
          finalUrl: current.toString(),
          redirectOrigins: Object.freeze(redirectOrigins),
        });
      }
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (deadline.aborted) {
        throw new DshCanonicalWebError('web_request_timeout', 'Web request exceeded its deadline', {
          phase: 'deadline',
          systemErrorClass: 'TimeoutError',
        });
      }
      throw dshCanonicalWebTransportError(error);
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    await this.proxyTransport.close?.();
  }

  private async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.policy.maxConcurrent) {
      this.active += 1;
      return this.releaseToken();
    }
    if (this.waiters.length >= this.policy.maxQueued) {
      throw new DshCanonicalWebError('network_policy_denied', 'Web request queue is full');
    }
    return await new Promise<() => void>((resolve, reject) => {
      const ready = (release: () => void): void => {
        signal.removeEventListener('abort', abort);
        resolve(release);
      };
      const abort = (): void => {
        const index = this.waiters.indexOf(ready);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.waiters.push(ready);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private releaseToken(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(this.releaseToken());
      else this.active -= 1;
    };
  }
}
