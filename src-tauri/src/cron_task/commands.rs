use super::*;

// ============ Tauri Commands ============

/// Create a new cron task
#[tauri::command]
pub async fn cmd_create_cron_task(config: CronTaskConfig) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.create_task(config).await
}

/// Start a cron task
/// The cron task Sidecar will be started on-demand when the first execution runs
#[tauri::command]
pub async fn cmd_start_cron_task(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    let task = manager.start_task(&task_id).await?;

    ulog_info!(
        "[CronTask] Started cron task {} for workspace {}",
        task.id,
        task.workspace_path
    );

    // Emit event so frontend task list refreshes immediately
    let _ = app_handle.emit(
        "cron:task-started",
        serde_json::json!({
            "taskId": task.id,
        }),
    );

    Ok(task)
}

/// Stop a cron task (with optional exit reason)
/// exit_reason can be set when AI calls ExitCronTask or end conditions are met
#[tauri::command]
pub async fn cmd_stop_cron_task(
    task_id: String,
    exit_reason: Option<String>,
) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.stop_task(&task_id, exit_reason).await
}

/// Delete a cron task
#[tauri::command]
pub async fn cmd_delete_cron_task(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.delete_task(&task_id).await?;
    let _ = app_handle.emit(
        "cron:task-deleted",
        serde_json::json!({ "taskId": task_id }),
    );
    Ok(())
}

/// Get a cron task by ID
#[tauri::command]
pub async fn cmd_get_cron_task(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager
        .get_task(&task_id)
        .await
        .ok_or_else(|| format!("Task not found: {}", task_id))
}

/// Get all cron tasks
#[tauri::command]
pub async fn cmd_get_cron_tasks() -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager
        .get_all_tasks()
        .await
        .into_iter()
        .filter(|task| task.managed_kind.is_none())
        .collect())
}

/// Get cron tasks for a workspace
#[tauri::command]
pub async fn cmd_get_workspace_cron_tasks(workspace_path: String) -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager
        .get_tasks_for_workspace(&workspace_path)
        .await
        .into_iter()
        .filter(|task| task.managed_kind.is_none())
        .collect())
}

/// Get active cron task for a session (running only)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_get_session_cron_task(sessionId: String) -> Result<Option<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_active_task_for_session(&sessionId).await)
}

/// Get active cron task for a tab (running only)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_get_tab_cron_task(tabId: String) -> Result<Option<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_active_task_for_tab(&tabId).await)
}

/// Record task execution (called by Sidecar after execution completes)
#[tauri::command]
pub async fn cmd_record_cron_execution(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.record_execution(&task_id).await
}

/// Update task's tab association
#[tauri::command]
pub async fn cmd_update_cron_task_tab(
    task_id: String,
    tab_id: Option<String>,
) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.update_task_tab(&task_id, tab_id).await
}

/// Update task's session ID (called when session is created after task creation)
#[tauri::command]
pub async fn cmd_update_cron_task_session(
    task_id: String,
    session_id: String,
) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.update_task_session(&task_id, session_id).await
}

/// Get tasks that need recovery (tasks that were running before app restart)
#[tauri::command]
pub async fn cmd_get_tasks_to_recover() -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_tasks_to_recover().await)
}

/// Start the scheduler for a task
/// This function is called both for initial task start and for recovery after app restart.
/// With Session-centric Sidecar (Owner model), this ensures CronTask is added as owner.
#[tauri::command]
pub async fn cmd_start_cron_scheduler(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    ulog_info!(
        "[CronTask] cmd_start_cron_scheduler called for task: {}",
        task_id
    );

    let manager = get_cron_task_manager();
    ulog_debug!("[CronTask] Got manager, getting task...");

    // Get task info for session activation
    let task = manager
        .get_task(&task_id)
        .await
        .ok_or_else(|| format!("Task not found: {}", task_id))?;
    ulog_debug!(
        "[CronTask] Got task: {}, session_id: {}",
        task_id,
        task.session_id
    );

    // Ensure Session has a Sidecar with CronTask as owner
    // IMPORTANT: Use spawn_blocking because ensure_session_sidecar uses reqwest::blocking::Client
    // which cannot be called from within a tokio async runtime (causes deadlock)
    if let Some(sidecar_state) = app_handle.try_state::<ManagedSidecarManager>() {
        ulog_debug!("[CronTask] Got sidecar state, ensuring session sidecar...");

        // Clone data for spawn_blocking (requires 'static lifetime)
        let app_handle_clone = app_handle.clone();
        let sidecar_state_clone = sidecar_state.inner().clone();
        let session_id = task.session_id.clone();
        let workspace_path = task.workspace_path.clone();
        let owner = SidecarOwner::CronTask(task_id.clone());
        let task_id_for_log = task_id.clone();
        let tab_id = task.tab_id.clone();

        ulog_info!(
            "[CronTask] Calling ensure_session_sidecar for session: {}",
            session_id
        );

        // Run blocking sidecar operations in a dedicated thread pool
        let result = tokio::task::spawn_blocking(move || {
            let workspace = std::path::Path::new(&workspace_path);
            ensure_session_sidecar(
                &app_handle_clone,
                &sidecar_state_clone,
                &session_id,
                workspace,
                owner,
            )
        })
        .await
        .map_err(|e| format!("spawn_blocking failed: {}", e))?;

        match result {
            Ok(result) => {
                ulog_info!(
                    "[CronTask] Ensured Sidecar for session {} (port={}, is_new={})",
                    task.session_id,
                    result.port,
                    result.is_new
                );

                // Activate session (for legacy session tracking)
                if let Ok(mut sidecar_manager) = sidecar_state.lock() {
                    sidecar_manager.activate_session(
                        task.session_id.clone(),
                        tab_id,
                        Some(task_id_for_log),
                        result.port,
                        task.workspace_path.clone(),
                        true, // is_cron_task = true
                    );
                }
            }
            Err(e) => {
                ulog_error!(
                    "[CronTask] Failed to ensure Sidecar for task {}: {}",
                    task_id,
                    e
                );
                return Err(e);
            }
        }
    }

    // Start the scheduler loop
    manager.start_task_scheduler(&task_id).await
}

/// Mark a task as currently executing (called when execution starts)
#[tauri::command]
pub async fn cmd_mark_task_executing(task_id: String) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.mark_task_executing(&task_id).await;
    Ok(())
}

/// Mark a task as no longer executing (called when execution completes)
#[tauri::command]
pub async fn cmd_mark_task_complete(task_id: String) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.mark_task_complete(&task_id).await;
    Ok(())
}

/// Check if a task is currently executing
#[tauri::command]
pub async fn cmd_is_task_executing(task_id: String) -> Result<bool, String> {
    let manager = get_cron_task_manager();
    Ok(manager.is_task_executing(&task_id).await)
}

/// Get execution history (run records) for a cron task
#[tauri::command]
pub fn cmd_get_cron_runs(
    task_id: String,
    limit: Option<usize>,
) -> Result<Vec<CronRunRecord>, String> {
    Ok(read_cron_runs(&task_id, limit.unwrap_or(20)))
}

/// Update editable fields of a cron task (name, prompt, schedule, endConditions)
/// If the task is running, it will be stopped, updated, and restarted.
#[tauri::command]
pub async fn cmd_update_cron_task_fields(
    app_handle: tauri::AppHandle,
    task_id: String,
    name: Option<String>,
    prompt: Option<String>,
    schedule: Option<CronSchedule>,
    interval_minutes: Option<u32>,
    end_conditions: Option<EndConditions>,
    notify_enabled: Option<bool>,
    model: Option<String>,
    permission_mode: Option<String>,
    delivery: Option<CronDelivery>,
    clear_delivery: Option<bool>,
) -> Result<CronTask, String> {
    // Delegate to the single-source-of-truth implementation in
    // `update_task_fields`. It handles the stop→apply→restart bounce
    // uniformly for every caller (Tauri command + Task Center projection),
    // so changing a running cron's schedule through any surface takes effect
    // immediately.
    let manager = get_cron_task_manager();
    let mut patch = serde_json::Map::new();
    if let Some(n) = name {
        patch.insert("name".to_string(), serde_json::Value::String(n));
    }
    if let Some(p) = prompt {
        patch.insert("prompt".to_string(), serde_json::Value::String(p));
    }
    if let Some(s) = schedule {
        patch.insert(
            "schedule".to_string(),
            serde_json::to_value(&s).unwrap_or(serde_json::Value::Null),
        );
    }
    if let Some(im) = interval_minutes {
        patch.insert(
            "intervalMinutes".to_string(),
            serde_json::Value::Number(serde_json::Number::from(im)),
        );
    }
    if let Some(ec) = end_conditions {
        patch.insert(
            "endConditions".to_string(),
            serde_json::to_value(&ec).unwrap_or(serde_json::Value::Null),
        );
    }
    if let Some(ne) = notify_enabled {
        patch.insert("notifyEnabled".to_string(), serde_json::Value::Bool(ne));
    }
    if let Some(m) = model {
        patch.insert("model".to_string(), serde_json::Value::String(m));
    }
    if let Some(pm) = permission_mode {
        patch.insert("permissionMode".to_string(), serde_json::Value::String(pm));
    }
    if let Some(d) = delivery {
        patch.insert(
            "delivery".to_string(),
            serde_json::to_value(&d).unwrap_or(serde_json::Value::Null),
        );
    } else if clear_delivery == Some(true) {
        patch.insert("clearDelivery".to_string(), serde_json::Value::Bool(true));
    }

    let updated = manager
        .update_task_fields(&task_id, serde_json::Value::Object(patch))
        .await?;

    let _ = app_handle.emit(
        "cron:task-updated",
        serde_json::json!({ "taskId": task_id }),
    );
    Ok(updated)
}
