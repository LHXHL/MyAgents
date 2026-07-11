use super::validation::validate_new_task_goal_shape;
use super::*;

fn is_goal_task(task: &CronTask) -> bool {
    task.is_goal()
}

fn is_goal_terminal(status: &GoalStatus) -> bool {
    status.is_terminal()
}

fn task_uses_session_automation(task: &CronTask, session_id: &str) -> bool {
    (task.session_id == session_id || task.internal_session_id.as_deref() == Some(session_id))
        && task.run_mode == RunMode::SingleSession
}

pub(crate) fn task_holds_persistent_session(task: &CronTask, session_id: &str) -> bool {
    let unfinished_goal = task.is_goal()
        && matches!(
            task.goal_status,
            Some(GoalStatus::Active | GoalStatus::Paused)
        );
    let owns_session =
        task.session_id == session_id || task.internal_session_id.as_deref() == Some(session_id);
    owns_session && (task.status == TaskStatus::Running || unfinished_goal)
}

fn goal_status_wire(status: &GoalStatus) -> &'static str {
    match status {
        GoalStatus::Active => "active",
        GoalStatus::Paused => "paused",
        GoalStatus::Complete => "complete",
        GoalStatus::Blocked => "blocked",
        GoalStatus::Canceled => "canceled",
    }
}

fn truncate_goal_delivery_text(text: &str) -> String {
    const MAX_BYTES: usize = 64 * 1024;
    if text.len() <= MAX_BYTES {
        return text.to_string();
    }
    let mut end = MAX_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

pub(super) fn goal_delivery_was_acknowledged(delivery: &Result<bool, String>) -> bool {
    matches!(delivery, Ok(true))
}

pub(super) fn goal_admission_change_kind(resumed: bool) -> &'static str {
    if resumed {
        "resumed"
    } else {
        "turn_admitted"
    }
}

fn invalidate_goal_turn_lease(task: &mut CronTask) {
    task.goal_turn_lease = None;
}

fn goal_sidecar_generation_is_current(
    sidecars: &ManagedSidecarManager,
    session_id: &str,
    expected_generation: u64,
) -> Result<bool, GoalMutationError> {
    let current = sidecars
        .lock()
        .map_err(|error| GoalMutationError::goal(format!("Sidecar lock poisoned: {error}")))?
        .generation_for(session_id);
    Ok(current == Some(expected_generation))
}

fn prepare_goal_create_config(
    mut config: CronTaskConfig,
) -> Result<CronTaskConfig, GoalMutationError> {
    let objective = config.prompt.trim().to_string();
    if objective.is_empty() {
        return Err(GoalMutationError::goal("Goal objective is required"));
    }
    if config.session_id.trim().is_empty() {
        return Err(GoalMutationError::goal("sessionId is required"));
    }
    if config.session_id.starts_with("pending-") {
        return Err(GoalMutationError::goal(
            "Goal requires a materialized session identity",
        ));
    }
    if config.workspace_path.trim().is_empty() {
        return Err(GoalMutationError::goal("workspacePath is required"));
    }

    let now = Utc::now();
    config.prompt = objective.clone();
    config.interval_minutes = config.interval_minutes.max(5);
    config.run_mode = RunMode::SingleSession;
    config.schedule = Some(CronSchedule::Loop);
    config.goal_status = Some(GoalStatus::Active);
    config.goal_objective = Some(objective);
    config.goal_updated_at = Some(now);
    config.goal_terminal_reason = None;
    config.goal_paused_reason = None;

    // Goal execution always follows the current session. Permission and end
    // policy remain explicit creation-surface choices; every other execution
    // snapshot belongs to the session owner and must not be persisted here.
    config.tab_id = None;
    config.model = None;
    config.provider_env = None;
    config.provider_id = None;
    config.provider_intent = ProviderIntent::FollowAgent;
    config.runtime = None;
    config.runtime_config = None;
    config.mcp_enabled_servers = None;
    config.managed_kind = None;
    config.source_bot_id = None;
    config.delivery = None;
    config.task_id = None;

    Ok(config)
}

fn build_cron_run_record(
    success: bool,
    duration_ms: u64,
    output_text: Option<&str>,
    error: Option<String>,
) -> CronRunRecord {
    const MAX_CONTENT_LEN: usize = 2000;
    let content = output_text.map(|text| {
        if text.len() <= MAX_CONTENT_LEN {
            return text.to_string();
        }
        let end = text
            .char_indices()
            .take_while(|(index, _)| *index < MAX_CONTENT_LEN)
            .last()
            .map(|(index, character)| index + character.len_utf8())
            .unwrap_or(MAX_CONTENT_LEN.min(text.len()));
        format!("{}...", &text[..end])
    });
    CronRunRecord {
        ts: Utc::now().timestamp_millis(),
        ok: success,
        duration_ms,
        content,
        error,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoopFailureDecision {
    RetryAfter(u64),
    Stop,
}

#[derive(Debug, Clone)]
struct GoalTurnFinalizationRequest {
    success: bool,
    error: Option<String>,
    duration_ms: u64,
    internal_session_id: Option<String>,
    output_text: Option<String>,
    channel_delivery_expected: bool,
}

#[cfg(not(test))]
pub(super) fn goal_durable_retry_delay() -> Duration {
    Duration::from_secs(3)
}

#[cfg(test)]
pub(super) fn goal_durable_retry_delay() -> Duration {
    Duration::from_millis(10)
}

async fn finalize_goal_turn_until_durable(
    manager: &CronTaskManager,
    shutdown: &Arc<RwLock<bool>>,
    task_id: &str,
    lease_id: &str,
    request: &GoalTurnFinalizationRequest,
) -> Option<GoalTurnFinalization> {
    loop {
        match manager
            .finalize_goal_scheduler_turn(
                task_id,
                lease_id,
                request.success,
                request.error.clone(),
                request.duration_ms,
                request.internal_session_id.clone(),
                request.output_text.clone(),
                request.channel_delivery_expected,
            )
            .await
        {
            Ok(finalization) => return Some(finalization),
            Err(error) => {
                ulog_error!(
                    "[CronTask] Goal turn finalization is not durable for task {} lease {}: {}; retrying",
                    task_id,
                    lease_id,
                    error
                );
            }
        }
        if *shutdown.read().await {
            return None;
        }
        tokio::time::sleep(goal_durable_retry_delay()).await;
    }
}

fn loop_failure_decision(consecutive_failures: u32) -> LoopFailureDecision {
    if consecutive_failures >= 10 {
        return LoopFailureDecision::Stop;
    }
    LoopFailureDecision::RetryAfter(match consecutive_failures {
        1 => 3,
        2 => 10,
        3 => 30,
        4 => 60,
        5 => 120,
        _ => 300,
    })
}

#[cfg(test)]
fn register_loop_failure(consecutive_failures: &mut u32) -> LoopFailureDecision {
    *consecutive_failures += 1;
    loop_failure_decision(*consecutive_failures)
}

async fn stop_loop_after_failure_limit(
    handle: &AppHandle,
    tasks: &Arc<RwLock<HashMap<String, CronTask>>>,
    shutdown: &Arc<RwLock<bool>>,
    task_id: &str,
    is_goal: bool,
    failure_kind: &str,
) {
    let reason = if is_goal {
        "Goal Mode: 10 consecutive failures"
    } else {
        "Loop task: 10 consecutive failures"
    };
    ulog_error!(
        "[CronTask] Task {} {} ({}), stopping",
        task_id,
        reason,
        failure_kind
    );
    let reason = Some(reason.to_string());
    if is_goal {
        loop {
            match get_cron_task_manager()
                .transition_goal_terminal(
                    task_id,
                    GoalStatus::Blocked,
                    reason.clone(),
                    GoalTerminalActor::System,
                )
                .await
            {
                Ok(_) => return,
                Err(error) => {
                    ulog_error!(
                        "[CronTask] Goal {} failure protector could not persist blocked state; retrying: {}",
                        task_id,
                        error
                    );
                }
            }
            let retry_at = Utc::now() + chrono::Duration::seconds(3);
            if !sleep_until_wallclock(retry_at, shutdown, task_id).await {
                return;
            }
        }
    } else {
        stop_task_internal(handle, tasks, task_id, reason).await;
    }
}

async fn record_run_if_task_alive(
    tasks: &Arc<RwLock<HashMap<String, CronTask>>>,
    task_id: &str,
    record: &CronRunRecord,
) {
    let tasks_guard = tasks.read().await;
    if tasks_guard.contains_key(task_id) {
        if let Err(error) = record_cron_run(task_id, record) {
            ulog_warn!("[CronTask] Failed to record run: {}", error);
        }
    } else {
        ulog_info!("[CronTask] Skip recording run for deleted task {}", task_id);
    }
}

#[derive(Debug, Clone)]
pub struct GoalSchedulerAdmission {
    pub task: CronTask,
    pub lease: GoalTurnLease,
    pub expected_revision: u64,
}

#[derive(Debug, Clone)]
pub struct GoalTurnFinalization {
    pub task: CronTask,
    pub applied: bool,
    pub delivery_enqueued: bool,
}

/// Manager for cron tasks
pub struct CronTaskManager {
    pub(crate) tasks: Arc<RwLock<HashMap<String, CronTask>>>,
    pub(super) storage_path: PathBuf,
    /// Flag to stop all scheduler loops
    pub(super) shutdown: Arc<RwLock<bool>>,
    /// Track which tasks are currently executing (for overlap prevention)
    pub(super) executing_tasks: Arc<RwLock<HashSet<String>>>,
    /// Track which tasks have active schedulers (prevents duplicate scheduler spawns)
    pub(super) active_schedulers: Arc<RwLock<HashSet<String>>>,
    /// JoinHandles for scheduler tasks — enables graceful shutdown
    pub(super) scheduler_handles:
        Arc<RwLock<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    /// One durable channel-outbox replay worker per Goal task.
    pub(super) goal_delivery_replayers: Arc<RwLock<HashSet<String>>>,
    /// Tauri app handle for emitting events (set after initialization)
    pub(super) app_handle: Arc<RwLock<Option<AppHandle>>>,
}

impl CronTaskManager {
    /// Create a new CronTaskManager with persistence at ~/.myagents/cron_tasks.json
    pub fn new() -> Self {
        let storage_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".myagents")
            .join("cron_tasks.json");

        // Load persisted tasks synchronously before creating the manager
        // This avoids the need for block_on with async locks
        let initial_tasks = Self::load_tasks_from_file(&storage_path);

        // PRD 0.2.5 cross-review I4 — run R3 migration in-memory at
        // construction time (synchronous), so the manager is correct from
        // the moment `get_cron_task_manager()` returns. Async migration in
        // `initialize_cron_manager` was racy with management_api startup.
        // The disk write is best-effort and happens lazily via the next
        // mutation (or eagerly via initialize_cron_manager), which is fine
        // because the migration is idempotent across restarts.
        let mut initial_tasks = initial_tasks;
        let migrated = Self::migrate_in_memory_legacy_auto_permission_mode(&mut initial_tasks);
        let recovered_goal_state = Self::recover_goal_leases_and_outbox(&mut initial_tasks);

        let task_count = initial_tasks.len();
        let manager = Self {
            tasks: Arc::new(RwLock::new(initial_tasks)),
            storage_path,
            shutdown: Arc::new(RwLock::new(false)),
            executing_tasks: Arc::new(RwLock::new(HashSet::new())),
            active_schedulers: Arc::new(RwLock::new(HashSet::new())),
            scheduler_handles: Arc::new(RwLock::new(HashMap::new())),
            goal_delivery_replayers: Arc::new(RwLock::new(HashSet::new())),
            app_handle: Arc::new(RwLock::new(None)),
        };

        if task_count > 0 {
            ulog_info!("[CronTask] Loaded {} tasks from disk", task_count);
        }
        if migrated > 0 {
            ulog_info!(
                "[CronTask] Migrated {} task(s) in-memory: permissionMode='auto' → '' (v0.2.5 R3); startup initialization will persist",
                migrated
            );
        }
        if recovered_goal_state > 0 {
            ulog_info!(
                "[CronTask] Recovered {} Goal lease/outbox state entries after restart",
                recovered_goal_state
            );
        }

        manager
    }

    pub(super) fn recover_goal_leases_and_outbox(tasks: &mut HashMap<String, CronTask>) -> usize {
        let mut recovered = 0;
        for task in tasks.values_mut().filter(|task| task.is_goal()) {
            let mut task_recovered = 0;
            let normalized_status = if task.goal_status.as_ref().is_some_and(is_goal_terminal) {
                TaskStatus::Stopped
            } else {
                TaskStatus::Running
            };
            if task.status != normalized_status {
                task.status = normalized_status;
                task_recovered += 1;
            }
            if task.goal_turn_lease.take().is_some() {
                task_recovered += 1;
            }
            if !task.goal_user_admissions.is_empty() {
                task.goal_user_admissions.clear();
                task_recovered += 1;
            }
            for item in &mut task.goal_delivery_outbox {
                if item.state == GoalDeliveryState::Sending {
                    item.state = GoalDeliveryState::Pending;
                    task_recovered += 1;
                }
            }
            if task_recovered > 0 {
                task.bump_goal_revision();
                recovered += task_recovered;
            }
        }
        recovered
    }

    async fn commit_goal_authority_revocations(
        &self,
        mut tasks: tokio::sync::RwLockWriteGuard<'_, HashMap<String, CronTask>>,
        next: HashMap<String, CronTask>,
        updated: Vec<CronTask>,
    ) -> Result<usize, String> {
        if updated.is_empty() {
            return Ok(0);
        }
        atomic_save_task_snapshot(
            &self.storage_path,
            next.values().cloned().collect::<Vec<_>>(),
        )
        .await?;
        *tasks = next;
        drop(tasks);
        for task in &updated {
            self.emit_goal_changed(task, "turn_revoked").await;
        }
        Ok(updated.len())
    }

    /// A claimed turn belongs to one concrete Sidecar process generation.
    /// A delayed stop for an older generation must not revoke replacement work.
    pub async fn revoke_goal_turn_authorities_for_sidecar(
        &self,
        session_id: &str,
        sidecar_generation: u64,
    ) -> Result<usize, String> {
        let tasks = self.tasks.write().await;
        let mut next = tasks.clone();
        let mut updated = Vec::new();
        let now = Utc::now();
        for task in next.values_mut().filter(|task| {
            task.is_goal()
                && (task.session_id == session_id
                    || task.internal_session_id.as_deref() == Some(session_id))
                && (task.goal_turn_lease.as_ref().is_some_and(|lease| {
                    lease.sidecar_generation == 0 || lease.sidecar_generation == sidecar_generation
                }) || task.goal_user_admissions.iter().any(|admission| {
                    admission.sidecar_generation == 0
                        || admission.sidecar_generation == sidecar_generation
                }))
        }) {
            if task.goal_turn_lease.as_ref().is_some_and(|lease| {
                lease.sidecar_generation == 0 || lease.sidecar_generation == sidecar_generation
            }) {
                task.goal_turn_lease = None;
            }
            task.goal_user_admissions.retain(|admission| {
                admission.sidecar_generation != 0
                    && admission.sidecar_generation != sidecar_generation
            });
            task.goal_updated_at = Some(now);
            task.updated_at = now;
            task.bump_goal_revision();
            updated.push(task.clone());
        }
        self.commit_goal_authority_revocations(tasks, next, updated)
            .await
    }

    /// Recover from skipped Sidecar stop broadcasts by comparing each durable
    /// authority's process generation with the current Sidecar registry.
    /// Lock order is task store -> Sidecar manager, matching the project owner
    /// hierarchy and preventing a new authority from appearing between the
    /// live snapshot and the durable mutation.
    pub async fn reconcile_goal_turn_authorities_with_live_sidecars(
        &self,
        sidecars: &ManagedSidecarManager,
    ) -> Result<usize, String> {
        let tasks = self.tasks.write().await;
        let live = sidecars
            .lock()
            .map_err(|error| format!("Sidecar lock poisoned: {error}"))?
            .live_sidecar_set();
        let mut next = tasks.clone();
        let mut updated = Vec::new();
        let now = Utc::now();
        for task in next.values_mut().filter(|task| task.is_goal()) {
            let generation_is_live = |generation: u64| {
                generation != 0
                    && (live.contains(&(task.session_id.clone(), generation))
                        || task.internal_session_id.as_ref().is_some_and(|session_id| {
                            live.contains(&(session_id.clone(), generation))
                        }))
            };
            let lease_revoked = task
                .goal_turn_lease
                .as_ref()
                .is_some_and(|lease| !generation_is_live(lease.sidecar_generation));
            if lease_revoked {
                task.goal_turn_lease = None;
            }
            let previous_admission_count = task.goal_user_admissions.len();
            task.goal_user_admissions
                .retain(|admission| generation_is_live(admission.sidecar_generation));
            if !lease_revoked && task.goal_user_admissions.len() == previous_admission_count {
                continue;
            }
            task.goal_updated_at = Some(now);
            task.updated_at = now;
            task.bump_goal_revision();
            updated.push(task.clone());
        }
        self.commit_goal_authority_revocations(tasks, next, updated)
            .await
    }

    /// PRD 0.2.5 cross-review I4 — sync, in-memory portion of the legacy
    /// `permission_mode = "auto"` migration. Runs at construction time so
    /// the manager state is correct before any async caller (management
    /// API, scheduler) can read it. Disk persistence happens lazily.
    /// Returns the number of migrated tasks.
    fn migrate_in_memory_legacy_auto_permission_mode(
        tasks: &mut HashMap<String, CronTask>,
    ) -> usize {
        let mut migrated = 0usize;
        for task in tasks.values_mut() {
            if task.permission_mode == "auto" {
                task.permission_mode = String::new();
                migrated += 1;
            }
        }
        migrated
    }

    /// Load tasks from file synchronously (used during initialization)
    /// Returns empty HashMap on any error (logged as warning)
    /// Uses per-task fallback: if whole-store parse fails, tries parsing tasks individually
    fn load_tasks_from_file(storage_path: &PathBuf) -> HashMap<String, CronTask> {
        if !storage_path.exists() {
            return HashMap::new();
        }

        let content = match fs::read_to_string(storage_path) {
            Ok(c) => c,
            Err(e) => {
                ulog_warn!("[CronTask] Failed to read cron tasks file: {}", e);
                return HashMap::new();
            }
        };

        // Tolerate UTF-8 BOM if the user manually edited cron_tasks.json with
        // a Windows editor — without strip_bom we'd take the per-task fallback
        // path below for nothing (issue #170 #6).
        let content_no_bom = strip_bom(&content);

        // Try whole-store deserialization first (fast path)
        match serde_json::from_str::<CronTaskStore>(content_no_bom) {
            Ok(store) => {
                let result: HashMap<String, CronTask> =
                    store.tasks.into_iter().map(|t| (t.id.clone(), t)).collect();
                // PRD 0.2.9 R9 — Count tasks still carrying the deprecated
                // `provider_env` snapshot (apiKey + baseUrl frozen at create
                // time). The sidecar live-resolves provider_id on every tick
                // for new tasks; legacy ones still work via the legacy
                // `Explicit` intent path until the user re-saves them.
                let legacy_count = result
                    .values()
                    .filter(|t| t.provider_env.is_some() && t.provider_id.is_none())
                    .count();
                if legacy_count > 0 {
                    ulog_info!(
                        "[CronTask] {} legacy task(s) still carry frozen provider_env (PRD 0.2.9). They run via legacy Explicit intent until re-saved. Edit & save once in 任务编辑 to migrate to live-resolve.",
                        legacy_count
                    );
                }
                return result;
            }
            Err(e) => {
                ulog_warn!(
                    "[CronTask] Whole-store parse failed ({}), trying per-task fallback",
                    e
                );
            }
        }

        // Fallback: parse as raw JSON value, then deserialize tasks individually
        let raw: serde_json::Value = match serde_json::from_str(content_no_bom) {
            Ok(v) => v,
            Err(e) => {
                ulog_warn!(
                    "[CronTask] Failed to parse cron tasks as JSON at all: {}",
                    e
                );
                return HashMap::new();
            }
        };

        let tasks_array = match raw.get("tasks").and_then(|v| v.as_array()) {
            Some(arr) => arr,
            None => {
                ulog_warn!("[CronTask] No 'tasks' array found in cron_tasks.json");
                return HashMap::new();
            }
        };

        let mut result = HashMap::new();
        let mut skipped = 0u32;
        for (i, task_val) in tasks_array.iter().enumerate() {
            match serde_json::from_value::<CronTask>(task_val.clone()) {
                Ok(task) => {
                    result.insert(task.id.clone(), task);
                }
                Err(e) => {
                    let task_id = task_val
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    ulog_warn!(
                        "[CronTask] Skipping corrupted task[{}] id={}: {}",
                        i,
                        task_id,
                        e
                    );
                    skipped += 1;
                }
            }
        }

        if skipped > 0 {
            ulog_warn!(
                "[CronTask] Per-task fallback: loaded {} tasks, skipped {} corrupted",
                result.len(),
                skipped
            );
        }

        result
    }

    /// Set the Tauri app handle for emitting events
    /// Must be called during app setup before starting any tasks
    pub async fn set_app_handle(&self, handle: AppHandle) {
        let mut app_handle = self.app_handle.write().await;
        *app_handle = Some(handle);
        ulog_info!("[CronTask] App handle set");
    }

    /// Start the scheduler for a task
    /// This spawns a background tokio task that directly executes via Sidecar at intervals
    pub async fn start_task_scheduler(&self, task_id: &str) -> Result<(), String> {
        let task = self
            .get_task(task_id)
            .await
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if task.status != TaskStatus::Running {
            return Err(format!("Task {} is not in running status", task_id));
        }

        // Liveness check + reservation must be atomic.
        //
        // Why a single critical section (v0.1.69 M2 → cross-review follow-up):
        // The prior shape split the check (read `active_schedulers`), the
        // cleanup (write both maps), and the spawn+store (separate `tokio::spawn`
        // followed by `scheduler_handles.write()`) into three serialisable
        // sections. Two concurrent callers for the same task_id could each
        // observe the other's intermediate state:
        //   - both see `active` without the task_id → both insert → both spawn
        //     → the second `scheduler_handles.insert()` overwrites the first
        //     JoinHandle → first tokio task orphaned, un-joinable, running
        //     forever in parallel with the second.
        //   - one sees "active but handle missing" (caller A between its own
        //     active-insert and handle-insert) and judges that entry stale,
        //     cleaning it up and spawning a duplicate.
        // Fix: hold `scheduler_handles.write()` across the whole flow
        // (check → cleanup → reserve → spawn → store). The scheduler body
        // itself never touches `scheduler_handles`, and `shutdown_all()` (the
        // only other writer) already expects to wait for in-flight starts —
        // so holding the write lock across `tokio::spawn` is safe.
        //
        // `active_schedulers` is retained as legacy bookkeeping used by
        // shutdown paths elsewhere; we keep it synced inside the same
        // critical section.
        let mut handles_guard = self.scheduler_handles.write().await;
        if let Some(existing) = handles_guard.get(task_id) {
            // `tauri::async_runtime::JoinHandle` wraps `tokio::task::JoinHandle`;
            // `is_finished` lives on the inner one (the wrapper exposes Future +
            // `abort()` only).
            if !existing.inner().is_finished() {
                ulog_info!(
                    "[CronTask] Scheduler already running for task {}, skipping",
                    task_id
                );
                return Ok(());
            }
            // Stale: previous tokio task panicked / aborted / returned early
            // without passing through our cleanup path. Drop the dead handle
            // before respawning so the `.insert()` at the end overwrites a
            // known-finished entry (never a live one).
            ulog_warn!(
                "[CronTask] Scheduler handle for task {} was finished — respawning",
                task_id
            );
            handles_guard.remove(task_id);
        }
        {
            let mut active = self.active_schedulers.write().await;
            active.insert(task_id.to_string());
        }

        let tasks = Arc::clone(&self.tasks);
        let shutdown = Arc::clone(&self.shutdown);
        let executing_tasks = Arc::clone(&self.executing_tasks);
        let active_schedulers = Arc::clone(&self.active_schedulers);
        let app_handle = Arc::clone(&self.app_handle);
        let storage_path = self.storage_path.clone();
        let task_id_owned = task_id.to_string();
        let schedule = task.schedule.clone();
        let is_goal = task.is_goal();
        let interval_mins = match &schedule {
            Some(CronSchedule::Every { minutes, .. }) => *minutes,
            _ => task.interval_minutes,
        };
        let last_executed = task.last_executed_at;
        let execution_count = task.execution_count;
        let task_id_for_handle = task_id.to_string();

        // Spawn the scheduler loop and store the JoinHandle for graceful shutdown
        let handle = tauri::async_runtime::spawn(async move {
            ulog_info!(
                "[CronTask] Scheduler started for task {} (interval: {} min, executions: {})",
                task_id_owned,
                interval_mins,
                execution_count
            );

            // Wait for app_handle to be available (with timeout)
            // This handles the race condition where scheduler starts before initialize_cron_manager completes
            let mut app_handle_ready = false;
            for i in 0..50 {
                // 5 seconds max wait (50 * 100ms)
                let handle_opt = app_handle.read().await;
                if handle_opt.is_some() {
                    app_handle_ready = true;
                    break;
                }
                drop(handle_opt);
                if i == 0 {
                    ulog_warn!(
                        "[CronTask] App handle not ready for task {}, waiting...",
                        task_id_owned
                    );
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }

            if !app_handle_ready {
                ulog_error!("[CronTask] App handle not available after 5 seconds, aborting scheduler for task {}", task_id_owned);
                // Clean up: remove from active schedulers
                {
                    let mut active = active_schedulers.write().await;
                    active.remove(&task_id_owned);
                }
                return;
            }

            // Emit scheduler started event to frontend
            {
                let handle_opt = app_handle.read().await;
                if let Some(ref handle) = *handle_opt {
                    let _ = handle.emit(
                        "cron:scheduler-started",
                        serde_json::json!({
                            "taskId": task_id_owned,
                            "intervalMinutes": interval_mins,
                            "executionCount": execution_count
                        }),
                    );
                }
            }

            // Calculate initial wait time
            // For CronSchedule::At — calculate delay until target time, then one-shot
            // For CronSchedule::Cron — compute next fire time from cron expression
            let is_one_shot = matches!(&schedule, Some(CronSchedule::At { .. }));
            let is_cron_expr = matches!(&schedule, Some(CronSchedule::Cron { .. }));
            let is_loop = matches!(&schedule, Some(CronSchedule::Loop));
            let cron_expr_info = match &schedule {
                Some(CronSchedule::Cron { expr, tz }) => Some((expr.clone(), tz.clone())),
                _ => None,
            };
            let interval_secs = interval_mins.max(5) as i64 * 60;
            // Compute initial target as a wall-clock time (not a Duration).
            // This is critical: we use sleep_until_wallclock() which polls Utc::now()
            // instead of tokio::time::sleep() which uses monotonic time that pauses
            // during system sleep/suspend.
            let initial_target: Option<DateTime<Utc>> = if is_loop {
                // Goal Mode: execute immediately (2s startup delay)
                ulog_info!(
                    "[CronTask] Task {} Goal Mode loop, executing in 2 seconds",
                    task_id_owned
                );
                Some(Utc::now() + chrono::Duration::seconds(2))
            } else if let Some(CronSchedule::At { ref at }) = schedule {
                // One-shot: target is the specified time
                match DateTime::parse_from_rfc3339(at)
                    .or_else(|_| DateTime::parse_from_str(at, "%Y-%m-%dT%H:%M:%S"))
                {
                    Ok(target) => {
                        let target_utc = target.with_timezone(&Utc);
                        let now = Utc::now();
                        if target_utc > now {
                            ulog_info!(
                                "[CronTask] Task {} scheduled at {}, waiting {} seconds",
                                task_id_owned,
                                at,
                                (target_utc - now).num_seconds()
                            );
                            Some(target_utc)
                        } else {
                            ulog_info!("[CronTask] Task {} target time {} already passed, executing immediately", task_id_owned, at);
                            Some(now + chrono::Duration::seconds(2))
                        }
                    }
                    Err(e) => {
                        ulog_warn!(
                            "[CronTask] Task {} invalid 'at' time '{}': {}, executing in 2s",
                            task_id_owned,
                            at,
                            e
                        );
                        Some(Utc::now() + chrono::Duration::seconds(2))
                    }
                }
            } else if let Some(CronSchedule::Cron { ref expr, ref tz }) = schedule {
                // Cron expression: compute next fire time from wall clock
                match next_cron_fire_time(expr, tz.as_deref()) {
                    Ok(target) => {
                        ulog_info!("[CronTask] Task {} cron expr '{}' (tz={:?}), next fire at {} (in {} seconds)",
                            task_id_owned, expr, tz, target, (target - Utc::now()).num_seconds());
                        Some(target)
                    }
                    Err(e) => {
                        ulog_error!(
                            "[CronTask] Task {} invalid cron config: {}, stopping scheduler",
                            task_id_owned,
                            e
                        );
                        {
                            let mut active = active_schedulers.write().await;
                            active.remove(&task_id_owned);
                        }
                        return;
                    }
                }
            } else if let Some(CronSchedule::Every {
                start_at: Some(ref sa),
                catch_up_window,
                ..
            }) = schedule
            {
                // Every with start_at: wait until the specified start time for first execution
                if execution_count == 0 {
                    match DateTime::parse_from_rfc3339(sa) {
                        Ok(target) => {
                            let target_utc = target.with_timezone(&Utc);
                            let now = Utc::now();
                            if target_utc > now {
                                ulog_info!(
                                    "[CronTask] Task {} delayed start at {}, waiting {} seconds",
                                    task_id_owned,
                                    sa,
                                    (target_utc - now).num_seconds()
                                );
                                Some(target_utc)
                            } else {
                                let next = resolve_missed_interval_target(
                                    target_utc,
                                    interval_secs,
                                    now,
                                    catch_up_window.as_ref(),
                                    2,
                                );
                                ulog_info!(
                                    "[CronTask] Task {} start time {} already passed; next anchored execution at {}",
                                    task_id_owned,
                                    sa,
                                    next
                                );
                                Some(next)
                            }
                        }
                        Err(_) => {
                            ulog_warn!(
                                "[CronTask] Task {} invalid start_at '{}', starting in 2 seconds",
                                task_id_owned,
                                sa
                            );
                            Some(Utc::now() + chrono::Duration::seconds(2))
                        }
                    }
                } else if let Some(last_exec) = last_executed {
                    let next_exec = last_exec + chrono::Duration::seconds(interval_secs);
                    let now = Utc::now();
                    let next_exec = if next_exec > now {
                        next_exec
                    } else {
                        resolve_missed_interval_target(
                            next_exec,
                            interval_secs,
                            now,
                            catch_up_window.as_ref(),
                            5,
                        )
                    };
                    Some(next_exec)
                } else {
                    Some(Utc::now() + chrono::Duration::seconds(2))
                }
            } else if execution_count == 0 {
                ulog_info!(
                    "[CronTask] Task {} first execution, starting in 2 seconds",
                    task_id_owned
                );
                Some(Utc::now() + chrono::Duration::seconds(2))
            } else if let Some(last_exec) = last_executed {
                let next_exec = last_exec + chrono::Duration::seconds(interval_secs);
                let now = Utc::now();
                if next_exec > now {
                    ulog_info!("[CronTask] Task {} next execution at {} (in {} seconds, based on lastExecutedAt)",
                        task_id_owned, next_exec, (next_exec - now).num_seconds());
                    Some(next_exec)
                } else {
                    ulog_info!(
                        "[CronTask] Task {} is past due, executing in 5 seconds",
                        task_id_owned
                    );
                    Some(now + chrono::Duration::seconds(5))
                }
            } else {
                ulog_info!(
                    "[CronTask] Task {} no lastExecutedAt but count={}, waiting full interval",
                    task_id_owned,
                    execution_count
                );
                Some(Utc::now() + chrono::Duration::seconds(interval_secs))
            };

            // Goal Mode loop: track consecutive failures for exponential backoff
            let mut loop_consecutive_failures: u32 = 0;

            // Wait for initial period using wall-clock polling (survives system sleep)
            if let Some(target) = initial_target {
                if !sleep_until_wallclock(target, &shutdown, &task_id_owned).await {
                    // Shutdown requested during wait
                    let mut active = active_schedulers.write().await;
                    active.remove(&task_id_owned);
                    return;
                }
            }

            loop {
                // Check shutdown flag
                {
                    let shutdown_flag = shutdown.read().await;
                    if *shutdown_flag {
                        ulog_info!("[CronTask] Scheduler shutdown for task {}", task_id_owned);
                        break;
                    }
                }

                // Check task status
                let task_opt = {
                    let tasks_guard = tasks.read().await;
                    tasks_guard.get(&task_id_owned).cloned()
                };

                let mut task = match task_opt {
                    Some(t) => t,
                    None => {
                        ulog_info!(
                            "[CronTask] Task {} no longer exists, stopping scheduler",
                            task_id_owned
                        );
                        break;
                    }
                };

                // Only execute if task is still running
                if task.status != TaskStatus::Running {
                    ulog_info!(
                        "[CronTask] Task {} status changed to {:?}, stopping scheduler",
                        task_id_owned,
                        task.status
                    );
                    break;
                }

                if is_goal && task.goal_status.as_ref().is_some_and(is_goal_terminal) {
                    ulog_info!(
                        "[CronTask] Task {} Goal Mode reached terminal status {:?}, stopping scheduler",
                        task_id_owned,
                        task.goal_status
                    );
                    break;
                }

                if is_goal && task.goal_status == Some(GoalStatus::Paused) {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }

                // Check end conditions before execution
                let should_complete = check_end_conditions_static(&task);
                if should_complete {
                    ulog_info!(
                        "[CronTask] Task {} reached end condition, completing",
                        task_id_owned
                    );
                    // Complete task and release its CronTask owner/projection.
                    if is_goal {
                        let _ = get_cron_task_manager()
                            .transition_goal_terminal(
                                &task_id_owned,
                                GoalStatus::Canceled,
                                Some("Goal end condition reached".to_string()),
                                GoalTerminalActor::System,
                            )
                            .await;
                    } else {
                        let handle = app_handle.read().await.clone();
                        if let Some(ref handle) = handle {
                            stop_task_internal(handle, &tasks, &task_id_owned, None).await;
                        }
                    }
                    break;
                }

                // Get app handle for execution (BEFORE reserving the
                // executing slot — if no handle, no point holding the lock).
                let handle_opt = {
                    let handle_guard = app_handle.read().await;
                    handle_guard.clone()
                };

                let Some(handle) = handle_opt else {
                    ulog_error!(
                        "[CronTask] No app handle available for task {}, will retry next interval",
                        task_id_owned
                    );
                    // Short wait before retrying (prevents tight loop)
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                };

                // PRD 0.2.5 cross-review C4 — atomic check-and-insert under
                // a single write lock. Closes the TOCTOU window where a
                // concurrent `trigger_now` could double-fire.
                let reserved = {
                    let mut executing = executing_tasks.write().await;
                    if executing.contains(&task_id_owned) {
                        false
                    } else {
                        executing.insert(task_id_owned.clone());
                        true
                    }
                };
                if !reserved {
                    ulog_warn!(
                        "[CronTask] Task {} is still executing, skipping this interval",
                        task_id_owned
                    );
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                }

                let goal_lease_id = if is_goal {
                    let manager = get_cron_task_manager();
                    match manager
                        .admit_goal_scheduler_turn(&task_id_owned, task.goal_revision)
                        .await
                    {
                        Ok(admission) => {
                            let lease_id = admission.lease.id.clone();
                            task = admission.task;
                            Some(lease_id)
                        }
                        Err(error) => {
                            let mut executing = executing_tasks.write().await;
                            executing.remove(&task_id_owned);
                            drop(executing);
                            ulog_info!(
                                "[CronTask] Goal turn admission skipped for {}: {}",
                                task_id_owned,
                                error
                            );
                            tokio::time::sleep(Duration::from_secs(1)).await;
                            continue;
                        }
                    }
                } else {
                    None
                };

                let execution_number = if is_goal {
                    task.goal_turn_number_for_dispatch()
                } else {
                    task.execution_count + 1
                };
                let is_first = execution_number == 1;
                ulog_info!(
                    "[CronTask] Executing task {} (execution #{})",
                    task_id_owned,
                    execution_number
                );

                // Emit execution starting event to frontend
                let _ = handle.emit(
                    "cron:execution-starting",
                    serde_json::json!({
                        "taskId": task_id_owned,
                        "executionNumber": execution_number,
                        "isFirstExecution": is_first
                    }),
                );

                ulog_info!(
                    "[CronTask] About to call execute_task_directly for task {}",
                    task_id_owned
                );

                // Emit debug event for frontend visibility
                let _ = handle.emit(
                    "cron:debug",
                    serde_json::json!({
                        "taskId": task_id_owned,
                        "message": "About to call execute_task_directly"
                    }),
                );

                // Execute directly via Sidecar with timeout to prevent indefinite hanging
                let exec_start = std::time::Instant::now();
                let execution_result = tokio::time::timeout(
                    Duration::from_secs(3600), // 60 minutes timeout
                    execute_task_directly(&handle, &task, is_first),
                )
                .await;

                let execution_result = match execution_result {
                    Ok(result) => result,
                    Err(_) => {
                        ulog_error!(
                            "[CronTask] Task {} execution timed out after 60 minutes",
                            task_id_owned
                        );
                        let _ = handle.emit(
                            "cron:debug",
                            serde_json::json!({
                                "taskId": task_id_owned,
                                "message": "Execution timed out after 60 minutes",
                                "error": true
                            }),
                        );
                        Err("Execution timed out".to_string())
                    }
                };
                let duration_ms = exec_start.elapsed().as_millis() as u64;
                let mut loop_retry_delay_secs = None;

                // Detect graceful terminal-state short-circuit (H2 sentinel).
                // Pulled out of the match below so every side-effect arm can
                // short-circuit uniformly without re-parsing the prefix.
                let terminal_stop =
                    matches!(&execution_result, Err(e) if e.starts_with(TERMINAL_STOP_SENTINEL));

                // Ordinary Cron records immediately. Goal records only after
                // lease finalization below, so a paused/edited/canceled turn
                // whose output is discarded cannot appear as a successful run.
                if !is_goal {
                    match &execution_result {
                        Ok((success, _, output_text, _, _)) => {
                            let run_record = build_cron_run_record(
                                *success,
                                duration_ms,
                                output_text.as_deref(),
                                None,
                            );
                            record_run_if_task_alive(&tasks, &task_id_owned, &run_record).await;
                        }
                        Err(_) if terminal_stop => {
                            // Graceful stop — `stop_task()` was already called
                            // inside `execute_task_directly`. Skipping the
                            // JSONL write keeps "最近一次" stats clean.
                        }
                        Err(ref e) => {
                            let run_record =
                                build_cron_run_record(false, duration_ms, None, Some(e.clone()));
                            record_run_if_task_alive(&tasks, &task_id_owned, &run_record).await;
                        }
                    }
                }

                // Log the actual execution outcome (not just is_ok which only means "no Rust error")
                match &execution_result {
                    Ok((success, _, _, _, _)) => {
                        ulog_info!("[CronTask] execute_task_directly completed for task {}: task_success={}", task_id_owned, success);
                        let _ = handle.emit("cron:debug", serde_json::json!({
                            "taskId": task_id_owned,
                            "message": format!("execute_task_directly completed: task_success={}", success)
                        }));
                    }
                    Err(_) if terminal_stop => {
                        // Already logged at `ulog_warn!` inside the guard —
                        // no additional "failed" log/emit so the user's log
                        // timeline shows one clean stop, not a stop + a
                        // redundant failure.
                    }
                    Err(ref e) => {
                        ulog_warn!(
                            "[CronTask] execute_task_directly failed for task {}: {}",
                            task_id_owned,
                            e
                        );
                        let _ = handle.emit(
                            "cron:debug",
                            serde_json::json!({
                                "taskId": task_id_owned,
                                "message": format!("execute_task_directly failed: {}", e),
                                "error": true
                            }),
                        );
                    }
                }

                // Mark task as no longer executing
                {
                    let mut executing = executing_tasks.write().await;
                    executing.remove(&task_id_owned);
                }

                // Handle execution result
                match execution_result {
                    Ok((
                        success,
                        ai_exit_reason,
                        output_text,
                        internal_sid,
                        goal_channel_delivery_expected,
                    )) => {
                        // Update execution count, last_executed_at, and internal_session_id
                        let updated_execution_count;
                        let updated_goal_task;
                        let goal_delivery_enqueued;
                        if is_goal {
                            let lease_id = goal_lease_id
                                .as_deref()
                                .expect("Goal dispatch must have a claimed lease");
                            let finalization_request = GoalTurnFinalizationRequest {
                                success,
                                error: None,
                                duration_ms,
                                internal_session_id: internal_sid.clone(),
                                output_text: output_text.clone(),
                                channel_delivery_expected: goal_channel_delivery_expected,
                            };
                            let Some(finalization) = finalize_goal_turn_until_durable(
                                get_cron_task_manager(),
                                &shutdown,
                                &task_id_owned,
                                lease_id,
                                &finalization_request,
                            )
                            .await
                            else {
                                break;
                            };
                            if !finalization.applied {
                                ulog_info!(
                                    "[CronTask] Discarding stale Goal completion/output for task {} lease {}",
                                    task_id_owned,
                                    lease_id
                                );
                                continue;
                            }
                            let run_record = build_cron_run_record(
                                success,
                                duration_ms,
                                output_text.as_deref(),
                                None,
                            );
                            record_run_if_task_alive(&tasks, &task_id_owned, &run_record).await;
                            updated_execution_count = finalization.task.execution_count;
                            goal_delivery_enqueued = finalization.delivery_enqueued;
                            updated_goal_task = Some(finalization.task);
                        } else {
                            let mut tasks_guard = tasks.write().await;
                            if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                                let now = Utc::now();
                                t.execution_count += 1;
                                t.last_executed_at = Some(now);
                                t.updated_at = now;
                                t.last_error = None;
                                // PRD 0.2.5 R6 — denormalized last-run summary
                                // for `cron list` (no jsonl read on list path).
                                t.last_run_ok = Some(success);
                                t.last_run_duration_ms = Some(duration_ms);
                                // Track the internal SDK session ID for frontend session loading
                                if internal_sid.is_some() {
                                    t.internal_session_id = internal_sid.clone();
                                }
                                updated_execution_count = t.execution_count;
                                updated_goal_task = None;
                            } else {
                                updated_execution_count = task.execution_count + 1;
                                updated_goal_task = None;
                            }
                            goal_delivery_enqueued = false;
                        }

                        // Goal Mode loop: reset failure counter on success, increment on logical failure
                        if is_loop {
                            if success {
                                if !is_goal {
                                    loop_consecutive_failures = 0;
                                }
                            } else {
                                let failure_count = updated_goal_task
                                    .as_ref()
                                    .map(|task| task.goal_consecutive_failures)
                                    .unwrap_or_else(|| {
                                        loop_consecutive_failures =
                                            loop_consecutive_failures.saturating_add(1);
                                        loop_consecutive_failures
                                    });
                                match loop_failure_decision(failure_count) {
                                    LoopFailureDecision::Stop => {
                                        stop_loop_after_failure_limit(
                                            &handle,
                                            &tasks,
                                            &shutdown,
                                            &task_id_owned,
                                            is_goal,
                                            "logical",
                                        )
                                        .await;
                                        break;
                                    }
                                    LoopFailureDecision::RetryAfter(delay_secs) => {
                                        loop_retry_delay_secs = Some(delay_secs);
                                        ulog_warn!("[CronTask] Task {} Loop logical failure #{}, backoff {}s",
                                            task_id_owned, failure_count, delay_secs);
                                    }
                                }
                            }
                        }

                        // Emit execution-complete for ALL success paths
                        // (one-shot, AI exit, end condition, and normal continue)
                        // Must happen before any break so frontend always gets the update
                        ulog_info!("[CronTask] Emitting cron:execution-complete for task {} with executionCount={}", task_id_owned, updated_execution_count);
                        let _ = handle.emit(
                            "cron:execution-complete",
                            serde_json::json!({
                                "taskId": task_id_owned,
                                "success": success,
                                "executionCount": updated_execution_count,
                                "internalSessionId": internal_sid
                            }),
                        );
                        if goal_delivery_enqueued {
                            get_cron_task_manager()
                                .ensure_goal_delivery_replay(&task_id_owned)
                                .await;
                        }

                        // Deliver results to IM Bot + wake heartbeat (v0.1.21)
                        // Use actual AI output when available, fallback to generic summary
                        if let Some(ref delivery) = task.delivery {
                            let content = output_text.unwrap_or_else(|| {
                                if success {
                                    format!(
                                        "Cron task '{}' completed successfully.",
                                        task.name.as_deref().unwrap_or(&task_id_owned)
                                    )
                                } else {
                                    format!(
                                        "Cron task '{}' completed with issues.",
                                        task.name.as_deref().unwrap_or(&task_id_owned)
                                    )
                                }
                            });
                            // Pass the run's actual session id (not a re-read of
                            // task.session_id) so a concurrent trigger_now that
                            // rotated session_id between L1588 (executing cleared)
                            // and here can't smuggle the wrong id into the
                            // follow-up envelope. #225 review (Codex).
                            deliver_cron_result_to_bot(
                                &handle,
                                delivery,
                                &task_id_owned,
                                &content,
                                internal_sid.as_deref(),
                            )
                            .await;
                        }

                        // Check if AI requested exit
                        if let Some(reason) = ai_exit_reason {
                            if is_goal {
                                ulog_warn!(
                                    "[CronTask] Ignoring legacy cron exit for explicit Goal {}",
                                    task_id_owned
                                );
                            } else {
                                ulog_info!(
                                    "[CronTask] Task {} AI requested exit: {}",
                                    task_id_owned,
                                    reason
                                );
                                stop_task_internal(&handle, &tasks, &task_id_owned, Some(reason))
                                    .await;
                                break;
                            }
                        }

                        // One-shot tasks (CronSchedule::At) auto-delete after first execution
                        if is_one_shot {
                            ulog_info!("[CronTask] Task {} is one-shot (schedule::at), auto-deleting after execution", task_id_owned);
                            stop_task_internal(
                                &handle,
                                &tasks,
                                &task_id_owned,
                                Some("One-shot task completed".to_string()),
                            )
                            .await;
                            // Remove from persistence (CT-08: one-shot tasks auto-delete)
                            {
                                let mut tasks_guard = tasks.write().await;
                                tasks_guard.remove(&task_id_owned);
                            }
                            let manager = get_cron_task_manager();
                            if let Err(e) = manager.save_to_disk().await {
                                ulog_warn!(
                                    "[CronTask] Failed to save after one-shot deletion: {}",
                                    e
                                );
                            }
                            break;
                        }

                        // Check end conditions after execution
                        let should_stop = {
                            let tasks_guard = tasks.read().await;
                            tasks_guard
                                .get(&task_id_owned)
                                .map(|t| check_end_conditions_static(t))
                                .unwrap_or(false)
                        };
                        if should_stop {
                            ulog_info!(
                                "[CronTask] Task {} reached end condition after execution",
                                task_id_owned
                            );
                            if is_goal {
                                let _ = get_cron_task_manager()
                                    .transition_goal_terminal(
                                        &task_id_owned,
                                        GoalStatus::Canceled,
                                        Some("Goal end condition reached".to_string()),
                                        GoalTerminalActor::System,
                                    )
                                    .await;
                            } else {
                                stop_task_internal(&handle, &tasks, &task_id_owned, None).await;
                            }
                            break;
                        }
                    }
                    Err(e) if e.starts_with(TERMINAL_STOP_SENTINEL) => {
                        if is_goal {
                            if let Some(lease_id) = goal_lease_id.as_deref() {
                                let manager = get_cron_task_manager();
                                let request = GoalTurnFinalizationRequest {
                                    success: false,
                                    error: Some(e.clone()),
                                    duration_ms,
                                    internal_session_id: None,
                                    output_text: None,
                                    channel_delivery_expected: false,
                                };
                                if finalize_goal_turn_until_durable(
                                    manager,
                                    &shutdown,
                                    &task_id_owned,
                                    lease_id,
                                    &request,
                                )
                                .await
                                .is_none()
                                {
                                    break;
                                }
                            }
                        }
                        // Graceful stop via H2 sentinel — `stop_task()` was
                        // already called inside `execute_task_directly`, so
                        // the CronTask is now Stopped. The next loop
                        // iteration's status check (line ~964) will break.
                        // Skip `last_error` + `cron:execution-error` so the
                        // UI doesn't briefly show this as a failed tick.
                        // Also skip the Goal Mode backoff branch — this is
                        // a terminal stop, not a retryable failure.
                        ulog_info!(
                            "[CronTask] Task {} exited via terminal-stop sentinel: {}",
                            task_id_owned,
                            e.trim_start_matches(TERMINAL_STOP_SENTINEL)
                        );
                    }
                    Err(e) => {
                        ulog_error!("[CronTask] Task {} execution failed: {}", task_id_owned, e);
                        let mut persisted_goal_failure_count = None;
                        if is_goal {
                            let lease_id = goal_lease_id
                                .as_deref()
                                .expect("Goal dispatch must have a claimed lease");
                            let request = GoalTurnFinalizationRequest {
                                success: false,
                                error: Some(e.clone()),
                                duration_ms,
                                internal_session_id: None,
                                output_text: None,
                                channel_delivery_expected: false,
                            };
                            match finalize_goal_turn_until_durable(
                                get_cron_task_manager(),
                                &shutdown,
                                &task_id_owned,
                                lease_id,
                                &request,
                            )
                            .await
                            {
                                Some(finalization) if finalization.applied => {
                                    persisted_goal_failure_count =
                                        Some(finalization.task.goal_consecutive_failures);
                                    let run_record = build_cron_run_record(
                                        false,
                                        duration_ms,
                                        None,
                                        Some(e.clone()),
                                    );
                                    record_run_if_task_alive(&tasks, &task_id_owned, &run_record)
                                        .await;
                                }
                                Some(_) => {
                                    ulog_info!(
                                        "[CronTask] Discarding stale Goal failure for task {} lease {}",
                                        task_id_owned,
                                        lease_id
                                    );
                                    continue;
                                }
                                None => break,
                            }
                        } else {
                            // Update last_error + denormalized last-run summary
                            let mut tasks_guard = tasks.write().await;
                            if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                                t.last_error = Some(e.clone());
                                // PRD 0.2.5 R6 — same denormalization as Ok path.
                                t.last_run_ok = Some(false);
                                t.last_run_duration_ms = Some(duration_ms);
                            }
                        }
                        // Emit error event for frontend
                        let _ = handle.emit(
                            "cron:execution-error",
                            serde_json::json!({
                                "taskId": task_id_owned,
                                "error": e
                            }),
                        );

                        // Goal Mode loop: exponential backoff on failure (3→10→30→60→120→300s, max 10 consecutive)
                        if is_loop {
                            let failure_count = persisted_goal_failure_count.unwrap_or_else(|| {
                                loop_consecutive_failures =
                                    loop_consecutive_failures.saturating_add(1);
                                loop_consecutive_failures
                            });
                            match loop_failure_decision(failure_count) {
                                LoopFailureDecision::Stop => {
                                    stop_loop_after_failure_limit(
                                        &handle,
                                        &tasks,
                                        &shutdown,
                                        &task_id_owned,
                                        is_goal,
                                        "transport",
                                    )
                                    .await;
                                    break;
                                }
                                LoopFailureDecision::RetryAfter(delay_secs) => {
                                    loop_retry_delay_secs = Some(delay_secs);
                                    ulog_warn!(
                                        "[CronTask] Task {} Loop transport failure #{}, backoff {}s",
                                        task_id_owned,
                                        failure_count,
                                        delay_secs
                                    );
                                }
                            }
                        }
                        // Continue to next interval (don't break on error)
                    }
                }

                // Save updated state atomically (temp file + rename)
                if let Err(e) = atomic_save_tasks(&storage_path, &tasks).await {
                    ulog_warn!("[CronTask] Failed to save task state: {}", e);
                }

                // Loop scheduling is shared by Goal and historical/internal Loop
                // tasks. Retryable failures use the policy backoff; successful
                // turns retain the short continuation buffer.
                if is_loop {
                    let delay_secs = loop_retry_delay_secs.unwrap_or(3);
                    ulog_info!(
                        "[CronTask] Task {} Loop: next execution in {} seconds",
                        task_id_owned,
                        delay_secs
                    );
                    let buffer_target = Utc::now() + chrono::Duration::seconds(delay_secs as i64);
                    if !sleep_until_wallclock(buffer_target, &shutdown, &task_id_owned).await {
                        ulog_info!(
                            "[CronTask] Task {} shutdown during Loop buffer",
                            task_id_owned
                        );
                        break;
                    }
                    continue;
                }

                // Wait for the next execution time using wall-clock polling.
                // This survives system sleep/suspend — after wake, the poll detects
                // that wall-clock time has passed and fires within ≤30 seconds.
                let next_target = if is_cron_expr {
                    if let Some((ref expr, ref tz)) = cron_expr_info {
                        match next_cron_fire_time(expr, tz.as_deref()) {
                            Ok(target) => {
                                ulog_info!(
                                    "[CronTask] Task {} cron next fire at {} (in {} seconds)",
                                    task_id_owned,
                                    target,
                                    (target - Utc::now()).num_seconds()
                                );
                                target
                            }
                            Err(e) => {
                                ulog_error!(
                                    "[CronTask] Task {} cron schedule error: {}, stopping",
                                    task_id_owned,
                                    e
                                );
                                break;
                            }
                        }
                    } else {
                        break; // Should not happen — cron_expr_info is always Some for is_cron_expr
                    }
                } else {
                    // Fixed interval: next = now + interval
                    let target = Utc::now() + chrono::Duration::seconds(interval_secs);
                    ulog_info!(
                        "[CronTask] Task {} next execution at {} (in {} minutes)",
                        task_id_owned,
                        target,
                        interval_mins
                    );
                    target
                };
                if !sleep_until_wallclock(next_target, &shutdown, &task_id_owned).await {
                    ulog_info!("[CronTask] Task {} shutdown during wait", task_id_owned);
                    break;
                }
            }

            // Clean up: remove from active schedulers
            {
                let mut active = active_schedulers.write().await;
                active.remove(&task_id_owned);
            }
            ulog_info!(
                "[CronTask] Scheduler loop exited for task {}",
                task_id_owned
            );
        });

        // Store JoinHandle under the same critical section that gated the
        // liveness check above — no race window between `tokio::spawn` and
        // the insert. `handles_guard` is released when `start_task_scheduler`
        // returns; the spawned task is already running, so no work is
        // blocked on this release.
        handles_guard.insert(task_id_for_handle, handle);
        drop(handles_guard);

        Ok(())
    }

    /// Mark a task as currently executing (called when execution starts)
    pub async fn mark_task_executing(&self, task_id: &str) {
        let mut executing = self.executing_tasks.write().await;
        executing.insert(task_id.to_string());
        ulog_debug!("[CronTask] Task {} marked as executing", task_id);
    }

    /// Mark a task as no longer executing (called when execution completes)
    pub async fn mark_task_complete(&self, task_id: &str) {
        let mut executing = self.executing_tasks.write().await;
        executing.remove(task_id);
        ulog_debug!("[CronTask] Task {} marked as complete", task_id);
    }

    /// Check if a task is currently executing
    pub async fn is_task_executing(&self, task_id: &str) -> bool {
        let executing = self.executing_tasks.read().await;
        executing.contains(task_id)
    }

    /// PRD 0.2.5 R9 — clone the currently-executing set in one read-lock
    /// acquisition. Lets `list_cron_handler` mark `currently_executing`
    /// per task without N separate `is_task_executing` calls.
    pub async fn executing_snapshot(&self) -> HashSet<String> {
        self.executing_tasks.read().await.clone()
    }

    /// PRD 0.2.5 (cross-review C4) — atomic check-and-insert. Returns true if
    /// the task was successfully reserved (was NOT executing), false if it
    /// was already executing. Caller MUST `mark_task_complete` if true is
    /// returned, or release via `mark_task_complete` when done.
    ///
    /// Why: a separate `is_task_executing` then `mark_task_executing` opens
    /// a TOCTOU window where two concurrent dispatchers (scheduler tick +
    /// `trigger_now`, or two `trigger_now` calls) can both observe "not
    /// executing" and both insert. This single-write-lock variant closes
    /// the window.
    pub async fn try_mark_task_executing(&self, task_id: &str) -> bool {
        let mut executing = self.executing_tasks.write().await;
        if executing.contains(task_id) {
            return false;
        }
        executing.insert(task_id.to_string());
        ulog_debug!("[CronTask] Task {} reserved as executing (atomic)", task_id);
        true
    }

    /// Save tasks to disk using atomic writes (temp file + rename)
    pub(crate) async fn save_to_disk(&self) -> Result<(), String> {
        atomic_save_tasks(&self.storage_path, &self.tasks).await
    }

    pub async fn remove_mcp_server_references(&self, server_id: &str) -> Result<usize, String> {
        let mut tasks = self.tasks.write().await;
        let mut next = tasks.clone();
        let mut updated = 0usize;

        for task in next.values_mut() {
            let Some(ids) = task.mcp_enabled_servers.as_mut() else {
                continue;
            };
            let before = ids.len();
            ids.retain(|id| id != server_id);
            if ids.len() != before {
                task.updated_at = Utc::now();
                updated += 1;
            }
        }

        if updated == 0 {
            return Ok(0);
        }

        atomic_save_task_snapshot(
            &self.storage_path,
            next.values().cloned().collect::<Vec<_>>(),
        )
        .await?;
        *tasks = next;
        Ok(updated)
    }

    async fn emit_goal_changed(&self, task: &CronTask, change_kind: &str) {
        if !is_goal_task(task) {
            return;
        }
        if let Some(ref handle) = *self.app_handle.read().await {
            let _ = handle.emit(
                "goal:changed",
                serde_json::json!({
                    "changeKind": change_kind,
                    "taskId": task.id,
                    "sessionId": task.session_id,
                    "workspacePath": task.workspace_path,
                    "goalStatus": task.goal_status.as_ref().map(goal_status_wire),
                    "goal": task,
                }),
            );
        }
    }

    /// Commit one Goal mutation as a disk-first copy-on-write transaction.
    /// The returned bool is false when the requested transition was already
    /// applied and no persistence or side effect should be repeated.
    async fn commit_goal_mutation<F>(
        &self,
        task_id: &str,
        mutate: F,
    ) -> Result<(CronTask, bool), GoalMutationError>
    where
        F: FnOnce(&mut CronTask) -> Result<bool, GoalMutationError>,
    {
        let mut tasks = self.tasks.write().await;
        let mut next = tasks.clone();
        let task = next
            .get_mut(task_id)
            .ok_or_else(|| GoalMutationError::goal(format!("Task not found: {}", task_id)))?;
        if !task.is_goal() {
            return Err(GoalMutationError::goal("Task is not a Goal Mode task"));
        }
        let changed = mutate(task)?;
        let updated = task.clone();
        if changed {
            atomic_save_task_snapshot(
                &self.storage_path,
                next.values().cloned().collect::<Vec<_>>(),
            )
            .await?;
            *tasks = next;
        }
        Ok((updated, changed))
    }

    /// PRD 0.2.5 R4 — fire one immediate execution of an existing cron task
    /// without changing its `status` / `next_execution_at` / any schedule
    /// fields. Fire-and-forget: returns as soon as the execution is dispatched.
    ///
    /// Conflict semantics: if the task is currently in `executing_tasks`
    /// (single_session running), return Err with a hint to retry later.
    /// new_session tasks have no inherent conflict (each tick spawns a fresh
    /// sidecar) but we still gate on `executing_tasks` for symmetry.
    ///
    /// Returns `(taskId, sessionId, dispatchedAtRfc3339)` for the CLI to print.
    pub async fn trigger_now(&self, task_id: &str) -> Result<TriggerNowInfo, String> {
        let task = self
            .get_task(task_id)
            .await
            .ok_or_else(|| format!("Task not found: {}", task_id))?;
        if is_goal_task(&task) {
            return Err(
                "Goal Mode tasks cannot be run from ordinary CronTask run-now surfaces".to_string(),
            );
        }

        // PRD 0.2.5 cross-review I1 — validate app_handle BEFORE reserving
        // the executing slot. Otherwise an early Err here would leak the
        // reservation forever (no cleanup path).
        let handle = self
            .app_handle
            .read()
            .await
            .clone()
            .ok_or_else(|| "App handle not initialized".to_string())?;

        // PRD 0.2.5 cross-review C4 — atomic check-and-reserve. Closes the
        // TOCTOU window where a concurrent scheduler tick or another
        // `trigger_now` call could both observe "not executing" between
        // is_task_executing() and mark_task_executing().
        if !self.try_mark_task_executing(task_id).await {
            return Err(format!(
                "Cannot run-now: a scheduled tick or earlier run-now is firing for {} this instant. \
                 Wait for it to finish (typically <60s); see `myagents cron runs {} --limit 1` after.",
                task_id, task_id
            ));
        }

        let dispatched_at = Utc::now();
        let session_id = task.session_id.clone();
        let task_id_owned = task_id.to_string();
        let executing_tasks = Arc::clone(&self.executing_tasks);
        let tasks_arc = Arc::clone(&self.tasks);

        // Fire-and-forget: spawn the execution off-task. The caller (CLI /
        // HTTP handler) returns to the user the moment dispatch starts.
        // CLAUDE.md ban on tokio::spawn — use tauri::async_runtime::spawn.
        tauri::async_runtime::spawn(async move {
            // Snapshot the latest task state inside the spawned task so we
            // pick up any in-memory mutation since the trigger arrived.
            let task_snapshot = {
                let tasks = tasks_arc.read().await;
                tasks.get(&task_id_owned).cloned()
            };
            let Some(t) = task_snapshot else {
                ulog_warn!(
                    "[CronTask] trigger_now: task {} disappeared before dispatch",
                    task_id_owned
                );
                let mut executing = executing_tasks.write().await;
                executing.remove(&task_id_owned);
                return;
            };

            // PRD 0.2.5 cross-review I3 — emit execution-starting event so
            // frontend/IM users see the same lifecycle signals as a scheduled
            // tick (the scheduler emits this before each tick).
            let _ = handle.emit(
                "cron:execution-starting",
                serde_json::json!({
                    "taskId": task_id_owned,
                    "executionNumber": t.execution_count + 1,
                    "isFirstExecution": false,
                    "trigger": "manual",  // distinguishes from scheduler ticks
                }),
            );

            // PRD 0.2.5 cross-review I3 — 60min timeout matches scheduler's
            // `tokio::time::timeout(Duration::from_secs(3600), ...)`. Without
            // this, a hung manual run would keep the task permanently
            // reserved in `executing_tasks`.
            let exec_start = std::time::Instant::now();
            let timed = tokio::time::timeout(
                Duration::from_secs(3600),
                execute_task_directly(&handle, &t, false /* is_first_execution */),
            )
            .await;
            let duration_ms = exec_start.elapsed().as_millis() as u64;
            let result = match timed {
                Ok(r) => r,
                Err(_) => {
                    ulog_error!(
                        "[CronTask] trigger_now: task {} timed out after 60 minutes",
                        task_id_owned
                    );
                    Err("Execution timed out".to_string())
                }
            };

            // PRD 0.2.5 cross-review C5 — skip JSONL write if task was
            // deleted while this manual run was in flight. Otherwise we'd
            // resurrect the run-history file delete_task() just cleaned.
            let task_still_alive = {
                let g = tasks_arc.read().await;
                g.contains_key(&task_id_owned)
            };

            const MAX_CONTENT_LEN: usize = 2000;
            let terminal_stop = matches!(&result, Err(e) if e.starts_with(TERMINAL_STOP_SENTINEL));
            match &result {
                Ok((success, ai_exit_reason, output_text, internal_sid, _)) => {
                    let run_record = CronRunRecord {
                        ts: Utc::now().timestamp_millis(),
                        ok: *success,
                        duration_ms,
                        content: output_text.as_ref().map(|t| {
                            if t.len() > MAX_CONTENT_LEN {
                                let end = t
                                    .char_indices()
                                    .take_while(|(i, _)| *i < MAX_CONTENT_LEN)
                                    .last()
                                    .map(|(i, c)| i + c.len_utf8())
                                    .unwrap_or(MAX_CONTENT_LEN.min(t.len()));
                                format!("{}...", &t[..end])
                            } else {
                                t.clone()
                            }
                        }),
                        error: None,
                    };
                    if task_still_alive {
                        let _ = record_cron_run(&task_id_owned, &run_record);
                    }

                    // PRD 0.2.5 cross-review I3 — denormalize + post-process
                    // mirror of scheduler's Ok branch (cron_task.rs ~1252-1320).
                    let updated_execution_count = {
                        let mut tasks_guard = tasks_arc.write().await;
                        if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                            t.execution_count += 1;
                            t.last_executed_at = Some(Utc::now());
                            t.updated_at = Utc::now();
                            t.last_error = None;
                            t.last_run_ok = Some(*success);
                            t.last_run_duration_ms = Some(duration_ms);
                            if internal_sid.is_some() {
                                t.internal_session_id = internal_sid.clone();
                            }
                            t.execution_count
                        } else {
                            t.execution_count + 1
                        }
                    };

                    let _ = handle.emit(
                        "cron:execution-complete",
                        serde_json::json!({
                            "taskId": task_id_owned,
                            "success": success,
                            "executionCount": updated_execution_count,
                            "internalSessionId": internal_sid,
                            "trigger": "manual",
                        }),
                    );

                    // IM delivery — AI output to configured channel
                    if let Some(ref delivery) = t.delivery {
                        let content = output_text.clone().unwrap_or_else(|| {
                            if *success {
                                format!(
                                    "Cron task '{}' completed successfully.",
                                    t.name.as_deref().unwrap_or(&task_id_owned)
                                )
                            } else {
                                format!(
                                    "Cron task '{}' completed with issues.",
                                    t.name.as_deref().unwrap_or(&task_id_owned)
                                )
                            }
                        });
                        // Same rationale as scheduler-loop site: pass the run's
                        // actual session id explicitly. See #225 review.
                        deliver_cron_result_to_bot(
                            &handle,
                            delivery,
                            &task_id_owned,
                            &content,
                            internal_sid.as_deref(),
                        )
                        .await;
                    }

                    // ai_exit_reason → stop the task. Even on a manual
                    // trigger, if the AI calls ExitCronTask we honor the
                    // request (consistent with scheduler behavior).
                    if let Some(reason) = ai_exit_reason.clone() {
                        ulog_info!(
                            "[CronTask] trigger_now: task {} AI requested exit: {}",
                            task_id_owned,
                            reason
                        );
                        stop_task_internal(&handle, &tasks_arc, &task_id_owned, Some(reason)).await;
                    } else {
                        // End condition check (deadline / max_executions)
                        let should_stop = {
                            let tasks_guard = tasks_arc.read().await;
                            tasks_guard
                                .get(&task_id_owned)
                                .map(check_end_conditions_static)
                                .unwrap_or(false)
                        };
                        if should_stop {
                            ulog_info!(
                                "[CronTask] trigger_now: task {} reached end condition",
                                task_id_owned
                            );
                            stop_task_internal(&handle, &tasks_arc, &task_id_owned, None).await;
                        }
                    }
                }
                Err(_) if terminal_stop => {
                    // Graceful stop already executed inside execute_task_directly.
                }
                Err(ref e) => {
                    let run_record = CronRunRecord {
                        ts: Utc::now().timestamp_millis(),
                        ok: false,
                        duration_ms,
                        content: None,
                        error: Some(e.clone()),
                    };
                    if task_still_alive {
                        let _ = record_cron_run(&task_id_owned, &run_record);
                    }
                    {
                        let mut tasks_guard = tasks_arc.write().await;
                        if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                            t.last_error = Some(e.clone());
                            t.last_run_ok = Some(false);
                            t.last_run_duration_ms = Some(duration_ms);
                        }
                    }
                    let _ = handle.emit(
                        "cron:execution-error",
                        serde_json::json!({
                            "taskId": task_id_owned,
                            "error": e,
                            "trigger": "manual",
                        }),
                    );
                }
            }

            // Persist updates (best-effort) via singleton.
            if let Err(e) = get_cron_task_manager().save_to_disk().await {
                ulog_warn!(
                    "[CronTask] trigger_now: failed to persist post-run state: {}",
                    e
                );
            }

            // Release the executing lock — must run on every path.
            let mut executing = executing_tasks.write().await;
            executing.remove(&task_id_owned);

            ulog_info!(
                "[CronTask] trigger_now completed for task {} in {}ms",
                task_id_owned,
                duration_ms
            );
        });

        Ok(TriggerNowInfo {
            task_id: task_id.to_string(),
            session_id,
            dispatched_at: dispatched_at.to_rfc3339(),
        })
    }

    pub(super) async fn create_task_with_initial_status(
        &self,
        mut config: CronTaskConfig,
        initial_status: TaskStatus,
    ) -> Result<CronTask, String> {
        // Validate minimum interval (5 minutes, matches frontend MIN_CRON_INTERVAL)
        if config.interval_minutes < 5 {
            return Err("Interval must be at least 5 minutes".to_string());
        }

        // PRD 0.2.9 — Apply the same provider-routing invariants as the
        // Task layer (`task::validate_task_provider_routing`). All callers
        // of this function (frontend cron creation paths, IM cron tool,
        // ensure_cron_for_task projection) flow through here, so this is
        // the choke point that prevents IM-bot / CLI / direct-Tauri
        // callers from persisting half-state CronTasks. Mirrors the pin
        // semantics: provider_id with no runtime → pin builtin.
        if config.provider_id.is_some() && config.runtime.is_none() {
            config.runtime = Some("builtin".to_string());
        }
        if config.provider_id.is_some() && config.model.is_none() {
            return Err("providerId 必须与 model 配对设置（CronTask 创建路径校验）".to_string());
        }
        if let Some(rt) = config.runtime.as_deref() {
            if matches!(rt, "claude-code" | "codex" | "gemini") && config.provider_id.is_some() {
                return Err(format!(
                    "外部 runtime '{}' 不允许同时指定 providerId（CronTask 创建路径校验）",
                    rt
                ));
            }
        }

        let managed_kind = match config.managed_kind.as_deref() {
            Some(kind) if kind.trim().is_empty() => None,
            Some(kind) if crate::task::is_supported_managed_kind(kind) => Some(kind.to_string()),
            Some(kind) => return Err(format!("unsupported managedKind: {}", kind)),
            None => None,
        };
        let is_goal_config = config.goal_status.is_some();
        let mut tasks = self.tasks.write().await;
        if is_goal_config && !config.goal_status.as_ref().is_some_and(is_goal_terminal) {
            let has_conflicting_automation = tasks.values().any(|existing| {
                task_uses_session_automation(existing, &config.session_id)
                    && ((is_goal_task(existing)
                        && !existing.goal_status.as_ref().is_some_and(is_goal_terminal))
                        || (!is_goal_task(existing) && existing.status == TaskStatus::Running))
            });
            if has_conflicting_automation {
                return Err(
                    "Current session already has an unfinished Goal or running single-session automation"
                        .to_string(),
                );
            }
        }
        validate_new_task_goal_shape(&config)?;

        let random_id = Uuid::new_v4().to_string().replace('-', "");
        let task = CronTask {
            id: format!("cron_{}", &random_id[..12]),
            workspace_path: config.workspace_path,
            session_id: config.session_id,
            prompt: config.prompt,
            interval_minutes: config.interval_minutes,
            end_conditions: config.end_conditions,
            run_mode: config.run_mode,
            status: initial_status,
            execution_count: 0,
            created_at: Utc::now(),
            last_executed_at: None,
            notify_enabled: config.notify_enabled,
            tab_id: config.tab_id,
            exit_reason: None,
            permission_mode: config.permission_mode,
            model: config.model,
            provider_env: config.provider_env,
            provider_id: config.provider_id,
            provider_intent: config.provider_intent,
            runtime: config.runtime,
            runtime_config: config.runtime_config,
            mcp_enabled_servers: config.mcp_enabled_servers,
            managed_kind,
            last_error: None,
            last_run_ok: None,
            last_run_duration_ms: None,
            source_bot_id: config.source_bot_id,
            delivery: config.delivery,
            schedule: config.schedule,
            name: config.name,
            next_execution_at: None,   // Enriched at read time
            internal_session_id: None, // Set after first execution
            updated_at: Utc::now(),
            task_id: config.task_id,
            goal_status: config.goal_status,
            goal_objective: config.goal_objective,
            goal_updated_at: config.goal_updated_at,
            goal_terminal_reason: config.goal_terminal_reason,
            goal_paused_reason: config.goal_paused_reason,
            goal_revision: if is_goal_config { 1 } else { 0 },
            goal_control_revision: if is_goal_config { 1 } else { 0 },
            goal_turn_lease: None,
            goal_user_admissions: Vec::new(),
            goal_delivery_outbox: Vec::new(),
            goal_consecutive_failures: 0,
        };

        let mut next = tasks.clone();
        next.insert(task.id.clone(), task.clone());
        atomic_save_task_snapshot(
            &self.storage_path,
            next.values().cloned().collect::<Vec<_>>(),
        )
        .await?;
        *tasks = next;
        ulog_info!("[CronTask] Created task: {}", task.id);

        Ok(task)
    }

    /// Create a new cron task (does not start it).
    pub async fn create_task(&self, config: CronTaskConfig) -> Result<CronTask, String> {
        self.create_task_with_initial_status(config, TaskStatus::Stopped)
            .await
    }

    /// Get a task by ID (enriched with next_execution_at)
    pub async fn get_task(&self, task_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks.get(task_id).cloned().map(enrich_task)
    }

    /// Look up a CronTask by its Task Center reverse pointer (PRD §11.2).
    /// Returns the first match; tasks are expected to be 1:1 with CronTasks.
    pub async fn find_by_task_id(&self, ta_task_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .find(|t| t.task_id.as_deref() == Some(ta_task_id))
            .cloned()
            .map(enrich_task)
    }

    /// System-only backfill for product-owned managed task markers.
    ///
    /// Ordinary CronTask update surfaces intentionally cannot mutate
    /// `managed_kind`; reconcile owners use this to repair older Task→Cron
    /// projections that predate the marker mirror.
    pub async fn set_managed_kind(
        &self,
        task_id: &str,
        managed_kind: Option<String>,
    ) -> Result<CronTask, String> {
        let managed_kind = match managed_kind {
            Some(kind) if kind.trim().is_empty() => None,
            Some(kind) if crate::task::is_supported_managed_kind(&kind) => Some(kind),
            Some(kind) => return Err(format!("unsupported managedKind: {}", kind)),
            None => None,
        };
        let mut tasks = self.tasks.write().await;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;
        task.managed_kind = managed_kind;
        task.updated_at = Utc::now();
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(enrich_task(task_clone))
    }

    /// Delete every CronTask linked to the given Task Center id. Used when a
    /// Task is archived / deleted / rerun so stale scheduler entries don't
    /// keep firing.
    pub async fn delete_by_task_id(&self, ta_task_id: &str) -> Result<usize, String> {
        let ids: Vec<String> = {
            let tasks = self.tasks.read().await;
            tasks
                .values()
                .filter(|t| t.task_id.as_deref() == Some(ta_task_id))
                .map(|t| t.id.clone())
                .collect()
        };
        for id in &ids {
            let _ = self.delete_task(id).await;
        }
        Ok(ids.len())
    }

    /// Get all tasks (enriched with next_execution_at)
    pub async fn get_all_tasks(&self) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks.values().cloned().map(enrich_task).collect()
    }

    /// Get tasks for a specific workspace (enriched with next_execution_at)
    /// Uses normalized path comparison to handle trailing slashes and other inconsistencies
    pub async fn get_tasks_for_workspace(&self, workspace_path: &str) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        let normalized_query = normalize_path(workspace_path);
        let result: Vec<CronTask> = tasks
            .values()
            .filter(|t| normalize_path(&t.workspace_path) == normalized_query)
            .cloned()
            .map(enrich_task)
            .collect();

        ulog_debug!(
            "[CronTask] get_tasks_for_workspace: query='{}' (normalized='{}'), found {} tasks",
            workspace_path,
            normalized_query,
            result.len()
        );

        result
    }

    /// Get active task for a specific session (running only, enriched)
    pub async fn get_active_task_for_session(&self, session_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|task| {
                !task.is_goal()
                    && !task
                        .managed_kind
                        .as_deref()
                        .is_some_and(crate::task::is_supported_managed_kind)
            })
            .find(|t| t.session_id == session_id && t.status == TaskStatus::Running)
            .cloned()
            .map(enrich_task)
    }

    /// Lifecycle-only query. Running schedulers and unfinished Goals keep their
    /// session identity stable even before a live CronTask owner attaches.
    pub async fn has_persistent_task_for_session(&self, session_id: &str) -> bool {
        self.tasks
            .read()
            .await
            .values()
            .any(|task| task_holds_persistent_session(task, session_id))
    }

    /// User-facing lifecycle snapshot. Internal managed jobs are intentionally
    /// excluded so they do not make every app exit require confirmation.
    pub async fn user_scheduler_lifecycle_snapshot(&self) -> (usize, Vec<String>) {
        let tasks = self.tasks.read().await;
        let mut running_task_count = 0;
        let mut protected_session_ids = HashSet::new();
        for task in tasks.values() {
            if task
                .managed_kind
                .as_deref()
                .is_some_and(crate::task::is_supported_managed_kind)
            {
                continue;
            }
            let unfinished_goal = task.is_goal()
                && matches!(
                    task.goal_status,
                    Some(GoalStatus::Active | GoalStatus::Paused)
                );
            if task.status == TaskStatus::Running && task.goal_status != Some(GoalStatus::Paused) {
                running_task_count += 1;
            }
            if task.status == TaskStatus::Running || unfinished_goal {
                protected_session_ids.insert(task.session_id.clone());
                if let Some(session_id) = task.internal_session_id.as_ref() {
                    protected_session_ids.insert(session_id.clone());
                }
            }
        }
        let mut protected_session_ids: Vec<String> = protected_session_ids.into_iter().collect();
        protected_session_ids.sort();
        (running_task_count, protected_session_ids)
    }

    /// Get the latest Goal Mode task for a session.
    ///
    /// `include_terminal=false` is used by AI/CLI state transitions: only the
    /// unfinished Goal should be mutable. `include_terminal=true` is reserved
    /// for explicit inspection/debug reads; normal desktop hydrate only
    /// restores active/paused Goals so old terminal Goals do not reappear.
    pub async fn get_goal_for_session(
        &self,
        session_id: &str,
        workspace_path: Option<&str>,
        include_terminal: bool,
    ) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        let normalized_workspace = workspace_path.map(normalize_path);
        let mut matches: Vec<CronTask> = tasks
            .values()
            .filter(|task| {
                if task.session_id != session_id || !is_goal_task(task) {
                    return false;
                }
                if let Some(ref workspace) = normalized_workspace {
                    if normalize_path(&task.workspace_path) != *workspace {
                        return false;
                    }
                }
                if include_terminal {
                    return true;
                }
                task.status == TaskStatus::Running
                    && !task.goal_status.as_ref().is_some_and(is_goal_terminal)
            })
            .cloned()
            .collect();
        matches.sort_by_key(|task| task.updated_at);
        matches.into_iter().next_back().map(enrich_task)
    }

    /// Get active task for a specific tab (running only, enriched)
    pub async fn get_active_task_for_tab(&self, tab_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|task| {
                !task.is_goal()
                    && !task
                        .managed_kind
                        .as_deref()
                        .is_some_and(crate::task::is_supported_managed_kind)
            })
            .find(|t| t.tab_id.as_deref() == Some(tab_id) && t.status == TaskStatus::Running)
            .cloned()
            .map(enrich_task)
    }

    /// Create, start, and schedule a current-session Goal Mode task.
    pub async fn create_goal_task(
        &self,
        config: CronTaskConfig,
    ) -> Result<CronTask, GoalMutationError> {
        let config = prepare_goal_create_config(config)?;

        // A Goal has no valid persisted "active but stopped" intermediate
        // state. Commit it Running in the same disk-first transaction as the
        // uniqueness check; scheduler attachment is recoverable lifecycle work.
        let created = self
            .create_task_with_initial_status(config, TaskStatus::Running)
            .await?;
        self.start_task_scheduler(&created.id).await?;
        let task = self.get_task(&created.id).await.unwrap_or(created);
        self.emit_goal_changed(&task, "created").await;
        Ok(task)
    }

    /// Get tasks created by a specific IM Bot (v0.1.21, enriched)
    pub async fn get_tasks_for_bot(&self, bot_id: &str) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|t| t.source_bot_id.as_deref() == Some(bot_id))
            .cloned()
            .map(enrich_task)
            .collect()
    }

    /// Update task fields (partial update, for management API)
    pub async fn update_task_fields(
        &self,
        task_id: &str,
        patch: serde_json::Value,
    ) -> Result<CronTask, String> {
        // Capture pre-patch state so we can decide whether the scheduler needs
        // to be bounced. The scheduler tokio task captures `schedule`/
        // `interval_mins`/`cron_expr_info` by value at spawn time
        // (`start_task_scheduler` line ~731), so editing these fields on disk
        // alone is invisible to the running loop. If we don't restart the
        // scheduler, the user sees "save succeeded" but the task keeps firing
        // at the old cadence until natural stop/start.
        let (was_running, prev_schedule, prev_interval, prev_end_conditions) = {
            let tasks = self.tasks.read().await;
            let task = tasks
                .get(task_id)
                .ok_or_else(|| format!("Task not found: {}", task_id))?;
            if is_goal_task(task) {
                return Err("Goal Mode tasks are managed through Goal controls and cannot be updated through ordinary CronTask surfaces".to_string());
            }
            (
                task.status == TaskStatus::Running,
                task.schedule.clone(),
                task.interval_minutes,
                task.end_conditions.clone(),
            )
        };

        // Pit-of-success: do the stop BEFORE mutating, so a concurrent
        // scheduler tick (reading stale schedule) doesn't interleave with the
        // write. Mirrors `cmd_update_cron_task_fields`'s dance.
        if was_running {
            self.stop_task(task_id, None).await?;
            let mut active = self.active_schedulers.write().await;
            active.remove(task_id);
        }

        let mut tasks = self.tasks.write().await;
        // Apply patches to a CLONE so a late-stage validation failure
        // (PRD 0.2.9 invariants below) doesn't leave the in-memory store
        // half-patched — found during cross-review of dev/0.2.9.
        let mut task: CronTask = tasks
            .get(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?
            .clone();
        let task = &mut task;

        // Apply allowed patches
        if let Some(name) = patch.get("name").and_then(|v| v.as_str()) {
            task.name = Some(name.to_string());
        }
        // Accept both "prompt" and "message" (Bun normalizes, but defend in depth)
        if let Some(prompt) = patch
            .get("prompt")
            .and_then(|v| v.as_str())
            .or_else(|| patch.get("message").and_then(|v| v.as_str()))
        {
            task.prompt = prompt.to_string();
        }
        if let Some(interval) = patch.get("intervalMinutes").and_then(|v| v.as_u64()) {
            task.interval_minutes = interval.max(5) as u32;
        }
        if let Some(schedule_val) = patch.get("schedule") {
            if schedule_val.is_null() {
                task.schedule = None;
            } else if let Ok(s) = serde_json::from_value::<CronSchedule>(schedule_val.clone()) {
                // Issue #115 Bug B — preserve `tz` when patch is a bare cron
                // expression that didn't specify one. CLI's
                // `normalizeScheduleFlag` for the bare-string form returns
                // `{kind:cron, expr}` with no `tz` field, so this is the
                // typical "user just wanted to change the firing pattern"
                // intent; silently dropping the existing tz changes the
                // meaning of the schedule from the user's local TZ to UTC.
                //
                // Merge rule: Cron-with-no-tz patch onto Cron-with-tz prev
                // → inherit tz. All other transitions (Every↔Cron, explicit
                // tz set, switch to At/Loop) replace wholesale, matching
                // user's explicit intent.
                let merged = match (&prev_schedule, s) {
                    (
                        Some(CronSchedule::Cron {
                            tz: Some(prev_tz), ..
                        }),
                        CronSchedule::Cron { expr, tz: None },
                    ) => CronSchedule::Cron {
                        expr,
                        tz: Some(prev_tz.clone()),
                    },
                    (_, other) => other,
                };
                // Mirror interval_minutes when switching to a fixed-interval schedule,
                // so any downstream reader that falls back to the legacy field stays
                // consistent.
                if let CronSchedule::Every { minutes, .. } = &merged {
                    task.interval_minutes = *minutes;
                }
                task.schedule = Some(merged);
            }
        }
        if let Some(end_conditions_val) = patch.get("endConditions") {
            // Issue #115 cross-review (Pattern B) — endConditions is a
            // nested struct with three independently-meaningful fields
            // (deadline / max_executions / ai_can_exit). Treating the
            // patch as a wholesale replacement silently zeroes out any
            // field the caller didn't include — e.g. a CLI `cron update
            // --endConditions '{"deadline":"..."}'` would lose the
            // previously-set max_executions and ai_can_exit. Merge per
            // field, only overwriting keys the patch actually carries.
            if let Some(obj) = end_conditions_val.as_object() {
                if obj.contains_key("deadline") {
                    if let Some(v) = obj.get("deadline") {
                        task.end_conditions.deadline = if v.is_null() {
                            None
                        } else {
                            serde_json::from_value(v.clone())
                                .unwrap_or(task.end_conditions.deadline)
                        };
                    }
                }
                if obj.contains_key("maxExecutions") {
                    if let Some(v) = obj.get("maxExecutions") {
                        task.end_conditions.max_executions = if v.is_null() {
                            None
                        } else {
                            v.as_u64()
                                .map(|n| n as u32)
                                .or(task.end_conditions.max_executions)
                        };
                    }
                }
                if obj.contains_key("aiCanExit") {
                    if let Some(b) = obj.get("aiCanExit").and_then(|v| v.as_bool()) {
                        task.end_conditions.ai_can_exit = b;
                    }
                }
            } else if let Ok(ec) =
                serde_json::from_value::<EndConditions>(end_conditions_val.clone())
            {
                // Non-object form (e.g. legacy callers passing a fully-typed
                // struct) — fall back to wholesale replace, which is what
                // the old behavior was. The merge above only kicks in for
                // partial-object patches, which is the common CLI case.
                task.end_conditions = ec;
            }
        }
        if let Some(notify) = patch.get("notifyEnabled").and_then(|v| v.as_bool()) {
            task.notify_enabled = notify;
        }
        if let Some(model) = patch.get("model") {
            if model.is_null() {
                task.model = None;
            } else if let Some(s) = model.as_str() {
                task.model = Some(s.to_string());
            }
        }
        // PRD 0.2.9 — Project per-task provider id from Task → CronTask. Two
        // states (mirrors model semantics):
        //   null     → clear (= follow Agent)
        //   "id"     → set the per-task override
        // The sidecar live-resolves env from this id on every tick, so we
        // never write a credential snapshot to disk here.
        if let Some(provider_id) = patch.get("providerId") {
            if provider_id.is_null() {
                task.provider_id = None;
            } else if let Some(s) = provider_id.as_str() {
                task.provider_id = if s.is_empty() {
                    None
                } else {
                    Some(s.to_string())
                };
            }
        }

        if let Some(pm) = patch.get("permissionMode").and_then(|v| v.as_str()) {
            task.permission_mode = pm.to_string();
        }
        // PRD #131 / Codex-review #1 — runtime + runtimeConfig projection
        // from Task → CronTask. Same two-state semantics as model/providerId:
        //   null     → clear (= follow Agent runtime)
        //   string   → set the per-task runtime override (builtin / codex / …)
        // Without these, an existing recurring task whose runtime was
        // edited in the Task panel kept executing on the original runtime
        // forever — Task and CronTask drifted out of sync.
        if let Some(runtime_val) = patch.get("runtime") {
            if runtime_val.is_null() {
                task.runtime = None;
            } else if let Some(s) = runtime_val.as_str() {
                task.runtime = if s.is_empty() {
                    None
                } else {
                    Some(s.to_string())
                };
            }
        }
        if let Some(rc_val) = patch.get("runtimeConfig") {
            if rc_val.is_null() {
                task.runtime_config = None;
            } else {
                task.runtime_config = Some(rc_val.clone());
            }
        }
        // Task → CronTask projection of MCP override:
        //   null      → follow workspace
        //   []        → explicitly no MCP
        //   [ids...]  → explicit per-task override
        if let Some(mcp_val) = patch.get("mcpEnabledServers") {
            if mcp_val.is_null() {
                task.mcp_enabled_servers = None;
            } else if let Ok(list) = serde_json::from_value::<Vec<String>>(mcp_val.clone()) {
                task.mcp_enabled_servers = Some(list);
            }
        }
        if let Some(delivery_val) = patch.get("delivery") {
            if delivery_val.is_null() {
                task.delivery = None;
            } else if let Ok(d) = serde_json::from_value::<CronDelivery>(delivery_val.clone()) {
                task.delivery = Some(d);
            }
        } else if patch.get("clearDelivery").and_then(|v| v.as_bool()) == Some(true) {
            task.delivery = None;
        }

        // PRD 0.2.9 — Re-run the create-time invariants on the merged state.
        // The sibling `create_task` choke point gates the create path, but
        // this `update_task_fields` path (used by `/api/cron/update` and the
        // CLI / IM patch flows) was missing the same gate, so a patch like
        // `{"providerId": "openai-x"}` against an existing CronTask with
        // `runtime: Some("codex")` would silently land — exactly the half-
        // state the validator is designed to refuse. Found by CC review on
        // dev/0.2.9. Same pin-runtime semantics: provider_id with no runtime
        // → pin builtin so a later Agent runtime flip doesn't cross-talk.
        // Patches were applied to a CLONE above, so a validation failure
        // here aborts cleanly without touching the in-memory store.
        if task.provider_id.is_some() && task.runtime.is_none() {
            task.runtime = Some("builtin".to_string());
        }
        if task.provider_id.is_some() && task.model.is_none() {
            return Err("providerId 必须与 model 配对设置（CronTask 更新路径校验）".to_string());
        }
        if let Some(rt) = task.runtime.as_deref() {
            if matches!(rt, "claude-code" | "codex" | "gemini") && task.provider_id.is_some() {
                return Err(format!(
                    "外部 runtime '{}' 不允许同时指定 providerId（CronTask 更新路径校验）",
                    rt
                ));
            }
        }

        task.updated_at = Utc::now();
        // Detect schedule-shape change so we know whether to restart the
        // scheduler (even shape-unchanged edits still go through this path
        // for model/permission/name; those don't need a bounce).
        let schedule_changed = task.schedule != prev_schedule
            || task.interval_minutes != prev_interval
            || task.end_conditions != prev_end_conditions;
        let updated = task.clone();
        // Commit the validated clone back to the map.
        tasks.insert(task_id.to_string(), updated.clone());
        drop(tasks);
        self.save_to_disk().await?;
        ulog_info!("[CronTask] Updated task fields: {}", task_id);

        if was_running {
            // Whether or not schedule changed, we stopped it — restart it so
            // the task keeps running. If schedule changed, the restart is
            // what makes the edit take effect; if not, it's just restoring
            // the pre-edit state.
            self.start_task(task_id).await?;
            self.start_task_scheduler(task_id).await?;
            if schedule_changed {
                ulog_info!(
                    "[CronTask] bounced scheduler for {} after schedule-shape edit",
                    task_id
                );
            }
        }

        Ok(updated)
    }

    /// Write the `task_id` back-pointer used by the Task Center to find the
    /// CronTask that backs a given new-model Task. Used by the legacy-upgrade
    /// path — once the pointer is set, the legacy surfacing filter (see
    /// `TaskListPanel.fetchLegacyCronTasks`) hides this row from the legacy
    /// list and the Task Center drives it through the new detail overlay.
    ///
    /// Concurrency guard (`require_null = true`) — when two upgrade flows
    /// race to link the same CronTask, only the first succeeds. The second
    /// sees `ALREADY_LINKED` and its caller can roll back the stale
    /// Task/Thought rows it just created. Pass `require_null = false` for
    /// explicit relink or clear operations.
    pub async fn set_task_id(
        &self,
        cron_task_id: &str,
        task_id: Option<String>,
        require_null: bool,
    ) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks
            .get_mut(cron_task_id)
            .ok_or_else(|| format!("CronTask not found: {}", cron_task_id))?;
        if require_null {
            if let Some(existing) = &task.task_id {
                if Some(existing) != task_id.as_ref() {
                    return Err(format!(
                        "ALREADY_LINKED: CronTask {} is already linked to Task {}",
                        cron_task_id, existing
                    ));
                }
            }
        }
        task.task_id = task_id;
        task.updated_at = Utc::now();
        let updated = task.clone();
        drop(tasks);
        self.save_to_disk().await?;
        ulog_info!("[CronTask] Set task_id: {}", cron_task_id);
        Ok(updated)
    }

    /// Start a task (begin scheduling)
    /// Can start a task in Stopped status (e.g., after creation or after previous stop)
    pub async fn start_task(&self, task_id: &str) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let target = tasks
            .get(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if target.status == TaskStatus::Running {
            return Err("Task is already running".to_string());
        }
        if is_goal_task(target) && target.goal_status.as_ref().is_some_and(is_goal_terminal) {
            return Err("Terminal Goal cannot be restarted".to_string());
        }
        if target.run_mode == RunMode::SingleSession
            && tasks.values().any(|existing| {
                existing.id != task_id
                    && task_uses_session_automation(existing, &target.session_id)
                    && ((is_goal_task(target)
                        && existing.status == TaskStatus::Running
                        && !is_goal_task(existing))
                        || (!is_goal_task(target)
                            && is_goal_task(existing)
                            && !existing.goal_status.as_ref().is_some_and(is_goal_terminal)))
            })
        {
            return Err(
                "Current session already has an unfinished Goal or running single-session automation"
                    .to_string(),
            );
        }

        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        task.status = TaskStatus::Running;
        task.updated_at = Utc::now();
        task.bump_goal_revision();
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;
        ulog_info!("[CronTask] Started task: {}", task_id);

        Ok(task_clone)
    }

    /// Stop a task (with optional exit reason)
    /// Also releases the associated CronTask owner/projection.
    /// exit_reason can be set when AI calls ExitCronTask tool or end conditions are met
    pub async fn stop_task(
        &self,
        task_id: &str,
        exit_reason: Option<String>,
    ) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if task.is_goal() {
            return Err("Goal Mode tasks must be stopped through Goal controls".to_string());
        }

        let session_id = task.session_id.clone();
        let now = Utc::now();
        task.status = TaskStatus::Stopped;
        task.exit_reason = exit_reason.clone();
        task.updated_at = now;
        let task_clone = task.clone();
        drop(tasks);

        // Release CronTask's ownership of the Session Sidecar
        // If Tab still owns it, Sidecar continues running
        self.stop_cron_task_sidecar_internal(&session_id, task_id)
            .await;

        self.save_to_disk().await?;

        // Emit stopped event for frontend listeners (e.g., RecentTasks badge refresh)
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            let _ = handle.emit(
                "cron:task-stopped",
                serde_json::json!({
                    "taskId": task_id,
                    "exitReason": exit_reason
                }),
            );
        }

        ulog_info!(
            "[CronTask] Stopped task: {} (CronTask released from session {})",
            task_id,
            session_id
        );

        Ok(task_clone)
    }

    pub async fn pause_goal_task(
        &self,
        task_id: &str,
        reason: GoalPausedReason,
    ) -> Result<CronTask, GoalMutationError> {
        let (updated, changed) = self
            .commit_goal_mutation(task_id, move |task| {
                if task.status != TaskStatus::Running {
                    return Err(GoalMutationError::goal("Goal is not running"));
                }
                if task.goal_status.as_ref().is_some_and(is_goal_terminal) {
                    return Err(GoalMutationError::goal("Goal is already terminal"));
                }
                if task.goal_status == Some(GoalStatus::Paused)
                    && task.goal_turn_lease.is_none()
                    && task.goal_user_admissions.is_empty()
                {
                    return Ok(false);
                }
                let now = Utc::now();
                task.goal_status = Some(GoalStatus::Paused);
                task.goal_paused_reason = Some(reason);
                invalidate_goal_turn_lease(task);
                task.goal_user_admissions.clear();
                task.goal_updated_at = Some(now);
                task.updated_at = now;
                task.bump_goal_revision();
                task.bump_goal_control_revision();
                Ok(true)
            })
            .await?;
        if !changed {
            return Ok(enrich_task(updated));
        }
        let handle = self.app_handle.read().await.clone();
        if let Some(ref handle) = handle {
            let _ = handle.emit(
                "cron:task-updated",
                serde_json::json!({ "taskId": task_id, "goalStatus": "paused" }),
            );
        }
        self.emit_goal_changed(&updated, "paused").await;
        Ok(enrich_task(updated))
    }

    pub async fn resume_goal_task(&self, task_id: &str) -> Result<CronTask, GoalMutationError> {
        let (updated, changed) = self
            .commit_goal_mutation(task_id, |task| {
                if task.goal_status.as_ref().is_some_and(is_goal_terminal) {
                    return Err(GoalMutationError::goal("Goal is already terminal"));
                }
                if task.status == TaskStatus::Running
                    && task.goal_status == Some(GoalStatus::Active)
                {
                    return Ok(false);
                }
                let now = Utc::now();
                task.status = TaskStatus::Running;
                task.goal_status = Some(GoalStatus::Active);
                task.goal_paused_reason = None;
                task.goal_updated_at = Some(now);
                task.updated_at = now;
                task.bump_goal_revision();
                task.bump_goal_control_revision();
                Ok(true)
            })
            .await?;
        if !changed {
            return Ok(enrich_task(updated));
        }
        if let Err(error) = self.start_task_scheduler(task_id).await {
            let _ = self
                .commit_goal_mutation(task_id, |task| {
                    let now = Utc::now();
                    task.goal_status = Some(GoalStatus::Paused);
                    task.goal_paused_reason = Some(GoalPausedReason::UserStop);
                    task.goal_updated_at = Some(now);
                    task.updated_at = now;
                    task.bump_goal_revision();
                    task.bump_goal_control_revision();
                    Ok(true)
                })
                .await;
            return Err(GoalMutationError::goal(format!(
                "Failed to resume Goal scheduler: {}",
                error
            )));
        }
        let handle = self.app_handle.read().await.clone();
        if let Some(ref handle) = handle {
            let _ = handle.emit(
                "cron:task-updated",
                serde_json::json!({ "taskId": task_id, "goalStatus": "active" }),
            );
        }
        self.emit_goal_changed(&updated, "resumed").await;
        Ok(enrich_task(updated))
    }

    pub async fn update_goal_objective_cas(
        &self,
        task_id: &str,
        objective: String,
        expected_revision: Option<u64>,
    ) -> Result<CronTask, GoalMutationError> {
        let objective = objective.trim().to_string();
        if objective.is_empty() {
            return Err(GoalMutationError::goal("Goal objective is required"));
        }
        let mut tasks = self.tasks.write().await;
        let mut next = tasks.clone();
        let task = next
            .get_mut(task_id)
            .ok_or_else(|| GoalMutationError::goal(format!("Task not found: {}", task_id)))?;
        if !task.is_goal() {
            return Err(GoalMutationError::goal("Task is not a Goal Mode task"));
        }
        if task.goal_status.as_ref().is_some_and(is_goal_terminal) {
            return Err(GoalMutationError::terminal("Cannot edit a terminal Goal"));
        }
        if expected_revision.is_some_and(|revision| revision != task.goal_revision) {
            return Err(GoalMutationError::stale_revision(format!(
                "expected {}, current {}",
                expected_revision.unwrap_or_default(),
                task.goal_revision
            )));
        }
        let has_authority_to_invalidate =
            task.goal_turn_lease.is_some() || !task.goal_user_admissions.is_empty();
        if task.goal_objective.as_deref() == Some(objective.as_str())
            && !has_authority_to_invalidate
        {
            return Ok(enrich_task(task.clone()));
        }
        invalidate_goal_turn_lease(task);
        task.goal_user_admissions.clear();
        let now = Utc::now();
        task.prompt = objective.clone();
        task.goal_objective = Some(objective);
        task.goal_updated_at = Some(now);
        task.updated_at = now;
        task.bump_goal_revision();
        task.bump_goal_control_revision();
        let updated = task.clone();
        atomic_save_task_snapshot(
            &self.storage_path,
            next.values().cloned().collect::<Vec<_>>(),
        )
        .await?;
        *tasks = next;
        drop(tasks);
        let handle = self.app_handle.read().await.clone();
        if let Some(ref handle) = handle {
            let _ = handle.emit(
                "cron:task-updated",
                serde_json::json!({ "taskId": task_id, "goalObjectiveUpdated": true }),
            );
        }
        self.emit_goal_changed(&updated, "objective_updated").await;
        Ok(enrich_task(updated))
    }

    /// Reserve a desktop/IM user turn before dispatch. The accepted/aborted
    /// finalizer is intentionally separate from the scheduler lease lifecycle.
    #[cfg(test)]
    pub async fn reserve_goal_user_admission(
        &self,
        task_id: &str,
        admission_id: &str,
        expected_revision: u64,
        admission_kind: GoalUserAdmissionKind,
    ) -> Result<(CronTask, GoalUserAdmission), GoalMutationError> {
        self.reserve_goal_user_admission_at_objective(
            task_id,
            admission_id,
            expected_revision,
            admission_kind,
            None,
            None,
        )
        .await
    }

    #[cfg(test)]
    pub async fn reserve_goal_user_admission_at_objective(
        &self,
        task_id: &str,
        admission_id: &str,
        expected_revision: u64,
        admission_kind: GoalUserAdmissionKind,
        expected_objective: Option<&str>,
        expected_control_revision: Option<u64>,
    ) -> Result<(CronTask, GoalUserAdmission), GoalMutationError> {
        self.reserve_goal_user_admission_inner(
            task_id,
            admission_id,
            expected_revision,
            admission_kind,
            expected_objective,
            expected_control_revision,
            0,
            None,
        )
        .await
    }

    pub async fn reserve_goal_user_admission_from_sidecar(
        &self,
        task_id: &str,
        admission_id: &str,
        expected_revision: u64,
        admission_kind: GoalUserAdmissionKind,
        expected_objective: Option<&str>,
        expected_control_revision: Option<u64>,
        session_id: &str,
        sidecar_generation: u64,
        sidecars: &ManagedSidecarManager,
    ) -> Result<(CronTask, GoalUserAdmission), GoalMutationError> {
        self.reserve_goal_user_admission_inner(
            task_id,
            admission_id,
            expected_revision,
            admission_kind,
            expected_objective,
            expected_control_revision,
            sidecar_generation,
            Some((sidecars, session_id)),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn reserve_goal_user_admission_inner(
        &self,
        task_id: &str,
        admission_id: &str,
        expected_revision: u64,
        admission_kind: GoalUserAdmissionKind,
        expected_objective: Option<&str>,
        expected_control_revision: Option<u64>,
        sidecar_generation: u64,
        sidecar_binding: Option<(&ManagedSidecarManager, &str)>,
    ) -> Result<(CronTask, GoalUserAdmission), GoalMutationError> {
        let mut tasks = self.tasks.write().await;
        let mut next = tasks.clone();
        let task = next
            .get_mut(task_id)
            .ok_or_else(|| GoalMutationError::goal(format!("Task not found: {}", task_id)))?;
        if !task.is_goal() {
            return Err(GoalMutationError::goal("Task is not a Goal Mode task"));
        }
        if task.status != TaskStatus::Running {
            return Err(GoalMutationError::goal("Goal is not running"));
        }
        if task.goal_status.as_ref().is_some_and(is_goal_terminal) {
            return Err(GoalMutationError::terminal("Goal is already terminal"));
        }
        if let Some((sidecars, session_id)) = sidecar_binding {
            if !goal_sidecar_generation_is_current(sidecars, session_id, sidecar_generation)? {
                return Err(GoalMutationError::stale_admission(format!(
                    "Sidecar generation {sidecar_generation} is no longer current"
                )));
            }
        }
        let now = Utc::now();
        if let Some(existing) = task
            .goal_user_admissions
            .iter()
            .find(|admission| admission.id == admission_id)
        {
            if existing.sidecar_generation != sidecar_generation {
                return Err(GoalMutationError::stale_admission(
                    "user Goal admission belongs to a previous Sidecar",
                ));
            }
            return Ok((enrich_task(task.clone()), existing.clone()));
        }
        let same_user_query_epoch = admission_kind == GoalUserAdmissionKind::UserQuery
            && expected_objective
                .map(str::trim)
                .is_some_and(|objective| task.goal_objective.as_deref() == Some(objective))
            && expected_control_revision == Some(task.goal_control_revision);
        if task.goal_revision != expected_revision && !same_user_query_epoch {
            return Err(GoalMutationError::stale_revision(format!(
                "expected {}, current {}",
                expected_revision, task.goal_revision
            )));
        }
        if admission_kind == GoalUserAdmissionKind::ObjectiveRestart
            && task
                .goal_turn_lease
                .as_ref()
                .is_some_and(|lease| lease.state == GoalTurnLeaseState::Claimed)
        {
            return Err(GoalMutationError::lease_conflict(
                "scheduler turn claimed before objective restart",
            ));
        }
        let turn_number = task
            .goal_user_admissions
            .iter()
            .map(|admission| admission.turn_number)
            .chain(task.goal_turn_lease.iter().map(|lease| lease.turn_number))
            .fold(task.execution_count, u32::max)
            .saturating_add(1);
        task.goal_updated_at = Some(now);
        task.updated_at = now;
        task.bump_goal_revision();
        let admission = GoalUserAdmission {
            id: admission_id.to_string(),
            revision: task.goal_revision,
            turn_number,
            state: GoalUserAdmissionState::Pending,
            sidecar_generation,
            created_at: now,
        };
        task.goal_user_admissions.push(admission.clone());
        let updated = task.clone();
        atomic_save_task_snapshot(
            &self.storage_path,
            next.values().cloned().collect::<Vec<_>>(),
        )
        .await?;
        *tasks = next;
        drop(tasks);

        self.emit_goal_changed(&updated, "user_admission_reserved")
            .await;
        Ok((enrich_task(updated), admission))
    }

    #[cfg(test)]
    pub async fn claim_goal_user_admission(
        &self,
        task_id: &str,
        admission_id: &str,
    ) -> Result<(CronTask, GoalUserAdmission), GoalMutationError> {
        self.claim_goal_user_admission_inner(task_id, admission_id, 0, None)
            .await
    }

    pub async fn claim_goal_user_admission_from_sidecar(
        &self,
        task_id: &str,
        admission_id: &str,
        session_id: &str,
        sidecar_generation: u64,
        sidecars: &ManagedSidecarManager,
    ) -> Result<(CronTask, GoalUserAdmission), GoalMutationError> {
        self.claim_goal_user_admission_inner(
            task_id,
            admission_id,
            sidecar_generation,
            Some((sidecars, session_id)),
        )
        .await
    }

    async fn claim_goal_user_admission_inner(
        &self,
        task_id: &str,
        admission_id: &str,
        sidecar_generation: u64,
        sidecar_binding: Option<(&ManagedSidecarManager, &str)>,
    ) -> Result<(CronTask, GoalUserAdmission), GoalMutationError> {
        let mut tasks = self.tasks.write().await;
        let mut next = tasks.clone();
        let task = next
            .get_mut(task_id)
            .ok_or_else(|| GoalMutationError::goal(format!("Task not found: {}", task_id)))?;
        if !task.is_goal() {
            return Err(GoalMutationError::goal("Task is not a Goal Mode task"));
        }
        if let Some((sidecars, session_id)) = sidecar_binding {
            if !goal_sidecar_generation_is_current(sidecars, session_id, sidecar_generation)? {
                return Err(GoalMutationError::stale_admission(format!(
                    "Sidecar generation {sidecar_generation} is no longer current"
                )));
            }
        }
        let now = Utc::now();
        let Some(index) = task
            .goal_user_admissions
            .iter()
            .position(|admission| admission.id == admission_id)
        else {
            return Err(GoalMutationError::stale_admission(
                "user Goal admission is no longer current",
            ));
        };
        let admission = task.goal_user_admissions[index].clone();
        if admission.sidecar_generation != sidecar_generation {
            return Err(GoalMutationError::stale_admission(
                "user Goal admission belongs to a previous Sidecar",
            ));
        }
        if task.goal_user_admissions[..index].iter().any(|earlier| {
            matches!(
                earlier.state,
                GoalUserAdmissionState::Pending | GoalUserAdmissionState::Claimed
            )
        }) {
            return Err(GoalMutationError::lease_conflict(
                "an earlier user Goal admission must dispatch first",
            ));
        }
        if task.status != TaskStatus::Running
            || task.goal_status.as_ref().is_some_and(is_goal_terminal)
        {
            return Err(GoalMutationError::terminal("Goal is no longer active"));
        }
        if admission.state != GoalUserAdmissionState::Pending {
            return Ok((enrich_task(task.clone()), admission));
        }
        let current = &mut task.goal_user_admissions[index];
        current.state = GoalUserAdmissionState::Claimed;
        let claimed = current.clone();
        task.goal_updated_at = Some(now);
        task.updated_at = now;
        task.bump_goal_revision();
        let updated = task.clone();
        atomic_save_task_snapshot(
            &self.storage_path,
            next.values().cloned().collect::<Vec<_>>(),
        )
        .await?;
        *tasks = next;
        drop(tasks);
        self.emit_goal_changed(&updated, "user_admission_claimed")
            .await;
        Ok((enrich_task(updated), claimed))
    }

    #[cfg(test)]
    pub async fn finalize_goal_user_admission(
        &self,
        task_id: &str,
        admission_id: &str,
        accepted: bool,
    ) -> Result<(CronTask, bool), GoalMutationError> {
        self.finalize_goal_user_admission_inner(task_id, admission_id, accepted, 0, None)
            .await
    }

    pub async fn abort_goal_user_admission(
        &self,
        task_id: &str,
        admission_id: &str,
    ) -> Result<(CronTask, bool), GoalMutationError> {
        self.finalize_goal_user_admission_inner(task_id, admission_id, false, 0, None)
            .await
    }

    pub async fn accept_goal_user_admission_from_sidecar(
        &self,
        task_id: &str,
        admission_id: &str,
        session_id: &str,
        sidecar_generation: u64,
        sidecars: &ManagedSidecarManager,
    ) -> Result<(CronTask, bool), GoalMutationError> {
        self.finalize_goal_user_admission_inner(
            task_id,
            admission_id,
            true,
            sidecar_generation,
            Some((sidecars, session_id)),
        )
        .await
    }

    async fn finalize_goal_user_admission_inner(
        &self,
        task_id: &str,
        admission_id: &str,
        accepted: bool,
        sidecar_generation: u64,
        sidecar_binding: Option<(&ManagedSidecarManager, &str)>,
    ) -> Result<(CronTask, bool), GoalMutationError> {
        let mut tasks = self.tasks.write().await;
        let mut next = tasks.clone();
        let task = next
            .get_mut(task_id)
            .ok_or_else(|| GoalMutationError::goal(format!("Task not found: {}", task_id)))?;
        if !task.is_goal() {
            return Err(GoalMutationError::goal("Task is not a Goal Mode task"));
        }
        let admission = task
            .goal_user_admissions
            .iter()
            .find(|admission| admission.id == admission_id)
            .cloned()
            .ok_or_else(|| {
                GoalMutationError::stale_admission("user Goal admission is no longer current")
            })?;
        if accepted {
            if let Some((sidecars, session_id)) = sidecar_binding {
                if admission.sidecar_generation != sidecar_generation
                    || !goal_sidecar_generation_is_current(
                        sidecars,
                        session_id,
                        sidecar_generation,
                    )?
                {
                    return Err(GoalMutationError::stale_admission(
                        "user Goal admission belongs to a previous Sidecar",
                    ));
                }
            }
        }
        if task.status != TaskStatus::Running
            || task.goal_status.as_ref().is_some_and(is_goal_terminal)
        {
            return Err(GoalMutationError::terminal("Goal is no longer active"));
        }

        if accepted && admission.state == GoalUserAdmissionState::Pending {
            return Err(GoalMutationError::stale_admission(
                "user Goal admission was not claimed before dispatch",
            ));
        }
        if accepted && admission.state == GoalUserAdmissionState::Dispatched {
            return Ok((enrich_task(task.clone()), false));
        }
        let resumed = accepted && task.goal_status == Some(GoalStatus::Paused);
        if accepted {
            if resumed {
                task.goal_status = Some(GoalStatus::Active);
                task.goal_paused_reason = None;
            }
            task.execution_count = task.execution_count.max(admission.turn_number);
            let current = task
                .goal_user_admissions
                .iter_mut()
                .find(|current| current.id == admission_id)
                .expect("admission checked above");
            current.state = GoalUserAdmissionState::Dispatched;
        } else {
            task.goal_user_admissions
                .retain(|current| current.id != admission_id);
        }
        let now = Utc::now();
        task.goal_updated_at = Some(now);
        task.updated_at = now;
        task.bump_goal_revision();
        let updated = task.clone();
        atomic_save_task_snapshot(
            &self.storage_path,
            next.values().cloned().collect::<Vec<_>>(),
        )
        .await?;
        *tasks = next;
        drop(tasks);

        let change_kind = if accepted {
            goal_admission_change_kind(resumed)
        } else {
            "user_admission_aborted"
        };
        self.emit_goal_changed(&updated, change_kind).await;
        Ok((enrich_task(updated), resumed))
    }

    pub async fn release_goal_user_admission(
        &self,
        task_id: &str,
        admission_id: &str,
    ) -> Result<CronTask, GoalMutationError> {
        let admission_id = admission_id.to_string();
        let (updated, changed) = self
            .commit_goal_mutation(task_id, move |task| {
                if task.goal_user_admissions.is_empty() {
                    return Ok(false);
                }
                let previous_len = task.goal_user_admissions.len();
                task.goal_user_admissions
                    .retain(|admission| admission.id != admission_id);
                if task.goal_user_admissions.len() == previous_len {
                    return Ok(false);
                }
                let now = Utc::now();
                task.goal_updated_at = Some(now);
                task.updated_at = now;
                task.bump_goal_revision();
                Ok(true)
            })
            .await?;
        if changed {
            self.emit_goal_changed(&updated, "user_admission_released")
                .await;
        }
        if changed
            && updated.status == TaskStatus::Stopped
            && updated.goal_status.as_ref().is_some_and(is_goal_terminal)
            && updated.goal_turn_lease.is_none()
            && updated.goal_user_admissions.is_empty()
        {
            self.stop_cron_task_sidecar_internal(&updated.session_id, task_id)
                .await;
        }
        Ok(enrich_task(updated))
    }

    /// Prepare a scheduler continuation without mutating durable Goal state.
    /// The returned pending lease is only a local candidate. Sidecar atomically
    /// admits and claims it after the Session becomes idle, immediately before
    /// runtime dispatch.
    pub async fn admit_goal_scheduler_turn(
        &self,
        task_id: &str,
        expected_revision: u64,
    ) -> Result<GoalSchedulerAdmission, GoalMutationError> {
        let tasks = self.tasks.read().await;
        let task = tasks
            .get(task_id)
            .ok_or_else(|| GoalMutationError::goal(format!("Task not found: {}", task_id)))?;
        if !task.is_goal() {
            return Err(GoalMutationError::goal("Task is not a Goal Mode task"));
        }
        if task.status != TaskStatus::Running
            || task.goal_status.as_ref().is_some_and(is_goal_terminal)
        {
            return Err(GoalMutationError::terminal("Goal is not active"));
        }
        if task.goal_status == Some(GoalStatus::Paused) {
            return Err(GoalMutationError::goal("Goal is paused"));
        }
        if task.goal_revision != expected_revision {
            return Err(GoalMutationError::stale_revision(format!(
                "expected {}, current {}",
                expected_revision, task.goal_revision
            )));
        }
        let now = Utc::now();
        if !task.goal_user_admissions.is_empty() {
            return Err(GoalMutationError::lease_conflict(
                "user Goal admission is pending",
            ));
        }
        if task.goal_turn_lease.is_some() {
            return Err(GoalMutationError::lease_conflict(
                "Goal already has a scheduler turn lease",
            ));
        }
        if !task.goal_delivery_outbox.is_empty() {
            return Err(GoalMutationError::lease_conflict(
                "Goal channel delivery must drain before automatic continuation",
            ));
        }

        let lease = GoalTurnLease {
            id: format!("goal_lease_{}", Uuid::new_v4().simple()),
            turn_number: task.execution_count.saturating_add(1),
            state: GoalTurnLeaseState::Pending,
            sidecar_generation: 0,
            created_at: now,
        };
        let mut prepared = task.clone();
        prepared.goal_turn_lease = Some(lease.clone());
        Ok(GoalSchedulerAdmission {
            task: enrich_task(prepared),
            lease,
            expected_revision,
        })
    }

    #[cfg(test)]
    pub async fn claim_goal_scheduler_turn(
        &self,
        task_id: &str,
        lease_id: &str,
        expected_revision: u64,
    ) -> Result<CronTask, GoalMutationError> {
        self.claim_goal_scheduler_turn_inner(task_id, lease_id, expected_revision, 0, None)
            .await
    }

    pub async fn claim_goal_scheduler_turn_from_sidecar(
        &self,
        task_id: &str,
        lease_id: &str,
        expected_revision: u64,
        session_id: &str,
        sidecar_generation: u64,
        sidecars: &ManagedSidecarManager,
    ) -> Result<CronTask, GoalMutationError> {
        self.claim_goal_scheduler_turn_inner(
            task_id,
            lease_id,
            expected_revision,
            sidecar_generation,
            Some((sidecars, session_id)),
        )
        .await
    }

    async fn claim_goal_scheduler_turn_inner(
        &self,
        task_id: &str,
        lease_id: &str,
        expected_revision: u64,
        sidecar_generation: u64,
        sidecar_binding: Option<(&ManagedSidecarManager, &str)>,
    ) -> Result<CronTask, GoalMutationError> {
        let mut tasks = self.tasks.write().await;
        let mut next = tasks.clone();
        let task = next
            .get_mut(task_id)
            .ok_or_else(|| GoalMutationError::goal(format!("Task not found: {}", task_id)))?;
        if !task.is_goal() {
            return Err(GoalMutationError::goal("Task is not a Goal Mode task"));
        }
        if let Some((sidecars, session_id)) = sidecar_binding {
            if !goal_sidecar_generation_is_current(sidecars, session_id, sidecar_generation)? {
                return Err(GoalMutationError::stale_lease(format!(
                    "Sidecar generation {sidecar_generation} is no longer current"
                )));
            }
        }
        if let Some(existing) = task.goal_turn_lease.as_ref() {
            if existing.id == lease_id
                && existing.state == GoalTurnLeaseState::Claimed
                && existing.sidecar_generation == sidecar_generation
            {
                return Ok(enrich_task(task.clone()));
            }
            return Err(GoalMutationError::lease_conflict(
                "Goal already has a claimed scheduler turn",
            ));
        }
        if task.status != TaskStatus::Running || task.goal_status != Some(GoalStatus::Active) {
            return Err(GoalMutationError::terminal("Goal is not active"));
        }
        if task.goal_revision != expected_revision {
            return Err(GoalMutationError::stale_revision(format!(
                "expected {}, current {}",
                expected_revision, task.goal_revision
            )));
        }
        let now = Utc::now();
        if !task.goal_user_admissions.is_empty() {
            return Err(GoalMutationError::lease_conflict(
                "user Goal admission is pending",
            ));
        }
        let lease = GoalTurnLease {
            id: lease_id.to_string(),
            turn_number: task.execution_count.saturating_add(1),
            state: GoalTurnLeaseState::Claimed,
            sidecar_generation,
            created_at: now,
        };
        task.goal_turn_lease = Some(lease);
        task.goal_updated_at = Some(now);
        task.updated_at = now;
        task.bump_goal_revision();
        let updated = task.clone();
        atomic_save_task_snapshot(
            &self.storage_path,
            next.values().cloned().collect::<Vec<_>>(),
        )
        .await?;
        *tasks = next;
        drop(tasks);
        self.emit_goal_changed(&updated, "turn_claimed").await;
        Ok(enrich_task(updated))
    }

    pub async fn revoke_goal_scheduler_lease(
        &self,
        task_id: &str,
        lease_id: &str,
    ) -> Result<CronTask, GoalMutationError> {
        let lease_id = lease_id.to_string();
        let (updated, changed) = self
            .commit_goal_mutation(task_id, move |task| {
                if !task
                    .goal_turn_lease
                    .as_ref()
                    .is_some_and(|lease| lease.id == lease_id)
                {
                    return Ok(false);
                }
                invalidate_goal_turn_lease(task);
                let now = Utc::now();
                task.goal_updated_at = Some(now);
                task.updated_at = now;
                task.bump_goal_revision();
                Ok(true)
            })
            .await?;
        if changed {
            self.emit_goal_changed(&updated, "turn_revoked").await;
        }
        Ok(enrich_task(updated))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn finalize_goal_scheduler_turn(
        &self,
        task_id: &str,
        lease_id: &str,
        success: bool,
        error: Option<String>,
        duration_ms: u64,
        internal_session_id: Option<String>,
        output_text: Option<String>,
        channel_delivery_expected: bool,
    ) -> Result<GoalTurnFinalization, GoalMutationError> {
        let mut tasks = self.tasks.write().await;
        let mut next = tasks.clone();
        let task = next
            .get(task_id)
            .ok_or_else(|| GoalMutationError::goal(format!("Task not found: {}", task_id)))?;
        if !task.is_goal() {
            return Err(GoalMutationError::goal("Task is not a Goal Mode task"));
        }
        let lease_matches = task.goal_turn_lease.as_ref().is_some_and(|lease| {
            lease.id == lease_id && lease.state == GoalTurnLeaseState::Claimed
        });
        if !lease_matches {
            return Ok(GoalTurnFinalization {
                task: enrich_task(task.clone()),
                applied: false,
                delivery_enqueued: false,
            });
        }

        let finalized_turn_number = task
            .goal_turn_lease
            .as_ref()
            .expect("matching Goal lease checked before finalization")
            .turn_number;
        let now = Utc::now();
        let task = next
            .get_mut(task_id)
            .expect("Goal task checked before finalization");
        task.goal_turn_lease = None;
        task.execution_count = task.execution_count.max(finalized_turn_number);
        task.last_executed_at = Some(now);
        task.last_run_ok = Some(success);
        task.last_run_duration_ms = Some(duration_ms);
        task.last_error = if success { None } else { error.clone() };
        task.goal_consecutive_failures = if success {
            0
        } else {
            task.goal_consecutive_failures.saturating_add(1)
        };
        if let Some(session_id) = internal_session_id {
            task.internal_session_id = Some(session_id);
        }
        let mut delivery_enqueued = false;
        if success && channel_delivery_expected {
            if let Some(text) = output_text
                .as_deref()
                .filter(|text| !text.trim().is_empty())
            {
                let delivery_id = format!("goal_delivery_{}", lease_id);
                if !task
                    .goal_delivery_outbox
                    .iter()
                    .any(|item| item.id == delivery_id)
                {
                    task.goal_delivery_outbox.push(GoalDeliveryOutboxItem {
                        id: delivery_id,
                        lease_id: lease_id.to_string(),
                        session_id: task.session_id.clone(),
                        text: truncate_goal_delivery_text(text),
                        state: GoalDeliveryState::Pending,
                        attempts: 0,
                        created_at: now,
                        last_error: None,
                    });
                    delivery_enqueued = true;
                }
            }
        }
        task.goal_updated_at = Some(now);
        task.updated_at = now;
        task.bump_goal_revision();
        let release_terminal_owner = task.status == TaskStatus::Stopped
            && task.goal_status.as_ref().is_some_and(is_goal_terminal);
        let session_id = task.session_id.clone();
        let updated = task.clone();
        atomic_save_task_snapshot(
            &self.storage_path,
            next.values().cloned().collect::<Vec<_>>(),
        )
        .await?;
        *tasks = next;
        drop(tasks);

        if release_terminal_owner {
            self.stop_cron_task_sidecar_internal(&session_id, task_id)
                .await;
        }

        self.emit_goal_changed(&updated, "execution_complete").await;

        Ok(GoalTurnFinalization {
            task: enrich_task(updated),
            applied: true,
            delivery_enqueued,
        })
    }

    async fn flush_goal_delivery_outbox_once(&self, task_id: &str) -> Result<bool, String> {
        let item = {
            let mut tasks = self.tasks.write().await;
            let mut next = tasks.clone();
            let Some(task) = next.get_mut(task_id) else {
                return Ok(true);
            };
            let Some(item) = task.goal_delivery_outbox.first_mut() else {
                return Ok(true);
            };
            // `Sending` is a crash marker, not a lock. This method has a
            // single replayer owner per Goal; retrying may duplicate a push
            // that succeeded before its commit failed, which is the intended
            // at-least-once contract and avoids a permanent in-process stall.
            item.state = GoalDeliveryState::Sending;
            item.attempts = item.attempts.saturating_add(1);
            item.last_error = None;
            let claimed = item.clone();
            task.bump_goal_revision();
            atomic_save_task_snapshot(
                &self.storage_path,
                next.values().cloned().collect::<Vec<_>>(),
            )
            .await?;
            *tasks = next;
            claimed
        };

        let handle = self.app_handle.read().await.clone();
        let delivery = if let Some(handle) = handle {
            let agents = handle.try_state::<crate::im::ManagedAgents>();
            let im_bots = handle.try_state::<crate::im::ManagedImBots>();
            crate::im::session_delivery::push_assistant_text_for_session(
                agents.as_deref(),
                im_bots.as_deref(),
                &item.session_id,
                &item.text,
            )
            .await
        } else {
            Err("App handle is unavailable for Goal channel delivery".to_string())
        };

        let delivered = goal_delivery_was_acknowledged(&delivery);
        let delivery_error = match delivery {
            Ok(true) => None,
            Ok(false) => Some("Goal channel is not bound yet".to_string()),
            Err(error) => Some(error),
        };
        let (updated, _) = self
            .commit_goal_mutation(task_id, move |task| {
                let Some(index) = task
                    .goal_delivery_outbox
                    .iter()
                    .position(|pending| pending.id == item.id)
                else {
                    return Ok(false);
                };
                if delivered {
                    task.goal_delivery_outbox.remove(index);
                } else if let Some(pending) = task.goal_delivery_outbox.get_mut(index) {
                    pending.state = GoalDeliveryState::Pending;
                    pending.last_error = delivery_error.clone();
                }
                task.bump_goal_revision();
                Ok(true)
            })
            .await
            .map_err(|error| error.to_string())?;
        Ok(updated.goal_delivery_outbox.is_empty())
    }

    pub async fn flush_goal_delivery_outbox_with_retry(
        &self,
        task_id: &str,
    ) -> Result<bool, String> {
        for delay_secs in [0_u64, 3, 10, 30] {
            if delay_secs > 0 {
                tokio::time::sleep(Duration::from_secs(delay_secs)).await;
            }
            if self.flush_goal_delivery_outbox_once(task_id).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub async fn goal_delivery_outbox_task_ids(&self) -> Vec<String> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|task| !task.goal_delivery_outbox.is_empty())
            .map(|task| task.id.clone())
            .collect()
    }

    pub async fn replay_goal_delivery_outbox_until_empty(&self, task_id: &str) {
        loop {
            if *self.shutdown.read().await {
                return;
            }
            match self.flush_goal_delivery_outbox_with_retry(task_id).await {
                Ok(true) => return,
                Ok(false) => {}
                Err(error) => {
                    ulog_warn!(
                        "[CronTask] Goal delivery outbox replay failed for {}: {}",
                        task_id,
                        error
                    );
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }

    /// Ensure a single retry worker owns this Goal's durable channel outbox.
    /// The final empty check is serialized with worker registration so an
    /// enqueue racing worker shutdown cannot leave a pending item orphaned.
    pub async fn ensure_goal_delivery_replay(&'static self, task_id: &str) {
        let task_id = task_id.to_string();
        {
            let mut replayers = self.goal_delivery_replayers.write().await;
            if !replayers.insert(task_id.clone()) {
                return;
            }
        }

        tauri::async_runtime::spawn(async move {
            loop {
                self.replay_goal_delivery_outbox_until_empty(&task_id).await;
                if *self.shutdown.read().await {
                    self.goal_delivery_replayers.write().await.remove(&task_id);
                    return;
                }

                let mut replayers = self.goal_delivery_replayers.write().await;
                let has_pending = self
                    .tasks
                    .read()
                    .await
                    .get(&task_id)
                    .is_some_and(|task| !task.goal_delivery_outbox.is_empty());
                if has_pending {
                    drop(replayers);
                    continue;
                }
                replayers.remove(&task_id);
                ulog_info!("[CronTask] Goal delivery outbox drained for {}", task_id);
                return;
            }
        });
    }

    pub async fn mark_goal_terminal(
        &self,
        task_id: &str,
        status: GoalStatus,
        reason: Option<String>,
    ) -> Result<CronTask, GoalMutationError> {
        let outcome = self
            .transition_goal_terminal(task_id, status, reason, GoalTerminalActor::User)
            .await?;
        Ok(enrich_task(outcome.task().clone()))
    }

    pub async fn transition_goal_terminal(
        &self,
        task_id: &str,
        status: GoalStatus,
        reason: Option<String>,
        actor: GoalTerminalActor,
    ) -> Result<GoalTerminalOutcome, GoalMutationError> {
        if actor == GoalTerminalActor::Model {
            return Err(GoalMutationError::stale_lease(
                "model terminal update requires Sidecar-bound authority",
            ));
        }
        self.transition_goal_terminal_inner(task_id, status, reason, actor, None, None)
            .await
    }

    #[cfg(test)]
    pub async fn transition_goal_terminal_authorized(
        &self,
        task_id: &str,
        status: GoalStatus,
        reason: Option<String>,
        actor: GoalTerminalActor,
        authority_id: &str,
    ) -> Result<GoalTerminalOutcome, GoalMutationError> {
        self.transition_goal_terminal_inner(
            task_id,
            status,
            reason,
            actor,
            Some(authority_id),
            None,
        )
        .await
    }

    pub async fn transition_goal_terminal_authorized_from_sidecar(
        &self,
        task_id: &str,
        status: GoalStatus,
        reason: Option<String>,
        authority_id: &str,
        session_id: &str,
        sidecar_generation: u64,
        sidecars: &ManagedSidecarManager,
    ) -> Result<GoalTerminalOutcome, GoalMutationError> {
        self.transition_goal_terminal_inner(
            task_id,
            status,
            reason,
            GoalTerminalActor::Model,
            Some(authority_id),
            Some((sidecars, session_id, sidecar_generation)),
        )
        .await
    }

    async fn transition_goal_terminal_inner(
        &self,
        task_id: &str,
        status: GoalStatus,
        reason: Option<String>,
        actor: GoalTerminalActor,
        authority_id: Option<&str>,
        sidecar_binding: Option<(&ManagedSidecarManager, &str, u64)>,
    ) -> Result<GoalTerminalOutcome, GoalMutationError> {
        if !is_goal_terminal(&status) {
            return Err(GoalMutationError::goal(
                "Goal terminal status must be complete, blocked, or canceled",
            ));
        }
        match actor {
            GoalTerminalActor::Model
                if !matches!(status, GoalStatus::Complete | GoalStatus::Blocked) =>
            {
                return Err(GoalMutationError::goal(
                    "Model may only mark a Goal complete or blocked",
                ));
            }
            GoalTerminalActor::User if status != GoalStatus::Canceled => {
                return Err(GoalMutationError::goal(
                    "User Goal control may only cancel the Goal",
                ));
            }
            _ => {}
        }

        let mut tasks = self.tasks.write().await;
        let mut next = tasks.clone();
        let task = next
            .get_mut(task_id)
            .ok_or_else(|| GoalMutationError::goal(format!("Task not found: {}", task_id)))?;
        if !task.is_goal() {
            return Err(GoalMutationError::goal("Task is not a Goal Mode task"));
        }
        if task.goal_status.as_ref().is_some_and(is_goal_terminal) {
            return Ok(GoalTerminalOutcome::AlreadyTerminal(enrich_task(
                task.clone(),
            )));
        }
        let authority_matches_scheduler = authority_id.is_some_and(|authority| {
            task.goal_turn_lease.as_ref().is_some_and(|lease| {
                lease.id == authority && lease.state == GoalTurnLeaseState::Claimed
            })
        });
        let authority_matches_user = authority_id.is_some_and(|authority| {
            task.goal_user_admissions.iter().any(|admission| {
                admission.id == authority
                    && matches!(
                        admission.state,
                        GoalUserAdmissionState::Claimed | GoalUserAdmissionState::Dispatched
                    )
            })
        });
        if actor == GoalTerminalActor::Model {
            if let Some((sidecars, session_id, sidecar_generation)) = sidecar_binding {
                let authority_generation = if authority_matches_scheduler {
                    task.goal_turn_lease
                        .as_ref()
                        .map(|lease| lease.sidecar_generation)
                } else if authority_matches_user {
                    task.goal_user_admissions
                        .iter()
                        .find(|admission| admission.id == authority_id.unwrap_or_default())
                        .map(|admission| admission.sidecar_generation)
                } else {
                    None
                };
                if authority_generation != Some(sidecar_generation)
                    || !goal_sidecar_generation_is_current(
                        sidecars,
                        session_id,
                        sidecar_generation,
                    )?
                {
                    return Err(GoalMutationError::stale_lease(
                        "Goal turn authority belongs to a previous Sidecar",
                    ));
                }
            }
        }
        if actor == GoalTerminalActor::Model
            && !authority_matches_scheduler
            && !authority_matches_user
        {
            return Err(GoalMutationError::stale_lease(
                "Goal turn authority is missing or no longer current",
            ));
        }
        if actor == GoalTerminalActor::Model && !task.end_conditions.ai_can_exit {
            return Err(GoalMutationError::goal(
                "This Goal does not allow AI to end it",
            ));
        }

        let session_id = task.session_id.clone();
        let now = Utc::now();
        let defer_owner_release = actor == GoalTerminalActor::Model
            && (authority_matches_scheduler || authority_matches_user);
        task.status = TaskStatus::Stopped;
        task.exit_reason = reason.clone();
        task.goal_status = Some(status);
        task.goal_terminal_reason = reason.clone();
        task.goal_paused_reason = None;
        if !authority_matches_scheduler {
            invalidate_goal_turn_lease(task);
        }
        if authority_matches_user {
            let authority = authority_id.expect("matched user authority must exist");
            task.goal_user_admissions
                .retain(|admission| admission.id == authority);
        } else {
            task.goal_user_admissions.clear();
        }
        task.goal_updated_at = Some(now);
        task.updated_at = now;
        task.bump_goal_revision();
        task.bump_goal_control_revision();
        let updated = task.clone();
        atomic_save_task_snapshot(
            &self.storage_path,
            next.values().cloned().collect::<Vec<_>>(),
        )
        .await?;
        *tasks = next;
        drop(tasks);

        if !defer_owner_release {
            self.stop_cron_task_sidecar_internal(&session_id, task_id)
                .await;
        }

        let handle = self.app_handle.read().await.clone();
        if let Some(ref handle) = handle {
            let _ = handle.emit(
                "cron:task-stopped",
                serde_json::json!({
                    "taskId": task_id,
                    "exitReason": reason,
                }),
            );
            self.emit_goal_changed(&updated, "terminal").await;
            send_goal_terminal_notification(handle, &updated);
        }
        crate::task::mark_cron_completion_if_linked(task_id, updated.exit_reason.as_deref()).await;

        Ok(GoalTerminalOutcome::Applied(enrich_task(updated)))
    }

    /// Internal helper to release CronTask's ownership of the Session Sidecar
    /// With Session-centric Sidecar (Owner model), this only releases the CronTask owner.
    /// If Tab still owns the Sidecar, it continues running.
    async fn stop_cron_task_sidecar_internal(&self, session_id: &str, task_id: &str) {
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
                let result = sidecar_state
                    .lock()
                    .map(|mut manager| manager.release_cron_session(session_id, task_id));
                match result {
                    Ok(stopped) => {
                        if stopped {
                            ulog_info!(
                                "[CronTask] Released CronTask {} from session {}, Sidecar stopped (was last owner)",
                                task_id, session_id
                            );
                        } else {
                            ulog_info!(
                                "[CronTask] Released CronTask {} from session {}, Sidecar continues under another owner",
                                task_id, session_id
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
            } else {
                ulog_warn!(
                    "[CronTask] Cannot release CronTask {}: SidecarManager state not found",
                    task_id
                );
            }
        } else {
            ulog_warn!(
                "[CronTask] Cannot release CronTask {}: app handle not available",
                task_id
            );
        }
    }

    /// Delete a task
    /// Also releases CronTask's Sidecar ownership/projection if it was running.
    pub async fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks
            .remove(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let session_id = task.session_id.clone();
        let was_running = task.status == TaskStatus::Running;
        drop(tasks);

        // Release CronTask's Sidecar ownership/projection if it was running.
        if was_running {
            self.stop_cron_task_sidecar_internal(&session_id, task_id)
                .await;
        }

        self.save_to_disk().await?;

        // Cascade-clean the run history file. Best-effort: failure must not
        // block delete (file may not exist if task never executed).
        let runs_path = run_record_path(task_id);
        if runs_path.exists() {
            match std::fs::remove_file(&runs_path) {
                Ok(()) => ulog_info!("[CronTask] Removed run history: {}", runs_path.display()),
                Err(e) => ulog_warn!(
                    "[CronTask] Failed to remove run history {}: {}",
                    runs_path.display(),
                    e
                ),
            }
        }

        ulog_info!(
            "[CronTask] Deleted task: {} (was_running: {}, CronTask released)",
            task_id,
            was_running
        );

        Ok(())
    }

    /// Record task execution
    pub async fn record_execution(&self, task_id: &str) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;
        if task.is_goal() {
            return Err("Goal turns must be counted through Goal admission".to_string());
        }

        let now = Utc::now();
        task.execution_count += 1;
        task.last_executed_at = Some(now);
        task.updated_at = now;

        // Check end conditions
        let should_stop = self.check_end_conditions(task);
        if should_stop {
            task.status = TaskStatus::Stopped;
        }

        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(task_clone)
    }

    /// Check if task should end based on conditions
    fn check_end_conditions(&self, task: &CronTask) -> bool {
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

    /// Get tasks that need to be recovered (running status on app restart, enriched)
    pub async fn get_tasks_to_recover(&self) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|t| t.status == TaskStatus::Running)
            .cloned()
            .map(enrich_task)
            .collect()
    }

    /// Update task's tab association
    pub async fn update_task_tab(
        &self,
        task_id: &str,
        tab_id: Option<String>,
    ) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        task.tab_id = tab_id;
        let now = Utc::now();
        task.updated_at = now;
        if task.is_goal() {
            task.goal_updated_at = Some(now);
            task.bump_goal_revision();
        }
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(task_clone)
    }

    /// Update task's session ID (called when session is created after task creation)
    pub async fn update_task_session(
        &self,
        task_id: &str,
        session_id: String,
    ) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks
            .get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        ulog_info!(
            "[CronTask] Updating task {} sessionId: {:?} -> {}",
            task_id,
            task.session_id,
            session_id
        );
        task.session_id = session_id;
        let now = Utc::now();
        task.updated_at = now;
        if task.is_goal() {
            task.goal_updated_at = Some(now);
            task.bump_goal_revision();
        }
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(task_clone)
    }

    /// Shutdown the manager (stop all scheduler loops)
    pub async fn shutdown(&self) {
        {
            let mut shutdown = self.shutdown.write().await;
            *shutdown = true;
        }
        ulog_info!("[CronTask] Manager shutdown initiated, awaiting scheduler handles...");

        // Drain and await all scheduler handles (with timeout)
        let handles: Vec<(String, tauri::async_runtime::JoinHandle<()>)> = {
            let mut h = self.scheduler_handles.write().await;
            h.drain().collect()
        };
        for (id, handle) in handles {
            match tokio::time::timeout(Duration::from_secs(5), handle).await {
                Ok(Ok(())) => ulog_debug!("[CronTask] Scheduler {} joined", id),
                Ok(Err(e)) => ulog_warn!("[CronTask] Scheduler {} panicked: {}", id, e),
                Err(_) => ulog_warn!("[CronTask] Scheduler {} join timed out", id),
            }
        }
        ulog_info!("[CronTask] Manager shutdown complete");
    }

    /// Check if shutdown has been requested
    pub async fn is_shutdown(&self) -> bool {
        let shutdown = self.shutdown.read().await;
        *shutdown
    }
}

/// Global singleton instance
static CRON_TASK_MANAGER: std::sync::OnceLock<CronTaskManager> = std::sync::OnceLock::new();

/// Get the global CronTaskManager instance
pub fn get_cron_task_manager() -> &'static CronTaskManager {
    CRON_TASK_MANAGER.get_or_init(CronTaskManager::new)
}

#[cfg(test)]
mod architecture_boundary_tests {
    use super::*;

    fn config(workspace: &str, session: &str, prompt: &str) -> CronTaskConfig {
        CronTaskConfig {
            workspace_path: workspace.to_string(),
            session_id: session.to_string(),
            prompt: prompt.to_string(),
            interval_minutes: 5,
            end_conditions: EndConditions::default(),
            run_mode: RunMode::SingleSession,
            notify_enabled: true,
            tab_id: None,
            permission_mode: String::new(),
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

    fn manager(storage_path: PathBuf) -> CronTaskManager {
        CronTaskManager {
            tasks: Arc::new(RwLock::new(HashMap::new())),
            storage_path,
            shutdown: Arc::new(RwLock::new(false)),
            executing_tasks: Arc::new(RwLock::new(HashSet::new())),
            active_schedulers: Arc::new(RwLock::new(HashSet::new())),
            scheduler_handles: Arc::new(RwLock::new(HashMap::new())),
            goal_delivery_replayers: Arc::new(RwLock::new(HashSet::new())),
            app_handle: Arc::new(RwLock::new(None)),
        }
    }

    #[test]
    fn goal_creation_inherits_session_configuration_but_preserves_policy() {
        let mut input = config("/tmp/goal", "session-goal", "  finish this  ");
        input.end_conditions = EndConditions {
            deadline: None,
            max_executions: Some(7),
            ai_can_exit: false,
        };
        input.notify_enabled = false;
        input.permission_mode = "fullAgency".to_string();
        input.tab_id = Some("tab-stale".to_string());
        input.model = Some("model-stale".to_string());
        input.provider_env = Some(TaskProviderEnv::default());
        input.provider_id = Some("provider-stale".to_string());
        input.provider_intent = ProviderIntent::Explicit;
        input.runtime = Some("codex".to_string());
        input.runtime_config = Some(serde_json::json!({ "stale": true }));
        input.mcp_enabled_servers = Some(vec!["stale-mcp".to_string()]);
        input.managed_kind = Some(crate::task::MANAGED_KIND_MEMORY_GARDENER.to_string());
        input.source_bot_id = Some("bot-stale".to_string());
        input.delivery = Some(CronDelivery {
            bot_id: "bot-stale".to_string(),
            chat_id: "chat-stale".to_string(),
            platform: "test".to_string(),
        });
        input.task_id = Some("task-stale".to_string());

        let prepared = prepare_goal_create_config(input).expect("prepare Goal config");

        assert_eq!(prepared.prompt, "finish this");
        assert_eq!(prepared.goal_objective.as_deref(), Some("finish this"));
        assert_eq!(prepared.permission_mode, "fullAgency");
        assert_eq!(prepared.end_conditions.max_executions, Some(7));
        assert!(!prepared.end_conditions.ai_can_exit);
        assert!(!prepared.notify_enabled);
        assert_eq!(prepared.run_mode, RunMode::SingleSession);
        assert_eq!(prepared.schedule, Some(CronSchedule::Loop));
        assert_eq!(prepared.goal_status, Some(GoalStatus::Active));
        assert!(prepared.tab_id.is_none());
        assert!(prepared.model.is_none());
        assert!(prepared.provider_env.is_none());
        assert!(prepared.provider_id.is_none());
        assert_eq!(prepared.provider_intent, ProviderIntent::FollowAgent);
        assert!(prepared.runtime.is_none());
        assert!(prepared.runtime_config.is_none());
        assert!(prepared.mcp_enabled_servers.is_none());
        assert!(prepared.managed_kind.is_none());
        assert!(prepared.source_bot_id.is_none());
        assert!(prepared.delivery.is_none());
        assert!(prepared.task_id.is_none());
    }

    #[test]
    fn loop_failure_policy_has_one_backoff_sequence_and_terminal_threshold() {
        let mut failures = 0;
        let decisions = (0..9)
            .map(|_| register_loop_failure(&mut failures))
            .collect::<Vec<_>>();
        assert_eq!(
            decisions,
            vec![
                LoopFailureDecision::RetryAfter(3),
                LoopFailureDecision::RetryAfter(10),
                LoopFailureDecision::RetryAfter(30),
                LoopFailureDecision::RetryAfter(60),
                LoopFailureDecision::RetryAfter(120),
                LoopFailureDecision::RetryAfter(300),
                LoopFailureDecision::RetryAfter(300),
                LoopFailureDecision::RetryAfter(300),
                LoopFailureDecision::RetryAfter(300),
            ]
        );
        assert_eq!(
            register_loop_failure(&mut failures),
            LoopFailureDecision::Stop
        );
    }

    #[tokio::test]
    async fn ordinary_lookup_filters_goal_and_managed_before_selecting() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));

        let mut goal_config = config("/tmp/goal", "shared-session", "goal objective");
        goal_config.schedule = Some(CronSchedule::Loop);
        goal_config.goal_status = Some(GoalStatus::Active);
        goal_config.goal_objective = Some("goal objective".to_string());
        goal_config.goal_updated_at = Some(Utc::now());
        let goal = manager.create_task(goal_config).await.expect("create Goal");
        {
            let mut tasks = manager.tasks.write().await;
            let stored = tasks.get_mut(&goal.id).expect("stored Goal");
            stored.status = TaskStatus::Running;
            // Historical Goal rows may still carry a pre-session-owned tab id.
            stored.tab_id = Some("shared-tab".to_string());
        }
        assert!(manager
            .get_active_task_for_session("shared-session")
            .await
            .is_none());
        assert!(manager
            .get_active_task_for_tab("shared-tab")
            .await
            .is_none());

        let mut managed = config("/tmp/goal", "managed-session", "managed");
        managed.tab_id = Some("managed-tab".to_string());
        managed.managed_kind = Some(crate::task::MANAGED_KIND_MEMORY_GARDENER.to_string());
        let managed = manager
            .create_task(managed)
            .await
            .expect("create managed task");
        manager
            .start_task(&managed.id)
            .await
            .expect("start managed task");
        assert!(manager
            .get_active_task_for_session("managed-session")
            .await
            .is_none());
        assert!(manager
            .get_active_task_for_tab("managed-tab")
            .await
            .is_none());

        let mut ordinary = config("/tmp/goal", "ordinary-session", "ordinary");
        ordinary.tab_id = Some("shared-tab".to_string());
        let ordinary = manager
            .create_task(ordinary)
            .await
            .expect("create ordinary task");
        manager
            .start_task(&ordinary.id)
            .await
            .expect("start ordinary task");
        assert_eq!(
            manager
                .get_active_task_for_session("ordinary-session")
                .await
                .map(|task| task.id),
            Some(ordinary.id.clone())
        );
        assert_eq!(
            manager
                .get_active_task_for_tab("shared-tab")
                .await
                .map(|task| task.id),
            Some(ordinary.id)
        );
        assert!(
            manager
                .has_persistent_task_for_session("shared-session")
                .await
        );
        assert!(
            manager
                .has_persistent_task_for_session("managed-session")
                .await
        );
        let (running_count, protected_sessions) = manager.user_scheduler_lifecycle_snapshot().await;
        assert_eq!(running_count, 2, "Goal + ordinary Cron, excluding managed");
        assert_eq!(
            protected_sessions,
            vec!["ordinary-session".to_string(), "shared-session".to_string()]
        );
    }

    #[tokio::test]
    async fn paused_goal_keeps_session_protected_without_counting_as_running() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));
        let mut goal = config("/tmp/paused-goal", "paused-session", "resume later");
        goal.schedule = Some(CronSchedule::Loop);
        goal.goal_status = Some(GoalStatus::Active);
        goal.goal_objective = Some("resume later".to_string());
        goal.goal_updated_at = Some(Utc::now());
        let created = manager
            .create_task_with_initial_status(goal, TaskStatus::Running)
            .await
            .expect("create paused Goal");
        manager
            .pause_goal_task(&created.id, GoalPausedReason::UserStop)
            .await
            .expect("pause Goal");

        assert!(
            manager
                .has_persistent_task_for_session("paused-session")
                .await
        );
        let (running_count, protected_sessions) = manager.user_scheduler_lifecycle_snapshot().await;
        assert_eq!(running_count, 0);
        assert_eq!(protected_sessions, vec!["paused-session".to_string()]);
    }

    #[tokio::test]
    async fn goal_create_transaction_persists_a_visible_recoverable_shape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));
        let mut goal = config("/tmp/goal-create", "goal-session", "finish release");
        goal.schedule = Some(CronSchedule::Loop);
        goal.goal_status = Some(GoalStatus::Active);
        goal.goal_objective = Some("finish release".to_string());
        goal.goal_updated_at = Some(Utc::now());

        let created = manager
            .create_task_with_initial_status(goal.clone(), TaskStatus::Running)
            .await
            .expect("commit running Goal");
        assert_eq!(created.status, TaskStatus::Running);
        assert!(manager
            .get_goal_for_session("goal-session", Some("/tmp/goal-create"), false)
            .await
            .is_some());

        let mut duplicate_config = goal;
        duplicate_config.workspace_path = "/tmp/different-workspace".to_string();
        let duplicate = manager
            .create_task_with_initial_status(duplicate_config, TaskStatus::Running)
            .await
            .expect_err("unfinished Goal remains unique across workspace mismatches");
        assert!(duplicate.contains("unfinished Goal"));

        let persisted: CronTaskStore = serde_json::from_str(
            &std::fs::read_to_string(&manager.storage_path).expect("read persisted Goal"),
        )
        .expect("parse persisted Goal");
        let stored = persisted
            .tasks
            .into_iter()
            .find(|task| task.id == created.id)
            .expect("stored Goal");
        assert_eq!(stored.status, TaskStatus::Running);
        assert_eq!(stored.goal_status, Some(GoalStatus::Active));
    }

    #[tokio::test]
    async fn paused_stop_revokes_claimed_user_admission_before_late_accept() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));
        let mut config = config("/tmp/goal-stop", "session-stop", "finish release");
        config.schedule = Some(CronSchedule::Loop);
        config.goal_status = Some(GoalStatus::Active);
        config.goal_objective = Some("finish release".to_string());
        config.goal_updated_at = Some(Utc::now());
        let goal = manager.create_task(config).await.expect("create Goal");
        let running = manager.start_task(&goal.id).await.expect("start Goal");
        let paused = manager
            .pause_goal_task(&goal.id, GoalPausedReason::UserStop)
            .await
            .expect("initial pause");
        let (reserved, admission) = manager
            .reserve_goal_user_admission_at_objective(
                &goal.id,
                "user-1",
                paused.goal_revision,
                GoalUserAdmissionKind::UserQuery,
                paused.goal_objective.as_deref(),
                Some(paused.goal_control_revision),
            )
            .await
            .expect("reserve paused Goal query");
        manager
            .claim_goal_user_admission(&goal.id, &admission.id)
            .await
            .expect("claim paused Goal query");

        let stopped_again = manager
            .pause_goal_task(&goal.id, GoalPausedReason::UserStop)
            .await
            .expect("Stop revokes claimed authority");
        assert_eq!(stopped_again.goal_status, Some(GoalStatus::Paused));
        assert!(stopped_again.goal_user_admissions.is_empty());
        assert!(stopped_again.goal_control_revision > reserved.goal_control_revision);
        assert!(manager
            .finalize_goal_user_admission(&goal.id, &admission.id, true)
            .await
            .is_err());
        assert_eq!(
            manager
                .get_task(&goal.id)
                .await
                .expect("Goal remains")
                .goal_status,
            Some(GoalStatus::Paused)
        );
        assert_eq!(running.status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn user_admissions_claim_in_reservation_order() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));
        let mut config = config("/tmp/goal-order", "session-order", "finish release");
        config.schedule = Some(CronSchedule::Loop);
        config.goal_status = Some(GoalStatus::Active);
        config.goal_objective = Some("finish release".to_string());
        config.goal_updated_at = Some(Utc::now());
        let goal = manager.create_task(config).await.expect("create Goal");
        let running = manager.start_task(&goal.id).await.expect("start Goal");
        let (_, first) = manager
            .reserve_goal_user_admission_at_objective(
                &goal.id,
                "first",
                running.goal_revision,
                GoalUserAdmissionKind::UserQuery,
                running.goal_objective.as_deref(),
                Some(running.goal_control_revision),
            )
            .await
            .expect("reserve first");
        let latest = manager.get_task(&goal.id).await.expect("latest Goal");
        let (_, second) = manager
            .reserve_goal_user_admission_at_objective(
                &goal.id,
                "second",
                latest.goal_revision,
                GoalUserAdmissionKind::UserQuery,
                latest.goal_objective.as_deref(),
                Some(latest.goal_control_revision),
            )
            .await
            .expect("reserve second");

        let error = manager
            .claim_goal_user_admission(&goal.id, &second.id)
            .await
            .expect_err("second cannot overtake first");
        assert_eq!(error.code(), "lease_conflict");
        manager
            .claim_goal_user_admission(&goal.id, &first.id)
            .await
            .expect("first claims normally");
    }

    #[tokio::test]
    async fn queued_user_turn_follows_inflight_scheduler_turn_number() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));
        let mut config = config("/tmp/goal-turns", "session-turns", "finish release");
        config.schedule = Some(CronSchedule::Loop);
        config.goal_status = Some(GoalStatus::Active);
        config.goal_objective = Some("finish release".to_string());
        config.goal_updated_at = Some(Utc::now());
        let goal = manager.create_task(config).await.expect("create Goal");
        let running = manager.start_task(&goal.id).await.expect("start Goal");
        let candidate = manager
            .admit_goal_scheduler_turn(&goal.id, running.goal_revision)
            .await
            .expect("admit scheduler");
        let claimed = manager
            .claim_goal_scheduler_turn(&goal.id, &candidate.lease.id, candidate.expected_revision)
            .await
            .expect("claim scheduler");
        assert_eq!(claimed.execution_count, 0, "claim does not consume a turn");
        let (_, user) = manager
            .reserve_goal_user_admission_at_objective(
                &goal.id,
                "queued-user",
                claimed.goal_revision,
                GoalUserAdmissionKind::UserQuery,
                claimed.goal_objective.as_deref(),
                Some(claimed.goal_control_revision),
            )
            .await
            .expect("queue user behind scheduler");
        assert_eq!(candidate.lease.turn_number, 1);
        assert_eq!(user.turn_number, 2);
    }

    #[tokio::test]
    async fn durable_finalization_retries_same_lease_after_storage_recovers() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));
        let mut config = config("/tmp/goal-finalize", "session-finalize", "finish release");
        config.schedule = Some(CronSchedule::Loop);
        config.goal_status = Some(GoalStatus::Active);
        config.goal_objective = Some("finish release".to_string());
        config.goal_updated_at = Some(Utc::now());
        let goal = manager.create_task(config).await.expect("create Goal");
        manager.start_task(&goal.id).await.expect("start Goal");
        let current = manager.get_task(&goal.id).await.expect("running Goal");
        let candidate = manager
            .admit_goal_scheduler_turn(&goal.id, current.goal_revision)
            .await
            .expect("admit scheduler");
        manager
            .claim_goal_scheduler_turn(&goal.id, &candidate.lease.id, candidate.expected_revision)
            .await
            .expect("claim scheduler");

        std::fs::remove_file(&manager.storage_path).expect("remove storage");
        std::fs::create_dir(&manager.storage_path).expect("block storage path");
        let storage_path = manager.storage_path.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(25)).await;
            std::fs::remove_dir(storage_path).expect("restore storage path");
        });
        let request = GoalTurnFinalizationRequest {
            success: true,
            error: None,
            duration_ms: 25,
            internal_session_id: Some("session-finalize".to_string()),
            output_text: Some("done".to_string()),
            channel_delivery_expected: false,
        };
        let finalized = finalize_goal_turn_until_durable(
            &manager,
            &manager.shutdown,
            &goal.id,
            &candidate.lease.id,
            &request,
        )
        .await
        .expect("storage recovery finalizes same lease");
        assert!(finalized.applied);
        assert!(finalized.task.goal_turn_lease.is_none());
        assert_eq!(finalized.task.execution_count, 1);
    }

    #[tokio::test]
    async fn sending_outbox_item_retries_in_same_process() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));
        let mut config = config("/tmp/goal-outbox", "session-outbox", "finish release");
        config.schedule = Some(CronSchedule::Loop);
        config.goal_status = Some(GoalStatus::Active);
        config.goal_objective = Some("finish release".to_string());
        config.goal_updated_at = Some(Utc::now());
        let goal = manager.create_task(config).await.expect("create Goal");
        {
            let mut tasks = manager.tasks.write().await;
            tasks
                .get_mut(&goal.id)
                .expect("stored Goal")
                .goal_delivery_outbox
                .push(GoalDeliveryOutboxItem {
                    id: "delivery-1".to_string(),
                    lease_id: "lease-1".to_string(),
                    session_id: "session-outbox".to_string(),
                    text: "result".to_string(),
                    state: GoalDeliveryState::Sending,
                    attempts: 0,
                    created_at: Utc::now(),
                    last_error: None,
                });
        }
        manager
            .save_to_disk()
            .await
            .expect("persist Sending marker");

        assert!(!manager
            .flush_goal_delivery_outbox_once(&goal.id)
            .await
            .expect("same-process retry"));
        let item = manager
            .get_task(&goal.id)
            .await
            .expect("Goal")
            .goal_delivery_outbox
            .into_iter()
            .next()
            .expect("pending delivery");
        assert_eq!(item.state, GoalDeliveryState::Pending);
        assert_eq!(item.attempts, 1);
    }

    #[tokio::test]
    async fn pending_delivery_blocks_the_next_automatic_goal_turn() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));
        let mut config = config(
            "/tmp/goal-outbox-gate",
            "session-outbox-gate",
            "finish release",
        );
        config.schedule = Some(CronSchedule::Loop);
        config.goal_status = Some(GoalStatus::Active);
        config.goal_objective = Some("finish release".to_string());
        config.goal_updated_at = Some(Utc::now());
        let goal = manager
            .create_task_with_initial_status(config, TaskStatus::Running)
            .await
            .expect("create Goal");
        {
            let mut tasks = manager.tasks.write().await;
            tasks
                .get_mut(&goal.id)
                .expect("Goal")
                .goal_delivery_outbox
                .push(GoalDeliveryOutboxItem {
                    id: "delivery-pending".to_string(),
                    lease_id: "lease-finished".to_string(),
                    session_id: "session-outbox-gate".to_string(),
                    text: "result".to_string(),
                    state: GoalDeliveryState::Pending,
                    attempts: 0,
                    created_at: Utc::now(),
                    last_error: None,
                });
        }
        let revision = manager
            .get_task(&goal.id)
            .await
            .expect("Goal")
            .goal_revision;

        let error = manager
            .admit_goal_scheduler_turn(&goal.id, revision)
            .await
            .expect_err("automatic continuation waits for channel delivery");
        assert_eq!(error.code(), "lease_conflict");
    }

    #[tokio::test]
    async fn goal_failure_count_is_durable_and_success_resets_it() {
        let temp = tempfile::tempdir().expect("tempdir");
        let storage_path = temp.path().join("cron_tasks.json");
        let manager = manager(storage_path.clone());
        let mut config = config("/tmp/goal-failures", "session-failures", "finish release");
        config.schedule = Some(CronSchedule::Loop);
        config.goal_status = Some(GoalStatus::Active);
        config.goal_objective = Some("finish release".to_string());
        config.goal_updated_at = Some(Utc::now());
        let goal = manager
            .create_task_with_initial_status(config, TaskStatus::Running)
            .await
            .expect("create Goal");

        let candidate = manager
            .admit_goal_scheduler_turn(&goal.id, goal.goal_revision)
            .await
            .expect("admit failed turn");
        manager
            .claim_goal_scheduler_turn(&goal.id, &candidate.lease.id, candidate.expected_revision)
            .await
            .expect("claim failed turn");
        let failed = manager
            .finalize_goal_scheduler_turn(
                &goal.id,
                &candidate.lease.id,
                false,
                Some("runtime failed".to_string()),
                10,
                None,
                None,
                false,
            )
            .await
            .expect("finalize failed turn");
        assert_eq!(failed.task.goal_consecutive_failures, 1);
        let reloaded = CronTaskManager::load_tasks_from_file(&storage_path);
        assert_eq!(reloaded[&goal.id].goal_consecutive_failures, 1);

        let candidate = manager
            .admit_goal_scheduler_turn(&goal.id, failed.task.goal_revision)
            .await
            .expect("admit successful turn");
        manager
            .claim_goal_scheduler_turn(&goal.id, &candidate.lease.id, candidate.expected_revision)
            .await
            .expect("claim successful turn");
        let succeeded = manager
            .finalize_goal_scheduler_turn(
                &goal.id,
                &candidate.lease.id,
                true,
                None,
                10,
                None,
                None,
                false,
            )
            .await
            .expect("finalize successful turn");
        assert_eq!(succeeded.task.goal_consecutive_failures, 0);
        let reloaded = CronTaskManager::load_tasks_from_file(&storage_path);
        assert_eq!(reloaded[&goal.id].goal_consecutive_failures, 0);
    }

    #[tokio::test]
    async fn create_task_rejects_orphan_and_mixed_goal_shapes_but_keeps_internal_loop() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));

        let mut orphan = config("/tmp/goal-shape", "session-orphan", "ordinary");
        orphan.goal_objective = Some("orphan objective".to_string());
        let orphan_error = manager
            .create_task(orphan)
            .await
            .expect_err("Goal metadata without explicit identity must fail");
        assert!(orphan_error.contains("explicit goalStatus"));

        let mut mixed = config("/tmp/goal-shape", "session-mixed", "objective");
        mixed.schedule = Some(CronSchedule::Every {
            minutes: 5,
            start_at: None,
            catch_up_window: None,
        });
        mixed.goal_status = Some(GoalStatus::Active);
        mixed.goal_objective = Some("objective".to_string());
        mixed.goal_updated_at = Some(Utc::now());
        let mixed_error = manager
            .create_task(mixed)
            .await
            .expect_err("Goal identity with an ordinary schedule must fail");
        assert!(mixed_error.contains("schedule.kind=loop"));

        let mut internal_loop = config("/tmp/goal-shape", "session-loop", "internal loop");
        internal_loop.schedule = Some(CronSchedule::Loop);
        let internal_loop = manager
            .create_task(internal_loop)
            .await
            .expect("loop shape without goalStatus remains an internal ordinary task");
        assert!(!internal_loop.is_goal());
    }

    #[tokio::test]
    async fn goal_creation_rejects_pending_session_identity() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));
        let mut pending = config("/tmp/goal-rebind", "pending-tab-1", "finish release");
        pending.schedule = Some(CronSchedule::Loop);
        pending.goal_status = Some(GoalStatus::Active);
        pending.goal_objective = Some("finish release".to_string());
        pending.goal_updated_at = Some(Utc::now());
        let error = manager
            .create_task(pending)
            .await
            .expect_err("pending Goal identity must be materialized first");
        assert!(error.contains("materialized sessionId"));
        assert!(manager.get_all_tasks().await.is_empty());
    }

    #[tokio::test]
    async fn terminal_persist_failure_keeps_goal_active_for_protector_retry() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = manager(temp.path().join("cron_tasks.json"));
        let mut config = config("/tmp/goal-protector", "session-1", "finish release");
        config.schedule = Some(CronSchedule::Loop);
        config.goal_status = Some(GoalStatus::Active);
        config.goal_objective = Some("finish release".to_string());
        config.goal_updated_at = Some(Utc::now());
        let goal = manager.create_task(config).await.expect("create Goal");
        manager.start_task(&goal.id).await.expect("start Goal");

        std::fs::remove_file(&manager.storage_path).expect("remove storage file");
        std::fs::create_dir(&manager.storage_path).expect("replace storage with directory");
        manager
            .transition_goal_terminal(
                &goal.id,
                GoalStatus::Blocked,
                Some("failure protector".to_string()),
                GoalTerminalActor::System,
            )
            .await
            .expect_err("disk failure must reject terminal transition");
        let still_active = manager
            .get_task(&goal.id)
            .await
            .expect("Goal remains loaded");
        assert_eq!(still_active.goal_status, Some(GoalStatus::Active));
        assert_ne!(still_active.status, TaskStatus::Stopped);

        std::fs::remove_dir(&manager.storage_path).expect("remove blocking directory");
        manager
            .transition_goal_terminal(
                &goal.id,
                GoalStatus::Blocked,
                Some("failure protector".to_string()),
                GoalTerminalActor::System,
            )
            .await
            .expect("protector retry persists terminal state");
        let blocked = manager.get_task(&goal.id).await.expect("blocked Goal");
        assert_eq!(blocked.goal_status, Some(GoalStatus::Blocked));
        assert_eq!(blocked.status, TaskStatus::Stopped);
    }
}
