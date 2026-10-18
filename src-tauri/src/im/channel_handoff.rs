//! Cross-conversation sends reuse the Channel Router and ordinary Inbox.
//! No authorization mutation, outbound probe, or second Session registry.
use super::{
    adapter::ImAdapter,
    channel_messaging::{
        binding_target, inbound_peer_id, transport_target, ChannelCapability, ChannelTarget,
    },
    health::HealthManager,
    model_commands,
    peer_names::{PeerDisplayName, PeerKind, PeerNameTargets},
    router::SessionRouter,
    state::{ChannelModelWorkGate, PeerLocks},
    types::{ImPlatform, ImSourceType},
    AnyAdapter, ImBotInstance, ManagedAgents, ManagedImBots,
};
use crate::inbox::{
    deliver::{prepare_existing_delivery, DeliverOutcome},
    PendingInboxMessage,
};
use crate::sidecar::ManagedSidecarManager;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

pub(crate) struct ChannelOwner {
    pub adapter: Arc<AnyAdapter>,
    router: Arc<Mutex<SessionRouter>>,
    health: Arc<HealthManager>,
    peer_locks: PeerLocks,
    gate: Arc<ChannelModelWorkGate>,
}
impl From<&ImBotInstance> for ChannelOwner {
    fn from(bot: &ImBotInstance) -> Self {
        Self {
            adapter: bot.adapter.clone(),
            router: bot.router.clone(),
            health: bot.health.clone(),
            peer_locks: bot.peer_locks.clone(),
            gate: bot.model_work_gate.clone(),
        }
    }
}
pub(crate) async fn channel_owner(
    agents: Option<&ManagedAgents>,
    bots: Option<&ManagedImBots>,
    id: &str,
) -> Result<ChannelOwner, String> {
    if let Some(agents) = agents {
        for agent in agents.lock().await.values() {
            if let Some(channel) = agent.channels.get(id) {
                return Ok(ChannelOwner::from(&channel.bot_instance));
            }
        }
    }
    if let Some(bots) = bots {
        if let Some(bot) = bots.lock().await.get(id) {
            return Ok(ChannelOwner::from(bot));
        }
    }
    Err("Channel is offline. Start it before sending.".into())
}

pub(crate) struct Conversation {
    pub target: ChannelTarget,
    session_key: String,
    source_type: ImSourceType,
    name: Option<String>,
}
fn useful_name(name: Option<String>, id: &str) -> Option<String> {
    name.filter(|s| !s.trim().is_empty() && s != id)
}
impl Conversation {
    pub fn world(&self, channel: &ChannelCapability, platform: &ImPlatform) -> Value {
        let mut connection = json!({"channelId":channel.id,"platform":platform.to_string()});
        if let Some(name) = &channel.name {
            connection["name"] = json!(name);
        }
        let mut conversation = json!({"id":self.target.id,"idType":self.target.id_type,"kind":
            if self.target.id_type == "channel_id" { "channel" } else if self.source_type == ImSourceType::Private { "direct" } else { "group" }});
        if let Some(name) = &self.name {
            conversation["name"] = json!(name);
        }
        json!({"connection":connection,"conversation":conversation})
    }
}
// Directory APIs consume platform IDs; transport prefixes belong only to routing.
fn directory_targets(target: &ChannelTarget, kind: &ImSourceType) -> PeerNameTargets {
    if *kind == ImSourceType::Private {
        PeerNameTargets {
            users: vec![target.id.clone()],
            groups: vec![],
        }
    } else {
        PeerNameTargets {
            users: vec![],
            groups: vec![target.id.clone()],
        }
    }
}
fn lark_group_name(id: &str, names: &[PeerDisplayName]) -> Result<String, String> {
    names.iter().find(|p| p.id == id && p.kind == PeerKind::Group).map(|p| p.name.clone())
        .ok_or_else(|| "Cannot resolve this Lark chat_id to an inbound group. For a private conversation use the user's open_id; no message was sent.".into())
}

impl ChannelOwner {
    pub async fn source_world(
        &self,
        channel: &ChannelCapability,
        session: &str,
    ) -> Result<Option<Value>, String> {
        let router = self.router.lock().await;
        let mut peers = router
            .peer_sessions_iter()
            .filter(|peer| peer.session_id == session);
        let Some(peer) = peers.next() else {
            return Ok(None);
        };
        if peers.next().is_some() {
            return Err("Ambiguous source Session binding".into());
        }
        let id = peer.source_id.as_str();
        Ok(Some(
            Conversation {
                target: binding_target(channel, id, &peer.source_type)?,
                session_key: peer.session_key.clone(),
                source_type: peer.source_type.clone(),
                name: useful_name(peer.source_display_name.clone(), id),
            }
            .world(channel, &self.adapter.routing_platform()?),
        ))
    }

    pub async fn resolve(
        &self,
        channel: &ChannelCapability,
        target: &ChannelTarget,
    ) -> Result<Conversation, String> {
        let platform = self.adapter.routing_platform()?;
        // Existing bindings already carry the platform's inbound identity/kind.
        // Telegram private user_id and chat_id refer to the same numeric peer.
        {
            let router = self.router.lock().await;
            let mut resolved = None;
            for peer in router.peer_sessions_iter() {
                let id = peer.source_id.as_str();
                let canonical = binding_target(channel, id, &peer.source_type)?;
                let same = canonical == *target
                    || (channel.platform == ImPlatform::Telegram
                        && canonical.id == target.id
                        && peer.source_type == ImSourceType::Private);
                if same {
                    if resolved.is_some() {
                        return Err(
                            "Ambiguous target Channel binding; reconnect to reconcile it".into(),
                        );
                    }
                    resolved = Some(Conversation {
                        target: canonical,
                        session_key: peer.session_key.clone(),
                        source_type: peer.source_type.clone(),
                        name: useful_name(peer.source_display_name.clone(), id),
                    });
                }
            }
            if let Some(conversation) = resolved {
                return Ok(conversation);
            }
        }
        let (source_id, source_type, mut name) = match self.adapter.as_ref() {
            AnyAdapter::Telegram(adapter) => adapter.resolve_channel_chat(&target.id).await?,
            AnyAdapter::Feishu(adapter) => adapter.resolve_channel_chat(target).await?,
            _ => {
                let kind = if target.target_type == "user" {
                    ImSourceType::Private
                } else {
                    ImSourceType::Group
                };
                let id = inbound_peer_id(&platform, &transport_target(&platform, target));
                // Lark chat_id may also be a p2p alias. Only an exact directory
                // group result proves that a previously unseen chat is a group.
                if matches!(&channel.platform, ImPlatform::OpenClaw(p) if matches!(p.as_str(), "openclaw-lark" | "feishu"))
                    && target.target_type == "chat"
                {
                    let names = self
                        .adapter
                        .peer_names(&directory_targets(target, &kind))
                        .await;
                    let name = lark_group_name(&target.id, &names)?;
                    (id, kind, Some(name))
                } else {
                    (id, kind, None)
                }
            }
        };
        let canonical = binding_target(channel, &source_id, &source_type)?;
        if name.is_none() {
            let targets = directory_targets(target, &source_type);
            name = self
                .adapter
                .peer_names(&targets)
                .await
                .into_iter()
                .find(|p| {
                    (p.id == target.id || p.id == source_id)
                        && (p.kind == PeerKind::User) == (source_type == ImSourceType::Private)
                })
                .map(|p| p.name);
        }
        Ok(Conversation {
            target: canonical,
            session_key: self.router.lock().await.session_key_for_peer(
                &platform,
                &source_type,
                &source_id,
            ),
            name: useful_name(name, &source_id),
            source_type,
        })
    }

    pub async fn deliver(
        &self,
        app: &tauri::AppHandle,
        manager: &ManagedSidecarManager,
        channel: &ChannelCapability,
        request: HandoffRequest,
    ) -> Result<Value, String> {
        let HandoffRequest {
            conversation,
            source_session,
            source_world,
            text,
            context,
            attachments,
        } = request;
        let _work = self
            .gate
            .try_enter()
            .ok_or("Channel is restarting; request was not admitted")?;
        // Retain the Router's resolved peer key. Re-read its current Session
        // under the same fence as inbound and /new; never cache a Session ID.
        let key = conversation.session_key.clone();
        let fence = self
            .peer_locks
            .lock()
            .await
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _fence = fence.lock().await;
        model_commands::ensure_peer_snapshot(&self.router, &self.health, manager, &key).await?;
        if let Some(name) = &conversation.name {
            let _projection = self.health.lock_active_sessions_projection().await;
            let mut router = self.router.lock().await;
            if let Some(mut peer) = router.peer_session_snapshot(&key) {
                peer.source_display_name = Some(name.clone());
                router.upsert_peer_session(peer);
                self.health
                    .persist_active_sessions_snapshot(router.active_sessions())
                    .await?;
            }
        }
        SessionRouter::ensure_sidecar(&self.router, &key, app, manager).await?;
        let (session, workspace) = {
            let router = self.router.lock().await;
            let peer = router
                .peer_session_snapshot(&key)
                .ok_or("Target binding unavailable")?;
            (peer.session_id, peer.workspace_path)
        };
        if session == source_session {
            return Err(
                "Target resolves to the source Session; use its default destination".into(),
            );
        }
        let mut message = PendingInboxMessage::new_request(
            source_session.clone(),
            "Channel Session".into(),
            session.clone(),
            text.clone(),
            false,
        );
        let world = conversation.world(channel, &self.adapter.routing_platform()?);
        let imported = import_attachments(&workspace, &message.message_id, attachments).await?;
        let mut handoff = json!({"target":world,"context":context});
        if let Some(source) = source_world {
            handoff["source"] = source;
        }
        if !imported.is_empty() {
            handoff["attachments"] = json!(imported);
        }
        message.session_event = Some(
            json!({"version":1,"type":"send.request","eventId":message.message_id,
            "sourceSessionId":source_session,"sourceKind":"internal-session","sourceLabel":"Channel Session",
            "targetSessionId":session,"sourceNotification":"none","createdAt":chrono::Utc::now().to_rfc3339(),
            "payload":text,"channelHandoff":handoff}),
        );
        let event_id = message.message_id.clone();
        // Original Inbox prepare resumes the already materialized Channel Session.
        // Keep the peer fence through the queue ACK so /new cannot change it midway.
        let outcome =
            match prepare_existing_delivery(app, manager, message, workspace.clone()).await {
                Ok(prepared) => prepared.admit(app, None, || Ok(())).await,
                Err(outcome) => outcome,
            };
        let (status, error) = finish_delivery(&workspace, &event_id, outcome).await;
        let mut result = json!({"action":"handoff","status":status,"eventId":event_id,"targetSessionId":session,
        "connection":world["connection"],"conversation":world["conversation"],
        "message": match status {
            "accepted" => "目标队列已接纳；尚不能确认模型已消费或平台已发送。",
            "unknown" => "无法确认目标队列是否已接纳；可能已经在处理。保留本回执，先检查目标 Session，勿盲目重发。",
            _ => "本次未接纳，未通过此请求外发。",
        }});
        if let Some(error) = error {
            result["error"] = json!(error);
        }
        Ok(result)
    }
}

pub(crate) struct HandoffRequest {
    pub conversation: Conversation,
    pub source_session: String,
    pub source_world: Option<Value>,
    pub text: String,
    pub context: String,
    pub attachments: Vec<HandoffAttachment>,
}

pub(crate) struct HandoffAttachment {
    pub bytes: Vec<u8>,
    pub name: String,
    pub mime_type: String,
    pub image: bool,
    pub caption: Option<String>,
}
async fn import_attachments(
    workspace: &std::path::Path,
    event: &str,
    attachments: Vec<HandoffAttachment>,
) -> Result<Vec<Value>, String> {
    use base64::Engine;
    if attachments.is_empty() {
        return Ok(vec![]);
    }
    let files = attachments
        .iter()
        .map(|a| crate::workspace_files::files_b64::Base64FileEntry {
            name: a.name.clone(),
            content: base64::engine::general_purpose::STANDARD.encode(&a.bytes),
        })
        .collect();
    let imported = crate::workspace_files::files_b64::cmd_workspace_import_files_b64(
        workspace.to_string_lossy().into(),
        files,
        Some(format!("myagents_files/channel-handoff/{event}")),
    )
    .await;
    let imported = match imported {
        Ok(imported) => imported,
        Err(error) => {
            discard_import(workspace, event).await;
            return Err(error);
        }
    };
    Ok(imported.files.into_iter().zip(attachments).map(|(path,a)| {
        let mut value = json!({"path":workspace.join(path),"name":a.name,"mimeType":a.mime_type,"image":a.image});
        if let Some(caption) = a.caption { value["caption"] = json!(caption); }
        value
    }).collect())
}

// Unknown ACKs may already be executing; only definite rejection owns cleanup.
async fn finish_delivery(
    workspace: &std::path::Path,
    event: &str,
    outcome: DeliverOutcome,
) -> (&'static str, Option<String>) {
    let result = match outcome {
        DeliverOutcome::Delivered { .. } => ("accepted", None),
        DeliverOutcome::Unconfirmed { reason } => ("unknown", Some(reason)),
        DeliverOutcome::DeliveryFailed { reason } | DeliverOutcome::Rejected { reason } => {
            ("failed", Some(reason))
        }
        DeliverOutcome::SessionNotFound => {
            ("failed", Some("Target Session no longer exists".into()))
        }
    };
    if result.0 == "failed" {
        discard_import(workspace, event).await;
    }
    result
}

async fn discard_import(workspace: &std::path::Path, event: &str) {
    if let Err(error) = crate::workspace_files::delete::cmd_workspace_delete(
        workspace.to_string_lossy().into(),
        format!("myagents_files/channel-handoff/{event}"),
        Some(true),
    )
    .await
    {
        crate::ulog_warn!(
            "[channel-handoff] Could not release rejected event attachments: {}",
            error
        );
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::ChannelDeliveryMode;
    use super::*;
    use std::path::PathBuf;
    // Same fixtures exercise the real Bridge dispatch paths in TypeScript.
    #[tokio::test]
    async fn registered_identity_reuses_inbound_binding_and_new_target_key() {
        let rows: Value = serde_json::from_str(include_str!(
            "../../../src/shared/__fixtures__/channel-context/routing-identities.json"
        ))
        .unwrap();
        for row in rows.as_array().unwrap() {
            let protocol = row["registered"].as_str().unwrap().to_string();
            let captured = protocol.clone();
            let service = axum::Router::new()
                .route(
                    "/capabilities",
                    axum::routing::get(move || {
                        let p = captured.clone();
                        async move { axum::Json(json!({"pluginId":p})) }
                    }),
                )
                .route(
                    "/peer-names",
                    axum::routing::post(
                        |axum::Json(query): axum::Json<PeerNameTargets>| async move {
                            axum::Json(
                                query
                                    .groups
                                    .into_iter()
                                    .map(|id| PeerDisplayName {
                                        id,
                                        kind: PeerKind::Group,
                                        name: "Team".into(),
                                    })
                                    .collect::<Vec<_>>(),
                            )
                        },
                    ),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tauri::async_runtime::spawn(async move {
                axum::serve(listener, service).await.unwrap()
            });
            let configured = row["configured"].as_str().unwrap().to_string();
            let mut adapter = super::super::bridge::BridgeAdapter::new(configured.clone(), port);
            assert!(adapter.routing_platform().is_err());
            adapter.sync_capabilities().await;
            assert_eq!(
                adapter.routing_platform().unwrap(),
                ImPlatform::OpenClaw(protocol.clone())
            );
            // Installation/tool identity remains unchanged.
            assert_eq!(adapter.plugin_id(), configured);
            let owner = ChannelOwner {
                adapter: Arc::new(AnyAdapter::Bridge(Arc::new(adapter))),
                router: Arc::new(Mutex::new(SessionRouter::new_for_agent(
                    PathBuf::from("/synthetic"),
                    "a".into(),
                ))),
                health: Arc::new(HealthManager::new(PathBuf::from(
                    "/nonexistent/channel-test-health",
                ))),
                peer_locks: Arc::new(Mutex::new(Default::default())),
                gate: ChannelModelWorkGate::new(),
            };
            let channel = ChannelCapability {
                id: "bot".into(),
                platform: ImPlatform::OpenClaw(configured),
                name: None,
                mode: ChannelDeliveryMode::Auto,
                group_activation: None,
                agent_id: Some("a".into()),
                health_path: PathBuf::new(),
            };
            let source_type = if row["kind"] == "private" {
                ImSourceType::Private
            } else {
                ImSourceType::Group
            };
            let target = ChannelTarget {
                channel_id: "bot".into(),
                target_type: if source_type == ImSourceType::Private {
                    "user"
                } else {
                    "chat"
                }
                .into(),
                id: row["id"].as_str().unwrap().into(),
                id_type: row["idType"].as_str().unwrap().into(),
            };
            let expected = owner.router.lock().await.session_key_for_peer(
                &ImPlatform::OpenClaw(protocol),
                &source_type,
                row["inbound"].as_str().unwrap(),
            );
            // First handoff creates exactly the key that a real inbound uses.
            let first = owner.resolve(&channel, &target).await.unwrap();
            assert_eq!(first.session_key, expected, "{}", row);
            owner
                .router
                .lock()
                .await
                .stage_materialized_session_binding(&first.session_key, "existing-session");
            // Repeated handoff resolves the exact binding. A /new between
            // resolution and admission changes only its Session, not its fence.
            let resolved = owner.resolve(&channel, &target).await.unwrap();
            assert_eq!(resolved.session_key, expected);
            owner
                .router
                .lock()
                .await
                .stage_materialized_session_binding(&expected, "new-session");
            assert_eq!(
                owner
                    .router
                    .lock()
                    .await
                    .peer_session_snapshot(&resolved.session_key)
                    .unwrap()
                    .session_id,
                "new-session"
            );
            assert_eq!(owner.router.lock().await.active_sessions().len(), 1);
            let world = owner
                .source_world(&channel, "new-session")
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                world["connection"]["platform"],
                format!("openclaw:{}", row["registered"].as_str().unwrap())
            );
            // Compare the two real Rust producers, not duplicated expected
            // strings: Inbox guard consumes this scope and this handoff world.
            let bound = super::super::session_delivery::SessionChannelTarget {
                adapter: owner.adapter.clone(),
                chat_id: row["inbound"].as_str().unwrap().into(),
                channel_id: "bot".into(),
                source_type: source_type.clone(),
                name: None,
            };
            let scope = super::super::channel_messaging::resolve_scope_from_channels(
                vec![channel],
                &[bound],
                &std::collections::HashMap::from([("bot".into(), owner.adapter.clone())]),
                "new-session",
                std::path::Path::new("/synthetic"),
            )
            .unwrap()
            .projection();
            assert_eq!(
                scope["channels"][0]["platform"], world["connection"]["platform"],
                "{}",
                row
            );
            assert_eq!(
                scope["defaultTarget"]["channelId"],
                world["connection"]["channelId"]
            );
            assert_eq!(scope["defaultTarget"]["id"], world["conversation"]["id"]);
            assert_eq!(
                scope["defaultTarget"]["idType"],
                world["conversation"]["idType"]
            );
            server.abort();
        }
    }

    #[test]
    fn lark_directory_uses_raw_ids_and_requires_group_evidence() {
        let target = ChannelTarget {
            channel_id: "bot".into(),
            target_type: "chat".into(),
            id: "oc_x".into(),
            id_type: "chat_id".into(),
        };
        let query = directory_targets(&target, &ImSourceType::Group);
        assert_eq!(query.groups, vec!["oc_x"]);
        assert!(query.users.is_empty());
        assert_eq!(
            transport_target(&ImPlatform::OpenClaw("openclaw-lark".into()), &target),
            "chat:oc_x"
        );
        let group = PeerDisplayName {
            id: "oc_x".into(),
            kind: PeerKind::Group,
            name: "work".into(),
        };
        assert_eq!(lark_group_name(&target.id, &[group]).unwrap(), "work");
        let private = PeerDisplayName {
            id: "oc_x".into(),
            kind: PeerKind::User,
            name: "person".into(),
        };
        assert!(lark_group_name(&target.id, &[private]).is_err());
        assert!(lark_group_name(&target.id, &[]).is_err());
    }

    #[tokio::test]
    async fn unknown_ack_retains_target_owned_attachment_but_rejection_releases_it() {
        let workspace =
            crate::workspace_files::test_support::make_test_workspace("channel_handoff");
        let event = uuid::Uuid::new_v4().to_string();
        let files = import_attachments(
            &workspace,
            &event,
            vec![HandoffAttachment {
                bytes: b"target-owned copy".to_vec(),
                name: "note.txt".into(),
                mime_type: "text/plain".into(),
                image: false,
                caption: None,
            }],
        )
        .await
        .unwrap();
        let path = std::path::Path::new(files[0]["path"].as_str().unwrap());
        let result = finish_delivery(
            &workspace,
            &event,
            DeliverOutcome::Unconfirmed {
                reason: "ACK lost".into(),
            },
        )
        .await;
        assert_eq!(result.0, "unknown");
        assert_eq!(std::fs::read(path).unwrap(), b"target-owned copy");
        let result = finish_delivery(
            &workspace,
            &event,
            DeliverOutcome::Rejected {
                reason: "binding changed".into(),
            },
        )
        .await;
        assert_eq!(result.0, "failed");
        assert!(!path.exists());
        std::fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn inbound_keys_and_canonical_targets_share_the_original_router_contract() {
        let router = SessionRouter::new_for_agent(PathBuf::from("/workspace"), "agent".into());
        for (platform, source, inbound, kind, id, id_type) in [
            (
                ImPlatform::Telegram,
                ImSourceType::Private,
                "123",
                "chat",
                "123",
                "chat_id",
            ),
            (
                ImPlatform::Feishu,
                ImSourceType::Private,
                "oc_p2p",
                "chat",
                "oc_p2p",
                "chat_id",
            ),
            (
                ImPlatform::Dingtalk,
                ImSourceType::Group,
                "group:cid",
                "chat",
                "cid",
                "conversation_id",
            ),
            (
                ImPlatform::OpenClaw("openclaw-lark".into()),
                ImSourceType::Private,
                "ou_x",
                "user",
                "ou_x",
                "open_id",
            ),
            (
                ImPlatform::OpenClaw("wecom".into()),
                ImSourceType::Private,
                "userid",
                "user",
                "userid",
                "userid",
            ),
            (
                ImPlatform::OpenClaw("wecom".into()),
                ImSourceType::Group,
                "chatid",
                "chat",
                "chatid",
                "chatid",
            ),
            (
                ImPlatform::OpenClaw("openclaw-weixin".into()),
                ImSourceType::Private,
                "user",
                "user",
                "user",
                "user_id",
            ),
            (
                ImPlatform::OpenClaw("qqbot".into()),
                ImSourceType::Group,
                "channel:123",
                "chat",
                "123",
                "channel_id",
            ),
        ] {
            let channel = ChannelCapability {
                id: "bot".into(),
                platform: platform.clone(),
                name: None,
                mode: ChannelDeliveryMode::Auto,
                group_activation: None,
                agent_id: Some("agent".into()),
                health_path: PathBuf::new(),
            };
            let target = binding_target(&channel, inbound, &source).unwrap();
            assert_eq!(
                (&*target.target_type, &*target.id, &*target.id_type),
                (kind, id, id_type)
            );
            let key = router.session_key_for_peer(&platform, &source, inbound);
            assert_eq!(
                key,
                format!(
                    "agent:agent:{platform}:{}:{inbound}",
                    if source == ImSourceType::Private {
                        "private"
                    } else {
                        "group"
                    }
                )
            );
            let world = Conversation {
                target,
                session_key: key,
                source_type: source,
                name: None,
            }
            .world(&channel, &platform);
            assert!(world["conversation"].get("name").is_none());
            assert_eq!(
                world["conversation"]["kind"],
                if id_type == "channel_id" {
                    "channel"
                } else if kind == "user" || inbound == "123" || inbound == "oc_p2p" {
                    "direct"
                } else {
                    "group"
                }
            );
        }
    }
}
