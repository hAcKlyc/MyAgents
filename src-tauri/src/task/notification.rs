//! Task-owned notification policy and durable delivery records. No business
//! scheduling or Session configuration is owned here.
use super::*;
use crate::im::channel_messaging::configured_channels;

pub const VERSION: u32 = 1;
pub const MAX_PENDING: usize = 32;
pub const MAX_RETAINED: usize = 32;
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
pub const DEFAULT_EVENTS: &[&str] = &["execution", "done", "blocked", "endCondition"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationRef {
    pub channel_id: String,
    pub session_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "scope", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RecentPrivate {
    Channel {
        #[serde(rename = "channelId")]
        channel_id: String,
    },
    Agent {
        #[serde(rename = "agentId")]
        agent_id: String,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    try_from = "serde_json::Value"
)]
pub enum NotificationTarget {
    #[default]
    Off,
    Conversation {
        #[serde(flatten)]
        address: ConversationRef,
    },
    RecentPrivate {
        #[serde(flatten)]
        target: RecentPrivate,
    },
    /// Input convenience, resolved before TaskStore publication.
    Current,
}

impl TryFrom<serde_json::Value> for NotificationTarget {
    type Error = String;
    fn try_from(value: serde_json::Value) -> Result<Self, String> {
        let object = value
            .as_object()
            .ok_or("Notification target must be an object")?;
        let field = |name: &str| {
            value
                .get(name)
                .and_then(|v| v.as_str())
                .filter(|v| !v.trim().is_empty())
                .map(str::to_string)
                .ok_or_else(|| format!("Notification target requires {name}"))
        };
        let (target, keys): (Self, &[&str]) = match field("type")?.as_str() {
            "off" => (Self::Off, &["type"]),
            "current" => (Self::Current, &["type"]),
            "conversation" => (
                Self::Conversation {
                    address: ConversationRef {
                        channel_id: field("channelId")?,
                        session_key: field("sessionKey")?,
                    },
                },
                &["type", "channelId", "sessionKey"],
            ),
            "recent-private" => match field("scope")?.as_str() {
                "channel" => (
                    Self::RecentPrivate {
                        target: RecentPrivate::Channel {
                            channel_id: field("channelId")?,
                        },
                    },
                    &["type", "scope", "channelId"],
                ),
                "agent" => (
                    Self::RecentPrivate {
                        target: RecentPrivate::Agent {
                            agent_id: field("agentId")?,
                        },
                    },
                    &["type", "scope", "agentId"],
                ),
                _ => return Err("Unknown recent-private scope".into()),
            },
            _ => return Err("Unknown notification target type".into()),
        };
        if object.keys().any(|key| !keys.contains(&key.as_str())) {
            return Err("Unexpected notification target field".into());
        }
        Ok(target)
    }
}

#[derive(Debug, Clone, Default)]
pub struct CreationContext {
    pub conversation: Option<ConversationRef>,
    pub parent_policy: Option<NotificationConfig>,
    pub allowed_channels: Option<Vec<String>>,
}

impl CreationContext {
    /// A verified parent execution already owns its recipient authority. Only
    /// a newly selected destination is constrained by the executing Agent.
    pub fn selection_scope(&self, policy: &NotificationConfig) -> Option<&[String]> {
        if self.parent_policy.is_some() && policy.source.as_deref() == Some("parent-task") {
            None
        } else {
            self.allowed_channels.as_deref()
        }
    }
}

/// Legacy migration is intentionally configuration-only: offline channels still
/// have an identity. Ambiguous/deleted owners remain visible diagnostics.
pub fn migrate_legacy(config: NotificationConfig) -> NotificationConfig {
    if config.version == Some(VERSION) {
        return config;
    }
    if config.bot_channel_id.as_deref().is_none_or(str::is_empty) {
        migrate_legacy_with_channels(config, &[])
    } else {
        migrate_legacy_with_channels(config, &configured_channels())
    }
}

fn migrate_legacy_with_channels(
    mut config: NotificationConfig,
    channels: &[crate::im::channel_messaging::ChannelCapability],
) -> NotificationConfig {
    config.error = None;
    config.channel_owner = None;
    config.im = Some(match config.bot_channel_id.as_deref() {
        None | Some("") => NotificationTarget::Off,
        Some(id) => {
            let matches: Vec<_> = channels.iter().filter(|c| c.id == id).collect();
            if matches.len() != 1 {
                config.error = Some(format!("Legacy notification channel {id} is missing or ambiguous; select a destination."));
                NotificationTarget::Off
            } else if let Some(agent_id) = &matches[0].agent_id {
                NotificationTarget::RecentPrivate {
                    target: RecentPrivate::Agent {
                        agent_id: agent_id.clone(),
                    },
                }
            } else {
                NotificationTarget::RecentPrivate {
                    target: RecentPrivate::Channel {
                        channel_id: id.into(),
                    },
                }
            }
        }
    });
    let events = config
        .events
        .get_or_insert_with(|| vec!["done".into(), "blocked".into(), "endCondition".into()]);
    if !events.iter().any(|e| e == "execution") {
        events.push("execution".into());
    }
    config.version = Some(VERSION);
    config.source = Some("legacy".into());
    config.bot_channel_id = None;
    config.bot_thread = None;
    config
}

pub fn normalize_create(
    input: Option<NotificationConfig>,
    context: &CreationContext,
) -> Result<NotificationConfig, String> {
    let mut config = input.unwrap_or_else(|| NotificationConfig {
        desktop_explicit: false,
        ..Default::default()
    });
    if config.version.is_some_and(|v| v != VERSION) {
        return Err("Unsupported notification version".into());
    }
    let legacy = config.bot_channel_id.is_some() || config.bot_thread.is_some();
    if legacy && config.im.is_some() {
        return Err("Do not mix notification.im and legacy bot fields".into());
    }
    if !config.desktop_explicit {
        config.desktop = context
            .parent_policy
            .as_ref()
            .map(|p| p.desktop)
            .unwrap_or(true);
    }
    if config.events.is_none() {
        config.events = context
            .parent_policy
            .as_ref()
            .and_then(|p| p.events.clone());
    }
    if legacy {
        config.version = None;
        config = migrate_legacy(config);
        if let Some(error) = &config.error {
            return Err(error.clone());
        }
    } else {
        let (target, source) = match config.im.take() {
            Some(NotificationTarget::Current) => (
                NotificationTarget::Conversation {
                    address: context
                        .conversation
                        .clone()
                        .ok_or("No current Channel conversation is available")?,
                },
                "current",
            ),
            Some(target) => (target, "explicit"),
            None if context.parent_policy.is_some() => (
                context
                    .parent_policy
                    .as_ref()
                    .and_then(|p| p.im.clone())
                    .unwrap_or_default(),
                "parent-task",
            ),
            None if context.conversation.is_some() => (
                NotificationTarget::Conversation {
                    address: context.conversation.clone().unwrap(),
                },
                "conversation",
            ),
            None => (NotificationTarget::Off, "default"),
        };
        config.im = Some(target);
        config.source = Some(source.into());
        config.version = Some(VERSION);
        config.error = None;
    }
    if config.source.as_deref() == Some("parent-task") {
        config.channel_owner = context
            .parent_policy
            .as_ref()
            .and_then(|p| p.channel_owner.clone());
    }
    validate(&config)?;
    Ok(config)
}

pub fn normalize_replacement(
    mut config: NotificationConfig,
    existing: Option<&NotificationConfig>,
) -> Result<NotificationConfig, String> {
    validate(&config)?;
    if config.im.is_none() && config.bot_channel_id.is_none() && config.bot_thread.is_none() {
        if let Some(existing) = existing {
            let existing = migrate_legacy(existing.clone());
            config.im = existing.im;
            config.channel_owner = existing.channel_owner;
            config.source = existing.source;
            config.error = existing.error;
            if !config.desktop_explicit {
                config.desktop = existing.desktop;
            }
            if config.events.is_none() {
                config.events = existing.events;
            }
            // Old replacement inputs retain the old execution subscription.
            if config.version.is_none() {
                if let Some(events) = &mut config.events {
                    if !events.iter().any(|event| event == "execution") {
                        events.push("execution".into());
                    }
                }
            }
            config.version = Some(VERSION);
            return Ok(config);
        }
    }
    if config.im.is_none() && config.version.is_none() {
        let migrated = migrate_legacy(config);
        if let Some(error) = &migrated.error {
            return Err(error.clone());
        }
        return Ok(migrated);
    }
    if matches!(config.im, Some(NotificationTarget::Current)) {
        return Err(
            "current requires a live source context; provide an explicit conversation".into(),
        );
    }
    config.version = Some(VERSION);
    if existing.is_some_and(|old| old.im == config.im) {
        config.channel_owner = existing.and_then(|old| old.channel_owner.clone());
        config.source = existing.and_then(|old| old.source.clone());
        config.error = existing.and_then(|old| old.error.clone());
    } else {
        freeze_channel_owner(&mut config)?;
        config.source = Some("explicit".into());
        config.error = None;
    }
    Ok(config)
}

pub fn freeze_channel_owner(config: &mut NotificationConfig) -> Result<(), String> {
    let id = match config.im.as_ref() {
        Some(NotificationTarget::Conversation { address }) => Some(&address.channel_id),
        Some(NotificationTarget::RecentPrivate {
            target: RecentPrivate::Channel { channel_id },
        }) => Some(channel_id),
        _ => None,
    };
    config.channel_owner = id
        .map(|id| crate::im::task_notification::channel(id).map(|c| c.agent_id))
        .transpose()?
        .flatten();
    Ok(())
}

pub fn validate(config: &NotificationConfig) -> Result<(), String> {
    if config.version.is_some_and(|v| v != VERSION) {
        return Err("Unsupported notification version".into());
    }
    if config.im.is_some() && (config.bot_channel_id.is_some() || config.bot_thread.is_some()) {
        return Err("Do not mix notification.im and legacy bot fields".into());
    }
    if let Some(events) = &config.events {
        if events.iter().any(|event| {
            ![
                "execution",
                "done",
                "blocked",
                "stopped",
                "verifying",
                "endCondition",
            ]
            .contains(&event.as_str())
        }) {
            return Err("Unknown notification event".into());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DeliveryState {
    Waiting,
    Preparing,
    Prepared,
    Sending,
    Sent,
    HandedOff,
    Suppressed,
    Failed,
    Unknown,
    Partial,
    Cancelled,
}
impl DeliveryState {
    pub fn pending(self) -> bool {
        matches!(
            self,
            Self::Waiting | Self::Preparing | Self::Prepared | Self::Sending
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDelivery {
    pub id: String,
    pub events: Vec<String>,
    pub policy: NotificationConfig,
    pub state: DeliveryState,
    pub created_at: i64,
    pub updated_at: i64,
    pub title: String,
    pub result: String,
    pub execution_session_id: Option<String>,
    pub target: Option<ConversationRef>,
    /// Ownership must remain stable even if a connection is reassigned later.
    pub agent_id: Option<String>,
    pub target_session_id: Option<String>,
    pub attempt_id: Option<String>,
    pub prepared_text: Option<String>,
    pub message_ids: Vec<String>,
    pub accepted_parts: usize,
    pub error: Option<String>,
    pub retry_at: Option<i64>,
}

pub fn effective_events(policy: Option<&NotificationConfig>) -> Vec<String> {
    policy.and_then(|p| p.events.clone())
        .unwrap_or_else(|| DEFAULT_EVENTS.iter().map(|s| (*s).into()).collect())
}

/// State and cause are independent facts of one transition, not competing events.
pub fn transition_events(t: &StatusTransition) -> Vec<&'static str> {
    let mut events = Vec::new();
    if let Some(event) = match t.to {
        TaskStatus::Done => Some("done"),
        TaskStatus::Blocked => Some("blocked"),
        TaskStatus::Stopped => Some("stopped"),
        TaskStatus::Verifying => Some("verifying"),
        _ => None,
    } {
        events.push(event);
    }
    if t.source == Some(TransitionSource::EndCondition) {
        events.push("endCondition");
    }
    events
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionReason {
    DeliveryRecorded,
    DesktopOnly,
    NotSubscribed,
    Disabled,
    InternalTask,
}

/// Immutable settlement evidence; delivery progress stays in notificationDeliveries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDecision {
    pub events: Vec<String>,
    pub subscribed_events: Vec<String>,
    pub reason: DecisionReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_id: Option<String>,
}

/// Called inside the original Task mutation, before its atomic persist. This
/// coalesces execution and terminal subscriptions into one notification intent.
pub fn record_event(
    task: &mut Task,
    transition: Option<&StatusTransition>,
    execution: Option<(&str, Option<&str>)>,
) -> Option<NotificationDelivery> {
    if task.deleted {
        return None;
    }
    let internal = matches!(
        task.managed_kind.as_deref(),
        Some(MANAGED_KIND_MEMORY_GARDENER | MANAGED_KIND_MEMORY_MOLT)
    ) || task.dispatch_origin == TaskDispatchOrigin::AttachedSession;
    let mut policy = task
        .notification
        .clone()
        .map(migrate_legacy)
        .unwrap_or_default();
    let subscribed = effective_events(Some(&policy));
    let mut events = Vec::new();
    if execution.is_some() {
        events.push("execution".to_string());
    }
    if let Some(transition) = transition {
        events.extend(transition_events(transition).into_iter().map(str::to_string));
    }
    let finish = |task: &mut Task, reason, delivery: Option<NotificationDelivery>| {
        if execution.is_some() {
            if let Some(run) = task.last_execution.as_mut() {
                run.notification = Some(NotificationDecision {
                    events: events.clone(),
                    subscribed_events: subscribed.clone(),
                    reason,
                    delivery_id: delivery.as_ref()
                        .filter(|_| reason == DecisionReason::DeliveryRecorded)
                        .map(|d| d.id.clone()),
                });
            }
        }
        delivery
    };
    if internal {
        // Keep domain-managed jobs quiet unless an existing explicit IM policy
        // opted in. Public source defaults never enter these creation paths.
        if policy
            .im
            .as_ref()
            .is_none_or(|target| matches!(target, NotificationTarget::Off))
        {
            return finish(task, DecisionReason::InternalTask, None);
        }
        policy.desktop = false;
    }
    if !events.iter().any(|e| subscribed.contains(e)) {
        return finish(task, DecisionReason::NotSubscribed, None);
    }
    let now = now_ms();
    let result = execution
        .map(|e| {
            if e.0.trim().is_empty() {
                format!(
                    "Task execution {}. See the execution Session for details.",
                    if task.last_execution.as_ref().is_some_and(|run| run.success) {
                        "completed without a text result"
                    } else {
                        "failed"
                    }
                )
            } else {
                e.0.to_string()
            }
        })
        .unwrap_or_else(|| {
            transition
                .and_then(|t| t.message.clone())
                .unwrap_or_default()
        });
    let title = format!(
        "任务「{}」{}",
        task.name,
        if execution.is_some() {
            "执行结束"
        } else {
            transition.map(|t| t.to.as_str()).unwrap_or("状态更新")
        }
    );
    let mut delivery = NotificationDelivery {
        id: Uuid::new_v4().to_string(),
        events: events.clone(),
        policy,
        state: DeliveryState::Waiting,
        created_at: now,
        updated_at: now,
        title,
        result,
        execution_session_id: execution.and_then(|e| e.1.map(str::to_string)),
        target: None,
        agent_id: None,
        target_session_id: None,
        attempt_id: None,
        prepared_text: None,
        message_ids: Vec::new(),
        accepted_parts: 0,
        error: None,
        retry_at: None,
    };
    if delivery
        .policy
        .im
        .as_ref()
        .is_none_or(|t| matches!(t, NotificationTarget::Off))
        && delivery.policy.error.is_none()
    {
        return if delivery.policy.desktop {
            finish(task, DecisionReason::DesktopOnly, Some(delivery))
        } else {
            finish(task, DecisionReason::Disabled, None)
        };
    }
    if delivery.result.len() > MAX_TEXT_BYTES
        || task
            .notification_deliveries
            .iter()
            .filter(|d| d.state.pending())
            .count()
            >= MAX_PENDING
    {
        delivery.state = DeliveryState::Failed;
        delivery.error = Some(
            "Notification capacity exceeded; business result is retained in its execution Session"
                .into(),
        );
        delivery.result.clear();
    } else if let Some(error) = &delivery.policy.error {
        delivery.state = DeliveryState::Failed;
        delivery.error = Some(error.clone());
    }
    let terminal_count = task
        .notification_deliveries
        .iter()
        .filter(|d| !d.state.pending())
        .count();
    let mut remove = terminal_count.saturating_sub(MAX_RETAINED - 1);
    task.notification_deliveries.retain(|d| {
        if !d.state.pending() && remove > 0 {
            remove -= 1;
            false
        } else {
            true
        }
    });
    task.notification_deliveries.push(delivery.clone());
    finish(task, DecisionReason::DeliveryRecorded, Some(delivery))
}

pub fn recover(task: &mut Task) -> bool {
    let mut changed = false;
    for d in &mut task.notification_deliveries {
        if matches!(d.state, DeliveryState::Preparing | DeliveryState::Sending) {
            d.state = DeliveryState::Unknown;
            d.error = Some("Application restarted during preparation or delivery; verify before explicitly resending".into());
            d.updated_at = now_ms();
            changed = true;
        } else if d.state == DeliveryState::Prepared {
            // Old clients prepared platform text but had not started sending.
            // The new owner hands the original event to the Session instead.
            d.state = DeliveryState::Waiting;
            d.prepared_text = None;
            d.attempt_id = None;
            changed = true;
        } else if d.attempt_id.take().is_some() {
            changed = true;
        }
    }
    changed
}

pub fn cancel_unstarted(task: &mut Task) {
    for d in &mut task.notification_deliveries {
        if d.state.pending() && d.state != DeliveryState::Sending {
            d.state = DeliveryState::Cancelled;
            d.attempt_id = None;
            d.updated_at = now_ms();
        }
    }
}

/// Preparation facts from the authenticated target Session. Transport callers
/// authenticate the Session; the Task owner settles the exact current attempt.
pub(crate) struct PreparationReceipt<'a> {
    pub outcome: Option<&'a str>,
    pub text: Option<&'a str>,
    pub error: Option<&'a str>,
}

impl TaskStore {
    pub(crate) async fn settle_notification_preparation(
        &self,
        task_id: &str,
        delivery_id: &str,
        attempt_id: &str,
        session_id: &str,
        receipt: PreparationReceipt<'_>,
    ) -> Result<NotificationDelivery, String> {
        self.mutate_notification(task_id, delivery_id, Some(attempt_id), |d| {
            if d.state != DeliveryState::Preparing
                || d.target_session_id.as_deref() != Some(session_id)
            {
                return Err("Notification attempt is no longer current".into());
            }
            d.error = receipt.error.map(str::to_string);
            match receipt.outcome {
                Some("handed-off") => {
                    d.state = DeliveryState::HandedOff;
                    d.attempt_id = None;
                    d.error = None;
                }
                Some("suppressed") => d.state = DeliveryState::Suppressed,
                Some("binding_changed" | "offline") => {
                    d.state = DeliveryState::Waiting;
                    d.attempt_id = None;
                    d.target_session_id = None;
                    d.retry_at = Some(now_ms() + 5_000);
                }
                Some("unknown") => d.state = DeliveryState::Unknown,
                Some("complete") => {
                    let text = receipt.text.unwrap_or("");
                    if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES {
                        d.state = DeliveryState::Failed;
                        d.error = Some(
                            "Notification preparation returned empty or oversized text".into(),
                        );
                    } else {
                        d.prepared_text = Some(text.into());
                        d.state = DeliveryState::Prepared;
                    }
                    d.attempt_id = None;
                }
                _ => {
                    d.state = DeliveryState::Failed;
                    d.attempt_id = None;
                }
            }
            Ok(())
        })
        .await
    }

    /// Exact-attempt CAS. No caller can publish a late receipt into another
    /// attempt; no lock is retained across platform or model I/O.
    pub(crate) async fn mutate_notification(
        &self,
        task_id: &str,
        delivery_id: &str,
        expected_attempt: Option<&str>,
        mutate: impl FnOnce(&mut NotificationDelivery) -> Result<(), String>,
    ) -> Result<NotificationDelivery, String> {
        self.ensure_writable()?;
        let mut inner = self.inner.write().await;
        let mut next = inner.clone();
        let task = next.get_mut(task_id).ok_or("Task not found")?;
        let d = task
            .notification_deliveries
            .iter_mut()
            .find(|d| d.id == delivery_id)
            .ok_or("Notification not found")?;
        if expected_attempt.is_some() && d.attempt_id.as_deref() != expected_attempt {
            return Err("Notification attempt is no longer current".into());
        }
        if task.deleted && d.state != DeliveryState::Sending {
            return Err("Task was deleted".into());
        }
        mutate(d)?;
        d.updated_at = now_ms();
        let updated = d.clone();
        Self::persist_locked(&self.jsonl_path, &next)?;
        *inner = next;
        drop(inner);
        emit_task_event("task:updated", serde_json::json!({"taskId":task_id}));
        Ok(updated)
    }

    pub async fn operate_notification(
        &self,
        task_id: &str,
        delivery_id: &str,
        action: &str,
    ) -> Result<NotificationDelivery, String> {
        self.mutate_notification(task_id, delivery_id, None, |d| {
            if matches!(action, "retry" | "resend") && d.result.is_empty() && d.error.as_deref().is_some_and(|error| error.starts_with("Notification capacity exceeded")) { return Err("This result exceeded the notification limit; inspect the execution Session. The business task will not be rerun.".into()); }
            match action {
                "cancel" if !matches!(d.state, DeliveryState::Sending | DeliveryState::Sent | DeliveryState::HandedOff) => { d.state = DeliveryState::Cancelled; d.attempt_id = None; }
                "retry" if matches!(d.state, DeliveryState::Failed | DeliveryState::Waiting | DeliveryState::Suppressed) && (d.attempt_id.is_none() || d.state == DeliveryState::Suppressed) => { d.state = DeliveryState::Waiting; d.attempt_id = None; d.prepared_text = None; d.error = None; d.retry_at = None; }
                "resend" if matches!(d.state, DeliveryState::Unknown | DeliveryState::Partial) => { d.state = DeliveryState::Waiting; d.prepared_text = None; d.attempt_id = None; d.error = None; d.retry_at = None; }
                _ => return Err("This notification cannot perform that action; unknown/partial delivery requires explicit resend (may duplicate)".into()),
            }
            Ok(())
        }).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn policy(value: serde_json::Value) -> NotificationConfig {
        serde_json::from_value(value).unwrap()
    }
    fn conversation() -> ConversationRef {
        ConversationRef {
            channel_id: "feishu-1".into(),
            session_key: "group:one".into(),
        }
    }
    fn channel(agent: Option<&str>) -> crate::im::channel_messaging::ChannelCapability {
        crate::im::channel_messaging::ChannelCapability {
            id: "bot".into(),
            platform: crate::im::types::ImPlatform::Feishu,
            name: None,
            mode: crate::im::types::ChannelDeliveryMode::Auto,
            group_activation: None,
            agent_id: agent.map(str::to_string),
            health_path: PathBuf::new(),
        }
    }
    #[test]
    fn wire_targets_roundtrip_without_a_dynamic_persisted_default() {
        for value in [
            json!({"type":"off"}),
            json!({"type":"conversation","channelId":"a","sessionKey":"private:1"}),
            json!({"type":"recent-private","scope":"channel","channelId":"a"}),
            json!({"type":"recent-private","scope":"agent","agentId":"a"}),
        ] {
            let target: NotificationTarget = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(target).unwrap(), value);
        }
        assert!(serde_json::from_value::<NotificationTarget>(
            json!({"type":"conversation","channelId":"a"})
        )
        .is_err());
        assert!(serde_json::from_value::<NotificationTarget>(
            json!({"type":"off","channelId":"a"})
        )
        .is_err());
        assert!(serde_json::from_value::<NotificationConfig>(json!({"version":99})).is_err());
    }
    #[test]
    fn ordinary_and_team_use_exact_source_parent_and_explicit_field_precedence() {
        let context = CreationContext {
            conversation: Some(conversation()),
            ..Default::default()
        };
        let source = normalize_create(None, &context).unwrap();
        assert_eq!(
            source.im,
            Some(NotificationTarget::Conversation {
                address: conversation()
            })
        );
        assert_eq!(source.source.as_deref(), Some("conversation"));
        let parent = policy(json!({"version":1,"desktop":false,"im":{"type":"off"},"events":[]}));
        let context = CreationContext {
            parent_policy: Some(parent),
            ..context
        };
        let inherited = normalize_create(None, &context).unwrap();
        assert!(!inherited.desktop);
        assert_eq!(inherited.events, Some(vec![]));
        assert_eq!(inherited.im, Some(NotificationTarget::Off));
        let explicit = normalize_create(
            Some(policy(json!({"desktop":true,"im":{"type":"current"}}))),
            &context,
        )
        .unwrap();
        assert!(explicit.desktop);
        assert_eq!(explicit.events, Some(vec![]));
        assert_eq!(explicit.im, source.im);
        let no_context = CreationContext::default();
        assert_eq!(
            normalize_create(None, &no_context).unwrap().im,
            Some(NotificationTarget::Off)
        );
        assert!(
            normalize_create(Some(policy(json!({"im":{"type":"current"}}))), &no_context).is_err()
        );
        assert!(serde_json::from_value::<NotificationConfig>(
            json!({"im":{"type":"off"},"botChannelId":"a"})
        )
        .is_err());
    }
    #[test]
    fn legacy_effective_scope_is_preserved_and_missing_owners_remain_visible() {
        for (agent, expected) in [
            (
                Some("agent"),
                json!({"type":"recent-private","scope":"agent","agentId":"agent"}),
            ),
            (
                None,
                json!({"type":"recent-private","scope":"channel","channelId":"bot"}),
            ),
        ] {
            let migrated = migrate_legacy_with_channels(
                policy(
                    json!({"desktop":false,"botChannelId":"bot","botThread":"unused","events":[]}),
                ),
                &[channel(agent)],
            );
            assert!(!migrated.desktop);
            assert_eq!(serde_json::to_value(migrated.im).unwrap(), expected);
            assert_eq!(migrated.events, Some(vec!["execution".into()]));
            assert!(migrated.bot_thread.is_none());
        }
        for channels in [vec![], vec![channel(Some("one")), channel(Some("two"))]] {
            let migrated =
                migrate_legacy_with_channels(policy(json!({"botChannelId":"bot"})), &channels);
            assert!(migrated.error.is_some());
            assert_eq!(migrated.im, Some(NotificationTarget::Off));
        }
        let off =
            migrate_legacy_with_channels(policy(json!({"botThread":"not-a-destination"})), &[]);
        assert_eq!(off.im, Some(NotificationTarget::Off));
    }
    #[test]
    fn verified_parent_authority_survives_a_different_execution_agent() {
        for im in [
            json!({"type":"conversation","channelId":"other","sessionKey":"private:1"}),
            json!({"type":"recent-private","scope":"agent","agentId":"other-agent"}),
        ] {
            let context = CreationContext {
                parent_policy: Some(policy(json!({"version":1,"im":im}))),
                allowed_channels: Some(vec!["execution-channel".into()]),
                ..Default::default()
            };
            let inherited = normalize_create(None, &context).unwrap();
            assert_eq!(serde_json::to_value(&inherited.im).unwrap(), im);
            assert!(context.selection_scope(&inherited).is_none());
            let explicit =
                normalize_create(Some(policy(json!({"version":1,"im":im}))), &context).unwrap();
            assert_eq!(
                context.selection_scope(&explicit),
                Some(["execution-channel".into()].as_slice())
            );
        }
    }
    #[test]
    fn replacement_omission_preserves_destination_but_explicit_clear_does_not() {
        let existing = policy(
            json!({"version":1,"desktop":false,"im":{"type":"conversation","channelId":"other","sessionKey":"private:1"},"source":"conversation"}),
        );
        for input in [
            json!({"desktop":true}),
            json!({"version":1,"desktop":true}),
            json!({"version":1,"events":[]}),
        ] {
            let updated = normalize_replacement(policy(input), Some(&existing)).unwrap();
            assert_eq!(updated.im, existing.im);
            assert_eq!(updated.source, existing.source);
        }
        for input in [
            json!({"version":1,"im":{"type":"off"}}),
            json!({"version":1,"im":null}),
            json!({"botChannelId":null}),
        ] {
            let updated = normalize_replacement(policy(input), Some(&existing)).unwrap();
            assert_eq!(updated.im, Some(NotificationTarget::Off));
        }
    }
    #[test]
    fn patches_preserve_target_and_new_empty_events_mean_none() {
        let source = normalize_create(
            None,
            &CreationContext {
                conversation: Some(conversation()),
                ..Default::default()
            },
        )
        .unwrap();
        let patch: TaskNotificationPatch =
            serde_json::from_value(json!({"version":1,"desktop":false,"events":[]})).unwrap();
        let updated = patch.apply(Some(source.clone())).unwrap();
        assert_eq!(updated.im, source.im);
        assert_eq!(updated.events, Some(vec![]));
        assert!(!updated.desktop);
        let legacy: TaskNotificationPatch = serde_json::from_value(json!({"events":[]})).unwrap();
        assert_eq!(
            legacy.apply(Some(source)).unwrap().events,
            Some(vec!["execution".into()])
        );
    }
}

/// Resolve the input-only convenience before validating a patch. The caller
/// obtains this context from authenticated host admission, never user JSON.
pub(crate) fn resolve_update_current(
    input: &mut TaskUpdateInput,
    context: &CreationContext,
) -> Result<(), String> {
    let target = if let Some(config) = &mut input.notification {
        config.im.as_mut()
    } else if let Some(patch) = &mut input.notification_patch {
        match &mut patch.im {
            NotificationFieldPatch::Set(target) => Some(target),
            _ => None,
        }
    } else {
        None
    };
    if let Some(target @ NotificationTarget::Current) = target {
        *target = NotificationTarget::Conversation {
            address: context
                .conversation
                .clone()
                .ok_or("No current Channel conversation is available")?,
        };
    }
    Ok(())
}
