import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qaBuildEnvironment } from './build-moxbot-updaterqa.mjs';
import { assertModelQaHomePath, modelQaLaunchEnvironment } from './run-moxbot-modelqa.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
export function parseModelQaArgs(args) {
  const options = {};
  let tauriArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { tauriArgs = args.slice(i + 1); break; }
    if (!['--qa-workspace', '--qa-version', '--qa-home'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Unknown, duplicate or missing model QA argument');
    options[args[i]] = args[++i];
  }
  const workspace = resolve(options['--qa-workspace'] ?? '');
  if (!options['--qa-workspace'] || !workspace.startsWith('/private/tmp/') || existsSync(workspace)) throw new Error('Model QA requires a new /private/tmp workspace');
  const version = options['--qa-version'];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Model QA requires an explicit stable version');
  const home = options['--qa-home'];
  assertModelQaHomePath(home);
  for (let i = 0; i < tauriArgs.length; i++) {
    const arg = tauriArgs[i];
    if (['--no-bundle', '--ci', '--verbose', '-v'].includes(arg)) continue;
    if (['--target', '-t'].includes(arg) && tauriArgs[i + 1] === 'aarch64-apple-darwin') { i++; continue; }
    if (arg === '--target=aarch64-apple-darwin') continue;
    if (arg === '--bundles' && tauriArgs[i + 1] === 'app') { i++; continue; }
    throw new Error('Model QA accepts only arm64 target/output flags; identity/features/config are closed');
  }
  return { workspace, version, home, tauriArgs };
}
export function modelQaBuildEnvironment(inherited, workspace, home) {
  assertModelQaHomePath(home);
  const env = { ...qaBuildEnvironment(inherited, workspace), MYAGENTS_BUILD_PROFILE: 'moxbot-modelqa' };
  env.MOXBOTS_MODELQA_HOME = home;
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'ZDOTDIR']) delete env[key];
  return env;
}
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Model QA build step failed: ' + command);
}
export async function buildModelQa(args) {
  if (process.platform !== 'darwin') throw new Error('Model QA build requires macOS/APFS');
  const options = parseModelQaArgs(args);
  modelQaLaunchEnvironment(options.home);
  mkdirSync(options.workspace, { mode: 0o700 });
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (['.git', '.codex', 'node_modules', 'dist', 'src-tauri', 'output', 'work'].includes(item.name) || item.name.startsWith('.env')) continue;
    run('/bin/cp', ['-cR', join(root, item.name), join(options.workspace, item.name)], root, process.env);
  }
  mkdirSync(join(options.workspace, 'src-tauri'));
  for (const item of readdirSync(join(root, 'src-tauri'), { withFileTypes: true })) {
    if (['target', 'gen'].includes(item.name)) continue;
    run('/bin/cp', ['-cR', join(root, 'src-tauri', item.name), join(options.workspace, 'src-tauri', item.name)], root, process.env);
  }
  run('/bin/cp', ['-cR', join(root, 'node_modules'), join(options.workspace, 'node_modules')], root, process.env);
  // APFS-clone existing Cargo dependencies when available; Cargo still owns
  // source/feature/profile invalidation and rebuilds the isolated app identity.
  if (existsSync(join(root, 'src-tauri/target'))) run('/bin/cp', ['-cR', join(root, 'src-tauri/target'), join(options.workspace, 'src-tauri/target')], root, process.env);
  const configPath = join(options.workspace, 'src-tauri/tauri.moxbot-modelqa.conf.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.version = options.version;
  config.plugins.updater = { pubkey: '', endpoints: [] };
  const env = modelQaBuildEnvironment(process.env, options.workspace, options.home);
  run('npm', ['run', 'build:assets'], options.workspace, env);
  config.build = { ...config.build, beforeBuildCommand: null };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  run('/usr/libexec/PlistBuddy', ['-c', `Add :MoXBotsModelQaHome string ${options.home}`, join(options.workspace, 'src-tauri/Info.moxbot-modelqa.plist')], options.workspace, env);
  writeFileSync(join(options.workspace, 'model-qa-build-receipt.json'), JSON.stringify({ identity: config.identifier, version: options.version, sourceRoot: root, profile: env.MYAGENTS_BUILD_PROFILE, dataRoot: '.moxbot-modelqa', qaHome: options.home, modelPolicy: 'tool-free utility only', productionCredentialReader: 'not linked', config: configPath }, null, 2) + '\n');
  run(process.execPath, [join(options.workspace, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--config', configPath, ...options.tauriArgs], options.workspace, env);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await buildModelQa(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
