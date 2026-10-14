import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepare, promote, validVersion, compareVersions, validateManifest, origin } from './release.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const cli = path.join(repo, 'node_modules/@tauri-apps/cli/tauri.js');
function run(binary, args) {
  const env = { ...process.env };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  const result = spawnSync(binary, args, { encoding: 'utf8', env });
  // CLI key-generation prints private-key material; never include subprocess stdout in test output.
  assert.equal(result.status, 0, 'Fixture command failed (output intentionally suppressed)');
  return result;
}
test('release versions and URL constraints reject downgrade aliases and external destinations', () => {
  assert.equal(compareVersions('0.5.10', '0.5.9'), 1);
  assert.equal(compareVersions('0.5.2', '0.5.2'), 0);
  for (const version of ['../a', '01.0.0', '0.5.3-dev', 'v0.5.3']) assert.throws(() => validVersion(version));
  const signature = Buffer.from('untrusted comment: fixture\n').toString('base64');
  const good = { version: '0.5.3', pub_date: '2026-10-14T00:00:00.000Z', notes: '', signature,
    url: `${origin}/updates/releases/0.5.3/${'a'.repeat(64)}-MoXBots.app.tar.gz` };
  assert.equal(validateManifest(good), good);
  for (const url of [good.url.replace('https:', 'http:'), good.url.replace('140.143.183.232', 'evil.example'),
    good.url + '?token=bad', good.url.replace('/0.5.3/', '/0.5.2/'),
    good.url.replace('/releases/', '/releases/../releases/')]) {
    assert.throws(() => validateManifest({ ...good, url }));
  }
});
test('real CLI minisign verification, immutable preparation, promotion, rollback and hostile archives', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moxbots-release-test-')));
  const out = path.join(base, 'updates');
  const key = path.join(base, 'fixture.key');
  try {
    run(process.execPath, [cli, 'signer', 'generate', '--ci', '-p', '', '-w', key]);
    fs.chmodSync(key, 0o600);
    const config = path.join(base, 'profile.json');
    fs.writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: fs.readFileSync(`${key}.pub`, 'utf8').trim() } } }));
    function make(version, variant = 'normal') {
      const archive = path.join(base, `${version}-${variant}.tar.gz`);
      run('python3', [path.join(here, 'fixture-archive.py'), archive, version, variant]);
      run(process.execPath, [cli, 'signer', 'sign', '-f', key, '-p', '', archive]);
      return { out, archive, signature: `${archive}.sig`, config };
    }
    const first = make('0.5.3');
    const prepared = prepare(first);
    assert.equal(prepared.promoted, false);
    assert.equal(fs.statSync(prepared.release).mode & 0o777, 0o755);
    assert.equal(fs.existsSync(path.join(out, 'stable/darwin-aarch64.json')), false);
    assert.equal(prepare(first).existing, true);
    assert.equal(promote({ out, config, version: '0.5.3' }).version, '0.5.3');
    assert.equal(fs.statSync(path.join(out, 'stable/darwin-aarch64.json')).mode & 0o777, 0o644);
    assert.throws(() => prepare(make('0.5.2')), /downgrade/);
    assert.throws(() => prepare(make('0.5.3', 'different')), /different/);
    const second = prepare(make('0.5.4'));
    assert.equal(promote({ out, config, version: '0.5.4' }).previousVersion, '0.5.3');
    assert.throws(() => promote({ out, config, version: '0.5.3' }), /Downgrade/);
    assert.equal(promote({ out, config, version: '0.5.3' }, true).rollback, true);
    assert.equal(fs.readdirSync(path.join(out, '.history')).length, 3);
    assert.equal(fs.existsSync(path.join(out, 'releases/0.5.4')), true);
    for (const variant of ['wrong-brand', 'wrong-arch', 'traversal', 'escape-link', 'chain-escape', 'cycle', 'duplicate', 'under-link']) {
      assert.throws(() => prepare(make('0.5.5', variant)), /Archive rejected/);
    }
    const tampered = make('0.5.6');
    fs.appendFileSync(tampered.archive, 'tampered');
    assert.throws(() => prepare(tampered), /signature verification rejected/);
    const comment = make('0.5.7');
    const decoded = Buffer.from(fs.readFileSync(comment.signature, 'utf8').trim(), 'base64').toString('utf8');
    fs.writeFileSync(comment.signature, Buffer.from(decoded.replace('\ntrusted comment:', '\ntrusted comment: modified')).toString('base64'));
    assert.throws(() => prepare(comment), /signature verification rejected/);
    const immutableArchive = path.join(out, new URL(second.manifest.url).pathname.slice('/updates/'.length));
    fs.appendFileSync(immutableArchive, 'tampered');
    assert.throws(() => promote({ out, config, version: '0.5.4' }), /mismatch/);
    const stableBefore = fs.readFileSync(path.join(out, 'stable/darwin-aarch64.json'), 'utf8');
    const changedKey = path.join(base, 'other.key');
    run(process.execPath, [cli, 'signer', 'generate', '--ci', '-p', '', '-w', changedKey]);
    fs.writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: fs.readFileSync(`${changedKey}.pub`, 'utf8').trim() } } }));
    assert.throws(() => prepare(first), /signature verification rejected/);
    assert.equal(fs.readFileSync(path.join(out, 'stable/darwin-aarch64.json'), 'utf8'), stableBefore);
    assert.equal(fs.existsSync(path.join(out, '.release-lock')), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
