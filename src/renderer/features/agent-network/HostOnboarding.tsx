import { useEffect, useRef, useState } from "react";
import { FloatingFocusManager, useFloating } from "@floating-ui/react";
import { useTranslation } from "react-i18next";
import CustomSelect from "@/components/CustomSelect";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { CloseIcon } from "@/components/icons";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import { copyPlainText } from "@/utils/clipboard";
import { openExternal } from "@/utils/openExternal";
import { APP_BUILD_PROFILE, APP_WEBSITE_URL } from "../../../shared/appProfile";
import {
  allCallableAgents,
  allNetworkDevices,
  type CallableAgent,
  type NetworkDevice,
  type NetworkSnapshot,
} from "@/api/agentNetwork";
import { currentNetworkGeneration } from "./store";

export const HOST_INSTALL_INSTRUCTIONS =
  "https://github.com/heavenzhang/MoXBots/blob/178b8047f78e51f843e5c0636d2e0182f192c8b1/scripts/host/README.md#unified-local-host--owned-agentnet-test-installation";
const buttonClass =
  "rounded-lg border border-[var(--line)] px-3 py-2 text-sm hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass =
  "rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50";
type Directory<T> = { items: T[]; complete: boolean };
type CheckResult = {
  scope: string;
  devices: Directory<NetworkDevice> | null;
  callable: Directory<CallableAgent> | null;
  time: number;
};

/** Read-only onboarding: installation and account authorization stay on the target. */
export function HostOnboarding({
  connectionId,
  snapshot,
  networkName,
  serviceUrl,
  official,
  localDeviceId,
  onClose,
  onManage,
}: {
  connectionId: string;
  snapshot: NetworkSnapshot;
  networkName: string;
  serviceUrl: string | null;
  official: boolean;
  localDeviceId: string;
  onClose: () => void;
  onManage: (device: NetworkDevice) => void;
}) {
  const { t } = useTranslation("app");
  const text = (key: string, values?: Record<string, string | number>) =>
    t(`agentNetwork.hostOnboarding.${key}`, values);
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<"desktop" | "linux">("desktop");
  const [installed, setInstalled] = useState(false);
  const [joined, setJoined] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [checkingScope, setCheckingScope] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const requestId = useRef(0);
  const scope = JSON.stringify([
    connectionId,
    snapshot.authGeneration,
    snapshot.principalId,
    snapshot.networkId,
    snapshot.revision,
    snapshot.state,
  ]);
  const {
    refs: { setFloating },
    context,
  } = useFloating({ open: true });
  useCloseLayer(() => {
    onClose();
    return true;
  }, 230);
  const busy = checkingScope === scope;
  useEffect(() => {
    requestId.current++;
    const requests = requestId;
    return () => {
      requests.current++;
    };
  }, [scope]);
  const ready =
    snapshot.state === "ready" &&
    !!snapshot.networkId &&
    !!snapshot.principalId;
  const current = ready && result?.scope === scope ? result : null;
  const targets = current?.devices?.items ?? [];
  const device = targets.find((item) => item.deviceId === targetId);
  const online = !!device?.joined && device.connectionState === "ready";
  const count =
    current?.callable?.items.filter((agent) => agent.deviceId === targetId)
      .length ?? 0;
  const commands = ["start", "wait", "join"]
    .map(
      (action) =>
        `sudo python3 scripts/host/network-control.py --profile ${APP_BUILD_PROFILE === "moxbot" ? "moxbot-test" : "myagents-test"} ${action}`,
    )
    .join("\n");
  async function act(action: () => Promise<void>, success?: string) {
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
    } catch {
      setNotice(text("actionFailed"));
    }
  }
  async function check() {
    if (!ready || busy) return;
    const id = ++requestId.current;
    const expectedScope = scope;
    const generation = currentNetworkGeneration(connectionId);
    setCheckingScope(scope);
    setResult(null);
    const [devices, callable] = await Promise.allSettled([
      allNetworkDevices(connectionId),
      allCallableAgents(snapshot.networkId!, connectionId),
    ]);
    if (
      id !== requestId.current ||
      generation !== currentNetworkGeneration(connectionId)
    )
      return;
    // A response for a different principal/network can never make this guide pass.
    const directory =
      devices.status === "fulfilled" &&
      devices.value.items.every(
        (item) =>
          item.networkId === snapshot.networkId &&
          item.principalId === snapshot.principalId,
      )
        ? devices.value
        : null;
    setResult({
      scope: expectedScope,
      devices: directory,
      callable: callable.status === "fulfilled" ? callable.value : null,
      time: Date.now(),
    });
    setCheckingScope(null);
  }
  let onlineText = text("unknown");
  let executionText = text("unknown");
  if (busy) onlineText = executionText = text("checking");
  else if (!current || !current.devices) {
    if (!ready || (current && !current.devices))
      onlineText = executionText = text("unavailable");
  } else if (!device) onlineText = executionText = text("unselected");
  else {
    onlineText = text(
      !device.joined
        ? "notJoined"
        : device.connectionState === "ready"
          ? "onlineYes"
          : device.connectionState === "syncing"
            ? "syncing"
            : "offline",
    );
    executionText = !online
      ? text(
          !device.joined
            ? "notJoined"
            : device.connectionState === "syncing"
              ? "syncing"
              : "offline",
        )
      : targetId === localDeviceId
        ? text("localExecution")
        : !current.callable
          ? text("unavailable")
          : count > 0
            ? text("callable", { count })
            : !current.callable.complete
              ? text("partial")
              : text("noAgent");
  }
  return (
    <OverlayBackdrop portal onClose={onClose} className="z-[230] p-3 sm:p-4">
      <FloatingFocusManager context={context} initialFocus={close} returnFocus>
        <section
          ref={setFloating}
          role="dialog"
          aria-modal="true"
          aria-labelledby="host-guide-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !isImeComposingEvent(event)) {
              event.stopPropagation();
              onClose();
            }
          }}
          className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xl"
        >
          <header className="flex items-start justify-between gap-3 px-5 pb-4 pt-5 sm:px-6">
            <div>
              <h2 id="host-guide-title" className="text-lg font-semibold">
                {text("title")}
              </h2>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                {text("intro")}
              </p>
            </div>
            <button
              ref={close}
              type="button"
              aria-label={text("close")}
              onClick={onClose}
              className="shrink-0 rounded-lg p-2 hover:bg-[var(--hover-bg)]"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </header>
          <ol
            aria-label={text("title")}
            className="grid grid-cols-2 gap-2 border-y border-[var(--line-subtle)] bg-[var(--paper-inset)] px-5 py-3 text-xs sm:grid-cols-4 sm:px-6"
          >
            {[1, 2, 3, 4].map((index) => (
              <li
                key={index}
                aria-current={step === index ? "step" : undefined}
                className={`flex items-center gap-2 ${step === index ? "font-semibold text-[var(--accent)]" : "text-[var(--ink-muted)]"}`}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current">
                  {index}
                </span>
                {text(`step${index}`)}
              </li>
            ))}
          </ol>
          <div className="min-h-0 overflow-y-auto px-5 py-5 text-sm leading-relaxed sm:px-6">
            {step === 1 && (
              <fieldset className="space-y-3">
                <legend className="mb-3 font-semibold">{text("step1")}</legend>
                {(["desktop", "linux"] as const).map((option) => (
                  <label
                    key={option}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${kind === option ? "border-[var(--accent)] bg-[var(--paper-inset)]" : "border-[var(--line)]"}`}
                  >
                    <input
                      type="radio"
                      name="host-kind"
                      value={option}
                      checked={kind === option}
                      onChange={() => {
                        setKind(option);
                        setInstalled(false);
                        setJoined(false);
                      }}
                      className="mt-1"
                    />
                    <span>
                      <span className="block font-semibold">
                        {text(option)}
                      </span>
                      <span className="mt-1 block text-[var(--ink-muted)]">
                        {text(`${option}Hint`)}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {step === 2 && (
              <div className="space-y-4">
                <h3 className="font-semibold">
                  {text(kind === "desktop" ? "desktopInstall" : "linuxInstall")}
                </h3>
                <p className="text-[var(--ink-muted)]">
                  {text(
                    kind === "desktop"
                      ? "desktopInstallBody"
                      : "linuxInstallBody",
                  )}
                </p>
                {kind === "linux" && (
                  <p className="rounded-xl bg-[var(--paper-inset)] p-3 text-[var(--ink-secondary)]">
                    {text("linuxLimit")}
                  </p>
                )}
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() =>
                    void act(() =>
                      openExternal(
                        kind === "desktop"
                          ? `${APP_WEBSITE_URL.replace(/\/$/, "")}/download/`
                          : HOST_INSTALL_INSTRUCTIONS,
                      ),
                    )
                  }
                >
                  {text(kind === "desktop" ? "download" : "instructions")}
                </button>
                <label className="flex items-start gap-2 border-t border-[var(--line-subtle)] pt-4">
                  <input
                    type="checkbox"
                    checked={installed}
                    onChange={(event) => setInstalled(event.target.checked)}
                    className="mt-1"
                  />
                  {text("installed")}
                </label>
              </div>
            )}
            {step === 3 && (
              <div className="space-y-4">
                <h3 className="font-semibold">{text("loginTitle")}</h3>
                <p className="text-[var(--ink-muted)]">
                  {text(kind === "desktop" ? "desktopLogin" : "linuxLogin")}
                </p>
                <div className="break-words rounded-xl border border-[var(--line)] p-3">
                  <p className="text-xs text-[var(--ink-muted)]">
                    {text("network")}
                  </p>
                  <p className="mt-1 font-semibold">
                    {networkName || text("official")}
                  </p>
                  {!official && (
                    <p className="mt-1 break-all font-mono text-xs">
                      {serviceUrl || "—"}
                    </p>
                  )}
                </div>
                <p className="text-[var(--ink-muted)]">{text("sameAccount")}</p>
                {kind === "linux" && (
                  <>
                    <p className="text-[var(--ink-muted)]">
                      {text(official ? "linuxOfficial" : "linuxOwned")}
                    </p>
                    <pre
                      aria-label={text("commands")}
                      className="overflow-x-auto rounded-xl bg-[var(--paper-inset)] p-3 text-xs"
                    >
                      {commands}
                    </pre>
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() =>
                        void act(() => copyPlainText(commands), text("copied"))
                      }
                    >
                      {text("copy")}
                    </button>
                  </>
                )}
                <label className="flex items-start gap-2 border-t border-[var(--line-subtle)] pt-4">
                  <input
                    type="checkbox"
                    checked={joined}
                    onChange={(event) => setJoined(event.target.checked)}
                    className="mt-1"
                  />
                  {text("loginDone")}
                </label>
              </div>
            )}
            {step === 4 && (
              <div className="space-y-4">
                <p className="font-semibold">{text("select")}</p>
                <CustomSelect
                  ariaLabel={text("select")}
                  value={targetId}
                  placeholder={text("choose")}
                  disabled={busy || !ready || targets.length === 0}
                  options={targets.map((item) => ({
                    value: item.deviceId,
                    label: `${item.name} · ${item.deviceId}`,
                  }))}
                  onChange={setTargetId}
                  size="md"
                />
                <button
                  type="button"
                  disabled={busy || !ready}
                  className={buttonClass}
                  onClick={() => void check()}
                >
                  {text(busy ? "checking" : "refresh")}
                </button>
                {!ready || (current && !current.devices) ? (
                  <p role="alert" className="text-[var(--error)]">
                    {text("readError")}
                  </p>
                ) : (
                  <p className="text-xs text-[var(--ink-muted)]">
                    {text("notFound")}
                  </p>
                )}
                <dl aria-live="polite" className="grid gap-3 sm:grid-cols-2">
                  {[
                    ["online", onlineText],
                    ["execution", executionText],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-xl border border-[var(--line)] p-4"
                    >
                      <dt className="text-xs text-[var(--ink-muted)]">
                        {text(label)}
                      </dt>
                      <dd
                        className={`mt-2 font-semibold ${label === "online" && online && !busy ? "text-[var(--success)]" : "text-[var(--ink)]"}`}
                      >
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                {current &&
                  (!current.devices?.complete ||
                    !current.callable?.complete) && (
                    <p className="text-xs text-[var(--ink-muted)]">
                      {text(
                        current.devices && current.callable
                          ? "partial"
                          : "unavailable",
                      )}
                    </p>
                  )}
                <p className="text-[var(--ink-muted)]">
                  {text("executionHint")}
                </p>
                {targetId === localDeviceId && (
                  <p className="text-xs text-[var(--ink-muted)]">
                    {text("localHint")}
                  </p>
                )}
                <p className="text-xs text-[var(--ink-muted)]">
                  {text("boundary")}
                </p>
                {current?.devices && (
                  <p className="text-xs text-[var(--ink-subtle)]">
                    {text("observed", {
                      time: new Date(current.time).toLocaleTimeString(),
                    })}
                  </p>
                )}
                <button
                  type="button"
                  disabled={!online || busy || !current}
                  className={buttonClass}
                  onClick={() => {
                    if (device && online && current && !busy) onManage(device);
                  }}
                >
                  {text("manage")}
                </button>
                <p className="text-xs text-[var(--ink-muted)]">
                  {text("finishHint")}
                </p>
              </div>
            )}
            {notice && (
              <p role="status" className="mt-3 text-sm text-[var(--ink-muted)]">
                {notice}
              </p>
            )}
          </div>
          <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--line-subtle)] px-5 py-4 sm:px-6">
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setNotice(null);
                if (step === 1) onClose();
                else setStep(step - 1);
              }}
            >
              {text(step === 1 ? "close" : "back")}
            </button>
            {step < 4 ? (
              <button
                type="button"
                className={primaryClass}
                disabled={(step === 2 && !installed) || (step === 3 && !joined)}
                onClick={() => {
                  setNotice(null);
                  setStep(step + 1);
                  if (step === 3) void check();
                }}
              >
                {text("next")}
              </button>
            ) : (
              <button
                type="button"
                className={primaryClass}
                disabled={!online || busy || !current}
                onClick={onClose}
              >
                {text("done")}
              </button>
            )}
          </footer>
        </section>
      </FloatingFocusManager>
    </OverlayBackdrop>
  );
}
