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
    ensure_session_sidecar, execute_cron_task, release_session_sidecar, CronExecutePayload,
    ManagedSidecarManager, ProviderEnv, SidecarOwner,
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
    cmd_get_workspace_cron_tasks, cmd_is_task_executing, cmd_mark_goal_terminal,
    cmd_mark_task_complete, cmd_mark_task_executing, cmd_pause_goal_task,
    cmd_record_cron_execution, cmd_resume_goal_task, cmd_start_cron_scheduler, cmd_start_cron_task,
    cmd_stop_cron_task, cmd_update_cron_task_fields, cmd_update_cron_task_session,
    cmd_update_cron_task_tab, cmd_update_goal_objective,
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
    CronDelivery, CronSchedule, CronTask, CronTaskConfig, EndConditions, GoalPausedReason,
    GoalStatus, ProviderIntent, RecurringWindow, RunMode, TaskProviderEnv, TaskStatus,
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
