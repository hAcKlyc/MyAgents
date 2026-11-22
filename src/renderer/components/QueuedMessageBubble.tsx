import { ClockIcon, PlayIcon, CloseIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';

import type { QueuedMessageInfo } from '@/types/queue';

interface QueuedMessagesPanelProps {
  messages: QueuedMessageInfo[];
  onCancel: (queueId: string) => void;
  onForceExecute: (queueId: string) => void;
  stopsCurrentTurn?: boolean;
}

/**
 * A single floating panel that displays all queued messages.
 * Right-aligned, semi-transparent background, compact layout.
 */
export default function QueuedMessagesPanel({ messages, onCancel, onForceExecute, stopsCurrentTurn = false }: QueuedMessagesPanelProps) {
  const { t } = useTranslation('chat');
  if (messages.length === 0) return null;

  // 卡片级 DOM——父级是 SimpleChatInput 里的 `flex items-end justify-end gap-2`
  // 行（和 AgentStatusPanel 共享）。`pointer-events-auto` 抢回行容器
  // `pointer-events-none` 屏蔽的点击；不再自带 `mb-2 flex justify-end`，那部分
  // 现在由行容器统一负责，否则 items-end / mr-auto / :only-child 检测会被多余
  // 一层 wrapper 干扰。
  return (
    <div
      className="pointer-events-auto min-w-[min(144px,100%)] max-w-[min(100%,max(144px,33%))] rounded-xl border border-[var(--line)] px-3 py-2 shadow-sm backdrop-blur-sm"
      style={{ backgroundColor: 'color-mix(in srgb, var(--paper) 88%, transparent)' }}
    >
      {/* Header */}
      <div className="mb-1.5 flex items-center gap-1 text-xs text-[var(--ink-muted)]">
        <ClockIcon size={11} />
        <span>{t(stopsCurrentTurn ? 'shell.queue.afterCurrentTurn' : 'shell.queue.title', { count: messages.length })}</span>
      </div>

      {/* Message list */}
      <div className="space-y-1">
        {messages.map((qm) => {
          const canCancel = qm.canCancel !== false && !qm.queueId.startsWith('opt-');
          const canForceExecute = qm.canForceExecute !== false && !qm.queueId.startsWith('opt-');

          return (
            <div key={qm.queueId} className="group flex items-center gap-1.5">
              {/* Message text */}
              <div className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">
                {qm.text.length > 60 ? qm.text.slice(0, 60) + '...' : qm.text}
              </div>

              {/* Images indicator */}
              {qm.images && qm.images.length > 0 && (
                <div className="flex shrink-0 gap-0.5">
                  {qm.images.slice(0, 2).map((img) => (
                    <div key={img.id} className="h-5 w-5 overflow-hidden rounded border border-[var(--ink-muted)]/20">
                      <img src={img.preview} alt={img.name} className="h-full w-full object-cover" />
                    </div>
                  ))}
                </div>
              )}

              {/* Action buttons — visible on hover. In-flight AgentSDK items are still
                  conditionally cancellable via SDK cancel_async_message; runtime queues
                  that cannot provide equivalent guarantees hide these controls. */}
              {(canForceExecute || canCancel) && (
                <div className="flex shrink-0 items-center gap-0.5 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  {canForceExecute && (
                    <button
                      type="button"
                      onClick={() => onForceExecute(qm.queueId)}
                      aria-label={t(stopsCurrentTurn ? 'shell.queue.stopAndSend' : 'shell.queue.sendNow')}
                      title={t(stopsCurrentTurn ? 'shell.queue.stopAndSend' : 'shell.queue.sendNow')}
                      className="compact-action text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"
                    >
                      <PlayIcon size={12} />
                    </button>
                  )}
                  {canCancel && (
                    <button
                      type="button"
                      onClick={() => onCancel(qm.queueId)}
                      aria-label={t(qm.isInFlight ? 'shell.queue.recallSend' : 'shell.queue.cancelQueued')}
                      title={t(qm.isInFlight ? 'shell.queue.recallSend' : 'shell.queue.cancelQueued')}
                      className="compact-action text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"
                    >
                      <CloseIcon size={12} />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
