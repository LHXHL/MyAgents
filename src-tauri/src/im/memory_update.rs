// Memory Auto-Update module (v0.1.43)
// Periodically triggers UPDATE_MEMORY.md in qualifying sessions to maintain long-term memory.
// Runs as an independent tokio task, spawned from HeartbeatRunner's run_once().

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Timelike, Utc};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::RwLock;

use crate::config_io::with_config_lock;
use crate::sidecar::{self, ManagedSidecarManager, SidecarOwner};
use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};

use super::types::MemoryAutoUpdateConfig;

/// Lightweight session metadata from sessions.json (only fields we need)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    id: String,
    #[serde(default)]
    agent_dir: Option<String>,
    #[serde(default)]
    last_active_at: Option<String>,
}

/// Minimal message line from session JSONL
#[derive(Debug, Deserialize)]
struct MessageLine {
    role: Option<String>,
    content: Option<serde_json::Value>,
}

/// Response from Bun POST /api/memory/update
#[derive(Debug, Deserialize)]
struct MemoryUpdateResponse {
    status: String,
    #[allow(dead_code)]
    reason: Option<String>,
}

enum MemoryUpdateSidecarTarget {
    Ready(u16),
    BoundButNotReady,
    Missing,
}

/// Outcome of one session's memory update. `Deferred` (sidecar bound but still
/// booting) is an EXPECTED transient — not a failure — so the caller retries it
/// next phase and logs at info, instead of writing an ERROR to the unified log
/// every heartbeat (cross-review CC Warning).
enum SessionUpdateOutcome {
    Updated,
    Deferred,
    Failed(String),
}

enum UpdateMemoryFileState {
    Ready,
    Empty,
}

/// Check conditions and spawn a batch memory update task if all gates pass.
/// Called at the end of HeartbeatRunner::run_once().
pub async fn check_and_spawn<R: Runtime>(
    agent_id: &str,
    workspace_path: &str,
    config: &Arc<RwLock<Option<MemoryAutoUpdateConfig>>>,
    is_running: &Arc<AtomicBool>,
    sidecar_manager: &ManagedSidecarManager,
    app_handle: &AppHandle<R>,
    // Hot-reloadable AI config for syncing to temp sidecars
    current_model: &Arc<RwLock<Option<String>>>,
    current_provider_env: &Arc<RwLock<Option<serde_json::Value>>>,
    mcp_servers_json: &Arc<RwLock<Option<String>>>,
    // Fallback timezone from heartbeat activeHours (when updateWindowTimezone is None)
    heartbeat_timezone: Option<&str>,
) {
    // Gate 1: Config exists and enabled
    let mau_config = {
        let guard = config.read().await;
        match guard.as_ref() {
            Some(c) if c.enabled => {
                let mut cfg = c.clone();
                // Timezone fallback: memoryAutoUpdate → heartbeat.activeHours → Asia/Shanghai
                if cfg.update_window_timezone.is_none() {
                    cfg.update_window_timezone = heartbeat_timezone.map(|s| s.to_string());
                }
                cfg
            }
            _ => return,
        }
    };

    // Gate 2: (removed) — Memory update is an autonomous operation. The Bun endpoint
    // now forces bypassPermissions, so the agent's configured permission mode no longer
    // matters for tool execution. Previously this gate blocked updates when the agent was
    // in 'plan' or 'acceptEdits' mode, but that was overly restrictive.

    // Gate 3: Current time in update window
    if !is_in_update_window(&mau_config) {
        ulog_debug!("[memory-update] Skipped: outside update window");
        return;
    }

    // Gate 4: Interval since last batch
    if let Some(ref last_batch) = mau_config.last_batch_at {
        if let Ok(last_dt) = last_batch.parse::<DateTime<Utc>>() {
            let hours_since = (Utc::now() - last_dt).num_hours();
            if hours_since < mau_config.interval_hours as i64 {
                ulog_debug!(
                    "[memory-update] Skipped: only {}h since last batch (need {}h)",
                    hours_since,
                    mau_config.interval_hours
                );
                return;
            }
        }
    }

    // Gate 5: Not already running (atomic CAS)
    if is_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        ulog_debug!("[memory-update] Skipped: batch already running");
        return;
    }

    // Gate 6: Ensure memory rule substrate + UPDATE_MEMORY.md at use time so
    // default-enabled agents can actually run without a manual file click.
    let rule_substrate =
        match crate::workspace_files::memory_rules::ensure_memory_rule_substrate_for_workspace(
            workspace_path,
        ) {
            Ok(result) => result,
            Err(e) => {
                ulog_warn!("[memory-update] Failed to prepare memory rules: {}", e);
                is_running.store(false, Ordering::SeqCst);
                return;
            }
        };
    let update_md_path = match resolve_update_memory_path(workspace_path) {
        Ok(path) => path,
        Err(e) => {
            ulog_warn!(
                "[memory-update] Invalid workspace for UPDATE_MEMORY.md: {}",
                e
            );
            is_running.store(false, Ordering::SeqCst);
            return;
        }
    };
    match ensure_update_memory_file(&update_md_path, &rule_substrate.memory.relative_path) {
        Ok(UpdateMemoryFileState::Ready) => {}
        Ok(UpdateMemoryFileState::Empty) => {
            ulog_debug!("[memory-update] Skipped: UPDATE_MEMORY.md body is empty");
            is_running.store(false, Ordering::SeqCst);
            return;
        }
        Err(e) => {
            ulog_warn!("[memory-update] Failed to prepare UPDATE_MEMORY.md: {}", e);
            is_running.store(false, Ordering::SeqCst);
            return;
        }
    }

    // Gate 7: Collect qualifying sessions
    let qualifying = collect_qualifying_sessions(workspace_path, &mau_config);
    if qualifying.is_empty() {
        ulog_debug!("[memory-update] Skipped: no qualifying sessions");
        is_running.store(false, Ordering::SeqCst);
        return;
    }

    ulog_info!(
        "[memory-update] Starting batch for agent {} — {} qualifying session(s)",
        agent_id,
        qualifying.len()
    );

    // Record lastBatchAt NOW (before spawning)
    update_config_field(app_handle, agent_id, |c| {
        c.last_batch_at = Some(Utc::now().to_rfc3339());
    })
    .await;

    // Spawn independent batch task
    let is_running_clone = Arc::clone(is_running);
    let agent_id_owned = agent_id.to_string();
    let workspace_owned = workspace_path.to_string();
    let sm = Arc::clone(sidecar_manager);
    let ah = app_handle.clone();
    let model = Arc::clone(current_model);
    let provider_env = Arc::clone(current_provider_env);
    let mcp_json = Arc::clone(mcp_servers_json);

    tauri::async_runtime::spawn(async move {
        let count = run_batch(
            &qualifying,
            &agent_id_owned,
            &workspace_owned,
            &sm,
            &ah,
            &model,
            &provider_env,
            &mcp_json,
        )
        .await;

        // Update lastBatchSessionCount
        update_config_field(&ah, &agent_id_owned, move |c| {
            c.last_batch_session_count = Some(count);
        })
        .await;

        is_running_clone.store(false, Ordering::SeqCst);
        ulog_info!(
            "[memory-update] Batch complete for agent {} — {}/{} sessions updated",
            agent_id_owned,
            count,
            qualifying.len()
        );
    });
}

/// Cooldown: skip sessions with user activity in the last N minutes, retry once after waiting.
const ACTIVE_SESSION_COOLDOWN_MINUTES: i64 = 15;

/// Run the batch: serially process each qualifying session.
/// Sessions with recent user activity are deferred and retried after a cooldown.
async fn run_batch<R: Runtime>(
    sessions: &[String],
    agent_id: &str,
    workspace_path: &str,
    sidecar_manager: &ManagedSidecarManager,
    app_handle: &AppHandle<R>,
    current_model: &Arc<RwLock<Option<String>>>,
    current_provider_env: &Arc<RwLock<Option<serde_json::Value>>>,
    mcp_servers_json: &Arc<RwLock<Option<String>>>,
) -> u32 {
    let http_client = crate::local_http::json_client(Duration::from_secs(3660)); // 61 min (Bun waits 60 min internally)
    let mut updated = 0u32;
    let mut deferred: Vec<String> = Vec::new();

    // Phase 1: process idle sessions, defer recently active ones
    let active_map = read_session_last_active_map();
    let cutoff = Utc::now() - chrono::Duration::minutes(ACTIVE_SESSION_COOLDOWN_MINUTES);

    for session_id in sessions {
        if let Some(last_active) = active_map.get(session_id.as_str()) {
            if *last_active > cutoff {
                let ago = (Utc::now() - *last_active).num_minutes();
                ulog_info!(
                    "[memory-update] Session {} active {}min ago (cooldown {}min), deferring",
                    session_id,
                    ago,
                    ACTIVE_SESSION_COOLDOWN_MINUTES
                );
                deferred.push(session_id.clone());
                continue;
            }
        }

        match update_single_session(
            session_id,
            agent_id,
            workspace_path,
            sidecar_manager,
            app_handle,
            &http_client,
            current_model,
            current_provider_env,
            mcp_servers_json,
        )
        .await
        {
            SessionUpdateOutcome::Updated => {
                updated += 1;
                ulog_info!(
                    "[memory-update] Session {} updated successfully",
                    session_id
                );
            }
            SessionUpdateOutcome::Deferred => {
                // Sidecar bound but still booting — expected transient, retry next phase.
                ulog_info!(
                    "[memory-update] Session {} sidecar still booting, deferring to retry phase",
                    session_id
                );
                deferred.push(session_id.clone());
            }
            SessionUpdateOutcome::Failed(e) => {
                ulog_error!("[memory-update] Session {} failed: {}", session_id, e);
            }
        }
    }

    // Phase 2: retry deferred sessions after cooldown
    if !deferred.is_empty() {
        ulog_info!(
            "[memory-update] {} session(s) deferred, retrying in {}min",
            deferred.len(),
            ACTIVE_SESSION_COOLDOWN_MINUTES
        );
        tokio::time::sleep(Duration::from_secs(
            ACTIVE_SESSION_COOLDOWN_MINUTES as u64 * 60,
        ))
        .await;

        // Re-read fresh timestamps
        let fresh_map = read_session_last_active_map();
        let fresh_cutoff = Utc::now() - chrono::Duration::minutes(ACTIVE_SESSION_COOLDOWN_MINUTES);

        for session_id in &deferred {
            if let Some(last_active) = fresh_map.get(session_id.as_str()) {
                if *last_active > fresh_cutoff {
                    ulog_info!(
                        "[memory-update] Session {} still active after wait, skipping",
                        session_id
                    );
                    continue;
                }
            }

            match update_single_session(
                session_id,
                agent_id,
                workspace_path,
                sidecar_manager,
                app_handle,
                &http_client,
                current_model,
                current_provider_env,
                mcp_servers_json,
            )
            .await
            {
                SessionUpdateOutcome::Updated => {
                    updated += 1;
                    ulog_info!(
                        "[memory-update] Session {} updated successfully (deferred)",
                        session_id
                    );
                }
                SessionUpdateOutcome::Deferred => {
                    // Already waited the cooldown; no further retry phase. Still
                    // booting is an expected transient, not a failure — info, not error.
                    ulog_info!(
                        "[memory-update] Session {} sidecar still not ready after cooldown, skipping",
                        session_id
                    );
                }
                SessionUpdateOutcome::Failed(e) => {
                    ulog_error!(
                        "[memory-update] Session {} failed (deferred): {}",
                        session_id,
                        e
                    );
                }
            }
        }
    }

    updated
}

/// Update a single session: ensure sidecar -> POST /api/memory/update -> release if temp
async fn update_single_session<R: Runtime>(
    session_id: &str,
    agent_id: &str,
    workspace_path: &str,
    sidecar_manager: &ManagedSidecarManager,
    app_handle: &AppHandle<R>,
    http_client: &reqwest::Client,
    current_model: &Arc<RwLock<Option<String>>>,
    current_provider_env: &Arc<RwLock<Option<serde_json::Value>>>,
    mcp_servers_json: &Arc<RwLock<Option<String>>>,
) -> SessionUpdateOutcome {
    let memory_update_key = format!("memory_update:{}:{}", agent_id, session_id);
    let owner = SidecarOwner::Agent(memory_update_key.clone());

    // Only create a temporary sidecar when no entry is bound at all. A
    // bound-but-not-ready sidecar may belong to a Tab/Cron/IM owner that is
    // still booting or awaiting health-monitor recovery; memory update must
    // not drive ensure's replacement/removal paths for that owner.
    let target = {
        let mut mgr = match sidecar_manager.lock() {
            Ok(g) => g,
            Err(e) => return SessionUpdateOutcome::Failed(format!("lock: {}", e)),
        };
        if let Some(port) = mgr.get_session_port(session_id) {
            MemoryUpdateSidecarTarget::Ready(port)
        } else if mgr.generation_for(session_id).is_some() {
            MemoryUpdateSidecarTarget::BoundButNotReady
        } else {
            MemoryUpdateSidecarTarget::Missing
        }
    };

    let (port, was_temp) = match target {
        MemoryUpdateSidecarTarget::Ready(port) => (port, false),
        MemoryUpdateSidecarTarget::BoundButNotReady => {
            return SessionUpdateOutcome::Deferred;
        }
        MemoryUpdateSidecarTarget::Missing => {
            // Need to start a temporary sidecar via spawn_blocking (ensure_session_sidecar is blocking)
            let started: Result<(u16, bool), String> = async {
                let ah = app_handle.clone();
                let sm = Arc::clone(sidecar_manager);
                let sid = session_id.to_string();
                let ws = workspace_path.to_string();
                let own = owner.clone();

                let result = tokio::task::spawn_blocking(move || {
                    let workspace = PathBuf::from(&ws);
                    sidecar::ensure_session_sidecar(&ah, &sm, &sid, &workspace, own)
                })
                .await
                .map_err(|e| format!("spawn_blocking: {}", e))?
                .map_err(|e| format!("ensure_sidecar: {}", e))?;

                // Sync AI config only for a sidecar this memory-update turn created.
                if result.is_new {
                    sync_ai_config_to_port(
                        result.port,
                        current_model,
                        current_provider_env,
                        mcp_servers_json,
                    )
                    .await;
                }
                Ok((result.port, true))
            }
            .await;
            match started {
                Ok(v) => v,
                Err(e) => return SessionUpdateOutcome::Failed(e),
            }
        }
    };

    // POST /api/memory/update — release temp sidecar on ALL exit paths
    let update_result: Result<(), String> = async {
        let url = format!("http://127.0.0.1:{}/api/memory/update", port);
        let result = http_client
            .post(&url)
            .json(&serde_json::json!({ "source": "auto" }))
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        let resp: MemoryUpdateResponse = result
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        match resp.status.as_str() {
            "completed" => Ok(()),
            "timeout" => {
                ulog_warn!(
                    "[memory-update] Session {} timed out (AI took too long)",
                    session_id
                );
                Ok(()) // Still count as attempted — don't retry immediately
            }
            "skipped" => Err(format!("Skipped: {:?}", resp.reason)),
            // The sidecar endpoint now reports a genuinely failed turn (e.g. an external
            // session whose runtime rejected the turn) as status="error" instead of
            // falsely reporting "completed". Surface it as a real failure so it does
            // NOT count toward the updated tally.
            "error" => Err(format!("Turn failed: {:?}", resp.reason)),
            _ => Err(format!("Unexpected status: {}", resp.status)),
        }
    }
    .await;

    // Always release temp sidecar, regardless of success/failure
    if was_temp {
        let _ = sidecar::release_session_sidecar(sidecar_manager, session_id, &owner);
    }

    match update_result {
        Ok(()) => SessionUpdateOutcome::Updated,
        Err(e) => SessionUpdateOutcome::Failed(e),
    }
}

/// Sync AI config to a newly started sidecar port
async fn sync_ai_config_to_port(
    port: u16,
    current_model: &Arc<RwLock<Option<String>>>,
    current_provider_env: &Arc<RwLock<Option<serde_json::Value>>>,
    mcp_servers_json: &Arc<RwLock<Option<String>>>,
) {
    let client = crate::local_http::json_client(Duration::from_secs(10));
    let model = current_model.read().await.clone();
    let provider_env = current_provider_env.read().await.clone();
    let mcp = mcp_servers_json.read().await.clone();

    let url = format!("http://127.0.0.1:{}/api/config/sync", port);
    let mut payload = serde_json::Map::new();
    if let Some(m) = model {
        payload.insert("model".into(), serde_json::Value::String(m));
    }
    if let Some(env) = provider_env {
        payload.insert("providerEnv".into(), env);
    }
    if let Some(mcp_json) = mcp {
        payload.insert("mcpServersJson".into(), serde_json::Value::String(mcp_json));
    }

    if !payload.is_empty() {
        let _ = client
            .post(&url)
            .json(&serde_json::Value::Object(payload))
            .send()
            .await;
    }
}

/// Read lastActiveAt for all sessions into a lookup map.
/// Used to detect recently active sessions that should not be interrupted by memory updates.
fn read_session_last_active_map() -> std::collections::HashMap<String, DateTime<Utc>> {
    let myagents_dir = match dirs::home_dir() {
        Some(home) => home.join(".myagents"),
        None => return Default::default(),
    };

    let sessions_path = myagents_dir.join("sessions.json");
    let content = match std::fs::read_to_string(&sessions_path) {
        Ok(c) => c,
        Err(e) => {
            ulog_warn!(
                "[memory-update] Failed to read sessions.json for activity check: {}",
                e
            );
            return Default::default();
        }
    };

    let sessions: Vec<SessionMeta> = match serde_json::from_str(strip_bom(&content)) {
        Ok(s) => s,
        Err(e) => {
            ulog_warn!(
                "[memory-update] Failed to parse sessions.json for activity check: {}",
                e
            );
            return Default::default();
        }
    };

    let mut map = std::collections::HashMap::new();
    for session in sessions {
        if let Some(ref last_active) = session.last_active_at {
            if let Ok(dt) = last_active.parse::<DateTime<Utc>>() {
                map.insert(session.id.clone(), dt);
            }
        }
    }
    map
}

fn resolve_update_memory_path(workspace_path: &str) -> Result<PathBuf, String> {
    let workspace_root =
        crate::workspace_files::path_safety::validate_workspace_root(workspace_path)?;
    crate::workspace_files::path_safety::resolve_inside_workspace(
        &workspace_root,
        "UPDATE_MEMORY.md",
    )
}

fn ensure_update_memory_file(
    path: &Path,
    memory_rule_relative_path: &str,
) -> Result<UpdateMemoryFileState, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("UPDATE_MEMORY.md is a symlink; refusing to read it".to_string());
            }
            if metadata.is_dir() {
                return Err("UPDATE_MEMORY.md is a directory".to_string());
            }

            let content =
                std::fs::read_to_string(path).map_err(|e| format!("read failed: {}", e))?;
            let body = strip_yaml_frontmatter(&content);
            if body.trim().is_empty() {
                return Ok(UpdateMemoryFileState::Empty);
            }
            Ok(UpdateMemoryFileState::Ready)
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let mut file = match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
            {
                Ok(file) => file,
                Err(open_err) if open_err.kind() == ErrorKind::AlreadyExists => {
                    return ensure_update_memory_file(path, memory_rule_relative_path);
                }
                Err(open_err) => {
                    return Err(format!("create failed: {}", open_err));
                }
            };
            let content =
                crate::workspace_files::memory_rules::render_default_update_memory_content(
                    memory_rule_relative_path,
                );
            file.write_all(content.as_bytes())
                .map_err(|write_err| format!("write failed: {}", write_err))?;
            ulog_info!(
                "[memory-update] Created default UPDATE_MEMORY.md at {}",
                path.display()
            );
            Ok(UpdateMemoryFileState::Ready)
        }
        Err(e) => Err(format!("metadata failed: {}", e)),
    }
}

/// Collect session IDs that qualify for memory update
fn collect_qualifying_sessions(
    workspace_path: &str,
    config: &MemoryAutoUpdateConfig,
) -> Vec<String> {
    let myagents_dir = match dirs::home_dir() {
        Some(home) => home.join(".myagents"),
        None => return vec![],
    };

    // Read sessions.json
    let sessions_path = myagents_dir.join("sessions.json");
    let sessions_content = match std::fs::read_to_string(&sessions_path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let all_sessions: Vec<SessionMeta> = match serde_json::from_str(strip_bom(&sessions_content)) {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    // #320 family: canonical workspace-path identity (drive-letter case fold +
    // trailing-slash trim), not a separator-only fold — config workspace path
    // and session agent_dir come from different stores with different forms.
    let normalized_workspace = crate::cron_task::normalize_path(workspace_path);
    let cutoff = Utc::now() - chrono::Duration::hours(config.interval_hours as i64);

    let mut qualifying = Vec::new();

    for session in &all_sessions {
        // Filter: belongs to this workspace
        let agent_dir = match &session.agent_dir {
            Some(d) => crate::cron_task::normalize_path(d),
            None => continue,
        };
        if agent_dir != normalized_workspace {
            continue;
        }

        // Filter: active within time window
        if let Some(ref last_active) = session.last_active_at {
            if let Ok(dt) = last_active.parse::<DateTime<Utc>>() {
                if dt < cutoff {
                    continue;
                }
            }
        } else {
            continue; // No lastActiveAt -> skip
        }

        // Filter: query count >= threshold
        let query_count = count_queries_since_last_update(&myagents_dir, &session.id);
        if query_count < config.query_threshold {
            continue;
        }

        qualifying.push(session.id.clone());
    }

    qualifying
}

/// Count user queries since the last <MEMORY_UPDATE> marker in a session's JSONL
fn count_queries_since_last_update(myagents_dir: &Path, session_id: &str) -> u32 {
    let jsonl_path = myagents_dir
        .join("sessions")
        .join(format!("{}.jsonl", session_id));
    let content = match std::fs::read_to_string(&jsonl_path) {
        Ok(c) => c,
        Err(_) => return 0,
    };

    let lines: Vec<&str> = content.lines().collect();
    let mut last_update_idx: Option<usize> = None;

    // Find last memory update marker (scan from end)
    // Matches both auto-update (<MEMORY_UPDATE> tag) and manual /UPDATE_MEMORY command
    for (i, line) in lines.iter().enumerate().rev() {
        if let Ok(msg) = serde_json::from_str::<MessageLine>(line) {
            if msg.role.as_deref() == Some("user") {
                if let Some(ref content) = msg.content {
                    let text = match content {
                        serde_json::Value::String(s) => s.as_str(),
                        _ => continue,
                    };
                    if text.contains("<MEMORY_UPDATE>") || text.contains("/UPDATE_MEMORY") {
                        last_update_idx = Some(i);
                        break;
                    }
                }
            }
        }
    }

    // Count user messages after the marker (excluding system injections)
    let start = last_update_idx.map(|i| i + 1).unwrap_or(0);
    let mut count = 0u32;

    for line in &lines[start..] {
        if let Ok(msg) = serde_json::from_str::<MessageLine>(line) {
            if msg.role.as_deref() == Some("user") {
                if let Some(ref content) = msg.content {
                    let text = match content {
                        serde_json::Value::String(s) => s.as_str(),
                        _ => continue,
                    };
                    // Exclude system-injected messages
                    if text.contains("<MEMORY_UPDATE>") || text.contains("<HEARTBEAT>") {
                        continue;
                    }
                    count += 1;
                }
            }
        }
    }

    count
}

/// Check if current time is within the update window
fn is_in_update_window(config: &MemoryAutoUpdateConfig) -> bool {
    let tz_name = config
        .update_window_timezone
        .as_deref()
        .unwrap_or("Asia/Shanghai");
    let tz: chrono_tz::Tz = match tz_name.parse() {
        Ok(tz) => tz,
        Err(_) => {
            ulog_warn!(
                "[memory-update] Invalid timezone '{}', assuming in-window",
                tz_name
            );
            return true;
        }
    };

    let now = Utc::now().with_timezone(&tz);
    let now_minutes = now.hour() * 60 + now.minute();

    let start = parse_hhmm(&config.update_window_start).unwrap_or(0);
    let end = parse_hhmm(&config.update_window_end).unwrap_or(360); // 06:00

    if start <= end {
        // Normal range: e.g. 00:00 - 06:00
        now_minutes >= start && now_minutes < end
    } else {
        // Wrapping range: e.g. 22:00 - 06:00
        now_minutes >= start || now_minutes < end
    }
}

/// Parse "HH:MM" to minutes since midnight
fn parse_hhmm(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    Some(h * 60 + m)
}

/// Strip YAML frontmatter from file content
fn strip_yaml_frontmatter(content: &str) -> &str {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return trimmed;
    }
    // Find second ---
    if let Some(end_idx) = trimmed[3..].find("---") {
        let after = &trimmed[3 + end_idx + 3..];
        after.trim()
    } else {
        trimmed
    }
}

/// Update a field in the MemoryAutoUpdateConfig on disk (atomic read-modify-write)
async fn update_config_field<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    f: impl FnOnce(&mut MemoryAutoUpdateConfig) + Send + 'static,
) {
    let agent_id_owned = agent_id.to_string();
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let config_path = dirs::home_dir()
            .ok_or("No home dir")?
            .join(".myagents")
            .join("config.json");

        with_config_lock(&config_path, false, |config| {
            if let Some(agents) = config.get_mut("agents").and_then(|a| a.as_array_mut()) {
                for agent in agents.iter_mut() {
                    if agent.get("id").and_then(|v| v.as_str()) == Some(&agent_id_owned) {
                        let mau: MemoryAutoUpdateConfig = agent
                            .get("memoryAutoUpdate")
                            .and_then(|v| serde_json::from_value(v.clone()).ok())
                            .unwrap_or_default();
                        let mut mau = mau;
                        f(&mut mau);
                        agent["memoryAutoUpdate"] =
                            serde_json::to_value(&mau).unwrap_or(serde_json::Value::Null);
                        break;
                    }
                }
            }
            Ok(())
        })?;

        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => ulog_error!("[memory-update] Failed to update config: {}", e),
        Err(e) => ulog_error!("[memory-update] spawn_blocking error: {}", e),
    }

    // Notify frontend
    let _ = app_handle.emit("agent:config-changed", serde_json::json!({}));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_update_memory_file_creates_default_when_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("UPDATE_MEMORY.md");

        let state =
            ensure_update_memory_file(&path, ".claude/rules/04-MEMORY.md").expect("ensure file");

        assert!(matches!(state, UpdateMemoryFileState::Ready));
        let content = std::fs::read_to_string(&path).expect("read created file");
        assert_eq!(
            content,
            crate::workspace_files::memory_rules::render_default_update_memory_content(
                ".claude/rules/04-MEMORY.md"
            )
        );
        assert!(!strip_yaml_frontmatter(&content).trim().is_empty());
    }

    #[test]
    fn ensure_update_memory_file_preserves_existing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("UPDATE_MEMORY.md");
        let original = "# Custom memory maintenance\n\nDo the local thing.\n";
        std::fs::write(&path, original).expect("write existing file");

        let state =
            ensure_update_memory_file(&path, ".claude/rules/04-MEMORY.md").expect("ensure file");

        assert!(matches!(state, UpdateMemoryFileState::Ready));
        let content = std::fs::read_to_string(&path).expect("read existing file");
        assert_eq!(content, original);
    }

    #[test]
    fn ensure_update_memory_file_reports_empty_body_after_frontmatter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("UPDATE_MEMORY.md");
        std::fs::write(&path, "---\ndescription: placeholder\n---\n\n   \n")
            .expect("write empty file");

        let state =
            ensure_update_memory_file(&path, ".claude/rules/04-MEMORY.md").expect("ensure file");

        assert!(matches!(state, UpdateMemoryFileState::Empty));
    }
}
