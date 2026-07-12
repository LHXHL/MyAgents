use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, TimeZone, Utc};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use crate::cron_task::CronRunRecord;
use crate::task::{
    Task, TaskExecutionMode, TaskExecutionTrigger, TaskListFilter, TaskStatus,
    TaskUpdateStatusInput, TransitionActor, TransitionSource,
};
use crate::{ulog_error, ulog_info, ulog_warn};

pub struct TaskSchedulerController {
    handles: Arc<RwLock<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    executions: ActiveExecutions,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
}

#[derive(Debug)]
struct ActiveTaskExecution {
    queue_id: String,
    canceled: bool,
    session_id: Option<String>,
}

type ActiveExecutions = Arc<RwLock<HashMap<String, ActiveTaskExecution>>>;

impl TaskSchedulerController {
    fn new() -> Self {
        Self {
            handles: Arc::new(RwLock::new(HashMap::new())),
            executions: Arc::new(RwLock::new(HashMap::new())),
            app_handle: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn initialize(&self, handle: AppHandle) {
        *self.app_handle.write().await = Some(handle.clone());
        let Some(store) = crate::task::get_task_store() else {
            ulog_error!("[task-scheduler] TaskStore is not initialized");
            return;
        };
        let running = store
            .list(TaskListFilter {
                status: Some(crate::task::StatusFilter::One(TaskStatus::Running)),
                include_managed: Some(true),
                ..Default::default()
            })
            .await;

        for task in running {
            if task.execution_mode == TaskExecutionMode::Loop {
                let _ = store
                    .update_status(TaskUpdateStatusInput {
                        id: task.id,
                        status: TaskStatus::Stopped,
                        message: Some("Legacy Loop tasks are retired".to_string()),
                        actor: TransitionActor::System,
                        source: Some(TransitionSource::Migration),
                    })
                    .await;
                continue;
            }
            if let Err(error) = self.start(&task.id).await {
                ulog_error!(
                    "[task-scheduler] failed to restore task {}: {}",
                    task.id,
                    error
                );
                block_task(&task, format!("Task scheduler recovery failed: {error}")).await;
            }
        }
        let _ = handle.emit("task:scheduler-ready", serde_json::json!({}));
    }

    pub async fn start(&self, task_id: &str) -> Result<(), String> {
        let store = crate::task::get_task_store()
            .ok_or_else(|| "task store not initialized".to_string())?;
        let task = store
            .get(task_id)
            .await
            .ok_or_else(|| format!("task not found: {task_id}"))?;
        if task.deleted || task.status != TaskStatus::Running {
            return Err(format!("task {task_id} is not running"));
        }
        validate_task_schedule(&task)?;

        let mut handles = self.handles.write().await;
        if let Some(existing) = handles.get(task_id) {
            if !existing.inner().is_finished() {
                return Ok(());
            }
            handles.remove(task_id);
        }

        let task_id_owned = task_id.to_string();
        let executions = Arc::clone(&self.executions);
        let app_handle = Arc::clone(&self.app_handle);
        let handle = tauri::async_runtime::spawn(async move {
            run_scheduler_loop(task_id_owned.clone(), executions, app_handle).await;
            ulog_info!("[task-scheduler] loop exited task={}", task_id_owned);
        });
        handles.insert(task_id.to_string(), handle);
        drop(handles);
        emit_cron_ui_event(
            &self.app_handle,
            "cron:scheduler-started",
            serde_json::json!({
                "taskId": task.id,
                "intervalMinutes": task.interval_minutes.unwrap_or(0),
                "executionCount": task.execution_count,
            }),
        )
        .await;
        ulog_info!("[task-scheduler] armed task={}", task_id);
        Ok(())
    }

    pub async fn stop(&self, task_id: &str) {
        self.cancel_execution(task_id).await;
        let active_session = self.execution_session(task_id).await;
        let scheduler_handle = self.handles.write().await.remove(task_id);
        let task = match crate::task::get_task_store() {
            Some(store) => store.get(task_id).await,
            None => None,
        };
        let app_handle = self.app_handle.read().await.clone();
        if let (Some(handle), Some(task)) = (app_handle.as_ref(), task) {
            match crate::task_execution::stop_task_turn(handle, &task, active_session.as_deref())
                .await
            {
                Ok(()) => crate::task_execution::release_task_sessions(
                    handle,
                    &task,
                    active_session.as_deref(),
                ),
                Err(error) => ulog_error!(
                    "[task-scheduler] task={} runtime stop was not confirmed: {}",
                    task_id,
                    error
                ),
            }
        }
        // The handle owns only the timer loop. A claimed execution runs in its
        // own task and unwinds through the normal outcome path after stopTurn.
        if let Some(handle) = scheduler_handle {
            handle.abort();
        }
        if let Some(handle) = app_handle {
            let _ = handle.emit(
                "cron:task-stopped",
                serde_json::json!({ "taskId": task_id }),
            );
        }
    }

    pub async fn trigger_now(&self, task_id: &str) -> Result<String, String> {
        let store = crate::task::get_task_store()
            .ok_or_else(|| "task store not initialized".to_string())?;
        let task = store
            .get(task_id)
            .await
            .ok_or_else(|| format!("task not found: {task_id}"))?;
        if task.deleted {
            return Err(format!("task {task_id} is deleted"));
        }
        if !matches!(task.status, TaskStatus::Running | TaskStatus::Stopped) {
            return Err(format!(
                "task {task_id} is {}; run-now only supports running or stopped tasks",
                task.status.as_str()
            ));
        }
        if self.app_handle.read().await.is_none() {
            return Err("task scheduler app handle is unavailable".to_string());
        }
        let queue_id = claim_execution(&self.executions, task_id).await?;
        let session_id = match reserve_claimed_execution_session(
            &self.executions,
            store,
            &task,
            &queue_id,
        )
        .await
        {
            Ok(Some(session_id)) => session_id,
            Ok(None) => {
                release_execution(&self.executions, task_id, &queue_id).await;
                return Err(format!("task {task_id} does not execute in a Session"));
            }
            Err(error) => {
                release_execution(&self.executions, task_id, &queue_id).await;
                return Err(error);
            }
        };

        let executions = Arc::clone(&self.executions);
        let app_handle = Arc::clone(&self.app_handle);
        let task_id = task.id;
        let reserved_session_id = session_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = run_one_claimed(
                &task_id,
                &queue_id,
                &executions,
                &app_handle,
                TaskExecutionTrigger::Manual,
                Some(reserved_session_id),
            )
            .await
            {
                ulog_error!(
                    "[task-scheduler] immediate run failed task={}: {}",
                    task_id,
                    error
                );
            }
            release_execution(&executions, &task_id, &queue_id).await;
        });
        Ok(session_id)
    }

    pub async fn is_executing(&self, task_id: &str) -> bool {
        self.executions.read().await.contains_key(task_id)
    }

    pub async fn executing_snapshot(&self) -> HashSet<String> {
        self.executions.read().await.keys().cloned().collect()
    }

    pub async fn authorize_dispatch(&self, task_id: &str, queue_id: &str) -> bool {
        execution_is_authorized(&self.executions, task_id, queue_id).await
    }

    async fn execution_session(&self, task_id: &str) -> Option<String> {
        self.executions
            .read()
            .await
            .get(task_id)
            .and_then(|execution| execution.session_id.clone())
    }

    async fn cancel_execution(&self, task_id: &str) {
        if let Some(execution) = self.executions.write().await.get_mut(task_id) {
            execution.canceled = true;
        }
    }
}

async fn claim_execution(executions: &ActiveExecutions, task_id: &str) -> Result<String, String> {
    let mut active = executions.write().await;
    if active.contains_key(task_id) {
        return Err(format!("task {task_id} is already executing"));
    }
    let queue_id = uuid::Uuid::new_v4().to_string();
    active.insert(
        task_id.to_string(),
        ActiveTaskExecution {
            queue_id: queue_id.clone(),
            canceled: false,
            session_id: None,
        },
    );
    Ok(queue_id)
}

async fn execution_is_authorized(
    executions: &ActiveExecutions,
    task_id: &str,
    queue_id: &str,
) -> bool {
    executions
        .read()
        .await
        .get(task_id)
        .is_some_and(|active| active.queue_id == queue_id && !active.canceled)
}

async fn reserve_claimed_execution_session(
    executions: &ActiveExecutions,
    store: &crate::task::TaskStore,
    task: &Task,
    queue_id: &str,
) -> Result<Option<String>, String> {
    if !crate::task_execution::uses_session_engine(task) {
        return Ok(None);
    }
    let session_id = crate::task_execution::select_execution_session(task);
    {
        let mut active = executions.write().await;
        let Some(execution) = active.get_mut(&task.id) else {
            return Err("Task execution was canceled before Session dispatch".to_string());
        };
        if execution.queue_id != queue_id || execution.canceled {
            return Err("Task execution was canceled before Session dispatch".to_string());
        }
        execution.session_id = Some(session_id.clone());
    }
    store.append_session(&task.id, &session_id).await?;
    Ok(Some(session_id))
}

async fn release_execution(executions: &ActiveExecutions, task_id: &str, queue_id: &str) {
    let mut active = executions.write().await;
    if active
        .get(task_id)
        .is_some_and(|execution| execution.queue_id == queue_id)
    {
        active.remove(task_id);
    }
}

async fn run_scheduler_loop(
    task_id: String,
    executions: ActiveExecutions,
    app_handle: Arc<RwLock<Option<AppHandle>>>,
) {
    loop {
        let Some(store) = crate::task::get_task_store() else {
            return;
        };
        let Some(task) = store.get(&task_id).await else {
            return;
        };
        if task.deleted || task.status != TaskStatus::Running {
            return;
        }
        if end_condition_reached(&task) {
            finish_task(
                &task,
                "Task end condition reached",
                TransitionSource::EndCondition,
            )
            .await;
            return;
        }
        let target = match next_execution_at(&task) {
            Ok(Some(target)) => target,
            Ok(None) => return,
            Err(error) => {
                block_task(&task, error).await;
                return;
            }
        };
        sleep_until_wallclock(target).await;

        let result = run_one(&task_id, &executions, &app_handle).await;
        match result {
            Ok(RunDisposition::Continue) => {}
            Ok(RunDisposition::Stop) => return,
            Err(error) => {
                ulog_error!("[task-scheduler] task={} run failed: {}", task_id, error);
                return;
            }
        }
    }
}

enum RunDisposition {
    Continue,
    Stop,
}

async fn run_one(
    task_id: &str,
    executions: &ActiveExecutions,
    app_handle: &Arc<RwLock<Option<AppHandle>>>,
) -> Result<RunDisposition, String> {
    let Some(store) = crate::task::get_task_store() else {
        return Err("task store not initialized".to_string());
    };
    let Some(task) = store.get(task_id).await else {
        return Ok(RunDisposition::Stop);
    };
    if task.deleted || task.status != TaskStatus::Running {
        return Ok(RunDisposition::Stop);
    }

    let queue_id = match claim_execution(executions, task_id).await {
        Ok(queue_id) => queue_id,
        Err(_) => {
            ulog_warn!("[task-scheduler] overlap skipped task={}", task_id);
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            return Ok(RunDisposition::Continue);
        }
    };

    let task_id_owned = task_id.to_string();
    let queue_id_owned = queue_id.clone();
    let executions = Arc::clone(executions);
    let app_handle = Arc::clone(app_handle);
    let worker = tauri::async_runtime::spawn(async move {
        let result = run_one_claimed(
            &task_id_owned,
            &queue_id_owned,
            &executions,
            &app_handle,
            TaskExecutionTrigger::Scheduled,
            None,
        )
        .await;
        release_execution(&executions, &task_id_owned, &queue_id_owned).await;
        result
    });
    worker
        .await
        .map_err(|error| format!("task execution worker failed: {error}"))?
}

async fn run_one_claimed(
    task_id: &str,
    queue_id: &str,
    executions: &ActiveExecutions,
    app_handle: &RwLock<Option<AppHandle>>,
    trigger: TaskExecutionTrigger,
    reserved_session_id: Option<String>,
) -> Result<RunDisposition, String> {
    if !execution_is_authorized(executions, task_id, queue_id).await {
        return Ok(RunDisposition::Stop);
    }
    let Some(store) = crate::task::get_task_store() else {
        return Err("task store not initialized".to_string());
    };
    let Some(task) = store.get(task_id).await else {
        return Ok(RunDisposition::Stop);
    };
    if task.deleted
        || (trigger == TaskExecutionTrigger::Scheduled && task.status != TaskStatus::Running)
    {
        return Ok(RunDisposition::Stop);
    }
    let started = Instant::now();
    let handle = app_handle
        .read()
        .await
        .clone()
        .ok_or_else(|| "task scheduler app handle is unavailable".to_string());
    emit_cron_ui_event(
        app_handle,
        "cron:execution-starting",
        serde_json::json!({
            "taskId": task_id,
            "executionNumber": task.execution_count.saturating_add(1),
            "trigger": if trigger == TaskExecutionTrigger::Manual { "manual" } else { "scheduled" },
        }),
    )
    .await;
    let execution = match handle.as_ref() {
        Ok(handle) => {
            let session_id = match reserved_session_id {
                Some(session_id) => Some(session_id),
                None => {
                    reserve_claimed_execution_session(executions, store, &task, queue_id).await?
                }
            };
            crate::task_execution::execute_task(handle, &task, queue_id, session_id).await
        }
        Err(error) => Err(error.clone()),
    };

    let (record, outcome) = match execution {
        Ok(outcome) => (
            CronRunRecord {
                ts: Utc::now().timestamp_millis(),
                ok: outcome.success,
                duration_ms: outcome.duration_ms,
                content: outcome.output_text.clone(),
                error: outcome.error.clone(),
            },
            Some(outcome),
        ),
        Err(error) => (
            CronRunRecord {
                ts: Utc::now().timestamp_millis(),
                ok: false,
                duration_ms: started.elapsed().as_millis() as u64,
                content: None,
                error: Some(error.clone()),
            },
            None,
        ),
    };

    // Cancellation and outcome commit share the same execution slot. The
    // TaskStore compare-and-commit then linearizes an explicit status change
    // against this exact run, so a stopped worker cannot mutate a restarted
    // schedule or report its control cancellation as a runtime failure.
    let active = executions.read().await;
    let authorized = active
        .get(task_id)
        .is_some_and(|execution| execution.queue_id == queue_id && !execution.canceled);
    if !authorized {
        return Ok(RunDisposition::Stop);
    }
    let updated = match store
        .record_execution_if_status(task_id, trigger, task.status)
        .await
    {
        Ok(Some(updated)) => updated,
        Ok(None) => return Ok(RunDisposition::Stop),
        Err(error) => {
            drop(active);
            if trigger == TaskExecutionTrigger::Scheduled {
                block_task(
                    &task,
                    format!("Task execution commit failed; scheduler stopped: {error}"),
                )
                .await;
            }
            return Err(format!("task execution commit failed: {error}"));
        }
    };
    drop(active);
    if let Err(error) = crate::cron_task::record_cron_run(task_id, &record).await {
        ulog_warn!(
            "[task-scheduler] run history write failed task={}: {}",
            task_id,
            error
        );
    }

    emit_cron_ui_event(
        app_handle,
        "cron:execution-complete",
        serde_json::json!({
            "taskId": task_id,
            "success": record.ok,
            "executionCount": updated.execution_count,
        }),
    )
    .await;
    if let Some(error) = record.error.as_deref() {
        emit_cron_ui_event(
            app_handle,
            "cron:execution-error",
            serde_json::json!({ "taskId": task_id, "error": error }),
        )
        .await;
    }

    if let (Ok(handle), Some(outcome)) = (handle.as_ref(), outcome.as_ref()) {
        crate::task_execution::deliver_task_result(handle, &task, outcome).await;
    }

    // A user may stop/delete the Task while the runtime turn is unwinding.
    // The committed status is authoritative; never let the late outcome
    // transition that terminal Task again.
    if updated.status != TaskStatus::Running {
        return Ok(RunDisposition::Stop);
    }

    if trigger == TaskExecutionTrigger::Manual {
        if let Some(reason) = outcome
            .as_ref()
            .and_then(|value| value.ai_exit_reason.as_deref())
        {
            finish_task(&updated, reason, TransitionSource::EndCondition).await;
            return Ok(RunDisposition::Stop);
        }
        if end_condition_reached(&updated) {
            finish_task(
                &updated,
                "Task end condition reached",
                TransitionSource::EndCondition,
            )
            .await;
            return Ok(RunDisposition::Stop);
        }
        return Ok(RunDisposition::Continue);
    }

    let provider_failure = record.error.as_deref().is_some_and(|error| {
        error.starts_with("Provider '")
            && (error.contains("not found in config") || error.contains("has no API Key"))
    });
    if provider_failure || outcome.is_none() {
        block_task(
            &updated,
            record
                .error
                .clone()
                .unwrap_or_else(|| "Task execution failed".to_string()),
        )
        .await;
        return Ok(RunDisposition::Stop);
    }

    let outcome = outcome.expect("checked above");
    if !outcome.success
        && matches!(
            updated.execution_mode,
            TaskExecutionMode::Once | TaskExecutionMode::Scheduled
        )
    {
        block_task(
            &updated,
            outcome
                .error
                .clone()
                .unwrap_or_else(|| "Task execution failed".to_string()),
        )
        .await;
        return Ok(RunDisposition::Stop);
    }

    if let Some(reason) = outcome.ai_exit_reason {
        finish_task(&updated, &reason, TransitionSource::EndCondition).await;
        return Ok(RunDisposition::Stop);
    }
    if matches!(
        updated.execution_mode,
        TaskExecutionMode::Once | TaskExecutionMode::Scheduled
    ) || end_condition_reached(&updated)
    {
        finish_task(
            &updated,
            "Task execution completed",
            TransitionSource::EndCondition,
        )
        .await;
        return Ok(RunDisposition::Stop);
    }

    Ok(RunDisposition::Continue)
}

async fn emit_cron_ui_event(
    app_handle: &RwLock<Option<AppHandle>>,
    event: &str,
    payload: serde_json::Value,
) {
    if let Some(handle) = app_handle.read().await.as_ref() {
        let _ = handle.emit(event, payload);
    }
}

async fn finish_task(task: &Task, message: &str, source: TransitionSource) {
    let Some(store) = crate::task::get_task_store() else {
        return;
    };
    let _ = store
        .update_status(TaskUpdateStatusInput {
            id: task.id.clone(),
            status: TaskStatus::Done,
            message: Some(message.to_string()),
            actor: TransitionActor::System,
            source: Some(source),
        })
        .await;
}

async fn block_task(task: &Task, message: String) {
    let Some(store) = crate::task::get_task_store() else {
        return;
    };
    let _ = store
        .update_status(TaskUpdateStatusInput {
            id: task.id.clone(),
            status: TaskStatus::Blocked,
            message: Some(message),
            actor: TransitionActor::System,
            source: Some(TransitionSource::Scheduler),
        })
        .await;
}

fn end_condition_reached(task: &Task) -> bool {
    let Some(conditions) = task.end_conditions.as_ref() else {
        return false;
    };
    conditions
        .deadline
        .is_some_and(|deadline| Utc::now().timestamp_millis() >= deadline)
        || conditions
            .max_executions
            .is_some_and(|max| task.execution_count >= max)
}

pub fn validate_task_schedule(task: &Task) -> Result<(), String> {
    match task.execution_mode {
        TaskExecutionMode::Once => Ok(()),
        TaskExecutionMode::Scheduled if task.dispatch_at.is_none() => {
            Err("Scheduled task requires dispatchAt".to_string())
        }
        TaskExecutionMode::Scheduled => Ok(()),
        TaskExecutionMode::Recurring => {
            if let Some(expression) = task.cron_expression.as_deref() {
                crate::cron_task::validate_cron_expression(
                    expression,
                    task.cron_timezone.as_deref(),
                )?;
            }
            Ok(())
        }
        TaskExecutionMode::Loop => Err("Legacy Loop tasks are retired".to_string()),
    }
}

pub fn next_execution_at(task: &Task) -> Result<Option<DateTime<Utc>>, String> {
    if task.deleted || task.status != TaskStatus::Running {
        return Ok(None);
    }
    validate_task_schedule(task)?;
    let now = Utc::now();
    let clamp = |candidate: DateTime<Utc>, seconds: i64| {
        let minimum = now + chrono::Duration::seconds(seconds);
        if candidate > minimum {
            candidate
        } else {
            minimum
        }
    };

    match task.execution_mode {
        TaskExecutionMode::Once => Ok(Some(now + chrono::Duration::seconds(2))),
        TaskExecutionMode::Scheduled => Ok(task
            .dispatch_at
            .and_then(|timestamp| Utc.timestamp_millis_opt(timestamp).single())
            .map(|target| clamp(target, 2))),
        TaskExecutionMode::Recurring => {
            if let Some(expression) = task
                .cron_expression
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return crate::cron_task::validation::next_cron_fire_time(
                    expression,
                    task.cron_timezone.as_deref(),
                )
                .map(Some);
            }

            let interval_secs = task.interval_minutes.unwrap_or(60).max(5) as i64 * 60;
            let catch_up = task.recurring_window.as_ref();
            if task.last_scheduled_at.is_none() {
                if let Some(start_at) = task.start_at.as_deref() {
                    let target = DateTime::parse_from_rfc3339(start_at)
                        .map_err(|error| format!("invalid startAt: {error}"))?
                        .with_timezone(&Utc);
                    return Ok(Some(
                        crate::cron_task::schedule::resolve_missed_interval_target(
                            target,
                            interval_secs,
                            now,
                            catch_up,
                            2,
                        ),
                    ));
                }
                return Ok(Some(now + chrono::Duration::seconds(2)));
            }
            let base = task
                .last_scheduled_at
                .and_then(|timestamp| Utc.timestamp_millis_opt(timestamp).single())
                .unwrap_or(now);
            Ok(Some(
                crate::cron_task::schedule::resolve_missed_interval_target(
                    base + chrono::Duration::seconds(interval_secs),
                    interval_secs,
                    now,
                    catch_up,
                    5,
                ),
            ))
        }
        TaskExecutionMode::Loop => Ok(None),
    }
}

async fn sleep_until_wallclock(target: DateTime<Utc>) {
    loop {
        let now = Utc::now();
        if now >= target {
            return;
        }
        let seconds = (target - now).num_seconds().clamp(1, 30) as u64;
        tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
    }
}

static TASK_SCHEDULER: std::sync::OnceLock<TaskSchedulerController> = std::sync::OnceLock::new();

pub fn get_task_scheduler() -> &'static TaskSchedulerController {
    TASK_SCHEDULER.get_or_init(TaskSchedulerController::new)
}

pub async fn has_persistent_task_for_session(session_id: &str) -> bool {
    let Some(store) = crate::task::get_task_store() else {
        return false;
    };
    store
        .list(TaskListFilter {
            status: Some(crate::task::StatusFilter::One(TaskStatus::Running)),
            include_managed: Some(true),
            ..Default::default()
        })
        .await
        .into_iter()
        .any(|task| {
            task.run_mode == Some(crate::task::TaskRunMode::SingleSession)
                && (task.preselected_session_id.as_deref() == Some(session_id)
                    || task.session_ids.iter().any(|value| value == session_id))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_task(task: &Task) -> (tempfile::TempDir, crate::task::TaskStore) {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(
            data_dir.join("tasks.jsonl"),
            format!("{}\n", serde_json::to_string(task).unwrap()),
        )
        .unwrap();
        let store = crate::task::TaskStore::new(data_dir);
        (dir, store)
    }

    #[tokio::test]
    async fn stop_fences_a_claimed_execution_before_runtime_dispatch() {
        let controller = TaskSchedulerController::new();
        let queue_id = claim_execution(&controller.executions, "task-1")
            .await
            .expect("claim execution");

        assert!(controller.authorize_dispatch("task-1", &queue_id).await);
        controller.cancel_execution("task-1").await;
        assert!(!controller.authorize_dispatch("task-1", &queue_id).await);

        release_execution(&controller.executions, "task-1", &queue_id).await;
        assert!(!controller.is_executing("task-1").await);
    }

    #[tokio::test]
    async fn run_now_reservation_returns_the_session_bound_and_persisted_for_this_run() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-run-now",
            "name": "run now",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "new-session",
            "intervalMinutes": 60,
            "sessionIds": ["previous-run"],
            "status": "stopped",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        let (_dir, store) = store_with_task(&task);
        let task = store.get("task-run-now").await.unwrap();
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, &task.id).await.unwrap();

        let returned_session =
            reserve_claimed_execution_session(&executions, &store, &task, &queue_id)
                .await
                .unwrap()
                .expect("ordinary Task execution must reserve a Session");

        let bound_session = executions
            .read()
            .await
            .get(&task.id)
            .and_then(|execution| execution.session_id.clone());
        let persisted = store.get(&task.id).await.unwrap();
        assert_ne!(returned_session, "previous-run");
        assert_eq!(bound_session.as_deref(), Some(returned_session.as_str()));
        assert_eq!(
            persisted.session_ids.last().map(String::as_str),
            Some(returned_session.as_str())
        );

        release_execution(&executions, &task.id, &queue_id).await;
    }

    #[tokio::test]
    async fn managed_batch_reservation_does_not_bind_or_persist_a_session() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "managed-batch",
            "name": "memory batch",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "recurring",
            "runMode": "new-session",
            "intervalMinutes": 60,
            "managedKind": "memory_auto_update_batch",
            "sessionIds": [],
            "status": "stopped",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        let (_dir, store) = store_with_task(&task);
        let task = store.get("managed-batch").await.unwrap();
        let executions: ActiveExecutions = Arc::new(RwLock::new(HashMap::new()));
        let queue_id = claim_execution(&executions, &task.id).await.unwrap();

        let reserved = reserve_claimed_execution_session(&executions, &store, &task, &queue_id)
            .await
            .unwrap();

        let bound_session = executions
            .read()
            .await
            .get(&task.id)
            .and_then(|execution| execution.session_id.clone());
        let persisted = store.get(&task.id).await.unwrap();
        assert_eq!(reserved, None);
        assert_eq!(bound_session, None);
        assert!(persisted.session_ids.is_empty());

        release_execution(&executions, &task.id, &queue_id).await;
    }

    #[test]
    fn loop_is_not_a_valid_task_schedule() {
        let mut task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-1",
            "name": "test",
            "executor": "agent",
            "workspaceId": "workspace",
            "workspacePath": "/tmp/workspace",
            "executionMode": "loop",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();
        task.execution_mode = TaskExecutionMode::Loop;
        assert!(validate_task_schedule(&task).is_err());
    }

    #[test]
    fn recurring_start_at_is_the_first_trigger_anchor() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-start-at",
            "name": "Memory Gardener",
            "executor": "agent",
            "workspaceId": "ws",
            "workspacePath": "/tmp/ws",
            "executionMode": "recurring",
            "intervalMinutes": 4320,
            "startAt": "2099-07-08T00:00:00Z",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .expect("task json");

        assert_eq!(
            next_execution_at(&task).unwrap().unwrap().to_rfc3339(),
            "2099-07-08T00:00:00+00:00"
        );
    }

    #[test]
    fn manual_history_does_not_skip_the_first_scheduled_anchor() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-manual-first",
            "name": "Memory Gardener",
            "executor": "agent",
            "workspaceId": "ws",
            "workspacePath": "/tmp/ws",
            "executionMode": "recurring",
            "intervalMinutes": 4320,
            "startAt": "2099-07-08T00:00:00Z",
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "lastExecutedAt": 2,
            "executionCount": 1,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();

        assert_eq!(
            next_execution_at(&task).unwrap().unwrap().to_rfc3339(),
            "2099-07-08T00:00:00+00:00"
        );
    }

    #[test]
    fn recurring_schedule_uses_the_last_timer_run_not_run_now() {
        let now = Utc::now();
        let scheduled = now - chrono::Duration::minutes(10);
        let manual = now - chrono::Duration::minutes(1);
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "task-anchor",
            "name": "anchored",
            "executor": "agent",
            "workspaceId": "ws",
            "workspacePath": "/tmp/ws",
            "executionMode": "recurring",
            "intervalMinutes": 60,
            "sessionIds": [],
            "status": "running",
            "tags": [],
            "createdAt": 1,
            "updatedAt": 1,
            "lastExecutedAt": manual.timestamp_millis(),
            "lastScheduledAt": scheduled.timestamp_millis(),
            "executionCount": 2,
            "statusHistory": [],
            "dispatchOrigin": "direct"
        }))
        .unwrap();

        let next = next_execution_at(&task).unwrap().unwrap();
        let expected = scheduled + chrono::Duration::minutes(60);
        assert!((next - expected).num_seconds().abs() <= 1);
    }

    #[test]
    fn rerun_one_shot_is_not_gated_by_cumulative_execution_count() {
        for (mode, dispatch_at) in [
            (TaskExecutionMode::Once, None),
            (
                TaskExecutionMode::Scheduled,
                Some(Utc::now().timestamp_millis() - 1_000),
            ),
        ] {
            let mut task: Task = serde_json::from_value(serde_json::json!({
                "id": "task-rerun",
                "name": "rerun",
                "executor": "agent",
                "workspaceId": "ws",
                "workspacePath": "/tmp/ws",
                "executionMode": "once",
                "sessionIds": [],
                "executionCount": 3,
                "status": "running",
                "tags": [],
                "createdAt": 1,
                "updatedAt": 1,
                "statusHistory": [],
                "dispatchOrigin": "direct"
            }))
            .unwrap();
            task.execution_mode = mode;
            task.dispatch_at = dispatch_at;
            assert!(next_execution_at(&task).unwrap().is_some());
        }
    }
}
