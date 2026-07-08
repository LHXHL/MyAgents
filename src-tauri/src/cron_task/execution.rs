use super::*;

// ============ Helper Functions ============

/// Check if task should end based on conditions (static version for use in scheduler)
pub(super) fn check_end_conditions_static(task: &CronTask) -> bool {
    // Check deadline
    if let Some(deadline) = task.end_conditions.deadline {
        if Utc::now() >= deadline {
            ulog_info!("[CronTask] Task {} reached deadline", task.id);
            return true;
        }
    }

    // Check max executions
    if let Some(max) = task.end_conditions.max_executions {
        if task.execution_count >= max {
            ulog_info!(
                "[CronTask] Task {} reached max executions ({})",
                task.id,
                max
            );
            return true;
        }
    }

    false
}

/// Rotate the session id for a `NewSession` cron task ahead of the next execution.
///
/// Keeps the Rust `ManagedSidecar` registry key and Bun's actual session id in
/// lockstep. Without this, `task.session_id` stayed as the placeholder forever
/// and Bun generated its own id inside `switchToSession(createSession(...))` —
/// the two diverged, the registry no longer found the live sidecar by the
/// real session id, and opening the session from history spawned a duplicate
/// read-only sidecar that couldn't see the in-flight execution.
///
/// Side effects:
///   - Releases the CronTask's ownership of the previous session's sidecar.
///     If that was the only owner, the sidecar stops. If a Tab had joined it
///     (rare for new_session mode, but possible if the user opened it mid-run),
///     the tab stays the remaining owner and the sidecar continues — benign.
///   - Writes the new id back to `tasks[task.id].session_id` so subsequent
///     ticks / crash-recovery / release paths see a consistent value.
///   - Does NOT persist to `cron_tasks.json` synchronously; the periodic
///     save path picks it up. Rotation always produces a fresh UUID so even
///     if the process dies mid-tick the stored placeholder id never collides.
async fn rotate_new_session_id(handle: &AppHandle, task: &CronTask) -> Result<String, String> {
    let new_session_id = Uuid::new_v4().to_string();
    let old_session_id = task.session_id.clone();

    if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
        let owner = SidecarOwner::CronTask(task.id.clone());
        if let Err(e) = release_session_sidecar(&sidecar_state, &old_session_id, &owner) {
            // Non-fatal: release failure just means the sidecar may linger
            // until another owner releases it or the app exits.
            ulog_warn!(
                "[CronTask] rotate_new_session_id: release old session {} failed: {} (non-fatal)",
                old_session_id,
                e
            );
        }
    }

    let manager = get_cron_task_manager();
    {
        let mut tasks_guard = manager.tasks.write().await;
        if let Some(t) = tasks_guard.get_mut(&task.id) {
            t.session_id = new_session_id.clone();
            // Keep `internal_session_id` in lockstep so any consumer that
            // falls back to `internalSessionId || sessionId` (Chat.tsx,
            // CronTaskDetailPanel, useTaskCenterData) doesn't observe a
            // tick-start window where they disagree. Post-rotation these
            // are semantically the same thing: Bun's real session id.
            t.internal_session_id = Some(new_session_id.clone());
            t.updated_at = Utc::now();
        }
    }

    // Persist the rotation synchronously. The previous docstring claimed a
    // "periodic save path picks it up" — no such periodic loop exists.
    // Without this `save_to_disk`, a Rust crash between rotate and the next
    // mutation-triggered save would leave `cron_tasks.json` pointing at a
    // stale session id; on restart `try_recover_single_task` would ensure
    // a sidecar for the dead id and waste I/O before the next tick rotates
    // again. Rotation is low-frequency (once per cron tick); the ~few KB
    // atomic write cost is negligible.
    if let Err(e) = manager.save_to_disk().await {
        // Non-fatal — execution proceeds on the in-memory id. Next successful
        // save will catch up. Log as warn so persistence issues are visible.
        ulog_warn!(
            "[CronTask] rotate_new_session_id: save_to_disk failed for task {}: {} (non-fatal, in-memory id in use)",
            task.id, e
        );
    }

    ulog_info!(
        "[CronTask] new_session rotate: task {} session_id {} → {}",
        task.id,
        old_session_id,
        new_session_id
    );

    Ok(new_session_id)
}

/// Execute a task directly via Sidecar (without going through frontend)
/// Returns (success, ai_exit_reason, output_text, internal_session_id) tuple
pub(super) async fn execute_task_directly(
    handle: &AppHandle,
    task: &CronTask,
    is_first_execution: bool,
) -> Result<(bool, Option<String>, Option<String>, Option<String>), String> {
    ulog_info!(
        "[CronTask] execute_task_directly starting for task {}",
        task.id
    );

    // Hold a system wake-lock for the duration of this cron execution to
    // prevent idle-sleep from killing the SDK's long-lived HTTPS stream to
    // the Anthropic API. Real incident: 2026-05-19 19:11 — Mac went idle
    // during an issue-triage cron, TCP stream died, SDK never detected the
    // dead socket, watchdog killed the turn at 19:26 with empty output.
    // `.ok()` so wake-lock failure never aborts the cron (running without
    // protection ≡ pre-wake-lock behavior).
    let _wake_lock = crate::wake_lock::WakeLock::acquire(&format!(
        "cron task {} ({})",
        task.id,
        task.name.as_deref().unwrap_or("unnamed")
    ))
    .map_err(|e| {
        ulog_warn!(
            "[CronTask] wake-lock acquire failed for {}: {} — continuing without protection",
            task.id,
            e
        );
        e
    })
    .ok();

    // Emit debug event: entering function
    let _ = handle.emit(
        "cron:debug",
        serde_json::json!({
            "taskId": task.id,
            "message": "execute_task_directly: entering function"
        }),
    );

    // Get SidecarManager state
    let sidecar_state = match handle.try_state::<ManagedSidecarManager>() {
        Some(state) => {
            let _ = handle.emit(
                "cron:debug",
                serde_json::json!({
                    "taskId": task.id,
                    "message": "execute_task_directly: got SidecarManager state"
                }),
            );
            state
        }
        None => {
            ulog_error!(
                "[CronTask] SidecarManager state not available for task {}",
                task.id
            );
            let _ = handle.emit(
                "cron:debug",
                serde_json::json!({
                    "taskId": task.id,
                    "message": "execute_task_directly: SidecarManager state NOT available",
                    "error": true
                }),
            );
            return Err("SidecarManager state not available".to_string());
        }
    };

    ulog_info!("[CronTask] Got SidecarManager state for task {}", task.id);

    if task.managed_kind.as_deref() == Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH) {
        return crate::memory_auto_update::run_managed_cron_batch(handle, task).await;
    }

    if matches!(
        task.managed_kind.as_deref(),
        Some(crate::task::MANAGED_KIND_MEMORY_GARDENER)
            | Some(crate::task::MANAGED_KIND_MEMORY_MOLT)
    ) {
        crate::workspace_files::memory_rules::ensure_memory_rule_substrate_for_workspace(
            &task.workspace_path,
        )
        .map_err(|e| format!("ensure memory rule substrate: {}", e))?;
    }

    // Convert run_mode enum to string for payload
    let run_mode_str = match task.run_mode {
        RunMode::SingleSession => "single_session",
        RunMode::NewSession => "new_session",
    };

    // Per-tick session-id rotation for new_session mode.
    //
    // Before this, `task.session_id` was a stable placeholder and Bun would
    // create its OWN session id internally via `switchToSession(createSession(...))`.
    // That split-brain meant the Rust `ManagedSidecar` registry was keyed by
    // the placeholder while Bun was actually running a different session —
    // opening the real session via history could not find the live sidecar
    // and spawned a duplicate read-only one that loaded a stale on-disk
    // snapshot (Bug A, v0.1.69). We now generate the real session id here,
    // use it as BOTH the Rust registry key and the id Bun switches into,
    // so a tab opening the session joins the live sidecar and sees
    // execution in-flight.
    //
    // For single_session mode: `task.session_id` is the stable identity of
    // the ongoing conversation; never rotated.
    let effective_session_id = if task.run_mode == RunMode::NewSession {
        rotate_new_session_id(handle, task).await?
    } else {
        task.session_id.clone()
    };

    // If this cron is bound to a Task Center Task, append the session id to
    // `task.sessionIds[]` so the "任务执行" panel in TaskDetailOverlay can
    // surface every execution (one row per tick for new_session, one stable
    // row for single_session). `append_session` is idempotent (dedup'd on
    // line 1864) so the single_session case safely no-ops after the first
    // tick.
    //
    // Design deliberately does NOT delegate this to the AI agent via CLI
    // (previous PRD text suggested that). Relying on the AI to remember a
    // `myagents task append-session` call at session end is a pit-of-
    // not-success: it only works when the AI explicitly does it, which is
    // unobservable until users report "my task executed but the history
    // is empty." Doing it at the Rust dispatch point guarantees coverage
    // for every execution, regardless of AI cooperation.
    if let Some(ref ta_id) = task.task_id {
        if let Some(ta_store) = crate::task::get_task_store() {
            if let Err(e) = ta_store.append_session(ta_id, &effective_session_id).await {
                // Non-fatal — the execution proceeds; the missing link just
                // means this run won't appear in the task detail 任务执行
                // list. Surface as warn so the gap is auditable.
                ulog_warn!(
                    "[CronTask] append_session(task={}, session={}) failed: {} — 任务执行 UI will miss this run",
                    ta_id, effective_session_id, e
                );
            }
        }
    }

    // Build execution payload
    // execution_number is 1-based (first execution = 1)
    let execution_number = task.execution_count + 1;
    let schedule_kind = task.schedule.as_ref().map(|schedule| {
        match schedule {
            CronSchedule::At { .. } => "at",
            CronSchedule::Every { .. } => "every",
            CronSchedule::Cron { .. } => "cron",
            CronSchedule::Loop => "loop",
        }
        .to_string()
    });

    // PRD §9.3.1: if this CronTask is linked to a Task Center task, construct
    // the prompt dynamically from the latest `~/.myagents/tasks/<id>/task.md`
    // (or alignment state) instead of using the CronTask's frozen `prompt`
    // field. This lets the user edit task.md between firings and the next
    // execution picks up the change.
    //
    // Short-circuit + block guards (CC review C1c + C2):
    //   - linked Task is deleted / archived / in terminal state → skip this
    //     tick AND actually stop the CronTask (status=Stopped + release
    //     sidecar ownership + emit event) so subsequent scheduler iterations
    //     exit via the `status != Running` break on line ~934.
    //     Without this the scheduler would keep firing every tick, each time
    //     hitting this guard, returning Err, recording a failed run, and
    //     trying again next interval — a silent error loop that burns disk
    //     on `~/.myagents/cron_runs/` and spams the unified log. (v0.1.69 H2)
    //   - task.md missing / empty for a direct task → transition the Task to
    //     Blocked with the error as message (rather than sending a meaningless
    //     placeholder prompt to the model)
    let prompt_to_send = if let Some(ref ta_id) = task.task_id {
        if let Some(ta_store) = crate::task::get_task_store() {
            if let Some(ta) = ta_store.get(ta_id).await {
                if ta.deleted
                    || matches!(
                        ta.status,
                        crate::task::TaskStatus::Deleted
                            | crate::task::TaskStatus::Archived
                            | crate::task::TaskStatus::Stopped
                            | crate::task::TaskStatus::Blocked
                            | crate::task::TaskStatus::Done
                    )
                {
                    let reason = format!(
                        "linked Task {} in terminal state '{}'",
                        ta_id,
                        ta.status.as_str()
                    );
                    ulog_warn!(
                        "[CronTask] task {} {} — stopping CronTask to prevent scheduler loop",
                        task.id,
                        reason
                    );
                    // Actually stop — flips status to Stopped + releases
                    // sidecar + emits `cron:task-stopped`. The scheduler's
                    // next iteration reads the new status and breaks.
                    // Failure to stop is logged but non-fatal: even without
                    // the manager update, returning Err still aborts this
                    // tick; worst case we fall back to the old loop
                    // behavior instead of crashing.
                    let stop_result = get_cron_task_manager()
                        .stop_task(&task.id, Some(reason.clone()))
                        .await;
                    if let Err(e) = stop_result {
                        ulog_error!(
                            "[CronTask] failed to stop task {} after terminal-state detection: {}",
                            task.id,
                            e
                        );
                    }
                    // Wrap the reason with the sentinel so the outer
                    // scheduler loop recognises this as a graceful stop
                    // (not a real execution failure) and skips recording
                    // a failure / setting last_error / emitting
                    // execution-error. See `TERMINAL_STOP_SENTINEL` docs.
                    return Err(format!("{}{}", TERMINAL_STOP_SENTINEL, reason));
                }
            }
        }

        match crate::task::build_dispatch_prompt(ta_id).await {
            Some(Ok(p)) => p,
            Some(Err(e)) => {
                ulog_error!(
                    "[CronTask] task {} linked to Task {} but dispatch prompt build failed: {} — blocking Task",
                    task.id, ta_id, e
                );
                // Transition Task to Blocked so the UI surfaces the problem.
                if let Some(ta_store) = crate::task::get_task_store() {
                    let _ = ta_store
                        .update_status(crate::task::TaskUpdateStatusInput {
                            id: ta_id.clone(),
                            status: crate::task::TaskStatus::Blocked,
                            message: Some(format!("dispatch prompt build failed: {}", e)),
                            actor: crate::task::TransitionActor::System,
                            source: Some(crate::task::TransitionSource::Crash),
                        })
                        .await;
                }
                return Err(format!("dispatch prompt build failed: {}", e));
            }
            None => task.prompt.clone(),
        }
    } else {
        task.prompt.clone()
    };

    let payload = CronExecutePayload {
        task_id: task.id.clone(),
        prompt: prompt_to_send,
        managed_kind: task.managed_kind.clone(),
        task_center_task_id: task.task_id.clone(),
        session_id: Some(effective_session_id.clone()),
        is_first_execution: Some(is_first_execution),
        ai_can_exit: Some(task.end_conditions.ai_can_exit),
        permission_mode: Some(task.permission_mode.clone()),
        model: task.model.clone(),
        // PRD 0.2.9: legacy snapshot path — only forwarded for tasks persisted
        // in 0.2.8 or earlier (when `provider_env` was the persistence shape).
        // New crons have `provider_env: None` and `provider_id: Some(_)`; the
        // sidecar prefers `provider_id` and live-resolves on every tick.
        provider_env: task.provider_env.as_ref().map(|env| ProviderEnv {
            base_url: env.base_url.clone(),
            api_key: env.api_key.clone(),
            api_protocol: env.api_protocol.clone(),
            max_output_tokens: env.max_output_tokens,
            max_output_tokens_param_name: env.max_output_tokens_param_name.clone(),
            upstream_format: env.upstream_format.clone(),
        }),
        provider_id: task.provider_id.clone(),
        // PRD #119: forward routing intent so the sidecar handler can
        // either honor the snapshot path (FollowAgent / legacy) or
        // short-circuit to task-owned values (Subscription / Explicit).
        provider_intent: Some(task.provider_intent),
        runtime: task.runtime.clone(),
        runtime_config: task.runtime_config.clone(),
        mcp_enabled_servers: task.mcp_enabled_servers.clone(),
        run_mode: Some(run_mode_str.to_string()),
        interval_minutes: Some(task.interval_minutes),
        execution_number: Some(execution_number),
        schedule_kind,
    };

    let _ = handle.emit("cron:debug", serde_json::json!({
        "taskId": task.id,
        "message": format!("execute_task_directly: calling execute_cron_task, workspace={}", task.workspace_path)
    }));

    ulog_info!(
        "[CronTask] Built payload for task {}, calling execute_cron_task with workspace: {}",
        task.id,
        task.workspace_path
    );

    // Execute via Sidecar
    let result =
        execute_cron_task(handle, &sidecar_state, &task.workspace_path, payload)
            .await
            .map_err(|e| {
                ulog_error!(
                    "[CronTask] execute_cron_task failed for task {}: {}",
                    task.id,
                    e
                );
                let _ = handle.emit("cron:debug", serde_json::json!({
                "taskId": task.id,
                "message": format!("execute_task_directly: execute_cron_task FAILED: {}", e),
                "error": true
            }));
                e
            })?;

    let _ = handle.emit("cron:debug", serde_json::json!({
        "taskId": task.id,
        "message": format!("execute_task_directly: execute_cron_task completed, task_success={}", result.success)
    }));

    ulog_info!(
        "[CronTask] execute_cron_task completed for task {}, task_success={}",
        task.id,
        result.success
    );

    // PRD 0.2.9 — Provider-resolution failure should permanently Block the
    // linked Task, not just record `last_run_ok=false`. The sidecar surfaces
    // these via `success:false` + an error string starting with
    // "Provider 'X'" (set in src/server/index.ts::resolveCronProviderRouting):
    //   - "Provider 'X' not found in config" — provider deleted
    //   - "Provider 'X' has no API Key" — credential removed
    // Both are deterministic per-tick failures: re-running on the next tick
    // will fail the same way until the user re-picks a provider. Mark the
    // Task as Blocked so the UI surfaces the actionable error and the
    // scheduler stops retrying. Mirrors the build_dispatch_prompt failure
    // path above.
    if !result.success {
        let err_msg = result.error.clone().unwrap_or_default();
        let is_provider_resolution_failure = err_msg.starts_with("Provider '")
            && (err_msg.contains("not found in config") || err_msg.contains("has no API Key"));
        if is_provider_resolution_failure {
            if let Some(ta_id) = task.task_id.as_ref() {
                ulog_error!(
                    "[CronTask] task {} provider resolution failed: {} — blocking linked Task {}",
                    task.id,
                    err_msg,
                    ta_id
                );
                if let Some(ta_store) = crate::task::get_task_store() {
                    let _ = ta_store
                        .update_status(crate::task::TaskUpdateStatusInput {
                            id: ta_id.clone(),
                            status: crate::task::TaskStatus::Blocked,
                            message: Some(err_msg.clone()),
                            actor: crate::task::TransitionActor::System,
                            source: Some(crate::task::TransitionSource::Crash),
                        })
                        .await;
                }
            }
            // Stop the underlying CronTask too so the scheduler doesn't keep
            // retrying every interval. The user's UI action (re-pick provider
            // → save) will rebuild and restart it via ensure_cron_for_task.
            let _ = get_cron_task_manager()
                .stop_task(&task.id, Some(format!("provider unavailable: {}", err_msg)))
                .await;
        }
    }

    // Send notification if enabled
    if task.notify_enabled {
        send_task_notification(handle, task, &result, &effective_session_id);
    }

    let ai_exit_reason = if result.ai_requested_exit == Some(true) {
        result.exit_reason
    } else {
        None
    };

    Ok((
        result.success,
        ai_exit_reason,
        result.output_text,
        result.session_id,
    ))
}

/// Stop a task, unregister CronTask user, and deactivate its session (internal helper)
/// Used by scheduler when end conditions are met or AI requests exit
/// With Session-centric Sidecar (Owner model), this releases CronTask's ownership.
pub(super) async fn stop_task_internal(
    handle: &AppHandle,
    tasks: &Arc<RwLock<HashMap<String, CronTask>>>,
    task_id: &str,
    exit_reason: Option<String>,
) {
    // Get session ID before updating status
    let session_id = {
        let tasks_guard = tasks.read().await;
        tasks_guard.get(task_id).map(|t| t.session_id.clone())
    };

    let Some(session_id) = session_id else {
        ulog_warn!(
            "[CronTask] Task {} not found in stop_task_internal",
            task_id
        );
        return;
    };

    // Release CronTask's ownership of the Session Sidecar
    if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
        let owner = SidecarOwner::CronTask(task_id.to_string());
        match release_session_sidecar(&sidecar_state, &session_id, &owner) {
            Ok(stopped) => {
                if stopped {
                    ulog_info!(
                        "[CronTask] Released CronTask {} from session {}, Sidecar stopped",
                        task_id,
                        session_id
                    );
                } else {
                    ulog_info!(
                        "[CronTask] Released CronTask {} from session {}, Sidecar continues",
                        task_id,
                        session_id
                    );
                }
            }
            Err(e) => {
                ulog_error!(
                    "[CronTask] Failed to release CronTask {} from session {}: {}",
                    task_id,
                    session_id,
                    e
                );
            }
        }

        // Deactivate session (for legacy session tracking)
        if let Ok(mut manager) = sidecar_state.lock() {
            manager.deactivate_session(&session_id);
            ulog_info!(
                "[CronTask] Deactivated session {} for stopped task {}",
                session_id,
                task_id
            );
        }
    }

    // Update task status
    {
        let mut tasks_guard = tasks.write().await;
        if let Some(task) = tasks_guard.get_mut(task_id) {
            task.status = TaskStatus::Stopped;
            task.exit_reason = exit_reason.clone();
        }
    }

    // Save to disk atomically (prevents data corruption on crash)
    if let Some(parent) = dirs::home_dir() {
        let storage_path = parent.join(".myagents").join("cron_tasks.json");
        if let Err(e) = atomic_save_tasks(&storage_path, &tasks).await {
            ulog_error!("[CronTask] Failed to save tasks on stop: {}", e);
        }
    }

    // Emit stopped event
    let _ = handle.emit(
        "cron:task-stopped",
        serde_json::json!({
            "taskId": task_id,
            "exitReason": exit_reason.clone()
        }),
    );

    // PRD §11 — propagate completion to Task Center if this CronTask is linked
    // to a Task (best-effort, failures logged).
    crate::task::mark_cron_completion_if_linked(task_id, exit_reason.as_deref()).await;

    ulog_info!("[CronTask] Task {} stopped", task_id);
}

/// Send system notification for task execution
fn send_task_notification(
    handle: &AppHandle,
    task: &CronTask,
    result: &crate::sidecar::CronExecuteResponse,
    effective_session_id: &str,
) {
    let title = if result.success {
        "定时任务执行完成".to_string()
    } else {
        "定时任务执行失败".to_string()
    };

    let body = if let Some(ref reason) = result.exit_reason {
        format!("AI 主动结束: {}", reason)
    } else if let Some(ref error) = result.error {
        format!("错误: {}", error)
    } else {
        format!("任务 #{} 已完成", task.execution_count + 1)
    };

    let session_id = result
        .session_id
        .clone()
        .unwrap_or_else(|| effective_session_id.to_string());
    let navigation = crate::notification::NotificationNavigation::for_session(
        task.tab_id.clone(),
        session_id.clone(),
        task.workspace_path.clone(),
    );
    let badge_increment = crate::notification_badge::NotificationBadgeIncrement {
        id: format!(
            "cron:{}:{}:{}",
            task.id,
            task.execution_count + 1,
            session_id
        ),
        source: "cron".to_string(),
        created_at: chrono::Utc::now().timestamp_millis(),
        target: crate::notification_badge::NotificationBadgeTarget::Session {
            session_id,
            workspace_path: task.workspace_path.clone(),
        },
    };

    // Send the OS notification through the unified notification module so the
    // click handler is wired structurally (Windows toast Activated, macOS /
    // Linux fallback). Cron completion must deep-link by session, not only by
    // tab: scheduled/background tasks frequently have no live Tab, and
    // new_session mode rotates a fresh session id per execution.
    crate::notification::show_with_navigation_target_and_badge(
        handle,
        &title,
        &body,
        navigation,
        Some(badge_increment),
    );
}
