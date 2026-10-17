import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '..');

test('app, product-build config, Tauri config, and both Cargo packages share one release version', () => {
  const packageVersion = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version;
  for (const config of ['tauri.conf.json', 'tauri.moxbot.conf.json']) {
    assert.equal(JSON.parse(readFileSync(join(repository, `src-tauri/${config}`), 'utf8')).version, packageVersion);
  }
  for (const manifest of ['src-tauri/Cargo.toml', 'src-tauri/document-worker/Cargo.toml']) {
    const match = readFileSync(join(repository, manifest), 'utf8').match(/^version = "([^"]+)"$/m);
    assert.ok(match, `${manifest} must declare a package version`);
    assert.equal(match[1], packageVersion);
  }
  assert.match(readFileSync(join(repository, 'scripts/build-moxbot.mjs'), 'utf8'), /tauri\.moxbot\.conf\.json/);
});

test('version sync updates both build configs and both Cargo manifests', t => {
  const root = mkdtempSync(join(tmpdir(), 'moxbots-version-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src-tauri/document-worker'), { recursive: true });
  writeFileSync(join(root, 'scripts/sync-version.js'), readFileSync(join(repository, 'scripts/sync-version.js')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.5.9' }));
  for (const config of ['tauri.conf.json', 'tauri.moxbot.conf.json']) {
    writeFileSync(join(root, `src-tauri/${config}`), JSON.stringify({ version: '0.5.8' }));
  }
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "myagents"\nversion = "0.5.8"\n');
  writeFileSync(join(root, 'src-tauri/document-worker/Cargo.toml'), '[package]\nname = "worker"\nversion = "0.5.8"\n');

  const result = spawnSync(process.execPath, [join(root, 'scripts/sync-version.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const config of ['tauri.conf.json', 'tauri.moxbot.conf.json']) {
    assert.equal(JSON.parse(readFileSync(join(root, `src-tauri/${config}`), 'utf8')).version, '0.5.9');
  }
  for (const manifest of ['src-tauri/Cargo.toml', 'src-tauri/document-worker/Cargo.toml']) {
    assert.match(readFileSync(join(root, manifest), 'utf8'), /^version = "0\.5\.9"$/m);
  }
});

test('npm version stages the production MoxBots config and Document Worker manifest', () => {
  const packageJson = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  assert.match(packageJson.scripts.version, /src-tauri\/tauri\.moxbot\.conf\.json/);
  assert.match(packageJson.scripts.version, /src-tauri\/document-worker\/Cargo\.toml/);
});
