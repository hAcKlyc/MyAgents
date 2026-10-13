import { APP_BUILD_PROFILE } from '../../../shared/appProfile';
import myagentsIcon from '@/assets/runtime-icons/myagents.png';
import myagentsWebLogo from '@/assets/brand/myagents-web-logo.png';
import moxbotsIcon from '@/assets/brand/moxbots-icon.png';

export const APP_ICON_SRC = APP_BUILD_PROFILE === 'moxbot' ? moxbotsIcon : myagentsIcon;
export const APP_WEB_LOGO_SRC = APP_BUILD_PROFILE === 'moxbot' ? moxbotsIcon : myagentsWebLogo;
