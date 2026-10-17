use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalMutationErrorCode {
    StaleRevision,
    StaleTurn,
    TurnConflict,
    Terminal,
    GoalChanged,
    GoalError,
    StoreCorrupt,
}

impl GoalMutationErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StaleRevision => "stale_revision",
            Self::StaleTurn => "stale_turn",
            Self::TurnConflict => "turn_conflict",
            Self::Terminal => "terminal",
            Self::GoalChanged => "goal_changed",
            Self::GoalError => "goal_error",
            Self::StoreCorrupt => "store_corrupt",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalMutationError {
    code: GoalMutationErrorCode,
    message: String,
}

impl GoalMutationError {
    pub fn new(code: GoalMutationErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code.as_str()
    }

    pub fn goal(message: impl Into<String>) -> Self {
        Self::new(GoalMutationErrorCode::GoalError, message)
    }

    pub fn store_corrupt(message: impl Into<String>) -> Self {
        Self::new(GoalMutationErrorCode::StoreCorrupt, message)
    }

    pub fn stale_revision(detail: impl AsRef<str>) -> Self {
        Self::new(GoalMutationErrorCode::StaleRevision, detail.as_ref())
    }

    pub fn stale_turn(detail: impl AsRef<str>) -> Self {
        Self::new(GoalMutationErrorCode::StaleTurn, detail.as_ref())
    }

    pub fn turn_conflict(detail: impl AsRef<str>) -> Self {
        Self::new(GoalMutationErrorCode::TurnConflict, detail.as_ref())
    }

    pub fn terminal(detail: impl AsRef<str>) -> Self {
        Self::new(GoalMutationErrorCode::Terminal, detail.as_ref())
    }

    pub fn goal_changed(detail: impl AsRef<str>) -> Self {
        Self::new(GoalMutationErrorCode::GoalChanged, detail.as_ref())
    }
}

impl std::fmt::Display for GoalMutationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.code == GoalMutationErrorCode::GoalError {
            formatter.write_str(&self.message)
        } else {
            write!(formatter, "{}: {}", self.code.as_str(), self.message)
        }
    }
}

impl std::error::Error for GoalMutationError {}

impl From<String> for GoalMutationError {
    fn from(message: String) -> Self {
        Self::goal(message)
    }
}

impl From<&str> for GoalMutationError {
    fn from(message: &str) -> Self {
        Self::goal(message)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Paused,
    Complete,
    Blocked,
    Canceled,
}

impl GoalStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Complete | Self::Blocked | Self::Canceled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalTerminalActor {
    Model,
    User,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalTurnKind {
    UserQuery,
    Continuation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalTurnAuthority {
    pub queue_id: String,
    pub kind: GoalTurnKind,
    pub turn_number: u32,
    pub sidecar_generation: u64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalDeliveryOutboxItem {
    pub id: String,
    pub text: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalEndConditions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_executions: Option<u32>,
    #[serde(default = "default_true")]
    pub ai_can_exit: bool,
}

impl Default for GoalEndConditions {
    fn default() -> Self {
        Self {
            deadline: None,
            max_executions: None,
            ai_can_exit: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGoalConfig {
    pub workspace_path: String,
    pub session_id: String,
    pub objective: String,
    #[serde(default)]
    pub end_conditions: GoalEndConditions,
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    #[serde(default)]
    pub permission_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionGoal {
    pub id: String,
    pub workspace_path: String,
    pub session_id: String,
    pub objective: String,
    pub status: GoalStatus,
    pub end_conditions: GoalEndConditions,
    pub notify_enabled: bool,
    pub permission_mode: String,
    pub turn_count: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub total_duration_ms: u64,
    #[serde(default)]
    pub total_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_executed_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    pub revision: u64,
    pub control_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn: Option<GoalTurnAuthority>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delivery_outbox: Vec<GoalDeliveryOutboxItem>,
    pub consecutive_failures: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionGoalView {
    pub id: String,
    pub workspace_path: String,
    pub session_id: String,
    pub objective: String,
    pub status: GoalStatus,
    pub end_conditions: GoalEndConditions,
    pub notify_enabled: bool,
    pub permission_mode: String,
    pub turn_count: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub total_duration_ms: u64,
    pub total_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_executed_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    pub revision: u64,
    pub control_revision: u64,
    pub is_executing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_number: Option<u32>,
}

impl SessionGoal {
    pub fn is_terminal(&self) -> bool {
        self.status.is_terminal()
    }

    pub fn protects_session_identity(&self) -> bool {
        !self.is_terminal() || self.current_turn.is_some() || !self.delivery_outbox.is_empty()
    }

    pub fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }

    pub fn bump_control_revision(&mut self) {
        self.control_revision = self.control_revision.saturating_add(1);
    }

    pub fn view(&self) -> SessionGoalView {
        SessionGoalView {
            id: self.id.clone(),
            workspace_path: self.workspace_path.clone(),
            session_id: self.session_id.clone(),
            objective: self.objective.clone(),
            status: self.status.clone(),
            end_conditions: self.end_conditions.clone(),
            notify_enabled: self.notify_enabled,
            permission_mode: self.permission_mode.clone(),
            turn_count: self.turn_count,
            created_at: self.created_at,
            updated_at: self.updated_at,
            total_duration_ms: self.total_duration_ms,
            total_tokens: self.total_tokens,
            last_executed_at: self.last_executed_at,
            terminal_reason: self.terminal_reason.clone(),
            revision: self.revision,
            control_revision: self.control_revision,
            is_executing: self.current_turn.is_some(),
            execution_number: self.current_turn.as_ref().map(|turn| turn.turn_number),
        }
    }
}

#[derive(Debug, Clone)]
pub struct GoalContinuationRequest {
    pub goal: SessionGoal,
    pub queue_id: String,
    pub turn_number: u32,
    pub expected_control_revision: u64,
}

#[derive(Debug, Clone)]
pub struct GoalTurnFinalization {
    pub goal: SessionGoal,
    pub applied: bool,
    pub delivery_enqueued: bool,
}

#[derive(Debug, Clone)]
pub struct GoalTurnFinalizationRequest {
    pub success: bool,
    pub code: Option<String>,
    pub error: Option<String>,
    pub output_text: Option<String>,
    pub duration_ms: u64,
    pub consumed_tokens: u64,
    pub channel_delivery_expected: bool,
}

#[derive(Debug, Clone)]
pub enum GoalTerminalOutcome {
    Applied(SessionGoal),
    AlreadyTerminal(SessionGoal),
}

impl GoalTerminalOutcome {
    pub fn goal(&self) -> &SessionGoal {
        match self {
            Self::Applied(goal) | Self::AlreadyTerminal(goal) => goal,
        }
    }
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::SessionGoal;

    #[test]
    fn legacy_goal_shape_defaults_terminal_totals_to_zero() {
        let goal: SessionGoal = serde_json::from_value(serde_json::json!({
            "id": "goal-1",
            "workspacePath": "/tmp/workspace",
            "sessionId": "session-1",
            "objective": "ship it",
            "status": "complete",
            "endConditions": { "aiCanExit": true },
            "notifyEnabled": true,
            "permissionMode": "",
            "turnCount": 2,
            "createdAt": "2026-07-12T00:00:00Z",
            "updatedAt": "2026-07-12T00:02:00Z",
            "revision": 4,
            "controlRevision": 2,
            "consecutiveFailures": 0
        }))
        .expect("pre-summary Goal data should remain readable");

        assert_eq!(goal.total_duration_ms, 0);
        assert_eq!(goal.total_tokens, 0);
        assert_eq!(goal.view().total_duration_ms, 0);
        assert_eq!(goal.view().total_tokens, 0);
    }
}
