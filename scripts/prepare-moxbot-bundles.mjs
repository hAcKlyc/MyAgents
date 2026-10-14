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
    let prose = text;
    if (relative === 'bundled-agents/myagents_helper/CLAUDE.md') {
      prose = prose
        .replace(/^\*\*MyAgents Space.*$/m, '**MoXBots 协作社区与帮助反馈属于所配置的 MoXBots 云服务**。社区用于交流话题和回复；帮助与反馈用于私有提单及管理员处理。它们复用现有云账号，不继承上游 Space 的 Issue、Goal、Skill 或 Tool API。')
        .replace(/^MyAgents 账号在.*$/m, 'MoXBots 云账号位于全局侧栏设置下方。账号入口提供登录、退出、小助理和帮助与反馈；更多菜单中的协作社区打开配置的云服务。浏览器通过同一云服务完成登录。')
        .replace(/^- 确认产品 Bug 或功能建议后，.*$/m, '- 确认产品 Bug 或功能建议后，先形成脱敏报告，引导用户通过账号菜单的「帮助与反馈」在所属 MoXBots 云服务提交。交流与分享使用「更多 → 协作社区」。未经用户明确授权，不自动发帖、回复或提交反馈；不可用时交付可复制的报告。不要向上游仓库或 Space 发送本产品反馈。');
    }
    return Buffer.from(prose
      .replace(/(?<![A-Za-z0-9_-])MyAgents(?![A-Za-z0-9_-])/g, 'MoXBots')
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
