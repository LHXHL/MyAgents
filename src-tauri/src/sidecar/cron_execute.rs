use super::*;

/// Task execution payload sent to the Sidecar's compatibility transport.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecutePayload {
    pub task_id: String,
    /// Ordinary SessionEngine queue identity for this concrete Task turn.
    pub queue_id: String,
    pub prompt: String,
    /// Product-owned hidden maintenance marker from Task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_kind: Option<String>,
    /// Whether this dispatch creates the Task-owned Session. Existing
    /// Sessions keep their own runtime/model/MCP configuration.
    #[serde(default)]
    pub initialize_session: bool,
    /// Session ID for activation tracking (prevents Sidecar from being killed during cron execution)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_can_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// PRD 0.2.9: per-task provider id. When set, sidecar live-resolves the
    /// provider env while creating the Task execution Session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override. `None` = follow workspace MCP config
    /// (Agent's mcpEnabledServers). `Some([])` = explicitly no MCP.
    /// `Some([...])` = enable only these server ids for this task.
    /// Sidecar `/cron/execute-sync` applies via `setMcpServers()` before
    /// delivering the prompt so the SDK's tool list matches the override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Run mode: "single_session" (keep context) or "new_session" (fresh each time)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_mode: Option<String>,
    /// Task execution interval in minutes (for System Prompt context)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u32>,
    /// Current execution number (1-based, for System Prompt context)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_number: Option<u32>,
    /// Schedule kind for cron reminder metadata ("at" | "every" | "cron").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_kind: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalExecutePayload {
    pub goal_id: String,
    pub objective: String,
    pub session_id: String,
    pub turn_number: u32,
    pub ai_can_exit: bool,
    pub permission_mode: String,
    pub queue_id: String,
    pub expected_control_revision: u64,
}

/// Cron task execution response from Sidecar
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTurnResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_requested_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_text: Option<String>,
    /// True only when the turn originated from an Agent Channel and its
    /// output must be delivered through that channel's durable outbox.
    #[serde(default)]
    pub goal_channel_delivery_expected: bool,
    /// Internal SDK session ID where conversation data is stored
    /// (may differ from the Sidecar session key used for process management)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

pub type CronExecuteResponse = BackgroundTurnResponse;
pub type GoalExecuteResponse = BackgroundTurnResponse;

fn runtime_source_from_runtime_config(
    runtime_config: Option<&serde_json::Value>,
) -> Option<String> {
    let source = runtime_config?.as_object()?.get("source")?.as_str()?;
    match source {
        "system-cli" | "managed-provider" => Some(source.to_string()),
        _ => None,
    }
}

/// Attach the durable Goal owner before a continuation is eligible to run.
/// The caller must re-read Goal state after this returns because Sidecar boot
/// is blocking and a concurrent pause/cancel may have committed meanwhile.
pub async fn ensure_goal_sidecar_owner<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    session_id: &str,
    goal_id: &str,
) -> Result<u16, String> {
    let app_handle = app_handle.clone();
    let manager = manager.clone();
    let workspace_path = workspace_path.to_string();
    let session_id = session_id.to_string();
    let owner = SidecarOwner::Goal(goal_id.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_sidecar_with_runtime_identity_override(
            &app_handle,
            &manager,
            &session_id,
            &PathBuf::from(workspace_path),
            owner,
            None,
            None,
        )
    })
    .await
    .map_err(|error| format!("Goal Sidecar attach task failed: {error}"))?
    .map(|result| result.port)
}

/// Execute a Task synchronously through the existing Sidecar transport.
pub async fn execute_cron_task<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    payload: CronExecutePayload,
) -> Result<CronExecuteResponse, String> {
    let session_id = payload.session_id.clone().ok_or_else(|| {
        format!(
            "[sidecar] execute_cron_task requires session_id for task {}",
            payload.task_id
        )
    })?;
    let owner = SidecarOwner::Task(payload.task_id.clone());
    execute_background_turn(
        app_handle,
        manager,
        workspace_path,
        &payload.task_id,
        &session_id,
        payload.runtime.clone(),
        payload.runtime_config.clone(),
        "/cron/execute-sync",
        &payload,
        owner,
        "task_execute",
        None,
    )
    .await
}

/// Execute one Session-owned Goal continuation through the existing
/// SessionEngine transport. Goal ownership is independent from CronTask and
/// is intentionally not projected into legacy cron session activations.
pub async fn execute_goal_turn<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    port: u16,
    payload: GoalExecutePayload,
) -> Result<GoalExecuteResponse, String> {
    let owner = SidecarOwner::Goal(payload.goal_id.clone());
    execute_background_turn(
        app_handle,
        manager,
        workspace_path,
        &payload.goal_id,
        &payload.session_id,
        None,
        None,
        "/goal/execute-sync",
        &payload,
        owner,
        "goal_execute",
        Some(port),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn execute_background_turn<R: Runtime, P: serde::Serialize>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    execution_id: &str,
    session_id: &str,
    runtime_override: Option<String>,
    runtime_config: Option<serde_json::Value>,
    endpoint: &str,
    payload: &P,
    owner: SidecarOwner,
    trace_operation: &'static str,
    attached_port: Option<u16>,
) -> Result<BackgroundTurnResponse, String> {
    ulog_info!(
        "[sidecar] background turn {} called in workspace {}",
        execution_id,
        workspace_path
    );
    let cron_started = trace_start();
    let execution_id = execution_id.to_string();
    let session_id = session_id.to_string();
    let execution_runtime = normalize_runtime_name(runtime_override.as_deref()).to_string();

    let (port, sidecar_is_new) = if let Some(port) = attached_port {
        (port, false)
    } else {
        // ensure_session_sidecar uses a blocking HTTP client, so keep it off
        // the async runtime. Goal callers attach and revalidate before this
        // function; Task attaches here on demand.
        let app_handle_clone = app_handle.clone();
        let manager_clone = manager.clone();
        let session_id_clone = session_id.clone();
        let workspace_clone = workspace_path.to_string();
        let runtime_source_override = runtime_source_from_runtime_config(runtime_config.as_ref());

        let result = tauri::async_runtime::spawn_blocking(move || {
            let workspace = PathBuf::from(&workspace_clone);
            ensure_session_sidecar_with_runtime_identity_override(
                &app_handle_clone,
                &manager_clone,
                &session_id_clone,
                &workspace,
                owner,
                runtime_override,
                runtime_source_override,
            )
        })
        .await
        .map_err(|e| {
            let err = format!("spawn_blocking failed: {}", e);
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
                    .duration_ms(elapsed_ms(cron_started))
                    .session_id(Some(&session_id))
                    .runtime(Some(&execution_runtime))
                    .status("error")
                    .detail("executionId", &execution_id)
                    .detail("error", &err),
            );
            err
        })?
        .map_err(|e| {
            ulog_error!(
                "[sidecar] ensure_session_sidecar failed for task {}: {}",
                execution_id,
                e
            );
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
                    .duration_ms(elapsed_ms(cron_started))
                    .session_id(Some(&session_id))
                    .runtime(Some(&execution_runtime))
                    .status("error")
                    .detail("executionId", &execution_id)
                    .detail("error", &e),
            );
            e
        })?;
        (result.port, result.is_new)
    };

    ulog_info!(
        "[sidecar] Background Sidecar ready for {} on port {} (isNew={})",
        execution_id,
        port,
        sidecar_is_new
    );

    let url = format!("http://127.0.0.1:{port}{endpoint}");

    ulog_info!(
        "[sidecar] Executing background turn {} via {}",
        execution_id,
        url
    );

    // Create HTTP client with generous timeout (cron tasks can take long)
    let client = crate::local_http::builder()
        .timeout(Duration::from_secs(3660)) // 60m business deadline + stop/finalize margin
        .tcp_nodelay(true)
        .build()
        .map_err(|e| format!("[sidecar] Failed to create HTTP client: {}", e))?;

    // Send request to Sidecar
    let response = client.post(&url).json(payload).send().await;

    let response = response.map_err(|e| {
        let err = format!("[sidecar] HTTP request failed: {}", e);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
                .duration_ms(elapsed_ms(cron_started))
                .session_id(Some(&session_id))
                .runtime(Some(&execution_runtime))
                .status("error")
                .detail("executionId", &execution_id)
                .detail("error", &err),
        );
        err
    })?;

    let status = response.status();
    let body = response.text().await.map_err(|e| {
        let err = format!("[sidecar] Failed to read response body: {}", e);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
                .duration_ms(elapsed_ms(cron_started))
                .session_id(Some(&session_id))
                .runtime(Some(&execution_runtime))
                .status("error")
                .detail("executionId", &execution_id)
                .detail("error", &err),
        );
        err
    })?;

    ulog_info!(
        "[sidecar] Background turn {} response: status={}, body={}",
        execution_id,
        status,
        body.chars().take(500).collect::<String>()
    );

    // Parse response
    let result: BackgroundTurnResponse = serde_json::from_str(&body).map_err(|e| {
        let err = format!(
            "[sidecar] Failed to parse response JSON: {} (body: {})",
            e, body
        );
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
                .duration_ms(elapsed_ms(cron_started))
                .session_id(Some(&session_id))
                .runtime(Some(&execution_runtime))
                .status("error")
                .detail("executionId", &execution_id)
                .detail("statusCode", status.as_u16())
                .detail("error", &err),
        );
        err
    })?;

    ulog_info!(
        "[sidecar] Background turn {} parsed response: success={}, error={:?}, ai_requested_exit={:?}",
        execution_id,
        result.success,
        result.error,
        result.ai_requested_exit
    );
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::BackgroundJob, trace_operation)
            .duration_ms(elapsed_ms(cron_started))
            .session_id(Some(&session_id))
            .runtime(Some(&execution_runtime))
            .status(if result.success { "ok" } else { "error" })
            .detail("executionId", &execution_id)
            .detail("statusCode", status.as_u16())
            .detail("isNewSidecar", sidecar_is_new)
            .detail("aiRequestedExit", result.ai_requested_exit.unwrap_or(false)),
    );

    Ok(result)
}
