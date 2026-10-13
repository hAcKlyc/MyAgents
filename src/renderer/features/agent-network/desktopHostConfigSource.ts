import { loadAppConfig, getAllProviders } from '@/config/configService';
import { loadProjects } from '@/config/services/projectService';
import { getProjectAgent } from '@/config/services/agentConfigService';
import {
  applyProviderEnablementAndOrder,
  getEffectiveModelAliases,
  getEffectivePrimaryModel,
  completeModelAliases,
  isProjectArchived,
  mergePresetCustomModels,
  type AppConfig,
  type Project,
  type Provider,
} from '@/config/types';
import { workspacePathsEqual } from '../../../shared/workspacePath';
import { assertQueryModelRoutesCompatible, resolveProviderForModel } from '../../../shared/provider-model-routing';
import { isHostModelId, isHostProviderProfile, type PortableApiProvider } from '../../../shared/hostProviderConfig';
import { resolveAgentRuntimePreference } from '../../../shared/integrated-runtimes/identity';

export type { PortableApiProvider } from '../../../shared/hostProviderConfig';

export interface DesktopHostConfigSource {
  agentName: string;
  localWorkspacePath: string;
  provider: PortableApiProvider;
  model: string;
  /** Transient write input only. Do not place it in drafts, notices or receipts. */
  credential?: string;
}

export class DesktopHostConfigSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DesktopHostConfigSourceError';
  }
}

const unavailable = (code: string): never => { throw new DesktopHostConfigSourceError(code); };

/** Flatten the existing per-model route into the bounded, non-secret Host profile. */
export function portableApiProviderForModel(provider: Provider, model: string, config?: AppConfig): PortableApiProvider {
  if (provider.type !== 'api' || (provider.execution && provider.execution.kind !== 'builtin')
    || provider.subscriptionAuth || !isHostModelId(model)) {
    return unavailable('HOST_SOURCE_PROVIDER_UNSUPPORTED');
  }
  let concrete: Provider;
  let aliases: ReturnType<typeof getEffectiveModelAliases>;
  try {
    const effectiveProvider = { ...provider, primaryModel: getEffectivePrimaryModel(provider, config?.providerPrimaryModels) };
    concrete = resolveProviderForModel(effectiveProvider, model);
    aliases = getEffectiveModelAliases(effectiveProvider, config?.providerModelAliases);
    if (aliases) assertQueryModelRoutesCompatible(provider, concrete, Object.values(aliases).filter((value): value is string => Boolean(value)));
  } catch {
    return unavailable('HOST_SOURCE_MODEL_UNSUPPORTED');
  }
  const profile: PortableApiProvider = {
    id: concrete.id,
    name: concrete.name,
    apiProtocol: concrete.apiProtocol ?? 'anthropic',
    baseUrl: concrete.config.baseUrl ?? '',
    authType: concrete.authType ?? 'both',
    ...(concrete.upstreamFormat ? { upstreamFormat: concrete.upstreamFormat } : {}),
    ...(concrete.maxOutputTokens !== undefined ? { maxOutputTokens: concrete.maxOutputTokens } : {}),
    ...(concrete.maxOutputTokensParamName ? { maxOutputTokensParamName: concrete.maxOutputTokensParamName } : {}),
    ...(aliases ? { modelAliases: aliases } : {}),
  };
  if (!isHostProviderProfile(profile)) return unavailable('HOST_SOURCE_ENDPOINT_UNSUPPORTED');
  return profile;
}

/** Immutable target identity preserves existing Session endpoints and aliases. */
export async function versionPortableHostProfile(profile: PortableApiProvider, model: string): Promise<PortableApiProvider> {
  if (!isHostProviderProfile(profile) || !isHostModelId(model)) return unavailable('HOST_SOURCE_PROVIDER_UNSUPPORTED');
  const aliases = completeModelAliases(profile.modelAliases, model);
  const sourceProviderId = profile.sourceProviderId ?? profile.id;
  const normalized: PortableApiProvider = { ...profile, sourceProviderId, ...(aliases ? { modelAliases: aliases } : {}) };
  const identity = JSON.stringify([
    'moxbots-host-api-profile-v1', sourceProviderId, normalized.name, normalized.apiProtocol,
    normalized.baseUrl, normalized.authType, normalized.upstreamFormat ?? null,
    normalized.maxOutputTokens ?? null, normalized.maxOutputTokensParamName ?? null,
    aliases?.fable ?? null, aliases?.sonnet ?? null, aliases?.opus ?? null, aliases?.haiku ?? null, model,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const suffix = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
  return { ...normalized, id: `${sourceProviderId.slice(0, 101)}-v-${suffix}` };
}

/** Read-only source projection. Explicit missing selections never fall back. */
export function resolveDesktopHostConfigSource(config: AppConfig, projects: readonly Project[], catalog: readonly Provider[]): DesktopHostConfigSource {
  const localWorkspacePath = config.defaultWorkspacePath;
  if (!localWorkspacePath?.trim()) return unavailable('HOST_SOURCE_WORKSPACE_MISSING');
  const matchingProjects = projects.filter(project => workspacePathsEqual(project.path, localWorkspacePath));
  if (matchingProjects.length > 1) return unavailable('HOST_SOURCE_AGENT_AMBIGUOUS');
  const project = matchingProjects[0];
  if (project && isProjectArchived(project)) return unavailable('HOST_SOURCE_WORKSPACE_ARCHIVED');
  const agent = getProjectAgent(config, projects, localWorkspacePath);
  if (project?.agentId && !agent) return unavailable('HOST_SOURCE_AGENT_MISSING');
  if (agent && resolveAgentRuntimePreference({ runtimePreference: agent.runtimePreference,
    runtime: agent.runtime, runtimeSource: agent.runtimeConfig?.source, providerId: agent.providerId })?.family === 'external') {
    return unavailable('HOST_SOURCE_RUNTIME_UNSUPPORTED');
  }
  const providers = applyProviderEnablementAndOrder(
    mergePresetCustomModels([...catalog], config.presetCustomModels, config.presetRemovedModels), config,
  );
  // Match the persisted workspace selection shown in Agent settings, including
  // Projects created before AgentConfig migration.
  const requestedId = agent?.providerId ?? project?.providerId ?? config.defaultProviderId;
  const sourceKey = (id: string): string | undefined => {
    const value = config.providerApiKeys && Object.hasOwn(config.providerApiKeys, id) ? config.providerApiKeys[id] : undefined;
    if (value !== undefined && typeof value !== 'string') return unavailable('HOST_SOURCE_CREDENTIAL_UNAVAILABLE');
    return value;
  };
  const provider = requestedId
    ? providers.find(item => item.id === requestedId)
    : providers.find(item => item.enabled !== false && Boolean(sourceKey(item.id)?.trim()));
  if (!provider) return unavailable('HOST_SOURCE_PROVIDER_MISSING');
  if (provider.enabled === false) return unavailable('HOST_SOURCE_PROVIDER_DISABLED');
  const model = agent?.model ?? project?.model ?? getEffectivePrimaryModel(provider, config.providerPrimaryModels);
  if (!isHostModelId(model)) return unavailable('HOST_SOURCE_MODEL_MISSING');
  const profile = portableApiProviderForModel(provider, model, config);
  const credential = sourceKey(provider.id);
  if (credential && (/^(?:systemd-credential|host-provider-credential|managed):/.test(credential)
    || /[\r\n\0]/.test(credential) || new TextEncoder().encode(credential).length > 16 * 1024)) {
    return unavailable('HOST_SOURCE_CREDENTIAL_UNAVAILABLE');
  }
  return {
    agentName: agent?.name || project?.displayName || project?.name || 'Agent',
    localWorkspacePath,
    provider: profile,
    model,
    ...(credential?.trim() ? { credential } : {}),
  };
}

/** Re-read source authority at application time, rather than a captured React snapshot. */
export async function loadDesktopHostConfigSource(): Promise<DesktopHostConfigSource> {
  const projects = await loadProjects();
  const currentConfig = await loadAppConfig();
  // Provider overlays, route metadata, selected model and key must all use
  // this same freshly read config; mixing an old catalog with a new key is unsafe.
  const providers = await getAllProviders(currentConfig);
  return resolveDesktopHostConfigSource(currentConfig, projects, providers);
}

/** A suggestion only; caller must resolve it within a real target Host root. */
export function desktopWorkspaceDirectoryHint(localPath: string): string | undefined {
  const name = localPath.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
  return name && name !== '.' && name !== '..' ? name : undefined;
}
