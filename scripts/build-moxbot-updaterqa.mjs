import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
export function parseQaBuildArgs(args, repositoryRoot = root) {
  const options = {};
  let tauriArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { tauriArgs = args.slice(i + 1); break; }
    if (!['--qa-workspace', '--qa-public-key', '--qa-endpoint', '--qa-version'].includes(args[i]) || !args[i + 1]) throw new Error('Unknown or missing QA build argument');
    if (options[args[i]]) throw new Error('Duplicate QA build argument');
    options[args[i]] = args[++i];
  }
  const workspace = resolve(options['--qa-workspace'] ?? '');
  const publicKeyPath = resolve(options['--qa-public-key'] ?? '');
  if (!options['--qa-workspace'] || !workspace.startsWith('/private/tmp/') || workspace === repositoryRoot || existsSync(workspace)) throw new Error('QA workspace must be a new directory under /private/tmp');
  if (!options['--qa-public-key'] || !publicKeyPath.endsWith('.pub')) throw new Error('QA build requires a public .pub key path');
  const endpoint = options['--qa-endpoint'];
  if (!endpoint || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/updates\/\{\{target\}\}\.json$/.test(endpoint)) throw new Error('QA update endpoint must be explicit IPv4 loopback with target template');
  const port = Number(endpoint.split(':')[2].split('/')[0]);
  if (port > 65535 || port < 1024) throw new Error('QA endpoint requires an unprivileged valid port');
  const version = options['--qa-version'];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('QA version must be explicit stable semver');
  // Only the native arm64 build and output selection are customizable.
  for (let i = 0; i < tauriArgs.length; i++) {
    const arg = tauriArgs[i];
    if (['--no-bundle', '--ci', '--verbose', '-v'].includes(arg)) continue;
    if (['--target', '-t'].includes(arg) && tauriArgs[i + 1] === 'aarch64-apple-darwin') { i++; continue; }
    if (arg === '--target=aarch64-apple-darwin') continue;
    if (arg === '--bundles' && tauriArgs[i + 1] === 'app') { i++; continue; }
    throw new Error('QA build accepts only arm64 target/output flags; config, features and runners are closed');
  }
  return { workspace, publicKeyPath, endpoint, version, tauriArgs };
}

export function qaBuildEnvironment(inherited, workspace) {
  const env = { ...inherited, MYAGENTS_SPACE_ENABLED: 'false', MYAGENTS_BUILD_PROFILE: 'moxbot-updaterqa', CARGO_TARGET_DIR: join(workspace, 'src-tauri/target') };
  // Build invocation credentials must not flow to a packaged QA identity.
  for (const name of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|OPENAI_|MOXBOTS_CREDENTIAL_|MOXBOTS_OWNED_SERVICE_URL|TAURI_CONFIG$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|TAURI_SIGNING_PRIVATE_KEY)/.test(name)) delete env[name];
  }
  return env;
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`QA build step failed: ${command}`);
}

export async function buildQa(args) {
  if (process.platform !== 'darwin') throw new Error('Updater QA isolation build currently requires macOS/APFS');
  const options = parseQaBuildArgs(args);
  const pubkey = readFileSync(options.publicKeyPath, 'utf8').trim();
  const decoded = Buffer.from(pubkey, 'base64').toString('utf8');
  if (!decoded.startsWith('untrusted comment:') || !/^RW[A-Za-z0-9+/=]+$/m.test(decoded)) throw new Error('QA public key must be a Tauri minisign public key');
  const production = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.moxbot.conf.json'), 'utf8'));
  if (pubkey === production.plugins.updater.pubkey) throw new Error('QA must use an independent temporary update key');
  mkdirSync(options.workspace, { mode: 0o700 });
  // Snapshot all source files, never mutate the current formal build's resources/dist/target.
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'src-tauri', 'output', 'work'].includes(item.name)) continue;
    run('/bin/cp', ['-cR', join(root, item.name), join(options.workspace, item.name)], root, process.env);
  }
  mkdirSync(join(options.workspace, 'src-tauri'));
  for (const item of readdirSync(join(root, 'src-tauri'), { withFileTypes: true })) {
    if (['target', 'gen'].includes(item.name)) continue;
    run('/bin/cp', ['-cR', join(root, 'src-tauri', item.name), join(options.workspace, 'src-tauri', item.name)], root, process.env);
  }
  run('/bin/cp', ['-cR', join(root, 'node_modules'), join(options.workspace, 'node_modules')], root, process.env);
  const configPath = join(options.workspace, 'src-tauri/tauri.moxbot-updaterqa.conf.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.version = options.version;
  config.plugins.updater.pubkey = pubkey;
  config.plugins.updater.endpoints = [options.endpoint];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(options.workspace, 'updater-qa-build-receipt.json'), JSON.stringify({ identity: config.identifier, version: options.version, sourceRoot: root, endpoint: options.endpoint, dataRoot: '.moxbot-updaterqa', productionCredentials: 'disabled', config: configPath }, null, 2));
  const env = qaBuildEnvironment(process.env, options.workspace);
  // Must rebuild server/CLI/Vite under the same QA defines; no inherited profile or no-assets shortcut.
  run('npm', ['run', 'build:assets'], options.workspace, env);
  config.build = { ...config.build, beforeBuildCommand: null };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  run(process.execPath, [join(options.workspace, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--config', configPath, ...options.tauriArgs], options.workspace, env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await buildQa(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
