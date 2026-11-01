//! Stable Task destination resolution belongs to the existing Channel owner.
use super::{
    channel_handoff::channel_owner,
    channel_messaging::{configured_channels, ChannelCapability},
    config_store,
    types::ImHealthState,
    ManagedAgents, ManagedImBots,
};
use crate::task::notification::{ConversationRef, NotificationTarget, RecentPrivate};

pub(crate) fn channel(id: &str) -> Result<ChannelCapability, String> {
    let mut matches = configured_channels().into_iter().filter(|c| c.id == id);
    let channel = matches
        .next()
        .ok_or("Notification Channel no longer exists")?;
    if matches.next().is_some() {
        return Err("Notification Channel identity is ambiguous".into());
    }
    Ok(channel)
}

pub(crate) async fn validate_target(
    target: &NotificationTarget,
    allowed: Option<&[String]>,
    agents: Option<&ManagedAgents>,
    bots: Option<&ManagedImBots>,
) -> Result<(), String> {
    let channel_id = match target {
        NotificationTarget::Off => return Ok(()),
        NotificationTarget::Current => {
            return Err("current must be resolved from an active conversation".into())
        }
        NotificationTarget::Conversation { address } => {
            let config = channel(&address.channel_id)?;
            let known = if let Ok(owner) = channel_owner(agents, bots, &address.channel_id).await {
                owner
                    .notification_peer(&address.session_key)
                    .await
                    .is_some()
            } else {
                std::fs::read(&config.health_path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<ImHealthState>(&bytes).ok())
                    .is_some_and(|h| {
                        h.active_sessions
                            .iter()
                            .any(|p| p.session_key == address.session_key)
                    })
            };
            if !known {
                return Err("sessionKey is not a known conversation on this Channel".into());
            }
            address.channel_id.clone()
        }
        NotificationTarget::RecentPrivate {
            target: RecentPrivate::Channel { channel_id },
        } => channel_id.clone(),
        NotificationTarget::RecentPrivate {
            target: RecentPrivate::Agent { agent_id },
        } => {
            let channels: Vec<_> = configured_channels()
                .into_iter()
                .filter(|c| c.agent_id.as_deref() == Some(agent_id))
                .collect();
            if channels.is_empty()
                || channels
                    .iter()
                    .any(|c| allowed.is_some_and(|ids| !ids.contains(&c.id)))
            {
                return Err(
                    "Notification Agent is unavailable or outside the caller's Agent".into(),
                );
            }
            return Ok(());
        }
    };
    channel(&channel_id)?;
    if allowed.is_some_and(|ids| !ids.contains(&channel_id)) {
        return Err("Notification Channel does not belong to the caller's Agent".into());
    }
    Ok(())
}

pub(crate) async fn resolve_target(
    target: &NotificationTarget,
    agents: Option<&ManagedAgents>,
    bots: Option<&ManagedImBots>,
) -> Result<Option<ConversationRef>, String> {
    match target {
        NotificationTarget::Off => Ok(None),
        NotificationTarget::Current => Err("Unresolved current notification target".into()),
        NotificationTarget::Conversation { address } => {
            channel(&address.channel_id)?;
            Ok(Some(address.clone()))
        }
        NotificationTarget::RecentPrivate {
            target: RecentPrivate::Channel { channel_id },
        } => {
            channel(channel_id)?;
            let Ok(owner) = channel_owner(agents, bots, channel_id).await else {
                return Ok(None);
            };
            Ok(owner
                .latest_notification_private()
                .await
                .map(|key| ConversationRef {
                    channel_id: channel_id.clone(),
                    session_key: key,
                }))
        }
        NotificationTarget::RecentPrivate {
            target: RecentPrivate::Agent { agent_id },
        } => {
            if !configured_channels()
                .iter()
                .any(|c| c.agent_id.as_deref() == Some(agent_id))
            {
                return Err("Notification Agent no longer exists".into());
            }
            let Some(agents) = agents else {
                return Ok(None);
            };
            Ok(
                match config_store::resolve_agent_heartbeat_route(agents, agent_id).await {
                    config_store::AgentHeartbeatRouteResolution::Target(route) => {
                        Some(ConversationRef {
                            channel_id: route.target.channel_id,
                            session_key: route.target.session_key,
                        })
                    }
                    _ => None,
                },
            )
        }
    }
}

/// Read-only destination description. Configuration/peer health are projections,
/// not a promise that the platform will accept the eventual send.
pub(crate) fn describe_policy(
    policy: Option<&crate::task::NotificationConfig>,
) -> serde_json::Value {
    let events = crate::task::notification::effective_events(policy);
    let mut description = describe_destination(policy);
    description["executionResultsSubscribed"] = serde_json::json!(events.iter().any(|e| e == "execution"));
    description["events"] = serde_json::json!(events);
    description
}

fn describe_destination(policy: Option<&crate::task::NotificationConfig>) -> serde_json::Value {
    use serde_json::json;
    let Some(policy) = policy else {
        return json!({"label":"IM off","availability":"off"});
    };
    if let Some(error) = &policy.error {
        return json!({"label":"Unavailable destination","availability":"unavailable","reason":error});
    }
    let id = match policy.im.as_ref() {
        None | Some(NotificationTarget::Off) => {
            return json!({"label":"IM off","availability":"off"})
        }
        Some(NotificationTarget::Current) => {
            return json!({"label":"Unresolved source","availability":"unavailable"})
        }
        Some(NotificationTarget::RecentPrivate {
            target: RecentPrivate::Agent { agent_id },
        }) => {
            let config = config_store::read_agent_configs_from_disk()
                .into_iter()
                .find(|a| a.id == *agent_id);
            return match config {
                Some(agent) => {
                    json!({"label":format!("{} / recent private chat across channels", agent.name),"availability":if agent.channels.is_empty() { "unavailable" } else { "configured" }})
                }
                None => json!({"label":agent_id,"availability":"unavailable"}),
            };
        }
        Some(NotificationTarget::Conversation { address }) => &address.channel_id,
        Some(NotificationTarget::RecentPrivate {
            target: RecentPrivate::Channel { channel_id },
        }) => channel_id,
    };
    let channel = match channel(id) {
        Ok(channel) => channel,
        Err(error) => return json!({"label":id,"availability":"unavailable","reason":error}),
    };
    let name = channel.name.as_deref().unwrap_or(id);
    let health = std::fs::read(&channel.health_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ImHealthState>(&bytes).ok());
    let label = match &policy.im {
        Some(NotificationTarget::Conversation { address }) => {
            let peer = health.as_ref().and_then(|h| {
                h.active_sessions
                    .iter()
                    .find(|p| p.session_key == address.session_key)
            });
            if peer.is_none() {
                return json!({"label":format!("{name} / {}", address.session_key),"availability":"unconfirmed","reason":"Conversation is not present in the last saved Channel snapshot"});
            }
            let peer = peer.unwrap();
            format!(
                "{name} / {}",
                peer.source_display_name
                    .as_deref()
                    .or(peer.source_id.as_deref())
                    .unwrap_or(&address.session_key)
            )
        }
        _ => format!("{name} / recent private chat"),
    };
    json!({"label":label,"availability":"configured","deliveryMode":channel.mode})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::NotificationConfig;

    #[test]
    fn notification_policy_projection_separates_target_and_event_filter() {
        let default = describe_policy(None);
        assert_eq!(default["availability"], "off");
        assert_eq!(default["executionResultsSubscribed"], true);
        assert_eq!(default["events"], serde_json::json!(["execution", "done", "blocked", "endCondition"]));
        for events in [vec![], vec!["done".into()], vec!["execution".into()]] {
            let policy = NotificationConfig { events: Some(events.clone()), ..Default::default() };
            let projection = describe_policy(Some(&policy));
            assert_eq!(projection["availability"], "off");
            assert_eq!(projection["executionResultsSubscribed"], events.iter().any(|e| e == "execution"));
            assert_eq!(projection["events"], serde_json::json!(events));
        }
    }
}
