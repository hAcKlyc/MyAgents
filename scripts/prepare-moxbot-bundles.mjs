import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = ['bundled-skills', 'bundled-agents', 'bundled-workspaces'];
const COMMANDS = 'agent|anydoc|cc-plugin|config|cron|diagnose|goal|im|mcp|model|plugin|record|reload|runtime|session|skill|space|speech|status|task|thought|tool|version|vision|widget';
const CLI = new RegExp(`\\bmyagents(?=[ \\t]+(?:(?:${COMMANDS})\\b|--[a-z]|<[a-z]))`, 'g');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Transform only application-authored guides and the one audited HOME fallback. */
export function transformMoxbotResource(relative, bytes) {
  // Cuse is a separately signed/hashed vendor package. Preserve its inventory.
  if (relative.startsWith('bundled-skills/cuse/') || /(?:^|\/)(?:LICENSE|NOTICE|THIRD_PARTY_NOTICES)(?:\.[^/]+)?$/i.test(relative)) return bytes;
  const text = bytes.toString('utf8');
  if (relative.endsWith('.md')) {
    return Buffer.from(text
      .replace(/~\/\.myagents(?=\/|[^a-zA-Z0-9_.-]|$)/g, '~/.moxbot')
      .replace(CLI, 'moxbot')
      .replace(/\bmyagents:\/\/open(?=\/|[^a-zA-Z0-9_.-]|$)/g, 'moxbot://open'));
  }
  if (relative === 'bundled-skills/download-anything/scripts/install-toolkit.sh') {
    return Buffer.from(text.replaceAll('$HOME/.myagents/npm-global', '$HOME/.moxbot/npm-global'));
  }
  if (/\.(?:[cm]?js|ts|sh|py)$/i.test(relative) && /\.myagents/.test(text)) {
    throw new Error(`Unaudited application-home reference in resource script: ${relative}`);
  }
  return bytes;
}

function physicalDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Bundle directory must be physical');
}

/** Fixed generated destination; source trees are never modified. No network or runtime execution. */
export function prepareMoxbotBundles({ repositoryRoot = ROOT } = {}) {
  const root = resolve(repositoryRoot);
  const parent = join(root, 'src-tauri', 'resources');
  mkdirSync(parent, { recursive: true });
  physicalDirectory(parent);
  const destination = join(parent, 'moxbot-bundled');
  const staging = mkdtempSync(join(parent, '.moxbot-bundled-prepare-'));
  const inventory = [];
  let backup;
  try {
    const visit = (source, relative) => {
      physicalDirectory(source);
      mkdirSync(join(staging, relative), { recursive: true });
      for (const name of readdirSync(source).sort()) {
        const path = join(source, name), child = `${relative}/${name}`, stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed in bundled resources: ${child}`);
        if (stat.isDirectory()) { visit(path, child); continue; }
        if (!stat.isFile()) throw new Error(`Non-regular bundled resource: ${child}`);
        const original = readFileSync(path), prepared = transformMoxbotResource(child, original);
        writeFileSync(join(staging, child), prepared);
        chmodSync(join(staging, child), stat.mode & 0o777);
        inventory.push({ path: child, sourceSha256: digest(original), sha256: digest(prepared), changed: !original.equals(prepared) });
      }
    };
    for (const group of GROUPS) visit(join(root, group), group);
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, profile: 'moxbot', files: inventory }, null, 2)}\n`);
    if (existsSync(destination)) {
      physicalDirectory(destination);
      backup = `${staging}-previous`;
      renameSync(destination, backup);
    }
    try { renameSync(staging, destination); }
    catch (error) { if (backup) { renameSync(backup, destination); backup = undefined; } throw error; }
    if (backup) rmSync(backup, { recursive: true });
    return { destination, files: inventory.length, changed: inventory.filter(entry => entry.changed).length };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/prepare-moxbot-bundles.mjs');
  console.log(JSON.stringify(prepareMoxbotBundles()));
}
