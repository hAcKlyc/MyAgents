import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ownedHostManagement, ownedHostErrorCode, sameOwnedHostScope, type OwnedHostCapabilities, type OwnedHostExtendedSnapshot, type OwnedHostScope, type OwnedHostOperation, type OwnedHostOwner, type PortableHostProvider } from "@/api/ownedHostManagement";
import { hostLocatorKey, type HostLocator } from "@/api/hostManagement";
import { loadDesktopHostConfigSource, versionPortableHostProfile } from "./desktopHostConfigSource";
import { ProviderConnectionFields, type ProviderConnectionValue } from "@/pages/settings/ProviderConnectionFields";
import { OwnedHostDirectoryPicker, displayHostPath } from "./OwnedHostDirectoryPicker";
import { DEFAULT_CONFIG, type Provider, type ModelEntity } from "@/config/types";
import { portableHostProviderToRegistry } from "@/../shared/hostProviderConfig";
import ModelManagementPanel from "@/components/ModelManagementPanel";
import { useCloseLayer } from "@/hooks/useCloseLayer";

const input = "w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";
const button = "rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";
const primary = "rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";
type GenericPending = { locatorKey: string; scope: OwnedHostScope; owner: OwnedHostOwner; mutationId: string; providerId?: string };
const pendingReceipts = new Map<string, GenericPending>();
const receiptKey = (locatorKey: string, scope: OwnedHostScope) => JSON.stringify([locatorKey, scope.serviceId, scope.environment, scope.principalId, scope.networkId, scope.deviceId, scope.keyGeneration]);

function toFields(provider: PortableHostProvider): ProviderConnectionValue {
  return { apiProtocol: provider.apiProtocol, baseUrl: provider.baseUrl, authType: provider.authType, upstreamFormat: provider.upstreamFormat ?? "chat_completions", maxOutputTokens: provider.maxOutputTokens === undefined ? "" : String(provider.maxOutputTokens), maxOutputTokensParamName: provider.maxOutputTokensParamName ?? (provider.upstreamFormat === "responses" ? "max_output_tokens" : "max_tokens") };
}
function fieldsToProvider(base: PortableHostProvider, fields: ProviderConnectionValue): PortableHostProvider {
  return { ...base, apiProtocol: fields.apiProtocol, baseUrl: fields.baseUrl.trim(), authType: fields.authType, ...(fields.apiProtocol === "openai" ? { upstreamFormat: fields.upstreamFormat, ...(fields.maxOutputTokens.trim() ? { maxOutputTokens: Number.parseInt(fields.maxOutputTokens, 10) } : { maxOutputTokens: undefined }), maxOutputTokensParamName: fields.maxOutputTokensParamName } : { upstreamFormat: undefined, maxOutputTokens: undefined, maxOutputTokensParamName: undefined }) };
}
function id() { return crypto.randomUUID(); }
function invalidateAsyncEpoch(epoch: { current: number }) { epoch.current++; }
function candidateModels(sourceModels: ModelEntity[] | undefined, provider: PortableHostProvider | null, modelId: string): ModelEntity[] {
  const candidates = sourceModels?.length ? sourceModels : [
    ...(modelId ? [{ model: modelId, modelName: modelId, modelSeries: "custom" as const }] : []),
    ...Object.values(provider?.modelAliases ?? {}).filter((value): value is string => typeof value === "string" && !!value.trim()).map(value => ({ model: value, modelName: value, modelSeries: "custom" as const })),
  ];
  const seen = new Set<string>();
  return candidates.filter(item => {
    if (!item.model || item.model.length > 160 || seen.has(item.model)) return false;
    seen.add(item.model);
    return true;
  }).slice(0, 128);
}

export function OwnedHostProviderConfiguration({ locator, scope, snapshot, capabilities, online, onRefresh }: {
  locator: HostLocator; scope: OwnedHostScope; snapshot: OwnedHostExtendedSnapshot; capabilities: OwnedHostCapabilities | null; online: boolean; onRefresh: () => void;
}) {
  const { t } = useTranslation("app");
  const [provider, setProvider] = useState<PortableHostProvider | null>(snapshot.provider);
  const [fields, setFields] = useState<ProviderConnectionValue | null>(() => snapshot.provider ? toFields(snapshot.provider) : null);
  const [execution, setExecution] = useState(snapshot.settings?.executionAuthorized ?? false);
  const [model, setModel] = useState(snapshot.settings?.model ?? "");
  const [workspace, setWorkspace] = useState(() => snapshot.settings?.workspace && snapshot.resources.roots.some(root => root.rootId === snapshot.settings?.workspace.rootId) ? snapshot.settings.workspace : { rootId: "", relativePath: "" });
  const [childName, setChildName] = useState("");
  const [credential, setCredential] = useState("");
  const [sourceHint, setSourceHint] = useState<{ agentName: string; path: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [picker, setPicker] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelEntities, setModelEntities] = useState<ModelEntity[]>(() => candidateModels(undefined, snapshot.provider, snapshot.settings?.model ?? ""));
  const [persistedProviderId, setPersistedProviderId] = useState(snapshot.settings?.providerId ?? "");
  const [profileDirty, setProfileDirty] = useState(false);
  const requestController = useRef<AbortController | null>(null);
  const activeScopeKey = useRef("");
  const cancellationEpoch = useRef(0);
  const profilePreparationToken = useRef<symbol | null>(null);
  const mayWriteRef = useRef(online && !snapshot.stopping);
  mayWriteRef.current = online && !snapshot.stopping;
  const mayConfigureRef = useRef(online && !snapshot.activeSession && !snapshot.stopping);
  mayConfigureRef.current = online && !snapshot.activeSession && !snapshot.stopping;
  const pipelineLock = useRef(false);
  const writeLock = useRef<symbol | null>(null);
  const currentPending = pendingReceipts.get(receiptKey(hostLocatorKey(locator), scope));
  const pending = currentPending && sameOwnedHostScope(currentPending.scope, scope) ? currentPending : undefined;
  const resolvedProvider = useMemo<Provider | null>(() => {
    if (!provider) return null;
    try {
      const entries = modelEntities.length ? modelEntities : [{ model, modelName: model, modelSeries: "custom", source: "manual" as const }];
      const registry = portableHostProviderToRegistry(provider, entries.map(item => item.model));
      const models = registry.models.map(item => {
        const candidate = entries.find(entry => entry.model === item.model);
        return candidate ? { ...item, ...candidate } : item;
      });
      // ModelManagementPanel has provider-ID special cases that persist directly
      // to desktop config. A synthetic Host-only ID keeps every path on callbacks.
      return { ...registry, models, primaryModel: model, id: `host-draft-${provider.id}`.slice(0, 128), vendor: "custom", cloudProvider: provider.name, isBuiltin: false, enabled: true } as Provider;
    } catch { return null; }
  }, [provider, model, modelEntities]);
  useCloseLayer(() => { if (modelsOpen) { setModelsOpen(false); return true; } return false; }, 210);

  const scopeKey = receiptKey(hostLocatorKey(locator), scope);
  const supports = (method: OwnedHostCapabilities["methods"][number]) => Boolean(capabilities?.methods.includes(method));
  useEffect(() => {
    activeScopeKey.current = scopeKey;
    return () => {
      if (activeScopeKey.current === scopeKey) activeScopeKey.current = "";
      invalidateAsyncEpoch(cancellationEpoch);
      profilePreparationToken.current = null;
      pipelineLock.current = false;
      requestController.current?.abort();
      requestController.current = null;
    };
  }, [scopeKey]);
  useEffect(() => {
    if (online && !snapshot.stopping) return;
    cancellationEpoch.current++;
    profilePreparationToken.current = null;
    pipelineLock.current = false;
    requestController.current?.abort();
    requestController.current = null;
    setSourceLoading(false);
    setBusy(false);
  }, [online, snapshot.stopping]);
  useEffect(() => {
    if (!snapshot.activeSession) return;
    cancellationEpoch.current++;
    profilePreparationToken.current = null;
    pipelineLock.current = false;
    setSourceLoading(false);
  }, [snapshot.activeSession]);
  const setPortableDraft = (next: PortableHostProvider, modelId: string, sourceModels?: ModelEntity[]) => {
    setProvider(next); setFields(toFields(next)); setModel(modelId);
    setModelEntities(candidateModels(sourceModels, next, modelId));
    setProfileDirty(true);
  };
  const startManualDraft = () => {
    const manual: PortableHostProvider = { id: `host-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`, name: "Custom Provider", apiProtocol: "anthropic", baseUrl: "https://api.anthropic.com", authType: "auth_token" };
    setPortableDraft(manual, snapshot.settings?.model || "claude-sonnet-4-5");
  };
  const applyReceipt = async (operation: OwnedHostOperation, owner: OwnedHostOwner, providerId?: string, allowRecovery = false, refreshAfter = true): Promise<boolean> => {
    const operationId = "mutationId" in operation.params ? operation.params.mutationId : "";
    if (!operationId || busy || writeLock.current || (!allowRecovery && pending)) return false;
    if (!pendingReceipts.has(scopeKey) && pendingReceipts.size >= 64) {
      setError(t("agentNetwork.ownedHost.failed", { code: "HOST_MANAGEMENT_CAPACITY" }));
      return false;
    }
    const identity: GenericPending = { locatorKey: hostLocatorKey(locator), owner, mutationId: operationId, scope, ...(providerId ? { providerId } : {}) };
    const lockToken = Symbol("host-write");
    writeLock.current = lockToken;
    pendingReceipts.set(scopeKey, identity); setBusy(true); setError(""); setNotice("");
    const controller = new AbortController();
    requestController.current = controller;
    const isCurrent = () => activeScopeKey.current === scopeKey && requestController.current === controller;
    try {
      const response = await ownedHostManagement(locator, scope, operation, controller.signal);
      if (!isCurrent()) return false;
      if (!sameOwnedHostScope(response.scope, scope)) throw { code: "HOST_MANAGEMENT_UNCONFIRMED" };
      const result = response.result;
      if (!result || !("status" in result) || result.status === "pending" || result.status === "not-found") {
        setNotice(t("agentNetwork.ownedHost.unknown")); return false;
      }
      if (result.status === "conflict") { pendingReceipts.delete(scopeKey); setNotice(t("agentNetwork.ownedHost.conflict")); onRefresh(); return false; }
      pendingReceipts.delete(scopeKey);
      if (owner === "config" && providerId) { setPersistedProviderId(providerId); setProfileDirty(false); }
      setNotice(t(owner === "credentials" ? "agentNetwork.ownedHost.credentialSaved" : owner === "resources" ? "agentNetwork.ownedHost.resourceRegistered" : "agentNetwork.ownedHost.profileSaved")); if (refreshAfter) onRefresh(); return true;
    } catch (cause) {
      if (!isCurrent()) return false;
      const code = ownedHostErrorCode(cause);
      if (!allowRecovery && !controller.signal.aborted && !["HOST_MANAGEMENT_UNCONFIRMED", "RESOURCE_UNCONFIRMED"].includes(code)) pendingReceipts.delete(scopeKey);
      setError(t("agentNetwork.ownedHost.failed", { code })); return false;
    } finally { if (writeLock.current === lockToken) writeLock.current = null; if (isCurrent()) { requestController.current = null; setBusy(false); } }
  };
  const saveProfile = async (selectedProvider = provider, selectedModel = model, selectedFields = fields, selectedWorkspace = workspace, prepared?: PortableHostProvider, refreshAfter = true, selectedExecution = execution) => {
    if (!mayConfigureRef.current || profilePreparationToken.current || !selectedProvider || !selectedFields || !selectedModel.trim() || !selectedWorkspace.rootId || busy || pending) return false;
    const token = Symbol("profile-preparation");
    profilePreparationToken.current = token;
    const epoch = cancellationEpoch.current;
    const operationScope = scopeKey;
    try {
      const plain = fieldsToProvider(selectedProvider, selectedFields);
      const finalized = prepared ?? await versionPortableHostProfile(plain, selectedModel.trim());
      if (profilePreparationToken.current !== token || cancellationEpoch.current !== epoch || activeScopeKey.current !== operationScope || !mayConfigureRef.current) return false;
      if (!supports("config.provider.set") || !supports("receipt.provider.get") || !capabilities?.providerKinds.includes(finalized.apiProtocol)) return false;
      const saved = await applyReceipt({ method: "config.provider.set", params: { provider: finalized, model: selectedModel.trim(), workspace: selectedWorkspace, executionAuthorized: selectedExecution, expectedRevision: snapshot.settings?.revision ?? 0, mutationId: id() } }, "config", finalized.id, false, refreshAfter);
      if (saved) setProfileDirty(false);
      return saved;
    } catch (cause) {
      if (profilePreparationToken.current !== token || cancellationEpoch.current !== epoch || activeScopeKey.current !== operationScope) return false;
      setError(t("agentNetwork.ownedHost.failed", { code: ownedHostErrorCode(cause) }));
      return false;
    } finally { if (profilePreparationToken.current === token) profilePreparationToken.current = null; }
  };
  const saveCredential = async (secret: string, providerId = persistedProviderId || snapshot.settings?.providerId || snapshot.credentials.providerId || "") => {
    if (!mayWriteRef.current || !supportsCredentialWrite || !providerId || !secret.trim() || busy || pending) return false;
    const expectedRevision = snapshot.credentials.providerId === providerId ? snapshot.credentials.revision : 0;
    return applyReceipt({ method: "credential.provider.set", params: { providerId, credential: secret, expectedRevision, mutationId: id() } }, "credentials", providerId);
  };
  const importDesktop = async () => {
    if (!mayConfigureRef.current || busy || sourceLoading || pipelineLock.current || pending || !supports("config.provider.set") || !supports("receipt.provider.get")) return;
    pipelineLock.current = true;
    const pipelineScope = scopeKey;
    const epoch = cancellationEpoch.current;
    const pipelineCurrent = () => pipelineLock.current && cancellationEpoch.current === epoch && activeScopeKey.current === pipelineScope && mayConfigureRef.current;
    setSourceLoading(true); setNotice(""); setError("");
    let secret: string | undefined;
    try {
      const source = await loadDesktopHostConfigSource();
      if (!pipelineCurrent()) return;
      secret = source.credential;
      setPortableDraft(source.provider, source.model, source.models);
      setSourceHint({ agentName: source.agentName, path: source.localWorkspacePath });
      if (!workspace.rootId) { setPicker(true); setNotice(t("agentNetwork.ownedHost.chooseTargetDirectory")); return; }
      const prepared = await versionPortableHostProfile(source.provider, source.model);
      if (!pipelineCurrent()) return;
      if (!capabilities?.providerKinds.includes(prepared.apiProtocol)) { setError(t("agentNetwork.ownedHost.sourceError", { code: "HOST_PROVIDER_KIND_UNSUPPORTED" })); return; }
      const saved = await saveProfile(source.provider, source.model, toFields(source.provider), workspace, prepared, false, snapshot.settings?.executionAuthorized ?? false);
      if (!pipelineCurrent()) return;
      if (!saved) return;
      if (secret && supportsCredentialWrite) {
        const credentialSaved = await saveCredential(secret, prepared.id);
        if (!pipelineCurrent()) return;
        if (!credentialSaved) { setError(""); setNotice(pendingReceipts.has(scopeKey) ? t("agentNetwork.ownedHost.partialCredentialUnknown") : t("agentNetwork.ownedHost.partialCredentialFailed")); }
      } else { setNotice(t(secret ? "agentNetwork.ownedHost.credentialUnsupported" : "agentNetwork.ownedHost.configurationOnly")); }
      if (pipelineCurrent()) onRefresh();
    } catch (cause) {
      if (!pipelineCurrent()) return;
      const code = ownedHostErrorCode(cause);
      setError(code === "HOST_SOURCE_PROVIDER_MISSING" ? t("agentNetwork.ownedHost.sourceEmpty") : t("agentNetwork.ownedHost.sourceError", { code }));
    } finally { secret = undefined; if (pipelineCurrent()) { pipelineLock.current = false; setSourceLoading(false); } }
  };
  const recover = async () => {
    if (!pending || busy) return;
    const op: OwnedHostOperation = pending.providerId && pending.owner !== "resources"
      ? { method: "receipt.provider.get", params: { owner: pending.owner as "config" | "credentials", providerId: pending.providerId, mutationId: pending.mutationId } }
      : { method: "receipt.get", params: { owner: pending.owner, mutationId: pending.mutationId } };
    await applyReceipt(op, pending.owner, pending.providerId, true);
  };
  const registerSelected = async () => {
    if (!online || busy || pending || !workspace.rootId || !workspace.relativePath) return;
    await applyReceipt({ method: "resources.register", params: { rootId: workspace.rootId, relativePath: workspace.relativePath, expectedRevision: snapshot.resources.revision, mutationId: id() } }, "resources");
  };
  const createChild = async () => {
    const relativePath = workspace.relativePath ? `${workspace.relativePath}/${childName}` : childName;
    if (!online || busy || pending || !workspace.rootId || !validHostChildName(childName)) return;
    await applyReceipt({ method: "resources.create", params: { rootId: workspace.rootId, relativePath, operation: "create", expectedRevision: snapshot.resources.revision, mutationId: id() } }, "resources");
    setChildName("");
  };
  const compatible = snapshot.resources.roots.length > 0;
  const supportsProfileWrite = supports("config.provider.set") && supports("receipt.provider.get") && !!capabilities?.providerKinds.includes(provider?.apiProtocol ?? "anthropic");
  const supportsProfileMethods = supports("config.provider.set") && supports("receipt.provider.get");
  const supportsCredentialWrite = supports("credential.provider.set") && supports("receipt.provider.get") && snapshot.credentials.writeAvailable;

  return <div className="space-y-4 rounded-xl border border-[var(--line)] p-4">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="text-sm font-semibold text-[var(--ink)]">{t("agentNetwork.ownedHost.desktopSource")}</h4>{sourceHint && <p className="mt-1 break-words text-xs text-[var(--ink-muted)]">{sourceHint.agentName} · {sourceHint.path}</p>}<p className="mt-1 text-xs text-[var(--ink-muted)]">{t("agentNetwork.ownedHost.sourceHint")}</p></div><button type="button" disabled={!online || (!!snapshot.activeSession || snapshot.stopping) || busy || sourceLoading || pipelineLock.current || !!pending || !compatible || !supportsProfileMethods} className={primary} onClick={() => void importDesktop()}>{t("agentNetwork.ownedHost.applyDesktop")}</button></div>
    <div className="space-y-3 border-t border-[var(--line)] pt-4">
      <h4 className="text-sm font-semibold text-[var(--ink)]">{t("agentNetwork.ownedHost.targetProvider")}</h4>
      {provider && fields ? <>
        <ProviderConnectionFields idPrefix={`host-provider-${provider.id}`} value={fields} allowBoth onChange={next => { setFields(next); setProvider(fieldsToProvider(provider, next)); setProfileDirty(true); }} />
        <label className="block space-y-1 text-sm text-[var(--ink)]"><span>{t("agentNetwork.ownedHost.targetModel")}</span><div className="flex gap-2"><input className={`${input} flex-1`} value={model} maxLength={160} onChange={e => { setModel(e.target.value); setProfileDirty(true); setModelEntities([{ model: e.target.value, modelName: e.target.value, modelSeries: "custom", source: "manual" }]); }} /><button type="button" className={`${button} shrink-0 whitespace-nowrap`} disabled={!resolvedProvider || busy || !online || !!snapshot.activeSession || snapshot.stopping} onClick={() => setModelsOpen(true)}>{t("agentNetwork.ownedHost.manageModels")}</button></div><span className="block text-xs text-[var(--ink-muted)]">{t("agentNetwork.ownedHost.modelSelectionOnly")}</span></label>
      </> : <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!online || !!snapshot.activeSession || snapshot.stopping || busy || pipelineLock.current || !!pending || !supportsProfileMethods} onClick={() => void importDesktop()}>{t("agentNetwork.ownedHost.loadDesktopSource")}</button><button type="button" className={button} disabled={!online || !!snapshot.activeSession || snapshot.stopping || busy || pipelineLock.current || !!pending || !supportsProfileWrite} onClick={startManualDraft}>{t("agentNetwork.ownedHost.manualProvider")}</button></div>}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"><label className="block min-w-0 space-y-1 text-sm text-[var(--ink)]"><span>{t("agentNetwork.ownedHost.targetDirectory")}</span><input className={input} readOnly value={workspace.rootId ? displayHostPath(snapshot.resources.roots.find(root => root.rootId === workspace.rootId)?.workspacePath ?? "", workspace.relativePath) : ""} placeholder={t("agentNetwork.ownedHost.chooseTargetDirectory")} /></label><button type="button" className={button} disabled={!online || !supports("resources.directory.list") || !snapshot.resources.roots.length || busy} onClick={() => setPicker(true)}>{t("agentNetwork.ownedHost.browseDirectories")}</button></div>
      <p className="break-words text-xs text-[var(--ink-muted)]">{t("agentNetwork.ownedHost.hostTargetCurrent", { provider: snapshot.provider?.name ?? "—", model: snapshot.settings?.model ?? "—" })}</p>
      <label className="flex items-center gap-2 text-sm text-[var(--ink)]"><input type="checkbox" checked={execution} disabled={!online || !!snapshot.activeSession || snapshot.stopping || busy || sourceLoading || !!pending || !supportsProfileWrite} onChange={event => { setExecution(event.target.checked); setProfileDirty(true); }} />{t("agentNetwork.ownedHost.execution")}</label>
      <button type="button" disabled={!provider || !fields || !model.trim() || !workspace.rootId || busy || pipelineLock.current || !!pending || !online || !supportsProfileWrite || !!snapshot.activeSession || snapshot.stopping} className={primary} onClick={() => void saveProfile()}>{t("agentNetwork.ownedHost.saveProfile")}</button>
      <div className="grid gap-3 border-t border-[var(--line)] pt-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label className="block min-w-0 space-y-1 text-sm text-[var(--ink)]"><span>{t("agentNetwork.ownedHost.childDirectoryName")}</span><input className={input} value={childName} onChange={event => setChildName(event.target.value)} maxLength={128} placeholder={t("agentNetwork.ownedHost.childDirectoryPlaceholder")} /></label>
        <button type="button" className={button} disabled={!online || busy || !!pending || !supports("resources.create") || !workspace.rootId || !validHostChildName(childName)} onClick={() => void createChild()}>{t("agentNetwork.ownedHost.createChildAgent")}</button>
      </div>
      <button type="button" className={button} disabled={!online || busy || !!pending || !supports("resources.register") || !workspace.rootId || !workspace.relativePath} onClick={() => void registerSelected()}>{t("agentNetwork.ownedHost.registerSelectedAgent")}</button>
      <section className="space-y-2 border-t border-[var(--line)] pt-3" aria-label={t("agentNetwork.ownedHost.agents")}>
        <h4 className="text-sm font-semibold text-[var(--ink)]">{t("agentNetwork.ownedHost.agents")}</h4>
        <ul className="space-y-2 text-sm text-[var(--ink-secondary)]">
          {snapshot.resources.agents.map(agent => (
            <li key={agent.agentId} className="min-w-0 break-words">
              <span>{agent.name} · {t(agent.enabled ? "agentNetwork.ownedHost.enabled" : "agentNetwork.ownedHost.disabled")}</span>
              <span className="block text-xs text-[var(--ink-muted)]">{agent.workspacePath}</span>
            </li>
          ))}
          {snapshot.resources.agents.length === 0 && (
            <li className="text-[var(--ink-muted)]">{t("agentNetwork.ownedHost.empty")}</li>
          )}
        </ul>
      </section>
      <form className="space-y-2 border-t border-[var(--line)] pt-3" onSubmit={e => { e.preventDefault(); const value = credential; setCredential(""); void saveCredential(value); }}>
        <label className="block space-y-1 text-sm text-[var(--ink)]"><span>{t("agentNetwork.ownedHost.targetKey")}</span><input type="password" autoComplete="new-password" className={input} value={credential} onChange={e => setCredential(e.target.value)} disabled={!online || snapshot.stopping || !supportsCredentialWrite || !snapshot.credentials.writeAvailable || busy || pipelineLock.current || !!pending || profileDirty || !(persistedProviderId || snapshot.settings?.providerId)} /></label>
        <p className="text-xs text-[var(--ink-muted)]">{snapshot.credentials.configured ? t("agentNetwork.ownedHost.targetKeyConfigured") : t("agentNetwork.ownedHost.credentialMissing")}</p>
        <button type="submit" className={button} disabled={!credential.trim() || !online || snapshot.stopping || !supportsCredentialWrite || !snapshot.credentials.writeAvailable || busy || pipelineLock.current || !!pending || profileDirty || !(persistedProviderId || snapshot.settings?.providerId)}>{t("agentNetwork.ownedHost.saveCredential")}</button>
      </form>
    </div>
    {(notice || error) && <p role={error ? "alert" : "status"} className={`break-words text-sm ${error ? "text-[var(--error)]" : "text-[var(--ink-secondary)]"}`}>{error || notice}</p>}
    {pending && <button type="button" className={button} disabled={!online || busy} onClick={() => void recover()}>{t("agentNetwork.ownedHost.checkReceipt")}</button>}
    {picker && supports("resources.directory.list") && <OwnedHostDirectoryPicker locator={locator} scope={scope} roots={snapshot.resources.roots} online={online} initial={workspace} onClose={() => setPicker(false)} onSelect={selected => { setWorkspace(selected); setProfileDirty(true); setPicker(false); }} />}
    {modelsOpen && resolvedProvider && <ModelManagementPanel provider={resolvedProvider} apiKey={undefined} config={DEFAULT_CONFIG} showModelParameterSettings={false} discoveryUnavailableMessage={t("agentNetwork.ownedHost.modelDiscoveryFromDesktop")} onClose={() => setModelsOpen(false)} onSaveCustomModels={async (_providerId, models) => { setModelEntities(models); setProfileDirty(true); }} onUpdateCustomProvider={async updated => { const models = updated.models as ModelEntity[]; setModelEntities(models); setProfileDirty(true); if (!models.some(item => item.model === model)) setModel(models[0]?.model ?? ""); }} onSetPrimaryModel={async (_providerId, selected) => { setModel(selected); setProfileDirty(true); }} onRefresh={async () => undefined} />}
  </div>;
}

function validHostChildName(value: string) { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
