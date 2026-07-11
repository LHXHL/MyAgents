use super::*;

/// Stable machine-readable classification for Goal mutation failures.
///
/// The Management API serializes this value directly. Human-readable error
/// text remains intentionally separate so callers never need to recover
/// protocol state by parsing a message prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalMutationErrorCode {
    StaleRevision,
    StaleAdmission,
    StaleLease,
    LeaseConflict,
    Terminal,
    GoalChanged,
    GoalError,
}

impl GoalMutationErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StaleRevision => "stale_revision",
            Self::StaleAdmission => "stale_admission",
            Self::StaleLease => "stale_lease",
            Self::LeaseConflict => "lease_conflict",
            Self::Terminal => "terminal",
            Self::GoalChanged => "goal_changed",
            Self::GoalError => "goal_error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalMutationError {
    code: GoalMutationErrorCode,
    message: String,
}

impl GoalMutationError {
    pub fn new(code: GoalMutationErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn coded(code: GoalMutationErrorCode, detail: impl AsRef<str>) -> Self {
        Self::new(code, detail.as_ref())
    }

    pub fn code(&self) -> &'static str {
        self.code.as_str()
    }

    pub fn goal(message: impl Into<String>) -> Self {
        Self::new(GoalMutationErrorCode::GoalError, message)
    }

    pub fn stale_revision(detail: impl AsRef<str>) -> Self {
        Self::coded(GoalMutationErrorCode::StaleRevision, detail)
    }

    pub fn stale_admission(detail: impl AsRef<str>) -> Self {
        Self::coded(GoalMutationErrorCode::StaleAdmission, detail)
    }

    pub fn stale_lease(detail: impl AsRef<str>) -> Self {
        Self::coded(GoalMutationErrorCode::StaleLease, detail)
    }

    pub fn lease_conflict(detail: impl AsRef<str>) -> Self {
        Self::coded(GoalMutationErrorCode::LeaseConflict, detail)
    }

    pub fn terminal(detail: impl AsRef<str>) -> Self {
        Self::coded(GoalMutationErrorCode::Terminal, detail)
    }

    pub fn goal_changed(detail: impl AsRef<str>) -> Self {
        Self::coded(GoalMutationErrorCode::GoalChanged, detail)
    }
}

impl std::fmt::Display for GoalMutationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.code == GoalMutationErrorCode::GoalError {
            formatter.write_str(&self.message)
        } else {
            write!(formatter, "{}: {}", self.code.as_str(), self.message)
        }
    }
}

impl std::error::Error for GoalMutationError {}

impl From<String> for GoalMutationError {
    fn from(message: String) -> Self {
        Self::goal(message)
    }
}

impl From<&str> for GoalMutationError {
    fn from(message: &str) -> Self {
        Self::goal(message)
    }
}

/// Run mode for cron tasks
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// Keep session context between executions
    SingleSession,
    /// Create new session for each execution (no memory)
    NewSession,
}

/// Task status (simplified: only Running and Stopped)
/// Stopped includes: manual stop, end conditions met, AI exit
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Task is running and will execute at intervals
    Running,
    /// Task was stopped (includes: manual stop, end conditions met, AI exit)
    Stopped,
}

/// Goal Mode lifecycle state. This is intentionally separate from
/// `TaskStatus`: `TaskStatus::Running` means the scheduler/Sidecar owner is
/// still retained, while `GoalStatus::Paused` means the loop should wait for a
/// user query before continuing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Paused,
    Complete,
    Blocked,
    Canceled,
}

impl GoalStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Complete | Self::Blocked | Self::Canceled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalPausedReason {
    UserStop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalTerminalActor {
    Model,
    User,
    System,
}

#[derive(Debug, Clone)]
pub enum GoalTerminalOutcome {
    Applied(CronTask),
    AlreadyTerminal(CronTask),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalTurnLeaseState {
    Pending,
    Claimed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalTurnLease {
    pub id: String,
    pub turn_number: u32,
    pub state: GoalTurnLeaseState,
    /// Unique Rust Sidecar process generation that owns this authority.
    #[serde(default)]
    pub sidecar_generation: u64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalUserAdmissionState {
    #[default]
    Pending,
    Claimed,
    Dispatched,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalUserAdmissionKind {
    UserQuery,
    ObjectiveRestart,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalUserAdmission {
    pub id: String,
    pub revision: u64,
    pub turn_number: u32,
    #[serde(default)]
    pub state: GoalUserAdmissionState,
    /// Unique Rust Sidecar process generation that admitted this turn.
    #[serde(default)]
    pub sidecar_generation: u64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalDeliveryState {
    Pending,
    Sending,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalDeliveryOutboxItem {
    pub id: String,
    pub lease_id: String,
    pub session_id: String,
    pub text: String,
    pub state: GoalDeliveryState,
    pub attempts: u32,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl GoalTerminalOutcome {
    pub fn task(&self) -> &CronTask {
        match self {
            Self::Applied(task) | Self::AlreadyTerminal(task) => task,
        }
    }

    pub fn was_applied(&self) -> bool {
        matches!(self, Self::Applied(_))
    }
}

/// End conditions for a cron task
///
/// `skip_serializing_if = "Option::is_none"` on the optional fields is
/// load-bearing: without it, Rust serializes `None` as JSON `null`, and the
/// renderer's modal init code (`CronTaskSettingsModal::endCondInit`) checks
/// `ec.maxExecutions !== undefined` to decide whether the task has end
/// conditions. `null !== undefined` is `true` in JS, so a "永久运行" task
/// (deadline=None, max_executions=None, ai_can_exit=false) would round-trip
/// through Rust as `{deadline: null, maxExecutions: null, aiCanExit: false}`
/// and the modal would mistakenly display "条件停止 + 执行次数 10". Skipping
/// the None fields keeps the JSON shape aligned with TS optional convention
/// (omit the property → `undefined` in the consumer).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EndConditions {
    /// Task will stop after this time (ISO timestamp)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<DateTime<Utc>>,
    /// Task will stop after this many executions
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_executions: Option<u32>,
    /// Allow AI to exit the task via ExitCronTask tool
    pub ai_can_exit: bool,
}

/// Provider environment for task execution
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderEnv {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens_param_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_format: Option<String>,
}

/// Explicit provider routing intent for a cron task (PRD #119, 2026-05).
///
/// Pre-#119, cron tasks could not unambiguously express their routing
/// intent: `provider_env: None` could mean "follow the workspace agent"
/// (legacy default) OR "explicitly use Anthropic subscription". The
/// sidecar handler had to guess — and silently picked "follow agent",
/// which caused subscription-intent crons to inherit a third-party
/// `providerEnvJson` from the agent snapshot when the user later changed
/// the agent's provider. The mirror failure (third-party intent silently
/// overridden by agent snapshot) was the original report.
///
/// This enum makes intent first-class:
///
///   - `FollowAgent` — pre-#119 default. Snapshot resolution at execute
///     time; agent changes between ticks affect this cron. Legacy tasks
///     deserialize into this variant via serde default.
///
///   - `Subscription` — cron explicitly runs on Anthropic subscription
///     auth, regardless of what the agent looks like at execute time.
///     `provider_env` is ignored.
///
///   - `Explicit` — cron runs on the captured `provider_env` regardless
///     of agent changes. `provider_env` MUST be `Some(...)` when this
///     variant is used.
///
/// Behavior at execute time (sidecar `/cron/execute(-sync)`): the handler
/// branches on intent and either follows the snapshot path (`FollowAgent`)
/// or short-circuits to the task's own values (`Subscription` /
/// `Explicit`). See `src/server/index.ts` for the resolution code.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderIntent {
    /// Snapshot-based: follow the workspace agent at execute time. Legacy
    /// default for crons created before #119 — present in this variant
    /// because serde fills missing fields with `Default::default()`.
    #[default]
    FollowAgent,
    /// Explicitly use Anthropic subscription. Ignores `provider_env`.
    Subscription,
    /// Explicitly use the captured `provider_env`. Snapshot is bypassed.
    /// Caller MUST ensure `provider_env` is `Some(...)` when this variant
    /// is selected; an `Explicit` intent with `provider_env: None` is a
    /// malformed task — the sidecar handler fails the request with
    /// HTTP 400 rather than silently degrading to subscription, which
    /// could still produce the model+endpoint mismatch this enum was
    /// introduced to prevent.
    Explicit,
}

/// Delivery target for IM Bot cron task results
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronDelivery {
    pub bot_id: String,
    pub chat_id: String,
    pub platform: String,
}

/// Optional catch-up window for interval schedules.
///
/// When an anchored recurring task misses its planned fire time, the scheduler
/// uses this window to run in the next permitted wall-clock window instead of
/// either firing immediately outside the window or skipping a full interval.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecurringWindow {
    pub timezone: String,
    pub start: String,
    pub end: String,
}

/// Flexible schedule types for cron tasks (v0.1.21)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CronSchedule {
    /// One-shot: execute at a specific time, then stop
    At { at: String },
    /// Recurring interval in minutes, with optional delayed start
    Every {
        minutes: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        catch_up_window: Option<RecurringWindow>,
    },
    /// Cron expression with optional timezone
    Cron { expr: String, tz: Option<String> },
    /// Goal Mode: completion-triggered re-execution (no time-based scheduling)
    /// AI finishes → 3s buffer → execute again. Exponential backoff on failure.
    Loop,
}

/// A scheduled cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTask {
    pub id: String,
    pub workspace_path: String,
    pub session_id: String,
    pub prompt: String,
    pub interval_minutes: u32,
    #[serde(default)]
    pub end_conditions: EndConditions,
    #[serde(default)]
    pub run_mode: RunMode,
    pub status: TaskStatus,
    #[serde(default)]
    pub execution_count: u32,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub last_executed_at: Option<DateTime<Utc>>,
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    /// Tab ID associated with this task (for frontend reference)
    #[serde(default)]
    pub tab_id: Option<String>,
    /// Exit reason (set when AI calls ExitCronTask)
    #[serde(default)]
    pub exit_reason: Option<String>,
    /// Permission mode for execution (auto, plan, fullAgency, custom)
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// Model to use for execution
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Provider environment (API key, base URL).
    ///
    /// PRD 0.2.9 — DEPRECATED. Read-only legacy field: deserialization
    /// honored so 0.2.8 `cron_tasks.json` still loads and the in-memory
    /// CronTask still routes correctly via the `Explicit` intent path. But
    /// `skip_serializing` ensures we **never write this back to disk** —
    /// so on the next `save_to_disk()` (any field edit) the credential
    /// copy disappears and the cron either runs subscription/follow or the
    /// user re-picks a provider. PRD 0.2.9 R2 invariant: zero credential
    /// copies in `~/.myagents/cron_tasks.json`.
    #[serde(default, skip_serializing)]
    pub provider_env: Option<TaskProviderEnv>,
    /// PRD 0.2.9 — Per-task provider id (live-resolution intent).
    ///
    /// Replaces `provider_env` as the canonical persistence shape. When set,
    /// the sidecar calls `resolveProviderEnv(providerId)` at every tick from
    /// `~/.myagents/config.json`, so:
    ///   * API key rotation propagates instantly (no need to re-save tasks)
    ///   * Provider deletion fails the next tick with a clear error
    ///   * No credential copies in `cron_tasks.json`
    ///
    /// `None` retains the FollowAgent / legacy snapshot semantics. See
    /// `tech_docs/task_provider_routing.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Routing intent for this cron — see `ProviderIntent` for full design.
    /// Defaults to `FollowAgent` (legacy snapshot behavior) so pre-#119 tasks
    /// keep their existing semantics across upgrade.
    /// PRD 0.2.9 — when `provider_id` is set, the sidecar ignores this field
    /// (live-resolution path takes precedence). Retained so 0.2.8 cron tasks
    /// still resolve correctly.
    #[serde(default)]
    pub provider_intent: ProviderIntent,
    /// Agent runtime snapshot for external Runtime tasks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// Runtime-scoped config snapshot for external Runtime tasks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override. Snapshot from the parent Task at
    /// projection time. `None` = follow workspace MCP config; `Some([])` =
    /// explicitly no MCP; `Some([...])` = enable only these server ids.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Internal system-managed task marker mirrored from Task Center.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_kind: Option<String>,
    /// Last error message (if any)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Last run success flag — denormalized from `cron_runs/<id>.jsonl` so
    /// `cron list` doesn't need to crack open every jsonl on every list call.
    /// Updated by `record_execution_result()` after each tick. PRD 0.2.5 R6.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_ok: Option<bool>,
    /// Last run duration in milliseconds — same denormalization rationale as
    /// `last_run_ok`. PRD 0.2.5 R6.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_duration_ms: Option<u64>,
    // ===== IM Bot cron fields (v0.1.21) =====
    /// Source IM Bot ID that created this task
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_bot_id: Option<String>,
    /// Where to deliver execution results
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    /// Flexible schedule (overrides interval_minutes when present)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<CronSchedule>,
    /// Human-readable name for the task
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Computed next execution time (enriched at read time, not persisted)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_execution_at: Option<String>,
    /// Internal SDK session ID where conversation data is stored.
    /// Differs from `session_id` (Sidecar session key) — this tracks the actual
    /// SDK session UUID for frontend to load conversation history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal_session_id: Option<String>,
    /// Last activity timestamp — updated on create, start, stop, execute.
    /// Used by frontend to sort tasks by most recent activity.
    #[serde(default = "chrono::Utc::now")]
    pub updated_at: DateTime<Utc>,
    /// Reverse pointer into the Task Center (v0.1.69, PRD §11.2). When set,
    /// this CronTask was created by a Task dispatch; each firing looks up the
    /// `Task.dispatchOrigin` + `task.md` to build the prompt dynamically
    /// (PRD §9.3.1) instead of using the `prompt` field as a frozen string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Explicit Goal Mode identity and lifecycle status. A loop schedule alone
    /// remains an ordinary CronTask.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_status: Option<GoalStatus>,
    /// Persistent Goal objective. Explicit Goals populate this at creation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_objective: Option<String>,
    /// Last Goal objective/status update timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_updated_at: Option<DateTime<Utc>>,
    /// Terminal reason for complete/blocked/canceled Goal states.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_terminal_reason: Option<String>,
    /// Pause reason for paused Goal tasks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_paused_reason: Option<GoalPausedReason>,
    /// Monotonic version for Goal state ordering across hydrate/events.
    #[serde(default)]
    pub goal_revision: u64,
    /// Monotonic Goal control epoch. Unlike `goal_revision`, admission/lease
    /// bookkeeping does not advance this value. It changes only when the
    /// objective or explicit lifecycle control state changes, so stale user
    /// queries cannot resume a Goal after pause/cancel while same-epoch queries
    /// queue. A user-query-driven paused-to-active transition stays in the
    /// paused snapshot's epoch.
    #[serde(default)]
    pub goal_control_revision: u64,
    /// Scheduler-only turn barrier, claimed immediately before runtime dispatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_turn_lease: Option<GoalTurnLease>,
    /// Ordered two-phase desktop/IM dispatch reservations. Each queued user
    /// query owns independent claim, dispatch, and release state.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub goal_user_admissions: Vec<GoalUserAdmission>,
    /// Durable at-least-once IM delivery queue, deduplicated by scheduler lease.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub goal_delivery_outbox: Vec<GoalDeliveryOutboxItem>,
    /// Durable consecutive turn failures for Goal backoff/terminal policy.
    #[serde(default)]
    pub goal_consecutive_failures: u32,
}

impl CronTask {
    /// Goal identity is explicit. A loop schedule or an orphaned objective does
    /// not promote an ordinary CronTask into Goal Mode.
    pub fn is_goal(&self) -> bool {
        self.goal_status.is_some()
    }

    pub fn bump_goal_revision(&mut self) {
        if self.is_goal() {
            self.goal_revision = self.goal_revision.saturating_add(1);
        }
    }

    pub fn bump_goal_control_revision(&mut self) {
        if self.is_goal() {
            self.goal_control_revision = self.goal_control_revision.saturating_add(1);
        }
    }

    /// One source of truth for the Goal turn being dispatched. A prepared or
    /// claimed lease owns its number; otherwise the next durable completion
    /// follows `execution_count`.
    pub fn goal_turn_number_for_dispatch(&self) -> u32 {
        self.goal_turn_lease
            .as_ref()
            .map(|lease| lease.turn_number)
            .unwrap_or_else(|| self.execution_count.saturating_add(1))
    }
}

/// Configuration for creating a new cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskConfig {
    pub workspace_path: String,
    pub session_id: String,
    pub prompt: String,
    pub interval_minutes: u32,
    #[serde(default)]
    pub end_conditions: EndConditions,
    #[serde(default)]
    pub run_mode: RunMode,
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// PRD 0.2.9 — DEPRECATED. New callers SHOULD pass `provider_id` instead;
    /// retained for the legacy IM-Bot / heartbeat paths that still build a
    /// frozen env at schedule time. See `provider_id` below.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_env: Option<TaskProviderEnv>,
    /// PRD 0.2.9 — Per-task provider id (live-resolution intent). Preferred
    /// over `provider_env` for all new callers. `None` keeps FollowAgent /
    /// legacy snapshot semantics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Provider routing intent (PRD #119). Callers without explicit intent —
    /// legacy IM Bot path, Task Center dispatch — leave this as
    /// `FollowAgent` (the serde default) and keep snapshot semantics.
    /// Frontend cron creation paths set this to `Subscription` or `Explicit`
    /// based on what the user picked when scheduling.
    /// PRD 0.2.9 — when `provider_id` is set, the sidecar ignores this field.
    #[serde(default)]
    pub provider_intent: ProviderIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list snapshot. Mirrors the `Task.mcp_enabled_servers`
    /// override; `None` = follow workspace MCP, `Some([])` = explicitly no MCP.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Internal system-managed task marker mirrored from Task Center.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_kind: Option<String>,
    // ===== IM Bot cron fields (v0.1.21) =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<CronSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Reverse pointer into Task Center (v0.1.69, PRD §11.2). Set when the
    /// CronTask is dispatched by a Task Center task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_status: Option<GoalStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_objective: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_updated_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_terminal_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_paused_reason: Option<GoalPausedReason>,
}

fn default_true() -> bool {
    true
}

/// Default permission_mode for new cron tasks: empty string = sentinel for
/// "user didn't pick" → resolved to runtime max at execution time
/// (see src/shared/types/runtime.ts::resolveCronPermissionMode).
///
/// Pre-v0.2.5 this returned "auto", which the cron resolver respected
/// literally as acceptEdits — silently breaking unattended runs whenever
/// WebSearch / Bash / mcp__* hit the human-approval queue. PRD 0.2.5 R3.
pub(super) fn default_permission_mode() -> String {
    String::new()
}

impl Default for RunMode {
    fn default() -> Self {
        Self::SingleSession
    }
}

/// Persistent storage for cron tasks
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(super) struct CronTaskStore {
    #[serde(default)]
    pub(super) tasks: Vec<CronTask>,
}
