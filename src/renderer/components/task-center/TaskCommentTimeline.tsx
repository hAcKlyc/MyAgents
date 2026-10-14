import { useUpdateEditorAdmission } from '@/hooks/useUpdateEditorAdmission';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ReplyIcon,
  LoaderIcon,
  UndoIcon,
  SendIcon,
  CloseIcon,
} from '@/components/icons';
import { useTranslation } from "react-i18next";

import {
  taskCreateUserComment,
  taskGetCommentContext,
  taskListComments,
  taskRetryComment,
} from "@/api/taskCenter";
import Markdown from "@/components/Markdown";
import { listenWithCleanup } from "@/utils/tauriListen";
import { CUSTOM_EVENTS } from "@/../shared/constants";
import type { Task } from "@/../shared/types/task";
import type {
  TaskComment,
  TaskCommentReplySummary,
} from "@/../shared/types/taskComment";
import { extractErrorMessage } from "./errors";

interface Props {
  task: Task;
  targetCommentId?: string | null;
  onTargetReady?: (found: boolean) => void;
  agentLabel?: string | null;
  onBeforeOpenSession?: () => void;
  children?: ReactNode;
}

const COMPOSER_MAX_HEIGHT_PX = 144;

function mergeReplyParents(
  current: TaskCommentReplySummary[],
  incoming: TaskCommentReplySummary[] | undefined,
): TaskCommentReplySummary[] {
  if (!incoming?.length) return current;
  const merged = new Map(
    current.map((summary) => [summary.commentId, summary]),
  );
  for (const summary of incoming) merged.set(summary.commentId, summary);
  return [...merged.values()];
}

export function TaskCommentTimeline({
  task,
  targetCommentId,
  onTargetReady,
  agentLabel,
  onBeforeOpenSession,
  children,
}: Props) {
  const { t, i18n } = useTranslation("task");
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>();
  const [nextAfter, setNextAfter] = useState<string | undefined>();
  const [replyParents, setReplyParents] = useState<TaskCommentReplySummary[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [body, setBodyState] = useState("");
  const bodyRef = useRef("");
  const setBody = useCallback((value: string) => {
    bodyRef.current = value;
    setBodyState(value);
  }, []);
  const [replyTo, setReplyToState] = useState<TaskComment | null>(null);
  const replyToRef = useRef<TaskComment | null>(null);
  const setReplyTo = useCallback((value: TaskComment | null) => {
    replyToRef.current = value;
    setReplyToState(value);
  }, []);
  const [sending, setSendingState] = useState(false);
  const sendingRef = useRef(false);
  const setSending = useCallback((value: boolean) => {
    sendingRef.current = value;
    setSendingState(value);
  }, []);
  const retryingRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const updateLockedRef = useUpdateEditorAdmission(
    'task-comment', timelineRef, textareaRef,
    () => !!bodyRef.current || !!replyToRef.current || isComposingRef.current || sendingRef.current || retryingRef.current > 0,
    '任务评论尚未提交或仍在输入、发送或重试，请先处理后再更新；内容已保留。',
  );
  const notifiedTargetRef = useRef<string | null>(null);
  const loadSequenceRef = useRef(0);
  const onTargetReadyRef = useRef(onTargetReady);

  useEffect(() => {
    onTargetReadyRef.current = onTargetReady;
  }, [onTargetReady]);

  const scrollToComment = useCallback((
    commentId: string,
    block: "center" | "nearest",
    behavior: ScrollBehavior = "smooth",
  ) => {
    const viewport = scrollRef.current;
    const target = itemRefs.current.get(commentId);
    if (!viewport || !target) return;
    const bounds = target.getBoundingClientRect();
    const top = bounds.top - viewport.getBoundingClientRect().top - viewport.clientTop;
    const bottom = top + bounds.height;
    const height = viewport.clientHeight;
    let delta = top + (bounds.height - height) / 2;
    if (block === "nearest") {
      // Visible rows, including a tall row spanning the viewport, stay put.
      if (top < 0 && bottom > height) delta = 0;
      else if (top < 0) delta = bounds.height <= height ? top : bottom - height;
      else if (bottom > height) delta = bounds.height <= height ? bottom - height : top;
      else delta = 0;
    }
    // Reading navigation owns only this viewport. Element.scrollIntoView also
    // scrolls ancestors (even overflow:hidden), which can displace drawer chrome.
    // Issue even a zero delta so the newest navigation cancels an older animation.
    viewport.scrollTo({ top: viewport.scrollTop + delta, behavior });
  }, []);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || isComposingRef.current) return;
    textarea.style.height = "auto";
    const nextHeight = Math.min(
      textarea.scrollHeight,
      COMPOSER_MAX_HEIGHT_PX,
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [body, resizeTextarea]);

  useEffect(() => {
    const root = timelineRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    let previousWidth = root.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const width =
        entries[0]?.contentRect.width ?? root.getBoundingClientRect().width;
      if (width === previousWidth) return;
      previousWidth = width;
      resizeTextarea();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  useEffect(() => {
    if (loading || !targetCommentId) return;
    if (notifiedTargetRef.current === targetCommentId) return;
    const target = itemRefs.current.get(targetCommentId);
    scrollToComment(targetCommentId, "center");
    target?.focus({ preventScroll: true });
    if (!target) return;
    notifiedTargetRef.current = targetCommentId;
    onTargetReadyRef.current?.(true);
  }, [loading, targetCommentId, comments, scrollToComment]);

  useEffect(() => {
    if (!targetCommentId) notifiedTargetRef.current = null;
  }, [targetCommentId]);

  const load = useCallback(async (preferLatest = false) => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      if (targetCommentId && !preferLatest) {
        const page = await taskGetCommentContext(task.id, targetCommentId);
        if (sequence !== loadSequenceRef.current) return;
        setComments(page.items);
        setNextBefore(page.previousBefore);
        setNextAfter(page.nextAfter);
        setReplyParents(page.replyParents ?? []);
      } else {
        const page = await taskListComments(task.id, { limit: 50 });
        if (sequence !== loadSequenceRef.current) return;
        setComments(page.items);
        setNextBefore(page.nextBefore);
        setNextAfter(undefined);
        setReplyParents(page.replyParents ?? []);
      }
    } catch (loadError) {
      if (sequence !== loadSequenceRef.current) return;
      const message = extractErrorMessage(loadError);
      setError(message);
      if (targetCommentId && /comment not found/i.test(message)) {
        onTargetReadyRef.current?.(false);
      }
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, [targetCommentId, task.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const ac = new AbortController();
    void listenWithCleanup<{ taskId?: string }>(
      "task:comment-changed",
      (event) => {
        if (event.payload?.taskId === task.id) {
          // Once an exact route has been announced, subsequent mutations are
          // ordinary timeline updates. Reload the newest page instead of
          // snapping back to the old around-window forever.
          const targetResolved = Boolean(
            targetCommentId && notifiedTargetRef.current === targetCommentId,
          );
          void load(targetResolved);
        }
      },
      ac.signal,
    );
    return () => ac.abort();
  }, [load, targetCommentId, task.id]);

  const byId = useMemo(
    () => new Map(comments.map((comment) => [comment.id, comment])),
    [comments],
  );
  const replyParentById = useMemo(
    () => new Map(replyParents.map((parent) => [parent.commentId, parent])),
    [replyParents],
  );

  const loadEarlier = useCallback(async () => {
    if (updateLockedRef.current || !nextBefore || loadingEarlier) return;
    setLoadingEarlier(true);
    const anchor = comments[0]?.id;
    try {
      const page = await taskListComments(task.id, {
        before: nextBefore,
        limit: 50,
      });
      setComments((current) => [...page.items, ...current]);
      setNextBefore(page.nextBefore);
      setReplyParents((current) =>
        mergeReplyParents(current, page.replyParents),
      );
      requestAnimationFrame(() => {
        if (!anchor) return;
        scrollToComment(anchor, "nearest", "auto");
      });
    } catch (loadError) {
      setError(extractErrorMessage(loadError));
    } finally {
      setLoadingEarlier(false);
    }
  }, [comments, loadingEarlier, nextBefore, task.id, scrollToComment, updateLockedRef]);

  const loadNewer = useCallback(async () => {
    if (updateLockedRef.current || !nextAfter || loadingNewer) return;
    setLoadingNewer(true);
    try {
      const page = await taskListComments(task.id, {
        after: nextAfter,
        limit: 50,
      });
      setComments((current) => [...current, ...page.items]);
      setNextAfter(page.nextAfter);
      setReplyParents((current) =>
        mergeReplyParents(current, page.replyParents),
      );
    } catch (loadError) {
      setError(extractErrorMessage(loadError));
    } finally {
      setLoadingNewer(false);
    }
  }, [loadingNewer, nextAfter, task.id, updateLockedRef]);

  const submit = useCallback(async () => {
    if (updateLockedRef.current || sendingRef.current || !body.trim() || sending) return;
    const submitted = body;
    setSending(true);
    setError(null);
    try {
      const comment = await taskCreateUserComment({
        id: task.id,
        body: submitted,
        replyToCommentId: replyTo?.id,
      });
      // Invalidate an event-triggered reload that may have started before the
      // invoke returned. The mutation response is the authoritative optimistic
      // row and must not be overwritten by the stale around page.
      loadSequenceRef.current += 1;
      setLoading(false);
      setComments((current) => [
        ...current.filter((item) => item.id !== comment.id),
        comment,
      ]);
      setBody("");
      setReplyTo(null);
      requestAnimationFrame(() => {
        scrollToComment(comment.id, "nearest");
      });
    } catch (submitError) {
      // Persistence failures retain the draft. A persisted-but-rejected
      // delivery returns a successful Comment with failed admission instead.
      setError(extractErrorMessage(submitError));
    } finally {
      setSending(false);
    }
  }, [body, replyTo?.id, sending, task.id, scrollToComment, setBody, setReplyTo, setSending, updateLockedRef]);

  const retry = useCallback(
    async (comment: TaskComment) => {
      if (updateLockedRef.current) return;
      retryingRef.current += 1;
      setError(null);
      try {
        const updated = await taskRetryComment(task.id, comment.id);
        setComments((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
      } catch (retryError) {
        setError(extractErrorMessage(retryError));
      } finally { retryingRef.current -= 1; }
    },
    [task.id, updateLockedRef],
  );

  const openCommentSession = useCallback(
    (sessionId: string) => {
      if (updateLockedRef.current) return;
      onBeforeOpenSession?.();
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
          detail: {
            sessionId,
            workspacePath: task.workspacePath,
            historyEntrySource: "task_run_history",
          },
        }),
      );
    },
    [onBeforeOpenSession, task.workspacePath, updateLockedRef],
  );

  return (
    <div ref={timelineRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 pb-8 pt-4 max-sm:px-5">
        <div className="mx-auto w-full min-w-0 max-w-[860px]">
          {children}
          <section
            className="mt-10 border-t border-[var(--line-subtle)] pt-7"
            aria-labelledby="task-comments-heading"
          >
            <div className="mb-4 flex items-baseline gap-2">
              <h3
                id="task-comments-heading"
                className="text-base font-semibold text-[var(--ink)]"
              >
                {t("comments.title")}
              </h3>
              <span className="text-xs tabular-nums text-[var(--ink-muted)]">
                {comments.length}
              </span>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-[var(--ink-muted)]">
                <LoaderIcon className="h-4 w-4 animate-spin" />{" "}
                {t("comments.loading")}
              </div>
            ) : (
              <div className="space-y-1">
                {nextBefore && (
                  <button
                    type="button"
                    onClick={() => void loadEarlier()}
                    className="mb-3 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)]"
                  >
                    {loadingEarlier
                      ? t("comments.loading")
                      : t("comments.loadEarlier")}
                  </button>
                )}
                {comments.length === 0 && (
                  <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                    {t("comments.empty")}
                  </div>
                )}
                {comments.map((comment) => {
                  const parent = comment.replyToCommentId
                    ? byId.get(comment.replyToCommentId)
                    : undefined;
                  const parentSummary = comment.replyToCommentId
                    ? replyParentById.get(comment.replyToCommentId)
                    : undefined;
                  const parentAuthor = parent
                    ? parent.author.kind === "agent"
                      ? parent.author.label || "Agent"
                      : parent.author.label || t("comments.you")
                    : parentSummary
                      ? parentSummary.author.kind === "agent"
                        ? parentSummary.author.label || "Agent"
                        : parentSummary.author.label || t("comments.you")
                      : "";
                  const parentQuote = parent
                    ? parent.body.trim()
                    : parentSummary?.quote;
                  const highlighted = targetCommentId === comment.id;
                  const retryable =
                    comment.admission?.state === "failed" ||
                    comment.admission?.state === "unknown";
                  const resolvedAgentLabel =
                    agentLabel || comment.author.label || null;
                  const authorLabel =
                    comment.author.kind === "agent"
                      ? `Agent(${resolvedAgentLabel || "Agent"})`
                      : comment.author.label || t("comments.you");
                  const canOpenSession =
                    comment.author.kind === "agent" &&
                    !!comment.conversationSessionId;
                  const commentIdentity = (
                    <>
                      <span className="text-sm font-medium text-[var(--ink-secondary)]">
                        {authorLabel}
                      </span>
                      <span>·</span>
                      <time>
                        {new Date(comment.createdAt).toLocaleString(
                          i18n.language,
                        )}
                      </time>
                      {comment.conversationSessionId && (
                        <span className="truncate font-mono text-xs">
                          · {comment.conversationSessionId.slice(0, 8)}
                        </span>
                      )}
                    </>
                  );
                  return (
                    <div
                      key={comment.id}
                      ref={(node) => {
                        if (node) itemRefs.current.set(comment.id, node);
                        else itemRefs.current.delete(comment.id);
                      }}
                      tabIndex={-1}
                      className={`rounded-xl px-3 py-3 ${highlighted ? "bg-[var(--accent-warm)]/10 ring-1 ring-[var(--accent-warm)]/35" : ""}`}
                    >
                      {highlighted && (
                        <div
                          className="mb-2 text-xs font-medium text-[var(--accent-warm)]"
                          role="status"
                          aria-live="polite"
                        >
                          {t("comments.notificationTarget")}
                        </div>
                      )}
                      {canOpenSession ? (
                        <button
                          type="button"
                          onClick={() =>
                            openCommentSession(comment.conversationSessionId!)
                          }
                          className="flex max-w-full min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-left text-xs text-[var(--ink-muted)] transition-colors hover:text-[var(--accent-warm)]"
                        >
                          {commentIdentity}
                        </button>
                      ) : (
                        <div className="flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                          {commentIdentity}
                        </div>
                      )}
                      {parentQuote && (
                        <button
                          type="button"
                          disabled={!parent}
                          onClick={() =>
                            parent &&
                            scrollToComment(parent.id, "center")
                          }
                          aria-label={t("comments.replyQuote", {
                            author: parentAuthor,
                            quote: parentQuote,
                          })}
                          className="mt-2 block w-full min-w-0 truncate rounded-r-md border-l-2 border-[var(--line)] bg-[var(--hover-bg)] px-2 py-1 text-left text-xs text-[var(--ink-muted)] disabled:cursor-default"
                        >
                          {parentQuote}
                        </button>
                      )}
                      <div className="mt-2 text-sm leading-6 text-[var(--ink-secondary)] [&_.markdown-content]:text-sm">
                        <Markdown compact raw preserveNewlines>
                          {comment.body}
                        </Markdown>
                      </div>
                      <div className="mt-2 flex items-center gap-3 text-xs">
                        <button
                          type="button"
                          onClick={() => { if (!updateLockedRef.current) setReplyTo(comment); }}
                          className="inline-flex items-center gap-1 text-[var(--ink-muted)] hover:text-[var(--ink)]"
                        >
                          <ReplyIcon className="h-3 w-3" />{" "}
                          {t("comments.reply")}
                        </button>
                        {comment.admission && (
                          <span
                            role="status"
                            aria-live="polite"
                            className={
                              comment.admission.state === "failed"
                                ? "text-[var(--error)]"
                                : "text-[var(--ink-muted)]"
                            }
                          >
                            {t(`comments.admission.${comment.admission.state}`)}
                          </span>
                        )}
                        {retryable && (
                          <button
                            type="button"
                            onClick={() => void retry(comment)}
                            className="inline-flex items-center gap-1 text-[var(--accent-warm)] hover:underline"
                          >
                            <UndoIcon className="h-3 w-3" />{" "}
                            {t("comments.retry")}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {nextAfter && (
                  <button
                    type="button"
                    onClick={() => void loadNewer()}
                    className="mt-3 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)]"
                  >
                    {loadingNewer
                      ? t("comments.loading")
                      : t("comments.loadNewer")}
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      </div>

      <div className="z-10 shrink-0 border-t border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-8 py-2.5 max-sm:px-5">
        <div className="mx-auto max-w-[860px]">
          {replyTo && (
            <div className="mb-1.5 flex items-center gap-2 rounded-r-lg border-l-2 border-[var(--line)] bg-[var(--hover-bg)] px-2.5 py-1.5 text-xs text-[var(--ink-muted)]">
              <ReplyIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {replyTo.body.trim()}
              </span>
              <button
                type="button"
                onClick={() => { if (!updateLockedRef.current) setReplyTo(null); }}
                aria-label={t("comments.cancelReply")}
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 shadow-sm focus-within:border-[var(--line-strong)]">
            <textarea
              ref={textareaRef}
              value={body}
              readOnly={updateLockedRef.current}
              onChange={(event) => { if (updateLockedRef.current) { event.target.value = bodyRef.current; return; } setBody(event.target.value); }}
              onCompositionStart={() => {
                if (updateLockedRef.current) return;
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                if (updateLockedRef.current) return;
                isComposingRef.current = false;
                requestAnimationFrame(resizeTextarea);
              }}
              onKeyDown={(event) => {
                if (updateLockedRef.current) return;
                if (event.nativeEvent.isComposing || event.keyCode === 229) {
                  return;
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              placeholder={t("comments.placeholder")}
              className="min-h-10 max-h-36 w-full resize-none overflow-y-hidden bg-transparent text-sm leading-5 text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]/70"
            />
            <div className="mt-0.5 flex justify-end">
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!body.trim() || sending}
                className="grid h-8 w-8 place-items-center rounded-full bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] disabled:opacity-40"
                aria-label={t("comments.send")}
              >
                {sending ? (
                  <LoaderIcon className="h-4 w-4 animate-spin" />
                ) : (
                  <SendIcon className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
          {error && (
            <div
              className="mt-2 flex items-center gap-3 text-xs text-[var(--error)]"
              role="alert"
            >
              <span className="min-w-0 flex-1">{error}</span>
              <button
                type="button"
                className="shrink-0 font-medium underline underline-offset-2"
                onClick={() => { if (!updateLockedRef.current) void load(); }}
              >
                {t("comments.retryLoad")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
