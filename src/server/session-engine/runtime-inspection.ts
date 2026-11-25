import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import { isManagedCodexRuntimeInstalled } from '../runtimes/codex-command-context';
import { getExternalRuntime, isRuntimeSupported } from '../runtimes/factory';
import { getSessionEngine } from './selector';

/** Ask the Session owner first; an installation-only probe never starts a Session. */
export async function inspectRuntime(runtime: RuntimeType) {
  const active = await getSessionEngine().inspectRuntime?.(runtime);
  if (active) return active;
  if (runtime === 'builtin') return null;
  return await getExternalRuntime(runtime).inspectRuntime?.() ?? null;
}

/** Probe the exact selected installation without creating a session. */
export async function detectRuntimeInstallation(runtime: RuntimeType, source?: RuntimeSource): Promise<boolean> {
  if (runtime === 'builtin') return true;
  if (runtime === 'codex' && source === 'managed-provider') return isManagedCodexRuntimeInstalled();
  return isRuntimeSupported(runtime) && (await getExternalRuntime(runtime).detect()).installed;
}
