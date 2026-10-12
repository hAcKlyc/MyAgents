use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Runtime};

const APP_ROUTE_SCHEME: &str = crate::app_dirs::APP_URL_SCHEME;
const APP_ROUTE_AUTHORITY: &str = "open";
const MAX_ID_BYTES: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "name", rename_all = "snake_case")]
pub enum AppRoute {
    #[serde(rename = "space.home")]
    SpaceHome {
        version: u8,
        #[serde(rename = "params")]
        params: SpaceHomeRouteParams,
    },
    #[serde(rename = "space.issues")]
    SpaceIssues {
        version: u8,
        #[serde(rename = "params")]
        params: SpaceRouteParams,
    },
    #[serde(rename = "space.tools")]
    SpaceTools {
        version: u8,
        #[serde(rename = "params")]
        params: SpaceRouteParams,
    },
    #[serde(rename = "space.issue")]
    SpaceIssue {
        version: u8,
        #[serde(rename = "params")]
        params: SpaceIssueRouteParams,
    },
    #[serde(rename = "task.comment")]
    TaskComment {
        version: u8,
        #[serde(rename = "params")]
        params: TaskCommentRouteParams,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpaceHomeRouteParams {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRouteParams {
    pub space_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpaceIssueRouteParams {
    pub space_id: String,
    pub issue_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentRouteParams {
    pub task_id: String,
    pub comment_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingAppRoute {
    pub generation: u64,
    pub route: AppRoute,
}

#[derive(Debug, Default)]
pub struct AppRouteQueue {
    generation: u64,
    pending: Option<PendingAppRoute>,
}

pub type ManagedAppRouteQueue = Arc<Mutex<AppRouteQueue>>;

pub fn create_queue() -> ManagedAppRouteQueue {
    Arc::new(Mutex::new(AppRouteQueue::default()))
}

/// Latest-wins queue between the native deep-link lifecycle and Renderer.
///
/// Tauri can deliver a link before the WebView has mounted its listener. The
/// event is therefore only a wake signal; Renderer atomically takes the value
/// through `cmd_take_pending_app_route`. Keeping the typed value in Rust also
/// means untrusted URL parsing never leaks into React components.
pub fn enqueue<R: Runtime>(app: &AppHandle<R>, state: &ManagedAppRouteQueue, route: AppRoute) {
    let generation = {
        let mut queue = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        queue.generation = queue.generation.saturating_add(1);
        let generation = queue.generation;
        queue.pending = Some(PendingAppRoute { generation, route });
        generation
    };
    if let Err(error) = app.emit("app-route:available", generation) {
        crate::ulog_warn!("[AppRoute] failed to wake renderer: {}", error);
    }
}

pub fn enqueue_deep_link<R: Runtime>(
    app: &AppHandle<R>,
    state: &ManagedAppRouteQueue,
    raw: &str,
) -> bool {
    let Some(route) = parse_deep_link(raw) else {
        return false;
    };
    enqueue(app, state, route);
    true
}

pub fn enqueue_from_args<R: Runtime>(
    app: &AppHandle<R>,
    state: &ManagedAppRouteQueue,
    args: &[String],
) -> bool {
    let mut accepted = false;
    for arg in args {
        accepted |= enqueue_deep_link(app, state, arg);
    }
    accepted
}

#[tauri::command]
pub fn cmd_take_pending_app_route(
    state: tauri::State<'_, ManagedAppRouteQueue>,
) -> Option<PendingAppRoute> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .pending
        .take()
}

impl AppRoute {
    pub fn space_home() -> Self {
        Self::SpaceHome {
            version: 1,
            params: SpaceHomeRouteParams {},
        }
    }

    pub fn space_issues(space_id: impl Into<String>) -> Option<Self> {
        let space_id = space_id.into();
        if !is_route_id(&space_id) {
            return None;
        }
        Some(Self::SpaceIssues {
            version: 1,
            params: SpaceRouteParams { space_id },
        })
    }

    pub fn space_tools(space_id: impl Into<String>) -> Option<Self> {
        let space_id = space_id.into();
        if !is_route_id(&space_id) {
            return None;
        }
        Some(Self::SpaceTools {
            version: 1,
            params: SpaceRouteParams { space_id },
        })
    }

    pub fn space_issue(space_id: impl Into<String>, issue_id: impl Into<String>) -> Option<Self> {
        let space_id = space_id.into();
        let issue_id = issue_id.into();
        if !is_route_id(&space_id) || !is_route_id(&issue_id) {
            return None;
        }
        Some(Self::SpaceIssue {
            version: 1,
            params: SpaceIssueRouteParams { space_id, issue_id },
        })
    }

    pub fn task_comment(task_id: impl Into<String>, comment_id: impl Into<String>) -> Option<Self> {
        let task_id = task_id.into();
        let comment_id = comment_id.into();
        if !is_route_id(&task_id) || !is_route_id(&comment_id) {
            return None;
        }
        Some(Self::TaskComment {
            version: 1,
            params: TaskCommentRouteParams {
                task_id,
                comment_id,
            },
        })
    }

    pub fn to_deep_link(&self) -> String {
        match self {
            Self::SpaceHome { .. } => format!("{APP_ROUTE_SCHEME}://open/v1/spaces"),
            Self::SpaceIssues { params, .. } => {
                format!("{APP_ROUTE_SCHEME}://open/v1/spaces/{}/issues", params.space_id)
            }
            Self::SpaceTools { params, .. } => {
                format!("{APP_ROUTE_SCHEME}://open/v1/spaces/{}/tools", params.space_id)
            }
            Self::SpaceIssue { params, .. } => format!(
                "{APP_ROUTE_SCHEME}://open/v1/spaces/{}/issues/{}",
                params.space_id, params.issue_id
            ),
            Self::TaskComment { params, .. } => format!(
                "{APP_ROUTE_SCHEME}://open/v1/tasks/{}/comments/{}",
                params.task_id, params.comment_id
            ),
        }
    }
}

fn is_route_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn decode_segment(value: &str) -> Option<String> {
    let decoded = percent_decode_str(value).decode_utf8().ok()?.into_owned();
    is_route_id(&decoded).then_some(decoded)
}

pub fn parse_deep_link(raw: &str) -> Option<AppRoute> {
    let value = raw.trim();
    if value.is_empty() || value.contains('?') || value.contains('#') || value.contains('\\') {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != APP_ROUTE_SCHEME
        || url.host_str() != Some(APP_ROUTE_AUTHORITY)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    // Check the source path before accepting URL-normalized dot segments.
    let authority_and_path = value.split_once("://")?.1;
    let source_path = &authority_and_path[authority_and_path.find('/')?..];
    if source_path != url.path() {
        return None;
    }
    let path = url.path().strip_prefix('/')?;
    if path.starts_with('/') {
        return None;
    }
    let segments = path.split('/').collect::<Vec<_>>();
    if segments == ["v1", "spaces"] {
        return Some(AppRoute::space_home());
    }
    if !matches!(segments.len(), 4 | 5) || segments[0] != "v1" {
        return None;
    }
    let parent_id = decode_segment(segments[2])?;
    if segments.len() == 4 {
        return match (segments[1], segments[3]) {
            ("spaces", "tools") => AppRoute::space_tools(parent_id),
            ("spaces", "issues") => AppRoute::space_issues(parent_id),
            _ => None,
        };
    }
    let child_id = decode_segment(segments[4])?;
    match (segments[1], segments[3]) {
        ("spaces", "issues") => AppRoute::space_issue(parent_id, child_id),
        ("tasks", "comments") => AppRoute::task_comment(parent_id, child_id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_shared_route_corpus() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../src/shared/appRoute.fixtures.json"))
                .expect("route fixtures");
        for item in fixtures["accepted"].as_array().expect("accepted routes") {
            let expected: AppRoute = serde_json::from_value(item["route"].clone()).expect("route");
            assert_eq!(
                parse_deep_link(item["url"].as_str().expect("url")),
                Some(expected.clone())
            );
            assert_eq!(parse_deep_link(&expected.to_deep_link()), Some(expected));
        }
        for url in fixtures["rejected"].as_array().expect("rejected routes") {
            assert_eq!(parse_deep_link(url.as_str().expect("url")), None);
        }
        assert_eq!(
            AppRoute::space_tools("official")
                .expect("route")
                .to_deep_link(),
            "myagents://open/v1/spaces/official/tools"
        );
        assert_eq!(AppRoute::space_tools(""), None);
        assert_eq!(AppRoute::space_tools("x".repeat(201)), None);
    }

    #[test]
    fn parses_and_serializes_supported_routes() {
        let route = parse_deep_link("myagents://open/v1/spaces/space_1/issues/issue-2")
            .expect("valid route");
        assert_eq!(
            route.to_deep_link(),
            "myagents://open/v1/spaces/space_1/issues/issue-2"
        );
        let comment = parse_deep_link("myagents://open/v1/tasks/task_1/comments/comment-2")
            .expect("valid task comment route");
        assert_eq!(
            comment,
            AppRoute::task_comment("task_1", "comment-2").expect("valid ids")
        );
        assert_eq!(
            comment.to_deep_link(),
            "myagents://open/v1/tasks/task_1/comments/comment-2"
        );
        assert_eq!(
            route,
            AppRoute::space_issue("space_1", "issue-2").expect("valid ids")
        );
    }

    #[test]
    fn rejects_resource_and_ambiguous_urls() {
        for value in [
            "myagents://attachment/session/file.png",
            "myagents://tool-attachment/session/turn/file.png",
            "myagents-resource://attachment/session/file.png",
            "myagents://evil/v1/spaces/a/issues/b",
            "myagents://open/v2/spaces/a/issues/b",
            "myagents://open/v1/spaces/a/issues/b/extra",
            "myagents://open/v1/tasks/a/comments/b/extra",
            "myagents://open/v1/tasks/a/issues/b",
            "myagents://open//v1/spaces/a/issues/b",
            "myagents://open/v1/spaces/a/issues/b?prompt=run",
            "myagents://open/v1/spaces/a/issues/b#fragment",
            "myagents://open/v1/spaces/a%2Fb/issues/c",
            "myagents://open/v1/spaces/a/issues/%ZZ",
            "myagents://user@open/v1/spaces/a/issues/b",
            "myagents://open:42/v1/spaces/a/issues/b",
        ] {
            assert_eq!(parse_deep_link(value), None, "{value}");
        }
    }

    #[test]
    fn bounds_route_identifiers() {
        assert_eq!(AppRoute::space_issue("", "issue"), None);
        assert_eq!(AppRoute::space_issue("space", "x".repeat(201)), None);
        assert_eq!(AppRoute::task_comment("task", ""), None);
    }

    #[test]
    fn queue_is_latest_generation_wins() {
        let state = create_queue();
        {
            let mut queue = state.lock().expect("queue lock");
            queue.generation = 40;
            queue.pending = Some(PendingAppRoute {
                generation: 41,
                route: AppRoute::space_issue("space-a", "issue-a").expect("route"),
            });
            queue.pending = Some(PendingAppRoute {
                generation: 42,
                route: AppRoute::space_issue("space-b", "issue-b").expect("route"),
            });
        }
        let pending = state
            .lock()
            .expect("queue lock")
            .pending
            .clone()
            .expect("pending");
        assert_eq!(pending.generation, 42);
        assert_eq!(
            pending.route.to_deep_link(),
            "myagents://open/v1/spaces/space-b/issues/issue-b"
        );
    }
}
