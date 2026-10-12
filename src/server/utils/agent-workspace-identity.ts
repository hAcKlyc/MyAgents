import {
  AgentWorkspaceIdentityError,
  buildAgentForProject,
  reconcileAgentWorkspaceIdentities,
  resolveAgentWorkspaceProjections,
  resolveAgentWorkspaceClaimConflict,
  type AgentWorkspaceConflictChoice,
  type AgentWorkspaceIdentityDiagnostic,
  type ResolvedAgentWorkspaceProjection,
  type ResolvedAgentWorkspaceIdentity,
} from '../../shared/agentWorkspaceIdentity';
import { type PermissionMode, type Project } from '../../shared/config-types';
import {
  normalizeWorkspacePathIdentity,
  workspacePathsEqual,
} from '../../shared/workspacePath';
import type { AgentConfig } from '../../shared/types/agent';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { basename, isAbsolute, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { broadcastAppConfigChanged } from './app-config-events';
import {
  atomicModifyConfig,
  atomicModifyProjects,
  loadConfig,
  loadProjects,
  withAgentConfigIntentLock,
  type AdminAppConfig,
  type AgentConfigSlim,
  type ProjectSlim,
} from './admin-config';
import { validateExternalReadPathNode } from './path-safety';

export type PersistedAgentWorkspaceIdentity = ResolvedAgentWorkspaceIdentity<
  ProjectSlim,
  AgentConfigSlim
>;
export type PersistedAgentWorkspaceProjection = ResolvedAgentWorkspaceProjection<
  ProjectSlim,
  AgentConfigSlim
>;

export interface PersistedAgentWorkspaceRegistry {
  config: AdminAppConfig;
  projects: ProjectSlim[];
  identities: PersistedAgentWorkspaceIdentity[];
  agentProjections: PersistedAgentWorkspaceProjection[];
  diagnostics: AgentWorkspaceIdentityDiagnostic[];
  repaired: boolean;
  repairDeferred: boolean;
  createdAgentIds: string[];
  relinkedProjectIds: string[];
}

function projectBuildOptions(config: AdminAppConfig) {
  return {
    buildAgent: (project: ProjectSlim, requestedAgentId?: string) => buildAgentForProject(
      asProjectBuildSource(project),
      {
        agentId: requestedAgentId,
        defaultPermissionMode: config.defaultPermissionMode,
      },
    ) as AgentConfig as AgentConfigSlim,
  };
}

function registryFromPersistedSnapshot(
  config: AdminAppConfig,
  projects: ProjectSlim[],
  repairDeferred: boolean,
): PersistedAgentWorkspaceRegistry {
  const projection = resolveAgentWorkspaceProjections(projects, config.agents ?? []);
  const identities = projection.agentProjections
    .filter(item => item.association === 'project-linked' && item.project)
    .map(item => ({
      projectId: item.projectId!,
      agentId: item.agentId,
      workspacePath: item.workspacePath,
      project: item.project!,
      agent: item.agent,
    }));
  return {
    config,
    projects,
    identities,
    agentProjections: projection.agentProjections,
    diagnostics: projection.diagnostics,
    repaired: false,
    repairDeferred,
    createdAgentIds: [],
    relinkedProjectIds: [],
  };
}

function asProjectBuildSource(project: ProjectSlim): Project {
  const permissionMode = project.permissionMode;
  const normalizedPermissionMode: PermissionMode | null =
    permissionMode === 'auto' || permissionMode === 'plan' || permissionMode === 'fullAgency'
      ? permissionMode
      : null;
  return {
    ...(project as unknown as Project),
    providerId: typeof project.providerId === 'string' ? project.providerId : null,
    permissionMode: normalizedPermissionMode,
    model: typeof project.model === 'string' ? project.model : null,
  };
}

export class WorkspaceAgentRegistrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkspaceAgentRegistrationError';
  }
}

function validateWorkspaceForRegistration(rawPath: string, admitPinnedWorkspace?: (path: string) => void): string {
  const workspacePath = rawPath.trim();
  if (!workspacePath || !isAbsolute(workspacePath)) {
    throw new WorkspaceAgentRegistrationError(
      'WORKSPACE_PATH_NOT_ABSOLUTE',
      '--workspacePath must be an absolute path.',
    );
  }
  // A private Host root may be under /var/lib, which the external arbitrary-read
  // blacklist deliberately rejects. Only the strict scoped owner can supply a
  // kernel-pinned admission; public Desktop/CLI registration retains that blacklist.
  const safety = admitPinnedWorkspace
    ? (admitPinnedWorkspace(workspacePath), { ok: true as const, canonical: workspacePath })
    : validateExternalReadPathNode(workspacePath);
  if (!safety.ok) {
    throw new WorkspaceAgentRegistrationError(
      'WORKSPACE_PATH_UNSAFE',
      safety.reason,
    );
  }
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(safety.canonical);
  } catch {
    throw new WorkspaceAgentRegistrationError(
      'WORKSPACE_PATH_NOT_FOUND',
      `Workspace directory does not exist or is not accessible: ${workspacePath}`,
    );
  }
  if (!metadata.isDirectory()) {
    throw new WorkspaceAgentRegistrationError(
      'WORKSPACE_PATH_NOT_DIRECTORY',
      `Workspace path is not a directory: ${workspacePath}`,
    );
  }
  const normalized = resolve(safety.canonical);
  const identity = normalizeWorkspacePathIdentity(normalized);
  const rootIdentity = normalizeWorkspacePathIdentity(parse(normalized).root);
  const privateDataIdentity = normalizeWorkspacePathIdentity(
    resolve(homedir(), '.myagents'),
  );
  if (
    !identity ||
    identity === rootIdentity ||
    identity === privateDataIdentity ||
    identity.startsWith(`${privateDataIdentity}/`)
  ) {
    throw new WorkspaceAgentRegistrationError(
      'WORKSPACE_PATH_UNSAFE',
      'Filesystem roots and the MyAgents private data directory cannot be registered as Agent workspaces.',
    );
  }
  return normalized;
}

function buildAgentForPersistedProject(
  project: ProjectSlim,
  config: AdminAppConfig,
  requestedAgentId?: string,
): AgentConfigSlim {
  return buildAgentForProject(asProjectBuildSource(project), {
    agentId: requestedAgentId,
    defaultPermissionMode: config.defaultPermissionMode,
  }) as AgentConfig as AgentConfigSlim;
}

export interface RegisterWorkspaceAgentResult {
  created: boolean;
  agentId: string;
  projectId: string;
  name: string;
  workspacePath: string;
  enabled: boolean;
  archived: false;
}

/**
 * Register an existing directory as the one Project-backed Agent identity.
 * The outer intent lock serializes the two existing per-file authorities.
 * Project.agentId commits first, so a retry after an interrupted Agent write
 * reuses the same identity instead of minting a duplicate.
 */
interface RegistrationOptions { strictPersistence?: boolean; notify?: boolean; assertWorkspace?: (path: string) => void }
type ScopedWorkspaceRegistration = (path: string) => Promise<RegisterWorkspaceAgentResult>;

/** The callback and registration share the original composite lock, never a second registry lock. */
export async function withWorkspaceAgentRegistrationIntent<T>(
  fn: (register: ScopedWorkspaceRegistration) => Promise<T>,
  options: RegistrationOptions = {},
): Promise<T> {
  return withAgentConfigIntentLock(async () => {
    let active = true;
    const operations: Promise<RegisterWorkspaceAgentResult>[] = [];
    try {
      const result = await fn(path => {
        if (!active) throw new Error('REGISTRATION_INTENT_CLOSED');
        if (operations.length) throw new Error('REGISTRATION_INTENT_ALREADY_USED');
        const operation = registerWorkspaceAgentInIntent(path, options);
        void operation.catch(() => undefined);
        operations.push(operation);
        return operation;
      });
      active = false;
      await Promise.all(operations);
      return result;
    } finally { active = false; await Promise.allSettled(operations); }
  });
}

export async function registerWorkspaceAgent(requestedPath: string): Promise<RegisterWorkspaceAgentResult> {
  const workspacePath = validateWorkspaceForRegistration(requestedPath);
  return withWorkspaceAgentRegistrationIntent(register => register(workspacePath));
}

async function registerWorkspaceAgentInIntent(
  requestedPath: string, options: RegistrationOptions,
): Promise<RegisterWorkspaceAgentResult> {
  const workspacePath = validateWorkspaceForRegistration(requestedPath, options.strictPersistence ? options.assertWorkspace : undefined);
  const persistence = { strict: options.strictPersistence };
  if (options.strictPersistence && workspacePath !== requestedPath) throw new Error('REGISTRATION_PATH_CHANGED');
  options.assertWorkspace?.(workspacePath);

    const initialProjects = loadProjects(persistence);
    const initialConfig = loadConfig(persistence);
    const matches = initialProjects.filter((project) =>
      workspacePathsEqual(project.path, workspacePath),
    );
    if (matches.length > 1) {
      throw new WorkspaceAgentRegistrationError(
        'DUPLICATE_PROJECT_WORKSPACE',
        'Multiple Projects resolve to the requested workspace; repair the conflict in MyAgents before retrying.',
        { projectIds: matches.map((project) => project.id) },
      );
    }

    const existing = matches[0];
    if (existing) {
      if (
        existing.internal === true ||
        existing.hidden === true ||
        existing.workspaceType === 'system-preset'
      ) {
        throw new WorkspaceAgentRegistrationError(
          'WORKSPACE_NOT_EXTERNALLY_REGISTERABLE',
          'This workspace is hidden, internal, or system-owned and cannot be changed by the external CLI.',
          { projectId: existing.id },
        );
      }
      if (
        typeof existing.archivedAt === 'string' &&
        existing.archivedAt.length > 0
      ) {
        throw new WorkspaceAgentRegistrationError(
          'WORKSPACE_ARCHIVED',
          'This workspace is archived. Unarchive it in MyAgents before retrying.',
          { projectId: existing.id, agentId: existing.agentId },
        );
      }
    }

    const initialProjection = resolveAgentWorkspaceProjections(
      initialProjects,
      initialConfig.agents ?? [],
    );
    const relevantDiagnostic = initialProjection.diagnostics.find(
      (diagnostic) =>
        (!!existing && diagnostic.projectIds.includes(existing.id)) ||
        (!!existing?.agentId && diagnostic.agentIds.includes(existing.agentId)),
    );
    if (relevantDiagnostic) {
      throw new WorkspaceAgentRegistrationError(
        relevantDiagnostic.code,
        relevantDiagnostic.message,
        {
          projectIds: relevantDiagnostic.projectIds,
          agentIds: relevantDiagnostic.agentIds,
        },
      );
    }
    const priorIdentity = existing
      ? initialProjection.agentProjections.find(
          (projection) =>
            projection.association === 'project-linked' &&
            projection.projectId === existing.id,
        )
      : undefined;

    const legacyMatches = initialProjection.agentProjections.filter(
      (projection) =>
        projection.association !== 'project-linked' &&
        workspacePathsEqual(projection.workspacePath, workspacePath),
    );
    if (legacyMatches.length > 1) {
      throw new WorkspaceAgentRegistrationError(
        'WORKSPACE_REGISTRATION_CONFLICT',
        'Multiple legacy Agents resolve to the requested workspace; repair the conflict before retrying.',
        { agentIds: legacyMatches.map((projection) => projection.agentId) },
      );
    }
    const legacyIdentity = legacyMatches[0];

    const projectId = existing?.id ?? randomUUID();
    const stableAgentId =
      existing?.agentId ??
      priorIdentity?.agentId ??
      legacyIdentity?.agentId ??
      randomUUID();
    const projectName =
      existing?.name || basename(workspacePath) || 'Workspace';
    let projectAfterCommit: ProjectSlim | undefined;

    const projects = await atomicModifyProjects((currentProjects) => {
      options.assertWorkspace?.(workspacePath);
      if (options.strictPersistence) loadConfig(persistence);
      const currentMatches = currentProjects.filter((project) =>
        workspacePathsEqual(project.path, workspacePath),
      );
      if (currentMatches.length > 1) {
        throw new WorkspaceAgentRegistrationError(
          'DUPLICATE_PROJECT_WORKSPACE',
          'Multiple Projects resolve to the requested workspace.',
        );
      }
      if (currentMatches.length === 0) {
        const project: ProjectSlim = {
          id: projectId,
          agentId: stableAgentId,
          name: projectName,
          path: workspacePath,
          lastOpened: new Date().toISOString(),
        };
        projectAfterCommit = project;
        return [...currentProjects, project];
      }
      const current = currentMatches[0];
      if (current.id !== projectId) {
        throw new WorkspaceAgentRegistrationError(
          'WORKSPACE_REGISTRATION_CONFLICT',
          'The workspace registration changed concurrently; retry the command.',
        );
      }
      const currentConfig = loadConfig(persistence);
      const reconciled = reconcileAgentWorkspaceIdentities(
        currentProjects,
        currentConfig.agents ?? [],
        {
          projectIds: options.strictPersistence ? new Set([projectId]) : undefined,
          buildAgent: (project, requestedAgentId) =>
            buildAgentForPersistedProject(
              project,
              currentConfig,
              requestedAgentId,
            ),
        },
      );
      projectAfterCommit = reconciled.projects.find(
        (project) => project.id === projectId,
      );
      return reconciled.projects;
    }, persistence);

    projectAfterCommit ??= projects.find((project) => project.id === projectId);
    if (!projectAfterCommit?.agentId) {
      throw new WorkspaceAgentRegistrationError(
        'AGENT_PROJECT_CLAIM_FAILED',
        'The Project identity could not be committed.',
        { projectId },
      );
    }

    let configResult:
      | ReturnType<
          typeof reconcileAgentWorkspaceIdentities<ProjectSlim, AgentConfigSlim>
        >
      | undefined;
    let config: AdminAppConfig;
    try {
      config = await atomicModifyConfig((current) => {
        options.assertWorkspace?.(workspacePath);
        if (options.strictPersistence) loadProjects(persistence);
        configResult = reconcileAgentWorkspaceIdentities(
          projects,
          current.agents ?? [],
          {
            projectIds: options.strictPersistence ? new Set([projectId]) : undefined,
            buildAgent: (project, requestedAgentId) =>
              buildAgentForPersistedProject(project, current, requestedAgentId),
          },
        );
        return configResult.changed
          ? { ...current, agents: configResult.agents }
          : current;
      }, persistence);
    } catch (error) {
      throw new WorkspaceAgentRegistrationError(
        'AGENT_MATERIALIZATION_DEFERRED',
        'The Project claim was saved, but Agent materialization was not confirmed. Retry the same command; it will reuse the same identity.',
        {
          projectId,
          agentId: projectAfterCommit.agentId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const finalAgentId = projectAfterCommit.agentId;
    const agent = (config.agents ?? []).find(
      (candidate) => candidate.id === finalAgentId,
    );
    if (!agent || !configResult) {
      throw new WorkspaceAgentRegistrationError(
        'AGENT_MATERIALIZATION_DEFERRED',
        'Agent materialization was not confirmed. Retry the same command.',
        { projectId, agentId: finalAgentId },
      );
    }
    options.assertWorkspace?.(workspacePath);
    if (options.notify !== false) await broadcastAppConfigChanged({
      section: 'agent-identity',
      action: priorIdentity ? 'register-idempotent' : 'register',
      projectId,
      agentId: finalAgentId,
    });
    return {
      created: options.strictPersistence ? !priorIdentity && !legacyIdentity : !priorIdentity,
      agentId: finalAgentId,
      projectId,
      name: agent.name,
      workspacePath: projectAfterCommit.path,
      enabled: agent.enabled === true,
      archived: false,
    };
}

/** Bounded explicit repair. While claims remain ambiguous, fresh starts fail closed.
 * Stop drains the same channel locks as startup (including not-yet-published instances).
 * The intent + Project locks keep that ambiguity in place until stop has completed.
 */
export async function resolvePersistedAgentWorkspaceConflict(
  choice: AgentWorkspaceConflictChoice,
  stopRuntime: () => Promise<void>,
): Promise<void> {
  return withAgentConfigIntentLock(async () => {
    const projectIds = new Set(choice.expectedClaims.map(item => item.id));
    const projects = await atomicModifyProjects(async currentProjects => {
      const initial = loadConfig();
      // Validate before stopping anything; validate again against latest config after stop.
      resolveAgentWorkspaceClaimConflict(currentProjects, initial.agents ?? [], choice, projectBuildOptions(initial));
      await stopRuntime();
      const latest = loadConfig();
      return resolveAgentWorkspaceClaimConflict(currentProjects, latest.agents ?? [], choice, projectBuildOptions(latest)).projects;
    });
    try {
      const config = await atomicModifyConfig(current => {
        const result = reconcileAgentWorkspaceIdentities(projects, current.agents ?? [], {
          ...projectBuildOptions(current), projectIds,
        });
        return result.createdAgentIds.length ? { ...current, agents: result.agents } : current;
      });
      const resolved = resolveAgentWorkspaceProjections(loadProjects(), config.agents ?? []);
      if ([...projectIds].some(id => !resolved.agentProjections.some(item => item.projectId === id && item.association === 'project-linked'))) {
        throw new Error('Not every affected workspace has a unique Agent.');
      }
    } catch (error) {
      // Project-first birth is already durable; never claim success or roll back
      // a valid user choice. Ordinary identity reconciliation can finish materialization.
      await broadcastAppConfigChanged({ section: 'agent-identity', action: 'repair-deferred' });
      throw new WorkspaceAgentRegistrationError('AGENT_MATERIALIZATION_DEFERRED',
        'Workspace ownership was saved, but independent configurations are not confirmed. Refresh or restart MyAgents to finish recovery.',
        { cause: error instanceof Error ? error.message : String(error) });
    }
    await broadcastAppConfigChanged({ section: 'agent-identity', action: 'resolve-conflict' });
  });
}

/**
 * Resolve the disk authorities to the required Agent↔Workspace domain.
 * Repairs are serialized by the existing cross-process intent lock. Project
 * links commit before newly-created pathless Agents so a retry can rebuild the
 * same stale ID after an interruption.
 */
export async function resolvePersistedAgentWorkspaceRegistry(): Promise<PersistedAgentWorkspaceRegistry> {
  return withAgentConfigIntentLock(async () => {
    let projectResult: ReturnType<
      typeof reconcileAgentWorkspaceIdentities<ProjectSlim, AgentConfigSlim>
    > | undefined;
    let projects: ProjectSlim[];
    try {
      projects = await atomicModifyProjects(currentProjects => {
      const currentConfig = loadConfig();
      projectResult = reconcileAgentWorkspaceIdentities(
        currentProjects,
        currentConfig.agents ?? [],
        projectBuildOptions(currentConfig),
      );
      return projectResult.projects;
      });
    } catch (error) {
      const fallbackConfig = loadConfig();
      const fallback = reconcileAgentWorkspaceIdentities(
        loadProjects(),
        fallbackConfig.agents ?? [],
        projectBuildOptions(fallbackConfig),
      );
      if (fallback.createdAgentIds.length > 0) throw error;
      console.warn('[agent-identity] code=IDENTITY_REPAIR_DEFERRED operation=project-link');
      return {
        ...registryFromPersistedSnapshot(fallbackConfig, fallback.projects, true),
        identities: fallback.identities,
        agentProjections: fallback.agentProjections,
        diagnostics: fallback.diagnostics,
        relinkedProjectIds: fallback.relinkedProjectIds,
      };
    }

    if (!projectResult) {
      throw new Error('Agent identity reconciliation did not produce a registry.');
    }
    if (projectResult.createdAgentIds.length === 0) {
      const config = loadConfig();
      return {
        ...registryFromPersistedSnapshot(config, projects, false),
        identities: projectResult.identities,
        agentProjections: projectResult.agentProjections,
        diagnostics: projectResult.diagnostics,
        repaired: projectResult.changed,
        relinkedProjectIds: projectResult.relinkedProjectIds,
      };
    }

    let configResult: ReturnType<
      typeof reconcileAgentWorkspaceIdentities<ProjectSlim, AgentConfigSlim>
    > | undefined;
    let config: AdminAppConfig;
    try {
      config = await atomicModifyConfig(current => {
        configResult = reconcileAgentWorkspaceIdentities(
          projects,
          current.agents ?? [],
          projectBuildOptions(current),
        );
        return configResult.changed ? { ...current, agents: configResult.agents } : current;
      });
    } catch {
      console.warn('[agent-identity] code=AGENT_MATERIALIZATION_DEFERRED operation=agent-birth');
      return registryFromPersistedSnapshot(loadConfig(), loadProjects(), true);
    }
    if (!projectResult || !configResult) {
      throw new Error('Agent identity reconciliation did not produce a registry.');
    }
    const registry: PersistedAgentWorkspaceRegistry = {
      config,
      projects: configResult.projects,
      identities: configResult.identities,
      agentProjections: configResult.agentProjections,
      diagnostics: configResult.diagnostics,
      repaired: projectResult.changed || configResult.changed,
      repairDeferred: false,
      createdAgentIds: configResult.createdAgentIds,
      relinkedProjectIds: projectResult.relinkedProjectIds,
    };
    if (registry.repaired) {
      await broadcastAppConfigChanged({
        section: 'agent-identity',
        action: 'repair',
        createdAgentIds: registry.createdAgentIds,
        relinkedProjectIds: registry.relinkedProjectIds,
      });
    }
    return registry;
  });
}

export function agentWorkspaceIdentityFailure(error: unknown): {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
} {
  if (error instanceof WorkspaceAgentRegistrationError) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      details: error.details,
    };
  }
  if (error instanceof AgentWorkspaceIdentityError) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      details: error.details,
    };
  }
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
