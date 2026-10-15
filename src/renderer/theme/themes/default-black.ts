import { APP_DISPLAY_NAME } from '../../../shared/appProfile';
import stylesheetText from './default-black.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const defaultBlackThemeManifest = {
  id: 'default-black',
  displayName: `${APP_DISPLAY_NAME} Classic2`,
  description: `${APP_DISPLAY_NAME} Classic with neutral-black primary buttons`,
  stylesheetText,
} satisfies PresetThemeManifest;
