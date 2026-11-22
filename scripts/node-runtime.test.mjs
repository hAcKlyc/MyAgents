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
  for (const name of ['node-runtime.json', 'download_nodejs.sh', 'download_nodejs.ps1', 'download-build-file.ps1']) {
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

test('development version ranges stay separate from the pinned runtime', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
  assert.deepEqual(pkg.engines, { node: '>=24.14.0', npm: '>=11.15.0' });
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
  assert.deepEqual(pkg.devEngines, {
    runtime: { name: 'node', version: pkg.engines.node, onFail: 'error' },
    packageManager: { name: 'npm', version: pkg.engines.npm, onFail: 'error' },
  });
  assert.equal(pkg.packageManager, undefined, 'do not override the npm range with an exact Corepack pin');
  assert.equal(readFileSync(join(repo, '.nvmrc'), 'utf8').trim(), versions.node);
  const setup = readFileSync(join(repo, 'setup.sh'), 'utf8');
  for (const [name, range] of Object.entries(pkg.engines)) {
    const line = setup.split('\n').find((line) => line.includes(`$(${name} --version`));
    assert.ok(line?.includes(`\\" ${range.slice(2)}"`), `${name} setup minimum must match package.json`);
  }
});

for (const [name, node, npm, accepted] of [
  ['minimum', '24.14.0', '11.15.0', true],
  ['newer patch', '24.14.1', '11.15.1', true],
  ['bundled pair', versions.node, versions.npm, true],
  ['newer major', '26.0.0', '12.0.0', true],
  ['older Node minor', '24.13.99', '11.15.0', false],
  ['older Node major', '22.99.99', '11.19.0', false],
  ['older npm minor', '24.20.0', '11.14.99', false],
  ['older npm major', '24.20.0', '9.99.99', false],
  ['prerelease Node', '26.0.0-rc.1', '11.15.0', false],
  ['missing Node', '', '11.15.0', false],
  ['missing npm', '24.14.0', '', false],
]) {
  test(`macOS setup toolchain admission: ${name}`, { skip: process.platform === 'win32' }, (t) => {
    const root = fixture(t);
    copyFileSync(join(repo, 'setup.sh'), join(root, 'setup.sh'));
    // This matrix covers the macOS version ranges, independently of the runner.
    // Linux's setup delegation is exercised by linux-package.test.mjs.
    put(join(root, 'bin/uname'), '#!/bin/sh\necho Darwin\n', true);
    for (const [tool, version] of [['node', node && `v${node}`], ['npm', npm]]) {
      put(join(root, 'bin', tool), version ? `#!/bin/sh\nprintf '%s\\n' ${quote(version)}\n` : '#!/bin/sh\nexit 127\n', true);
    }
    for (const tool of ['rustc', 'cargo', 'rustup']) put(join(root, 'bin', tool), '#!/bin/sh\nexit 0\n', true);
    // Stop immediately after dependency admission: no downloads, installs,
    // Rust builds, or access to the real user's toolchain and home directory.
    put(join(root, 'scripts/ensure_rust_toolchain.sh'), '#!/bin/sh\necho TOOLCHAIN_ACCEPTED\nexit 91\n', true);
    const result = spawnSync('/bin/bash', [join(root, 'setup.sh')], {
      encoding: 'utf8',
      env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: root },
      timeout: 10_000,
    });
    assert.equal(result.status, accepted ? 91 : 1, result.stdout + result.stderr);
    assert.equal(result.stdout.includes('TOOLCHAIN_ACCEPTED'), accepted);
  });
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

test('Windows setup and builds check prerequisites and install dependencies before preparing Node-based resources', () => {
  for (const name of ['setup_windows.ps1', 'build_windows.ps1', 'build_dev_win.ps1']) {
    const source = readFileSync(join(repo, name), 'utf8');
    const helper = source.indexOf('windows-build-environment.ps1');
    const msvc = source.indexOf('Initialize-MsvcBuildEnvironment');
    const preflight = source.indexOf('--check-prerequisites');
    const download = source.indexOf('download_nodejs.ps1');
    const activate = source.indexOf('Use-BundledNodeBuildTools');
    const install = source.indexOf('& npm install');
    const prepareResource = source.indexOf(name === 'setup_windows.ps1' ? 'prepare-cliproxy.mjs' : 'prepare-dsh-runtime.mjs');
    assert.ok(helper >= 0 && helper < msvc && msvc < preflight, `${name}: MSVC must be ready before preflight`);
    assert.ok(preflight < activate, `${name}: native prerequisites must be checked before dependency installation`);
    assert.ok(download >= 0 && download < activate && activate < install, `${name}: bundled Node must be active before npm install`);
    assert.ok(install < prepareResource, `${name}: project dependencies must be installed before resource downloads use Undici`);
  }
});

for (const scenario of ['empty', 'valid-cache', 'wrong-npm', 'missing-npx', 'old-node', 'wrong-arch', 'stale-staging', 'cross-target', 'bad-download']) {
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
    if (scenario === 'cross-target') {
      put(join(cache, 'bin/node'), `#!/bin/sh\necho TARGET_BINARY_EXECUTED >&2\nexit 126\n`, true);
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
    assert.match(result.stdout, new RegExp(`Bundled node version: v${versions.node}`));
    assert.doesNotMatch(result.stdout + result.stderr, /unknown|TARGET_BINARY_EXECUTED/);
    assert.equal(JSON.parse(readFileSync(join(staging, 'lib/node_modules/npm/package.json'))).version, versions.npm);
    assert.equal(existsSync(join(staging, 'lib/node_modules/npm/bin/npx-cli.js')), true);
    assert.equal(existsSync(join(root, 'downloads')), !['valid-cache', 'cross-target'].includes(scenario));
    if (!['valid-cache', 'cross-target'].includes(scenario)) {
      assert.match(readFileSync(join(root, 'downloads'), 'utf8'), /--connect-timeout 1800 --max-time 1800 --retry 4 --retry-delay 1 --retry-connrefused/);
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

for (const scenario of ['transient', 'timeout', 'permanent', 'invalid-payload', 'exhausted']) {
  test(`Windows bootstrap download keeps final files intact: ${scenario}`, { skip: !hasPowershell }, t => {
    const root = fixture(t); const output = join(root, 'installer.exe');
    put(output, 'previous');
    const harness = join(root, 'download-test.ps1');
    put(harness, `
$ErrorActionPreference = 'Stop'
. ${psQuote(join(root, 'scripts/download-build-file.ps1'))}
$global:Calls = 0
function Start-Sleep { param($Seconds) }
function Invoke-WebRequest {
  param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
  if ($TimeoutSec -ne 1800) { throw 'short timeout' }
  if (-not $OutFile.EndsWith('.partial')) { throw 'must isolate partial files' }
  $global:Calls++
  Set-Content -LiteralPath $OutFile 'partial'
  if ('${scenario}' -eq 'permanent') { throw 'permanent failure' }
  if ('${scenario}' -eq 'exhausted' -or ($global:Calls -eq 1 -and '${scenario}' -in @('transient', 'timeout'))) {
    throw [System.Net.WebException]::new('connection timed out', [System.Net.WebExceptionStatus]::Timeout)
  }
  Set-Content -LiteralPath $OutFile 'complete'
}
$Failed = $false
try {
  Get-BuildDownload -Uri 'https://example.invalid/installer' -OutFile ${psQuote(output)} -Validate { param($Path) '${scenario}' -ne 'invalid-payload' }
} catch { $Failed = $true }
if ($Failed -ne $${['permanent', 'invalid-payload', 'exhausted'].includes(scenario)}) { throw 'unexpected result' }
if ($global:Calls -ne ${scenario === 'exhausted' ? 5 : ['transient', 'timeout'].includes(scenario) ? 2 : 1}) { throw 'unexpected attempt count' }
$Expected = '${['permanent', 'invalid-payload', 'exhausted'].includes(scenario) ? 'previous' : 'complete'}'
if ((Get-Content -Raw ${psQuote(output)}).Trim() -ne $Expected) { throw 'wrong published bytes' }
if (Get-ChildItem ${psQuote(root)} -Filter '*.partial') { throw 'partial file leaked' }
`);
    const result = spawnSync(powershell, ['-NoProfile', '-File', harness], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
