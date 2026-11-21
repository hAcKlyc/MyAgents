import { GroupedModelList, providerModelGroups } from '@/components/GroupedModelList';
import { Popover } from '@/components/ui/Popover';
// TaskAdvancedConfigEditor — collapsible "高级配置" block shared by the
// task dispatch dialog and the task edit panel.
//
// Default semantics: every field is `undefined` (== "跟随 Agent 工作区当前
// 配置"). The user opts in per field by picking a concrete value, which
// snapshots that value onto the Task. PRD 0.2.4 §需求 4.
//
// Permission-mode default has special meaning: when left at "跟随默认", the
// task executor uses the runtime's *maximum* permission (e.g. SDK builtin
// → bypassPermissions). This is intentional — task dispatch is unattended
// by definition, so a task that lands in `auto` mode would block at the
// first tool call waiting for confirmation that nobody is around to give.
// The cron execute path has long hardcoded `'fullAgency'` for this reason
// (see `src/server/index.ts` `/cron/execute-sync`); the field surfaced here is
// the user-facing escape hatch when they want a stricter mode.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDownIcon, SlidersIcon } from '@/components/icons';
import CustomSelect from '@/components/CustomSelect';
import { useConfig } from '@/hooks/useConfig';
import { useAvailableProviders } from '@/hooks/useAvailableProviders';
import { useBrowserResourceReady } from '@/hooks/useBrowserResourceReady';
import { useToast } from '@/components/Toast';
import { isProviderAvailable } from '@/config/services/providerService';
import {
  CC_MODELS,
  RUNTIME_DISPLAY_NAMES,
  VALID_RUNTIMES,
  getRuntimePermissionModes,
  buildRuntimeChangePatch,
  isAgentRuntimeSelectorAvailable,
  RUNTIME_CONFIG_PER_RUNTIME_FIELDS,
  type RuntimeModelInfo,
  type RuntimeSource,
  type RuntimeType,
} from '@/../shared/types/runtime';
import { isPermissionModeForRuntimeIdentity, managedCodexProviderPermissionToRuntimePermission } from '@/../shared/providerExecution';
import {
  AGENT_RUNTIME_DISTRIBUTION_POLICY,
  isRuntimeAllowedByDistribution,
} from '@/../shared/integrated-runtimes/distribution-policy';
import type { McpServerDefinition } from '@/config/types';
import type { RuntimeConfig } from '@/../shared/types/runtime';
import { getAllMcpServersFromConfig } from '@/config/services/mcpService';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import {
  applyBuiltinBrowserExecutionToolToggle,
  MANAGED_BROWSER_MCP_ID,
} from '@/../shared/browserTools';
import { apiGetJson } from '@/api/apiFetch';
import {
  clearRuntimeModelOverride,
  resolveAgentRuntimeModelCatalogIdentity,
  resolveRuntimeModelCatalogIdentity,
  runtimeModelCatalogPath,
} from '@/utils/runtimeModelCatalog';
import { projectProvidersForRuntime } from '@/utils/runtimeProviderProjection';

// "跟随" sentinel: an empty-string value selected from <CustomSelect>
// translates back to `undefined` on the wrapper level. Using `''` rather
// than a different sentinel keeps the option compatible with the existing
// `<CustomSelect value={…}>` contract (which doesn't tolerate `undefined`).
const FOLLOW_VALUE = '';

interface Props {
  /** Workspace path the task is bound to — used to resolve the workspace's
   *  Agent (runtime / model / MCP defaults) and provider (model picker).
   *  Display name for hint copy is derived internally from the resolved
   *  project so callers don't need to thread it through separately. */
  workspacePath?: string;

  // ─── Runtime / provider / model / permission mode ────────────────────
  runtime?: RuntimeType;
  setRuntime: (v: RuntimeType | undefined) => void;
  /** PRD 0.2.9 — Per-task provider id override. MUST be paired with
   *  `model`; the picker writes both atomically. `undefined` = follow Agent. */
  providerId?: string;
  setProviderId: (v: string | undefined) => void;
  model?: string;
  setModel: (v: string | undefined) => void;
  /** PRD 0.2.9 — External-runtime model override (claude-code / codex).
   *  Stored on `runtimeConfig.model` rather than `model` because
   *  external-runtime ids never collide with builtin provider model ids
   *  and the cron exec path reads them from runtimeConfig. */
  runtimeConfig?: RuntimeConfig;
  setRuntimeConfig: (v: RuntimeConfig | undefined) => void;
  permissionMode?: string;
  setPermissionMode: (v: string | undefined) => void;

  // ─── MCP enable list ─────────────────────────────────────────────────
  /** `undefined` = follow Agent. `[]` = explicitly run with no MCP servers. */
  mcpEnabledServers?: string[];
  setMcpEnabledServers: (v: string[] | undefined) => void;
}

export function TaskAdvancedConfigEditor(props: Props) {
  const { t } = useTranslation('task');
  const { t: tSettings } = useTranslation('settings');
  const toast = useToast();
  const managedBrowserReady = useBrowserResourceReady();
  const {
    workspacePath,
    runtime,
    setRuntime: setRuntimeRaw,
    providerId,
    setProviderId,
    model,
    setModel,
    runtimeConfig,
    setRuntimeConfig,
    permissionMode,
    setPermissionMode,
    mcpEnabledServers,
    setMcpEnabledServers,
  } = props;

  // Default-collapsed; expand state is local to the panel lifecycle.
  // Auto-expand if any value is already set (so "edit existing override"
  // doesn't hide what the user previously configured).
  const hasAnyOverride =
    runtime !== undefined
    || (providerId && providerId.length > 0)
    || (model && model.length > 0)
    || (runtimeConfig?.model && runtimeConfig.model.length > 0)
    || (permissionMode && permissionMode.length > 0)
    || mcpEnabledServers !== undefined;
  const [open, setOpen] = useState<boolean>(hasAnyOverride);
  const [modelPickerOpen, setModelPickerOpen] = useState<'builtin' | 'external' | null>(null);

  const { config, projects, providers, apiKeys, providerVerifyStatus } = useConfig();
  // PRD 0.2.9 — All credentialed providers (cross-provider list, mirrors
  // Chat's WorkspaceBasicsSection). Pre-#130 the picker showed only the
  // workspace's single bound provider; that's the bug this PRD fixes.
  const credentialedProviders = useAvailableProviders();

  // Resolve the workspace's Agent — source of truth for the runtime / model
  // / permission / MCP defaults that the task inherits when the user picks
  // "跟随 Agent". DSH shares MyAgents Product provider/model/MCP
  // configuration; only user-managed CLIs own those fields themselves.
  const workspaceAgent = useMemo(() => {
    if (!workspacePath) return null;
    const project = projects.find(candidate => workspacePathsEqual(candidate.path, workspacePath));
    return project?.agentId
      ? config?.agents?.find(agent => agent.id === project.agentId) ?? null
      : null;
  }, [workspacePath, config, projects]);

  // Runtime selection follows the build distribution; Task overrides retain their identity.
  const runtimeSelectorAvailable = isAgentRuntimeSelectorAvailable();

  // Effective runtime that this task will run under (in this UI's view):
  //   Task override (if set) > explicit Agent choice > root Integrated default
  // External runtimes self-manage model/permission/MCP, so all three
  // sub-fields are gated on `effectiveRuntime === 'builtin'`.
  const agentRuntimeCatalogIdentity = resolveAgentRuntimeModelCatalogIdentity(
    workspaceAgent,
    config?.defaultIntegratedRuntime,
  );
  const agentRuntime = agentRuntimeCatalogIdentity.runtime;
  const runtimeCatalogIdentity = resolveRuntimeModelCatalogIdentity(
    runtime,
    runtimeConfig,
    agentRuntimeCatalogIdentity,
  );
  const rawEffectiveRuntime = runtimeCatalogIdentity.runtime;
  const effectiveRuntimeSource = runtimeCatalogIdentity.source;
  const effectiveRuntime: RuntimeType = rawEffectiveRuntime;
  const usesProductConfiguration = effectiveRuntime === 'builtin' || effectiveRuntime === 'dsh';
  const availableProviders = useMemo(
    () => projectProvidersForRuntime(credentialedProviders, effectiveRuntime),
    [credentialedProviders, effectiveRuntime],
  );
  const agentRuntimeLabel = RUNTIME_DISPLAY_NAMES[agentRuntime] ?? agentRuntime;
  const effectiveRuntimeLabel = RUNTIME_DISPLAY_NAMES[effectiveRuntime] ?? effectiveRuntime;

  // Wrap `setRuntime` to clear runtime-specific stale fields on switch.
  //
  // Two layers of fields care about cross-runtime drift:
  //
  //   1. **Task-level fields** (task.providerId / task.model / task.permissionMode /
  //      task.mcpEnabledServers) — providerId/model/MCP are builtin-only
  //      (Rust validator rejects them on external runtimes); permissionMode
  //      vocabulary differs per runtime so it must clear on any switch.
  //
  //   2. **Per-task runtimeConfig** (runtimeConfig.model / .permissionMode /
  //      .additionalArgs) — same bug class as agent-level Bug B (issue #194
  //      follow-up). Earlier version of this handler only cleared
  //      `runtimeConfig.model` when switching back to builtin, leaving the
  //      external→external case (claude-code → codex) leaking a Claude model into a
  //      Codex task. Codex CLI then rejects with "model is not supported".
  //
  // The runtimeConfig scrub now reuses `buildRuntimeChangePatch` so it's in
  // lockstep with the agent-level confirmRuntimeChange / Settings /
  // Launcher / `myagents agent set runtime` paths.
  //
  // No-op guard compares the complete catalog identity. Codex system CLI and
  // managed provider share a RuntimeType but not model/permission vocabularies,
  // so returning to an Agent with the other source must still scrub stale
  // per-runtime fields.
  const setRuntime = useCallback(
    (next: RuntimeType | undefined) => {
      setRuntimeRaw(next);
      const nextEffective: RuntimeType = next ?? agentRuntime;
      const nextIdentity = resolveRuntimeModelCatalogIdentity(
        next,
        next === runtime ? runtimeConfig : undefined,
        agentRuntimeCatalogIdentity,
      );
      if (
        nextIdentity.runtime === rawEffectiveRuntime
        && nextIdentity.source === effectiveRuntimeSource
      ) return;

      // Task-level permissionMode (independent of runtimeConfig).
      if (permissionMode !== undefined) setPermissionMode(undefined);

      // Per-task runtimeConfig scrub — same policy as agent-level.
      // Only call setter when there's actually something to remove, so a
      // runtimeConfig containing ONLY envPolicy doesn't get pointlessly
      // re-allocated on every runtime toggle.
      const hasScrubbableFields = RUNTIME_CONFIG_PER_RUNTIME_FIELDS.some((k) => {
        const v = runtimeConfig?.[k];
        return Array.isArray(v) ? v.length > 0 : v !== undefined;
      });
      if (hasScrubbableFields) {
        const scrubbed = buildRuntimeChangePatch(runtimeConfig, nextEffective).runtimeConfig;
        setRuntimeConfig(scrubbed);
      }

      // Product provider/model/MCP fields remain valid for Builtin and DSH.
      if (nextEffective !== 'builtin' && nextEffective !== 'dsh') {
        if (providerId !== undefined) setProviderId(undefined);
        if (model !== undefined) setModel(undefined);
        if (mcpEnabledServers !== undefined) setMcpEnabledServers(undefined);
      }
    },
    [
      setRuntimeRaw,
      setProviderId,
      setModel,
      setPermissionMode,
      setMcpEnabledServers,
      setRuntimeConfig,
      providerId,
      model,
      permissionMode,
      mcpEnabledServers,
      runtimeConfig,
      runtime,
      agentRuntime,
      rawEffectiveRuntime,
      effectiveRuntimeSource,
      agentRuntimeCatalogIdentity,
    ],
  );

  // Workspace project — used to resolve provider/model fallback when the
  // Agent's `model` is unset, and to derive the display name for hint copy.
  const workspaceProject = useMemo(() => {
    if (!workspacePath) return null;
    return projects.find((p) => workspacePathsEqual(p.path, workspacePath)) ?? null;
  }, [workspacePath, projects]);

  // Workspace display label — derived locally from the resolved project so
  // the parent dialog doesn't have to thread a separate `workspaceLabel`
  // prop. Mirrors the precedence used elsewhere (Launcher / DispatchTaskDialog).
  const workspaceDisplayName =
    workspaceProject?.displayName
    || workspaceProject?.name
    || '';

  // PRD 0.2.9 — Workspace-default provider lookup (used only for the
  // "跟随 Agent (当前 X)" hint label, NOT to constrain the picker). The
  // picker itself lists ALL credentialed providers via
  // `availableProviders` above. Precedence mirrors WorkspaceBasicsSection:
  //   agent.providerId → project.providerId → null
  const workspaceProvider = useMemo(() => {
    const wsProviderId =
      workspaceAgent?.providerId
      ?? workspaceProject?.providerId
      ?? null;
    if (!wsProviderId) return null;
    return providers.find((p) => p.id === wsProviderId) ?? null;
  }, [workspaceAgent, workspaceProject, providers]);

  // The currently-picked provider for THIS task — when `providerId` is set,
  // resolve to a Provider object (may be undefined if the provider has been
  // deleted from config since the task was saved). Read from the FULL
  // provider list (not `availableProviders`) so a provider whose API key
  // was just removed still surfaces — see R8 stale-provider UX below.
  const pickedProvider = useMemo(() => {
    if (!providerId) return null;
    return providers.find((p) => p.id === providerId) ?? null;
  }, [providerId, providers]);
  const pickedProviderAvailable = pickedProvider
    ? isProviderAvailable(pickedProvider, apiKeys, providerVerifyStatus)
    : true;

  // "Current model" display label for the "跟随 Agent" sentinel, so the
  // user always knows what "follow" actually resolves to.
  const workspaceEffectiveModelId =
    workspaceAgent?.model || workspaceProject?.model || '';
  const workspaceDefaultModelLabel = (() => {
    if (workspaceEffectiveModelId) {
      const hit = workspaceProvider?.models?.find(
        (m) => m.model === workspaceEffectiveModelId,
      );
      return hit?.modelName || workspaceEffectiveModelId;
    }
    return workspaceProvider?.primaryModel || '';
  })();

  // Picked-model display label (when the task carries an explicit override).
  const pickedModelLabel = useMemo(() => {
    if (!providerId || !model) return null;
    const provider = pickedProvider;
    const hit = provider?.models?.find((m) => m.model === model);
    return hit?.modelName || model;
  }, [providerId, model, pickedProvider]);

  // PRD 0.2.9 R5 — External runtime model list (claude-code/codex).
  // Static for CC; dynamic for Codex (queried from the CLI). Mirrors
  // Chat.tsx:721-738. Empty list while the fetch is in flight is fine —
  // the picker just shows "跟随 Agent 当前模型" alone.
  const [codexCatalog, setCodexCatalog] = useState<{
    runtime: RuntimeType;
    source: RuntimeSource;
    models: RuntimeModelInfo[];
  } | null>(null);
  useEffect(() => {
    if (effectiveRuntime !== 'codex' && effectiveRuntime !== 'antigravity') return;
    let cancelled = false;
    const source = effectiveRuntimeSource ?? 'system-cli';
    apiGetJson<{ models?: RuntimeModelInfo[] }>(
      runtimeModelCatalogPath(effectiveRuntime, source),
    )
      .then((res) => {
        if (!cancelled) setCodexCatalog({ runtime: effectiveRuntime, source, models: res?.models ?? [] });
      })
      .catch(() => {
        if (!cancelled) setCodexCatalog({ runtime: effectiveRuntime, source, models: [] });
      });
    return () => { cancelled = true; };
  }, [effectiveRuntime, effectiveRuntimeSource]);
  const externalRuntimeModels: RuntimeModelInfo[] = useMemo(() => {
    if (effectiveRuntime === 'claude-code') return CC_MODELS;
    if (effectiveRuntime === 'codex' || effectiveRuntime === 'antigravity') {
      return codexCatalog?.runtime === effectiveRuntime && codexCatalog.source === (effectiveRuntimeSource ?? 'system-cli')
        ? codexCatalog.models
        : [];
    }
    return [];
  }, [effectiveRuntime, effectiveRuntimeSource, codexCatalog]);

  // PRD 0.2.9 — Pair-write helpers. Selecting a provider's model writes
  // BOTH `providerId` and `model` atomically; selecting "跟随 Agent" uses
  // the explicit clear flag (handled at the caller level via
  // `setProviderId(undefined) + setModel(undefined)`) so nothing stays
  // half-set.
  const selectBuiltinFollow = useCallback(() => {
    setProviderId(undefined);
    setModel(undefined);
    setModelPickerOpen(null);
  }, [setProviderId, setModel]);
  const selectBuiltinModel = useCallback((pid: string, mid: string) => {
    setProviderId(pid);
    setModel(mid);
    setModelPickerOpen(null);
  }, [setProviderId, setModel]);
  const selectExternalFollow = useCallback(() => {
    if (runtimeConfig?.model) {
      setRuntimeConfig(clearRuntimeModelOverride(runtimeConfig));
    }
    setModelPickerOpen(null);
  }, [runtimeConfig, setRuntimeConfig]);
  const selectExternalModel = useCallback((mid: string) => {
    setRuntimeConfig({ ...(runtimeConfig ?? {}), model: mid });
    setModelPickerOpen(null);
  }, [runtimeConfig, setRuntimeConfig]);

  // MCP catalogue — single source of truth via the shared
  // `getAllMcpServersFromConfig` helper (preset + custom merge, platform
  // filter, args/env overrides). Without this, the editor used to
  // duplicate the preset+custom merge inline and silently dropped the
  // args/env override layer that production execution actually applies —
  // the picker would visually claim a server "is enabled" while the
  // running cron tick used a different env. PRD 0.2.4 §3.6.
  const mcpCatalogue: McpServerDefinition[] = useMemo(() => {
    if (!config) return [];
    return getAllMcpServersFromConfig(config).slice().sort(
      (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'),
    );
  }, [config]);

  const runtimeOptions = useMemo(
    () => [
      {
        value: FOLLOW_VALUE,
        // Inline the Agent's actual current runtime in the option label
        // (consistent with the model picker's "跟随 Agent（当前 X）" shape)
        // so the user can see what "follow" resolves to without scanning a
        // separate hint line. `agentRuntimeLabel` is always truthy because
        // the fallback chain (`RUNTIME_DISPLAY_NAMES[r] ?? r`) covers every
        // possible RuntimeType.
        label: t('advanced.followAgentWorkspaceCurrent', { value: agentRuntimeLabel }),
      },
      ...VALID_RUNTIMES.filter(runtime =>
        isRuntimeAllowedByDistribution(AGENT_RUNTIME_DISTRIBUTION_POLICY, runtime),
      ).map((r) => ({
        value: r,
        label: RUNTIME_DISPLAY_NAMES[r],
      })),
    ],
    [agentRuntimeLabel, t],
  );

  // Permission-mode options — runtime-specific. Each runtime defines its
  // own set of permission strings (builtin: auto/plan/fullAgency/custom;
  // CC: default/acceptEdits/bypassPermissions/plan/dontAsk/auto;
  // Codex: auto-edit/full-auto/no-restrictions (managed uses product projection).
  // Sourcing from the canonical
  // `getRuntimePermissionModes` registry means adding a new runtime's
  // perm modes only requires updating that one switch — the picker here
  // surfaces them automatically.
  const permissionOptions = useMemo(
    () => [
      { value: FOLLOW_VALUE, label: t('advanced.permissionFollow') },
      ...(effectiveRuntime === 'codex' && effectiveRuntimeSource === 'managed-provider'
        ? getRuntimePermissionModes('builtin').flatMap((m) => {
          const value = managedCodexProviderPermissionToRuntimePermission(m.value);
          return value ? [{
            ...m, value,
            label: t(`chat:input.permissionModes.${m.value}.label`, { defaultValue: m.label }),
            description: m.value === 'auto'
              ? t('chat:input.permissionModes.full-auto.description')
              : t(`chat:input.permissionModes.${m.value}.description`, { defaultValue: m.description }),
          }] : [];
        })
        : getRuntimePermissionModes(effectiveRuntime))
        .filter((m) => !m.hidden && isPermissionModeForRuntimeIdentity(
          m.value,
          effectiveRuntime,
          effectiveRuntimeSource,
        ))
        .map((m) => {
          const label = effectiveRuntimeSource === 'managed-provider'
            ? m.label
            : t(`chat:input.permissionModes.${m.value}.label`, { defaultValue: m.label });
          return {
            value: m.value,
            label: m.description
              ? `${label} · ${effectiveRuntimeSource === 'managed-provider' ? m.description : t(`advanced.permissionModes.${effectiveRuntime}.${m.value}`, { defaultValue: m.description })}`
              : label,
          };
        }),
    ],
    [effectiveRuntime, effectiveRuntimeSource, t],
  );

  // Toggle a single MCP server in the override list.
  // `undefined` follows Agent; `[]` is an explicit no-MCP override. The
  // "恢复跟随 Agent" button is the only path that clears back to undefined.
  const toggleMcp = (id: string) => {
    const enabled = mcpEnabledServers === undefined || !mcpEnabledServers.includes(id);
    if (id === MANAGED_BROWSER_MCP_ID && enabled && !managedBrowserReady) {
      toast.warning(tSettings('toolbox.browserResource.installFirst'));
      return;
    }
    if (mcpEnabledServers === undefined) {
      setMcpEnabledServers(applyBuiltinBrowserExecutionToolToggle([], id, true, managedBrowserReady));
      return;
    }
    setMcpEnabledServers(applyBuiltinBrowserExecutionToolToggle(
      mcpEnabledServers,
      id,
      enabled,
      managedBrowserReady,
    ));
  };

  const resetMcpToFollow = () => setMcpEnabledServers(undefined);

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--line)]">
      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-4 py-2.5 text-left transition-colors hover:bg-[var(--hover-bg)]"
        aria-expanded={open}
      >
        <SlidersIcon className="h-4 w-4 text-[var(--ink-muted)]" strokeWidth={1.5} />
        <span className="flex-1 text-sm font-medium text-[var(--ink)]">
          {t('advanced.title')}
          <span className="ml-1.5 text-xs font-normal text-[var(--ink-muted)]">
            {t('advanced.subtitle')}
          </span>
        </span>
        <ChevronDownIcon
          className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="space-y-5 border-t border-[var(--line-subtle)] px-4 py-4">
          {/* Runtime — visible only when the multi-agent-runtime gate is on.
              When off, the rest of the editor still renders normally; effective
              runtime is forced to 'builtin' upstream so model/permission/MCP
              fields show their builtin variant. Mirrors WorkspaceBasicsSection's
              gate treatment so the two surfaces feel consistent. */}
          {runtimeSelectorAvailable && (
            <FieldRow
              label="Runtime"
              hint={
                workspaceDisplayName
                  ? t('advanced.runtimeHintWithWorkspace', { workspace: workspaceDisplayName })
                  : t('advanced.runtimeHintDefault')
              }
            >
              <CustomSelect
                value={runtime ?? FOLLOW_VALUE}
                options={runtimeOptions}
                onChange={(v) => setRuntime(v ? (v as RuntimeType) : undefined)}
                placeholder={t('advanced.runtimePlaceholder')}
                size="md"
              />
            </FieldRow>
          )}

          {/* External CLI notice — Model / MCP fields are managed by the
              runtime itself (Claude Code / Codex); only model and
              permission can be overridden per-task. Mirrors
              WorkspaceBasicsSection's treatment of the same situation. */}
          {!usesProductConfiguration && (
            <p className="rounded-[var(--radius-md)] bg-[var(--accent-warm-subtle)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--ink-muted)]">
              {t('advanced.externalNotice', { runtime: effectiveRuntimeLabel })}
            </p>
          )}

          {/* Permission mode — visible for EVERY runtime. The option list
              pivots on the effective runtime via getRuntimePermissionModes
              (builtin: auto/plan/fullAgency/custom; CC: default/acceptEdits/…;
              Codex: suggest/auto-edit/…).
              "跟随默认（最大权限）" sentinel means: at execution time, fall
              back to the runtime's max permission (cron is unattended). */}
          <FieldRow
            label={t('advanced.permissionLabel')}
            hint={t('advanced.permissionHint')}
          >
            <CustomSelect
              value={permissionMode ?? FOLLOW_VALUE}
              options={permissionOptions}
              onChange={(v) => setPermissionMode(v ? v : undefined)}
              placeholder={effectiveRuntime === 'codex' && permissionMode === 'suggest'
                ? `${t('chat:input.permissionModes.suggest.label')} · ${t('chat:input.permissionModes.suggest.description')}`
                : t('advanced.permissionPlaceholder')}
              ariaLabel={t('advanced.permissionLabel')}
              size="md"
            />
          </FieldRow>

          {/* PRD 0.2.9 — Model picker, two variants (builtin / external).
              Both render as a popup-grouped list to match Chat / Agent
              settings UX. The builtin variant uses `useAvailableProviders`
              (cross-provider) — issue #130 fix. The external variant
              reads `runtimeModels` (CC_MODELS / codexModels)
              and writes `runtimeConfig.model`. */}
          <FieldRow
            label={t('advanced.modelLabel')}
            hint={
              usesProductConfiguration
                ? t('advanced.modelHintBuiltin')
                : t('advanced.modelHintExternal', { runtime: effectiveRuntimeLabel })
            }
          >
            <ModelPicker
              isBuiltin={usesProductConfiguration}
              open={modelPickerOpen}
              setOpen={setModelPickerOpen}
              inheritedProviderId={workspaceProvider?.id}
              // Builtin
              availableProviders={availableProviders}
              providers={providers}
              providerId={providerId}
              model={model}
              workspaceDefaultModelLabel={workspaceDefaultModelLabel}
              pickedProvider={pickedProvider}
              pickedProviderAvailable={pickedProviderAvailable}
              pickedModelLabel={pickedModelLabel}
              onSelectBuiltinFollow={selectBuiltinFollow}
              onSelectBuiltinModel={selectBuiltinModel}
              // External
              effectiveRuntime={effectiveRuntime}
              effectiveRuntimeLabel={effectiveRuntimeLabel}
              externalRuntimeModels={externalRuntimeModels}
              externalSelectedModel={runtimeConfig?.model}
              onSelectExternalFollow={selectExternalFollow}
              onSelectExternalModel={selectExternalModel}
            />
          </FieldRow>


          {/* MCP enable list — Product-configured runtimes only. Hint + reset action share a
              single bottom row: status text on the left, "恢复跟随 Agent"
              on the right (only when there's actually an override to revert
              — pristine state hides the button rather than disabling it,
              since a disabled button reads as "I should be able to click
              this but can't" while no button reads as "nothing to do here"). */}
          {usesProductConfiguration && (
            <FieldRow label={t('advanced.mcpTools')}>
              {mcpCatalogue.length === 0 ? (
                <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--line)] px-3 py-3 text-xs text-[var(--ink-muted)]">
                  {t('advanced.noMcp')}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {mcpCatalogue.map((s) => {
                      const checked = mcpEnabledServers
                        ? mcpEnabledServers.includes(s.id)
                        : false; // pristine = visually unchecked, label says "跟随"
                      return (
                        <label
                          key={s.id}
                          className={`flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border border-transparent px-2 py-1 text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] ${
                            checked
                              ? 'border-[var(--accent-warm)]/30 bg-[var(--accent-warm-subtle)] text-[var(--ink)]'
                              : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleMcp(s.id)}
                            className="h-3.5 w-3.5 accent-[var(--accent-warm)]"
                          />
                          <span className="truncate">{s.name}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3 text-xs leading-snug text-[var(--ink-muted)]">
                    <span>
                      {mcpEnabledServers === undefined
                        ? t('advanced.mcpFollowing')
                        : t('advanced.mcpEnabled', { count: mcpEnabledServers.length })}
                    </span>
                    {mcpEnabledServers !== undefined && (
                      <button
                        type="button"
                        onClick={resetMcpToFollow}
                        className="shrink-0 text-[var(--ink-muted)] transition-colors hover:text-[var(--accent-warm)]"
                      >
                        {t('advanced.restoreFollowAgent')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </FieldRow>
          )}
        </div>
      )}
    </div>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-medium text-[var(--ink-secondary)]">
          {label}
        </span>
      </div>
      {children}
      {hint && (
        <p className="mt-1.5 text-xs leading-snug text-[var(--ink-muted)]">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * PRD 0.2.9 — Two-mode grouped model picker. Displays as a button that
 * opens a popup; the popup renders either a provider-grouped list (builtin
 * runtime) or a flat external-runtime list. Mirrors the WorkspaceBasicsSection
 * popup UX so the two surfaces feel identical.
 *
 * Stale-provider UX (R8): when `providerId` references a provider that has
 * lost credentials (or been deleted entirely), the closed-button label still
 * shows the saved selection with a ⚠ marker, so users see what's wrong
 * before opening the picker.
 */
function ModelPicker(props: {
  isBuiltin: boolean;
  open: 'builtin' | 'external' | null;
  setOpen: (next: 'builtin' | 'external' | null) => void;
  inheritedProviderId?: string;
  // Builtin
  availableProviders: ReturnType<typeof useAvailableProviders>;
  providers: ReturnType<typeof useConfig>['providers'];
  providerId?: string;
  model?: string;
  workspaceDefaultModelLabel: string;
  pickedProvider: ReturnType<typeof useConfig>['providers'][number] | null;
  pickedProviderAvailable: boolean;
  pickedModelLabel: string | null;
  onSelectBuiltinFollow: () => void;
  onSelectBuiltinModel: (providerId: string, model: string) => void;
  // External
  effectiveRuntime: RuntimeType;
  effectiveRuntimeLabel: string;
  externalRuntimeModels: RuntimeModelInfo[];
  externalSelectedModel?: string;
  onSelectExternalFollow: () => void;
  onSelectExternalModel: (model: string) => void;
}) {
  const { t } = useTranslation('task');
  const {
    isBuiltin,
    open,
    setOpen,
    inheritedProviderId,
    availableProviders,
    providers,
    providerId,
    model,
    workspaceDefaultModelLabel,
    pickedProvider,
    pickedProviderAvailable,
    pickedModelLabel,
    onSelectBuiltinFollow,
    onSelectBuiltinModel,
    effectiveRuntime,
    externalRuntimeModels,
    externalSelectedModel,
    onSelectExternalFollow,
    onSelectExternalModel,
  } = props;

  const variant: 'builtin' | 'external' = isBuiltin ? 'builtin' : 'external';
  const isOpen = open === variant;
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Closed-button label. PRD 0.2.9 — "跟随 Agent" is a real selected state
  // (not a placeholder), so render it in `text-[var(--ink)]` to match the
  // Runtime / 权限模式 selects above. CustomSelect treats the empty-string
  // value as a selected option (FOLLOW_VALUE) and gets ink color via its
  // `selectedOption ? text-[var(--ink)] : text-[var(--ink-muted)]` branch
  // (CustomSelect.tsx:94); we mirror that here so the three 高级配置
  // fields read as a uniform group.
  let closedLabel: React.ReactNode;
  if (isBuiltin) {
    if (providerId && model) {
      const providerName = pickedProvider?.name || providerId;
      const modelName = pickedModelLabel || model;
      closedLabel = (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">
            {providerName}{t('advanced.providerModelSeparator', { model: modelName })}
          </span>
          {!pickedProviderAvailable && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-[var(--warning)]"
              title={t('advanced.providerUnavailableTitle')}
            >
              {t('advanced.providerUnavailableShort')}
            </span>
          )}
        </span>
      );
    } else {
      closedLabel = (
        <span className="truncate">
          {workspaceDefaultModelLabel
            ? t('advanced.followAgentCurrent', { value: workspaceDefaultModelLabel })
            : t('advanced.followAgentWorkspace')}
        </span>
      );
    }
  } else {
    if (externalSelectedModel) {
      const hit = externalRuntimeModels.find((m) => m.value === externalSelectedModel);
      closedLabel = (
        <span className="truncate">
          {hit?.displayName || externalSelectedModel}
        </span>
      );
    } else {
      closedLabel = (
        <span className="truncate">{t('advanced.followAgentCurrentModel')}</span>
      );
    }
  }

  return (
    <div className="relative" onKeyDown={event => {
      if (isOpen && event.key === 'Escape') {
        event.stopPropagation();
        setOpen(null);
        triggerRef.current?.focus({ preventScroll: true });
      }
    }}>
      <button
        type="button"
        ref={triggerRef}
        aria-expanded={isOpen}
        // Match the CustomSelect `size="md"` shape used by the IM Bot
        // delivery picker below (NotificationConfigEditor.tsx) so the three
        // 高级配置 fields (Runtime / 权限模式 / 模型) read as one visual
        // group: `rounded-lg`, `bg-[var(--paper)]`, `px-3 py-2.5 text-sm`,
        // `border-[var(--line)]`, hover deepens the border. Down-arrow chevron
        // (mirroring CustomSelect's affordance) is animated on open.
        className="flex w-full items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--ink-subtle)]"
        onClick={() => setOpen(isOpen ? null : variant)}
      >
        <span className="min-w-0 flex-1 truncate">{closedLabel}</span>
        <ChevronDownIcon
          className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      <Popover open={isOpen} onClose={() => setOpen(null)} anchorRef={triggerRef} matchAnchorWidth
        placement="bottom-start" className="flex flex-col" maxHeight="364px">
        {variant === 'builtin' ? (
          <GroupedModelList onDismiss={() => setOpen(null)}
            groups={providerModelGroups(availableProviders, onSelectBuiltinModel)}
            selectedGroupId={providerId} selectedModelId={model} preferredGroupId={inheritedProviderId}
            follow={{
              name: workspaceDefaultModelLabel
                ? t('advanced.followAgentCurrent', { value: workspaceDefaultModelLabel })
                : t('advanced.followAgentWorkspace'),
              selected: !providerId,
              select: onSelectBuiltinFollow,
            }}>
            {availableProviders.length === 0 && (
              <div className="px-3 py-3 text-xs text-[var(--ink-muted)]">{t('advanced.noProviders')}</div>
            )}
            {/* PRD 0.2.9 R8 — Stale-provider rescue. If the saved provider
                is uncredentialed (or fully removed from config), surface
                the row inside the picker too so the user can spot it
                and pick a fresh one. Skipped when the saved provider
                is in the available list (then it's already shown). */}
            {providerId
              && !availableProviders.some((p) => p.id === providerId)
              && (() => {
                const p = providers.find((q) => q.id === providerId);
                const providerLabel = p?.name ?? providerId;
                const modelLabel = (p?.models?.find((mm) => mm.model === model)?.modelName)
                  || model
                  || '';
                return (
                  <div className="mt-2 rounded-[var(--radius-sm)] border border-dashed border-[var(--warning)]/50 bg-[var(--warning-subtle)]/40 px-3 py-2 text-xs leading-relaxed text-[var(--ink-muted)]">
                    <div className="font-medium text-[var(--ink)]">
                      {t('advanced.selectedProvider', {
                        provider: providerLabel,
                        model: modelLabel
                          ? t('advanced.providerModelSeparator', { model: modelLabel })
                          : '',
                      })}
                    </div>
                    <div className="mt-1">
                      {p
                        ? t('advanced.providerMissingKey')
                        : t('advanced.providerDeleted')}
                    </div>
                  </div>
                );
              })()}
          </GroupedModelList>
        ) : (
          <GroupedModelList flat onDismiss={() => setOpen(null)}
            selectedGroupId={effectiveRuntime} selectedModelId={externalSelectedModel}
            groups={[{ id: effectiveRuntime, name: '', models: externalRuntimeModels.map(option => ({
              id: option.value, name: option.displayName || option.value, select: () => onSelectExternalModel(option.value),
            })) }]}
            follow={{ name: t('advanced.followAgentCurrentModel'), selected: !externalSelectedModel, select: onSelectExternalFollow }}>
            {externalRuntimeModels.length === 0 && (
              <div className="px-3 py-3 text-xs leading-relaxed text-[var(--ink-muted)]">
                {t(effectiveRuntime === 'codex' ? 'advanced.queryingModels' : 'advanced.noRuntimeModels')}
              </div>
            )}
          </GroupedModelList>
        )}
      </Popover>
    </div>
  );
}

export default TaskAdvancedConfigEditor;
