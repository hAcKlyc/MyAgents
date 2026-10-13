#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { downloadBuildResource } from '../build-resource-download.mjs';
import { dshBuildDefines } from '../integrated-runtimes/dsh-build-selection.mjs';
import { renderBootstrap, sha256File } from './bootstrap.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const profile = process.env.MYAGENTS_HOST_PROFILE ?? 'myagents-test';
const profiles = {
  'myagents-test': { root: 'myagents-host-test', archive: 'myagents-host-test', tagPrefix: 'host-test-', cli: 'myagents-host', socket: '/run/myagents-host-test/control.sock' },
  'moxbot-test': { root: 'moxbot-host-test', archive: 'moxbot-host-test', tagPrefix: 'host-test-moxbot-', cli: 'moxbot-host', socket: '/run/moxbot-host-test/control.sock' },
};
if (!Object.hasOwn(profiles, profile)) throw new Error('MYAGENTS_HOST_PROFILE must be myagents-test or moxbot-test');
const selectedProfile = profiles[profile];
const output = resolve(root, process.env.MYAGENTS_HOST_OUTPUT ?? 'output/host');
const nodeVersion = JSON.parse(readFileSync(join(root, 'scripts/node-runtime.json'), 'utf8')).node;
const sdkVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies['@anthropic-ai/claude-agent-sdk'];
const nodeArchiveSha256 = '2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2';
const nodeArchiveUrl = `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz`;
const sha256 = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');
function verifyLinuxX64Elf(path) {
  const fd = openSync(path, 'r');
  const header = Buffer.alloc(20);
  try {
    if (readSync(fd, header, 0, header.length, 0) !== header.length
      || header.subarray(0, 4).toString('hex') !== '7f454c46'
      || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62
      || !(statSync(path).mode & 0o111)) throw new Error(`Expected executable Linux x64 ELF: ${path}`);
  } finally { closeSync(fd); }
}
const lockedSdk = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages['node_modules/@anthropic-ai/claude-agent-sdk-linux-x64'];
if (lockedSdk?.version !== sdkVersion || !lockedSdk.integrity) throw new Error('Linux x64 SDK package is not integrity-pinned in package-lock.json');
const sdkPackageSha512 = Buffer.from(lockedSdk.integrity.slice('sha512-'.length), 'base64');
if (!lockedSdk.integrity.startsWith('sha512-') || sdkPackageSha512.length !== 64) throw new Error('Expected a SHA-512 integrity pin for the Linux x64 SDK package');
if (nodeVersion !== '24.20.0') throw new Error(`Expected scripts/node-runtime.json Node pin 24.20.0, got ${nodeVersion}`);

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain').length > 0;
function assertCleanBuildSnapshot(stage) {
  if (!dirty) {
    const currentCommit = git('rev-parse', 'HEAD');
    const currentDirty = git('status', '--porcelain').length > 0;
    if (currentCommit !== commit || currentDirty) throw new Error(`Clean source changed during build (${stage}); refusing to publish archive/bootstrap`);
  }
}
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const buildIdentity = { version: packageJson.version, mode: 'bundle', capturedAt: new Date().toISOString(), commit, dirty };
const esbuildBanner = 'import { createRequire as __myAgentsCreateRequire } from "module"; const require = __myAgentsCreateRequire(import.meta.url);';
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(output, '.build-'));
const releaseId = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14)}-${commit.slice(0, 12)}`;
const archive = join(output, `${selectedProfile.archive}-${releaseId}.tar.gz`);
const archiveSidecar = `${archive}.sha256`;
const bootstrapPath = join(output, `${profile === 'myagents-test' ? 'install' : 'install-moxbot'}-${releaseId}.sh`);
// A repeated build in the same timestamp second shares its releaseId; clear stale outputs first.
rmSync(archive, { force: true });
rmSync(archiveSidecar, { force: true });
rmSync(bootstrapPath, { force: true });
const releaseRoot = join(temp, selectedProfile.root, 'releases', releaseId);
const resources = join(releaseRoot, 'resources');
mkdirSync(resources, { recursive: true });
try {
  for (const [entry, target] of [
    ['src/host/main.ts', 'host-main.mjs'],
    ['src/server/host-session-worker.ts', 'host-session-worker.mjs'],
  ]) {
    const source = join(root, entry);
    if (!existsSync(source)) throw new Error(`Missing source entry: ${entry}`);
    await build({
      entryPoints: [source], outfile: join(resources, target), bundle: true, platform: 'node', format: 'esm', target: 'node24',
      banner: { js: esbuildBanner },
      external: ['playwright', 'playwright/*', 'playwright-core', 'playwright-core/*', '@playwright/mcp', '@playwright/mcp/*'],
      define: {
        ...dshBuildDefines(root),
        __MYAGENTS_VERSION__: JSON.stringify(packageJson.version),
        __MYAGENTS_BUILD_IDENTITY__: JSON.stringify(buildIdentity),
      },
    });
  }

  const nodeTar = join(temp, 'node.tar.xz');
  const cachedNode = join(output, 'cache', `node-v${nodeVersion}-linux-x64.tar.xz`);
  mkdirSync(dirname(cachedNode), { recursive: true });
  if (!existsSync(cachedNode) || await sha256(cachedNode) !== nodeArchiveSha256) {
    const bytes = await downloadBuildResource(nodeArchiveUrl, { maxBytes: 100 * 1024 * 1024 });
    if (createHash('sha256').update(bytes).digest('hex') !== nodeArchiveSha256) throw new Error('Official Node archive SHA-256 mismatch');
    const partial = `${cachedNode}.partial`;
    writeFileSync(partial, bytes, { mode: 0o600 });
    renameSync(partial, cachedNode);
  }
  if (await sha256(cachedNode) !== nodeArchiveSha256) throw new Error('Cached Node archive SHA-256 mismatch');
  copyFileSync(cachedNode, nodeTar);
  const unpack = join(temp, 'node-unpacked');
  mkdirSync(unpack);
  execFileSync('tar', ['-xJf', nodeTar, '-C', unpack, `node-v${nodeVersion}-linux-x64/bin/node`]);
  const nodeSource = join(unpack, `node-v${nodeVersion}-linux-x64/bin/node`);
  verifyLinuxX64Elf(nodeSource);
  const nodeDestination = join(resources, 'nodejs/bin/node');
  mkdirSync(dirname(nodeDestination), { recursive: true });
  copyFileSync(nodeSource, nodeDestination);
  chmodSync(nodeDestination, 0o755);

  // The native optional dependency is often absent from macOS node_modules.
  // Fetch its exact lockfile tarball, check npm's SHA-512 integrity, and extract only the ELF.
  const sdkCache = join(output, 'cache', `claude-agent-sdk-linux-x64-${sdkVersion}.tgz`);
  mkdirSync(dirname(sdkCache), { recursive: true });
  if (!existsSync(sdkCache) || !createHash('sha512').update(readFileSync(sdkCache)).digest().equals(sdkPackageSha512)) {
    const bytes = await downloadBuildResource(lockedSdk.resolved, { maxBytes: 1024 * 1024 * 1024 });
    if (!createHash('sha512').update(bytes).digest().equals(sdkPackageSha512)) throw new Error('Claude SDK npm tarball integrity mismatch');
    const partial = `${sdkCache}.partial`;
    writeFileSync(partial, bytes, { mode: 0o600 });
    renameSync(partial, sdkCache);
  }
  if (!createHash('sha512').update(readFileSync(sdkCache)).digest().equals(sdkPackageSha512)) throw new Error('Cached Claude SDK npm tarball integrity mismatch');
  const sdkExtract = join(temp, 'sdk-unpacked');
  mkdirSync(sdkExtract);
  execFileSync('tar', ['-xzf', sdkCache, '-C', sdkExtract, 'package/claude']);
  const sdkSource = join(sdkExtract, 'package/claude');
  verifyLinuxX64Elf(sdkSource);
  const sdkDestination = join(resources, 'claude-agent-sdk/claude');
  mkdirSync(dirname(sdkDestination), { recursive: true });
  copyFileSync(sdkSource, sdkDestination);
  chmodSync(sdkDestination, statSync(sdkSource).mode & 0o755);

  const cli = join(releaseRoot, `bin/${selectedProfile.cli}`);
  mkdirSync(dirname(cli), { recursive: true });
  const prefix = `/opt/${selectedProfile.root}`;
  writeFileSync(cli, `#!/bin/sh\nset -eu\nexport MYAGENTS_HOST_SOCKET=${selectedProfile.socket}\nexec ${prefix}/current/resources/nodejs/bin/node ${prefix}/current/resources/host-main.mjs "$@"\n`, { mode: 0o755 });
  const files = [];
  async function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) await walk(path);
      else {
        const rel = path.slice(releaseRoot.length + 1).split('/').join('/');
        files.push({ path: rel, size: st.size, mode: st.mode & 0o777, sha256: await sha256(path) });
      }
    }
  }
  await walk(releaseRoot);
  const manifest = {
    schemaVersion: 1, profile, releaseId, target: 'linux-x64-glibc', sourceCommit: commit, sourceDirty: dirty,
    versions: { node: nodeVersion, claudeAgentSdk: sdkVersion, app: packageJson.version },
    pinnedResources: { nodeArchiveSha256, claudeSdkPackageIntegrity: lockedSdk.integrity },
    files,
    signing: { status: 'unsigned-test-package', note: 'SHA-256 checksums provide integrity only; this package has no publisher signature.' },
  };
  writeFileSync(join(releaseRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  let bootstrap;
  try {
    assertCleanBuildSnapshot('before archive');
    execFileSync('tar', ['-czf', archive, '-C', temp, selectedProfile.root]);
    assertCleanBuildSnapshot('after archive');
  } catch (error) {
    rmSync(archive, { force: true });
    rmSync(archiveSidecar, { force: true });
    throw error;
  }
  const archiveHash = await sha256(archive);
  writeFileSync(archiveSidecar, `${archiveHash}  ${archive.split('/').at(-1)}\n`);
  const releaseTag = `${selectedProfile.tagPrefix}${releaseId}`;
  if (!dirty) {
    try {
      assertCleanBuildSnapshot('before bootstrap');
      const committedInstaller = execFileSync('git', ['show', `${commit}:scripts/host/install.sh`], { cwd: root });
      const workingInstallerHash = await sha256File(join(root, 'scripts/host/install.sh'));
      const installerHash = sha256Bytes(committedInstaller);
      if (workingInstallerHash !== installerHash) throw new Error('Working scripts/host/install.sh differs from the pinned source commit');
      assertCleanBuildSnapshot('after bootstrap inputs');
      bootstrap = bootstrapPath;
      writeFileSync(bootstrap, renderBootstrap({
        sourceCommit: commit, releaseTag, archiveName: archive.split('/').at(-1), profile,
        archiveSha256: archiveHash, installerSha256: installerHash, installerBase64: committedInstaller.toString('base64'),
      }), { mode: 0o755 });
      assertCleanBuildSnapshot('after bootstrap');
    } catch (error) {
      rmSync(archive, { force: true });
      rmSync(archiveSidecar, { force: true });
      if (bootstrap) rmSync(bootstrap, { force: true });
      throw error;
    }
  }
  console.log(JSON.stringify({ archive, sha256: archiveHash, releaseId, releaseTag, ...(bootstrap ? { bootstrap } : { bootstrap: 'omitted: source tree is dirty' }), manifest: manifest.signing.status }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
