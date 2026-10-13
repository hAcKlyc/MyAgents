import { createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  chmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const RELEASE_LOCK = path.join(REPO_ROOT, 'scripts/moxbot-credential-reader-release.json');
export const READER_FILENAME = 'moxbots-credential-reader';
export const READER_DESTINATION = `Contents/Helpers/${READER_FILENAME}`;
export const MANIFEST_DESTINATION = 'Contents/Resources/credential-reader-manifest.json';
const MANIFEST_FILENAME = 'credential-reader-manifest.json';
const MAX_MANIFEST_BYTES = 4096;
const MAX_READER_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_40 = /^[0-9a-f]{40}$/;
const MANIFEST_KEYS = [
  'version',
  'protocolVersion',
  'identifier',
  'parentIdentifier',
  'executable',
  'sha256',
  'cdhash',
  'signingCertificateSha256',
];

function fail(message) {
  throw new Error(`MoxBots credential reader: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function validateReleaseLock(lock) {
  exactKeys(lock, [
    'version',
    'protocolVersion',
    'identifier',
    'parentIdentifier',
    'signingCertificateSha256',
    'sourceInputSha256',
    'artifacts',
  ], 'release lock');
  if (!lock.artifacts || typeof lock.artifacts !== 'object' || Array.isArray(lock.artifacts)) {
    fail('release lock artifact pins must be an object');
  }
  const artifactArchitectures = Object.keys(lock.artifacts);
  if (artifactArchitectures.length === 0
    || artifactArchitectures.some((architecture) => !['arm64', 'x86_64'].includes(architecture))) {
    fail('release lock artifact architectures are invalid');
  }
  for (const architecture of artifactArchitectures) {
    const pin = lock.artifacts[architecture];
    exactKeys(pin, ['sha256', 'cdhash'], `${architecture} artifact pin`);
    if (!HEX_64.test(pin.sha256) || !HEX_40.test(pin.cdhash)) {
      fail(`${architecture} artifact pin is invalid`);
    }
  }
  if (lock.version !== 1 || lock.protocolVersion !== 1
    || lock.identifier !== 'com.moxbot.credential-reader'
    || lock.parentIdentifier !== 'com.moxbot.app'
    || !HEX_64.test(lock.signingCertificateSha256)
    || !HEX_64.test(lock.sourceInputSha256)) {
    fail('release lock is invalid');
  }
  return lock;
}

function readReleaseLock(lockPath = RELEASE_LOCK) {
  const bytes = readSafeFile(lockPath, 4096, 'release lock');
  let lock;
  try {
    lock = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('release lock is not valid JSON');
  }
  return validateReleaseLock(lock);
}

export function computeSourceInputSha256(repositoryRoot = REPO_ROOT) {
  if (!path.isAbsolute(repositoryRoot) || path.resolve(repositoryRoot) !== repositoryRoot) {
    fail('source root must be an absolute normalized path');
  }
  const root = realpathSync(repositoryRoot);
  if (root !== repositoryRoot) fail('source root must be physically canonical');

  const files = [];
  const collect = (absolutePath, relativePath) => {
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      fail('pinned source input is missing');
    }
    if (stat.isSymbolicLink()) fail('pinned source input contains a symlink');
    const relativeParts = relativePath.split('/');
    if (relativeParts.includes('target')) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolutePath).sort()) {
        collect(path.join(absolutePath, entry), `${relativePath}/${entry}`);
      }
      return;
    }
    if (!stat.isFile()) fail('pinned source input contains a non-regular file');
    const bytes = readSafeFile(absolutePath, MAX_SOURCE_FILE_BYTES, 'pinned source input');
    files.push({ relativePath, sha256: sha256(bytes) });
  };

  collect(path.join(root, 'rust-toolchain.toml'), 'rust-toolchain.toml');
  for (const directory of [
    'src-tauri/agent-network-crypto',
    'src-tauri/agent-network-protocol',
    'vendor/agent-network-protocol',
  ]) {
    collect(path.join(root, directory), directory);
  }
  files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.relativePath, 'utf8');
    digest.update('\0', 'ascii');
    digest.update(file.sha256, 'ascii');
    digest.update('\n', 'ascii');
  }
  return digest.digest('hex');
}

function modeOf(stat) {
  return stat.mode & 0o7777;
}

function checkOwnerAndWrites(stat, label, directory = false) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (stat.uid !== 0 && stat.uid !== uid) fail(`${label} has an unexpected owner`);
  if ((modeOf(stat) & 0o022) !== 0) fail(`${label} is group/world writable`);
  if (directory && !stat.isDirectory()) fail(`${label} is not a directory`);
}

function isTrustedWritableAncestor(targetPath, stat, isAncestor) {
  if (!isAncestor || !stat.isDirectory() || stat.uid !== 0) return false;
  const mode = modeOf(stat);
  if (targetPath === '/private/tmp') return mode === 0o1777;
  return targetPath === '/Applications'
    && (mode & 0o002) === 0
    && (mode & 0o0777) === 0o0775;
}

export function assertPhysicalPath(targetPath, { leafType, label }) {
  if (!path.isAbsolute(targetPath) || path.resolve(targetPath) !== targetPath) {
    fail(`${label} must be an absolute normalized path`);
  }
  let current = path.parse(targetPath).root;
  const parts = targetPath.slice(current.length).split(path.sep).filter(Boolean);
  if (!parts.length) fail(`${label} cannot be the filesystem root`);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      fail(`${label} path is missing`);
    }
    if (stat.isSymbolicLink()) fail(`${label} path contains a symlink`);
    const isAncestor = index < parts.length - 1;
    const isDirectory = isAncestor || leafType === 'directory';
    if (isTrustedWritableAncestor(current, stat, isAncestor)) {
      if (!stat.isDirectory()) fail(`${label} parent is not a directory`);
    } else {
      checkOwnerAndWrites(stat, label, isDirectory);
    }
    if (isAncestor && !stat.isDirectory()) fail(`${label} parent is not a directory`);
  }
  const canonical = realpathSync(targetPath);
  if (canonical !== targetPath) fail(`${label} path is not physically canonical`);
  return lstatSync(targetPath);
}

function sameFileIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.nlink === b.nlink && modeOf(a) === modeOf(b) && a.mtimeMs === b.mtimeMs;
}

function readSafeFile(targetPath, maxBytes, label) {
  const initial = assertPhysicalPath(targetPath, { leafType: 'file', label });
  if (!initial.isFile() || initial.nlink !== 1 || initial.size > maxBytes) {
    fail(`${label} is not a bounded regular single-link file`);
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const nonBlock = constants.O_NONBLOCK ?? 0;
  let fd;
  try {
    fd = openSync(targetPath, constants.O_RDONLY | noFollow | nonBlock);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || !sameFileIdentity(initial, before)) {
      fail(`${label} changed while opening`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const current = lstatSync(targetPath);
    if (!sameFileIdentity(before, after) || !sameFileIdentity(after, current) || bytes.length !== after.size) {
      fail(`${label} changed while reading`);
    }
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseManifest(bytes, lock) {
  if (bytes.length > MAX_MANIFEST_BYTES) fail('manifest exceeds the size limit');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('manifest is not valid JSON');
  }
  exactKeys(manifest, MANIFEST_KEYS, 'manifest');
  const canonical = `${JSON.stringify(manifest)}\n`;
  if (bytes.toString('utf8') !== canonical) fail('manifest is not canonical JSON');
  if (manifest.version !== lock.version
    || manifest.protocolVersion !== lock.protocolVersion
    || manifest.identifier !== lock.identifier
    || manifest.parentIdentifier !== lock.parentIdentifier
    || manifest.executable !== READER_DESTINATION
    || !HEX_64.test(manifest.sha256)
    || !HEX_40.test(manifest.cdhash)
    || manifest.signingCertificateSha256 !== lock.signingCertificateSha256) {
    fail('manifest does not match the pinned release contract');
  }
  return manifest;
}

function runFile(program, args, { cwd } = {}) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`${path.basename(program)} verification failed`);
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function field(output, name) {
  const matches = [...output.matchAll(new RegExp(`^${name}=([^\\r\\n]+)$`, 'gm'))];
  if (matches.length !== 1) fail(`codesign output has no unique ${name}`);
  return matches[0][1].trim();
}

export function inspectMacSignature(binaryPath, { run = runFile, makeTempDir = mkdtempSync } = {}) {
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', binaryPath]);
  const details = run('/usr/bin/codesign', ['--display', '--verbose=4', binaryPath]);
  const identifier = field(details, 'Identifier');
  const cdhash = field(details, 'CDHash').toLowerCase();
  if (!HEX_40.test(cdhash)) fail('codesign CDHash is malformed');

  const certDir = makeTempDir(path.join(realpathSync(tmpdir()), 'moxbot-reader-cert-'));
  try {
    run('/usr/bin/codesign', ['--display', '--extract-certificates', binaryPath], { cwd: certDir });
    const leaf = readSafeFile(path.join(certDir, 'codesign0'), 1024 * 1024, 'signing certificate');
    const certificate = new X509Certificate(leaf);
    const signingCertificateSha256 = sha256(certificate.raw);
    return { identifier, cdhash, signingCertificateSha256 };
  } finally {
    rmSync(certDir, { recursive: true, force: true });
  }
}

export function inspectMacArchitecture(binaryPath, { run = runFile } = {}) {
  const output = run('/usr/bin/lipo', ['-archs', binaryPath]).trim().split(/\s+/).filter(Boolean);
  return output;
}

export function verifyPackagedCredentialReader({
  appBundle,
  expectedManifest,
  repositoryRoot = REPO_ROOT,
  inspectSignature = inspectMacSignature,
  inspectArchitecture = inspectMacArchitecture,
}) {
  const lock = readReleaseLock(path.join(repositoryRoot, 'scripts/moxbot-credential-reader-release.json'));
  if (expectedManifest.executable !== READER_DESTINATION) fail('packaged reader destination is invalid');
  const sourceInputSha256 = computeSourceInputSha256(repositoryRoot);
  if (sourceInputSha256 !== lock.sourceInputSha256) {
    fail('source closure changed before Tauri bundle verification');
  }
  const appStat = assertPhysicalPath(appBundle, { leafType: 'directory', label: 'built app bundle' });
  if (!appStat.isDirectory() || !appBundle.endsWith('.app')) fail('built output is not an app bundle');
  const manifestPath = path.join(appBundle, MANIFEST_DESTINATION);
  const binaryPath = path.join(appBundle, READER_DESTINATION);
  const manifestBytes = readSafeFile(manifestPath, MAX_MANIFEST_BYTES, 'bundled manifest');
  const manifest = parseManifest(manifestBytes, {
    version: expectedManifest.version,
    protocolVersion: expectedManifest.protocolVersion,
    identifier: expectedManifest.identifier,
    parentIdentifier: expectedManifest.parentIdentifier,
    signingCertificateSha256: expectedManifest.signingCertificateSha256,
  });
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
    fail('Tauri changed the bundled credential reader manifest');
  }
  const binaryBytes = readSafeFile(binaryPath, MAX_READER_BYTES, 'bundled reader');
  if (sha256(binaryBytes) !== expectedManifest.sha256) fail('Tauri changed the bundled credential reader bytes');
  const architectures = inspectArchitecture(binaryPath);
  if (architectures.length !== 1) fail('bundled reader must be a thin binary');
  const artifactPin = lock.artifacts[architectures[0]];
  if (!artifactPin || expectedManifest.sha256 !== artifactPin.sha256
    || expectedManifest.cdhash !== artifactPin.cdhash) {
    fail('expected packaged reader does not match a trusted architecture artifact pin');
  }
  const signature = inspectSignature(binaryPath);
  if (signature.identifier !== expectedManifest.identifier
    || signature.cdhash.toLowerCase() !== expectedManifest.cdhash
    || signature.signingCertificateSha256.toLowerCase() !== expectedManifest.signingCertificateSha256) {
    fail('Tauri changed the bundled credential reader signature');
  }
  if (computeSourceInputSha256(repositoryRoot) !== sourceInputSha256) {
    fail('pinned source inputs changed during Tauri bundle verification');
  }
  return true;
}

export function resolveMacTargetTriple(args, hostArch = process.arch) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--target' || argument === '-t') return args[index + 1];
    if (argument.startsWith('--target=')) return argument.slice('--target='.length);
  }
  if (hostArch === 'arm64') return 'aarch64-apple-darwin';
  if (hostArch === 'x64') return 'x86_64-apple-darwin';
  fail('unable to determine a supported macOS target triple');
}

function validateArch(targetArch) {
  if (targetArch !== 'arm64' && targetArch !== 'x86_64') fail('unsupported macOS target architecture');
}

export function buildMoxbotReaderOverlay(stagingDirectory) {
  const helper = path.join(stagingDirectory, READER_FILENAME);
  const manifest = path.join(stagingDirectory, MANIFEST_FILENAME);
  return {
    bundle: {
      macOS: {
        files: {
          [READER_DESTINATION.slice('Contents/'.length)]: helper,
          [MANIFEST_DESTINATION.slice('Contents/'.length)]: manifest,
        },
      },
    },
  };
}

export function resolveMacTargetArch(args, hostArch = process.arch) {
  let target;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--target' || argument === '-t') {
      target = args[index + 1];
      if (!target) fail('--target requires a Rust target triple');
      index += 1;
    } else if (argument.startsWith('--target=')) {
      target = argument.slice('--target='.length);
    }
  }
  if (target) {
    if (target === 'aarch64-apple-darwin' || target === 'arm64-apple-darwin') return 'arm64';
    if (target === 'x86_64-apple-darwin') return 'x86_64';
    fail('only thin arm64-apple-darwin and x86_64-apple-darwin builds are supported');
  }
  if (hostArch === 'arm64') return 'arm64';
  if (hostArch === 'x64') return 'x86_64';
  fail('unable to determine a supported macOS target architecture');
}

export function addMoxbotReaderBuildOptions(args, overlay) {
  const result = [...args];
  if (result.some((argument) => argument === '--sign' || argument === '--signing-identity'
    || argument.startsWith('--signing-identity='))) {
    fail('Tauri signing is disabled while the immutable reader is bundled');
  }

  const features = new Set();
  const remaining = [];
  for (let index = 0; index < result.length; index += 1) {
    const argument = result[index];
    if (argument === '--features' || argument === '-f') {
      const list = result[index + 1];
      if (!list || list.startsWith('-')) fail(`${argument} requires a feature list`);
      for (const feature of list.split(',').map((item) => item.trim()).filter(Boolean)) features.add(feature);
      index += 1;
    } else if (argument.startsWith('--features=')) {
      for (const feature of argument.slice('--features='.length).split(',').map((item) => item.trim()).filter(Boolean)) features.add(feature);
    } else {
      remaining.push(argument);
    }
  }
  features.add('moxbot-credential-reader');
  remaining.push('--features', [...features].join(','));
  if (!remaining.includes('--no-sign')) remaining.push('--no-sign');
  remaining.push('--config', JSON.stringify(overlay));
  return remaining;
}

export function prepareMoxbotCredentialReader({
  bundleDirectory = process.env.MOXBOTS_CREDENTIAL_READER_BUNDLE,
  targetArch,
  repositoryRoot = REPO_ROOT,
  platform = process.platform,
  lock = readReleaseLock(path.join(repositoryRoot, 'scripts/moxbot-credential-reader-release.json')),
  inspectSignature = inspectMacSignature,
  inspectArchitecture = inspectMacArchitecture,
  stageParent = realpathSync(tmpdir()),
}) {
  if (platform !== 'darwin') fail('reader injection is only supported on macOS builds');
  if (!bundleDirectory) fail('MOXBOTS_CREDENTIAL_READER_BUNDLE is required for every MoXBots macOS build');
  validateArch(targetArch);
  validateReleaseLock(lock);

  const artifactPin = lock.artifacts[targetArch];
  if (!artifactPin) {
    fail(`no signed reader artifact pin exists for ${targetArch}; it requires a separate release artifact`);
  }
  const sourceInputSha256 = computeSourceInputSha256(repositoryRoot);
  if (sourceInputSha256 !== lock.sourceInputSha256) {
    fail('source closure does not match the pinned reader artifact');
  }

  const resolvedBundle = path.resolve(bundleDirectory);
  if (resolvedBundle !== bundleDirectory) fail('artifact directory must be absolute and normalized');
  const bundleStat = assertPhysicalPath(resolvedBundle, { leafType: 'directory', label: 'artifact directory' });
  if (!bundleStat.isDirectory()) fail('artifact path is not a directory');
  const entries = readdirSync(resolvedBundle).sort();
  if (entries.length !== 2 || entries[0] !== MANIFEST_FILENAME || entries[1] !== READER_FILENAME) {
    fail('artifact directory must contain exactly the pinned manifest and reader');
  }

  const manifestPath = path.join(resolvedBundle, MANIFEST_FILENAME);
  const binaryPath = path.join(resolvedBundle, READER_FILENAME);
  if ((modeOf(bundleStat) & 0o222) !== 0) fail('artifact directory must be immutable while packaging');
  const manifestStat = assertPhysicalPath(manifestPath, { leafType: 'file', label: 'manifest' });
  const binaryStat = assertPhysicalPath(binaryPath, { leafType: 'file', label: 'reader binary' });
  if ((modeOf(bundleStat) & 0o7000) !== 0
    || (modeOf(manifestStat) & 0o7000) !== 0
    || (modeOf(binaryStat) & 0o7000) !== 0) {
    fail('artifact contains special permission bits');
  }
  if ((modeOf(manifestStat) & 0o222) !== 0 || (modeOf(binaryStat) & 0o222) !== 0) {
    fail('artifact files must be read-only while packaging');
  }
  if ((modeOf(binaryStat) & 0o111) === 0) fail('reader binary is not executable');
  const manifestBytes = readSafeFile(manifestPath, MAX_MANIFEST_BYTES, 'manifest');
  const manifest = parseManifest(manifestBytes, lock);
  if (manifest.sha256 !== artifactPin.sha256 || manifest.cdhash !== artifactPin.cdhash) {
    fail(`reader manifest does not match the trusted ${targetArch} artifact pin`);
  }
  const binaryBytes = readSafeFile(binaryPath, MAX_READER_BYTES, 'reader binary');
  if (sha256(binaryBytes) !== manifest.sha256) fail('reader SHA-256 does not match the manifest');

  const signature = inspectSignature(binaryPath);
  if (signature.identifier !== lock.identifier
    || signature.cdhash.toLowerCase() !== manifest.cdhash
    || signature.signingCertificateSha256.toLowerCase() !== lock.signingCertificateSha256) {
    fail('reader signature does not match the pinned identity');
  }
  const architectures = inspectArchitecture(binaryPath);
  if (architectures.length !== 1 || architectures[0] !== targetArch) {
    fail('reader must be a thin binary for the requested target architecture');
  }
  if (!readSafeFile(binaryPath, MAX_READER_BYTES, 'reader binary').equals(binaryBytes)
    || !readSafeFile(manifestPath, MAX_MANIFEST_BYTES, 'manifest').equals(manifestBytes)) {
    fail('artifact changed during signature verification');
  }
  if (computeSourceInputSha256(repositoryRoot) !== sourceInputSha256) {
    fail('pinned source inputs changed during artifact verification');
  }

  const canonicalStageParent = realpathSync(stageParent);
  const stagingDirectory = mkdtempSync(path.join(canonicalStageParent, 'moxbot-fixed-reader-'));
  try {
    const stagedBinary = path.join(stagingDirectory, READER_FILENAME);
    const stagedManifest = path.join(stagingDirectory, MANIFEST_FILENAME);
    writeFileSync(stagedBinary, binaryBytes, { flag: 'wx', mode: 0o555 });
    chmodSync(stagedBinary, 0o555);
    writeFileSync(stagedManifest, manifestBytes, { flag: 'wx', mode: 0o444 });
    chmodSync(stagedManifest, 0o444);
    if (sha256(readSafeFile(stagedBinary, MAX_READER_BYTES, 'staged reader')) !== manifest.sha256
      || !readSafeFile(stagedManifest, MAX_MANIFEST_BYTES, 'staged manifest').equals(manifestBytes)) {
      fail('staged reader bytes changed');
    }
    return {
      stagingDirectory,
      overlay: buildMoxbotReaderOverlay(stagingDirectory),
      manifest,
      targetArch,
      cleanup() {
        rmSync(stagingDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}
