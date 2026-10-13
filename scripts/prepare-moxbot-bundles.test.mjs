import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareMoxbotBundles, transformMoxbotResource } from './prepare-moxbot-bundles.mjs';

const repo = new URL('../', import.meta.url);

test('transforms home references, command aliases and only the owned open route', () => {
  const source = Buffer.from('~/.myagents/config.json ~/.myagents/ ~/.myagents-other myagents task list myagents --help myagents <group> --help myagents://open/v1/spaces myagents://legacy/attachment');
  const output = transformMoxbotResource('bundled-agents/myagents_helper/CLAUDE.md', source).toString();
  assert.equal(output, '~/.moxbot/config.json ~/.moxbot/ ~/.myagents-other moxbot task list moxbot --help moxbot <group> --help moxbot://open/v1/spaces myagents://legacy/attachment');
});

test('preserves protocol, artifact, project marker and legal/provider names', () => {
  const source = Buffer.from('MYAGENTS_PORT X-MyAgents-Session <myagents-session> .myagents/workspace.json myagents_files/image.png myagents-task-automation MyAgents Claude Codex myagents protocol');
  assert.deepEqual(transformMoxbotResource('bundled-skills/probe/SKILL.md', source), source);
  assert.deepEqual(transformMoxbotResource('bundled-skills/probe/LICENSE', Buffer.from('myagents task ~/.myagents')), Buffer.from('myagents task ~/.myagents'));
  const vendor = Buffer.from('myagents task ~/.myagents');
  assert.deepEqual(transformMoxbotResource('bundled-skills/cuse/SKILL.md', vendor), vendor);
});

test('changes only the audited shell home fallback and refuses unknown script roots', () => {
  const source = Buffer.from('${MYAGENTS_NPM_GLOBAL_PREFIX:-$HOME/.myagents/npm-global}');
  assert.equal(transformMoxbotResource('bundled-skills/download-anything/scripts/install-toolkit.sh', source).toString(), '${MYAGENTS_NPM_GLOBAL_PREFIX:-$HOME/.moxbot/npm-global}');
  assert.throws(() => transformMoxbotResource('bundled-skills/unknown/helper.mjs', Buffer.from("join(homedir(), '.myagents')")), /Unaudited/);
});

test('copies real helper and skill source unchanged while staging isolated guides and deterministic manifest', t => {
  const root = mkdtempSync(join(tmpdir(), 'moxbot-bundles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = [
    'bundled-agents/myagents_helper/CLAUDE.md',
    'bundled-skills/myagents-task-automation/SKILL.md',
    'bundled-workspaces/mino/CLAUDE.md',
  ];
  const originals = files.map(path => readFileSync(new URL(path, repo)));
  files.forEach((path, index) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), originals[index]); });
  const result = prepareMoxbotBundles({ repositoryRoot: root });
  assert.equal(result.files, 3);
  files.forEach((path, index) => assert.deepEqual(readFileSync(join(root, path)), originals[index]));
  const helper = readFileSync(join(result.destination, files[0]), 'utf8');
  assert.match(helper, /`~\/\.moxbot\/`/);
  assert.match(helper, /moxbot:\/\/open\/v1\/spaces/);
  assert.match(readFileSync(join(result.destination, files[1]), 'utf8'), /moxbot task create-direct/);
  const first = readFileSync(join(result.destination, 'manifest.json'));
  prepareMoxbotBundles({ repositoryRoot: root });
  assert.deepEqual(readFileSync(join(result.destination, 'manifest.json')), first);
});

test('rejects source symlinks without replacing a previously generated bundle', t => {
  if (process.platform === 'win32') return t.skip('Windows symlink privilege is not required for this test');
  const root = mkdtempSync(join(tmpdir(), 'moxbot-bundles-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const group of ['bundled-skills', 'bundled-agents', 'bundled-workspaces']) mkdirSync(join(root, group));
  const initial = prepareMoxbotBundles({ repositoryRoot: root });
  const original = readFileSync(join(initial.destination, 'manifest.json'));
  symlinkSync(join(root, 'bundled-agents'), join(root, 'bundled-skills', 'link'));
  assert.throws(() => prepareMoxbotBundles({ repositoryRoot: root }), /Symlink/);
  assert.deepEqual(readFileSync(join(initial.destination, 'manifest.json')), original);
});
