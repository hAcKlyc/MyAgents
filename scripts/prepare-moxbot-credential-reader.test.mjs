import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  addMoxbotReaderBuildOptions,
  assertPhysicalPath,
  buildMoxbotReaderOverlay,
  inspectMacSignature,
  prepareMoxbotCredentialReader,
  resolveMacTargetArch,
  verifyPackagedCredentialReader,
} from './prepare-moxbot-credential-reader.mjs';

const lock = {
  version: 1,
  protocolVersion: 1,
  identifier: 'com.moxbot.credential-reader',
  parentIdentifier: 'com.moxbot.app',
  signingCertificateSha256: 'ef80bf8a1764d1c5e8a36cf83e0bc7ed833b2f79e297ddb634a449242aac6d71',
};
const binary = Buffer.from('test signed Mach-O payload');
const digest = createHash('sha256').update(binary).digest('hex');
const manifest = {
  version: 1,
  protocolVersion: 1,
  identifier: 'com.moxbot.credential-reader',
  parentIdentifier: 'com.moxbot.app',
  executable: 'Contents/Helpers/moxbots-credential-reader',
  sha256: digest,
  cdhash: 'ab'.repeat(20),
  signingCertificateSha256: lock.signingCertificateSha256,
};
const signature = {
  identifier: manifest.identifier,
  cdhash: manifest.cdhash,
  signingCertificateSha256: manifest.signingCertificateSha256,
};

function canonicalManifest(value = manifest) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function fixture(t, { manifestValue = manifest, binaryValue = binary, manifestBytes } = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'moxbot-reader-test-'));
  chmodSync(root, 0o700);
  const bundleDirectory = path.join(root, 'artifact');
  mkdirSync(bundleDirectory, { mode: 0o700 });
  writeFileSync(path.join(bundleDirectory, 'moxbots-credential-reader'), binaryValue, { mode: 0o700 });
  chmodSync(path.join(bundleDirectory, 'moxbots-credential-reader'), 0o555);
  writeFileSync(path.join(bundleDirectory, 'credential-reader-manifest.json'),
    manifestBytes ?? canonicalManifest(manifestValue), { mode: 0o600 });
  chmodSync(path.join(bundleDirectory, 'credential-reader-manifest.json'), 0o444);
  chmodSync(bundleDirectory, 0o555);
  t.after(() => {
    chmodSync(bundleDirectory, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, bundleDirectory };
}

function prepare(t, options = {}) {
  const { root, bundleDirectory } = fixture(t, options.fixture);
  const result = prepareMoxbotCredentialReader({
    bundleDirectory,
    targetArch: 'arm64',
    platform: 'darwin',
    stageParent: root,
    lock,
    inspectSignature: options.inspectSignature ?? (() => signature),
    inspectArchitecture: options.inspectArchitecture ?? (() => ['arm64']),
  });
  t.after(() => result.cleanup());
  return { root, bundleDirectory, result };
}

test('valid signed thin reader is copied byte-for-byte into isolated immutable staging', (t) => {
  const { result } = prepare(t);
  assert.deepEqual(readFileSync(path.join(result.stagingDirectory, 'moxbots-credential-reader')), binary);
  assert.deepEqual(readFileSync(path.join(result.stagingDirectory, 'credential-reader-manifest.json')), canonicalManifest());
  assert.equal(result.overlay.bundle.macOS.files['Helpers/moxbots-credential-reader'],
    path.join(result.stagingDirectory, 'moxbots-credential-reader'));
  assert.equal(result.overlay.bundle.macOS.files['Resources/credential-reader-manifest.json'],
    path.join(result.stagingDirectory, 'credential-reader-manifest.json'));
});

test('post-Tauri verification detects mutation of the nested reader', (t) => {
  const { root, result } = prepare(t);
  const appBundle = path.join(root, 'MoXBots.app');
  const contents = path.join(appBundle, 'Contents');
  mkdirSync(path.join(contents, 'Helpers'), { recursive: true });
  mkdirSync(path.join(contents, 'Resources'));
  copyFileSync(path.join(result.stagingDirectory, 'moxbots-credential-reader'),
    path.join(contents, 'Helpers/moxbots-credential-reader'));
  copyFileSync(path.join(result.stagingDirectory, 'credential-reader-manifest.json'),
    path.join(contents, 'Resources/credential-reader-manifest.json'));
  chmodSync(path.join(contents, 'Helpers/moxbots-credential-reader'), 0o555);
  chmodSync(path.join(contents, 'Resources/credential-reader-manifest.json'), 0o444);
  assert.equal(verifyPackagedCredentialReader({
    appBundle, expectedManifest: result.manifest, inspectSignature: () => signature,
  }), true);
  chmodSync(path.join(contents, 'Helpers/moxbots-credential-reader'), 0o755);
  writeFileSync(path.join(contents, 'Helpers/moxbots-credential-reader'), 'Tauri-mutated payload');
  chmodSync(path.join(contents, 'Helpers/moxbots-credential-reader'), 0o555);
  assert.throws(() => verifyPackagedCredentialReader({
    appBundle, expectedManifest: result.manifest, inspectSignature: () => signature,
  }), /changed the bundled credential reader bytes/);
});

test('manifest and reader digests are checked before signature approval', (t) => {
  let signatureCalls = 0;
  const { root, bundleDirectory } = fixture(t, { binaryValue: Buffer.from('tampered') });
  assert.throws(() => prepareMoxbotCredentialReader({
    bundleDirectory,
    targetArch: 'arm64',
    platform: 'darwin',
    stageParent: root,
    lock,
    inspectSignature: () => { signatureCalls += 1; return signature; },
    inspectArchitecture: () => ['arm64'],
  }), /SHA-256/);
  assert.equal(signatureCalls, 0);
});

test('unknown fields, noncanonical JSON, and a different publisher pin fail closed', (t) => {
  const extra = { ...manifest, unexpected: true };
  const { root, bundleDirectory } = fixture(t, { manifestBytes: canonicalManifest(extra) });
  assert.throws(() => prepareMoxbotCredentialReader({
    bundleDirectory, targetArch: 'arm64', platform: 'darwin', stageParent: root, lock,
    inspectSignature: () => signature, inspectArchitecture: () => ['arm64'],
  }), /unexpected or missing fields/);

  const second = fixture(t, { manifestBytes: Buffer.from(`{ "version":1 }`) });
  assert.throws(() => prepareMoxbotCredentialReader({
    bundleDirectory: second.bundleDirectory, targetArch: 'arm64', platform: 'darwin', stageParent: second.root, lock,
    inspectSignature: () => signature, inspectArchitecture: () => ['arm64'],
  }), /unexpected or missing fields/);

  const { root: thirdRoot, bundleDirectory: thirdBundle } = fixture(t);
  assert.throws(() => prepareMoxbotCredentialReader({
    bundleDirectory: thirdBundle, targetArch: 'arm64', platform: 'darwin', stageParent: thirdRoot,
    lock: { ...lock, signingCertificateSha256: 'cd'.repeat(32) },
    inspectSignature: () => signature, inspectArchitecture: () => ['arm64'],
  }), /release contract/);
});

test('signature identity and thin target architecture are both required', (t) => {
  const { root, bundleDirectory } = fixture(t);
  assert.throws(() => prepareMoxbotCredentialReader({
    bundleDirectory, targetArch: 'arm64', platform: 'darwin', stageParent: root, lock,
    inspectSignature: () => ({ ...signature, cdhash: 'cd'.repeat(20) }),
    inspectArchitecture: () => ['arm64'],
  }), /signature does not match/);
  assert.throws(() => prepareMoxbotCredentialReader({
    bundleDirectory, targetArch: 'arm64', platform: 'darwin', stageParent: root, lock,
    inspectSignature: () => signature,
    inspectArchitecture: () => ['arm64', 'x86_64'],
  }), /thin binary/);
});

test('symlink, hardlink, and group/world-writable artifact files are rejected', (t) => {
  const symlinkFixture = fixture(t);
  chmodSync(symlinkFixture.bundleDirectory, 0o755);
  const source = path.join(symlinkFixture.bundleDirectory, 'moxbots-credential-reader');
  rmSync(source);
  symlinkSync(path.join(symlinkFixture.root, 'other-binary'), source);
  writeFileSync(path.join(symlinkFixture.root, 'other-binary'), binary);
  chmodSync(path.join(symlinkFixture.root, 'other-binary'), 0o555);
  chmodSync(symlinkFixture.bundleDirectory, 0o555);
  assert.throws(() => prepareMoxbotCredentialReader({
    bundleDirectory: symlinkFixture.bundleDirectory, targetArch: 'arm64', platform: 'darwin',
    stageParent: symlinkFixture.root, lock, inspectSignature: () => signature,
    inspectArchitecture: () => ['arm64'],
  }), /symlink/);

  const hardlinkFixture = fixture(t);
  linkSync(path.join(hardlinkFixture.bundleDirectory, 'moxbots-credential-reader'),
    path.join(hardlinkFixture.root, 'extra-link'));
  assert.throws(() => prepareMoxbotCredentialReader({
    bundleDirectory: hardlinkFixture.bundleDirectory, targetArch: 'arm64', platform: 'darwin',
    stageParent: hardlinkFixture.root, lock, inspectSignature: () => signature,
    inspectArchitecture: () => ['arm64'],
  }), /single-link/);

  const writableFixture = fixture(t);
  chmodSync(path.join(writableFixture.bundleDirectory, 'moxbots-credential-reader'), 0o775);
  assert.throws(() => prepareMoxbotCredentialReader({
    bundleDirectory: writableFixture.bundleDirectory, targetArch: 'arm64', platform: 'darwin',
    stageParent: writableFixture.root, lock, inspectSignature: () => signature,
    inspectArchitecture: () => ['arm64'],
  }), /group\/world writable/);

  const ownerWritableFixture = fixture(t);
  chmodSync(path.join(ownerWritableFixture.bundleDirectory, 'moxbots-credential-reader'), 0o755);
  assert.throws(() => prepareMoxbotCredentialReader({
    bundleDirectory: ownerWritableFixture.bundleDirectory, targetArch: 'arm64', platform: 'darwin',
    stageParent: ownerWritableFixture.root, lock, inspectSignature: () => signature,
    inspectArchitecture: () => ['arm64'],
  }), /read-only/);
});

test('platform, target architecture, feature, no-sign, and file injection gates are explicit', () => {
  assert.equal(resolveMacTargetArch(['--target', 'aarch64-apple-darwin']), 'arm64');
  assert.equal(resolveMacTargetArch(['--target=x86_64-apple-darwin']), 'x86_64');
  assert.throws(() => resolveMacTargetArch(['--target', 'universal-apple-darwin']), /only thin/);
  assert.throws(() => prepareMoxbotCredentialReader({ bundleDirectory: '/missing', targetArch: 'arm64', platform: 'linux', lock }), /only supported on macOS/);
  const args = addMoxbotReaderBuildOptions(['build', '--features', 'existing-feature'], buildMoxbotReaderOverlay('/stage'));
  assert.ok(args.includes('--no-sign'));
  assert.equal(args[args.indexOf('--features') + 1], 'existing-feature,moxbot-credential-reader');
  const overlay = JSON.parse(args.at(-1));
  assert.deepEqual(overlay.bundle.macOS.files, buildMoxbotReaderOverlay('/stage').bundle.macOS.files);
  assert.throws(() => addMoxbotReaderBuildOptions(['build', '--sign'], {}), /Tauri signing is disabled/);
});

test('root build script contains the fail-closed macOS Mox feature guard', () => {
  const cargo = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
  const wrapper = readFileSync(new URL('./build-moxbot.mjs', import.meta.url), 'utf8');
  const releaseLock = JSON.parse(readFileSync(new URL('./moxbot-credential-reader-release.json', import.meta.url), 'utf8'));
  assert.deepEqual(releaseLock, lock);
  assert.match(cargo, /moxbot-credential-reader\s*=\s*\["myagents-agent-network-crypto\/fixed-macos-reader"\]/);
  assert.match(build, /target_os == "macos" && profile == "moxbot" && !reader_enabled/);
  assert.match(build, /CARGO_FEATURE_MOXBOT_CREDENTIAL_READER/);
  assert.match(wrapper, /prepareMoxbotCredentialReader/);
});

test('real local macOS signed app path and signature metadata are inspectable', (t) => {
  const appBundle = '/Applications/MoXBots.app';
  const executable = path.join(appBundle, 'Contents/MacOS/myagents');
  if (process.platform !== 'darwin' || !existsSync(executable)) {
    t.skip('requires the local signed MoXBots app');
    return;
  }
  assert.equal(assertPhysicalPath(appBundle, { leafType: 'directory', label: 'built app bundle' }).isDirectory(), true);
  const metadata = inspectMacSignature(executable);
  assert.match(metadata.identifier, /^[A-Za-z0-9.-]+$/);
  assert.match(metadata.cdhash, /^[0-9a-f]{40}$/);
  assert.match(metadata.signingCertificateSha256, /^[0-9a-f]{64}$/);
});
