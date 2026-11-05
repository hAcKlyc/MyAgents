//! Process-scoped Cloud notification synchronization owner (PRD 0.4.10).
//!
//! The Renderer only receives a normalized in-memory snapshot. The file below
//! deliberately persists receipts, cutoffs, and pending operation IDs only —
//! never announcement text, Issue titles, actors, excerpts, targets, or URLs.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Utc;
use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex as AsyncMutex, Notify};

use super::{
    api_url, capability_base_url, ensure_space_available, http_client, parse_authorized_cloud_data,
    read_current_session, session_path, session_user_id, space_build_capability, url_component,
    with_space_client_context_headers, write_private_json_unlocked, AuthenticatedSpaceSession,
    SpaceCommandError,
};
use crate::app_route::AppRoute;
use crate::network_diagnostics::{error_category, RequestDiagnostic};
use crate::{ulog_debug, ulog_info, ulog_warn};

const STATE_FILE: &str = "notification-state.json";
const UPDATED_EVENT: &str = "notification-center:updated";
const PAGE_SIZE: usize = 20;
const MAX_SCAN_PAGES: usize = 100;
const MAX_PENDING_IDS: usize = 2_000;
const MAX_ANNOUNCEMENT_RECEIPTS: usize = 2_000;
const MAX_ACCOUNTS: usize = 20;
const FOREGROUND_INTERVAL: Duration = Duration::from_secs(60);
const BACKGROUND_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSortPoint {
    pub created_at: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotificationTarget {
    ExternalUrl { url: String },
    AppRoute { route: AppRoute },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationActor {
    #[serde(rename = "type")]
    pub actor_type: String,
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationIssue {
    pub id: String,
    pub number: Option<i64>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum NotificationItem {
    Announcement {
        id: String,
        created_at: String,
        is_read: bool,
        summary_zh: String,
        summary_other: Option<String>,
        target: NotificationTarget,
    },
    #[serde(rename = "space_issue_comment")]
    SpaceIssueComment {
        id: String,
        created_at: String,
        is_read: bool,
        comment_id: String,
        actor: NotificationActor,
        space_id: String,
        issue: NotificationIssue,
        excerpt: Option<String>,
        target: NotificationTarget,
    },
    #[serde(rename = "task_agent_comment")]
    TaskAgentComment {
        id: String,
        created_at: String,
        is_read: bool,
        task_id: String,
        task_name: String,
        comment_id: String,
        agent: NotificationActor,
        excerpt: String,
        target: NotificationTarget,
    },
}

impl NotificationItem {
    fn id(&self) -> &str {
        match self {
            Self::Announcement { id, .. }
            | Self::SpaceIssueComment { id, .. }
            | Self::TaskAgentComment { id, .. } => id,
        }
    }

    fn created_at(&self) -> &str {
        match self {
            Self::Announcement { created_at, .. }
            | Self::SpaceIssueComment { created_at, .. }
            | Self::TaskAgentComment { created_at, .. } => created_at,
        }
    }

    fn is_read(&self) -> bool {
        match self {
            Self::Announcement { is_read, .. }
            | Self::SpaceIssueComment { is_read, .. }
            | Self::TaskAgentComment { is_read, .. } => *is_read,
        }
    }

    fn set_read(&mut self) {
        match self {
            Self::Announcement { is_read, .. }
            | Self::SpaceIssueComment { is_read, .. }
            | Self::TaskAgentComment { is_read, .. } => *is_read = true,
        }
    }

    fn is_announcement(&self) -> bool {
        matches!(self, Self::Announcement { .. })
    }

    fn target(&self) -> NotificationTarget {
        match self {
            Self::Announcement { target, .. }
            | Self::SpaceIssueComment { target, .. }
            | Self::TaskAgentComment { target, .. } => target.clone(),
        }
    }

    fn point(&self) -> NotificationSortPoint {
        NotificationSortPoint {
            created_at: self.created_at().to_string(),
            id: self.id().to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationAuthState {
    SignedOut,
    Authenticated,
    ReauthRequired,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationLoadState {
    Idle,
    Loading,
    Ready,
    Error,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSnapshot {
    pub load_state: NotificationLoadState,
    pub auth_state: NotificationAuthState,
    pub items: Vec<NotificationItem>,
    pub has_unread: bool,
    pub has_more: bool,
    pub is_loading_more: bool,
    pub feed_cutoff: Option<NotificationSortPoint>,
    pub last_synced_at: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationActivation {
    pub notification_id: String,
    pub target: NotificationTarget,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedPage {
    items: Vec<NotificationItem>,
    next_cursor: Option<String>,
    feed_cutoff: NotificationSortPoint,
    has_unread: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnnouncementReceipts {
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    cutoff: Option<NotificationSortPoint>,
    #[serde(default)]
    revision: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountPendingState {
    #[serde(default)]
    pending_ids: Vec<String>,
    #[serde(default)]
    pending_read_all: Option<NotificationSortPoint>,
    #[serde(default)]
    merged_announcement_revision: u64,
    #[serde(default)]
    touched_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalTaskReceipts {
    #[serde(default)]
    ids: Vec<String>,
    /// Sort points let the local owner expire receipts by the same 90-day
    /// visibility window without dropping an older-but-still-visible read fact
    /// merely because the bounded source index temporarily omitted it.
    #[serde(default)]
    points: BTreeMap<String, NotificationSortPoint>,
    #[serde(default)]
    cutoff: Option<NotificationSortPoint>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudOriginReceipts {
    #[serde(default)]
    announcements: AnnouncementReceipts,
    #[serde(default)]
    accounts: BTreeMap<String, AccountPendingState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedNotificationState {
    version: u8,
    #[serde(default)]
    cloud_origins: BTreeMap<String, CloudOriginReceipts>,
    #[serde(default)]
    local_tasks: LocalTaskReceipts,
}

impl Default for PersistedNotificationState {
    fn default() -> Self {
        Self {
            version: 2,
            cloud_origins: BTreeMap::new(),
            local_tasks: LocalTaskReceipts::default(),
        }
    }
}

#[derive(Debug, Clone)]
struct Baseline {
    cutoff: NotificationSortPoint,
}

#[derive(Debug)]
struct RuntimeState {
    load_state: NotificationLoadState,
    auth_state: NotificationAuthState,
    identity_key: Option<String>,
    origin_key: Option<String>,
    account_key: Option<String>,
    items: Vec<NotificationItem>,
    next_cursor: Option<String>,
    feed_cutoff: Option<NotificationSortPoint>,
    has_unread: bool,
    is_loading_more: bool,
    visible_limit: usize,
    last_synced_at: Option<String>,
    error_code: Option<String>,
    baselines: HashMap<String, Baseline>,
    reminded_ids: HashSet<String>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            load_state: NotificationLoadState::Idle,
            auth_state: NotificationAuthState::SignedOut,
            identity_key: None,
            origin_key: None,
            account_key: None,
            items: Vec::new(),
            next_cursor: None,
            feed_cutoff: None,
            has_unread: false,
            is_loading_more: false,
            visible_limit: PAGE_SIZE,
            last_synced_at: None,
            error_code: None,
            baselines: HashMap::new(),
            reminded_ids: HashSet::new(),
        }
    }
}

pub struct NotificationCenter {
    path: PathBuf,
    runtime: Mutex<RuntimeState>,
    persisted: Mutex<PersistedNotificationState>,
    sync_gate: AsyncMutex<()>,
    wake: Notify,
    task_store: crate::task::ManagedTaskStore,
}

pub type ManagedNotificationCenter = Arc<NotificationCenter>;

const LOCAL_NOTIFICATION_WINDOW_DAYS: i64 = 90;

impl NotificationCenter {
    fn local_items(
        &self,
        persisted: &PersistedNotificationState,
    ) -> (bool, bool, Vec<NotificationItem>) {
        let source = self.task_store.agent_comment_notification_source();
        let cutoff_ms = Utc::now().timestamp_millis()
            - chrono::Duration::days(LOCAL_NOTIFICATION_WINDOW_DAYS).num_milliseconds();
        let items = source
            .items
            .into_iter()
            .filter(|locator| locator.created_at >= cutoff_ms)
            .filter_map(|locator| {
                let created_at =
                    chrono::DateTime::<Utc>::from_timestamp_millis(locator.created_at)?
                        .to_rfc3339();
                let point = NotificationSortPoint {
                    created_at: created_at.clone(),
                    id: locator.notification_id.clone(),
                };
                let is_read = persisted
                    .local_tasks
                    .ids
                    .iter()
                    .any(|id| id == &locator.notification_id)
                    || persisted
                        .local_tasks
                        .cutoff
                        .as_ref()
                        .is_some_and(|cutoff| is_at_or_before(&point, cutoff));
                let route = AppRoute::task_comment(&locator.task_id, &locator.comment_id)?;
                Some(NotificationItem::TaskAgentComment {
                    id: locator.notification_id,
                    created_at,
                    is_read,
                    task_id: locator.task_id,
                    task_name: locator.task_name,
                    comment_id: locator.comment_id,
                    agent: NotificationActor {
                        actor_type: "registered_agent".to_string(),
                        id: locator.session_id,
                        display_name: locator.agent_label.unwrap_or_else(|| "Agent".to_string()),
                    },
                    excerpt: locator.excerpt,
                    target: NotificationTarget::AppRoute { route },
                })
            })
            .collect();
        (source.ready, source.partial_error, items)
    }

    fn snapshot(&self) -> NotificationSnapshot {
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let persisted = self
            .persisted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (local_ready, local_partial, local_items) = self.local_items(&persisted);
        let mut items = runtime.items.clone();
        items.extend(local_items);
        items.sort_by(|left, right| {
            right
                .created_at()
                .cmp(left.created_at())
                .then_with(|| right.id().cmp(left.id()))
        });
        items.dedup_by(|left, right| left.id() == right.id());
        let total_items = items.len();
        let has_any_unread = items.iter().any(|item| !item.is_read());
        let local_cutoff = items
            .iter()
            .find(|item| matches!(item, NotificationItem::TaskAgentComment { .. }))
            .map(NotificationItem::point);
        let feed_cutoff = match (runtime.feed_cutoff.clone(), local_cutoff) {
            (Some(cloud), Some(local)) => Some(later_cutoff(Some(cloud), local)),
            (cloud, None) => cloud,
            (None, local) => local,
        };
        let load_state = if local_ready
            && !items.is_empty()
            && matches!(
                runtime.load_state,
                NotificationLoadState::Error | NotificationLoadState::Unavailable
            ) {
            NotificationLoadState::Ready
        } else if !local_ready && runtime.load_state == NotificationLoadState::Idle {
            NotificationLoadState::Loading
        } else {
            runtime.load_state
        };
        let visible_limit = runtime.visible_limit.max(PAGE_SIZE);
        items.truncate(visible_limit);
        NotificationSnapshot {
            load_state,
            auth_state: runtime.auth_state,
            has_unread: runtime.has_unread || has_any_unread,
            has_more: runtime.next_cursor.is_some() || total_items > visible_limit,
            is_loading_more: runtime.is_loading_more,
            feed_cutoff,
            last_synced_at: runtime.last_synced_at.clone(),
            error_code: runtime
                .error_code
                .clone()
                .or_else(|| local_partial.then(|| "task_source_partial".to_string())),
            items,
        }
    }
}

#[derive(Debug, Clone)]
struct SyncContext {
    identity_key: String,
    origin_key: String,
    account_key: Option<String>,
    auth_state: NotificationAuthState,
    base_url: String,
    session: Option<AuthenticatedSpaceSession>,
}

fn origin_key(base_url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(base_url.trim().trim_end_matches('/').as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn account_key(base_url: &str, user_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(base_url.trim().trim_end_matches('/').as_bytes());
    hasher.update([0]);
    hasher.update(user_id.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn notification_state_path(data_dir: &Path) -> PathBuf {
    data_dir.join(STATE_FILE)
}

fn state_path() -> PathBuf {
    crate::app_dirs::myagents_data_dir()
        .map(|path| notification_state_path(&path))
        .unwrap_or_else(|| PathBuf::from(STATE_FILE))
}

fn load_persisted(path: &Path) -> PersistedNotificationState {
    match std::fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str::<PersistedNotificationState>(&content) {
            Ok(state) if state.version == 2 => state,
            Ok(_) => {
                ulog_warn!("[NotificationCenter] ignored unsupported local state version");
                PersistedNotificationState::default()
            }
            Err(error) => {
                ulog_warn!(
                    "[NotificationCenter] ignored invalid local state: {}",
                    error
                );
                PersistedNotificationState::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            PersistedNotificationState::default()
        }
        Err(error) => {
            ulog_warn!("[NotificationCenter] failed to read local state: {}", error);
            PersistedNotificationState::default()
        }
    }
}

pub fn create_state(task_store: crate::task::ManagedTaskStore) -> ManagedNotificationCenter {
    let path = state_path();
    Arc::new(NotificationCenter {
        persisted: Mutex::new(load_persisted(&path)),
        path,
        runtime: Mutex::new(RuntimeState::default()),
        sync_gate: AsyncMutex::new(()),
        wake: Notify::new(),
        task_store,
    })
}

fn persist(center: &NotificationCenter) -> Result<(), String> {
    let persisted = center
        .persisted
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    write_private_json_unlocked(&center.path, &*persisted)
}

fn mutate_persisted<T>(
    center: &NotificationCenter,
    mutate: impl FnOnce(&mut PersistedNotificationState) -> T,
) -> Result<T, String> {
    let mut persisted = center
        .persisted
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let before = persisted.clone();
    let result = mutate(&mut persisted);
    if let Err(error) = write_private_json_unlocked(&center.path, &*persisted) {
        *persisted = before;
        return Err(error);
    }
    Ok(result)
}

fn current_context() -> Result<SyncContext, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Err("SPACE_NOTIFICATIONS_UNAVAILABLE_IN_MOCK".to_string());
    }
    let capability = ensure_space_available()?;
    let configured_base_url = capability_base_url(&capability)?;
    let configured_origin_key = origin_key(&configured_base_url);
    let Some(session) = read_current_session()? else {
        return Ok(SyncContext {
            identity_key: format!("anonymous:{}", configured_base_url.trim_end_matches('/')),
            origin_key: configured_origin_key,
            account_key: None,
            auth_state: NotificationAuthState::SignedOut,
            base_url: configured_base_url,
            session: None,
        });
    };
    let user_id = session_user_id(&session)
        .ok_or_else(|| "SPACE_NOTIFICATION_ACCOUNT_ID_MISSING".to_string())?;
    let key = account_key(&session.base_url, &user_id);
    if session.authenticated_token().is_none() {
        return Ok(SyncContext {
            identity_key: format!("reauth:{key}"),
            origin_key: origin_key(&session.base_url),
            account_key: None,
            auth_state: NotificationAuthState::ReauthRequired,
            base_url: session.base_url,
            session: None,
        });
    }
    let authenticated = AuthenticatedSpaceSession::from_account(session, session_path()?)?;
    Ok(SyncContext {
        identity_key: format!("account:{key}"),
        origin_key: origin_key(&authenticated.base_url),
        account_key: Some(key),
        auth_state: NotificationAuthState::Authenticated,
        base_url: authenticated.base_url.clone(),
        session: Some(authenticated),
    })
}

fn reset_projection_for_identity(center: &NotificationCenter, context: &SyncContext) -> bool {
    let mut runtime = center
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let changed = runtime.identity_key.as_deref() != Some(context.identity_key.as_str());
    if changed {
        // Private content is process memory only and must disappear before a
        // request for the next identity starts.
        runtime.items.clear();
        runtime.next_cursor = None;
        runtime.feed_cutoff = None;
        runtime.has_unread = false;
        runtime.visible_limit = PAGE_SIZE;
        runtime.last_synced_at = None;
        runtime.error_code = None;
        // Entering an identity always establishes a fresh no-toast baseline.
        // The process-wide reminded set remains intact so one public
        // announcement cannot toast again after login/logout.
        runtime.baselines.remove(&context.identity_key);
    }
    runtime.identity_key = Some(context.identity_key.clone());
    runtime.origin_key = Some(context.origin_key.clone());
    runtime.account_key = context.account_key.clone();
    runtime.auth_state = context.auth_state;
    runtime.load_state = NotificationLoadState::Loading;
    changed
}

fn emit_snapshot<R: tauri::Runtime>(app: &AppHandle<R>, center: &NotificationCenter) {
    let snapshot = center.snapshot();
    if let Err(error) = app.emit(UPDATED_EVENT, snapshot) {
        ulog_debug!(
            "[NotificationCenter] renderer update not delivered: {}",
            error
        );
    }
}

fn is_at_or_before(point: &NotificationSortPoint, cutoff: &NotificationSortPoint) -> bool {
    point.created_at < cutoff.created_at
        || (point.created_at == cutoff.created_at && point.id <= cutoff.id)
}

fn is_after(point: &NotificationSortPoint, cutoff: &NotificationSortPoint) -> bool {
    point.created_at > cutoff.created_at
        || (point.created_at == cutoff.created_at && point.id > cutoff.id)
}

fn later_cutoff(
    current: Option<NotificationSortPoint>,
    candidate: NotificationSortPoint,
) -> NotificationSortPoint {
    match current {
        Some(current) if !is_after(&candidate, &current) => current,
        _ => candidate,
    }
}

fn normalize_item(
    item: &mut NotificationItem,
    receipts: &AnnouncementReceipts,
    pending: Option<&AccountPendingState>,
) {
    if item.is_announcement()
        && (receipts.ids.iter().any(|id| id == item.id())
            || receipts
                .cutoff
                .as_ref()
                .is_some_and(|cutoff| is_at_or_before(&item.point(), cutoff)))
    {
        item.set_read();
    }
    if let Some(pending) = pending {
        if pending.pending_ids.iter().any(|id| id == item.id())
            || pending
                .pending_read_all
                .as_ref()
                .is_some_and(|cutoff| is_at_or_before(&item.point(), cutoff))
        {
            item.set_read();
        }
    }
}

fn normalized_page(
    center: &NotificationCenter,
    origin_key: &str,
    account_key: Option<&str>,
    mut page: FeedPage,
) -> FeedPage {
    let persisted = center
        .persisted
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(origin) = persisted.cloud_origins.get(origin_key) {
        let pending = account_key.and_then(|key| origin.accounts.get(key));
        for item in &mut page.items {
            normalize_item(item, &origin.announcements, pending);
        }
    }
    page
}

async fn fetch_page(
    context: &SyncContext,
    cursor: Option<&str>,
) -> Result<FeedPage, SpaceCommandError> {
    let path = match cursor {
        Some(cursor) => format!(
            "/api/notifications?limit={PAGE_SIZE}&cursor={}",
            url_component(cursor)
        ),
        None => format!("/api/notifications?limit={PAGE_SIZE}"),
    };
    let client = http_client().map_err(SpaceCommandError::from)?;
    let mut request = with_space_client_context_headers(
        client.get(api_url(&context.base_url, &path).map_err(SpaceCommandError::from)?),
        &space_build_capability(),
    );
    if let Some(session) = context.session.as_ref() {
        request = request.header(AUTHORIZATION, format!("Bearer {}", session.session_token()));
    }
    let diagnostic = RequestDiagnostic::new("space-notifications", &reqwest::Method::GET, &path);
    let response = diagnostic.send(request).await.map_err(|error| {
        SpaceCommandError::transport(format!(
            "Notification feed request failed ({})",
            error_category(&error)
        ))
    })?;
    {
        let value =
            parse_authorized_cloud_data(response, context.session.as_ref(), &diagnostic).await?;
        serde_json::from_value(value).map_err(|error| {
            SpaceCommandError::local(
                "SPACE_RESPONSE_INVALID",
                format!("Invalid notification feed response: {error}"),
            )
        })
    }
}

async fn post_authenticated(
    context: &SyncContext,
    path: &str,
    body: Value,
) -> Result<Value, SpaceCommandError> {
    let session = context.session.as_ref().ok_or_else(|| {
        SpaceCommandError::local("SPACE_REAUTH_REQUIRED", "Space login is required")
    })?;
    let diagnostic = RequestDiagnostic::new("space-notifications", &reqwest::Method::POST, path);
    let response = diagnostic
        .send(with_space_client_context_headers(
            http_client()
                .map_err(SpaceCommandError::from)?
                .post(api_url(&context.base_url, path).map_err(SpaceCommandError::from)?)
                .header(AUTHORIZATION, format!("Bearer {}", session.session_token()))
                .json(&body),
            &space_build_capability(),
        ))
        .await
        .map_err(|error| {
            SpaceCommandError::transport(format!(
                "Notification mutation failed ({})",
                error_category(&error)
            ))
        })?;
    parse_authorized_cloud_data(response, Some(session), &diagnostic).await
}

fn touch_account<'a>(
    origin: &'a mut CloudOriginReceipts,
    key: &str,
) -> &'a mut AccountPendingState {
    origin
        .accounts
        .entry(key.to_string())
        .or_default()
        .touched_at = Utc::now().timestamp();
    if origin.accounts.len() > MAX_ACCOUNTS {
        let active = key.to_string();
        let mut oldest = origin
            .accounts
            .iter()
            .filter(|(candidate, state)| {
                **candidate != active
                    && state.pending_ids.is_empty()
                    && state.pending_read_all.is_none()
            })
            .map(|(candidate, state)| (candidate.clone(), state.touched_at))
            .collect::<Vec<_>>();
        oldest.sort_by_key(|(_, touched_at)| *touched_at);
        for (candidate, _) in oldest
            .into_iter()
            .take(origin.accounts.len().saturating_sub(MAX_ACCOUNTS))
        {
            origin.accounts.remove(&candidate);
        }
    }
    origin
        .accounts
        .get_mut(key)
        .expect("active account retained")
}

async fn flush_pending(
    center: &NotificationCenter,
    context: &SyncContext,
) -> Result<(), SpaceCommandError> {
    let Some(key) = context.account_key.as_deref() else {
        return Ok(());
    };

    let (announcement_revision, announcement_ids, announcement_cutoff, merged_revision) = {
        let persisted = center
            .persisted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let origin = persisted
            .cloud_origins
            .get(&context.origin_key)
            .cloned()
            .unwrap_or_default();
        let account = origin.accounts.get(key).cloned().unwrap_or_default();
        (
            origin.announcements.revision,
            origin.announcements.ids,
            origin.announcements.cutoff,
            account.merged_announcement_revision,
        )
    };
    if announcement_revision > merged_revision {
        if announcement_ids.is_empty() {
            if let Some(cutoff) = announcement_cutoff.clone() {
                post_authenticated(
                    context,
                    "/api/notifications/announcement-reads/merge",
                    json!({ "cutoff": cutoff }),
                )
                .await?;
            }
        } else {
            for (index, chunk) in announcement_ids.chunks(100).enumerate() {
                let mut body = json!({ "announcementIds": chunk });
                if index == 0 {
                    if let Some(cutoff) = announcement_cutoff.clone() {
                        body["cutoff"] = serde_json::to_value(cutoff).unwrap_or(Value::Null);
                    }
                }
                post_authenticated(context, "/api/notifications/announcement-reads/merge", body)
                    .await?;
            }
        }
        {
            let mut persisted = center
                .persisted
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let origin = persisted
                .cloud_origins
                .entry(context.origin_key.clone())
                .or_default();
            let account = touch_account(origin, key);
            account.merged_announcement_revision = account
                .merged_announcement_revision
                .max(announcement_revision);
        }
        if let Err(error) = persist(center) {
            ulog_warn!(
                "[NotificationCenter] failed to persist merge checkpoint: {}",
                error
            );
        }
    }

    loop {
        let batch = {
            let persisted = center
                .persisted
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            persisted
                .cloud_origins
                .get(&context.origin_key)
                .and_then(|origin| origin.accounts.get(key))
                .map(|account| {
                    account
                        .pending_ids
                        .iter()
                        .take(100)
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        if batch.is_empty() {
            break;
        }
        post_authenticated(
            context,
            "/api/notifications/read",
            json!({ "notificationIds": batch }),
        )
        .await?;
        {
            let mut persisted = center
                .persisted
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let origin = persisted
                .cloud_origins
                .entry(context.origin_key.clone())
                .or_default();
            let account = touch_account(origin, key);
            account
                .pending_ids
                .retain(|id| !batch.iter().any(|sent| sent == id));
        }
        if let Err(error) = persist(center) {
            ulog_warn!(
                "[NotificationCenter] failed to persist ACK checkpoint: {}",
                error
            );
        }
    }

    let pending_cutoff = {
        let persisted = center
            .persisted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        persisted
            .cloud_origins
            .get(&context.origin_key)
            .and_then(|origin| origin.accounts.get(key))
            .and_then(|account| account.pending_read_all.clone())
    };
    if let Some(cutoff) = pending_cutoff.clone() {
        post_authenticated(
            context,
            "/api/notifications/read-all",
            json!({ "cutoff": cutoff }),
        )
        .await?;
        {
            let mut persisted = center
                .persisted
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let origin = persisted
                .cloud_origins
                .entry(context.origin_key.clone())
                .or_default();
            let account = touch_account(origin, key);
            if account.pending_read_all.as_ref() == pending_cutoff.as_ref() {
                account.pending_read_all = None;
            }
        }
        if let Err(error) = persist(center) {
            ulog_warn!(
                "[NotificationCenter] failed to persist read-all checkpoint: {}",
                error
            );
        }
    }
    Ok(())
}

fn toast_text(item: &NotificationItem) -> (String, String) {
    let locale = crate::i18n::current_locale();
    match item {
        NotificationItem::Announcement {
            summary_zh,
            summary_other,
            ..
        } => {
            let body = if locale.as_str().starts_with("zh") {
                summary_zh.clone()
            } else {
                summary_other.clone().unwrap_or_else(|| summary_zh.clone())
            };
            (
                crate::i18n::t("notification.centerAnnouncementTitle", locale).to_string(),
                body,
            )
        }
        NotificationItem::SpaceIssueComment { actor, issue, .. } => (
            crate::i18n::t("notification.centerCommentTitle", locale).to_string(),
            format!("{} · {}", actor.display_name, issue.title),
        ),
        NotificationItem::TaskAgentComment {
            agent,
            task_name,
            excerpt,
            ..
        } => (
            crate::i18n::t("notification.centerCommentTitle", locale).to_string(),
            format!("{} · {} · {}", agent.display_name, task_name, excerpt),
        ),
    }
}

fn main_window_unfocused<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    app.get_window("main")
        .map(|window| {
            !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false)
        })
        .unwrap_or(true)
}

fn update_baseline_and_collect_toasts(
    runtime: &mut RuntimeState,
    identity_key: &str,
    cutoff: &NotificationSortPoint,
    scanned_items: &[NotificationItem],
) -> Vec<NotificationItem> {
    let Some(baseline) = runtime.baselines.get_mut(identity_key) else {
        runtime.baselines.insert(
            identity_key.to_string(),
            Baseline {
                cutoff: cutoff.clone(),
            },
        );
        return Vec::new();
    };
    let previous = baseline.cutoff.clone();
    let mut toasts = Vec::new();
    for item in scanned_items {
        if !item.is_read()
            && is_after(&item.point(), &previous)
            && runtime.reminded_ids.insert(item.id().to_string())
        {
            toasts.push(item.clone());
        }
    }
    if is_after(cutoff, &baseline.cutoff) {
        baseline.cutoff = cutoff.clone();
    }
    toasts
}

fn advance_baseline_without_toasts(
    runtime: &mut RuntimeState,
    identity_key: &str,
    cutoff: &NotificationSortPoint,
) {
    match runtime.baselines.get_mut(identity_key) {
        Some(baseline) if is_after(cutoff, &baseline.cutoff) => {
            baseline.cutoff = cutoff.clone();
        }
        Some(_) => {}
        None => {
            runtime.baselines.insert(
                identity_key.to_string(),
                Baseline {
                    cutoff: cutoff.clone(),
                },
            );
        }
    }
}

fn collect_refresh_toasts(
    runtime: &mut RuntimeState,
    identity_key: &str,
    cutoff: &NotificationSortPoint,
    scanned_items: &[NotificationItem],
    scan_complete_for_new: bool,
) -> Vec<NotificationItem> {
    if scan_complete_for_new {
        update_baseline_and_collect_toasts(runtime, identity_key, cutoff, scanned_items)
    } else {
        advance_baseline_without_toasts(runtime, identity_key, cutoff);
        Vec::new()
    }
}

fn should_scan_next_page(
    account_key: Option<&str>,
    old_cutoff: Option<&NotificationSortPoint>,
    anonymous_has_unread: bool,
    reached_old_cutoff: bool,
) -> bool {
    let needs_anonymous_unread_scan = account_key.is_none() && !anonymous_has_unread;
    match old_cutoff {
        // First process sync establishes a no-toast baseline. Authenticated
        // `hasUnread` is already authoritative, so it never walks history.
        None => needs_anonymous_unread_scan,
        Some(_) => needs_anonymous_unread_scan || !reached_old_cutoff,
    }
}

async fn refresh_once(
    app: &AppHandle,
    center: &NotificationCenter,
) -> Result<(), SpaceCommandError> {
    // Retry any in-memory receipt whose previous disk checkpoint failed.
    persist_receipts_best_effort(center);
    center
        .task_store
        .retry_comment_notification_index_if_partial()
        .await;
    let context = current_context().map_err(SpaceCommandError::from)?;
    let identity_changed = reset_projection_for_identity(center, &context);
    emit_snapshot(app, center);
    if identity_changed {
        ulog_info!(
            "[NotificationCenter] projection identity changed auth={:?}",
            context.auth_state
        );
    }

    if context.session.is_some() {
        flush_pending(center, &context).await?;
    }

    let first = normalized_page(
        center,
        &context.origin_key,
        context.account_key.as_deref(),
        fetch_page(&context, None).await?,
    );
    let mut scanned_items = first.items.clone();
    let old_cutoff = {
        let runtime = center
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime
            .baselines
            .get(&context.identity_key)
            .map(|baseline| baseline.cutoff.clone())
    };
    let mut anonymous_has_unread = first.items.iter().any(|item| !item.is_read());
    let mut cursor = first.next_cursor.clone();
    let mut scanned_pages = 1usize;
    let mut reached_old_cutoff = false;
    if let Some(cutoff) = old_cutoff.as_ref() {
        reached_old_cutoff = first
            .items
            .iter()
            .any(|item| !is_after(&item.point(), cutoff));
    }
    while cursor.is_some()
        && scanned_pages < MAX_SCAN_PAGES
        && should_scan_next_page(
            context.account_key.as_deref(),
            old_cutoff.as_ref(),
            anonymous_has_unread,
            reached_old_cutoff,
        )
    {
        let page = normalized_page(
            center,
            &context.origin_key,
            context.account_key.as_deref(),
            fetch_page(&context, cursor.as_deref()).await?,
        );
        if let Some(cutoff) = old_cutoff.as_ref() {
            reached_old_cutoff |= page
                .items
                .iter()
                .any(|item| !is_after(&item.point(), cutoff));
        }
        anonymous_has_unread |= page.items.iter().any(|item| !item.is_read());
        scanned_items.extend(page.items);
        cursor = page.next_cursor;
        scanned_pages += 1;
    }

    let scan_complete_for_new = old_cutoff.is_some() && (reached_old_cutoff || cursor.is_none());
    let should_toast = main_window_unfocused(app);
    let toasts = {
        let mut runtime = center
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if runtime.identity_key.as_deref() != Some(context.identity_key.as_str()) {
            return Ok(());
        }
        runtime.items = first.items;
        runtime.next_cursor = first.next_cursor;
        runtime.feed_cutoff = Some(first.feed_cutoff.clone());
        runtime.has_unread = if context.account_key.is_some() {
            first.has_unread.unwrap_or(false)
        } else {
            anonymous_has_unread
        };
        runtime.load_state = NotificationLoadState::Ready;
        runtime.last_synced_at = Some(Utc::now().to_rfc3339());
        runtime.error_code = None;
        // First sync must never toast history. A capped scan also advances
        // safely without toasts; otherwise it would refetch the same 100
        // pages every minute forever while holding a stale baseline.
        collect_refresh_toasts(
            &mut runtime,
            &context.identity_key,
            &first.feed_cutoff,
            &scanned_items,
            scan_complete_for_new,
        )
    };
    emit_snapshot(app, center);

    if should_toast {
        for item in toasts {
            let (title, body) = toast_text(&item);
            crate::notification::show_cloud_notification(
                app,
                &title,
                &body,
                item.id().to_string(),
                item.target(),
                item.is_announcement(),
                Some(context.origin_key.clone()),
                context.account_key.clone(),
            );
        }
    }
    Ok(())
}

fn classify_error(error: &SpaceCommandError) -> String {
    if error.code == "SPACE_REAUTH_REQUIRED" {
        "reauth_required".to_string()
    } else if error.retryable {
        "network".to_string()
    } else {
        "unavailable".to_string()
    }
}

async fn run_refresh(app: &AppHandle, center: &NotificationCenter) -> bool {
    let _guard = center.sync_gate.lock().await;
    match refresh_once(app, center).await {
        Ok(()) => true,
        Err(error) => {
            ulog_warn!(
                "[NotificationCenter] sync failed code={} retryable={}",
                error.code,
                error.retryable
            );
            {
                let mut runtime = center
                    .runtime
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let requires_reauth = matches!(
                    error.code.as_str(),
                    "SPACE_REAUTH_REQUIRED" | "SPACE_SESSION_STATE_WRITE_FAILED"
                );
                if requires_reauth {
                    // A 401 is an immediate privacy boundary. Do not retain
                    // account-only Issue text while the public reauth feed is
                    // waiting for its next fetch.
                    runtime.items.clear();
                    runtime.next_cursor = None;
                    runtime.feed_cutoff = None;
                    runtime.has_unread = false;
                    runtime.identity_key = None;
                    runtime.account_key = None;
                    runtime.auth_state = NotificationAuthState::ReauthRequired;
                }
                runtime.error_code = Some(classify_error(&error));
                runtime.load_state = if runtime.items.is_empty() && !error.retryable {
                    NotificationLoadState::Unavailable
                } else {
                    NotificationLoadState::Error
                };
            }
            emit_snapshot(app, center);
            if error.code == "SPACE_REAUTH_REQUIRED" {
                // parse_authorized_cloud_data has committed the reauth state;
                // consume it immediately to project the public feed.
                center.wake.notify_one();
            }
            false
        }
    }
}

fn poll_interval(app: &AppHandle) -> Duration {
    if main_window_unfocused(app) {
        BACKGROUND_INTERVAL
    } else {
        FOREGROUND_INTERVAL
    }
}

pub fn start(app: AppHandle, center: ManagedNotificationCenter) {
    tauri::async_runtime::spawn(async move {
        let mut failures = 0u32;
        let mut first_failure: Option<Instant> = None;
        loop {
            let succeeded = run_refresh(&app, &center).await;
            failures = if succeeded {
                if let Some(started) = first_failure.take() {
                    ulog_info!(
                        "[NotificationCenter] sync recovered failures={} streakMs={}",
                        failures,
                        started.elapsed().as_millis()
                    );
                }
                0
            } else {
                failures.saturating_add(1)
            };
            let base = poll_interval(&app);
            let wait = if failures == 0 {
                base
            } else {
                let multiplier = 1u32 << failures.min(5);
                base.saturating_mul(multiplier).min(MAX_BACKOFF)
            };
            if failures > 0 {
                let started = first_failure.get_or_insert_with(Instant::now);
                ulog_warn!(
                    "[NotificationCenter] sync aggregate failures={} streakMs={} nextDelayMs={}",
                    failures,
                    started.elapsed().as_millis(),
                    wait.as_millis()
                );
            }
            tokio::select! {
                _ = tokio::time::sleep(wait) => {},
                _ = center.wake.notified() => {},
            }
        }
    });
}

pub fn wake(center: &ManagedNotificationCenter) {
    center.wake.notify_one();
}

/// Producer hook for a newly persisted local Agent comment. Comment success
/// never depends on notification projection; this only refreshes the shared
/// snapshot and optionally shows the same exact-route OS toast surface.
pub fn agent_comment_appended<R: tauri::Runtime>(
    app: &AppHandle<R>,
    center: &ManagedNotificationCenter,
    notification_id: &str,
) {
    emit_snapshot(app, center);
    if main_window_unfocused(app) {
        if let Some(item) = center
            .snapshot()
            .items
            .into_iter()
            .find(|item| item.id() == notification_id)
        {
            let (title, body) = toast_text(&item);
            crate::notification::show_cloud_notification(
                app,
                &title,
                &body,
                item.id().to_string(),
                item.target(),
                false,
                None,
                None,
            );
        }
    }
    center.wake.notify_one();
}

/// Clear the current projection synchronously at login/logout boundaries.
/// The following network refresh may be slow or offline; private text must not
/// survive in Renderer memory while that request is pending.
pub fn auth_boundary_changed<R: tauri::Runtime>(
    app: &AppHandle<R>,
    center: &ManagedNotificationCenter,
) {
    let auth_state = current_context()
        .map(|context| context.auth_state)
        .unwrap_or(NotificationAuthState::SignedOut);
    {
        let mut runtime = center
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.items.clear();
        runtime.next_cursor = None;
        runtime.feed_cutoff = None;
        runtime.has_unread = false;
        runtime.visible_limit = PAGE_SIZE;
        runtime.identity_key = None;
        runtime.origin_key = None;
        runtime.account_key = None;
        runtime.auth_state = auth_state;
        runtime.load_state = NotificationLoadState::Loading;
        runtime.last_synced_at = None;
        runtime.error_code = None;
        runtime.baselines.clear();
    }
    emit_snapshot(app, center);
    center.wake.notify_one();
}

#[tauri::command]
pub fn cmd_notification_get_snapshot(
    state: tauri::State<'_, ManagedNotificationCenter>,
) -> NotificationSnapshot {
    state.snapshot()
}

#[tauri::command]
pub fn cmd_notification_refresh(state: tauri::State<'_, ManagedNotificationCenter>) {
    wake(state.inner());
}

#[tauri::command]
pub async fn cmd_notification_load_more(
    app: AppHandle,
    state: tauri::State<'_, ManagedNotificationCenter>,
) -> Result<NotificationSnapshot, String> {
    let center = state.inner().clone();
    let _guard = center.sync_gate.lock().await;
    let cursor = {
        let mut runtime = center
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cursor = runtime.next_cursor.clone();
        runtime.visible_limit = runtime.visible_limit.saturating_add(PAGE_SIZE);
        if cursor.is_some() {
            runtime.is_loading_more = true;
        }
        cursor
    };
    if cursor.is_none() {
        return Ok(center.snapshot());
    }
    let context = match current_context() {
        Ok(context) => context,
        Err(error) => {
            let mut runtime = center
                .runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            runtime.is_loading_more = false;
            runtime.error_code = Some(error);
            drop(runtime);
            return Ok(center.snapshot());
        }
    };
    {
        let mut runtime = center
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if runtime.identity_key.as_deref() != Some(context.identity_key.as_str()) {
            runtime.is_loading_more = false;
            return Err("Notification identity changed".to_string());
        }
    }
    emit_snapshot(&app, &center);
    let result = fetch_page(&context, cursor.as_deref()).await;
    let mut runtime = center
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    runtime.is_loading_more = false;
    match result {
        Ok(page) if runtime.identity_key.as_deref() == Some(context.identity_key.as_str()) => {
            let page = normalized_page(
                &center,
                &context.origin_key,
                context.account_key.as_deref(),
                page,
            );
            let existing = runtime
                .items
                .iter()
                .map(|item| item.id().to_string())
                .collect::<HashSet<_>>();
            runtime.items.extend(
                page.items
                    .into_iter()
                    .filter(|item| !existing.contains(item.id())),
            );
            runtime.next_cursor = page.next_cursor;
            runtime.error_code = None;
        }
        Ok(_) => {}
        Err(error) => {
            runtime.error_code = Some(classify_error(&error));
        }
    }
    drop(runtime);
    let snapshot = center.snapshot();
    if let Err(error) = app.emit(UPDATED_EVENT, snapshot.clone()) {
        ulog_debug!(
            "[NotificationCenter] load-more update not delivered: {}",
            error
        );
    }
    Ok(snapshot)
}

fn record_announcement_read(origin: &mut CloudOriginReceipts, id: &str) {
    if !origin
        .announcements
        .ids
        .iter()
        .any(|candidate| candidate == id)
    {
        origin.announcements.ids.push(id.to_string());
        if origin.announcements.ids.len() > MAX_ANNOUNCEMENT_RECEIPTS {
            let overflow = origin
                .announcements
                .ids
                .len()
                .saturating_sub(MAX_ANNOUNCEMENT_RECEIPTS);
            origin.announcements.ids.drain(0..overflow);
        }
        origin.announcements.revision = origin.announcements.revision.saturating_add(1);
    }
}

fn record_read_receipt(
    persisted: &mut PersistedNotificationState,
    origin_key: &str,
    notification_id: &str,
    is_announcement: bool,
    account_key: Option<&str>,
) {
    let origin = persisted
        .cloud_origins
        .entry(origin_key.to_string())
        .or_default();
    if is_announcement {
        record_announcement_read(origin, notification_id);
    }
    let Some(key) = account_key else {
        return;
    };
    let account = touch_account(origin, key);
    if account.pending_ids.iter().any(|id| id == notification_id) {
        return;
    }
    if account.pending_ids.len() >= MAX_PENDING_IDS {
        // A local queue bound must never turn an explicit click into a dead
        // navigation. Keep the optimistic projection and retry capacity on a
        // later refresh; normal accounts remain far below this 90-day bound.
        ulog_warn!(
            "[NotificationCenter] pending read queue full account={} id={}",
            key,
            notification_id
        );
        return;
    }
    account.pending_ids.push(notification_id.to_string());
}

fn record_local_task_read(
    persisted: &mut PersistedNotificationState,
    notification_id: &str,
    point: NotificationSortPoint,
) {
    let already_recorded = persisted.local_tasks.points.contains_key(notification_id)
        || persisted
            .local_tasks
            .ids
            .iter()
            .any(|id| id == notification_id);
    if !already_recorded {
        persisted.local_tasks.ids.push(notification_id.to_string());
    }
    persisted
        .local_tasks
        .points
        .insert(notification_id.to_string(), point);

    // Expiry is a temporal bound, not a count bound. Amortize the scan so a
    // large burst of individually-read notifications remains O(n log n).
    if persisted.local_tasks.points.len() % 256 != 0 {
        return;
    }
    let expiry = Utc::now() - chrono::Duration::days(LOCAL_NOTIFICATION_WINDOW_DAYS);
    let expired = persisted
        .local_tasks
        .points
        .iter()
        .filter_map(|(id, point)| {
            chrono::DateTime::parse_from_rfc3339(&point.created_at)
                .ok()
                .filter(|created_at| created_at.with_timezone(&Utc) < expiry)
                .map(|_| id.clone())
        })
        .collect::<HashSet<_>>();
    if !expired.is_empty() {
        persisted.local_tasks.ids.retain(|id| !expired.contains(id));
        persisted
            .local_tasks
            .points
            .retain(|id, _| !expired.contains(id));
    }
}

fn local_task_notification_point(
    center: &NotificationCenter,
    notification_id: &str,
) -> Option<NotificationSortPoint> {
    center
        .task_store
        .agent_comment_notification_source()
        .items
        .into_iter()
        .find(|item| item.notification_id == notification_id)
        .and_then(|item| {
            chrono::DateTime::<Utc>::from_timestamp_millis(item.created_at).map(|created_at| {
                NotificationSortPoint {
                    created_at: created_at.to_rfc3339(),
                    id: item.notification_id,
                }
            })
        })
}

const TASK_RECEIPT_PERSIST_ERROR: &str = "task_receipt_persist_failed";

fn set_task_receipt_persist_error(center: &NotificationCenter, failed: bool) {
    let mut runtime = center
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if failed {
        runtime.error_code = Some(TASK_RECEIPT_PERSIST_ERROR.to_string());
    } else if runtime.error_code.as_deref() == Some(TASK_RECEIPT_PERSIST_ERROR) {
        runtime.error_code = None;
    }
}

fn persist_local_task_read(
    center: &NotificationCenter,
    notification_id: &str,
    point: NotificationSortPoint,
) -> Result<(), String> {
    mutate_persisted(center, |persisted| {
        record_local_task_read(persisted, notification_id, point);
    })
}

fn commit_local_task_read(
    center: &NotificationCenter,
    notification_id: &str,
    point: NotificationSortPoint,
) -> Result<(), String> {
    let result = persist_local_task_read(center, notification_id, point);
    set_task_receipt_persist_error(center, result.is_err());
    result
}

fn persist_receipts_best_effort(center: &NotificationCenter) {
    if let Err(error) = persist(center) {
        // The in-memory pending operation is still eligible for this process'
        // next sync. Disk availability must not block the click target.
        ulog_warn!(
            "[NotificationCenter] failed to persist notification receipt: {}",
            error
        );
    }
}

fn runtime_matches_cloud_identity(
    runtime: &RuntimeState,
    origin_key: Option<&str>,
    account_key: Option<&str>,
) -> bool {
    runtime.origin_key.as_deref() == origin_key && runtime.account_key.as_deref() == account_key
}

fn project_item_read_for_identity(
    runtime: &mut RuntimeState,
    origin_key: &str,
    account_key: Option<&str>,
    notification_id: &str,
) -> bool {
    if !runtime_matches_cloud_identity(runtime, Some(origin_key), account_key) {
        return false;
    }
    let changed = runtime
        .items
        .iter_mut()
        .find(|item| item.id() == notification_id)
        .is_some_and(|item| {
            let was_unread = !item.is_read();
            item.set_read();
            was_unread
        });
    if changed
        && runtime.items.iter().all(NotificationItem::is_read)
        && runtime.next_cursor.is_none()
    {
        runtime.has_unread = false;
    }
    changed
}

fn project_all_read_for_identity(
    runtime: &mut RuntimeState,
    origin_key: Option<&str>,
    account_key: Option<&str>,
) -> bool {
    if !runtime_matches_cloud_identity(runtime, origin_key, account_key) {
        return false;
    }
    for item in &mut runtime.items {
        item.set_read();
    }
    runtime.has_unread = false;
    true
}

async fn mark_read_local<R: tauri::Runtime>(
    app: &AppHandle<R>,
    center: &NotificationCenter,
    notification_id: &str,
) -> Result<NotificationActivation, String> {
    if notification_id.starts_with("task-comment:") {
        let item = center
            .snapshot()
            .items
            .into_iter()
            .find(|item| item.id() == notification_id)
            .filter(|item| matches!(item, NotificationItem::TaskAgentComment { .. }))
            .ok_or_else(|| "Notification is no longer available".to_string())?;
        let target = item.target();
        let point = item.point();
        if let Err(error) = commit_local_task_read(center, notification_id, point) {
            emit_snapshot(app, center);
            return Err(error);
        }
        emit_snapshot(app, center);
        return Ok(NotificationActivation {
            notification_id: notification_id.to_string(),
            target,
        });
    }
    let (target, is_announcement, origin_key, account_key) = {
        let runtime = center
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let item = runtime
            .items
            .iter()
            .find(|item| item.id() == notification_id)
            .ok_or_else(|| "Notification is no longer available".to_string())?;
        let target = item.target();
        let is_announcement = item.is_announcement();
        let origin_key = runtime
            .origin_key
            .clone()
            .ok_or_else(|| "Notification origin is no longer available".to_string())?;
        (
            target,
            is_announcement,
            origin_key,
            runtime.account_key.clone(),
        )
    };
    mutate_persisted(center, |persisted| {
        record_read_receipt(
            persisted,
            &origin_key,
            notification_id,
            is_announcement,
            account_key.as_deref(),
        );
    })?;
    {
        let mut runtime = center
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        project_item_read_for_identity(
            &mut runtime,
            &origin_key,
            account_key.as_deref(),
            notification_id,
        );
    }
    emit_snapshot(app, center);
    center.wake.notify_one();
    Ok(NotificationActivation {
        notification_id: notification_id.to_string(),
        target,
    })
}

#[tauri::command]
pub async fn cmd_notification_mark_read(
    app: AppHandle,
    state: tauri::State<'_, ManagedNotificationCenter>,
    notification_id: String,
) -> Result<NotificationActivation, String> {
    let id = notification_id.trim();
    if id.is_empty() || id.len() > 200 {
        return Err("Notification id is invalid".to_string());
    }
    mark_read_local(&app, state.inner(), id).await
}

#[tauri::command]
pub fn cmd_notification_mark_all_read(
    app: AppHandle,
    state: tauri::State<'_, ManagedNotificationCenter>,
) -> Result<NotificationSnapshot, String> {
    let center = state.inner();
    let (cloud_cutoff, origin_key, account_key) = {
        let runtime = center
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cutoff = runtime.feed_cutoff.clone();
        (
            cutoff,
            runtime.origin_key.clone(),
            runtime.account_key.clone(),
        )
    };
    let local_cutoff = {
        let persisted = center
            .persisted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        center
            .local_items(&persisted)
            .2
            .first()
            .map(NotificationItem::point)
    };
    if cloud_cutoff.is_none() && local_cutoff.is_none() {
        return Err("Notification snapshot is not ready".to_string());
    }
    if cloud_cutoff.is_some() && origin_key.is_none() {
        return Err("Notification origin is no longer available".to_string());
    }
    mutate_persisted(center, |persisted| {
        if let Some(cutoff) = local_cutoff {
            persisted.local_tasks.cutoff =
                Some(later_cutoff(persisted.local_tasks.cutoff.take(), cutoff));
        }
        if let (Some(cutoff), Some(origin_key)) = (cloud_cutoff.clone(), origin_key.as_ref()) {
            let origin = persisted
                .cloud_origins
                .entry(origin_key.clone())
                .or_default();
            origin.announcements.cutoff = Some(later_cutoff(
                origin.announcements.cutoff.take(),
                cutoff.clone(),
            ));
            origin.announcements.revision = origin.announcements.revision.saturating_add(1);
            if let Some(key) = account_key.as_deref() {
                let account = touch_account(origin, key);
                account.pending_read_all =
                    Some(later_cutoff(account.pending_read_all.take(), cutoff));
            }
        }
    })?;
    {
        let mut runtime = center
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        project_all_read_for_identity(&mut runtime, origin_key.as_deref(), account_key.as_deref());
    }
    let snapshot = center.snapshot();
    if let Err(error) = app.emit(UPDATED_EVENT, snapshot.clone()) {
        ulog_debug!(
            "[NotificationCenter] read-all update not delivered: {}",
            error
        );
    }
    center.wake.notify_one();
    Ok(snapshot)
}

fn validate_external_url(raw: &str) -> Result<String, String> {
    if raw.len() > 2048 {
        return Err("Notification URL is too long".to_string());
    }
    let parsed = url::Url::parse(raw).map_err(|_| "Notification URL is invalid".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Notification URL scheme is not allowed".to_string());
    }
    Ok(parsed.to_string())
}

#[tauri::command]
pub fn cmd_notification_open_external(url: String) -> Result<(), String> {
    let url = validate_external_url(url.trim())?;
    crate::browser::open_external(&url)
}

pub fn activate_from_toast<R: tauri::Runtime>(
    app: AppHandle<R>,
    notification_id: String,
    target: NotificationTarget,
    is_announcement: bool,
    origin_key: Option<String>,
    origin_account_key: Option<String>,
) {
    let center = app.state::<ManagedNotificationCenter>().inner().clone();
    tauri::async_runtime::spawn(async move {
        if notification_id.starts_with("task-comment:") {
            let result = local_task_notification_point(&center, &notification_id)
                .ok_or_else(|| "Task notification is no longer available".to_string())
                .and_then(|point| commit_local_task_read(&center, &notification_id, point));
            if let Err(error) = result {
                ulog_warn!(
                    "[NotificationCenter] failed to persist Task toast receipt id={}: {}",
                    notification_id,
                    error
                );
            }
            emit_snapshot(&app, &center);
            if let NotificationTarget::AppRoute { route } = target {
                let queue = app
                    .state::<crate::app_route::ManagedAppRouteQueue>()
                    .inner()
                    .clone();
                crate::app_route::enqueue(&app, &queue, route);
            }
            return;
        }
        // A delivered banner can outlive a feed refresh, logout, or account
        // switch. Its closure captures the origin account so an old private
        // toast can never be ACKed against the newly active account.
        let projection_changed = {
            let mut runtime = center
                .runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            origin_key.as_deref().is_some_and(|origin_key| {
                project_item_read_for_identity(
                    &mut runtime,
                    origin_key,
                    origin_account_key.as_deref(),
                    &notification_id,
                )
            })
        };
        if let Some(origin_key) = origin_key.as_deref() {
            let mut persisted = center
                .persisted
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            record_read_receipt(
                &mut persisted,
                origin_key,
                &notification_id,
                is_announcement,
                origin_account_key.as_deref(),
            );
        }
        persist_receipts_best_effort(&center);
        if projection_changed {
            emit_snapshot(&app, &center);
        }
        center.wake.notify_one();
        match target {
            NotificationTarget::AppRoute { route } => {
                let queue = app
                    .state::<crate::app_route::ManagedAppRouteQueue>()
                    .inner()
                    .clone();
                crate::app_route::enqueue(&app, &queue, route);
            }
            NotificationTarget::ExternalUrl { url } => match validate_external_url(&url) {
                Ok(url) => {
                    if let Err(error) = crate::browser::open_external(&url) {
                        ulog_warn!(
                            "[NotificationCenter] external target open failed: {}",
                            error
                        );
                    }
                }
                Err(error) => {
                    ulog_warn!("[NotificationCenter] rejected external target: {}", error)
                }
            },
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(created_at: &str, id: &str) -> NotificationSortPoint {
        NotificationSortPoint {
            created_at: created_at.to_string(),
            id: id.to_string(),
        }
    }

    fn announcement(id: &str) -> NotificationItem {
        serde_json::from_value(json!({
            "id": id,
            "kind": "announcement",
            "createdAt": "2026-08-16T01:00:00.000Z",
            "isRead": false,
            "summaryZh": "公告",
            "summaryOther": null,
            "target": { "kind": "external_url", "url": "https://example.com" }
        }))
        .expect("announcement")
    }

    #[test]
    fn notification_state_path_is_application_global() {
        let root = PathBuf::from("/tmp/myagents-data");
        assert_eq!(
            notification_state_path(&root),
            root.join("notification-state.json")
        );
    }

    #[test]
    fn cloud_receipts_are_origin_scoped_while_task_receipts_are_global() {
        let mut state = PersistedNotificationState::default();
        record_read_receipt(&mut state, "origin-a", "announcement-1", true, None);
        record_local_task_read(
            &mut state,
            "task-comment:1",
            point("2026-08-16T01:00:00.000Z", "task-comment:1"),
        );

        assert_eq!(
            state.cloud_origins["origin-a"].announcements.ids,
            vec!["announcement-1"]
        );
        assert!(!state.cloud_origins.contains_key("origin-b"));
        assert_eq!(state.local_tasks.ids, vec!["task-comment:1"]);
    }

    #[test]
    fn anonymous_toast_from_another_origin_cannot_mutate_current_projection() {
        let runtime = RuntimeState {
            origin_key: Some("origin-b".to_string()),
            account_key: None,
            ..RuntimeState::default()
        };

        assert!(!runtime_matches_cloud_identity(
            &runtime,
            Some("origin-a"),
            None,
        ));
        assert!(runtime_matches_cloud_identity(
            &runtime,
            Some("origin-b"),
            None,
        ));
    }

    #[test]
    fn stale_individual_read_cannot_mutate_replaced_projection() {
        let mut runtime = RuntimeState {
            origin_key: Some("origin-b".to_string()),
            account_key: Some("account-b".to_string()),
            items: vec![announcement("shared-id")],
            has_unread: true,
            ..RuntimeState::default()
        };

        assert!(!project_item_read_for_identity(
            &mut runtime,
            "origin-a",
            Some("account-a"),
            "shared-id",
        ));
        assert!(!runtime.items[0].is_read());
        assert!(runtime.has_unread);

        runtime.origin_key = Some("origin-a".to_string());
        runtime.account_key = Some("account-a".to_string());
        assert!(project_item_read_for_identity(
            &mut runtime,
            "origin-a",
            Some("account-a"),
            "shared-id",
        ));
        assert!(runtime.items[0].is_read());
        assert!(!runtime.has_unread);
    }

    #[test]
    fn stale_mark_all_cannot_mutate_replaced_projection() {
        let mut runtime = RuntimeState {
            origin_key: Some("origin-b".to_string()),
            account_key: Some("account-b".to_string()),
            items: vec![announcement("shared-id")],
            has_unread: true,
            ..RuntimeState::default()
        };

        assert!(!project_all_read_for_identity(
            &mut runtime,
            Some("origin-a"),
            Some("account-a"),
        ));
        assert!(!runtime.items[0].is_read());
        assert!(runtime.has_unread);

        runtime.origin_key = Some("origin-a".to_string());
        runtime.account_key = Some("account-a".to_string());
        assert!(project_all_read_for_identity(
            &mut runtime,
            Some("origin-a"),
            Some("account-a"),
        ));
        assert!(runtime.items[0].is_read());
        assert!(!runtime.has_unread);
    }

    #[test]
    fn cutoff_comparison_matches_cloud_tuple_semantics() {
        let cutoff = point("2026-08-16T01:00:00.000Z", "m");
        assert!(is_at_or_before(
            &point("2026-08-15T23:00:00.000Z", "z"),
            &cutoff
        ));
        assert!(is_at_or_before(
            &point("2026-08-16T01:00:00.000Z", "a"),
            &cutoff
        ));
        assert!(!is_at_or_before(
            &point("2026-08-16T01:00:00.000Z", "z"),
            &cutoff
        ));
    }

    #[test]
    fn first_authenticated_sync_never_walks_historical_pages() {
        assert!(!should_scan_next_page(Some("account"), None, false, false,));
        assert!(should_scan_next_page(None, None, false, false));
        assert!(!should_scan_next_page(None, None, true, false));
    }

    #[test]
    fn subsequent_scan_stops_only_after_unread_and_toast_boundaries_are_known() {
        let old = point("2026-08-16T01:00:00.000Z", "m");
        assert!(should_scan_next_page(
            Some("account"),
            Some(&old),
            true,
            false,
        ));
        assert!(!should_scan_next_page(
            Some("account"),
            Some(&old),
            true,
            true,
        ));
        assert!(should_scan_next_page(None, Some(&old), false, true,));
        assert!(!should_scan_next_page(None, Some(&old), true, true,));
    }

    #[test]
    fn baseline_cutoff_never_moves_backward() {
        let mut runtime = RuntimeState::default();
        let newest = point("2026-08-16T02:00:00.000Z", "z");
        let older = point("2026-08-16T01:00:00.000Z", "z");
        advance_baseline_without_toasts(&mut runtime, "account", &newest);
        advance_baseline_without_toasts(&mut runtime, "account", &older);
        assert_eq!(runtime.baselines["account"].cutoff, newest);
    }

    #[test]
    fn reminded_ids_are_process_scoped_across_identities() {
        let mut runtime = RuntimeState::default();
        let old = point("2026-08-16T01:00:00.000Z", "a");
        let newest = point("2026-08-16T02:00:00.000Z", "z");
        let item: NotificationItem = serde_json::from_value(json!({
            "id": "announcement-1",
            "kind": "announcement",
            "createdAt": "2026-08-16T02:00:00.000Z",
            "isRead": false,
            "summaryZh": "公告",
            "summaryOther": null,
            "target": { "kind": "external_url", "url": "https://example.com" }
        }))
        .expect("announcement");

        runtime.baselines.insert(
            "anonymous".to_string(),
            Baseline {
                cutoff: old.clone(),
            },
        );
        assert_eq!(
            update_baseline_and_collect_toasts(
                &mut runtime,
                "anonymous",
                &newest,
                std::slice::from_ref(&item),
            )
            .len(),
            1
        );
        runtime
            .baselines
            .insert("account".to_string(), Baseline { cutoff: old });
        assert!(
            update_baseline_and_collect_toasts(&mut runtime, "account", &newest, &[item],)
                .is_empty()
        );
    }

    #[test]
    fn second_refresh_toasts_items_after_the_first_sync_baseline() {
        let mut runtime = RuntimeState::default();
        let first = point("2026-08-16T01:00:00.000Z", "a");
        let second = point("2026-08-16T02:00:00.000Z", "z");
        let item: NotificationItem = serde_json::from_value(json!({
            "id": "announcement-new",
            "kind": "announcement",
            "createdAt": "2026-08-16T02:00:00.000Z",
            "isRead": false,
            "summaryZh": "新公告",
            "summaryOther": null,
            "target": { "kind": "external_url", "url": "https://example.com" }
        }))
        .expect("announcement");

        assert!(collect_refresh_toasts(&mut runtime, "account", &first, &[], false).is_empty());
        assert_eq!(
            collect_refresh_toasts(&mut runtime, "account", &second, &[item], true).len(),
            1
        );
    }

    #[test]
    fn persisted_shape_never_contains_private_feed_content() {
        let mut state = PersistedNotificationState::default();
        let origin = state
            .cloud_origins
            .entry("hashed-origin".into())
            .or_default();
        origin.announcements.ids.push("announcement-1".to_string());
        origin.accounts.insert(
            "hashed-account".to_string(),
            AccountPendingState {
                pending_ids: vec!["private-notification-1".to_string()],
                ..AccountPendingState::default()
            },
        );
        let json = serde_json::to_string(&state).expect("serialize");
        for forbidden in ["excerpt", "issueTitle", "actor", "target", "https://"] {
            assert!(
                !json.contains(forbidden),
                "persisted private field: {forbidden}"
            );
        }
    }

    #[test]
    fn receipt_persistence_failure_rolls_back_the_in_memory_projection() {
        let dir = tempfile::tempdir().unwrap();
        let blocked_path = dir.path().join("notification-state.json");
        std::fs::create_dir_all(&blocked_path).unwrap();
        let task_store = Arc::new(crate::task::TaskStore::new(dir.path().join("task-data")));
        let center = NotificationCenter {
            path: blocked_path,
            runtime: Mutex::new(RuntimeState::default()),
            persisted: Mutex::new(PersistedNotificationState::default()),
            sync_gate: AsyncMutex::new(()),
            wake: Notify::new(),
            task_store,
        };

        let result = commit_local_task_read(
            &center,
            "task-comment:1",
            point("2026-08-16T01:00:00.000Z", "task-comment:1"),
        );

        assert!(result.is_err());
        assert!(center
            .persisted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .local_tasks
            .ids
            .is_empty());
        assert_eq!(
            center.snapshot().error_code.as_deref(),
            Some(TASK_RECEIPT_PERSIST_ERROR)
        );
    }

    #[test]
    fn local_receipts_remain_monotonic_when_the_source_index_rotates() {
        let mut state = PersistedNotificationState::default();
        let origin = state.cloud_origins.entry("origin-a".into()).or_default();
        for index in 0..(MAX_ANNOUNCEMENT_RECEIPTS + 5) {
            record_announcement_read(origin, &format!("a-{index}"));
        }
        record_announcement_read(origin, "a-10");
        assert_eq!(origin.announcements.ids.len(), MAX_ANNOUNCEMENT_RECEIPTS);
        assert_eq!(
            origin.announcements.revision,
            (MAX_ANNOUNCEMENT_RECEIPTS + 5) as u64
        );

        for index in 0..5_005 {
            let id = format!("task-comment-{index}");
            record_local_task_read(&mut state, &id, point(&Utc::now().to_rfc3339(), &id));
        }
        record_local_task_read(
            &mut state,
            "task-comment-10",
            point(&Utc::now().to_rfc3339(), "task-comment-10"),
        );
        assert_eq!(state.local_tasks.ids.len(), 5_005);
        assert!(state
            .local_tasks
            .ids
            .iter()
            .any(|id| id == "task-comment-0"));
        assert_eq!(state.local_tasks.points.len(), 5_005);
    }

    #[test]
    fn toast_receipt_stays_bound_to_its_origin_account() {
        let mut state = PersistedNotificationState::default();
        record_read_receipt(
            &mut state,
            "origin-a",
            "private-1",
            false,
            Some("account-a"),
        );
        record_read_receipt(
            &mut state,
            "origin-a",
            "announcement-1",
            true,
            Some("account-a"),
        );
        let origin = &state.cloud_origins["origin-a"];

        assert_eq!(
            origin.accounts["account-a"].pending_ids,
            vec!["private-1", "announcement-1"]
        );
        assert!(!origin.accounts.contains_key("account-b"));
        assert_eq!(origin.announcements.ids, vec!["announcement-1"]);
    }

    #[test]
    fn anonymous_toast_receipt_never_creates_an_account_queue() {
        let mut state = PersistedNotificationState::default();
        record_read_receipt(&mut state, "origin-a", "announcement-1", true, None);
        let origin = &state.cloud_origins["origin-a"];

        assert_eq!(origin.announcements.ids, vec!["announcement-1"]);
        assert!(origin.accounts.is_empty());
    }

    #[test]
    fn external_urls_allow_only_absolute_http_and_https() {
        assert!(validate_external_url("https://myagents.io/notices/1").is_ok());
        assert!(validate_external_url("http://localhost:3000/notice").is_ok());
        for value in [
            "/notice",
            "myagents://open/v1/spaces/a/issues/b",
            "file:///tmp/x",
        ] {
            assert!(validate_external_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn deserializes_the_cloud_camel_case_feed_contract() {
        let page: FeedPage = serde_json::from_value(json!({
            "items": [
                {
                    "id": "announcement_1",
                    "kind": "announcement",
                    "createdAt": "2026-08-16T01:00:00.000Z",
                    "isRead": false,
                    "summaryZh": "系统公告",
                    "summaryOther": null,
                    "target": { "kind": "external_url", "url": "http://example.com/a" }
                },
                {
                    "id": "comment_1",
                    "kind": "space_issue_comment",
                    "createdAt": "2026-08-16T00:59:00.000Z",
                    "isRead": true,
                    "commentId": "comment-1",
                    "actor": { "type": "user", "id": "user-1", "displayName": "Ethan" },
                    "spaceId": "space-1",
                    "issue": { "id": "issue-1", "number": 7, "title": "通知中心" },
                    "excerpt": "看起来不错",
                    "target": {
                        "kind": "app_route",
                        "route": {
                            "version": 1,
                            "name": "space.issue",
                            "params": { "spaceId": "space-1", "issueId": "issue-1" }
                        }
                    }
                }
            ],
            "nextCursor": null,
            "feedCutoff": { "createdAt": "2026-08-16T01:01:00.000Z", "id": "z" },
            "hasUnread": true
        }))
        .expect("feed contract");
        assert_eq!(page.items.len(), 2);
        assert!(matches!(
            page.items[1].target(),
            NotificationTarget::AppRoute { .. }
        ));
    }
}
