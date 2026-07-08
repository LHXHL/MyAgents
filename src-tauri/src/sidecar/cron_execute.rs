use super::*;

/// Cron task execution payload - sent to Sidecar's /cron/execute-sync endpoint
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecutePayload {
    pub task_id: String,
    pub prompt: String,
    /// Product-owned hidden maintenance marker mirrored from CronTask.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_kind: Option<String>,
    /// Task Center Task id when this CronTask is the execution provider for a Task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_center_task_id: Option<String>,
    /// Session ID for activation tracking (prevents Sidecar from being killed during cron execution)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_first_execution: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_can_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_env: Option<ProviderEnv>,
    /// PRD 0.2.9: per-task provider id. When set, sidecar live-resolves the
    /// provider env on every tick from `~/.myagents/config.json`. Mutually
    /// exclusive with `provider_env` (legacy explicit-snapshot path).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// PRD #119: routing intent. `None` deserializes to FollowAgent on the
    /// receiver side (sidecar handler treats absent as legacy default).
    /// PRD 0.2.9 prefers `provider_id` over this; intent is kept for
    /// backward-compat with crons persisted in 0.2.8 and earlier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_intent: Option<crate::cron_task::ProviderIntent>,
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
    /// Schedule kind for cron reminder metadata ("at" | "every" | "cron" | "loop").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_kind: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEnv {
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

/// Cron task execution response from Sidecar
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecuteResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_requested_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_text: Option<String>,
    /// Internal SDK session ID where conversation data is stored
    /// (may differ from the Sidecar session key used for process management)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

fn runtime_source_from_runtime_config(
    runtime_config: Option<&serde_json::Value>,
) -> Option<String> {
    let source = runtime_config?.as_object()?.get("source")?.as_str()?;
    match source {
        "system-cli" | "managed-provider" => Some(source.to_string()),
        _ => None,
    }
}

/// Execute a cron task synchronously via Sidecar HTTP API
/// This function ensures a Sidecar is running for the session and calls its /cron/execute-sync endpoint
pub async fn execute_cron_task<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    payload: CronExecutePayload,
) -> Result<CronExecuteResponse, String> {
    ulog_info!(
        "[sidecar] execute_cron_task called for task {} in workspace {}",
        payload.task_id,
        workspace_path
    );
    let cron_started = trace_start();
    let cron_task_id = payload.task_id.clone();
    let cron_runtime = normalize_runtime_name(payload.runtime.as_deref()).to_string();

    // Require session_id for Session-centric Sidecar
    let session_id = payload.session_id.clone().ok_or_else(|| {
        let err = format!(
            "[sidecar] execute_cron_task requires session_id for task {}",
            payload.task_id
        );
        ulog_error!("{}", err);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                .duration_ms(elapsed_ms(cron_started))
                .runtime(Some(&cron_runtime))
                .status("error")
                .detail("taskId", &cron_task_id)
                .detail("error", &err),
        );
        err
    })?;

    // Emit debug event
    let _ = app_handle.emit(
        "cron:debug",
        serde_json::json!({
            "taskId": payload.task_id,
            "message": "execute_cron_task: about to call ensure_session_sidecar"
        }),
    );

    // Ensure Sidecar is running for this session with CronTask as owner
    // IMPORTANT: Use spawn_blocking because ensure_session_sidecar uses reqwest::blocking::Client
    // which cannot be called from within a tokio async runtime (causes deadlock)
    let app_handle_clone = app_handle.clone();
    let manager_clone = manager.clone();
    let session_id_clone = session_id.clone();
    let workspace_clone = workspace_path.to_string();
    let task_id_clone = payload.task_id.clone();
    let owner = SidecarOwner::CronTask(task_id_clone.clone());
    let runtime_override = payload.runtime.clone();
    let runtime_source_override =
        runtime_source_from_runtime_config(payload.runtime_config.as_ref());

    let result = tokio::task::spawn_blocking(move || {
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
            PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                .duration_ms(elapsed_ms(cron_started))
                .session_id(Some(&session_id))
                .runtime(Some(&cron_runtime))
                .status("error")
                .detail("taskId", &cron_task_id)
                .detail("error", &err),
        );
        err
    })?
    .map_err(|e| {
        ulog_error!(
            "[sidecar] ensure_session_sidecar failed for task {}: {}",
            payload.task_id,
            e
        );
        let _ = app_handle.emit(
            "cron:debug",
            serde_json::json!({
                "taskId": payload.task_id,
                "message": format!("execute_cron_task: ensure_session_sidecar FAILED: {}", e),
                "error": true
            }),
        );
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                .duration_ms(elapsed_ms(cron_started))
                .session_id(Some(&session_id))
                .runtime(Some(&cron_runtime))
                .status("error")
                .detail("taskId", &cron_task_id)
                .detail("error", &e),
        );
        e
    })?;

    let port = result.port;
    let sidecar_is_new = result.is_new;

    // Emit debug event
    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": format!("execute_cron_task: sidecar ready on port {}, isNew={}", port, result.is_new)
    }));

    ulog_info!(
        "[sidecar] Cron sidecar ready for task {} on port {} (isNew={})",
        payload.task_id,
        port,
        result.is_new
    );

    // Also record in session_activations for Session singleton tracking
    {
        let _ = app_handle.emit(
            "cron:debug",
            serde_json::json!({
                "taskId": payload.task_id,
                "message": "execute_cron_task: recording session activation"
            }),
        );

        let mut manager_guard = manager.lock().map_err(|e| {
            let _ = app_handle.emit(
                "cron:debug",
                serde_json::json!({
                    "taskId": payload.task_id,
                    "message": format!("execute_cron_task: mutex lock FAILED: {}", e),
                    "error": true
                }),
            );
            e.to_string()
        })?;

        manager_guard.activate_session(
            session_id.clone(),
            None,                          // No tab_id for cron tasks
            Some(payload.task_id.clone()), // Store task_id for Tab connection
            port,
            workspace_path.to_string(),
            true, // is_cron_task = true
        );

        let _ = app_handle.emit(
            "cron:debug",
            serde_json::json!({
                "taskId": payload.task_id,
                "message": "execute_cron_task: session activation recorded"
            }),
        );

        ulog_info!(
            "[sidecar] Cron task {} activated session {} as cron (port {})",
            payload.task_id,
            session_id,
            port
        );
    }

    let url = format!("http://127.0.0.1:{}/cron/execute-sync", port);

    let _ = app_handle.emit(
        "cron:debug",
        serde_json::json!({
            "taskId": payload.task_id,
            "message": format!("execute_cron_task: about to send HTTP request to {}", url)
        }),
    );

    ulog_info!(
        "[sidecar] Executing cron task {} via {}",
        payload.task_id,
        url
    );

    // Create HTTP client with generous timeout (cron tasks can take long)
    let client = crate::local_http::builder()
        .timeout(Duration::from_secs(3660)) // 61 minutes (slightly more than cron task's 60 min timeout)
        .tcp_nodelay(true)
        .build()
        .map_err(|e| format!("[sidecar] Failed to create HTTP client: {}", e))?;

    let _ = app_handle.emit(
        "cron:debug",
        serde_json::json!({
            "taskId": payload.task_id,
            "message": "execute_cron_task: HTTP client created, sending request..."
        }),
    );

    // Send request to Sidecar
    let response = client.post(&url).json(&payload).send().await;

    // Deactivate session after execution (regardless of success/failure)
    // Note: We keep the session activated between cron executions to protect Sidecar.
    // Only deactivate if the task is being stopped or completed.
    // For now, we keep it activated - the cron scheduler should deactivate when task stops.

    let response = response.map_err(|e| {
        let err = format!("[sidecar] HTTP request failed: {}", e);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                .duration_ms(elapsed_ms(cron_started))
                .session_id(Some(&session_id))
                .runtime(Some(&cron_runtime))
                .status("error")
                .detail("taskId", &cron_task_id)
                .detail("error", &err),
        );
        err
    })?;

    let status = response.status();
    let body = response.text().await.map_err(|e| {
        let err = format!("[sidecar] Failed to read response body: {}", e);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                .duration_ms(elapsed_ms(cron_started))
                .session_id(Some(&session_id))
                .runtime(Some(&cron_runtime))
                .status("error")
                .detail("taskId", &cron_task_id)
                .detail("error", &err),
        );
        err
    })?;

    ulog_info!(
        "[sidecar] Cron task {} response: status={}, body={}",
        payload.task_id,
        status,
        body.chars().take(500).collect::<String>()
    );

    // Parse response
    let result: CronExecuteResponse = serde_json::from_str(&body).map_err(|e| {
        let err = format!(
            "[sidecar] Failed to parse response JSON: {} (body: {})",
            e, body
        );
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                .duration_ms(elapsed_ms(cron_started))
                .session_id(Some(&session_id))
                .runtime(Some(&cron_runtime))
                .status("error")
                .detail("taskId", &cron_task_id)
                .detail("statusCode", status.as_u16())
                .detail("error", &err),
        );
        err
    })?;

    ulog_info!(
        "[sidecar] Cron task {} parsed response: success={}, error={:?}, ai_requested_exit={:?}",
        payload.task_id,
        result.success,
        result.error,
        result.ai_requested_exit
    );
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
            .duration_ms(elapsed_ms(cron_started))
            .session_id(Some(&session_id))
            .runtime(Some(&cron_runtime))
            .status(if result.success { "ok" } else { "error" })
            .detail("taskId", &cron_task_id)
            .detail("statusCode", status.as_u16())
            .detail("isNewSidecar", sidecar_is_new)
            .detail("aiRequestedExit", result.ai_requested_exit.unwrap_or(false)),
    );

    Ok(result)
}

/// Tauri command to execute a cron task synchronously
/// This is called by the cron scheduler in Rust
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_execute_cron_task(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    workspacePath: String,
    taskId: String,
    sessionId: Option<String>,
    prompt: String,
    isFirstExecution: Option<bool>,
    aiCanExit: Option<bool>,
    permissionMode: Option<String>,
    model: Option<String>,
    providerEnv: Option<ProviderEnv>,
    providerId: Option<String>,
    providerIntent: Option<crate::cron_task::ProviderIntent>,
    runtime: Option<String>,
    runtimeConfig: Option<serde_json::Value>,
    managedKind: Option<String>,
    runMode: Option<String>,
    intervalMinutes: Option<u32>,
    executionNumber: Option<u32>,
) -> Result<CronExecuteResponse, String> {
    let payload = CronExecutePayload {
        task_id: taskId.clone(),
        prompt,
        managed_kind: managedKind,
        task_center_task_id: None,
        session_id: sessionId,
        is_first_execution: isFirstExecution,
        ai_can_exit: aiCanExit,
        permission_mode: permissionMode,
        model,
        provider_env: providerEnv,
        provider_id: providerId,
        provider_intent: providerIntent,
        runtime,
        runtime_config: runtimeConfig,
        // Renderer-driven cron execution path doesn't carry a parent Task,
        // so per-task MCP overrides aren't applicable here. Fall back to
        // "follow workspace MCP" by sending None.
        mcp_enabled_servers: None,
        run_mode: runMode,
        interval_minutes: intervalMinutes,
        execution_number: executionNumber,
        schedule_kind: None,
    };

    execute_cron_task(&app_handle, &state, &workspacePath, payload).await
}
