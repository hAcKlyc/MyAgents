import { useId, useLayoutEffect, useRef, type RefObject } from 'react';
import { APP_BUILD_PROFILE } from '@/../shared/appProfile';
import { registerComposerUpdateOwner } from '@/utils/composerUpdateCheckpoint';

/** Admission-only bridge for local editors without a restorable Session.
 * Their existing state/IO owners remain authoritative; no draft is serialized
 * or submitted here. Callers must update unsafe refs before their first await. */
export function useUpdateEditorAdmission(
  scopePrefix: string,
  root: RefObject<HTMLElement | null>,
  input: RefObject<HTMLTextAreaElement | null>,
  isUnsafe: () => boolean,
  blockingReason: string,
) {
  const id = useId();
  const locked = useRef(false);
  const priorReadOnly = useRef(false);
  const unsafe = useRef(isUnsafe);
  useLayoutEffect(() => { unsafe.current = isUnsafe; });
  useLayoutEffect(() => {
    if (APP_BUILD_PROFILE !== 'moxbot') return;
    return registerComposerUpdateOwner({
      snapshot: () => ({
        scope: { tabId: `${scopePrefix}:${id}`, sessionId: null, workspacePath: null, mode: 'launcher' },
        text: '', context: {}, imageCount: 0, pendingAttachments: false,
        composing: false, sending: false, stagedWorkflow: false,
        ...(unsafe.current() ? { blockingReason } : {}),
      }),
      freeze: value => {
        const wasLocked = locked.current;
        locked.current = value;
        if (root.current) root.current.inert = value;
        if (input.current) {
          if (value && !wasLocked) priorReadOnly.current = input.current.readOnly;
          input.current.readOnly = value || priorReadOnly.current;
        }
      },
    });
  }, [id, scopePrefix, root, input, blockingReason]);
  return locked;
}
