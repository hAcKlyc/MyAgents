import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '..');
const build = readFileSync(join(repo, 'build_macos.sh'), 'utf8');
const unix = { skip: process.platform === 'win32' };
const version = '0.3.308';
const packageName = arch => `@anthropic-ai/claude-agent-sdk-darwin-${arch}`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'myagents sdk prepare '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ optionalDependencies: Object.fromEntries(['arm64', 'x64'].map(arch => [packageName(arch), version])) }));
  writeFileSync(join(root, 'scripts/ensure_claude_sdk_package.sh'), readFileSync(join(repo, 'scripts/ensure_claude_sdk_package.sh')));
  const tool = (name, source) => {
    const path = join(root, 'tools', name);
    writeFileSync(path, `#!${process.execPath}\n${source}\n`);
    chmodSync(path, 0o755);
  };
  // Preserve node's exit status for production package validation.
  tool('node', 'process.exit(require("node:child_process").spawnSync(process.execPath, process.argv.slice(2), {stdio:"inherit"}).status ?? 1);');
  tool('uname', 'console.log(process.argv[2] === "-s" ? "Darwin" : "arm64");');
  tool('lipo', 'console.log(require("node:fs").readFileSync(process.argv.at(-1),"utf8").split("\\n")[0]);');
  tool('otool', 'console.log("Mach-O load commands");');
  tool('codesign', 'const fs=require("node:fs"); fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({tool:"codesign",args:process.argv.slice(2)})+"\\n"); process.exit(fs.readFileSync(process.argv.at(-1),"utf8").includes("invalid-signature") ? 1 : 0);');
  tool('xattr', '');
  tool('npm', `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({tool:'npm',args})+'\\n');
if(process.env.NPM_FAIL==='1') process.exit(42);
const prefix=args[args.indexOf('--prefix')+1];
const arch=args.find(a=>a.startsWith('--cpu=')).slice(6);
const name='@anthropic-ai/claude-agent-sdk-darwin-'+arch;
const dir=path.join(prefix,'node_modules',name);
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'package.json'), JSON.stringify({name,version:'${version}'}));
fs.writeFileSync(path.join(dir,'claude'),arch==='x64'?'x86_64':'arm64');
console.error('npm http fetch GET 200 fixture-sdk.tgz');
`);
  const env = { ...process.env, PATH: `${join(root, 'tools')}:${process.env.PATH}`, CALL_LOG: join(root, 'calls.jsonl'), HOME: root };
  const calls = () => existsSync(env.CALL_LOG) ? readFileSync(env.CALL_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const install = (arch, suffix = '') => {
    const dir = join(root, 'node_modules', packageName(arch));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: packageName(arch), version }));
    writeFileSync(join(dir, 'claude'), `${arch === 'x64' ? 'x86_64' : 'arm64'}\n${suffix}`);
  };
  const run = (arches = [], extraEnv = {}) => spawnSync('bash', [join(root, 'scripts/ensure_claude_sdk_package.sh'), ...arches], { cwd: tmpdir(), env: { ...env, ...extraEnv }, encoding: 'utf8' });
  return { root, env, calls, install, run };
}

test('macOS release delegates exactly the selected architectures and stops on preparation failure', unix, t => {
  const { root, env } = fixture(t);
  const start = build.indexOf('REQUIRED_SDK_ARCHES=()');
  const call = '"${PROJECT_DIR}/scripts/ensure_claude_sdk_package.sh" "${REQUIRED_SDK_ARCHES[@]}"';
  const end = build.indexOf(call, start);
  assert.ok(start >= 0 && end > start, 'release must use the shared preparation entry');
  const block = build.slice(start, end + call.length);
  const helper = join(root, 'scripts/ensure_claude_sdk_package.sh');
  writeFileSync(helper, '#!/bin/bash\nprintf "%s\\n" "$@"\nexit "${PREPARE_EXIT:-0}"\n');
  chmodSync(helper, 0o755);
  for (const [targets, arches] of [
    [['aarch64-apple-darwin'], ['arm64']],
    [['x86_64-apple-darwin'], ['x64']],
    [['aarch64-apple-darwin', 'x86_64-apple-darwin'], ['arm64', 'x64']],
  ]) {
    for (const exit of [0, 42]) {
      const r = spawnSync('bash', ['-c', `set -e\nBUILD_TARGETS=(${targets.join(' ')})\n${block}\necho ready`], { env: { ...env, PROJECT_DIR: root, PREPARE_EXIT: String(exit) }, encoding: 'utf8' });
      assert.equal(r.status, exit, r.stderr);
      assert.deepEqual(r.stdout.trim().split('\n'), [...arches, ...(exit === 0 ? ['ready'] : [])]);
    }
  }
  assert.doesNotMatch(build, /VENDOR_DIR|签名 Vendor|validate_claude_sdk_package\(\)|ensure_claude_sdk_package\(\)/);
  assert.ok(end < build.indexOf('    CLAUDE_SRC='));
  assert.match(build, /cp "\$CLAUDE_SRC" "\$CLAUDE_DEST"/);
  assert.match(build, /validate_macho_binary "\$CLAUDE_DEST"/);
  assert.match(build, /--sign "\$APPLE_SIGNING_IDENTITY" "\$CLAUDE_DEST"/);
});

test('setup/dev host default and explicit dual-target preparation reuse valid signed packages without npm', unix, t => {
  const f = fixture(t);
  f.install('arm64');
  f.install('x64');
  for (const arches of [[], ['arm64', 'x64']]) {
    const r = f.run(arches);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  assert.equal(f.calls().filter(c => c.tool === 'npm').length, 0);
  assert.ok(f.calls().filter(c => c.tool === 'codesign').every(c => c.args.includes('--verify') && !c.args.includes('--sign')));
  for (const file of ['setup.sh', 'build_dev.sh']) assert.match(readFileSync(join(repo, file), 'utf8'), /scripts\/ensure_claude_sdk_package\.sh/);
});

test('missing Intel package is acquired with target/version context and native npm HTTP logging', unix, t => {
  const f = fixture(t);
  f.install('arm64');
  const r = f.run(['arm64', 'x64']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /darwin-x64@0\.3\.308/);
  assert.match(r.stdout, /下载.*首次.*较慢/);
  const npm = f.calls().filter(c => c.tool === 'npm');
  assert.equal(npm.length, 1);
  for (const flag of ['--loglevel=http', '--force', '--ignore-scripts', '--cpu=x64', `${packageName('x64')}@${version}`]) assert.ok(npm[0].args.includes(flag), flag);
  assert.match(r.stderr, /npm http fetch GET 200/);
  assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('.tmp-claude-sdk')), []);
});

test('invalid source signature triggers the same repair path; failed npm stops and cleans its temporary directory', unix, t => {
  const f = fixture(t);
  f.install('arm64', 'invalid-signature');
  const source = join(f.root, 'node_modules', packageName('arm64'), 'claude');
  const before = readFileSync(source, 'utf8');
  const failed = f.run(['arm64'], { NPM_FAIL: '1' });
  assert.notEqual(failed.status, 0);
  assert.equal(readFileSync(source, 'utf8'), before);
  assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('.tmp-claude-sdk')), []);
  const repaired = f.run(['arm64']);
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  assert.doesNotMatch(readFileSync(source, 'utf8'), /invalid-signature/);
});
