//! Team AI is a management surface over the existing Channel and Session owners.
use super::{
    adapter::ImAdapter,
    config_store::read_agent_configs_from_disk,
    health, model_commands,
    router::SessionRouter,
    state::{ChannelModelWorkGate, PeerLocks},
    types::{AgentConfigRust, ImHealthState, ImStatus},
    HealthManager, ManagedAgents,
};
use crate::sidecar::ManagedSidecarManager;
use crate::ulog_warn;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

fn agent_config(id: &str) -> Result<AgentConfigRust, String> {
    read_agent_configs_from_disk()
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| "Agent workspace unavailable".to_string())
}

fn read_health(agent: &str, channel: &str) -> Result<ImHealthState, String> {
    match std::fs::read_to_string(health::agent_channel_health_path(agent, channel)) {
        Ok(text) => serde_json::from_str(crate::utils::bom::strip_bom(&text))
            .map_err(|e| format!("Channel state is unreadable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ImHealthState::default()),
        Err(e) => Err(format!("Cannot read Channel state: {e}")),
    }
}

struct LiveChannel {
    router: Arc<Mutex<SessionRouter>>,
    health: Arc<HealthManager>,
    locks: PeerLocks,
    gate: Arc<ChannelModelWorkGate>,
}
async fn live_channel(agents: &ManagedAgents, agent: &str, channel: &str) -> Option<LiveChannel> {
    let guard = agents.lock().await;
    let bot = &guard.get(agent)?.channels.get(channel)?.bot_instance;
    Some(LiveChannel {
        router: bot.router.clone(),
        health: bot.health.clone(),
        locks: bot.peer_locks.clone(),
        gate: bot.model_work_gate.clone(),
    })
}

// ===== Team AI peer profiles =====
//
// One private chat / group of a Team AI Agent may own a complete birth template.
// `config.json` holds it at `agents[].channels[].peerProfiles[sessionKey]`; Node
// owns its shape (`src/server/utils/peer-profile.ts`). Writes happen only here and
// always replace the whole value: either composed by Node from the stored config
// plus one Team AI page edit (`UpdateConfig`), or copied from the peer's current
// Session after a Session-side change (`sync_peer_profile`) — never a partial merge.

fn stored_peer_profile(agent_id: &str, channel_id: &str, session_key: &str) -> Option<Value> {
    if !super::config_store::agent_is_team_ai(agent_id) {
        return None;
    }
    agent_config(agent_id)
        .ok()?
        .channels
        .into_iter()
        .find(|channel| channel.id == channel_id)?
        .peer_profiles
        .remove(session_key)
}

/// sessionKeys of a Channel whose Team AI peers own a profile (empty for ordinary Agents).
pub(super) fn profiled_peer_keys(
    agent_id: &str,
    channel_id: &str,
) -> std::collections::HashSet<String> {
    if !super::config_store::agent_is_team_ai(agent_id) {
        return Default::default();
    }
    agent_config(agent_id)
        .ok()
        .and_then(|cfg| cfg.channels.into_iter().find(|c| c.id == channel_id))
        .map(|channel| channel.peer_profiles.into_keys().collect())
        .unwrap_or_default()
}

/// Replace (`Some`) or delete (`None`) one peer profile. `expected` turns a
/// delete into compare-and-delete so a stale rejection cannot drop a newer profile.
fn write_peer_profile(
    channel_id: &str,
    session_key: &str,
    profile: Option<Value>,
    expected: Option<&Value>,
) -> Result<(), String> {
    super::commands::mutate_bot_config(channel_id, |channel, is_channel| {
        if !is_channel {
            return Err("Peer profiles belong to Agent Channels".into());
        }
        apply_peer_profile(channel, session_key, profile, expected);
        Ok(())
    })
    .map(|_| ())
}

fn apply_peer_profile(channel: &mut Value, session_key: &str, profile: Option<Value>, expected: Option<&Value>) {
    let Some(channel) = channel.as_object_mut() else { return };
    let mut map = channel
        .remove("peerProfiles")
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    match profile {
        Some(profile) => {
            map.insert(session_key.to_string(), profile);
        }
        None if expected.is_none() || map.get(session_key) == expected => {
            map.remove(session_key);
        }
        None => {}
    }
    if !map.is_empty() {
        channel.insert("peerProfiles".into(), Value::Object(map));
    }
}

/// The single birth entry for IM-born Sessions. A Team AI peer profile seeds the
/// Session when present; otherwise the Agent template does. A profile Node proves
/// permanently invalid falls back to the Agent template and is deleted here.
pub(super) async fn birth_for_peer(
    client: &reqwest::Client,
    manager: &ManagedSidecarManager,
    workspace: &str,
    owner: Option<(&str, &str)>,
    session_key: &str,
) -> Result<String, String> {
    let profile = owner.and_then(|(agent, channel)| stored_peer_profile(agent, channel, session_key));
    let mut birth = json!({"agentDir":workspace,"seedMaxPermission":true,"origin":{"kind":"agent-channel","surface":"channel_message"}});
    if let Some(profile) = &profile {
        birth["peerProfile"] = profile.clone();
    }
    let value = model_commands::create_birth_value(client, manager, &birth).await?;
    if let (Some(profile), Some((_, channel))) = (&profile, owner) {
        if value["peerProfile"] == "rejected" {
            ulog_warn!("[team-ai] Peer profile is no longer valid; following Agent defaults: channel={} key={}", channel, session_key);
            if let Err(error) = write_peer_profile(channel, session_key, None, Some(profile)) {
                ulog_warn!("[team-ai] Failed to delete invalid peer profile: {}", error);
            }
        }
    }
    model_commands::birth_session_id(&value)
}

/// Copy the peer's current Session configuration into its profile.
///
/// Callers hold the peer fence and have verified `session_id` is the peer's
/// current binding. Ordinary Agents are a no-op (`Ok(false)`).
pub(super) async fn sync_peer_profile(
    manager: &ManagedSidecarManager,
    agent_id: &str,
    channel_id: &str,
    session_key: &str,
    session_id: &str,
) -> Result<bool, String> {
    if !super::config_store::agent_is_team_ai(agent_id) {
        return Ok(false);
    }
    let profile = peer_profile_projection(manager, session_id).await?;
    write_peer_profile(channel_id, session_key, Some(profile), None)?;
    Ok(true)
}

/// Node's projection of a Session's complete execution choice (read-only).
async fn peer_profile_projection(manager: &ManagedSidecarManager, session_id: &str) -> Result<Value, String> {
    let port = model_commands::global_port(manager)?;
    let mut url = reqwest::Url::parse("http://localhost/api/im/peer-profile").map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("sessionId", session_id);
    let value = request_json(port, &format!("{}?{}", url.path(), url.query().unwrap_or_default()), None).await?;
    value.get("profile").filter(|p| p.is_object()).cloned().ok_or_else(|| "Session configuration unavailable".into())
}

/// Response field shared by every Team AI write: whether the peer profile followed the Session.
fn profile_outcome(result: Result<bool, String>) -> Value {
    match result {
        Ok(true) => json!("saved"),
        Ok(false) => Value::Null,
        Err(error) => {
            ulog_warn!("[team-ai] Session saved but peer profile was not: {}", error);
            json!("failed")
        }
    }
}

/// Desktop Chat entry: after a Team AI Session snapshot write, let its peer
/// profile follow if (and only if) that Session is some peer's current binding.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_team_ai_sync_peer_profile(
    agentState: tauri::State<'_, ManagedAgents>,
    manager: tauri::State<'_, ManagedSidecarManager>,
    agentId: String,
    sessionId: String,
) -> Result<Value, String> {
    if !super::config_store::agent_is_team_ai(&agentId) {
        return Ok(json!({"peerProfile":null}));
    }
    let mut unreadable = None;
    for channel in agent_config(&agentId)?.channels {
        let lifecycle = super::agent_channel::agent_channel_lifecycle_lock(&agentId, &channel.id);
        if let Some(live) = live_channel(agentState.inner(), &agentId, &channel.id).await {
            let current = |router: &SessionRouter| {
                router.active_sessions().into_iter().find(|peer| peer.session_id == sessionId).map(|peer| peer.session_key)
            };
            let Some(key) = current(&*live.router.lock().await) else { continue };
            // Never wait on the peer fence while holding the lifecycle lock: a fence holder
            // (e.g. a heartbeat turn) may itself reload Agent config, which takes that lock.
            let lock = live.locks.lock().await.entry(key.clone()).or_insert_with(|| Arc::new(Mutex::new(()))).clone();
            let _fence = lock.lock_owned().await;
            if current(&*live.router.lock().await).as_deref() != Some(key.as_str()) {
                return Ok(json!({"peerProfile":null}));
            }
            let outcome = async {
                let profile = peer_profile_projection(manager.inner(), &sessionId).await?;
                // Commit only if no start/stop is running and this is still the same Channel
                // instance and binding; a replacement owns any later write.
                let _lifecycle = lifecycle.try_lock().map_err(|_| "Channel is restarting; edit again to save the conversation settings".to_string())?;
                let same = live_channel(agentState.inner(), &agentId, &channel.id).await
                    .is_some_and(|now| Arc::ptr_eq(&now.router, &live.router));
                if !same || current(&*live.router.lock().await).as_deref() != Some(key.as_str()) {
                    return Err("Channel changed; edit again to save the conversation settings".to_string());
                }
                write_peer_profile(&channel.id, &key, Some(profile), None).map(|_| true)
            }
            .await;
            return Ok(json!({"peerProfile":profile_outcome(outcome)}));
        }
        // A stopped Channel has no peer fence. Its lifecycle lock keeps it stopped and the
        // persisted binding stable; nothing below waits on a lock a fence holder owns.
        let _lifecycle = lifecycle.lock().await;
        if live_channel(agentState.inner(), &agentId, &channel.id).await.is_some() {
            return Ok(json!({"peerProfile":profile_outcome(Err("Channel started; edit again to save the conversation settings".into()))}));
        }
        let key = match read_health(&agentId, &channel.id) {
            Ok(state) => state.active_sessions.into_iter().find(|peer| peer.session_id == sessionId).map(|peer| peer.session_key),
            Err(error) => {
                unreadable = Some(error);
                None
            }
        };
        let Some(key) = key else { continue };
        let outcome = sync_peer_profile(manager.inner(), &agentId, &channel.id, &key, &sessionId).await;
        return Ok(json!({"peerProfile":profile_outcome(outcome)}));
    }
    // An unreadable binding is not proof that the Session is unbound.
    Ok(json!({"peerProfile":unreadable.map_or(Value::Null, |error| profile_outcome(Err(error)))}))
}

/// Enumerate configured Channels, including disabled connections; read errors are not empty peers.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_team_ai_channels(
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
) -> Result<Value, String> {
    let cfg = agent_config(&agentId)?;
    let team_ai = super::config_store::agent_is_team_ai(&agentId);
    let mut channels = Vec::new();
    for channel in &cfg.channels {
        let live = live_channel(agentState.inner(), &agentId, &channel.id).await;
        let state = if let Some(live) = &live {
            Ok(live.health.get_state().await)
        } else {
            read_health(&agentId, &channel.id)
        };
        let mut row = json!({ "channelId": channel.id, "platform": channel.channel_type.to_string(), "name": channel.name,
            "enabled": channel.enabled, "online": false, "status": "stopped", "peers": [] });
        match state {
            // A read failure is not an empty Channel; the page offers a retry.
            Err(error) => row["loadError"] = json!(error),
            Ok(state) => {
                let running = live.is_some();
                row["online"] =
                    json!(running && channel.enabled && matches!(state.status, ImStatus::Online));
                let (current, history) = if let Some(live) = live {
                    let router = live.router.lock().await;
                    (router.active_sessions(), router.peer_history())
                } else {
                    (state.active_sessions, state.peer_session_history)
                };
                let mut router = SessionRouter::new_for_agent(
                    cfg.resolved_workspace_path.clone().into(),
                    agentId.clone(),
                );
                router.restore_peer_history(history);
                // Projection only: do not restore/rotate/ensure any execution identity while browsing.
                let mut peers = router.peer_history();
                for peer in &current {
                    let entry = peers.iter_mut().find(|h| h.session_key == peer.session_key);
                    if let Some(entry) = entry {
                        if peer.metadata_indexed && !entry.session_ids.contains(&peer.session_id) {
                            entry.session_ids.push(peer.session_id.clone());
                        }
                    } else {
                        peers.push(super::types::PeerSessionHistory {
                            session_key: peer.session_key.clone(),
                            source_type: peer.source_type.clone(),
                            source_id: peer.source_id.clone().unwrap_or_else(|| {
                                super::router::parse_session_key(&peer.session_key).1
                            }),
                            source_display_name: peer.source_display_name.clone(),
                            workspace_path: peer.workspace_path.clone(),
                            session_ids: if peer.metadata_indexed {
                                vec![peer.session_id.clone()]
                            } else {
                                Vec::new()
                            },
                        });
                    }
                }
                row["status"] = if running {
                    json!(state.status)
                } else {
                    json!("stopped")
                };
                row["error"] = json!(state.error_message);
                row["peers"] = json!(peers.into_iter().map(|peer| {
                    let active = current.iter().find(|p| p.session_key == peer.session_key);
                    json!({"sessionKey":peer.session_key,"sourceType":peer.source_type,"sourceId":peer.source_id,
                        "hasProfile":team_ai && channel.peer_profiles.contains_key(&peer.session_key),
                        "name":active.and_then(|p| p.source_display_name.clone()).or(peer.source_display_name)
                            .or_else(|| configured_peer_name(channel, &peer.source_type, &peer.source_id)),
                        "sessionId":active.map(|p| p.session_id.clone()),"sessionIds":peer.session_ids})
                }).collect::<Vec<_>>());
            }
        }
        channels.push(row);
    }
    Ok(json!({"channels": channels}))
}

/// Names the operator already gave this peer in the Channel's access settings.
fn configured_peer_name(
    channel: &super::types::ChannelConfigRust,
    source_type: &super::types::ImSourceType,
    source_id: &str,
) -> Option<String> {
    let name = match source_type {
        super::types::ImSourceType::Group => channel
            .group_permissions
            .iter()
            .find(|group| group.group_id == source_id)
            .map(|group| group.group_name.clone()),
        _ => channel.user_display_names.get(source_id).cloned(),
    };
    name.filter(|name| !name.trim().is_empty())
}

async fn metadata(workspace: &str, session: &str) -> Result<Value, String> {
    crate::session_metadata::cmd_list_session_metadata(Some(workspace.to_string()))
        .await?
        .into_iter()
        .find(|m| m["id"].as_str() == Some(session))
        .ok_or_else(|| "Session unavailable in this workspace".into())
}

async fn request_json(port: u16, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let client = crate::local_http::json_client(Duration::from_secs(60));
    let url = format!("http://127.0.0.1:{port}{path}");
    let response = match body {
        Some(body) => client.post(&url).json(body).send().await,
        None => client.get(&url).send().await,
    }
    .map_err(|e| format!("Operation result unconfirmed; refresh: {e}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("Operation response unconfirmed: {e}"))?;
    if !status.is_success()
        && value["requiresNewSession"] != true
        && value["sessionConfig"] != "saved"
    {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Session request failed")
            .to_string());
    }
    Ok(value)
}

async fn session_request(
    manager: &ManagedSidecarManager,
    session: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Option<Value>, String> {
    // Pin the exact generation under lifecycle arbitration, then release the
    // lifecycle lock before HTTP: Goal stop calls back into that same owner.
    let dispatch = {
        let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[session]).await;
        manager
            .lock()
            .map_err(|e| e.to_string())?
            .acquire_session_dispatch(session)?
    };
    let Some(dispatch) = dispatch else {
        return Ok(None);
    };
    let client = crate::local_http::json_client(Duration::from_secs(60));
    let url = dispatch.url_for_path(path)?;
    let response = match body {
        Some(body) => client.post(url).json(body).send().await,
        None => client.get(url).send().await,
    }
    .map_err(|e| format!("Operation result unconfirmed; refresh: {e}"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success()
        && value["requiresNewSession"] != true
        && value["sessionConfig"] != "saved"
    {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Session request failed")
            .to_string());
    }
    Ok(Some(value))
}

async fn known_session(
    agents: &ManagedAgents,
    agent: &str,
    channel: &str,
    key: &str,
    session: &str,
) -> Result<String, String> {
    let cfg = agent_config(agent)?;
    if !cfg.channels.iter().any(|c| c.id == channel) {
        return Err("Channel unavailable".into());
    }
    let (active, history) = if let Some(live) = live_channel(agents, agent, channel).await {
        let router = live.router.lock().await;
        (router.active_sessions(), router.peer_history())
    } else {
        let state = read_health(agent, channel)?;
        (state.active_sessions, state.peer_session_history)
    };
    let known = active
        .iter()
        .any(|p| p.session_key == key && p.session_id == session)
        || history
            .iter()
            .any(|p| p.session_key == key && p.session_ids.iter().any(|id| id == session));
    if !known {
        return Err("Session is not associated with this conversation".into());
    }
    metadata(&cfg.resolved_workspace_path, session).await?;
    Ok(cfg.resolved_workspace_path)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSessionTarget {
    channel_id: String,
    session_key: String,
    session_id: String,
}

/// Bounded, lightweight observations. Reading never creates a Session process.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_team_ai_states(
    agentState: tauri::State<'_, ManagedAgents>,
    manager: tauri::State<'_, ManagedSidecarManager>,
    agentId: String,
    targets: Vec<TeamSessionTarget>,
) -> Result<Value, String> {
    if targets.len() > 64 {
        return Err("Too many Session observations".into());
    }
    use futures_util::{stream, StreamExt};
    let agents = agentState.inner();
    let manager = manager.inner();
    let agent = agentId.as_str();
    let states: Vec<Value> = stream::iter(targets).map(|target| async move {
        let result = async {
            known_session(
                agents,
                agent,
                &target.channel_id,
                &target.session_key,
                &target.session_id,
            )
            .await?;
            session_request(
                manager,
                &target.session_id,
                "/api/session-state",
                None,
            )
            .await
        }
        .await;
        let mut row = json!({"channelId":target.channel_id,"sessionKey":target.session_key,"sessionId":target.session_id,"state":null});
        match result {
            Ok(Some(value)) if value["sessionId"] == target.session_id => {
                row["state"] = value["sessionState"].clone()
            }
            Ok(Some(_)) => row["error"] = json!("Session identity changed"),
            Ok(None) => {}
            Err(error) => row["error"] = json!(error),
        }
        row
    }).buffer_unordered(8).collect().await;
    Ok(json!({"states":states}))
}

/// UpdateConfig result after the profile has committed: whatever happens to the current
/// Session (start failure, request failure, apply failure) is reported, never thrown.
fn config_apply_outcome(applied: Result<Option<Value>, String>) -> Value {
    match applied {
        Ok(Some(result)) if result["success"] == true => {
            json!({"success":true,"peerProfile":"saved","sessionApply":result["runtimeApply"].as_str().unwrap_or("applied")})
        }
        Ok(Some(result)) => json!({"success":false,"peerProfile":"saved","sessionApply":"failed","sessionConfig":result["sessionConfig"],"error":result["error"]}),
        Ok(None) => json!({"success":false,"peerProfile":"saved","sessionApply":"failed","error":"Session stopped"}),
        Err(error) => json!({"success":false,"peerProfile":"saved","sessionApply":"failed","error":error}),
    }
}

/// Current binding of a peer without requiring a live Channel (live Router, else health).
async fn current_session(agents: &ManagedAgents, agent: &str, channel: &str, key: &str) -> Result<Option<String>, String> {
    if let Some(live) = live_channel(agents, agent, channel).await {
        return Ok(live.router.lock().await.peer_session_snapshot(key).map(|p| p.session_id));
    }
    Ok(read_health(agent, channel)?
        .active_sessions
        .into_iter()
        .find(|peer| peer.session_key == key)
        .map(|peer| peer.session_id))
}

/// Read-only view of a peer's config (its profile, else the Agent template) and the
/// catalogue to edit it. Works for stopped Channels; never starts a Session.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_team_ai_peer_config(
    agentState: tauri::State<'_, ManagedAgents>,
    manager: tauri::State<'_, ManagedSidecarManager>,
    agentId: String,
    channelId: String,
    sessionKey: String,
) -> Result<Value, String> {
    let session = current_session(agentState.inner(), &agentId, &channelId, &sessionKey).await?;
    let profile = stored_peer_profile(&agentId, &channelId, &sessionKey);
    request_json(
        model_commands::global_port(manager.inner())?,
        "/api/im/peer-config",
        Some(&json!({"agentId":agentId,"profile":profile,"sessionId":session})),
    )
    .await
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TeamAiAction {
    New,
    /// Stop owning a profile; later births follow the Agent template again.
    ClearProfile,
    /// Change one field of the peer config. The whole next config becomes the profile;
    /// a compatible change is also applied to the current Session.
    UpdateConfig { change: Value },
    SetPrimary {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_team_ai_action(
    app: AppHandle,
    agentState: tauri::State<'_, ManagedAgents>,
    manager: tauri::State<'_, ManagedSidecarManager>,
    agentId: String,
    channelId: String,
    sessionKey: String,
    expectedSessionId: Option<String>,
    action: TeamAiAction,
) -> Result<Value, String> {
    let cfg = agent_config(&agentId)?;
    let live = live_channel(agentState.inner(), &agentId, &channelId)
        .await
        .ok_or("Channel is offline; start it before making changes")?;
    let _work = live.gate.try_enter().ok_or("Channel is stopping")?;
    let lock = live
        .locks
        .lock()
        .await
        .entry(sessionKey.clone())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();
    let fence = lock.lock_owned().await;
    let prior = live
        .router
        .lock()
        .await
        .peer_session_snapshot(&sessionKey)
        .map(|p| p.session_id);
    if prior != expectedSessionId {
        return Err("Conversation changed; refresh before continuing".into());
    }
    if !live.router.lock().await.knows_peer(&sessionKey) {
        return Err("Conversation unavailable".into());
    }
    let (target, created) = match action {
        TeamAiAction::SetPrimary { session_id } => {
            known_session(agentState.inner(), &agentId, &channelId, &sessionKey, &session_id).await?;
            if prior.as_deref() == Some(&session_id) {
                return Ok(json!({"success":true}));
            }
            (session_id, false)
        }
        TeamAiAction::New => {
            let born = birth_for_peer(
                &crate::local_http::json_client(Duration::from_secs(60)),
                manager.inner(),
                &cfg.resolved_workspace_path,
                Some((&agentId, &channelId)),
                &sessionKey,
            )
            .await?;
            (born, true)
        }
        TeamAiAction::ClearProfile => {
            write_peer_profile(&channelId, &sessionKey, None, None)?;
            return Ok(json!({"success":true}));
        }
        TeamAiAction::UpdateConfig { change } => {
            let profile = stored_peer_profile(&agentId, &channelId, &sessionKey);
            let composed = request_json(
                model_commands::global_port(manager.inner())?,
                "/api/im/peer-config/compose",
                Some(&json!({"agentId":agentId,"profile":profile,"sessionId":prior,"change":change})),
            )
            .await?;
            let next = composed.get("profile").filter(|p| p.is_object()).cloned().ok_or("Peer configuration unavailable")?;
            // The profile is the operator's intent; it commits first and stands on its own.
            write_peer_profile(&channelId, &sessionKey, Some(next), None)?;
            let Some(apply) = composed.get("apply").filter(|a| a.is_object()) else {
                // "applied" when the current Session already runs this config (e.g. switched back to its Runtime).
                let state = if composed["inEffect"].as_bool() == Some(true) { "applied" } else { "skipped" };
                return Ok(json!({"success":true,"peerProfile":"saved","sessionApply":state}));
            };
            let (Some(sid), Some(path)) = (prior.as_deref(), apply["path"].as_str()) else {
                return Ok(json!({"success":true,"peerProfile":"saved","sessionApply":"skipped"}));
            };
            let applied = match super::state::ensure_sidecar_port_for_command(&live.router, &sessionKey, "builtin", None, &app, manager.inner(), &live.health).await {
                Ok(_) => session_request(manager.inner(), sid, path, Some(&apply["body"])).await,
                Err(error) => Err(error),
            };
            drop(fence);
            return Ok(config_apply_outcome(applied));
        }
    };
    let handover = super::handover::handover_session_to_channel(
        app.clone(),
        target.clone(),
        agentId.clone(),
        channelId.clone(),
        cfg.resolved_workspace_path,
        Some(sessionKey.clone()),
        Some((sessionKey.clone(), fence)),
        Some(prior.unwrap_or_default()),
    )
    .await;
    match handover {
        Ok((result, fence, adapter, chat_id)) => {
            drop(fence);
            let notified = adapter
                .send_message(
                    &chat_id,
                    &format!("当前会话切换至「{}」", target.chars().take(8).collect::<String>()),
                )
                .await
                .is_ok();
            let _ = app.emit(
                "agent:status-changed",
                json!({"agentId":agentId,"channelId":channelId}),
            );
            Ok(json!({"success":true,"sessionId":target,"statePersisted":result.state_persisted,"notified":notified,"warning":result.warning}))
        }
        Err(error) => Ok(
            json!({"success":false,"createdSessionId":if created { Some(target) } else { None },"error":error}),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::{SidecarManager, SidecarOwner};

    // HOME isolates config IO on Unix (same pattern as im::commands group_access_tests).
    #[cfg(unix)]
    #[test]
    fn peer_profiles_persist_and_are_read_only_for_team_ai_agents() {
        let home = tempfile::tempdir().unwrap();
        let output = crate::process_cmd::new(std::env::current_exe().unwrap())
            .args(["--exact", "im::team_ai::tests::peer_profiles_disk_child", "--nocapture"])
            .env("HOME", home.path())
            .env("MYAGENTS_TEAM_AI_TEST_HOME", home.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    #[test]
    fn peer_profiles_disk_child() {
        let Some(home) = std::env::var_os("MYAGENTS_TEAM_AI_TEST_HOME") else {
            return;
        };
        let dir = std::path::PathBuf::from(home).join(".myagents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), serde_json::to_vec(&json!({"agents":[{"id":"agent","name":"Team","enabled":false,
            "channels":[{"id":"bot","type":"telegram","enabled":false,"name":"Bot"}]}]})).unwrap()).unwrap();
        let projects = |purpose: Option<&str>| {
            std::fs::write(dir.join("projects.json"), serde_json::to_vec(&json!([{"id":"p","agentId":"agent","path":"/tmp/team","purpose":purpose}])).unwrap()).unwrap();
        };
        projects(Some("team-ai"));
        let first = json!({"runtime":"builtin","model":"a"});
        let newer = json!({"runtime":"builtin","model":"b"});
        write_peer_profile("bot", "k", Some(first.clone()), None).unwrap();
        assert_eq!(stored_peer_profile("agent", "bot", "k"), Some(first.clone()));
        assert!(profiled_peer_keys("agent", "bot").contains("k"));
        write_peer_profile("bot", "k", Some(newer.clone()), None).unwrap();
        // A stale rejection (observed for `first`) must not delete the newer profile.
        write_peer_profile("bot", "k", None, Some(&first)).unwrap();
        assert_eq!(stored_peer_profile("agent", "bot", "k"), Some(newer.clone()));
        // Ordinary Agents never read peer profiles; the data is kept for a later re-join.
        projects(None);
        assert_eq!(stored_peer_profile("agent", "bot", "k"), None);
        assert!(profiled_peer_keys("agent", "bot").is_empty());
        projects(Some("team-ai"));
        assert_eq!(stored_peer_profile("agent", "bot", "k"), Some(newer));
        write_peer_profile("bot", "k", None, None).unwrap();
        assert_eq!(stored_peer_profile("agent", "bot", "k"), None);
    }

    #[test]
    fn config_edits_report_every_current_session_failure_after_the_profile_committed() {
        let ok = config_apply_outcome(Ok(Some(json!({"success":true,"runtimeApply":"deferred"}))));
        assert_eq!(ok, json!({"success":true,"peerProfile":"saved","sessionApply":"deferred"}));
        for failure in [
            Err("Session Sidecar failed to start".to_string()),
            Ok(None),
            Ok(Some(json!({"success":false,"sessionConfig":"saved","error":"apply failed"}))),
        ] {
            let outcome = config_apply_outcome(failure);
            assert_eq!(outcome["peerProfile"], "saved");
            assert_eq!(outcome["sessionApply"], "failed");
        }
    }

    #[test]
    fn peer_profile_writes_replace_whole_values_and_delete_only_the_expected_stale_value() {
        let mut channel = json!({"id":"c","peerProfiles":{"other":{"runtime":"dsh"}}});
        let first = json!({"runtime":"builtin","model":"a"});
        let newer = json!({"runtime":"builtin","model":"b"});
        apply_peer_profile(&mut channel, "k", Some(first.clone()), None);
        apply_peer_profile(&mut channel, "k", Some(newer.clone()), None);
        assert_eq!(channel["peerProfiles"]["k"], newer);
        // A rejection observed for `first` must not delete the newer profile.
        apply_peer_profile(&mut channel, "k", None, Some(&first));
        assert_eq!(channel["peerProfiles"]["k"], newer);
        apply_peer_profile(&mut channel, "k", None, None);
        assert!(channel["peerProfiles"].get("k").is_none());
        assert_eq!(channel["peerProfiles"]["other"]["runtime"], "dsh");
        apply_peer_profile(&mut channel, "other", None, None);
        assert!(channel.get("peerProfiles").is_none(), "empty map is not persisted");
    }

    #[test]
    fn peer_profiles_round_trip_through_the_typed_channel_config() {
        let raw = json!({"id":"c","type":"telegram","enabled":true,
            "peerProfiles":{"agent:a:telegram:private:1":{"runtime":"builtin","model":"m","mcpEnabledServers":["x"]}}});
        let channel: super::super::types::ChannelConfigRust = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(channel.peer_profiles.len(), 1);
        assert_eq!(serde_json::to_value(&channel).unwrap()["peerProfiles"], raw["peerProfiles"]);
        let empty: super::super::types::ChannelConfigRust =
            serde_json::from_value(json!({"id":"c","type":"telegram","enabled":true})).unwrap();
        assert!(serde_json::to_value(&empty).unwrap().get("peerProfiles").is_none());
    }

    #[test]
    fn peer_names_fall_back_to_operator_given_access_names() {
        let channel: super::super::types::ChannelConfigRust = serde_json::from_value(json!({
            "id":"c","type":"telegram","enabled":true,
            "userDisplayNames":{"u1":"李奕晨","u2":"  "},
            "groupPermissions":[{"groupId":"g1","groupName":"产品研发群","platform":"telegram","status":"approved","discoveredAt":"t","addedBy":null}]
        })).unwrap();
        use super::super::types::ImSourceType;
        assert_eq!(configured_peer_name(&channel, &ImSourceType::Private, "u1").as_deref(), Some("李奕晨"));
        assert_eq!(configured_peer_name(&channel, &ImSourceType::Private, "u2"), None);
        assert_eq!(configured_peer_name(&channel, &ImSourceType::Group, "g1").as_deref(), Some("产品研发群"));
        assert_eq!(configured_peer_name(&channel, &ImSourceType::Group, "u1"), None);
    }

    #[tokio::test]
    async fn stop_callback_can_reenter_goal_lifecycle_while_dispatch_generation_is_pinned() {
        use axum::{routing::post, Json, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let service = Router::new().route(
            "/chat/stop",
            post(|| async {
                // The real Node facade awaits Rust Goal pause, which takes this lock.
                let _goal =
                    crate::sidecar::acquire_session_lifecycle(&["team-stop-goal-test"]).await;
                Json(json!({"success":true}))
            }),
        );
        let server =
            tauri::async_runtime::spawn(
                async move { axum::serve(listener, service).await.unwrap() },
            );
        let manager = Arc::new(std::sync::Mutex::new(SidecarManager::new()));
        manager.lock().unwrap().insert_test_ready_frontend_sidecar(
            "team-stop-goal-test",
            port,
            SidecarOwner::Tab("test-only".into()),
        );
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            session_request(
                &manager,
                "team-stop-goal-test",
                "/chat/stop",
                Some(&json!({})),
            ),
        )
        .await
        .expect("Goal callback must not wait on the caller lifecycle lock")
        .unwrap()
        .unwrap();
        assert_eq!(response["success"], true);
        server.abort();
    }

    #[tokio::test]
    async fn management_reads_and_stop_do_not_start_a_dormant_session() {
        let manager = Arc::new(std::sync::Mutex::new(SidecarManager::new()));
        assert!(
            session_request(&manager, "dormant", "/api/session-state", None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            session_request(&manager, "dormant", "/chat/stop", Some(&json!({})))
                .await
                .unwrap()
                .is_none()
        );
        assert!(manager
            .lock()
            .unwrap()
            .get_session_port("dormant")
            .is_none());
    }
}
