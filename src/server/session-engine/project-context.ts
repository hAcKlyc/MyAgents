import { getSessionData, getSessionsByAgentDir, isHistoryVisibleSession } from '../SessionStore';
import { loadProjects } from '../utils/admin-config';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { normalizeSessionOrigin } from '../../shared/session-origin';
import { projectSessionContextSources, PROJECT_CONTEXT_SCAN_SESSIONS, renderProjectContext } from '../../shared/projectContext';
import type { ProjectContextSnapshot } from '../../shared/projectContext';
import type { DesktopMessageRequest } from './types';
import { escapeSystemReminderText } from '../../shared/systemReminder';
import type { SessionMetadata } from '../types/session';

function eligibleSource(session: SessionMetadata): boolean {
  const origin = normalizeSessionOrigin(session.origin);
  return !session.archived && isHistoryVisibleSession(session)
    && (!session.source || session.source === 'desktop')
    && (!origin || origin.kind === 'desktop' || origin.kind === 'unknown');
}

/** Source transcript is the only durable truth. No second writer, background
 * model request or shared cache can overwrite/race a different Session. Read at
 * send time, after prewarm; subsequent turns already have their own context. */
export async function readProjectContext(request: Pick<DesktopMessageRequest, 'sessionId' | 'workspacePath' | 'scenario'>): Promise<ProjectContextSnapshot | undefined> {
  if (request.scenario.surface === 'floating-ball') return undefined;
  const projects = loadProjects({ strict: true }).filter(project => workspacePathsEqual(project.path, request.workspacePath));
  if (projects.length !== 1) return undefined;
  const project = projects[0];
  if (project.projectContextEnabled === false || project.hidden || project.archivedAt || project.internal) return undefined;
  const current = await getSessionData(request.sessionId);
  const targetOrigin = normalizeSessionOrigin(current?.origin);
  if (current && (current.transcriptRecovery || current.hostBotBinding
    || (current.source && current.source !== 'desktop')
    || (targetOrigin && targetOrigin.kind !== 'desktop' && targetOrigin.kind !== 'unknown')
    || !workspacePathsEqual(current.agentDir, request.workspacePath)
    || current.messages.some(message => message.role === 'user'))) return undefined;
  const candidates = getSessionsByAgentDir(request.workspacePath).filter(session =>
    session.id !== request.sessionId && eligibleSource(session));
  const snapshot: ProjectContextSnapshot = { projectId: project.id, sources: [],
    totalSessions: candidates.length, scannedSessions: 0, unavailableSessions: 0 };
  for (const metadata of candidates.slice(0, PROJECT_CONTEXT_SCAN_SESSIONS)) {
    snapshot.scannedSessions += 1;
    try {
      const data = await getSessionData(metadata.id);
      if (!data || !eligibleSource(data) || !workspacePathsEqual(data.agentDir, request.workspacePath)) continue;
      if (data.transcriptRecovery || (data.transcriptSaveStatus && data.transcriptSaveStatus.state !== 'healthy')) {
        snapshot.unavailableSessions += 1; continue;
      }
      snapshot.sources.push(...projectSessionContextSources(metadata.id, data.messages));
    } catch { snapshot.unavailableSessions += 1; }
  }
  // Return only exactly the sources that fit the rendered budget, not an
  // unbounded annotation hidden outside the prompt's byte limit.
  const rendered = renderProjectContext(snapshot);
  if (!rendered) return undefined;
  snapshot.sources = snapshot.sources.filter(source => rendered.includes(
    `<source>${escapeSystemReminderText(JSON.stringify(source))}</source>`));
  return snapshot;
}

export async function optionalProjectContext(request: Pick<DesktopMessageRequest, 'sessionId' | 'workspacePath' | 'scenario'>): Promise<ProjectContextSnapshot | undefined> {
  try { return await readProjectContext(request); }
  catch (error) {
    console.warn('[project-context] Background unavailable; continuing original query:', error instanceof Error ? error.name : 'unknown');
    return undefined;
  }
}
