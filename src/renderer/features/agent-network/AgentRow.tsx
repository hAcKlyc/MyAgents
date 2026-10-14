import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Tip from "@/components/Tip";
import { EditIcon, LoaderIcon, PlusIcon } from "@/components/icons";
import WorkspaceIcon from "@/components/launcher/WorkspaceIcon";
import {
  metadataSchemas,
  NETWORK_BUDGETS,
} from "@myagents/agent-network-protocol";
import {
  networkErrorKey,
  networkRequest as requestNetwork,
  type NetworkAgent,
  type NetworkDevice,
} from "@/api/agentNetwork";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import {
  clearDescriptionDraft,
  currentNetworkGeneration as networkGeneration,
  descriptionDraftKey,
  getDescriptionDraft,
  setDescriptionDraft,
} from "./store";
import { agentIconId } from "./deviceDisplay";

export function AgentRow({
  connectionId = "official",
  agent,
  device,
  onChanged,
  onOpenSession,
  sessionOnline = true,
}: {
  connectionId?: string;
  agent: NetworkAgent;
  device: NetworkDevice;
  onChanged: () => void;
  onOpenSession?: () => void;
  sessionOnline?: boolean;
}) {
  const { t } = useTranslation("app");
  const networkRequest = (request: Parameters<typeof requestNetwork>[0]) =>
    requestNetwork(request, connectionId);
  const key = descriptionDraftKey(
    agent.principalId,
    agent.networkId,
    agent.mountId,
  );
  const [description, setDescription] = useState(
    () => getDescriptionDraft(key) ?? agent.description ?? "",
  );
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const inFlight = useRef(false),
    switchFlight = useRef(false),
    escaped = useRef(false);
  const descriptionRef = useRef(description);
  descriptionRef.current = description;
  useEffect(() => {
    if (getDescriptionDraft(key) === undefined)
      setDescription(agent.description ?? "");
  }, [agent.description, key]);
  async function saveDescription() {
    if (escaped.current) {
      escaped.current = false;
      return;
    }
    if (inFlight.current) return;
    const value = descriptionRef.current.trim() || null;
    if (value === agent.description) {
      clearDescriptionDraft(key);
      setEditing(false);
      return;
    }
    setDescriptionDraft(key, descriptionRef.current);
    if (
      new TextEncoder().encode(value ?? "").length >
      NETWORK_BUDGETS.descriptionBytes
    ) {
      setError(t("agentNetwork.errors.descriptionTooLong"));
      return;
    }
    const generation = networkGeneration(connectionId);
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      metadataSchemas.mount.parse(
        await networkRequest({
          kind: "description",
          networkId: agent.networkId,
          mountId: agent.mountId,
          description: value,
          expectedDescriptionRevision: agent.descriptionRevision,
          expectedMembershipRevision: device.membershipRevision,
          mutationId: crypto.randomUUID(),
        }),
      );
      if (generation !== networkGeneration(connectionId)) return;
      clearDescriptionDraft(key);
      setEditing(false);
      onChanged();
    } catch (failure) {
      if (generation !== networkGeneration(connectionId)) return;
      setError(
        t(`agentNetwork.errors.${networkErrorKey(failure, "mutation")}`),
      );
      onChanged();
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  async function toggle() {
    if (switchFlight.current || !device.joined) return;
    const generation = networkGeneration(connectionId);
    switchFlight.current = true;
    setSwitchBusy(true);
    setSwitchError(null);
    try {
      metadataSchemas.mount.parse(
        await networkRequest({
          kind: "enabled",
          networkId: agent.networkId,
          mountId: agent.mountId,
          enabled: !agent.enabled,
          expectedEnableRevision: agent.enableRevision,
          expectedMembershipRevision: device.membershipRevision,
          mutationId: crypto.randomUUID(),
        }),
      );
      if (generation === networkGeneration(connectionId)) onChanged();
    } catch (failure) {
      if (generation === networkGeneration(connectionId)) {
        setSwitchError(
          t(`agentNetwork.errors.${networkErrorKey(failure, "mutation")}`),
        );
        onChanged();
      }
    } finally {
      switchFlight.current = false;
      setSwitchBusy(false);
    }
  }
  const startEditing = () => {
    escaped.current = false;
    setEditing(true);
  };
  let descriptionLine = null;
  if (editing) {
    descriptionLine = (
      <div>
        <textarea
          autoFocus
          rows={3}
          disabled={saving}
          value={description}
          aria-label={t("agentNetwork.descriptionFor", { name: agent.name })}
          className="block max-h-36 min-h-16 w-full resize-y rounded-lg border border-[var(--focus-border)] bg-[var(--paper)] px-2.5 py-2 text-sm leading-relaxed text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
          placeholder={t("agentNetwork.descriptionPlaceholder")}
          onChange={(event) => {
            setDescription(event.target.value);
            setDescriptionDraft(key, event.target.value);
          }}
          onBlur={() => {
            void saveDescription();
          }}
          onKeyDown={(event) => {
            if (isImeComposingEvent(event)) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              void saveDescription();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              escaped.current = true;
              clearDescriptionDraft(key);
              setDescription(agent.description ?? "");
              setError(null);
              setEditing(false);
            }
          }}
        />
        <p className="mt-1 flex justify-between gap-3 text-xs text-[var(--ink-subtle)]">
          <span>{t("agentNetwork.descriptionWhy")}</span>
          <span className="shrink-0">
            {saving ? (
              <span role="status">{t("agentNetwork.saving")}</span>
            ) : (
              t("agentNetwork.descriptionKeys")
            )}
          </span>
        </p>
      </div>
    );
  } else if (description) {
    descriptionLine = (
      <button
        type="button"
        onClick={startEditing}
        aria-label={t("agentNetwork.editDescription", { name: agent.name })}
        className="line-clamp-2 w-full whitespace-pre-line text-left text-sm leading-relaxed text-[var(--ink-secondary)] hover:text-[var(--ink)]"
      >
        {description}
      </button>
    );
  } else if (agent.enabled) {
    // An open Agent without a description is hard for other Agents to pick.
    descriptionLine = (
      <button
        type="button"
        onClick={startEditing}
        className="inline-flex items-center gap-1.5 rounded-md bg-[var(--warning-bg)] px-2 py-1 text-xs text-[var(--warning)]"
      >
        <EditIcon className="h-3 w-3" />
        {t("agentNetwork.descriptionNudge")}
      </button>
    );
  }
  return (
    <li className="group rounded-[10px] p-3 transition-colors hover:bg-[var(--hover-bg)]">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center">
          <WorkspaceIcon icon={agentIconId(agent.icon)} size={28} />
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-[var(--ink)]">
              {agent.name}
            </span>
            {agent.enabled && (
              <span className="shrink-0 rounded bg-[var(--accent)]/10 px-1.5 text-xs leading-[18px] text-[var(--accent)]">
                {t("agentNetwork.opened")}
              </span>
            )}
            {!editing && !description && !agent.enabled && (
              <button
                type="button"
                onClick={startEditing}
                aria-label={t("agentNetwork.addDescriptionFor", {
                  name: agent.name,
                })}
                className="inline-flex shrink-0 items-center gap-1 rounded px-1 text-xs text-[var(--ink-subtle)] opacity-0 transition-opacity hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] focus-visible:opacity-100 group-hover:opacity-100"
              >
                <PlusIcon className="h-3 w-3" />
                {t("agentNetwork.addDescription")}
              </button>
            )}
          </div>
          <p
            className="truncate font-mono text-xs text-[var(--ink-subtle)]"
            title={agent.path}
          >
            {displayPath(agent.path)}
          </p>
        </div>
        <Tip
          label={t("agentNetwork.joinToEnable")}
          disabled={device.joined}
          className="shrink-0"
        >
          <button
            type="button"
            role="switch"
            aria-checked={agent.enabled}
            aria-label={t("agentNetwork.enableAgent", { name: agent.name })}
            aria-busy={switchBusy}
            disabled={!device.joined || switchBusy}
            onClick={() => {
              void toggle();
            }}
            className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${agent.enabled ? "bg-[var(--accent)]" : "bg-[var(--line-strong)]"}`}
          >
            {switchBusy ? (
              <LoaderIcon className="mx-auto h-3.5 w-3.5 animate-spin text-[var(--ink-muted)]" />
            ) : (
              <span
                className={`h-4 w-4 rounded-full bg-[var(--paper-elevated)] shadow-sm transition-transform ${agent.enabled ? "translate-x-4" : ""}`}
              />
            )}
          </button>
        </Tip>
      </div>
      {onOpenSession && <button type="button" onClick={onOpenSession} disabled={!sessionOnline} className="mt-2 rounded-lg px-2.5 py-1.5 text-sm text-[var(--accent)] hover:bg-[var(--hover-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)] disabled:opacity-50">{t('remoteSession.openSession')}</button>}
      {descriptionLine && <div className="mt-2.5">{descriptionLine}</div>}
      {error && (
        <p className="mt-1.5 text-xs text-[var(--error)]" role="alert">
          {error}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              void saveDescription();
            }}
          >
            {t("agentNetwork.retry")}
          </button>
        </p>
      )}
      {switchError && (
        <p className="mt-1.5 text-xs text-[var(--error)]" role="alert">
          {switchError}
        </p>
      )}
    </li>
  );
}

/** Home-relative paths are what people recognise; the full path stays in the title. */
function displayPath(path: string): string {
  return path
    .replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}
