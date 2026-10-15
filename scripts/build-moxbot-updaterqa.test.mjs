import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appBuildDefines, resolveAppBuildProfile } from './app-build-profile.mjs';
import { parseQaBuildArgs, qaBuildEnvironment } from './build-moxbot-updaterqa.mjs';

function args(extra = []) {
  return ['--qa-workspace', `/private/tmp/moxbots-qa-fixture-${process.pid}`, '--qa-public-key', '/private/tmp/fixture.key.pub', '--qa-endpoint', 'http://127.0.0.1:54321/updates/{{target}}.json', '--qa-version', '0.5.2', ...extra];
}
test('all explicit MoXBots capability lists include main-window zoom without granting it to floating windows', () => {
  const zoom = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/ui-zoom.json', import.meta.url)));
  assert.deepEqual(zoom.windows, ['main']);
  assert.deepEqual(zoom.permissions, ['core:webview:allow-set-webview-zoom']);
  for (const profile of ['moxbot', 'moxbot-updaterqa', 'moxbot-modelqa']) {
    const config = JSON.parse(readFileSync(new URL(`../src-tauri/tauri.${profile}.conf.json`, import.meta.url)));
    assert.ok(config.app.security.capabilities.includes(zoom.identifier), `${profile} must load the zoom capability`);
  }
});
test('QA requires independent endpoint/config/features/workspace and never accepts production options', () => {
  const plan = parseQaBuildArgs(args(['--', '--target', 'aarch64-apple-darwin', '--no-bundle']));
  assert.equal(plan.endpoint, 'http://127.0.0.1:54321/updates/{{target}}.json');
  for (const malicious of ['https://140.143.183.232/updates/{{target}}.json', 'http://localhost:54321/updates/{{target}}.json', 'http://127.0.0.1:99999/updates/{{target}}.json', 'http://127.0.0.1:54321/updates/{{target}}.json?token=secret']) {
    const modified = args(); modified[5] = malicious;
    assert.throws(() => parseQaBuildArgs(modified));
  }
  for (const option of ['--config', '--config=override.json', '--features=moxbot-credential-reader', '--debug', '-f']) {
    assert.throws(() => parseQaBuildArgs(args(['--', option])));
  }
  const invalidRoot = args(); invalidRoot[1] = '/Applications/MoXBots.app';
  assert.throws(() => parseQaBuildArgs(invalidRoot));
  const key = args(); key[3] = '/private/tmp/private.key';
  assert.throws(() => parseQaBuildArgs(key));
});
test('Vite/Node profile definitions agree and QA build strips production credentials without mutating caller env', () => {
  assert.equal(resolveAppBuildProfile({}), 'myagents');
  assert.throws(() => resolveAppBuildProfile({ MYAGENTS_BUILD_PROFILE: 'typo' }));
  assert.equal(appBuildDefines({ MYAGENTS_BUILD_PROFILE: 'moxbot' }).__MYAGENTS_UPDATER_QA__, 'false');
  assert.deepEqual(appBuildDefines({ MYAGENTS_BUILD_PROFILE: 'moxbot-updaterqa' }), { __MYAGENTS_BUILD_PROFILE__: '"moxbot-updaterqa"', __MYAGENTS_UPDATER_QA__: 'true', __MYAGENTS_MODEL_QA__: 'false' });
  const input = { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'canary', MOXBOTS_CREDENTIAL_WRITER_FAMILY: 'developer-id-v2', TAURI_CONFIG: 'production', RUSTFLAGS: '--cfg myagents_moxbot', TAURI_SIGNING_PRIVATE_KEY: 'secret', MYAGENTS_BUILD_PROFILE: 'moxbot' };
  const env = qaBuildEnvironment(input, '/private/tmp/qa-workspace');
  assert.equal(input.ANTHROPIC_API_KEY, 'canary');
  assert.equal(env.MYAGENTS_BUILD_PROFILE, 'moxbot-updaterqa');
  assert.equal(env.MYAGENTS_SPACE_ENABLED, 'false');
  for (const key of ['ANTHROPIC_API_KEY', 'MOXBOTS_CREDENTIAL_WRITER_FAMILY', 'TAURI_CONFIG', 'RUSTFLAGS', 'TAURI_SIGNING_PRIVATE_KEY']) assert.equal(env[key], undefined);
  assert.equal(env.CARGO_TARGET_DIR, '/private/tmp/qa-workspace/src-tauri/target');
});
test('QA config has distinct OS identity and grants no production app data scope', () => {
  const qa = JSON.parse(readFileSync(new URL('../src-tauri/tauri.moxbot-updaterqa.conf.json', import.meta.url)));
  assert.equal(qa.identifier, 'com.moxbot.updaterqa');
  assert.equal(qa.productName, 'MoXBots Updater QA');
  assert.deepEqual(qa.plugins['deep-link'].desktop.schemes, ['moxbot-updaterqa']);
  assert.deepEqual(qa.app.security.assetProtocol.scope, ['$HOME/.moxbot-updaterqa/**']);
  const fsScope = qa.app.security.capabilities[0].permissions.find(item => typeof item === 'object' && item.identifier === 'fs:scope');
  assert.deepEqual(fsScope.allow.map(item => item.path), ['$HOME/.moxbot-updaterqa', '$HOME/.moxbot-updaterqa/**']);
  assert.equal(qa.plugins.updater.pubkey, '');
  assert.deepEqual(qa.plugins.updater.endpoints, []);
  const production = JSON.parse(readFileSync(new URL('../src-tauri/tauri.moxbot.conf.json', import.meta.url)));
  assert.equal(production.plugins.updater.dangerousInsecureTransportProtocol, undefined);
  assert.ok(production.plugins.updater.endpoints.every(url => url.startsWith('https://')));
});
