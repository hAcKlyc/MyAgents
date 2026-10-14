import { remoteAccountState } from "./accountFence";
import { useEffectEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "@/components/Markdown";
import { PlusIcon, RefreshIcon, SendIcon, StopIcon } from "@/components/icons";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import { useAgentNetworkRegistry } from "@/features/agent-network/store";
import {
  remoteAccountMatches,
  remoteErrorCode,
  remoteSessionRequest,
} from "@/api/remoteSession";
import type { HostLocator } from "@/api/hostManagement";
import type { OwnedHostScope } from "@/api/ownedHostManagement";
import type {
  RemoteInteraction,
  RemoteMessage,
  RemoteSessionRequest,
  RemoteSessionResult,
  RemoteSnapshot,
} from "@/../shared/remoteSession";
import {
  readRemoteDraft,
  writeRemoteDraft,
  readRemoteOperation,
  writeRemoteOperation,
  type PendingRemoteOperation,
  type KnownRemoteOperation,
} from "./drafts";
import type { RemoteSessionBinding, RemoteSessionTab } from "./tabContract";

const buttonShape =
  "rounded-lg px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)] disabled:cursor-not-allowed disabled:opacity-50";
const button = `${buttonShape} text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]`;
const primary = `${buttonShape} bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]`;
type SessionList = Extract<RemoteSessionResult, { kind: "list" }>;
type RemoteMutationRequest = Extract<
  RemoteSessionRequest,
  { kind: "start" | "send" | "respond" | "stop" }
>;

export default function RemoteSession({
  tab,
  isActive,
  binding,
}: {
  tab: RemoteSessionTab;
  isActive: boolean;
  binding: RemoteSessionBinding;
}) {
  const registry = useAgentNetworkRegistry();
  const connection = registry.connections.find(
    (c) => c.id === tab.locator.connectionId,
  );
  const current = connection?.snapshot;
  const accountState = remoteAccountState(tab.locator, current);
  const { t } = useTranslation("app");
  if (accountState !== "match" || !current)
    return (
      <div
        className="flex h-full items-center justify-center bg-[var(--paper)] p-8 text-sm text-[var(--ink-muted)]"
        role="status"
        aria-busy={accountState === "pending"}
      >
        {t(
          accountState === "pending"
            ? "remoteSession.connectionPending"
            : "remoteSession.accountChanged",
        )}
      </div>
    );
  // A new auth generation destroys all message/interaction state immediately.
  return (
    <RemoteSessionContent
      key={`${tab.id}:${current.authGeneration}`}
      tab={tab}
      locator={{ ...tab.locator, authGeneration: current.authGeneration }}
      isActive={isActive}
      online={current.state === "ready" && !connection?.removing}
      binding={binding}
    />
  );
}

function RemoteSessionContent({
  tab,
  locator,
  isActive,
  online,
  binding,
}: {
  tab: RemoteSessionTab;
  locator: HostLocator;
  isActive: boolean;
  online: boolean;
  binding: RemoteSessionBinding;
}) {
  const { t } = useTranslation("app");
  const [scope, setScope] = useState<OwnedHostScope | null>(tab.targetScope);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [capable, setCapable] = useState(false);
  const capableRef = useRef(false);
  const [list, setList] = useState<SessionList | null>(null);
  const [listTail, setListTail] = useState<SessionList | null>(null);
  const [snapshot, setSnapshot] = useState<RemoteSnapshot | null>(null);
  const [older, setOlder] = useState<RemoteMessage[]>([]);
  const olderRef = useRef(older);
  olderRef.current = older;
  const [before, setBefore] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [draft, setDraft] = useState(() => readRemoteDraft(tab));
  const [pending, setPending] = useState<PendingRemoteOperation | null>(() =>
    readRemoteOperation(tab),
  );
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const mutationError = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const controllers = useRef(new Set<AbortController>());
  const polling = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const pageEpoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const activeControllers = controllers.current;
    return () => {
      mounted.current = false;
      activeControllers.forEach((c) => c.abort());
    };
  }, []);
  const alive = () => mounted.current && remoteAccountMatches(locator);
  const request = async (operation: RemoteSessionRequest) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      return await remoteSessionRequest(
        locator,
        scopeRef.current,
        operation,
        controller.signal,
      );
    } finally {
      controllers.current.delete(controller);
    }
  };
  function keepPending(value: KnownRemoteOperation | null): boolean {
    try {
      writeRemoteOperation(tab, value);
    } catch {
      const uncertain: PendingRemoteOperation = {
        kind: "unknown",
        operationId: null,
        status: "unknown",
      };
      pendingRef.current = uncertain;
      setPending(uncertain);
      mutationError.current = "REMOTE_OPERATION_STORAGE_UNAVAILABLE";
      setError(mutationError.current);
      return false;
    }
    pendingRef.current = value;
    setPending(value);
    return true;
  }
  function acceptReceipt(
    data: RemoteSessionResult,
    operation: KnownRemoteOperation,
  ) {
    if (data.kind !== "receipt") return;
    if (data.status === "rejected") {
      if (!keepPending(null)) return;
      mutationError.current = data.code ?? "REMOTE_SESSION_REJECTED";
      setError(mutationError.current);
      return;
    }
    if (
      data.status !== "accepted" ||
      (operation.kind === "start" && !data.sessionId)
    ) {
      keepPending({
        ...operation,
        status: data.status === "processing" ? "processing" : "unconfirmed",
      });
      return;
    }
    if (!keepPending(null)) return;
    if (operation.kind === "start" && data.sessionId && scopeRef.current)
      binding.onBound(tab.id, data.sessionId, scopeRef.current, tab.agentName);
    if (operation.kind === "start" || operation.kind === "send") {
      setDraft("");
      writeRemoteDraft(tab, "");
    }
    mutationError.current = null;
    setError(null);
    setRefresh((v) => v + 1);
  }
  function adoptSnapshot(next: RemoteSnapshot) {
    const previous = snapshotRef.current;
    // Sequential latest-page polling plus a generation check for older-page requests.
    if (
      previous &&
      previous.generation === next.generation &&
      /^\d+$/.test(previous.revision) &&
      /^\d+$/.test(next.revision) &&
      BigInt(next.revision) < BigInt(previous.revision)
    )
      return;
    if (!previous || previous.generation !== next.generation) {
      pageEpoch.current++;
      setOlder([]);
      setBefore(next.nextBefore);
      setHasOlder(next.hasMoreBefore);
    } else if (olderRef.current.length === 0) {
      setBefore(next.nextBefore);
      setHasOlder(next.hasMoreBefore);
    }
    snapshotRef.current = next;
    setSnapshot(next);
  }
  const synchronize = useEffectEvent(async (cancelled: () => boolean) => {
    if (polling.current || busyRef.current) return;
    polling.current = true;
    try {
      if (!capableRef.current) {
        const response = await request({
          kind: "capabilities",
          agentId: tab.agentId,
        });
        if (cancelled() || !alive()) return;
        scopeRef.current = response.scope;
        setScope(response.scope);
        capableRef.current = true;
        setCapable(true);
        binding.onTarget?.(tab.id, response.scope);
      }
      const operation = pendingRef.current;
      if (operation && operation.kind !== "unknown") {
        const response = await request({
          kind: "receipt",
          agentId: tab.agentId,
          operationId: operation.operationId,
        });
        if (cancelled() || !alive()) return;
        acceptReceipt(response.data, operation);
      }
      if (tab.sessionId) {
        const response = await request({
          kind: "get",
          agentId: tab.agentId,
          sessionId: tab.sessionId,
          limit: 30,
        });
        if (cancelled() || !alive()) return;
        if (response.data.kind === "snapshot") adoptSnapshot(response.data);
      } else {
        const response = await request({
          kind: "list",
          agentId: tab.agentId,
          limit: 30,
        });
        if (cancelled() || !alive()) return;
        if (response.data.kind === "list") {
          // Latest page is an authoritative replacement. Older fetched pages
          // remain a separately labelled cache; missing latest rows stay gone.
          setList(response.data);
        }
      }
      if (!cancelled() && alive()) setError(mutationError.current);
    } catch (failure) {
      if (!cancelled() && alive()) setError(remoteErrorCode(failure));
    } finally {
      polling.current = false;
      if (!cancelled() && alive()) setLoading(false);
    }
  });
  useEffect(() => {
    if (!isActive || !online) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const sync = async () => {
      await synchronize(() => cancelled);
      if (!cancelled) timer = setTimeout(() => void sync(), 1500);
    };
    void sync();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isActive, online, tab.agentId, tab.sessionId, refresh]);
  async function mutate(operation: RemoteMutationRequest) {
    if (busyRef.current || pendingRef.current || !online || !capable) return;
    const tracked: KnownRemoteOperation = {
      kind: operation.kind,
      operationId: operation.operationId,
      status: "processing",
    };
    if (!keepPending(tracked)) return;
    if (scopeRef.current) binding.onTarget?.(tab.id, scopeRef.current);
    busyRef.current = true;
    setBusy(true);
    mutationError.current = null;
    setError(null);
    try {
      const response = await request(operation);
      if (alive()) acceptReceipt(response.data, tracked);
    } catch (failure) {
      if (alive()) {
        const code = remoteErrorCode(failure);
        if (
          code === "REMOTE_SESSION_UNCONFIRMED" ||
          code.endsWith("_UNCONFIRMED")
        )
          keepPending({ ...tracked, status: "unconfirmed" });
        else {
          if (!keepPending(null)) return;
          mutationError.current = code;
          setError(code);
        }
      }
    } finally {
      busyRef.current = false;
      if (alive()) setBusy(false);
    }
  }
  async function loadOlder() {
    if (!snapshot || !before || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const generation = snapshot.generation,
      epoch = pageEpoch.current;
    try {
      const response = await request({
        kind: "get",
        agentId: tab.agentId,
        sessionId: snapshot.sessionId,
        limit: 30,
        before,
      });
      if (
        !alive() ||
        epoch !== pageEpoch.current ||
        response.data.kind !== "snapshot" ||
        response.data.generation !== generation
      )
        return;
      const data = response.data;
      setOlder((previous) => [
        ...data.messages,
        ...previous.filter((m) => !data.messages.some((n) => n.id === m.id)),
      ]);
      setBefore(data.nextBefore);
      setHasOlder(data.hasMoreBefore);
    } catch (failure) {
      if (alive()) setError(remoteErrorCode(failure));
    } finally {
      busyRef.current = false;
      if (alive()) setBusy(false);
    }
  }
  async function moreSessions() {
    const cursor = (listTail ?? list)?.nextBefore;
    if (!cursor || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await request({
        kind: "list",
        agentId: tab.agentId,
        limit: 30,
        before: cursor,
      });
      if (alive() && response.data.kind === "list") {
        const data = response.data;
        setListTail((previous) => ({
          ...data,
          items: [
            ...(previous?.items ?? []),
            ...data.items.filter(
              (item) =>
                !previous?.items.some((p) => p.sessionId === item.sessionId),
            ),
          ],
        }));
      }
    } catch (failure) {
      if (alive()) setError(remoteErrorCode(failure));
    } finally {
      busyRef.current = false;
      if (alive()) setBusy(false);
    }
  }
  const disabled =
    !online ||
    !capable ||
    busy ||
    !!pending ||
    snapshot?.state === "unavailable";
  const state = !online
    ? "offline"
    : pending
      ? pending.status
      : loading
        ? "loading"
        : (snapshot?.terminal ?? snapshot?.state ?? "draft");
  const messages = [
    ...older.filter((m) => !snapshot?.messages.some((n) => n.id === m.id)),
    ...(snapshot?.messages ?? []),
  ];
  const errorKey = error?.includes("BUSY")
    ? "busy"
    : error?.includes("UNSUPPORTED") || error?.includes("METHOD")
      ? "unsupported"
      : "failed";
  const open = (sessionId?: string, title = tab.agentName) => {
    if (scopeRef.current)
      binding.onOpen({
        title,
        locator,
        agentId: tab.agentId,
        agentName: tab.agentName,
        deviceName: tab.deviceName,
        sessionId,
        targetScope: scopeRef.current,
      });
  };
  const sessionRow = (item: SessionList["items"][number]) => (
    <li key={item.sessionId}>
      <button
        type="button"
        className={`${button} block w-full py-3 text-left`}
        disabled={!online || !!pending}
        onClick={() => open(item.sessionId, item.title)}
      >
        <span className="block truncate font-medium">{item.title}</span>
        <span className="block truncate text-xs text-[var(--ink-muted)]">
          {item.preview}
        </span>
        <span className="text-xs text-[var(--ink-subtle)]">
          {item.runtime} ·{" "}
          {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : ""}
        </span>
      </button>
    </li>
  );
  const cachedSessions =
    listTail?.items.filter(
      (item) =>
        !list?.items.some((latest) => latest.sessionId === item.sessionId),
    ) ?? [];
  return (
    <div className="flex h-full min-w-0 flex-col bg-[var(--paper)] text-[var(--ink)]">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--line-subtle)] px-6 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">
            {snapshot?.title || tab.agentName}
          </h1>
          <p className="truncate text-xs text-[var(--ink-muted)]">
            {t("remoteSession.remote")} · {tab.deviceName} · {tab.agentName}
          </p>
          <p
            className="truncate font-mono text-xs text-[var(--ink-subtle)]"
            title={`${locator.deviceId} / ${tab.agentId}`}
          >
            {locator.deviceId} / {tab.agentId}
            {tab.sessionId ? ` / ${tab.sessionId}` : ""}
          </p>
        </div>
        <span role="status" className="text-xs text-[var(--ink-muted)]">
          {t(`remoteSession.states.${state}`)}
        </span>
        <button
          className={button}
          type="button"
          aria-label={t("remoteSession.refresh")}
          onClick={() => {
            setListTail(null);
            setRefresh((v) => v + 1);
          }}
          disabled={!online || busy}
        >
          <RefreshIcon className="h-4 w-4" />
        </button>
        <button
          className={button}
          type="button"
          onClick={() => open()}
          disabled={!online || !capable || !!pending}
        >
          <PlusIcon className="mr-1 inline h-4 w-4" />
          {t("remoteSession.newSession")}
        </button>
        {snapshot?.generation &&
          snapshot.turnId &&
          ["running", "waiting_user_action"].includes(snapshot.state) && (
            <button
              className={button}
              type="button"
              disabled={disabled}
              onClick={() =>
                void mutate({
                  kind: "stop",
                  agentId: tab.agentId,
                  sessionId: snapshot.sessionId,
                  generation: snapshot.generation!,
                  turnId: snapshot.turnId!,
                  operationId: crypto.randomUUID(),
                })
              }
            >
              <StopIcon className="mr-1 inline h-4 w-4" />
              {t("remoteSession.stop")}
            </button>
          )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {error && (
            <p
              className="rounded-lg bg-[var(--error-bg)] p-3 text-sm text-[var(--error)]"
              role="alert"
            >
              {t(`remoteSession.${errorKey}`)}{" "}
              <span className="font-mono text-xs">{error}</span>
            </p>
          )}
          {pending && (
            <div
              className="rounded-lg bg-[var(--warning-bg)] p-3 text-sm text-[var(--ink-secondary)]"
              role="status"
            >
              <p>
                {t(
                  pending.status === "unknown"
                    ? "remoteSession.operationUnknown"
                    : pending.status === "processing"
                      ? "remoteSession.processing"
                      : "remoteSession.unconfirmed",
                )}
              </p>
              <p className="mt-1 font-mono text-xs">{pending.operationId}</p>
              <button
                type="button"
                className={button}
                disabled={busy || !online || pending.kind === "unknown"}
                onClick={() => setRefresh((v) => v + 1)}
              >
                {t("remoteSession.checkReceipt")}
              </button>
            </div>
          )}
          {loading && (
            <p aria-busy="true" className="text-sm text-[var(--ink-muted)]">
              {t("remoteSession.states.loading")}
            </p>
          )}
          {!tab.sessionId && (
            <section aria-label={t("remoteSession.history")}>
              <h2 className="mb-3 text-sm font-semibold text-[var(--ink-muted)]">
                {t("remoteSession.history")}
              </h2>
              {!loading && list?.items.length === 0 && (
                <p className="py-5 text-sm text-[var(--ink-muted)]">
                  {t("remoteSession.empty")}
                </p>
              )}
              <ul>{list?.items.map(sessionRow)}</ul>
              {cachedSessions.length > 0 && (
                <>
                  <p className="mt-4 text-xs text-[var(--ink-muted)]">
                    {t("remoteSession.cachedHistory")}
                  </p>
                  <ul aria-label={t("remoteSession.cachedHistory")}>
                    {cachedSessions.map(sessionRow)}
                  </ul>
                </>
              )}
              {(listTail ?? list)?.hasMore && (
                <button
                  type="button"
                  className={button}
                  disabled={busy || !online}
                  onClick={() => void moreSessions()}
                >
                  {t("remoteSession.moreSessions")}
                </button>
              )}
            </section>
          )}
          {hasOlder && (
            <button
              type="button"
              className={button}
              disabled={busy || !online}
              onClick={() => void loadOlder()}
            >
              {t("remoteSession.older")}
            </button>
          )}
          {messages.map((message) => (
            <article
              key={message.id}
              className={
                message.role === "user"
                  ? "ml-auto max-w-[90%] rounded-xl bg-[var(--message-user-bg)] px-4 py-3"
                  : ""
              }
            >
              <Markdown
                workspacePath={null}
                remoteContent
                preserveNewlines={message.role === "user"}
                allowSetextHeadings={message.role !== "user"}
              >
                {message.content}
              </Markdown>
              {message.truncated && (
                <p className="mt-2 text-xs text-[var(--ink-muted)]">
                  {t("remoteSession.truncated")}
                </p>
              )}
              {message.tools.map((tool) => (
                <details
                  key={tool.id}
                  className="mt-3 rounded-lg bg-[var(--paper-inset)] p-3 text-sm"
                >
                  <summary>
                    {tool.name} · {t(`remoteSession.toolStates.${tool.status}`)}
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap text-xs text-[var(--ink-secondary)]">
                    {tool.summary}
                  </p>
                </details>
              ))}
            </article>
          ))}
          {snapshot?.interactions.map((interaction) => (
            <InteractionCard
              key={`${interaction.generation}:${interaction.turnId}:${interaction.requestId}`}
              interaction={interaction}
              disabled={
                disabled ||
                interaction.generation !== snapshot.generation ||
                interaction.turnId !== snapshot.turnId
              }
              onRespond={(approved, answers) =>
                void mutate({
                  kind: "respond",
                  agentId: tab.agentId,
                  sessionId: snapshot.sessionId,
                  generation: interaction.generation,
                  turnId: interaction.turnId,
                  requestId: interaction.requestId,
                  interaction: interaction.interaction,
                  approved,
                  answers,
                  operationId: crypto.randomUUID(),
                })
              }
            />
          ))}
        </div>
      </div>
      <form
        className="shrink-0 px-6 pb-4 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!disabled && text)
            void mutate(
              tab.sessionId
                ? {
                    kind: "send",
                    agentId: tab.agentId,
                    sessionId: tab.sessionId,
                    operationId: crypto.randomUUID(),
                    text,
                  }
                : {
                    kind: "start",
                    agentId: tab.agentId,
                    operationId: crypto.randomUUID(),
                    text,
                  },
            );
        }}
      >
        <div className="mx-auto max-w-3xl rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3">
          <label className="sr-only" htmlFor={`remote-composer-${tab.id}`}>
            {t("remoteSession.message")}
          </label>
          <textarea
            id={`remote-composer-${tab.id}`}
            value={draft}
            rows={3}
            maxLength={8000}
            disabled={disabled}
            className="max-h-48 min-h-20 w-full resize-y bg-transparent text-base text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
            placeholder={t("remoteSession.placeholder")}
            onChange={(event) => {
              setDraft(event.target.value);
              writeRemoteDraft(tab, event.target.value);
            }}
            onKeyDown={(event) => {
              if (isImeComposingEvent(event)) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[var(--ink-muted)]">
              {t("remoteSession.snapshotHint")}
              {snapshot?.runtime ? ` · ${snapshot.runtime}` : ""}
              {snapshot?.model ? ` · ${snapshot.model}` : ""}
            </span>
            <button
              type="submit"
              className={primary}
              disabled={disabled || !draft.trim()}
            >
              <SendIcon className="mr-1 inline h-4 w-4" />
              {t("remoteSession.send")}
            </button>
          </div>
        </div>
        <p className="mx-auto mt-2 max-w-3xl text-xs text-[var(--ink-subtle)]">
          {t("remoteSession.closeHint")}
        </p>
      </form>
    </div>
  );
}

function InteractionCard({
  interaction,
  disabled,
  onRespond,
}: {
  interaction: RemoteInteraction;
  disabled: boolean;
  onRespond: (approved: boolean, answers?: Record<string, string>) => void;
}) {
  const { t } = useTranslation("app");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const complete = interaction.questions.every(
    (q) => !!answers[q.answerKey]?.trim(),
  );
  return (
    <section
      className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4"
      aria-label={t(`remoteSession.interactions.${interaction.interaction}`)}
    >
      <h2 className="text-sm font-semibold">
        {interaction.title ||
          t(`remoteSession.interactions.${interaction.interaction}`)}
      </h2>
      <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--ink-secondary)]">
        {interaction.description}
      </p>
      {!interaction.actionable && (
        <p className="mt-2 text-xs text-[var(--warning)]">
          {t("remoteSession.incompleteInteraction")}
        </p>
      )}
      {interaction.interaction === "question" &&
        interaction.questions.map((q, index) => (
          <fieldset
            key={q.answerKey}
            className="mt-4"
            disabled={disabled || !interaction.actionable}
          >
            <legend className="text-sm">{q.question}</legend>
            {q.options.length > 0 ? (
              q.options.map((option) => (
                <label
                  key={option}
                  className="mr-3 inline-flex items-center gap-2 py-2 text-sm"
                >
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={`${interaction.requestId}-${index}`}
                    checked={
                      q.multiSelect
                        ? (answers[q.answerKey] ?? "")
                            .split("\n")
                            .includes(option)
                        : answers[q.answerKey] === option
                    }
                    onChange={(event) =>
                      setAnswers((previous) => {
                        const values = (previous[q.answerKey] ?? "")
                          .split("\n")
                          .filter(Boolean);
                        return {
                          ...previous,
                          [q.answerKey]: q.multiSelect
                            ? (event.target.checked
                                ? [...values, option]
                                : values.filter((v) => v !== option)
                              ).join("\n")
                            : option,
                        };
                      })
                    }
                  />
                  {option}
                </label>
              ))
            ) : (
              <input
                aria-label={q.question}
                maxLength={4000}
                className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] p-2 text-sm outline-[var(--focus-border)]"
                value={answers[q.answerKey] ?? ""}
                onChange={(event) =>
                  setAnswers((previous) => ({
                    ...previous,
                    [q.answerKey]: event.target.value,
                  }))
                }
              />
            )}
          </fieldset>
        ))}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className={primary}
          disabled={
            disabled ||
            !interaction.actionable ||
            (interaction.interaction === "question" && !complete)
          }
          onClick={() =>
            onRespond(
              true,
              interaction.interaction === "question" ? answers : undefined,
            )
          }
        >
          {t(
            interaction.interaction === "permission"
              ? "remoteSession.allowOnce"
              : interaction.interaction === "plan"
                ? "remoteSession.approvePlan"
                : "remoteSession.submitAnswers",
          )}
        </button>
        <button
          type="button"
          className={button}
          disabled={disabled}
          onClick={() => onRespond(false)}
        >
          {t("remoteSession.deny")}
        </button>
      </div>
    </section>
  );
}
