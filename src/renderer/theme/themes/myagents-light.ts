import { APP_DISPLAY_NAME } from '../../../shared/appProfile';
import stylesheetText from './myagents-light.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const myAgentsLightThemeManifest = {
  id: 'myagents-light',
  displayName: `${APP_DISPLAY_NAME} Light`,
  description: 'Claude-inspired surfaces with neutral-black primary buttons',
  stylesheetText,
} satisfies PresetThemeManifest;
