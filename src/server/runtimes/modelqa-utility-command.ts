import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isModelQaBuild, isUpdaterQaBuild } from '../../shared/updaterQa';
import type { RuntimeSource } from '../../shared/types/runtime';

/** Launcher verifies the binary digest; only this compiled QA utility may use its explicit path.
 * Never changes ordinary command discovery, native homes, model/source or authentication. */
export function modelqaUtilityCommand(runtime: 'codex' | 'claude-code', source: RuntimeSource, fallback: () => string): string {
  if (!isModelQaBuild() || isUpdaterQaBuild() || source !== 'system-cli') return fallback();
  const path = process.env[runtime === 'codex' ? 'MOXBOTS_MODELQA_CODEX_EXECUTABLE' : 'MOXBOTS_MODELQA_CLAUDE_EXECUTABLE'];
  if (!path || !isAbsolute(path) || realpathSync(path) !== path || !statSync(path).isFile()) throw new Error('MODEL_QA_UTILITY_EXECUTABLE_UNAVAILABLE');
  accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  return path;
}
