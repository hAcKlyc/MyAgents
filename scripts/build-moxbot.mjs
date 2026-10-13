import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMoxbotBundles } from './prepare-moxbot-bundles.mjs';
import {
  addMoxbotReaderBuildOptions,
  prepareMoxbotCredentialReader,
  resolveMacTargetArch,
  resolveMacTargetTriple,
  readMoxbotCredentialReaderRelease,
  verifyPackagedCredentialReader,
} from './prepare-moxbot-credential-reader.mjs';

// Fix all three product profiles (Vite, esbuild, Cargo) in the same invocation.
// The override also owns the bundle ID, OS deep link and filesystem permission.
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const userArgs = process.argv.slice(2);
const readerRelease = process.env.MOXBOTS_CREDENTIAL_READER_RELEASE ?? 'developer-id-v2';
let readerLock;
let reader;
let expectedAppBundle;
let cliArgs = [
  'build', '--config', 'src-tauri/tauri.moxbot.conf.json',
  ...userArgs,
];
try {
  if (!['legacy-local-v1', 'developer-id-v2'].includes(readerRelease)) {
    throw new Error('Unknown credential reader release');
  }
  if (process.platform === 'darwin') {
    const targetArch = resolveMacTargetArch(userArgs);
    const targetTriple = resolveMacTargetTriple(userArgs);
    readerLock = readMoxbotCredentialReaderRelease({ release: readerRelease, repositoryRoot: root });
    reader = prepareMoxbotCredentialReader({
      targetArch, repositoryRoot: root, release: readerRelease, lock: readerLock,
    });
    cliArgs = addMoxbotReaderBuildOptions(cliArgs, reader.overlay);
    const targetRoot = process.env.CARGO_TARGET_DIR
      ? path.resolve(root, process.env.CARGO_TARGET_DIR)
      : path.join(root, 'src-tauri/target');
    const explicitTarget = userArgs.some((argument) => argument === '--target'
      || argument === '-t' || argument.startsWith('--target='));
    const cargoProfile = userArgs.includes('--debug') ? 'debug' : 'release';
    const cargoRoot = explicitTarget ? path.join(targetRoot, targetTriple) : targetRoot;
    expectedAppBundle = path.join(cargoRoot, cargoProfile, 'bundle/macos/MoXBots.app');
  }
  await prepareMoxbotBundles({ repositoryRoot: root });
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url)),
    ...cliArgs,
  ], {
    cwd: root,
    env: { ...process.env, MYAGENTS_BUILD_PROFILE: 'moxbot' },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (process.exitCode === 0 && reader) {
    verifyPackagedCredentialReader({
      appBundle: expectedAppBundle,
      expectedManifest: reader.manifest,
      repositoryRoot: root,
      release: readerRelease,
      lock: readerLock,
    });
  }
} finally {
  reader?.cleanup();
}
