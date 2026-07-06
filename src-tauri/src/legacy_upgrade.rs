//! Legacy CronTask → new-model Task upgrade primitive (PRD §11.4).
//!
//! v0.1.68 CronTasks don't have a `task_id` back-pointer and so surface in
//! the Task Center as "遗留" rows. This module turns them into proper
//! new-model Tasks, preserving schedule / prompt / workspace / end
//! conditions / runtime config — the existing CronTask keeps running, we
//! just wire both-sided back-pointers.
//!
//! Design notes:
//!
//! 1. **No synthetic Thought.** Earlier iterations auto-created a Thought
//!    whose content was the cron's prompt, on the theory that every Task
//!    must have a `sourceThoughtId`. In practice this polluted the user's
//!    thought stream with one "synthetic" entry per upgraded cron. The v1
//!    invariant ("every NEW Task has a sourceThoughtId") doesn't need to
//!    apply to migrations: a legacy cron has no thought and there was
//!    never a moment at which one would have been captured. We leave
//!    `source_thought_id = None` on migrated tasks.
//!
//! 2. **Preserve lifecycle state.** Crons have two statuses (Running /
//!    Stopped), but a stopped cron means any of three things — user
//!    paused, end conditions fired, AI self-exited. `exit_reason` tells
//!    them apart. We map:
//!      - Running                           → Task::Running
//!      - Stopped + exit_reason set         → Task::Done
//!      - Stopped without exit_reason       → Task::Stopped
//!    This is what `TaskStore::create_migrated` is for — the regular
//!    `create_direct` always starts Todo, which lies about already-
//!    completed crons by dumping them into 待启动.
//!
//! 3. **Rust-native field conversions.** The whole reason this lives in
//!    Rust (not TypeScript) is to let the type system catch serde-shape
//!    drift between `cron_task::*` and `task::*` at `cargo check` time.
//!    Every conversion helper below is a `match` on a strongly-typed
//!    enum; add a variant on either side and the compiler refuses to
//!    build.
//!
//! 4. **Atomic rollback.** The whole pipeline lives inside a single
//!    `async fn`. `cron_manager.set_task_id` uses `require_null=true`,
//!    so two concurrent upgrades on the same cron can't both "win" —
//!    the loser sees `ALREADY_LINKED` and we undo the partial Task we
//!    just created.

use crate::cron_task;
use crate::task;
use crate::thought;
use crate::ulog_info;

/// Map a CronTask's `RunMode` to the Task-side enum.
fn run_mode_from_cron(rm: &cron_task::RunMode) -> task::TaskRunMode {
    match rm {
        cron_task::RunMode::SingleSession => task::TaskRunMode::SingleSession,
        cron_task::RunMode::NewSession => task::TaskRunMode::NewSession,
    }
}

/// Map a CronTask's `EndConditions` (deadline as `DateTime<Utc>`) to the
/// Task-side shape (deadline as `i64` ms-epoch).
fn end_conditions_from_cron(ec: &cron_task::EndConditions) -> task::TaskEndConditions {
    task::TaskEndConditions {
        deadline: ec.deadline.map(|dt| dt.timestamp_millis()),
        max_executions: ec.max_executions,
        ai_can_exit: ec.ai_can_exit,
    }
}

/// Derive the Task's `execution_mode` from the cron's schedule kind.
fn execution_mode_from_cron_schedule(
    schedule: &Option<cron_task::CronSchedule>,
) -> task::TaskExecutionMode {
    match schedule {
        Some(cron_task::CronSchedule::At { .. }) => task::TaskExecutionMode::Scheduled,
        Some(cron_task::CronSchedule::Loop) => task::TaskExecutionMode::Loop,
        _ => task::TaskExecutionMode::Recurring,
    }
}

/// Build a Task-side `NotificationConfig` from the cron's (flat) notification
/// fields. `CronDelivery.platform` has no Task-side counterpart — the channel
/// id carries the platform implicitly via the bot registry.
fn notification_from_cron(
    notify_enabled: bool,
    delivery: &Option<cron_task::CronDelivery>,
) -> task::NotificationConfig {
    task::NotificationConfig {
        desktop: notify_enabled,
        bot_channel_id: delivery.as_ref().map(|d| d.bot_id.clone()),
        bot_thread: delivery.as_ref().map(|d| d.chat_id.clone()),
        events: Some(vec![
            "done".to_string(),
            "blocked".to_string(),
            "endCondition".to_string(),
        ]),
    }
}

/// Compute the Task status that best represents the cron's current
/// lifecycle state. See the module doc for mapping rules.
fn initial_status_from_cron(cron: &cron_task::CronTask) -> task::TaskStatus {
    match cron.status {
        cron_task::TaskStatus::Running => task::TaskStatus::Running,
        cron_task::TaskStatus::Stopped => {
            if cron.exit_reason.is_some() {
                task::TaskStatus::Done
            } else {
                task::TaskStatus::Stopped
            }
        }
    }
}

fn migration_message_for(status: task::TaskStatus, cron: &cron_task::CronTask) -> String {
    match status {
        task::TaskStatus::Running => "migrated from legacy cron (running)".to_string(),
        task::TaskStatus::Done => cron
            .exit_reason
            .as_deref()
            .map(|r| format!("migrated from legacy cron (done: {})", r))
            .unwrap_or_else(|| "migrated from legacy cron (done)".to_string()),
        task::TaskStatus::Stopped => "migrated from legacy cron (paused)".to_string(),
        _ => "migrated from legacy cron".to_string(),
    }
}

fn derive_task_name(cron: &cron_task::CronTask) -> String {
    if let Some(name) = cron.name.as_deref() {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return truncate_chars(trimmed, 120);
        }
    }
    let first_line = cron
        .prompt
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("未命名定时任务")
        .trim();
    truncate_chars(first_line, 60)
}

fn truncate_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let keep: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", keep)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeResult {
    pub task: task::Task,
}

/// Upgrade one legacy CronTask to a new-model Task.
///
/// The renderer resolves `workspace_path → workspace_id` from its config
/// and passes the id in (Rust doesn't have a cross-process view of the
/// projects list). Everything else — schedule mapping, status derivation,
/// rollback — happens server-side under a single `async fn`.
///
/// `thought_store` is kept in the signature so future revisions can use
/// it (e.g. if we add user-opt-in "also create a thought on upgrade"
/// behavior), but the default migration does NOT create a Thought.
pub async fn upgrade_legacy_cron(
    task_store: &task::TaskStore,
    _thought_store: &thought::ThoughtStore,
    cron_task_id: &str,
    workspace_id: &str,
) -> Result<UpgradeResult, String> {
    let manager = cron_task::get_cron_task_manager();
    let cron = manager
        .get_task(cron_task_id)
        .await
        .ok_or_else(|| format!("CronTask not found: {}", cron_task_id))?;

    if let Some(existing_task_id) = &cron.task_id {
        return Err(format!(
            "ALREADY_LINKED: CronTask {} is already linked to Task {}",
            cron_task_id, existing_task_id
        ));
    }

    let prompt = cron.prompt.trim();
    if prompt.is_empty() {
        return Err("CronTask has an empty prompt; refusing to upgrade".to_string());
    }

    // Build input from strongly-typed Rust conversions — no JSON round-
    // trip means field drift between cron_task::* and task::* becomes a
    // compile error in the helpers above, not a runtime serde failure.
    let execution_mode = execution_mode_from_cron_schedule(&cron.schedule);
    let run_mode = Some(run_mode_from_cron(&cron.run_mode));
    let end_conditions = Some(end_conditions_from_cron(&cron.end_conditions));
    let notification = Some(notification_from_cron(cron.notify_enabled, &cron.delivery));
    let initial_status = initial_status_from_cron(&cron);

    // Carry scheduling detail from the CronTask so the migrated Task
    // survives a schedule-shape edit without losing the user's interval /
    // cron expression / dispatch time.
    let (interval_minutes, cron_expression, cron_timezone, dispatch_at) = match &cron.schedule {
        Some(cron_task::CronSchedule::Every { minutes, .. }) => (Some(*minutes), None, None, None),
        Some(cron_task::CronSchedule::Cron { expr, tz }) => {
            (None, Some(expr.clone()), tz.clone(), None)
        }
        Some(cron_task::CronSchedule::At { at }) => {
            let ms = chrono::DateTime::parse_from_rfc3339(at)
                .ok()
                .map(|dt| dt.timestamp_millis());
            (None, None, None, ms)
        }
        Some(cron_task::CronSchedule::Loop) | None => (None, None, None, None),
    };

    let input = task::TaskCreateDirectInput {
        name: derive_task_name(&cron),
        executor: task::TaskExecutor::Agent,
        description: None,
        workspace_id: workspace_id.to_string(),
        workspace_path: cron.workspace_path.clone(),
        task_md_content: cron.prompt.clone(),
        execution_mode,
        run_mode,
        end_conditions,
        interval_minutes,
        cron_expression,
        cron_timezone,
        start_at: None,
        recurring_window: None,
        dispatch_at,
        model: cron.model.clone(),
        // PRD 0.2.9 — Legacy crons store credential snapshots in
        // `provider_env` rather than the new `provider_id` indirection. We
        // intentionally drop them here: the upgraded Task will resolve the
        // provider via the agent workspace at execute time (FollowAgent
        // semantics), which preserves "what the user thinks runs" without
        // copying secrets into the new tasks.jsonl.
        provider_id: None,
        permission_mode: Some(cron.permission_mode.clone()),
        preselected_session_id: Some(cron.session_id.clone()),
        runtime: cron.runtime.clone(),
        runtime_config: cron.runtime_config.clone(),
        // Legacy crons predate the per-task MCP override (PRD 0.2.4 §需求 4)
        // — `None` means "follow Agent workspace MCP enable list".
        mcp_enabled_servers: None,
        managed_kind: None,
        // Legacy crons have no source Thought and we don't mint one —
        // synthetic thoughts pollute the user's thought stream without
        // carrying any of the "captured a raw idea" meaning the field
        // is supposed to represent.
        source_thought_id: None,
        tags: vec![],
        notification,
    };

    // Create the Task with the status that matches the cron's current
    // lifecycle state — not the default Todo.
    let task = task_store
        .create_migrated(
            input,
            initial_status,
            migration_message_for(initial_status, &cron),
        )
        .await
        .map_err(|e| format!("create migrated task: {}", e))?;

    // Forward pointer Task → CronTask.
    if let Err(e) = task_store
        .set_cron_task_id(&task.id, Some(cron_task_id.to_string()))
        .await
    {
        let _ = task_store.delete(&task.id).await;
        return Err(format!("set Task.cron_task_id: {}", e));
    }

    // Back pointer CronTask → Task, with link-if-null guard. When two
    // upgrade flows race on the same cron, the loser sees
    // `ALREADY_LINKED` here and we roll back the partial Task we just
    // created.
    if let Err(e) = manager
        .set_task_id(cron_task_id, Some(task.id.clone()), true)
        .await
    {
        let _ = task_store.set_cron_task_id(&task.id, None).await;
        let _ = task_store.delete(&task.id).await;
        return Err(format!("set CronTask.task_id: {}", e));
    }

    ulog_info!(
        "[legacy-upgrade] cron {} → task {} (status {})",
        cron_task_id,
        task.id,
        initial_status.as_str()
    );

    Ok(UpgradeResult { task })
}

/// Tauri command — thin wrapper around `upgrade_legacy_cron`.
#[tauri::command]
pub async fn cmd_task_upgrade_legacy_cron(
    task_state: tauri::State<'_, task::ManagedTaskStore>,
    thought_state: tauri::State<'_, thought::ManagedThoughtStore>,
    cron_task_id: String,
    workspace_id: String,
) -> Result<UpgradeResult, String> {
    upgrade_legacy_cron(&task_state, &thought_state, &cron_task_id, &workspace_id).await
}
