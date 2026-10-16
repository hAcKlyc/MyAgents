import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import CustomSelect from "@/components/CustomSelect";

import {
  communityRequest,
  type CommunityCategory,
  type CommunityDetail,
  type CommunityRequest,
  type CommunityScope,
  type CommunityTopic,
} from "./api";

type Mutation = Extract<CommunityRequest, { kind: "create" | "reply" }>;
const categories: CommunityCategory[] = [
  "discussion",
  "question",
  "showcase",
  "announcement",
];
// Owner/session failures can occur after HTTP delivery; keep those writes uncertain.
const definitiveErrors = new Set([
  "REQUEST_INVALID",
  "REQUEST_TOO_LARGE",
  "UNAUTHORIZED",
  "COMMUNITY_NOT_FOUND",
  "COMMUNITY_LOCKED",
  "ADMIN_REQUIRED",
  "REVISION_CONFLICT",
  "MUTATION_CONFLICT",
  "MUTATION_LIMIT",
]);
const count = (value: string) => Array.from(value).length;
const button =
  "rounded-lg px-3 py-2 text-sm text-[var(--ink-secondary)] hover:bg-[var(--paper-inset)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]`;
const field =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-60";

/** A defensive identity boundary even when a caller forgets to key the page. */
export default function CommunityPage({ scope }: { scope: CommunityScope }) {
  return (
    <CommunitySession
      key={JSON.stringify([
        scope.connectionId,
        scope.principalId,
        scope.bindingId,
      ])}
      scope={scope}
    />
  );
}

function CommunitySession({ scope }: { scope: CommunityScope }) {
  const { t, i18n } = useTranslation("community");
  const [topics, setTopics] = useState<CommunityTopic[]>([]);
  const [detail, setDetail] = useState<CommunityDetail | null>(null);
  const [view, setView] = useState<"list" | "detail" | "create">("list");
  const [filter, setFilter] = useState<CommunityCategory | "all">("all");
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] =
    useState<Exclude<CommunityCategory, "announcement">>("discussion");
  const [reply, setReply] = useState("");
  const [mutation, setMutation] = useState<Mutation | null>(null);
  const [sending, setSending] = useState(false);
  const [writeError, setWriteError] = useState<"uncertain" | "failed" | null>(
    null,
  );
  const alive = useRef(false);
  const readSequence = useRef(0);
  const mutationRef = useRef<Mutation | null>(null);
  const sendingRef = useRef(false);
  const { connectionId, principalId, bindingId } = scope;

  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readSequence.current += 1;
    };
  }, []);

  const load = useCallback(
    async (id: string | null) => {
      const sequence = ++readSequence.current;
      setLoading(true);
      setReadError(false);
      try {
        const identity = { connectionId, principalId, bindingId };
        if (id) {
          const result = await communityRequest(identity, {
            kind: "detail",
            topicId: id,
          });
          if (!alive.current || sequence !== readSequence.current) return;
          setDetail(result);
        } else {
          const result = await communityRequest(identity, { kind: "list" });
          if (!alive.current || sequence !== readSequence.current) return;
          setTopics(result.items);
        }
      } catch {
        if (alive.current && sequence === readSequence.current)
          setReadError(true);
      } finally {
        if (alive.current && sequence === readSequence.current)
          setLoading(false);
      }
    },
    [connectionId, principalId, bindingId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const navigate = (
    next: "list" | "create" | "detail",
    id: string | null = null,
  ) => {
    if (mutationRef.current) return;
    readSequence.current += 1;
    setView(next);
    setTopicId(id);
    setDetail(null);
    setReply("");
    setReadError(false);
    setWriteError(null);
    setLoading(false);
    if (next !== "create") void load(id);
  };

  const send = async (request: Mutation) => {
    if (
      sendingRef.current ||
      (mutationRef.current && mutationRef.current !== request)
    )
      return;
    mutationRef.current = request;
    sendingRef.current = true;
    setMutation(request);
    setSending(true);
    setWriteError(null);
    try {
      if (request.kind === "create") {
        const topic = await communityRequest(scope, request);
        if (!alive.current || mutationRef.current !== request) return;
        setTitle("");
        setContent("");
        setView("detail");
        setTopicId(topic.id);
        setDetail({ topic, replies: [] });
        void load(topic.id);
      } else {
        const result = await communityRequest(scope, request);
        if (!alive.current || mutationRef.current !== request) return;
        setReply("");
        setDetail((previous) =>
          previous && previous.topic.id === request.topicId
            ? {
                topic: {
                  ...previous.topic,
                  reply_count: previous.topic.reply_count + 1,
                },
                replies: [
                  ...previous.replies.filter((item) => item.id !== result.id),
                  result,
                ],
              }
            : previous,
        );
        void load(request.topicId);
      }
      mutationRef.current = null;
      setMutation(null);
    } catch (error) {
      if (!alive.current || mutationRef.current !== request) return;
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      if (typeof code === "string" && definitiveErrors.has(code)) {
        mutationRef.current = null;
        setMutation(null);
        setWriteError("failed");
      } else setWriteError("uncertain");
    } finally {
      if (alive.current) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  };

  const date = (timestamp: number) =>
    new Date(timestamp).toLocaleString(i18n.language);
  const titleValid = title.trim().length > 0 && count(title) <= 120;
  const contentValid = content.trim().length > 0 && count(content) <= 8000;
  const replyValid = reply.trim().length > 0 && count(reply) <= 4000;
  const locked = mutation !== null;

  return (
    <section
      className="h-full overflow-y-auto bg-[var(--paper)] text-[var(--ink)]"
      aria-label={t("title")}
    >
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8 max-sm:px-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{t("title")}</h1>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">
              {t("subtitle")}
            </p>
          </div>
          <div className="flex gap-2">
            {view !== "list" && (
              <button
                className={button}
                disabled={locked}
                onClick={() => navigate("list")}
              >
                {t("back")}
              </button>
            )}
            {view !== "create" && (
              <button
                className={button}
                disabled={loading || locked}
                onClick={() => void load(topicId)}
              >
                {t("refresh")}
              </button>
            )}
            {view === "list" && (
              <button className={primary} onClick={() => navigate("create")}>
                {t("newTopic")}
              </button>
            )}
          </div>
        </header>

        {writeError && (
          <div
            role="alert"
            className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-sm"
          >
            <p>
              {t(writeError === "uncertain" ? "writeUncertain" : "writeFailed")}
            </p>
            {writeError === "uncertain" && mutation && (
              <button
                className={`${button} mt-2`}
                disabled={sending}
                onClick={() => void send(mutation)}
              >
                {t("retrySend")}
              </button>
            )}
          </div>
        )}
        {sending && (
          <p role="status" className="text-sm text-[var(--ink-muted)]">
            {t("sending")}
          </p>
        )}
        {loading && (
          <p role="status" className="text-sm text-[var(--ink-muted)]">
            {t("loading")}
          </p>
        )}
        {readError && (
          <div role="alert" className="text-sm">
            <p>{t("readFailed")}</p>
            <button
              className={button}
              disabled={locked}
              onClick={() => void load(topicId)}
            >
              {t("retryLoad")}
            </button>
          </div>
        )}

        {view === "list" && (
          <>
            <div className="flex flex-wrap gap-2" aria-label={t("filter")}>
              {(["all", ...categories] as const).map((item) => (
                <button
                  key={item}
                  aria-pressed={filter === item}
                  className={`${button} ${filter === item ? "bg-[var(--paper-inset)] font-semibold" : ""}`}
                  onClick={() => setFilter(item)}
                >
                  {t(`categories.${item}`)}
                </button>
              ))}
            </div>
            {!loading &&
              !readError &&
              topics.filter(
                (item) => filter === "all" || item.category === filter,
              ).length === 0 && (
                <p className="py-12 text-center text-sm text-[var(--ink-muted)]">
                  {t("empty")}
                </p>
              )}
            <ul className="divide-y divide-[var(--line)]">
              {topics
                .filter((item) => filter === "all" || item.category === filter)
                .map((topic) => (
                  <li key={topic.id}>
                    <button
                      className="w-full rounded-lg px-3 py-4 text-left hover:bg-[var(--paper-inset)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                      onClick={() => navigate("detail", topic.id)}
                    >
                      <div className="mb-1 flex flex-wrap gap-2 text-xs text-[var(--ink-muted)]">
                        <span>{t(`categories.${topic.category}`)}</span>
                        {topic.pinned && <span>{t("pinned")}</span>}
                        {topic.locked && <span>{t("lockedBadge")}</span>}
                      </div>
                      <h2 className="break-words text-lg font-semibold">
                        {topic.title}
                      </h2>
                      <p className="mt-2 text-xs text-[var(--ink-muted)]">
                        {topic.author_name} · {date(topic.created_at)} ·{" "}
                        {t("replyCount", { count: topic.reply_count })}
                      </p>
                    </button>
                  </li>
                ))}
            </ul>
          </>
        )}

        {view === "create" && (
          <form
            className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (titleValid && contentValid && !mutationRef.current)
                void send({
                  kind: "create",
                  mutationId: crypto.randomUUID(),
                  category,
                  title,
                  content,
                });
            }}
          >
            <h2 className="text-lg font-semibold">{t("newTopic")}</h2>
            <div className="space-y-1 text-sm">
              <span>{t("category")}</span>
              <CustomSelect
                size="md"
                ariaLabel={t("category")}
                value={category}
                disabled={locked}
                onChange={(value) => setCategory(value as typeof category)}
                options={categories
                  .filter((item) => item !== "announcement")
                  .map((item) => ({
                    value: item,
                    label: t(`categories.${item}`),
                  }))}
              />
            </div>
            <label className="block space-y-1 text-sm">
              <span>{t("topicTitle")}</span>
              <input
                className={field}
                value={title}
                disabled={locked}
                onChange={(event) => setTitle(event.target.value)}
                aria-label={t("topicTitle")}
                aria-describedby="community-title-count"
              />
              <span
                id="community-title-count"
                className="text-xs text-[var(--ink-muted)]"
              >
                {t("characters", { count: count(title), limit: 120 })}
              </span>
            </label>
            <label className="block space-y-1 text-sm">
              <span>{t("topicContent")}</span>
              <textarea
                className={field}
                rows={8}
                value={content}
                disabled={locked}
                onChange={(event) => setContent(event.target.value)}
                aria-label={t("topicContent")}
                aria-describedby="community-content-count"
              />
              <span
                id="community-content-count"
                className="text-xs text-[var(--ink-muted)]"
              >
                {t("characters", { count: count(content), limit: 8000 })}
              </span>
            </label>
            <button
              className={primary}
              disabled={locked || !titleValid || !contentValid}
              type="submit"
            >
              {t("publish")}
            </button>
          </form>
        )}

        {view === "detail" && detail && (
          <>
            <article className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
              <div className="text-xs text-[var(--ink-muted)]">
                {t(`categories.${detail.topic.category}`)}
                {detail.topic.pinned ? ` · ${t("pinned")}` : ""}
              </div>
              <h2 className="break-words text-xl font-semibold">
                {detail.topic.title}
              </h2>
              <p className="text-xs text-[var(--ink-muted)]">
                {detail.topic.author_name} · {date(detail.topic.created_at)}
              </p>
              <p className="whitespace-pre-wrap break-words text-base">
                {detail.topic.content}
              </p>
            </article>
            <section aria-label={t("replies")} className="space-y-4">
              <h3 className="text-lg font-semibold">
                {t("replyCount", { count: detail.replies.length })}
              </h3>
              {detail.replies.map((item) => (
                <article
                  key={item.id}
                  className="rounded-lg border border-[var(--line)] p-4"
                >
                  <p className="mb-2 text-xs text-[var(--ink-muted)]">
                    {item.author_name} · {date(item.created_at)}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {item.content}
                  </p>
                </article>
              ))}
              {detail.topic.locked ? (
                <p role="status" className="text-sm text-[var(--ink-muted)]">
                  {t("locked")}
                </p>
              ) : (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (replyValid && !mutationRef.current)
                      void send({
                        kind: "reply",
                        mutationId: crypto.randomUUID(),
                        topicId: detail.topic.id,
                        content: reply,
                      });
                  }}
                >
                  <label className="block space-y-1 text-sm">
                    <span>{t("yourReply")}</span>
                    <textarea
                      className={field}
                      rows={4}
                      value={reply}
                      disabled={locked || loading}
                      onChange={(event) => setReply(event.target.value)}
                      aria-label={t("yourReply")}
                      aria-describedby="community-reply-count"
                    />
                    <span
                      id="community-reply-count"
                      className="text-xs text-[var(--ink-muted)]"
                    >
                      {t("characters", { count: count(reply), limit: 4000 })}
                    </span>
                  </label>
                  <button
                    type="submit"
                    className={primary}
                    disabled={locked || loading || !replyValid}
                  >
                    {t("sendReply")}
                  </button>
                </form>
              )}
            </section>
          </>
        )}
      </div>
    </section>
  );
}
