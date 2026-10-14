import { useTranslation } from 'react-i18next';
import { APP_BUILD_PROFILE } from '../../../../shared/appProfile';
import toolMarketZh from '@/assets/onboarding/tool-market-zh-CN.png';
import toolMarketEn from '@/assets/onboarding/tool-market-en-US.png';

/** Local bundled artwork; navigation remains owned by App. */
export function ToolMarketEntry({ onOpen }: { onOpen: () => void }) {
  const { t, i18n } = useTranslation('settings');
  // The owned community does not implement the upstream Space resource market.
  if (APP_BUILD_PROFILE === 'moxbot') return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('capabilities.toolMarketOpen')}
      title={t('capabilities.toolMarketOpen')}
      className="block w-[360px] max-w-full shrink-0 overflow-hidden rounded-xl transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--paper)]"
      data-tool-market-entry
    >
      <img
        src={i18n.resolvedLanguage === 'en-US' ? toolMarketEn : toolMarketZh}
        alt={t('capabilities.toolMarketBanner')}
        width={2172}
        height={724}
        className="block h-auto w-full"
      />
    </button>
  );
}
