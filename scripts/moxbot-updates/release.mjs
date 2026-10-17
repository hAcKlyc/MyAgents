#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../..');
export const origin = 'https://140.143.183.232';
export const endpoint = `${origin}/updates/stable/darwin-aarch64.json`;
const platform = 'darwin-aarch64';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function validVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Only production MAJOR.MINOR.PATCH versions are allowed');
  }
  return value;
}
export function compareVersions(a, b) {
  const left = validVersion(a).split('.').map(BigInt);
  const right = validVersion(b).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function validateManifest(manifest) {
  validVersion(manifest.version);
  const url = new URL(manifest.url);
  if (manifest.url !== url.href || url.origin !== origin || url.username || url.password || url.search || url.hash ||
      url.href !== `${origin}/updates/releases/${manifest.version}/${path.basename(url.pathname)}` ||
      !/^[a-f0-9]{64}-MoXBots\.app\.tar\.gz$/.test(path.basename(url.pathname))) {
    throw new Error('Artifact URL must be HTTPS on the own immutable release path');
  }
  decode(manifest.signature, 'signature');
  if (typeof manifest.notes !== 'string' || manifest.notes.length > 20000 ||
      typeof manifest.pub_date !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(manifest.pub_date) ||
      !Number.isFinite(Date.parse(manifest.pub_date))) throw new Error('Invalid release notes or date');
  return manifest;
}
function decode(value, name) {
  if (typeof value !== 'string' || value.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
      Buffer.from(value, 'base64').toString('base64') !== value) throw new Error(`Invalid base64 ${name}`);
  const text = Buffer.from(value, 'base64').toString('utf8');
  if (!text.startsWith('untrusted comment:') || text.includes('\uFFFD')) throw new Error(`Invalid minisign ${name}`);
  return text;
}
function command(executable, args) {
  // Capture subprocess output: never inherit output from key-generating/signing tools.
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Validation command failed: ${path.basename(executable)} ${result.stderr?.trim() || result.error?.message || ''}`);
  return result.stdout;
}
function publicKey(config) {
  const value = readJson(config).plugins?.updater?.pubkey;
  decode(value, 'public key');
  return value;
}
function verify(archive, signature, key) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'moxbots-update-verify-'));
  try {
    fs.writeFileSync(path.join(temporary, 'pubkey'), decode(key, 'public key'), { mode: 0o600 });
    fs.writeFileSync(path.join(temporary, 'signature'), decode(signature, 'signature'), { mode: 0o600 });
    const helper = path.join(here, 'signature-verifier');
    command('cargo', ['build', '--offline', '--locked', '--release', '--manifest-path', path.join(helper, 'Cargo.toml')]);
    command(path.join(helper, 'target/release/moxbot-update-signature-verifier'),
      [archive, path.join(temporary, 'pubkey'), path.join(temporary, 'signature')]);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function regular(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('Input must be a regular file, not a link');
}
function directory(dir, mode = 0o755) {
  const absolute = path.resolve(dir);
  const existed = fs.existsSync(absolute);
  fs.mkdirSync(absolute, { recursive: true, mode });
  if (fs.realpathSync(absolute) !== absolute || !fs.lstatSync(absolute).isDirectory()) {
    throw new Error('Output directory must not contain symlinks');
  }
  if (!existed) fs.chmodSync(absolute, mode);
  return absolute;
}
function lock(root, work) {
  const lockPath = path.join(root, '.release-lock');
  try { fs.mkdirSync(lockPath, { mode: 0o700 }); }
  catch { throw new Error('Release lock exists; inspect active publisher before removing a stale lock'); }
  fs.writeFileSync(path.join(lockPath, 'owner.json'), json({ pid: process.pid, created: new Date().toISOString() }));
  try { return work(); } finally { fs.rmSync(lockPath, { recursive: true, force: true }); }
}
function hashFile(file) {
  // Keep archive hashing bounded in memory, even for bundled desktop runtimes.
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const bytes = Buffer.allocUnsafe(1024 * 1024);
  try { for (;;) { const n = fs.readSync(fd, bytes, 0, bytes.length, null); if (!n) break; hash.update(bytes.subarray(0, n)); } }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function inspect(file) { return JSON.parse(command('python3', [path.join(here, 'inspect-archive.py'), file])); }
function readCurrent(root) {
  const file = path.join(root, 'stable', `${platform}.json`);
  if (!fs.existsSync(file)) return null;
  regular(file);
  return validateManifest(readJson(file));
}
export function prepare(options) {
  const root = directory(options.out);
  const key = publicKey(options.config);
  regular(options.archive); regular(options.signature);
  const signature = fs.readFileSync(options.signature, 'utf8').trim();
  decode(signature, 'signature');
  return lock(root, () => {
    directory(path.join(root, 'releases'));
    const staging = fs.mkdtempSync(path.join(root, 'releases', '.prepare-'));
    try {
      const snapshot = path.join(staging, 'archive.tar.gz');
      fs.copyFileSync(options.archive, snapshot, fs.constants.COPYFILE_EXCL);
      verify(snapshot, signature, key);
      const app = inspect(snapshot);
      const version = validVersion(app.version);
      if (options.version && version !== validVersion(options.version)) throw new Error('Archive version does not match requested release');
      const digest = hashFile(snapshot);
      const size = fs.statSync(snapshot).size;
      const filename = `${digest}-MoXBots.app.tar.gz`;
      const manifest = validateManifest({ version, notes: options.notes ? fs.readFileSync(options.notes, 'utf8') : '',
        pub_date: new Date().toISOString(), url: `${origin}/updates/releases/${version}/${filename}`, signature });
      const current = readCurrent(root);
      if (current && compareVersions(version, current.version) < 0) throw new Error('Cannot prepare a downgrade from stable');
      if (current && version === current.version && manifest.url !== current.url) throw new Error('Same version has a different stable artifact');
      const destination = path.join(root, 'releases', version);
      if (fs.existsSync(destination)) {
        const existing = checkedRelease(root, version, key);
        if (existing.receipt.sha256 !== digest || existing.manifest.signature !== signature) throw new Error('Immutable version already exists with different artifact or signature');
        return { prepared: true, promoted: false, existing: true, manifest: existing.manifest };
      }
      fs.renameSync(snapshot, path.join(staging, filename));
      fs.chmodSync(path.join(staging, filename), 0o644);
      fs.writeFileSync(path.join(staging, 'manifest.json'), json(manifest), { flag: 'wx' });
      fs.writeFileSync(path.join(staging, 'receipt.json'), json({ schema: 1, platform, sha256: digest, size,
        publicKeySha256: sha(key), ...app, signatureVerified: true, preparedAt: manifest.pub_date }), { flag: 'wx', mode: 0o600 });
      fs.chmodSync(staging, 0o755);
      fs.renameSync(staging, destination);
      return { prepared: true, promoted: false, release: destination, manifest };
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  });
}
function checkedRelease(root, version, key) {
  validVersion(version);
  const dir = path.join(root, 'releases', version);
  if (fs.realpathSync(dir) !== dir || !fs.lstatSync(dir).isDirectory()) throw new Error('Invalid release directory');
  const manifestFile = path.join(dir, 'manifest.json');
  const receiptFile = path.join(dir, 'receipt.json');
  regular(manifestFile); regular(receiptFile);
  const manifest = validateManifest(readJson(manifestFile));
  const receipt = readJson(receiptFile);
  const file = path.join(dir, path.basename(new URL(manifest.url).pathname));
  regular(file);
  const digest = hashFile(file);
  if (manifest.version !== version || receipt.version !== version || receipt.platform !== platform ||
      receipt.publicKeySha256 !== sha(key) || receipt.sha256 !== digest ||
      path.basename(file) !== `${digest}-MoXBots.app.tar.gz` || receipt.size !== fs.statSync(file).size) throw new Error('Release receipt or artifact mismatch');
  verify(file, manifest.signature, key);
  const app = inspect(file);
  if (app.version !== version) throw new Error('Archive and manifest version mismatch');
  return { manifest, receipt };
}
export function promote(options, rollback = false) {
  const root = directory(options.out);
  const key = publicKey(options.config);
  return lock(root, () => {
    const { manifest } = checkedRelease(root, options.version, key);
    const current = readCurrent(root);
    if (!rollback && current && compareVersions(manifest.version, current.version) < 0) throw new Error('Downgrade requires explicit rollback command');
    if (current && manifest.version === current.version && manifest.url !== current.url) throw new Error('Same version cannot point at different artifact');
    if (rollback && !current) throw new Error('Rollback requires an existing stable release');
    const stable = directory(path.join(root, 'stable'));
    const history = directory(path.join(root, '.history'), 0o700);
    const stamp = `${Date.now()}-${crypto.randomUUID()}`;
    // Persist recovery evidence BEFORE switching stable. Never delete immutable releases.
    fs.writeFileSync(path.join(history, `${stamp}.json`), json({ action: rollback ? 'rollback' : 'promote',
      previous: current, next: manifest, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    const temporary = path.join(stable, `.darwin-aarch64-${stamp}.json`);
    const fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, json(manifest)); fs.fchmodSync(fd, 0o644); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, path.join(stable, `${platform}.json`));
    const dirFd = fs.openSync(stable, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    return { promoted: true, rollback, endpoint, version: manifest.version, previousVersion: current?.version ?? null };
  });
}
function argumentsFor(argv) {
  const [action, ...args] = argv;
  const options = { config: path.join(repository, 'src-tauri/tauri.moxbot.conf.json') };
  const allowed = new Set(['out', 'config', 'archive', 'signature', 'notes', 'version']);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !allowed.has(name) || !args[i + 1] || options[name] && name !== 'config') throw new Error('Invalid or repeated command option');
    options[name] = args[i + 1];
  }
  if (!options.out || !['prepare', 'promote', 'rollback'].includes(action) ||
      (action === 'prepare' ? !options.archive || !options.signature : !options.version)) {
    throw new Error('Usage: release.mjs prepare --out ROOT --archive APP.tar.gz --signature APP.tar.gz.sig [--notes FILE] [--version X.Y.Z] [--config PROFILE]; promote|rollback --out ROOT --version X.Y.Z [--config PROFILE]');
  }
  return { action, options };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { action, options } = argumentsFor(process.argv.slice(2));
    console.log(json(action === 'prepare' ? prepare(options) : promote(options, action === 'rollback')));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
