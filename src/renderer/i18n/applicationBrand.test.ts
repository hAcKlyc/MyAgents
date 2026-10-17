import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('application branding across profiles', () => {
  it.each(['myagents', 'moxbot'] as const)('brands local UI without relabeling upstream services (%s)', async (profile) => {
    vi.stubGlobal('__MYAGENTS_BUILD_PROFILE__', profile);
    vi.resetModules();
    const { i18n } = await import('./index');
    const { APP_WEBSITE_URL } = await import('../../shared/appProfile');
    const name = profile === 'moxbot' ? 'MoXBots' : 'MyAgents';
    expect(i18n.t('app:globalSidebar.openWebsite', { lng: 'zh-CN' })).toBe(`打开 ${name} 官网`);
    expect(i18n.t('app:globalSidebar.openWebsite', { lng: 'en-US' })).toBe(`Open the ${name} website`);
    expect(i18n.t('settings:about.licensingCopyright', { lng: 'en-US' })).toContain('Ethan L. MyAgents');
    expect(i18n.t('app:space.login.title', { lng: 'en-US' })).toBe('MyAgents Community');
    expect(i18n.t('app:globalSidebar.community', { lng: 'zh-CN' })).toBe('协作社区');
    expect(i18n.t('app:globalSidebar.cloudUnavailable', { lng: 'zh-CN' })).not.toContain('globalSidebar.');
    if (profile === 'moxbot') {
      expect(i18n.t('settings:about.developerParagraph1', { lng: 'zh-CN' })).toContain('Bot 团队');
      expect(i18n.t('settings:about.developerParagraph1', { lng: 'zh-CN' })).not.toContain('MyAgents');
      expect(i18n.t('settings:about.communityTitle', { lng: 'en-US' })).toBe('MoXBots Community');
    }
    for (const lng of ['zh-CN', 'en-US'] as const) {
      const originalNetwork = lng === 'zh-CN' ? 'AgentNet 局域网络' : 'AgentNet Local Network';
      const ownedPage = lng === 'zh-CN' ? 'Bots 网络' : 'Bots Network';
      expect(i18n.t('app:globalSidebar.agentNetwork', { lng })).toBe(profile === 'moxbot' ? 'Bots Ready' : originalNetwork);
      expect(i18n.t('app:tabs.agentNetwork', { lng })).toBe(profile === 'moxbot' ? ownedPage : originalNetwork);
      // Product navigation must not rename the upstream connection identity.
      expect(i18n.t('app:agentNetwork.networkName', { lng })).toBe(originalNetwork);
    }
    expect(APP_WEBSITE_URL).toBe(profile === 'moxbot' ? 'https://140.143.183.232/' : 'https://myagents.io');
  });
});
