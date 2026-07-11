// Cron Task Manager for MyAgents
// Manages scheduled task execution with persistence and recovery
// Includes Rust-layer scheduler that directly executes tasks via Sidecar
//
// Key responsibilities:
// - Task lifecycle management (create, start, pause, stop, complete)
// - Interval-based scheduling with overlap prevention
// - Session activation/deactivation coordination with SidecarManager
// - Persistence to ~/.myagents/cron_tasks.json with auto-recovery on startup

use chrono::{DateTime, Utc};
use cron::Schedule as CronExprSchedule;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use tokio::time::Duration;
use uuid::Uuid;

use crate::sidecar::{
    ensure_session_sidecar, execute_cron_task, CronExecutePayload, ManagedSidecarManager,
    ProviderEnv, SidecarOwner,
};
use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};

pub(crate) mod commands;
pub(crate) mod delivery;
pub(crate) mod execution;
pub(crate) mod init_recovery;
pub(crate) mod manager;
pub(crate) mod run_records;
pub(crate) mod schedule;
pub(crate) mod store;
pub(crate) mod types;
pub(crate) mod validation;

#[allow(unused_imports)]
pub use commands::{
    cmd_create_cron_task, cmd_create_goal_task, cmd_delete_cron_task, cmd_get_cron_runs,
    cmd_get_cron_task, cmd_get_cron_tasks, cmd_get_goal_task, cmd_get_session_cron_task,
    cmd_get_session_goal_task, cmd_get_tab_cron_task, cmd_get_tasks_to_recover,
    cmd_get_user_scheduler_lifecycle_snapshot, cmd_get_workspace_cron_tasks, cmd_is_task_executing,
    cmd_mark_goal_terminal, cmd_mark_task_complete, cmd_mark_task_executing, cmd_pause_goal_task,
    cmd_record_cron_execution, cmd_resume_goal_task, cmd_start_cron_scheduler, cmd_start_cron_task,
    cmd_stop_cron_task, cmd_update_cron_task_fields, cmd_update_cron_task_session,
    cmd_update_cron_task_tab,
};
use delivery::deliver_cron_result_to_bot;
pub use delivery::{deliver_task_notification_to_bot, deliver_task_notification_to_bot_checked};
use execution::{
    check_end_conditions_static, execute_task_directly, send_goal_terminal_notification,
    stop_task_internal,
};
pub use init_recovery::initialize_cron_manager;
pub use manager::{get_cron_task_manager, CronTaskManager};
pub use run_records::{
    read_cron_runs, record_cron_run, CronRecoveryFailedTask, CronRecoverySummaryPayload,
    CronRunRecord, CronTaskRecoveredPayload, CronTaskStatusChangedPayload, CronTaskTriggerPayload,
    TriggerNowInfo,
};
use run_records::{run_record_path, TERMINAL_STOP_SENTINEL};
pub use schedule::enrich_for_summary;
use schedule::{enrich_task, resolve_missed_interval_target, sleep_until_wallclock};
use store::{atomic_save_task_snapshot, atomic_save_tasks};
#[cfg(test)]
use types::default_permission_mode;
use types::CronTaskStore;
pub use types::{
    CronDelivery, CronSchedule, CronTask, CronTaskConfig, EndConditions, GoalDeliveryOutboxItem,
    GoalDeliveryState, GoalMutationError, GoalMutationErrorCode, GoalPausedReason, GoalStatus,
    GoalTerminalActor, GoalTerminalOutcome, GoalTurnLease, GoalTurnLeaseState, GoalUserAdmission,
    GoalUserAdmissionKind, GoalUserAdmissionState, ProviderIntent, RecurringWindow, RunMode,
    TaskProviderEnv, TaskStatus,
};
pub(crate) use validation::normalize_path;
pub use validation::validate_cron_expression;
#[allow(unused_imports)]
use validation::{next_cron_fire_time, translate_unix_dow_to_crate_dow};

#[cfg(test)]
mod cron_dialect_tests {
    use super::*;

    fn sample_task(id: &str, workspace_path: &str) -> CronTask {
        let now = Utc::now();
        CronTask {
            id: id.to_string(),
            workspace_path: workspace_path.to_string(),
            session_id: "session".to_string(),
            prompt: "prompt".to_string(),
            interval_minutes: 60,
            end_conditions: EndConditions::default(),
            run_mode: RunMode::SingleSession,
            status: TaskStatus::Running,
            execution_count: 0,
            created_at: now,
            last_executed_at: None,
            notify_enabled: true,
            tab_id: None,
            exit_reason: None,
            permission_mode: default_permission_mode(),
            model: None,
            provider_env: None,
            provider_id: None,
            provider_intent: ProviderIntent::FollowAgent,
            runtime: None,
            runtime_config: None,
            mcp_enabled_servers: None,
            managed_kind: None,
            last_error: None,
            last_run_ok: None,
            last_run_duration_ms: None,
            source_bot_id: None,
            delivery: None,
            schedule: None,
            name: None,
            next_execution_at: None,
            internal_session_id: None,
            updated_at: now,
            task_id: None,
            goal_status: None,
            goal_objective: None,
            goal_updated_at: None,
            goal_terminal_reason: None,
            goal_paused_reason: None,
            goal_revision: 0,
            goal_control_revision: 0,
            goal_turn_lease: None,
            goal_user_admissions: Vec::new(),
            goal_delivery_outbox: Vec::new(),
            goal_consecutive_failures: 0,
        }
    }

    fn test_manager_with_task(task: CronTask) -> CronTaskManager {
        let mut tasks = HashMap::new();
        tasks.insert(task.id.clone(), task);
        CronTaskManager {
            tasks: Arc::new(RwLock::new(tasks)),
            storage_path: PathBuf::from("unused"),
            shutdown: Arc::new(RwLock::new(false)),
            executing_tasks: Arc::new(RwLock::new(HashSet::new())),
            active_schedulers: Arc::new(RwLock::new(HashSet::new())),
            scheduler_handles: Arc::new(RwLock::new(HashMap::new())),
            goal_delivery_replayers: Arc::new(RwLock::new(HashSet::new())),
            app_handle: Arc::new(RwLock::new(None)),
        }
    }

    fn test_manager_with_storage(
        tasks: HashMap<String, CronTask>,
        storage_path: PathBuf,
    ) -> CronTaskManager {
        CronTaskManager {
            tasks: Arc::new(RwLock::new(tasks)),
            storage_path,
            shutdown: Arc::new(RwLock::new(false)),
            executing_tasks: Arc::new(RwLock::new(HashSet::new())),
            active_schedulers: Arc::new(RwLock::new(HashSet::new())),
            scheduler_handles: Arc::new(RwLock::new(HashMap::new())),
            goal_delivery_replayers: Arc::new(RwLock::new(HashSet::new())),
            app_handle: Arc::new(RwLock::new(None)),
        }
    }

    fn sample_cron_config(workspace_path: &str, session_id: &str) -> CronTaskConfig {
        CronTaskConfig {
            workspace_path: workspace_path.to_string(),
            session_id: session_id.to_string(),
            prompt: "prompt".to_string(),
            interval_minutes: 5,
            end_conditions: EndConditions::default(),
            run_mode: RunMode::SingleSession,
            notify_enabled: true,
            tab_id: None,
            permission_mode: default_permission_mode(),
            model: None,
            provider_env: None,
            provider_id: None,
            provider_intent: ProviderIntent::FollowAgent,
            runtime: None,
            runtime_config: None,
            mcp_enabled_servers: None,
            managed_kind: None,
            source_bot_id: None,
            delivery: None,
            schedule: None,
            name: None,
            task_id: None,
            goal_status: None,
            goal_objective: None,
            goal_updated_at: None,
            goal_terminal_reason: None,
            goal_paused_reason: None,
        }
    }

    #[test]
    fn normalize_path_matches_windows_separator_variants() {
        assert_eq!(
            normalize_path(r"C:\Users\me\project\"),
            "c:/users/me/project"
        );
        assert_eq!(normalize_path("C:/Users/me/project"), "c:/users/me/project");
        assert_eq!(
            normalize_path(r"\\Server\Share\Project\"),
            "//server/share/project"
        );
        assert_eq!(normalize_path("/Users/me/project/"), "/Users/me/project");
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(normalize_path(r"C:\"), "c:/");
    }

    #[test]
    fn normalize_path_keeps_posix_literal_backslashes() {
        assert_ne!(normalize_path(r"/tmp/a\b"), normalize_path("/tmp/a/b"));
        assert_eq!(normalize_path(r"/tmp/a\b/"), r"/tmp/a\b");
    }

    #[tokio::test]
    async fn get_tasks_for_workspace_matches_backslash_query_to_forward_slash_storage() {
        let task = sample_task("task-1", "C:/Users/me/project");
        let manager = test_manager_with_task(task);

        let tasks = manager
            .get_tasks_for_workspace(r"C:\Users\me\project\")
            .await;

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "task-1");
    }

    fn sample_goal_task(id: &str, task_status: TaskStatus, goal_status: GoalStatus) -> CronTask {
        let mut task = sample_task(id, "/tmp/goal-workspace");
        task.schedule = Some(CronSchedule::Loop);
        task.run_mode = RunMode::SingleSession;
        task.status = task_status;
        task.goal_status = Some(goal_status);
        task.goal_objective = Some("finish the goal".to_string());
        task.goal_revision = 1;
        task.goal_control_revision = 1;
        task
    }

    #[tokio::test]
    async fn terminal_goal_cannot_be_restarted_through_manager_start() {
        let task = sample_goal_task("goal-terminal", TaskStatus::Stopped, GoalStatus::Complete);
        let manager = test_manager_with_task(task);

        let err = manager
            .start_task("goal-terminal")
            .await
            .expect_err("terminal goals must not restart");

        assert!(err.contains("Terminal Goal"));
    }

    #[tokio::test]
    async fn ordinary_stop_cannot_reinterpret_an_explicit_goal() {
        let task = sample_goal_task("goal-stop", TaskStatus::Running, GoalStatus::Active);
        let manager = test_manager_with_task(task);

        let err = manager
            .stop_task("goal-stop", Some("ordinary stop".to_string()))
            .await
            .expect_err("ordinary stop must reject Goal tasks");
        let stored = manager.get_task("goal-stop").await.expect("Goal remains");
        assert!(err.contains("Goal controls"));
        assert_eq!(stored.status, TaskStatus::Running);
        assert_eq!(stored.goal_status, Some(GoalStatus::Active));
    }

    #[tokio::test]
    async fn ordinary_update_rejects_goal_tasks_without_canceling_them() {
        let task = sample_goal_task("goal-active", TaskStatus::Running, GoalStatus::Active);
        let manager = test_manager_with_task(task);

        let err = manager
            .update_task_fields(
                "goal-active",
                serde_json::json!({ "name": "should not apply" }),
            )
            .await
            .expect_err("ordinary cron update must reject Goal tasks");
        let stored = manager.get_task("goal-active").await.expect("task remains");

        assert!(err.contains("Goal Mode tasks"));
        assert_eq!(stored.status, TaskStatus::Running);
        assert_eq!(stored.goal_status, Some(GoalStatus::Active));
        assert_eq!(stored.name, None);
    }

    #[tokio::test]
    async fn ordinary_run_now_rejects_goal_tasks_before_app_handle_check() {
        let task = sample_goal_task("goal-run-now", TaskStatus::Running, GoalStatus::Active);
        let manager = test_manager_with_task(task);

        let err = manager
            .trigger_now("goal-run-now")
            .await
            .expect_err("ordinary cron run-now must reject Goal tasks");

        assert!(err.contains("Goal Mode tasks"));
    }

    #[tokio::test]
    async fn session_goal_lookup_scopes_by_session_workspace_and_terminal_flag() {
        let mut active = sample_goal_task("goal-active", TaskStatus::Running, GoalStatus::Active);
        active.session_id = "session-a".to_string();
        active.workspace_path = "C:/Users/me/project".to_string();

        let mut terminal =
            sample_goal_task("goal-terminal", TaskStatus::Stopped, GoalStatus::Complete);
        terminal.session_id = "session-a".to_string();
        terminal.workspace_path = "C:/Users/me/project".to_string();
        terminal.updated_at = active.updated_at + chrono::Duration::seconds(5);

        let mut other_session =
            sample_goal_task("goal-other", TaskStatus::Running, GoalStatus::Active);
        other_session.session_id = "session-b".to_string();
        other_session.workspace_path = "C:/Users/me/project".to_string();

        let manager = {
            let mut tasks = HashMap::new();
            tasks.insert(active.id.clone(), active);
            tasks.insert(terminal.id.clone(), terminal);
            tasks.insert(other_session.id.clone(), other_session);
            CronTaskManager {
                tasks: Arc::new(RwLock::new(tasks)),
                storage_path: PathBuf::from("unused"),
                shutdown: Arc::new(RwLock::new(false)),
                executing_tasks: Arc::new(RwLock::new(HashSet::new())),
                active_schedulers: Arc::new(RwLock::new(HashSet::new())),
                scheduler_handles: Arc::new(RwLock::new(HashMap::new())),
                goal_delivery_replayers: Arc::new(RwLock::new(HashSet::new())),
                app_handle: Arc::new(RwLock::new(None)),
            }
        };

        let unfinished = manager
            .get_goal_for_session("session-a", Some(r"C:\Users\me\project"), false)
            .await
            .expect("unfinished active goal");
        assert_eq!(unfinished.id, "goal-active");

        let latest = manager
            .get_goal_for_session("session-a", Some("C:/Users/me/project"), true)
            .await
            .expect("latest terminal-inclusive goal");
        assert_eq!(latest.id, "goal-terminal");

        assert!(manager
            .get_goal_for_session("session-b", Some("C:/Users/me/other"), false)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn manager_create_task_rejects_duplicate_unfinished_goal_but_allows_internal_loop_shape()
    {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let mut active = sample_goal_task("goal-active", TaskStatus::Running, GoalStatus::Active);
        active.session_id = "session-a".to_string();
        active.workspace_path = "/tmp/goal-workspace".to_string();
        let mut tasks = HashMap::new();
        tasks.insert(active.id.clone(), active);
        let manager = test_manager_with_storage(tasks, storage_path);

        let mut duplicate_goal = sample_cron_config("/tmp/goal-workspace", "session-a");
        duplicate_goal.schedule = Some(CronSchedule::Loop);
        duplicate_goal.goal_status = Some(GoalStatus::Active);
        duplicate_goal.goal_objective = Some("another goal".to_string());

        let err = manager
            .create_task(duplicate_goal)
            .await
            .expect_err("duplicate unfinished Goal should be rejected atomically");
        assert!(err.contains("unfinished Goal"));

        let mut internal_loop = sample_cron_config("/tmp/goal-workspace", "session-a");
        internal_loop.schedule = Some(CronSchedule::Loop);
        let created = manager
            .create_task(internal_loop)
            .await
            .expect("loop-shaped non-Goal tasks remain available to internal owners");
        assert_eq!(created.schedule, Some(CronSchedule::Loop));
        assert_eq!(created.goal_status, None);
    }

    #[tokio::test]
    async fn concurrent_goal_creates_commit_only_one_unfinished_goal() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager =
            test_manager_with_storage(HashMap::new(), temp.path().join("cron_tasks.json"));
        let mut first = sample_cron_config("/tmp/goal-race", "session-race");
        first.schedule = Some(CronSchedule::Loop);
        first.goal_status = Some(GoalStatus::Active);
        first.goal_objective = Some("first objective".to_string());
        let mut second = first.clone();
        second.prompt = "second objective".to_string();
        second.goal_objective = Some("second objective".to_string());

        let (first_result, second_result) =
            tokio::join!(manager.create_task(first), manager.create_task(second));
        assert_ne!(first_result.is_ok(), second_result.is_ok());
        assert_eq!(
            manager
                .get_all_tasks()
                .await
                .into_iter()
                .filter(CronTask::is_goal)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn create_task_disk_failure_does_not_leave_ghost_task() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = test_manager_with_storage(HashMap::new(), temp.path().to_path_buf());
        let config = sample_cron_config("/tmp/save-failure", "session-save-failure");

        manager
            .create_task(config)
            .await
            .expect_err("renaming a task snapshot over a directory must fail");
        assert!(manager.get_all_tasks().await.is_empty());
    }

    #[test]
    fn goal_identity_requires_explicit_status() {
        let mut loop_task = sample_task("loop", "/tmp/goal-workspace");
        loop_task.schedule = Some(CronSchedule::Loop);
        loop_task.goal_objective = Some("orphaned objective".to_string());
        assert!(!loop_task.is_goal());

        loop_task.goal_status = Some(GoalStatus::Active);
        assert!(loop_task.is_goal());
    }

    #[test]
    fn ordinary_cron_create_rejects_every_explicit_goal_field() {
        let mut config = sample_cron_config("/tmp/goal-workspace", "session-a");
        config.schedule = Some(CronSchedule::Every {
            minutes: 10,
            start_at: None,
            catch_up_window: None,
        });
        config.goal_status = Some(GoalStatus::Active);
        assert!(commands::validate_ordinary_cron_create_config(&config).is_err());

        let mut config = sample_cron_config("/tmp/goal-workspace", "session-a");
        config.goal_objective = Some("orphaned objective".to_string());
        assert!(commands::validate_ordinary_cron_create_config(&config).is_err());

        let mut config = sample_cron_config("/tmp/goal-workspace", "session-a");
        config.goal_updated_at = Some(Utc::now());
        assert!(commands::validate_ordinary_cron_create_config(&config).is_err());

        let mut config = sample_cron_config("/tmp/goal-workspace", "session-a");
        config.goal_terminal_reason = Some("orphaned terminal reason".to_string());
        assert!(commands::validate_ordinary_cron_create_config(&config).is_err());

        let mut config = sample_cron_config("/tmp/goal-workspace", "session-a");
        config.goal_paused_reason = Some(GoalPausedReason::UserStop);
        assert!(commands::validate_ordinary_cron_create_config(&config).is_err());
    }

    #[test]
    fn goal_admission_event_distinguishes_resume_from_active_turn() {
        assert_eq!(manager::goal_admission_change_kind(false), "turn_admitted");
        assert_eq!(manager::goal_admission_change_kind(true), "resumed");
    }

    #[test]
    fn goal_revisions_default_for_persisted_pre_revision_tasks() {
        let task = sample_goal_task("goal-old", TaskStatus::Running, GoalStatus::Active);
        let mut value = serde_json::to_value(task).expect("serialize task");
        let object = value.as_object_mut().expect("task object");
        object.remove("goalRevision");
        object.remove("goalControlRevision");
        let restored: CronTask = serde_json::from_value(value).expect("deserialize old task");
        assert_eq!(restored.goal_revision, 0);
        assert_eq!(restored.goal_control_revision, 0);
    }

    #[test]
    fn startup_recovery_revokes_turn_authorities_and_requeues_terminal_outbox() {
        let mut task = sample_goal_task("goal-recovery", TaskStatus::Stopped, GoalStatus::Complete);
        let now = Utc::now();
        task.goal_turn_lease = Some(GoalTurnLease {
            id: "claimed-before-crash".to_string(),
            turn_number: 1,
            state: GoalTurnLeaseState::Claimed,
            sidecar_generation: 7,
            created_at: now,
        });
        task.goal_user_admissions.push(GoalUserAdmission {
            id: "user-before-crash".to_string(),
            revision: task.goal_revision,
            turn_number: 2,
            state: GoalUserAdmissionState::Dispatched,
            sidecar_generation: 7,
            created_at: now,
        });
        task.goal_delivery_outbox.push(GoalDeliveryOutboxItem {
            id: "goal_delivery_claimed-before-crash".to_string(),
            lease_id: "claimed-before-crash".to_string(),
            session_id: task.session_id.clone(),
            text: "deliver after restart".to_string(),
            state: GoalDeliveryState::Sending,
            attempts: 1,
            created_at: now,
            last_error: None,
        });
        let initial_revision = task.goal_revision;
        let initial_control_revision = task.goal_control_revision;
        let mut tasks = HashMap::from([(task.id.clone(), task)]);

        assert_eq!(
            CronTaskManager::recover_goal_leases_and_outbox(&mut tasks),
            3
        );
        let recovered = tasks.get("goal-recovery").expect("recovered Goal");
        assert!(recovered.goal_turn_lease.is_none());
        assert!(recovered.goal_user_admissions.is_empty());
        assert_eq!(
            recovered.goal_delivery_outbox[0].state,
            GoalDeliveryState::Pending
        );
        assert_eq!(recovered.goal_revision, initial_revision + 1);
        assert_eq!(recovered.goal_control_revision, initial_control_revision);
    }

    #[test]
    fn startup_recovery_normalizes_explicit_goal_scheduler_status() {
        let active = sample_goal_task(
            "goal-active-stopped",
            TaskStatus::Stopped,
            GoalStatus::Active,
        );
        let complete = sample_goal_task(
            "goal-complete-running",
            TaskStatus::Running,
            GoalStatus::Complete,
        );
        let mut tasks =
            HashMap::from([(active.id.clone(), active), (complete.id.clone(), complete)]);

        assert_eq!(
            CronTaskManager::recover_goal_leases_and_outbox(&mut tasks),
            2
        );
        assert_eq!(tasks["goal-active-stopped"].status, TaskStatus::Running);
        assert_eq!(tasks["goal-complete-running"].status, TaskStatus::Stopped);
    }

    #[tokio::test]
    async fn goal_and_ordinary_single_session_automation_are_mutually_exclusive() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let ordinary = sample_task("ordinary-running", "/tmp/goal-workspace");
        let manager = test_manager_with_storage(
            HashMap::from([(ordinary.id.clone(), ordinary)]),
            storage_path,
        );
        let mut goal = sample_cron_config("/tmp/goal-workspace", "session");
        goal.schedule = Some(CronSchedule::Loop);
        goal.goal_status = Some(GoalStatus::Active);
        goal.goal_objective = Some(goal.prompt.clone());
        goal.goal_updated_at = Some(Utc::now());

        manager
            .create_task_with_initial_status(goal, TaskStatus::Running)
            .await
            .expect_err("running ordinary automation blocks Goal creation");

        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let goal = sample_goal_task("goal-paused", TaskStatus::Running, GoalStatus::Paused);
        let manager =
            test_manager_with_storage(HashMap::from([(goal.id.clone(), goal)]), storage_path);
        let ordinary = manager
            .create_task(sample_cron_config("/tmp/goal-workspace", "session"))
            .await
            .expect("stopped ordinary automation may be configured");

        manager
            .start_task(&ordinary.id)
            .await
            .expect_err("unfinished Goal blocks ordinary automation start");
    }

    #[tokio::test]
    async fn goal_turn_authorities_are_two_phase_and_user_can_queue_behind_auto_turn() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let task = sample_goal_task("goal-admit", TaskStatus::Running, GoalStatus::Active);
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);

        let prepared = manager
            .admit_goal_scheduler_turn("goal-admit", 1)
            .await
            .expect("active Goal prepares scheduler candidate");
        let unchanged = manager.get_task("goal-admit").await.expect("stored Goal");
        assert_eq!(unchanged.execution_count, 0);
        assert_eq!(unchanged.goal_revision, 1);
        assert!(unchanged.goal_turn_lease.is_none());

        let claimed = manager
            .claim_goal_scheduler_turn("goal-admit", &prepared.lease.id, 1)
            .await
            .expect("idle-boundary claim commits the auto turn");
        assert_eq!(claimed.execution_count, 0);
        assert_eq!(claimed.goal_revision, 2);
        assert_eq!(
            claimed.goal_turn_lease.as_ref().map(|lease| &lease.state),
            Some(&GoalTurnLeaseState::Claimed)
        );

        let (reserved, admission) = manager
            .reserve_goal_user_admission(
                "goal-admit",
                "user-1",
                claimed.goal_revision,
                GoalUserAdmissionKind::UserQuery,
            )
            .await
            .expect("one user turn may queue behind a claimed auto turn");
        assert_eq!(reserved.execution_count, 0);
        assert_eq!(admission.turn_number, 2);
        assert_eq!(admission.state, GoalUserAdmissionState::Pending);
        assert!(reserved.goal_turn_lease.is_some());

        let finalized_auto = manager
            .finalize_goal_scheduler_turn(
                "goal-admit",
                &prepared.lease.id,
                true,
                None,
                5,
                None,
                None,
                false,
            )
            .await
            .expect("auto turn finalizes");
        assert!(finalized_auto.applied);
        assert_eq!(finalized_auto.task.goal_user_admissions.len(), 1);

        manager
            .claim_goal_user_admission("goal-admit", "user-1")
            .await
            .expect("queued user turn claims immediately before dispatch");
        let (dispatched, resumed) = manager
            .finalize_goal_user_admission("goal-admit", "user-1", true)
            .await
            .expect("transport acceptance commits user turn");
        assert!(!resumed);
        assert_eq!(dispatched.execution_count, 2);
        assert_eq!(
            dispatched
                .goal_user_admissions
                .first()
                .map(|admission| &admission.state),
            Some(&GoalUserAdmissionState::Dispatched)
        );
        let released = manager
            .release_goal_user_admission("goal-admit", "user-1")
            .await
            .expect("turn-idle release clears user authority");
        assert!(released.goal_user_admissions.is_empty());

        manager
            .pause_goal_task("goal-admit", GoalPausedReason::UserStop)
            .await
            .expect("pause Goal");
        let paused = manager.get_task("goal-admit").await.expect("paused Goal");
        assert!(manager
            .admit_goal_scheduler_turn("goal-admit", paused.goal_revision)
            .await
            .is_err());

        let (_, admission) = manager
            .reserve_goal_user_admission(
                "goal-admit",
                "user-resume",
                paused.goal_revision,
                GoalUserAdmissionKind::UserQuery,
            )
            .await
            .expect("paused Goal reserves a user turn without resuming yet");
        assert_eq!(admission.state, GoalUserAdmissionState::Pending);
        manager
            .claim_goal_user_admission("goal-admit", "user-resume")
            .await
            .expect("paused user turn claims before dispatch");
        let (second, resumed) = manager
            .finalize_goal_user_admission("goal-admit", "user-resume", true)
            .await
            .expect("accepted user ingress resumes Goal");
        assert!(resumed);
        assert_eq!(second.goal_status, Some(GoalStatus::Active));
        assert_eq!(second.execution_count, 3);
    }

    #[tokio::test]
    async fn goal_terminal_transition_is_actor_aware_and_first_writer_wins() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let mut task =
            sample_goal_task("goal-terminal-cas", TaskStatus::Running, GoalStatus::Active);
        task.end_conditions.ai_can_exit = false;
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);

        let prepared = manager
            .admit_goal_scheduler_turn("goal-terminal-cas", 1)
            .await
            .expect("prepare authority");
        manager
            .claim_goal_scheduler_turn("goal-terminal-cas", &prepared.lease.id, 1)
            .await
            .expect("claim authority");
        let model_error = manager
            .transition_goal_terminal_authorized(
                "goal-terminal-cas",
                GoalStatus::Complete,
                Some("model done".to_string()),
                GoalTerminalActor::Model,
                &prepared.lease.id,
            )
            .await
            .expect_err("aiCanExit=false rejects model terminal transition");
        assert!(model_error.to_string().contains("does not allow AI"));

        let applied = manager
            .transition_goal_terminal(
                "goal-terminal-cas",
                GoalStatus::Blocked,
                Some("system guard".to_string()),
                GoalTerminalActor::System,
            )
            .await
            .expect("system guard bypasses aiCanExit");
        assert!(applied.was_applied());
        assert_eq!(applied.task().goal_status, Some(GoalStatus::Blocked));

        let repeated = manager
            .transition_goal_terminal(
                "goal-terminal-cas",
                GoalStatus::Complete,
                Some("late completion".to_string()),
                GoalTerminalActor::System,
            )
            .await
            .expect("terminal retry is idempotent");
        assert!(!repeated.was_applied());
        assert_eq!(repeated.task().goal_status, Some(GoalStatus::Blocked));
        assert_eq!(
            repeated.task().goal_terminal_reason.as_deref(),
            Some("system guard")
        );
    }

    #[tokio::test]
    async fn model_terminal_transition_succeeds_when_ai_exit_is_enabled() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let mut task = sample_goal_task(
            "goal-model-complete",
            TaskStatus::Running,
            GoalStatus::Active,
        );
        task.end_conditions.ai_can_exit = true;
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);

        let prepared = manager
            .admit_goal_scheduler_turn("goal-model-complete", 1)
            .await
            .expect("prepare authority");
        manager
            .claim_goal_scheduler_turn("goal-model-complete", &prepared.lease.id, 1)
            .await
            .expect("claim authority");
        let outcome = manager
            .transition_goal_terminal_authorized(
                "goal-model-complete",
                GoalStatus::Complete,
                Some("verified".to_string()),
                GoalTerminalActor::Model,
                &prepared.lease.id,
            )
            .await
            .expect("model can complete when aiCanExit is enabled");
        assert!(outcome.was_applied());
        assert_eq!(outcome.task().status, TaskStatus::Stopped);
        assert_eq!(outcome.task().goal_status, Some(GoalStatus::Complete));
    }

    #[tokio::test]
    async fn model_terminal_from_user_turn_retains_owner_until_admission_release() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let mut task = sample_goal_task(
            "goal-user-complete",
            TaskStatus::Running,
            GoalStatus::Active,
        );
        task.end_conditions.ai_can_exit = true;
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);

        let (_, reserved) = manager
            .reserve_goal_user_admission(
                "goal-user-complete",
                "user-completion-turn",
                1,
                GoalUserAdmissionKind::UserQuery,
            )
            .await
            .expect("reserve user turn");
        manager
            .claim_goal_user_admission("goal-user-complete", &reserved.id)
            .await
            .expect("claim user turn");
        manager
            .finalize_goal_user_admission("goal-user-complete", &reserved.id, true)
            .await
            .expect("mark user turn dispatched");

        let outcome = manager
            .transition_goal_terminal_authorized(
                "goal-user-complete",
                GoalStatus::Complete,
                Some("verified from user turn".to_string()),
                GoalTerminalActor::Model,
                &reserved.id,
            )
            .await
            .expect("user turn may complete Goal");
        assert!(outcome.was_applied());
        assert_eq!(outcome.task().status, TaskStatus::Stopped);
        assert_eq!(outcome.task().goal_user_admissions.len(), 1);
        assert_eq!(outcome.task().goal_user_admissions[0].id, reserved.id);

        let released = manager
            .release_goal_user_admission("goal-user-complete", &reserved.id)
            .await
            .expect("release after runtime idle");
        assert!(released.goal_user_admissions.is_empty());
        assert_eq!(released.goal_status, Some(GoalStatus::Complete));
        manager
            .release_goal_user_admission("goal-user-complete", &reserved.id)
            .await
            .expect("release compensation is idempotent");
    }

    #[tokio::test]
    async fn objective_update_revokes_claimed_turn_and_rejects_stale_terminal_and_output() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let task = sample_goal_task("goal-stale-turn", TaskStatus::Running, GoalStatus::Active);
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);

        let prepared = manager
            .admit_goal_scheduler_turn("goal-stale-turn", 1)
            .await
            .expect("prepare auto turn");
        let claimed = manager
            .claim_goal_scheduler_turn("goal-stale-turn", &prepared.lease.id, 1)
            .await
            .expect("claim auto turn");
        let updated = manager
            .update_goal_objective_cas(
                "goal-stale-turn",
                "new objective".to_string(),
                Some(claimed.goal_revision),
            )
            .await
            .expect("objective update wins");
        assert_eq!(updated.goal_objective.as_deref(), Some("new objective"));

        let terminal_error = manager
            .transition_goal_terminal_authorized(
                "goal-stale-turn",
                GoalStatus::Complete,
                Some("old objective complete".to_string()),
                GoalTerminalActor::Model,
                &prepared.lease.id,
            )
            .await
            .expect_err("old turn cannot terminalize the new objective");
        assert_eq!(terminal_error.code(), "stale_lease");

        let finalized = manager
            .finalize_goal_scheduler_turn(
                "goal-stale-turn",
                &prepared.lease.id,
                true,
                None,
                10,
                Some("old-internal-session".to_string()),
                Some("stale output".to_string()),
                true,
            )
            .await
            .expect("stale finalization is a no-op");
        assert!(!finalized.applied);
        assert!(finalized.task.goal_delivery_outbox.is_empty());
        assert!(finalized.task.internal_session_id.is_none());
        assert_eq!(finalized.task.goal_status, Some(GoalStatus::Active));
    }

    #[tokio::test]
    async fn sidecar_stop_revokes_turn_authority_without_a_wall_clock_timeout() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let mut task =
            sample_goal_task("goal-sidecar-stop", TaskStatus::Running, GoalStatus::Active);
        let created_at = Utc::now() - chrono::Duration::hours(4);
        task.goal_turn_lease = Some(GoalTurnLease {
            id: "stopped-sidecar-lease".to_string(),
            turn_number: 1,
            state: GoalTurnLeaseState::Claimed,
            sidecar_generation: 9,
            created_at,
        });
        task.goal_user_admissions.push(GoalUserAdmission {
            id: "stopped-sidecar-user-turn".to_string(),
            revision: task.goal_revision,
            turn_number: 2,
            state: GoalUserAdmissionState::Pending,
            sidecar_generation: 9,
            created_at,
        });
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);

        let revoked = manager
            .revoke_goal_turn_authorities_for_sidecar("session", 9)
            .await
            .expect("sidecar lifecycle revocation persists");
        assert_eq!(revoked, 1);
        let stored = manager
            .get_task("goal-sidecar-stop")
            .await
            .expect("Goal remains stored");
        assert!(stored.goal_turn_lease.is_none());
        assert!(stored.goal_user_admissions.is_empty());
        assert_eq!(stored.execution_count, 0);
    }

    #[tokio::test]
    async fn stale_sidecar_stop_preserves_replacement_generation_authority() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let mut task =
            sample_goal_task("goal-sidecar-aba", TaskStatus::Running, GoalStatus::Active);
        task.goal_turn_lease = Some(GoalTurnLease {
            id: "old-generation".to_string(),
            turn_number: 1,
            state: GoalTurnLeaseState::Claimed,
            sidecar_generation: 9,
            created_at: Utc::now(),
        });
        task.goal_user_admissions.push(GoalUserAdmission {
            id: "replacement-generation".to_string(),
            revision: task.goal_revision,
            turn_number: 2,
            state: GoalUserAdmissionState::Pending,
            sidecar_generation: 10,
            created_at: Utc::now(),
        });
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);

        assert_eq!(
            manager
                .revoke_goal_turn_authorities_for_sidecar("session", 9)
                .await
                .expect("old generation revoke persists"),
            1
        );
        let stored = manager
            .get_task("goal-sidecar-aba")
            .await
            .expect("Goal remains stored");
        assert!(stored.goal_turn_lease.is_none());
        assert_eq!(stored.goal_user_admissions.len(), 1);
        assert_eq!(stored.goal_user_admissions[0].sidecar_generation, 10);

        let no_live_sidecars =
            Arc::new(std::sync::Mutex::new(crate::sidecar::SidecarManager::new()));
        assert_eq!(
            manager
                .reconcile_goal_turn_authorities_with_live_sidecars(&no_live_sidecars)
                .await
                .expect("lag reconciliation persists"),
            1
        );
        assert!(manager
            .get_task("goal-sidecar-aba")
            .await
            .expect("Goal remains stored")
            .goal_user_admissions
            .is_empty());
    }

    #[tokio::test]
    async fn stale_sidecar_cannot_finalize_or_terminalize_goal_authority() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let mut task = sample_goal_task(
            "goal-stale-sidecar-commit",
            TaskStatus::Running,
            GoalStatus::Paused,
        );
        task.goal_paused_reason = Some(GoalPausedReason::UserStop);
        task.goal_user_admissions.push(GoalUserAdmission {
            id: "stale-user-authority".to_string(),
            revision: task.goal_revision,
            turn_number: 1,
            state: GoalUserAdmissionState::Claimed,
            sidecar_generation: 9,
            created_at: Utc::now(),
        });
        let manager = test_manager_with_storage(
            HashMap::from([(task.id.clone(), task)]),
            storage_path.clone(),
        );
        let no_current_sidecar =
            Arc::new(std::sync::Mutex::new(crate::sidecar::SidecarManager::new()));

        let finalize_error = manager
            .accept_goal_user_admission_from_sidecar(
                "goal-stale-sidecar-commit",
                "stale-user-authority",
                "session",
                9,
                &no_current_sidecar,
            )
            .await
            .expect_err("stopped Sidecar cannot resume or count a turn");
        assert_eq!(finalize_error.code(), "stale_admission");
        let stored = manager
            .get_task("goal-stale-sidecar-commit")
            .await
            .expect("Goal remains stored");
        assert_eq!(stored.goal_status, Some(GoalStatus::Paused));
        assert_eq!(stored.execution_count, 0);

        let mut task = sample_goal_task(
            "goal-stale-sidecar-terminal",
            TaskStatus::Running,
            GoalStatus::Active,
        );
        task.goal_turn_lease = Some(GoalTurnLease {
            id: "stale-scheduler-authority".to_string(),
            turn_number: 1,
            state: GoalTurnLeaseState::Claimed,
            sidecar_generation: 9,
            created_at: Utc::now(),
        });
        let terminal_manager = test_manager_with_storage(
            HashMap::from([(task.id.clone(), task)]),
            temp.path().join("terminal_tasks.json"),
        );
        let terminal_error = terminal_manager
            .transition_goal_terminal_authorized_from_sidecar(
                "goal-stale-sidecar-terminal",
                GoalStatus::Complete,
                Some("stale completion".to_string()),
                "stale-scheduler-authority",
                "session",
                9,
                &no_current_sidecar,
            )
            .await
            .expect_err("stopped Sidecar cannot terminalize a Goal");
        assert_eq!(terminal_error.code(), "stale_lease");
        let stored = terminal_manager
            .get_task("goal-stale-sidecar-terminal")
            .await
            .expect("Goal remains stored");
        assert_eq!(stored.goal_status, Some(GoalStatus::Active));
        assert_eq!(stored.status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn user_admission_requires_predispatch_claim_and_pause_invalidates_it() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let task = sample_goal_task("goal-user-gate", TaskStatus::Running, GoalStatus::Active);
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);

        manager
            .reserve_goal_user_admission(
                "goal-user-gate",
                "user-gate",
                1,
                GoalUserAdmissionKind::UserQuery,
            )
            .await
            .expect("reserve user turn");
        let error = manager
            .finalize_goal_user_admission("goal-user-gate", "user-gate", true)
            .await
            .expect_err("transport acceptance cannot bypass predispatch claim");
        assert_eq!(error.code(), "stale_admission");

        manager
            .claim_goal_user_admission("goal-user-gate", "user-gate")
            .await
            .expect("claim user turn");
        manager
            .pause_goal_task("goal-user-gate", GoalPausedReason::UserStop)
            .await
            .expect("pause invalidates claimed user authority");
        let stale = manager
            .finalize_goal_user_admission("goal-user-gate", "user-gate", true)
            .await
            .expect_err("stale transport completion cannot resume paused Goal");
        assert_eq!(stale.code(), "stale_admission");
        let stored = manager
            .get_task("goal-user-gate")
            .await
            .expect("stored Goal");
        assert_eq!(stored.goal_status, Some(GoalStatus::Paused));
        assert_eq!(stored.execution_count, 0);
    }

    #[tokio::test]
    async fn multiple_user_messages_keep_ordered_independent_authorities() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let task = sample_goal_task("goal-user-queue", TaskStatus::Running, GoalStatus::Active);
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);

        let (after_first, first) = manager
            .reserve_goal_user_admission(
                "goal-user-queue",
                "user-first",
                1,
                GoalUserAdmissionKind::UserQuery,
            )
            .await
            .expect("reserve first user query");
        let (_, second) = manager
            .reserve_goal_user_admission_at_objective(
                "goal-user-queue",
                "user-second",
                1,
                GoalUserAdmissionKind::UserQuery,
                Some("finish the goal"),
                Some(1),
            )
            .await
            .expect("same-objective user query tolerates admission revision churn");
        assert!(after_first.goal_revision > 1);
        assert_eq!(after_first.goal_control_revision, 1);
        assert_eq!(first.turn_number, 1);
        assert_eq!(second.turn_number, 2);

        manager
            .claim_goal_user_admission("goal-user-queue", "user-first")
            .await
            .expect("claim first query");
        manager
            .finalize_goal_user_admission("goal-user-queue", "user-first", true)
            .await
            .expect("dispatch first query");
        manager
            .claim_goal_user_admission("goal-user-queue", "user-second")
            .await
            .expect("claim second query");
        let (after_second, _) = manager
            .finalize_goal_user_admission("goal-user-queue", "user-second", true)
            .await
            .expect("dispatch second query");
        assert_eq!(after_second.execution_count, 2);
        assert_eq!(after_second.goal_user_admissions.len(), 2);

        manager
            .release_goal_user_admission("goal-user-queue", "user-first")
            .await
            .expect("release first authority independently");
        let remaining = manager
            .get_task("goal-user-queue")
            .await
            .expect("stored Goal");
        assert_eq!(remaining.goal_user_admissions.len(), 1);
        assert_eq!(remaining.goal_user_admissions[0].id, "user-second");
        manager
            .release_goal_user_admission("goal-user-queue", "user-second")
            .await
            .expect("release second authority");
        assert!(manager
            .get_task("goal-user-queue")
            .await
            .expect("stored Goal")
            .goal_user_admissions
            .is_empty());
    }

    #[tokio::test]
    async fn goal_control_revision_rejects_a_query_snapshot_taken_before_pause() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let task = sample_goal_task(
            "goal-control-epoch",
            TaskStatus::Running,
            GoalStatus::Active,
        );
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);

        let paused = manager
            .pause_goal_task("goal-control-epoch", GoalPausedReason::UserStop)
            .await
            .expect("pause Goal");
        assert_eq!(paused.goal_control_revision, 2);

        let stale = manager
            .reserve_goal_user_admission_at_objective(
                "goal-control-epoch",
                "stale-before-pause",
                1,
                GoalUserAdmissionKind::UserQuery,
                Some("finish the goal"),
                Some(1),
            )
            .await
            .expect_err("pre-pause query snapshot must not resume the Goal");
        assert_eq!(stale.code(), "stale_revision");

        let (reserved, _) = manager
            .reserve_goal_user_admission_at_objective(
                "goal-control-epoch",
                "fresh-after-pause",
                paused.goal_revision,
                GoalUserAdmissionKind::UserQuery,
                Some("finish the goal"),
                Some(paused.goal_control_revision),
            )
            .await
            .expect("fresh query can reserve against the paused Goal");
        assert_eq!(reserved.goal_control_revision, paused.goal_control_revision);
        manager
            .claim_goal_user_admission("goal-control-epoch", "fresh-after-pause")
            .await
            .expect("claim fresh query");
        let (resumed, did_resume) = manager
            .finalize_goal_user_admission("goal-control-epoch", "fresh-after-pause", true)
            .await
            .expect("accepted fresh query resumes the Goal");
        assert!(did_resume);
        assert_eq!(resumed.goal_status, Some(GoalStatus::Active));
        assert_eq!(resumed.goal_control_revision, paused.goal_control_revision);

        let (second, _) = manager
            .reserve_goal_user_admission_at_objective(
                "goal-control-epoch",
                "also-fresh-after-pause",
                paused.goal_revision,
                GoalUserAdmissionKind::UserQuery,
                Some("finish the goal"),
                Some(paused.goal_control_revision),
            )
            .await
            .expect("another post-pause query stays in the same control epoch");
        assert_eq!(second.goal_control_revision, paused.goal_control_revision);
    }

    #[tokio::test]
    async fn objective_restart_cannot_queue_behind_claimed_scheduler_turn() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let task = sample_goal_task(
            "goal-objective-restart",
            TaskStatus::Running,
            GoalStatus::Active,
        );
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);
        let prepared = manager
            .admit_goal_scheduler_turn("goal-objective-restart", 1)
            .await
            .expect("prepare scheduler turn");
        let claimed = manager
            .claim_goal_scheduler_turn("goal-objective-restart", &prepared.lease.id, 1)
            .await
            .expect("claim scheduler turn");

        let error = manager
            .reserve_goal_user_admission(
                "goal-objective-restart",
                "restart",
                claimed.goal_revision,
                GoalUserAdmissionKind::ObjectiveRestart,
            )
            .await
            .expect_err("objective restart must not duplicate a claimed continuation");
        assert_eq!(error.code(), "lease_conflict");

        manager
            .reserve_goal_user_admission(
                "goal-objective-restart",
                "ordinary-query",
                claimed.goal_revision,
                GoalUserAdmissionKind::UserQuery,
            )
            .await
            .expect("ordinary query may queue behind claimed continuation");
    }

    #[tokio::test]
    async fn goal_channel_outbox_is_gated_by_turn_origin() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let task = sample_goal_task(
            "goal-outbox-origin",
            TaskStatus::Running,
            GoalStatus::Active,
        );
        let manager =
            test_manager_with_storage(HashMap::from([(task.id.clone(), task)]), storage_path);

        let desktop = manager
            .admit_goal_scheduler_turn("goal-outbox-origin", 1)
            .await
            .expect("prepare desktop turn");
        manager
            .claim_goal_scheduler_turn("goal-outbox-origin", &desktop.lease.id, 1)
            .await
            .expect("claim desktop turn");
        let desktop_done = manager
            .finalize_goal_scheduler_turn(
                "goal-outbox-origin",
                &desktop.lease.id,
                true,
                None,
                1,
                None,
                Some("desktop output".to_string()),
                false,
            )
            .await
            .expect("finalize desktop turn");
        assert!(!desktop_done.delivery_enqueued);
        assert!(desktop_done.task.goal_delivery_outbox.is_empty());

        let channel = manager
            .admit_goal_scheduler_turn("goal-outbox-origin", desktop_done.task.goal_revision)
            .await
            .expect("prepare channel turn");
        manager
            .claim_goal_scheduler_turn(
                "goal-outbox-origin",
                &channel.lease.id,
                desktop_done.task.goal_revision,
            )
            .await
            .expect("claim channel turn");
        let channel_done = manager
            .finalize_goal_scheduler_turn(
                "goal-outbox-origin",
                &channel.lease.id,
                true,
                None,
                1,
                None,
                Some("channel output".to_string()),
                true,
            )
            .await
            .expect("finalize channel turn");
        assert!(channel_done.delivery_enqueued);
        assert_eq!(channel_done.task.goal_delivery_outbox.len(), 1);
    }

    #[test]
    fn missing_channel_binding_does_not_ack_durable_delivery() {
        assert!(manager::goal_delivery_was_acknowledged(&Ok(true)));
        assert!(!manager::goal_delivery_was_acknowledged(&Ok(false)));
        assert!(!manager::goal_delivery_was_acknowledged(&Err(
            "temporary channel error".to_string()
        )));
    }

    #[test]
    fn goal_terminal_notification_respects_toggle_and_status() {
        let mut task = sample_goal_task("goal-notify", TaskStatus::Stopped, GoalStatus::Complete);
        assert!(execution::should_send_goal_terminal_notification(&task));
        task.notify_enabled = false;
        assert!(!execution::should_send_goal_terminal_notification(&task));
        task.notify_enabled = true;
        task.goal_status = Some(GoalStatus::Active);
        assert!(!execution::should_send_goal_terminal_notification(&task));
    }

    /// Fingerprint cases for `translate_unix_dow_to_crate_dow` — encodes the
    /// Unix→crate mapping that the rest of the app relies on.
    #[test]
    fn translate_dow_handles_singletons_ranges_lists_steps_names() {
        // Singletons
        assert_eq!(translate_unix_dow_to_crate_dow("0"), "1"); // Sunday
        assert_eq!(translate_unix_dow_to_crate_dow("7"), "1"); // Sunday alias
        assert_eq!(translate_unix_dow_to_crate_dow("1"), "2"); // Monday
        assert_eq!(translate_unix_dow_to_crate_dow("6"), "7"); // Saturday
                                                               // Wildcards
        assert_eq!(translate_unix_dow_to_crate_dow("*"), "*");
        assert_eq!(translate_unix_dow_to_crate_dow("?"), "?"); // Quartz wildcard, pass through
                                                               // Forward ranges (no Sunday-alias wrap)
        assert_eq!(translate_unix_dow_to_crate_dow("1-5"), "2-6"); // Mon-Fri
        assert_eq!(translate_unix_dow_to_crate_dow("0-6"), "*"); // all days, Unix Sun=0 form
        assert_eq!(translate_unix_dow_to_crate_dow("0-7"), "*"); // wraps → all days
        assert_eq!(translate_unix_dow_to_crate_dow("1-7"), "*"); // wraps → all days
                                                                 // Wrap-around ranges that hit Sunday-alias 7 — must enumerate, not
                                                                 // produce invalid descending crate ranges like "6-1"
        assert_eq!(translate_unix_dow_to_crate_dow("5-7"), "1,6,7"); // Fri-Sun
        assert_eq!(translate_unix_dow_to_crate_dow("2-7"), "1,3-7"); // Tue-Sun
                                                                     // Lists
        assert_eq!(translate_unix_dow_to_crate_dow("0,3,5"), "1,4,6");
        assert_eq!(translate_unix_dow_to_crate_dow("1,3,5"), "2,4,6");
        // Step values — must produce same days as the Unix expression
        // `*/2` Unix (0,2,4,6 = Sun/Tue/Thu/Sat) → crate (1,3,5,7 = same days)
        assert_eq!(translate_unix_dow_to_crate_dow("*/2"), "1,3,5,7");
        assert_eq!(translate_unix_dow_to_crate_dow("0/2"), "1,3,5,7");
        assert_eq!(translate_unix_dow_to_crate_dow("1-5/2"), "2,4,6"); // Mon,Wed,Fri
                                                                       // 1-7/2 Unix = Mon,Wed,Fri,Sun (NOT */2 phase). Must preserve phase.
        assert_eq!(translate_unix_dow_to_crate_dow("1-7/2"), "1,2,4,6");
        // Named days pass through unchanged (cron crate already accepts them)
        assert_eq!(translate_unix_dow_to_crate_dow("SUN"), "SUN");
        assert_eq!(translate_unix_dow_to_crate_dow("MON-FRI"), "MON-FRI");
    }

    /// Issue #166 regression — `0 21 * * 0` (every Sunday 21:00) must parse,
    /// and the next fire time must land on a Sunday at 21:00.
    #[test]
    fn issue_166_unix_sunday_cron_parses_and_fires_on_sunday() {
        // Validation succeeds (was failing with "Days of Week must be greater than or equal to 1")
        assert!(validate_cron_expression("0 21 * * 0", Some("UTC")).is_ok());
        assert!(validate_cron_expression("0 21 * * 7", Some("UTC")).is_ok());

        // Next fire is on a Sunday
        let next = next_cron_fire_time("0 21 * * 0", Some("UTC")).unwrap();
        assert_eq!(next.format("%A").to_string(), "Sunday");
        assert_eq!(next.format("%H:%M").to_string(), "21:00");
    }

    /// Issue #166 broader pattern — `1-5` (frontend "weekdays") must mean
    /// Mon-Fri, not Sun-Thu. Regression for the silent-mis-fire bug.
    #[test]
    fn weekdays_range_means_monday_through_friday() {
        let next = next_cron_fire_time("0 8 * * 1-5", Some("UTC")).unwrap();
        let weekday = next.format("%A").to_string();
        assert!(
            matches!(
                weekday.as_str(),
                "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday"
            ),
            "weekday cron should fire Mon-Fri, got {}",
            weekday
        );
    }

    /// 6-field input is treated as the cron crate's native sec-min-hour-dom-month-dow
    /// (no year). Previously the year wildcard was missing and the format!
    /// prepended `0` instead, producing 7 fields with everything off by one.
    #[test]
    fn six_field_cron_appends_year_wildcard() {
        // 6-field: sec=0, min=0, hour=21, dom=*, month=*, dow=1 (Sun in crate semantics)
        assert!(validate_cron_expression("0 0 21 * * 1", Some("UTC")).is_ok());
    }
}
