// TaskDetailOverlay — modal covering Task Center with full details of one Task.
// PRD §7.3. Uses the shared OverlayBackdrop + closeLayer Cmd+W integration.

import { isImeComposingEvent } from '@/utils/imeKeyboard';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIcon,
  ArchiveIcon,
  BellIcon,
  HelperIcon,
  SuccessIcon,
  EditIcon,
  PlayIcon,
  UndoIcon,
  RadioIcon,
  SlidersIcon,
  StopIcon,
  TrashIcon,
  CloseIcon,
} from '@/components/icons';
import ConfirmDialog from "@/components/ConfirmDialog";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import {
  DropdownMenu,
  type DropdownMenuItem,
  type DropdownMenuSection,
} from "@/components/ui/DropdownMenu";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { useAgentStatuses } from "@/hooks/useAgentStatuses";
import { useConfig } from "@/hooks/useConfig";
import { useToast } from "@/components/Toast";
import { listenWithCleanup } from "@/utils/tauriListen";
import { workspacePathsEqual } from "@/../shared/workspacePath";
import {
  taskArchive,
  taskDelete,
  taskGet,
  taskGetRunStats,
  taskCheckNow,
  taskRerun,
  taskResetCheckpoint,
  taskRun,
  taskRunNow,
  taskTriggerTestTask,
  taskUpdateStatus,
} from "@/api/taskCenter";
import { patchAgentConfig } from "@/config/services/agentConfigService";
import type {
  Task,
  TaskRunStats,
  TaskTriggerTestResponse,
} from "@/../shared/types/task";
import { TaskStatusBadge } from "./TaskStatusBadge";
import { TaskSessionsList } from "./TaskSessionsList";
import { SummaryCard } from "./SummaryCard";
import { TaskDocBlock } from "./TaskDocBlock";
import { TaskCommentTimeline } from "./TaskCommentTimeline";
import { TaskEditPanel, type FocusDoc } from "./TaskEditPanel";
import { extractErrorMessage } from "./errors";
import { TriggerErrorDetails } from "./TriggerErrorDetails";
import PanelResizeHandle, { usePanelWidth, type PanelWidthConfig } from "@/components/PanelResizeHandle";

/** Esc-to-close for the overlay's preview mode. The edit panel handles its
 *  own Esc (with dirty-guard) via PanelChrome.usePanelKeys, so this wires
 *  itself off when `editing` is true to avoid two handlers firing on the
 *  same keypress. */
function useOverlayEsc(active: boolean, onEsc: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (isImeComposingEvent(e)) return;
      if (e.key !== "Escape") return;
      onEsc();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [active, onEsc]);
}

const OVERLAY_Z = 200;

interface Props {
  task: Task;
  /** When true, the overlay opens directly in edit mode — used by the
   *  card/row "编辑" menu item. */
  startEditing?: boolean;
  /** Deep links can open the drawer around one exact comment. */
  targetCommentId?: string | null;
  onTargetCommentReady?: (found: boolean) => void;
  onClose: () => void;
  onChanged?: (next: Task | null) => void;
}

const PROPERTIES_WIDTH: PanelWidthConfig = {
  storageKey: "myagents.taskDetail.propertiesWidth.v1",
  defaultWidth: 380,
  minWidth: 300,
  maxWidth: 640,
};

export function TaskDetailOverlay({
  task: initial,
  startEditing = false,
  targetCommentId = null,
  onTargetCommentReady,
  onClose,
  onChanged,
}: Props) {
  const { t } = useTranslation("task");
  const propertiesWidth = usePanelWidth(PROPERTIES_WIDTH);
  const [task, setTask] = useState<Task>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(startEditing);
  const [showMobileProperties, setShowMobileProperties] = useState(false);
  // When edit mode opens via an inline "编辑" button on a specific doc
  // (task.md / verify.md) or on the notification section, the edit
  // panel needs to scroll/focus to that target. `null` = top of panel.
  const [focusDoc, setFocusDoc] = useState<FocusDoc | null>(null);
  const [runStats, setRunStats] = useState<TaskRunStats | null>(null);
  const [showSyncConfirm, setShowSyncConfirm] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showResetCheckpointConfirm, setShowResetCheckpointConfirm] =
    useState(false);
  const [triggerAction, setTriggerAction] = useState<
    "test" | "check" | "run" | "reset" | null
  >(null);
  const [triggerTestResult, setTriggerTestResult] =
    useState<TaskTriggerTestResponse | null>(null);
  // Bumped on every external task change so child blocks (TaskDocBlock) can
  // reload their document contents without us having to lift the content up.
  const [reloadToken, setReloadToken] = useState(0);

  const toast = useToast();
  const { config, projects } = useConfig();
  const workspace = useMemo(
    () =>
      projects.find((x) =>
        workspacePathsEqual(x.path, task.workspacePath),
      ) ?? null,
    [projects, task.workspacePath],
  );
  const agentId = workspace?.agentId ?? null;
  const agentLabel = useMemo(() => {
    if (!agentId) return workspace?.displayName ?? workspace?.name ?? null;
    return (
      config.agents?.find((agent) => agent.id === agentId)?.name ??
      workspace?.displayName ??
      workspace?.name ??
      null
    );
  }, [agentId, config.agents, workspace?.displayName, workspace?.name]);

  // Guard every async setState call so a late-returning sync / refetch
  // can't hit an already-unmounted overlay. The toast / onChanged callback
  // paths are fine (they're called by the parent or the toast portal),
  // but local setBusy / setSyncing / setTask need protection.
  const isMountedRef = useRef(true);
  const taskFetchGenerationRef = useRef(0);
  const triggerActionGenerationRef = useRef(0);
  const deleteGenerationRef = useRef(0);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchLatestTask = useCallback(async () => {
    const generation = ++taskFetchGenerationRef.current;
    const fresh = await taskGet(task.id);
    if (
      !fresh ||
      !isMountedRef.current ||
      generation !== taskFetchGenerationRef.current
    ) {
      return null;
    }
    setTask(fresh);
    return fresh;
  }, [task.id]);

  useCloseLayer(() => {
    onClose();
    return true;
  }, OVERLAY_Z);

  // Esc closes the overlay in preview mode. In edit mode, TaskEditPanel
  // owns Esc so it can run its dirty-guard before unwinding to preview;
  // we deactivate the overlay-level Esc to keep them from competing.
  useOverlayEsc(!editing, onClose);

  // Load run stats alongside the fresh task — re-fired on reloadToken so
  // external transitions (scheduler tick) re-aggregate executionCount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stats = await taskGetRunStats(task.id);
        if (!cancelled) setRunStats(stats);
      } catch {
        /* silent — stats are best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task.id, reloadToken]);

  // Sync per-task execution overrides back to the owning Agent's default
  // config. Mirrors CronTaskDetailPanel.handleSyncToAgent, but scoped to
  // `task.model` / `task.permissionMode` rather than a session snapshot
  // (Task Center does not carry a session-level snapshot).
  //
  // Button is hidden when there's nothing meaningful to sync: auto is the
  // Agent default, so `permissionMode === 'auto'` with no model override
  // produces a no-op patch that only confuses the user.
  const hasMeaningfulOverride =
    !!task.model || (!!task.permissionMode && task.permissionMode !== "auto");
  const canSyncToAgent = !!agentId && hasMeaningfulOverride;
  const isDangerousSync = task.permissionMode === "fullAgency";

  const doSyncToAgent = useCallback(async () => {
    if (!agentId) return;
    setSyncing(true);
    try {
      const patch: { model?: string; permissionMode?: string } = {};
      if (task.model) patch.model = task.model;
      if (task.permissionMode) patch.permissionMode = task.permissionMode;
      await patchAgentConfig(agentId, patch);
      if (!isMountedRef.current) return;
      toast.success(t("detail.syncSuccess"));
      setShowSyncConfirm(false);
    } catch (e) {
      if (!isMountedRef.current) return;
      toast.error(t("detail.syncFailed", { message: extractErrorMessage(e) }));
    } finally {
      if (isMountedRef.current) setSyncing(false);
    }
  }, [agentId, task.model, task.permissionMode, toast, t]);

  // Refetch on mount so we show the latest statusHistory (in case UI was out of sync).
  useEffect(() => {
    void (async () => {
      try {
        await fetchLatestTask();
      } catch {
        /* silent — use `initial` */
      }
    })();
  }, [fetchLatestTask]);

  // Live-update on external transitions (CLI / scheduler / other window).
  // Listen to both `task:status-changed` (state transitions) and
  // `task:session-appended` (new runs linked to this task) — the latter is
  // critical for the "任务执行" section to show runs that fire while the
  // overlay is open.
  useEffect(() => {
    const ac = new AbortController();
    const reloadIfMatches = async (taskId: string | undefined) => {
      if (ac.signal.aborted || !isMountedRef.current) return;
      if (taskId !== task.id) return;
      try {
        const fresh = await fetchLatestTask();
        if (ac.signal.aborted || !isMountedRef.current) return;
        if (fresh) {
          setReloadToken((n) => n + 1);
        }
      } catch {
        /* silent */
      }
    };
    for (const evt of [
      "task:status-changed",
      "task:session-appended",
      "task:session-rebound",
      "task:trigger-checked",
      "task:trigger-error",
      "task:execution-complete",
      "cron:execution-state-changed",
    ]) {
      void listenWithCleanup<{ taskId?: string }>(
        evt,
        (e) => {
          void reloadIfMatches(e.payload?.taskId);
        },
        ac.signal,
      );
    }
    return () => ac.abort();
  }, [fetchLatestTask, task.id]);

  const runStatus = useCallback(
    async (next: Task["status"]) => {
      setBusy(true);
      setErr(null);
      try {
        const updated = await taskUpdateStatus({ id: task.id, status: next });
        if (!isMountedRef.current) return;
        setTask(updated);
        onChanged?.(updated);
      } catch (e) {
        if (!isMountedRef.current) return;
        setErr(extractErrorMessage(e));
      } finally {
        if (isMountedRef.current) setBusy(false);
      }
    },
    [task.id, onChanged],
  );

  const dispatchRun = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      await taskRun(task.id);
      // The Rust endpoint transitions us to `running` via update_status; our
      // SSE listener upstairs handles the refresh, but also refetch here so
      // the overlay updates instantly.
      const fresh = await fetchLatestTask();
      if (fresh) {
        onChanged?.(fresh);
      }
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [task.id, onChanged, fetchLatestTask]);

  const dispatchRerun = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      await taskRerun(task.id);
      const fresh = await fetchLatestTask();
      if (fresh) {
        onChanged?.(fresh);
      }
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [task.id, onChanged, fetchLatestTask]);

  const doArchive = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const updated = await taskArchive(task.id);
      setTask(updated);
      onChanged?.(updated);
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [task.id, onChanged]);

  const runTriggerAction = useCallback(
    async (action: "test" | "check" | "run" | "reset") => {
      if (triggerAction) return;
      const generation = ++triggerActionGenerationRef.current;
      setTriggerAction(action);
      setErr(null);
      if (action !== "test") setTriggerTestResult(null);
      try {
        if (action === "test") {
          const result = await taskTriggerTestTask(task.id);
          if (
            isMountedRef.current &&
            generation === triggerActionGenerationRef.current
          ) {
            setTriggerTestResult(result);
          }
        } else if (action === "check") {
          const result = await taskCheckNow(task.id);
          if (
            !isMountedRef.current ||
            generation !== triggerActionGenerationRef.current
          )
            return;
          if (result.outcome === "error") {
            setErr(result.state.lastError?.message ?? t("common.unknownError"));
          }
        } else if (action === "run") {
          await taskRunNow(task.id);
          if (
            !isMountedRef.current ||
            generation !== triggerActionGenerationRef.current
          )
            return;
        } else {
          await taskResetCheckpoint(task.id);
          if (
            !isMountedRef.current ||
            generation !== triggerActionGenerationRef.current
          )
            return;
          setShowResetCheckpointConfirm(false);
        }
        if (action !== "test") {
          if (
            !isMountedRef.current ||
            generation !== triggerActionGenerationRef.current
          )
            return;
          const fresh = await fetchLatestTask();
          if (
            fresh &&
            isMountedRef.current &&
            generation === triggerActionGenerationRef.current
          ) {
            onChanged?.(fresh);
            setReloadToken((value) => value + 1);
          }
        }
      } catch (error) {
        if (
          isMountedRef.current &&
          generation === triggerActionGenerationRef.current
        ) {
          setErr(extractErrorMessage(error));
        }
      } finally {
        if (
          isMountedRef.current &&
          generation === triggerActionGenerationRef.current
        ) {
          setTriggerAction(null);
        }
      }
    },
    [fetchLatestTask, onChanged, task.id, t, triggerAction],
  );

  // OverflowMenu's 删除 entry opens a <ConfirmDialog> (matching the
  // sync-to-agent flow); `doDelete` is the confirmed path. Replaces the
  // prior `window.confirm` which rendered as an OS-native modal that
  // bypassed the overlay's Cmd+W closeLayer stack and ignored the
  // app's design tokens.
  const doDelete = useCallback(async () => {
    const generation = ++deleteGenerationRef.current;
    setBusy(true);
    setErr(null);
    try {
      await taskDelete(task.id);
      if (!isMountedRef.current || generation !== deleteGenerationRef.current)
        return;
      setShowDeleteConfirm(false);
      onChanged?.(null);
      onClose();
    } catch (e) {
      if (!isMountedRef.current || generation !== deleteGenerationRef.current)
        return;
      setErr(extractErrorMessage(e));
      setBusy(false);
    }
  }, [task.id, onChanged, onClose]);

  const locked =
    task.status === "running" ||
    task.status === "verifying" ||
    !!task.executionState;

  const enterEdit = useCallback(
    (target: FocusDoc | null = null) => {
      if (locked) return;
      setErr(null);
      setFocusDoc(target);
      setEditing(true);
    },
    [locked],
  );

  const onEditSaved = useCallback(
    (next: Task) => {
      setTask(next);
      onChanged?.(next);
      setEditing(false);
      setFocusDoc(null);
      // Docs don't move here, but bump so dependent blocks re-render cleanly.
      setReloadToken((n) => n + 1);
    },
    [onChanged],
  );

  const onEditCancel = useCallback(() => {
    setEditing(false);
    setFocusDoc(null);
  }, []);

  return (
    <>
      {showSyncConfirm && (
        <ConfirmDialog
          title={
            isDangerousSync
              ? t("detail.syncDangerTitle")
              : t("detail.syncTitle")
          }
          message={
            isDangerousSync
              ? t("detail.syncDangerMessage")
              : t("detail.syncMessage")
          }
          confirmText={
            isDangerousSync
              ? t("detail.syncDangerConfirm")
              : t("detail.syncConfirm")
          }
          cancelText={t("common.cancel")}
          confirmVariant={isDangerousSync ? "danger" : undefined}
          loading={syncing}
          onConfirm={() => void doSyncToAgent()}
          onCancel={() => setShowSyncConfirm(false)}
        />
      )}
      {showDeleteConfirm && (
        <ConfirmDialog
          title={t("detail.deleteTitle")}
          message={t("detail.deleteMessage", { name: task.name })}
          confirmText={t("common.delete")}
          cancelText={t("common.cancel")}
          confirmVariant="danger"
          loading={busy}
          onConfirm={() => void doDelete()}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
      {showResetCheckpointConfirm && (
        <ConfirmDialog
          title={t("trigger.resetTitle")}
          message={t("trigger.resetMessage")}
          confirmText={t("trigger.resetConfirm")}
          cancelText={t("common.cancel")}
          loading={triggerAction === "reset"}
          onConfirm={() => void runTriggerAction("reset")}
          onCancel={() => setShowResetCheckpointConfirm(false)}
        />
      )}
      <OverlayBackdrop
        onClose={editing ? undefined : onClose}
        className="z-[200] items-stretch justify-end bg-black/20"
        portal
      >
        <aside
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
          className="relative flex h-full w-[82vw] max-w-[1440px] flex-col overflow-hidden border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-2xl max-lg:w-[92vw] max-sm:w-full"
          aria-label={t("detail.drawerLabel")}
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-6 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <TaskStatusBadge
                status={task.status}
                executionState={task.executionState}
              />
              <h2
                className="min-w-0 flex-1 truncate text-lg font-semibold leading-7 text-[var(--ink)]"
                title={task.name}
              >
                {task.name}
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setShowMobileProperties((value) => !value)}
              className="shrink-0 rounded-[var(--radius-md)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] xl:hidden"
              title={t("detail.properties")}
              aria-label={t("detail.properties")}
            >
              <SlidersIcon className="h-4 w-4" />
            </button>
            {task.status === "todo" && (
              <ActionBtn
                icon={<PlayIcon className="h-3.5 w-3.5" />}
                label={t("detail.runNow")}
                disabled={busy}
                onClick={dispatchRun}
              />
            )}
            {(task.status === "running" ||
              task.status === "verifying" ||
              task.executionState === "running" ||
              task.executionState === "checking" ||
              task.executionState === "stop_failed") &&
              task.executionState !== "stopping" && (
                <ActionBtn
                  icon={<StopIcon className="h-3.5 w-3.5" />}
                  label={
                    task.executionState === "stop_failed"
                      ? t("detail.retryStop")
                      : t("detail.stop")
                  }
                  variant="danger"
                  disabled={busy}
                  onClick={() => runStatus("stopped")}
                />
              )}
            {(task.status === "blocked" ||
              task.status === "stopped" ||
              task.status === "done" ||
              task.status === "archived") &&
              task.dispatchOrigin !== "attached-session" &&
              !task.executionState && (
                <ActionBtn
                  icon={<UndoIcon className="h-3.5 w-3.5" />}
                  label={t("detail.rerun")}
                  disabled={busy}
                  onClick={dispatchRerun}
                  title="reset → todo → run (PRD §10.2.2)"
                />
              )}
            <OverflowMenu
              status={task.status}
              busy={busy}
              locked={locked}
              syncing={syncing}
              canSyncToAgent={canSyncToAgent}
              onEdit={() => enterEdit(null)}
              onMarkDone={() => runStatus("done")}
              onArchive={doArchive}
              onSyncToAgent={() => setShowSyncConfirm(true)}
              onDelete={
                task.executionState
                  ? undefined
                  : () => setShowDeleteConfirm(true)
              }
            />
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-[var(--radius-md)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              title={t("detail.closeTitle")}
              aria-label={t("detail.closeTitle")}
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </header>

          {err && (
            <div className="shrink-0 border-b border-[var(--error)]/30 bg-[var(--error-bg)] px-7 py-2 text-xs text-[var(--error)]">
              {err}
            </div>
          )}

          <div className="relative flex min-h-0 flex-1">
            <main className="flex min-w-0 flex-1 overflow-hidden">
              <TaskCommentTimeline
                task={task}
                targetCommentId={targetCommentId}
                onTargetReady={onTargetCommentReady}
                agentLabel={agentLabel}
                onBeforeOpenSession={onClose}
              >
                {task.externalSource?.type === "space-issue" && (
                  <div className="mb-2">
                    <span className="inline-flex rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                      Space Issue · {task.externalSource.issueId}
                    </span>
                  </div>
                )}
                {task.description && (
                  <p className="mb-4 max-w-[80ch] text-sm leading-6 text-[var(--ink-muted)]">
                    {task.description}
                  </p>
                )}
                <TaskDocBlock
                  task={task}
                  doc="task"
                  emptyHint={t("detail.taskDocEmpty")}
                  collapsible={false}
                  reloadKey={reloadToken}
                  onError={setErr}
                />
              </TaskCommentTimeline>
            </main>

            <div
              className="relative hidden shrink-0 xl:block"
              style={{ width: propertiesWidth.width }}
            >
            <PanelResizeHandle
              config={PROPERTIES_WIDTH}
              width={propertiesWidth.width}
              edge="left"
              label={t("detail.resizeProperties")}
              onPreview={propertiesWidth.setWidth}
              onCommit={propertiesWidth.commit}
            />
            <aside className="h-full overflow-y-auto border-l border-[var(--line-subtle)] bg-[var(--paper)]/60 px-5 py-5">
              <SummaryCard task={task} stats={runStats} />
              <div className="mt-5">
                <TaskSessionsList task={task} onBeforeOpen={onClose} />
              </div>
              {task.trigger?.detector.type === "command" && (
                <TriggerRuntimeSection
                  task={task}
                  action={triggerAction}
                  testResult={triggerTestResult}
                  onTest={() => void runTriggerAction("test")}
                  onCheck={() => void runTriggerAction("check")}
                  onRun={() => void runTriggerAction("run")}
                  onReset={() => setShowResetCheckpointConfirm(true)}
                />
              )}
              <hr className="my-5 border-[var(--line-subtle)]" />
              <NotificationSummary task={task} />
            </aside>
            </div>

            {showMobileProperties && (
              <aside className="absolute inset-y-0 right-0 z-20 w-[min(380px,88vw)] overflow-y-auto border-l border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-5 shadow-xl xl:hidden">
                <div className="mb-5 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-[var(--ink)]">
                    {t("detail.properties")}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setShowMobileProperties(false)}
                    aria-label={t("common.close")}
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                </div>
                <SummaryCard task={task} stats={runStats} />
                <div className="mt-5">
                  <TaskSessionsList task={task} onBeforeOpen={onClose} />
                </div>
                {task.trigger?.detector.type === "command" && (
                  <TriggerRuntimeSection
                    task={task}
                    action={triggerAction}
                    testResult={triggerTestResult}
                    onTest={() => void runTriggerAction("test")}
                    onCheck={() => void runTriggerAction("check")}
                    onRun={() => void runTriggerAction("run")}
                    onReset={() => setShowResetCheckpointConfirm(true)}
                  />
                )}
                <hr className="my-5 border-[var(--line-subtle)]" />
                <NotificationSummary task={task} />
              </aside>
            )}
          </div>

          {editing && (
            <div className="absolute inset-0 z-30 flex justify-end bg-black/20 backdrop-blur-[1px]">
              <section
                role="dialog"
                aria-modal="true"
                aria-label={t("detail.edit")}
                className="flex h-full w-[min(780px,92vw)] flex-col overflow-hidden border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-2xl"
              >
                <TaskEditPanel
                  task={task}
                  focusDoc={focusDoc}
                  onSaved={onEditSaved}
                  onCancel={onEditCancel}
                  onError={setErr}
                />
              </section>
            </div>
          )}
        </aside>
      </OverlayBackdrop>
    </>
  );
}

/** OverflowMenu — "⋯" button with all secondary actions (编辑、标记完成,
 *  归档, 同步到 Agent, 删除). Wraps the shared `DropdownMenu` primitive
 *  with task-specific section layout: secondary actions first, delete
 *  separated in its own danger group. */
function OverflowMenu({
  status,
  busy,
  locked,
  syncing,
  canSyncToAgent,
  onEdit,
  onMarkDone,
  onArchive,
  onSyncToAgent,
  onDelete,
}: {
  status: Task["status"];
  busy: boolean;
  locked: boolean;
  syncing: boolean;
  canSyncToAgent: boolean;
  onEdit: () => void;
  onMarkDone: () => void;
  onArchive: () => void;
  onSyncToAgent: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation("task");
  const canMarkDone = status === "verifying";
  const canArchive = status === "done";

  const secondary: DropdownMenuItem[] = [
    {
      icon: <EditIcon className="h-3.5 w-3.5" />,
      label: t("detail.edit"),
      onClick: onEdit,
      disabled: locked,
      title: locked ? t("detail.editLockedTitle") : undefined,
    },
  ];
  if (canMarkDone) {
    secondary.push({
      icon: <SuccessIcon className="h-3.5 w-3.5" />,
      label: t("detail.markDone"),
      onClick: onMarkDone,
    });
  }
  if (canArchive) {
    secondary.push({
      icon: <ArchiveIcon className="h-3.5 w-3.5" />,
      label: t("detail.archive"),
      onClick: onArchive,
    });
  }
  if (canSyncToAgent) {
    secondary.push({
      icon: <HelperIcon className="h-3.5 w-3.5" />,
      label: syncing ? t("detail.syncing") : t("detail.syncToAgent"),
      title: t("detail.syncToAgentTitle"),
      onClick: onSyncToAgent,
      disabled: syncing,
    });
  }

  const destructive: DropdownMenuItem[] = onDelete
    ? [
        {
          icon: <TrashIcon className="h-3.5 w-3.5" />,
          label: t("common.delete"),
          onClick: onDelete,
          danger: true,
        },
      ]
    : [];
  const sections: DropdownMenuSection[] = [
    { items: secondary },
    { items: destructive },
  ];

  return (
    <DropdownMenu
      sections={sections}
      size="md"
      disabled={busy}
      minWidth={160}
      zIndex={OVERLAY_Z + 1}
    />
  );
}

export function TriggerRuntimeSection({
  task,
  action,
  testResult,
  onTest,
  onCheck,
  onRun,
  onReset,
}: {
  task: Task;
  action: "test" | "check" | "run" | "reset" | null;
  testResult: TaskTriggerTestResponse | null;
  onTest: () => void;
  onCheck: () => void;
  onRun: () => void;
  onReset: () => void;
}) {
  const { t, i18n } = useTranslation("task");
  const [now, setNow] = useState(() => Date.now());
  const detector = task.trigger?.detector;
  const backoffUntil = task.triggerState?.backoffUntil;
  useEffect(() => {
    if (!backoffUntil || backoffUntil <= now) return;
    const delay = Math.min(backoffUntil - now + 1, 60_000);
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [backoffUntil, now]);
  if (!detector || detector.type !== "command") return null;
  const state = task.triggerState;
  const health =
    task.executionState === "checking"
      ? "checking"
      : state?.pendingActivation
        ? "pending"
        : task.executionState === "running"
          ? "running"
          : state?.backoffUntil && state.backoffUntil > now
            ? "backoff"
            : state?.lastError
              ? "error"
              : task.status === "stopped"
                ? "paused"
                : "waiting";
  const formatTime = (value: number | undefined) =>
    value
      ? new Intl.DateTimeFormat(i18n.language, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(value)
      : t("trigger.never");
  const checkpoint = JSON.stringify(state?.checkpoint ?? null, null, 2);
  const anyBusy = action !== null || !!task.executionState;

  return (
    <section
      className="mt-5 border-t border-[var(--line-subtle)] pt-5"
      data-testid="trigger-runtime-section"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
            <RadioIcon className="h-4 w-4" />
            {t("trigger.runtimeTitle")}
            <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
              {t(`trigger.health.${health}`)}
            </span>
          </div>
          <p className="mt-1.5 max-w-[65ch] text-xs leading-relaxed text-[var(--ink-muted)]">
            {t("trigger.runtimeDescription")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <ActionBtn
            icon={
              <ActivityIcon
                className={
                  action === "test"
                    ? "h-3.5 w-3.5 animate-pulse"
                    : "h-3.5 w-3.5"
                }
              />
            }
            label={action === "test" ? t("trigger.testing") : t("trigger.test")}
            disabled={anyBusy}
            onClick={onTest}
          />
          <ActionBtn
            icon={
              <RadioIcon
                className={
                  action === "check"
                    ? "h-3.5 w-3.5 animate-pulse"
                    : "h-3.5 w-3.5"
                }
              />
            }
            label={t("trigger.checkNow")}
            disabled={
              anyBusy ||
              !!state?.pendingActivation ||
              !["running", "stopped", "blocked"].includes(task.status)
            }
            onClick={onCheck}
          />
          <ActionBtn
            icon={<PlayIcon className="h-3.5 w-3.5" />}
            label={t("trigger.runNow")}
            disabled={
              anyBusy ||
              !!state?.pendingActivation ||
              !["running", "stopped"].includes(task.status)
            }
            onClick={onRun}
          />
          <ActionBtn
            icon={<UndoIcon className="h-3.5 w-3.5" />}
            label={t("trigger.reset")}
            disabled={anyBusy || !!state?.pendingActivation}
            onClick={onReset}
          />
        </div>
      </div>

      <p className="mt-3 rounded-md bg-[var(--paper-inset)] px-3 py-2 text-xs leading-relaxed text-[var(--ink-muted)]">
        {t("trigger.testWarning")}
      </p>

      {testResult && (
        <div
          className={`mt-3 rounded-md border px-3 py-2 text-xs ${
            testResult.ok
              ? "border-[var(--line-subtle)] text-[var(--ink-secondary)]"
              : "border-[var(--error)]/30 bg-[var(--error-bg)] text-[var(--error)]"
          }`}
        >
          {testResult.ok ? (
            <>
              <p className="font-medium">
                {t(`trigger.decision.${testResult.result.decision}`)} ·{" "}
                {testResult.result.reason.message}
              </p>
              {testResult.result.handoff?.summary && (
                <p className="mt-1">{testResult.result.handoff.summary}</p>
              )}
            </>
          ) : (
            <TriggerErrorDetails error={testResult.failure.error} />
          )}
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-xs md:grid-cols-4">
        <TriggerMetric
          label={t("trigger.lastChecked")}
          value={formatTime(state?.lastCheckedAt)}
        />
        <TriggerMetric
          label={t("trigger.lastOutcome")}
          value={
            state?.lastOutcome
              ? t(`trigger.outcome.${state.lastOutcome}`)
              : t("trigger.never")
          }
        />
        <TriggerMetric
          label={t("trigger.checkCount")}
          value={String(state?.checkCount ?? 0)}
          mono
        />
        <TriggerMetric
          label={t("trigger.executionCount")}
          value={String(task.executionCount ?? 0)}
          mono
        />
        <TriggerMetric
          label={t("trigger.lastActivated")}
          value={formatTime(state?.lastActivatedAt)}
        />
        <TriggerMetric
          label={t("trigger.failures")}
          value={String(state?.consecutiveFailures ?? 0)}
          mono
        />
        <TriggerMetric
          label={t("trigger.checkpointRevision")}
          value={String(state?.checkpointRevision ?? 0)}
          mono
        />
        <TriggerMetric
          label={t("trigger.checkpointUpdated")}
          value={formatTime(state?.checkpointUpdatedAt)}
        />
      </dl>

      {state?.lastReason && (
        <p className="mt-4 text-xs text-[var(--ink-secondary)]">
          <span className="font-mono text-[var(--ink-muted)]">
            {state.lastReason.code}
          </span>
          {" · "}
          {state.lastReason.message}
        </p>
      )}
      {state?.lastError && (
        <div className="mt-3 rounded-md border border-[var(--error)]/30 bg-[var(--error-bg)] px-3 py-2 text-xs text-[var(--error)]">
          <TriggerErrorDetails error={state.lastError} />
        </div>
      )}
      {state?.pendingActivation && (
        <div className="mt-3 border-l-2 border-[var(--accent)] pl-3 text-xs text-[var(--ink-secondary)]">
          <p className="font-medium">{t("trigger.pendingTitle")}</p>
          <p className="mt-1 font-mono break-all">
            {state.pendingActivation.event.id} ·{" "}
            {state.pendingActivation.event.kind}
          </p>
          <p className="mt-1 text-[var(--ink-muted)]">
            {formatTime(state.pendingActivation.detectedAt)} ·{" "}
            {state.pendingActivation.deliveryState}
            {state.pendingActivation.queueId
              ? ` · ${state.pendingActivation.queueId}`
              : ""}
          </p>
        </div>
      )}

      <details className="mt-4 text-xs">
        <summary className="cursor-pointer font-medium text-[var(--ink-muted)]">
          {t("trigger.configuration")}
        </summary>
        <dl className="mt-3 grid gap-2 text-[var(--ink-secondary)]">
          <TriggerMetric
            label={t("trigger.executable")}
            value={detector.command.executable}
            mono
          />
          <TriggerMetric
            label={t("trigger.args")}
            value={JSON.stringify(detector.command.args)}
            mono
          />
          <TriggerMetric
            label={t("trigger.cwd")}
            value={detector.command.cwd ?? task.workspacePath ?? ""}
            mono
          />
          <TriggerMetric
            label={t("trigger.timeout")}
            value={`${detector.timeoutMs ?? 30_000} ms`}
            mono
          />
        </dl>
        <p className="mt-3 font-medium text-[var(--ink-muted)]">
          {t("trigger.checkpointPreview")}
        </p>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--paper-inset)] p-3 font-mono text-[var(--ink-secondary)]">
          {checkpoint}
        </pre>
      </details>
    </section>
  );
}

function TriggerMetric({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[var(--ink-muted)]">{label}</dt>
      <dd
        className={`mt-0.5 break-words text-[var(--ink-secondary)] ${mono ? "font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

/** NotificationSummary — read-only one-liner ("桌面 ✓ · 飞书·公司群").
 *  v0.1.69 preview polish: no inline edit button — the overlay's
 *  top-level "编辑" is the only edit entry across the whole preview. */
function NotificationSummary({ task }: { task: Task }) {
  const { t } = useTranslation("task");
  const { statuses } = useAgentStatuses();
  const cfg = task.notification;
  const desktop = cfg?.desktop !== false;
  const botChannelId = cfg?.botChannelId ?? null;
  const channelLabel = useMemo(() => {
    if (!botChannelId) return null;
    for (const agent of Object.values(statuses)) {
      for (const ch of agent.channels) {
        if (ch.channelId === botChannelId) {
          return `${agent.agentName} · ${ch.name ?? ch.channelType}`;
        }
      }
    }
    return t("detail.unknownChannel", { id: botChannelId });
  }, [botChannelId, statuses, t]);

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-[var(--ink)]">
        <BellIcon className="h-3.5 w-3.5" />
        {t("detail.notification")}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span
          className={desktop ? "text-[var(--ink)]" : "text-[var(--ink-muted)]"}
        >
          {t("detail.desktopNotification")}{" "}
          {desktop
            ? `✓ ${t("detail.desktopOn")}`
            : `✗ ${t("detail.desktopOff")}`}
        </span>
        {channelLabel ? (
          <span className="text-[var(--ink)]">IM Bot: {channelLabel}</span>
        ) : (
          <span className="text-[var(--ink-muted)]/70">
            {t("detail.noBot")}
          </span>
        )}
      </div>
    </div>
  );
}

interface ActionBtnProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  variant?: "default" | "danger";
}

function ActionBtn({
  icon,
  label,
  onClick,
  disabled,
  title,
  variant,
}: ActionBtnProps) {
  // Disabled state uses `ink-subtle` (a lighter fade) + explicit hover
  // overrides so CSS `:hover` doesn't still tint the button orange/red —
  // prior `disabled:opacity-50` alone kept the ink-muted tone close enough
  // to the active state that users read it as clickable (PRD §9.4 "锁定
  // 态视觉" feedback; without the override the hover background still
  // flashed on mouse-over).
  const base =
    "flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:text-[var(--ink-subtle)] disabled:hover:bg-transparent";
  const variantCls =
    variant === "danger"
      ? "text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)] disabled:hover:text-[var(--ink-subtle)]"
      : "text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:hover:text-[var(--ink-subtle)]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${variantCls}`}
    >
      {icon}
      {label}
    </button>
  );
}

export default TaskDetailOverlay;
