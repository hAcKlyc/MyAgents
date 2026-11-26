import { isAbsolute } from 'node:path';
import type { RuntimeDetection } from '../../shared/types/runtime';
import { spawn } from '../utils/subprocess';
import type { RuntimeDetectionOptions } from './types';

/** Installation is an executable lookup. A version probe only enriches the result. */
export async function detectCliInstallation(
  command: string,
  env: NodeJS.ProcessEnv,
  options?: RuntimeDetectionOptions,
): Promise<RuntimeDetection> {
  // resolveCommand returns a bare name when no executable was found.
  if (!isAbsolute(command)) return { installed: false };
  const installation: RuntimeDetection = { installed: true, path: command };
  if (options?.includeVersion === false) return installation;

  try {
    const child = spawn([command, '--version'], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const readVersion = Promise.all([child.exited, new Response(child.stdout).text()]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 2_000);
    });
    try {
      const result = await Promise.race([readVersion, timeout]);
      const version = result?.[1].trim();
      if (result?.[0] === 0 && version) return { ...installation, version };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // The executable was found. A failed metadata probe doesn't change that.
  }
  return installation;
}
