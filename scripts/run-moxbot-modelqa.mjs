import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function modelQaLaunchEnvironment(home, inherited = process.env) {
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
  return env;
}
export function launchModelQa(app, home) {
  // Validate the original input before canonicalizing; a symlink is not consent.
  const env = prepareModelQaHome(home);
  app = realpathSync(app);
  if (!app.startsWith('/private/tmp/') || !app.endsWith('/MoXBots Model QA.app')) throw new Error('Only an isolated Model QA app may be launched');
  const plist = join(app, 'Contents/Info.plist');
  const read = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist], { encoding: 'utf8' }).trim();
  if (read('CFBundleIdentifier') !== 'com.moxbot.modelqa') throw new Error('Unexpected model QA bundle identity');
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
  const child = spawn(join(app, 'Contents/MacOS', executable), [], { env, stdio: 'ignore', detached: true });
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
