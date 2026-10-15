import { isUpdaterQaBuild } from '../../../shared/updaterQa';
import type { RuntimeSource, RuntimeType, RuntimeEnvPolicy } from '../../../shared/types/runtime';
import type { RuntimeTextUtilityTask } from '../types';
import { getExternalActivePair } from './lifecycle';
import { generateClaudeTextUtility } from '../claude-text-utility';
import { generateCodexTextUtility } from '../codex-text-utility';

/** Only native DSH utility can use the live process; CLI utilities own a separate lifecycle. */
export async function runExternalTextUtility(input: RuntimeTextUtilityTask & {
  runtime: RuntimeType; runtimeSource?: RuntimeSource; model: string; workspacePath?: string; envPolicy?: RuntimeEnvPolicy;
}): Promise<string | null> {
  if (isUpdaterQaBuild() || input.signal?.aborted) return null;
  if (input.runtime === 'dsh') {
    const pair = getExternalActivePair();
    return pair?.runtime.type === 'dsh' && pair.runtime.runTextUtility
      ? pair.runtime.runTextUtility(pair.process, input) : null;
  }
  if (input.runtime === 'claude-code') return generateClaudeTextUtility(input);
  if (input.runtime === 'codex') return generateCodexTextUtility(input);
  return null;
}
