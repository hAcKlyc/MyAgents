//! Fixed owned-community intents. Account authority stays in the existing owner;
//! renderer scope is only a stale-request fence and cannot supply a bearer/URL.
use super::NetworkError;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) fn canonical_issuer(value: &str) -> Result<String, NetworkError> {
    let url = url::Url::parse(value).map_err(|_| NetworkError::new("OWNED_SERVICE_UNAVAILABLE"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["", "/"].contains(&url.path())
    {
        return Err(NetworkError::new("OWNED_SERVICE_UNAVAILABLE"));
    }
    Ok(url.origin().ascii_serialization())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CommunityScope {
    pub connection_id: String,
    pub principal_id: String,
    pub binding_id: String,
}
impl CommunityScope {
    pub(crate) fn matches(&self, connection: &str, principal: &str, binding: &str) -> bool {
        self.connection_id == connection
            && self.principal_id == principal
            && self.binding_id == binding
            && !binding.is_empty()
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CommunityRequest {
    List {},
    Detail {
        topic_id: String,
    },
    Create {
        mutation_id: String,
        category: String,
        title: String,
        content: String,
    },
    Reply {
        mutation_id: String,
        topic_id: String,
        content: String,
    },
}
fn invalid() -> NetworkError {
    NetworkError::new("REQUEST_INVALID")
}
fn uuid(value: &str) -> Result<(), NetworkError> {
    if uuid::Uuid::parse_str(value)
        .map(|v| v.to_string())
        .as_deref()
        == Ok(value)
    {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn text(value: &str, max: usize) -> Result<(), NetworkError> {
    if value.trim().is_empty() || value.chars().count() > max {
        Err(invalid())
    } else {
        Ok(())
    }
}
impl CommunityRequest {
    pub(crate) fn route(&self) -> Result<(Method, String, Option<Value>), NetworkError> {
        Ok(match self {
            Self::List {} => (Method::GET, "/api/community".into(), None),
            Self::Detail { topic_id } => {
                uuid(topic_id)?;
                (Method::GET, format!("/api/community/{topic_id}"), None)
            }
            Self::Create {
                mutation_id,
                category,
                title,
                content,
            } => {
                uuid(mutation_id)?;
                text(title, 120)?;
                text(content, 8000)?;
                if !["discussion", "question", "showcase"].contains(&category.as_str()) {
                    return Err(invalid());
                }
                (
                    Method::POST,
                    "/api/community".into(),
                    Some(
                        json!({"mutation_id":mutation_id,"category":category,"title":title,"content":content}),
                    ),
                )
            }
            Self::Reply {
                mutation_id,
                topic_id,
                content,
            } => {
                uuid(mutation_id)?;
                uuid(topic_id)?;
                text(content, 4000)?;
                (
                    Method::POST,
                    format!("/api/community/{topic_id}/replies"),
                    Some(json!({"mutation_id":mutation_id,"content":content})),
                )
            }
        })
    }
    /// Forward only known business fields, never a server-provided auth payload.
    pub(crate) fn response(&self, value: Value) -> Result<Value, NetworkError> {
        let invalid = || NetworkError::new("OWNED_RESPONSE_INVALID");
        if value.get("ok") != Some(&Value::Bool(true)) {
            return Err(invalid());
        }
        let data = value.get("data").cloned().ok_or_else(invalid)?;
        let result = match self {
            Self::List {} => {
                #[derive(Deserialize, Serialize)]
                struct Items {
                    items: Vec<Topic>,
                }
                let list: Items = serde_json::from_value(data).map_err(|_| invalid())?;
                if list.items.len() > 100 || !list.items.iter().all(Topic::valid) {
                    return Err(invalid());
                }
                serde_json::to_value(list)
            }
            Self::Detail { topic_id } => {
                #[derive(Deserialize, Serialize)]
                struct Detail {
                    topic: Topic,
                    replies: Vec<Reply>,
                }
                let detail: Detail = serde_json::from_value(data).map_err(|_| invalid())?;
                if detail.topic.id != *topic_id
                    || !detail.topic.valid()
                    || detail.replies.len() > 200
                    || !detail.replies.iter().all(Reply::valid)
                {
                    return Err(invalid());
                }
                serde_json::to_value(detail)
            }
            Self::Create { .. } => {
                let topic: Topic = serde_json::from_value(data).map_err(|_| invalid())?;
                if !topic.valid() {
                    return Err(invalid());
                }
                serde_json::to_value(topic)
            }
            Self::Reply { .. } => {
                let reply: Reply = serde_json::from_value(data).map_err(|_| invalid())?;
                if !reply.valid() {
                    return Err(invalid());
                }
                serde_json::to_value(reply)
            }
        };
        result.map_err(|_| invalid())
    }
}
#[derive(Serialize, Deserialize)]
struct Topic {
    id: String,
    category: String,
    title: String,
    content: String,
    author_name: String,
    created_at: i64,
    updated_at: i64,
    revision: u64,
    reply_count: u64,
    is_owner: bool,
    pinned: bool,
    locked: bool,
    visibility: String,
}
impl Topic {
    fn valid(&self) -> bool {
        uuid(&self.id).is_ok()
            && text(&self.title, 120).is_ok()
            && text(&self.content, 8000).is_ok()
            && self.author_name.len() <= 512
            && ["discussion", "question", "showcase", "announcement"]
                .contains(&self.category.as_str())
            && ["published", "hidden"].contains(&self.visibility.as_str())
    }
}
#[derive(Serialize, Deserialize)]
struct Reply {
    id: String,
    content: String,
    author_name: String,
    created_at: i64,
}
impl Reply {
    fn valid(&self) -> bool {
        uuid(&self.id).is_ok() && text(&self.content, 4000).is_ok() && self.author_name.len() <= 512
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    #[test]
    fn issuer_is_a_fixed_https_origin() {
        assert_eq!(
            canonical_issuer("https://cloud.test:443/").unwrap(),
            "https://cloud.test"
        );
        for value in [
            "http://cloud.test",
            "https://a:b@cloud.test",
            "https://cloud.test/community",
            "https://cloud.test/?token=x",
            "https://cloud.test/#x",
        ] {
            assert!(canonical_issuer(value).is_err());
        }
    }
    #[test]
    fn intents_cannot_supply_routes_or_credentials() {
        for value in [
            json!({"kind":"list","url":"https://evil.test"}),
            json!({"kind":"list","token":"secret"}),
            json!({"kind":"list","method":"POST"}),
            json!({"kind":"admin"}),
        ] {
            assert!(serde_json::from_value::<CommunityRequest>(value).is_err());
        }
        for id in ["../auth/session", "https://evil.test", "x?y", ""] {
            assert!(CommunityRequest::Detail {
                topic_id: id.into()
            }
            .route()
            .is_err());
        }
    }
    #[test]
    fn write_limits_count_unicode_and_preserve_receipt_body() {
        let request = CommunityRequest::Create {
            mutation_id: ID.into(),
            category: "discussion".into(),
            title: "😀".repeat(120),
            content: "中".repeat(8000),
        };
        let (method, path, body) = request.route().unwrap();
        assert_eq!(method, Method::POST);
        assert_eq!(path, "/api/community");
        assert!(serde_json::to_vec(&body).unwrap().len() > 16 * 1024);
        assert_eq!(body.as_ref().unwrap()["mutation_id"], ID);
        assert!(CommunityRequest::Reply {
            mutation_id: ID.into(),
            topic_id: ID.into(),
            content: "x".repeat(4001)
        }
        .route()
        .is_err());
    }
    #[test]
    fn response_is_bounded_and_projects_only_business_fields() {
        let topic = json!({"id":ID,"category":"discussion","title":"T","content":"中".repeat(8000),"author_name":"member","created_at":1,"updated_at":1,"revision":1,"reply_count":0,"is_owner":true,"pinned":false,"locked":false,"visibility":"published","accessToken":"not-forwarded"});
        let mut list = vec![topic; 100];
        let projected = CommunityRequest::List {}
            .response(json!({"ok":true,"data":{"items":list}}))
            .unwrap();
        assert!(serde_json::to_vec(&projected).unwrap().len() > 128 * 1024);
        assert!(projected["items"][0].get("accessToken").is_none());
        list.push(list[0].clone());
        assert!(CommunityRequest::List {}
            .response(json!({"ok":true,"data":{"items":list}}))
            .is_err());
    }
    #[test]
    fn scope_rejects_same_principal_new_binding_or_other_account() {
        let scope = CommunityScope {
            connection_id: "a".into(),
            principal_id: ID.into(),
            binding_id: "old".into(),
        };
        assert!(scope.matches("a", ID, "old"));
        assert!(!scope.matches("a", ID, "new"));
        assert!(!scope.matches("b", ID, "old"));
        assert!(!scope.matches("a", "another", "old"));
    }
}
