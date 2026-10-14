/** Closed at bundle compilation. Inherited runtime env cannot enable this mode. */
declare const __MYAGENTS_UPDATER_QA__: boolean;
export function isUpdaterQaBuild(): boolean {
  return typeof __MYAGENTS_UPDATER_QA__ !== 'undefined' && __MYAGENTS_UPDATER_QA__ === true;
}
