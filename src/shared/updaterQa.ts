/** Closed at bundle compilation. Inherited runtime env cannot enable this mode. */
declare const __MYAGENTS_UPDATER_QA__: boolean;
export function isUpdaterQaBuild(): boolean {
  return typeof __MYAGENTS_UPDATER_QA__ !== 'undefined' && __MYAGENTS_UPDATER_QA__ === true;
}

/** Model acceptance has independent identity/state but never enables updater QA execution. */
declare const __MYAGENTS_MODEL_QA__: boolean;
export function isModelQaBuild(): boolean {
  return typeof __MYAGENTS_MODEL_QA__ !== 'undefined' && __MYAGENTS_MODEL_QA__ === true;
}
export function isIsolatedQaBuild(): boolean {
  return isUpdaterQaBuild() || isModelQaBuild();
}
