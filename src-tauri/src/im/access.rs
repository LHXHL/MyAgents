//! Channel input admission. Configuration is read under the same lock as edits;
//! acceptance belongs to the input, so later edits never revoke queued work.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::types::{GroupPermission, GroupPermissionStatus, ImMessage, ImPlatform, ImSourceType};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessMode {
    Review,
    Open,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAccessConfig {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_access_mode"
    )]
    pub access_mode: Option<AccessMode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_user_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_group_ids: Vec<String>,
}

fn deserialize_access_mode<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<AccessMode>, D::Error> {
    AccessMode::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExistingInteraction {
    Approval(String),
    Question(String),
}

impl ExistingInteraction {
    pub(super) fn matches(&self, request_id: &str, approval: bool) -> bool {
        match self {
            Self::Approval(id) => approval && id == request_id,
            Self::Question(id) => !approval && id == request_id,
        }
    }
}

/// A fact about this accepted input, not a reusable permission for another input.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputAdmission {
    pub sender_is_owner: bool,
    pub group_approved: bool,
    pub triggered: bool,
    pub existing_interaction: Option<ExistingInteraction>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccessSnapshot {
    #[serde(flatten)]
    access: ChannelAccessConfig,
    #[serde(default)]
    allowed_users: Vec<String>,
    #[serde(default)]
    group_permissions: Vec<GroupPermission>,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AccessIntent {
    SetMode { mode: AccessMode },
    SetUserBlocked { user_id: String, blocked: bool },
    SetGroupBlocked { group_id: String, blocked: bool },
    AddUser { user_id: String },
    RemoveUser { user_id: String },
    ApproveGroup { group_id: String },
    RemoveGroup { group_id: String },
    ReviewGroup { group_id: String, approve: bool },
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
        Err("A non-empty platform ID is required".into())
    } else {
        Ok(())
    }
}

fn edit_set(channel: &mut Value, key: &str, id: &str, present: bool) -> Result<(), String> {
    valid_id(id)?;
    let mut values: Vec<String> = channel
        .get(key)
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| format!("Invalid {key}"))?
        .unwrap_or_default();
    if present {
        if !values.iter().any(|value| value == id) {
            values.push(id.to_string());
        }
    } else {
        values.retain(|value| value != id);
    }
    // Preserve insertion order while dropping duplicates from old data.
    let mut seen = std::collections::HashSet::new();
    values.retain(|value| seen.insert(value.clone()));
    channel[key] = json!(values);
    Ok(())
}

pub(super) fn apply_intent(channel: &mut Value, intent: &AccessIntent) -> Result<(), String> {
    // Invalid modes/sets must fail closed even when editing another field.
    let _: AccessSnapshot = serde_json::from_value(channel.clone())
        .map_err(|e| format!("Invalid channel access config: {e}"))?;
    match intent {
        AccessIntent::ReviewGroup { group_id, approve } => {
            let snapshot: AccessSnapshot = serde_json::from_value(channel.clone()).map_err(|e| e.to_string())?;
            if snapshot.access.access_mode == Some(AccessMode::Open)
                || snapshot.access.blocked_group_ids.contains(group_id)
                || !snapshot.group_permissions.iter().any(|group| group.group_id == *group_id && group.status == GroupPermissionStatus::Pending) {
                return Err("Group approval changed; refresh before continuing".into());
            }
            let edit = if *approve { AccessIntent::ApproveGroup { group_id: group_id.clone() } }
                else { AccessIntent::RemoveGroup { group_id: group_id.clone() } };
            apply_intent(channel, &edit)?;
        }
        AccessIntent::SetMode { mode } => channel["accessMode"] = json!(mode),
        AccessIntent::SetUserBlocked { user_id, blocked } => {
            if *blocked
                && channel
                    .get("type")
                    .or_else(|| channel.get("platform"))
                    .and_then(Value::as_str)
                    == Some("telegram")
                && user_id.parse::<u64>().is_err()
            {
                return Err(
                    "Telegram blocking requires the stable numeric user ID, not a username".into(),
                );
            }
            edit_set(channel, "blockedUserIds", user_id, *blocked)?;
        }
        AccessIntent::SetGroupBlocked { group_id, blocked } => {
            edit_set(channel, "blockedGroupIds", group_id, *blocked)?
        }
        AccessIntent::AddUser { user_id } => edit_set(channel, "allowedUsers", user_id, true)?,
        AccessIntent::RemoveUser { user_id } => edit_set(channel, "allowedUsers", user_id, false)?,
        AccessIntent::ApproveGroup { group_id } | AccessIntent::RemoveGroup { group_id } => {
            valid_id(group_id)?;
            let mut groups: Vec<GroupPermission> = serde_json::from_value(
                channel
                    .get("groupPermissions")
                    .cloned()
                    .unwrap_or(json!([])),
            )
            .map_err(|e| format!("Invalid group permissions: {e}"))?;
            if matches!(intent, AccessIntent::ApproveGroup { .. }) {
                let group = groups
                    .iter_mut()
                    .find(|group| group.group_id == *group_id)
                    .ok_or("Group no longer exists")?;
                group.status = GroupPermissionStatus::Approved;
            } else {
                groups.retain(|group| group.group_id != *group_id);
            }
            channel["groupPermissions"] = json!(groups);
        }
    }
    Ok(())
}

/// Merges only this discovery; a delayed event cannot demote an approved group.
pub(super) fn discover_group(channel: &mut Value, group: &GroupPermission) -> Result<(), String> {
    let mut groups: Vec<GroupPermission> = serde_json::from_value(
        channel
            .get("groupPermissions")
            .cloned()
            .unwrap_or(json!([])),
    )
    .map_err(|e| format!("Invalid group permissions: {e}"))?;
    if !groups
        .iter()
        .any(|existing| existing.group_id == group.group_id)
    {
        groups.push(group.clone());
        channel["groupPermissions"] = json!(groups);
    }
    Ok(())
}

/// Pure decision + atomic automatic registration, called inside the config lock.
pub(super) fn admit(
    channel: &mut Value,
    msg: &ImMessage,
    plugin_command: bool,
    existing_interaction: Option<ExistingInteraction>,
) -> Result<Option<InputAdmission>, String> {
    let mut snapshot: AccessSnapshot = serde_json::from_value(channel.clone())
        .map_err(|e| format!("Invalid channel access config: {e}"))?;
    let group = msg.source_type == ImSourceType::Group;
    let triggered = !group
        || msg.is_mention
        || plugin_command
        || super::platform_capabilities::effective_group_activation(
            &msg.platform,
            channel.get("groupActivation").and_then(Value::as_str),
        ) == super::types::GroupActivation::Always;
    let username = msg.source_metadata.sender_username.as_deref();
    let bound = snapshot.allowed_users.iter().any(|id| {
        id == &msg.sender_id
            || (msg.platform == ImPlatform::Telegram
                && username.is_some_and(|name| id.eq_ignore_ascii_case(name)))
    });
    let approved = snapshot.group_permissions.iter().any(|permission| {
        permission.group_id == msg.chat_id && permission.status == GroupPermissionStatus::Approved
    });
    let accepted = || InputAdmission {
        sender_is_owner: bound,
        group_approved: approved,
        triggered,
        existing_interaction: existing_interaction.clone(),
    };
    // A response associated with an existing request retains that request's scope.
    if existing_interaction.is_some() {
        return Ok(Some(accepted()));
    }
    // WeChat is connected through its QR-authenticated account. Old generic
    // settings remain on disk but cannot strand it behind now-hidden controls.
    if !super::platform_capabilities::supports_access_control(&msg.platform) {
        return Ok((!group).then(accepted));
    }
    if snapshot.access.blocked_user_ids.contains(&msg.sender_id)
        || (group && snapshot.access.blocked_group_ids.contains(&msg.chat_id))
    {
        return Ok(None);
    }
    let text = msg.text.trim();
    let bind = text.starts_with("/start BIND_")
        || (text.starts_with("BIND_") && msg.platform != ImPlatform::Telegram);
    let command = super::model_commands::management_command(text);
    let help = matches!(command, Some("/help" | "/start"));
    // Missing persisted mode has the same effective policy as explicit whitelist.
    match snapshot.access.access_mode.unwrap_or(AccessMode::Review) {
        AccessMode::Review => {
            if !group && !bound && !bind && !help {
                return Ok(None);
            }
        }
        AccessMode::Open => {
            let used = !help && !bind && (!group || (triggered && command.is_none()));
            if used {
                valid_id(&msg.sender_id)?;
                if msg.platform == ImPlatform::Telegram && msg.sender_id.parse::<u64>().is_err() {
                    return Err("Telegram input has no stable sender identity".into());
                }
                edit_set(channel, "allowedUsers", &msg.sender_id, true)?;
                if let Some(name) = msg
                    .sender_name
                    .as_deref()
                    .filter(|name| !name.trim().is_empty())
                {
                    if channel.get("userDisplayNames").is_none() {
                        channel["userDisplayNames"] = json!({});
                    }
                    if !channel["userDisplayNames"].is_object() {
                        return Err("Invalid user display names".into());
                    }
                    channel["userDisplayNames"][&msg.sender_id] = json!(name);
                }
                if group {
                    let found = snapshot
                        .group_permissions
                        .iter_mut()
                        .find(|permission| permission.group_id == msg.chat_id);
                    if let Some(permission) = found {
                        permission.status = GroupPermissionStatus::Approved;
                    } else {
                        snapshot.group_permissions.push(GroupPermission {
                            group_id: msg.chat_id.clone(),
                            group_name: msg
                                .hint_group_name
                                .clone()
                                .unwrap_or_else(|| msg.chat_id.clone()),
                            platform: msg.platform.clone(),
                            status: GroupPermissionStatus::Approved,
                            discovered_at: chrono::Utc::now().to_rfc3339(),
                            added_by: msg.sender_name.clone(),
                        });
                    }
                    channel["groupPermissions"] = json!(snapshot.group_permissions);
                }
                return Ok(Some(InputAdmission {
                    sender_is_owner: true,
                    group_approved: group || approved,
                    triggered,
                    existing_interaction: None,
                }));
            }
        }
    }
    Ok(Some(accepted()))
}

pub(super) async fn admit_input<R: tauri::Runtime>(
    app: &AppHandle<R>,
    bot_id: &str,
    msg: &ImMessage,
    plugin_command: bool,
    existing_interaction: Option<ExistingInteraction>,
) -> Result<Option<InputAdmission>, String> {
    let bid = bot_id.to_string();
    let message = msg.clone();
    let (result, changed) = tokio::task::spawn_blocking(move || {
        let mut result = None;
        let changed = super::commands::mutate_bot_config(&bid, |channel, _| {
            result = admit(channel, &message, plugin_command, existing_interaction)?;
            Ok(())
        })?;
        Ok::<_, String>((result, changed))
    })
    .await
    .map_err(|e| e.to_string())??;
    if changed {
        let _ = app.emit("im:bot-config-changed", json!({"botId":bot_id}));
    }
    Ok(result)
}

pub(super) async fn mutate(bot_id: &str, intent: AccessIntent) -> Result<bool, String> {
    let bid = bot_id.to_string();
    tokio::task::spawn_blocking(move || {
        super::commands::mutate_bot_config(&bid, |channel, _| apply_intent(channel, &intent))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_channel_access(
    app: AppHandle,
    bot_id: String,
    intent: AccessIntent,
) -> Result<(), String> {
    mutate(&bot_id, intent).await?;
    let _ = app.emit("im:bot-config-changed", json!({"botId":bot_id}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::im::types::{BufferedMessage, ImSourceMetadata};

    #[test]
    fn group_review_requires_current_pending_authorization_and_reject_does_not_block() {
        let original = json!({"type":"feishu", "groupPermissions":[{"groupId":"g", "groupName":"Group", "platform":"feishu", "status":"pending", "discoveredAt":"t"}]});
        let mut rejected = original.clone();
        apply_intent(&mut rejected, &AccessIntent::ReviewGroup { group_id: "g".into(), approve: false }).unwrap();
        assert_eq!(rejected["groupPermissions"], json!([]));
        assert!(rejected.get("blockedGroupIds").is_none());
        for state in [json!({"accessMode":"open"}), json!({"blockedGroupIds":["g"]}), json!({"groupPermissions":[]})] {
            let mut channel = original.clone();
            channel.as_object_mut().unwrap().extend(state.as_object().unwrap().clone());
            let before = channel.clone();
            assert!(apply_intent(&mut channel, &AccessIntent::ReviewGroup { group_id: "g".into(), approve: true }).is_err());
            assert_eq!(channel, before);
        }
        let mut approved = original;
        apply_intent(&mut approved, &AccessIntent::ReviewGroup { group_id: "g".into(), approve: true }).unwrap();
        assert!(apply_intent(&mut approved, &AccessIntent::ReviewGroup { group_id: "g".into(), approve: false }).is_err());
        assert_eq!(approved["groupPermissions"][0]["status"], "approved");
    }

    fn message(platform: ImPlatform, group: bool, text: &str) -> ImMessage {
        ImMessage {
            access_admission: None,
            source_metadata: ImSourceMetadata::default(),
            chat_id: if group { "group-1" } else { "private-1" }.into(),
            message_id: "message-1".into(),
            text: text.into(),
            sender_id: "123".into(),
            sender_name: Some("Alice".into()),
            account_id: None,
            source_type: if group {
                ImSourceType::Group
            } else {
                ImSourceType::Private
            },
            platform,
            timestamp: chrono::Utc::now(),
            attachments: vec![],
            media_group_id: None,
            is_mention: true,
            reply_to_bot: false,
            hint_group_name: Some("Test group".into()),
            reply_to_body: None,
            group_system_prompt: None,
            request_id: String::new(),
            delivery_protocol: None,
        }
    }

    #[test]
    fn qr_bound_wechat_ignores_historical_multi_user_access_settings() {
        for plugin in ["weixin", "openclaw-weixin"] {
            for mode in [None, Some("review"), Some("open")] {
                let mut channel = json!({
                    "allowedUsers": ["old-scanner"], "blockedUserIds": ["123"],
                    "blockedGroupIds": ["chat-1"], "groupPermissions": []
                });
                if let Some(mode) = mode {
                    channel["accessMode"] = json!(mode);
                }
                let original = channel.clone();
                let input = message(ImPlatform::OpenClaw(plugin.into()), false, "hello");
                let accepted = admit(&mut channel, &input, false, None).unwrap().unwrap();
                assert!(!accepted.sender_is_owner); // No new tool-owner authority.
                assert_eq!(channel, original); // No registration or destructive migration.
                let group = message(ImPlatform::OpenClaw(plugin.into()), true, "hello");
                assert!(admit(&mut channel, &group, false, None).unwrap().is_none());
                assert_eq!(channel, original);
            }
            let mut bound = json!({"accessMode":"review", "allowedUsers":["123"]});
            assert!(
                admit(
                    &mut bound,
                    &message(ImPlatform::OpenClaw(plugin.into()), false, "hello"),
                    false,
                    None
                )
                .unwrap()
                .unwrap()
                .sender_is_owner
            );
        }
    }

    #[test]
    fn missing_mode_is_whitelist_on_every_managed_platform() {
        for platform in [
            ImPlatform::Telegram,
            ImPlatform::Feishu,
            ImPlatform::Dingtalk,
            ImPlatform::OpenClaw("wecom".into()),
            ImPlatform::OpenClaw("wecom-openclaw-plugin".into()),
            ImPlatform::OpenClaw("openclaw-lark".into()),
            ImPlatform::OpenClaw("qqbot".into()),
            ImPlatform::OpenClaw("custom".into()),
        ] {
            for channel in [
                json!({}),
                json!({"allowedUsers":["123"]}),
                json!({"allowedUsers":["123"],"blockedUserIds":["123"]}),
            ] {
                for group in [false, true] {
                    for text in [
                        "hello",
                        "/help",
                        "/start",
                        "BIND_fixture",
                        "/start BIND_fixture",
                    ] {
                        let mut missing = channel.clone();
                        let mut explicit = channel.clone();
                        explicit["accessMode"] = json!("review");
                        let input = message(platform.clone(), group, text);
                        let a = admit(&mut missing, &input, false, None).unwrap();
                        let b = admit(&mut explicit, &input, false, None).unwrap();
                        assert_eq!(
                            serde_json::to_value(a).unwrap(),
                            serde_json::to_value(b).unwrap()
                        );
                        assert_eq!(missing, channel); // No implicit write or registration.
                    }
                }
            }
            assert!(admit(
                &mut json!({}),
                &message(platform, false, "hello"),
                false,
                None
            )
            .unwrap()
            .is_none());
        }
        let mut channel = json!({"allowedUsers":["Alice_Name"]});
        let mut input = message(ImPlatform::Telegram, false, "hello");
        input.source_metadata.sender_username = Some("alice_name".into());
        assert!(
            admit(&mut channel, &input, false, None)
                .unwrap()
                .unwrap()
                .sender_is_owner
        );
        input.source_metadata.sender_username = None;
        input.sender_name = Some("Alice_Name".into());
        assert!(admit(&mut channel, &input, false, None).unwrap().is_none());
    }

    #[test]
    fn review_rejects_new_private_users_but_retains_registered_qualifications() {
        let mut channel = json!({"accessMode":"review"});
        let input = message(ImPlatform::Dingtalk, false, "hello");
        assert!(admit(&mut channel, &input, false, None).unwrap().is_none());
        apply_intent(
            &mut channel,
            &AccessIntent::SetMode {
                mode: AccessMode::Open,
            },
        )
        .unwrap();
        assert!(
            admit(&mut channel, &input, false, None)
                .unwrap()
                .unwrap()
                .sender_is_owner
        );
        apply_intent(
            &mut channel,
            &AccessIntent::SetMode {
                mode: AccessMode::Review,
            },
        )
        .unwrap();
        assert!(admit(&mut channel, &input, false, None).unwrap().is_some());
        assert_eq!(channel["userDisplayNames"]["123"], "Alice");
    }

    #[test]
    fn first_real_group_use_registers_both_user_and_group_without_waiting_for_discovery() {
        let mut channel = json!({"accessMode":"open", "blockedUserIds":["other"]});
        let input = message(ImPlatform::Feishu, true, "hello");
        let accepted = admit(&mut channel, &input, false, None).unwrap().unwrap();
        assert!(accepted.sender_is_owner && accepted.group_approved);
        assert_eq!(channel["allowedUsers"], json!(["123"]));
        assert_eq!(channel["groupPermissions"][0]["status"], "approved");
        assert_eq!(channel["blockedUserIds"], json!(["other"]));
        let late_discovery = GroupPermission {
            group_id: input.chat_id,
            group_name: "discovery".into(),
            platform: input.platform,
            status: GroupPermissionStatus::Pending,
            discovered_at: "now".into(),
            added_by: None,
        };
        discover_group(&mut channel, &late_discovery).unwrap();
        assert_eq!(channel["groupPermissions"][0]["status"], "approved");
        apply_intent(
            &mut channel,
            &AccessIntent::SetMode {
                mode: AccessMode::Review,
            },
        )
        .unwrap();
        let mut stranger = message(ImPlatform::Feishu, true, "hello");
        stranger.sender_id = "456".into();
        let accepted = admit(&mut channel, &stranger, false, None)
            .unwrap()
            .unwrap();
        assert!(accepted.group_approved && !accepted.sender_is_owner);
    }

    #[test]
    fn non_triggering_group_messages_and_help_do_not_auto_register() {
        let mut channel = json!({"accessMode":"open"});
        for text in ["/help", "/start", "/model", "/invalid-command"] {
            let mut input = message(ImPlatform::Telegram, true, text);
            input.is_mention = false;
            admit(&mut channel, &input, false, None).unwrap();
        }
        for text in ["/help", "/start", "/start BIND_abc"] {
            admit(
                &mut channel,
                &message(ImPlatform::Telegram, false, text),
                false,
                None,
            )
            .unwrap();
        }
        let mut input = message(ImPlatform::Dingtalk, true, "ordinary chat");
        input.is_mention = false;
        channel["groupActivation"] = json!("always");
        assert!(
            !admit(&mut channel, &input, false, None)
                .unwrap()
                .unwrap()
                .triggered
        );
        assert!(channel.get("allowedUsers").is_none());
        input.platform = ImPlatform::Feishu;
        assert!(
            admit(&mut channel, &input, false, None)
                .unwrap()
                .unwrap()
                .triggered
        );
        assert_eq!(channel["allowedUsers"], json!(["123"]));
    }

    #[test]
    fn plugin_command_is_real_use_and_attachment_only_query_registers() {
        let mut channel = json!({"accessMode":"open"});
        let mut input = message(ImPlatform::OpenClaw("custom".into()), true, "/business");
        input.is_mention = false;
        assert!(
            admit(&mut channel, &input, true, None)
                .unwrap()
                .unwrap()
                .sender_is_owner
        );
        let mut input = message(ImPlatform::Telegram, false, "");
        input.sender_id = "456".into();
        input.attachments.push(crate::im::types::ImAttachment {
            file_name: "image.png".into(),
            mime_type: "image/png".into(),
            data: vec![1],
            attachment_type: crate::im::types::ImAttachmentType::Image,
        });
        assert!(
            admit(&mut channel, &input, false, None)
                .unwrap()
                .unwrap()
                .sender_is_owner
        );
        assert_eq!(channel["allowedUsers"], json!(["123", "456"]));
    }

    #[test]
    fn either_blacklist_wins_and_unblocking_does_not_erase_other_conditions() {
        let mut channel = json!({"accessMode":"open", "allowedUsers":["123"], "blockedUserIds":["123"], "blockedGroupIds":["group-1"]});
        let input = message(ImPlatform::Telegram, true, "hello");
        assert!(admit(&mut channel, &input, false, None).unwrap().is_none());
        apply_intent(
            &mut channel,
            &AccessIntent::SetUserBlocked {
                user_id: "123".into(),
                blocked: false,
            },
        )
        .unwrap();
        assert!(admit(&mut channel, &input, false, None).unwrap().is_none());
        assert!(admit(
            &mut channel,
            &message(ImPlatform::Telegram, false, "hello"),
            false,
            None
        )
        .unwrap()
        .is_some());
        apply_intent(
            &mut channel,
            &AccessIntent::SetGroupBlocked {
                group_id: "group-1".into(),
                blocked: false,
            },
        )
        .unwrap();
        assert!(admit(&mut channel, &input, false, None).unwrap().is_some());
        apply_intent(
            &mut channel,
            &AccessIntent::SetUserBlocked {
                user_id: "123".into(),
                blocked: true,
            },
        )
        .unwrap();
        apply_intent(
            &mut channel,
            &AccessIntent::SetMode {
                mode: AccessMode::Review,
            },
        )
        .unwrap();
        assert_eq!(channel["allowedUsers"], json!(["123"]));
        assert_eq!(channel["blockedUserIds"], json!(["123"]));
        assert!(admit(
            &mut channel,
            &message(ImPlatform::Telegram, false, "/start BIND_abc"),
            false,
            None
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn earlier_acceptance_survives_block_and_disk_buffer_roundtrip() {
        let mut channel = json!({"accessMode":"open"});
        let mut input = message(ImPlatform::Telegram, true, "work");
        input.access_admission = admit(&mut channel, &input, false, None).unwrap();
        apply_intent(
            &mut channel,
            &AccessIntent::SetUserBlocked {
                user_id: "123".into(),
                blocked: true,
            },
        )
        .unwrap();
        apply_intent(
            &mut channel,
            &AccessIntent::RemoveUser {
                user_id: "123".into(),
            },
        )
        .unwrap();
        let buffered = serde_json::to_value(BufferedMessage::from_im_message(&input)).unwrap();
        let replay = serde_json::from_value::<BufferedMessage>(buffered.clone())
            .unwrap()
            .to_im_message();
        assert!(replay.access_admission.unwrap().sender_is_owner);
        assert!(admit(&mut channel, &input, false, None).unwrap().is_none());
        assert!(admit(
            &mut channel,
            &input,
            false,
            Some(ExistingInteraction::Question("old-request".into()))
        )
        .unwrap()
        .is_some());
        let mut legacy_buffer = buffered;
        legacy_buffer
            .as_object_mut()
            .unwrap()
            .remove("access_admission");
        assert!(serde_json::from_value::<BufferedMessage>(legacy_buffer)
            .unwrap()
            .to_im_message()
            .access_admission
            .is_none());
    }

    #[test]
    fn quoting_blocked_user_is_processed_unchanged_for_other_sender() {
        let mut channel = json!({"accessMode":"open", "blockedUserIds":["blocked"]});
        let mut input = message(ImPlatform::Telegram, true, "explain this quote");
        input.reply_to_body = Some("blocked user's text".into());
        assert!(admit(&mut channel, &input, false, None).unwrap().is_some());
        assert_eq!(input.reply_to_body.as_deref(), Some("blocked user's text"));
        assert_eq!(channel["blockedUserIds"], json!(["blocked"]));
    }

    #[test]
    fn malformed_config_and_unstable_block_identity_fail_closed() {
        for malformed in [
            json!({"accessMode":"future"}),
            json!({"accessMode":null}),
            json!({"blockedUserIds":null}),
            json!({"allowedUsers":{}}),
        ] {
            assert!(admit(
                &mut malformed.clone(),
                &message(ImPlatform::Telegram, false, "hello"),
                false,
                None
            )
            .is_err());
        }
        let mut channel = json!({"type":"telegram"});
        assert!(apply_intent(
            &mut channel,
            &AccessIntent::SetUserBlocked {
                user_id: "username".into(),
                blocked: true
            }
        )
        .is_err());
        assert!(apply_intent(
            &mut channel,
            &AccessIntent::SetGroupBlocked {
                group_id: "".into(),
                blocked: true
            }
        )
        .is_err());
        assert!(serde_json::from_value::<AccessIntent>(
            json!({"kind":"setMode","mode":"open","allowedUsers":["spoof"]})
        )
        .is_err());
    }

    #[test]
    fn config_lock_merges_concurrent_registration_block_and_name_updates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            json!({"channel":{"accessMode":"open"}, "unrelated":42}).to_string(),
        )
        .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = (0..3)
            .map(|operation| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    crate::config_io::with_config_lock(&path, false, |config| {
                        match operation {
                            0 => {
                                admit(
                                    &mut config["channel"],
                                    &message(ImPlatform::Telegram, true, "hello"),
                                    false,
                                    None,
                                )?;
                            }
                            1 => apply_intent(
                                &mut config["channel"],
                                &AccessIntent::SetUserBlocked {
                                    user_id: "456".into(),
                                    blocked: true,
                                },
                            )?,
                            _ => {
                                config["channel"]["name"] = json!("latest name");
                            }
                        }
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let config: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(config["channel"]["allowedUsers"], json!(["123"]));
        assert_eq!(config["channel"]["blockedUserIds"], json!(["456"]));
        assert_eq!(config["channel"]["name"], "latest name");
        assert_eq!(config["unrelated"], 42);
    }
    #[test]
    fn registration_and_blacklisting_are_linearized_in_either_lock_order() {
        for block_first in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("config.json");
            std::fs::write(&path, json!({"channel":{"accessMode":"open"}}).to_string()).unwrap();
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let first_path = path.clone();
            let first = std::thread::spawn(move || {
                let mut accepted = false;
                crate::config_io::with_config_lock(&first_path, false, |config| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    if block_first {
                        apply_intent(
                            &mut config["channel"],
                            &AccessIntent::SetUserBlocked {
                                user_id: "123".into(),
                                blocked: true,
                            },
                        )?;
                    } else {
                        accepted = admit(
                            &mut config["channel"],
                            &message(ImPlatform::Telegram, false, "hello"),
                            false,
                            None,
                        )?
                        .is_some();
                    }
                    Ok(())
                })
                .unwrap();
                accepted
            });
            entered_rx.recv().unwrap();
            let second_path = path.clone();
            let second = std::thread::spawn(move || {
                let mut accepted = false;
                crate::config_io::with_config_lock(&second_path, false, |config| {
                    if block_first {
                        accepted = admit(
                            &mut config["channel"],
                            &message(ImPlatform::Telegram, false, "hello"),
                            false,
                            None,
                        )?
                        .is_some();
                    } else {
                        apply_intent(
                            &mut config["channel"],
                            &AccessIntent::SetUserBlocked {
                                user_id: "123".into(),
                                blocked: true,
                            },
                        )?;
                    }
                    Ok(())
                })
                .unwrap();
                accepted
            });
            release_tx.send(()).unwrap();
            assert_eq!(first.join().unwrap(), !block_first);
            assert!(!second.join().unwrap());
            let config: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert_eq!(config["channel"]["blockedUserIds"], json!(["123"]));
            assert_eq!(
                config["channel"].get("allowedUsers").is_some(),
                !block_first
            );
        }
    }

    #[test]
    fn repeated_use_keeps_qualification_order_and_does_not_write_config() {
        let mut channel = json!({"accessMode":"open", "allowedUsers":["123","456"],"userDisplayNames":{"123":"Alice"}});
        let before = channel.clone();
        admit(
            &mut channel,
            &message(ImPlatform::Telegram, false, "hello"),
            false,
            None,
        )
        .unwrap();
        assert_eq!(channel, before);
    }
    #[test]
    fn mixed_sender_fragments_are_individually_authorized() {
        let mut coalescer = super::super::telegram::MessageCoalescer::new();
        let mut first = message(ImPlatform::Telegram, true, &"A".repeat(4001));
        first.message_id = "1".into();
        let mut blocked = message(ImPlatform::Telegram, true, &"B".repeat(4001));
        blocked.message_id = "2".into();
        blocked.sender_id = "456".into();
        let mut tail = message(ImPlatform::Telegram, true, "tail");
        tail.message_id = "3".into();
        assert!(coalescer.push(&first).is_empty());
        let mut ready = coalescer.push(&blocked);
        ready.extend(coalescer.push(&tail));
        assert_eq!(ready.len(), 3);
        let mut channel = json!({"accessMode":"open", "blockedUserIds":["456"]});
        assert!(admit(&mut channel, &ready[0], false, None)
            .unwrap()
            .is_some());
        assert_eq!(ready[0].text, first.text);
        assert!(admit(&mut channel, &ready[1], false, None)
            .unwrap()
            .is_none());
        assert!(admit(&mut channel, &ready[2], false, None)
            .unwrap()
            .is_some());
        assert_eq!(channel["allowedUsers"], json!(["123"]));
    }

    #[test]
    fn removal_then_valid_binding_uses_latest_qualification_without_restart() {
        let mut channel = json!({"accessMode":"review", "allowedUsers":["123"]});
        let input = message(ImPlatform::Telegram, false, "hello");
        apply_intent(
            &mut channel,
            &AccessIntent::RemoveUser {
                user_id: "123".into(),
            },
        )
        .unwrap();
        assert!(admit(&mut channel, &input, false, None).unwrap().is_none());
        assert!(admit(
            &mut channel,
            &message(ImPlatform::Telegram, false, "/start BIND_current"),
            false,
            None
        )
        .unwrap()
        .is_some());
        // Valid binding dispatch now commits this intent before checking for a duplicate.
        apply_intent(
            &mut channel,
            &AccessIntent::AddUser {
                user_id: "123".into(),
            },
        )
        .unwrap();
        assert!(
            admit(&mut channel, &input, false, None)
                .unwrap()
                .unwrap()
                .sender_is_owner
        );
    }

    #[test]
    fn explicit_null_mode_is_invalid() {
        for platform in [ImPlatform::Dingtalk, ImPlatform::OpenClaw("qqbot".into())] {
            assert!(admit(
                &mut json!({"accessMode":null}),
                &message(platform, false, "hello"),
                false,
                None
            )
            .is_err());
        }
        assert!(serde_json::from_value::<super::super::types::ImConfig>(
            json!({"accessMode":null})
        )
        .is_err());
    }
}
