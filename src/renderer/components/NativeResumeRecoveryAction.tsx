import { useTranslation } from 'react-i18next';
import { NATIVE_RESUME_BOUNDARY_MESSAGE } from '../../shared/nativeResumeBoundary';
import type { Message } from '@/types/chat';

/** Fork the retained native prefix; never resume the source's discarded tail. */
export function NativeResumeRecoveryAction({ error, messages, disabled, onFork }: {
  error: string;
  messages: readonly Pick<Message, 'id' | 'role' | 'sdkUuid'>[];
  disabled: boolean;
  onFork?: (messageId: string) => void;
}) {
  const { t } = useTranslation('chat');
  if (error !== NATIVE_RESUME_BOUNDARY_MESSAGE || !onFork) return null;
  const target = messages.findLast(message => message.role === 'assistant' && Boolean(message.sdkUuid));
  if (!target) return null;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onFork(target.id)}
      className="flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)] disabled:opacity-50"
    >
      {t('shell.agentError.resumeInFork')}
    </button>
  );
}
