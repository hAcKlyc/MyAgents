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
  computeSourceInputSha256,
  addMoxbotReaderBuildOptions,
  assertPhysicalPath,
  buildMoxbotReaderOverlay,
  inspectMacSignature,
  prepareMoxbotCredentialReader,
  resolveMacTargetArch,
  verifyPackagedCredentialReader,
} from './prepare-moxbot-credential-reader.mjs';

const releaseLock = {
  version: 1,
  protocolVersion: 1,
  identifier: 'com.moxbot.credential-reader',
  parentIdentifier: 'com.moxbot.app',
  signingCertificateSha256: 'ef80bf8a1764d1c5e8a36cf83e0bc7ed833b2f79e297ddb634a449242aac6d71',
  sourceInputSha256: 'd653fc71a62428a61803e5380cb9825525aff4527aaf4583929e9e65c5c0c6e6',
  artifacts: {
    arm64: {
      sha256: '312119423c1badba19e460ce723b7eb3711b93b2c3d0e1dac39d76b219115f2b',
      cdhash: '654da8dd4e33d7f36f3f363c5f91e149e8c452fd',
    },
  },
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
  signingCertificateSha256: releaseLock.signingCertificateSha256,
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
  const sourceRoot = path.join(root, 'source');
  for (const directory of [
    'src-tauri/agent-network-crypto',
    'src-tauri/agent-network-protocol',
    'vendor/agent-network-protocol',
  ]) mkdirSync(path.join(sourceRoot, directory), { recursive: true });
  writeFileSync(path.join(sourceRoot, 'rust-toolchain.toml'), 'channel = "1.92.0"\n');
  writeFileSync(path.join(sourceRoot, 'src-tauri/agent-network-crypto/lib.rs'), 'pub fn crypto() {}\n');
  writeFileSync(path.join(sourceRoot, 'src-tauri/agent-network-protocol/schema.json'), '{}\n');
  writeFileSync(path.join(sourceRoot, 'vendor/agent-network-protocol/schema.json'), '{"v":1}\n');
  mkdirSync(path.join(sourceRoot, 'src-tauri/agent-network-crypto/target'), { recursive: true });
  writeFileSync(path.join(sourceRoot, 'src-tauri/agent-network-crypto/target/ignored.bin'), 'ignored');
  const sourceInputSha256 = computeSourceInputSha256(sourceRoot);
  const fixtureLock = {
    ...releaseLock,
    sourceInputSha256,
    artifacts: {
      arm64: { sha256: manifestValue.sha256, cdhash: manifestValue.cdhash },
    },
  };
  mkdirSync(path.join(sourceRoot, 'scripts'), { mode: 0o755 });
  writeFileSync(path.join(sourceRoot, 'scripts/moxbot-credential-reader-release.json'),
    `${JSON.stringify(fixtureLock, null, 2)}\n`);
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
  return { root, bundleDirectory, sourceRoot, lock: fixtureLock };
}

function prepare(t, options = {}) {
  const preparedFixture = fixture(t, options.fixture);
  const { root, bundleDirectory } = preparedFixture;
  const result = prepareMoxbotCredentialReader({
    bundleDirectory,
    targetArch: 'arm64',
    platform: 'darwin',
    repositoryRoot: preparedFixture.sourceRoot,
    stageParent: root,
    lock: options.lock ?? preparedFixture.lock,
    inspectSignature: options.inspectSignature ?? (() => signature),
    inspectArchitecture: options.inspectArchitecture ?? (() => ['arm64']),
  });
  t.after(() => result.cleanup());
  return { root, bundleDirectory, result };
}

function prepareDirect(fixtureResult, overrides = {}) {
  return prepareMoxbotCredentialReader({
    bundleDirectory: fixtureResult.bundleDirectory,
    targetArch: 'arm64',
    platform: 'darwin',
    repositoryRoot: fixtureResult.sourceRoot,
    stageParent: fixtureResult.root,
    lock: fixtureResult.lock,
    inspectSignature: () => signature,
    inspectArchitecture: () => ['arm64'],
    ...overrides,
  });
}

test('source closure digest is deterministic and excludes target trees', (t) => {
  const sourceFixture = fixture(t);
  const digestBefore = computeSourceInputSha256(sourceFixture.sourceRoot);
  assert.equal(digestBefore, 'e1b4433a6b698846a01aaf3ff90ff6cf3b95f323a7e5cd548f086bc0e4fa5663');
  writeFileSync(path.join(sourceFixture.sourceRoot, 'src-tauri/agent-network-crypto/target/ignored.bin'), 'changed ignored output');
  assert.equal(computeSourceInputSha256(sourceFixture.sourceRoot), digestBefore);
  writeFileSync(path.join(sourceFixture.sourceRoot, 'src-tauri/agent-network-crypto/lib.rs'), 'changed source\n');
  assert.notEqual(computeSourceInputSha256(sourceFixture.sourceRoot), digestBefore);

  const symlinkSource = fixture(t);
  const sourceFile = path.join(symlinkSource.sourceRoot, 'src-tauri/agent-network-crypto/lib.rs');
  rmSync(sourceFile);
  symlinkSync(path.join(symlinkSource.root, 'external-source'), sourceFile);
  writeFileSync(path.join(symlinkSource.root, 'external-source'), 'source\n');
  assert.throws(() => computeSourceInputSha256(symlinkSource.sourceRoot), /contains a symlink/);
});

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
  assert.throws(() => verifyPackagedCredentialReader({
    appBundle, expectedManifest: result.manifest, repositoryRoot: path.join(root, 'source'),
    inspectSignature: () => signature, inspectArchitecture: () => ['x86_64'],
  }), /trusted architecture artifact pin/);
  assert.equal(verifyPackagedCredentialReader({
    appBundle, expectedManifest: result.manifest, repositoryRoot: path.join(root, 'source'),
    inspectSignature: () => signature, inspectArchitecture: () => ['arm64'],
  }), true);
  chmodSync(path.join(contents, 'Helpers/moxbots-credential-reader'), 0o755);
  writeFileSync(path.join(contents, 'Helpers/moxbots-credential-reader'), 'Tauri-mutated payload');
  chmodSync(path.join(contents, 'Helpers/moxbots-credential-reader'), 0o555);
  assert.throws(() => verifyPackagedCredentialReader({
    appBundle, expectedManifest: result.manifest, repositoryRoot: path.join(root, 'source'),
    inspectSignature: () => signature, inspectArchitecture: () => ['arm64'],
  }), /changed the bundled credential reader bytes/);
});

test('post-Tauri verification rejects source drift after artifact staging', (t) => {
  const { root, result } = prepare(t);
  const sourceRoot = path.join(root, 'source');
  const appBundle = path.join(root, 'MoXBots.app');
  const contents = path.join(appBundle, 'Contents');
  mkdirSync(path.join(contents, 'Helpers'), { recursive: true });
  mkdirSync(path.join(contents, 'Resources'));
  copyFileSync(path.join(result.stagingDirectory, 'moxbots-credential-reader'),
    path.join(contents, 'Helpers/moxbots-credential-reader'));
  copyFileSync(path.join(result.stagingDirectory, 'credential-reader-manifest.json'),
    path.join(contents, 'Resources/credential-reader-manifest.json'));
  writeFileSync(path.join(sourceRoot, 'src-tauri/agent-network-protocol/schema.json'), '{"changed":true}\n');
  assert.throws(() => verifyPackagedCredentialReader({
    appBundle, expectedManifest: result.manifest, repositoryRoot: sourceRoot,
    inspectSignature: () => signature, inspectArchitecture: () => ['arm64'],
  }), /source closure changed before Tauri bundle verification/);
});

test('manifest and reader digests are checked before signature approval', (t) => {
  let signatureCalls = 0;
  const badFixture = fixture(t, { binaryValue: Buffer.from('tampered') });
  assert.throws(() => prepareDirect(badFixture, {
    inspectSignature: () => { signatureCalls += 1; return signature; },
  }), /SHA-256/);
  assert.equal(signatureCalls, 0);
});

test('unknown fields, noncanonical JSON, and a different publisher pin fail closed', (t) => {
  const extra = { ...manifest, unexpected: true };
  const first = fixture(t, { manifestBytes: canonicalManifest(extra) });
  assert.throws(() => prepareDirect(first), /unexpected or missing fields/);

  const second = fixture(t, { manifestBytes: Buffer.from(`{ "version":1 }`) });
  assert.throws(() => prepareDirect(second), /unexpected or missing fields/);

  const third = fixture(t);
  assert.throws(() => prepareDirect(third, {
    lock: { ...third.lock, signingCertificateSha256: 'cd'.repeat(32) },
  }), /release contract/);
});

test('signature identity and thin target architecture are both required', (t) => {
  const preparedFixture = fixture(t);
  assert.throws(() => prepareDirect(preparedFixture, {
    inspectSignature: () => ({ ...signature, cdhash: 'cd'.repeat(20) }),
  }), /signature does not match/);
  assert.throws(() => prepareDirect(preparedFixture, {
    inspectArchitecture: () => ['arm64', 'x86_64'],
  }), /thin binary/);
});

test('trusted artifact pins and source closure must both match before staging', (t) => {
  const sourceChanged = fixture(t);
  writeFileSync(path.join(sourceChanged.sourceRoot, 'src-tauri/agent-network-crypto/lib.rs'), 'unreviewed source\n');
  assert.throws(() => prepareDirect(sourceChanged), /source closure does not match the pinned reader artifact/);

  const manifestChanged = fixture(t);
  assert.throws(() => prepareDirect(manifestChanged, {
    lock: {
      ...manifestChanged.lock,
      artifacts: { arm64: { sha256: 'cd'.repeat(32), cdhash: manifestChanged.lock.artifacts.arm64.cdhash } },
    },
  }), /manifest does not match the trusted arm64 artifact pin/);

  const unsupportedArch = fixture(t);
  assert.throws(() => prepareDirect(unsupportedArch, { targetArch: 'x86_64' }), /requires a separate release artifact/);

  const invalidLock = fixture(t);
  assert.throws(() => prepareDirect(invalidLock, {
    lock: { ...invalidLock.lock, sourceInputSha256: 'not-a-digest' },
  }), /release lock is invalid/);
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
  assert.throws(() => prepareDirect(symlinkFixture), /symlink/);

  const hardlinkFixture = fixture(t);
  linkSync(path.join(hardlinkFixture.bundleDirectory, 'moxbots-credential-reader'),
    path.join(hardlinkFixture.root, 'extra-link'));
  assert.throws(() => prepareDirect(hardlinkFixture), /single-link/);

  const writableFixture = fixture(t);
  chmodSync(path.join(writableFixture.bundleDirectory, 'moxbots-credential-reader'), 0o775);
  assert.throws(() => prepareDirect(writableFixture), /group\/world writable/);

  const ownerWritableFixture = fixture(t);
  chmodSync(path.join(ownerWritableFixture.bundleDirectory, 'moxbots-credential-reader'), 0o755);
  assert.throws(() => prepareDirect(ownerWritableFixture), /read-only/);
});

test('platform, target architecture, feature, no-sign, and file injection gates are explicit', () => {
  assert.equal(resolveMacTargetArch(['--target', 'aarch64-apple-darwin']), 'arm64');
  assert.equal(resolveMacTargetArch(['--target=x86_64-apple-darwin']), 'x86_64');
  assert.throws(() => resolveMacTargetArch(['--target', 'universal-apple-darwin']), /only thin/);
  assert.throws(() => prepareMoxbotCredentialReader({ bundleDirectory: '/missing', targetArch: 'arm64', platform: 'linux', lock: releaseLock }), /only supported on macOS/);
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
  assert.deepEqual(releaseLock, {
    version: 1,
    protocolVersion: 1,
    identifier: 'com.moxbot.credential-reader',
    parentIdentifier: 'com.moxbot.app',
    signingCertificateSha256: 'ef80bf8a1764d1c5e8a36cf83e0bc7ed833b2f79e297ddb634a449242aac6d71',
    sourceInputSha256: 'd653fc71a62428a61803e5380cb9825525aff4527aaf4583929e9e65c5c0c6e6',
    artifacts: {
      arm64: {
        sha256: '312119423c1badba19e460ce723b7eb3711b93b2c3d0e1dac39d76b219115f2b',
        cdhash: '654da8dd4e33d7f36f3f363c5f91e149e8c452fd',
      },
    },
  });
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


test('default module repository root is normalized before source verification', () => {
  assert.match(computeSourceInputSha256(), /^[0-9a-f]{64}$/);
});
