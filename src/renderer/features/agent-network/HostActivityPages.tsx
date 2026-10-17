import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CustomSelect from "@/components/CustomSelect";
import {
  canManageHost,
  hostAddressKey,
  hostInteractionKey,
  sameHostAddress,
  type HostAddress,
  type HostInteraction,
  type HostInteractionSnapshot,
  type HostLogPage,
  type HostLogQuery,
  type HostPageReceipt,
  type HostPagesAdapter,
  type HostSnapshot,
} from "@/api/hostManagement";
import { getHostPagePending, setHostPagePending } from "./hostManagementState";

const button =
  "rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

/** Reads are fenced by address, online state, grant/capability and adapter.
 * Entering a page/reconnecting always obtains a fresh owner projection. */
function useOwnerRead<T>(
  address: HostAddress,
  enabled: boolean,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([hostAddressKey(address), enabled, retry]);
  const [result, setResult] = useState<{
    key: string;
    load: typeof load;
    signal: AbortSignal;
    data?: T;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    void load(abort.signal).then(
      (data) => {
        if (!abort.signal.aborted)
          setResult({ key, load, signal: abort.signal, data });
      },
      () => {
        if (!abort.signal.aborted)
          setResult({ key, load, signal: abort.signal, failed: true });
      },
    );
    return () => abort.abort();
  }, [enabled, key, load]);
  const current =
    result?.key === key && result.load === load && !result.signal.aborted
      ? result
      : undefined;
  return {
    data: current?.data,
    failed: current?.failed,
    refresh: () => setRetry((value) => value + 1),
  };
}

export function HostActivityPages({
  snapshot,
  adapter,
  page,
  active,
}: {
  snapshot: HostSnapshot;
  adapter?: HostPagesAdapter;
  page: "approvals" | "logs";
  active: boolean;
}) {
  const { t } = useTranslation("app");
  const capability = page === "approvals" ? "interactions.read" : "logs.read";
  if (!adapter || !snapshot.capabilities.includes(capability))
    return (
      <p role="status" className="text-sm text-[var(--ink-muted)]">
        {t("agentNetwork.host.pages.unavailable")}
      </p>
    );
  if (!snapshot.permissions.includes("read"))
    return <p role="alert">{t("agentNetwork.host.denied")}</p>;
  return page === "approvals" ? (
    <HostApprovals
      key={hostAddressKey(snapshot.address)}
      snapshot={snapshot}
      adapter={adapter}
      active={active}
    />
  ) : (
    <HostLogs
      key={hostAddressKey(snapshot.address)}
      snapshot={snapshot}
      adapter={adapter}
      active={active}
    />
  );
}

function HostApprovals({
  snapshot,
  adapter,
  active,
}: {
  snapshot: HostSnapshot;
  adapter: HostPagesAdapter;
  active: boolean;
}) {
  const { t } = useTranslation("app");
  const address = snapshot.address;
  const load = useCallback(
    async (signal: AbortSignal) => {
      const next = await adapter.readInteractions(address, signal);
      if (
        !sameHostAddress(address, next.address) ||
        !next.readToken ||
        next.items.length > 100
      )
        throw new Error("HOST_INTERACTIONS_INVALID");
      return next;
    },
    [address, adapter],
  );
  const read = useOwnerRead<HostInteractionSnapshot>(
    address,
    active && snapshot.online,
    load,
  );
  const [pending, setPending] = useState(() => getHostPagePending(address));
  const [busySignal, setBusySignal] = useState<AbortSignal>();
  const busy = !!busySignal && !busySignal.aborted;
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(
    pending?.resource === "interaction" ? "unconfirmed" : null,
  );
  const lifetime = useRef<AbortController | null>(null);
  if (!lifetime.current) lifetime.current = new AbortController();
  const grantKey = JSON.stringify([
    snapshot.permissions,
    snapshot.capabilities,
  ]);
  const [clock, setClock] = useState(() => Date.now());
  const enabled = active && snapshot.online;
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    busyRef.current = false;
    // Expiry disables actions even without a network event; no background read.
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [enabled, adapter, grantKey]);
  const mayRespond =
    enabled && canManageHost(snapshot, "approve", "interaction.respond");
  function retain(value?: typeof pending) {
    setHostPagePending(address, value);
    setPending(value);
  }
  async function finish(
    receipt: HostPageReceipt,
    mutationId: string,
    signal: AbortSignal,
  ) {
    if (signal.aborted) return;
    if (
      !sameHostAddress(receipt.address, address) ||
      receipt.mutationId !== mutationId ||
      receipt.resource !== "interaction"
    )
      throw new Error("HOST_RECEIPT_INVALID");
    retain({ mutationId, resource: "interaction", receipt });
    setNotice(receipt.status);
    if (
      ["applied", "rejected", "expired", "conflict"].includes(receipt.status)
    ) {
      // The response receipt is not the current pending list. Never optimistically
      // remove a request or call accepted an approval; read its owner again.
      try {
        await load(signal);
        if (signal.aborted) return;
        retain();
        read.refresh();
      } catch {
        if (!signal.aborted) setNotice("interactionReadFailed");
      }
    }
  }
  async function actOn(
    item: HostInteraction,
    approved: boolean,
    answers: Record<string, string>,
  ) {
    const signal = lifetime.current?.signal;
    const token = read.data?.readToken;
    if (
      !signal ||
      signal.aborted ||
      !mayRespond ||
      pending ||
      busyRef.current ||
      !token ||
      !read.data?.items.some(
        (current) => hostInteractionKey(current) === hostInteractionKey(item),
      ) ||
      Date.parse(item.expiresAt) <= Date.now() ||
      !Number.isFinite(Date.parse(item.expiresAt))
    )
      return;
    if (
      item.kind === "question" &&
      item.questions.some(
        (question) =>
          !answers[question.id]?.trim() ||
          !question.options.includes(answers[question.id]),
      )
    )
      return;
    busyRef.current = true;
    setBusySignal(signal);
    const mutationId = crypto.randomUUID();
    setNotice(null);
    let handedOff = false;
    try {
      // Revalidate exact identity immediately before submission. The Host must
      // atomically reject outdated tokens/generations at its original owner.
      const fresh = await load(signal);
      if (signal.aborted) return;
      const current = fresh.items.find(
        (candidate) =>
          hostInteractionKey(candidate) === hostInteractionKey(item) &&
          candidate.kind === item.kind,
      );
      if (
        !current ||
        !Number.isFinite(Date.parse(current.expiresAt)) ||
        Date.parse(current.expiresAt) <= Date.now() ||
        JSON.stringify(current) !== JSON.stringify(item)
      ) {
        retain();
        setNotice("expired");
        read.refresh();
        return;
      }
      if (
        item.kind === "question" &&
        (current.kind !== "question" ||
          current.questions.some(
            (question) =>
              !answers[question.id]?.trim() ||
              !question.options.includes(answers[question.id]),
          ))
      ) {
        setNotice("expired");
        read.refresh();
        return;
      }
      retain({ mutationId, resource: "interaction", receipt: null });
      handedOff = true;
      const identity = {
        sessionId: item.sessionId,
        requestId: item.requestId,
        turnId: item.turnId,
        runtimeGeneration: item.runtimeGeneration,
        mutationId,
        readToken: fresh.readToken,
      };
      const response =
        item.kind === "question"
          ? { ...identity, kind: "question" as const, answers }
          : { ...identity, kind: item.kind, approved };
      await finish(
        await adapter.respondInteraction(address, response, signal),
        mutationId,
        signal,
      );
    } catch {
      if (!signal.aborted) setNotice(handedOff ? "unconfirmed" : "readFailed");
    } finally {
      if (!signal.aborted) {
        busyRef.current = false;
        setBusySignal(undefined);
      }
    }
  }
  async function recover() {
    const signal = lifetime.current?.signal;
    if (
      !signal ||
      signal.aborted ||
      !enabled ||
      !pending ||
      pending.resource !== "interaction" ||
      busyRef.current
    )
      return;
    busyRef.current = true;
    setBusySignal(signal);
    try {
      await finish(
        await adapter.receipt(address, pending.mutationId, signal),
        pending.mutationId,
        signal,
      );
    } catch {
      if (!signal.aborted) setNotice("unconfirmed");
    } finally {
      if (!signal.aborted) {
        busyRef.current = false;
        setBusySignal(undefined);
      }
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--ink-muted)]">
        {t("agentNetwork.host.pages.approvalHint")}
      </p>
      {!snapshot.online && (
        <p role="status">{t("agentNetwork.host.offline")}</p>
      )}
      {!mayRespond && snapshot.online && (
        <p role="status" className="text-xs text-[var(--ink-muted)]">
          {t("agentNetwork.host.pages.approvalReadOnly")}
        </p>
      )}
      <button
        type="button"
        className={button}
        disabled={!enabled || busy || !!pending}
        onClick={read.refresh}
      >
        {t("agentNetwork.host.refresh")}
      </button>
      {pending && (
        <div role="status" className="space-y-2 text-xs">
          <p>
            {t(
              pending.resource === "interaction"
                ? "agentNetwork.host.receiptHint"
                : "agentNetwork.host.pages.otherPending",
            )}
          </p>
          {pending.resource === "interaction" && (
            <button
              type="button"
              className={button}
              disabled={!enabled || busy}
              onClick={() => void recover()}
            >
              {t("agentNetwork.host.queryReceipt")}
            </button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-[var(--ink-secondary)]">
          {t(`agentNetwork.host.pages.approvalNotices.${notice}`)}
        </p>
      )}
      {read.failed ? (
        <p role="alert">{t("agentNetwork.host.notices.readFailed")}</p>
      ) : !enabled ? null : !read.data ? (
        <p role="status" aria-busy="true">
          {t("agentNetwork.host.loading")}
        </p>
      ) : read.data.items.length === 0 ? (
        <p
          role="status"
          className="rounded-lg bg-[var(--paper-inset)] p-3 text-sm"
        >
          {t("agentNetwork.host.pages.noApprovals")}
        </p>
      ) : (
        read.data.items.map((item) => (
          <InteractionCard
            key={hostInteractionKey(item)}
            item={item}
            disabled={
              !mayRespond ||
              busy ||
              !!pending ||
              !Number.isFinite(Date.parse(item.expiresAt)) ||
              Date.parse(item.expiresAt) <= clock
            }
            expired={
              !Number.isFinite(Date.parse(item.expiresAt)) ||
              Date.parse(item.expiresAt) <= clock
            }
            onRespond={actOn}
          />
        ))
      )}
    </div>
  );
}

function InteractionCard({
  item,
  disabled,
  expired,
  onRespond,
}: {
  item: HostInteraction;
  disabled: boolean;
  expired: boolean;
  onRespond: (
    item: HostInteraction,
    approved: boolean,
    answers: Record<string, string>,
  ) => Promise<void>;
}) {
  const { t } = useTranslation("app");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const complete =
    item.kind !== "question" ||
    item.questions.every((question) => !!answers[question.id]);
  return (
    <article className="space-y-3 rounded-lg border border-[var(--line-subtle)] p-3 [overflow-wrap:anywhere]">
      <h4 className="text-sm font-semibold text-[var(--ink)]">
        {t(`agentNetwork.host.pages.kinds.${item.kind}`)} · {item.title}
      </h4>
      {expired && (
        <p role="status" className="text-xs text-[var(--warning)]">
          {t("agentNetwork.host.pages.expired")}
        </p>
      )}
      <dl className="space-y-1 text-xs text-[var(--ink-muted)]">
        <div>
          {t("agentNetwork.host.pages.interactionIdentity", {
            session: item.sessionId,
            request: item.requestId,
            turn: item.turnId,
            generation: item.runtimeGeneration,
          })}
        </div>
        <div>
          {t("agentNetwork.host.pages.expires", { time: item.expiresAt })}
        </div>
      </dl>
      {item.kind === "question" ? (
        item.questions.map((question) => (
          <label
            key={question.id}
            className="block space-y-1 text-sm text-[var(--ink-secondary)]"
          >
            <span>{question.prompt}</span>
            <CustomSelect
              size="md"
              ariaLabel={question.prompt}
              disabled={disabled}
              value={answers[question.id] ?? ""}
              placeholder={t("agentNetwork.host.pages.selectAnswer")}
              options={question.options.map((option) => ({
                value: option,
                label: option,
              }))}
              onChange={(value) =>
                setAnswers((current) => ({ ...current, [question.id]: value }))
              }
            />
          </label>
        ))
      ) : (
        <p className="whitespace-pre-wrap text-sm text-[var(--ink-secondary)]">
          {item.description}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={disabled || !complete}
          onClick={() => void onRespond(item, true, answers)}
        >
          {t(
            item.kind === "question"
              ? "agentNetwork.host.pages.submitAnswers"
              : "agentNetwork.host.pages.approve",
          )}
        </button>
        {item.kind !== "question" && (
          <button
            type="button"
            className={button}
            disabled={disabled}
            onClick={() => void onRespond(item, false, {})}
          >
            {t("agentNetwork.host.pages.reject")}
          </button>
        )}
      </div>
    </article>
  );
}

function HostLogs({
  snapshot,
  adapter,
  active,
}: {
  snapshot: HostSnapshot;
  adapter: HostPagesAdapter;
  active: boolean;
}) {
  const { t } = useTranslation("app");
  const address = snapshot.address;
  const [query, setQuery] = useState<HostLogQuery>({
    level: "all",
    limit: 100,
  });
  const load = useCallback(
    async (signal: AbortSignal) => {
      const page = await adapter.readLogs(address, query, signal);
      if (
        !sameHostAddress(address, page.address) ||
        page.redacted !== true ||
        page.entries.length > query.limit ||
        page.entries.some(
          (entry) =>
            entry.message.length > 4096 ||
            !["info", "warn", "error", "debug"].includes(entry.level),
        )
      )
        throw new Error("HOST_LOG_PROJECTION_INVALID");
      return page;
    },
    [address, adapter, query],
  );
  const read = useOwnerRead<HostLogPage>(
    address,
    active && snapshot.online,
    load,
  );
  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--ink-muted)]">
        {t("agentNetwork.host.pages.logsHint")}
      </p>
      {!snapshot.online && (
        <p role="status">{t("agentNetwork.host.offline")}</p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-36 space-y-1 text-sm text-[var(--ink-secondary)]">
          <span>{t("agentNetwork.host.pages.logLevel")}</span>
          <CustomSelect
            size="md"
            ariaLabel={t("agentNetwork.host.pages.logLevel")}
            value={query.level}
            disabled={!active || !snapshot.online}
            options={["all", "info", "warn", "error", "debug"].map((level) => ({
              value: level,
              label: t(`agentNetwork.host.pages.levels.${level}`),
            }))}
            onChange={(value) =>
              setQuery({ limit: 100, level: value as HostLogQuery["level"] })
            }
          />
        </label>
        <button
          type="button"
          className={button}
          disabled={!active || !snapshot.online}
          onClick={() => {
            setQuery({ level: query.level, limit: 100 });
            read.refresh();
          }}
        >
          {t("agentNetwork.host.pages.latestLogs")}
        </button>
      </div>
      {read.failed ? (
        <p role="alert">{t("agentNetwork.host.pages.logsFailed")}</p>
      ) : !active || !snapshot.online ? null : !read.data ? (
        <p role="status" aria-busy="true">
          {t("agentNetwork.host.loading")}
        </p>
      ) : (
        <>
          <p className="text-xs text-[var(--ink-muted)]">
            {t("agentNetwork.host.pages.logCount", {
              count: read.data.entries.length,
            })}
          </p>
          {read.data.entries.length === 0 && (
            <p role="status">{t("agentNetwork.host.pages.noLogs")}</p>
          )}
          <ol
            aria-label={t("agentNetwork.host.pages.tabs.logs")}
            className="space-y-2"
          >
            {read.data.entries.map((entry) => (
              <li
                key={entry.id}
                className="rounded-lg bg-[var(--paper-inset)] p-3 text-xs [overflow-wrap:anywhere]"
              >
                <div className="flex flex-wrap gap-x-2 text-[var(--ink-muted)]">
                  <time>{entry.timestamp}</time>
                  <span>
                    {t(`agentNetwork.host.pages.levels.${entry.level}`)}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap font-mono text-[var(--ink-secondary)]">
                  {entry.message}
                </p>
                {(entry.sessionId || entry.requestId || entry.turnId) && (
                  <p className="mt-1 text-[var(--ink-muted)]">
                    {[entry.sessionId, entry.requestId, entry.turnId]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </li>
            ))}
          </ol>
          <button
            type="button"
            className={button}
            disabled={
              !read.data.nextCursor || read.data.nextCursor === query.cursor
            }
            onClick={() =>
              setQuery({ ...query, cursor: read.data!.nextCursor })
            }
          >
            {t("agentNetwork.host.pages.olderLogs")}
          </button>
        </>
      )}
    </div>
  );
}
