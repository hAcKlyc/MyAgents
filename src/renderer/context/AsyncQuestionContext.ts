import { createContext, useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { AsyncQuestionReply } from '../../shared/asyncUserQuestions';
import type { Message } from '@/types/chat';

/** Local send rows retain reply identity for retry, but only canonical users
 * prove that an async question was answered. */
export function acceptedAsyncQuestionReplies(
  messages: readonly Pick<Message, 'role' | 'deliveryStatus' | 'asyncQuestionReply'>[],
): AsyncQuestionReply[] {
  return messages.flatMap(message =>
    message.role === 'user' && !message.deliveryStatus && message.asyncQuestionReply
      ? [message.asyncQuestionReply]
      : [],
  );
}

interface AsyncQuestionComposerDraft {
  sessionId: string | null;
  reply: AsyncQuestionReply;
  title: string;
}

/** Chat-local reply annotation is part of the submitted composer draft. */
export function useAsyncQuestionComposerDraft(sessionId: string | null) {
  const [draft, setDraft] = useState<AsyncQuestionComposerDraft | null>(null);
  const target = draft?.sessionId === sessionId ? draft : null;
  const targetRef = useRef(target);
  useLayoutEffect(() => { targetRef.current = target; }, [target]);
  const capture = useCallback(
    (explicitReply?: AsyncQuestionReply, retryFailedMessageId?: string) => {
      // Card actions and failed-row retries own their reply identity. They must
      // not borrow the annotation of an independently edited composer draft.
      return explicitReply || retryFailedMessageId ? null : targetRef.current;
    },
    [],
  );
  const handoff = useCallback((submitted: AsyncQuestionComposerDraft | null, clearComposer?: () => void) => {
    // Compare the exact draft, so a newly selected reply to the same question
    // cannot be consumed by an earlier submission.
    if (submitted) setDraft(current => current === submitted ? null : current);
    clearComposer?.();
  }, []);
  return { target, capture, setDraft, handoff };
}

/** Views derive status from accepted messages and the existing Session queue. */
export interface AsyncQuestionActions {
  answered: AsyncQuestionReply[];
  queued: AsyncQuestionReply[];
  disabled: boolean;
  onReply: (reply: AsyncQuestionReply, text: string) => Promise<boolean>;
  onCompose: (reply: AsyncQuestionReply, title: string) => void;
}

export const AsyncQuestionContext = createContext<AsyncQuestionActions | null>(null);
