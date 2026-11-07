import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { sha256File } from './document-processing-resource-cache.mjs';
import {
  REQUIRED_SPEECH_LEGAL_FILES,
  validatePreparedSpeechBundle,
  validateSpeechBuildLock,
} from './speech-inference-resource-cache.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const resourceLock = JSON.parse(
  readFileSync(
    join(repoRoot, 'src-tauri', 'document-worker', 'resource-lock.json'),
    'utf8',
  ),
);

function integrity(path, relative) {
  const bytes = readFileSync(path);
  return { path: relative, sha256: sha256File(path), size: bytes.length };
}

function nativeEntry(path, relative, license, signingKind) {
  return {
    ...integrity(path, relative),
    license,
    upstreamRevision: 'fixture-revision',
    artifactSource: 'fixture-source',
    signing: { kind: signingKind, identity: 'fixture-identity' },
  };
}

async function speechFixture() {
  const root = await mkdtemp(join(tmpdir(), 'myagents-speech-bundle-'));
  mkdirSync(join(root, 'native'), { recursive: true });
  mkdirSync(join(root, 'legal'), { recursive: true });
  const worker = join(root, 'myagents-media-worker');
  const adapter = join(root, 'native', 'myagents-speech-adapter');
  const sherpa = join(root, 'native', 'sherpa-onnx-c-api');
  writeFileSync(worker, 'worker');
  chmodSync(worker, 0o755);
  writeFileSync(adapter, 'adapter');
  writeFileSync(sherpa, 'sherpa');
  for (const filename of REQUIRED_SPEECH_LEGAL_FILES) {
    writeFileSync(join(root, 'legal', filename), `${filename}\n`);
  }
  const expected = {
    adapterAbiVersion: 2,
    platform: process.platform === 'win32' ? 'windows' : 'linux',
    architecture: 'x64',
    buildFingerprint: 'f'.repeat(64),
    sherpaOnnxVersion: '1.13.6',
    sherpaOnnxCommit: '1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911',
    onnxRuntimeVersion: '1.28.0',
    onnxRuntimeUpstreamRevision:
      'v1.28.0@da9b5e364c465de65c49d91e696cd6485270757f',
    onnxRuntimeSha256: 'a'.repeat(64),
    onnxRuntimeSize: 1024,
    nativeIncrementHardLimitBytes: 80 * 1024 * 1024,
    signingKind: 'sha256-manifest',
  };
  const files = {
    mediaWorker: nativeEntry(
      worker,
      'myagents-media-worker',
      'AGPL-3.0-only',
      expected.signingKind,
    ),
    adapter: nativeEntry(
      adapter,
      'native/myagents-speech-adapter',
      'AGPL-3.0-only',
      expected.signingKind,
    ),
    sherpaOnnx: nativeEntry(
      sherpa,
      'native/sherpa-onnx-c-api',
      'Apache-2.0',
      expected.signingKind,
    ),
  };
  const manifest = {
    schemaVersion: 1,
    capability: 'speech-inference',
    adapterAbiVersion: 2,
    platform: expected.platform,
    architecture: expected.architecture,
    buildFingerprint: expected.buildFingerprint,
    nativeIncrementBytes: Object.values(files).reduce(
      (sum, entry) => sum + entry.size,
      0,
    ),
    framework: {
      sherpaOnnxVersion: expected.sherpaOnnxVersion,
      sherpaOnnxCommit: expected.sherpaOnnxCommit,
      onnxRuntimeVersion: expected.onnxRuntimeVersion,
      onnxRuntimeUpstreamRevision: expected.onnxRuntimeUpstreamRevision,
    },
    files,
    onnxRuntime: {
      sha256: 'a'.repeat(64),
      size: 1024,
      license: 'MIT',
      upstreamRevision: expected.onnxRuntimeUpstreamRevision,
    },
    legalFiles: REQUIRED_SPEECH_LEGAL_FILES.map((filename) =>
      integrity(join(root, 'legal', filename), `legal/${filename}`),
    ),
  };
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { root, expected, manifest, manifestPath };
}

test('speech build lock pins the complete audited native source graph', () => {
  assert.equal(validateSpeechBuildLock(resourceLock), true);

  const duplicate = structuredClone(resourceLock);
  duplicate.speechInference.dependencies[0].id =
    duplicate.speechInference.dependencies[1].id;
  assert.equal(validateSpeechBuildLock(duplicate), false);

  const drifted = structuredClone(resourceLock);
  drifted.speechInference.source.sha256 = 'unlocked';
  assert.equal(validateSpeechBuildLock(drifted), false);
});

test('Eigen acquisition uses the audited mirror without changing the upstream archive identity', () => {
  // Sherpa's pinned cmake/eigen.cmake independently requires this archive/hash.
  // GitLab returned HTTP 406 on the v0.5.12 Ubuntu runner; CP2K serves identical bytes.
  assert.deepEqual(
    resourceLock.speechInference.dependencies.find((entry) => entry.id === 'eigen'),
    {
      id: 'eigen',
      url: 'https://www.cp2k.org/static/downloads/eigen-5.0.1.tar.gz',
      sha256: 'e9c326dc8c05cd1e044c71f30f1b2e34a6161a3b6ecf445d56b53ff1669e3dec',
      size: 2967272,
      archiveName: 'eigen-5.0.1.tar.gz',
      license: 'MPL-2.0',
      upstreamRevision: '5.0.1',
    },
  );
});

test('prepared speech bundle requires exact native and legal inventories', async () => {
  const fixture = await speechFixture();
  try {
    assert.equal(
      validatePreparedSpeechBundle(fixture.root, fixture.expected),
      true,
    );

    assert.equal(
      validatePreparedSpeechBundle(fixture.root, {
        ...fixture.expected,
        onnxRuntimeSha256: 'b'.repeat(64),
      }),
      false,
    );

    writeFileSync(join(fixture.root, 'native', 'undeclared'), 'drift');
    assert.equal(
      validatePreparedSpeechBundle(fixture.root, fixture.expected),
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('prepared speech cache rejects retired notices from another build', async () => {
  const fixture = await speechFixture();
  try {
    assert.equal(
      validatePreparedSpeechBundle(fixture.root, fixture.expected),
      true,
    );
    for (const filename of [
      'HDBSCAN-LICENSE-APACHE',
      'HDBSCAN-LICENSE-MIT',
      'KDTREE-LICENSE-APACHE',
      'KDTREE-LICENSE-MIT',
    ]) {
      writeFileSync(join(fixture.root, 'legal', filename), 'retired notice');
    }
    assert.equal(
      validatePreparedSpeechBundle(fixture.root, fixture.expected),
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('prepared speech bundle rejects tampering and duplicated ORT bytes', async () => {
  const fixture = await speechFixture();
  try {
    writeFileSync(
      join(fixture.root, fixture.manifest.files.adapter.path),
      'tampered',
    );
    assert.equal(
      validatePreparedSpeechBundle(fixture.root, fixture.expected),
      false,
    );

    writeFileSync(
      fixture.manifestPath,
      `${JSON.stringify(fixture.manifest)}\n`,
    );
    writeFileSync(join(fixture.root, 'native', 'onnxruntime.so'), 'duplicate');
    assert.equal(
      validatePreparedSpeechBundle(fixture.root, fixture.expected),
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
