import { APP_BUILD_PROFILE, APP_WEBSITE_URL } from '../../../shared/appProfile';

export type SettingsSection =
  | 'general'
  | 'proxy'
  | 'external-cli'
  | 'shortcuts'
  | 'providers'
  | 'mcp'
  | 'skills'
  | 'sub-agents'
  | 'plugins'
  | 'agent'
  | 'usage-stats'
  | 'desktop-pet'
  | 'about'
  | 'developer';

export const VALID_SECTIONS: SettingsSection[] = [
  'general',
  'proxy',
  'external-cli',
  'shortcuts',
  'providers',
  'mcp',
  'skills',
  'sub-agents',
  'plugins',
  'agent',
  'usage-stats',
  'desktop-pet',
  'about',
  'developer',
];

export const MYAGENTS_GITHUB_URL = APP_BUILD_PROFILE === 'moxbot'
  ? 'https://github.com/heavenzhang/MoXBots'
  : 'https://github.com/hAcKlyc/MyAgents';
export const MYAGENTS_SOURCE_CODE_URL = MYAGENTS_GITHUB_URL;
export const MYAGENTS_RELEASES_URL = APP_BUILD_PROFILE === 'moxbot'
  ? `${APP_WEBSITE_URL}download/`
  : `${MYAGENTS_GITHUB_URL}/releases`;

export const PLAYWRIGHT_DEVICE_PRESETS = [
  'iPhone 15 Pro',
  'iPhone 15',
  'iPhone SE',
  'iPad Pro 11',
  'Pixel 7',
  'Galaxy S23',
];
