import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  copyFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home/profile-test',
  join: async (...parts: string[]) => parts.join('/'),
  dirname: async (path: string) => path.slice(0, path.lastIndexOf('/')),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isBrowserDevMode: () => false }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('profile-owned renderer data root', () => {
  it.each([
    ['myagents', '.myagents'],
    ['moxbot', '.moxbot'],
  ] as const)('%s resolves all config state under the matching home directory', async (profile, directory) => {
    vi.stubGlobal('__MYAGENTS_BUILD_PROFILE__', profile);
    vi.resetModules();

    const appProfile = await import('../../../shared/appProfile');
    const configStore = await import('./configStore');

    expect(appProfile.APP_DATA_DIR_NAME).toBe(directory);
    expect(await configStore.getConfigDir()).toBe(`/home/profile-test/${directory}`);
  });
});
