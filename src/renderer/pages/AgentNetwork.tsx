import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { metadataSchemas } from "@myagents/agent-network-protocol";
import {
  spaceGetSession,
  spaceLogout,
  type SpaceSessionView,
} from "@/api/spaceCloud";
import {
  allDeviceAgents,
  allNetworkDevices,
  networkErrorKey,
  networkRequest as requestNetwork,
  type NetworkRequest,
  type NetworkDevice,
  type NetworkSnapshot,
} from "@/api/agentNetwork";
import { useMyAgentsLogin } from "@/hooks/useMyAgentsLogin";
import { SpaceLogin } from "@/pages/space/SpaceChrome";
import ConfirmDialog from "@/components/ConfirmDialog";
import { getDeviceId, preloadDeviceId } from "@/identity/deviceIdentity";
import { useToastOptional } from "@/components/Toast";
import { copyPlainText } from "@/utils/clipboard";
import { openExternal } from "@/utils/openExternal";
import agentNetworkBanner from "@/assets/onboarding/agent-network-banner.jpg";
import { DeviceCard } from "@/features/agent-network/DeviceCard";
import { DeviceDetails } from "@/features/agent-network/DeviceDetails";
import { DeviceRenameDialog } from "@/features/agent-network/DeviceRenameDialog";
import type { DeviceCatalog } from "@/features/agent-network/deviceDisplay";
import {
  currentNetworkGeneration as networkGeneration,
  useAgentNetworkRegistry,
  useAgentNetworkSnapshot,
} from "@/features/agent-network/store";

import { NetworkHeader } from "@/features/agent-network/NetworkHeader";
import { NetworkSelector } from "@/features/agent-network/NetworkSelector";

const ownedCredentialStoreErrors = new Set([
  "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED",
  "NETWORK_CREDENTIAL_STORE_UNAVAILABLE",
  "NETWORK_CREDENTIAL_STORE_INVALID",
  "OWNED_SESSION_RECORD_MISSING",
]);

function networkStatusMessage(snapshot: NetworkSnapshot, official: boolean) {
  if (
    !official &&
    snapshot.state === "disconnected" &&
    snapshot.error &&
    ownedCredentialStoreErrors.has(snapshot.error.code)
  ) {
    return `agentNetwork.errors.${networkErrorKey(snapshot.error)}`;
  }
  if (snapshot.error?.code === "NETWORK_REMOVAL_UNCONFIRMED")
    return "agentNetwork.errors.removalPending";
  if (snapshot.state === "connecting") return "agentNetwork.connecting";
  if (snapshot.state === "disconnected") return "agentNetwork.reconnecting";
  return `agentNetwork.errors.${networkErrorKey(snapshot.error)}`;
}

export default function AgentNetwork({
  isActive = true,
}: {
  isActive?: boolean;
}) {
  const registry = useAgentNetworkRegistry();
  const selected =
    registry.selfhostEnabled === true ? registry.selected : "official";
  const connection =
    registry.connections.find((c) => c.id === selected) ??
    registry.connections[0];
  const snapshot = useAgentNetworkSnapshot(connection?.id);
  // An account boundary creates a fresh UI scope immediately, including dialogs
  // and mutations; old completions only hold the discarded component instance.
  return (
    <AgentNetworkContent
      key={`${connection?.id}:${snapshot.authGeneration}`}
      connectionId={connection?.id ?? "official"}
      official={connection?.official ?? true}
      selector={<NetworkSelector registry={registry} />}
      isActive={isActive}
      snapshot={snapshot}
    />
  );
}
function AgentNetworkContent({
  isActive,
  snapshot,
  connectionId,
  official,
  selector,
}: {
  isActive: boolean;
  snapshot: NetworkSnapshot;
  connectionId: string;
  official: boolean;
  selector: ReactNode;
}) {
  const { t } = useTranslation("app");
  const networkRequest = useCallback(
    (request: NetworkRequest) => requestNetwork(request, connectionId),
    [connectionId],
  );
  const [session, setSession] = useState<SpaceSessionView | null>(null),
    [authLoading, setAuthLoading] = useState(true);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [devices, setDevices] = useState<NetworkDevice[]>([]),
    [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null),
    [complete, setComplete] = useState(true);
  const [refresh, setRefresh] = useState(0),
    [selected, setSelected] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<NetworkDevice | null>(null);
  const [renaming, setRenaming] = useState<NetworkDevice | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({}),
    [errors, setErrors] = useState<Record<string, string>>({});
  const [catalogs, setCatalogs] = useState<Record<string, DeviceCatalog>>({});
  const flight = useRef(new Set<string>());
  const toast = useToastOptional();
  // Never throws: one device's unreadable catalog must not hide the others.
  const readCatalog = useCallback(
    async (deviceId: string): Promise<DeviceCatalog> => {
      try {
        const page = await allDeviceAgents(deviceId, connectionId);
        return { status: "ready", items: page.items, complete: page.complete };
      } catch (failure) {
        return {
          status: "error",
          error: t(`agentNetwork.errors.${networkErrorKey(failure)}`),
        };
      }
    },
    [t, connectionId],
  );
  const reloadAccount = useCallback(async () => {
    const generation = networkGeneration(connectionId);
    if (!official) {
      await preloadDeviceId();
      setAuthLoading(false);
      return;
    }
    setAuthLoading(true);
    setAccountError(null);
    try {
      const result = await spaceGetSession();
      if (generation !== networkGeneration(connectionId)) return;
      setSession(result);
      await preloadDeviceId();
    } catch (failure) {
      if (generation === networkGeneration(connectionId))
        setAccountError(t(`agentNetwork.errors.${networkErrorKey(failure)}`));
    } finally {
      if (generation === networkGeneration(connectionId)) setAuthLoading(false);
    }
  }, [t, connectionId, official]);
  const { authBusy, authFlow, startLogin } = useMyAgentsLogin(
    isActive,
    reloadAccount,
  );
  useEffect(() => {
    void reloadAccount();
  }, [reloadAccount, snapshot.authGeneration]);
  useEffect(() => {
    if (
      !isActive ||
      snapshot.state !== "ready" ||
      (official && session?.state !== "authenticated")
    )
      return;
    let cancelled = false;
    const generation = networkGeneration(connectionId);
    const current = () =>
      !cancelled && generation === networkGeneration(connectionId);
    setLoading(true);
    setLoadError(null);
    void Promise.all([
      networkRequest({ kind: "network" }),
      allNetworkDevices(connectionId),
    ])
      .then(async ([info, page]) => {
        if (!current()) return;
        metadataSchemas.network.parse(info);
        const localId = getDeviceId();
        setDevices(
          page.items.sort(
            (a, b) =>
              Number(b.deviceId === localId) - Number(a.deviceId === localId) ||
              a.name.localeCompare(b.name) ||
              a.deviceId.localeCompare(b.deviceId),
          ),
        );
        setComplete(page.complete);
        setLoading(false);
        // Cards show which Agents each device opens, so catalogs are read with
        // the device list; the previous catalogs stay visible until replaced.
        const entries = await Promise.all(
          page.items.map(
            async (device) =>
              [device.deviceId, await readCatalog(device.deviceId)] as const,
          ),
        );
        if (current()) setCatalogs(Object.fromEntries(entries));
      })
      .catch((failure) => {
        if (!current()) return;
        setLoadError(t(`agentNetwork.errors.${networkErrorKey(failure)}`));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isActive,
    snapshot.state,
    snapshot.revision,
    session?.state,
    refresh,
    readCatalog,
    t,
    official,
    connectionId,
    networkRequest,
  ]);
  async function retryCatalog(deviceId: string) {
    const generation = networkGeneration(connectionId);
    setCatalogs((current) => {
      const next = { ...current };
      delete next[deviceId];
      return next;
    });
    const catalog = await readCatalog(deviceId);
    if (generation === networkGeneration(connectionId))
      setCatalogs((current) => ({ ...current, [deviceId]: catalog }));
  }
  async function copyDeviceId(device: NetworkDevice) {
    try {
      await copyPlainText(device.deviceId);
      toast?.success(t("agentNetwork.copied"));
    } catch {
      toast?.error(t("agentNetwork.copyFailed"));
    }
  }
  async function renameDevice(device: NetworkDevice, name: string) {
    const generation = networkGeneration(connectionId);
    try {
      const result = metadataSchemas.deviceName.parse(
        await networkRequest({
          kind: "renameDevice",
          networkId: device.networkId,
          deviceId: device.deviceId,
          name,
          expectedName: device.name,
          mutationId: crypto.randomUUID(),
        }),
      );
      if (generation !== networkGeneration(connectionId)) return;
      if (
        result.deviceId !== device.deviceId ||
        result.networkId !== device.networkId ||
        result.principalId !== device.principalId
      )
        throw { code: "NETWORK_SCOPE_MISMATCH" };
      setDevices((current) =>
        current.map((item) =>
          item.deviceId === result.deviceId
            ? { ...item, name: result.name }
            : item,
        ),
      );
      setRenaming(null);
      setRefresh((value) => value + 1);
    } catch (failure) {
      if (generation !== networkGeneration(connectionId)) return;
      if (
        typeof failure === "object" &&
        failure !== null &&
        "code" in failure &&
        failure.code === "REVISION_CONFLICT" &&
        "details" in failure
      ) {
        const latest = metadataSchemas.deviceName.safeParse(failure.details);
        if (
          latest.success &&
          latest.data.deviceId === device.deviceId &&
          latest.data.networkId === device.networkId &&
          latest.data.principalId === device.principalId
        )
          setRenaming((current) =>
            current?.deviceId === device.deviceId
              ? { ...current, name: latest.data.name }
              : current,
          );
      }
      setRefresh((value) => value + 1);
      throw new Error(
        t(`agentNetwork.errors.${networkErrorKey(failure, "mutation")}`),
      );
    }
  }
  async function membership(device: NetworkDevice, joined: boolean) {
    if (flight.current.has(device.deviceId)) return;
    flight.current.add(device.deviceId);
    setBusy((current) => ({ ...current, [device.deviceId]: true }));
    setErrors((current) => ({ ...current, [device.deviceId]: "" }));
    const generation = networkGeneration(connectionId);
    try {
      metadataSchemas.membership.parse(
        await networkRequest({
          kind: "membership",
          networkId: device.networkId,
          deviceId: device.deviceId,
          joined,
          expectedMembershipRevision: device.membershipRevision,
          mutationId: crypto.randomUUID(),
        }),
      );
      if (generation !== networkGeneration(connectionId)) return;
      setLeaving(null);
      setRefresh((value) => value + 1);
      // Joining leads straight to choosing which workspaces to open.
      if (joined) setSelected(device.deviceId);
    } catch (failure) {
      if (generation !== networkGeneration(connectionId)) return;
      setLeaving(null);
      setErrors((current) => ({
        ...current,
        [device.deviceId]: t(
          `agentNetwork.errors.${networkErrorKey(failure, "mutation")}`,
        ),
      }));
      setRefresh((value) => value + 1);
    } finally {
      flight.current.delete(device.deviceId);
      setBusy((current) => ({ ...current, [device.deviceId]: false }));
    }
  }
  if (authLoading)
    return (
      <NetworkPage selector={selector} gated>
        <div
          className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]"
          aria-busy="true"
        >
          {t("agentNetwork.loading")}
        </div>
      </NetworkPage>
    );
  if (accountError)
    return (
      <NetworkPage selector={selector} gated>
        <div className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]">
          <p role="alert">
            {accountError}{" "}
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => {
                void reloadAccount();
              }}
            >
              {t("agentNetwork.retry")}
            </button>
          </p>
        </div>
      </NetworkPage>
    );
  if (official && (!session || session.state === "reauth_required")) {
    const accountName =
      session?.state === "reauth_required"
        ? (session.account.user.name ?? session.account.user.email)
        : null;
    return (
      <NetworkPage selector={selector} gated>
        <SpaceLogin
          authBusy={authBusy}
          authFlow={authFlow}
          onLogin={() => {
            void startLogin();
          }}
          reauthRequired={session?.state === "reauth_required"}
          accountName={accountName}
          onForgetAccount={() => {
            void spaceLogout().then(reloadAccount);
          }}
        />
      </NetworkPage>
    );
  }
  const localId = getDeviceId();
  const joinedDevices = devices.filter((device) => device.joined);
  const pendingDevices = devices.filter((device) => !device.joined);
  const joinedCatalogs = joinedDevices.map(
    (device) => catalogs[device.deviceId],
  );
  const catalogsKnown = joinedCatalogs.every(
    (catalog) => catalog?.status === "ready",
  );
  const openAgents = joinedCatalogs.reduce(
    (sum, catalog) =>
      sum +
      (catalog?.status === "ready"
        ? catalog.items.filter((agent) => agent.enabled).length
        : 0),
    0,
  );
  const directoryKnown = !loading && !loadError && snapshot.state === "ready";
  // First-use onboarding follows this device's membership, never remote catalogs.
  const showSetup =
    !loading &&
    !loadError &&
    snapshot.state === "ready" &&
    devices.find((device) => device.deviceId === localId)?.joined === false;
  const selectedDevice = devices.find((device) => device.deviceId === selected);
  const card = (device: NetworkDevice) => (
    <DeviceCard
      key={device.deviceId}
      device={device}
      catalog={catalogs[device.deviceId]}
      isLocal={device.deviceId === localId}
      busy={busy[device.deviceId] ?? false}
      error={errors[device.deviceId] || null}
      onOpen={() => setSelected(device.deviceId)}
      onJoin={() => {
        void membership(device, true);
      }}
      onLeave={() => setLeaving(device)}
      onRename={() => setRenaming(device)}
      onCopyId={() => {
        void copyDeviceId(device);
      }}
    />
  );
  return (
    <NetworkPage
      selector={selector}
      deviceCount={directoryKnown ? joinedDevices.length : null}
      agentCount={directoryKnown && catalogsKnown ? openAgents : null}
    >
      <>
        {(loadError || accountError) && (
          <p role="alert" className="mb-4 text-sm text-[var(--error)]">
            {loadError || accountError}{" "}
            <button
              type="button"
              className="underline"
              onClick={() => {
                setRefresh((value) => value + 1);
                if (accountError) void reloadAccount();
              }}
            >
              {t("agentNetwork.retry")}
            </button>
          </p>
        )}
        {snapshot.state !== "ready" && (
          <p role="status" className="mb-4 text-sm text-[var(--ink-muted)]">
            {t(networkStatusMessage(snapshot, official))}
          </p>
        )}
        {showSetup && (
          <>
            <button
              type="button"
              aria-label={t("agentNetwork.learnMore")}
              onClick={() => {
                void openExternal(
                  "https://myagents.io/blog/private-agent-network",
                );
              }}
              className="mb-4 block w-full overflow-hidden rounded-xl transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--paper)]"
            >
              <img
                src={agentNetworkBanner}
                width={1980}
                height={396}
                alt=""
                className="block h-auto w-full"
              />
            </button>
            <SetupGuide />
          </>
        )}
        {loading && devices.length === 0 && snapshot.state === "ready" ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {[0, 1].map((index) => (
              <div
                key={index}
                aria-busy="true"
                className="h-40 animate-pulse rounded-xl bg-[var(--paper-inset)]"
              />
            ))}
          </div>
        ) : (
          <>
            {joinedDevices.length > 0 && (
              <section className="mb-7">
                <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-[var(--ink-muted)]">
                  {t("agentNetwork.joinedDevices")}
                  <span className="font-normal text-[var(--ink-subtle)]">
                    {joinedDevices.length}
                  </span>
                </h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {joinedDevices.map(card)}
                </div>
              </section>
            )}
            {pendingDevices.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-[var(--ink-muted)]">
                  {t("agentNetwork.pendingDevices")}
                  <span className="font-normal text-[var(--ink-subtle)]">
                    {pendingDevices.length}
                  </span>
                </h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {pendingDevices.map(card)}
                </div>
              </section>
            )}
          </>
        )}
        {!loading &&
          !loadError &&
          snapshot.state === "ready" &&
          devices.length === 0 && (
            <p className="py-8 text-sm text-[var(--ink-muted)]">
              {t("agentNetwork.noDevices")}
            </p>
          )}
        {!complete && (
          <p className="mt-4 text-xs text-[var(--ink-muted)]">
            {t("agentNetwork.partial")}
          </p>
        )}
      </>
      {selectedDevice && (
        <DeviceDetails
          connectionId={connectionId}
          authGeneration={snapshot.authGeneration}
          connectionReady={snapshot.state === "ready"}
          device={selectedDevice}
          catalog={catalogs[selectedDevice.deviceId]}
          isLocal={selectedDevice.deviceId === localId}
          membershipBusy={busy[selectedDevice.deviceId] ?? false}
          membershipError={errors[selectedDevice.deviceId] || null}
          onJoin={() => {
            void membership(selectedDevice, true);
          }}
          onLeave={() => setLeaving(selectedDevice)}
          onRename={() => setRenaming(selectedDevice)}
          onCopyId={() => {
            void copyDeviceId(selectedDevice);
          }}
          onRetry={() => {
            void retryCatalog(selectedDevice.deviceId);
          }}
          onClose={() => setSelected(null)}
          onChanged={() => setRefresh((value) => value + 1)}
        />
      )}
      {renaming && (
        <DeviceRenameDialog
          key={renaming.deviceId}
          currentName={renaming.name}
          onConfirm={(name) => renameDevice(renaming, name)}
          onCancel={() => setRenaming(null)}
        />
      )}
      {leaving && (
        <ConfirmDialog
          title={t("agentNetwork.leaveTitle")}
          message={t("agentNetwork.leaveMessage")}
          confirmText={t("agentNetwork.leaveConfirm")}
          confirmVariant="danger"
          loading={busy[leaving.deviceId]}
          onCancel={() => setLeaving(null)}
          onConfirm={() => {
            void membership(leaving, false);
          }}
        />
      )}
    </NetworkPage>
  );
}

/** First-use path from the product story: join, open workspaces, then just talk. */
function SetupGuide() {
  const { t } = useTranslation("app");
  return (
    <ol className="mb-7 grid grid-cols-1 overflow-hidden rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)] md:grid-cols-3">
      {([1, 2, 3] as const).map((index) => {
        const current = index === 1;
        return (
          <li
            key={index}
            aria-current={current ? "step" : undefined}
            className="flex gap-3 border-[var(--line-subtle)] px-[18px] py-4 [&:not(:first-child)]:border-t md:[&:not(:first-child)]:border-l md:[&:not(:first-child)]:border-t-0"
          >
            <span
              className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border text-xs ${
                current
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-[var(--line-strong)] text-[var(--ink-muted)]"
              }`}
            >
              {index}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--ink)]">
                {t(`agentNetwork.guide.step${index}Title`)}
              </p>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                {t(`agentNetwork.guide.step${index}Body`)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Keep page chrome at one React/layout position across account and data gates. */
function NetworkPage({
  selector,
  children,
  gated = false,
  deviceCount = null,
  agentCount = null,
}: {
  selector: ReactNode;
  children: ReactNode;
  gated?: boolean;
  deviceCount?: number | null;
  agentCount?: number | null;
}) {
  return (
    <main className="h-full overflow-y-auto bg-[var(--paper)] text-[var(--ink)]">
      <div
        className={`mx-auto flex w-full max-w-5xl flex-col px-8 pb-12 pt-8 ${gated ? "h-full" : "min-h-full"}`}
      >
        <NetworkHeader
          selector={selector}
          deviceCount={deviceCount}
          agentCount={agentCount}
        />
        <div className={gated ? "min-h-0 flex-1" : undefined}>{children}</div>
      </div>
    </main>
  );
}
