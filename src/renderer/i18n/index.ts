import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { moxbotsCopy } from './moxbotsCopy';
import { APP_BUILD_PROFILE, APP_DISPLAY_NAME } from '../../shared/appProfile';

import { resolveEffectiveLocale, type SupportedLocale } from '../../shared/i18n';
import appEn from './locales/en-US/app.json';
import chatEn from './locales/en-US/chat.json';
import commonEn from './locales/en-US/common.json';
import launcherEn from './locales/en-US/launcher.json';
import settingsEn from './locales/en-US/settings.json';
import taskEn from './locales/en-US/task.json';
import appZh from './locales/zh-CN/app.json';
import chatZh from './locales/zh-CN/chat.json';
import commonZh from './locales/zh-CN/common.json';
import launcherZh from './locales/zh-CN/launcher.json';
import settingsZh from './locales/zh-CN/settings.json';
import taskZh from './locales/zh-CN/task.json';

export const resources = {
  'zh-CN': {
    app: { ...appZh, agentNetwork: { ...appZh.agentNetwork, ...(APP_BUILD_PROFILE === 'moxbot' ? { infoIntro: 'Bots Net 用于连接同一云账号下授权的设备与 Agent。设备管理和远程执行以目标 Host 的实际权限与状态为准。', infoRelay: '设备通过当前连接的云服务发现彼此并中转网络通信。', infoLocal: '任务在所选择的设备或 Host 执行，模型与工具由该执行环境的配置决定。' } : {}) } },
    chat: chatZh,
    common: commonZh,
    launcher: launcherZh,
    settings: { ...settingsZh, about: { ...settingsZh.about, ...(APP_BUILD_PROFILE === 'moxbot' ? moxbotsCopy['zh-CN'].about : {}) } },
    task: taskZh,
  },
  'en-US': {
    app: { ...appEn, agentNetwork: { ...appEn.agentNetwork, ...(APP_BUILD_PROFILE === 'moxbot' ? { infoIntro: 'Bots Net connects authorized devices and Agents under your cloud account. Device management and remote execution follow the target Host’s effective permissions and state.', infoRelay: 'Devices use the connected cloud service for discovery and relaying network communication.', infoLocal: 'Tasks run on the selected device or Host, using that environment’s configured models and tools.' } : {}) } },
    chat: chatEn,
    common: commonEn,
    launcher: launcherEn,
    settings: { ...settingsEn, about: { ...settingsEn.about, ...(APP_BUILD_PROFILE === 'moxbot' ? moxbotsCopy['en-US'].about : {}) } },
    task: taskEn,
  },
} as const;

export const DEFAULT_I18N_NAMESPACE = 'common';

export function getBrowserSystemLocale(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return navigator.languages?.[0] ?? navigator.language;
}

export function getInitialLocale(): SupportedLocale {
  const systemLocale = getBrowserSystemLocale();
  return systemLocale ? resolveEffectiveLocale('system', systemLocale) : 'zh-CN';
}

void i18n
  .use(initReactI18next)
  .use({
    type: 'postProcessor',
    name: 'applicationBrand',
    process(value: string, keys: string[]) {
      // Legal attribution and upstream community/network/Space services keep
      // their own identities; only local application prose is rebranded.
      const upstreamText = /^(?:[^:]+:)?(?:about\.(?:licensing|developer)|community\.|account\.|agentNetwork\.(?:info|officialNetwork)|space\.)/;
      if (APP_BUILD_PROFILE !== 'moxbot' || keys.some((key) => upstreamText.test(key))) return value;
      return value.replaceAll('MyAgents', APP_DISPLAY_NAME).replaceAll('MA 小助理', 'MoX 小助理');
    },
  })
  .init({
    resources,
    postProcess: ['applicationBrand'],
    lng: getInitialLocale(),
    fallbackLng: 'zh-CN',
    defaultNS: DEFAULT_I18N_NAMESPACE,
    ns: ['common', 'app', 'settings', 'chat', 'launcher', 'task'],
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });

export { i18n };
