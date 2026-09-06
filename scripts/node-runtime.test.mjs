import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '..');
const versions = JSON.parse(readFileSync(join(repo, 'scripts/node-runtime.json'), 'utf8'));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const psQuote = (s) => `'${s.replaceAll("'", "''")}'`;
function put(path, content, executable = false) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (executable) chmodSync(path, 0o755);
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'myagents-node-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  for (const name of ['node-runtime.json', 'download_nodejs.sh', 'download_nodejs.ps1']) {
    copyFileSync(join(repo, 'scripts', name), join(root, 'scripts', name));
  }
  return root;
}
function unixTree(root, npmVersion = versions.npm) {
  put(join(root, 'bin/node'), `#!/bin/sh\necho v${versions.node}\n`, true);
  for (const [cmd, cli] of [['npm', 'npm-cli'], ['npx', 'npx-cli']]) {
    put(join(root, 'bin', cmd), '#!/bin/sh\nexit 0\n', true);
    put(join(root, 'lib/node_modules/npm/bin', `${cli}.js`), '');
  }
  put(join(root, 'lib/node_modules/npm/package.json'), JSON.stringify({ version: npmVersion, dependencies: { version: '4.29.0' } }, null, 2));
}

test('all resource consumers use the pinned official pair, without npm overrides', () => {
  assert.deepEqual(versions, { node: '24.20.0', npm: '11.19.0' });
  for (const name of ['scripts/download_nodejs.sh', 'scripts/download_nodejs.ps1', 'vite.config.ts']) {
    assert.match(readFileSync(join(repo, name), 'utf8'), /node-runtime\.json/);
  }
  for (const name of ['setup_windows.ps1', 'build_windows.ps1', 'build_dev_win.ps1']) {
    const text = readFileSync(join(repo, name), 'utf8');
    assert.match(text, /scripts\\download_nodejs\.ps1/);
    assert.doesNotMatch(text, /npm\/latest|npm@latest|\$NodeVersion\s*=/);
  }
  assert.doesNotMatch(readFileSync(join(repo, 'scripts/download_nodejs.sh'), 'utf8'), /upgrade_npm|npm\/latest/);
});

for (const scenario of ['empty', 'valid-cache', 'wrong-npm', 'missing-npx', 'old-node', 'wrong-arch', 'stale-staging', 'bad-download']) {
  test(`Unix resource preparation: ${scenario}`, { skip: process.platform === 'win32' }, (t) => {
    const root = fixture(t);
    const cache = join(root, `src-tauri/resources/nodejs-cache/darwin-arm64-v${versions.node}`);
    const staging = join(root, 'src-tauri/resources/nodejs');
    const artifact = join(root, `archive/node-v${versions.node}-darwin-arm64`);
    unixTree(artifact, scenario === 'bad-download' ? '12.0.2' : versions.npm);
    const archive = join(root, 'node.tar.xz');
    assert.equal(spawnSync('tar', ['-cJf', archive, '-C', dirname(artifact), artifact.split('/').at(-1)]).status, 0);
    if (!['empty', 'bad-download'].includes(scenario)) {
      const tree = scenario === 'stale-staging' ? staging : cache;
      unixTree(tree, ['wrong-npm', 'stale-staging'].includes(scenario) ? '12.0.2' : versions.npm);
      put(join(tree, '.myagents-nodejs-version'), scenario === 'old-node' ? '24.14.0' : versions.node);
      put(join(tree, '.myagents-nodejs-platform'), 'darwin');
      put(join(tree, '.myagents-nodejs-arch'), scenario === 'wrong-arch' ? 'x64' : 'arm64');
      if (scenario === 'missing-npx') rmSync(join(tree, 'lib/node_modules/npm/bin/npx-cli.js'));
    }
    // No network or real runtime required: run the whole preparation pipeline
    // against a local archive, with file(1) identifying the synthetic target.
    put(join(root, 'tools/file'), '#!/bin/sh\necho "Mach-O 64-bit executable arm64"\n', true);
    put(join(root, 'tools/curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(join(root, 'downloads'))}\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = '-o' ]; then shift; cp ${quote(archive)} "$1"; exit; fi\nshift\ndone\nexit 1\n`, true);
    const result = spawnSync('bash', [join(root, 'scripts/download_nodejs.sh'), '--target', 'arm64'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'tools')}:${process.env.PATH}` },
    });
    if (scenario === 'bad-download') {
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /does not match Node/);
      assert.equal(existsSync(staging), false);
      return;
    }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(readFileSync(join(staging, 'lib/node_modules/npm/package.json'))).version, versions.npm);
    assert.equal(existsSync(join(staging, 'lib/node_modules/npm/bin/npx-cli.js')), true);
    assert.equal(existsSync(join(root, 'downloads')), scenario !== 'valid-cache');
    if (scenario !== 'valid-cache') {
      assert.match(readFileSync(join(root, 'downloads'), 'utf8'), new RegExp(`https://nodejs.org/dist/v${versions.node}/node-v${versions.node}-darwin-arm64.tar.xz`));
    }
  });
}

// Optional local PowerShell path allows running the Windows preparation logic
// on macOS too. Network, archive extraction and robocopy are isolated fixtures;
// this does not replace Windows OS / real long-path copying acceptance.
const powershell = process.env.MYAGENTS_TEST_PWSH || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const hasPowershell = spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']).status === 0;
for (const scenario of ['valid', 'wrong-npm', 'missing-npx', 'bad-download', 'copy-failure']) {
  test(`Windows preparation with isolated IO: ${scenario}`, { skip: !hasPowershell }, (t) => {
    const root = fixture(t);
    const staging = join(root, 'src-tauri/resources/nodejs');
    const artifact = join(root, 'official');
    // Use the test runner's actual Node for fixture npm JS on Windows. These
    // fixture versions are independent from the production pin asserted above.
    put(join(root, 'scripts/node-runtime.json'), JSON.stringify({ node: process.versions.node, npm: versions.npm }));
    mkdirSync(artifact);
    if (process.platform === 'win32') {
      copyFileSync(process.execPath, join(artifact, 'node.exe'));
    } else {
      put(join(artifact, 'node.exe'), `#!/bin/sh\nif [ "$1" = '-p' ]; then\necho '["${process.versions.node}","win32","x64"]'\nelse\nexec ${quote(process.execPath)} "$@"\nfi\n`, true);
    }
    for (const file of ['npm', 'npx', 'npm.cmd', 'npx.cmd']) put(join(artifact, file), 'fixture');
    put(join(artifact, 'node_modules/npm/package.json'), JSON.stringify({ version: scenario === 'bad-download' ? '12.0.2' : versions.npm }));
    for (const cli of ['npm-cli', 'npx-cli']) put(join(artifact, `node_modules/npm/bin/${cli}.js`), `console.log('${versions.npm}')`);
    if (['valid', 'wrong-npm', 'missing-npx'].includes(scenario)) {
      cpSync(artifact, staging, { recursive: true });
      if (scenario === 'wrong-npm') put(join(staging, 'node_modules/npm/package.json'), '{"version":"12.0.2"}');
      if (scenario === 'missing-npx') rmSync(join(staging, 'node_modules/npm/bin/npx-cli.js'));
    }
    const harness = join(root, 'harness.ps1');
    put(harness, `
$ErrorActionPreference = 'Stop'
$global:TestDownloads = 0
function Invoke-WebRequest {
  param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
  if ($Uri -ne 'https://nodejs.org/dist/v${process.versions.node}/node-v${process.versions.node}-win-x64.zip') { throw "Unexpected URL: $Uri" }
  $global:TestDownloads++
  Set-Content $OutFile 'fixture'
}
function Expand-Archive {
  param($LiteralPath, $DestinationPath, [switch]$Force)
  Copy-Item -Recurse ${psQuote(artifact)} (Join-Path $DestinationPath 'node-v${process.versions.node}-win-x64')
}
function robocopy {
  param($Source, $Destination)
  Copy-Item -Recurse $Source $Destination
  $global:LASTEXITCODE = ${scenario === 'copy-failure' ? 8 : 1}
}
$Failed = $false
try { & ${psQuote(join(root, 'scripts/download_nodejs.ps1'))} } catch { $Failed = $true; Write-Host $_ }
if ($Failed -ne $${['bad-download', 'copy-failure'].includes(scenario) ? 'true' : 'false'}) { throw 'Unexpected preparation outcome' }
if ($global:TestDownloads -ne ${scenario === 'valid' ? 0 : 1}) { throw 'Unexpected download count' }
if (-not $Failed -and $global:LASTEXITCODE -ne 0) { throw 'Successful preparation left failure exit status' }
`);
    const result = spawnSync(powershell, ['-NoProfile', '-File', harness], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    if (!['bad-download', 'copy-failure'].includes(scenario)) {
      assert.equal(JSON.parse(readFileSync(join(staging, 'node_modules/npm/package.json'))).version, versions.npm);
      assert.equal(existsSync(join(staging, 'node_modules/npm/bin/npx-cli.js')), true);
    }
  });
}
