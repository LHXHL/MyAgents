//! Display metadata uses config's existing writer; names never grant access.
use super::types::{GroupPermission, ImMessage, ImSourceType};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Emitter, Runtime};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerKind {
    User,
    Group,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerDisplayName {
    pub id: String,
    pub kind: PeerKind,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PeerNameTargets {
    #[serde(default)]
    pub users: Vec<String>,
    #[serde(default)]
    pub groups: Vec<String>,
}

impl PeerDisplayName {
    fn valid_name(&self) -> Option<&str> {
        let name = self.name.trim();
        (!self.id.is_empty() && !name.is_empty() && name != self.id && name.chars().count() <= 256)
            .then_some(name)
    }

    pub fn from_message(msg: &ImMessage) -> Vec<Self> {
        let mut names = Vec::new();
        if let Some(name) = &msg.sender_name {
            names.push(Self {
                id: msg.sender_id.clone(),
                kind: PeerKind::User,
                name: name.clone(),
            });
        }
        if msg.source_type == ImSourceType::Group {
            if let Some(name) = &msg.hint_group_name {
                names.push(Self {
                    id: msg.chat_id.clone(),
                    kind: PeerKind::Group,
                    name: name.clone(),
                });
            }
        }
        names
    }
}

/// Merge against the freshly locked config. Never add peers, replace permission
/// records, or restore IDs removed while the platform lookup was in flight.
pub(super) fn merge_peer_names(bot: &mut Value, names: &[PeerDisplayName]) {
    for peer in names {
        let Some(name) = peer.valid_name() else {
            continue;
        };
        match peer.kind {
            PeerKind::User => {
                let bound = bot["allowedUsers"]
                    .as_array()
                    .is_some_and(|users| users.iter().any(|id| id.as_str() == Some(&peer.id)));
                if bound {
                    if !bot["userDisplayNames"].is_object() {
                        bot["userDisplayNames"] = serde_json::json!({});
                    }
                    bot["userDisplayNames"][&peer.id] = Value::String(name.to_string());
                }
            }
            PeerKind::Group => {
                if let Some(groups) = bot["groupPermissions"].as_array_mut() {
                    for group in groups {
                        if group["groupId"].as_str() == Some(&peer.id) {
                            group["groupName"] = Value::String(name.to_string());
                        }
                    }
                }
            }
        }
    }
}

pub(super) async fn apply_peer_names<R: Runtime>(
    app: &tauri::AppHandle<R>,
    bot_id: &str,
    permissions: &Arc<RwLock<Vec<GroupPermission>>>,
    names: Vec<PeerDisplayName>,
) {
    if !names.iter().any(|name| name.valid_name().is_some()) {
        return;
    }
    let bid = bot_id.to_string();
    let to_persist = names.clone();
    let result = tokio::task::spawn_blocking(move || {
        super::commands::mutate_bot_config(&bid, |bot, _| {
            merge_peer_names(bot, &to_persist);
            Ok(())
        })
    })
    .await;
    match result {
        Ok(Ok(changed)) => {
            // Update only display fields, under the existing live projection lock.
            let mut groups = permissions.write().await;
            for peer in names.iter().filter(|peer| peer.kind == PeerKind::Group) {
                if let Some(name) = peer.valid_name() {
                    for group in groups.iter_mut().filter(|group| group.group_id == peer.id) {
                        group.group_name = name.to_string();
                    }
                }
            }
            drop(groups);
            if changed {
                let _ = app.emit(
                    "im:bot-config-changed",
                    serde_json::json!({ "botId": bot_id }),
                );
            }
        }
        _ => crate::ulog_warn!(
            "[im] Could not save peer display names for channel {}",
            bot_id
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_merge_without_granting_access_or_changing_group_state() {
        let mut bot = json!({"allowedUsers":["u"], "groupPermissions":[{"groupId":"g", "groupName":"g", "status":"pending", "platform":"openclaw:wecom"}]});
        let peer = |id: &str, kind, name: &str| PeerDisplayName {
            id: id.into(),
            kind,
            name: name.into(),
        };
        merge_peer_names(
            &mut bot,
            &[
                peer("u", PeerKind::User, " Alice "),
                peer("removed", PeerKind::User, "Old user"),
                peer("g", PeerKind::Group, "Team"),
                peer("removed", PeerKind::Group, "Old group"),
                peer("g", PeerKind::User, "Wrong kind"),
            ],
        );
        assert_eq!(bot["allowedUsers"], json!(["u"]));
        assert_eq!(bot["userDisplayNames"], json!({"u":"Alice"}));
        assert_eq!(
            bot["groupPermissions"],
            json!([{"groupId":"g", "groupName":"Team", "status":"pending", "platform":"openclaw:wecom"}])
        );
        let before = bot.clone();
        merge_peer_names(
            &mut bot,
            &[
                peer("u", PeerKind::User, "u"),
                peer("g", PeerKind::Group, " "),
            ],
        );
        assert_eq!(bot, before);
        // Subsequent lookup cannot resurrect an unbound ID or its display name.
        bot["allowedUsers"] = json!([]);
        bot["userDisplayNames"] = json!({});
        merge_peer_names(&mut bot, &[peer("u", PeerKind::User, "Alice")]);
        assert_eq!(bot["userDisplayNames"], json!({}));
    }
}
