import { lookup as lookupOsHostname } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { ProxyAgent, request as undiciRequest } from 'undici';

import { DshCanonicalWebError, dshCanonicalWebTransportError } from './canonical-web-errors';

export type DshDnsAnswer = Readonly<{ address: string; family: 4 | 6 }>;

export type DshSafeHttpPolicy = Readonly<{
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

function parseHttpUrl(rawUrl: string): URL {
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
  url.hash = '';
  return url;
}

async function systemLookup(hostname: string, signal: AbortSignal): Promise<readonly DshDnsAnswer[]> {
  signal.throwIfAborted();
  const literal = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(literal);
  if (family === 4 || family === 6) return Object.freeze([{ address: literal, family }]);
  const answers = await lookupOsHostname(hostname, { all: true });
  signal.throwIfAborted();
  return Object.freeze(answers.map(answer => Object.freeze({ address: answer.address, family: answer.family as 4 | 6 })));
}

function validateAddresses(answers: readonly DshDnsAnswer[]): readonly DshDnsAnswer[] {
  if (answers.length === 0) {
    throw new DshCanonicalWebError('unsafe_destination', 'Web destination has no DNS address');
  }
  for (const answer of answers) {
    if (isIP(answer.address) !== answer.family) {
      throw new DshCanonicalWebError('unsafe_destination', 'Web destination returned malformed DNS data');
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
      let current = parseHttpUrl(rawUrl);
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
          const addresses = validateAddresses(answers);
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
          const next = parseHttpUrl(new URL(location, current).toString());
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
