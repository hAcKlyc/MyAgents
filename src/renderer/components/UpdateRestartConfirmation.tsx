import { useTranslation } from 'react-i18next';
import ConfirmDialog from './ConfirmDialog';

/** Shared by startup and user-invoked update entry points. Enter must not
 * accidentally interrupt work when the startup dialog appears. */
export default function UpdateRestartConfirmation({ version, onConfirm, onCancel }: {
  version: string | null;
  onConfirm: (interruptWork: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('app');
  return <ConfirmDialog
    title={t('appChrome.updateRestartTitle')}
    message={t('appChrome.updateRestartMessage', { version })}
    confirmText={t('appChrome.updateRestartWhenIdle')}
    cancelText={t('appChrome.later')}
    confirmVariant="primary"
    alternativeAction={{ text: t('appChrome.updateRestartConfirm'), danger: true, onClick: () => onConfirm(true) }}
    disableEnterShortcut
    onConfirm={() => onConfirm(false)}
    onCancel={onCancel}
  />;
}
