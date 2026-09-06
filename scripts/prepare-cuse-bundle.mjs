import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FEED = 'https://download.myagents.io/cuse/bundles';
const MAX_BYTES = 64 * 1024 * 1024;
const hash = data => createHash('sha256').update(data).digest('hex');
const requireValue = (value, message) => { if (!value) throw new Error(`Cuse bundle: ${message}`); };
const stableVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
const safePath = value => typeof value === 'string' && value.split('/').every(part =>
  /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..' && !part.endsWith('.')
  && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));

export function cusePlatform(target) {
  if (['aarch64-apple-darwin', 'x86_64-apple-darwin', 'universal-apple-darwin'].includes(target)) return 'macos-universal';
  if (target === 'x86_64-pc-windows-msvc') return 'windows-x64';
  if (/^(x86_64|aarch64)-unknown-linux-(gnu|musl)$/.test(target)) return null;
  throw new Error(`Unsupported Cuse build target: ${target}; pass an explicit Rust target triple`);
}

function checkDescriptor(value, url) {
  requireValue(value?.url === url && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_BYTES, 'invalid artifact descriptor');
}
function checkBytes(data, descriptor) {
  requireValue(data.length === descriptor.size && hash(data) === descriptor.sha256, 'artifact size/SHA256 mismatch');
}

async function download(url, limit) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'myagents-cuse-builder', 'Cache-Control': 'no-cache' },
    redirect: 'error', signal: AbortSignal.timeout(120_000),
  });
  requireValue(response.ok, `download failed: HTTP ${response.status} (${url})`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireValue(size <= limit, 'download exceeds expected size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function checkMetadata(meta, platform, version, commit) {
  const entrypoint = platform === 'macos-universal' ? 'scripts/cuse' : 'scripts/cuse.exe';
  requireValue(meta?.schema_version === 1 && meta.name === 'cuse' && meta.kind === 'skill'
    && meta.platform === platform && meta.version === version && meta.source_commit === commit
    && meta.entrypoint === entrypoint && Array.isArray(meta.args) && meta.args.length === 0,
  'package identity/entrypoint mismatch');
  requireValue(meta.files && !Array.isArray(meta.files) && typeof meta.files === 'object', 'missing file inventory');
  for (const required of ['SKILL.md', 'LICENSE', entrypoint]) requireValue(Object.hasOwn(meta.files, required), `missing ${required}`);
  for (const [path, info] of Object.entries(meta.files)) {
    requireValue(safePath(path) && path !== 'package.json' && /^[a-f0-9]{64}$/.test(info?.sha256)
      && Number.isSafeInteger(info.size) && info.size > 0 && info.size <= MAX_BYTES, 'invalid file inventory');
  }
}

function inventory(root, prefix = '') {
  requireValue(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'not a physical bundle directory');
  return readdirSync(root).flatMap(name => {
    const path = join(root, name);
    const relative = prefix + name;
    const stat = lstatSync(path);
    requireValue(!stat.isSymbolicLink(), 'symlink in bundle');
    if (stat.isDirectory()) return inventory(path, relative + '/');
    requireValue(stat.isFile(), 'non-regular payload');
    return [relative];
  }).sort();
}

export function validateInstalledBundle(root, platform, version, commit) {
  const meta = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  checkMetadata(meta, platform, version, commit);
  requireValue(JSON.stringify(inventory(root)) === JSON.stringify(['package.json', ...Object.keys(meta.files)].sort()), 'file inventory mismatch');
  for (const [path, info] of Object.entries(meta.files)) checkBytes(readFileSync(join(root, path)), info);
  if (process.platform !== 'win32' && platform === 'macos-universal') {
    requireValue((lstatSync(join(root, meta.entrypoint)).mode & 0o111) !== 0, 'CLI is not executable');
  }
  return meta;
}

export function extractBundle(bytes, staging, platform, version, commit) {
  const entries = new AdmZip(bytes).getEntries();
  const seen = new Set();
  let total = 0;
  requireValue(entries.length > 0 && entries.length <= 512, 'invalid ZIP entry count');
  for (const entry of entries) {
    const name = entry.entryName;
    const mode = entry.attr >>> 16;
    requireValue(name.startsWith('cuse/') && safePath(name) && !entry.isDirectory
      && (mode & 0o170000) === 0o100000, 'unsafe ZIP member');
    requireValue(!seen.has(name.toLowerCase()), 'duplicate ZIP member');
    seen.add(name.toLowerCase());
    total += entry.header.size;
    requireValue(total <= MAX_BYTES && !(entry.header.flags & 1), 'oversized or encrypted ZIP');
  }
  // Validate every name before any writes. Never delegate path handling to unzip.
  for (const entry of entries) {
    const path = join(staging, entry.entryName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.getData(), { flag: 'wx', mode: (entry.attr >>> 16) & 0o777 });
    chmodSync(path, (entry.attr >>> 16) & 0o777);
  }
  const root = join(staging, 'cuse');
  validateInstalledBundle(root, platform, version, commit);
  return root;
}

export async function prepareCuseBundle({ target, destination = join(ROOT, 'bundled-skills', 'cuse'), fetchBytes = download, log = console.log }) {
  const platform = cusePlatform(target);
  if (!platform) {
    // Shared build trees must not leak a previous Mac/Windows binary into Linux.
    rmSync(destination, { recursive: true, force: true });
    log('Cuse: unsupported on Linux; omitted from bundled skills');
    return { platform, updated: false };
  }
  const pointer = JSON.parse((await fetchBytes(`${FEED}/latest.json`, 64 * 1024)).toString('utf8'));
  requireValue(pointer?.schema_version === 1 && stableVersion(pointer.version), 'invalid latest pointer');
  const version = pointer.version;
  const prefix = `${FEED}/releases/v${version}`;
  checkDescriptor(pointer.manifest, `${prefix}/manifest.json`);
  const manifestBytes = await fetchBytes(pointer.manifest.url, pointer.manifest.size);
  checkBytes(manifestBytes, pointer.manifest);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  requireValue(manifest?.schema_version === 1 && manifest.version === version
    && /^[a-f0-9]{40}$/.test(manifest.source_commit), 'invalid version manifest');
  const artifact = manifest.packages?.skill?.[platform];
  checkDescriptor(artifact, `${prefix}/cuse-skill-v${version}-${platform}.zip`);
  const commit = manifest.source_commit;
  try {
    validateInstalledBundle(destination, platform, version, commit);
    log(`Cuse ${version} ${platform}: verified local bundle (ZIP SHA256 ${artifact.sha256})`);
    return { version, platform, updated: false };
  } catch { /* A stale/incomplete local projection must be replaced from the verified archive. */ }
  const bytes = await fetchBytes(artifact.url, artifact.size);
  checkBytes(bytes, artifact);
  mkdirSync(dirname(destination), { recursive: true });
  const staging = mkdtempSync(join(dirname(destination), '.cuse-prepare-'));
  const backup = join(staging, 'previous');
  try {
    const unpacked = extractBundle(bytes, staging, platform, version, commit);
    if (existsSync(destination)) renameSync(destination, backup);
    try { renameSync(unpacked, destination); }
    catch (error) {
      if (existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
  } finally {
    // If Windows denied both commit and rollback, keep the previous resource for
    // recovery instead of deleting the only good copy in a cleanup handler.
    if (existsSync(backup) && !existsSync(destination)) {
      log(`Cuse: previous bundle preserved at ${backup}`);
    } else { rmSync(staging, { recursive: true, force: true }); }
  }
  log(`Cuse ${version} ${platform}: staged complete Skill+CLI (ZIP SHA256 ${artifact.sha256})`);
  return { version, platform, updated: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help') {
    console.log('Usage: node scripts/prepare-cuse-bundle.mjs RUST_TARGET_TRIPLE\nFetch latest Cuse Skill+CLI into bundled-skills/cuse, verify all payloads, then replace.\nTargets: aarch64-apple-darwin, x86_64-apple-darwin, x86_64-pc-windows-msvc.\nLinux targets omit Cuse. Network failure is fatal; no version pin or stale fallback.');
    if (args[0] !== '--help') process.exitCode = 1;
  } else { await prepareCuseBundle({ target: args[0] }); }
}
