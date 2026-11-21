// TaskCenter — single-instance tab combining Thought stream (left) and Task list (right).
// PRD §5 / §6.

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OverlayOwnerActiveContext } from '@/context/OverlayOwnerActiveContext';
import { ThoughtPanel } from '@/components/task-center/ThoughtPanel';
import { TaskListPanel } from '@/components/task-center/TaskListPanel';
import RecordingSourceDialog from '@/components/task-center/RecordingSourceDialog';
import { taskCenterAvailable } from '@/api/taskCenter';
import { speechModelPackStatus } from '@/api/recording';
import { track } from '@/analytics';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import { useConfig } from '@/hooks/useConfig';
import type { Thought } from '@/../shared/types/thought';
import type { TaskCreateRequest } from '@/../shared/taskDiscussion';
import type { PendingAppRoute } from '@/../shared/appRoute';
import type {
  RecordSummary,
  RecordingSnapshot,
  RecordingSourceSelection,
} from '@/../shared/types/record';

interface Props {
  isActive?: boolean;
  /** Canonical Session id of the Chat tab from which Task Center was opened. */
  currentSessionId?: string | null;
  /** Most recent OPEN_TASK_CENTER event payload. Forwarded to `TaskListPanel`
   *  so navigation with `{ autofocusSearch: true }` can open the task-list
   *  search input without the user touching the UI a second time. `nonce`
   *  forces the consumer's effect to re-fire when the same intent is sent
   *  back-to-back (e.g. user clicking the Launcher search icon twice). */
  pendingIntent?: {
    autofocusSearch?: boolean;
    nonce: number;
    consumed?: boolean;
  } | null;
  onSearchIntentConsumed?: (generation: number) => void;
  pendingRoute?: PendingAppRoute | null;
  onRouteConsumed?: (generation: number) => void;
  onOpenRecord?: (
    recordId: string,
    mediaMs?: number,
    activeRecording?: boolean,
  ) => void;
  activeRecordingSnapshot?: RecordingSnapshot | null;
  onStartRecording?: (selection: RecordingSourceSelection) => Promise<void>;
}

export default function TaskCenter({
  isActive,
  pendingIntent,
  onSearchIntentConsumed,
  currentSessionId,
  pendingRoute,
  onRouteConsumed,
  onOpenRecord,
  activeRecordingSnapshot,
  onStartRecording,
}: Props) {
  const { t } = useTranslation('task');
  const { config, updateConfig } = useConfig();
  const [recordingRequestBusy, setRecordingRequestBusy] = useState(false);
  const [recordingSourceDialog, setRecordingSourceDialog] = useState<{
    initialSelection: RecordingSourceSelection;
    modelPackUsable?: boolean;
    error?: string;
  } | null>(null);

  const handleOpenSpeechSettings = useCallback(() => {
    setRecordingSourceDialog(null);
    window.dispatchEvent(
      new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
        detail: {
          section: 'mcp',
          officialToolId: 'speech-recognition',
        },
      }),
    );
  }, []);

  const handleRequestRecording = useCallback(async () => {
    if (!onStartRecording) return;
    const initialSelection = config.recordingSourceSelection ?? {
      microphone: true,
      system: true,
    };
    setRecordingRequestBusy(true);
    if (config.recordingSourceSelection) {
      try {
        await onStartRecording(initialSelection);
      } catch (error) {
        setRecordingSourceDialog({
          initialSelection,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setRecordingRequestBusy(false);
      }
      return;
    }
    let modelPackUsable: boolean | undefined;
    try {
      modelPackUsable = (await speechModelPackStatus()).usable;
    } catch {
      // Resource status is advisory for start; capture remains available.
    }
    setRecordingSourceDialog({ initialSelection, modelPackUsable });
    setRecordingRequestBusy(false);
  }, [config.recordingSourceSelection, onStartRecording]);

  const handleRecordingSourceConfirm = useCallback(
    async (selection: RecordingSourceSelection) => {
      if (!onStartRecording || !recordingSourceDialog) return;
      setRecordingRequestBusy(true);
      try {
        await updateConfig({ recordingSourceSelection: selection });
        await onStartRecording(selection);
        setRecordingSourceDialog(null);
      } catch (error) {
        setRecordingSourceDialog({
          ...recordingSourceDialog,
          initialSelection: selection,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setRecordingRequestBusy(false);
      }
    },
    [onStartRecording, recordingSourceDialog, updateConfig],
  );

  // Child panels react to `isActive` transitions on their own (via refreshKey
  // derived from it below). We do NOT setState in an effect here — the lint
  // rule `react-hooks/set-state-in-effect` flags that. `isActive` itself is
  // passed down as the refresh signal.
  //
  // Tabs stay mounted with `content-visibility: hidden` when inactive, so
  // panels need to know "I just became active again" to reload. Passing
  // `isActive` straight through accomplishes that without a derived counter.

  const handleDispatch = useCallback(
    (t: Thought) => {
      const request: TaskCreateRequest = {
        initialMode: 'manual',
        source: 'thought',
        currentSessionId: currentSessionId ?? null,
        thought: { id: t.id, content: t.content, tags: t.tags },
      };
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CREATE, { detail: request }),
      );
    },
    [currentSessionId],
  );

  const handleDiscuss = useCallback((t: Thought, workspaceId: string) => {
    track('task_align_discuss', {});
    // Hand off to App.tsx which owns tab creation. The workspace was picked
    // explicitly via the card's workspace popover, so we carry its id through
    // the event; App.tsx uses it instead of running a smart-default guess.
    window.dispatchEvent(
      new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, {
        detail: {
          sourceRecordId: t.id,
          sourceRecordKind: 'text',
          content: t.content,
          workspaceId,
        },
      }),
    );
  }, []);

  const handleDiscussAudio = useCallback(
    (record: RecordSummary, workspaceId: string) => {
      track('task_align_discuss', {});
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, {
          detail: {
            sourceRecordId: record.id,
            sourceRecordKind: 'audio',
            workspaceId,
          },
        }),
      );
    },
    [],
  );

  const handleCreateTask = useCallback(() => {
    const request: TaskCreateRequest = {
      initialMode: 'smart',
      source: 'task-center',
      currentSessionId: currentSessionId ?? null,
    };
    window.dispatchEvent(
      new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CREATE, { detail: request }),
    );
  }, [currentSessionId]);

  // The DispatchTaskDialog returns the full Task, but for Phase 4 we only need
  // to know "something changed" to re-fetch both panels. Future Phase 5 hook:
  // pass the task down so the newly created one can be highlighted/scrolled to.

  if (!taskCenterAvailable()) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] px-8 text-center">
        <div className="max-w-md text-sm leading-relaxed text-[var(--ink-muted)]">
          <p className="font-medium text-[var(--ink-secondary)]">
            {t('center.title')}
          </p>
          <p className="mt-2">{t('center.desktopOnly')}</p>
          <p className="mt-2 text-[var(--ink-muted)]/70">
            {t('center.desktopUnavailable')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--paper)]">
      {recordingSourceDialog && (
        <RecordingSourceDialog
          mode="start"
          initialSelection={recordingSourceDialog.initialSelection}
          modelPackUsable={recordingSourceDialog.modelPackUsable}
          error={recordingSourceDialog.error}
          busy={recordingRequestBusy}
          onConfirm={handleRecordingSourceConfirm}
          onCancel={() => setRecordingSourceDialog(null)}
          onOpenSpeechSettings={handleOpenSpeechSettings}
        />
      )}
      {/* Page title — v0.1.69 polish:
            • breadcrumb "沉淀想法 › 派发任务 › 让 AI 执行" removed
              (it was scene-setting copy, redundant once the user is in
              the tab)
            • title bumped to 20px (type-scale §2.2 --text-xl) so it
              reads as the page heading it is, a tier above the 14px
              section headers inside the panels below
            • bottom border removed; vertical breathing room (pt/pb)
              replaces the hairline as the divider, continuing the
              "layout over rules" direction set in the review  */}
      <div className="flex shrink-0 items-center px-5 pt-5 pb-3">
        <h1 className="text-xl font-semibold text-[var(--ink)]">
          {t('center.title')}
        </h1>
      </div>

      {/* Two-column body — each panel renders its own section header
          (icon + label + collapsible 🔍 search toggle). */}
      <div className="flex min-w-0 flex-1 overflow-hidden">
        {/* Left: Thought stream */}
        <div className="flex w-[480px] min-w-0 max-w-full shrink-0 flex-col overflow-hidden">
          <ThoughtPanel
            onDispatchThought={handleDispatch}
            onDiscussThought={handleDiscuss}
            onDiscussAudioRecord={handleDiscussAudio}
            refreshKey={isActive ? '1' : '0'}
            // Suppress thought-input autofocus when the user arrived via
            // the Launcher 「我的任务」 search icon — in that flow the
            // caret belongs in the TaskListPanel search field, not the
            // ThoughtInput. Both would otherwise `requestAnimationFrame`
            // a focus call on the same tick, the right panel's effect
            // wins by render order but the user sees a momentary caret
            // flicker on the thought input. (v0.1.69 cross-review W4)
            autoFocusInput={!!isActive && !pendingIntent?.autofocusSearch}
            onOpenRecord={onOpenRecord}
            activeRecordingSnapshot={activeRecordingSnapshot}
            onStartRecording={
              onStartRecording ? handleRequestRecording : undefined
            }
            recordingBusy={recordingRequestBusy}
          />
        </div>

        {/* Divider — weaker line-subtle (6% ink) so the two panels feel
            like a continuous surface rather than two pages cut apart.
            A full --line (10%) reads heavier than the card borders, which
            made the split feel over-emphasized. */}
        <div className="w-px bg-[var(--line-subtle)]" />

        {/* Right: Task list */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <OverlayOwnerActiveContext.Provider value={isActive !== false}>
            <TaskListPanel
              refreshKey={isActive ? '1' : '0'}
              pendingIntent={pendingIntent ?? null}
              onSearchIntentConsumed={onSearchIntentConsumed}
              pendingRoute={pendingRoute ?? null}
              onRouteConsumed={onRouteConsumed}
              onCreateTask={handleCreateTask}
            />
          </OverlayOwnerActiveContext.Provider>
        </div>
      </div>
    </div>
  );
}
