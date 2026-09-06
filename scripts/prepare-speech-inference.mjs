import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLockedResource,
  computeBuildFingerprint,
  sha256File,
} from './document-processing-resource-cache.mjs';
import {
  validateDocumentRuntimeDescriptor,
  validatePreparedSpeechBundle,
  validateSpeechBuildLock,
} from './speech-inference-resource-cache.mjs';
import {
  extractSherpaBuildSource,
  patchHclustWindowsFenvPragma,
  patchSherpaWindowsOnnxRuntimeImport,
} from './sherpa-source-extraction.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appVersion = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
).version;
const mediaWorkerRoot = join(projectRoot, 'src-tauri', 'media-worker');
const documentWorkerRoot = join(projectRoot, 'src-tauri', 'document-worker');
const lockPath = join(documentWorkerRoot, 'resource-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (!validateSpeechBuildLock(lock)) {
  throw new Error('Speech inference source lock is invalid or incomplete');
}

let target;
let force;
let checkPrerequisites;
let offline;
let targetLock;
const speechLock = lock.speechInference;
const cacheRoot = join(
  projectRoot,
  'src-tauri',
  'resources',
  'document-processing-cache',
);
const legacyCacheRoot = join(
  projectRoot,
  'src-tauri',
  'target',
  'document-processing-cache',
);
const resourceRoot = join(
  projectRoot,
  'src-tauri',
  'resources',
  'speech-inference',
);
const publishRoot = join(resourceRoot, 'v1');
const cacheStats = { hits: 0, migrated: 0, downloaded: 0 };
const preparePath = fileURLToPath(import.meta.url);
const helperPath = join(
  projectRoot,
  'scripts',
  'speech-inference-resource-cache.mjs',
);
const sharedHelperPath = join(
  projectRoot,
  'scripts',
  'document-processing-resource-cache.mjs',
);
const extractionHelperPath = join(
  projectRoot,
  'scripts',
  'sherpa-source-extraction.mjs',
);
const buildJobs = String(
  Math.max(
    1,
    Math.min(
      4,
      Number.parseInt(process.env.MYAGENTS_NATIVE_BUILD_JOBS ?? '', 10) ||
        availableParallelism(),
    ),
  ),
);
const speechAdapterCmake = readFileSync(
  join(mediaWorkerRoot, 'native', 'CMakeLists.txt'),
  'utf8',
);
const speechAdapterCmakeMinimum =
  /^cmake_minimum_required\(VERSION\s+(\d+)\.(\d+)(?:\.(\d+))?\)/m.exec(
    speechAdapterCmake,
  );
if (!speechAdapterCmakeMinimum) {
  throw new Error('Speech native adapter CMake minimum version is missing');
}
const MINIMUM_SPEECH_CMAKE_VERSION_PARTS = [
  Number(speechAdapterCmakeMinimum[1]),
  Number(speechAdapterCmakeMinimum[2]),
  Number(speechAdapterCmakeMinimum[3] ?? 0),
];
export const MINIMUM_SPEECH_CMAKE_VERSION =
  MINIMUM_SPEECH_CMAKE_VERSION_PARTS.join('.');

function probeCommand(command, commandArgs) {
  try {
    return execFileSync(command, commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function parseCmakeVersion(output) {
  const match = /\bcmake version\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(
    output ?? '',
  );
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

export function speechBuildPrerequisiteFailures(tools, platform) {
  const failures = [];
  const cmakeVersion = parseCmakeVersion(tools.cmakeVersion);
  if (!tools.cmakeVersion) {
    failures.push(
      `CMake >= ${MINIMUM_SPEECH_CMAKE_VERSION} (install from https://cmake.org/download/)`,
    );
  } else if (!cmakeVersion) {
    failures.push(
      `CMake >= ${MINIMUM_SPEECH_CMAKE_VERSION} (could not parse: ${tools.cmakeVersion.split('\n')[0]}; upgrade from https://cmake.org/download/)`,
    );
  } else if (
    !versionAtLeast(cmakeVersion, MINIMUM_SPEECH_CMAKE_VERSION_PARTS)
  ) {
    failures.push(
      `CMake >= ${MINIMUM_SPEECH_CMAKE_VERSION} (found ${cmakeVersion.join('.')}; upgrade from https://cmake.org/download/)`,
    );
  }
  if (!tools.cargoVersion) {
    failures.push('Cargo (install with the repository Rust toolchain)');
  }
  if (!tools.compiler) {
    failures.push(
      platform === 'macos'
        ? 'Apple Clang (install Xcode Command Line Tools)'
        : platform === 'windows'
          ? 'MSVC C++ Build Tools (run from a Developer PowerShell)'
          : 'a C++20 compiler (install the platform build-essential package)',
    );
  }
  return failures;
}

function prerequisiteFailures() {
  const compiler =
    targetLock.platform === 'macos'
      ? probeCommand('xcrun', ['--find', 'clang++'])
      : targetLock.platform === 'windows'
        ? probeCommand('where.exe', ['cl.exe'])
        : probeCommand('sh', ['-c', 'command -v c++ || command -v g++']);
  return speechBuildPrerequisiteFailures(
    {
      cmakeVersion: probeCommand('cmake', ['--version']),
      cargoVersion: probeCommand('cargo', ['--version']),
      compiler,
    },
    targetLock.platform,
  );
}

function assertPrerequisites() {
  const failures = prerequisiteFailures();
  if (failures.length === 0) {
    console.log(`Speech-inference build prerequisites ready for ${target}`);
    return;
  }
  throw new Error(
    [
      `Speech-inference build prerequisites are missing for ${target}:`,
      ...failures.map((failure) => `- ${failure}`),
      'Install the missing tools and rerun the same command.',
    ].join('\n'),
  );
}

function filesUnder(root, result = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) continue;
    if (metadata.isDirectory()) filesUnder(path, result);
    else if (metadata.isFile()) result.push(path);
  }
  return result;
}

function findOne(root, predicate, description) {
  const matches = filesUnder(root).filter(predicate);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${description} under ${root}, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  return matches[0];
}

async function acquire(entry, cacheName) {
  return acquireLockedResource({
    cacheRoot,
    legacyCacheRoot,
    entry,
    cacheName,
    offline,
    stats: cacheStats,
  });
}

const appleSigningIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim();
const windowsSignTool = process.env.WINDOWS_SIGNTOOL_PATH?.trim();
const windowsCertificateSha1 = process.env.WINDOWS_CERTIFICATE_SHA1?.trim();
const rustcIdentity = execFileSync('rustc', ['-Vv'], {
  encoding: 'utf8',
}).trim();
let signingKind;
let signingIdentity;
let buildFingerprint;
let preparedRoot;

function configurePreparation(options) {
  target = options.target;
  force = options.force;
  checkPrerequisites = options.checkPrerequisites;
  offline = options.speechOffline;
  targetLock = lock.targets[target];
  if (!targetLock) {
    throw new Error(`Unsupported speech-inference target: ${target}`);
  }
  if (
    targetLock.platform === 'windows' &&
    Boolean(windowsSignTool) !== Boolean(windowsCertificateSha1)
  ) {
    throw new Error(
      'WINDOWS_SIGNTOOL_PATH and WINDOWS_CERTIFICATE_SHA1 must be set together',
    );
  }
  signingKind =
    targetLock.platform === 'macos'
      ? 'codesign'
      : targetLock.platform === 'windows'
        ? 'authenticode'
        : 'sha256-manifest';
  signingIdentity =
    targetLock.platform === 'macos'
      ? appleSigningIdentity || 'adhoc-development-build'
      : targetLock.platform === 'windows'
        ? windowsCertificateSha1?.toLowerCase() || 'development-build'
        : 'MyAgents-resource-manifest-v1';
  buildFingerprint = computeBuildFingerprint({
    projectRoot,
    metadata: {
      prepareSchemaVersion: 2,
      appVersion,
      target,
      targetLock,
      speechLock,
      rustcIdentity,
      signingIdentity,
      windowsSignTool: windowsSignTool || '',
      windowsTimestampUrl: process.env.WINDOWS_TIMESTAMP_URL?.trim() || '',
    },
    inputs: [
      preparePath,
      helperPath,
      sharedHelperPath,
      extractionHelperPath,
      lockPath,
      join(projectRoot, 'rust-toolchain.toml'),
      join(mediaWorkerRoot, 'Cargo.toml'),
      join(mediaWorkerRoot, 'Cargo.lock'),
      join(mediaWorkerRoot, 'SPEECH_INFERENCE_NOTICES.md'),
      join(mediaWorkerRoot, 'native'),
      join(mediaWorkerRoot, 'src'),
      join(projectRoot, 'src-tauri', 'media-worker-protocol'),
    ],
  });
  preparedRoot = join(cacheRoot, 'prepared-speech', target, buildFingerprint);
}

function expectedSpeechBundle(runtime) {
  return {
    adapterAbiVersion: speechLock.adapterAbiVersion,
    platform: targetLock.platform,
    architecture: targetLock.architecture,
    buildFingerprint,
    sherpaOnnxVersion: speechLock.sherpaOnnxVersion,
    sherpaOnnxCommit: speechLock.sherpaOnnxCommit,
    onnxRuntimeVersion: speechLock.onnxRuntimeVersion,
    onnxRuntimeUpstreamRevision: speechLock.onnxRuntimeUpstreamRevision,
    onnxRuntimeSha256: runtime.sha256,
    onnxRuntimeSize: runtime.size,
    nativeIncrementHardLimitBytes: speechLock.nativeIncrementHardLimitBytes,
    signingKind,
  };
}

function recoverProjection() {
  mkdirSync(resourceRoot, { recursive: true });
  const entries = readdirSync(resourceRoot, { withFileTypes: true });
  const backups = entries
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith('.v1-backup-'),
    )
    .map((entry) => join(resourceRoot, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!existsSync(publishRoot) && backups.length > 0) {
    renameSync(backups.shift(), publishRoot);
  }
  for (const backup of backups) {
    rmSync(backup, { recursive: true, force: true });
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.v1-staging-')) {
      rmSync(join(resourceRoot, entry.name), { recursive: true, force: true });
    }
  }
}

function publishPreparedBundle(source, expectedBundle) {
  if (validatePreparedSpeechBundle(publishRoot, expectedBundle)) return false;
  const token = `${process.pid}-${randomUUID()}`;
  const projectionStage = join(resourceRoot, `.v1-staging-${token}`);
  const projectionBackup = join(resourceRoot, `.v1-backup-${token}`);
  cpSync(source, projectionStage, {
    recursive: true,
    errorOnExist: true,
    preserveTimestamps: true,
  });
  if (!validatePreparedSpeechBundle(projectionStage, expectedBundle)) {
    rmSync(projectionStage, { recursive: true, force: true });
    throw new Error(
      `Prepared speech resource projection is invalid: ${source}`,
    );
  }
  let movedPrevious = false;
  try {
    if (existsSync(publishRoot)) {
      renameSync(publishRoot, projectionBackup);
      movedPrevious = true;
    }
    renameSync(projectionStage, publishRoot);
  } catch (error) {
    rmSync(projectionStage, { recursive: true, force: true });
    if (
      movedPrevious &&
      !existsSync(publishRoot) &&
      existsSync(projectionBackup)
    ) {
      renameSync(projectionBackup, publishRoot);
    }
    throw error;
  }
  if (movedPrevious) {
    rmSync(projectionBackup, { recursive: true, force: true });
  }
  return true;
}

function configurePlatformArgs() {
  if (targetLock.platform === 'macos') {
    return [
      `-DCMAKE_OSX_ARCHITECTURES=${targetLock.architecture === 'arm64' ? 'arm64' : 'x86_64'}`,
      `-DCMAKE_OSX_DEPLOYMENT_TARGET=${targetLock.onnxRuntime.sourceBuild.deploymentTarget}`,
    ];
  }
  return [];
}

function copyLegalTree(sourceRoot, destinationRoot, prefix) {
  const legalFiles = filesUnder(sourceRoot).filter((path) =>
    /^(license|copying)([._-].*)?$/i.test(basename(path)),
  );
  if (legalFiles.length === 0) {
    throw new Error(`${prefix} source omitted its license files`);
  }
  for (const source of legalFiles) {
    const suffix = relative(sourceRoot, source)
      .replaceAll(/[\\/]/g, '-')
      .toUpperCase();
    copyFileSync(source, join(destinationRoot, `${prefix}-${suffix}`));
  }
}

function cargoPackageRoot(packageName, expectedVersion) {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--format-version',
        '1',
        '--locked',
        '--manifest-path',
        join(mediaWorkerRoot, 'Cargo.toml'),
      ],
      { cwd: projectRoot, encoding: 'utf8' },
    ),
  );
  const packages = metadata.packages.filter(
    (entry) => entry.name === packageName && entry.version === expectedVersion,
  );
  if (packages.length !== 1) {
    throw new Error(
      `Expected one ${packageName} ${expectedVersion} package source`,
    );
  }
  return dirname(packages[0].manifest_path);
}

function signNativeFiles(paths) {
  if (targetLock.platform === 'macos') {
    for (const path of paths) {
      const signingArgs = appleSigningIdentity
        ? [
            '--force',
            '--options',
            'runtime',
            '--timestamp',
            '--sign',
            appleSigningIdentity,
            path,
          ]
        : ['--force', '--sign', '-', path];
      execFileSync('codesign', signingArgs, { stdio: 'inherit' });
      execFileSync('codesign', ['--verify', '--strict', path], {
        stdio: 'inherit',
      });
    }
  }
  if (
    targetLock.platform === 'windows' &&
    windowsSignTool &&
    windowsCertificateSha1
  ) {
    const timestampUrl =
      process.env.WINDOWS_TIMESTAMP_URL?.trim() ||
      'http://timestamp.digicert.com';
    for (const path of paths) {
      execFileSync(
        windowsSignTool,
        [
          'sign',
          '/fd',
          'SHA256',
          '/sha1',
          windowsCertificateSha1,
          '/tr',
          timestampUrl,
          '/td',
          'SHA256',
          path,
        ],
        { stdio: 'inherit' },
      );
      execFileSync(windowsSignTool, ['verify', '/pa', '/all', path], {
        stdio: 'inherit',
      });
    }
  }
}

export async function prepareSpeechInference(options, documentResult) {
  configurePreparation(options);
  if (checkPrerequisites && !documentResult?.runtime) {
    assertPrerequisites();
    return Object.freeze({ target, needsBuild: true });
  }
  const sharedRuntime = validateDocumentRuntimeDescriptor(
    documentResult?.runtime,
    {
      target,
      platform: targetLock.platform,
      architecture: targetLock.architecture,
      upstreamRevision: speechLock.onnxRuntimeUpstreamRevision,
    },
  );
  const expectedBundle = expectedSpeechBundle(sharedRuntime);
  if (checkPrerequisites) {
    if (validatePreparedSpeechBundle(preparedRoot, expectedBundle)) {
      console.log(
        `Speech-inference build prerequisites not needed for ${target} (prepared cache hit)`,
      );
      return Object.freeze({ target, needsBuild: false });
    }
    assertPrerequisites();
    return Object.freeze({ target, needsBuild: true });
  }
  recoverProjection();
  if (!force && validatePreparedSpeechBundle(preparedRoot, expectedBundle)) {
    publishPreparedBundle(preparedRoot, expectedBundle);
    console.log(
      `Restored cached speech-inference resources for ${target} (fingerprint ${buildFingerprint.slice(0, 12)})`,
    );
    return Object.freeze({ target, needsBuild: false });
  }
  if (offline) {
    throw new Error(
      `Offline prepared speech bundle cache miss for ${target} (${preparedRoot}); run the prepare command online once`,
    );
  }
  assertPrerequisites();
  const runtime = sharedRuntime;
  if (existsSync(preparedRoot)) {
    rmSync(preparedRoot, { recursive: true, force: true });
  }
  // MSBuild FileTracker still creates MAX_PATH-sensitive nested tlog paths.
  // Keep transient build segments short while the final cache and projection
  // retain their descriptive, target-scoped names.
  const workParent = join(cacheRoot, 'w');
  mkdirSync(workParent, { recursive: true });
  const workRoot = mkdtempSync(join(workParent, 's-'));
  const stageRoot = join(workRoot, 'v');
  const extractRoot = join(workRoot, 'x');
  const buildRoot = join(workRoot, 'b');
  mkdirSync(join(stageRoot, 'native'), { recursive: true });
  mkdirSync(join(stageRoot, 'legal'), { recursive: true });
  mkdirSync(extractRoot, { recursive: true });
  mkdirSync(buildRoot, { recursive: true });

  try {
    const sourceArchive = await acquire(
      speechLock.source,
      speechLock.source.archiveName,
    );
    const sourceExtract = join(extractRoot, 's');
    mkdirSync(sourceExtract, { recursive: true });
    const sherpaSource = extractSherpaBuildSource({
      archive: sourceArchive,
      destination: sourceExtract,
      archiveRoot: speechLock.source.archiveRoot,
    });
    if (targetLock.platform === 'windows') {
      patchSherpaWindowsOnnxRuntimeImport(sherpaSource);
    }
    for (const dependency of speechLock.dependencies) {
      const archive = await acquire(dependency, dependency.archiveName);
      copyFileSync(archive, join(sherpaSource, dependency.archiveName));
    }

    const ortBuildRoot = join(workRoot, 'o');
    const ortLibraryRoot = join(ortBuildRoot, 'lib');
    mkdirSync(ortLibraryRoot, { recursive: true });
    const runtimeBuildName =
      targetLock.platform === 'windows'
        ? 'onnxruntime.dll'
        : targetLock.platform === 'macos'
          ? 'libonnxruntime.dylib'
          : 'libonnxruntime.so';
    copyFileSync(runtime.path, join(ortLibraryRoot, runtimeBuildName));

    let ortIncludeRoot;
    if (targetLock.onnxRuntime.sourceBuild) {
      ortIncludeRoot = join(
        cacheRoot,
        'source',
        `onnxruntime-${targetLock.onnxRuntime.sourceBuild.commit}`,
        'include',
        'onnxruntime',
        'core',
        'session',
      );
    } else {
      const ortArchive = await acquire(
        targetLock.onnxRuntime,
        `${target}-onnxruntime-${basename(new URL(targetLock.onnxRuntime.url).pathname)}`,
      );
      const ortExtract = join(extractRoot, 'onnxruntime');
      mkdirSync(ortExtract, { recursive: true });
      execFileSync('tar', ['-xf', ortArchive, '-C', ortExtract], {
        stdio: 'inherit',
      });
      ortIncludeRoot = dirname(
        findOne(
          ortExtract,
          (path) => basename(path) === 'onnxruntime_c_api.h',
          'ONNX Runtime C API header',
        ),
      );
      if (targetLock.platform === 'windows') {
        copyFileSync(
          findOne(
            ortExtract,
            (path) => basename(path).toLowerCase() === 'onnxruntime.lib',
            'ONNX Runtime import library',
          ),
          join(ortLibraryRoot, 'onnxruntime.lib'),
        );
      }
    }
    if (!existsSync(join(ortIncludeRoot, 'onnxruntime_c_api.h'))) {
      throw new Error(
        `ONNX Runtime headers are unavailable: ${ortIncludeRoot}`,
      );
    }

    const sherpaBuild = join(buildRoot, 's');
    execFileSync(
      'cmake',
      [
        '-S',
        sherpaSource,
        '-B',
        sherpaBuild,
        '-DCMAKE_BUILD_TYPE=Release',
        // Initialize extra flags without replacing CMake's platform defaults
        // (notably MSVC /EHsc, required by Sherpa and its C++ dependencies).
        '-DCMAKE_CXX_FLAGS_INIT=-DSHERPA_ONNX_DISABLE_COREML=1',
        '-DBUILD_SHARED_LIBS=ON',
        '-DSHERPA_ONNX_BUILD_C_API_EXAMPLES=OFF',
        '-DSHERPA_ONNX_ENABLE_C_API=ON',
        '-DSHERPA_ONNX_ENABLE_BINARY=OFF',
        '-DSHERPA_ONNX_ENABLE_CHECK=OFF',
        '-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF',
        '-DSHERPA_ONNX_ENABLE_PYTHON=OFF',
        '-DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=ON',
        '-DSHERPA_ONNX_ENABLE_TESTS=OFF',
        '-DSHERPA_ONNX_ENABLE_TTS=OFF',
        '-DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF',
        '-DSHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=ON',
        ...configurePlatformArgs(),
      ],
      {
        env: {
          ...process.env,
          SHERPA_ONNXRUNTIME_INCLUDE_DIR: ortIncludeRoot,
          SHERPA_ONNXRUNTIME_LIB_DIR: ortLibraryRoot,
        },
        stdio: 'inherit',
      },
    );
    // FetchContent has materialized hclust during configuration. Patch before
    // compiling Sherpa; the adapter later consumes this same dependency tree.
    const hclustIncludeRoot = join(sherpaBuild, '_deps', 'hclust_cpp-src');
    if (targetLock.platform === 'windows') {
      patchHclustWindowsFenvPragma(hclustIncludeRoot);
    }
    execFileSync(
      'cmake',
      [
        '--build',
        sherpaBuild,
        '--config',
        'Release',
        '--target',
        'sherpa-onnx-c-api',
        '--parallel',
        buildJobs,
      ],
      { stdio: 'inherit' },
    );
    const sharedLibraryExtension =
      targetLock.platform === 'windows'
        ? '.dll'
        : targetLock.platform === 'macos'
          ? '.dylib'
          : '.so';
    const sherpaLibrary = findOne(
      sherpaBuild,
      (path) =>
        basename(path) ===
        `${targetLock.platform === 'windows' ? '' : 'lib'}sherpa-onnx-c-api${sharedLibraryExtension}`,
      'sherpa-onnx C API shared library',
    );
    const sherpaLinkLibrary =
      targetLock.platform === 'windows'
        ? findOne(
            sherpaBuild,
            (path) => basename(path) === 'sherpa-onnx-c-api.lib',
            'sherpa-onnx C API import library',
          )
        : sherpaLibrary;

    const adapterBuild = join(buildRoot, 'a');
    if (!existsSync(join(hclustIncludeRoot, 'fastcluster-all-in-one.h'))) {
      throw new Error(
        `Locked hclust-cpp headers are unavailable: ${hclustIncludeRoot}`,
      );
    }
    execFileSync(
      'cmake',
      [
        '-S',
        join(mediaWorkerRoot, 'native'),
        '-B',
        adapterBuild,
        '-DCMAKE_BUILD_TYPE=Release',
        `-DMYAGENTS_SHERPA_INCLUDE_DIR=${sherpaSource}`,
        `-DMYAGENTS_SHERPA_LIBRARY=${sherpaLinkLibrary}`,
        `-DMYAGENTS_HCLUST_INCLUDE_DIR=${hclustIncludeRoot}`,
        ...configurePlatformArgs(),
      ],
      { stdio: 'inherit' },
    );
    execFileSync(
      'cmake',
      ['--build', adapterBuild, '--config', 'Release', '--parallel', buildJobs],
      { stdio: 'inherit' },
    );
    const adapterLibrary = findOne(
      adapterBuild,
      (path) =>
        basename(path) ===
        `${targetLock.platform === 'windows' ? '' : 'lib'}myagents-speech-adapter${sharedLibraryExtension}`,
      'MyAgents speech adapter shared library',
    );

    execFileSync(
      'cargo',
      [
        'build',
        '--locked',
        '--release',
        '--target',
        target,
        '--manifest-path',
        join(mediaWorkerRoot, 'Cargo.toml'),
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, CARGO_INCREMENTAL: '0' },
        stdio: 'inherit',
      },
    );
    const workerName =
      targetLock.platform === 'windows'
        ? 'myagents-media-worker.exe'
        : 'myagents-media-worker';
    const workerSource = join(
      mediaWorkerRoot,
      'target',
      target,
      'release',
      workerName,
    );
    if (!existsSync(workerSource)) {
      throw new Error(`Media Worker build did not produce ${workerSource}`);
    }

    const workerDestination = join(stageRoot, workerName);
    const adapterDestination = join(
      stageRoot,
      'native',
      `myagents-speech-adapter${sharedLibraryExtension}`,
    );
    const sherpaDestination = join(
      stageRoot,
      'native',
      `sherpa-onnx-c-api${sharedLibraryExtension}`,
    );
    copyFileSync(workerSource, workerDestination);
    copyFileSync(adapterLibrary, adapterDestination);
    copyFileSync(sherpaLibrary, sherpaDestination);
    if (targetLock.platform !== 'windows') {
      chmodSync(workerDestination, statSync(workerDestination).mode | 0o111);
    }
    signNativeFiles([sherpaDestination, adapterDestination, workerDestination]);

    const legalRoot = join(stageRoot, 'legal');
    copyFileSync(
      join(mediaWorkerRoot, 'SPEECH_INFERENCE_NOTICES.md'),
      join(legalRoot, 'SPEECH_INFERENCE_NOTICES.md'),
    );
    copyFileSync(
      join(sherpaSource, 'LICENSE'),
      join(legalRoot, 'SHERPA-ONNX-LICENSE'),
    );
    const dependencySourceRoot = join(sherpaBuild, '_deps');
    const dependencyBuildNames = {
      eigen: 'eigen',
      'hclust-cpp': 'hclust_cpp',
      'kaldi-decoder': 'kaldi_decoder',
      'kaldi-native-fbank': 'kaldi_native_fbank',
      kaldifst: 'kaldifst',
      kissfft: 'kissfft',
      'nlohmann-json': 'json',
      openfst: 'openfst',
      'simple-sentencepiece': 'simple-sentencepiece',
    };
    for (const dependency of speechLock.dependencies) {
      const buildName = dependencyBuildNames[dependency.id];
      copyLegalTree(
        join(dependencySourceRoot, `${buildName}-src`),
        legalRoot,
        dependency.id.toUpperCase(),
      );
    }
    const opus2Root = cargoPackageRoot('opus2', speechLock.opus2Version);
    copyFileSync(
      join(opus2Root, 'LICENSE-APACHE'),
      join(legalRoot, 'OPUS2-LICENSE-APACHE'),
    );
    copyFileSync(
      join(opus2Root, 'LICENSE-MIT'),
      join(legalRoot, 'OPUS2-LICENSE-MIT'),
    );
    const libopusRoot = cargoPackageRoot(
      'libopus_sys',
      speechLock.libopusSysVersion,
    );
    copyFileSync(
      join(libopusRoot, 'opus', 'COPYING'),
      join(legalRoot, 'LIBOPUS-LICENSE'),
    );
    copyFileSync(
      join(libopusRoot, 'LICENSE'),
      join(legalRoot, 'LIBOPUS-SYS-LICENSE'),
    );
    for (const [packageName, version, prefix] of [
      ['hdbscan', speechLock.hdbscanVersion, 'HDBSCAN'],
      ['kdtree', speechLock.kdtreeVersion, 'KDTREE'],
      ['num-traits', speechLock.numTraitsVersion, 'NUM-TRAITS'],
    ]) {
      const packageRoot = cargoPackageRoot(packageName, version);
      copyFileSync(
        join(packageRoot, 'LICENSE-APACHE'),
        join(legalRoot, `${prefix}-LICENSE-APACHE`),
      );
      copyFileSync(
        join(packageRoot, 'LICENSE-MIT'),
        join(legalRoot, `${prefix}-LICENSE-MIT`),
      );
    }

    function integrityFile(path) {
      return {
        path: relative(stageRoot, path).replaceAll('\\', '/'),
        sha256: sha256File(path),
        size: statSync(path).size,
      };
    }
    function nativeFile(path, license, upstreamRevision, artifactSource) {
      return {
        ...integrityFile(path),
        license,
        upstreamRevision,
        artifactSource,
        signing: { kind: signingKind, identity: signingIdentity },
      };
    }
    const files = {
      mediaWorker: nativeFile(
        workerDestination,
        'AGPL-3.0-only',
        `MyAgents/${appVersion}`,
        'current MyAgents source tree',
      ),
      adapter: nativeFile(
        adapterDestination,
        'AGPL-3.0-only',
        `MyAgents/${appVersion}; adapter ABI ${speechLock.adapterAbiVersion}`,
        'current MyAgents source tree',
      ),
      sherpaOnnx: nativeFile(
        sherpaDestination,
        speechLock.source.license,
        speechLock.source.upstreamRevision,
        speechLock.source.url,
      ),
    };
    const nativeIncrementBytes = Object.values(files).reduce(
      (sum, entry) => sum + entry.size,
      0,
    );
    if (nativeIncrementBytes > speechLock.nativeIncrementHardLimitBytes) {
      throw new Error(
        `Speech native bundle exceeds 80 MiB: ${nativeIncrementBytes} bytes`,
      );
    }
    const manifest = {
      schemaVersion: 1,
      capability: 'speech-inference',
      adapterAbiVersion: speechLock.adapterAbiVersion,
      platform: targetLock.platform,
      architecture: targetLock.architecture,
      buildFingerprint,
      nativeIncrementBytes,
      framework: {
        sherpaOnnxVersion: speechLock.sherpaOnnxVersion,
        sherpaOnnxCommit: speechLock.sherpaOnnxCommit,
        onnxRuntimeVersion: speechLock.onnxRuntimeVersion,
        onnxRuntimeUpstreamRevision: speechLock.onnxRuntimeUpstreamRevision,
      },
      files,
      onnxRuntime: {
        sha256: runtime.sha256,
        size: runtime.size,
        license: runtime.license,
        upstreamRevision: runtime.upstreamRevision,
      },
      legalFiles: filesUnder(legalRoot).sort().map(integrityFile),
    };
    writeFileSync(
      join(stageRoot, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (!validatePreparedSpeechBundle(stageRoot, expectedBundle)) {
      throw new Error(
        `Newly prepared speech-inference resources failed validation for ${target}`,
      );
    }
    mkdirSync(dirname(preparedRoot), { recursive: true });
    renameSync(stageRoot, preparedRoot);
    publishPreparedBundle(preparedRoot, expectedBundle);
    console.log(
      `Prepared locked speech-inference resources for ${target} ` +
        `(fingerprint ${buildFingerprint.slice(0, 12)}; native ${(nativeIncrementBytes / 1024 / 1024).toFixed(1)} MiB; ` +
        `cache hits ${cacheStats.hits}, migrated ${cacheStats.migrated}, downloaded ${cacheStats.downloaded})`,
    );
    return Object.freeze({ target, needsBuild: false });
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}
