import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

type FixtureEvent = {
  mode: 'stream' | 'static' | 'error' | 'cancel';
  event: 'reply-start' | 'partial' | 'deliver' | 'idle' | 'fully-complete' | 'dispatch-idle' | 'done';
  payload?: Record<string, unknown>;
  kind?: string;
  result?: Record<string, unknown>;
};

const FIXTURE_PLUGIN_SOURCE = String.raw`
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const eventsPath = process.env.FIXTURE_EVENTS_PATH;
const releasePath = process.env.FIXTURE_RELEASE_PATH;

function record(event) {
  appendFileSync(eventsPath, JSON.stringify(event) + '\n');
}

async function waitForRelease() {
  while (!existsSync(releasePath)) await delay(10);
}

async function runInbound(runtime, mode) {
  const { dispatcher, replyOptions, markDispatchIdle } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      onReplyStart: () => record({ mode, event: 'reply-start' }),
      onIdle: () => record({ mode, event: 'idle' }),
      deliver: async (payload, info) => {
        record({ mode, event: 'deliver', payload, kind: info.kind });
      },
    });

  const result = await runtime.channel.reply.dispatchReplyFromConfig({
    ctx: {
      To: 'chat:same-chat',
      SenderId: 'fixture-user',
      ChatType: 'direct',
      Body: mode,
    },
    dispatcher,
    replyOptions: {
      ...replyOptions,
      ...(mode === 'stream'
        ? {
            onPartialReply: async (payload) => {
              record({ mode, event: 'partial', payload });
              await waitForRelease();
            },
          }
        : {}),
    },
  });
  // Mirror the installed Lark plugin's terminal lifecycle: drain every
  // plugin-owned delivery before sealing its renderer, then release its chat
  // queue. The fixture intentionally keeps those renderer hooks local.
  await dispatcher.waitForIdle();
  record({ mode, event: 'fully-complete' });
  markDispatchIdle();
  record({ mode, event: 'dispatch-idle' });
  record({ mode, event: 'done', result });
}

export default {
  register(api) {
    const runtime = api.runtime;
    api.registerChannel({
      id: 'fixture',
      name: 'Reply Transport Fixture',
      config: {
        isConfigured: () => true,
        resolveAccount: () => ({ accountId: 'default', enabled: true }),
      },
      gateway: {
        startAccount: async (ctx) => {
          ctx.setStatus({ running: true, connected: true, lastEventAt: Date.now() });
          await Promise.all([
            runInbound(runtime, 'stream'),
            runInbound(runtime, 'static'),
            runInbound(runtime, 'error'),
            runInbound(runtime, 'cancel'),
          ]);
        },
        stopAccount: async () => {},
      },
    });
  },
};
`;

function readFixtureEvents(path: string): FixtureEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as FixtureEvent);
}

async function waitFor<T>(
  probe: () => T | undefined | null | false,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function listenOnRandomPort(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not expose a TCP port');
  return address.port;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listenOnRandomPort(server);
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

async function waitForExit(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>(resolveExit => child.once('exit', () => resolveExit())),
    delay(timeoutMs).then(() => {
      child.kill('SIGKILL');
    }),
  ]);
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Plugin Bridge request-scoped reply transport', () => {
  it.each([true, false])('recovers same-chat input after a failed empty terminal handoff (admission patch: %s)', async patchMatches => {
    const scratch = mkdtempSync(join(tmpdir(), 'myagents-wecom-terminal-'));
    const eventsPath = join(scratch, 'events.ndjson');
    const pluginDir = join(scratch, 'openclaw-plugins', 'fixture-install');
    const packageDir = join(pluginDir, 'node_modules', '@fixture', 'wecom-terminal');
    const vendorDir = join(pluginDir, 'node_modules', '@wecom', 'wecom-openclaw-plugin');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(join(vendorDir, 'dist', 'src'), { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ private: true, dependencies: { '@fixture/wecom-terminal': '1.0.0' } }));
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@fixture/wecom-terminal', version: '1.0.0', type: 'module', keywords: ['openclaw'], openclaw: { extensions: ['./index.mjs'], channel: { id: 'fixture' } } }));
    writeFileSync(join(vendorDir, 'package.json'), JSON.stringify({ type: 'module' }));
    const source = readFileSync(new URL('./fixtures/wecom-chat-queue-2026.9.15.txt', import.meta.url), 'utf8');
    writeFileSync(join(vendorDir, 'dist', 'src', 'chat-queue.js'), patchMatches ? source : source.replace('prev.then(task, task)', 'prev.then(() => task(), () => task())'));
    writeFileSync(join(packageDir, 'index.mjs'), String.raw`
      import { appendFileSync } from 'node:fs';
      import { enqueueWeComChatTask } from '@wecom/wecom-openclaw-plugin/dist/src/chat-queue.js';
      const record = event => appendFileSync(process.env.FIXTURE_EVENTS_PATH, JSON.stringify(event) + '\n');
      export default { register(api) { api.registerChannel({
        id: 'fixture', name: 'WeCom terminal fixture',
        config: { isConfigured: () => true, resolveAccount: () => ({ accountId: 'default', enabled: true }) },
        gateway: { startAccount: async ctx => {
          ctx.setStatus({ running: true, connected: true });
          const run = async mode => {
            record({ mode, event: 'reply-start' });
            const result = await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: { To: 'wecom:same-chat', SenderId: 'sender', Body: mode, AccountId: 'default', ChatType: 'direct' },
              dispatcherOptions: { deliver: async payload => record({ mode, event: 'deliver', payload }) },
            });
            record({ mode, event: 'done', result });
          };
          const first = enqueueWeComChatTask({ accountId: 'default', chatId: 'same-chat', task: () => run('static') });
          const next = enqueueWeComChatTask({ accountId: 'default', chatId: 'same-chat', task: () => run('stream') });
          await Promise.all([first.promise, next.promise]);
        }, stopAccount: async () => {} },
      }); } };
    `);
    const inputs: Array<Record<string, unknown>> = [];
    const rustServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        inputs.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      });
    });
    let child: ChildProcess | undefined;
    let output = '';
    try {
      const rustPort = await listenOnRandomPort(rustServer);
      const bridgePort = await reservePort();
      child = spawn(process.execPath, ['--import', 'tsx/esm', resolve('src/server/plugin-bridge/index.ts'),
        '--plugin-dir', pluginDir, '--port', String(bridgePort), '--rust-port', String(rustPort), '--bot-id', 'fixture-bot'], {
        cwd: process.cwd(), env: { ...process.env, HOME: scratch, BRIDGE_PLUGIN_CONFIG: '{}', FIXTURE_EVENTS_PATH: eventsPath, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', chunk => { output += chunk.toString(); });
      child.stderr?.on('data', chunk => { output += chunk.toString(); });
      await waitFor(() => inputs.length >= (patchMatches ? 2 : 1), `initial ingress\n${output}`);
      expect(output.includes('WeCom admission patch target not found')).toBe(!patchMatches);
      expect(readFixtureEvents(eventsPath).some(event => event.event === 'done')).toBe(false);
      // No terminal reached the Bridge during the failed handoff. Rust owns
      // retrying this same request; the Bridge must keep its dispatcher alive.
      expect(output).not.toContain('canonical_final');
      const firstId = String(inputs.find(body => body.text === 'static')?.requestId);
      const complete = async (requestId: string, finalPayloads: unknown[]) => {
        const response = await postJson(`http://127.0.0.1:${bridgePort}`, '/complete-dispatch', { requestId, finalPayloads });
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      };
      if (patchMatches) {
        // The input lane is independent of the missing first terminal.
        await complete(String(inputs.find(body => body.text === 'stream')?.requestId), [{ text: 'next answer' }]);
        await waitFor(() => readFixtureEvents(eventsPath).some(event => event.mode === 'stream' && event.event === 'done'), 'independent follow-up completion');
      }
      await complete(firstId, []);
      await complete(firstId, []); // Lost ACK retry must not run the renderer twice.
      await waitFor(() => inputs.length === 2, 'serial fallback releases the next input');
      if (!patchMatches) await complete(String(inputs[1].requestId), [{ text: 'next answer' }]);
      await waitFor(() => readFixtureEvents(eventsPath).filter(event => event.event === 'done').length === 2, 'both dispatchers settle');
      expect(readFixtureEvents(eventsPath).filter(event => event.mode === 'static' && event.event === 'deliver')).toEqual([]);
      expect(readFixtureEvents(eventsPath).filter(event => event.mode === 'stream' && event.event === 'deliver')).toHaveLength(1);
      expect(output.match(new RegExp(`canonical_final[^\\n]*requestId=${firstId}`, 'g'))).toHaveLength(1);
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await waitForExit(child);
      }
      rustServer.closeAllConnections();
      await closeServer(rustServer);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('ACKs slow partials, isolates same-chat requests, and preserves canonical finals', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'myagents-reply-transport-'));
    const eventsPath = join(scratch, 'events.ndjson');
    const releasePath = join(scratch, 'release');
    const pluginDir = join(scratch, 'openclaw-plugins', 'fixture-install');
    const pluginPackageDir = join(pluginDir, 'node_modules', '@fixture', 'reply-transport');
    mkdirSync(pluginPackageDir, { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
      private: true,
      dependencies: { '@fixture/reply-transport': '1.0.0' },
    }));
    writeFileSync(join(pluginPackageDir, 'package.json'), JSON.stringify({
      name: '@fixture/reply-transport',
      version: '1.0.0',
      type: 'module',
      keywords: ['openclaw'],
      openclaw: {
        extensions: ['./index.mjs'],
        channel: { id: 'fixture' },
      },
    }));
    // A changed vendor module must not prevent an otherwise working plugin
    // from starting just because a compatibility patch no longer matches.
    const vendorDir = join(pluginDir, 'node_modules', '@wecom', 'wecom-openclaw-plugin');
    mkdirSync(join(vendorDir, 'dist', 'src'), { recursive: true });
    writeFileSync(join(vendorDir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(vendorDir, 'dist', 'src', 'monitor.js'), 'export const upstreamRevision = "next";');
    writeFileSync(join(pluginPackageDir, 'index.mjs'),
      `import '@wecom/wecom-openclaw-plugin/dist/src/monitor.js';\n${FIXTURE_PLUGIN_SOURCE}`);

    const ingressBodies: Array<Record<string, unknown>> = [];
    const rustServer = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/api/im-bridge/message') {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        ingressBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
      });
    });

    let child: ChildProcess | undefined;
    let output = '';
    try {
      const rustPort = await listenOnRandomPort(rustServer);
      const bridgePort = await reservePort();
      const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;
      child = spawn(process.execPath, [
        '--import',
        'tsx/esm',
        resolve('src/server/plugin-bridge/index.ts'),
        '--plugin-dir', pluginDir,
        '--port', String(bridgePort),
        '--rust-port', String(rustPort),
        '--bot-id', 'fixture-bot',
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: scratch,
          BRIDGE_PLUGIN_CONFIG: '{}',
          FIXTURE_EVENTS_PATH: eventsPath,
          FIXTURE_RELEASE_PATH: releasePath,
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', chunk => { output += chunk.toString(); });
      child.stderr?.on('data', chunk => { output += chunk.toString(); });

      await waitFor(
        () => ingressBodies.length === 4 ? ingressBodies : undefined,
        `four fixture ingress messages\n${output}`,
      );
      expect(output).toContain('wecom context/delivery patch target not found; loading upstream code');
      const streamIngress = ingressBodies.find(body => body.text === 'stream');
      const staticIngress = ingressBodies.find(body => body.text === 'static');
      const errorIngress = ingressBodies.find(body => body.text === 'error');
      const cancelIngress = ingressBodies.find(body => body.text === 'cancel');
      expect(streamIngress).toMatchObject({
        chatId: 'same-chat',
        deliveryProtocol: 'openclaw-reply',
      });
      expect(staticIngress).toMatchObject({
        chatId: 'same-chat',
        deliveryProtocol: 'openclaw-reply',
      });
      const streamRequestId = String(streamIngress?.requestId);
      const staticRequestId = String(staticIngress?.requestId);
      const errorRequestId = String(errorIngress?.requestId);
      const cancelRequestId = String(cancelIngress?.requestId);
      expect(streamRequestId).not.toBe(staticRequestId);
      expect(new Set([streamRequestId, staticRequestId, errorRequestId, cancelRequestId]).size).toBe(4);

      expect((await postJson(bridgeBaseUrl, '/start-dispatch', { requestId: streamRequestId })).ok).toBe(true);
      const streamStartResponse = await postJson(bridgeBaseUrl, '/start-stream', {
        requestId: streamRequestId,
        chatId: 'same-chat',
        initialContent: 'stream-0',
      });
      expect(streamStartResponse.ok).toBe(true);
      const streamId = String((await streamStartResponse.json() as { streamId: string }).streamId);
      await waitFor(
        () => readFixtureEvents(eventsPath).find(event => event.mode === 'stream' && event.event === 'partial'),
        'blocked streaming partial callback',
      );

      for (let index = 1; index <= 50; index += 1) {
        const response = await postJson(bridgeBaseUrl, '/stream-chunk', {
          streamId,
          content: `stream-${index}`,
          sequence: index + 1,
        });
        expect(response.ok).toBe(true);
      }
      expect((await postJson(bridgeBaseUrl, '/finish-stream-block', { streamId })).ok).toBe(true);
      const canonicalFinal = { text: 'stream-final', metadata: { source: 'producer' } };
      expect((await postJson(bridgeBaseUrl, '/complete-dispatch', {
        requestId: streamRequestId,
        finalPayloads: [canonicalFinal],
      })).ok).toBe(true);

      // The streaming callback is still blocked. A second request in the same
      // chat must independently reach its final delivery and settle.
      expect((await postJson(bridgeBaseUrl, '/start-dispatch', { requestId: staticRequestId })).ok).toBe(true);
      const staticStartResponse = await postJson(bridgeBaseUrl, '/start-stream', {
        requestId: staticRequestId,
        chatId: 'same-chat',
        initialContent: 'static-preview',
      });
      const staticStreamId = String((await staticStartResponse.json() as { streamId: string }).streamId);
      expect((await postJson(bridgeBaseUrl, '/finish-stream-block', { streamId: staticStreamId })).ok).toBe(true);
      expect((await postJson(bridgeBaseUrl, '/complete-dispatch', {
        requestId: staticRequestId,
        finalPayloads: [{ text: 'static-final' }],
      })).ok).toBe(true);

      for (const terminal of [
        { requestId: errorRequestId, reason: 'model error', text: 'error-final', isError: true },
        { requestId: cancelRequestId, reason: 'cancelled', text: 'cancel-final', isError: false },
      ]) {
        expect((await postJson(bridgeBaseUrl, '/start-dispatch', {
          requestId: terminal.requestId,
        })).ok).toBe(true);
        expect((await postJson(bridgeBaseUrl, '/abort-dispatch', {
          requestId: terminal.requestId,
          reason: terminal.reason,
          terminalPayload: { text: terminal.text, isError: terminal.isError },
        })).ok).toBe(true);
      }

      await waitFor(
        () => readFixtureEvents(eventsPath).find(event => event.mode === 'static' && event.event === 'done'),
        'same-chat static dispatch settlement',
      );
      let events = readFixtureEvents(eventsPath);
      expect(events.filter(event => event.mode === 'static' && event.event === 'partial')).toEqual([]);
      expect(events.find(event => event.mode === 'static' && event.event === 'deliver')).toMatchObject({
        kind: 'final',
        payload: { text: 'static-final' },
      });
      expect(events.find(event => event.mode === 'stream' && event.event === 'deliver')).toBeUndefined();
      expect(events.find(event => event.mode === 'error' && event.event === 'deliver')).toMatchObject({
        kind: 'final',
        payload: { text: 'error-final', isError: true },
      });
      expect(events.find(event => event.mode === 'cancel' && event.event === 'deliver')).toMatchObject({
        kind: 'final',
        payload: { text: 'cancel-final', isError: false },
      });

      writeFileSync(releasePath, 'release');
      await waitFor(
        () => readFixtureEvents(eventsPath).find(event => event.mode === 'stream' && event.event === 'done'),
        'streaming dispatch settlement after release',
      );
      events = readFixtureEvents(eventsPath);
      expect(events
        .filter(event => event.mode === 'stream' && event.event === 'partial')
        .map(event => event.payload?.text))
        .toEqual(['stream-0', 'stream-50']);
      expect(events.find(event => event.mode === 'stream' && event.event === 'deliver')).toMatchObject({
        kind: 'final',
        payload: canonicalFinal,
      });
      for (const mode of ['stream', 'static', 'error', 'cancel'] as const) {
        const lifecycle = events
          .filter(event => event.mode === mode)
          .map(event => event.event);
        expect(lifecycle.indexOf('deliver')).toBeLessThan(lifecycle.indexOf('fully-complete'));
        expect(lifecycle.indexOf('fully-complete')).toBeLessThan(lifecycle.indexOf('idle'));
        expect(lifecycle.indexOf('idle')).toBeLessThan(lifecycle.indexOf('dispatch-idle'));
        expect(lifecycle.indexOf('fully-complete')).toBeLessThan(lifecycle.indexOf('dispatch-idle'));
        expect(lifecycle.indexOf('dispatch-idle')).toBeLessThan(lifecycle.indexOf('done'));
      }
      await waitFor(
        () => (output.match(/plugin_delivery_settled/g)?.length ?? 0) === 4,
        `four plugin renderer settlements\n${output}`,
      );

      const lateChunk = await postJson(bridgeBaseUrl, '/stream-chunk', {
        streamId,
        content: 'late',
      });
      expect(lateChunk.status).toBe(404);
      const missingDispatch = await postJson(bridgeBaseUrl, '/start-dispatch', { requestId: 'missing' });
      expect(missingDispatch.status).toBe(404);
    } finally {
      // Unblock the fixture before asking the Bridge to stop so cleanup never
      // depends on a test assertion having reached the release point.
      if (!existsSync(releasePath)) appendFileSync(releasePath, 'release');
      if (child && child.exitCode === null) {
        const bridgePortMatch = output.match(/HTTP server listening on port (\d+)/);
        if (bridgePortMatch) {
          await postJson(`http://127.0.0.1:${bridgePortMatch[1]}`, '/stop', {}).catch(() => undefined);
        }
        await waitForExit(child);
      }
      await closeServer(rustServer);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});
