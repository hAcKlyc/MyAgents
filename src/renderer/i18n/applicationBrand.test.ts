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
    expect(APP_WEBSITE_URL).toBe(profile === 'moxbot' ? 'https://140.143.183.232/' : 'https://myagents.io');
  });
});
