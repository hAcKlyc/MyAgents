import { useRef, type ReactNode } from "react";
import { FloatingFocusManager, useFloating } from "@floating-ui/react";
import { useTranslation } from "react-i18next";
import {
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  InfoIcon,
} from "@/components/icons";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import type { NetworkDevice } from "@/api/agentNetwork";
import type { HostManagementAdapter } from "@/api/hostManagement";
import { AgentRow } from "./AgentRow";
import { HostManagement } from "./HostManagement";
import { OwnedHostManagement } from "./OwnedHostManagement";
import {
  DeviceIcon,
  DeviceMenu,
  deviceStatusText,
  LocalTag,
  osName,
  sortAgents,
  type DeviceCatalog,
} from "./deviceDisplay";

export function DeviceDetails({
  connectionId = "official",
  device,
  catalog,
  isLocal,
  onClose,
  onChanged,
  onRetry,
  onJoin,
  onLeave,
  onCopyId,
  onRename,
  membershipBusy,
  membershipError,
  authGeneration = 0,
  connectionReady = true,
  hostAdapter,
}: {
  connectionId?: string;
  device: NetworkDevice;
  /** `undefined` while the page is still reading this device's catalog. */
  catalog: DeviceCatalog | undefined;
  isLocal: boolean;
  onClose: () => void;
  onChanged: () => void;
  onRetry: () => void;
  onJoin: () => void;
  onLeave: () => void;
  onCopyId: () => void;
  onRename: () => void;
  membershipBusy: boolean;
  membershipError: string | null;
  authGeneration?: number;
  connectionReady?: boolean;
  /** Isolated acceptance harness seam; production never supplies a fixture. */
  hostAdapter?: HostManagementAdapter;
}) {
  const { t } = useTranslation("app");
  const {
    refs: { setFloating },
    context,
  } = useFloating({ open: true });
  const close = useRef<HTMLButtonElement>(null);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);
  const agents = catalog?.status === "ready" ? sortAgents(catalog.items) : [];
  const openCount = agents.filter((agent) => agent.enabled).length;
  const info: { label: string; value: ReactNode }[] = [
    {
      label: t("agentNetwork.system"),
      value: (
        <>
          {device.osVersion || "—"}
          {device.platform && (
            <span className="text-[var(--ink-subtle)]">
              {" · "}
              <span>{device.platform}</span>
            </span>
          )}
        </>
      ),
    },
    {
      label: t("agentNetwork.clientVersion"),
      value: device.appVersion || "—",
    },
    {
      label: t("agentNetwork.lastSeen"),
      value: device.lastNetworkSeenAt
        ? new Date(device.lastNetworkSeenAt).toLocaleString()
        : "—",
    },
    {
      label: t("agentNetwork.deviceId"),
      value: (
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-mono" title={device.deviceId}>
            {device.deviceId}
          </span>
          <button
            type="button"
            onClick={onCopyId}
            aria-label={t("agentNetwork.copyDeviceId")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <CopyIcon className="h-3.5 w-3.5" />
          </button>
        </span>
      ),
    },
  ];
  return (
    <OverlayBackdrop portal onClose={onClose} className="z-[220] p-4">
      <FloatingFocusManager context={context} initialFocus={close} returnFocus>
        <section
          ref={setFloating}
          role="dialog"
          aria-modal="true"
          aria-labelledby="network-device-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !isImeComposingEvent(event)) {
              event.stopPropagation();
              onClose();
            }
          }}
          className="flex max-h-[min(760px,90dvh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] shadow-xl"
        >
          <header className="flex items-center gap-3.5 px-6 pb-4 pt-5">
            <DeviceIcon device={device} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h2
                  id="network-device-title"
                  className="min-w-0 break-words text-lg font-semibold text-[var(--ink)] [overflow-wrap:anywhere]"
                >
                  {device.name}
                </h2>
                {isLocal && <LocalTag />}
              </div>
              <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
                {osName(device.platform)} · {deviceStatusText(t, device)}
              </p>
            </div>
            <DeviceMenu
              busy={membershipBusy}
              onCopyId={onCopyId}
              onRename={onRename}
              onLeave={device.joined ? onLeave : undefined}
            />
            <button
              ref={close}
              type="button"
              onClick={onClose}
              aria-label={t("agentNetwork.close")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 overflow-y-auto px-6 pb-5">
            {!device.joined && (
              <div className="mb-3 flex items-center gap-3 rounded-[10px] bg-[var(--accent)]/10 px-3.5 py-3 text-sm text-[var(--ink-secondary)]">
                <InfoIcon className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 flex-1">
                  {t("agentNetwork.notJoinedHint")}
                </span>
                <button
                  type="button"
                  onClick={onJoin}
                  disabled={membershipBusy}
                  aria-busy={membershipBusy}
                  className="shrink-0 rounded-lg bg-[var(--button-primary-bg)] px-2.5 py-1.5 text-xs font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-60"
                >
                  {t(
                    membershipBusy
                      ? "agentNetwork.saving"
                      : "agentNetwork.join",
                  )}
                </button>
              </div>
            )}
            {membershipError && (
              <p role="alert" className="mb-3 text-xs text-[var(--error)]">
                {membershipError}
              </p>
            )}
            {connectionId !== "official" && !hostAdapter ? (
              <OwnedHostManagement
                key={`${connectionId}:${device.principalId}:${device.networkId}:${device.deviceId}:${authGeneration}`}
                locator={{
                  connectionId,
                  principalId: device.principalId,
                  networkId: device.networkId,
                  deviceId: device.deviceId,
                  authGeneration,
                }}
                online={connectionReady && device.connectionState === "ready"}
              />
            ) : (
              <HostManagement
                adapter={hostAdapter}
                key={`${connectionId}:${device.principalId}:${device.networkId}:${device.deviceId}:${authGeneration}`}
                locator={{
                  connectionId,
                  principalId: device.principalId,
                  networkId: device.networkId,
                  deviceId: device.deviceId,
                  authGeneration,
                }}
                online={connectionReady && device.connectionState === "ready"}
              />
            )}
            <h3 className="mb-1.5 flex items-baseline gap-2 text-sm font-semibold text-[var(--ink-muted)]">
              {t("agentNetwork.agents")}
              {catalog?.status === "ready" && agents.length > 0 && (
                <span className="text-xs font-normal text-[var(--ink-subtle)]">
                  {t("agentNetwork.openRatio", {
                    open: openCount,
                    total: agents.length,
                  })}
                </span>
              )}
            </h3>
            {catalog === undefined ? (
              <div aria-busy="true" className="space-y-3 py-3">
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="h-12 animate-pulse rounded-[10px] bg-[var(--paper-inset)]"
                  />
                ))}
              </div>
            ) : catalog.status === "error" ? (
              <p role="alert" className="py-4 text-sm text-[var(--error)]">
                {catalog.error}{" "}
                <button type="button" onClick={onRetry} className="underline">
                  {t("agentNetwork.retry")}
                </button>
              </p>
            ) : agents.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">
                {t(
                  device.catalogSyncedAt === null
                    ? "agentNetwork.unsynced"
                    : "agentNetwork.noAgents",
                )}
              </p>
            ) : (
              <ul className="-mx-3">
                {agents.map((agent) => (
                  <AgentRow
                    connectionId={connectionId}
                    key={agent.mountId}
                    agent={agent}
                    device={device}
                    onChanged={onChanged}
                  />
                ))}
              </ul>
            )}
            {catalog?.status === "ready" && !catalog.complete && (
              <p className="py-3 text-xs text-[var(--ink-muted)]">
                {t("agentNetwork.partial")}
              </p>
            )}
            <details className="group/info mt-4 border-t border-[var(--line-subtle)] pt-2">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1.5 text-sm text-[var(--ink-muted)] hover:text-[var(--ink)] [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-open/info:rotate-90" />
                {t("agentNetwork.deviceInfo")}
              </summary>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 py-2 pl-5 text-xs">
                {info.map(({ label, value }) => (
                  <div key={label} className="contents">
                    <dt className="text-[var(--ink-muted)]">{label}</dt>
                    <dd className="min-w-0 break-words text-[var(--ink-secondary)]">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </div>
        </section>
      </FloatingFocusManager>
    </OverlayBackdrop>
  );
}
