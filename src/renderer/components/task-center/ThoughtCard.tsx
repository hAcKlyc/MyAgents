// ThoughtCard — single thought row rendered in the left-column stream.
// Supports inline edit, an overflow "更多" menu for destructive actions,
// and a "dispatch to task" split-button entry.
//
// Two height regimes:
//   • View (非编辑态): long content clamps to `VIEW_CLAMP_LINES` lines and
//     surfaces a 展开/收起 toggle. The overflow flag is measured post-render
//     so the toggle only appears when content is actually clipped.
//   • Edit (编辑态): textarea auto-resizes with content up to
//     `EDIT_MAX_HEIGHT_PX`, beyond which it scrolls internally. This keeps
//     a single oversized draft from eating the whole panel.

import { APP_BUILD_PROFILE } from '@/../shared/appProfile';
import { registerComposerUpdateOwner } from '@/utils/composerUpdateCheckpoint';
import { isImeComposingEvent } from '@/utils/imeKeyboard';
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  TasksIcon,
  CheckIcon,
  MessageIcon,
  MoreIcon,
  EditIcon,
  TrashIcon,
  ZapIcon,
} from '@/components/icons';
import { thoughtDelete, thoughtSetArchived, thoughtUpdate } from '@/api/taskCenter';
import { Popover } from '@/components/ui/Popover';
import type { Thought } from '@/../shared/types/thought';
import { RecordWorkspacePicker } from './RecordWorkspacePicker';
import { splitWithTagHighlights } from '@/utils/parseThoughtTags';
import { findHighlightRanges, renderTextWithHighlights } from '@/utils/highlightSearchMatches';
import { relativeTime } from '@/utils/taskCenterUtils';
import { isSupportedLocale } from '@/../shared/i18n';

interface Props {
  thought: Thought;
  onChanged: (t: Thought | null) => void;
  onDispatch?: (t: Thought) => void;
  /** Open a new task-discussion Chat tab. The selected workspace is the one
   *  the user picked from the popover. */
  onDiscuss?: (t: Thought, workspaceId: string) => void;
  /** Click handler for inline tag chips — wires into the panel's tag filter. */
  onTagClick?: (tag: string) => void;
  /** Active search query from the panel — when non-empty, every match in the
   *  thought body is wrapped in a `<mark>` span. Tag pills stay tag-coloured
   *  and are not double-highlighted. */
  searchQuery?: string;
  /** When true, the card renders in selection-mode skin: hover actions are
   *  hidden, the entire body becomes a click target that toggles selection,
   *  and a checkbox is shown at the bottom-right corner. */
  selectMode?: boolean;
  /** Whether this card is currently in the selected set. */
  selected?: boolean;
  /** Called when the card body is clicked while `selectMode` is true. */
  onToggleSelect?: () => void;
  /** Called from the ⋯ menu's "多选" item — parent enters select mode and
   *  pre-selects this card. */
  onEnterSelectMode?: () => void;
}

const VIEW_CLAMP_LINES = 5;
const EDIT_MAX_HEIGHT_PX = 200; // ~8.8 行 @ text-sm 14px × leading-relaxed 1.625 ≈ 22.75px/行

function isCardControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, a, input, textarea, select, [role="menuitem"]') !==
      null
  );
}

export function ThoughtCard({
  thought,
  onChanged,
  onDispatch,
  onDiscuss,
  onTagClick,
  searchQuery,
  selectMode = false,
  selected = false,
  onToggleSelect,
  onEnterSelectMode,
}: Props) {
  const [editing, setEditingState] = useState(false);
  const editingRef = useRef(false);
  const setEditing = useCallback((value: boolean) => {
    editingRef.current = value;
    setEditingState(value);
  }, []);
  const [draft, setDraft] = useState(thought.content);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusyState(value);
  }, []);
  const cardRef = useRef<HTMLDivElement>(null);
  const updateLockedRef = useRef(false);
  const checkpointId = useId();
  useLayoutEffect(() => {
    if (APP_BUILD_PROFILE !== 'moxbot') return;
    return registerComposerUpdateOwner({
      snapshot: () => ({
        scope: { tabId: `thought-card:${checkpointId}`, sessionId: null, workspacePath: null, mode: 'launcher' },
        text: '', context: {}, imageCount: 0, pendingAttachments: false,
        composing: false, sending: false, stagedWorkflow: false,
        ...(editingRef.current || busyRef.current ? {
          blockingReason: '任务中心文本记录仍在编辑或保存，请先保存或取消后再更新；内容已保留。',
        } : {}),
      }),
      freeze: locked => {
        updateLockedRef.current = locked;
        if (cardRef.current) cardRef.current.inert = locked;
      },
    });
  }, [checkpointId]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const { t, i18n } = useTranslation('task');
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';

  const viewRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const discussAnchorRef = useRef<HTMLButtonElement>(null);

  // Overflow detection — measure only in collapsed state so flipping to
  // expanded doesn't reset the flag (clientHeight would grow to match).
  useLayoutEffect(() => {
    if (editing || expanded) return;
    const el = viewRef.current;
    if (!el) return;
    setHasOverflow(el.scrollHeight > el.clientHeight + 1);
  }, [thought.content, editing, expanded]);

  // Auto-resize the edit textarea on every draft change, bounded by
  // EDIT_MAX_HEIGHT_PX. Beyond that the textarea scrolls internally.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, EDIT_MAX_HEIGHT_PX)}px`;
  }, [draft, editing]);

  // Close, flip, and outside-click behaviour are handled by the `<Popover>`
  // primitive below — no hand-rolled `mousedown` / `keydown` / viewport
  // measurement here.

  const handleSave = useCallback(async () => {
    if (updateLockedRef.current || busyRef.current) return;
    if (draft.trim() === thought.content.trim()) {
      setEditing(false);
      setExpanded(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await thoughtUpdate({ id: thought.id, content: draft });
      onChanged(updated);
      setEditing(false);
      // Return to collapsed state so the effect re-measures against the new
      // content; otherwise `hasOverflow` can stay stale from the pre-edit
      // body length.
      setExpanded(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, thought.content, thought.id, onChanged, setEditing, setBusy]);

  const handleDelete = useCallback(async () => {
    if (updateLockedRef.current || busyRef.current) return;
    setShowMenu(false);
    setBusy(true);
    setError(null);
    try {
      await thoughtDelete(thought.id);
      onChanged(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [thought.id, onChanged, setBusy]);

  const isArchived = thought.archived === true;
  const handleToggleArchive = useCallback(async () => {
    if (updateLockedRef.current || busyRef.current) return;
    setShowMenu(false);
    setBusy(true);
    setError(null);
    try {
      const updated = await thoughtSetArchived(thought.id, !isArchived);
      // Returning the updated thought lets the panel filter it out of the
      // current view if the new archived state no longer matches viewMode.
      onChanged(updated);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [thought.id, isArchived, onChanged, setBusy]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (updateLockedRef.current || busyRef.current || isImeComposingEvent(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setDraft(thought.content);
        setEditing(false);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSave();
      }
    },
    [thought.content, handleSave, setEditing],
  );

  const enterEdit = useCallback(() => {
    if (updateLockedRef.current || busyRef.current) return;
    setDraft(thought.content);
    setEditing(true);
    setExpanded(true); // opening edit always shows the full body
  }, [thought.content, setEditing]);

  const convertedCount = thought.convertedTaskIds?.length ?? 0;

  // The card owns the primary action in both reading modes: edit in the
  // normal view, selection toggle in multi-select. Nested controls keep their
  // own action and never bubble into the card action.
  const handleCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (updateLockedRef.current || busyRef.current || editing || isCardControl(e.target)) return;
    if (selectMode) onToggleSelect?.();
    else enterEdit();
  };
  const handleCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (updateLockedRef.current || busyRef.current || e.target !== e.currentTarget || editing) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (selectMode) onToggleSelect?.();
    else enterEdit();
  };

  return (
    // Card rhythm (DESIGN.md §5.3 compact card):
    //   p-4          — 16px all sides (border → inner content gutter)
    //   mb-2 between meta row and body — 8px, tight enough that the
    //                  meta row reads as part of the same card, not a
    //                  stray header.
    //   mt-3 between body and footer (expand toggle / inline-edit
    //                  action bar) — 12px, the larger step that visually
    //                  separates "read" from "act".
    <div
      ref={cardRef}
      role={selectMode ? 'checkbox' : editing ? undefined : 'button'}
      aria-checked={selectMode ? selected : undefined}
      aria-label={
        !selectMode && !editing
          ? `${t('common.edit')}: ${thought.content.slice(0, 80)}`
          : undefined
      }
      tabIndex={editing ? undefined : 0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      className={`group relative rounded-[var(--radius-lg)] bg-[var(--paper-elevated)] p-4 outline-none transition-shadow hover:shadow-sm focus-visible:ring-1 focus-visible:ring-[var(--accent-warm)] ${
        !editing ? 'cursor-pointer' : ''
      } ${selected ? 'ring-1 ring-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]' : ''}`}
    >
      {/* Top meta row — time + derived-task count on the left, action
          cluster on the right. Moved from the bottom of the card (prior
          iteration) so status reads first, before the user commits to
          reading the full body.

          Row height is driven by the 12px text (≈ 20px row with the 14px
          icon). The `⋯` button is `h-5 w-5` (20px) rather than the
          toolbar default `h-6 w-6`; larger would force the whole row
          taller than the text needs, pushing the body down and making
          the top padding read as larger than the bottom `p-4` — the
          card felt lopsided.

          Always-rendered meta row (rendered in BOTH preview and edit
          modes — only the right-side action cluster hides in edit).
          Prior shape hid the whole row on `!editing`, which yanked the
          textarea up by ~24px on double-click — jitter the user saw
          as the card "jumping". Consistent structure across states
          means no reflow on mode transitions. */}
      <div className="mb-2 flex h-5 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-[var(--ink-muted)]/60">
          {relativeTime(thought.updatedAt, locale)}
          {convertedCount > 0 && (
            <span className="ml-2 text-[var(--accent-warm)]">
              {t('thoughts.derivedTasks', { count: convertedCount })}
            </span>
          )}
        </span>
        {!editing && !selectMode && (
          <div className="flex shrink-0 items-center gap-1">
            {/* Primary actions (AI 讨论 / 派发) — hover-only to keep the
                 resting card uncluttered. Each button owns a local
                 `group/btn-*` so its dark-pill tooltip doesn't inherit
                 the card-level `group-hover`. Native `title=` would
                 render the OS-default grey tooltip and break with the
                 WorkspaceCard tooltip language we use elsewhere. */}
            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {onDiscuss && (
                <div className="group/discuss relative">
                  <button
                    ref={discussAnchorRef}
                    type="button"
                    onClick={() => { if (!updateLockedRef.current) setShowWorkspacePicker((v) => !v); }}
                    className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--accent-cool)]"
                  >
                    <MessageIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {t('thoughts.aiDiscuss')}
                  </button>
                  {!showWorkspacePicker && (
                    <span className="pointer-events-none absolute -bottom-7 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--button-dark-bg)] px-2 py-0.5 text-xs text-[var(--button-dark-text)] opacity-0 shadow-lg transition-opacity group-hover/discuss:opacity-100">
                      {t('thoughts.aiDiscussTooltip')}
                    </span>
                  )}
                </div>
              )}
              {onDispatch && (
                <div className="group/dispatch relative">
                  <button
                    type="button"
                    onClick={() => { if (!updateLockedRef.current) onDispatch(thought); }}
                    className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--accent-warm)]"
                  >
                    <ZapIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {t('thoughts.dispatch')}
                  </button>
                  <span className="pointer-events-none absolute -bottom-7 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--button-dark-bg)] px-2 py-0.5 text-xs text-[var(--button-dark-text)] opacity-0 shadow-lg transition-opacity group-hover/dispatch:opacity-100">
                    {t('thoughts.dispatchTooltip')}
                  </span>
                </div>
              )}
            </div>
            {/* Workspace picker — rendered once per card; shows when the
                 AI 讨论 button is clicked. Portal'd via Popover so the
                 anchor's `overflow-hidden` card chrome can't clip it. */}
            {onDiscuss && (
              <RecordWorkspacePicker
                open={showWorkspacePicker}
                onClose={() => setShowWorkspacePicker(false)}
                anchorRef={discussAnchorRef}
                tags={thought.tags}
                onSelect={(workspaceId) => { if (!updateLockedRef.current) onDiscuss(thought, workspaceId); }}
              />
            )}
            {/* "更多" — always visible so the user has a permanent
                 handle on secondary actions (编辑 / 删除) without having
                 to hover-discover. `h-5 w-5` matches the meta row's
                 text-driven height so the button never raises the row
                 above its 20px baseline. */}
            <button
              ref={menuAnchorRef}
              type="button"
              onClick={() => { if (!updateLockedRef.current) setShowMenu((v) => !v); }}
              disabled={busy}
              title={t('thoughts.moreActions')}
              className="flex h-5 w-5 items-center justify-center rounded-[var(--radius-md)] text-[var(--ink-muted)]/70 transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <MoreIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
            <Popover
              open={showMenu}
              onClose={() => setShowMenu(false)}
              anchorRef={menuAnchorRef}
              placement="bottom-end"
              className="min-w-[120px] py-1"
            >
              <button
                type="button"
                onClick={() => {
                  if (updateLockedRef.current) return;
                  setShowMenu(false);
                  enterEdit();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                <EditIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t('common.edit')}
              </button>
              {onEnterSelectMode && (
                <button
                  type="button"
                  onClick={() => {
                    if (updateLockedRef.current) return;
                    setShowMenu(false);
                    onEnterSelectMode();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <TasksIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {t('thoughts.multiSelect')}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleToggleArchive()}
                disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50"
              >
                {isArchived ? (
                  <>
                    <ArchiveRestoreIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {t('thoughts.unarchive')}
                  </>
                ) : (
                  <>
                    <ArchiveIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {t('thoughts.archive')}
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--error)] hover:bg-[var(--error-bg)]"
              >
                <TrashIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t('common.delete')}
              </button>
            </Popover>
          </div>
        )}
      </div>

      {/* Body — thought content or edit textarea. */}
      {editing ? (
        <textarea
          ref={editRef}
          value={draft}
          onChange={(e) => { if (!updateLockedRef.current) setDraft(e.target.value); }}
          onKeyDown={handleEditKeyDown}
          autoFocus
          rows={2}
          style={{
            minHeight: '2.75rem',
            maxHeight: `${EDIT_MAX_HEIGHT_PX}px`,
            overflowY: 'auto',
          }}
          className="w-full resize-none rounded-[var(--radius-sm)] bg-transparent text-sm leading-relaxed text-[var(--ink)] focus:outline-none"
        />
      ) : (
        <div
          ref={viewRef}
          className="cursor-text whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--ink-secondary)]"
          style={
            expanded
              ? undefined
              : {
                  display: '-webkit-box',
                  WebkitLineClamp: VIEW_CLAMP_LINES,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }
          }
        >
          {renderWithTagHighlights(thought.content, selectMode ? undefined : onTagClick, searchQuery)}
        </div>
      )}

      {/* Bottom-right select indicator. Rendered only in selectMode so the
          resting card doesn't carry an extra glyph. The card body's onClick
          is the actual toggle target — the checkbox is a visual receipt
          (and a separate click target for users who specifically aim at it). */}
      {selectMode && (
        <div className="pointer-events-none absolute bottom-2 right-2">
          <div
            className={`flex h-5 w-5 items-center justify-center rounded-full border transition-colors ${
              selected
                ? 'border-[var(--accent-warm)] bg-[var(--accent-warm)] text-[var(--on-accent)]'
                : 'border-[var(--line-strong)] bg-[var(--paper-elevated)] text-transparent'
            }`}
          >
            <CheckIcon className="h-3 w-3" strokeWidth={3} />
          </div>
        </div>
      )}

      {/* Expand/collapse toggle — only when the clamp actually clipped
          content. Sits directly below the body so it feels attached to it. */}
      {!editing && hasOverflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs text-[var(--accent-warm)] hover:underline"
        >
          {expanded ? t('thoughts.collapse') : t('thoughts.expand')}
        </button>
      )}

      {error && <div className="mt-2 text-xs text-[var(--error)]">{error}</div>}

      {/* Inline edit action bar — only in edit mode. Sits at the bottom
          so the edit flow reads top-down: textarea → save/cancel. */}
      {editing && (
        <div className="mt-3 flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => {
              if (updateLockedRef.current || busyRef.current) return;
              setDraft(thought.content);
              setEditing(false);
            }}
            disabled={busy}
            className="rounded-[var(--radius-md)] px-2 py-1 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={busy}
            className="rounded-[var(--radius-md)] bg-[var(--accent-warm)] px-2.5 py-1 text-sm font-medium text-[var(--on-accent)] hover:bg-[var(--accent-warm-hover)]"
          >
            {t('common.save')}
          </button>
        </div>
      )}
    </div>
  );
}

function renderWithTagHighlights(content: string, onTagClick?: (tag: string) => void, searchQuery?: string) {
  // Saved-card tags sit one typography step below the compact thought body,
  // so they read as metadata rather than competing with the prose. Keep the
  // authoring overlay separate: its glyph metrics must match the textarea for
  // cursor/highlight alignment.
  const parts = splitWithTagHighlights(content);
  const pillCls = 'rounded-[var(--radius-sm)] bg-[var(--accent-warm-subtle)] px-1 text-xs text-[var(--accent-warm)]';
  // Search-keyword highlight is intentionally only applied to non-tag
  // segments. Tag pills are already a coloured block; layering a `<mark>`
  // inside them doubles the visual emphasis and looks broken.
  const q = searchQuery?.trim() ?? '';
  return parts.map((p, i) => {
    if (p.type === 'tag' && p.tag) {
      const body = p.tag;
      return onTagClick ? (
        <button
          key={i}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTagClick(body);
          }}
          className={`${pillCls} cursor-pointer transition-colors hover:bg-[var(--accent-warm-muted)]`}
        >
          {p.value}
        </button>
      ) : (
        <span key={i} className={pillCls}>
          {p.value}
        </span>
      );
    }
    if (q.length > 0) {
      const ranges = findHighlightRanges(p.value, q);
      if (ranges.length > 0) {
        return <span key={i}>{renderTextWithHighlights(p.value, ranges)}</span>;
      }
    }
    return <span key={i}>{p.value}</span>;
  });
}

export default ThoughtCard;
