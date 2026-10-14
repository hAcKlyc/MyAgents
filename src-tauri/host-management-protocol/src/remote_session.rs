//! Closed same-account session projection. No filesystem, provider, or caller overrides.
use crate::{CanonicalUuid, CodecError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub const REMOTE_SESSION_BYTES: usize = 48 * 1024;
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RemoteSessionRequest {
    Capabilities {
        agent_id: String,
    },
    List {
        agent_id: String,
        limit: u8,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "optional_string"
        )]
        before: Option<String>,
    },
    Get {
        agent_id: String,
        session_id: String,
        limit: u8,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "optional_string"
        )]
        before: Option<String>,
    },
    Start {
        agent_id: String,
        operation_id: CanonicalUuid,
        text: String,
    },
    Send {
        agent_id: String,
        session_id: String,
        operation_id: CanonicalUuid,
        text: String,
    },
    Receipt {
        agent_id: String,
        operation_id: CanonicalUuid,
    },
    Respond {
        agent_id: String,
        session_id: String,
        operation_id: CanonicalUuid,
        generation: String,
        turn_id: String,
        request_id: String,
        interaction: RemoteInteractionKind,
        approved: bool,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "optional_answers"
        )]
        answers: Option<BTreeMap<String, String>>,
    },
    Stop {
        agent_id: String,
        session_id: String,
        operation_id: CanonicalUuid,
        generation: String,
        turn_id: String,
    },
}
fn optional_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}
fn optional_answers<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<BTreeMap<String, String>>, D::Error> {
    BTreeMap::deserialize(d).map(Some)
}
fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(d)
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteInteractionKind {
    Permission,
    Plan,
    Question,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteMessageRole {
    User,
    Assistant,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteToolStatus {
    Running,
    Complete,
    Error,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteSessionState {
    Idle,
    Running,
    WaitingUserAction,
    Unavailable,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteTerminal {
    Complete,
    Stopped,
    Error,
    Interrupted,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteReceiptStatus {
    Processing,
    Accepted,
    Rejected,
    Unconfirmed,
    NotFound,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteTool {
    pub id: String,
    pub name: String,
    pub status: RemoteToolStatus,
    pub summary: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteMessage {
    pub id: String,
    pub role: RemoteMessageRole,
    pub timestamp: String,
    pub content: String,
    pub truncated: bool,
    pub tools: Vec<RemoteTool>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteQuestion {
    pub answer_key: String,
    pub question: String,
    pub options: Vec<String>,
    pub multi_select: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteInteraction {
    pub actionable: bool,
    pub request_id: String,
    pub generation: String,
    pub turn_id: String,
    pub interaction: RemoteInteractionKind,
    pub title: String,
    pub description: String,
    pub questions: Vec<RemoteQuestion>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSessionItem {
    pub session_id: String,
    pub title: String,
    pub updated_at: String,
    pub preview: String,
    pub runtime: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RemoteSessionResult {
    Capabilities {
        version: u8,
        agent_id: String,
        runtime: String,
        max_active_sessions: u8,
        live_updates: String,
    },
    List {
        agent_id: String,
        items: Vec<RemoteSessionItem>,
        has_more: bool,
        #[serde(deserialize_with = "nullable")]
        next_before: Option<String>,
    },
    Snapshot {
        agent_id: String,
        session_id: String,
        #[serde(deserialize_with = "nullable")]
        generation: Option<String>,
        #[serde(deserialize_with = "nullable")]
        turn_id: Option<String>,
        revision: String,
        state: RemoteSessionState,
        title: String,
        runtime: String,
        #[serde(deserialize_with = "nullable")]
        model: Option<String>,
        #[serde(deserialize_with = "nullable")]
        terminal: Option<RemoteTerminal>,
        messages: Vec<RemoteMessage>,
        interactions: Vec<RemoteInteraction>,
        has_more_before: bool,
        #[serde(deserialize_with = "nullable")]
        next_before: Option<String>,
    },
    Receipt {
        agent_id: String,
        operation_id: CanonicalUuid,
        #[serde(deserialize_with = "nullable")]
        session_id: Option<String>,
        status: RemoteReceiptStatus,
        #[serde(deserialize_with = "nullable")]
        code: Option<String>,
    },
    Error {
        code: String,
    },
}
fn length(s: &str, n: usize) -> bool {
    s.encode_utf16().count() <= n
}
fn id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}
fn session(s: &str) -> bool {
    !s.is_empty() && s.len() <= 99 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn code(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}
fn bounded<T: Serialize>(v: &T) -> bool {
    serde_json::to_vec(v).is_ok_and(|b| b.len() <= REMOTE_SESSION_BYTES)
}
impl RemoteSessionRequest {
    pub fn agent_id(&self) -> &str {
        match self {
            Self::Capabilities { agent_id }
            | Self::List { agent_id, .. }
            | Self::Get { agent_id, .. }
            | Self::Start { agent_id, .. }
            | Self::Send { agent_id, .. }
            | Self::Receipt { agent_id, .. }
            | Self::Respond { agent_id, .. }
            | Self::Stop { agent_id, .. } => agent_id,
        }
    }
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::Get { session_id, .. }
            | Self::Send { session_id, .. }
            | Self::Respond { session_id, .. }
            | Self::Stop { session_id, .. } => Some(session_id),
            _ => None,
        }
    }
    pub fn operation_id(&self) -> Option<CanonicalUuid> {
        match self {
            Self::Start { operation_id, .. }
            | Self::Send { operation_id, .. }
            | Self::Receipt { operation_id, .. }
            | Self::Respond { operation_id, .. }
            | Self::Stop { operation_id, .. } => Some(*operation_id),
            _ => None,
        }
    }
    pub fn mutation(&self) -> bool {
        matches!(
            self,
            Self::Start { .. } | Self::Send { .. } | Self::Respond { .. } | Self::Stop { .. }
        )
    }
    pub fn validate(&self) -> Result<(), CodecError> {
        let valid = id(self.agent_id())
            && self.session_id().is_none_or(session)
            && match self {
                Self::List { limit, before, .. } | Self::Get { limit, before, .. } => {
                    (1..=30).contains(limit) && before.as_ref().is_none_or(|s| length(s, 256))
                }
                Self::Start { text, .. } | Self::Send { text, .. } => {
                    !text.is_empty() && length(text, 8000)
                }
                Self::Respond {
                    generation,
                    turn_id,
                    request_id,
                    answers,
                    ..
                } => {
                    id(generation)
                        && id(turn_id)
                        && id(request_id)
                        && answers.as_ref().is_none_or(|a| {
                            a.iter().all(|(k, v)| length(k, 512) && length(v, 4000))
                        })
                }
                Self::Stop {
                    generation,
                    turn_id,
                    ..
                } => id(generation) && id(turn_id),
                _ => true,
            };
        if valid && bounded(self) {
            Ok(())
        } else {
            Err(CodecError::InvalidFrame)
        }
    }
    pub fn matches_result(&self, result: &RemoteSessionResult) -> bool {
        if matches!(result, RemoteSessionResult::Error { .. }) {
            return true;
        }
        match (self, result) {
            (
                Self::Capabilities { agent_id },
                RemoteSessionResult::Capabilities { agent_id: got, .. },
            )
            | (Self::List { agent_id, .. }, RemoteSessionResult::List { agent_id: got, .. }) => {
                agent_id == got
            }
            (
                Self::Get {
                    agent_id,
                    session_id,
                    ..
                },
                RemoteSessionResult::Snapshot {
                    agent_id: got,
                    session_id: sid,
                    ..
                },
            ) => agent_id == got && session_id == sid,
            (
                _,
                RemoteSessionResult::Receipt {
                    agent_id,
                    operation_id,
                    session_id,
                    ..
                },
            ) => {
                self.operation_id() == Some(*operation_id)
                    && self.agent_id() == agent_id
                    && self
                        .session_id()
                        .is_none_or(|sid| session_id.as_deref() == Some(sid))
            }
            _ => false,
        }
    }
}
impl RemoteSessionResult {
    pub fn validate(&self) -> Result<(), CodecError> {
        let valid = match self {
            Self::Capabilities {
                version,
                agent_id,
                runtime,
                max_active_sessions,
                live_updates,
            } => {
                *version == 1
                    && id(agent_id)
                    && length(runtime, 64)
                    && (1..=100).contains(max_active_sessions)
                    && live_updates == "snapshot"
            }
            Self::List {
                agent_id,
                items,
                next_before,
                ..
            } => {
                id(agent_id)
                    && items.len() <= 30
                    && next_before.as_ref().is_none_or(|s| length(s, 256))
                    && items.iter().all(|s| {
                        session(&s.session_id)
                            && length(&s.title, 256)
                            && length(&s.updated_at, 64)
                            && length(&s.preview, 512)
                            && length(&s.runtime, 64)
                    })
            }
            Self::Snapshot {
                agent_id,
                session_id,
                generation,
                turn_id,
                revision,
                title,
                runtime,
                model,
                messages,
                interactions,
                next_before,
                ..
            } => {
                id(agent_id)
                    && session(session_id)
                    && generation.as_deref().is_none_or(id)
                    && turn_id.as_deref().is_none_or(id)
                    && length(revision, 128)
                    && length(title, 256)
                    && length(runtime, 64)
                    && model.as_ref().is_none_or(|s| length(s, 256))
                    && next_before.as_ref().is_none_or(|s| length(s, 256))
                    && messages.len() <= 30
                    && interactions.len() <= 8
                    && messages.iter().all(|m| {
                        id(&m.id)
                            && length(&m.timestamp, 64)
                            && length(&m.content, 16000)
                            && m.tools.len() <= 10
                            && m.tools.iter().all(|t| {
                                id(&t.id) && length(&t.name, 160) && length(&t.summary, 2000)
                            })
                    })
                    && interactions.iter().all(|i| {
                        id(&i.request_id)
                            && id(&i.generation)
                            && id(&i.turn_id)
                            && length(&i.title, 256)
                            && length(&i.description, 4000)
                            && i.questions.len() <= 6
                            && i.questions.iter().all(|q| {
                                length(&q.answer_key, 512)
                                    && length(&q.question, 512)
                                    && q.options.len() <= 8
                                    && q.options.iter().all(|s| length(s, 256))
                            })
                    })
            }
            Self::Receipt {
                agent_id,
                session_id,
                code: err,
                ..
            } => {
                id(agent_id)
                    && session_id.as_deref().is_none_or(session)
                    && err.as_deref().is_none_or(code)
            }
            Self::Error { code: err } => code(err),
        };
        if valid && bounded(self) {
            Ok(())
        } else {
            Err(CodecError::InvalidFrame)
        }
    }
}
