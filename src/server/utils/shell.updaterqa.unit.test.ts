import { describe, expect, it, vi } from 'vitest';
const guards = vi.hoisted(() => ({ exec: vi.fn(), scan: vi.fn(() => { throw new Error('No user home scans'); }) }));
vi.mock('../../shared/updaterQa', () => ({ isUpdaterQaBuild: () => true }));
vi.mock('../../shared/appProfile', () => ({ APP_DATA_DIR_NAME: '.moxbot-updaterqa', APP_BUILD_PROFILE: 'moxbot', APP_CLI_NAME: 'moxbot-updaterqa', APP_DISPLAY_NAME: 'MoXBots Updater QA', APP_URL_SCHEME: 'moxbot-updaterqa', APP_WEBSITE_URL: 'https://140.143.183.232/', IS_UPDATER_QA: true }));
vi.mock('child_process', () => ({ execFile: guards.exec }));
import { getFallbackPaths, warmupShellPath } from './shell';

describe('updater QA shell isolation', () => {
  it('uses only bundled/system paths and never evaluates user login shell startup files', async () => {
    expect(getFallbackPaths({ platform: 'darwin', env: { HOME: '/synthetic/home' }, bundledNodeDir: '/qa/bundle/node', exists: guards.scan, readDir: guards.scan })).toEqual(['/qa/bundle/node', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    await warmupShellPath();
    expect(guards.exec).not.toHaveBeenCalled();
    expect(guards.scan).not.toHaveBeenCalled();
  });
});
