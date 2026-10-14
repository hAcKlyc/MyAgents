import { AsyncLocalStorage } from 'node:async_hooks';
import { isModelQaBuild } from '../../shared/updaterQa';
const admission = new AsyncLocalStorage<{ active: boolean }>();
/** Only the audited tool-free utility owner may admit an SDK child in model QA. */
export async function withModelQaUtilityAdmission<T>(operation: () => Promise<T>): Promise<T> {
  if (!isModelQaBuild()) return operation();
  const scope = { active: true };
  try { return await admission.run(scope, operation); }
  finally { scope.active = false; }
}
export function hasModelQaUtilityAdmission(): boolean { return admission.getStore()?.active === true; }
