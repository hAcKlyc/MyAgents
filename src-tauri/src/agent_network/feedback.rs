//! Fixed owned-feedback intents. Account authority stays in the existing owner;
//! renderer scope is only a stale-request fence and cannot supply a bearer/URL.
use super::community::{invalid, text, uuid, CommunityScope};
use super::NetworkError;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const FEEDBACK_PATH: &str = "/api/feedback";

pub(crate) type FeedbackScope = CommunityScope;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum FeedbackRequest {
    List {},
    Create {
        mutation_id: String,
        category: String,
        title: String,
        description: String,
    },
}

impl FeedbackRequest {
    pub(crate) fn route(&self) -> Result<(Method, String, Option<Value>), NetworkError> {
        Ok(match self {
            Self::List {} => (Method::GET, FEEDBACK_PATH.into(), None),
            Self::Create {
                mutation_id,
                category,
                title,
                description,
            } => {
                uuid(mutation_id)?;
                if !["bug", "suggestion", "help"].contains(&category.as_str()) {
                    return Err(invalid());
                }
                text(title, 120)?;
                text(description, 8000)?;
                (
                    Method::POST,
                    FEEDBACK_PATH.into(),
                    Some(json!({
                        "mutation_id": mutation_id,
                        "category": category,
                        "title": title,
                        "description": description,
                    })),
                )
            }
        })
    }

    /// Forward only the fields the desktop renders, never a server-provided auth payload.
    pub(crate) fn response(&self, value: Value) -> Result<Value, NetworkError> {
        let invalid_response = || NetworkError::new("OWNED_RESPONSE_INVALID");
        if value.get("ok") != Some(&Value::Bool(true)) {
            return Err(invalid_response());
        }
        let data = value.get("data").cloned().ok_or_else(invalid_response)?;
        let result = match self {
            Self::List {} => {
                #[derive(Deserialize, Serialize)]
                struct Items {
                    items: Vec<Feedback>,
                }
                let list: Items = serde_json::from_value(data).map_err(|_| invalid_response())?;
                if list.items.len() > 100 || !list.items.iter().all(Feedback::valid) {
                    return Err(invalid_response());
                }
                serde_json::to_value(list)
            }
            Self::Create { .. } => {
                let feedback: Feedback =
                    serde_json::from_value(data).map_err(|_| invalid_response())?;
                if !feedback.valid() {
                    return Err(invalid_response());
                }
                serde_json::to_value(feedback)
            }
        };
        result.map_err(|_| invalid_response())
    }
}

#[derive(Serialize, Deserialize)]
struct Feedback {
    id: String,
    title: String,
    description: String,
    category: String,
    status: String,
    revision: u64,
    created_at: i64,
    updated_at: i64,
    events: Vec<FeedbackEvent>,
}

impl Feedback {
    fn valid(&self) -> bool {
        uuid(&self.id).is_ok()
            && text(&self.title, 120).is_ok()
            && text(&self.description, 8000).is_ok()
            && ["bug", "suggestion", "help"].contains(&self.category.as_str())
            && ["new", "in_progress", "resolved"].contains(&self.status.as_str())
            && self.events.iter().all(FeedbackEvent::valid)
    }
}

#[derive(Serialize, Deserialize)]
struct FeedbackEvent {
    id: String,
    kind: String,
    status: Option<String>,
    reply: Option<String>,
    created_at: i64,
}

impl FeedbackEvent {
    fn valid(&self) -> bool {
        uuid(&self.id).is_ok()
            && self.kind.len() <= 64
            && self
                .status
                .as_deref()
                .is_none_or(|s| ["new", "in_progress", "resolved"].contains(&s))
            && self.reply.as_deref().is_none_or(|r| text(r, 4000).is_ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn intents_cannot_supply_routes_or_credentials() {
        for value in [
            json!({"kind":"list","url":"https://evil.test"}),
            json!({"kind":"list","token":"secret"}),
            json!({"kind":"list","method":"POST"}),
            json!({"kind":"admin"}),
            json!({"kind":"detail","feedbackId":ID}),
        ] {
            assert!(serde_json::from_value::<FeedbackRequest>(value).is_err());
        }
    }

    #[test]
    fn create_uses_fixed_path_and_only_known_fields() {
        let request = FeedbackRequest::Create {
            mutation_id: ID.into(),
            category: "bug".into(),
            title: "保存后界面未更新".into(),
            description: "中".repeat(8000),
        };
        let (method, path, body) = request.route().unwrap();
        assert_eq!(method, Method::POST);
        assert_eq!(path, FEEDBACK_PATH);
        let body = body.unwrap();
        let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["category", "description", "mutation_id", "title"]);
    }

    #[test]
    fn create_rejects_bad_category_mutation_and_limits() {
        let valid = |category: &str, title: String, description: String, mutation: &str| {
            FeedbackRequest::Create {
                mutation_id: mutation.into(),
                category: category.into(),
                title,
                description,
            }
            .route()
            .is_ok()
        };
        assert!(!valid("announcement", "t".into(), "d".into(), ID));
        assert!(!valid("bug", "t".into(), "d".into(), "not-a-uuid"));
        assert!(!valid("bug", "  ".into(), "d".into(), ID));
        assert!(!valid("bug", "😀".repeat(121), "d".into(), ID));
        assert!(!valid("bug", "t".into(), "中".repeat(8001), ID));
        assert!(valid("help", "😀".repeat(120), "中".repeat(8000), ID));
    }

    #[test]
    fn list_response_is_bounded_and_drops_unknown_fields() {
        let request = FeedbackRequest::List {};
        let record = json!({
            "id": ID,
            "principal_id": "someone-else",
            "title": "t",
            "description": "d",
            "category": "help",
            "app_version": null,
            "status": "new",
            "revision": 1,
            "created_at": 1,
            "updated_at": 1,
            "events": [],
        });
        let out = request
            .response(json!({"ok": true, "data": {"items": [record]}}))
            .unwrap();
        let item = &out["items"][0];
        assert!(item.get("principal_id").is_none());
        assert!(item.get("app_version").is_none());
        let too_many: Vec<_> = (0..101).map(|_| json!({})).collect();
        assert!(request
            .response(json!({"ok": true, "data": {"items": too_many}}))
            .is_err());
        assert!(request
            .response(json!({"ok": false, "data": {"items": []}}))
            .is_err());
    }
}
