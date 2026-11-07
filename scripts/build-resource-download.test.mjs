import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { BUILD_DOWNLOAD_ATTEMPTS, BUILD_DOWNLOAD_TIMEOUT_MS, downloadBuildResource } from './build-resource-download.mjs';

const quiet = { maxBytes: 10, log() {}, sleep: async () => {} };

test('build downloads retain environment proxy routing and NO_PROXY bypass', async t => {
  const origin = createServer((_req, res) => res.end('direct'));
  const proxy = createServer();
  let proxyHits = 0;
  proxy.on('connect', (_req, socket) => {
    proxyHits++;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end(
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproxy',
    ));
  });
  for (const server of [origin, proxy]) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
  }
  const url = `http://127.0.0.1:${origin.address().port}/resource`;
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const script = `
    const url = ${JSON.stringify(url)};
    const before = await (await fetch(url)).text();
    const { downloadBuildResource } = await import(${JSON.stringify(new URL('./build-resource-download.mjs', import.meta.url).href)});
    const options = { maxBytes: 10, timeoutMs: 2000, attempts: 1, log() {} };
    const proxied = (await downloadBuildResource(url, options)).toString();
    process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1';
    const bypassed = (await downloadBuildResource(url, options)).toString();
    console.log(JSON.stringify({ before, proxied, bypassed }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--use-env-proxy', '--input-type=module', '-e', script], {
    env: { ...process.env, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' },
    timeout: 10_000,
  });
  assert.deepEqual(JSON.parse(stdout), { before: 'proxy', proxied: 'proxy', bypassed: 'direct' });
  assert.equal(proxyHits, 2);
});

test('real Node fetch uses the build budget for header and body transport timers', async t => {
  const server = createServer((_req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  const diagnostic = channel('undici:request:create');
  const capture = ({ request }) => {
    if (request.origin === origin) requests.push(request);
  };
  diagnostic.subscribe(capture);
  t.after(() => diagnostic.unsubscribe(capture));
  assert.equal((await downloadBuildResource(`${origin}/budget`, quiet)).toString(), 'ok');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headersTimeout, 1_800_000);
  assert.equal(requests[0].bodyTimeout, 1_800_000);
});

test('thirty-minute default covers every fresh attempt and retries a transient HTTP failure', async t => {
  assert.equal(BUILD_DOWNLOAD_TIMEOUT_MS, 1_800_000);
  const timeouts = []; const signals = []; const delays = [];
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return new AbortController().signal; });
  const result = await downloadBuildResource('https://example.invalid/a', { ...quiet,
    sleep: async ms => delays.push(ms),
    fetchImpl: async (_url, options) => {
      signals.push(options.signal);
      assert.equal(options.redirect, 'error');
      return signals.length === 1 ? new Response('busy', { status: 503 }) : new Response('ok');
    },
  });
  assert.equal(result.toString(), 'ok');
  assert.deepEqual(timeouts, [1_800_000, 1_800_000]);
  assert.notEqual(signals[0], signals[1]);
  assert.deepEqual(delays, [1000]);
});

test('transient transport errors stop after five attempts with actionable diagnostics', async () => {
  let calls = 0;
  await assert.rejects(downloadBuildResource('https://example.invalid/a', { ...quiet,
    fetchImpl: async () => { calls++; throw new TypeError('fetch failed'); },
  }), /example.invalid\/a.*attempt 5\/5.*1800s/);
  assert.equal(calls, 5);
});

for (const status of [401, 403, 404, 406]) {
  test(`HTTP ${status} fails immediately`, async () => {
    let calls = 0;
    await assert.rejects(downloadBuildResource('https://example.invalid/a', { ...quiet,
      fetchImpl: async () => { calls++; return new Response('no', { status }); },
    }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  });
}

test('oversized body is never retried', async () => {
  let calls = 0;
  await assert.rejects(downloadBuildResource('https://example.invalid/a', { ...quiet,
    fetchImpl: async () => { calls++; return new Response('too much data'); },
  }), /exceeds 10 bytes/);
  assert.equal(calls, 1);
});

test('real fetch body timeout retries the whole transfer, not just headers', async t => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(200); res.write('a');
    if (calls > 1) res.end('b');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const bytes = await downloadBuildResource(`http://127.0.0.1:${server.address().port}/slow`, {
    ...quiet, timeoutMs: 150,
  });
  assert.equal(bytes.toString(), 'ab');
  assert.equal(calls, 2);
});

// A flaky build must still be able to finish at the end of its retry budget.
test('fourth timeout can recover on the fifth attempt without reusing an aborted signal', async t => {
  const signals = []; const timeouts = []; const delays = [];
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return new AbortController().signal; });
  const bytes = await downloadBuildResource('https://example.invalid/runtime', { ...quiet,
    sleep: async ms => delays.push(ms),
    fetchImpl: async (_url, { signal }) => {
      signals.push(signal);
      if (signals.length < 5) throw new DOMException('slow transfer', 'TimeoutError');
      return new Response('complete');
    },
  });
  assert.equal(bytes.toString(), 'complete');
  assert.equal(new Set(signals).size, 5);
  assert.deepEqual(timeouts, Array(5).fill(1_800_000));
  assert.deepEqual(delays, Array.from({ length: 4 }, (_, i) => (i + 1) * 1000));
});

test('project npm and Cargo policies match the resource download budget', () => {
  const npmrc = readFileSync(new URL('../.npmrc', import.meta.url), 'utf8');
  const cargo = readFileSync(new URL('../.cargo/config.toml', import.meta.url), 'utf8');
  assert.equal(Number(npmrc.match(/^fetch-timeout=(\d+)$/m)?.[1]), BUILD_DOWNLOAD_TIMEOUT_MS);
  assert.equal(Number(npmrc.match(/^fetch-retries=(\d+)$/m)?.[1]), BUILD_DOWNLOAD_ATTEMPTS - 1);
  assert.equal(Number(cargo.match(/^timeout = (\d+)$/m)?.[1]), BUILD_DOWNLOAD_TIMEOUT_MS / 1000);
  assert.equal(Number(cargo.match(/^retry = (\d+)$/m)?.[1]), BUILD_DOWNLOAD_ATTEMPTS - 1);
});

test('resource owners can reserve a single attempt for an existing transport fallback', async () => {
  let calls = 0;
  await assert.rejects(downloadBuildResource('https://example.invalid/a', { ...quiet, attempts: 1,
    fetchImpl: async () => { calls++; throw new TypeError('fetch failed'); },
  }), /attempt 1\/1/);
  assert.equal(calls, 1);
  await assert.rejects(downloadBuildResource('https://example.invalid/a', { ...quiet, attempts: 0 }), /attempt count/);
});
