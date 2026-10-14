import { useUpdateEditorAdmission } from '@/hooks/useUpdateEditorAdmission';
// ThoughtInput — compact freeform note input for Thought mode.
// Writes through to ~/.myagents/thoughts/ via `cmd_thought_create`.
//
// flomo-style inline tag editor: `#word ` as you type → `#word` renders
// highlighted inline; typing `#` (or clicking the # toolbar button) opens
// a tag picker filtered by the partial tag; Enter / Tab / click picks.
//
// Implementation: a transparent <textarea> layered on top of a mirror
// <div> that renders the same text with `#tag` runs coloured via
// `splitWithTagHighlights` (the shared parser with Rust + ThoughtCard, so
// highlight ≡ server-extracted `thought.tags[]`).

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { HashIcon, MicIcon, EditIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { thoughtCreate } from '@/api/taskCenter';
import Tip from '@/components/Tip';
import { Popover } from '@/components/ui/Popover';
import {
  findActiveTagContext,
  isBoundaryChar,
  splitWithTagHighlights,
  tagBodyEndOffset,
} from '@/utils/parseThoughtTags';
import type { Thought } from '@/../shared/types/thought';

export interface ThoughtInputHandle {
  /** Programmatically focus the textarea. Mirrors SimpleChatInputHandle so
   *  parents (e.g. Launcher BrandSection) can drive focus on mode switches
   *  without relying on the `autoFocus` prop-flip heuristic. */
  focus: () => void;
}

// Visual variants. Both variants share the outer card frame (radius,
// shadow, border) so the Task Center input and the Launcher 想法 input
// read as the same affordance. They diverge only on inner metrics —
// `compact` (Task Center) uses the 14px UI tier so short notes stay dense
// beside the Task list; `launcher` keeps 16px prose text and roomier padding
// to match SimpleChatInput's launcher-mode card byte-for-byte.
type ThoughtInputVariant = 'compact' | 'launcher';

const VARIANTS: Record<
  ThoughtInputVariant,
  {
    pxPerLine: number;
    /** Extra px added on top of `pxPerLine * minLines` when the padding
     *  lives on the textarea/overlay-inner itself (compact). Set to 0
     *  when the padding lives on an outer wrapper (launcher) — then
     *  `minHeight` is pure content so it matches SimpleChatInput's own
     *  `LINE_HEIGHT * effectiveMinLines` formula byte-for-byte. */
    verticalPaddingPx: number;
    textareaClass: string;
    cardClass: string;
    /** Tailwind class for the outer card's focus state. Empty string in
     *  `launcher` because SimpleChatInput's card doesn't change border
     *  on focus — adding it would surface as a "mystery grey outline"
     *  the user doesn't see on the chat input. */
    focusClass: string;
    /** Padding on the *outer* content wrapper (one level inside the
     *  card, outside the textarea). Non-empty for launcher so the
     *  textarea can have `minHeight = pxPerLine * minLines` exactly
     *  (no padding bundled into its box), matching SimpleChatInput. */
    outerPaddingClass: string;
    /** Padding on the textarea + overlay-inner themselves. Non-empty
     *  for compact (all padding lives here, outer wrapper is a no-op). */
    innerPaddingClass: string;
    toolbarPaddingClass: string;
    toolbarButtonPaddingClass: string;
  }
> = {
  compact: {
    pxPerLine: 23, // text-sm 14px × leading-relaxed 1.625 ≈ 22.75px（改字号必同步此几何常量）
    verticalPaddingPx: 12,
    textareaClass: 'text-sm leading-relaxed',
    // Resting `shadow-xs` so the input reads as quietly elevated above
    // the thought stream below; lifts to `shadow-sm` on hover / focus to
    // signal the active write surface. Same idiom as SettingsHelperInbox.
    cardClass:
      'rounded-2xl shadow-xs hover:shadow-sm focus-within:shadow-sm transition-shadow duration-150',
    focusClass: '',
    outerPaddingClass: '',
    innerPaddingClass: 'px-3 pt-3',
    toolbarPaddingClass: 'px-2 pb-2 pt-1',
    toolbarButtonPaddingClass: 'p-1.5',
  },
  launcher: {
    // Every metric here is pinned to SimpleChatInput's launcher card so
    // the 任务 ↔ 想法 toggle is a pure content swap, no visual wobble.
    pxPerLine: 26, // matches LINE_HEIGHT = 26 (text-base × leading-relaxed 1.625)
    verticalPaddingPx: 0,
    textareaClass: 'text-base leading-relaxed',
    cardClass: 'rounded-2xl shadow-md',
    focusClass: '',
    outerPaddingClass: 'px-4 pt-3',
    innerPaddingClass: '',
    toolbarPaddingClass: 'px-3 pb-2 pt-1',
    toolbarButtonPaddingClass: 'p-2',
  },
};

/**
 * Single source of truth for every CSS class that decides where a glyph
 * lands. The mirror `<div>` and the user-facing `<textarea>` MUST have
 * identical wrap geometry — if any of these tokens drift between the
 * two layers (e.g. someone adds `tracking-tight` to the textarea but
 * forgets the mirror), text wraps at a different character and the
 * textarea's caret floats into "mystery whitespace" after the last
 * visible mirror glyph (regression scenario from cross-review M9).
 */
function MIRROR_TEXTAREA_SHARED_CLASS(
  theme: (typeof VARIANTS)[ThoughtInputVariant],
): string {
  return `${theme.innerPaddingClass} ${theme.textareaClass}`;
}

/**
 * Inline styles whose presence (or absence) likewise affects wrap
 * geometry. Both layers spread this object so the textarea can
 * additionally pin `WebkitTextFillColor: 'transparent'` and its
 * own min/maxHeight without forking the shared keys.
 */
const MIRROR_TEXTAREA_SHARED_STYLE = {
  fontFamily: 'inherit',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'break-word',
} as const;

type MirrorScrollTarget = Pick<HTMLDivElement, 'style'> | null;
type TextareaScrollSource = Pick<HTMLTextAreaElement, 'scrollTop'> | null;
type TextareaResizeSource = Pick<
  HTMLTextAreaElement,
  'scrollHeight' | 'scrollTop' | 'style'
>;

export function syncThoughtInputMirrorScroll(
  textarea: TextareaScrollSource,
  inner: MirrorScrollTarget,
): void {
  if (!textarea || !inner) return;
  inner.style.transform = `translateY(${-textarea.scrollTop}px)`;
}

export function resizeThoughtInputTextareaAndSyncMirror(
  textarea: TextareaResizeSource,
  inner: MirrorScrollTarget,
  minHeightPx: number,
  maxHeightPx: number,
): void {
  // Use `auto`, not `0px`: collapsing a scrolled textarea can make WebKit
  // clamp or adjust scrollTop before restoring height, which desynchronizes
  // the transparent native textarea from the highlighted mirror layer.
  textarea.style.height = 'auto';
  const next = Math.min(textarea.scrollHeight, maxHeightPx);
  textarea.style.height = `${Math.max(next, minHeightPx)}px`;
  syncThoughtInputMirrorScroll(textarea, inner);
}

interface Props {
  onCreated?: (t: Thought) => void;
  /** Launcher-only audio creation action. Text persistence stays independent. */
  onStartRecording?: () => void | Promise<void>;
  recordingBusy?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * Existing tags sorted by frequency. Populates the `#` autocomplete menu.
   * Parent (ThoughtPanel / BrandSection) aggregates this via
   * `useThoughtTagCandidates`; we accept it as a prop so there's one
   * source of truth.
   *
   * **`count === 0` is a sentinel**, not a bug: entries with zero
   * frequency are "known good tag options that no thought has used yet"
   * (most commonly Agent workspace names). Keep them visible — filtering
   * them out would hide brand-new workspaces from the picker and defeat
   * the whole point of the discovery merge.
   */
  existingTags?: Array<[string, number]>;
  /**
   * Initial minimum row count for the textarea. Defaults to 2 (compact
   * Task Center list). Launcher 想法 mode passes 3 to match SimpleChatInput's
   * `LAUNCHER_MIN_LINES`, so the two inputs occupy the same vertical
   * footprint and mode switches don't reflow the page.
   */
  minLines?: number;
  /**
   * Maximum row count the textarea can auto-grow to before internal
   * scroll kicks in. Defaults to 8 for the compact Task Center stream.
   * Launcher 想法 mode passes 12 to match SimpleChatInput's `MAX_LINES`,
   * so the two inputs share the same content-driven ceiling.
   */
  maxLines?: number;
  /**
   * Visual variant — `compact` for the Task Center thought stream (default),
   * `launcher` for Launcher 想法 mode where the input must visually match
   * the Chat input (same radius / shadow / text size / padding).
   */
  variant?: ThoughtInputVariant;
}

export const ThoughtInput = forwardRef<ThoughtInputHandle, Props>(
  function ThoughtInput(
    {
      onCreated,
      onStartRecording,
      recordingBusy = false,
      // Guide-style placeholder — tells new users both *what* to write and
      // *how* to tag it, so the empty state doesn't look like dead space.
      // DESIGN.md §5.2 rules the placeholder color (--ink-muted) which is already
      // applied by the textarea className below.
      placeholder,
      autoFocus = false,
      existingTags = [],
      minLines = 2,
      maxLines = 8,
      variant = 'compact',
    },
    ref,
  ) {
    const { t } = useTranslation('task');
    const theme = VARIANTS[variant];
    const effectivePlaceholder = placeholder ?? t('thoughts.inputPlaceholder');
    // Layout invariant: effective max >= min. Caller-supplied maxLines
    // below minLines would produce a weird "negative growth room" state;
    // clamp up so the textarea always has at least its starting height.
    const effectiveMaxLines = Math.max(maxLines, minLines);
    const textareaMinHeightPx =
      theme.verticalPaddingPx + theme.pxPerLine * minLines;
    const textareaMaxHeightPx =
      theme.verticalPaddingPx + theme.pxPerLine * effectiveMaxLines;
    const [value, setValueState] = useState('');
    const valueRef = useRef('');
    const setValue = useCallback((next: string) => {
      valueRef.current = next;
      setValueState(next);
    }, []);
    const [busy, setBusyState] = useState(false);
    const busyRef = useRef(false);
    const setBusy = useCallback((next: boolean) => {
      busyRef.current = next;
      setBusyState(next);
    }, []);
    const recordingBusyRef = useRef(recordingBusy);
    useLayoutEffect(() => { recordingBusyRef.current = recordingBusy; }, [recordingBusy]);
    const startingRecordingRef = useRef(false);
    const interactionBusy = busy || recordingBusy;
    const [error, setError] = useState<string | null>(null);

    // Tag autocomplete state.
    const [tagMenu, setTagMenu] = useState<{
      anchor: number;
      query: string;
    } | null>(null);
    const [tagIndex, setTagIndex] = useState(0);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const overlayInnerRef = useRef<HTMLDivElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    // Bug #123 mirror: SimpleChatInput skips style writes during IME
    // composition because WebKit + WeChat 输入法 voice input duplicates
    // candidate text when the textarea is restyled mid-composition. Same
    // hazard applies here — both inputs share the launcher 想法 surface.
    const isComposingRef = useRef(false);
    const [resizeBump, setResizeBump] = useState(0);
    const updateLockedRef = useUpdateEditorAdmission(
      'thought-input', cardRef, textareaRef,
      () => !!valueRef.current || isComposingRef.current || busyRef.current || recordingBusyRef.current || startingRecordingRef.current,
      '新建文本记录尚未提交或仍在输入、保存或开始录音，请先处理后再更新；内容已保留。',
    );

    // Imperative focus — exposed through the forwarded ref so parents can
    // drive focus on mode/tab switches. Matches SimpleChatInputHandle.
    useImperativeHandle(
      ref,
      () => ({
        focus: () => textareaRef.current?.focus(),
      }),
      [],
    );
    // Pending caret position — consumed by the useLayoutEffect below after
    // React commits the new value, so `setSelectionRange` runs against the
    // up-to-date DOM instead of racing with rAF.
    const pendingCaretRef = useRef<number | null>(null);

    const segments = useMemo(() => splitWithTagHighlights(value), [value]);

    // Substring (not prefix) match — flomo behaviour; typing "ag" finds
    // "myagents", "tags", etc. Capped at 8 rows.
    const filteredTags = useMemo(() => {
      if (!tagMenu) return [];
      const q = tagMenu.query.toLowerCase();
      const list = q
        ? existingTags.filter(([t]) => t.toLowerCase().includes(q))
        : existingTags;
      return list.slice(0, 8);
    }, [existingTags, tagMenu]);

    useEffect(() => {
      setTagIndex(0);
    }, [tagMenu?.query, tagMenu?.anchor]);

    // Programmatic focus when `autoFocus` flips true. The textarea's
    // `autoFocus` HTML attribute only fires on initial mount, but the
    // TaskCenter tab is a singleton — the user can leave and come back
    // without a remount. `autoFocus` effectively becomes a "focus intent"
    // signal now: each time the parent passes `true` (TaskCenter
    // re-activates) we reassert focus. Guarded by the prop value so
    // `false` transitions don't steal focus from other fields.
    useEffect(() => {
      if (!autoFocus) return;
      // Defer one frame so the focus lands after the tab's layout pass
      // and the textarea is actually part of the visible tree (the
      // hidden-tab branch uses `content-visibility: hidden`).
      const raf = requestAnimationFrame(() => textareaRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }, [autoFocus]);

    // The overlay wrapper is `overflow: hidden` (to clip past the textarea
    // bounds), so setting `scrollTop` on it would no-op. Instead we translate
    // the inner content upward by the textarea's scrollTop — produces the
    // same visual scroll without needing a scrollable overlay container.
    const syncScroll = useCallback(() => {
      syncThoughtInputMirrorScroll(
        textareaRef.current,
        overlayInnerRef.current,
      );
    }, []);

    // Auto-grow the textarea with content. Floor = `minLines`; ceiling =
    // `maxLines` (compact: 8, launcher: 9). Past the ceiling the textarea
    // scrolls internally. Resize and mirror-scroll sync must happen in one
    // layout pass: native textarea geometry changes can adjust scrollTop, and
    // the highlighted mirror has to read that final value (#246).
    useLayoutEffect(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      // Bug #123 — same IME guard SimpleChatInput uses. The post-
      // compositionend handler bumps `resizeBump` so we catch up after commit.
      if (isComposingRef.current) {
        syncScroll();
        return;
      }
      // Skip when the textarea is in a `display:none` subtree (Launcher hides
      // the inactive 对话/想法 mode this way). `scrollHeight` reads as 0 there
      // and the height reset below would lock the height to `minLines` until
      // the user types again. Preserve the last visible height instead.
      if (ta.offsetParent === null) {
        syncScroll();
        return;
      }
      resizeThoughtInputTextareaAndSyncMirror(
        ta,
        overlayInnerRef.current,
        textareaMinHeightPx,
        textareaMaxHeightPx,
      );
    }, [
      value,
      textareaMinHeightPx,
      textareaMaxHeightPx,
      resizeBump,
      syncScroll,
    ]);

    const handleCompositionStart = useCallback(() => {
      if (updateLockedRef.current) return;
      isComposingRef.current = true;
    }, [updateLockedRef]);
    const handleCompositionEnd = useCallback(() => {
      if (updateLockedRef.current) return;
      isComposingRef.current = false;
      setResizeBump((b) => b + 1);
    }, [updateLockedRef]);

    // Consume any pending caret position after React flushes `setValue` to
    // the DOM — safer than `requestAnimationFrame`, which can run before
    // the commit.
    useLayoutEffect(() => {
      const pos = pendingCaretRef.current;
      if (pos === null) return;
      const ta = textareaRef.current;
      if (!ta) return;
      ta.setSelectionRange(pos, pos);
      ta.focus();
      pendingCaretRef.current = null;
    }, [value]);

    const recomputeTagMenu = useCallback(
      (nextValue: string, cursor: number) => {
        setTagMenu(findActiveTagContext(nextValue, cursor));
      },
      [],
    );

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (updateLockedRef.current) { e.target.value = valueRef.current; return; }
        const next = e.target.value;
        setValue(next);
        recomputeTagMenu(next, e.target.selectionStart ?? next.length);
      },
      [recomputeTagMenu, setValue, updateLockedRef],
    );

    const handleSelect = useCallback(() => {
      if (updateLockedRef.current) return;
      const ta = textareaRef.current;
      if (!ta) return;
      recomputeTagMenu(ta.value, ta.selectionStart ?? ta.value.length);
    }, [recomputeTagMenu, updateLockedRef]);

    const insertTag = useCallback(
      (tag: string) => {
        if (updateLockedRef.current || !tagMenu) return;
        const { anchor } = tagMenu;
        // Replace the WHOLE tag body at the anchor — including any chars
        // after the caret that are still valid tag chars — so picking a
        // suggestion while the cursor is mid-word doesn't orphan the tail
        // (e.g. caret in `#abc|def` + pick `#abc` no longer leaves `def`).
        const bodyEnd = tagBodyEndOffset(value, anchor);
        const before = value.slice(0, anchor);
        const after = value.slice(bodyEnd);
        const insertion = `#${tag} `;
        const next = before + insertion + after;
        pendingCaretRef.current = before.length + insertion.length;
        setValue(next);
        setTagMenu(null);
      },
      [tagMenu, value, setValue, updateLockedRef],
    );

    const handleHashButton = useCallback(() => {
      if (updateLockedRef.current) return;
      const ta = textareaRef.current;
      if (!ta) return;
      // Replace any active selection — matches standard form-input
      // semantics when a new character is inserted.
      const start = ta.selectionStart ?? value.length;
      const end = ta.selectionEnd ?? start;
      const prev = start === 0 ? '' : value[start - 1];
      const needsSpace = start > 0 && start === end && !isBoundaryChar(prev);
      const insertion = needsSpace ? ' #' : '#';
      const next = value.slice(0, start) + insertion + value.slice(end);
      const newPos = start + insertion.length;
      pendingCaretRef.current = newPos;
      setValue(next);
      recomputeTagMenu(next, newPos);
    }, [recomputeTagMenu, value, setValue, updateLockedRef]);

    const handleSubmit = useCallback(async () => {
      if (updateLockedRef.current || busyRef.current || startingRecordingRef.current) return;
      const content = value.trim();
      if (!content || interactionBusy) return;
      setBusy(true);
      setError(null);
      try {
        const t = await thoughtCreate(
          { content },
          variant === 'launcher' ? 'launcher_input' : 'task_center',
        );
        setValue('');
        setTagMenu(null);
        onCreated?.(t);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    }, [interactionBusy, onCreated, value, variant, setBusy, setValue, updateLockedRef]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (updateLockedRef.current) return;
        // Skip all custom key handling during IME composition — otherwise
        // pressing Enter to commit a pinyin candidate would instead pick a
        // tag suggestion (or submit).
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;

        if (tagMenu && filteredTags.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setTagIndex((i) => Math.min(filteredTags.length - 1, i + 1));
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setTagIndex((i) => Math.max(0, i - 1));
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            insertTag(filteredTags[tagIndex][0]);
            return;
          }
        }
        if (tagMenu && e.key === 'Escape') {
          e.preventDefault();
          setTagMenu(null);
          return;
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void handleSubmit();
        }
      },
      [tagMenu, filteredTags, tagIndex, insertTag, handleSubmit, updateLockedRef],
    );

    const handleStartRecording = useCallback(async () => {
      if (updateLockedRef.current || busyRef.current || recordingBusyRef.current || startingRecordingRef.current) return;
      startingRecordingRef.current = true;
      try { await onStartRecording?.(); }
      catch (recordingError) { setError(String(recordingError)); }
      finally { startingRecordingRef.current = false; }
    }, [onStartRecording, updateLockedRef]);

    const canSend = value.trim().length > 0 && !interactionBusy;

    return (
      <div className="w-full">
        <div
          ref={cardRef}
          className={`relative flex flex-col border border-[var(--line)] bg-[var(--paper-elevated)] ${theme.focusClass} ${theme.cardClass}`}
        >
          {/* Mirror layer: same text as the textarea but with coloured `#tag`
            runs. Must match the textarea's font metrics so the highlighted
            spans sit under the same glyphs the user is typing.
            `pointer-events: none` keeps clicks reaching the textarea. */}
          <div className={`relative ${theme.outerPaddingClass}`}>
            {/* Overlay clip box — matches textarea bounds (absolute inset-0)
              and hides anything past its edges. The actual text lives in
              an inner `overlayInnerRef` div that gets `translateY(-scrollTop)`
              applied whenever the textarea scrolls, so highlighted spans
              track the real text when the thought is long. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-hidden"
            >
              {/* `paddingWrapper` reproduces the outer's padding INSIDE the
                clip box so the inner text-rendering area exactly matches
                the textarea's bounding box. Without this layer the inner
                used the full clip-box width while the textarea used
                (clip-box - outer-padding); any future textarea-only
                padding addition would have to be added here too or the
                two layers wrap at different characters and the caret
                floats into "mystery" whitespace after the visible mirror
                text. */}
              <div className={theme.outerPaddingClass}>
                <div
                  ref={overlayInnerRef}
                  // `MIRROR_TEXTAREA_SHARED_CLASS` carries every Tailwind/
                  // CSS-token decision that affects glyph layout — padding
                  // inside the box, font size, line-height. The textarea
                  // below applies the EXACT same class (plus its own
                  // appearance/background overrides) so any future style
                  // change here hits both layers in lockstep.
                  className={`${MIRROR_TEXTAREA_SHARED_CLASS(theme)} text-[var(--ink)]`}
                  style={{
                    ...MIRROR_TEXTAREA_SHARED_STYLE,
                    willChange: 'transform', // mirror translateY(-scrollTop) GPU hint
                  }}
                >
                  {segments.map((seg, i) =>
                    seg.type === 'tag' ? (
                      <span
                        key={i}
                        className="rounded-[var(--radius-sm)] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]"
                      >
                        {seg.value}
                      </span>
                    ) : (
                      <span key={i}>{seg.value}</span>
                    ),
                  )}
                  {value.endsWith('\n') && '\u200b'}
                </div>
              </div>
            </div>
            <textarea
              ref={textareaRef}
              value={value}
              readOnly={updateLockedRef.current}
              onChange={handleChange}
              onSelect={handleSelect}
              onClick={handleSelect}
              onKeyDown={handleKeyDown}
              onScroll={syncScroll}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              placeholder={effectivePlaceholder}
              // Height is driven by the `useLayoutEffect` above (2-row
              // minimum, 8-row max, internal scroll past that). We don't
              // set `rows={N}` here because it would re-inject a min-height
              // attribute that fights the JS sizer on first paint.
              disabled={interactionBusy}
              // NB: no HTML `autoFocus` attribute. The `autoFocus` prop
              // drives a `useEffect` above that calls `.focus()` via
              // `requestAnimationFrame` — that effect fires on every
              // `false → true` transition (tab re-activation), which the
              // mount-only HTML attribute cannot do. Keeping both would
              // just double-fire `.focus()` on first mount.
              // The textarea's own text is transparent (mirror layer above
              // renders the glyphs) — but `-webkit-text-fill-color`
              // overrides `::placeholder { color }` in WebKit, so without
              // the `placeholder:[-webkit-text-fill-color:...]` override
              // the placeholder inherits the transparent fill and is
              // invisible. That was the silent bug in the prior rev.
              // `block` is load-bearing: without it, the textarea is a
              // default inline-level replaced element and contributes a
              // baseline descender gap (~3–4px) to its parent's line box.
              // That's invisible when the textarea owns its line (Task
              // Center compact layout looked fine), but in the Launcher
              // variant where the textarea is supposed to be pixel-perfect
              // against SimpleChatInput's `block w-full` textarea, the
              // descender was the residual height difference Codex RCA
              // round 3 identified. `block` collapses the descender gap
              // so the card footprint is truly textarea.height + wrappers.
              //
              // Textarea-specific classes (block layout, transparency to let
              // the mirror layer show through, caret/placeholder colour) +
              // `MIRROR_TEXTAREA_SHARED_CLASS` so geometry stays pinned to
              // the mirror. Editing the geometry props here without also
              // updating the shared helper would re-create the wrap-mismatch
              // / caret-floating-on-mystery-whitespace bug.
              className={`block relative w-full resize-none overflow-y-auto bg-transparent text-transparent caret-[var(--ink)] placeholder:text-[var(--ink-muted)] placeholder:[-webkit-text-fill-color:var(--ink-muted)] focus:outline-none ${MIRROR_TEXTAREA_SHARED_CLASS(theme)}`}
              style={{
                ...MIRROR_TEXTAREA_SHARED_STYLE,
                WebkitTextFillColor: 'transparent',
                minHeight: `${textareaMinHeightPx}px`,
                maxHeight: `${textareaMaxHeightPx}px`,
                // The `useLayoutEffect` above writes `style.height`
                // imperatively each keystroke; this transition smooths the
                // visible growth/shrink. Explicit property list + `height`
                // so shrink animates symmetrically to grow (WebKit textareas
                // sometimes drop the transition on shrink when only one of
                // `min-height` / `height` is listed).
                transitionProperty: 'min-height, max-height, height',
                transitionDuration: '220ms',
                transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                willChange: 'height',
              }}
            />
          </div>

          {/* Tag autocomplete — Escape dismissal is owned by the textarea's
            onKeyDown (sets tagMenu=null explicitly), so we disable the
            Popover's own Escape handler to keep the two paths from
            double-firing. Outside-click close from the primitive is fine
            since textarea clicks are the anchor and don't count as outside. */}
          <Popover
            open={!!tagMenu && filteredTags.length > 0}
            onClose={() => { if (!updateLockedRef.current) setTagMenu(null); }}
            anchorRef={cardRef}
            placement="bottom-start"
            closeOnEscape={false}
            className="w-56 py-1 shadow-md"
          >
            {tagMenu && (
              <div className="px-3 pb-1 pt-0.5 text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
                {tagMenu.query
                  ? t('thoughts.tagMenuMatch', { query: tagMenu.query })
                  : t('thoughts.tagMenuChoose')}
              </div>
            )}
            {filteredTags.map(([tag, n], i) => (
              <button
                key={tag}
                type="button"
                onMouseDown={(e) => {
                  // Prevent textarea blur so the selection state survives.
                  e.preventDefault();
                  insertTag(tag);
                }}
                onMouseEnter={() => { if (!updateLockedRef.current) setTagIndex(i); }}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors ${
                  i === tagIndex
                    ? 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]'
                    : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                }`}
              >
                <span>#{tag}</span>
                <span className="text-xs text-[var(--ink-muted)]/60">{n}</span>
              </button>
            ))}
          </Popover>

          <div
            className={`flex items-center justify-between ${theme.toolbarPaddingClass}`}
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleHashButton}
                disabled={interactionBusy}
                title={t('thoughts.insertTag')}
                className={`rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--accent-warm)] disabled:cursor-not-allowed disabled:opacity-50 ${theme.toolbarButtonPaddingClass}`}
              >
                <HashIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              {onStartRecording && (
                <button
                  type="button"
                  onClick={() => void handleStartRecording()}
                  disabled={interactionBusy}
                  className={`inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--accent-warm)] disabled:cursor-wait disabled:opacity-50 ${
                    variant === 'launcher' ? 'h-8 px-2.5' : 'h-7 px-2'
                  }`}
                >
                  <MicIcon className="h-4 w-4" />
                  <span>
                    {recordingBusy
                      ? t('records.startingRecording')
                      : t('records.startRecording')}
                  </span>
                </button>
              )}
              <Tip
                label={t('thoughts.record')}
                shortcut="⌘ + Enter"
                align="end"
              >
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!canSend || recordingBusy}
                  className={`rounded-lg bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:bg-[var(--ink-muted)]/15 disabled:text-[var(--ink-muted)]/60 ${theme.toolbarButtonPaddingClass}`}
                >
                  <EditIcon className="h-4 w-4" />
                </button>
              </Tip>
            </div>
          </div>
        </div>
        {error && (
          <div className="mt-1.5 text-xs text-[var(--error)]">{error}</div>
        )}
      </div>
    );
  },
);

export default ThoughtInput;
