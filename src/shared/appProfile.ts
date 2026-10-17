import { isUpdaterQaBuild, isModelQaBuild } from './updaterQa';
/** Closed, build-time product identity. Unbundled tools retain MyAgents defaults. */
declare const __MYAGENTS_BUILD_PROFILE__: 'myagents' | 'moxbot' | 'moxbot-updaterqa' | 'moxbot-modelqa';

const selectedProfile = typeof __MYAGENTS_BUILD_PROFILE__ === 'undefined'
  ? 'myagents'
  : __MYAGENTS_BUILD_PROFILE__;
if (selectedProfile !== 'myagents' && selectedProfile !== 'moxbot' && selectedProfile !== 'moxbot-updaterqa' && selectedProfile !== 'moxbot-modelqa') {
  throw new Error('Unsupported application build profile');
}

// QA shares the MoxBots behavior, but every persistent identity is distinct.
export const IS_UPDATER_QA = isUpdaterQaBuild();
export const IS_MODEL_QA = isModelQaBuild();
if (IS_UPDATER_QA !== (selectedProfile === 'moxbot-updaterqa') || IS_MODEL_QA !== (selectedProfile === 'moxbot-modelqa')) {
  throw new Error('Inconsistent application QA build profile');
}
export const APP_BUILD_PROFILE: 'myagents' | 'moxbot' = selectedProfile === 'myagents' ? 'myagents' : 'moxbot';
export const APP_DATA_DIR_NAME = IS_MODEL_QA ? '.moxbot-modelqa' : IS_UPDATER_QA ? '.moxbot-updaterqa' : APP_BUILD_PROFILE === 'moxbot' ? '.moxbot' : '.myagents';
export const APP_DISPLAY_NAME = IS_MODEL_QA ? 'MoXBots Model QA' : IS_UPDATER_QA ? 'MoXBots Updater QA' : APP_BUILD_PROFILE === 'moxbot' ? 'MoXBots' : 'MyAgents';
export const APP_WEBSITE_URL = APP_BUILD_PROFILE === 'moxbot'
  ? 'https://140.143.183.232/'
  : 'https://myagents.io';
export const APP_URL_SCHEME = IS_MODEL_QA ? 'moxbot-modelqa' : IS_UPDATER_QA ? 'moxbot-updaterqa' : APP_BUILD_PROFILE;
export const APP_CLI_NAME = IS_MODEL_QA ? 'moxbot-modelqa' : IS_UPDATER_QA ? 'moxbot-updaterqa' : APP_BUILD_PROFILE;
