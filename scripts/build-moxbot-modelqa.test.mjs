import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, chmodSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appBuildDefines } from './app-build-profile.mjs';
import { parseModelQaArgs, modelQaBuildEnvironment } from './build-moxbot-modelqa.mjs';
import { modelQaLaunchEnvironment, prepareModelQaHome } from './run-moxbot-modelqa.mjs';

test('model QA has a closed fourth identity and never turns off updater QA model refusal', () => {
  for (const profile of ['myagents', 'moxbot', 'moxbot-updaterqa', 'moxbot-modelqa']) {
    const d = appBuildDefines({ MYAGENTS_BUILD_PROFILE: profile });
    assert.equal(d.__MYAGENTS_UPDATER_QA__, String(profile === 'moxbot-updaterqa'));
    assert.equal(d.__MYAGENTS_MODEL_QA__, String(profile === 'moxbot-modelqa'));
  }
  const args = ['--qa-workspace', '/private/tmp/modelqa-build-fixture-' + process.pid, '--qa-version', '0.5.5'];
  assert.equal(parseModelQaArgs(args).version, '0.5.5');
  for (const flag of ['--config', '--features', '--runner', '--debug', '--target=x86_64-apple-darwin']) assert.throws(() => parseModelQaArgs([...args, '--', flag]));
  assert.throws(() => parseModelQaArgs(['--qa-workspace', '/Applications/MoXBots.app', '--qa-version', '0.5.5']));
  const env = modelQaBuildEnvironment({ OPENAI_API_KEY: 'canary', CLAUDE_CONFIG_DIR: '/daily', NODE_OPTIONS: '--require=/daily', RUSTFLAGS: '--cfg myagents_updater_qa' }, '/private/tmp/test');
  assert.equal(env.MYAGENTS_BUILD_PROFILE, 'moxbot-modelqa');
  for (const key of ['OPENAI_API_KEY', 'CLAUDE_CONFIG_DIR', 'NODE_OPTIONS', 'RUSTFLAGS']) assert.equal(env[key], undefined);
});

test('native model QA config cannot address production state or register autostart/hotkeys', () => {
  const d = JSON.parse(readFileSync(new URL('../src-tauri/tauri.moxbot-modelqa.conf.json', import.meta.url)));
  assert.equal(d.identifier, 'com.moxbot.modelqa');
  assert.deepEqual(d.plugins['deep-link'].desktop.schemes, ['moxbot-modelqa']);
  assert.deepEqual(d.app.security.assetProtocol.scope, ['$HOME/.moxbot-modelqa/**']);
  assert.deepEqual(d.plugins.updater, { pubkey: '', endpoints: [] });
  const permissions = d.app.security.capabilities[0].permissions;
  assert.equal(permissions.some(p => typeof p === 'string' && /^(autostart|global-shortcut):/.test(p)), false);
  assert.deepEqual(permissions.find(p => p.identifier === 'fs:scope').allow.map(p => p.path), ['$HOME/.moxbot-modelqa', '$HOME/.moxbot-modelqa/**']);
});

test('launch environment rejects shared/symlink/world-readable homes and poisoned inherited credentials', { skip: process.platform !== 'darwin' }, () => {
  const home = mkdtempSync('/private/tmp/moxbots-modelqa-test-');
  chmodSync(home, 0o700);
  const env = modelQaLaunchEnvironment(home, { USER: 'qa', OPENAI_API_KEY: 'canary', CODEX_HOME: '/daily', NODE_OPTIONS: '--require=/daily', PATH: '/daily' });
  assert.equal(env.HOME, home);
  assert.equal(env.CODEX_HOME, join(home, '.moxbot-modelqa/codex'));
  assert.equal(env.CLAUDE_CONFIG_DIR, join(home, '.moxbot-modelqa/claude'));
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  chmodSync(home, 0o755); assert.throws(() => modelQaLaunchEnvironment(home)); chmodSync(home, 0o700);
  const alias = join(mkdtempSync(join(tmpdir(), 'modelqa-alias-')), 'home'); symlinkSync(home, alias);
  assert.throws(() => modelQaLaunchEnvironment(alias));
  assert.throws(() => modelQaLaunchEnvironment('/Users/qa'));
});

test('launcher preflight refuses linked data/auth/config even inside a private HOME', { skip: process.platform !== 'darwin' }, () => {
  const outside = mkdtempSync('/private/tmp/modelqa-outside-');
  for (const child of ['.moxbot-modelqa', '.moxbot-modelqa/codex', '.moxbot-modelqa/claude', '.moxbot-modelqa/config.json']) {
    const home = mkdtempSync('/private/tmp/moxbots-modelqa-links-'); chmodSync(home, 0o700);
    const parent = child.includes('/') ? join(home, '.moxbot-modelqa') : home;
    if (parent !== home) mkdirSync(parent, { mode: 0o700 });
    symlinkSync(outside, join(home, child));
    assert.throws(() => prepareModelQaHome(home));
  }
  const home = mkdtempSync('/private/tmp/moxbots-modelqa-dangling-'); chmodSync(home, 0o700);
  prepareModelQaHome(home);
  symlinkSync(join(outside, 'missing-credentials.json'), join(home, '.moxbot-modelqa/codex/auth.json'));
  assert.throws(() => prepareModelQaHome(home));
});
