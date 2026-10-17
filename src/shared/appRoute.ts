import { APP_URL_SCHEME } from './appProfile';
export interface SpaceHomeAppRoute {
  version: 1;
  name: 'space.home';
  params: Record<string, never>;
}

export interface SpaceIssuesAppRoute {
  version: 1;
  name: 'space.issues';
  params: { spaceId: string };
}

export interface SpaceToolsAppRoute {
  version: 1;
  name: 'space.tools';
  params: { spaceId: string };
}

export interface SpaceIssueAppRoute {
  version: 1;
  name: 'space.issue';
  params: {
    spaceId: string;
    issueId: string;
  };
}

export interface TaskCommentAppRoute {
  version: 1;
  name: 'task.comment';
  params: {
    taskId: string;
    commentId: string;
  };
}

export type AppRoute = SpaceHomeAppRoute | SpaceIssuesAppRoute | SpaceToolsAppRoute | SpaceIssueAppRoute | TaskCommentAppRoute;

export interface PendingAppRoute {
  generation: number;
  route: AppRoute;
}

const APP_ROUTE_ID = /^[A-Za-z0-9_-]{1,200}$/;

export function isAppRouteId(value: string): boolean {
  return APP_ROUTE_ID.test(value);
}

export function createSpaceHomeAppRoute(): SpaceHomeAppRoute {
  return { version: 1, name: 'space.home', params: {} };
}

export function createSpaceIssuesAppRoute(spaceId: string): SpaceIssuesAppRoute {
  if (!isAppRouteId(spaceId)) throw new Error('App route contains an invalid identifier');
  return { version: 1, name: 'space.issues', params: { spaceId } };
}

export function createSpaceToolsAppRoute(spaceId: string): SpaceToolsAppRoute {
  if (!isAppRouteId(spaceId)) throw new Error('App route contains an invalid identifier');
  return { version: 1, name: 'space.tools', params: { spaceId } };
}

export function createSpaceIssueAppRoute(spaceId: string, issueId: string): SpaceIssueAppRoute {
  if (!isAppRouteId(spaceId) || !isAppRouteId(issueId)) {
    throw new Error('App route contains an invalid identifier');
  }
  return {
    version: 1,
    name: 'space.issue',
    params: { spaceId, issueId },
  };
}

export function createTaskCommentAppRoute(taskId: string, commentId: string): TaskCommentAppRoute {
  if (!isAppRouteId(taskId) || !isAppRouteId(commentId)) {
    throw new Error('App route contains an invalid identifier');
  }
  return {
    version: 1,
    name: 'task.comment',
    params: { taskId, commentId },
  };
}

export function serializeAppRoute(route: AppRoute): string {
  if (route.version !== 1) {
    throw new Error('Unsupported app route');
  }
  if (route.name === 'space.home') return `${APP_URL_SCHEME}://open/v1/spaces`;
  if (route.name === 'space.tools' || route.name === 'space.issues') {
    if (!isAppRouteId(route.params.spaceId)) throw new Error('Unsupported app route');
    return `${APP_URL_SCHEME}://open/v1/spaces/${encodeURIComponent(route.params.spaceId)}/${route.name === 'space.tools' ? 'tools' : 'issues'}`;
  }
  if (route.name === 'space.issue') {
    if (!isAppRouteId(route.params.spaceId) || !isAppRouteId(route.params.issueId)) {
      throw new Error('Unsupported app route');
    }
    return `${APP_URL_SCHEME}://open/v1/spaces/${encodeURIComponent(route.params.spaceId)}/issues/${encodeURIComponent(route.params.issueId)}`;
  }
  if (route.name !== 'task.comment' || !isAppRouteId(route.params.taskId) || !isAppRouteId(route.params.commentId)) {
    throw new Error('Unsupported app route');
  }
  return `${APP_URL_SCHEME}://open/v1/tasks/${encodeURIComponent(route.params.taskId)}/comments/${encodeURIComponent(route.params.commentId)}`;
}

export function parseAppRouteUrl(raw: string): AppRoute | null {
  const value = raw.trim();
  if (!value || value.includes('?') || value.includes('#') || value.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${APP_URL_SCHEME}:`
    || url.hostname !== 'open'
    || url.port
    || url.username
    || url.password
  ) {
    return null;
  }
  // URL parsers normalize dot segments before exposing pathname. Require the
  // source path to survive intact so unregistered segments cannot disappear.
  const sourcePath = /^[a-z][a-z\d+.-]*:\/\/[^/]*(\/.*)$/i.exec(value)?.[1];
  if (sourcePath !== url.pathname) return null;
  const segments = url.pathname.split('/').slice(1);
  if (segments.length === 2 && segments[0] === 'v1' && segments[1] === 'spaces') {
    return createSpaceHomeAppRoute();
  }
  if ((segments.length !== 4 && segments.length !== 5) || segments[0] !== 'v1') {
    return null;
  }
  try {
    const parentId = decodeURIComponent(segments[2]);
    if (segments.length === 4) {
      if (segments[1] !== 'spaces' || !isAppRouteId(parentId)) return null;
      if (segments[3] === 'tools') return createSpaceToolsAppRoute(parentId);
      if (segments[3] === 'issues') return createSpaceIssuesAppRoute(parentId);
      return null;
    }
    const childId = decodeURIComponent(segments[4]);
    if (!isAppRouteId(parentId) || !isAppRouteId(childId)) return null;
    if (segments[1] === 'spaces' && segments[3] === 'issues') {
      return createSpaceIssueAppRoute(parentId, childId);
    }
    if (segments[1] === 'tasks' && segments[3] === 'comments') {
      return createTaskCommentAppRoute(parentId, childId);
    }
    return null;
  } catch {
    return null;
  }
}
