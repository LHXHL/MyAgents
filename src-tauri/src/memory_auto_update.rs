use std::collections::HashSet;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use chrono::{DateTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::config_io::with_config_lock;
use crate::cron_task::{
    get_cron_task_manager, normalize_path, CronSchedule, CronTask, CronTaskConfig, EndConditions,
    RecurringWindow, RunMode, TaskStatus,
};
use crate::im::types::{HeartbeatConfig, MemoryAutoUpdateConfig};
use crate::sidecar::{self, ManagedSidecarManager, SidecarOwner};
use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_info, ulog_warn};

pub const SCAN_CADENCE_MINUTES: u32 = 30;
const IDLE_COOLDOWN_MINUTES: i64 = 30;
const SESSION_SCAN_LOOKBACK_HOURS: i64 = 24 * 30;
const MEMORY_UPDATE_HTTP_TIMEOUT_SECS: u64 = 61 * 60;
const MANAGED_AUTO_UPDATE_NAME: &str = "Memory Auto-Update";
const MANAGED_AUTO_UPDATE_PROMPT: &str =
    "System-managed memory auto-update dispatcher. This CronTask is hidden from ordinary UI.";

static IN_FLIGHT_WORKSPACES: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureMemoryAutoUpdateTaskResult {
    pub enabled: bool,
    pub cron_task_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureMemoryAutoUpdateTaskRequest {
    pub agent_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub memory_auto_update: Option<MemoryAutoUpdateConfig>,
    #[serde(default)]
    pub heartbeat: Option<HeartbeatConfig>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAutoUpdateBatchSummary {
    pub checked_sessions: u32,
    pub eligible_sessions: u32,
    pub updated: u32,
    pub skipped_recent_input: u32,
    pub skipped_busy: u32,
    pub skipped_no_threshold: u32,
    pub skipped_min_interval: u32,
    pub skipped_duplicate: u32,
    pub failed: u32,
    pub completed_at: String,
}

#[derive(Debug)]
struct DiskMemoryAutoUpdateAgent {
    request: ConfigureMemoryAutoUpdateTaskRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    id: String,
    #[serde(default)]
    agent_dir: Option<String>,
    #[serde(default)]
    last_active_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageLine {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<Value>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, alias = "created_at")]
    created_at: Option<String>,
}

#[derive(Debug, Default)]
struct SessionJsonlAnalysis {
    query_count: u32,
    last_human_user_at: Option<DateTime<Utc>>,
    last_memory_update_at: Option<DateTime<Utc>>,
}

#[derive(Debug)]
struct SessionCandidate {
    id: String,
}

#[derive(Debug)]
enum SessionUpdateOutcome {
    Updated,
    Busy,
    Failed(String),
}

#[derive(Debug)]
enum UpdateMemoryFileState {
    Ready,
    Empty,
}

#[derive(Debug, Deserialize)]
struct MemoryUpdateResponse {
    status: String,
    reason: Option<String>,
}

#[derive(Debug)]
enum MemoryUpdateSidecarTarget {
    Ready(u16),
    BoundButNotReady,
    Missing,
}

struct WorkspaceInflightGuard {
    key: String,
}

impl WorkspaceInflightGuard {
    async fn acquire(workspace_path: &str) -> Option<Self> {
        let key = normalize_path(workspace_path);
        let mut guard = IN_FLIGHT_WORKSPACES.lock().await;
        if guard.contains(&key) {
            return None;
        }
        guard.insert(key.clone());
        Some(Self { key })
    }

    async fn release(self) {
        let mut guard = IN_FLIGHT_WORKSPACES.lock().await;
        guard.remove(&self.key);
    }
}

#[tauri::command]
pub async fn cmd_configure_memory_auto_update_task(
    request: ConfigureMemoryAutoUpdateTaskRequest,
) -> Result<ConfigureMemoryAutoUpdateTaskResult, String> {
    configure_memory_auto_update_task(request).await
}

pub async fn configure_memory_auto_update_task(
    request: ConfigureMemoryAutoUpdateTaskRequest,
) -> Result<ConfigureMemoryAutoUpdateTaskResult, String> {
    let manager = get_cron_task_manager();
    let mut existing = find_managed_cron_tasks_for_workspace(&request.workspace_path).await;
    existing.sort_by_key(|task| task.created_at);

    let keep = existing.first().cloned();
    for duplicate in existing.iter().skip(1) {
        ulog_warn!(
            "[memory-auto-update] deleting duplicate hidden CronTask {} for workspace {}",
            duplicate.id,
            request.workspace_path
        );
        let _ = manager.delete_task(&duplicate.id).await;
    }

    let Some(mut config) = request.memory_auto_update.clone().filter(|c| c.enabled) else {
        if let Some(task) = keep {
            if task.status == TaskStatus::Running {
                let _ = manager
                    .stop_task(&task.id, Some("memory auto-update disabled".to_string()))
                    .await;
            }
            return Ok(ConfigureMemoryAutoUpdateTaskResult {
                enabled: false,
                cron_task_id: Some(task.id),
            });
        }
        return Ok(ConfigureMemoryAutoUpdateTaskResult {
            enabled: false,
            cron_task_id: None,
        });
    };

    apply_heartbeat_timezone_fallback(&mut config, request.heartbeat.as_ref());

    let desired_schedule = schedule_for_config(&config);
    if let Some(task) = keep {
        let drifted = task.name.as_deref() != Some(MANAGED_AUTO_UPDATE_NAME)
            || task.prompt != MANAGED_AUTO_UPDATE_PROMPT
            || task.interval_minutes != SCAN_CADENCE_MINUTES
            || !schedule_policy_matches(task.schedule.as_ref(), &desired_schedule)
            || task.notify_enabled
            || task.run_mode != RunMode::SingleSession
            || task.managed_kind.as_deref()
                != Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH);

        let task = if drifted {
            let updated = manager
                .update_task_fields(
                    &task.id,
                    serde_json::json!({
                        "name": MANAGED_AUTO_UPDATE_NAME,
                        "prompt": MANAGED_AUTO_UPDATE_PROMPT,
                        "intervalMinutes": SCAN_CADENCE_MINUTES,
                        "schedule": desired_schedule,
                        "notifyEnabled": false,
                    }),
                )
                .await?;
            manager.get_task(&task.id).await.unwrap_or(updated)
        } else {
            task
        };

        if task.status != TaskStatus::Running {
            manager.start_task(&task.id).await?;
        }
        manager.start_task_scheduler(&task.id).await?;
        return Ok(ConfigureMemoryAutoUpdateTaskResult {
            enabled: true,
            cron_task_id: Some(task.id),
        });
    }

    let task = manager
        .create_task(CronTaskConfig {
            workspace_path: request.workspace_path.clone(),
            session_id: Uuid::new_v4().to_string(),
            prompt: MANAGED_AUTO_UPDATE_PROMPT.to_string(),
            interval_minutes: SCAN_CADENCE_MINUTES,
            end_conditions: EndConditions::default(),
            run_mode: RunMode::SingleSession,
            notify_enabled: false,
            tab_id: None,
            permission_mode: String::new(),
            model: None,
            provider_env: None,
            provider_id: None,
            provider_intent: Default::default(),
            runtime: None,
            runtime_config: None,
            mcp_enabled_servers: None,
            managed_kind: Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH.to_string()),
            source_bot_id: None,
            delivery: None,
            schedule: Some(desired_schedule),
            name: Some(MANAGED_AUTO_UPDATE_NAME.to_string()),
            task_id: None,
        })
        .await?;
    manager.start_task(&task.id).await?;
    manager.start_task_scheduler(&task.id).await?;

    ulog_info!(
        "[memory-auto-update] created hidden CronTask {} for agent {} workspace {}",
        task.id,
        request.agent_id,
        request.workspace_path
    );

    Ok(ConfigureMemoryAutoUpdateTaskResult {
        enabled: true,
        cron_task_id: Some(task.id),
    })
}

pub async fn reconcile_memory_auto_update_tasks_from_disk() -> Result<(), String> {
    let agents = load_disk_memory_auto_update_agents()?;
    let mut enabled_workspaces = HashSet::new();

    for agent in agents {
        if agent
            .request
            .memory_auto_update
            .as_ref()
            .is_some_and(|config| config.enabled)
        {
            enabled_workspaces.insert(normalize_path(&agent.request.workspace_path));
        }
        if let Err(error) = configure_memory_auto_update_task(agent.request.clone()).await {
            ulog_warn!(
                "[memory-auto-update] startup reconcile failed for agent {} workspace {}: {}",
                agent.request.agent_id,
                agent.request.workspace_path,
                error
            );
        }
    }

    let manager = get_cron_task_manager();
    let existing = manager.get_all_tasks().await;
    for task in existing {
        if task.managed_kind.as_deref() != Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH)
        {
            continue;
        }
        let workspace_key = normalize_path(&task.workspace_path);
        if enabled_workspaces.contains(&workspace_key) {
            continue;
        }
        if let Err(error) =
            configure_memory_auto_update_task(ConfigureMemoryAutoUpdateTaskRequest {
                agent_id: "startup-reconcile".to_string(),
                workspace_path: task.workspace_path.clone(),
                memory_auto_update: None,
                heartbeat: None,
            })
            .await
        {
            ulog_warn!(
                "[memory-auto-update] startup reconcile failed to stop hidden CronTask {} for workspace {}: {}",
                task.id,
                task.workspace_path,
                error
            );
        }
    }

    Ok(())
}

pub async fn run_managed_cron_batch(
    handle: &AppHandle,
    task: &CronTask,
) -> Result<(bool, Option<String>, Option<String>, Option<String>), String> {
    let Some((agent_id, mut config, heartbeat)) =
        load_enabled_memory_auto_update_agent_for_workspace(&task.workspace_path)?
    else {
        let text = format!(
            "Memory auto-update hidden batch skipped for {}: memoryAutoUpdate is not explicitly enabled.",
            task.workspace_path
        );
        return Ok((true, None, Some(text), None));
    };
    apply_heartbeat_timezone_fallback(&mut config, heartbeat.as_ref());

    if !is_in_update_window(&config) {
        let text = format!(
            "Memory auto-update hidden batch skipped for {}: outside update window {}-{}.",
            task.workspace_path, config.update_window_start, config.update_window_end
        );
        return Ok((true, None, Some(text), None));
    }

    let sidecar_state = handle
        .try_state::<ManagedSidecarManager>()
        .ok_or_else(|| "SidecarManager state not available".to_string())?;
    let summary = run_batch(
        handle,
        &agent_id,
        &task.workspace_path,
        &config,
        &sidecar_state,
    )
    .await;
    let ok = summary.failed == 0;
    Ok((ok, None, Some(format_batch_summary(&summary)), None))
}

pub async fn run_batch<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    workspace_path: &str,
    config: &MemoryAutoUpdateConfig,
    sidecar_manager: &ManagedSidecarManager,
) -> MemoryAutoUpdateBatchSummary {
    let mut summary = MemoryAutoUpdateBatchSummary {
        completed_at: Utc::now().to_rfc3339(),
        ..Default::default()
    };

    let Some(inflight) = WorkspaceInflightGuard::acquire(workspace_path).await else {
        summary.skipped_duplicate = 1;
        return summary;
    };

    match prepare_update_memory_file(workspace_path) {
        Ok(UpdateMemoryFileState::Ready) => {}
        Ok(UpdateMemoryFileState::Empty) => {
            ulog_debug!(
                "[memory-auto-update] skipped {}: UPDATE_MEMORY.md body is empty",
                workspace_path
            );
            inflight.release().await;
            return summary;
        }
        Err(error) => {
            ulog_warn!(
                "[memory-auto-update] failed to prepare UPDATE_MEMORY.md for {}: {}",
                workspace_path,
                error
            );
            summary.failed = 1;
            inflight.release().await;
            return summary;
        }
    }

    let candidates = collect_candidates(workspace_path, config, &mut summary);
    summary.eligible_sessions = candidates.len() as u32;

    let http_client =
        crate::local_http::json_client(Duration::from_secs(MEMORY_UPDATE_HTTP_TIMEOUT_SECS));
    for candidate in candidates {
        match update_single_session(
            &candidate.id,
            agent_id,
            workspace_path,
            sidecar_manager,
            app_handle,
            &http_client,
        )
        .await
        {
            SessionUpdateOutcome::Updated => {
                summary.updated += 1;
                ulog_info!(
                    "[memory-auto-update] session {} updated successfully",
                    candidate.id
                );
            }
            SessionUpdateOutcome::Busy => {
                summary.skipped_busy += 1;
                ulog_info!(
                    "[memory-auto-update] session {} busy; will retry on next scan",
                    candidate.id
                );
            }
            SessionUpdateOutcome::Failed(error) => {
                summary.failed += 1;
                ulog_warn!(
                    "[memory-auto-update] session {} update failed: {}",
                    candidate.id,
                    error
                );
            }
        }
    }

    if summary.updated > 0 {
        update_successful_completion(app_handle, agent_id, summary.updated).await;
    }

    summary.completed_at = Utc::now().to_rfc3339();
    inflight.release().await;
    summary
}

pub fn format_batch_summary(summary: &MemoryAutoUpdateBatchSummary) -> String {
    format!(
        "Memory auto-update batch completed at {}. checked={}, eligible={}, updated={}, skippedRecentInput={}, skippedBusy={}, skippedNoThreshold={}, skippedMinInterval={}, skippedDuplicate={}, failed={}",
        summary.completed_at,
        summary.checked_sessions,
        summary.eligible_sessions,
        summary.updated,
        summary.skipped_recent_input,
        summary.skipped_busy,
        summary.skipped_no_threshold,
        summary.skipped_min_interval,
        summary.skipped_duplicate,
        summary.failed
    )
}

async fn find_managed_cron_tasks_for_workspace(workspace_path: &str) -> Vec<CronTask> {
    get_cron_task_manager()
        .get_tasks_for_workspace(workspace_path)
        .await
        .into_iter()
        .filter(|task| {
            task.managed_kind.as_deref() == Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH)
        })
        .collect()
}

fn schedule_for_config(config: &MemoryAutoUpdateConfig) -> CronSchedule {
    CronSchedule::Every {
        minutes: SCAN_CADENCE_MINUTES,
        start_at: Some(next_scan_start_at(config).to_rfc3339()),
        catch_up_window: Some(recurring_window(config)),
    }
}

fn schedule_policy_matches(existing: Option<&CronSchedule>, desired: &CronSchedule) -> bool {
    match (existing, desired) {
        (
            Some(CronSchedule::Every {
                minutes,
                start_at,
                catch_up_window,
            }),
            CronSchedule::Every {
                minutes: desired_minutes,
                catch_up_window: desired_window,
                ..
            },
        ) => {
            minutes == desired_minutes
                && catch_up_window == desired_window
                && start_at
                    .as_deref()
                    .is_some_and(|raw| DateTime::parse_from_rfc3339(raw).is_ok())
        }
        (Some(existing), desired) => existing == desired,
        (None, _) => false,
    }
}

fn recurring_window(config: &MemoryAutoUpdateConfig) -> RecurringWindow {
    RecurringWindow {
        timezone: config
            .update_window_timezone
            .clone()
            .unwrap_or_else(|| "Asia/Shanghai".to_string()),
        start: config.update_window_start.clone(),
        end: config.update_window_end.clone(),
    }
}

fn next_scan_start_at(config: &MemoryAutoUpdateConfig) -> DateTime<Utc> {
    let tz_name = config
        .update_window_timezone
        .as_deref()
        .unwrap_or("Asia/Shanghai");
    let Ok(tz) = tz_name.parse::<chrono_tz::Tz>() else {
        return Utc::now() + chrono::Duration::seconds(10);
    };
    let now_local = Utc::now().with_timezone(&tz);
    if is_local_time_in_window(now_local.hour() * 60 + now_local.minute(), config) {
        return Utc::now() + chrono::Duration::seconds(10);
    }

    let start = parse_hhmm(&config.update_window_start).unwrap_or(0);
    let today_start = now_local
        .date_naive()
        .and_hms_opt(start / 60, start % 60, 0)
        .and_then(|naive| naive.and_local_timezone(tz).single())
        .unwrap_or(now_local + chrono::Duration::minutes(1));
    let next = if today_start > now_local {
        today_start
    } else {
        today_start + chrono::Duration::days(1)
    };
    next.with_timezone(&Utc)
}

fn apply_heartbeat_timezone_fallback(
    config: &mut MemoryAutoUpdateConfig,
    heartbeat: Option<&HeartbeatConfig>,
) {
    if config.update_window_timezone.is_none() {
        config.update_window_timezone = heartbeat
            .and_then(|h| h.active_hours.as_ref())
            .map(|hours| hours.timezone.clone());
    }
}

fn load_disk_memory_auto_update_agents() -> Result<Vec<DiskMemoryAutoUpdateAgent>, String> {
    let Some(data_dir) = crate::app_dirs::myagents_data_dir() else {
        return Ok(Vec::new());
    };
    let config_path = data_dir.join("config.json");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read config.json: {}", error)),
    };
    let config: Value =
        serde_json::from_str(strip_bom(&content)).map_err(|e| format!("parse config: {}", e))?;
    Ok(collect_disk_memory_auto_update_agents(&config))
}

fn collect_disk_memory_auto_update_agents(config: &Value) -> Vec<DiskMemoryAutoUpdateAgent> {
    let Some(agents) = config.get("agents").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for agent in agents {
        let Some(agent_id) = agent.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(workspace_path) = agent.get("workspacePath").and_then(Value::as_str) else {
            continue;
        };
        let Some(mau_value) = agent.get("memoryAutoUpdate") else {
            continue;
        };
        let memory_auto_update = match serde_json::from_value::<MemoryAutoUpdateConfig>(
            mau_value.clone(),
        ) {
            Ok(config) => Some(config),
            Err(error) => {
                ulog_warn!(
                    "[memory-auto-update] skipping startup reconcile for agent {}: invalid memoryAutoUpdate config: {}",
                    agent_id,
                    error
                );
                continue;
            }
        };
        let heartbeat = agent
            .get("heartbeat")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());

        result.push(DiskMemoryAutoUpdateAgent {
            request: ConfigureMemoryAutoUpdateTaskRequest {
                agent_id: agent_id.to_string(),
                workspace_path: workspace_path.to_string(),
                memory_auto_update,
                heartbeat,
            },
        });
    }
    result
}

fn prepare_update_memory_file(workspace_path: &str) -> Result<UpdateMemoryFileState, String> {
    let rule_substrate =
        crate::workspace_files::memory_rules::ensure_memory_rule_substrate_for_workspace(
            workspace_path,
        )?;
    let update_md_path = resolve_update_memory_path(workspace_path)?;
    ensure_update_memory_file(&update_md_path, &rule_substrate.memory.relative_path)
}

fn collect_candidates(
    workspace_path: &str,
    config: &MemoryAutoUpdateConfig,
    summary: &mut MemoryAutoUpdateBatchSummary,
) -> Vec<SessionCandidate> {
    let Some(myagents_dir) = crate::app_dirs::myagents_data_dir() else {
        return vec![];
    };
    let sessions_path = myagents_dir.join("sessions.json");
    let sessions_content = match std::fs::read_to_string(&sessions_path) {
        Ok(content) => content,
        Err(_) => return vec![],
    };
    let sessions: Vec<SessionMeta> = match serde_json::from_str(strip_bom(&sessions_content)) {
        Ok(sessions) => sessions,
        Err(error) => {
            ulog_warn!(
                "[memory-auto-update] failed to parse sessions.json for {}: {}",
                workspace_path,
                error
            );
            return vec![];
        }
    };

    let normalized_workspace = normalize_path(workspace_path);
    let now = Utc::now();
    let lookback_hours = SESSION_SCAN_LOOKBACK_HOURS.max(config.interval_hours as i64);
    let lookback_cutoff = now - chrono::Duration::hours(lookback_hours);
    let idle_cutoff = now - chrono::Duration::minutes(IDLE_COOLDOWN_MINUTES);
    let min_interval_cutoff = now - chrono::Duration::hours(config.interval_hours as i64);
    let mut candidates = Vec::new();

    for session in sessions {
        let Some(agent_dir) = session.agent_dir.as_ref() else {
            continue;
        };
        if normalize_path(agent_dir) != normalized_workspace {
            continue;
        }
        let last_active_at = session
            .last_active_at
            .as_deref()
            .and_then(parse_datetime_utc);
        if last_active_at.is_some_and(|dt| dt < lookback_cutoff) {
            continue;
        }
        summary.checked_sessions += 1;

        let analysis = analyze_session_jsonl(&myagents_dir, &session.id);
        if analysis
            .last_memory_update_at
            .is_some_and(|dt| dt > min_interval_cutoff)
        {
            summary.skipped_min_interval += 1;
            continue;
        }
        if analysis.query_count < config.query_threshold {
            summary.skipped_no_threshold += 1;
            continue;
        }

        let idle_reference = analysis.last_human_user_at.or(last_active_at);
        if idle_reference.is_some_and(|dt| dt > idle_cutoff) {
            summary.skipped_recent_input += 1;
            continue;
        }

        candidates.push(SessionCandidate { id: session.id });
    }

    candidates
}

fn analyze_session_jsonl(myagents_dir: &Path, session_id: &str) -> SessionJsonlAnalysis {
    let jsonl_path = myagents_dir
        .join("sessions")
        .join(format!("{}.jsonl", session_id));
    let content = match std::fs::read_to_string(&jsonl_path) {
        Ok(content) => content,
        Err(_) => return SessionJsonlAnalysis::default(),
    };
    analyze_session_jsonl_content(&content)
}

fn analyze_session_jsonl_content(content: &str) -> SessionJsonlAnalysis {
    let lines: Vec<MessageLine> = content
        .lines()
        .filter_map(|line| serde_json::from_str::<MessageLine>(line).ok())
        .collect();
    let mut last_update_idx: Option<usize> = None;
    let mut last_memory_update_at: Option<DateTime<Utc>> = None;
    let mut last_human_user_at: Option<DateTime<Utc>> = None;

    for (idx, msg) in lines.iter().enumerate() {
        if msg.role.as_deref() != Some("user") {
            continue;
        }
        let text = msg.content.as_ref().map(message_text).unwrap_or_default();
        let ts = message_timestamp(msg);
        if is_memory_update_marker(&text) {
            last_update_idx = Some(idx);
            last_memory_update_at = ts;
            continue;
        }
        if is_system_injected_user_text(&text) {
            continue;
        }
        if let Some(ts) = ts {
            last_human_user_at = Some(ts);
        }
    }

    let start = last_update_idx.map(|idx| idx + 1).unwrap_or(0);
    let mut query_count = 0u32;
    for msg in lines.iter().skip(start) {
        if msg.role.as_deref() != Some("user") {
            continue;
        }
        let text = msg.content.as_ref().map(message_text).unwrap_or_default();
        if is_system_injected_user_text(&text) {
            continue;
        }
        query_count += 1;
    }

    SessionJsonlAnalysis {
        query_count,
        last_human_user_at,
        last_memory_update_at,
    }
}

async fn update_single_session<R: Runtime>(
    session_id: &str,
    agent_id: &str,
    workspace_path: &str,
    sidecar_manager: &ManagedSidecarManager,
    app_handle: &AppHandle<R>,
    http_client: &reqwest::Client,
) -> SessionUpdateOutcome {
    let memory_update_key = format!("memory_update:{}:{}", agent_id, session_id);
    let owner = SidecarOwner::Agent(memory_update_key);

    let target = {
        let mut mgr = match sidecar_manager.lock() {
            Ok(guard) => guard,
            Err(error) => return SessionUpdateOutcome::Failed(format!("lock: {}", error)),
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
        MemoryUpdateSidecarTarget::BoundButNotReady => return SessionUpdateOutcome::Busy,
        MemoryUpdateSidecarTarget::Missing => {
            let ah = app_handle.clone();
            let sm = sidecar_manager.clone();
            let sid = session_id.to_string();
            let ws = workspace_path.to_string();
            let own = owner.clone();
            let started = tauri::async_runtime::spawn_blocking(move || {
                let workspace = PathBuf::from(ws);
                sidecar::ensure_session_sidecar(&ah, &sm, &sid, &workspace, own)
            })
            .await
            .map_err(|e| format!("spawn_blocking: {}", e))
            .and_then(|r| r.map_err(|e| format!("ensure_sidecar: {}", e)));

            match started {
                Ok(result) => (result.port, true),
                Err(error) => return SessionUpdateOutcome::Failed(error),
            }
        }
    };

    let update_result = post_memory_update(http_client, port).await;

    if was_temp {
        let _ = sidecar::release_session_sidecar(sidecar_manager, session_id, &owner);
    }

    update_result
}

async fn post_memory_update(http_client: &reqwest::Client, port: u16) -> SessionUpdateOutcome {
    let url = format!("http://127.0.0.1:{}/api/memory/update", port);
    let response = match http_client
        .post(&url)
        .json(&serde_json::json!({ "source": "auto" }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return SessionUpdateOutcome::Failed(format!("HTTP request failed: {}", error));
        }
    };
    let status = response.status();
    let parsed = response.json::<MemoryUpdateResponse>().await;
    let body = match parsed {
        Ok(body) => body,
        Err(error) => {
            return SessionUpdateOutcome::Failed(format!(
                "Failed to parse response (status {}): {}",
                status, error
            ));
        }
    };
    match body.status.as_str() {
        "completed" => SessionUpdateOutcome::Updated,
        "skipped" if body.reason.as_deref() == Some("session_busy") => SessionUpdateOutcome::Busy,
        "timeout" => SessionUpdateOutcome::Failed("turn timed out".to_string()),
        "skipped" => SessionUpdateOutcome::Failed(format!("skipped: {:?}", body.reason)),
        "error" => SessionUpdateOutcome::Failed(format!("turn failed: {:?}", body.reason)),
        other => SessionUpdateOutcome::Failed(format!("unexpected status: {}", other)),
    }
}

async fn update_successful_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    updated_count: u32,
) {
    let agent_id = agent_id.to_string();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let config_path = crate::app_dirs::myagents_data_dir()
            .ok_or("No data dir")?
            .join("config.json");
        with_config_lock(&config_path, true, |config| {
            let Some(agents) = config.get_mut("agents").and_then(|v| v.as_array_mut()) else {
                return Ok(());
            };
            let Some(agent) = agents
                .iter_mut()
                .find(|agent| agent.get("id").and_then(Value::as_str) == Some(agent_id.as_str()))
            else {
                return Ok(());
            };
            let current = agent
                .get("memoryAutoUpdate")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let mut mau: MemoryAutoUpdateConfig =
                serde_json::from_value(current).unwrap_or_default();
            mau.last_batch_at = Some(Utc::now().to_rfc3339());
            mau.last_batch_session_count = Some(updated_count);
            agent["memoryAutoUpdate"] = serde_json::to_value(mau).unwrap_or(Value::Null);
            Ok(())
        })?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => {
            let _ = app_handle.emit("agent:config-changed", serde_json::json!({}));
        }
        Ok(Err(error)) => ulog_warn!("[memory-auto-update] failed to update config: {}", error),
        Err(error) => ulog_warn!(
            "[memory-auto-update] config update spawn_blocking failed: {}",
            error
        ),
    }
}

fn load_enabled_memory_auto_update_agent_for_workspace(
    workspace_path: &str,
) -> Result<Option<(String, MemoryAutoUpdateConfig, Option<HeartbeatConfig>)>, String> {
    let Some(data_dir) = crate::app_dirs::myagents_data_dir() else {
        return Ok(None);
    };
    let config_path = data_dir.join("config.json");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read config.json: {}", error)),
    };
    let config: Value =
        serde_json::from_str(strip_bom(&content)).map_err(|e| format!("parse config: {}", e))?;
    let Some(agents) = config.get("agents").and_then(Value::as_array) else {
        return Ok(None);
    };
    let normalized_workspace = normalize_path(workspace_path);
    for agent in agents {
        let Some(agent_workspace) = agent.get("workspacePath").and_then(Value::as_str) else {
            continue;
        };
        if normalize_path(agent_workspace) != normalized_workspace {
            continue;
        }
        let Some(mau_value) = agent.get("memoryAutoUpdate") else {
            continue;
        };
        if mau_value.get("enabled").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(agent_id) = agent.get("id").and_then(Value::as_str) else {
            continue;
        };
        let mau: MemoryAutoUpdateConfig = serde_json::from_value(mau_value.clone())
            .map_err(|e| format!("parse memoryAutoUpdate: {}", e))?;
        let heartbeat = agent
            .get("heartbeat")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());
        return Ok(Some((agent_id.to_string(), mau, heartbeat)));
    }
    Ok(None)
}

pub fn is_in_update_window(config: &MemoryAutoUpdateConfig) -> bool {
    let tz_name = config
        .update_window_timezone
        .as_deref()
        .unwrap_or("Asia/Shanghai");
    let tz: chrono_tz::Tz = match tz_name.parse() {
        Ok(tz) => tz,
        Err(_) => {
            ulog_warn!(
                "[memory-auto-update] invalid timezone '{}', assuming in-window",
                tz_name
            );
            return true;
        }
    };

    let now = Utc::now().with_timezone(&tz);
    is_local_time_in_window(now.hour() * 60 + now.minute(), config)
}

fn is_local_time_in_window(now_minutes: u32, config: &MemoryAutoUpdateConfig) -> bool {
    let start = parse_hhmm(&config.update_window_start).unwrap_or(0);
    let end = parse_hhmm(&config.update_window_end).unwrap_or(360);
    if start <= end {
        now_minutes >= start && now_minutes < end
    } else {
        now_minutes >= start || now_minutes < end
    }
}

fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.split_once(':')?;
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
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
                Err(open_err) => return Err(format!("create failed: {}", open_err)),
            };
            let content =
                crate::workspace_files::memory_rules::render_default_update_memory_content(
                    memory_rule_relative_path,
                );
            file.write_all(content.as_bytes())
                .map_err(|write_err| format!("write failed: {}", write_err))?;
            Ok(UpdateMemoryFileState::Ready)
        }
        Err(e) => Err(format!("metadata failed: {}", e)),
    }
}

fn strip_yaml_frontmatter(content: &str) -> &str {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return trimmed;
    }
    if let Some(end_idx) = trimmed[3..].find("---") {
        let after = &trimmed[3 + end_idx + 3..];
        after.trim()
    } else {
        trimmed
    }
}

fn message_timestamp(message: &MessageLine) -> Option<DateTime<Utc>> {
    message
        .timestamp
        .as_deref()
        .or(message.created_at.as_deref())
        .and_then(parse_datetime_utc)
}

fn parse_datetime_utc(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|dt| dt.with_timezone(&Utc))
        .ok()
}

fn message_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(message_text)
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(obj) => obj
            .get("text")
            .or_else(|| obj.get("content"))
            .map(message_text)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn is_memory_update_marker(text: &str) -> bool {
    text.contains("<MEMORY_UPDATE>") || text.contains("/UPDATE_MEMORY")
}

fn is_system_injected_user_text(text: &str) -> bool {
    is_memory_update_marker(text)
        || text.contains("<HEARTBEAT>")
        || text.contains("<CRON_TASK>")
        || text.contains("<system-reminder>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> MemoryAutoUpdateConfig {
        MemoryAutoUpdateConfig {
            enabled: true,
            interval_hours: 24,
            query_threshold: 2,
            update_window_start: "00:00".to_string(),
            update_window_end: "07:00".to_string(),
            update_window_timezone: Some("Asia/Shanghai".to_string()),
            last_batch_at: None,
            last_batch_session_count: None,
        }
    }

    #[test]
    fn jsonl_analysis_counts_queries_after_memory_marker() {
        let content = r#"{"role":"user","content":"before","timestamp":"2026-01-01T00:00:00.000Z"}
{"role":"user","content":"<MEMORY_UPDATE> update","timestamp":"2026-01-01T01:00:00.000Z"}
{"role":"assistant","content":"done","timestamp":"2026-01-01T01:01:00.000Z"}
{"role":"user","content":"q1","timestamp":"2026-01-01T02:00:00.000Z"}
{"role":"user","content":"<HEARTBEAT> hidden","timestamp":"2026-01-01T02:05:00.000Z"}
{"role":"user","content":[{"type":"text","text":"q2"}],"timestamp":"2026-01-01T03:00:00.000Z"}"#;

        let analysis = analyze_session_jsonl_content(content);

        assert_eq!(analysis.query_count, 2);
        assert_eq!(
            analysis
                .last_memory_update_at
                .expect("memory marker")
                .to_rfc3339(),
            "2026-01-01T01:00:00+00:00"
        );
        assert_eq!(
            analysis.last_human_user_at.expect("last user").to_rfc3339(),
            "2026-01-01T03:00:00+00:00"
        );
    }

    #[test]
    fn update_window_handles_wrapping_ranges() {
        let cfg = base_config();
        assert!(is_local_time_in_window(60, &cfg));
        assert!(!is_local_time_in_window(8 * 60, &cfg));

        let mut wrapping = cfg;
        wrapping.update_window_start = "21:00".to_string();
        wrapping.update_window_end = "09:00".to_string();
        assert!(is_local_time_in_window(22 * 60, &wrapping));
        assert!(is_local_time_in_window(2 * 60, &wrapping));
        assert!(!is_local_time_in_window(12 * 60, &wrapping));
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

    #[test]
    fn schedule_policy_match_ignores_transient_start_anchor_but_requires_valid_anchor() {
        let cfg = base_config();
        let desired = schedule_for_config(&cfg);
        let existing = CronSchedule::Every {
            minutes: SCAN_CADENCE_MINUTES,
            start_at: Some("2026-07-08T00:00:00Z".to_string()),
            catch_up_window: Some(recurring_window(&cfg)),
        };
        let missing_anchor = CronSchedule::Every {
            minutes: SCAN_CADENCE_MINUTES,
            start_at: None,
            catch_up_window: Some(recurring_window(&cfg)),
        };
        let wrong_cadence = CronSchedule::Every {
            minutes: SCAN_CADENCE_MINUTES + 1,
            start_at: Some("2026-07-08T00:00:00Z".to_string()),
            catch_up_window: Some(recurring_window(&cfg)),
        };

        assert!(schedule_policy_matches(Some(&existing), &desired));
        assert!(!schedule_policy_matches(Some(&missing_anchor), &desired));
        assert!(!schedule_policy_matches(Some(&wrong_cadence), &desired));
    }

    #[test]
    fn disk_reconcile_only_uses_explicit_memory_auto_update_config() {
        let config = serde_json::json!({
            "agents": [
                {
                    "id": "missing",
                    "workspacePath": "/tmp/missing"
                },
                {
                    "id": "enabled",
                    "workspacePath": "/tmp/enabled",
                    "memoryAutoUpdate": {
                        "enabled": true,
                        "intervalHours": 24,
                        "queryThreshold": 3,
                        "updateWindowStart": "00:00",
                        "updateWindowEnd": "07:00",
                        "updateWindowTimezone": "Asia/Shanghai"
                    }
                },
                {
                    "id": "disabled",
                    "workspacePath": "/tmp/disabled",
                    "memoryAutoUpdate": {
                        "enabled": false,
                        "intervalHours": 24,
                        "queryThreshold": 3,
                        "updateWindowStart": "00:00",
                        "updateWindowEnd": "07:00",
                        "updateWindowTimezone": "Asia/Shanghai"
                    }
                }
            ]
        });

        let agents = collect_disk_memory_auto_update_agents(&config);

        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].request.agent_id, "enabled");
        assert_eq!(
            agents[0]
                .request
                .memory_auto_update
                .as_ref()
                .unwrap()
                .enabled,
            true
        );
        assert_eq!(agents[1].request.agent_id, "disabled");
        assert_eq!(
            agents[1]
                .request
                .memory_auto_update
                .as_ref()
                .unwrap()
                .enabled,
            false
        );
    }
}
