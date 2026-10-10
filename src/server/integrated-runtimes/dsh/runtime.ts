import { buildTurnProviderAnalytics, type TurnProviderAnalytics } from '../../session-core/turn-analytics';
import type { AskUserQuestionAnswers } from '../../../shared/types/askUserQuestion';
import { dshSessionOwnedPaths } from './owned-paths';
import { resolveProviderForModel } from '../../../shared/provider-model-routing';
import type { MethodParams } from './protocol-types';
import type { RuntimeAgentWorkControl, RuntimeAgentWorkTree } from '../../../shared/types/subagent-lifecycle';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, normalize } from 'node:path';

import packageJson from '../../../../package.json';
import dshLock from '../../../shared/integrated-runtimes/effective-dsh-lock';
import type { Provider, ProviderAuthType } from '../../../shared/config-types';
import { getProviderExecutionConstraint } from '../../../shared/integrated-runtimes/provider-constraints';
import {
  DSH_PERMISSION_MODES,
  type RuntimeDiagnostics,
  type RuntimeInspection,
  type RuntimeDetection,
  type RuntimeExtensionApplyState,
  type RuntimeExtensionComponentStatus,
  type RuntimeExtensionDiagnostics,
  type RuntimeModelInfo,
  type RuntimePermissionRuleMutationResult,
  type RuntimePermissionRulesSnapshot,
  type RuntimePermissionMode,
  type RuntimeType,
} from '../../../shared/types/runtime';
import { isConcreteProviderRoute } from '../../../shared/providerRoute';
import { INTERNAL_CLI_TOKEN_ENV } from '../../../shared/externalCliCapabilities';
import { getSessionMetadata } from '../../SessionStore';
import { fingerprintDshNativeInput } from './input-identity';
import {
  findEffectiveProvider,
  loadConfig,
  resolveProviderEnv,
  resolveWorkspaceConfig,
} from '../../utils/admin-config';
import { getHomeDir } from '../../utils/platform';
import { getBundledNodePath } from '../../utils/runtime';
import { ensureShellPath } from '../../utils/shell';
import { getSidecarPort } from '../../session-core/sidecar-port';
import { getPreparedModelPolicy, prepareProviderBinding, type PreparedProvider } from '../../utils/managed-proxy-binding';
import { getGeneralProxyEnvironment, getProviderRequestProxyPolicy } from '../../proxy-state';
import { RuntimeSteerUnavailableError } from '../../runtimes/types';
import type {
  AgentRuntime,
  ResolvedImagePayload,
  RuntimeConfigCapabilities,
  RuntimeProcess,
  SessionStartOptions,
  UnifiedEvent,
  UnifiedEventCallback,
} from '../../runtimes/types';
import { saveToolAttachment } from '../../runtimes/tool-attachments';
import { recoverPendingDshMutation } from '../../session-engine/dsh-mutation-recovery';
import {
  reconcileDshTurnsAtStartup,
  type DshUnsettledTurn,
} from '../../session-engine/dsh-turn-reconciliation';
import { DshAttachmentRegistry } from './attachments';
import { compileDshCollaboration, type DshCollaborationDeclaration, type DshHostModelBinding } from './collaboration-compiler';
import { buildDshChildEnvironment } from './child-environment';
import { DshCanonicalWebHost } from './canonical-web';
import { DSH_CANONICAL_WEB_ADAPTER_ID } from './canonical-web-provider';
import { DshRuntimeEventProjector, projectDshAgentWorkSnapshot } from './event-projector';
import {
  compileDshExtensionSnapshot,
  compileDshProductExtensionPlane,
  dshExtensionGenerationId,
  type DshCompiledExtensionPlane,
  type DshProductExtensionSource,
} from './extension-compiler';
import { executeDshProductHostTool, resolveDshMcpCredential } from './extension-host';
import { createDshInitializeParams } from './initialize';
import { inspectDshRuntimeArtifactIdentity, resolveDshRuntimeInstallation } from './installation';
import { buildDshQuestionAnswer, reconcileExpiredDshInteractionResponse } from './interaction-response';
import { dshPermissionReview } from './permission-display';
import { resolveDshProviderApiKey } from './provider-credential';
import { releaseLargeValueRef } from '../../utils/large-value-store';
import { DshMutationController } from './mutations';
import {
  parseDshPermissionRuleMutation,
  parseDshPermissionRulesSnapshot,
  projectDshPermissionDiagnostics,
  validateDshPermissionIdentifier,
  validateDshPermissionTarget,
} from './permission-rules';
import {
  compileDshModelExecutionProfile,
  type DshModelExecutionProfile,
  type DshReasoningEffortSelection,
} from './profile-compiler';
import {
  DshRuntimeProcessHost,
  redactDshDiagnosticLine,
} from './process-host';
import {
  DSH_CANONICAL_WEB_POLICY_REF,
  type DshExecutionEnvironment,
  type DshHostRequestHandlers,
  type DshRpcObject,
  type DshRuntimeNotificationHandlers,
} from './protocol-types';

const OFFICIAL_INTERACTION_REVISION = 'host-interaction-v1';
const DSH_CHECKPOINT_POLICY_REVISION = 'myagents-root-write-edit-checkpoint-v1';

type ProductPermissionMode = 'approval-required' | 'workspace-autonomous' | 'full-autonomous';

type PendingInteraction = Readonly<{
  kind: 'permission' | 'ask_user' | 'plan_approval';
  reviewRefId?: string;
  desiredPolicyRevision: string;
  schema: DshRpcObject;
}>;

type DshConfiguration = Readonly<{
  collaboration: DshCollaborationDeclaration;
  bindings: readonly DshHostModelBinding[];
  profile: DshModelExecutionProfile;
  providerAnalytics: TurnProviderAnalytics;
  apiKey: string;
  authType: ProviderAuthType;
  preparedProvider?: PreparedProvider;
  onManagedDrain?: () => void;
  productPermissionMode: ProductPermissionMode;
  reasoningEffort: DshReasoningEffortSelection;
  revision: string;
}>;

function extensionApplyState(value: unknown): RuntimeExtensionApplyState {
  if (value === 'applied') return 'applied';
  if (value === 'queued') return 'deferred_until_idle';
  if (value === 'restart_when_idle') return 'pending_next_start';
  return 'failed';
}

type DshExtensionComponentReceipt = Readonly<{
  key: string;
  state: string;
  reason?: string;
}>;

function extensionComponentReceipts(result: DshRpcObject): DshExtensionComponentReceipt[] {
  if (!Array.isArray(result.components)) return [];
  return result.components.map((raw) => {
    const component = object(raw, 'DSH extension component status');
    return {
      key: string(component.key, 'DSH extension component key'),
      state: string(component.state, 'DSH extension component state'),
      ...(typeof component.reason === 'string' ? { reason: component.reason } : {}),
    };
  });
}

function extensionComponentApplyState(value: string): RuntimeExtensionApplyState {
  if (value === 'ready') return 'applied';
  if (value === 'unsupported') return 'unsupported';
  if (value === 'degraded' || value === 'failed') return 'failed';
  return 'not_applicable';
}

export function projectDshExtensionStatus(
  plane: DshCompiledExtensionPlane,
  result: DshRpcObject,
  unchanged = false,
): RuntimeExtensionDiagnostics {
  const desiredRevision = string(result.desiredRevision, 'DSH desired extension revision');
  const effectiveWireRevision = string(result.effectiveRevision, 'DSH effective extension revision');
  const state = extensionApplyState(result.state);
  const components = plane.diagnostics.map((component): RuntimeExtensionComponentStatus => {
    if (state === 'deferred_until_idle' && component.state === 'applied') {
      return {
        ...component,
        state,
        code: 'dsh_extension_generation_queued',
      };
    }
    return { ...component,
      ...(component.state === 'unsupported' || component.state === 'failed'
        ? { admission: 'rejected' as const, modelInvocable: false } : {}),
    };
  });
  for (const component of extensionComponentReceipts(result)) {
    const key = component.key;
    const separator = key.indexOf(':');
    const kind = separator < 0 ? 'runtime' : key.slice(0, separator);
    const id = separator < 0 ? undefined : key.slice(separator + 1);
    const declaration = plane.snapshot.components.find(item => item.kind === kind && item.id === id);
    const descriptor = declaration?.descriptor as DshRpcObject | undefined;
    const invocation = descriptor?.invocation as DshRpcObject | undefined;
    const pending = state === 'deferred_until_idle' || state === 'pending_next_start';
    const ready = !pending && component.state === 'ready';
    const modelInvocable = pending ? undefined : !ready ? false
      : kind === 'skill' ? invocation?.modelInvocable === true
        : kind === 'agent' || kind === 'host_tool' ? true
          : kind === 'command' || kind === 'hook' ? false : undefined;
    components.push({
      component: kind,
      ...(id === undefined ? {} : { id }),
      state: pending ? state : extensionComponentApplyState(component.state),
      code: component.reason ?? `dsh_extension_component_${component.state}`,
      admission: pending ? 'pending' : ready ? 'ready' : component.state === 'disabled' ? 'disabled' : 'rejected',
      ...(typeof declaration?.enabled === 'boolean' ? { enabled: declaration.enabled } : {}),
      ...(modelInvocable === undefined ? {} : { modelInvocable }),
      ...(!pending && effectiveWireRevision !== 'none' ? { effectiveGeneration: effectiveWireRevision } : {}),
    });
  }
  return {
    desiredRevision,
    effectiveRevision: effectiveWireRevision === 'none' ? null : effectiveWireRevision,
    state: unchanged && state === 'applied' ? 'unchanged' : state,
    components,
  };
}

function extensionDiagnostics(
  workspacePath: string,
  catalog: DshRpcObject,
  extensions: RuntimeExtensionDiagnostics,
  configuration?: DshConfiguration,
  permissionRules?: RuntimePermissionRulesSnapshot,
): RuntimeDiagnostics {
  const mcpServers = Array.isArray(catalog.mcpServers)
    ? catalog.mcpServers.map((entry) => {
        const server = object(entry, 'DSH extension MCP status');
        return {
          name: string(server.id, 'DSH extension MCP identity'),
          toolCount: 0,
          state: string(server.state, 'DSH extension MCP state'),
        };
      })
    : [];
  return {
    runtime: 'dsh',
    runtimeSource: 'integrated',
    effectiveEnv: { cwd: workspacePath },
    mcpServers,
    status: {
      auth: 'unsupported',
      features: 'unsupported',
      mcpServers: 'ok',
      apps: 'unsupported',
    },
    extensions,
    ...(configuration && permissionRules ? {
      permissions: projectDshPermissionDiagnostics(
        configuration.productPermissionMode,
        permissionRules,
      ),
    } : {}),
    timestamp: new Date().toISOString(),
  };
}

type DshExtensionCatalogFacts = Readonly<{
  digest: string;
  loadedSkillNames: readonly string[];
  tools: readonly string[];
}>;

function extensionCatalogFacts(
  plane: DshCompiledExtensionPlane,
  catalog: DshRpcObject,
  result: DshRpcObject,
): DshExtensionCatalogFacts {
  const digest = string(catalog.digest, 'DSH extension catalog digest');
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('DSH effective extension catalog digest is invalid');
  }
  if (catalog.revision !== plane.snapshot.revision) {
    throw new Error('DSH effective extension catalog differs from Product extension intent');
  }
  const loadedSkillNames = Array.isArray(catalog.skills)
    ? catalog.skills.map((entry) => string(
        object(entry, 'DSH extension Skill').name,
        'DSH extension Skill name',
      ))
    : [];
  const omittedSkillNames = new Set(extensionComponentReceipts(result)
    .filter(component => component.state !== 'ready' && component.key.startsWith('skill:'))
    .map(component => component.key.slice('skill:'.length)));
  const expectedLoadedSkillNames = plane.expectedSkillNames
    .filter(name => !omittedSkillNames.has(name));
  if (
    new Set(loadedSkillNames).size !== loadedSkillNames.length
    || loadedSkillNames.length !== expectedLoadedSkillNames.length
    || expectedLoadedSkillNames.some(name => !loadedSkillNames.includes(name))
  ) {
    throw new Error('DSH effective Skill catalog differs from Product extension intent');
  }
  const tools = Array.isArray(catalog.tools)
    ? catalog.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  const omittedHostToolNames = new Set(extensionComponentReceipts(result)
    .filter(component => component.state !== 'ready' && component.key.startsWith('host_tool:'))
    .map(component => component.key.slice('host_tool:'.length)));
  if (plane.hostToolBindings.some(binding => (
    !omittedHostToolNames.has(binding.publicToolName)
    && !tools.includes(binding.publicToolName)
  ))) {
    throw new Error('DSH effective Host tool catalog differs from Product extension intent');
  }
  return Object.freeze({
    digest,
    loadedSkillNames: Object.freeze(loadedSkillNames),
    tools: Object.freeze(tools),
  });
}

function hash(...parts: readonly string[]): string {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part).update('\0');
  return digest.digest('hex');
}

function systemContextFingerprint(options: SessionStartOptions): string {
  return options.systemContext === undefined
    ? options.systemPromptAppend ?? ''
    : JSON.stringify(options.systemContext);
}

function systemContextParams(options: SessionStartOptions): Pick<MethodParams<'session/create'>, 'systemPrompt' | 'systemContext'> {
  return options.systemContext === undefined
    ? { systemPrompt: options.systemPromptAppend ?? '' }
    : { systemPrompt: '', systemContext: options.systemContext };
}

function object(value: unknown, description: string): DshRpcObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as DshRpcObject;
}

function string(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown, description: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${description} is invalid`);
  }
  return value as number;
}

function productPermissionMode(value: string | undefined): ProductPermissionMode {
  if (value === undefined || value === '') return 'approval-required';
  if (value === 'approval-required' || value === 'workspace-autonomous' || value === 'full-autonomous') return value;
  throw new Error(`Unsupported MyAgents DSH permission mode: ${value}`);
}

function reasoningSelection(value: string | undefined): DshReasoningEffortSelection {
  if (value === undefined || value === '' || value === 'default') return 'default';
  if (value === 'off' || value === 'low' || value === 'medium'
    || value === 'high' || value === 'xhigh' || value === 'max') {
    return value;
  }
  return 'default';
}

function scenarioCapability(options: SessionStartOptions): 'interactive' | 'deterministic-headless' {
  return options.scenario.type === 'desktop' ? 'interactive' : 'deterministic-headless';
}

function turnOrigin(options: SessionStartOptions): MethodParams<'turn/start'>['origin'] {
  return options.scenario.type === 'desktop'
    ? { kind: 'desktop' }
    : { kind: 'headless', scenario: options.scenario.type };
}

function platformTarget(): 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'linux-x64' {
  const target = `${process.platform}-${process.arch}`;
  if (target === 'darwin-arm64' || target === 'darwin-x64' || target === 'win32-x64' || target === 'linux-x64') {
    return target;
  }
  throw new Error(`DSH Runtime has no accepted native target for ${target}`);
}

async function resourceRootForNode(nodeExecutablePath: string): Promise<string> {
  let cursor = dirname(await realpath(nodeExecutablePath));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await access(join(cursor, 'integrated-runtimes', 'dsh', 'runtime-artifact'));
      return await realpath(cursor);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  throw new Error('Bundled DSH Runtime resources are unavailable beside bundled Node');
}

async function installedRuntime() {
  const nodeExecutablePath = getBundledNodePath();
  if (!nodeExecutablePath) throw new Error('MyAgents bundled Node is unavailable');
  return await resolveDshRuntimeInstallation({
    nodeExecutablePath,
    resourceRoot: await resourceRootForNode(nodeExecutablePath),
  });
}

function providerForSession(options: SessionStartOptions, requestedOverride?: string): {
  provider: Provider;
  modelId: string;
} {
  const config = loadConfig();
  const metadata = getSessionMetadata(options.sessionId);
  // A fresh desktop turn carries its selection before native admission creates
  // Product metadata. Existing Sessions resolve through their owned snapshot,
  // including the shared legacy policy, rather than current Agent defaults.
  const route = isConcreteProviderRoute(metadata?.providerRoute)
    ? metadata.providerRoute
    : !metadata && isConcreteProviderRoute(options.providerRoute)
      ? options.providerRoute
      : resolveWorkspaceConfig(options.workspacePath, metadata, { includeMcp: false }).providerRoute;
  if (!isConcreteProviderRoute(route)) {
    throw new Error('DSH Session has no concrete Provider authority');
  }
  const providerId = route.providerId;
  const provider = findEffectiveProvider(providerId, config) as Provider | null;
  if (!provider) throw new Error(`DSH Provider ${providerId} is unavailable`);
  const modelId = requestedOverride || route.model;
  return { provider: resolveProviderForModel(provider, modelId), modelId };
}

export async function compileConfiguration(
  options: SessionStartOptions,
  overrides?: { model?: string; permissionMode?: string; reasoningEffort?: string },
  previous?: DshConfiguration,
  onManagedDrain?: () => void,
): Promise<DshConfiguration> {
  const selected = providerForSession(options, overrides?.model);
  const productMode = productPermissionMode(overrides?.permissionMode ?? options.permissionMode);
  const effort = reasoningSelection(overrides?.reasoningEffort ?? options.reasoningEffort);
  const config = loadConfig();
  const credential = resolveProviderEnv(selected.provider.id, config, selected.modelId);
  if (!credential) throw new Error(`DSH Provider ${selected.provider.id} has no Host-owned credential`);
  const constraint = getProviderExecutionConstraint(selected.provider);
  if (constraint.kind !== 'portable') throw new Error(`DSH Provider ${selected.provider.id} belongs to another Runtime`);
  const reusable = credential.endpointSource && previous?.profile.provider === selected.provider.id
    && previous.profile.modelId === selected.modelId ? previous.preparedProvider : undefined;
  const preparedProvider = credential.endpointSource
    ? reusable ?? await prepareProviderBinding({
        providerEnv: credential,
        model: selected.modelId,
        controller: new AbortController(),
        onDrain: previous?.onManagedDrain ?? onManagedDrain,
      })
    : undefined;
  try {
    const effectiveCredential = preparedProvider?.providerEnv ?? credential;
    const apiKey = effectiveCredential?.apiKey ?? '';
    const authType = effectiveCredential?.authType ?? selected.provider.authType ?? 'both';
    if (!apiKey && constraint.credentialKind !== 'host-managed-oauth') {
      throw new Error(`DSH Provider ${selected.provider.id} has no Host-owned API credential`);
    }
    const boundPolicy = getPreparedModelPolicy(effectiveCredential);
    const effectiveProvider = boundPolicy
      ? { ...selected.provider, models: selected.provider.models.map(model => model.model === selected.modelId
          ? { ...model,
              ...(boundPolicy.contextLength != null ? { contextLength: boundPolicy.contextLength } : {}),
              ...(boundPolicy.maxOutputTokens != null ? { maxOutputTokens: boundPolicy.maxOutputTokens } : {}),
            }
          : model) }
      : selected.provider;
    const profile = compileDshModelExecutionProfile({
      provider: effectiveProvider,
      modelId: selected.modelId,
      reasoningEffort: effort,
      ...(constraint.credentialKind === 'proxy-managed'
        ? { preparedBaseUrl: effectiveCredential?.baseUrl } : {}),
    });
    const collaborative = compileDshCollaboration({
      profile, apiKey, authType,
      ...(constraint.credentialKind === 'host-managed-oauth' ? { managedOauth: true as const } : {}),
    }, config.dshCollaboration, ref => {
      const provider = findEffectiveProvider(ref.providerId, config) as Provider | null;
      const refConstraint = provider ? getProviderExecutionConstraint(provider) : undefined;
      const refCredential = resolveProviderEnv(ref.providerId, config, ref.modelId);
      if (!provider || refConstraint?.kind !== 'portable' || refConstraint.credentialKind !== 'api-key' || !refCredential?.apiKey) {
        throw new Error(`DSH collaboration Provider ${ref.providerId} requires a directly configured API key`);
      }
      return { provider: resolveProviderForModel(provider, ref.modelId), apiKey: refCredential.apiKey };
    });
    return Object.freeze({
      ...collaborative,
      profile,
      providerAnalytics: buildTurnProviderAnalytics({
        providerId: profile.provider, providerName: selected.provider.name, baseUrl: profile.baseUrl,
      }, profile.api),
      apiKey,
      authType,
      ...(preparedProvider ? { preparedProvider } : {}),
      ...(previous?.onManagedDrain ?? onManagedDrain
        ? { onManagedDrain: previous?.onManagedDrain ?? onManagedDrain } : {}),
      productPermissionMode: productMode,
      reasoningEffort: effort === 'off' || profile.effort === effort ? effort : 'default',
      revision: `myagents-dsh-config-v1:${hash(
        profile.revision,
        JSON.stringify(collaborative.collaboration),
        authType,
        productMode,
        OFFICIAL_INTERACTION_REVISION,
        systemContextFingerprint(options),
      )}`,
    });
  } catch (error) {
    if (preparedProvider && preparedProvider !== reusable) {
      await preparedProvider.release().catch(() => console.warn('[dsh] Failed to settle rejected Provider binding'));
    }
    throw error;
  }
}

async function createOwnedRoots(productSessionId: string): Promise<Readonly<{
  runtimeHome: string;
  attachmentRoot: string;
}>> {
  const { runtimeHome: requestedRuntimeHome, attachmentRoot: requestedAttachmentRoot } =
    dshSessionOwnedPaths(join(getHomeDir(), '.myagents'), productSessionId);
  await Promise.all([
    mkdir(requestedRuntimeHome, { recursive: true, mode: 0o700 }),
    mkdir(requestedAttachmentRoot, { recursive: true, mode: 0o700 }),
  ]);
  const [runtimeHome, attachmentRoot] = await Promise.all([
    realpath(requestedRuntimeHome),
    realpath(requestedAttachmentRoot),
  ]);
  return Object.freeze({ runtimeHome, attachmentRoot });
}

function executionEnvironment(
  workspacePath: string,
  workspaceIdentity: string,
  attachmentRoot: string,
  allowedEnvironmentKeys: readonly string[],
): Omit<DshExecutionEnvironment, 'digest'> {
  const windows = process.platform === 'win32';
  return {
    revision: `myagents-dsh-execution-v2:${hash(
      platformTarget(),
      workspaceIdentity,
      workspacePath,
      attachmentRoot,
    )}`,
    workspace: {
      identity: workspaceIdentity,
      canonicalRoot: workspacePath,
    },
    executables: {
      bundledNodeRef: 'bundled-node',
      shellRef: 'runtime-shell',
      ripgrepRef: 'bundled-ripgrep',
      shellDialect: windows ? 'pwsh' : 'bash',
      allowedCommandRefs: ['runtime-shell', 'bundled-node', 'bundled-ripgrep'],
    },
    environment: {
      allowedKeys: [...allowedEnvironmentKeys],
    },
    network: { mode: 'host-policy', policyRef: DSH_CANONICAL_WEB_POLICY_REF },
    process: {
      backgroundRetention: 'allow',
      maxChildren: 16,
    },
    checkpoint: {
      policyRevision: DSH_CHECKPOINT_POLICY_REVISION,
    },
    attachmentStagingRoot: attachmentRoot,
  };
}

function answerValue(
  kind: PendingInteraction['kind'],
  schema: DshRpcObject,
  decision: 'deny' | 'allow_once' | 'always_allow',
  reason: string | undefined,
  updatedInput: Record<string, unknown> | undefined,
): DshRpcObject {
  const answers = updatedInput?.answers;
  const answerMap = answers && typeof answers === 'object' && !Array.isArray(answers)
    ? answers as Record<string, unknown>
    : {};
  const questions = Array.isArray(schema.questions) ? schema.questions : [];
  if (kind === 'plan_approval') {
    const question = questions.length === 1 ? object(questions[0], 'DSH Plan approval question') : undefined;
    if (!question) throw new Error('DSH Plan approval must contain one question');
    const id = string(question.id, 'DSH Plan approval question id');
    const intent = object(question.intent, 'DSH Plan approval intent');
    const approve = string(intent.approve, 'DSH Plan approval label');
    if (decision !== 'deny') return { answers: [{ id, selected: [approve] }] };
    const feedback = typeof updatedInput?.feedback === 'string'
      ? updatedInput.feedback.trim()
      : reason?.trim();
    if (feedback) return { answers: [{ id, selected: [], custom: feedback }] };
    const options = Array.isArray(question.options) ? question.options : [];
    const reject = options
      .map(option => object(option, 'DSH Plan approval option'))
      .map(option => optionalString(option.label))
      .find(label => label !== undefined && label !== approve);
    return { answers: [{ id, selected: reject ? [reject] : [] }] };
  }
  return {
    answers: questions.flatMap((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const question = candidate as DshRpcObject;
      const id = typeof question.id === 'string' ? question.id : `question-${index}`;
      const label = typeof question.question === 'string' ? question.question : undefined;
      const value = answerMap[id] ?? answerMap[String(index)] ?? (label ? answerMap[label] : undefined);
      const labels = Array.isArray(question.options)
        ? question.options.map(option => string(object(option, 'DSH question option').label, 'DSH option label')) : [];
      return [buildDshQuestionAnswer(id, value, labels, question.multiSelect === true)];
    }),
  };
}

class DshProcess implements RuntimeProcess {
  readonly runtimeGeneration: string;
  loadedSkillNames: readonly string[];
  activeOperationId: string | undefined;
  realtimeSteerEligibleOperationId: string | undefined;
  planRevision: string | undefined;
  planMode: 'normal' | 'plan' | undefined;
  configuration: DshConfiguration;
  desiredPermissionMode: ProductPermissionMode;
  pendingConfiguration: DshConfiguration | undefined;
  readonly operationUserMessages = new Map<string, string>();
  readonly collaborationOperations = new Set<string>();
  readonly injectedUserMessages = new Set<string>();
  readonly pendingInteractions: Map<string, PendingInteraction>;
  extensionDigest: string;
  tools: readonly string[];
  extensionPlane: DshCompiledExtensionPlane;
  extensionCatalog: DshRpcObject;
  extensionDiagnostics: RuntimeExtensionDiagnostics;
  permissionRules: RuntimePermissionRulesSnapshot | undefined;
  desiredExtensionPlane: DshCompiledExtensionPlane | undefined;
  private resourcesClosed = false;
  private extensionSerial: Promise<void> = Promise.resolve();
  private readonly extensionPlanes = new Map<string, DshCompiledExtensionPlane>();

  constructor(
    readonly host: DshRuntimeProcessHost,
    readonly projector: DshRuntimeEventProjector,
    readonly attachments: DshAttachmentRegistry,
    readonly canonicalWeb: DshCanonicalWebHost,
    readonly options: SessionStartOptions,
    readonly onEvent: UnifiedEventCallback,
    readonly executionEnvironment: DshExecutionEnvironment,
    configuration: DshConfiguration,
    readonly runtimeSessionId: string,
    extensionDigest: string,
    tools: readonly string[],
    readonly productTranscriptChangedAtStartup: boolean,
    loadedSkillNames: readonly string[],
    extensionPlane: DshCompiledExtensionPlane,
    extensionCatalog: DshRpcObject,
    extensionDiagnostics: RuntimeExtensionDiagnostics,
    activeTurn?: DshUnsettledTurn,
    pendingInteractions?: Map<string, PendingInteraction>,
  ) {
    this.configuration = configuration;
    this.desiredPermissionMode = configuration.productPermissionMode;
    this.extensionDigest = extensionDigest;
    this.tools = Object.freeze([...tools]);
    this.extensionPlane = extensionPlane;
    this.extensionCatalog = extensionCatalog;
    this.extensionDiagnostics = extensionDiagnostics;
    this.loadedSkillNames = Object.freeze([...loadedSkillNames]);
    this.extensionPlanes.set(dshExtensionGenerationId(extensionPlane), extensionPlane);
    this.runtimeGeneration = string(host.identity?.runtimeGeneration, 'DSH Runtime generation');
    this.pendingInteractions = pendingInteractions ?? new Map();
    if (activeTurn) {
      this.activeOperationId = activeTurn.clientOperationId;
      if (activeTurn.origin === 'collaboration') this.collaborationOperations.add(activeTurn.clientOperationId);
      else this.operationUserMessages.set(activeTurn.clientOperationId, activeTurn.clientUserMessageId);
    }
  }

  get pid(): number {
    const pid = this.host.pid;
    if (!pid) throw new Error('DSH Runtime process has no pid');
    return pid;
  }

  get exited(): boolean {
    return this.host.state === 'stopped' || this.host.state === 'failed';
  }

  writeLine(): Promise<void> {
    return Promise.reject(new Error('DSH Runtime accepts only generated protocol requests'));
  }

  kill(): void {
    this.closeOwnedResources('host_kill');
    void this.host.stop('host_kill');
  }

  waitForExit(): Promise<number> {
    return this.host.waitForExit().finally(() => this.closeOwnedResources('runtime_exit'));
  }

  closeOwnedResources(reason: string): void {
    if (this.resourcesClosed) return;
    this.resourcesClosed = true;
    void this.configuration.preparedProvider?.release().catch(() => {
      console.warn('[dsh] Managed Provider binding release was not confirmed');
    });
    for (const pending of this.pendingInteractions.values()) if (pending.reviewRefId) void releaseLargeValueRef(pending.reviewRefId);
    this.pendingInteractions.clear();
    this.attachments.close();
    void this.canonicalWeb.close().catch((error: unknown) => {
      console.warn(
        `[dsh-web] failed to close Host Web resources: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    });
    const dispatchers = new Set(
      [...this.extensionPlanes.values()]
        .map(plane => plane.hostToolDispatcher)
        .filter((dispatcher): dispatcher is NonNullable<typeof dispatcher> => Boolean(dispatcher)),
    );
    this.extensionPlanes.clear();
    this.desiredExtensionPlane = undefined;
    for (const dispatcher of dispatchers) dispatcher.dispose(reason);
  }

  planeForGeneration(generationId: string | undefined): DshCompiledExtensionPlane | undefined {
    return generationId ? this.extensionPlanes.get(generationId) : undefined;
  }

  registerExtensionPlane(plane: DshCompiledExtensionPlane): boolean {
    if (this.resourcesClosed) throw new Error('DSH extension owner is closed');
    const generationId = dshExtensionGenerationId(plane);
    if (this.extensionPlanes.has(generationId)) return false;
    this.extensionPlanes.set(generationId, plane);
    return true;
  }

  releaseExtensionPlane(plane: DshCompiledExtensionPlane, reason: string): void {
    const generationId = dshExtensionGenerationId(plane);
    if (this.extensionPlanes.get(generationId) !== plane) return;
    this.extensionPlanes.delete(generationId);
    const dispatcher = plane.hostToolDispatcher;
    if (
      dispatcher
      && ![...this.extensionPlanes.values()].some(candidate => candidate.hostToolDispatcher === dispatcher)
    ) {
      dispatcher.dispose(reason);
    }
  }

  serializeExtensionUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.extensionSerial.then(operation);
    this.extensionSerial = result.then(() => undefined, () => undefined);
    return result;
  }
}

function dshProcess(process: RuntimeProcess): DshProcess {
  if (!(process instanceof DshProcess)) throw new Error('Runtime process is not owned by DSH');
  return process;
}

export type DshConversationMutationContext = Readonly<{
  controller: DshMutationController;
  runtimeSessionId: string;
  runtimeHome: string;
  workspaceIdentity: string;
}>;

export function getDshConversationMutationContext(
  runtimeProcess: RuntimeProcess,
): DshConversationMutationContext {
  const process = dshProcess(runtimeProcess);
  return Object.freeze({
    controller: new DshMutationController(process.host, process.runtimeSessionId),
    runtimeSessionId: process.runtimeSessionId,
    runtimeHome: process.host.runtimeHome,
    workspaceIdentity: process.executionEnvironment.workspace.identity,
  });
}

export async function createDshForkTargetFacts(
  productSessionId: string,
): Promise<Readonly<{
  runtimeHome: string;
  persistenceRef: string;
}>> {
  const roots = await createOwnedRoots(productSessionId);
  return Object.freeze({
    runtimeHome: roots.runtimeHome,
    persistenceRef: `product-session-${hash(productSessionId)}`,
  });
}

export class DshRuntime implements AgentRuntime {
  readonly type: RuntimeType = 'dsh';

  getTurnProviderAnalytics(process: RuntimeProcess): TurnProviderAnalytics {
    return dshProcess(process).configuration.providerAnalytics;
  }

  getConfigCapabilities(): RuntimeConfigCapabilities {
    return {
      model: 'live_session_rpc',
      permissionMode: 'next_turn_state',
      reasoningEffort: 'live_session_rpc',
    };
  }

  async detect(): Promise<RuntimeDetection> {
    try {
      const installation = await installedRuntime();
      return {
        installed: true,
        version: dshLock.dsh.version,
        path: installation.runtimeEntrypointPath,
      };
    } catch {
      return { installed: false };
    }
  }

  async inspectRuntime(runtimeProcess?: RuntimeProcess): Promise<RuntimeInspection> {
    const expectedIdentity = {
      sourceCommit: dshLock.handoff.sourceCommit,
      runtimeVersion: dshLock.runtime.version, dshVersion: dshLock.dsh.version, requiredNodeVersion: dshLock.runtime.requiredNodeVersion,
      handoffSha256: dshLock.handoff.manifestSha256, runtimeManifestSha256: dshLock.handoff.runtimeManifestSha256,
    };
    const resources: RuntimeInspection['resources'] = {
      state: 'unavailable', expectedIdentity, installedIdentity: null,
    };
    let installed = false;
    try {
      const installation = await installedRuntime();
      installed = true;
      resources.state = 'available';
      resources.installedIdentity = await inspectDshRuntimeArtifactIdentity(installation);
      if (!resources.installedIdentity) resources.code = 'dsh_identity_unavailable';
    } catch {
      resources.code = 'dsh_resources_unavailable';
    }
    const active = runtimeProcess ? dshProcess(runtimeProcess) : undefined;
    const current = active?.host.state === 'protocol-ready' && !active.exited ? active : undefined;
    const configuration = current?.configuration;
    const rules = current?.permissionRules;
    return {
      runtime: this.type, installed, version: dshLock.dsh.version, resources,
      process: active?.host.diagnosticSnapshot.process ?? { state: 'not_running' },
      model: configuration ? { id: configuration.profile.modelId, provider: configuration.profile.provider, revision: configuration.revision } : null,
      permissions: configuration && rules ? projectDshPermissionDiagnostics(configuration.productPermissionMode, rules) : null,
      extensions: current?.extensionDiagnostics ?? null,
      environment: active?.host.diagnosticSnapshot.environment ?? null,
      proxy: active?.host.diagnosticSnapshot.proxy ?? null,
      observedAt: new Date().toISOString(),
    };
  }

  async queryModels(): Promise<RuntimeModelInfo[]> {
    // DSH model choices are owned by the selected Product Provider catalog.
    return [];
  }

  getPermissionModes(): RuntimePermissionMode[] {
    return DSH_PERMISSION_MODES;
  }

  async startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess> {
    if (options.runtimeSource && options.runtimeSource !== 'integrated') {
      throw new Error('DSH Runtime source must be integrated');
    }
    const installation = await installedRuntime();
    const workspacePath = await realpath(options.workspacePath);
    if (normalize(workspacePath) !== workspacePath) {
      throw new Error('DSH workspace path is not canonical');
    }
    const roots = await createOwnedRoots(options.sessionId);
    const attachments = new DshAttachmentRegistry(roots.attachmentRoot);
    await attachments.initialize();
    const workspaceIdentity = `myagents-workspace-v1:${hash(workspacePath)}`;
    const commandDirectories = (await ensureShellPath())
      .split(delimiter)
      .filter(entry => entry.length > 0 && isAbsolute(entry));
    const childEnvironment = buildDshChildEnvironment({
      nodeExecutablePath: installation.nodeExecutablePath,
      commandDirectories,
      inheritedEnvironment: process.env,
      proxyEnvironment: getGeneralProxyEnvironment(),
      sessionCli: {
        productSessionId: options.sessionId,
        sidecarPort: getSidecarPort(),
        internalCliToken: process.env[INTERNAL_CLI_TOKEN_ENV] ?? '',
      },
    });
    const environmentWithoutDigest = executionEnvironment(
      workspacePath,
      workspaceIdentity,
      roots.attachmentRoot,
      childEnvironment.allowedKeys,
    );
    let processValue: DshProcess | undefined;
    let drainRequested = false;
    const onManagedDrain = () => {
      if (drainRequested) return;
      drainRequested = true;
      if (processValue) void this.stopSession(processValue).catch(() => undefined);
    };
    const configuration = await compileConfiguration(options, undefined, undefined, onManagedDrain);
    try {
    const initialize = createDshInitializeParams({
      productSessionId: options.sessionId,
      productVersion: packageJson.version,
      runtimeHome: roots.runtimeHome,
      workspace: { path: workspacePath, identity: workspaceIdentity },
      executionEnvironment: environmentWithoutDigest,
      interaction: scenarioCapability(options),
      webSearchAdapters: [DSH_CANONICAL_WEB_ADAPTER_ID],
    });
    const extensionPlane: DshCompiledExtensionPlane = options.dshExtensions
      ? compileDshProductExtensionPlane(options.dshExtensions)
      : Object.freeze({
          snapshot: compileDshExtensionSnapshot(),
          credentialBindings: Object.freeze([]),
          hostToolBindings: Object.freeze([]),
          expectedSkillNames: Object.freeze([]),
          diagnostics: Object.freeze([]),
        } satisfies DshCompiledExtensionPlane);
    const extension = extensionPlane.snapshot;
    const initialExtensionGenerationId = dshExtensionGenerationId(extensionPlane);
    let projector: DshRuntimeEventProjector | undefined;
    let projectedPlan: { mode: 'normal' | 'plan'; revision: string } | undefined;
    const pendingInteractions = new Map<string, PendingInteraction>();
    const recoveringInputIds = new Set(getSessionMetadata(options.sessionId)?.pendingDshInputs?.map(input => input.clientUserMessageId) ?? []);
    const deferredProductActions: Array<{ action: () => void; turnId?: string }> = [];
    let productEventDeliveryReady = false;
    const emitProductEvent = (event: UnifiedEvent, turnId?: string): void => {
      if (productEventDeliveryReady) onEvent(event);
      else deferredProductActions.push({ action: () => onEvent(event), turnId });
    };
    const deferProductAction = (action: () => void, turnId?: string): void => {
      if (productEventDeliveryReady) action();
      else deferredProductActions.push({ action, turnId });
    };
    const canonicalWeb = new DshCanonicalWebHost({
      activeConfiguration: () => processValue?.configuration ?? configuration,
      runtimeSessionId: () => processValue?.runtimeSessionId,
    });
    const extensionPlaneForHostRequest = (params: DshRpcObject): DshCompiledExtensionPlane | undefined => {
      const authority = params.authority && typeof params.authority === 'object'
        && !Array.isArray(params.authority)
        ? params.authority as DshRpcObject
        : undefined;
      const generationId = typeof authority?.componentGenerationId === 'string'
        ? authority.componentGenerationId
        : undefined;
      if (processValue) return processValue.planeForGeneration(generationId);
      return generationId === initialExtensionGenerationId ? extensionPlane : undefined;
    };

    const hostHandlers: DshHostRequestHandlers = Object.freeze({
      'host/credential/resolve': async (params, context) => {
        if (params.subject === 'mcp') {
          const plane = extensionPlaneForHostRequest(params);
          if (!plane) {
            return {
              kind: 'availability',
              available: false,
              authoritativeCredentialRevision: typeof params.credentialRevision === 'string'
                ? params.credentialRevision
                : 'invalid-credential-revision',
              reasonCode: 'mcp_credential_authority_mismatch',
            };
          }
          return resolveDshMcpCredential({
            plane,
            extensionDigest: plane.snapshot.digest,
            params,
          });
        }
        if (params.subject !== 'provider') {
          return {
            kind: 'availability',
            available: false,
            authoritativeCredentialRevision: 'unsupported-credential-subject',
            reasonCode: 'credential_subject_unavailable',
          };
        }
        const current = processValue?.configuration ?? configuration;
        const candidate = processValue?.pendingConfiguration;
        const expectedRevision = params.authority && typeof params.authority === 'object' && !Array.isArray(params.authority)
          ? (params.authority as DshRpcObject).expectedConfigRevision : undefined;
        const candidates = candidate && (params.purpose === 'availability' || expectedRevision === candidate.revision)
          ? [...candidate.bindings, ...current.bindings] : current.bindings;
        const active = candidates.find(binding => binding.profile.credentialRef === params.credentialRef
          && binding.profile.providerRouteId === params.providerRouteId && binding.profile.revision === params.profileRevision);
        if (!active) {
          return {
            kind: 'availability',
            available: false,
            authoritativeCredentialRevision: current.profile.revision,
            reasonCode: 'provider_credential_authority_mismatch',
          };
        }
        if (params.purpose === 'availability') {
          return {
            kind: 'availability',
            available: true,
            authoritativeCredentialRevision: active.profile.revision,
          };
        }
        const apiKey = await resolveDshProviderApiKey(active, context.signal);
        return {
          kind: 'material',
          authoritativeCredentialRevision: active.profile.revision,
          material: { apiKey },
          providerNetwork: getProviderRequestProxyPolicy(active.profile.provider),
        };
      },
      'host/interaction/request': async (params, context) => {
        const interactionId = string(params.interactionId, 'DSH interaction id');
        const kind = string(params.kind, 'DSH interaction kind') as PendingInteraction['kind'];
        if (kind !== 'permission' && kind !== 'ask_user' && kind !== 'plan_approval') {
          throw new Error('DSH interaction kind is unsupported');
        }
        const schema = object(params.schema, 'DSH interaction schema');
        const authority = object(params.authority, 'DSH interaction authority');
        const toolName = kind === 'permission'
          ? (typeof schema.tool === 'string' ? schema.tool : 'DSHTool')
          : kind === 'plan_approval' ? 'ExitPlanMode' : 'AskUserQuestion';
        const details = kind === 'permission'
          ? await dshPermissionReview(params as MethodParams<'host/interaction/request'>, attachments, options.sessionId)
          : {};
        if (context.signal.aborted) {
          if (details.reviewRef) await releaseLargeValueRef(details.reviewRef.id);
          throw context.signal.reason;
        }
        pendingInteractions.set(interactionId, {
          kind,
          desiredPolicyRevision: string(params.desiredPolicyRevision, 'DSH interaction revision'),
          schema,
          ...(details.reviewRef === undefined ? {} : { reviewRefId: details.reviewRef.id }),
        });
        emitProductEvent({
          kind: 'permission_request',
          requestId: interactionId,
          toolName,
          toolUseId: typeof authority.callId === 'string' ? authority.callId : interactionId,
          ...(typeof authority.rootCallId === 'string' ? { rootToolUseId: authority.rootCallId } : {}),
          input: schema,
          ...details,
          interactionKind: kind,
          ...(params.permissionAction === 'sandbox.escalation'
            ? { defaultToNo: true, suppressAlwaysAllowRule: true }
            : {}),
        });
        emitProductEvent({ kind: 'status_change', state: 'waiting_permission' });
        return { registered: true };
      },
      'host/tool/execute': (params, context) => canonicalWeb.handles(params)
        ? canonicalWeb.execute(params, context)
        : (() => {
            const plane = extensionPlaneForHostRequest(params);
            return plane
              ? executeDshProductHostTool({
                  plane,
                  attachments,
                  runtimeSessionId: processValue?.runtimeSessionId,
                  productSessionId: options.sessionId,
                  params,
                  context,
                })
              : Promise.resolve({ state: 'failed', code: 'host_tool_authority_mismatch' });
          })(),
      'host/hook/execute': () => ({ state: 'continue' }),
      'host/attachment/put': params => attachments.put(params),
      'host/attachment/acquire': params => attachments.acquire(params),
      'host/attachment/release': params => attachments.release(params),
    });
    const notificationHandlers: DshRuntimeNotificationHandlers = Object.freeze({
      'runtime/event': params => {
        if (!projector) throw new Error('DSH event arrived before projection was bound');
        return projector.accept(params);
      },
      'host/interaction/cancel': params => {
        const interactionId = string(params.interactionId, 'DSH cancelled interaction id');
        const pending = pendingInteractions.get(interactionId);
        pendingInteractions.delete(interactionId);
        if (pending?.reviewRefId) void releaseLargeValueRef(pending.reviewRefId);
        emitProductEvent({ kind: 'interactive_request_resolved', requestId: interactionId, status: 'cancelled' });
      },
    });
    const host = new DshRuntimeProcessHost({
      installation,
      initialize,
      hostHandlers,
      notificationHandlers,
      childEnvironment,
      onStderrLine: line => emitProductEvent({ kind: 'log', level: 'warn', message: line }),
      redactStderrLine: redactDshDiagnosticLine,
      onFailure: error => {
        emitProductEvent({ kind: 'log', level: 'error', message: redactDshDiagnosticLine(error.message) });
        // Transport failure ends this process generation. The shared lifecycle
        // owner must release running state so queued input can resume it.
        emitProductEvent({ kind: 'session_complete', subtype: 'error', result: redactDshDiagnosticLine(error.message) });
      },
    });

    try {
      const identity = await host.start();
      projector = new DshRuntimeEventProjector({
        productSessionId: options.sessionId,
        runtimeGeneration: identity.runtimeGeneration,
        onEvent: emitProductEvent,
        clientUserMessageIdForOperation: operationId => processValue?.operationUserMessages.get(operationId),
        clientUserMessageIdForInjection: messageId => processValue?.injectedUserMessages.has(messageId) || recoveringInputIds.has(messageId) ? messageId : undefined,
        onCollaborationAdmitted: (clientOperationId, turnId) => {
          deferProductAction(() => {
            if (!processValue) throw new Error('DSH collaboration admission has no process owner');
            processValue.collaborationOperations.add(clientOperationId);
            processValue.activeOperationId = clientOperationId;
            processValue.realtimeSteerEligibleOperationId = clientOperationId;
          }, turnId);
        },
        onTurnTerminal: terminal => {
          deferProductAction(() => {
            if (processValue?.activeOperationId === terminal.clientOperationId) {
              void processValue.configuration.preparedProvider?.reportTerminal(terminal.terminal.kind === 'succeeded')
                .catch(() => console.warn('[dsh] Managed Provider terminal projection failed'));
            }
            if (processValue?.activeOperationId === terminal.clientOperationId) {
              processValue.activeOperationId = undefined;
            }
            if (processValue?.realtimeSteerEligibleOperationId === terminal.clientOperationId) {
              processValue.realtimeSteerEligibleOperationId = undefined;
            }
          }, terminal.turnId);
        },
        onPlan: (snapshot) => {
          projectedPlan = snapshot;
          if (processValue) {
            processValue.planMode = snapshot.mode;
            processValue.planRevision = snapshot.revision;
          }
          // Plan is native Session state, independent of Product permission.
          // Reporting the current turn's permission here would write its older
          // admission policy back over a newer Session desired configuration.
        },
        resolveToolImage: async (image, context) => {
          const lease = await attachments.acquire({
            attachmentId: string(image.attachmentId, 'DSH tool image attachment id'),
            expectedMimeType: string(image.mimeType, 'DSH tool image MIME type'),
            expectedSizeBytes: nonNegativeInteger(image.sizeBytes, 'DSH tool image size'),
            expectedSha256: string(image.sha256, 'DSH tool image digest'),
          });
          try {
            return await saveToolAttachment(
              { kind: 'externalPath', sourcePath: string(lease.readOnlyPath, 'DSH tool image lease path') },
              {
                sessionId: options.sessionId,
                turnId: context.turnId ?? context.runtimeSessionId,
                toolUseId: context.toolUseId,
                mimeType: string(lease.mimeType, 'DSH tool image lease MIME type'),
                kind: 'image',
                caption: optionalString(image.name),
                producedBy: context.toolName,
              },
            );
          } finally {
            attachments.release({ leaseId: string(lease.leaseId, 'DSH tool image lease id') });
          }
        },
      });
      const extensionResult = await host.request(
        'extension/replace',
        { snapshotAttachment: await attachments.publishJson(extension) },
      );
      const componentReceipts = extensionComponentReceipts(extensionResult);
      const componentIssues = componentReceipts.filter(component => (
        component.state !== 'ready' && component.state !== 'disabled'
      ));
      const extensionReceipt = {
        state: extensionResult.state,
        desiredRevision: extensionResult.desiredRevision,
        effectiveRevision: extensionResult.effectiveRevision,
        componentCount: componentReceipts.length,
        issues: componentIssues,
      };
      console.log(`[dsh-extension] initial replace receipt=${JSON.stringify(extensionReceipt)}`);
      for (const issue of componentIssues) {
        console.warn(
          `[dsh-extension] component isolated key=${issue.key} state=${issue.state} reason=${issue.reason ?? 'none'}`,
        );
      }
      if (extensionResult.state !== 'applied'
        || extensionResult.effectiveRevision !== extension.revision) {
        throw new Error(
          `DSH extension snapshot did not become effective before Session binding: ${JSON.stringify(extensionReceipt)}`,
        );
      }
      const extensionCatalog = await host.request('extension/catalog', {});
      const extensionFacts = extensionCatalogFacts(extensionPlane, extensionCatalog, extensionResult);
      const extensionDigest = extensionFacts.digest;
      const loadedSkillNames = extensionFacts.loadedSkillNames;
      const admittedExtensionStatus = projectDshExtensionStatus(extensionPlane, extensionResult);
      for (const issue of admittedExtensionStatus.components) {
        if (issue.state !== 'failed' && issue.state !== 'unsupported') continue;
        console.warn(
          `[dsh-extension] product diagnostic component=${issue.component} id=${issue.id ?? 'none'} state=${issue.state} code=${issue.code}`,
        );
      }

      const bindingPermissionMode = configuration.productPermissionMode;
      const bindingConfigRevision = options.resumeSessionId
        ? configuration.revision
        : `myagents-dsh-binding-v1:${hash(
            configuration.profile.revision,
            JSON.stringify(configuration.collaboration),
            bindingPermissionMode,
            OFFICIAL_INTERACTION_REVISION,
            systemContextFingerprint(options),
          )}`;
      const bindingParams: MethodParams<'session/create'> = {
        clientOperationId: `session-bind-${randomUUID()}`,
        persistenceRef: `product-session-${hash(options.sessionId)}`,
        provider: configuration.profile,
        collaboration: configuration.collaboration,
        configRevision: bindingConfigRevision,
        extensionDigest,
        ...systemContextParams(options),
        permissionMode: bindingPermissionMode,
        interactionScenario: OFFICIAL_INTERACTION_REVISION,
        ...(options.resumeSessionId ? { runtimeSessionId: options.resumeSessionId } : {}),
      };
      let binding = await host.request(
        options.resumeSessionId ? 'session/resume' : 'session/create',
        bindingParams,
      );
      const runtimeSessionId = string(binding.runtimeSessionId, 'DSH Runtime Session id');
      const mutationController = new DshMutationController(host, runtimeSessionId);
      const recovery = await recoverPendingDshMutation({
        productSessionId: options.sessionId,
        runtimeSessionId,
        binding,
        controller: mutationController,
      });
      if (recovery.productDeleted) {
        throw new Error('The DSH Product Session was deleted during recovery');
      }
      if (binding.state === 'recovery_required' || recovery.recovered) {
        binding = await host.request('session/resume', {
          ...bindingParams,
          clientOperationId: `session-rebind-${randomUUID()}`,
          runtimeSessionId,
        });
      }
      if (binding.state !== 'ready') {
        throw new Error(`DSH Session requires recovery: ${String(binding.reason ?? 'unknown')}`);
      }
      if (binding.runtimeSessionId !== runtimeSessionId) {
        throw new Error('DSH recovery changed the Runtime Session identity');
      }
      const turnReconciliation = options.resumeSessionId
        ? await reconcileDshTurnsAtStartup({
            productSessionId: options.sessionId,
            runtimeSessionId,
            controller: mutationController,
          })
        : { transcriptChanged: false, reconciledOperations: 0, settledTurnIds: [] };
      const toolCatalog = object(binding.toolCatalog, 'DSH tool catalog');
      const boundExtensionCatalog = object(binding.extensionCatalog, 'DSH bound extension catalog');
      if (boundExtensionCatalog.digest !== extensionDigest) {
        throw new Error('DSH Session bound a different extension catalog generation');
      }
      const tools = Array.isArray(toolCatalog.effectiveTools)
        ? toolCatalog.effectiveTools.filter((tool): tool is string => typeof tool === 'string')
        : [];
      processValue = new DshProcess(
        host,
        projector,
        attachments,
        canonicalWeb,
        options,
        onEvent,
        initialize.executionEnvironment,
        configuration,
        runtimeSessionId,
        extensionDigest,
        tools,
        recovery.recovered || turnReconciliation.transcriptChanged,
        loadedSkillNames,
        extensionPlane,
        extensionCatalog,
        admittedExtensionStatus,
        turnReconciliation.activeTurn,
        pendingInteractions,
      );
      if (drainRequested) throw new Error('Managed Provider binding was drained during DSH admission');
      if (projectedPlan) {
        processValue.planMode = projectedPlan.mode;
        processValue.planRevision = projectedPlan.revision;
      }
      await projector.whenIdle();
      if (turnReconciliation.activeTurn) {
        onEvent({
          kind: 'root_turn_admitted',
          runtimeTurnId: turnReconciliation.activeTurn.productTurnId,
          ...(turnReconciliation.activeTurn.origin === 'collaboration'
            ? { origin: 'collaboration' as const, clientOperationId: turnReconciliation.activeTurn.clientOperationId }
            : { clientUserMessageId: turnReconciliation.activeTurn.clientUserMessageId }),
        });
      }
      const settledTurnIds = new Set(turnReconciliation.settledTurnIds);
      productEventDeliveryReady = true;
      for (const { action, turnId } of deferredProductActions.splice(0)) {
        // Reconciliation already restored these terminals. Preserve events for operations
        // admitted after its snapshot, including background reports waking an idle Root.
        if (turnId === undefined || !settledTurnIds.has(turnId)) action();
      }
      await this.applyConfiguration(processValue, configuration);
      onEvent({
        kind: 'session_init',
        sessionId: runtimeSessionId,
        model: configuration.profile.modelId,
        tools: [...tools],
      });
      onEvent({ kind: 'runtime_tool_catalog', tools: [...tools] });
      onEvent({
        kind: 'runtime_diagnostics',
        diagnostics: extensionDiagnostics(
          workspacePath,
          extensionCatalog,
          admittedExtensionStatus,
          processValue.configuration,
          processValue.permissionRules,
        ),
      });
      onEvent({
        kind: 'status_change',
        state: pendingInteractions.size > 0
          ? 'waiting_permission'
          : processValue.activeOperationId
            ? 'running'
            : 'idle',
      });
      if (options.initialTurn) {
        await this.startTurn(
          processValue,
          options.initialTurn.message,
          options.initialTurn.images,
          options.initialTurn.clientUserMessageId,
          options.initialTurn.clientOperationId,
        );
      }
      return processValue;
    } catch (error) {
      if (processValue) processValue.closeOwnedResources('session_admission_failed');
      else await configuration.preparedProvider?.release().catch(() => undefined);
      attachments.close();
      await canonicalWeb.close().catch(() => undefined);
      extensionPlane.hostToolDispatcher?.dispose('session_admission_failed');
      await host.stop('session_admission_failed').catch(() => undefined);
      throw error;
    }
    } finally {
      if (!processValue || processValue.exited) {
        await configuration.preparedProvider?.release().catch(() => undefined);
      }
    }
  }

  private async canonicalInput(
    process: DshProcess,
    message: string,
    images: readonly ResolvedImagePayload[] | undefined,
  ): Promise<MethodParams<'turn/start'>['input']> {
    const text = message.trim();
    const imageParts = await process.attachments.registerImages(images);
    const parts: MethodParams<'turn/start'>['input']['parts'] = [
      ...(text ? [{ kind: 'text' as const, text }] : []),
      ...imageParts,
    ];
    if (parts.length === 0) throw new Error('DSH turn input is empty');
    return { parts };
  }

  private async startTurn(
    process: DshProcess,
    message: string,
    images: readonly ResolvedImagePayload[] | undefined,
    clientUserMessageId: string,
    requestedClientOperationId?: string,
    allowRealtimeSteer = true,
  ): Promise<void> {
    if (process.activeOperationId) throw new Error('DSH already owns an active root turn');
    // Global collaboration choices become effective through the existing
    // configuration owner at the next user-turn boundary, including a warm process.
    const desired = await compileConfiguration(process.options, { model: process.configuration.profile.modelId,
      permissionMode: process.desiredPermissionMode, reasoningEffort: process.configuration.reasoningEffort }, process.configuration);
    if (desired.revision !== process.configuration.revision) await this.applyConfiguration(process, desired);
    else process.configuration = desired;
    if (process.activeOperationId) throw new Error('DSH Root acquired collaboration work during configuration admission');
    if (process.desiredExtensionPlane) {
      const reconciled = await this.reconcileDshExtensions(process);
      if (reconciled?.state !== 'applied' && reconciled?.state !== 'unchanged') {
        throw new Error('DSH extension generation is not effective at the root-turn boundary');
      }
    }
    const clientOperationId = requestedClientOperationId ?? `turn-${randomUUID()}`;
    process.activeOperationId = clientOperationId;
    process.realtimeSteerEligibleOperationId = undefined;
    process.operationUserMessages.set(clientOperationId, clientUserMessageId);
    try {
      await process.configuration.preparedProvider?.beforeTurn();
      const result = await process.host.request('turn/start', {
        clientOperationId,
        clientUserMessageId,
        input: await this.canonicalInput(process, message, images),
        configRevision: process.configuration.revision,
        extensionDigest: process.extensionDigest,
        executionEnvironmentRevision: process.executionEnvironment.revision,
        executionEnvironmentDigest: process.executionEnvironment.digest,
        limits: {
          ...(process.options.maxTurns ? { maxTurns: process.options.maxTurns } : {}),
        },
        origin: turnOrigin(process.options),
      });
      if (result.state !== 'accepted' && result.state !== 'already_known') {
        throw new Error('DSH root turn was not admitted');
      }
      if (allowRealtimeSteer && process.activeOperationId === clientOperationId) {
        process.realtimeSteerEligibleOperationId = clientOperationId;
      }
    } catch (error) {
      await process.configuration.preparedProvider?.reportTerminal(false);
      if (process.activeOperationId === clientOperationId) process.activeOperationId = undefined;
      if (process.realtimeSteerEligibleOperationId === clientOperationId) {
        process.realtimeSteerEligibleOperationId = undefined;
      }
      throw error;
    }
  }

  async sendMessage(
    runtimeProcess: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
    options?: Parameters<AgentRuntime['sendMessage']>[3],
  ): Promise<void> {
    await this.startTurn(
      dshProcess(runtimeProcess),
      message,
      images,
      options?.clientUserMessageId ?? `user-${randomUUID()}`,
      options?.clientOperationId,
      options?.allowRealtimeSteer !== false,
    );
  }

  private emitExtensionDiagnostics(process: DshProcess): void {
    process.onEvent({
      kind: 'runtime_diagnostics',
      diagnostics: extensionDiagnostics(
        process.executionEnvironment.workspace.canonicalRoot,
        process.extensionCatalog,
        process.extensionDiagnostics,
        process.configuration,
        process.permissionRules,
      ),
    });
  }

  private async refreshPermissionRules(
    process: DshProcess,
    emitDiagnostics = true,
  ): Promise<RuntimePermissionRulesSnapshot> {
    const snapshot = parseDshPermissionRulesSnapshot(
      await process.host.request('permission/rules/list', {}),
    );
    process.permissionRules = snapshot;
    if (emitDiagnostics) this.emitExtensionDiagnostics(process);
    return snapshot;
  }

  async listAgentWork(runtimeProcess: RuntimeProcess, tasksFor?: string) {
    const process = dshProcess(runtimeProcess);
    const items: ReturnType<typeof projectDshAgentWorkSnapshot>[] = [];
    let taskLists: RuntimeAgentWorkTree['taskLists'];
    if (process.host.supportsNativeSubagents()) {
      const catalog = await process.host.requestNativeSubagent('subagent/list', {});
      if (!Array.isArray(catalog.items)) throw new Error('DSH subagent catalog is invalid');
      for (const child of catalog.items) {
        const activity = child.activity;
        const mode = child.mode;
        if ((activity !== 'running' && activity !== 'inactive') || (mode !== 'one-shot' && mode !== 'continuable')) throw new Error('DSH subagent state is invalid');
        items.push({
          native: { mode, activity },
          agentId: child.id, taskId: child.id, parentToolUseId: child.id,
          tree: { rootAgentId: process.runtimeSessionId, parentAgentId: child.parentId, depth: child.depth },
          status: activity === 'running' ? 'running' : 'completed', startedAt: 0,
          mode: mode === 'continuable' ? 'continuable' : 'foreground',
          description: child.label ?? '',
          handleState: mode === 'continuable' ? 'open' : 'closed',
          handleRevision: 0,
        });
      }
      const addresses = [
        { agentId: process.runtimeSessionId, list: 'personal' as const },
        { agentId: process.runtimeSessionId, list: 'shared' as const },
        ...(tasksFor && items.some(item => item.agentId === tasksFor)
          ? [{ agentId: tasksFor, list: 'personal' as const }] : []),
      ];
      taskLists = await Promise.all(addresses.map(async address => {
        const result = await process.host.requestNativeSubagent('subagent/tasks', address);
        return { agentId: result.agentId, list: result.list, tasks: result.snapshot.tasks };
      }));
    } else {
    const seen = new Set<string>();
    let afterTaskId: string | undefined;
    do {
      const result = await process.host.request('work/list', afterTaskId === undefined ? {} : { afterTaskId });
      if (!Array.isArray(result.items) || result.items.length > 32 || items.length + result.items.length > 256) throw new Error('DSH Work list is invalid');
      for (const raw of result.items) {
        const item = projectDshAgentWorkSnapshot(object(raw, 'DSH Work item'));
        if (seen.has(item.taskId)) throw new Error('DSH Work list repeats an Agent');
        seen.add(item.taskId); items.push(item);
      }
      afterTaskId = result.nextTaskId === undefined ? undefined : string(result.nextTaskId, 'DSH Work cursor');
      if (afterTaskId !== undefined && (result.items.length === 0 || afterTaskId !== items.at(-1)?.taskId)) throw new Error('DSH Work cursor did not advance');
    } while (afterTaskId !== undefined);
    }
    const effective = process.configuration.collaboration;
    let desiredState: 'effective' | 'pending' | 'invalid';
    try {
      const desired = await compileConfiguration(process.options, { model: process.configuration.profile.modelId,
        permissionMode: process.desiredPermissionMode, reasoningEffort: process.configuration.reasoningEffort }, process.configuration);
      desiredState = desired.revision === process.configuration.revision ? 'effective' : 'pending';
    } catch { desiredState = 'invalid'; }
    return { items, ...(taskLists === undefined ? {} : { taskLists }), configuration: { revision: process.configuration.revision,
      maxDepth: effective.maxDepth, maxActiveChildren: effective.maxActiveChildren, maxRetainedChildren: effective.maxRetainedChildren,
      messageDelivery: effective.messageDelivery, modelPolicy: effective.modelPolicy.mode, desiredState,
    } };
  }

  async controlAgentWork(runtimeProcess: RuntimeProcess, input: RuntimeAgentWorkControl): Promise<void> {
    const process = dshProcess(runtimeProcess);
    if (process.host.supportsNativeSubagents()) {
      if (input.kind === 'resume') throw new Error('Native DSH subagents resume through a new message');
      const result = input.kind === 'message'
        ? await process.host.requestNativeSubagent('subagent/prompt', { agentId: input.agentId, clientMessageId: input.clientMessageId, message: input.message })
        : await process.host.requestNativeSubagent('subagent/interrupt', { agentId: input.agentId });
      if (result.ok !== true) throw new Error('DSH subagent action was not accepted');
      return;
    }
    const { kind, ...params } = input;
    const method = kind === 'resume' ? 'work/agent/resume' : kind === 'stop' ? 'work/agent/stop' : 'work/agent/message';
    const result = await process.host.request(method, params);
    if (result.ok !== true) throw new Error('DSH Agent action was not accepted');
    await process.projector.whenIdle();
  }

  async listPermissionRules(
    runtimeProcess: RuntimeProcess,
  ): Promise<RuntimePermissionRulesSnapshot> {
    return this.refreshPermissionRules(dshProcess(runtimeProcess));
  }

  async addPermissionRule(
    runtimeProcess: RuntimeProcess,
    input: Readonly<{
      expectedRevision: string;
      tool: string;
      permissionClass: string;
      target: string;
    }>,
  ): Promise<RuntimePermissionRuleMutationResult> {
    const process = dshProcess(runtimeProcess);
    if (process.activeOperationId) {
      throw new Error('DSH permission rules can change only while the root turn is idle');
    }
    const result = parseDshPermissionRuleMutation(await process.host.request(
      'permission/rules/add',
      {
        expectedRevision: validateDshPermissionIdentifier(
          input.expectedRevision,
          'DSH expected permission revision',
        ),
        tool: validateDshPermissionIdentifier(input.tool, 'DSH permission rule tool'),
        permissionClass: validateDshPermissionIdentifier(
          input.permissionClass,
          'DSH permission rule class',
        ),
        target: validateDshPermissionTarget(input.target),
      },
    ));
    const snapshot = await this.refreshPermissionRules(process);
    if (snapshot.revision !== result.revision) {
      throw new Error('DSH permission mutation read-back revision differs from the result');
    }
    return result;
  }

  async revokePermissionRule(
    runtimeProcess: RuntimeProcess,
    input: Readonly<{ expectedRevision: string; ruleId: string }>,
  ): Promise<RuntimePermissionRuleMutationResult> {
    const process = dshProcess(runtimeProcess);
    if (process.activeOperationId) {
      throw new Error('DSH permission rules can change only while the root turn is idle');
    }
    const result = parseDshPermissionRuleMutation(await process.host.request(
      'permission/rules/revoke',
      {
        expectedRevision: validateDshPermissionIdentifier(
          input.expectedRevision,
          'DSH expected permission revision',
        ),
        ruleId: validateDshPermissionIdentifier(input.ruleId, 'DSH permission rule id'),
      },
    ));
    const snapshot = await this.refreshPermissionRules(process);
    if (snapshot.revision !== result.revision) {
      throw new Error('DSH permission mutation read-back revision differs from the result');
    }
    return result;
  }

  private async commitEffectiveExtension(
    process: DshProcess,
    plane: DshCompiledExtensionPlane,
    status: RuntimeExtensionDiagnostics,
    result: DshRpcObject,
  ): Promise<RuntimeExtensionDiagnostics> {
    const catalog = await process.host.request('extension/catalog', {});
    const facts = extensionCatalogFacts(plane, catalog, result);
    process.extensionPlane = plane;
    process.extensionCatalog = catalog;
    process.extensionDigest = facts.digest;
    process.loadedSkillNames = facts.loadedSkillNames;
    process.tools = facts.tools;
    process.extensionDiagnostics = status;
    process.desiredExtensionPlane = undefined;
    // DSH may retain an old component generation for background children
    // after the root operation reaches the replacement boundary. Protocol
    // 2.0.0 carries that generation on reverse requests but exposes no Host
    // retirement acknowledgement, so every once-effective Host plane remains
    // routable until this process generation closes.
    process.onEvent({ kind: 'runtime_tool_catalog', tools: [...facts.tools] });
    this.emitExtensionDiagnostics(process);
    return status;
  }

  private async settleExtensionApply(
    process: DshProcess,
    plane: DshCompiledExtensionPlane,
    result: DshRpcObject,
    unchanged = false,
  ): Promise<RuntimeExtensionDiagnostics> {
    if (result.desiredRevision !== plane.snapshot.revision) {
      throw new Error('DSH desired extension revision differs from Product intent');
    }
    const status = projectDshExtensionStatus(plane, result, unchanged);
    for (const issue of extensionComponentReceipts(result)) {
      if (issue.state === 'ready' || issue.state === 'disabled') continue;
      console.warn(
        `[dsh-extension] component isolated key=${issue.key} state=${issue.state} reason=${issue.reason ?? 'none'}`,
      );
    }
    if (status.state === 'applied' || status.state === 'unchanged') {
      if (result.effectiveRevision !== plane.snapshot.revision) {
        throw new Error('DSH applied a different extension revision');
      }
      return this.commitEffectiveExtension(process, plane, status, result);
    }
    process.extensionDiagnostics = status;
    if (status.state === 'failed') {
      process.desiredExtensionPlane = undefined;
      if (plane !== process.extensionPlane) {
        process.releaseExtensionPlane(plane, 'dsh_extension_generation_failed');
      }
    } else {
      process.desiredExtensionPlane = plane;
    }
    this.emitExtensionDiagnostics(process);
    return status;
  }

  async replaceDshExtensions(
    runtimeProcess: RuntimeProcess,
    source: DshProductExtensionSource,
  ): Promise<RuntimeExtensionDiagnostics> {
    const process = dshProcess(runtimeProcess);
    return process.serializeExtensionUpdate(async () => {
      let plane: DshCompiledExtensionPlane;
      try {
        plane = compileDshProductExtensionPlane(source);
      } catch (error) {
        source.hostToolDispatcher?.dispose('dsh_extension_compilation_failed');
        throw error;
      }
      const existing = process.planeForGeneration(dshExtensionGenerationId(plane));
      if (existing && existing === process.desiredExtensionPlane) {
        plane.hostToolDispatcher?.dispose('dsh_extension_generation_unchanged');
        return process.extensionDiagnostics;
      }
      if (existing === process.extensionPlane && !process.desiredExtensionPlane) {
        plane.hostToolDispatcher?.dispose('dsh_extension_generation_unchanged');
        const unchanged = {
          ...process.extensionDiagnostics,
          desiredRevision: process.extensionPlane.snapshot.revision,
          effectiveRevision: process.extensionPlane.snapshot.revision,
          state: 'unchanged' as const,
        };
        process.extensionDiagnostics = unchanged;
        this.emitExtensionDiagnostics(process);
        return unchanged;
      }
      if (existing) {
        plane.hostToolDispatcher?.dispose('dsh_extension_generation_reused');
        plane = existing;
      }
      // Publication is local and definite: until it succeeds the Runtime
      // cannot own this candidate, so preserve the current desired generation.
      let snapshotAttachment;
      try {
        snapshotAttachment = await process.attachments.publishJson(plane.snapshot);
        if (!existing) process.registerExtensionPlane(plane);
      } catch (error) {
        if (!existing) plane.hostToolDispatcher?.dispose('dsh_extension_snapshot_publish_failed');
        throw error;
      }
      const previousDesired = process.desiredExtensionPlane;
      process.desiredExtensionPlane = plane;
      // On an ambiguous transport failure the Runtime may already own this
      // candidate and can still issue generation-fenced credential requests;
      // therefore the registered plane remains owned until reconciliation or
      // process teardown.
      const result = await process.host.request(
        'extension/replace',
        { snapshotAttachment },
      );
      if (previousDesired && previousDesired !== plane && previousDesired !== process.extensionPlane) {
        process.releaseExtensionPlane(previousDesired, 'dsh_extension_candidate_replaced');
      }
      return this.settleExtensionApply(process, plane, result);
    });
  }

  async reconcileDshExtensions(
    runtimeProcess: RuntimeProcess,
  ): Promise<RuntimeExtensionDiagnostics | null> {
    const process = dshProcess(runtimeProcess);
    return process.serializeExtensionUpdate(async () => {
      const plane = process.desiredExtensionPlane;
      if (!plane) return null;
      const result = await process.host.request('extension/status', {});
      return this.settleExtensionApply(process, plane, result);
    });
  }

  getActiveRootOperation(runtimeProcess: RuntimeProcess): Readonly<{
    clientOperationId: string;
    clientUserMessageId?: string;
    origin?: 'collaboration';
    realtimeSteerEligible?: boolean;
  }> | null {
    const process = dshProcess(runtimeProcess);
    const clientOperationId = process.activeOperationId;
    if (!clientOperationId) return null;
    const clientUserMessageId = process.operationUserMessages.get(clientOperationId);
    if (!clientUserMessageId && !process.collaborationOperations.has(clientOperationId)) {
      throw new Error('DSH active root operation lost its Product origin');
    }
    return Object.freeze({
      ...(process.collaborationOperations.has(clientOperationId) ? { origin: 'collaboration' as const } : {}),
      clientOperationId,
      clientUserMessageId,
      realtimeSteerEligible: process.realtimeSteerEligibleOperationId === clientOperationId,
    });
  }

  canSteerMessage(runtimeProcess: RuntimeProcess): boolean {
    return !runtimeProcess.exited
      && this.getActiveRootOperation(runtimeProcess)?.realtimeSteerEligible === true;
  }

  async steerMessage(
    runtimeProcess: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
    options?: { clientUserMessageId?: string; clientOperationId?: string; beforeDispatch?: (identity: { clientOperationId: string; inputFingerprint: string }) => Promise<void> },
  ): Promise<void> {
    const process = dshProcess(runtimeProcess);
    if (!options?.clientUserMessageId) throw new Error('DSH realtime input requires a stable Product user identity');
    const pending = getSessionMetadata(process.options.sessionId)?.pendingDshInputs?.find(input => input.clientUserMessageId === options.clientUserMessageId
      && input.clientOperationId === options.clientOperationId && input.sourceRuntimeSessionId === process.runtimeSessionId);
    const clientOperationId = pending?.clientOperationId ?? process.activeOperationId;
    if (!clientOperationId) throw new RuntimeSteerUnavailableError('DSH has no active root turn to steer');
    if (!pending && process.realtimeSteerEligibleOperationId !== process.activeOperationId) {
      throw new RuntimeSteerUnavailableError('DSH active root turn is not eligible for realtime steering');
    }
    if (options.clientOperationId !== undefined && options.clientOperationId !== clientOperationId) throw new Error('DSH realtime input target changed before admission');
    const input = await this.canonicalInput(process, message, images);
    const inputFingerprint = fingerprintDshNativeInput(input);
    if (pending && pending.runtimeInputFingerprint !== inputFingerprint) throw new Error('The recovered DSH input differs from its original Runtime request');
    await options.beforeDispatch?.({ clientOperationId, inputFingerprint });
    process.injectedUserMessages.add(options.clientUserMessageId);
    let result: DshRpcObject;
    try {
      result = await process.host.request('turn/followUp', {
        clientOperationId, messageId: options.clientUserMessageId, input, delivery: 'realtime',
      });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'turn_not_active') throw error;
      if (!pending) {
        process.injectedUserMessages.delete(options.clientUserMessageId);
        throw new RuntimeSteerUnavailableError(error.message);
      }
      const history = await new DshMutationController(process.host, process.runtimeSessionId).readHistory();
      const terminal = history.events.some(event => event.eventType === 'myagents/operation/terminal'
        && object(event.data, 'DSH terminal input owner').clientOperationId === clientOperationId);
      const accepted = history.events.some(event => event.eventType === 'myagents/operation/message'
        && object(event.data, 'DSH input receipt').clientMessageId === options.clientUserMessageId);
      if (!terminal || accepted) throw error;
      // An exact terminal head proves this pre-dispatch Product intent never
      // entered DSH. It cannot be silently reassigned to the next operation.
      result = { messageId: options.clientUserMessageId, state: 'cancelled' };
    }
    if (result.messageId !== options.clientUserMessageId || !['queued', 'admitted', 'delivered', 'cancelled'].includes(String(result.state))) throw new Error('DSH realtime input was not accepted');
    if (result.state === 'delivered' || result.state === 'cancelled') process.onEvent({
      kind: result.state === 'delivered' ? 'user_message_accepted' : 'user_message_cancelled', clientUserMessageId: options.clientUserMessageId,
    });
  }

  async compactContext(runtimeProcess: RuntimeProcess): Promise<void> {
    const process = dshProcess(runtimeProcess);
    if (process.activeOperationId) throw new Error('DSH compaction requires a quiescent root turn');
    const result = await process.host.request('session/compact', {
      clientOperationId: `compact-${randomUUID()}`,
    });
    if (result.state !== 'accepted' && result.state !== 'already_known') {
      throw new Error('DSH compaction was not accepted');
    }
    await process.projector.whenIdle();
  }

  async cancelSteeredMessage(
    runtimeProcess: RuntimeProcess,
    input: { clientOperationId: string; clientUserMessageId: string },
  ): Promise<'cancelled' | 'delivered'> {
    const process = dshProcess(runtimeProcess);
    let result: DshRpcObject;
    try {
      result = await process.host.request('turn/message/cancel', {
        clientOperationId: input.clientOperationId, messageId: input.clientUserMessageId,
      });
    } catch (error) {
      const pending = getSessionMetadata(process.options.sessionId)?.pendingDshInputs?.find(candidate => candidate.clientUserMessageId === input.clientUserMessageId
        && candidate.clientOperationId === input.clientOperationId && candidate.state === 'cancel_requested' && candidate.sourceRuntimeSessionId === process.runtimeSessionId);
      if (!pending || !(error instanceof Error) || !('code' in error) || error.code !== 'turn_message_unknown') throw error;
      const history = await new DshMutationController(process.host, process.runtimeSessionId).readHistory();
      if (history.events.some(event => event.eventType === 'myagents/operation/message'
        && object(event.data, 'DSH cancellation receipt').clientMessageId === input.clientUserMessageId)) throw error;
      result = { messageId: input.clientUserMessageId, state: 'cancelled' };
    }
    if (result.messageId !== input.clientUserMessageId || (result.state !== 'cancelled' && result.state !== 'delivered')) {
      throw new Error('DSH input cancellation did not return an exact durable receipt');
    }
    process.onEvent({ kind: result.state === 'cancelled' ? 'user_message_cancelled' : 'user_message_accepted', clientUserMessageId: input.clientUserMessageId });
    return result.state;
  }

  async respondAskUserQuestion(runtimeProcess: RuntimeProcess, requestId: string, answers: AskUserQuestionAnswers | null): Promise<void> {
    const process = dshProcess(runtimeProcess);
    if (process.pendingInteractions.get(requestId)?.kind !== 'ask_user') throw new Error('DSH question is no longer pending');
    await this.respondPermission(runtimeProcess, requestId, answers === null ? 'deny' : 'allow_once', undefined, undefined,
      answers === null ? undefined : { answers });
  }

  async respondPermission(
    runtimeProcess: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    reason?: string,
    _suggestions?: unknown[],
    updatedInput?: Record<string, unknown>,
  ): Promise<void> {
    const process = dshProcess(runtimeProcess);
    const pending = process.pendingInteractions.get(requestId);
    if (!pending) throw new Error('DSH interaction is no longer pending');
    if (decision === 'always_allow' && pending.schema.permissionClass === 'sandbox.escalation') {
      throw new Error('Sandbox escalation can approve only this operation');
    }
    const question = pending.kind !== 'permission';
    const wireDecision = question
      ? (pending.kind === 'plan_approval' || decision !== 'deny' ? 'answered' : 'cancelled')
      : decision;
    const result = await process.host.request('interaction/respond', {
      interactionId: requestId,
      expectedRevision: pending.desiredPolicyRevision,
      decision: wireDecision,
      ...(question && wireDecision === 'answered'
        ? { value: answerValue(pending.kind, pending.schema, decision, reason, updatedInput) }
        : {}),
    });
    if (result.state === 'rejected') {
      throw new Error(`DSH interaction response was rejected: ${String(result.code)}`);
    }
    if (
      reconcileExpiredDshInteractionResponse(
        result.state,
        requestId,
        interactionId => {
          process.pendingInteractions.delete(interactionId);
          if (pending.reviewRefId) void releaseLargeValueRef(pending.reviewRefId);
        },
        process.onEvent,
      )
    ) {
      return;
    }
    if (result.state !== 'applied' && result.state !== 'already_settled') {
      throw new Error('DSH interaction response returned an invalid state');
    }
    if (!question && decision === 'always_allow') {
      const snapshot = await this.refreshPermissionRules(process);
      if (
        result.state === 'applied'
        && snapshot.revision !== string(
          result.effectivePolicyRevision,
          'DSH applied permission policy revision',
        )
      ) {
        throw new Error('DSH always-allow read-back revision differs from the response');
      }
    }
    process.pendingInteractions.delete(requestId);
    if (pending.reviewRefId) await releaseLargeValueRef(pending.reviewRefId);
    process.onEvent({ kind: 'interactive_request_resolved', requestId, status: result.state });
    process.onEvent({ kind: 'status_change', state: process.pendingInteractions.size > 0 ? 'waiting_permission' : process.activeOperationId ? 'running' : 'idle' });
  }

  async interruptTurn(runtimeProcess: RuntimeProcess): Promise<void> {
    const process = dshProcess(runtimeProcess);
    if (!process.activeOperationId) return;
    await process.host.request('turn/interrupt', {
      clientOperationId: process.activeOperationId,
      cancelQueued: false,
    });
  }

  async stopSession(runtimeProcess: RuntimeProcess): Promise<void> {
    const process = dshProcess(runtimeProcess);
    try {
      if (process.activeOperationId) {
        await process.host.request('turn/interrupt', {
          clientOperationId: process.activeOperationId,
          cancelQueued: true,
        });
      }
      await process.host.request('session/close', {
        clientOperationId: `session-close-${randomUUID()}`,
      }).catch(() => undefined);
    } finally {
      process.closeOwnedResources('host_shutdown');
      await process.host.stop('host_shutdown');
    }
  }

  private async applyConfiguration(
    process: DshProcess,
    configuration: DshConfiguration,
  ): Promise<void> {
    if (process.pendingConfiguration) throw new Error('DSH configuration admission is already in progress');
    process.pendingConfiguration = configuration;
    let result: DshRpcObject;
    try {
      result = await process.host.request('config/apply', {
      revision: configuration.revision,
      provider: configuration.profile,
      collaboration: configuration.collaboration,
      permissionMode: configuration.productPermissionMode,
      interactionScenario: OFFICIAL_INTERACTION_REVISION,
      ...systemContextParams(process.options),
      executionEnvironmentRevision: process.executionEnvironment.revision,
      executionEnvironmentDigest: process.executionEnvironment.digest,
    });
    } catch (error) {
      if (configuration.preparedProvider && configuration.preparedProvider !== process.configuration.preparedProvider) {
        await configuration.preparedProvider.release().catch(() => undefined);
      }
      throw error;
    } finally {
      process.pendingConfiguration = undefined;
    }
    if (result.state !== 'applied' || result.effectiveRevision !== configuration.revision) {
      if (configuration.preparedProvider && configuration.preparedProvider !== process.configuration.preparedProvider) {
        await configuration.preparedProvider.release().catch(() => undefined);
      }
      throw new Error('DSH configuration did not become effective');
    }
    const prior = process.configuration;
    process.configuration = configuration;
    if (prior.preparedProvider && prior.preparedProvider !== configuration.preparedProvider) {
      await prior.preparedProvider.release().catch(() => undefined);
    }
    const permissionRules = await this.refreshPermissionRules(process, false);
    if (permissionRules.permissionMode !== configuration.productPermissionMode) {
      throw new Error('DSH effective permission mode differs from Product configuration');
    }
  }

  private async applyPlanMode(process: DshProcess, desired: 'normal' | 'plan'): Promise<void> {
    const call = (mode: 'normal' | 'plan', expectedRevision: string) => process.host.request(
      'plan/apply',
      {
        clientOperationId: `plan-${randomUUID()}`,
        expectedRevision,
        mode,
      },
    );
    if (process.planRevision) {
      const result = await call(desired, process.planRevision);
      process.planRevision = string(result.revision, 'DSH Plan revision');
      process.planMode = desired;
      return;
    }

    const placeholder = `myagents-plan-probe:${hash(process.runtimeSessionId)}`;
    try {
      const already = await call(desired, placeholder);
      process.planRevision = string(already.revision, 'DSH Plan revision');
      process.planMode = desired;
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      if (code !== 'plan_revision_stale') throw error;
      const currentMode = desired === 'plan' ? 'normal' : 'plan';
      const current = await call(currentMode, placeholder);
      const currentRevision = string(current.revision, 'DSH Plan revision');
      const applied = await call(desired, currentRevision);
      process.planRevision = string(applied.revision, 'DSH Plan revision');
      process.planMode = desired;
    }
  }

  async setModel(runtimeProcess: RuntimeProcess, model: string | undefined): Promise<void> {
    const process = dshProcess(runtimeProcess);
    await this.applyConfiguration(process, await compileConfiguration(process.options, {
      model,
      permissionMode: process.configuration.productPermissionMode,
      reasoningEffort: process.configuration.reasoningEffort,
    }, process.configuration));
  }

  async setPermissionMode(runtimeProcess: RuntimeProcess, mode: string | undefined): Promise<void> {
    const process = dshProcess(runtimeProcess);
    if (process.exited) throw new Error('DSH process has exited');
    process.desiredPermissionMode = productPermissionMode(mode);
  }

  async setReasoningEffort(runtimeProcess: RuntimeProcess, effort: string | undefined): Promise<void> {
    const process = dshProcess(runtimeProcess);
    await this.applyConfiguration(process, await compileConfiguration(process.options, {
      model: process.configuration.profile.modelId,
      permissionMode: process.configuration.productPermissionMode,
      reasoningEffort: effort,
    }, process.configuration));
  }
}
