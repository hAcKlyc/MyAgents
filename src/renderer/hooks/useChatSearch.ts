/**
 * useChatSearch — in-page text finder for the Chat message list.
 *
 * Counts matches against the full message array (so virtualized / off-screen
 * messages are included), then paints CSS Custom Highlight ranges on whatever
 * is currently rendered. Navigation (Next/Prev) jumps to the target message
 * via ChatScrollController when off-screen, then re-paints once the message
 * mounts. A card-pulse animation fires on every navigation so the user knows
 * where they landed even if the precise word highlight isn't paintable (rich
 * content where extracted source text and rendered DOM text diverge — e.g.
 * KaTeX, mention pills, complex tables).
 *
 * Scope is text nodes inside `[data-chat-search-scope]` (each MessageList
 * row wrapper), excluding status timers, permission prompts, split panels.
 * The wrapper now also carries `data-message-id` so we can find the DOM
 * subtree of a specific message when painting "current" highlight.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Message } from '@/types/chat';
import type { ChatScrollController } from '@/hooks/useChatScrollController';

// ── CSS Custom Highlight API types (not yet in lib.dom for all TS versions) ──
//
// Per spec (https://drafts.csswg.org/css-highlight-api-1/):
//   • `CSS.highlights` — global HighlightRegistry on the CSS namespace object
//   • `Highlight`       — global constructor on window / globalThis
// The Highlight constructor is NOT a property of CSS. An earlier version of
// this hook incorrectly looked up `CSS.Highlight`, which is undefined in every
// real browser, so the support check always failed and the feature was dead
// on arrival in packaged builds. Fixed to read `Highlight` from globalThis.
interface HighlightLike {
  clear: () => void;
  add: (range: Range) => void;
  size: number;
}
interface HighlightRegistryLike {
  set: (name: string, highlight: HighlightLike) => void;
  delete: (name: string) => void;
}
interface CssWithHighlights {
  highlights?: HighlightRegistryLike;
}
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;

const HIGHLIGHT_ALL = 'chat-search';
const HIGHLIGHT_CURRENT = 'chat-search-current';
const SCOPE_ATTR = 'data-chat-search-scope';
const MESSAGE_ID_ATTR = 'data-message-id';
const PULSE_CLASS = 'chat-search-msg-pulse';
const DEBOUNCE_MS = 150;
// Bounded retry window after controller-owned virtualized navigation. Complex Markdown/tool
// rows can take more than a couple of animation frames to mount and paint; a
// short time budget keeps navigation reliable without creating an unbounded
// polling loop.
const PAINT_RETRY_TIMEOUT_MS = 1200;

function getCssHighlights(): CssWithHighlights | null {
  if (typeof CSS === 'undefined') return null;
  return CSS as unknown as CssWithHighlights;
}

function getHighlightCtor(): HighlightCtor | null {
  if (typeof globalThis === 'undefined') return null;
  const ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  return typeof ctor === 'function' ? ctor : null;
}

export function isHighlightApiSupported(): boolean {
  const css = getCssHighlights();
  return !!(css && css.highlights) && !!getHighlightCtor();
}

/**
 * Inject the ::highlight() CSS rules + the card-pulse animation at runtime.
 *
 * ::highlight() rules cannot live in index.css because LightningCSS (Tailwind
 * v4's CSS optimizer, ≤1.30.2 at time of writing) emits a warning for every
 * occurrence during build. Runtime injection sidesteps the build-time parser
 * — the browser's own CSS engine handles ::highlight() correctly. The pulse
 * animation is kept here too so the whole search feature ships as one CSS
 * payload, idempotent.
 */
const STYLE_ELEMENT_ID = 'chat-search-highlight-styles';
function ensureHighlightStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  // Build the selector via string concat to keep the literal "::highlight("
  // out of any future static-analysis passes that might also choke on it.
  // The Highlight pseudo-element spec only allows color / background-color /
  // text-decoration / text-shadow on live ranges — font-weight / padding /
  // border-radius from the file-search mark aren't paintable here.
  const hl = '::' + 'highlight';
  style.textContent = `
    ${hl}(chat-search) {
      background-color: color-mix(in srgb, var(--accent) 30%, transparent);
      color: var(--ink);
    }
    ${hl}(chat-search-current) {
      background-color: var(--accent);
      color: var(--on-accent);
    }
    @keyframes chat-search-msg-pulse {
      0%   {
        box-shadow: 0 0 0 2px var(--accent), 0 0 16px 4px color-mix(in srgb, var(--accent) 30%, transparent);
        background-color: color-mix(in srgb, var(--accent) 8%, transparent);
      }
      100% {
        box-shadow: 0 0 0 0 transparent;
        background-color: transparent;
      }
    }
    [${SCOPE_ATTR}].${PULSE_CLASS} {
      animation: chat-search-msg-pulse 1.4s ease-out;
      border-radius: 0.5rem;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Extract the searchable text representation of a message. This is the
 * authoritative source for `matchCount` — including for virtualized messages
 * that aren't in DOM.
 *
 * v1 scope: TEXT BLOCKS ONLY (plus string-typed content). Deliberately excludes:
 *   • thinking blocks    — collapsed-by-default, body is unmounted
 *   • tool_use cards     — input/result is collapsed; tool.result may be
 *                          truncated at render time (ToolUse.tsx 50k/200k
 *                          caps); counter inclusion would inflate matchCount
 *                          with characters the user can never see
 *   • server_tool_use    — same reasoning as tool_use
 *
 * Searching inside thinking / tool I/O is out of scope for v1: the
 * source-vs-DOM divergence makes occurrence indexing unreliable and the
 * counter untrustworthy. If/when needed, the right fix is to either count
 * what the Message component will display (not raw source) or auto-expand
 * collapsed rows during navigation.
 *
 * Markdown source vs rendered DOM divergence note: text blocks return raw
 * markdown source, not the rendered text. For plain prose this is identical
 * to the DOM. For markdown syntax characters (`**`, `_`, `#`) source count
 * may slightly exceed DOM count. When that happens the current-match Range
 * lookup falls back to "card pulse only" — user still lands in the right
 * message, just without a precise word highlight.
 */
function extractMessageSearchText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text' && block.text) parts.push(block.text);
  }
  return parts.join('\n');
}

/** Count case-insensitive (non-overlapping) occurrences of needle in haystack. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const hay = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let from = 0;
  while (from <= hay.length - n.length) {
    const idx = hay.indexOf(n, from);
    if (idx === -1) break;
    count += 1;
    from = idx + n.length;
  }
  return count;
}

/** Build Range objects for every case-insensitive match of `query` within `scope`. */
function buildRangesInScope(scope: Element, query: string): Range[] {
  if (!query) return [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue;
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (parent) {
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const ranges: Range[] = [];
  const needle = query.toLowerCase();
  const needleLen = needle.length;
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const text = node.nodeValue;
    if (text) {
      const hay = text.toLowerCase();
      let from = 0;
      while (from <= hay.length - needleLen) {
        const idx = hay.indexOf(needle, from);
        if (idx === -1) break;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needleLen);
        ranges.push(range);
        from = idx + needleLen;
      }
    }
    current = walker.nextNode();
  }
  return ranges;
}

/**
 * Walk ancestors from `start` up to `stop` (exclusive) and clear inline
 * maxHeight / overflow clipping so a highlighted match inside a collapsed
 * container becomes visible. React owns these inline styles, so any later
 * re-render of the owning component will restore them — that's fine.
 */
function uncollapseAncestors(start: Element | null, stop: Element | null): void {
  let el: Element | null = start;
  while (el && el !== stop) {
    if (el instanceof HTMLElement) {
      if (el.style.maxHeight) el.style.maxHeight = 'none';
      if (el.style.overflow === 'hidden') el.style.overflow = 'visible';
    }
    el = el.parentElement;
  }
}

/** Scroll `scroller` so the center of `target` (Range or Element) lands at the scroller's vertical center. */
function scrollIntoCenter(scroller: HTMLElement, target: Range | Element): void {
  const rect = target.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0) {
    if (target instanceof Element) target.scrollIntoView({ block: 'center' });
    return;
  }
  const targetCenter = rect.top + rect.height / 2;
  const scrollerCenter = scrollerRect.top + scrollerRect.height / 2;
  scroller.scrollBy({ top: targetCenter - scrollerCenter });
}

/** Find the scope wrapper element for `messageId` under `scroller`. */
function findMessageScope(scroller: HTMLElement, messageId: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(
    `[${SCOPE_ATTR}][${MESSAGE_ID_ATTR}="${CSS.escape(messageId)}"]`,
  );
}

/**
 * Restart the card-pulse animation on `scope`. Standard CSS animation restart
 * trick: drop the class, force reflow, re-add. Works regardless of how many
 * times navigation lands on the same message in a row.
 */
function pulseMessageCard(scope: HTMLElement): void {
  scope.classList.remove(PULSE_CLASS);
  // Force reflow so the next class addition starts a fresh animation cycle.
  void scope.offsetWidth;
  scope.classList.add(PULSE_CLASS);
}

interface MessageMatchSummary {
  /** Index into the `messages` prop. */
  messageIndex: number;
  messageId: string;
  /** Non-overlapping occurrence count for this message. */
  count: number;
}

interface MatchPosition {
  messageIndex: number;
  messageId: string;
  /** 0-based occurrence index within the owning message. */
  occInMessage: number;
}

/** Resolve a flat global match index into per-message coordinates. */
function resolveFlatIndex(
  summaries: MessageMatchSummary[],
  flatIdx: number,
): MatchPosition | null {
  if (flatIdx < 0) return null;
  let remaining = flatIdx;
  for (const s of summaries) {
    if (remaining < s.count) {
      return { messageIndex: s.messageIndex, messageId: s.messageId, occInMessage: remaining };
    }
    remaining -= s.count;
  }
  return null;
}

export interface UseChatSearchOptions {
  scrollerRef: React.RefObject<HTMLElement | null>;
  /** Full message list (history + streaming combined) — drives the count. */
  messages: readonly Message[];
  /** Controller-owned message navigation. */
  scrollToMessage: ChatScrollController['scrollToMessage'];
  /** Mounted ranges still need to enter controller-owned reading mode. */
  pauseAutoScroll: ChatScrollController['pauseAutoScroll'];
  /** When true, the hook is active: scan + paint highlights. */
  active: boolean;
}

export interface ChatSearchController {
  query: string;
  setQuery: (value: string) => void;
  matchCount: number;
  currentIndex: number; // 0-based; -1 when no matches
  next: () => void;
  prev: () => void;
  /** True if the Highlight API is available in this environment. */
  supported: boolean;
  hasQuery: boolean;
}

let paintedBy: symbol | null = null;

export function useChatSearch({
  scrollerRef,
  messages,
  scrollToMessage,
  pauseAutoScroll,
  active,
}: UseChatSearchOptions): ChatSearchController {
  const [query, setQueryState] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);

  // Refs mirror state for use in imperative callbacks without stale closures.
  const currentIndexRef = useRef(-1);
  const queryRef = useRef('');
  // Writing to a ref during render is flagged by `react-hooks/refs`, but the
  // value is pure — same value React will commit — so StrictMode double-
  // invocation is a no-op. Mirrors `query` so navigation callbacks can read
  // the latest value without depending on it (and thus re-creating).
  queryRef.current = query;
  const messagesRef = useRef(messages);
  // Same justification as queryRef above.
  messagesRef.current = messages;
  const scrollToMessageRef = useRef(scrollToMessage);
  scrollToMessageRef.current = scrollToMessage;
  const pauseAutoScrollRef = useRef(pauseAutoScroll);
  pauseAutoScrollRef.current = pauseAutoScroll;
  const summariesRef = useRef<MessageMatchSummary[]>([]);
  const focusRequestIdRef = useRef(0);
  const supported = useMemo(() => {
    const ok = isHighlightApiSupported();
    if (ok) ensureHighlightStyles();
    return ok;
  }, []);

  const owner = useRef(Symbol('chat-search'));
  const occurrences = useRef({ query: '', counts: new WeakMap<Message, number>() });
  const clearHighlights = useCallback(() => {
    if (paintedBy !== owner.current) return;
    paintedBy = null;
    const css = getCssHighlights();
    if (!css?.highlights) return;
    css.highlights.delete(HIGHLIGHT_ALL);
    css.highlights.delete(HIGHLIGHT_CURRENT);
  }, []);

  /**
   * Paint all visible ranges (the "all" highlight) + the current match (the
   * "current" highlight). `currentDomRange` is the resolved DOM Range for the
   * focused match, or null if it isn't currently in DOM (off-screen virtualized
   * or rich-content miss). When null, the current match isn't drawn — the
   * card-pulse animation visually communicates the jump instead.
   */
  const paintAllAndCurrent = useCallback(
    (currentDomRange: Range | null) => {
      const css = getCssHighlights();
      const HighlightImpl = getHighlightCtor();
      if (!css?.highlights || !HighlightImpl) return;
      const scroller = scrollerRef.current;
      const q = queryRef.current;
      paintedBy = owner.current;
      css.highlights.delete(HIGHLIGHT_ALL);
      css.highlights.delete(HIGHLIGHT_CURRENT);
      if (!scroller || !q) return;
      const scopes = scroller.querySelectorAll<HTMLElement>(`[${SCOPE_ATTR}]`);
      const others: Range[] = [];
      for (const scope of scopes) {
        const ranges = buildRangesInScope(scope, q);
        for (const r of ranges) {
          if (currentDomRange && rangesEqual(r, currentDomRange)) continue;
          others.push(r);
        }
      }
      if (others.length > 0) {
        css.highlights.set(HIGHLIGHT_ALL, new HighlightImpl(...others));
      }
      if (currentDomRange) {
        css.highlights.set(HIGHLIGHT_CURRENT, new HighlightImpl(currentDomRange));
      }
    },
    [scrollerRef],
  );

  /**
   * Resolve the current focused match (currentIndexRef) to a DOM Range if
   * the message is rendered AND the n-th occurrence is locatable. Returns
   * null if the message scope isn't in DOM yet or the rendered text doesn't
   * carry that many matches (rich-content divergence).
   */
  const resolveCurrentRange = useCallback((): Range | null => {
    const pos = resolveFlatIndex(summariesRef.current, currentIndexRef.current);
    if (!pos) return null;
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const scope = findMessageScope(scroller, pos.messageId);
    if (!scope) return null;
    const ranges = buildRangesInScope(scope, queryRef.current);
    return ranges[pos.occInMessage] ?? null;
  }, [scrollerRef]);

  /**
   * Recompute match summaries from the messages array + current query. This
   * is the single source of truth for `matchCount`; the DOM paint pass below
   * is purely visual.
   */
  const recomputeSummaries = useCallback(() => {
    const q = queryRef.current;
    if (!active || !supported || !q) {
      summariesRef.current = [];
      return 0;
    }
    if (occurrences.current.query !== q) {
      occurrences.current = { query: q, counts: new WeakMap() };
    }
    const { counts } = occurrences.current;
    const msgs = messagesRef.current;
    const summaries: MessageMatchSummary[] = [];
    let total = 0;
    for (let i = 0; i < msgs.length; i += 1) {
      const m = msgs[i];
      let count = counts.get(m);
      if (count === undefined) {
        count = countOccurrences(extractMessageSearchText(m), q);
        counts.set(m, count);
      }
      if (count > 0) {
        summaries.push({ messageIndex: i, messageId: m.id, count });
        total += count;
      }
    }
    summariesRef.current = summaries;
    return total;
  }, [active, supported]);

  /**
   * Reconcile after `messages` / `query` / scroll / mutation changes:
   *  1. Recompute summaries + total from the messages array
   *  2. Preserve the user's focus position when possible (by messageId +
   *     occInMessage); else clamp to a valid position
   *  3. Re-paint based on what's currently in DOM
   */
  const reconcile = useCallback(
    ({ resetFocus }: { resetFocus: boolean }) => {
      if (!active || !supported) {
        summariesRef.current = [];
        currentIndexRef.current = -1;
        setMatchCount(0);
        setCurrentIndex(-1);
        clearHighlights();
        return;
      }
      // Capture the prior focus before recompute so we can try to preserve it.
      const priorFlat = currentIndexRef.current;
      const priorPos = resolveFlatIndex(summariesRef.current, priorFlat);

      const total = recomputeSummaries();
      let nextFlat: number;
      if (total === 0) {
        nextFlat = -1;
      } else if (resetFocus || !priorPos) {
        nextFlat = 0;
      } else {
        // Try to re-locate the same (messageId, occInMessage) in the new summaries.
        const newSummaryIdx = summariesRef.current.findIndex(s => s.messageId === priorPos.messageId);
        if (newSummaryIdx === -1) {
          nextFlat = 0;
        } else {
          const offset = summariesRef.current.slice(0, newSummaryIdx).reduce((acc, s) => acc + s.count, 0);
          const newCount = summariesRef.current[newSummaryIdx].count;
          const occ = Math.min(priorPos.occInMessage, newCount - 1);
          nextFlat = offset + occ;
        }
      }
      currentIndexRef.current = nextFlat;
      setMatchCount(total);
      setCurrentIndex(nextFlat);
      paintAllAndCurrent(resolveCurrentRange());
    },
    [active, supported, clearHighlights, recomputeSummaries, paintAllAndCurrent, resolveCurrentRange],
  );

  // ── Two debounced paths ──
  // Recompute path: query / messages changed → re-extract summaries (O(messages))
  //                 + repaint
  // Repaint path:   scroll / DOM mutation → just rebuild visible Ranges and
  //                 paint. Summaries don't change because messages didn't change.
  // Sharing one debounce timer would make the cheaper repaint pay the recompute
  // cost on every scroll tick in a 500-message session.
  const recomputeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repaintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRecompute = useCallback(
    (resetFocus: boolean) => {
      if (recomputeTimerRef.current !== null) {
        if (!resetFocus) return;
        clearTimeout(recomputeTimerRef.current);
      }
      recomputeTimerRef.current = setTimeout(() => {
        recomputeTimerRef.current = null;
        reconcile({ resetFocus });
      }, DEBOUNCE_MS);
    },
    [reconcile],
  );

  const scheduleRepaint = useCallback(() => {
    if (repaintTimerRef.current !== null) return;
    repaintTimerRef.current = setTimeout(() => {
      repaintTimerRef.current = null;
      if (!active || !supported) return;
      paintAllAndCurrent(resolveCurrentRange());
    }, DEBOUNCE_MS);
  }, [active, supported, paintAllAndCurrent, resolveCurrentRange]);

  // Query change → recompute + reset focus to first match.
  useEffect(() => {
    if (!active) return;
    scheduleRecompute(true);
    return () => {
      if (recomputeTimerRef.current) {
        clearTimeout(recomputeTimerRef.current);
        recomputeTimerRef.current = null;
      }
    };
  }, [active, query, scheduleRecompute]);

  // Messages-array change (streaming, history append, rewind) → recompute,
  // preserve focus via (messageId, occInMessage) re-anchoring.
  useEffect(() => {
    if (!active) return;
    scheduleRecompute(false);
  }, [active, messages, scheduleRecompute]);

  // Scroll + DOM mutations: Virtuoso unmounts off-screen items and streaming
  // appends new content. Re-paint so Ranges stay live, but DON'T re-sum the
  // messages array — that count is invariant under scroll.
  useEffect(() => {
    if (!active) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    scroller.addEventListener('scroll', scheduleRepaint, { passive: true });
    const mo = new MutationObserver(scheduleRepaint);
    mo.observe(scroller, { childList: true, characterData: true, subtree: true });
    return () => {
      scroller.removeEventListener('scroll', scheduleRepaint);
      mo.disconnect();
    };
  }, [active, scrollerRef, scheduleRepaint]);

  // Clear highlights on deactivation / unmount.
  useEffect(() => {
    if (!active) {
      occurrences.current = { query: '', counts: new WeakMap() };
      focusRequestIdRef.current += 1;
      clearHighlights();
    }
    return () => {
      focusRequestIdRef.current += 1;
      clearHighlights();
      if (recomputeTimerRef.current) {
        clearTimeout(recomputeTimerRef.current);
        recomputeTimerRef.current = null;
      }
      if (repaintTimerRef.current) {
        clearTimeout(repaintTimerRef.current);
        repaintTimerRef.current = null;
      }
    };
  }, [active, clearHighlights]);

  /**
   * Land on the focused match: pulse the card, then paint + scroll the precise
   * Range into view. If the message is off-screen, jump via Virtuoso first,
   * then retry the DOM lookup once it mounts.
   */
  const focusCurrent = useCallback(() => {
    const focusRequestId = ++focusRequestIdRef.current;
    const pos = resolveFlatIndex(summariesRef.current, currentIndexRef.current);
    if (!pos) {
      paintAllAndCurrent(null);
      return;
    }
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const tryPaintAndScroll = (): boolean => {
      const scope = findMessageScope(scroller, pos.messageId);
      if (!scope) return false;
      // Mounting is complete. Release that index transaction before native
      // Range positioning, including when no geometric correction is needed.
      pauseAutoScrollRef.current();
      const ranges = buildRangesInScope(scope, queryRef.current);
      const target = ranges[pos.occInMessage] ?? null;
      paintAllAndCurrent(target);
      // Card pulse fires regardless of whether we located the precise Range —
      // it's the consistent "you arrived here" signal across plain text +
      // rich content (where the precise Range may not be findable).
      pulseMessageCard(scope);
      if (target) {
        const parent = target.startContainer.parentElement;
        if (parent) uncollapseAncestors(parent, scroller);
        scrollIntoCenter(scroller, target);
      } else {
        scrollIntoCenter(scroller, scope);
      }
      return true;
    };

    if (tryPaintAndScroll()) return;

    // Off-screen: ask the scroll controller to mount the row, then retry.
    const isCurrentNavigation = scrollToMessageRef.current(pos.messageId, {
      behavior: 'auto',
      align: 'center',
    });
    const startedAt = Date.now();
    const retry = () => {
      if (focusRequestIdRef.current !== focusRequestId || !isCurrentNavigation?.()) return;
      const selected = resolveFlatIndex(summariesRef.current, currentIndexRef.current);
      if (selected?.messageId !== pos.messageId || selected.occInMessage !== pos.occInMessage) return;
      if (tryPaintAndScroll()) return;
      if (Date.now() - startedAt >= PAINT_RETRY_TIMEOUT_MS) {
        // Give up the precise paint; the pulse + scroll already landed the
        // user in the right neighbourhood when controller navigation eventually
        // commits, and the MutationObserver-driven reconcile will pick up
        // the row's Ranges on the next paint cycle.
        return;
      }
      requestAnimationFrame(retry);
    };
    requestAnimationFrame(retry);
  }, [scrollerRef, paintAllAndCurrent]);

  const next = useCallback(() => {
    const total = summariesRef.current.reduce((acc, s) => acc + s.count, 0);
    if (total === 0) return;
    const nextIdx = (currentIndexRef.current + 1) % total;
    currentIndexRef.current = nextIdx;
    setCurrentIndex(nextIdx);
    focusCurrent();
  }, [focusCurrent]);

  const prev = useCallback(() => {
    const total = summariesRef.current.reduce((acc, s) => acc + s.count, 0);
    if (total === 0) return;
    const cur = currentIndexRef.current;
    const nextIdx = cur - 1 < 0 ? total - 1 : cur - 1;
    currentIndexRef.current = nextIdx;
    setCurrentIndex(nextIdx);
    focusCurrent();
  }, [focusCurrent]);

  const setQuery = useCallback((value: string) => {
    if (queryRef.current === value) return;
    focusRequestIdRef.current += 1;
    summariesRef.current = [];
    currentIndexRef.current = -1;
    setMatchCount(0);
    setCurrentIndex(-1);
    clearHighlights();
    setQueryState(value);
  }, [clearHighlights]);

  return {
    query,
    setQuery,
    matchCount,
    currentIndex,
    next,
    prev,
    supported,
    hasQuery: query.length > 0,
  };
}

// Range equality — same start container / start offset / end offset is enough
// for our case (two Ranges built from the same TreeWalker pass are identical
// iff they share these three). Avoids the cost of compareBoundaryPoints which
// allocates internally.
function rangesEqual(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer
    && a.startOffset === b.startOffset
    && a.endContainer === b.endContainer
    && a.endOffset === b.endOffset
  );
}
