//! Channel send capability projection. Configuration and existing Session
//! bindings remain authoritative; this module owns no mutable state.
use super::{config_store, health, session_delivery, types::*, ManagedAgents, ManagedImBots};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChannelTarget {
    pub channel_id: String,
    #[serde(rename = "type")]
    pub target_type: String,
    pub id: String,
    pub id_type: String,
}

pub(crate) struct ChannelCapability {
    pub id: String,
    pub platform: ImPlatform,
    pub name: Option<String>,
    pub mode: ChannelDeliveryMode,
    pub group_activation: Option<String>,
    pub agent_id: Option<String>,
    pub health_path: PathBuf,
}

pub(crate) fn configured_channels() -> Vec<ChannelCapability> {
    let mut channels = Vec::new();
    for agent in config_store::read_agent_configs_from_disk() {
        for channel in agent.channels {
            channels.push(ChannelCapability {
                health_path: health::agent_channel_health_path(&agent.id, &channel.id),
                id: channel.id,
                platform: channel.channel_type,
                name: channel.name,
                mode: channel.message_delivery_mode,
                group_activation: channel.group_activation,
                agent_id: Some(agent.id.clone()),
            });
        }
    }
    for (id, config) in config_store::read_im_configs_from_disk() {
        if channels.iter().any(|channel| channel.id == id) {
            continue;
        }
        channels.push(ChannelCapability {
            health_path: health::bot_health_path(&id),
            id,
            platform: config.platform,
            name: config.name,
            mode: config.message_delivery_mode,
            group_activation: config.group_activation,
            agent_id: None,
        });
    }
    channels
}

/// Native DingTalk currently emits only filename/caption placeholders for
/// media. That is not attachment delivery and must not be advertised as such.
pub(crate) fn media_types(platform: &ImPlatform) -> &'static [&'static str] {
    match platform {
        ImPlatform::Dingtalk => &[],
        _ => &["image", "file"],
    }
}

pub(crate) fn target_types(platform: &ImPlatform) -> Value {
    match platform {
        ImPlatform::Telegram => {
            json!([{"type":"user","idTypes":["user_id"]},{"type":"chat","idTypes":["chat_id"]}])
        }
        ImPlatform::Feishu => {
            json!([{"type":"user","idTypes":["open_id"]},{"type":"chat","idTypes":["chat_id"]}])
        }
        ImPlatform::Dingtalk => {
            json!([{"type":"user","idTypes":["staff_id"]},{"type":"chat","idTypes":["conversation_id"]}])
        }
        ImPlatform::OpenClaw(id) => match id.trim_start_matches("openclaw:") {
            "openclaw-lark" | "feishu" => {
                json!([{"type":"user","idTypes":["open_id"]},{"type":"chat","idTypes":["chat_id"]}])
            }
            "wecom" | "wecom-openclaw-plugin" => {
                json!([{"type":"user","idTypes":["userid"]},{"type":"chat","idTypes":["chatid"]}])
            }
            "openclaw-weixin" | "weixin" => json!([{"type":"user","idTypes":["user_id"]}]),
            "qqbot" => {
                json!([{"type":"user","idTypes":["openid"]},{"type":"chat","idTypes":["group_openid","channel_id"]}])
            }
            _ => json!([]),
        },
    }
}

pub(crate) fn binding_target(
    channel: &ChannelCapability,
    id: &str,
    source: &ImSourceType,
) -> Result<ChannelTarget, String> {
    let group = matches!(source, ImSourceType::Group);
    let (kind, id_type, id) = match &channel.platform {
        ImPlatform::Telegram | ImPlatform::Feishu => ("chat", "chat_id", id),
        ImPlatform::Dingtalk => {
            if group {
                (
                    "chat",
                    "conversation_id",
                    id.strip_prefix("group:").unwrap_or(id),
                )
            } else {
                ("user", "staff_id", id)
            }
        }
        ImPlatform::OpenClaw(plugin) => match plugin.trim_start_matches("openclaw:") {
            "openclaw-lark" | "feishu" => {
                if group {
                    ("chat", "chat_id", id.strip_prefix("chat:").unwrap_or(id))
                } else {
                    ("user", "open_id", id.strip_prefix("user:").unwrap_or(id))
                }
            }
            "wecom" | "wecom-openclaw-plugin" => {
                if group {
                    ("chat", "chatid", id)
                } else {
                    ("user", "userid", id)
                }
            }
            "openclaw-weixin" | "weixin" => ("user", "user_id", id),
            "qqbot" => {
                if let Some(value) = id.strip_prefix("channel:") {
                    ("chat", "channel_id", value)
                } else if group {
                    (
                        "chat",
                        "group_openid",
                        id.strip_prefix("group:").unwrap_or(id),
                    )
                } else {
                    ("user", "openid", id.strip_prefix("c2c:").unwrap_or(id))
                }
            }
            _ => return Err("Unsupported channel target protocol".into()),
        },
    };
    Ok(ChannelTarget {
        channel_id: channel.id.clone(),
        target_type: kind.into(),
        id: id.into(),
        id_type: id_type.into(),
    })
}

pub(crate) struct ResolvedChannelScope {
    pub channels: Vec<ChannelCapability>,
    pub binding: Option<ChannelTarget>,
    pub session_key: Option<String>,
    pub source_type: Option<ImSourceType>,
    pub binding_name: Option<String>,
}

pub(crate) async fn resolve_scope(
    agents: Option<&ManagedAgents>,
    bots: Option<&ManagedImBots>,
    session: &str,
    workspace: &Path,
) -> Result<ResolvedChannelScope, String> {
    let channels = configured_channels();
    let (live, live_channels) = session_delivery::exact_live_bindings(agents, bots, session).await;
    resolve_scope_from_channels(channels, &live, &live_channels, session, workspace)
}

/// Resolve one coherent live snapshot against configured connection metadata.
/// Configuration collection stays in the caller so producer parity can be
/// tested with isolated inputs. Offline binding recovery keeps its existing path.
pub(crate) fn resolve_scope_from_channels(
    mut channels: Vec<ChannelCapability>,
    live: &[session_delivery::SessionChannelTarget],
    live_channels: &std::collections::HashMap<String, std::sync::Arc<super::AnyAdapter>>,
    session: &str,
    workspace: &Path,
) -> Result<ResolvedChannelScope, String> {
    let mut unique_ids = std::collections::HashSet::new();
    if channels
        .iter()
        .any(|channel| !unique_ids.insert(&channel.id))
    {
        return Err("Duplicate Channel IDs; resolve the configuration before sending.".into());
    }
    // Config owns installation/lifecycle metadata; the live adapter owns the
    // protocol exposed to Sessions, CLI capabilities and handoff envelopes.
    for channel in &mut channels {
        if let Some(adapter) = live_channels.get(&channel.id) {
            channel.platform = adapter.routing_platform()?;
        }
    }
    let mut bindings = Vec::new();
    for channel in &channels {
        let matches: Vec<_> = live
            .iter()
            .filter(|target| target.channel_id == channel.id)
            .collect();
        if !matches.is_empty() {
            for target in matches {
                bindings.push((
                    binding_target(channel, &target.chat_id, &target.source_type)?,
                    target.source_type.clone(),
                    target.name.clone(),
                    target.session_key.clone(),
                ));
            }
        } else if !live_channels.contains_key(&channel.id) {
            if let Ok(bytes) = std::fs::read(&channel.health_path) {
                if let Ok(state) = serde_json::from_slice::<ImHealthState>(&bytes) {
                    for peer in state
                        .active_sessions
                        .into_iter()
                        .filter(|peer| peer.session_id == session)
                    {
                        let id = peer
                            .source_id
                            .ok_or("Binding has no exact destination; reconnect the channel.")?;
                        bindings.push((
                            binding_target(channel, &id, &peer.source_type)?,
                            peer.source_type,
                            peer.source_display_name,
                            peer.session_key,
                        ));
                    }
                }
            }
        }
    }
    if bindings.len() > 1 {
        return Err(
            "Ambiguous Session channel binding; resolve the duplicate binding before sending."
                .into(),
        );
    }
    let (binding, source_type, binding_name, session_key) = bindings
        .pop()
        .map(|(target, source, name, key)| {
            let name = name.filter(|n| !n.trim().is_empty() && n != &target.id);
            (Some(target), Some(source), name, Some(key))
        })
        .unwrap_or_default();
    let bound_agent = binding
        .as_ref()
        .and_then(|target| {
            channels
                .iter()
                .find(|channel| channel.id == target.channel_id)
        })
        .and_then(|channel| channel.agent_id.clone());
    let agent_id = match bound_agent {
        Some(agent) => Some(agent),
        None if binding.is_none() => config_store::project_agent_for_workspace(workspace)?,
        None => None,
    };
    let channels = channels
        .into_iter()
        .filter(|channel| {
            binding
                .as_ref()
                .is_some_and(|target| target.channel_id == channel.id)
                || (agent_id.is_some() && channel.agent_id == agent_id)
        })
        .collect();
    Ok(ResolvedChannelScope {
        channels,
        binding,
        source_type,
        binding_name,
        session_key,
    })
}

impl ResolvedChannelScope {
    pub fn projection(&self) -> Value {
        json!({"ok":true,"defaultTarget": self.binding,"conversationRef":self.binding.as_ref().zip(self.session_key.as_ref()).map(|(b,k)| json!({"channelId":b.channel_id,"sessionKey":k})),"sourceType":self.source_type,"bindingName":self.binding_name,"channels":self.channels.iter().map(|channel| json!({
            "channelId":channel.id,"platform":channel.platform.to_string(),"name":channel.name,"mode":channel.mode,
            "groupActivation":channel.group_activation.as_deref().unwrap_or("mention"),"targetTypes":target_types(&channel.platform),"mediaTypes":media_types(&channel.platform)
        })).collect::<Vec<_>>()})
    }
}

/// Bridge Lark ingress removes its destination prefix. Sending uses that
/// prefix, but Router identity must match the actual inbound chatId.
pub(crate) fn inbound_peer_id(platform: &ImPlatform, id: &str) -> String {
    match platform {
        ImPlatform::OpenClaw(plugin) if matches!(plugin.as_str(), "openclaw-lark" | "feishu") => id
            .strip_prefix("user:")
            .or_else(|| id.strip_prefix("chat:"))
            .unwrap_or(id)
            .to_string(),
        _ => id.to_string(),
    }
}

pub(crate) fn transport_target(platform: &ImPlatform, target: &ChannelTarget) -> String {
    match platform {
        ImPlatform::Dingtalk if target.target_type == "chat" => format!("group:{}", target.id),
        ImPlatform::OpenClaw(id) if matches!(id.as_str(), "openclaw-lark" | "feishu") => {
            format!("{}:{}", target.target_type, target.id)
        }
        ImPlatform::OpenClaw(id) if id == "qqbot" => format!(
            "{}:{}",
            match target.id_type.as_str() {
                "openid" => "c2c",
                "group_openid" => "group",
                _ => "channel",
            },
            target.id
        ),
        _ => target.id.clone(),
    }
}

/// Only for failures before a turn exists. Admitted turns use their frozen policy.
pub(crate) fn pending_delivery_mode(channel_id: &str) -> ChannelDeliveryMode {
    configured_channels()
        .into_iter()
        .find(|channel| channel.id == channel_id)
        .map(|channel| channel.mode)
        .unwrap_or_default()
}
