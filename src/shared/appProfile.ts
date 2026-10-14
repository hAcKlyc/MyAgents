/** Closed, build-time product identity. Unbundled tools retain MyAgents defaults. */
declare const __MYAGENTS_BUILD_PROFILE__: 'myagents' | 'moxbot';

const selectedProfile = typeof __MYAGENTS_BUILD_PROFILE__ === 'undefined'
  ? 'myagents'
  : __MYAGENTS_BUILD_PROFILE__;
if (selectedProfile !== 'myagents' && selectedProfile !== 'moxbot') {
  throw new Error('Unsupported application build profile');
}

export const APP_BUILD_PROFILE: 'myagents' | 'moxbot' = selectedProfile;
export const APP_DATA_DIR_NAME = APP_BUILD_PROFILE === 'moxbot' ? '.moxbot' : '.myagents';
export const APP_DISPLAY_NAME = APP_BUILD_PROFILE === 'moxbot' ? 'MoXBots' : 'MyAgents';
export const APP_WEBSITE_URL = APP_BUILD_PROFILE === 'moxbot'
  ? 'https://140.143.183.232/'
  : 'https://myagents.io';
export const APP_URL_SCHEME = APP_BUILD_PROFILE;
export const APP_CLI_NAME = APP_BUILD_PROFILE;
