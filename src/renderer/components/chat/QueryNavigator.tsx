// Query Navigator — floating right-side panel for quick session query navigation
// Unified row design: dashes are always visible in the same position.
// On hover, text labels slide in from the right — dashes stay anchored.

import { memo, useLayoutEffect, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Message } from '../../types/chat';
import { parseLeadingSystemReminder } from '../../../shared/systemReminder';

/** Minimum user queries to show the navigator */
const MIN_QUERIES = 3;

interface QueryNavigatorProps {
  messages: readonly Message[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  pauseAutoScroll: () => void;
  /** Virtuoso-aware navigation: scrolls to message by ID even if virtualized (not in DOM) */
  onNavigateToQuery?: (messageId: string) => void;
}

/** Extract plain text preview from message content */
function getQueryText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    const textBlock = msg.content.find(
      (b): b is { type: 'text'; text: string } => b.type === 'text',
    );
    return textBlock?.text ?? '';
  }
  return '';
}

/** Extract the real user query from a mixed system-reminder + user message. */
function getVisibleQueryText(text: string): string {
  const trimmed = text.trim();
  const reminder = parseLeadingSystemReminder(trimmed);
  if (reminder.hasReminder) return reminder.visibleText;
  return text;
}

/** Match Message.tsx's non-bubble system render paths. */
function isNonUserQueryMessage(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('<local-command-stdout>') ||
    getVisibleQueryText(trimmed).trim() === ''
  );
}

function createQuerySelector() {
  let previous: { id: string; text: string }[] = [];
  return (messages: readonly Message[]) => {
    const next = messages.flatMap(message => {
      if (message.role !== 'user') return [];
      const text = getVisibleQueryText(getQueryText(message));
      return text.trim() && !isNonUserQueryMessage(text) ? [{ id: message.id, text }] : [];
    });
    if (previous.length !== next.length || next.some((row, i) =>
      row.id !== previous[i].id || row.text !== previous[i].text)) previous = next;
    return previous;
  };
}

const QueryNavigator = memo(function QueryNavigator({
  messages,
  scrollContainerRef,
  pauseAutoScroll,
  onNavigateToQuery,
}: QueryNavigatorProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600, row: 34 });

  const listRef = useRef<HTMLDivElement>(null);


  const selectQueries = useMemo(() => createQuerySelector(), []);
  const queries = useMemo(() => selectQueries(messages), [messages, selectQueries]);

  // Clamp activeIndex to valid range (handles session switch, query list shrink)
  const queryIndices = useMemo(() => new Map(queries.map((q, i) => [q.id, i])), [queries]);
  const activeIndex = activeId ? queryIndices.get(activeId) ?? -1 : -1;
  const focusedIndex = focusedId ? queryIndices.get(focusedId) ?? -1 : -1;
  const hasRail = queries.length >= MIN_QUERIES;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!hasRail || !list) return;
    const measure = () => {
      const row = list.querySelector('button')?.getBoundingClientRect().height || 34;
      setViewport({ top: list.scrollTop, height: list.clientHeight || 600, row });
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(list);
    const first = list.querySelector('button');
    if (first) observer?.observe(first);
    return () => observer?.disconnect();
  }, [hasRail, isExpanded]);

  // Track active query via IntersectionObserver.
  // With virtualization, elements mount/unmount as the user scrolls. A MutationObserver
  // watches for child changes in the container and re-observes any new user message elements.
  const visibleIndicesRef = useRef(new Set<number>());

  useEffect(() => {
    visibleIndicesRef.current.clear();

    if (queries.length < MIN_QUERIES) return;
    const container = scrollContainerRef.current;
    if (!container) return;


    const observedElements = new WeakSet<Element>();
    const visibleSet = visibleIndicesRef.current;

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const messageId = el.getAttribute('data-message-id');
          if (!messageId) continue;
          const qIndex = queryIndices.get(messageId);
          if (qIndex === undefined) continue;

          if (entry.isIntersecting) {
            visibleSet.add(qIndex);
          } else {
            visibleSet.delete(qIndex);
          }
        }

        if (visibleSet.size > 0) {
          setActiveId(queries[Math.min(...visibleSet)].id);
        }
      },
      {
        root: container,
        rootMargin: '0px 0px -60% 0px',
        threshold: 0,
      },
    );

    // Observe all currently-visible user elements
    const observeUserElements = () => {
      const userElements = container.querySelectorAll<HTMLElement>('[data-role="user"]');
      userElements.forEach((el) => {
        if (!observedElements.has(el)) {
          observedElements.add(el);
          intersectionObserver.observe(el);
        }
      });
    };

    observeUserElements();

    // Re-observe when virtuoso mounts/unmounts elements (DOM subtree changes).
    // Debounce: streaming causes 100+ mutations/sec (token appends, markdown renders).
    // Batch into a single querySelectorAll scan per 100ms window.
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const mutationObserver = new MutationObserver(() => {
      if (debounceTimer) return; // Already scheduled
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        observeUserElements();
      }, 100);
    });
    mutationObserver.observe(container, { childList: true, subtree: true });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      intersectionObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [queries, queryIndices, scrollContainerRef]);

  // Auto-scroll the panel to keep active item visible
  useEffect(() => {
    const list = listRef.current;
    if (!isExpanded || activeIndex < 0 || !list) return;
    const top = activeIndex * viewport.row;
    if (top < list.scrollTop || top + viewport.row > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: Math.max(0, top - (list.clientHeight - viewport.row) / 2), behavior: 'smooth' });
    }
  }, [isExpanded, activeIndex, viewport.row]);

  // Navigate to a query — prefer virtuoso-aware navigation (handles virtualized messages)
  const handleQueryClick = useCallback(
    (queryId: string) => {
      // Virtuoso path: scroll by index even if the message is not in the DOM
      if (onNavigateToQuery) {
        onNavigateToQuery(queryId);
        return;
      }

      // Fallback: direct DOM scroll (for non-virtualized contexts)
      const container = scrollContainerRef.current;
      if (!container) return;

      const target = container.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(queryId)}"]`,
      );
      if (!target) return;

      pauseAutoScroll();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [scrollContainerRef, pauseAutoScroll, onNavigateToQuery],
  );

  if (queries.length < MIN_QUERIES) return null;

  const start = Math.min(queries.length - 1, Math.max(0, Math.floor(viewport.top / viewport.row) - 3));
  const end = Math.min(queries.length, start + Math.ceil(viewport.height / viewport.row) + 7);
  const mounted = Array.from({ length: end - start }, (_, offset) => start + offset);
  if (focusedIndex >= 0 && (focusedIndex < start || focusedIndex >= end)) mounted.push(focusedIndex);
  if (isExpanded && !mounted.includes(0)) mounted.unshift(0);
  if (isExpanded && !mounted.includes(queries.length - 1)) mounted.push(queries.length - 1);
  mounted.sort((a, b) => a - b);
  return (
    <div
      className="absolute right-4 top-0 bottom-0 z-30 hidden md:flex items-center pointer-events-none"
    >
      {/* Single unified container — dashes always anchored right, text slides in */}
      <div
        aria-hidden={!isExpanded}
        onMouseEnter={() => setIsExpanded(true)}
        onMouseLeave={() => setIsExpanded(false)}
        className={`pointer-events-auto relative max-h-[60vh] overflow-hidden transition-[width,background-color,border-color,box-shadow] duration-200 ${
          isExpanded
            ? 'w-72 rounded-xl border border-[var(--line)] shadow-lg'
            : 'w-5 border border-transparent'
        }`}
        style={isExpanded ? {
          background: 'var(--paper-elevated)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        } : undefined}
      >
        {/* Top fade mask */}
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-5 transition-opacity duration-200 ${
            isExpanded ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ background: 'linear-gradient(to bottom, var(--paper-elevated), var(--paper-elevated-a0))' }}
        />

        {/* Scrollable list — each row: [text (conditional)] + [dash (always)] */}
        <div
          ref={listRef}
          onScroll={event => {
            const top = event.currentTarget.scrollTop;
            setViewport(previous => previous.top === top ? previous : { ...previous, top });
          }}
          className="overflow-y-auto max-h-[60vh] py-3"
        >
          <div className="relative" style={{ height: queries.length * viewport.row }}>
          {mounted.map(i => {
            const q = queries[i];
            const isActive = i === activeIndex;
            return (
              <button
                key={q.id}
                data-query-index={i}
                style={{ position: 'absolute', top: i * viewport.row }}
                onFocus={() => setFocusedId(q.id)}
                onBlur={() => setFocusedId(null)}
                onKeyDown={event => {
                  if (event.key !== 'Tab' || !isExpanded) return;
                  const next = i + (event.shiftKey ? -1 : 1);
                  const list = listRef.current;
                  if (!list || next < 0 || next >= queries.length || list.querySelector(`[data-query-index="${next}"]`)) return;
                  event.preventDefault();
                  list.scrollTop = next * viewport.row;
                  setViewport(previous => ({ ...previous, top: list.scrollTop }));
                  requestAnimationFrame(() => {
                    if (list.contains(document.activeElement)) list.querySelector<HTMLButtonElement>(`[data-query-index="${next}"]`)?.focus();
                  });
                }}
                type="button"
                tabIndex={isExpanded ? 0 : -1}
                onClick={() => isExpanded && handleQueryClick(q.id)}
                className={`flex w-full items-center gap-1.5 py-[5px] text-left transition-colors ${
                  isExpanded
                    ? `px-3 cursor-pointer rounded-lg ${isActive ? 'bg-[var(--hover-bg)]' : 'hover:bg-[var(--hover-bg)]'}`
                    : 'px-0 cursor-default justify-end'
                }`}
              >
                {/* Query text — only visible when expanded */}
                <span
                  className={`flex-1 truncate text-sm leading-6 transition-opacity duration-200 ${
                    isExpanded ? 'opacity-100' : 'opacity-0 w-0 overflow-hidden'
                  } ${isActive ? 'text-[var(--accent)] font-medium' : 'text-[var(--ink-muted)]'}`}
                >
                  {q.text}
                </span>

                {/* Dash — always visible, same position */}
                <span
                  className={`flex-shrink-0 rounded-full transition-all duration-150 ${
                    isActive
                      ? 'w-[10px] h-[3px] bg-[var(--accent)]'
                      : isExpanded
                        ? 'w-[8px] h-[2px] bg-[var(--ink-faint)]'
                        : 'w-[8px] h-[2px] bg-[var(--ink-faint)] opacity-40'
                  } ${isExpanded ? 'mr-1' : 'mr-1.5'}`}
                />
              </button>
            );
          })}
          </div>
        </div>

        {/* Bottom fade mask */}
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-5 transition-opacity duration-200 ${
            isExpanded ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ background: 'linear-gradient(to top, var(--paper-elevated), var(--paper-elevated-a0))' }}
        />
      </div>
    </div>
  );
});

export default QueryNavigator;
