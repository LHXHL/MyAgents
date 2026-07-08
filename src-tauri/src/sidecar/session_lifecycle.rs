use super::*;

// ============= Session-Centric Sidecar API (v0.1.11) =============

/// Result returned from ensure_session_sidecar
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureSidecarResult {
    pub port: u16,
    pub is_new: bool,
}

/// Ensure a Session has a Sidecar running, adding the specified owner.
/// If the Session already has a healthy Sidecar, just adds the owner.
/// If no Sidecar exists, creates a new one with the owner.
///
/// Returns (port, is_new) where is_new is true if a new Sidecar was started.
///
/// # WARNING: Blocking Function
/// This function uses `reqwest::blocking::Client` internally (via `check_sidecar_http_health`)
/// which uses `block_on()`. Calling this function from within an async context (tokio runtime)
/// will cause a deadlock or panic.
///
/// When calling from async code, wrap in `tokio::task::spawn_blocking`:
/// ```ignore
/// let result = tokio::task::spawn_blocking(move || {
///     ensure_session_sidecar(&app_handle, &manager, &session_id, workspace_path, owner)
/// })
/// .await
/// .map_err(|e| format!("spawn_blocking failed: {}", e))?;
/// ```
pub fn ensure_session_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
) -> Result<EnsureSidecarResult, String> {
    ensure_session_sidecar_with_runtime_override(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        None,
    )
}

/// Upper bound on ensure re-entry. The ensure path re-runs itself on
/// generation-change and concurrent-create (it must re-wait for `/health/ready`
/// rather than return a replacement port directly). This caps that re-entry so
/// a thrashing health monitor that keeps bumping the generation can't recurse
/// without a depth bound. Each attempt costs ≥2s (HTTP/readiness window), so 8
/// is generous — real churn settles in 1–2 (cross-review: all three reviewers
/// flagged the prior unbounded self-recursion).
const MAX_ENSURE_ATTEMPTS: u32 = 8;

pub fn ensure_session_sidecar_with_runtime_override<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    runtime_override: Option<String>,
) -> Result<EnsureSidecarResult, String> {
    ensure_session_sidecar_with_runtime_identity_override(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        runtime_override,
        None,
    )
}

pub fn ensure_session_sidecar_with_runtime_identity_override<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    runtime_override: Option<String>,
    runtime_source_override: Option<String>,
) -> Result<EnsureSidecarResult, String> {
    let _update_spawn_permit = begin_update_spawn_permit()?;
    ensure_session_sidecar_attempt(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        runtime_override,
        runtime_source_override,
        0,
    )
}

fn ensure_session_sidecar_attempt<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    runtime_override: Option<String>,
    runtime_source_override: Option<String>,
    attempt: u32,
) -> Result<EnsureSidecarResult, String> {
    if attempt >= MAX_ENSURE_ATTEMPTS {
        return Err(format!(
            "Session {} ensure exceeded {} attempts (sidecar generation churn not settling)",
            session_id, MAX_ENSURE_ATTEMPTS
        ));
    }
    ulog_info!(
        "[sidecar] ensure_session_sidecar called for session: {}, owner: {:?} (attempt {})",
        session_id,
        owner,
        attempt
    );
    let ensure_started = trace_start();
    let owner_for_trace = format!("{:?}", owner);
    let requested_runtime_for_trace =
        normalize_runtime_name(runtime_override.as_deref()).to_string();
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_start")
            .session_id(Some(session_id))
            .runtime(Some(&requested_runtime_for_trace))
            .detail("owner", &owner_for_trace),
    );

    // Ensure file descriptor limit is high enough for Bun
    ensure_high_file_descriptor_limit();

    // Block briefly if startup cleanup is still running — same barrier as
    // `start_tab_sidecar`. Without this, Cron task recovery / session-monitor
    // auto-restart / IM message arrival during the startup window would spawn
    // a new session sidecar that races with the stale-process sweep (the very
    // case db58545 set out to prevent). In the common case this returns
    // immediately (AtomicBool load; cleanup completes in ~50 ms).
    wait_for_startup_cleanup(Duration::from_secs(15));

    ulog_debug!("[sidecar] Acquiring manager lock...");
    let mut manager_guard = manager.lock().map_err(|e| {
        ulog_error!("[sidecar] Failed to acquire manager lock: {}", e);
        e.to_string()
    })?;
    ulog_debug!("[sidecar] Manager lock acquired");

    // Check if Session already has a healthy Sidecar
    // We use a two-phase approach to avoid holding the lock during HTTP check:
    // Phase 1: Check if sidecar exists and get its port (with lock)
    // Phase 2: Do HTTP health check (without lock)
    // Phase 3: Re-acquire lock and finalize decision

    // Note: there used to be an inline drift check for Agent-owner Sidecars
    // here, but it's been removed as of v0.1.66. Drift is now handled at the
    // IM router layer (`SessionRouter::check_and_reset_on_runtime_drift`)
    // which runs BEFORE `ensure_session_sidecar` and regenerates the peer
    // session_id on drift. By the time we reach here:
    //
    //   - IM message path (router-driven): the router already forked to a
    //     fresh session_id, so `session_id` has no existing Sidecar and the
    //     spawn path below uses the owner-aware priority chain to pick the
    //     correct runtime from agent config.
    //
    //   - memory auto-update callers: they target an existing session_id
    //     that may be shared with a desktop Tab. Killing the Sidecar here
    //     would orphan the Tab's SSE stream. Better to let memory_auto_update
    //     reuse the existing (possibly stale-runtime) Sidecar — memory file
    //     updates are runtime-agnostic so a mismatched runtime doesn't
    //     actually break anything.
    //
    // The priority chain at the spawn path below still enforces "Agent owner
    // uses agent config, not session metadata" so fresh spawns for Agent
    // owners always honor the user's latest runtime choice, including the
    // external → builtin switch direction.

    let existing_sidecar_info: Option<ExistingSidecarReuse> = {
        let generation = manager_guard.current_generation(session_id);
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            if sidecar.is_dead() {
                // Process exited, clean up
                ulog_info!(
                    "[sidecar] Session {} has dead Sidecar process, removing",
                    session_id
                );
                manager_guard.remove_sidecar(session_id);
                None
            } else if sidecar.is_reusable() {
                if validate_sidecar_runtime_invariant(
                    session_id,
                    sidecar.runtime.as_deref(),
                    sidecar.runtime_source.as_deref(),
                    "reuse-healthy-precheck",
                )
                .is_err()
                {
                    manager_guard.remove_sidecar(session_id);
                    manager_guard.clear_generation(session_id);
                    None
                } else {
                    // Healthy — needs HTTP verification outside the lock
                    Some(ExistingSidecarReuse::Healthy {
                        port: sidecar.port,
                        generation,
                        runtime: normalize_runtime_name(sidecar.runtime.as_deref()).to_string(),
                        runtime_source: sidecar.runtime_source.clone(),
                    })
                }
            } else {
                // Starting — another thread is doing wait_for_health/readiness.
                // Add the owner now, then wait for /health/ready outside the lock.
                ulog_info!(
                    "[sidecar] Session {} Sidecar still starting on port {}, adding owner {:?}",
                    session_id,
                    sidecar.port,
                    owner
                );
                if validate_sidecar_runtime_invariant(
                    session_id,
                    sidecar.runtime.as_deref(),
                    sidecar.runtime_source.as_deref(),
                    "reuse-starting",
                )
                .is_err()
                {
                    manager_guard.remove_sidecar(session_id);
                    manager_guard.clear_generation(session_id);
                    None
                } else {
                    let owner_added = sidecar.add_owner(owner.clone());
                    Some(ExistingSidecarReuse::Starting {
                        port: sidecar.port,
                        generation,
                        runtime: normalize_runtime_name(sidecar.runtime.as_deref()).to_string(),
                        runtime_source: sidecar.runtime_source.clone(),
                        owner_added,
                    })
                }
            }
        } else {
            None
        }
    };

    // If we found a running sidecar, verify HTTP health (with lock released).
    // CRITICAL: The lock is dropped during the 2s HTTP check. Another thread (health monitor)
    // can replace the sidecar during this window. We use a generation counter to detect this
    // and avoid accidentally killing the healthy replacement.
    if let Some(existing) = existing_sidecar_info {
        let (
            port,
            pre_gen,
            runtime_for_trace,
            runtime_source_for_trace,
            wait_for_starting,
            joined_owner_added,
        ) = match existing {
            ExistingSidecarReuse::Healthy {
                port,
                generation,
                runtime,
                runtime_source,
            } => (port, generation, runtime, runtime_source, false, false),
            ExistingSidecarReuse::Starting {
                port,
                generation,
                runtime,
                runtime_source,
                owner_added,
            } => (port, generation, runtime, runtime_source, true, owner_added),
        };
        let runtime_source_label =
            normalize_runtime_source_name(&runtime_for_trace, runtime_source_for_trace.as_deref())
                .to_string();
        drop(manager_guard);

        let check_started = trace_start();
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "reuse_check_start")
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_label)
                .detail("port", port)
                .detail("starting", wait_for_starting),
        );
        let http_healthy = if wait_for_starting {
            wait_for_readiness(port, 30).is_ok()
        } else {
            // Verify HTTP server is actually responsive (not just process alive)
            check_sidecar_http_health(port)
        };
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "reuse_check_end")
                .duration_ms(elapsed_ms(check_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_label)
                .status(if http_healthy { "ok" } else { "error" })
                .detail("port", port)
                .detail("starting", wait_for_starting),
        );

        // Re-acquire lock after HTTP check
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        let post_gen = manager_guard.current_generation(session_id);

        if post_gen != pre_gen {
            // Generation changed: another thread replaced the sidecar during our HTTP check.
            // Re-enter the normal ensure path for the replacement instead of returning its
            // port directly. The replacement may still be Starting; the normal path knows
            // how to wait for /health/ready and also re-verifies Healthy sidecars over HTTP.
            ulog_info!(
                "[sidecar] Session {} generation changed ({} → {}) during HTTP check on port {}, checking replacement",
                session_id, pre_gen, post_gen, port
            );
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if !sidecar.is_dead() {
                    ulog_info!(
                        "[sidecar] Session {} replacement on port {} is {:?}, retrying ensure",
                        session_id,
                        sidecar.port,
                        sidecar.state
                    );
                    if validate_sidecar_runtime_invariant(
                        session_id,
                        sidecar.runtime.as_deref(),
                        sidecar.runtime_source.as_deref(),
                        "reuse-replacement",
                    )
                    .is_err()
                    {
                        manager_guard.remove_sidecar(session_id);
                        manager_guard.clear_generation(session_id);
                    } else {
                        drop(manager_guard);
                        return ensure_session_sidecar_attempt(
                            app_handle,
                            manager,
                            session_id,
                            workspace_path,
                            owner,
                            runtime_override,
                            runtime_source_override,
                            attempt + 1,
                        );
                    }
                }
            }
            // Replacement sidecar process also dead — fall through to create
        } else if http_healthy {
            // Same generation, HTTP healthy — try to reuse
            let mut remove_for_runtime_drift = false;
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port && sidecar.is_reusable() {
                    ulog_info!(
                        "[sidecar] Session {} Sidecar HTTP healthy on port {}, adding owner {:?}",
                        session_id,
                        port,
                        owner
                    );
                    if validate_sidecar_runtime_invariant(
                        session_id,
                        sidecar.runtime.as_deref(),
                        sidecar.runtime_source.as_deref(),
                        "reuse-http-healthy",
                    )
                    .is_err()
                    {
                        remove_for_runtime_drift = true;
                    } else {
                        sidecar.add_owner(owner.clone());
                        emit_perf_trace(
                            PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                                .duration_ms(elapsed_ms(ensure_started))
                                .session_id(Some(session_id))
                                .runtime(Some(&runtime_for_trace))
                                .detail("runtimeSource", &runtime_source_label)
                                .status("ok")
                                .detail("port", port)
                                .detail("is_new", false)
                                .detail(
                                    "reuse",
                                    if wait_for_starting {
                                        "starting-ready"
                                    } else {
                                        "healthy"
                                    },
                                ),
                        );
                        return Ok(EnsureSidecarResult {
                            port,
                            is_new: false,
                        });
                    }
                } else if sidecar.port == port && wait_for_starting {
                    ulog_info!(
                        "[sidecar] Session {} starting Sidecar reached readiness on port {}, adding owner {:?}",
                        session_id, port, owner
                    );
                    if validate_sidecar_runtime_invariant(
                        session_id,
                        sidecar.runtime.as_deref(),
                        sidecar.runtime_source.as_deref(),
                        "reuse-starting-ready",
                    )
                    .is_err()
                    {
                        remove_for_runtime_drift = true;
                    } else {
                        sidecar.state = SidecarState::Healthy;
                        sidecar.add_owner(owner.clone());
                        emit_perf_trace(
                            PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                                .duration_ms(elapsed_ms(ensure_started))
                                .session_id(Some(session_id))
                                .runtime(Some(&runtime_for_trace))
                                .detail("runtimeSource", &runtime_source_label)
                                .status("ok")
                                .detail("port", port)
                                .detail("is_new", false)
                                .detail("reuse", "starting-ready"),
                        );
                        return Ok(EnsureSidecarResult {
                            port,
                            is_new: false,
                        });
                    }
                }
            }
            if remove_for_runtime_drift {
                manager_guard.remove_sidecar(session_id);
                manager_guard.clear_generation(session_id);
            }
            // Sidecar gone but generation unchanged (removed without replacement)
            ulog_info!(
                "[sidecar] Session {} Sidecar removed during HTTP check, will create new",
                session_id
            );
        } else {
            if wait_for_starting {
                // We joined a sidecar that another owner was already starting.
                // Our independent readiness timeout must not kill or replace
                // that startup; the original creator may still be inside its
                // longer TCP+ready boot window. Detach only the owner we added.
                ulog_warn!(
                    "[sidecar] Session {} starting Sidecar on port {} did not become ready for joining owner {:?}; preserving original startup",
                    session_id, port, owner
                );
                // Only detach the owner if THIS call actually added it. When the
                // owner was already present (a same-owner concurrent ensure joined
                // the same Starting sidecar), `add_owner` returned false; removing
                // it here would empty the shared owner set and tear down a sidecar
                // the other caller is still legitimately starting (cross-review
                // Codex Critical #2). Leave teardown to whoever truly owns it.
                let should_stop = if joined_owner_added {
                    if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                        sidecar.port == port && sidecar.remove_owner(&owner)
                    } else {
                        false
                    }
                } else {
                    false
                };
                if should_stop {
                    manager_guard.remove_sidecar(session_id);
                    manager_guard.clear_generation(session_id);
                }
                return Err(format!(
                    "Session {} sidecar on port {} is still starting",
                    session_id, port
                ));
            }
            // Same generation, HTTP unhealthy — safe to remove (no one replaced it)
            ulog_warn!(
                "[sidecar] Session {} Sidecar process alive but HTTP unresponsive on port {}, removing",
                session_id, port
            );
            manager_guard.remove_sidecar(session_id);
        }

        let result = create_new_session_sidecar(
            app_handle,
            manager,
            session_id,
            workspace_path,
            owner,
            manager_guard,
            runtime_override.as_deref(),
            runtime_source_override.as_deref(),
            attempt,
        );
        if let Ok(ensure_result) = &result {
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                    .duration_ms(elapsed_ms(ensure_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&requested_runtime_for_trace))
                    .status("ok")
                    .detail("port", ensure_result.port)
                    .detail("is_new", ensure_result.is_new),
            );
        }
        return result;
    }

    // No existing sidecar found, create a new one with the original guard
    let result = create_new_session_sidecar(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        manager_guard,
        runtime_override.as_deref(),
        runtime_source_override.as_deref(),
        attempt,
    );
    if let Ok(ensure_result) = &result {
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                .duration_ms(elapsed_ms(ensure_started))
                .session_id(Some(session_id))
                .runtime(Some(&requested_runtime_for_trace))
                .status("ok")
                .detail("port", ensure_result.port)
                .detail("is_new", ensure_result.is_new),
        );
    }
    result
}

/// Helper function to create a new session sidecar
/// Extracted to avoid code duplication and handle the mutex guard properly
fn create_new_session_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    mut manager_guard: std::sync::MutexGuard<'_, SidecarManager>,
    runtime_override: Option<&str>,
    runtime_source_override: Option<&str>,
    attempt: u32,
) -> Result<EnsureSidecarResult, String> {
    let boot_started = trace_start();

    // Guard against double-creation: if another thread already created a sidecar for this
    // session (e.g., health monitor raced with frontend), reuse it instead of spawning another.
    if let Some(existing) = manager_guard.sidecars.get_mut(session_id) {
        if !existing.is_dead() {
            ulog_info!(
                "[sidecar] Session {} already has a {:?} sidecar on port {} (created by another thread), retrying ensure",
                session_id, existing.state, existing.port
            );
            drop(manager_guard);
            return ensure_session_sidecar_attempt(
                app_handle,
                manager,
                session_id,
                workspace_path,
                owner,
                runtime_override.map(str::to_string),
                runtime_source_override.map(str::to_string),
                attempt + 1,
            );
        }
        // Exists but process dead — remove before creating fresh
        manager_guard.remove_sidecar(session_id);
    }

    // Need to start a new Sidecar
    // First, find executables
    let node_path =
        find_node_executable(app_handle).ok_or_else(|| diagnose_node_not_found(app_handle))?;
    let script_path =
        find_server_script(app_handle).ok_or_else(|| "Server script not found".to_string())?;

    // Allocate port
    let port = manager_guard.allocate_port()?;

    ulog_info!(
        "[sidecar] Starting SessionSidecar for session {} on port {}, owner: {:?}",
        session_id,
        port,
        owner
    );

    // Build command (see sibling SessionSidecar path for the tsx-loader rationale)
    let mut cmd = crate::process_cmd::new(&node_path);
    if script_path.extension().and_then(|s| s.to_str()) == Some("ts") {
        cmd.arg("--import").arg("tsx/esm");
    }
    cmd.arg(&script_path)
        .arg("--port")
        .arg(port.to_string())
        .arg(SIDECAR_MARKER)
        .arg("--agent-dir")
        .arg(workspace_path);

    // Pass session_id to Bun for real sessions (not pending-xxx)
    // so Bun uses the same UUID as Rust/SDK, enabling resume on crash recovery
    if !session_id.starts_with("pending-") {
        cmd.arg("--session-id").arg(session_id);
    }

    // Set working directory to script's parent directory
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
    }

    // Apply proxy policy: user proxy / inherit system / protect localhost (pit-of-success)
    proxy_config::apply_to_subprocess(&mut cmd);

    // Inject management API port for Bun→Rust IPC (v0.1.21)
    let mgmt_port = crate::management_api::get_management_port();
    if mgmt_port > 0 {
        cmd.env("MYAGENTS_MANAGEMENT_PORT", mgmt_port.to_string());
    }

    // Inject runtime type for Agent Runtime selection (v0.1.59, v0.1.62, v0.1.66).
    //
    // Priority rules, split by owner type:
    //
    //   Tab / CronTask / BackgroundCompletion (desktop-style):
    //     runtime_override → session metadata → agent config
    //
    //     Session metadata is authoritative so an ongoing conversation can't
    //     switch runtimes mid-stream just because the user tweaked the agent's
    //     default in Settings. This is the v0.1.62 session-stability guarantee.
    //
    //   Live Agent peer owners (IM / agent-channel session keys):
    //     runtime_override → agent config (NO session fallback)
    //
    //     The IM peer session map is keyed on (agent, channel, user), so the
    //     user never sees individual session IDs — their mental model is "I'm
    //     talking to my agent". When they change the agent's runtime in
    //     Settings, they expect the next IM message to use the new runtime
    //     regardless of which session_id the peer map happens to point at.
    //
    //     Critically, we must NOT fall back to session metadata for live IM
    //     peer owners: `resolve_agent_runtime_from_config` returns None when
    //     the agent is builtin, and falling through to session_runtime would
    //     silently re-resurrect a previously-used external runtime (e.g.
    //     gemini→builtin switch), defeating the whole point of the IM drift
    //     semantics. A None result here means "spawn as builtin (no env var)"
    //     which is exactly correct — the user explicitly asked for builtin.
    //
    //   Maintenance Agent owners (for example memory_update:{agent}:{session})
    //     target a concrete historical session_id, not an opaque peer binding,
    //     so they follow the desktop-style session metadata rule.
    let session_runtime_identity = if owner_prefers_live_agent_runtime(&owner) {
        None
    } else {
        resolve_session_runtime_identity_full(session_id)
    };
    let session_runtime = session_runtime_identity
        .as_ref()
        .map(|identity| identity.runtime.clone());
    let agent_runtime_identity = resolve_agent_runtime_identity_from_config(workspace_path);
    let agent_runtime = agent_runtime_identity
        .as_ref()
        .map(|identity| identity.runtime.clone());
    let resolved_runtime = resolve_runtime_for_owner(
        runtime_override.map(str::to_string),
        &owner,
        session_runtime,
        agent_runtime,
    );
    let resolved_runtime_name = normalize_runtime_name(resolved_runtime.as_deref()).to_string();
    let resolved_runtime_source = if resolved_runtime_name == "builtin" {
        None
    } else if runtime_override.is_some() {
        Some(runtime_source_override.unwrap_or("system-cli"))
    } else if session_runtime_identity
        .as_ref()
        .map(|identity| identity.runtime.as_str())
        == Some(resolved_runtime_name.as_str())
        && !owner_prefers_live_agent_runtime(&owner)
    {
        session_runtime_identity
            .as_ref()
            .and_then(|identity| identity.runtime_source.as_deref())
    } else if agent_runtime_identity
        .as_ref()
        .map(|identity| identity.runtime.as_str())
        == Some(resolved_runtime_name.as_str())
    {
        agent_runtime_identity
            .as_ref()
            .and_then(|identity| identity.runtime_source.as_deref())
    } else {
        Some("system-cli")
    };
    let resolved_identity =
        RuntimeIdentity::new(Some(&resolved_runtime_name), resolved_runtime_source);
    if let Some(runtime) = resolved_identity.runtime_for_env() {
        cmd.env("MYAGENTS_RUNTIME", runtime);
    }
    if let Some(runtime_source) = resolved_identity.runtime_source_for_env() {
        cmd.env("MYAGENTS_RUNTIME_SOURCE", runtime_source);
    }
    let runtime_for_trace = resolved_identity.runtime.clone();
    let runtime_source_for_trace = resolved_identity.runtime_source_label().to_string();

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Windows: CREATE_NO_WINDOW already applied by process_cmd::new()

    // Unix: Make child a process group leader so kill(-PGID) kills the entire tree
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // Spawn
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_start")
            .session_id(Some(session_id))
            .runtime(Some(&runtime_for_trace))
            .detail("runtimeSource", &runtime_source_for_trace)
            .detail("owner", format!("{:?}", owner)),
    );
    let mut child = cmd.spawn().map_err(|e| {
        ulog_error!("[sidecar] Failed to spawn SessionSidecar: {}", e);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_failed")
                .duration_ms(elapsed_ms(boot_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_for_trace)
                .status("error")
                .detail("error", e.to_string()),
        );
        format!("Failed to spawn sidecar: {}", e)
    })?;
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "spawned")
            .duration_ms(elapsed_ms(boot_started))
            .session_id(Some(session_id))
            .runtime(Some(&runtime_for_trace))
            .detail("runtimeSource", &runtime_source_for_trace)
            .status("ok")
            .detail("port", port),
    );

    // Capture stdout/stderr → 写入统一日志
    let session_id_clone = session_id.to_string();
    if let Some(stdout) = child.stdout.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut bun_logger_active = false;
            for line in reader.lines().flatten() {
                // Once Bun's unified logger is initialized, ALL console.log output is
                // written directly to the unified log file by Bun's logger interceptor.
                // Capturing stdout after this point causes 100% duplication ([BUN] + [bun-out]).
                // Only pre-logger startup lines need to go through bun-out.
                if !bun_logger_active {
                    if line.contains("[Logger] Unified logging initialized") {
                        bun_logger_active = true;
                    }
                    ulog_info!("[bun-out][session:{}] {}", session_id_for_log, line);
                }
                // After logger init: silently drop stdout (Bun logger handles it)
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                match classify_sidecar_stderr(&line) {
                    SidecarStderrLevel::Info => {
                        ulog_info!("[bun-err][session:{}] {}", session_id_for_log, line)
                    }
                    SidecarStderrLevel::Warn => {
                        ulog_warn!("[bun-err][session:{}] {}", session_id_for_log, line)
                    }
                    SidecarStderrLevel::Error => {
                        ulog_error!("[bun-err][session:{}] {}", session_id_for_log, line)
                    }
                }
            }
        });
    }

    // Check if the process already exited (non-blocking poll). No pre-sleep;
    // the health-loop's alive_check catches any crash this probe misses.
    if let Ok(Some(status)) = child.try_wait() {
        thread::sleep(Duration::from_millis(100));
        ulog_error!(
            "[sidecar] SessionSidecar exited immediately with status: {:?}",
            status
        );
        #[cfg(target_os = "windows")]
        maybe_mark_crashed_node(&status, &node_path);
        let diag = diagnose_immediate_exit(&status, &node_path);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_immediate_exit")
                .duration_ms(elapsed_ms(boot_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_for_trace)
                .status("error")
                .detail("status", format!("{:?}", status)),
        );
        return Err(diag);
    }

    // Create SessionSidecar with owner
    let mut owners = HashSet::new();
    owners.insert(owner.clone());
    let sidecar = SessionSidecar {
        process: child,
        port,
        session_id: session_id.to_string(),
        workspace_path: workspace_path.to_path_buf(),
        state: SidecarState::Starting,
        owners,
        created_at: std::time::Instant::now(),
        runtime: resolved_identity.runtime_for_env().map(str::to_string),
        runtime_source: resolved_identity
            .runtime_source_for_env()
            .map(str::to_string),
    };

    manager_guard.insert_sidecar(session_id, sidecar);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Build liveness check closure for session sidecar
    let liveness_manager = manager.clone();
    let liveness_session_id = session_id.to_string();
    let alive_check: Box<dyn Fn() -> bool> = Box::new(move || {
        if let Ok(mut guard) = liveness_manager.lock() {
            if let Some(sidecar) = guard.sidecars.get_mut(&liveness_session_id) {
                matches!(sidecar.process.try_wait(), Ok(None))
            } else {
                false
            }
        } else {
            true // can't acquire lock, assume alive
        }
    });

    // Wait for health (TCP up). Then wait for /health/ready (deferred init
    // complete) so renderer-driven session startup gates on actual readiness,
    // not just liveness. Other startup paths (cron / IM bot) keep the looser
    // liveness-only contract — they don't surface a "still warming up" UI.
    let health_started = trace_start();
    match wait_for_health(port, Some(alive_check)) {
        Ok(()) => {
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "tcp_live")
                    .duration_ms(elapsed_ms(health_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("ok")
                    .detail("port", port),
            );
            // Pattern 4: tighten the renderer-driven session sidecar startup
            // to wait for /health/ready as well. 30s timeout matches existing
            // long-running migration / SDK init budgets.
            let readiness_started = trace_start();
            if let Err(e) = wait_for_readiness(port, 30) {
                ulog_error!(
                    "[sidecar] Session {} /health/ready failed: {}",
                    session_id,
                    e
                );
                emit_perf_trace(
                    PerfTrace::new(PerfTraceName::SidecarBoot, "ready_failed")
                        .duration_ms(elapsed_ms(readiness_started))
                        .session_id(Some(session_id))
                        .runtime(Some(&runtime_for_trace))
                        .status("error")
                        .detail("port", port)
                        .detail("error", &e),
                );
                let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
                let port_matches = manager_guard
                    .sidecars
                    .get(session_id)
                    .map(|s| s.port == port)
                    .unwrap_or(false);
                if port_matches {
                    manager_guard.remove_sidecar(session_id);
                }
                return Err(e);
            }
            // Mark as healthy — verify port to avoid mutating a replacement sidecar
            // that was created by another thread (e.g., health monitor) during the wait.
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port {
                    sidecar.state = SidecarState::Healthy;
                } else {
                    ulog_warn!(
                        "[sidecar] Session {} sidecar replaced during wait_for_health (expected port {}, found {}), skipping Healthy transition",
                        session_id, port, sidecar.port
                    );
                }
            }
            ulog_info!(
                "[sidecar] SessionSidecar for session {} is healthy on port {}",
                session_id,
                port
            );
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "ready_ok")
                    .duration_ms(elapsed_ms(boot_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("ok")
                    .detail("port", port),
            );
            Ok(EnsureSidecarResult { port, is_new: true })
        }
        Err(e) => {
            ulog_error!("[sidecar] SessionSidecar health check failed: {}", e);
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "tcp_live_failed")
                    .duration_ms(elapsed_ms(health_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("error")
                    .detail("port", port)
                    .detail("error", &e),
            );
            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            // Verify port before acting — another thread may have replaced the sidecar
            let port_matches = manager_guard
                .sidecars
                .get(session_id)
                .map(|s| s.port == port)
                .unwrap_or(false);
            if port_matches {
                // Check exit status and mark crashed bun for fallback
                #[cfg(target_os = "windows")]
                if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                    if let Ok(Some(status)) = sidecar.process.try_wait() {
                        maybe_mark_crashed_node(&status, &node_path);
                    }
                }
                // Remove the failed sidecar (ours, not a replacement)
                manager_guard.remove_sidecar(session_id);
            } else {
                ulog_warn!(
                    "[sidecar] Session {} sidecar replaced during wait_for_health (port {}), skipping removal",
                    session_id, port
                );
            }
            Err(e)
        }
    }
}

/// Release an owner from a Session's Sidecar.
/// If this was the last owner, the Sidecar is stopped.
///
/// Returns true if the Sidecar was stopped (no more owners).
pub fn release_session_sidecar(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
) -> Result<bool, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    let (removed, stopped) = manager_guard.remove_session_owner(session_id, owner);

    if removed {
        if stopped {
            // Clean up generation counter when sidecar is permanently removed
            manager_guard.clear_generation(session_id);
            ulog_info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar stopped (last owner)",
                owner,
                session_id
            );
        } else {
            ulog_info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar continues running",
                owner,
                session_id
            );
        }
        Ok(stopped)
    } else {
        ulog_debug!(
            "[sidecar] Session {} has no Sidecar to release owner {:?} from",
            session_id,
            owner
        );
        Ok(false)
    }
}

/// Get the port for a Session's Sidecar
pub fn get_session_sidecar_port(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<Option<u16>, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager_guard.get_session_port(session_id))
}

/// Check whether a Session has a live Sidecar entry, including one still starting.
pub fn has_session_sidecar(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<bool, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager_guard.has_session_sidecar(session_id))
}

/// Get the current sidecar generation for a Session, if Rust still tracks one.
pub fn get_session_generation(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<Option<u64>, String> {
    let manager_guard = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager_guard.generation_for(session_id))
}

// ============= Session-Centric Tauri Commands =============

/// Ensure a Session has a Sidecar running, adding the specified owner
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_ensure_session_sidecar(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    workspacePath: String,
    ownerType: String,
    ownerId: String,
) -> Result<EnsureSidecarResult, String> {
    let owner = match ownerType.as_str() {
        "tab" => SidecarOwner::Tab(ownerId),
        "cron_task" => SidecarOwner::CronTask(ownerId),
        "im_bot" | "agent" => SidecarOwner::Agent(ownerId),
        _ => return Err(format!("Invalid owner type: {}", ownerType)),
    };

    let workspace_path = PathBuf::from(&workspacePath);

    // CRITICAL: this command BLOCKS for the entire cold sidecar boot (~800ms — it
    // waits for the sidecar's /health/ready). A SYNC `pub fn` Tauri command runs on
    // the MAIN THREAD, which on macOS is the WKWebView's UI thread — so a sync
    // version freezes the whole UI for the boot: the Launcher→Chat flip commits in
    // React but the WebView physically cannot PAINT it until the command returns.
    // (Measured via a double-rAF `chat_painted` mark: the paint fired ~3ms AFTER
    // this resolved, i.e. ~800ms after the click — that was the user's
    // "click → wait → page appears", and it's why every renderer-side fix did
    // nothing.) Make the command `async` and run the blocking boot on a blocking
    // thread so the main thread stays free and the WebView paints the flip in the
    // next frame. Clone the manager Arc out of the State first (the State guard must
    // not be held across the .await).
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_sidecar(&app_handle, &manager, &sessionId, &workspace_path, owner)
    })
    .await
    .map_err(|e| format!("ensure_session_sidecar blocking task failed: {e:?}"))?
}

/// Release an owner from a Session's Sidecar
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_release_session_sidecar(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    ownerType: String,
    ownerId: String,
) -> Result<bool, String> {
    let owner = match ownerType.as_str() {
        "tab" => SidecarOwner::Tab(ownerId),
        "cron_task" => SidecarOwner::CronTask(ownerId),
        "background_completion" => SidecarOwner::BackgroundCompletion(ownerId),
        "im_bot" | "agent" => SidecarOwner::Agent(ownerId),
        _ => return Err(format!("Invalid owner type: {}", ownerType)),
    };

    release_session_sidecar(&state, &sessionId, &owner)
}

/// Get the ready port for a Session's Sidecar.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_get_session_port(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<Option<u16>, String> {
    get_session_sidecar_port(&state, &sessionId)
}

/// Check whether a Session has a live Sidecar entry, including Starting.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_has_session_sidecar(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<bool, String> {
    has_session_sidecar(&state, &sessionId)
}

/// Get the current sidecar generation for a Session, if any.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_get_session_generation(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<Option<u64>, String> {
    get_session_generation(&state, &sessionId)
}

/// Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
/// This updates HashMap keys without stopping the Sidecar.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_upgrade_session_id(
    state: tauri::State<'_, ManagedSidecarManager>,
    oldSessionId: String,
    newSessionId: String,
) -> Result<bool, String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    Ok(manager.upgrade_session_id(&oldSessionId, &newSessionId))
}

/// Check if a session's Sidecar has persistent background owners (CronTask or Agent)
/// Used by frontend to decide whether closing a tab needs confirmation.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_session_has_persistent_owners(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> bool {
    let manager = state.lock().unwrap_or_else(|e| e.into_inner());
    manager.session_has_persistent_owners(&sessionId)
}
