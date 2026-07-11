use std::time::Instant;

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::cron_task::CronDelivery;
use crate::sidecar::{
    execute_cron_task, release_session_sidecar, CronExecutePayload, ManagedSidecarManager,
    SidecarOwner,
};
use crate::task::{Task, TaskExecutionMode, TaskRunMode, TaskStatus};
use crate::{ulog_error, ulog_warn};

#[derive(Debug)]
pub struct TaskExecutionOutcome {
    pub success: bool,
    pub error: Option<String>,
    pub ai_exit_reason: Option<String>,
    pub output_text: Option<String>,
    pub session_id: Option<String>,
    pub duration_ms: u64,
}

fn run_mode(task: &Task) -> TaskRunMode {
    task.run_mode.unwrap_or(TaskRunMode::NewSession)
}

fn execution_session(task: &Task, session_exists: impl Fn(&str) -> bool) -> (String, bool) {
    if run_mode(task) == TaskRunMode::SingleSession {
        if let Some(session_id) = task
            .preselected_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return (session_id.to_string(), !session_exists(session_id));
        }
        if let Some(session_id) = task.session_ids.first() {
            return (session_id.clone(), !session_exists(session_id));
        }
    }
    (Uuid::new_v4().to_string(), true)
}

fn schedule_kind(task: &Task) -> Option<String> {
    match task.execution_mode {
        TaskExecutionMode::Once | TaskExecutionMode::Scheduled => Some("at".to_string()),
        TaskExecutionMode::Recurring if task.cron_expression.is_some() => Some("cron".to_string()),
        TaskExecutionMode::Recurring => Some("every".to_string()),
        TaskExecutionMode::Loop => None,
    }
}

fn retain_owner_between_runs(task: &Task) -> bool {
    run_mode(task) == TaskRunMode::SingleSession && task.status == TaskStatus::Running
}

fn release_task_owner(sidecar: &ManagedSidecarManager, task_id: &str, session_id: &str) {
    if let Err(error) = release_session_sidecar(
        sidecar,
        session_id,
        &SidecarOwner::Task(task_id.to_string()),
    ) {
        ulog_warn!(
            "[task] failed to release Task owner task={} session={}: {}",
            task_id,
            session_id,
            error
        );
    }
}

pub async fn execute_task(
    handle: &AppHandle,
    task: &Task,
    queue_id: &str,
) -> Result<TaskExecutionOutcome, String> {
    let started = Instant::now();

    if task.managed_kind.as_deref() == Some(crate::task::MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH) {
        let (success, ai_exit_reason, output_text, session_id) =
            crate::memory_auto_update::run_managed_task_batch(handle, task).await?;
        return Ok(TaskExecutionOutcome {
            success,
            error: None,
            ai_exit_reason,
            output_text,
            session_id,
            duration_ms: started.elapsed().as_millis() as u64,
        });
    }

    if matches!(
        task.managed_kind.as_deref(),
        Some(crate::task::MANAGED_KIND_MEMORY_GARDENER)
            | Some(crate::task::MANAGED_KIND_MEMORY_MOLT)
    ) {
        crate::workspace_files::memory_rules::ensure_memory_rule_substrate_for_workspace(
            &task.workspace_path,
        )
        .map_err(|error| format!("ensure memory rule substrate: {error}"))?;
    }

    let sidecar = handle
        .try_state::<ManagedSidecarManager>()
        .ok_or_else(|| "SidecarManager state not available".to_string())?;
    let prompt = crate::task::build_dispatch_prompt(&task.id)
        .await
        .ok_or_else(|| format!("task {} disappeared before dispatch", task.id))??;
    let (session_id, initialize_session) = execution_session(task, |session_id| {
        crate::sidecar::runtime_identity::resolve_session_runtime_identity_full(session_id)
            .is_some()
            || sidecar
                .lock()
                .ok()
                .is_some_and(|mut manager| manager.has_session_sidecar(session_id))
    });

    if !crate::task_scheduler::get_task_scheduler()
        .bind_execution_session(&task.id, queue_id, &session_id)
        .await
    {
        return Err("Task execution was canceled before Session dispatch".to_string());
    }

    crate::task::get_task_store()
        .ok_or_else(|| "task store not initialized".to_string())?
        .append_session(&task.id, &session_id)
        .await?;

    let effective_run_mode = run_mode(task);
    let payload = CronExecutePayload {
        task_id: task.id.clone(),
        queue_id: queue_id.to_string(),
        prompt,
        managed_kind: task.managed_kind.clone(),
        initialize_session,
        session_id: Some(session_id.clone()),
        ai_can_exit: Some(
            task.end_conditions
                .as_ref()
                .is_some_and(|conditions| conditions.ai_can_exit),
        ),
        permission_mode: Some(task.permission_mode.clone().unwrap_or_default()),
        model: initialize_session.then(|| task.model.clone()).flatten(),
        provider_id: initialize_session
            .then(|| task.provider_id.clone())
            .flatten(),
        runtime: initialize_session.then(|| task.runtime.clone()).flatten(),
        runtime_config: initialize_session
            .then(|| task.runtime_config.clone())
            .flatten(),
        mcp_enabled_servers: initialize_session
            .then(|| task.mcp_enabled_servers.clone())
            .flatten(),
        run_mode: Some(match effective_run_mode {
            TaskRunMode::SingleSession => "single_session".to_string(),
            TaskRunMode::NewSession => "new_session".to_string(),
        }),
        interval_minutes: task.interval_minutes,
        execution_number: Some(task.execution_count.saturating_add(1)),
        schedule_kind: schedule_kind(task),
    };

    let result = execute_cron_task(handle, &sidecar, &task.workspace_path, payload).await;
    let execution_is_current = crate::task_scheduler::get_task_scheduler()
        .authorize_dispatch(&task.id, queue_id)
        .await;
    let retain_owner = execution_is_current
        && match crate::task::get_task_store() {
            Some(store) => store
                .get(&task.id)
                .await
                .is_some_and(|current| retain_owner_between_runs(&current)),
            None => false,
        };
    if !retain_owner {
        release_task_owner(&sidecar, &task.id, &session_id);
    }

    let response = result.map_err(|error| {
        ulog_error!(
            "[task] execution transport failed task={}: {}",
            task.id,
            error
        );
        error
    })?;
    Ok(TaskExecutionOutcome {
        success: response.success,
        error: response.error,
        ai_exit_reason: response
            .ai_requested_exit
            .unwrap_or(false)
            .then_some(response.exit_reason)
            .flatten(),
        output_text: response.output_text,
        session_id: response.session_id.or(Some(session_id)),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

pub async fn deliver_task_result(handle: &AppHandle, task: &Task, outcome: &TaskExecutionOutcome) {
    let content = outcome.output_text.clone().unwrap_or_else(|| {
        if outcome.success {
            format!("Task '{}' completed successfully.", task.name)
        } else {
            format!(
                "Task '{}' failed: {}",
                task.name,
                outcome.error.as_deref().unwrap_or("unknown error")
            )
        }
    });

    if let Some(notification) = task.notification.as_ref() {
        if let Some(bot_id) = notification
            .bot_channel_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            let delivery = CronDelivery {
                bot_id: bot_id.to_string(),
                chat_id: notification
                    .bot_thread
                    .clone()
                    .unwrap_or_else(|| "_auto_".to_string()),
                platform: "task-center".to_string(),
            };
            crate::cron_task::deliver_cron_result_to_bot(
                handle,
                &delivery,
                &task.id,
                &content,
                outcome.session_id.as_deref(),
            )
            .await;
        }
    }

    if task
        .notification
        .as_ref()
        .map(|notification| notification.desktop)
        .unwrap_or(true)
    {
        let title = if outcome.success {
            "定时任务执行完成"
        } else {
            "定时任务执行失败"
        };
        let session_id = outcome.session_id.clone().unwrap_or_default();
        let navigation = crate::notification::NotificationNavigation::for_session(
            None,
            session_id.clone(),
            task.workspace_path.clone(),
        );
        let badge = crate::notification_badge::NotificationBadgeIncrement {
            id: format!(
                "task:{}:{}",
                task.id,
                task.execution_count.saturating_add(1)
            ),
            source: "task".to_string(),
            created_at: chrono::Utc::now().timestamp_millis(),
            target: crate::notification_badge::NotificationBadgeTarget::Session {
                session_id,
                workspace_path: task.workspace_path.clone(),
            },
        };
        crate::notification::show_with_navigation_target_and_badge(
            handle,
            title,
            &content,
            navigation,
            Some(badge),
        );
    }
}

pub fn release_task_sessions(handle: &AppHandle, task: &Task, active_session_id: Option<&str>) {
    let Some(sidecar) = handle.try_state::<ManagedSidecarManager>() else {
        return;
    };
    let retained_session = (run_mode(task) == TaskRunMode::SingleSession)
        .then(|| {
            task.preselected_session_id
                .as_deref()
                .or_else(|| task.session_ids.first().map(String::as_str))
        })
        .flatten();
    let mut sessions = Vec::new();
    for session_id in [active_session_id, retained_session].into_iter().flatten() {
        if sessions.iter().all(|existing| *existing != session_id) {
            sessions.push(session_id);
        }
    }
    for session_id in sessions {
        release_task_owner(&sidecar, &task.id, session_id);
    }
}

pub async fn stop_task_turn(
    handle: &AppHandle,
    task: &Task,
    active_session_id: Option<&str>,
) -> Result<(), String> {
    let Some(session_id) = active_session_id else {
        return Ok(());
    };
    let Some(sidecar) = handle.try_state::<ManagedSidecarManager>() else {
        return Err("SidecarManager state not available".to_string());
    };
    let client = crate::local_http::builder()
        .timeout(std::time::Duration::from_secs(65))
        .build()
        .map_err(|error| format!("build Task stop client: {error}"))?;
    let port = sidecar
        .lock()
        .map_err(|error| format!("Sidecar lock poisoned: {error}"))?
        .get_session_port(session_id);
    let Some(port) = port else {
        return Ok(());
    };
    let response = client
        .post(format!("http://127.0.0.1:{port}/task/stop"))
        .json(&serde_json::json!({ "taskId": task.id }))
        .send()
        .await
        .map_err(|error| format!("request /task/stop: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("read /task/stop response: {error}"))?;
    validate_task_stop_confirmation(status, &body)
}

fn validate_task_stop_confirmation(status: reqwest::StatusCode, body: &str) -> Result<(), String> {
    let payload: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| format!("parse /task/stop response: {error}"))?;
    if status.is_success()
        && payload.get("success").and_then(serde_json::Value::as_bool) == Some(true)
    {
        return Ok(());
    }
    Err(payload
        .get("error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("SessionEngine did not confirm the Task-scoped stop")
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn single_session_task(session_id: &str) -> Task {
        serde_json::from_value(serde_json::json!({
            "id": "task-1",
            "name": "test",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "single-session",
            "preselectedSessionId": session_id,
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap()
    }

    #[test]
    fn existing_single_session_inherits_its_runtime_configuration() {
        let (session_id, initialize) =
            execution_session(&single_session_task("session-1"), |_| true);
        assert_eq!(session_id, "session-1");
        assert!(!initialize);
    }

    #[test]
    fn dedicated_single_session_is_initialized_on_first_execution() {
        let (session_id, initialize) =
            execution_session(&single_session_task("session-1"), |_| false);
        assert_eq!(session_id, "session-1");
        assert!(initialize);
    }

    #[test]
    fn stopped_single_session_run_does_not_retain_task_owner() {
        let mut task = single_session_task("session-1");
        task.status = TaskStatus::Stopped;
        assert!(!retain_owner_between_runs(&task));

        task.status = TaskStatus::Running;
        assert!(retain_owner_between_runs(&task));
    }

    #[test]
    fn task_stop_requires_session_engine_confirmation() {
        assert!(validate_task_stop_confirmation(
            reqwest::StatusCode::OK,
            r#"{"success":true,"alreadyStopped":true}"#,
        )
        .is_ok());
        assert_eq!(
            validate_task_stop_confirmation(
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"success":false,"error":"runtime refused to stop"}"#,
            )
            .unwrap_err(),
            "runtime refused to stop"
        );
    }
}
