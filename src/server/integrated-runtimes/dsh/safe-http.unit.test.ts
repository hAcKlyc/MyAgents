import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { dshCanonicalWebTransportError } from './canonical-web-errors';
import {
  DshSafeHttpClient,
  DshNodeProxyHttpTransport,
  createDshPinnedLookup,
  type DshDnsAnswer,
  type DshRawHttpResponse,
  type DshSafeHttpPolicy,
  type DshSafeHttpProxyTransport,
  type DshSafeHttpTransport,
} from './safe-http';

const policy: DshSafeHttpPolicy = Object.freeze({
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
  it.each(['127.0.0.1', '::1'])('reaches a real %s development server through OS localhost resolution', async host => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.method ?? '');
      response.end('local development');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port: 0, ipv6Only: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local server address');
    const client = new DshSafeHttpClient(policy);
    try {
      for (const hostname of ['localhost', host === '::1' ? '[::1]' : host]) {
        for (const method of ['GET', 'POST'] as const) {
          const result = await client.request(`http://${hostname}:${address.port}/development`, {
            method, signal: AbortSignal.timeout(2000),
          });
          expect(Buffer.from(result.bytes).toString()).toBe('local development');
        }
      }
      expect(requests).toEqual(['GET', 'POST', 'GET', 'POST']);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([
    ['http://localhost:3000/page', '127.0.0.1', 4],
    ['http://[::1]:8080/page', '::1', 6],
    ['http://service.local:9000/page', '192.168.1.2', 4],
    ['http://service.lan:1234/page', '10.0.0.2', 4],
    ['https://service.internal:8443/page', '198.18.2.98', 4],
    ['http://metadata.google.internal/page', '169.254.169.254', 4],
    ['http://service.home/page', '::ffff:127.0.0.1', 6],
  ] as const)('admits %s for content GET and Provider POST', async (url, address, family) => {
    const lookup = vi.fn(async () => [{ address, family }]);
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async () => raw(200, Buffer.from('local content')));
    const client = new DshSafeHttpClient(policy, { lookup, transport: { dispatch } });
    try {
      for (const method of ['GET', 'POST'] as const) {
        const result = await client.request(url, {
          method, ...(method === 'POST' ? { body: Buffer.from('local request') } : {}),
          signal: new AbortController().signal,
        });
        expect(Buffer.from(result.bytes).toString()).toBe('local content');
      }
      expect(dispatch).toHaveBeenCalledTimes(2);
      for (const call of dispatch.mock.calls) expect(call[1]).toEqual({ address, family });
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
    }
  });

  it('keeps frozen GET and Provider POST headers isolated through real proxy reuse, concurrency and rotation', async () => {
    const sockets = new Set<Duplex>();
    const received: Array<{ method: string; host: string; credential: string; body: string }> = [];
    const tunneled = createServer(async (request, response) => {
      sockets.add(request.socket);
      let body = '';
      for await (const chunk of request) body += String(chunk);
      received.push({
        method: request.method!, host: request.headers.host!,
        credential: String(request.headers.authorization ?? request.headers['x-api-key'] ?? ''), body,
      });
      response.end('ok');
    });
    let connects = 0;
    const proxies = [createServer(), createServer()];
    const routes: string[] = [];
    const transport = new DshNodeProxyHttpTransport(policy.maxCompressedBytes);
    try {
      for (const proxy of proxies) {
        proxy.on('connect', (_request, socket) => {
          connects += 1;
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          tunneled.emit('connection', socket);
        });
        await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
        const address = proxy.address();
        if (!address || typeof address === 'string') throw new Error('Missing proxy fixture address');
        routes.push(`http://127.0.0.1:${address.port}`);
      }
      const headers = [
        Object.freeze({ accept: 'text/html' }),
        Object.freeze({ authorization: 'Bearer synthetic-a', 'content-type': 'application/json' }),
        Object.freeze({ 'x-api-key': 'synthetic-b', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }),
      ];
      const before = JSON.stringify(headers);
      for (const route of routes) {
        for (let repeat = 0; repeat < 2; repeat += 1) {
          const results = await Promise.all(headers.map((entry, index) => transport.dispatch(
            new URL(`http://127.0.0.${index + 2}/page`), {
              method: index === 0 ? 'GET' : 'POST', headers: entry,
              ...(index === 0 ? {} : { body: Buffer.from(`{"index":${index}}`) }),
            }, new AbortController().signal, route,
          )));
          expect(results.map(result => Buffer.from(result.bytes).toString())).toEqual(['ok', 'ok', 'ok']);
        }
      }
      expect(JSON.stringify(headers)).toBe(before);
      expect(headers.every(entry => !Object.hasOwn(entry, 'host'))).toBe(true);
      expect(received).toHaveLength(12);
      for (const entry of received) {
        const index = Number(entry.host.split('.').at(-1)) - 2;
        expect(entry.credential).toBe(['', 'Bearer synthetic-a', 'synthetic-b'][index]);
        expect(entry.body).toBe(index === 0 ? '' : `{"index":${index}}`);
        expect(entry.method).toBe(index === 0 ? 'GET' : 'POST');
      }
      expect(connects).toBeLessThan(received.length);
      const beforeInvalidHeaders = connects;
      await expect(transport.dispatch(new URL('http://127.0.0.2/'), {
        method: 'GET', headers: Object.freeze({ 'invalid header': 'synthetic-private-value' }),
      }, new AbortController().signal, routes[1]!)).rejects.toMatchObject({
        code: 'web_request_failed', phase: 'request_construction',
      });
      expect(connects).toBe(beforeInvalidHeaders);
      const cancelled = new AbortController();
      cancelled.abort(new Error('fixture cancellation'));
      const previousConnects = connects;
      await expect(transport.dispatch(new URL('http://127.0.0.2/'), {
        method: 'GET', headers: headers[0],
      }, cancelled.signal, routes[1]!)).rejects.toBe(cancelled.signal.reason);
      expect(connects).toBe(previousConnects);
      await transport.close();
      await expect(transport.dispatch(new URL('http://127.0.0.2/'), {
        method: 'GET', headers: headers[0],
      }, new AbortController().signal, routes[1]!)).rejects.toMatchObject({ code: 'web_request_failed' });
    } finally {
      await transport.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all(proxies.map(proxy => new Promise<void>(resolve => proxy.close(() => resolve()))));
      tunneled.close();
    }
  });

  it.each([
    ['TypeError', 'request_construction'], ['ENOTFOUND', 'dns'],
    ['ECONNREFUSED', 'proxy_connect'], ['CERT_HAS_EXPIRED', 'tls'],
    ['UND_ERR_HEADERS_TIMEOUT', 'response_headers'], ['UND_ERR_BODY_TIMEOUT', 'response_body'],
  ] as const)('classifies %s without exposing private error content', (code, phase) => {
    const original = code === 'TypeError' ? new TypeError('private body secret')
      : Object.assign(new Error('private body secret'), { code });
    const error = dshCanonicalWebTransportError(original, 'proxy');
    expect(error.phase).toBe(phase);
    expect(error.message).not.toContain('private');
  });

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

  it('tries the next validated address when the first connection fails', async () => {
    const dispatch = vi.fn(async (_url: URL, address: DshDnsAnswer) => {
      if (address.address === '93.184.216.34') {
        throw Object.assign(new Error('first address unavailable'), { code: 'ECONNREFUSED' });
      }
      return raw(200, Buffer.from('fallback'), { 'content-type': 'text/plain' });
    });
    const client = new DshSafeHttpClient(policy, {
      lookup: vi.fn(async () => [
        { address: '93.184.216.34', family: 4 as const },
        { address: '93.184.216.35', family: 4 as const },
      ]),
      transport: { dispatch },
    });

    const result = await client.request('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(Buffer.from(result.bytes).toString('utf8')).toBe('fallback');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('uses explicit proxy DNS without invoking the direct resolver', async () => {
    const lookup = vi.fn(async () => [{ address: '198.18.0.185', family: 4 as const }]);
    const proxyTransport = {
      dispatch: vi.fn(async () => raw(200, Buffer.from('proxied'), {
        'content-type': 'text/plain',
      })),
    } satisfies DshSafeHttpProxyTransport;
    const client = new DshSafeHttpClient(policy, {
      lookup,
      proxyForUrl: () => 'http://127.0.0.1:7897',
      proxyTransport,
    });

    const result = await client.request('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    });

    expect(Buffer.from(result.bytes).toString('utf8')).toBe('proxied');
    expect(lookup).not.toHaveBeenCalled();
    expect(proxyTransport.dispatch).toHaveBeenCalledWith(
      new URL('https://example.com/'),
      expect.objectContaining({ method: 'GET' }),
      expect.any(AbortSignal),
      'http://127.0.0.1:7897',
    );

    await expect(client.request('http://127.0.0.1/', {
      method: 'GET',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ statusCode: 200 });
    expect(proxyTransport.dispatch).toHaveBeenCalledTimes(2);
  });

  it('identifies the configured proxy path when its transport cannot connect', async () => {
    const client = new DshSafeHttpClient(policy, {
      lookup: publicLookup(),
      proxyForUrl: () => 'http://127.0.0.1:7897',
      proxyTransport: {
        dispatch: vi.fn(async () => {
          throw Object.assign(new Error('synthetic proxy refusal'), { code: 'ECONNREFUSED' });
        }),
      },
    });

    await expect(client.request('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'web_connect_failed',
      message: 'Web connection through the configured proxy was refused (ECONNREFUSED). Check the destination and proxy availability, then retry.',
      phase: 'proxy_connect',
      systemErrorClass: 'ECONNREFUSED',
    });
  });

  it('classifies a proxy connection timeout without claiming generic network failure', async () => {
    const client = new DshSafeHttpClient(policy, {
      proxyForUrl: () => 'http://127.0.0.1:7897',
      proxyTransport: {
        dispatch: vi.fn(async () => {
          throw Object.assign(new Error('synthetic timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
        }),
      },
    });

    await expect(client.request('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'web_request_timeout',
      message: 'Web proxy connection timed out',
      phase: 'proxy_connect',
      systemErrorClass: 'UND_ERR_CONNECT_TIMEOUT',
    });
  });

  it('reuses the composition-owned proxy dispatcher across sequential requests', async () => {
    const sockets = new Set<Duplex>();
    let connectCount = 0;
    const proxy = createServer();
    proxy.on('connect', (_request, socket) => {
      connectCount += 1;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      let buffered = '';
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('latin1');
        while (buffered.includes('\r\n\r\n')) {
          buffered = buffered.slice(buffered.indexOf('\r\n\r\n') + 4);
          socket.write([
            'HTTP/1.1 200 OK',
            'Content-Type: text/plain',
            'Content-Length: 2',
            'Connection: keep-alive',
            '',
            'ok',
          ].join('\r\n'));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Proxy fixture has no TCP address');

    try {
      const transport = new DshNodeProxyHttpTransport(policy.maxCompressedBytes);
      for (let index = 0; index < 5; index += 1) {
        const response = await transport.dispatch(new URL('http://127.0.0.2/reuse'), {
          method: 'GET',
        }, new AbortController().signal, `http://127.0.0.1:${address.port}`);
        expect(Buffer.from(response.bytes).toString('utf8')).toBe('ok');
      }
      expect(connectCount).toBeLessThan(5);
      await transport.close();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });

  it('follows redirects to local services and pins each resolved address', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async url => url.pathname === '/start'
      ? raw(302, new Uint8Array(), { location: 'http://private.example:3000/final' })
      : raw(200, Buffer.from('local page')));
    const lookup = vi.fn(async (hostname: string): Promise<readonly DshDnsAnswer[]> => (
      hostname === 'private.example' ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }]
    ));
    const client = new DshSafeHttpClient(policy, { lookup, transport: { dispatch } });
    const result = await client.request('https://example.com/start', { method: 'GET', signal: new AbortController().signal });
    expect(Buffer.from(result.bytes).toString()).toBe('local page');
    expect(result.finalUrl).toBe('http://private.example:3000/final');
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]?.[1]).toEqual({ address: '127.0.0.1', family: 4 });
    expect(lookup).toHaveBeenNthCalledWith(2, 'private.example', expect.any(AbortSignal));
  });

  it('accepts mixed DNS answers, Fake-IP and IPv6 translation addresses', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async () => raw(200));
    for (const answers of [
      [{ address: '93.184.216.34', family: 4 as const }, { address: '10.0.0.2', family: 4 as const }],
      [{ address: '198.18.2.98', family: 4 as const }],
      [{ address: '::ffff:127.0.0.1', family: 6 as const }],
      [{ address: '64:ff9b:1::c0a8:1', family: 6 as const }],
    ]) {
      const lookup = vi.fn(async () => answers);
      const client = new DshSafeHttpClient(policy, { lookup, transport: { dispatch } });
      await expect(client.request('https://example.com', { method: 'GET', signal: new AbortController().signal }))
        .resolves.toMatchObject({ statusCode: 200 });
      expect(lookup).toHaveBeenCalledOnce();
    }
    expect(dispatch).toHaveBeenCalledTimes(4);
  });

  it.each(['cancellation', 'deadline'] as const)('waits for DNS settlement after %s without dispatching HTTP', async mode => {
    const dns = Promise.withResolvers<readonly DshDnsAnswer[]>();
    const started = Promise.withResolvers<AbortSignal>();
    const controller = new AbortController();
    const reason = new Error('cancel DNS');
    let resolutions = 0;
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async () => raw(200));
    const client = new DshSafeHttpClient({ ...policy, maxConcurrent: 1, maxQueued: 0,
      timeoutMs: mode === 'deadline' ? 10 : policy.timeoutMs }, {
      lookup: async (_hostname, signal) => {
        resolutions += 1;
        if (resolutions > 1) return [{ address: '127.0.0.1', family: 4 }];
        started.resolve(signal);
        return dns.promise;
      },
      transport: { dispatch },
    });
    try {
      const pending = client.request('http://localhost:3000/', { method: 'GET', signal: controller.signal });
      const signal = await started.promise;
      let settled = false;
      void pending.finally(() => { settled = true; }).catch(() => undefined);
      const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      if (mode === 'cancellation') controller.abort(reason);
      await aborted;
      expect(settled).toBe(false);
      await expect(client.request('http://localhost:3000/queued', { method: 'GET', signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'network_policy_denied' });
      dns.resolve([{ address: '127.0.0.1', family: 4 }]);
      if (mode === 'cancellation') await expect(pending).rejects.toBe(reason);
      else await expect(pending).rejects.toMatchObject({ code: 'web_request_timeout' });
      expect(dispatch).not.toHaveBeenCalled();
      await expect(client.request('http://localhost:3000/next', { method: 'GET', signal: new AbortController().signal }))
        .resolves.toMatchObject({ statusCode: 200 });
    } finally {
      await client.close();
    }
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
