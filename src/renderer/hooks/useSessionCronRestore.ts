import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getSessionCronTask, isTaskExecuting } from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isPendingSessionId } from '../../shared/constants';

/** Hydrate only the current Chat's Task projection; Rust owns scheduler recovery. */
export function useSessionCronRestore({
  sessionId,
  tabId,
  task,
  onRestore,
  onClear,
}: {
  sessionId: string | null | undefined;
  tabId: string;
  task: CronTask | null;
  onRestore: (task: CronTask, executing: boolean) => void;
  onClear: () => void;
}) {
  // A revisited Session is a new activation, even if an intervening read failed.
  // Losing the memo can only close readiness and cause another verified read.
  const activation = useMemo(() => ({ sessionId, tabId }), [sessionId, tabId]);
  const currentActivation = useRef(activation);
  useLayoutEffect(() => {
    currentActivation.current = activation;
  }, [activation]);
  const [settledActivation, setSettledActivation] = useState<typeof activation | null>(null);
  const loadedActivation = useRef<typeof activation | null>(null);

  useEffect(() => {
    if (!sessionId || !tabId || !isTauriEnvironment()) return;
    if (loadedActivation.current === activation) return;
    const targetSessionId = sessionId;
    let cancelled = false;

    async function hydrate() {
      try {
        const snapshot = await getSessionCronTask(targetSessionId);
        if (cancelled || currentActivation.current !== activation) return;
        if (snapshot?.status === 'running') {
          const executing = await isTaskExecuting(snapshot.id);
          if (cancelled || currentActivation.current !== activation) return;
          // Commit together after both reads. Restoring the task may rerender
          // Chat and clean up this effect; no async writes follow that commit.
          loadedActivation.current = activation;
          onRestore(snapshot, executing);
          setSettledActivation(activation);
        } else {
          loadedActivation.current = activation;
          if (task?.sessionId && task.sessionId !== sessionId) {
            const isSessionUpgrade =
              isPendingSessionId(task.sessionId) && !isPendingSessionId(targetSessionId);
            if (!isSessionUpgrade) onClear();
          }
          setSettledActivation(activation);
        }
      } catch (error) {
        if (!cancelled) console.error('[Chat] Failed to load cron task state:', error);
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [activation, sessionId, tabId, task, onRestore, onClear]);

  // Unsaved settings can be restored only after the existing Task projection
  // has settled. Failed/late reads do not authorize consuming a disk draft.
  return !isTauriEnvironment() || settledActivation === activation;
}
