import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Fix all three product profiles (Vite, esbuild, Cargo) in the same invocation.
// The override also owns the bundle ID, OS deep link and filesystem permission.
const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url)),
  'build', '--config', 'src-tauri/tauri.moxbot.conf.json',
  ...process.argv.slice(2),
], {
  cwd: root,
  env: { ...process.env, MYAGENTS_BUILD_PROFILE: 'moxbot' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
