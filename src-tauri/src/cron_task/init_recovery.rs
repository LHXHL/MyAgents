use super::*;

/// Initialize cron task manager with app handle (called during app setup)
/// Now includes unified recovery logic (方案 A: Rust 统一恢复)
/// Emits "cron:manager-ready" event when initialization is complete
/// Emits "cron:task-recovered" for each recovered task
/// Emits "cron:recovery-summary" after all recovery attempts complete
pub async fn initialize_cron_manager(handle: AppHandle) {
    let manager = get_cron_task_manager();
    manager.set_app_handle(handle.clone()).await;
    ulog_info!("[CronTask] Manager initialized with app handle");

    let sidecars = handle.state::<ManagedSidecarManager>().inner().clone();
    match sidecars.lock() {
        Ok(guard) => {
            let mut sidecar_stops = guard.subscribe_stop_events();
            let sidecars_for_reconcile = sidecars.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match sidecar_stops.recv().await {
                        Ok((session_id, generation)) => {
                            revoke_stopped_sidecar_authority_until_durable(&session_id, generation)
                                .await;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                            ulog_warn!(
                                "[CronTask] Sidecar lifecycle listener lagged by {} event(s); reconciling durable Goal authorities",
                                count
                            );
                            reconcile_goal_authorities_until_durable(&sidecars_for_reconcile).await;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        }
        Err(error) => ulog_error!(
            "[CronTask] Failed to subscribe to Sidecar lifecycle: {}",
            error
        ),
    }

    // CronTaskManager::new performs synchronous normalization before any API
    // can observe the store (legacy permission cleanup + Goal authority
    // recovery). Persist that single startup snapshot before schedulers attach.
    persist_startup_normalization(manager).await;
    replay_goal_delivery_outboxes(manager).await;

    // Safety-net heal: recurring/scheduled Tasks whose schedule fields
    // were wiped by an earlier migration bug can be repaired from the
    // linked CronTask, which still carries the authoritative schedule.
    // Must run before `recover_running_tasks` so the recovery pass sees
    // the healed schedule (and `ensure_cron_for_task` doesn't silently
    // fall back to the 60-minute default for a task the user set to
    // "every day at 11am").
    heal_task_schedule_fields(manager).await;

    // Recover running tasks (方案 A: Rust 层统一恢复)
    recover_running_tasks(&handle).await;

    if let Err(error) =
        crate::memory_auto_update::reconcile_memory_auto_update_tasks_from_disk().await
    {
        ulog_warn!(
            "[memory-auto-update] startup disk-first reconcile failed: {}",
            error
        );
    }

    // Emit event to notify frontend that cron manager is ready
    // Frontend no longer needs to call recoverCronTasks
    let _ = handle.emit("cron:manager-ready", serde_json::json!({}));
    ulog_info!("[CronTask] Emitted cron:manager-ready event");
}

async fn revoke_stopped_sidecar_authority_until_durable(session_id: &str, generation: u64) {
    let manager = get_cron_task_manager();
    loop {
        match manager
            .revoke_goal_turn_authorities_for_sidecar(session_id, generation)
            .await
        {
            Ok(0) => return,
            Ok(count) => {
                ulog_info!(
                    "[CronTask] Revoked Goal turn authority for {} task(s) after Sidecar {} generation {} stopped",
                    count,
                    session_id,
                    generation
                );
                return;
            }
            Err(error) => ulog_error!(
                "[CronTask] Goal authority revoke is not durable after Sidecar {} generation {} stopped: {}; retrying",
                session_id,
                generation,
                error
            ),
        }
        if *manager.shutdown.read().await {
            return;
        }
        tokio::time::sleep(super::manager::goal_durable_retry_delay()).await;
    }
}

async fn reconcile_goal_authorities_until_durable(sidecars: &ManagedSidecarManager) {
    let manager = get_cron_task_manager();
    loop {
        match manager
            .reconcile_goal_turn_authorities_with_live_sidecars(sidecars)
            .await
        {
            Ok(0) => return,
            Ok(count) => {
                ulog_info!(
                    "[CronTask] Reconciled {} Goal authority task(s) after Sidecar event lag",
                    count
                );
                return;
            }
            Err(error) => ulog_error!(
                "[CronTask] Goal authority reconciliation is not durable: {}; retrying",
                error
            ),
        }
        if *manager.shutdown.read().await {
            return;
        }
        tokio::time::sleep(super::manager::goal_durable_retry_delay()).await;
    }
}

async fn replay_goal_delivery_outboxes(manager: &'static CronTaskManager) {
    for task_id in manager.goal_delivery_outbox_task_ids().await {
        manager.ensure_goal_delivery_replay(&task_id).await;
    }
}

/// Persist construction-time normalization before recovery starts schedulers.
/// The synchronous pass must run in `CronTaskManager::new()` so Management API
/// readers never see stale authority; its async disk write belongs here.
async fn persist_startup_normalization(manager: &CronTaskManager) {
    if let Err(e) = manager.save_to_disk().await {
        ulog_warn!(
            "[CronTask] Startup normalization persist failed (in-memory state still \
             correct; next mutation will persist): {}",
            e
        );
    }
}

/// Scan every live CronTask, take a snapshot of its schedule, and offer it
/// to `TaskStore` as backfill material for any linked Task with missing
/// schedule fields. The backfill helper only writes when a field is
/// actually empty — stable tasks are untouched.
async fn heal_task_schedule_fields(manager: &CronTaskManager) {
    let Some(task_store) = crate::task::get_task_store() else {
        return;
    };
    let cron_tasks = manager.get_all_tasks().await;
    // Build a lookup by cron task id so the TaskStore heal pass can answer
    // "what schedule does this CronTask have?" without holding the cron
    // manager lock while we iterate the Task map.
    let snapshot: std::collections::HashMap<String, crate::task::ScheduleBackfill> = cron_tasks
        .into_iter()
        .filter_map(|ct| {
            let backfill = match ct.schedule.as_ref()? {
                CronSchedule::Every { minutes, .. } => {
                    crate::task::ScheduleBackfill::IntervalMinutes(*minutes)
                }
                CronSchedule::Cron { expr, tz } => crate::task::ScheduleBackfill::Cron {
                    expression: expr.clone(),
                    timezone: tz.clone(),
                },
                CronSchedule::At { at } => crate::task::ScheduleBackfill::DispatchAt(
                    chrono::DateTime::parse_from_rfc3339(at)
                        .ok()?
                        .timestamp_millis(),
                ),
                CronSchedule::Loop => return None,
            };
            Some((ct.id, backfill))
        })
        .collect();

    if snapshot.is_empty() {
        return;
    }

    let healed = task_store
        .heal_missing_schedule_fields(|cron_id| snapshot.get(cron_id).cloned())
        .await;
    if !healed.is_empty() {
        ulog_info!(
            "[task] safety-net heal: back-filled schedule on {} task(s) from linked CronTasks: {:?}",
            healed.len(),
            healed
        );
    }
}

/// Recover all tasks that were running before app restart (方案 A: Rust 统一恢复)
/// This function:
/// 1. Gets all tasks with status=Running
/// 2. For each task: starts Sidecar, activates session, starts scheduler
/// 3. Emits cron:task-recovered for each success
/// 4. Emits cron:recovery-summary when done
async fn recover_running_tasks(handle: &AppHandle) {
    let manager = get_cron_task_manager();
    let tasks_to_recover = manager.get_tasks_to_recover().await;

    if tasks_to_recover.is_empty() {
        ulog_info!("[CronTask] No tasks to recover");
        // Emit empty summary
        let _ = handle.emit(
            "cron:recovery-summary",
            CronRecoverySummaryPayload {
                total_tasks: 0,
                recovered_count: 0,
                failed_count: 0,
                failed_tasks: vec![],
            },
        );
        return;
    }

    // Phrased as "reattaching" rather than "recovering" so the log line
    // doesn't read like a crash-recovery event — every boot reattaches all
    // persisted Running tasks to a fresh Sidecar, which is the normal
    // happy path, not error remediation. (cron:task-recovered / cron:recovery-summary
    // event names retained for frontend compatibility.)
    ulog_info!(
        "[CronTask] Reattaching {} scheduled task(s) (status=Running)...",
        tasks_to_recover.len()
    );

    let mut recovered_count = 0u32;
    let mut failed_tasks: Vec<CronRecoveryFailedTask> = vec![];

    for task in &tasks_to_recover {
        match try_recover_single_task(handle, task).await {
            Ok(port) => {
                recovered_count += 1;
                ulog_info!("[CronTask] Reattached task {} on port {}", task.id, port);

                // Emit task-recovered event for frontend
                let _ = handle.emit(
                    "cron:task-recovered",
                    CronTaskRecoveredPayload {
                        task_id: task.id.clone(),
                        session_id: task.session_id.clone(),
                        workspace_path: task.workspace_path.clone(),
                        port,
                        status: "running".to_string(),
                        execution_count: task.execution_count,
                        interval_minutes: task.interval_minutes,
                    },
                );
            }
            Err(e) => {
                ulog_error!("[CronTask] Failed to reattach task {}: {}", task.id, e);
                failed_tasks.push(CronRecoveryFailedTask {
                    task_id: task.id.clone(),
                    workspace_path: task.workspace_path.clone(),
                    error: e,
                });
            }
        }
    }

    let total = tasks_to_recover.len() as u32;
    let failed_count = failed_tasks.len() as u32;

    ulog_info!(
        "[CronTask] Reattach complete: {}/{} tasks reattached, {} failed",
        recovered_count,
        total,
        failed_count
    );

    // Emit recovery summary
    let _ = handle.emit(
        "cron:recovery-summary",
        CronRecoverySummaryPayload {
            total_tasks: total,
            recovered_count,
            failed_count,
            failed_tasks,
        },
    );
}

/// Try to recover a single task
/// Returns the Sidecar port on success
async fn try_recover_single_task(handle: &AppHandle, task: &CronTask) -> Result<u16, String> {
    ulog_info!(
        "[CronTask] Reattaching task {} for workspace {}",
        task.id,
        task.workspace_path
    );

    // Step 1: Ensure Session has a Sidecar with CronTask as owner
    // IMPORTANT: Use spawn_blocking because ensure_session_sidecar uses reqwest::blocking::Client
    // which cannot be called from within a tokio async runtime (causes deadlock)
    let sidecar_state = handle
        .try_state::<ManagedSidecarManager>()
        .ok_or_else(|| "SidecarManager state not available".to_string())?;

    // Clone data for spawn_blocking (requires 'static lifetime)
    let handle_clone = handle.clone();
    let sidecar_state_clone = sidecar_state.inner().clone();
    let session_id = task.session_id.clone();
    let workspace_path = task.workspace_path.clone();
    let task_id = task.id.clone();
    let owner = SidecarOwner::CronTask(task_id.clone());

    // Run blocking sidecar operations in a dedicated thread pool
    let result = tokio::task::spawn_blocking(move || {
        let workspace = std::path::Path::new(&workspace_path);
        ensure_session_sidecar(
            &handle_clone,
            &sidecar_state_clone,
            &session_id,
            workspace,
            owner,
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))??;

    ulog_info!(
        "[CronTask] Session {} Sidecar ensured: port={}, is_new={}",
        task.session_id,
        result.port,
        result.is_new
    );

    // Step 2: Activate session (for legacy session tracking)
    {
        let mut manager = sidecar_state
            .lock()
            .map_err(|e| format!("Failed to lock SidecarManager: {}", e))?;

        manager.activate_cron_session(
            task.session_id.clone(),
            task_id,
            result.port,
            task.workspace_path.clone(),
        );
        ulog_info!(
            "[CronTask] Session {} activated for task {}",
            task.session_id,
            task.id
        );
    }

    // Step 3: Start scheduler
    let cron_manager = get_cron_task_manager();
    cron_manager.start_task_scheduler(&task.id).await?;
    ulog_info!("[CronTask] Scheduler started for task {}", task.id);

    Ok(result.port)
}
