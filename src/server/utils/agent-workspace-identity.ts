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
import { isWindowsReservedName } from '../../shared/utils';
import type { AgentConfig } from '../../shared/types/agent';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, resolve } from 'node:path';
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

/**
 * Strip Windows extended-length verbatim prefixes (`\\?\` or `//?/`) before
 * lexical identity comparison or persistence so Windows `canonicalize()` /
 * verbatim CLI inputs cannot diverge from standard `C:\...` identities or
 * bypass `~/.myagents` private-directory containment.
 */
export function stripWindowsVerbatimPrefix(rawPath: string): string {
  if (rawPath.startsWith('\\\\?\\UNC\\') || rawPath.startsWith('//?/UNC/')) {
    return `\\\\${rawPath.slice(8)}`;
  }
  if (rawPath.startsWith('\\\\?\\') || rawPath.startsWith('//?/')) {
    return rawPath.slice(4);
  }
  return rawPath;
}

function normalizeContainedPathIdentity(rawPath: string): string {
  return normalizeWorkspacePathIdentity(stripWindowsVerbatimPrefix(rawPath));
}

function resolveCanonicalIfExists(targetPath: string): string {
  try {
    return stripWindowsVerbatimPrefix(realpathSync(targetPath));
  } catch {
    return stripWindowsVerbatimPrefix(resolve(targetPath));
  }
}

export function getManagedProjectsRoot(): string {
  return resolve(resolveCanonicalIfExists(homedir()), '.myagents', 'projects');
}

function isDirectChildOfManagedProjects(normalizedIdentity: string): boolean {
  const managedProjectsIdentity = normalizeContainedPathIdentity(
    resolveCanonicalIfExists(getManagedProjectsRoot()),
  );
  if (!managedProjectsIdentity) return false;
  const prefix = `${managedProjectsIdentity}/`;
  if (!normalizedIdentity.startsWith(prefix)) return false;
  const remainder = normalizedIdentity.slice(prefix.length);
  return remainder.length > 0 && !remainder.includes('/');
}

/**
 * Validate and sanitize a workspace display name into a safe single directory
 * component under `~/.myagents/projects/`. Rejects path separators, `..`, NUL
 * bytes, and names that become empty after sanitization (fail closed).
 */
export function sanitizeManagedWorkspaceDirName(rawName: string): string {
  const trimmed = rawName.trim();
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    trimmed === '.'
  ) {
    throw new WorkspaceAgentRegistrationError(
      'INVALID_WORKSPACE_NAME',
      `Invalid workspace name '${rawName}': must be a non-empty name without path separators or '..'.`,
    );
  }
  let sanitized = '';
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) ?? 0;
    if (/^[A-Za-z0-9_-]$/.test(ch)) {
      sanitized += ch;
    } else if (ch === ' ' || ch === '@') {
      sanitized += '-';
    } else if (code > 0x2e7f) {
      sanitized += ch;
    }
  }
  const collapsed = sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').replace(/^\.+|\.+$/g, '');
  if (
    !collapsed ||
    collapsed === '.' ||
    collapsed === '..' ||
    isWindowsReservedName(trimmed) ||
    isWindowsReservedName(collapsed)
  ) {
    throw new WorkspaceAgentRegistrationError(
      'INVALID_WORKSPACE_NAME',
      `Workspace name '${rawName}' produces an invalid or reserved directory name after sanitization.`,
    );
  }
  return collapsed;
}

/**
 * Resolve the target path under `~/.myagents/projects/<sanitized-name>` for a
 * managed workspace. The registration intent owner checks existing claims before
 * the directory materializer runs.
 */
export function resolveManagedWorkspaceCreationPath(rawName: string): {
  displayName: string;
  sanitizedDirName: string;
  workspacePath: string;
  projectsRoot: string;
} {
  const displayName = rawName.trim();
  const sanitizedDirName = sanitizeManagedWorkspaceDirName(displayName);
  const projectsRoot = getManagedProjectsRoot();
  const workspacePath = resolve(projectsRoot, sanitizedDirName);
  if (
    normalizeWorkspacePathIdentity(dirname(workspacePath)) !==
    normalizeWorkspacePathIdentity(projectsRoot)
  ) {
    throw new WorkspaceAgentRegistrationError(
      'WORKSPACE_PATH_UNSAFE',
      'Managed workspace must resolve to a direct child of ~/.myagents/projects/.',
    );
  }
  return { displayName, sanitizedDirName, workspacePath, projectsRoot };
}

function validateWorkspaceForRegistration(rawPath: string): string {
  const workspacePath = rawPath.trim();
  if (!workspacePath || !isAbsolute(workspacePath)) {
    throw new WorkspaceAgentRegistrationError(
      'WORKSPACE_PATH_NOT_ABSOLUTE',
      '--workspacePath must be an absolute path.',
    );
  }
  const safety = validateExternalReadPathNode(workspacePath);
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
  const normalized = stripWindowsVerbatimPrefix(resolve(safety.canonical));
  const identity = normalizeContainedPathIdentity(normalized);
  const rootIdentity = normalizeContainedPathIdentity(parse(normalized).root);
  const privateDataIdentity = normalizeContainedPathIdentity(
    resolveCanonicalIfExists(resolve(resolveCanonicalIfExists(homedir()), '.myagents')),
  );
  const isInsidePrivateData =
    identity === privateDataIdentity ||
    identity.startsWith(`${privateDataIdentity}/`);
  if (
    !identity ||
    identity === rootIdentity ||
    (isInsidePrivateData && !isDirectChildOfManagedProjects(identity))
  ) {
    throw new WorkspaceAgentRegistrationError(
      'WORKSPACE_PATH_UNSAFE',
      'Filesystem roots and MyAgents private data directories (outside direct children of ~/.myagents/projects/) cannot be registered as Agent workspaces.',
    );
  }
  return normalized;
}

function buildAgentForPersistedProject(
  project: ProjectSlim,
  config: AdminAppConfig,
  requestedAgentId?: string,
  options: { suppressTemplateDefaults?: boolean } = {},
): AgentConfigSlim {
  return buildAgentForProject(asProjectBuildSource(project), {
    agentId: requestedAgentId,
    defaultPermissionMode: config.defaultPermissionMode,
    ...(options.suppressTemplateDefaults ? { agentDefaults: {} } : {}),
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
  templateId?: string;
  templateSource?: 'builtin' | 'user';
}

export interface RegisterWorkspaceAgentOptions {
  /** Optional explicit display name for a newly registered workspace. */
  name?: string;
  /** Optional template provenance when materialized under ~/.myagents/projects/. */
  templateId?: string;
  templateSource?: 'builtin' | 'user';
  /** Fail closed instead of returning idempotently if the workspace is already registered. */
  rejectIfAlreadyRegistered?: boolean;
  /**
   * Optional directory materializer invoked inside `withAgentConfigIntentLock`
   * ONLY for managed `~/.myagents/projects/<direct-child>` creation. If any
   * step before the Project claim commits fails, the directory is removed.
   */
  createManagedDirectory?: () => Promise<string> | string;
  /**
   * Optional atomic initial Agent/Project patch applied ONLY to a newly created
   * Agent inside the same `withAgentConfigIntentLock` transaction. `enabled`
   * remains fixed at `false`.
   */
  applyInitialAgentPatch?: (
    agent: AgentConfigSlim,
    config: AdminAppConfig,
  ) => {
    ok: true;
    agent: AgentConfigSlim;
    projectPatch?: Partial<ProjectSlim>;
  } | {
    ok: false;
    code: string;
    message: string;
  };
}

/**
 * Register an existing directory (or newly materialized managed directory under
 * `~/.myagents/projects/<name>`) as the one Project-backed Agent identity.
 * The outer intent lock serializes the two existing per-file authorities.
 * Project.agentId commits first, so a retry after an interrupted Agent write
 * reuses the same identity instead of minting a duplicate.
 */
export async function registerWorkspaceAgent(
  requestedPath: string,
  options: RegisterWorkspaceAgentOptions = {},
): Promise<RegisterWorkspaceAgentResult> {
  if (!options.createManagedDirectory) {
    validateWorkspaceForRegistration(requestedPath);
  }
  return withAgentConfigIntentLock(async () => {
    let createdManagedDirPath: string | null = null;
    let workspacePath: string;
    try {
      if (options.createManagedDirectory) {
        const preliminaryProjects = loadProjects();
        const preliminaryConflict = preliminaryProjects.find((project) =>
          workspacePathsEqual(project.path, requestedPath),
        );
        if (preliminaryConflict) {
          const claimedAgentId = preliminaryConflict.agentId;
          const awaitingAgent = claimedAgentId &&
            preliminaryConflict.name === options.name &&
            preliminaryConflict.templateId === options.templateId &&
            preliminaryConflict.templateSource === options.templateSource &&
            lstatSync(requestedPath, { throwIfNoEntry: false })?.isDirectory() &&
            !(loadConfig().agents ?? []).some((agent) => agent.id === claimedAgentId);
          if (!awaitingAgent) {
            throw new WorkspaceAgentRegistrationError(
              'WORKSPACE_ALREADY_EXISTS',
              `A workspace is already registered at ${requestedPath}. Choose a different --name or pass --workspacePath "${requestedPath}" to reuse it.`,
              { workspacePath: requestedPath, projectId: preliminaryConflict.id, agentId: claimedAgentId },
            );
          }
          workspacePath = validateWorkspaceForRegistration(requestedPath);
        } else {
          const materializedPath = await options.createManagedDirectory();
          createdManagedDirPath = materializedPath;
          workspacePath = validateWorkspaceForRegistration(materializedPath);
        }
      } else {
        workspacePath = validateWorkspaceForRegistration(requestedPath);
      }

      const initialProjects = loadProjects();
      const initialConfig = loadConfig();
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

      if (priorIdentity && options.rejectIfAlreadyRegistered) {
        throw new WorkspaceAgentRegistrationError(
          'WORKSPACE_ALREADY_REGISTERED',
          `Workspace '${workspacePath}' is already registered as Agent '${priorIdentity.agentId}'. Use 'myagents agent set ${priorIdentity.agentId} ...' to change its name or settings.`,
          { agentId: priorIdentity.agentId, projectId: priorIdentity.projectId ?? existing?.id },
        );
      }

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
      if (legacyIdentity && options.rejectIfAlreadyRegistered) {
        throw new WorkspaceAgentRegistrationError(
          'WORKSPACE_ALREADY_REGISTERED',
          `Workspace '${workspacePath}' is already registered as Agent '${legacyIdentity.agentId}'. Use 'myagents agent set ${legacyIdentity.agentId} ...' to change its name or settings.`,
          { agentId: legacyIdentity.agentId },
        );
      }

      const projectId = existing?.id ?? randomUUID();
      const stableAgentId =
        existing?.agentId ??
        priorIdentity?.agentId ??
        legacyIdentity?.agentId ??
        randomUUID();
      const explicitName = options.name?.trim();
      const projectName =
        existing?.name || explicitName || basename(workspacePath) || 'Workspace';

      // Pre-validate initial patch against the draft Agent before committing any
      // Project/Config files so invalid options leave zero disk artifacts.
      let initialPatchResult: {
        agent: AgentConfigSlim;
        projectPatch?: Partial<ProjectSlim>;
      } | undefined;
      if (!priorIdentity && options.applyInitialAgentPatch) {
        const draftProject: ProjectSlim = {
          id: projectId,
          agentId: stableAgentId,
          name: projectName,
          path: workspacePath,
          lastOpened: new Date().toISOString(),
          ...(options.templateId ? { templateId: options.templateId, templateSource: options.templateSource } : {}),
        };
        const draftAgent = buildAgentForPersistedProject(
          draftProject,
          initialConfig,
          stableAgentId,
          { suppressTemplateDefaults: true },
        );
        const applied = options.applyInitialAgentPatch(draftAgent, initialConfig);
        if (!applied.ok) {
          throw new WorkspaceAgentRegistrationError(applied.code, applied.message);
        }
        initialPatchResult = {
          agent: { ...applied.agent, id: stableAgentId, name: projectName, enabled: false },
          projectPatch: applied.projectPatch,
        };
      }

      let projectAfterCommit: ProjectSlim | undefined;

      const projects = await atomicModifyProjects((currentProjects) => {
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
            ...(options.templateId ? { templateId: options.templateId, templateSource: options.templateSource } : {}),
            ...(initialPatchResult?.projectPatch ?? {}),
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
        const currentConfig = loadConfig();
        const reconciled = reconcileAgentWorkspaceIdentities(
          currentProjects,
          currentConfig.agents ?? [],
          {
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
      });

      projectAfterCommit ??= projects.find((project) => project.id === projectId);
      if (!projectAfterCommit?.agentId) {
        throw new WorkspaceAgentRegistrationError(
          'AGENT_PROJECT_CLAIM_FAILED',
          'The Project identity could not be committed.',
          { projectId },
        );
      }
      // Once projects.json has durably committed the workspace claim, the
      // managed directory belongs to that Project and MUST remain on disk so
      // an interrupted Agent write (`AGENT_MATERIALIZATION_DEFERRED`) can
      // retry and reuse the saved Project claim cleanly.
      createdManagedDirPath = null;

      let configResult:
        | ReturnType<
            typeof reconcileAgentWorkspaceIdentities<ProjectSlim, AgentConfigSlim>
          >
        | undefined;
      let config: AdminAppConfig;
      try {
        config = await atomicModifyConfig((current) => {
          configResult = reconcileAgentWorkspaceIdentities(
            projects,
            current.agents ?? [],
            {
              buildAgent: (project, requestedAgentId) => {
                const isTargetProject = project.id === projectId;
                const built = buildAgentForPersistedProject(
                  project,
                  current,
                  requestedAgentId,
                  { suppressTemplateDefaults: isTargetProject },
                );
                if (isTargetProject && built.id === stableAgentId) {
                  // CLI-created / registered Agents always start with enabled=false
                  // and never auto-enable template proactive tasks (Heartbeat/Memory).
                  return {
                    ...built,
                    ...(initialPatchResult ? initialPatchResult.agent : {}),
                    id: stableAgentId,
                    name: projectName,
                    enabled: false,
                  };
                }
                return built;
              },
            },
          );
          let agents = configResult.agents;
          let changed = configResult.changed;
          if (initialPatchResult) {
            const idx = agents.findIndex((candidate) => candidate.id === stableAgentId);
            if (idx >= 0) {
              agents = [...agents];
              agents[idx] = {
                ...agents[idx],
                ...initialPatchResult.agent,
                id: stableAgentId,
                name: projectName,
                enabled: false,
              };
              changed = true;
            }
          }
          return changed ? { ...current, agents } : current;
        });
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
      await broadcastAppConfigChanged({
        section: 'agent-identity',
        action: priorIdentity ? 'register-idempotent' : 'register',
        projectId,
        agentId: finalAgentId,
      });
      return {
        created: !priorIdentity,
        agentId: finalAgentId,
        projectId,
        name: agent.name,
        workspacePath: projectAfterCommit.path,
        enabled: agent.enabled === true,
        archived: false,
        ...(projectAfterCommit.templateId ? { templateId: String(projectAfterCommit.templateId) } : {}),
        ...(projectAfterCommit.templateSource === 'builtin' || projectAfterCommit.templateSource === 'user'
          ? { templateSource: projectAfterCommit.templateSource }
          : {}),
      };
    } catch (error) {
      if (createdManagedDirPath) {
        const normalizedCreated = normalizeContainedPathIdentity(resolve(createdManagedDirPath));
        if (isDirectChildOfManagedProjects(normalizedCreated)) {
          try {
            rmSync(createdManagedDirPath, { recursive: true, force: true });
          } catch {
            // Best-effort rollback of newly created managed directory
          }
        }
      }
      throw error;
    }
  });
}

/**
 * Create a brand-new empty directory strictly as a direct child of
 * `~/.myagents/projects/` without `{ recursive: true }` on the leaf so
 * concurrent creation races fail closed with `WORKSPACE_ALREADY_EXISTS`.
 */
export function createEmptyManagedWorkspaceDir(
  projectsRoot: string,
  targetPath: string,
): string {
  mkdirSync(projectsRoot, { recursive: true });
  try {
    mkdirSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new WorkspaceAgentRegistrationError(
        'WORKSPACE_ALREADY_EXISTS',
        `Managed workspace directory already exists: ${targetPath}. Choose a different --name or pass --workspacePath "${targetPath}" to register/reuse it.`,
        { workspacePath: targetPath },
      );
    }
    throw error;
  }
  return targetPath;
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
