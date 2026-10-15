import { useTranslation } from 'react-i18next';
import ConfirmDialog from './ConfirmDialog';

/** Shared by startup and user-invoked update entry points. Enter must not
 * accidentally interrupt work when the startup dialog appears. */
export default function UpdateRestartConfirmation({ version, onConfirm, onCancel }: {
  version: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('app');
  return <ConfirmDialog
    title={t('appChrome.updateRestartTitle')}
    message={t('appChrome.updateRestartMessage', { version })}
    confirmText={t('appChrome.updateRestartConfirm')}
    cancelText={t('appChrome.later')}
    confirmVariant="danger"
    disableEnterShortcut
    onConfirm={onConfirm}
    onCancel={onCancel}
  />;
}
