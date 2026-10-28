//! Read projection of Channel membership and existing Session bindings.
//! A configured identity is visible before it has a routable conversation.
use crate::im::{
    access::AccessMode,
    channel_messaging::{binding_target, ChannelCapability},
    platform_capabilities::supports_access_control,
    types::{
        ChannelConfigRust, GroupPermissionStatus, ImActiveSession, ImPlatform, ImSourceType,
        PeerSessionHistory,
    },
};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Peer {
    id: String,
    session_key: Option<String>,
    source_type: ImSourceType,
    source_id: String,
    name: Option<String>,
    session_id: Option<String>,
    session_ids: Vec<String>,
    has_profile: bool,
    access: Option<&'static str>,
}

// Only existing adapter address contracts can bridge legacy records without
// observed sender metadata. In particular, native Feishu chat_id is NOT open_id.
fn legacy_user_id(channel: &ChannelConfigRust, peer: &PeerSessionHistory) -> Option<String> {
    if peer.source_type != ImSourceType::Private {
        return None;
    }
    if channel.channel_type == ImPlatform::Telegram {
        return peer
            .source_id
            .parse::<u64>()
            .ok()
            .map(|_| peer.source_id.clone());
    }
    let capability = ChannelCapability {
        id: channel.id.clone(),
        platform: channel.channel_type.clone(),
        name: None,
        mode: channel.message_delivery_mode,
        group_activation: None,
        agent_id: None,
        health_path: Default::default(),
    };
    binding_target(&capability, &peer.source_id, &peer.source_type)
        .ok()
        .filter(|target| target.target_type == "user")
        .map(|target| target.id)
}

fn user_matches(
    channel: &ChannelConfigRust,
    configured: &str,
    user: Option<&str>,
    username: Option<&str>,
) -> bool {
    user == Some(configured)
        || (channel.channel_type == ImPlatform::Telegram
            && username.is_some_and(|name| name.eq_ignore_ascii_case(configured)))
}

fn access(
    channel: &ChannelConfigRust,
    kind: &ImSourceType,
    id: &str,
    user: Option<&str>,
    username: Option<&str>,
) -> Option<&'static str> {
    if !supports_access_control(&channel.channel_type) {
        return None;
    }
    let group = *kind == ImSourceType::Group;
    if (group
        && channel
            .access
            .blocked_group_ids
            .iter()
            .any(|value| value == id))
        || (!group
            && channel
                .access
                .blocked_user_ids
                .iter()
                .any(|value| user == Some(value.as_str())))
    {
        return Some("blocked");
    }
    if channel.access.access_mode == Some(AccessMode::Open) {
        return Some("open");
    }
    if group {
        channel
            .group_permissions
            .iter()
            .find(|g| g.group_id == id)
            .map(|g| match g.status {
                GroupPermissionStatus::Pending => "pending",
                GroupPermissionStatus::Approved => "approved",
            })
    } else {
        channel
            .allowed_users
            .iter()
            .any(|id| user_matches(channel, id, user, username))
            .then_some("bound")
    }
}

pub(super) fn project(
    channel: &ChannelConfigRust,
    current: Vec<ImActiveSession>,
    history: Vec<PeerSessionHistory>,
    team_ai: bool,
) -> Vec<Peer> {
    let mut history: BTreeMap<_, _> = history
        .into_iter()
        .map(|p| (p.session_key.clone(), p))
        .collect();
    for active in &current {
        let entry = history
            .entry(active.session_key.clone())
            .or_insert_with(|| PeerSessionHistory {
                session_key: active.session_key.clone(),
                source_type: active.source_type.clone(),
                source_id: active
                    .source_id
                    .clone()
                    .unwrap_or_else(|| crate::im::router::parse_session_key(&active.session_key).1),
                source_display_name: active.source_display_name.clone(),
                user_id: None,
                user_username: None,
                workspace_path: active.workspace_path.clone(),
                session_ids: Vec::new(),
            });
        if active.metadata_indexed && !entry.session_ids.contains(&active.session_id) {
            entry.session_ids.push(active.session_id.clone());
        }
    }
    let mut peers: BTreeMap<String, Peer> = BTreeMap::new();
    let mut represented_users = Vec::new();
    for peer in history.into_values() {
        let active = current.iter().find(|p| p.session_key == peer.session_key);
        let user = peer
            .user_id
            .clone()
            .or_else(|| legacy_user_id(channel, &peer));
        let configured_users: Vec<_> = if peer.source_type == ImSourceType::Private {
            channel
                .allowed_users
                .iter()
                .filter(|id| {
                    user_matches(channel, id, user.as_deref(), peer.user_username.as_deref())
                })
                .collect()
        } else {
            Vec::new()
        };
        represented_users.extend(configured_users.iter().map(|id| (*id).clone()));
        let identity = if peer.source_type == ImSourceType::Group {
            format!("group:{}", peer.source_id)
        } else if let Some(id) = configured_users
            .first()
            .map(|id| id.as_str())
            .or(user.as_deref())
        {
            format!("private:{id}")
        } else {
            format!("chat:{}", peer.source_id)
        };
        let configured_name = if peer.source_type == ImSourceType::Group {
            super::configured_peer_name(channel, &peer.source_type, &peer.source_id)
        } else {
            configured_users
                .iter()
                .find_map(|id| super::configured_peer_name(channel, &peer.source_type, id))
                .or_else(|| {
                    user.as_deref()
                        .and_then(|id| super::configured_peer_name(channel, &peer.source_type, id))
                })
        };
        let name = active
            .and_then(|p| p.source_display_name.clone())
            .into_iter()
            .chain(peer.source_display_name.clone())
            .chain(configured_name)
            .find(|name| {
                !name.trim().is_empty()
                    && name != &peer.source_id
                    && Some(name.as_str()) != user.as_deref()
            });
        // Separate historical routing addresses retain their own action scope.
        // Do not combine their Session IDs under an unrelated Router key.
        let identity = if peers.contains_key(&identity) {
            format!("{identity}\0{}", peer.session_key)
        } else {
            identity
        };
        let next = Peer {
            id: identity.clone(),
            access: access(
                channel,
                &peer.source_type,
                &peer.source_id,
                user.as_deref(),
                peer.user_username.as_deref(),
            ),
            has_profile: team_ai && channel.peer_profiles.contains_key(&peer.session_key),
            session_key: Some(peer.session_key),
            source_type: peer.source_type,
            source_id: peer.source_id,
            name,
            session_id: active.map(|p| p.session_id.clone()),
            session_ids: peer.session_ids,
        };
        peers.insert(identity, next);
    }
    if supports_access_control(&channel.channel_type) {
        for user in &channel.allowed_users {
            if represented_users.contains(user) {
                continue;
            }
            let id = format!("private:{user}");
            peers.entry(id.clone()).or_insert_with(|| Peer {
                id,
                session_key: None,
                source_type: ImSourceType::Private,
                source_id: user.clone(),
                name: super::configured_peer_name(channel, &ImSourceType::Private, user),
                session_id: None,
                session_ids: Vec::new(),
                has_profile: false,
                access: access(channel, &ImSourceType::Private, user, Some(user), None),
            });
        }
        for group in &channel.group_permissions {
            let id = format!("group:{}", group.group_id);
            peers.entry(id.clone()).or_insert_with(|| Peer {
                id,
                session_key: None,
                source_type: ImSourceType::Group,
                source_id: group.group_id.clone(),
                name: super::configured_peer_name(channel, &ImSourceType::Group, &group.group_id),
                session_id: None,
                session_ids: Vec::new(),
                has_profile: false,
                access: access(channel, &ImSourceType::Group, &group.group_id, None, None),
            });
        }
    }
    peers.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn config() -> ChannelConfigRust {
        serde_json::from_value(json!({"id":"c", "type":"feishu", "enabled":true,
            "allowedUsers":["ou_user"], "userDisplayNames":{"ou_user":"New user"},
            "groupPermissions":[{"groupId":"oc_group", "groupName":"New group", "platform":"feishu", "status":"pending", "discoveredAt":"t"}]})).unwrap()
    }
    fn history(kind: &str, id: &str, user: Option<&str>) -> PeerSessionHistory {
        serde_json::from_value(json!({"sessionKey":format!("agent:a:feishu:{kind}:{id}"), "sourceType":kind,
            "sourceId":id, "sourceDisplayName":null, "userId":user, "workspacePath":"/synthetic", "sessionIds":["old-session"]})).unwrap()
    }
    fn rows(channel: &ChannelConfigRust, history: Vec<PeerSessionHistory>) -> Value {
        serde_json::to_value(project(channel, Vec::new(), history, true)).unwrap()
    }
    #[test]
    fn binding_and_group_discovery_are_visible_before_a_session_exists() {
        let value = rows(&config(), Vec::new());
        assert_eq!(value.as_array().unwrap().len(), 2);
        assert_eq!(value[0]["id"], "group:oc_group");
        assert_eq!(value[0]["access"], "pending");
        assert_eq!(value[1]["name"], "New user");
        assert_eq!(value[1]["access"], "bound");
        for peer in value.as_array().unwrap() {
            assert!(peer["sessionKey"].is_null());
            assert!(peer["sessionId"].is_null());
            assert_eq!(peer["sessionIds"], json!([]));
        }
    }
    #[test]
    fn observed_private_sender_joins_configuration_to_a_distinct_delivery_chat() {
        let value = rows(
            &config(),
            vec![history("private", "oc_p2p", Some("ou_user"))],
        );
        assert_eq!(value.as_array().unwrap().len(), 2);
        assert_eq!(value[1]["id"], "private:ou_user");
        assert_eq!(value[1]["sourceId"], "oc_p2p");
        assert_eq!(value[1]["sessionKey"], "agent:a:feishu:private:oc_p2p");
        assert_eq!(value[1]["name"], "New user");
        assert_eq!(value[1]["sessionIds"], json!(["old-session"]));
    }
    #[test]
    fn old_native_feishu_history_never_guesses_a_sender_from_a_chat_id_or_name() {
        let value = rows(&config(), vec![history("private", "oc_p2p", None)]);
        assert_eq!(value.as_array().unwrap().len(), 3);
        assert_eq!(value[0]["id"], "chat:oc_p2p");
        assert!(value[2]["sessionKey"].is_null());
    }
    #[test]
    fn current_and_old_group_sessions_share_one_permission_row() {
        let channel = config();
        let old = history("group", "oc_group", None);
        let current: ImActiveSession = serde_json::from_value(json!({
            "sessionKey":old.session_key,"sessionId":"current","sourceType":"group","sourceId":"oc_group",
            "workspacePath":"/synthetic","messageCount":0,"metadataIndexed":true,"lastActive":"t"
        })).unwrap();
        let value =
            serde_json::to_value(project(&channel, vec![current], vec![old], true)).unwrap();
        assert_eq!(value.as_array().unwrap().len(), 2);
        assert_eq!(value[0]["access"], "pending");
        assert_eq!(value[0]["sessionId"], "current");
        assert_eq!(value[0]["sessionIds"], json!(["old-session", "current"]));
    }
    #[test]
    fn open_and_blocked_groups_do_not_request_approval() {
        let mut channel = config();
        channel.access.access_mode = Some(AccessMode::Open);
        assert_eq!(rows(&channel, vec![])[0]["access"], "open");
        channel.access.blocked_group_ids.push("oc_group".into());
        assert_eq!(rows(&channel, vec![])[0]["access"], "blocked");
    }
    #[test]
    fn rejecting_discovery_removes_only_the_request_not_session_history() {
        let mut channel = config();
        channel.group_permissions.clear();
        assert_eq!(rows(&channel, vec![]).as_array().unwrap().len(), 1);
        let retained = rows(&channel, vec![history("group", "oc_group", None)]);
        assert_eq!(retained[0]["sessionIds"], json!(["old-session"]));
        assert!(retained[0]["access"].is_null());
    }
    #[test]
    fn legacy_user_address_contracts_and_telegram_aliases_do_not_duplicate_users() {
        let mut channel = config();
        channel.channel_type = ImPlatform::OpenClaw("wecom-openclaw-plugin".into());
        assert_eq!(
            rows(&channel, vec![history("private", "ou_user", None)])
                .as_array()
                .unwrap()
                .len(),
            2
        );
        channel.channel_type = ImPlatform::Telegram;
        channel.allowed_users = vec!["Alice".into(), "42".into()];
        let mut peer = history("private", "42", Some("42"));
        peer.user_username = Some("alice".into());
        let value = rows(&channel, vec![peer]);
        assert_eq!(value.as_array().unwrap().len(), 2);
        assert_eq!(value[1]["id"], "private:Alice");
        assert_eq!(value[1]["access"], "bound");
    }
}
