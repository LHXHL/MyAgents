//! Narrow application owner for Task mutations that cross TaskStore,
//! scheduler, and ThoughtStore boundaries.
//!
//! Transports stamp caller identity and map DTOs/errors. Compatibility and
//! system domains call these use cases directly instead of importing an HTTP
//! handler module.

use serde::Serialize;

use crate::task::{
    StatusTransition, Task, TaskCreateAttachedInput, TaskCreateDirectInput,
    TaskCreateFromAlignmentInput, TaskStatus, TaskStore, TaskUpdateInput, TaskUpdateStatusInput,
};
use crate::task_scheduler::TaskControlGuard;
use crate::thought::ThoughtStore;
use crate::ulog_warn;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskApplicationErrorCode {
    StoreUnavailable,
    NotFound,
    Busy,
    InvalidState,
    ExecutionUnresolved,
    ScheduleInvalid,
    MutationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskApplicationError {
    code: TaskApplicationErrorCode,
    message: String,
}

impl TaskApplicationError {
    pub fn code(&self) -> TaskApplicationErrorCode {
        self.code
    }

    fn store_unavailable() -> Self {
        Self {
            code: TaskApplicationErrorCode::StoreUnavailable,
            message: "task store not initialized".to_string(),
        }
    }

    fn not_found(task_id: &str) -> Self {
        Self {
            code: TaskApplicationErrorCode::NotFound,
            message: format!("task not found: {task_id}"),
        }
    }

    fn busy(task_id: &str) -> Self {
        Self {
            code: TaskApplicationErrorCode::Busy,
            message: format!(
                "task {task_id} is stopping or changing scheduler state; retry after it settles"
            ),
        }
    }

    fn invalid_state(message: impl Into<String>) -> Self {
        Self {
            code: TaskApplicationErrorCode::InvalidState,
            message: message.into(),
        }
    }

    fn unresolved(task_id: &str, state: &str, rerun: bool) -> Self {
        let action = if rerun {
            "retry stop before rerunning"
        } else {
            "stop it before rerunning"
        };
        Self {
            code: TaskApplicationErrorCode::ExecutionUnresolved,
            message: format!("task {task_id} still has an unresolved {state} execution; {action}"),
        }
    }

    fn schedule(message: String) -> Self {
        Self {
            code: TaskApplicationErrorCode::ScheduleInvalid,
            message,
        }
    }

    fn mutation(message: String) -> Self {
        Self {
            code: TaskApplicationErrorCode::MutationFailed,
            message,
        }
    }
}

impl std::fmt::Display for TaskApplicationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TaskApplicationError {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunResult {
    pub task: Task,
    /// One-based ordinal owned by the accepted run/rerun mutation. This is
    /// deliberately independent from Session history cardinality.
    pub attempt_ordinal: u32,
}

#[derive(Debug, Clone)]
pub struct TaskStatusMutationResult {
    pub task: Task,
    pub transition: Option<StatusTransition>,
}

pub struct TaskApplication<'a> {
    tasks: &'a TaskStore,
    thoughts: Option<&'a ThoughtStore>,
}

impl<'a> TaskApplication<'a> {
    pub fn new(tasks: &'a TaskStore, thoughts: Option<&'a ThoughtStore>) -> Self {
        Self { tasks, thoughts }
    }

    pub fn from_globals() -> Result<TaskApplication<'static>, TaskApplicationError> {
        let tasks = crate::task::get_task_store()
            .map(std::sync::Arc::as_ref)
            .ok_or_else(TaskApplicationError::store_unavailable)?;
        let thoughts = crate::thought::get_thought_store().map(std::sync::Arc::as_ref);
        Ok(TaskApplication::new(tasks, thoughts))
    }

    async fn ordinary_task(&self, task_id: &str) -> Result<Task, TaskApplicationError> {
        let task = self
            .tasks
            .get(task_id)
            .await
            .ok_or_else(|| TaskApplicationError::not_found(task_id))?;
        if crate::task::is_managed_task(&task) {
            return Err(TaskApplicationError::mutation(
                crate::task::MANAGED_TASK_ERROR.to_string(),
            ));
        }
        Ok(task)
    }

    async fn any_task(&self, task_id: &str) -> Result<Task, TaskApplicationError> {
        self.tasks
            .get(task_id)
            .await
            .filter(|task| !task.deleted)
            .ok_or_else(|| TaskApplicationError::not_found(task_id))
    }

    async fn link_source_thought(&self, task: &Task) {
        let (Some(thought_id), Some(thoughts)) = (task.source_thought_id.as_deref(), self.thoughts)
        else {
            return;
        };
        if let Err(error) = thoughts.link_task(thought_id, &task.id).await {
            // Preserve the established partial-success contract: Task is the
            // durable primary fact and a Thought projection failure is visible
            // in logs without rolling the Task back.
            ulog_warn!(
                "[task-application] created {} but thought link failed: {}",
                task.id,
                error
            );
        }
    }

    async fn unlink_source_thought(&self, task: &Task) {
        let (Some(thought_id), Some(thoughts)) = (task.source_thought_id.as_deref(), self.thoughts)
        else {
            return;
        };
        if let Err(error) = thoughts.unlink_task(thought_id, &task.id).await {
            ulog_warn!(
                "[task-application] deleted {} but thought unlink failed: {}",
                task.id,
                error
            );
        }
    }

    pub async fn create_direct(
        &self,
        input: TaskCreateDirectInput,
    ) -> Result<Task, TaskApplicationError> {
        let task = self
            .tasks
            .create_direct(input)
            .await
            .map_err(TaskApplicationError::mutation)?;
        self.link_source_thought(&task).await;
        Ok(task)
    }

    pub async fn create_system_managed_direct(
        &self,
        input: TaskCreateDirectInput,
    ) -> Result<Task, TaskApplicationError> {
        self.tasks
            .create_system_managed_direct(input)
            .await
            .map_err(TaskApplicationError::mutation)
    }

    pub async fn create_from_alignment(
        &self,
        input: TaskCreateFromAlignmentInput,
    ) -> Result<Task, TaskApplicationError> {
        let task = self
            .tasks
            .create_from_alignment(input)
            .await
            .map_err(TaskApplicationError::mutation)?;
        self.link_source_thought(&task).await;
        Ok(task)
    }

    pub async fn create_attached(
        &self,
        input: TaskCreateAttachedInput,
    ) -> Result<Task, TaskApplicationError> {
        self.tasks
            .create_attached(input)
            .await
            .map_err(TaskApplicationError::mutation)
    }

    pub async fn update_ordinary(
        &self,
        input: TaskUpdateInput,
    ) -> Result<Task, TaskApplicationError> {
        self.ordinary_task(&input.id).await?;
        self.tasks
            .update(input)
            .await
            .map_err(TaskApplicationError::mutation)
    }

    pub async fn append_session_ordinary(
        &self,
        task_id: &str,
        session_id: &str,
    ) -> Result<Task, TaskApplicationError> {
        self.ordinary_task(task_id).await?;
        self.tasks
            .append_session(task_id, session_id)
            .await
            .map_err(TaskApplicationError::mutation)
    }

    pub async fn update_status_ordinary(
        &self,
        input: TaskUpdateStatusInput,
    ) -> Result<TaskStatusMutationResult, TaskApplicationError> {
        let control = crate::task_scheduler::acquire_task_control(&input.id).await;
        let current = self.ordinary_task(&input.id).await?;
        if crate::task::is_terminal_execution_stop_request(current.status, input.status) {
            crate::task_scheduler::get_task_scheduler()
                .stop_with_control_held(&current.id, &control)
                .await
                .map_err(TaskApplicationError::mutation)?;
            return Ok(TaskStatusMutationResult {
                task: current,
                transition: None,
            });
        }
        let (task, transition) = self
            .tasks
            .update_status_with_task_control_held(input, &control)
            .await
            .map_err(TaskApplicationError::mutation)?;
        Ok(TaskStatusMutationResult {
            task,
            transition: Some(transition),
        })
    }

    pub async fn archive_ordinary(
        &self,
        task_id: &str,
        message: Option<String>,
    ) -> Result<Task, TaskApplicationError> {
        self.ordinary_task(task_id).await?;
        self.tasks
            .archive(task_id, message)
            .await
            .map_err(TaskApplicationError::mutation)
    }

    pub async fn delete_ordinary(&self, task_id: &str) -> Result<(), TaskApplicationError> {
        let task = self.ordinary_task(task_id).await?;
        self.delete_task(task).await
    }

    pub async fn delete_internal(&self, task_id: &str) -> Result<(), TaskApplicationError> {
        let task = self.any_task(task_id).await?;
        self.delete_task(task).await
    }

    async fn delete_task(&self, task: Task) -> Result<(), TaskApplicationError> {
        self.tasks
            .delete(&task.id)
            .await
            .map_err(TaskApplicationError::mutation)?;
        self.unlink_source_thought(&task).await;
        Ok(())
    }

    pub async fn run_ordinary(&self, task_id: &str) -> Result<TaskRunResult, TaskApplicationError> {
        self.ordinary_task(task_id).await?;
        self.run(task_id).await
    }

    pub async fn run(&self, task_id: &str) -> Result<TaskRunResult, TaskApplicationError> {
        let control = crate::task_scheduler::try_acquire_task_control(task_id)
            .await
            .ok_or_else(|| TaskApplicationError::busy(task_id))?;
        self.run_with_control(task_id, &control).await
    }

    pub(crate) async fn run_with_control(
        &self,
        task_id: &str,
        control: &TaskControlGuard,
    ) -> Result<TaskRunResult, TaskApplicationError> {
        let task = self.any_task(task_id).await?;
        if task.status != TaskStatus::Todo {
            return Err(TaskApplicationError::invalid_state(format!(
                "task is in state '{}'; use 'myagents task rerun {}' to re-dispatch it",
                task.status.as_str(),
                task.id
            )));
        }
        if let Some(execution) = crate::task_scheduler::get_task_scheduler()
            .execution_projection(task_id)
            .await
        {
            return Err(TaskApplicationError::unresolved(
                task_id,
                execution.state.as_str(),
                false,
            ));
        }
        crate::task_scheduler::validate_task_schedule(&task)
            .map_err(TaskApplicationError::schedule)?;
        let (running, _) = self
            .tasks
            .update_status_with_task_control_held(
                TaskUpdateStatusInput {
                    id: task.id.clone(),
                    status: TaskStatus::Running,
                    message: Some("dispatched".to_string()),
                    actor: crate::task::TransitionActor::System,
                    source: Some(crate::task::TransitionSource::Scheduler),
                },
                control,
            )
            .await
            .map_err(TaskApplicationError::mutation)?;
        if let Err(error) = crate::task_scheduler::get_task_scheduler()
            .start_with_control_held(&running.id, control)
            .await
        {
            let rollback = self
                .tasks
                .update_status_with_task_control_held(
                    TaskUpdateStatusInput {
                        id: running.id.clone(),
                        status: TaskStatus::Blocked,
                        message: Some(format!("scheduler start failed: {error}")),
                        actor: crate::task::TransitionActor::System,
                        source: Some(crate::task::TransitionSource::Scheduler),
                    },
                    control,
                )
                .await;
            if let Err(rollback_error) = rollback {
                ulog_warn!(
                    "[task-application] scheduler start failed and blocked transition failed task={}: {}",
                    running.id,
                    rollback_error
                );
            }
            return Err(TaskApplicationError::mutation(error));
        }
        Ok(TaskRunResult {
            attempt_ordinal: running.execution_count.saturating_add(1),
            task: running,
        })
    }

    pub async fn rerun_ordinary(
        &self,
        task_id: &str,
    ) -> Result<TaskRunResult, TaskApplicationError> {
        let control = crate::task_scheduler::try_acquire_task_control(task_id)
            .await
            .ok_or_else(|| TaskApplicationError::busy(task_id))?;
        let task = self.ordinary_task(task_id).await?;
        if !matches!(
            task.status,
            TaskStatus::Blocked | TaskStatus::Stopped | TaskStatus::Done | TaskStatus::Archived
        ) {
            return Err(TaskApplicationError::invalid_state(format!(
                "rerun only valid from blocked/stopped/done/archived; current = '{}'",
                task.status.as_str()
            )));
        }
        if let Some(execution) = crate::task_scheduler::get_task_scheduler()
            .execution_projection(task_id)
            .await
        {
            return Err(TaskApplicationError::unresolved(
                task_id,
                execution.state.as_str(),
                true,
            ));
        }
        self.tasks
            .update_status_with_task_control_held(
                TaskUpdateStatusInput {
                    id: task.id.clone(),
                    status: TaskStatus::Todo,
                    message: Some("rerun requested".to_string()),
                    actor: crate::task::TransitionActor::System,
                    source: Some(crate::task::TransitionSource::Rerun),
                },
                &control,
            )
            .await
            .map_err(|error| TaskApplicationError::mutation(format!("reset failed: {error}")))?;
        self.run_with_control(task_id, &control).await
    }

    /// Compatibility start preserves the retired Cron surface's idempotent
    /// running/restart behavior while sharing the canonical run transition.
    pub async fn start_scheduled_task(&self, task_id: &str) -> Result<Task, TaskApplicationError> {
        let control = crate::task_scheduler::acquire_task_control(task_id).await;
        let mut task = self.any_task(task_id).await?;
        if task.status == TaskStatus::Running {
            if let Err(error) = crate::task_scheduler::get_task_scheduler()
                .start_with_control_held(task_id, &control)
                .await
            {
                let _ = self
                    .tasks
                    .update_status_with_task_control_held(
                        TaskUpdateStatusInput {
                            id: task_id.to_string(),
                            status: TaskStatus::Blocked,
                            message: Some(format!("scheduler start failed: {error}")),
                            actor: crate::task::TransitionActor::System,
                            source: Some(crate::task::TransitionSource::Scheduler),
                        },
                        &control,
                    )
                    .await;
                return Err(TaskApplicationError::mutation(error));
            }
            return Ok(task);
        }
        if task.status != TaskStatus::Todo {
            task = self
                .tasks
                .update_status_with_task_control_held(
                    TaskUpdateStatusInput {
                        id: task_id.to_string(),
                        status: TaskStatus::Todo,
                        message: Some("scheduled task restarted".to_string()),
                        actor: crate::task::TransitionActor::System,
                        source: Some(crate::task::TransitionSource::Scheduler),
                    },
                    &control,
                )
                .await
                .map_err(TaskApplicationError::mutation)?
                .0;
        }
        self.run_with_control(&task.id, &control)
            .await
            .map(|result| result.task)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::{
        TaskDispatchOrigin, TaskExecutionMode, TaskExecutor, TaskRunMode, TaskStatus,
        TransitionActor, TransitionSource,
    };
    use crate::thought::{ThoughtCreateInput, ThoughtStore};
    use tempfile::tempdir;

    fn direct_input(workspace: &std::path::Path) -> TaskCreateDirectInput {
        TaskCreateDirectInput {
            name: "Application task".to_string(),
            executor: TaskExecutor::Agent,
            description: None,
            workspace_id: "workspace-1".to_string(),
            workspace_path: workspace.to_string_lossy().into_owned(),
            task_md_content: "Do the work".to_string(),
            execution_mode: TaskExecutionMode::Once,
            run_mode: Some(TaskRunMode::NewSession),
            end_conditions: None,
            interval_minutes: None,
            cron_expression: None,
            cron_timezone: None,
            start_at: None,
            recurring_window: None,
            dispatch_at: None,
            model: None,
            provider_id: None,
            permission_mode: None,
            preselected_session_id: None,
            runtime: None,
            runtime_config: None,
            mcp_enabled_servers: None,
            managed_kind: None,
            source_thought_id: None,
            tags: Vec::new(),
            notification: None,
        }
    }

    #[tokio::test]
    async fn create_and_delete_share_thought_projection_policy() {
        let temp = tempdir().unwrap();
        let tasks = TaskStore::new(temp.path().join("task-store"));
        let thoughts = ThoughtStore::new(temp.path().join("thought-store"));
        let thought = thoughts
            .create(ThoughtCreateInput {
                content: "Source thought".to_string(),
                images: Vec::new(),
            })
            .await
            .unwrap();
        let application = TaskApplication::new(&tasks, Some(&thoughts));
        let mut input = direct_input(temp.path());
        input.source_thought_id = Some(thought.id.clone());

        let created = application.create_direct(input).await.unwrap();
        assert!(thoughts
            .get(&thought.id)
            .await
            .unwrap()
            .converted_task_ids
            .contains(&created.id));

        application.delete_ordinary(&created.id).await.unwrap();
        assert!(!thoughts
            .get(&thought.id)
            .await
            .unwrap()
            .converted_task_ids
            .contains(&created.id));
    }

    #[tokio::test]
    async fn busy_run_is_a_typed_application_error() {
        let temp = tempdir().unwrap();
        let tasks = TaskStore::new(temp.path().join("task-store"));
        let application = TaskApplication::new(&tasks, None);
        let task = application
            .create_direct(direct_input(temp.path()))
            .await
            .unwrap();
        let control = crate::task_scheduler::acquire_task_control(&task.id).await;

        let error = application.run(&task.id).await.unwrap_err();
        assert_eq!(error.code(), TaskApplicationErrorCode::Busy);
        drop(control);
    }

    #[tokio::test]
    async fn rerun_rejects_todo_before_writing_a_transition() {
        let temp = tempdir().unwrap();
        let tasks = TaskStore::new(temp.path().join("task-store"));
        let application = TaskApplication::new(&tasks, None);
        let task = application
            .create_direct(direct_input(temp.path()))
            .await
            .unwrap();

        let error = application.rerun_ordinary(&task.id).await.unwrap_err();
        assert_eq!(error.code(), TaskApplicationErrorCode::InvalidState);
        let unchanged = tasks.get(&task.id).await.unwrap();
        assert_eq!(unchanged.status, TaskStatus::Todo);
        assert_eq!(unchanged.dispatch_origin, TaskDispatchOrigin::Direct);
        assert_eq!(unchanged.status_history.len(), 1);
        assert_eq!(unchanged.status_history[0].actor, TransitionActor::User);
        assert_eq!(
            unchanged.status_history[0].source,
            Some(TransitionSource::Ui)
        );
    }

    #[tokio::test]
    async fn missing_task_is_a_typed_application_error() {
        let temp = tempdir().unwrap();
        let tasks = TaskStore::new(temp.path().join("task-store"));
        let application = TaskApplication::new(&tasks, None);

        let error = application.run_ordinary("missing-task").await.unwrap_err();

        assert_eq!(error.code(), TaskApplicationErrorCode::NotFound);
        assert_eq!(error.to_string(), "task not found: missing-task");
    }
}
