/** One closed build profile feeds Vite, Node bundles, and the QA wrapper. */
export function resolveAppBuildProfile(env = process.env) {
  const value = env.MYAGENTS_BUILD_PROFILE ?? 'myagents';
  if (!['myagents', 'moxbot', 'moxbot-updaterqa', 'moxbot-modelqa'].includes(value)) {
    throw new Error('MYAGENTS_BUILD_PROFILE must be myagents, moxbot, moxbot-updaterqa or moxbot-modelqa');
  }
  return value;
}
export function appBuildDefines(env = process.env) {
  const profile = resolveAppBuildProfile(env);
  return {
    __MYAGENTS_BUILD_PROFILE__: JSON.stringify(profile),
    __MYAGENTS_UPDATER_QA__: JSON.stringify(profile === 'moxbot-updaterqa'),
    __MYAGENTS_MODEL_QA__: JSON.stringify(profile === 'moxbot-modelqa'),
  };
}
