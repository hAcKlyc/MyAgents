// TaskEditPanel — edit mode for a Task. Rendered inside `TaskDetailOverlay`
// when the user clicks the 「编辑」 affordance. Shares its scheduling and
// end-condition editors AND its panel chrome (FormSection / PanelFooter /
// SECTION_GAP) with the dispatch dialog so creation and subsequent edits
// stay pixel-aligned (PRD §7.3 — "create → edit is one continuous lifecycle").
//
// Document model: task.md is the single editable task contract. Legacy
// verify/progress/alignment files remain available from the read-only detail
// surface, but new edits do not sustain a parallel document protocol.
//
// All field mutations flow into a local `draft` state; the save handler diffs
// against the initial Task and sends only the changed fields through
// `cmd_task_update` (PRD §9.4 — schedule-shape changes also detach the
// live Task scheduler, handled in Rust). Cancel discards the draft and rolls
// back to read-only view; if the draft is dirty, a ConfirmDialog gates the
// discard so accidental Esc / 取消 doesn't lose work.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIcon,
  BellIcon,
  HelperIcon,
  ClockIcon,
  DocumentIcon,
  FolderOpenIcon,
  SlidersIcon,
} from '@/components/icons';

import {
  taskOpenDocsDir,
  taskReadDoc,
  taskUpdate,
} from '@/api/taskCenter';
import ConfirmDialog from '@/components/ConfirmDialog';
import NotificationConfigEditor from '@/components/task-center/NotificationConfigEditor';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { useToast } from '@/components/Toast';
import { isProjectActiveForUser } from '@/config/types';
import { useConfig } from '@/hooks/useConfig';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useTaskCenterData } from '@/hooks/useTaskCenterData';
import CustomSelect from '@/components/CustomSelect';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import type {
  EndConditions,
  NotificationConfig,
  Task,
  TaskExecutionMode,
  TaskRunMode,
  TaskTrigger,
  TaskUpdateInput,
} from '@/../shared/types/task';
import { APP_DATA_DIR_NAME } from '../../../shared/appProfile';
import {
  EndConditionsEditor,
  type EndConditionMode,
} from './editors/EndConditionsEditor';
import { ExecutionModeEditor } from './editors/ExecutionModeEditor';
import { INPUT_CLS, toLocalDateTimeString } from './editors/controls';
import { TaskAdvancedConfigEditor } from './editors/TaskAdvancedConfigEditor';
import { TriggerEditor } from './editors/TriggerEditor';
import { projectTaskExecutionOverrides } from './taskProviderProjection';
import {
  FormSection,
  PanelFooter,
  SECTION_DIVIDER,
  SECTION_GAP,
  usePanelKeys,
} from './editors/PanelChrome';
import type { RuntimeConfig, RuntimeType } from '@/../shared/types/runtime';
import { extractErrorMessage } from './errors';

/** Which section/field the edit panel should scroll to + focus on open.
 *  Exported so callers (e.g. TaskDetailOverlay's inline "编辑" buttons)
 *  can pass a specific target without magic strings. `null` / undefined
 *  = open at the top (basic-info section).
 */
export type FocusDoc = 'task' | 'notification';

export interface TaskEditPanelProps {
  task: Task;
  /** If set, the panel scroll-focuses this section on mount. */
  focusDoc?: FocusDoc | null;
  onSaved: (next: Task) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}

interface Draft {
  name: string;
  workspaceId: string;
  workspacePath: string;
  taskMd: string;
  executionMode: TaskExecutionMode;
  runMode: TaskRunMode;
  preselectedSessionId: string;
  trigger: TaskTrigger;
  atDateTime: string;
  intervalMinutes: number;
  cronExpression: string;
  cronTimezone: string;
  endConditionMode: EndConditionMode;
  deadline: string;
  maxExecutions: string;
  aiCanExit: boolean;
  notification: NotificationConfig;
  // Advanced overrides — `undefined` means "follow Agent"; MCP `[]` means explicit no MCP.
  runtime: RuntimeType | undefined;
  /** PRD 0.2.9 — Per-task provider id; paired with `model`. */
  providerId: string | undefined;
  model: string | undefined;
  /** PRD 0.2.9 — External-runtime config (model/permissionMode for codex/CC). */
  runtimeConfig: RuntimeConfig | undefined;
  permissionMode: string | undefined;
  mcpEnabledServers: string[] | undefined;
}

function taskToDraft(task: Task, taskMd: string): Draft {
  // End-condition mode is derived: if any constraint is present, the user
  // intended "conditional"; otherwise "forever".
  const ec = task.endConditions;
  const hasConstraints = !!(ec?.deadline || ec?.maxExecutions);
  const endConditionMode: EndConditionMode = hasConstraints ? 'conditional' : 'forever';
  // `dispatchAt` is now the authoritative "when to fire" timestamp for
  // scheduled mode. Fall back to the legacy `endConditions.deadline` for
  // rows created before the split.
  const atSource = task.dispatchAt ?? (task.executionMode === 'scheduled' ? ec?.deadline : undefined);
  const atDateTime = atSource ? toLocalDateTimeString(new Date(atSource)) : '';
  return {
    name: task.name,
    workspaceId: task.workspaceId,
    workspacePath: task.workspacePath ?? '',
    taskMd,
    executionMode: task.executionMode,
    runMode: task.executionMode === 'recurring'
      ? task.runMode ?? 'new-session'
      : task.executionMode === 'loop'
        ? 'single-session'
        : 'new-session',
    preselectedSessionId:
      task.executionMode === 'recurring' || task.executionMode === 'loop'
        ? task.preselectedSessionId ?? ''
        : '',
    trigger: task.executionMode === 'recurring'
      ? task.trigger ?? { source: { type: 'time' }, detector: { type: 'always' } }
      : { source: { type: 'time' }, detector: { type: 'always' } },
    atDateTime,
    intervalMinutes: task.intervalMinutes ?? 30,
    cronExpression: task.cronExpression ?? '',
    cronTimezone: task.cronTimezone ?? '',
    endConditionMode,
    deadline: ec?.deadline ? toLocalDateTimeString(new Date(ec.deadline)) : '',
    maxExecutions: ec?.maxExecutions ? String(ec.maxExecutions) : '',
    aiCanExit: ec?.aiCanExit ?? true,
    notification: task.notification ?? { desktop: true },
    runtime: task.runtime,
    // PRD 0.2.9 — Per-task provider id (paired with `model`).
    providerId: task.providerId && task.providerId.length > 0 ? task.providerId : undefined,
    // Empty string from disk = "no override"; surface as undefined so the
    // advanced editor's "跟随 Agent" sentinel is respected.
    model: task.model && task.model.length > 0 ? task.model : undefined,
    // PRD 0.2.9 — Runtime config (external-runtime model/permission overrides).
    runtimeConfig: task.runtimeConfig as RuntimeConfig | undefined,
    permissionMode:
      task.permissionMode && task.permissionMode.length > 0
        ? task.permissionMode
        : undefined,
    mcpEnabledServers: task.mcpEnabledServers,
  };
}

export function TaskEditPanel({
  task,
  focusDoc = null,
  onSaved,
  onCancel,
  onError,
}: TaskEditPanelProps) {
  const { t } = useTranslation('task');
  const { sessions } = useTaskCenterData({ isActive: true });
  const [draft, setDraft] = useState<Draft>(() => taskToDraft(task, ''));
  // Snapshot of the draft at the moment task.md finished
  // loading. We diff against this for the dirty check so reads
  // populating the textareas don't count as dirty.
  const initialDraftRef = useRef<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [triggerValid, setTriggerValid] = useState(true);
  // Tri-state: null (loading) | true (loaded) | false (failed) — separate
  // from just "loaded" so a read failure doesn't silently let the user
  // overwrite their existing task.md with an empty string (C2 review).
  const [taskMdReadState, setTaskMdReadState] =
    useState<'loading' | 'ok' | 'failed'>('loading');
  // Discard-confirmation dialog when the draft is dirty.
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const toast = useToast();
  const { projects, providers } = useConfig();

  // Refs for `focusDoc` — scroll-into-view + caret focus on open. Effect
  // runs on mount only (focusDoc is an intent, not a live mode). For task.md
  // we also select so the user can start typing immediately; notification
  // only scrolls into view.
  const taskMdRef = useRef<HTMLTextAreaElement | null>(null);
  const notificationRef = useRef<HTMLDivElement | null>(null);
  // Fire-once latch: once we've scrolled + focused for a given focusDoc
  // value, don't fire again if read-state re-renders push the effect.
  const focusAppliedRef = useRef<FocusDoc | null>(null);
  useEffect(() => {
    if (!focusDoc) {
      focusAppliedRef.current = null;
      return;
    }
    if (focusAppliedRef.current === focusDoc) return;
    // Gate on the relevant doc being loaded — focusing a disabled
    // textarea is a no-op, so firing too early (before the filesystem
    // read lands) silently misses. Previously this was a hard-coded
    // 80ms timeout, which is both flaky on slow disks and a magic
    // number. Now we wait until the textarea is enabled.
    if (focusDoc === 'task' && taskMdReadState === 'loading') return;
    // Defer to next frame so the refs are wired and layout is settled.
    const raf = requestAnimationFrame(() => {
      const el =
        focusDoc === 'task' ? taskMdRef.current
          : focusDoc === 'notification' ? notificationRef.current
            : null;
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (el instanceof HTMLTextAreaElement) {
        el.focus({ preventScroll: true });
      }
      focusAppliedRef.current = focusDoc;
    });
    return () => cancelAnimationFrame(raf);
  }, [focusDoc, taskMdReadState]);

  // Read the canonical task.md once; the backend lazily merges any legacy
  // verify.md into this body before returning it.
  useEffect(() => {
    let cancelled = false;
    void taskReadDoc(task.id, 'task')
      .then((content) => {
        if (cancelled) return;
        setTaskMdReadState('ok');
        setDraft((current) => {
          const next = { ...current, taskMd: content };
          initialDraftRef.current = next;
          return next;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setTaskMdReadState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  const handleOpenDocsDir = useCallback(async () => {
    try {
      await taskOpenDocsDir(task.id);
    } catch (e) {
      toast.error(extractErrorMessage(e));
    }
  }, [task.id, toast]);

  // If the task transitions to running / verifying while we're editing
  // (external SSE — scheduler fired, or another window changed status),
  // we'd be presenting editable controls the backend will reject. Bail
  // out of edit mode and surface why.
  const locked = task.status === 'running' || task.status === 'verifying';
  useEffect(() => {
    if (locked) {
      onError(t('edit.lockedError'));
      onCancel();
    }
  }, [locked, onCancel, onError, t]);

  const isScheduled = draft.executionMode === 'scheduled';
  const isRecurring = draft.executionMode === 'recurring';
  const isLoop = draft.executionMode === 'loop';
  const showEndConditions = isRecurring || isLoop;
  const visibleProjects = useMemo(
    () => projects.filter(isProjectActiveForUser),
    [projects],
  );
  const workspace = useMemo(
    () => visibleProjects.find((project) =>
      workspacePathsEqual(project.path, draft.workspacePath),
    ) ?? visibleProjects.find((project) => project.id === draft.workspaceId) ?? null,
    [draft.workspaceId, draft.workspacePath, visibleProjects],
  );
  const projectOptions = useMemo(
    () => visibleProjects.map((project) => ({
      value: project.path,
      label:
        project.displayName || project.name || project.path.split('/').pop() || project.path,
      icon: <WorkspaceIcon icon={project.icon} size={16} />,
    })),
    [visibleProjects],
  );
  const sessionOptions = useMemo(
    () => sessions
      .filter((session) => workspace && workspacePathsEqual(session.agentDir, workspace.path))
      .map((session, index) => ({
        value: session.id,
        label: index === 0
          ? t('trigger.sessionRecent', { title: session.title || session.id })
          : session.title || session.id,
      })),
    [sessions, t, workspace],
  );
  const preservesLegacyMissingBinding =
    task.runMode === 'single-session' &&
    !task.preselectedSessionId &&
    draft.runMode === 'single-session' &&
    !draft.preselectedSessionId &&
    task.workspacePath !== undefined &&
    workspacePathsEqual(task.workspacePath, draft.workspacePath);

  // Keep runMode aligned with PRD §9.2 defaults when user flips mode.
  const setExecutionMode = useCallback((next: TaskExecutionMode) => {
    setDraft((d) => {
      const nextRunMode: TaskRunMode =
        next === 'loop' ? 'single-session'
          : next === 'recurring' ? 'new-session'
            : 'new-session';
      return {
        ...d,
        executionMode: next,
        runMode: nextRunMode,
        preselectedSessionId: '',
        trigger: next === 'recurring'
          ? d.trigger
          : { source: { type: 'time' }, detector: { type: 'always' } },
      };
    });
  }, []);

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!draft.name.trim()) errs.push(t('edit.validation.nameRequired'));
    if (taskMdReadState === 'failed')
      errs.push(t('edit.validation.taskReadFailed'));
    if (taskMdReadState === 'ok' && !draft.taskMd.trim())
      errs.push(t('edit.validation.taskRequired'));
    if (!workspace) errs.push(t('dispatch.validation.workspaceRequired'));
    if (isRecurring && !triggerValid) errs.push(t('trigger.validation.invalid'));
    if (
      isRecurring &&
      draft.runMode === 'single-session' &&
      !sessionOptions.some((option) => option.value === draft.preselectedSessionId) &&
      !preservesLegacyMissingBinding
    ) {
      errs.push(t('trigger.validation.sessionRequired'));
    }
    if (isScheduled) {
      const ts = Date.parse(draft.atDateTime);
      if (Number.isNaN(ts) || ts <= Date.now()) errs.push(t('edit.validation.futureTimeRequired'));
    }
    if (isRecurring) {
      const advancedOn = draft.cronExpression.trim().length > 0;
      if (advancedOn) {
        // Rust nom-cron is strict; do a shallow shape check here to catch
        // the obvious "forgot a field" mistake before the backend would.
        if (draft.cronExpression.trim().split(/\s+/).length !== 5) {
          errs.push(t('edit.validation.cronPartsRequired'));
        }
      } else if (draft.intervalMinutes < 5) {
        errs.push(t('edit.validation.intervalTooShort'));
      }
    }
    if (
      showEndConditions &&
      draft.endConditionMode === 'conditional' &&
      !draft.deadline &&
      !draft.maxExecutions &&
      !draft.aiCanExit
    ) {
      errs.push(t('edit.validation.endConditionRequired'));
    }
    return errs;
  }, [draft, isScheduled, isRecurring, preservesLegacyMissingBinding, sessionOptions, showEndConditions, taskMdReadState, triggerValid, t, workspace]);

  const buildEndConditions = useCallback((): EndConditions | undefined => {
    if (!showEndConditions) return undefined;
    if (draft.endConditionMode === 'forever') return { aiCanExit: draft.aiCanExit };
    const out: EndConditions = { aiCanExit: draft.aiCanExit };
    if (draft.deadline) {
      const ts = Date.parse(draft.deadline);
      if (!Number.isNaN(ts)) out.deadline = ts;
    }
    if (draft.maxExecutions) {
      const n = parseInt(draft.maxExecutions, 10);
      if (!Number.isNaN(n) && n > 0) out.maxExecutions = n;
    }
    return out;
  }, [draft, showEndConditions]);

  // Dirty check: stringified compare against the post-load snapshot. Cheap
  // (the draft is small), and it sidesteps having to reason about which
  // fields are user-touched. Returns false until both reads have settled.
  const isDirty = useMemo(() => {
    if (!initialDraftRef.current) return false;
    return JSON.stringify(draft) !== JSON.stringify(initialDraftRef.current);
  }, [draft]);

  const requestCancel = useCallback(() => {
    if (saving) return;
    if (isDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    onCancel();
  }, [saving, isDirty, onCancel]);

  // The edit sheet is a distinct close layer above the detail Drawer. Cmd/Ctrl+W
  // must unwind through the dirty guard instead of closing the whole Drawer.
  useCloseLayer(() => {
    requestCancel();
    return true;
  }, 230);

  const confirmDiscard = useCallback(() => {
    setShowDiscardConfirm(false);
    onCancel();
  }, [onCancel]);

  const handleSave = useCallback(async () => {
    if (errors.length > 0 || saving) return;

    // Build a partial update. `Option<T>` on the Rust side means "don't
    // touch this field" for any key we omit — so we send only what the
    // user actually changed. Rust's `update()` takes care of clearing
    // mode-incompatible fields when `executionMode` flips (PRD §9.4
    // hygiene), so we just forward the draft.
    const payload: TaskUpdateInput = { id: task.id };
    const projectedExecution = projectTaskExecutionOverrides({
      providers,
      runtime: draft.runtime,
      providerId: draft.providerId,
      model: draft.model,
      runtimeConfig: draft.runtimeConfig,
    });
    if (draft.name.trim() !== task.name) payload.name = draft.name.trim();
    if (
      workspace &&
      (workspace.id !== task.workspaceId ||
        !task.workspacePath ||
        !workspacePathsEqual(workspace.path, task.workspacePath))
    ) {
      payload.workspaceId = workspace.id;
      payload.workspacePath = workspace.path;
    }

    if (taskMdReadState === 'ok') {
      // Only persist when we actually loaded the current body — a failed
      // read must not let the user overwrite with whatever's in the
      // textarea (could be the empty default).
      payload.prompt = draft.taskMd;
    }

    const modeChanged = draft.executionMode !== task.executionMode;
    // executionMode is the structural discriminator for runMode, Session and
    // Trigger fields. Always send it from this full editor so a stale partial
    // draft cannot merge recurring-only fields into a Task another window has
    // already changed to Once/Scheduled.
    payload.executionMode = draft.executionMode;

    const nextRunMode: TaskRunMode = isRecurring
      ? draft.runMode
      : isLoop
        ? 'single-session'
        : 'new-session';
    if (nextRunMode !== (task.runMode ?? 'new-session')) payload.runMode = nextRunMode;
    const nextPreselected =
      (isRecurring || isLoop) && nextRunMode === 'single-session'
        ? draft.preselectedSessionId
        : '';
    if (nextPreselected !== (task.preselectedSessionId ?? '')) {
      payload.preselectedSessionId = nextPreselected;
    }

    if (draft.executionMode !== 'once') {
      const ec = buildEndConditions();
      const initialEc = JSON.stringify(task.endConditions ?? null);
      const nextEc = JSON.stringify(ec ?? null);
      if (modeChanged || initialEc !== nextEc) payload.endConditions = ec;
    }

    if (!isRecurring) {
      if (task.trigger) payload.clearTrigger = true;
    } else {
      const initialTrigger = task.trigger ?? { source: { type: 'time' }, detector: { type: 'always' } };
      if (JSON.stringify(initialTrigger) !== JSON.stringify(draft.trigger)) {
        if (draft.trigger.detector.type === 'always') payload.clearTrigger = true;
        else payload.trigger = draft.trigger;
      }
    }

    // Scheduling detail — only forward the field relevant to the target
    // mode so the Rust layer's mode-hygiene cleanup can do its job.
    if (isScheduled) {
      const ts = Date.parse(draft.atDateTime);
      if (!Number.isNaN(ts) && ts !== task.dispatchAt) {
        payload.dispatchAt = ts;
      }
    } else if (isRecurring) {
      const advanced = draft.cronExpression.trim();
      if (advanced) {
        if (advanced !== (task.cronExpression ?? '')) payload.cronExpression = advanced;
        if (draft.cronTimezone !== (task.cronTimezone ?? ''))
          payload.cronTimezone = draft.cronTimezone;
      } else {
        // Simple mode — clear any cron expression the task had before.
        if (task.cronExpression) payload.cronExpression = '';
        if (task.cronTimezone) payload.cronTimezone = '';
        if (draft.intervalMinutes !== (task.intervalMinutes ?? 0)) {
          payload.intervalMinutes = draft.intervalMinutes;
        }
      }
    }

    // Execution overrides — diff against the persisted Task. Sending an
    // empty string clears (Rust `update()` treats `Some("")` as
    // `permission_mode = None`); sending undefined leaves the field untouched.
    //
    // PRD 0.2.9 — providerId + model are paired. If user clears them both
    // ("跟随 Agent" sentinel), use the explicit `clearProviderOverride`
    // flag so atomicity is server-enforced (Rust validator catches half-state).
    const initialProviderId = task.providerId ?? '';
    const initialModel = task.model ?? '';
    const draftProviderId = projectedExecution.providerId ?? '';
    const draftModel = projectedExecution.model ?? '';
    const providerOrModelChanged =
      initialProviderId !== draftProviderId || initialModel !== draftModel;
    if (providerOrModelChanged) {
      const goingToFollow = !draftProviderId && !draftModel;
      if (goingToFollow) {
        payload.clearProviderOverride = true;
      } else {
        if (initialModel !== draftModel) payload.model = draftModel;
        if (initialProviderId !== draftProviderId) payload.providerId = draftProviderId;
      }
    }
    const draftPermissionMode = draft.permissionMode ?? '';
    if (draftPermissionMode !== (task.permissionMode ?? '')) {
      payload.permissionMode = draftPermissionMode;
    }
    // PRD 0.2.9 / #131 — runtime + runtimeConfig diff. "Follow Agent" maps
    // to `draft.runtime === undefined`, which JSON-omits the field — Rust
    // `update()` then leaves the existing override untouched. Use the
    // explicit `clearRuntimeOverride` flag for the clear case (mirrors
    // `clearProviderOverride`) so the round-trip is unambiguous on both
    // sides.
    const initialRuntime = task.runtime ?? '';
    const draftRuntime = projectedExecution.runtime ?? '';
    const initialRuntimeConfig = JSON.stringify(task.runtimeConfig ?? null);
    const nextRuntimeConfig = JSON.stringify(projectedExecution.runtimeConfig ?? null);
    const runtimeChanged = initialRuntime !== draftRuntime;
    const runtimeConfigChanged = initialRuntimeConfig !== nextRuntimeConfig;
    if (runtimeChanged || runtimeConfigChanged) {
      const goingToFollowRuntime = !draftRuntime && !projectedExecution.runtimeConfig;
      if (goingToFollowRuntime) {
        payload.clearRuntimeOverride = true;
      } else {
        if (runtimeChanged) payload.runtime = projectedExecution.runtime;
        if (runtimeConfigChanged) {
          // RuntimeConfig vs RuntimeConfigSnapshot — structurally compatible,
          // see DispatchTaskDialog for the cast rationale.
          payload.runtimeConfig = projectedExecution.runtimeConfig as Record<string, unknown> | undefined;
        }
      }
    }
    // MCP override is tri-state: undefined = follow Agent, [] = explicit no
    // MCP, [ids] = explicit override. Clearing to follow uses a dedicated flag
    // because [] is now a real persisted state.
    const initialMcp = task.mcpEnabledServers === undefined
      ? '__follow__'
      : JSON.stringify(task.mcpEnabledServers);
    const draftMcp = draft.mcpEnabledServers === undefined
      ? '__follow__'
      : JSON.stringify(draft.mcpEnabledServers);
    if (initialMcp !== draftMcp) {
      if (draft.mcpEnabledServers === undefined) {
        payload.clearMcpOverride = true;
      } else {
        payload.mcpEnabledServers = draft.mcpEnabledServers;
      }
    }

    const initialNotification = JSON.stringify(task.notification ?? null);
    const nextNotification = JSON.stringify(draft.notification);
    if (initialNotification !== nextNotification)
      payload.notification = draft.notification;

    // Bail if nothing changed — stay in edit mode so the user isn't
    // thrown back to read-only with no feedback.
    if (Object.keys(payload).length === 1) {
      onError(t('edit.noChanges'));
      return;
    }

    setSaving(true);
    try {
      const updated = await taskUpdate(payload);
      onSaved(updated);
    } catch (e) {
      onError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [
    draft,
    errors,
    saving,
    task,
    providers,
    workspace,
    buildEndConditions,
    isScheduled,
    isRecurring,
    isLoop,
    taskMdReadState,
    onSaved,
    onError,
    t,
  ]);

  // Esc → cancel (with dirty guard); Cmd/Ctrl+Enter → save. The discard
  // confirm dialog is itself an overlay layer (z-300 via ConfirmDialog),
  // so its own Esc handling is independent and won't double-close.
  usePanelKeys({
    onClose: requestCancel,
    onSubmit: () => void handleSave(),
    disabled: errors.length > 0 || saving || showDiscardConfirm,
  });

  return (
    <>
      {showDiscardConfirm && (
        <ConfirmDialog
          title={t('edit.discardTitle')}
          message={t('edit.discardMessage')}
          confirmText={t('edit.discardConfirm')}
          cancelText={t('edit.discardCancel')}
          confirmVariant="danger"
          onConfirm={confirmDiscard}
          onCancel={() => setShowDiscardConfirm(false)}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className={`flex-1 overflow-y-auto px-6 py-5 ${SECTION_GAP}`}>
        {/* 基本信息 */}
        <FormSection icon={DocumentIcon} title={t('edit.sectionBasic')}>
          <div className="space-y-4">
            <Field label={t('edit.name')} required>
              <input
                type="text"
                value={draft.name}
                maxLength={120}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                className={INPUT_CLS}
              />
            </Field>
          </div>
        </FormSection>

        <div className={SECTION_DIVIDER} />

        {/* task.md is the single editable semantic contract. */}
        <FormSection
          icon={DocumentIcon}
          title={t('detail.taskDocTitle')}
          action={<OpenFolderButton onClick={() => void handleOpenDocsDir()} />}
        >
          <DocPathRow path={`~/${APP_DATA_DIR_NAME}/tasks/${task.id}/task.md`} />
          {taskMdReadState === 'failed' ? (
            <div className="rounded-[var(--radius-md)] border border-[var(--error)]/30 bg-[var(--error-bg)] px-3 py-2.5 text-xs text-[var(--error)]">
              {t('edit.taskReadFailed')}
            </div>
          ) : (
            <>
              <textarea
                ref={taskMdRef}
                value={draft.taskMd}
                onChange={(e) => setDraft((d) => ({ ...d, taskMd: e.target.value }))}
                rows={10}
                disabled={taskMdReadState !== 'ok'}
                placeholder={
                  taskMdReadState === 'ok'
                    ? t('edit.taskPlaceholder')
                    : t('common.loading')
                }
                className={`${INPUT_CLS} resize-y font-mono text-sm`}
              />
              <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                {t('edit.taskDescription')}
              </p>
            </>
          )}
        </FormSection>

        <div className={SECTION_DIVIDER} />

        <FormSection icon={HelperIcon} title={t('dispatch.workspace')}>
          <CustomSelect
            value={workspace?.path ?? draft.workspacePath}
            options={projectOptions}
            onChange={(workspacePath) => {
              const selected = visibleProjects.find((project) =>
                workspacePathsEqual(project.path, workspacePath),
              );
              if (!selected) return;
              setDraft((current) => ({
                ...current,
                workspaceId: selected.id,
                workspacePath: selected.path,
                preselectedSessionId: '',
              }));
            }}
            placeholder={t('dispatch.workspacePlaceholder')}
            size="md"
          />
          <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
            {t('dispatch.workspaceHint')}
          </p>
        </FormSection>

        <div className={SECTION_DIVIDER} />

        {/* 高级配置 — runtime / provider / model / permission / MCP overrides (PRD 0.2.9) */}
        <FormSection icon={SlidersIcon} title={t('edit.advanced')}>
          <TaskAdvancedConfigEditor
            workspacePath={draft.workspacePath}
            runtime={draft.runtime}
            setRuntime={(v) => setDraft((d) => ({ ...d, runtime: v }))}
            providerId={draft.providerId}
            setProviderId={(v) => setDraft((d) => ({ ...d, providerId: v }))}
            model={draft.model}
            setModel={(v) => setDraft((d) => ({ ...d, model: v }))}
            runtimeConfig={draft.runtimeConfig}
            setRuntimeConfig={(v) => setDraft((d) => ({ ...d, runtimeConfig: v }))}
            permissionMode={draft.permissionMode}
            setPermissionMode={(v) => setDraft((d) => ({ ...d, permissionMode: v }))}
            mcpEnabledServers={draft.mcpEnabledServers}
            setMcpEnabledServers={(v) =>
              setDraft((d) => ({ ...d, mcpEnabledServers: v }))
            }
          />
        </FormSection>

        <div className={SECTION_DIVIDER} />

        {/* 执行模式 */}
        <FormSection icon={ClockIcon} title={t('dispatch.sectionExecution')}>
          <ExecutionModeEditor
            executionMode={draft.executionMode}
            setExecutionMode={setExecutionMode}
            runMode={draft.runMode}
            setRunMode={(v) => setDraft((d) => ({ ...d, runMode: v }))}
            atDateTime={draft.atDateTime}
            setAtDateTime={(v) => setDraft((d) => ({ ...d, atDateTime: v }))}
            intervalMinutes={draft.intervalMinutes}
            setIntervalMinutes={(v) => setDraft((d) => ({ ...d, intervalMinutes: v }))}
            cronExpression={draft.cronExpression}
            setCronExpression={(v) => setDraft((d) => ({ ...d, cronExpression: v }))}
            cronTimezone={draft.cronTimezone}
            setCronTimezone={(v) => setDraft((d) => ({ ...d, cronTimezone: v }))}
            showSessionStrategy={isRecurring}
          />
          {isRecurring && draft.runMode === 'single-session' && !isLoop && (
            <div className="mt-5">
              <label className="mb-2 block text-sm font-medium text-[var(--ink-secondary)]">
                {t('trigger.targetSession')}
              </label>
              <CustomSelect
                value={draft.preselectedSessionId}
                options={sessionOptions}
                onChange={(value) => setDraft((current) => ({
                  ...current,
                  preselectedSessionId: value,
                }))}
                placeholder={t('trigger.targetSessionPlaceholder')}
                size="md"
              />
              <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                {t('trigger.targetSessionHint')}
              </p>
            </div>
          )}
        </FormSection>

        {isRecurring && (
          <>
            <div className={SECTION_DIVIDER} />
            <FormSection icon={ActivityIcon} title={t('trigger.sectionTitle')}>
              <TriggerEditor
                value={draft.trigger}
                workspacePath={draft.workspacePath}
                ownerTaskId={task.id}
                checkpointState={task.triggerState}
                onChange={(trigger) => setDraft((current) => ({ ...current, trigger }))}
                onValidityChange={setTriggerValid}
              />
              {task.trigger?.detector.type === 'command' && draft.trigger.detector.type === 'always' && (
                <p className="mt-3 text-xs leading-relaxed text-[var(--ink-muted)]">
                  {t('trigger.switchAlwaysWarning')}
                </p>
              )}
            </FormSection>
          </>
        )}

        {showEndConditions && (
          <>
            <div className={SECTION_DIVIDER} />
            <FormSection icon={HelperIcon} title={t('dispatch.sectionEndConditions')}>
              <EndConditionsEditor
                mode={draft.endConditionMode}
                setMode={(v) => setDraft((d) => ({ ...d, endConditionMode: v }))}
                deadline={draft.deadline}
                setDeadline={(v) => setDraft((d) => ({ ...d, deadline: v }))}
                maxExecutions={draft.maxExecutions}
                setMaxExecutions={(v) => setDraft((d) => ({ ...d, maxExecutions: v }))}
                aiCanExit={draft.aiCanExit}
                setAiCanExit={(v) => setDraft((d) => ({ ...d, aiCanExit: v }))}
              />
            </FormSection>
          </>
        )}

        <div className={SECTION_DIVIDER} />

        {/* 通知 */}
        <FormSection icon={BellIcon} title={t('dispatch.sectionNotifications')}>
          <div ref={notificationRef}>
            <NotificationConfigEditor
              value={draft.notification}
              onChange={(v) => setDraft((d) => ({ ...d, notification: v }))}
              workspacePath={draft.workspacePath}
            />
          </div>
        </FormSection>
        </div>

        <PanelFooter
          error={errors[0] ?? null}
          onCancel={requestCancel}
          onSubmit={() => void handleSave()}
          busy={saving}
          disabled={errors.length > 0}
          submitLabel={saving ? t('edit.saving') : t('common.save')}
        />
      </div>
    </>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-[var(--ink-secondary)]">
        {label}
        {hint && <span className="ml-2 text-xs text-[var(--ink-muted)]/70">{hint}</span>}
        {required && <span className="ml-1 text-[var(--accent-warm)]">*</span>}
      </label>
      {children}
    </div>
  );
}

/** Path row under a doc section — mirrors the read-mode TaskDocBlock so
 *  preview ↔ edit feel like the same surface in two modes. */
function DocPathRow({ path }: { path: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ink-muted)]/70"
        title={path}
      >
        {path}
      </span>
    </div>
  );
}

function OpenFolderButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('task');
  return (
    <button
      type="button"
      onClick={onClick}
      title={t('edit.openDocsDirTitle')}
      className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
    >
      <FolderOpenIcon className="h-3 w-3" />
      {t('edit.openDocsDir')}
    </button>
  );
}
