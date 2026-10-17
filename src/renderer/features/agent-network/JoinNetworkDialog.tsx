import { useRef, useState } from "react";
import { FloatingFocusManager, useFloating } from "@floating-ui/react";
import { useTranslation } from "react-i18next";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { CloseIcon, LoaderIcon } from "@/components/icons";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import { useOwnedLoginFlow } from "./useOwnedLoginFlow";
import type { OwnedLoginAttempt } from "@/api/agentNetwork";

type JoinMode = "account" | "key";
export function JoinNetworkDialog({
  onConfirm,
  onOwnedStart,
  onOwnedOpen,
  onOwnedPoll,
  onOwnedCancel,
  onCancel,
  accountOnly = false,
  initialUrl = "",
  title,
}: {
  onConfirm: (url: string, key: string) => Promise<void>;
  onOwnedStart: (
    issuer: string,
    publicTlsCaFile?: string,
  ) => Promise<OwnedLoginAttempt>;
  onOwnedOpen: (attemptId: string) => Promise<void>;
  onOwnedPoll: (
    attemptId: string,
  ) => Promise<"pending" | "authenticated" | OwnedLoginAttempt>;
  onOwnedCancel: (attemptId: string) => Promise<void>;
  onCancel: () => void;
  accountOnly?: boolean;
  initialUrl?: string;
  title?: string;
}) {
  const { t } = useTranslation("app"),
    { t: common } = useTranslation("common");
  const [url, setUrl] = useState(initialUrl),
    [publicTlsCaFile, setPublicTlsCaFile] = useState(""),
    [showAdvanced, setShowAdvanced] = useState(false),
    [key, setKey] = useState(""),
    [mode, setMode] = useState<JoinMode>("account"),
    [legacyBusy, setBusy] = useState(false),
    [legacyError, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null),
    flight = useRef(false);
  const { refs, context } = useFloating({ open: true });
  const login = useOwnedLoginFlow({
    onOwnedStart,
    onOwnedOpen,
    onOwnedPoll,
    onOwnedCancel,
    onCancel,
  });
  const { attempt, notice } = login;
  const busy = legacyBusy || login.busy;
  const error = legacyError ?? login.error;
  const close = () => {
    if (busy) return;
    if (mode === "account") void login.cancel();
    else {
      setKey("");
      onCancel();
    }
  };
  useCloseLayer(() => {
    close();
    return true;
  }, 260);
  async function submitLegacy() {
    if (flight.current || !url.trim() || !key.trim()) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(url.trim(), key.trim());
      setKey("");
      onCancel();
    } catch (failure) {
      setKey("");
      setError(
        failure instanceof Error
          ? failure.message
          : t("agentNetwork.errors.failed"),
      );
      setBusy(false);
    } finally {
      flight.current = false;
    }
  }
  const startOwned = () => {
    setError(null);
    return login.start(url, publicTlsCaFile);
  };
  const hasAttempt = attempt !== null;
  const fixedServiceUrl = accountOnly && initialUrl.trim().length > 0;
  return (
    <OverlayBackdrop
      portal
      className="z-[260] px-4 py-4"
      onClose={busy ? undefined : close}
    >
      <FloatingFocusManager context={context} initialFocus={input}>
        <section
          ref={refs.setFloating}
          role="dialog"
          aria-modal="true"
          aria-labelledby="join-network-title"
          className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !isImeComposingEvent(e)) {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id="join-network-title" className="text-lg font-semibold">
              {title ?? t("agentNetwork.joinSelfhost")}
            </h2>
            <button
              type="button"
              onClick={close}
              disabled={busy}
              aria-label={common("actions.close")}
              className="rounded-lg p-2 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
          {!accountOnly && (
            <div
              className="mb-4 flex rounded-lg bg-[var(--paper-inset)] p-1"
              role="tablist"
            >
              {(["account", "key"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={mode === option}
                  disabled={busy || hasAttempt}
                  onClick={() => {
                    setMode(option);
                    setError(null);
                  }}
                  className="flex-1 rounded-md px-3 py-2 text-sm aria-selected:bg-[var(--paper-elevated)] aria-selected:font-medium"
                >
                  {t(
                    option === "account"
                      ? "agentNetwork.ownedLogin.mode"
                      : "agentNetwork.legacyKey.mode",
                  )}
                </button>
              ))}
            </div>
          )}
          <label
            htmlFor="network-url"
            className="mb-2 block text-sm font-medium"
          >
            {t("agentNetwork.serviceUrl")}
          </label>
          <input
            ref={input}
            id="network-url"
            type="url"
            autoComplete="url"
            placeholder="https://your-network.example"
            value={url}
            disabled={busy || hasAttempt}
            readOnly={fixedServiceUrl}
            aria-describedby={
              fixedServiceUrl ? "owned-login-fixed-service-url" : undefined
            }
            onChange={(e) => {
              if (!fixedServiceUrl) setUrl(e.target.value);
            }}
            className="mb-4 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
          {fixedServiceUrl && (
            <p
              id="owned-login-fixed-service-url"
              className="-mt-3 mb-4 text-xs text-[var(--ink-muted)]"
            >
              {t("agentNetwork.ownedLogin.fixedServiceUrl")}
            </p>
          )}
          {mode === "key" && !accountOnly ? (
            <>
              <label
                htmlFor="network-key"
                className="mb-2 block text-sm font-medium"
              >
                {t("agentNetwork.deviceKey")}
              </label>
              <input
                id="network-key"
                type="password"
                autoComplete="off"
                maxLength={256}
                value={key}
                disabled={busy}
                onChange={(e) => setKey(e.target.value)}
                className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              />
              <p className="mt-3 text-xs leading-relaxed text-[var(--ink-muted)]">
                {t("agentNetwork.selfhostHint")}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
                {t("agentNetwork.ownedLogin.hint")}
              </p>
              <details
                className="mt-3 text-sm"
                open={showAdvanced}
                onToggle={(event) => setShowAdvanced(event.currentTarget.open)}
              >
                <summary className="cursor-pointer text-[var(--ink-muted)]">
                  {t("agentNetwork.ownedLogin.advanced")}
                </summary>
                <label
                  htmlFor="network-public-ca"
                  className="mt-3 mb-2 block text-sm font-medium"
                >
                  {t("agentNetwork.ownedLogin.caFile")}
                </label>
                <input
                  id="network-public-ca"
                  type="text"
                  autoComplete="off"
                  placeholder="/path/to/test-ca.pem"
                  value={publicTlsCaFile}
                  disabled={busy || hasAttempt}
                  onChange={(e) => setPublicTlsCaFile(e.target.value)}
                  className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                />
                <p className="mt-2 text-xs leading-relaxed text-[var(--ink-muted)]">
                  {t("agentNetwork.ownedLogin.caHint")}
                </p>
                {attempt && (
                  <div className="mt-3">
                    <p className="text-xs font-medium">
                      {t("agentNetwork.ownedLogin.authorizationLink")}
                    </p>
                    <p className="mt-1 break-all text-xs text-[var(--ink-muted)]">
                      {attempt.authorizationUrl}
                    </p>
                  </div>
                )}
              </details>
              {attempt && (
                <div className="mt-4 rounded-lg border border-[var(--line)] p-3">
                  <p className="text-sm font-medium">
                    {t("agentNetwork.ownedLogin.waiting")}
                  </p>
                  {!login.expired && !login.stopped && (
                    <p
                      className="mt-2 flex items-center gap-2 text-xs text-[var(--ink-muted)]"
                      role="status"
                    >
                      <LoaderIcon className="h-4 w-4 animate-spin" />
                      {t("agentNetwork.ownedLogin.autoChecking")}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-[var(--ink-muted)]">
                    {t("agentNetwork.ownedLogin.expires", {
                      time: new Date(
                        attempt.expiresAt * 1000,
                      ).toLocaleTimeString(),
                    })}
                  </p>
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => void login.reopen()}
                      disabled={
                        busy || login.checking || login.expired || login.stopped
                      }
                      className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-50"
                    >
                      {t("agentNetwork.ownedLogin.openBrowser")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void login.check()}
                      disabled={
                        busy || login.checking || login.expired || login.stopped
                      }
                      className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-50"
                    >
                      {login.checking && (
                        <LoaderIcon className="h-4 w-4 animate-spin" />
                      )}
                      {t("agentNetwork.ownedLogin.check")}
                    </button>
                  </div>
                  {login.expired && (
                    <button
                      type="button"
                      onClick={() => void startOwned()}
                      disabled={busy || login.checking}
                      className="mt-3 rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 text-sm text-[var(--button-primary-text)] disabled:opacity-50"
                    >
                      {t("agentNetwork.ownedLogin.restart")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {notice && (
            <p role="status" className="mt-3 text-sm text-[var(--ink-muted)]">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-[var(--error)]">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={close}
              disabled={busy}
              className="rounded-lg px-4 py-2 text-sm hover:bg-[var(--paper-inset)]"
            >
              {hasAttempt
                ? t("agentNetwork.ownedLogin.cancel")
                : common("actions.cancel")}
            </button>
            {!hasAttempt && (
              <button
                type="button"
                onClick={() =>
                  void (mode === "account" ? startOwned() : submitLegacy())
                }
                disabled={
                  busy || !url.trim() || (mode === "key" && !key.trim())
                }
                className="flex items-center gap-2 rounded-lg bg-[var(--ink)] px-4 py-2 text-sm text-[var(--paper)] disabled:opacity-50"
              >
                {busy && <LoaderIcon className="h-4 w-4 animate-spin" />}
                {t(
                  busy
                    ? "agentNetwork.joiningSelfhost"
                    : mode === "account"
                      ? "agentNetwork.ownedLogin.start"
                      : "agentNetwork.join",
                )}
              </button>
            )}
          </div>
        </section>
      </FloatingFocusManager>
    </OverlayBackdrop>
  );
}
