import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertModelQaHomePath(home) {
  if (typeof home !== 'string' || !/^\/private\/tmp\/moxbots-modelqa-[A-Za-z0-9_-]+$/.test(home)) throw new Error('Model QA HOME must be an explicit direct private temporary directory');
}
export function modelQaLaunchEnvironment(home, inherited = process.env) {
  assertModelQaHomePath(home);
  if (!home.startsWith('/private/tmp/moxbots-modelqa-') || realpathSync(home) !== home || !lstatSync(home).isDirectory() || (lstatSync(home).mode & 0o077)) throw new Error('Model QA requires a physical private 0700 HOME under /private/tmp/moxbots-modelqa-*');
  const data = join(home, '.moxbot-modelqa');
  return {
    HOME: home, USER: inherited.USER ?? '', LOGNAME: inherited.LOGNAME ?? '',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'zh_CN.UTF-8',
    TMPDIR: home, SHELL: '/bin/sh',
    CODEX_HOME: join(data, 'codex'), CLAUDE_CONFIG_DIR: join(data, 'claude'),
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
  };
}
/** An explicit local manifest pins only two native CLIs and a loopback proxy. */
export function modelQaRuntimeEnvironment(data) {
  const file = join(data, 'modelqa-runtime-policy.json');
  let st;
  try { st = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw new Error('Model QA runtime policy must be an owned private physical file');
  const raw = readFileSync(file, 'utf8');
  if (Buffer.byteLength(raw) > 8192) throw new Error('Model QA runtime policy too large');
  const policy = JSON.parse(raw);
  if (policy.version !== 1 || !policy.executables || Object.keys(policy).some(k => !['version', 'executables', 'proxy'].includes(k))) throw new Error('Invalid model QA runtime policy');
  const env = {};
  const names = { codex: 'MOXBOTS_MODELQA_CODEX_EXECUTABLE', claudeCode: 'MOXBOTS_MODELQA_CLAUDE_EXECUTABLE' };
  if (Object.keys(policy.executables).some(k => !Object.hasOwn(names, k))) throw new Error('Unexpected model QA executable');
  for (const [name, row] of Object.entries(policy.executables)) {
    if (!row || Object.keys(row).some(k => !['path', 'sha256'].includes(k)) || typeof row.path !== 'string' || !row.path.startsWith('/') || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Unpinned model QA executable');
    const stat = lstatSync(row.path);
    if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111) || realpathSync(row.path) !== row.path) throw new Error('Model QA executable must be canonical and executable');
    if (createHash('sha256').update(readFileSync(row.path)).digest('hex') !== row.sha256) throw new Error('Model QA executable changed since approval');
    env[names[name]] = row.path;
  }
  if (policy.proxy !== undefined) {
    const url = new URL(policy.proxy);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024 || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Model QA proxy must be an explicit uncredentialed loopback HTTP proxy');
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) env[key] = url.origin;
  }
  return env;
}
export function prepareModelQaHome(home) {
  const env = modelQaLaunchEnvironment(home);
  const data = join(home, '.moxbot-modelqa');
  for (const dir of [data, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(dir) !== dir || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw new Error('Model QA data/auth directory must be private, physical and owned');
  }
  for (const path of [join(data, 'config.json'), join(data, 'app.lock'), join(env.CODEX_HOME, 'auth.json'), join(env.CODEX_HOME, 'config.toml'), join(env.CLAUDE_CONFIG_DIR, 'settings.json'), join(env.CLAUDE_CONFIG_DIR, '.credentials.json')]) {
    let st;
    try { st = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!st.isFile() || st.isSymbolicLink() || realpathSync(path) !== path || (process.getuid && st.uid !== process.getuid())) throw new Error('Model QA configuration must be an owned physical file');
  }
  return { ...env, ...modelQaRuntimeEnvironment(data) };
}
/** The CLI's single-threaded spawn gives only its child a private creation mask. */
export function spawnPrivateModelQaProcess(executable, args, options) {
  const previous = process.umask(0o077);
  try { return spawn(executable, args, options); }
  finally { process.umask(previous); }
}
export function launchModelQa(app, home) {
  // Validate the original input before canonicalizing; a symlink is not consent.
  const env = prepareModelQaHome(home);
  app = realpathSync(app);
  if (!app.startsWith('/private/tmp/') || !app.endsWith('/MoXBots Model QA.app')) throw new Error('Only an isolated Model QA app may be launched');
  const plist = join(app, 'Contents/Info.plist');
  const read = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist], { encoding: 'utf8' }).trim();
  if (read('CFBundleIdentifier') !== 'com.moxbot.modelqa') throw new Error('Unexpected model QA bundle identity');
  if (read('MoXBotsModelQaHome') !== home) throw new Error('Model QA app is compiled for a different private HOME');
  const executable = read('CFBundleExecutable');
  if (executable.includes('/') || executable.includes('..')) throw new Error('Invalid model QA executable');
  const data = join(home, '.moxbot-modelqa');
  // A preexisting live app lock is never replaced/killed by the acceptance launcher.
  try {
    const pid = Number(readFileSync(join(data, 'app.lock'), 'utf8').trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error('Model QA instance is already active; reuse it or quit it normally'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const child = spawnPrivateModelQaProcess(join(app, 'Contents/MacOS', executable), [], { env, stdio: 'ignore', detached: true });
  child.unref();
  writeFileSync(join(home, 'modelqa-launch.json'), JSON.stringify({ app, home, pid: child.pid, bundleId: 'com.moxbot.modelqa', credentialContents: 'not captured', policy: 'utility only; dedicated account namespace; not an OS sandbox' }, null, 2) + '\n', { mode: 0o600 });
  return child.pid;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node run-moxbot-modelqa.mjs <isolated-app> <private-home>');
    console.log(JSON.stringify({ pid: launchModelQa(process.argv[2], process.argv[3]) }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
