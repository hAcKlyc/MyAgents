import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getOpenClawConfigSnapshot, setOpenClawConfigSnapshot } from '../plugin-bridge/openclaw-config';

const require = createRequire(new URL('../plugin-bridge/sdk-shim/package.json', import.meta.url));
const sdk = (name: string) => import(pathToFileURL(require.resolve(`openclaw/plugin-sdk/${name}`)).href);

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'bridge-sdk-contract-'));
  vi.stubEnv('HOME', scratch);
  vi.stubEnv('USERPROFILE', scratch);
  setOpenClawConfigSnapshot({ channels: { sample: { enabled: true } }, unrelated: { keep: true } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
  setOpenClawConfigSnapshot({ channels: {} });
});

describe('SDK temp paths — executable contracts across public subpaths', () => {
  it.each(['temp-path', 'diffs', 'browser-support', 'browser-security-runtime', 'llm-task', 'security-runtime', 'sandbox'])(
    '%s returns the legacy Bridge temp root for module-load media and logger paths', async (name) => {
      const current = await sdk(name);
      const legacy = await sdk('infra-runtime');
      expect(current.resolvePreferredOpenClawTmpDir).toBe(legacy.resolvePreferredOpenClawTmpDir);
      const root = current.resolvePreferredOpenClawTmpDir();
      expect(root).toBe(path.join(scratch, '.myagents', 'tmp'));
      // The exact 2.4.10 import-time operation that failed before registration.
      expect(path.join(root, 'weixin/media/outbound-temp')).toContain('outbound-temp');
      const log = path.join(root, 'openclaw-test.log');
      writeFileSync(log, 'test');
      expect(readFileSync(log, 'utf8')).toBe('test');
    },
  );

  it('creates isolated download targets and sanitizes names on every platform', async () => {
    const temp = await sdk('temp-path');
    const target = await temp.createTempDownloadTarget({ prefix: '../download', fileName: '..\\outside.txt', tmpDir: scratch });
    expect(path.dirname(target.path)).toBe(target.dir);
    expect(path.dirname(target.file('../../other.txt'))).toBe(target.dir);
    expect(path.dirname(target.file('..\\other.txt'))).toBe(target.dir);
    writeFileSync(target.path, 'payload');
    expect(readFileSync(target.path, 'utf8')).toBe('payload');
    await target[Symbol.asyncDispose]();
    expect(existsSync(target.dir)).toBe(false);
    await target.cleanup();
  });

  it('cleans downloads after both successful and failed callbacks', async () => {
    const temp = await sdk('temp-path');
    let downloaded = '';
    const run = (fail: boolean) => temp.withTempDownloadPath({ prefix: 'download', tmpDir: scratch }, async (file: string) => {
      downloaded = file;
      writeFileSync(file, 'payload');
      if (fail) throw new Error('download failed');
      return readFileSync(file, 'utf8');
    });
    await expect(run(false)).resolves.toBe('payload');
    expect(existsSync(path.dirname(downloaded))).toBe(false);
    await expect(run(true)).rejects.toThrow('download failed');
    expect(existsSync(path.dirname(downloaded))).toBe(false);
  });
});

describe('SDK migration preserves Bridge owners and legacy entry points', () => {
  it('protects relocated implementations from regeneration and synchronizes installed-shim freshness', () => {
    const base = new URL('../plugin-bridge/sdk-shim/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('plugin-sdk/_handwritten.json', base), 'utf8'));
    for (const name of ['temp-path', 'diffs', 'browser-support', 'browser-security-runtime', 'llm-task', 'security-runtime', 'sandbox', 'config-mutation', 'config-runtime', 'channel-ingress-runtime', 'channel-outbound', 'channel-message', 'channel-runtime']) {
      expect(manifest).toContain(name);
      expect(require.resolve(`openclaw/plugin-sdk/${name}`)).toContain(`${name}.js`);
    }
    const pkg = JSON.parse(readFileSync(new URL('package.json', base), 'utf8'));
    const version = pkg.version.replace(/-shim$/, '');
    const runtime = readFileSync(new URL('../plugin-bridge/compat-runtime.ts', import.meta.url), 'utf8');
    const rust = readFileSync(new URL('../../../src-tauri/src/im/bridge.rs', import.meta.url), 'utf8');
    expect(runtime.match(/const SHIM_COMPAT_VERSION = '([^']+)'/)?.[1]).toBe(version);
    expect(rust.match(/const SHIM_COMPAT_VERSION: &str = "([^"]+)"/)?.[1]).toBe(version);
  });

  it('shares typing callbacks between all three released import paths', async () => {
    const [legacy, middle, current] = await Promise.all(['channel-runtime', 'channel-message', 'channel-outbound'].map(sdk));
    expect(current.createTypingCallbacks).toBe(legacy.createTypingCallbacks);
    expect(middle.createTypingCallbacks).toBe(legacy.createTypingCallbacks);
    const callbacks = current.createTypingCallbacks({ start: vi.fn(), stop: vi.fn() });
    await expect(callbacks.onReplyStart()).resolves.toBeUndefined();
    expect(callbacks.onIdle()).toBeUndefined();
    expect(callbacks.onCleanup()).toBeUndefined();
  });

  it('keeps new ingress on the existing Rust-owned authorization path', async () => {
    const current = await sdk('channel-ingress-runtime');
    const legacy = await sdk('command-auth');
    const readStoreAllowFrom = vi.fn(async () => ['old-openclaw-owner']);
    const result = await current.resolveChannelMessageIngress({
      channelId: 'sample', accountId: 'account',
      identity: { primary: { normalize: (value: string) => value, sensitivity: 'pii' } },
      subject: { stableId: 'user-authorized-by-myagents' },
      conversation: { kind: 'direct', id: 'user-authorized-by-myagents' },
      event: { kind: 'message', authMode: 'inbound', mayPair: true },
      policy: { dmPolicy: 'pairing', groupPolicy: 'disabled' },
      readStoreAllowFrom,
      command: { allowTextCommands: true, hasControlCommand: true },
    });
    const previous = await legacy.resolveSenderCommandAuthorizationWithRuntime({});
    expect(result.senderAccess.allowed).toBe(previous.senderAllowedForCommands);
    expect(result.commandAccess.authorized).toBe(previous.commandAuthorized);
    expect(result.commandAccess.requested).toBe(true);
    // A second pairing store would reject Rust-authorized senders before Rust admission.
    expect(readStoreAllowFrom).not.toHaveBeenCalled();
  });

  it('does not report command authorization when no command gate was requested', async () => {
    const current = await sdk('channel-ingress-runtime');
    const result = await current.resolveChannelMessageIngress({ policy: {}, subject: {}, conversation: { kind: 'direct' } });
    expect(result.senderAccess.allowed).toBe(true);
    expect(result.commandAccess).toMatchObject({ requested: false, authorized: false, shouldBlockControlCommand: false });
  });

  it('runs the new config mutation callback against the current snapshot without touching disk', async () => {
    const current = await sdk('config-mutation');
    const legacy = await sdk('config-runtime');
    const result = await current.mutateConfigFile({
      afterWrite: { mode: 'auto' },
      mutate(draft: Record<string, unknown>) { draft.updated = 'now'; return 'callback-result'; },
    });
    expect(result.nextConfig).toMatchObject({ updated: 'now', unrelated: { keep: true } });
    expect(result.result).toBe('callback-result');
    expect(legacy.loadConfig()).toEqual(getOpenClawConfigSnapshot());
    expect(legacy.loadConfig()).toMatchObject({ updated: 'now', channels: { sample: { enabled: true } } });
    expect(existsSync(path.join(scratch, '.openclaw'))).toBe(false);
    expect(existsSync(path.join(scratch, '.myagents', 'config.json'))).toBe(false);
  });

  it('serializes async mutations and recovers after a rejected callback', async () => {
    const current = await sdk('config-mutation');
    const first = current.mutateConfigFile({ mutate: async (draft: Record<string, unknown>) => {
      await Promise.resolve(); draft.first = true;
    } });
    const second = current.mutateConfigFile({ mutate: (draft: Record<string, unknown>) => { draft.second = true; } });
    await Promise.all([first, second]);
    await expect(current.mutateConfigFile({ mutate: (draft: Record<string, unknown>) => {
      draft.leaked = true; throw new Error('mutation failed');
    } })).rejects.toThrow('mutation failed');
    await current.mutateConfigFile({ mutate: (draft: Record<string, unknown>) => { draft.third = true; } });
    expect(getOpenClawConfigSnapshot()).toMatchObject({ first: true, second: true, third: true });
    expect(getOpenClawConfigSnapshot()).not.toHaveProperty('leaked');
  });

  it('detects a legacy write during an async mutation instead of overwriting newer state', async () => {
    const current = await sdk('config-mutation');
    const legacy = await sdk('config-runtime');
    await expect(current.mutateConfigFile({ mutate: async (draft: Record<string, unknown>) => {
      legacy.writeConfigFile({ channels: {}, newer: true });
      await Promise.resolve(); draft.stale = true;
    } })).rejects.toThrow(/changed/);
    expect(getOpenClawConfigSnapshot()).toMatchObject({ newer: true });
    expect(getOpenClawConfigSnapshot()).not.toHaveProperty('stale');
  });

  it('rejects a suspended draft when the host replaces its runtime snapshot', async () => {
    const current = await sdk('config-mutation');
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const pending = current.mutateConfigFile({ mutate: async (draft: Record<string, unknown>) => {
      started();
      await resume;
      draft.stale = true;
    } });
    await entered;
    setOpenClawConfigSnapshot({ channels: { sample: { enabled: false } }, hostUpdate: true });
    release();
    await expect(pending).rejects.toThrow(/changed/);
    expect(getOpenClawConfigSnapshot()).toEqual({ channels: { sample: { enabled: false } }, hostUpdate: true });
    await current.mutateConfigFile({ mutate: (draft: Record<string, unknown>) => { draft.recovered = true; } });
    expect(getOpenClawConfigSnapshot()).toHaveProperty('recovered', true);
  });

  it.each(['io', 'base', 'baseHash', 'writeOptions'])('rejects unsupported %s file transactions without calling the callback', async key => {
    const current = await sdk('config-mutation');
    const mutate = vi.fn();
    const before = getOpenClawConfigSnapshot();
    await expect(current.mutateConfigFile({ [key]: {}, mutate })).rejects.toThrow(/runtime snapshot/);
    expect(mutate).not.toHaveBeenCalled();
    expect(getOpenClawConfigSnapshot()).toEqual(before);
  });

  it('preserves legacy function mutation, copy isolation, and load/write contracts', async () => {
    const legacy = await sdk('config-runtime');
    const mutated = legacy.mutateConfigFile((draft: Record<string, unknown>) => { draft.legacy = true; });
    expect(mutated).toMatchObject({ legacy: true });
    const input = { channels: { sample: { enabled: false } } };
    legacy.writeConfigFile(input);
    input.channels.sample.enabled = true;
    expect(legacy.loadConfig().channels.sample.enabled).toBe(false);
  });
});
