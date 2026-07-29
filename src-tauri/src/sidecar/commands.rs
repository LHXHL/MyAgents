use super::*;

// ============= Session Activation Tauri Commands =============

/// Get session activation status
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_get_session_activation(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Option<SessionActivation> {
    let manager = state.lock().ok()?;
    manager.get_session_activation(&sessionId).cloned()
}

/// Activate a session (associate with Sidecar)
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_activate_session(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    tabId: Option<String>,
    taskId: Option<String>,
    port: u16,
    workspacePath: String,
    isCronTask: bool,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.activate_session(sessionId, tabId, taskId, port, workspacePath, isCronTask);
    Ok(())
}

/// Deactivate a session
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_deactivate_session(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.deactivate_session(&sessionId);
    Ok(())
}

/// Update session's tab association
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_update_session_tab(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    tabId: Option<String>,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.update_session_tab(&sessionId, tabId);
    Ok(())
}

/// Atomically reconcile an ensured Tab with the latest activation owner state.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_reconcile_session_tab_activation(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    tabId: String,
) -> Result<bool, String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    Ok(manager.reconcile_session_tab_activation(&sessionId, &tabId))
}
