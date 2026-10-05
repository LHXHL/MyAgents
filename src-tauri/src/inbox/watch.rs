use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::sidecar::{ManagedSidecarManager, SidecarState};
use crate::{ulog_info, ulog_warn};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWatchRequest {
    pub watch_id: String,
    pub watcher_session_id: String,
    #[serde(default)]
    pub watcher_resume_workspace_path: Option<String>,
    pub target_session_id: String,
    #[serde(default)]
    pub target_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_return: Option<super::types::NetworkReturnReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observer_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWatchResult {
    pub watch_id: String,
    pub target_session_id: String,
    pub target_state_at_registration: String,
    pub delivery: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_status: Option<String>,
    pub coalesced: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterWatchResponse {
    accepted: bool,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    delivery: Option<String>,
    #[serde(default)]
    target_state_at_registration: Option<String>,
    #[serde(default)]
    final_state: Option<String>,
    #[serde(default)]
    terminal_reason: Option<String>,
    #[serde(default)]
    latest_result: Option<String>,
    #[serde(default)]
    watch_id: Option<String>,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    terminal_status: Option<String>,
    #[serde(default)]
    coalesced: bool,
}

fn lookup_live_port(manager: &ManagedSidecarManager, session_id: &str) -> Option<(u16, String)> {
    let guard = manager.lock().ok()?;
    let sidecar = guard.get_session_sidecar(session_id)?;
    match sidecar.state {
        SidecarState::Healthy if sidecar.is_reusable() => {
            Some((sidecar.port, "healthy".to_string()))
        }
        SidecarState::Healthy => None,
        SidecarState::Starting => Some((sidecar.port, "starting".to_string())),
        SidecarState::Dead => None,
    }
}

async fn register_on_target_sidecar(
    port: u16,
    req: &SessionWatchRequest,
    observed_sidecar_state: &str,
) -> Result<RegisterWatchResponse, String> {
    let url = format!("http://127.0.0.1:{}/api/session-watch/register", port);
    let client = crate::local_http::json_client(Duration::from_secs(10));
    let deadline = if observed_sidecar_state == "starting" {
        Some(Instant::now() + Duration::from_secs(45))
    } else {
        None
    };

    loop {
        let response = client
            .post(&url)
            .header(
                crate::external_cli::INTERNAL_TOKEN_HEADER,
                crate::external_cli::internal_token(),
            )
            .json(&serde_json::json!({
                "watchId": req.watch_id.clone(),
                "watcherSessionId": req.watcher_session_id.clone(),
                "watcherResumeWorkspacePath": req.watcher_resume_workspace_path.clone(),
                "targetSessionId": req.target_session_id.clone(),
                "targetLabel": req.target_label.clone(),
                "observedSidecarState": observed_sidecar_state,
                "networkReturn": req.network_return.clone(),
                "observerScope": req.observer_scope.clone(),
            }))
            .send()
            .await;

        match response {
            Ok(response) => {
                let status = response.status();
                if !status.is_success() {
                    if status.as_u16() == 503 && deadline.is_some_and(|d| Instant::now() < d) {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }
                    return Err(format!("target watch register HTTP {}", status.as_u16()));
                }
                return response
                    .json::<RegisterWatchResponse>()
                    .await
                    .map_err(|e| format!("target watch register response parse failed: {}", e));
            }
            Err(e) => {
                if deadline.is_some_and(|d| Instant::now() < d) {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
                return Err(format!("target watch register HTTP failed: {}", e));
            }
        }
    }
}

pub async fn register_session_watch(
    _app_handle: AppHandle,
    manager: ManagedSidecarManager,
    req: SessionWatchRequest,
) -> SessionWatchResult {
    let Some((port, observed_sidecar_state)) = lookup_live_port(&manager, &req.target_session_id)
    else {
        let exists = crate::sidecar::session_lifecycle::session_exists_for_continuation(
            &manager,
            &req.target_session_id,
        );
        return SessionWatchResult {
            watch_id: req.watch_id,
            target_session_id: req.target_session_id,
            target_state_at_registration: "idle".to_string(),
            delivery: if exists { "already_idle" } else { "not_found" }.to_string(),
            final_state: None,
            terminal_reason: None,
            latest_result: None,
            turn_id: None, terminal_status: None, coalesced: false,
        };
    };

    match register_on_target_sidecar(port, &req, &observed_sidecar_state).await {
        Ok(body) => {
            let target_state = body
                .target_state_at_registration
                .unwrap_or_else(|| "unknown".to_string());
            let delivery = body.delivery.unwrap_or_else(|| {
                if body.accepted {
                    "registered".to_string()
                } else {
                    body.reason.unwrap_or_else(|| "error".to_string())
                }
            });

            if body.accepted && delivery == "registered" {
                ulog_info!(
                    "[session-watch] registered watch_id={} target={} watcher={} state={}",
                    req.watch_id,
                    req.target_session_id,
                    req.watcher_session_id,
                    target_state
                );
                return SessionWatchResult {
                    watch_id: body.watch_id.unwrap_or(req.watch_id),
                    target_session_id: req.target_session_id,
                    target_state_at_registration: target_state,
                    delivery,
                    final_state: None,
                    terminal_reason: None,
                    latest_result: body.latest_result,
                    turn_id: body.turn_id, terminal_status: body.terminal_status, coalesced: body.coalesced,
                };
            }

            return SessionWatchResult {
                watch_id: req.watch_id,
                target_session_id: req.target_session_id,
                target_state_at_registration: target_state,
                delivery: if delivery == "already_idle" {
                    "already_idle".to_string()
                } else {
                    "error".to_string()
                },
                final_state: body.final_state,
                terminal_reason: body.terminal_reason,
                latest_result: body.latest_result,
                turn_id: body.turn_id, terminal_status: body.terminal_status, coalesced: body.coalesced,
            };
        }
        Err(e) => {
            ulog_warn!(
                "[session-watch] failed to register watch_id={} target={}: {}",
                req.watch_id,
                req.target_session_id,
                e
            );
            SessionWatchResult {
                watch_id: req.watch_id,
                target_session_id: req.target_session_id,
                target_state_at_registration: "unknown".to_string(),
                delivery: "error".to_string(),
                final_state: Some("registration_failed".to_string()),
                terminal_reason: Some("watch_registration_failed".to_string()),
                latest_result: None,
            turn_id: None, terminal_status: None, coalesced: false,
            }
        }
    }
}

/// Remove only the watcher bound to this original remote invocation. Cleanup
/// cannot select a URL, cancel a turn, or remove a local/replacement watcher.
pub(crate) async fn remove_network_watch(
    manager:&ManagedSidecarManager,target_session:&str,watch_id:&str,
    reference:&super::types::NetworkReturnReference,
) {
    let dispatch=manager.lock().ok().and_then(|mut state|state.acquire_session_dispatch(target_session).ok().flatten());
    let Some(dispatch)=dispatch else{return;};
    let Ok(url)=dispatch.url_for_path("/api/session-watch/network-remove")else{return;};
    let _=crate::local_http::json_client(Duration::from_secs(10)).post(url)
        .header(crate::external_cli::INTERNAL_TOKEN_HEADER,crate::external_cli::internal_token())
        .json(&serde_json::json!({"targetSessionId":target_session,"watchId":watch_id,"networkReturn":reference}))
        .send().await;
}

/// Local observations remain in each target's existing watch registry. Read
/// current owners rather than introducing a second source registry or history.
pub(crate) async fn manage_local_watches(manager:&ManagedSidecarManager, watcher:&str, cancel:Option<&str>, all:bool) -> Result<Vec<serde_json::Value>,crate::agent_network::NetworkError> {
    let dispatches={
        let mut state=manager.lock().map_err(|_|crate::agent_network::NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?;
        let ids:Vec<_>=state.live_sidecar_set().into_iter().map(|(id,_)|id).collect();
        ids.into_iter().filter_map(|id|state.acquire_session_dispatch(&id).ok().flatten()).collect::<Vec<_>>()
    };
    let responses=futures_util::future::join_all(dispatches.into_iter().map(|dispatch|async move {
        let url=dispatch.url_for_path("/api/session-watch/manage").map_err(|_|crate::agent_network::NetworkError::new("WATCH_OWNER_UNAVAILABLE"))?;
        let response=crate::local_http::json_client(Duration::from_secs(10)).post(url)
            .header(crate::external_cli::INTERNAL_TOKEN_HEADER,crate::external_cli::internal_token())
            .json(&serde_json::json!({"watcherSessionId":watcher,"cancel":cancel,"all":all})).send().await
            .map_err(|_|crate::agent_network::NetworkError::new("WATCH_OWNER_UNAVAILABLE"))?;
        let value:serde_json::Value=response.error_for_status().map_err(|_|crate::agent_network::NetworkError::new("WATCH_OWNER_UNAVAILABLE"))?
            .json().await.map_err(|_|crate::agent_network::NetworkError::new("WATCH_OWNER_INVALID_RESPONSE"))?;
        Ok::<_,crate::agent_network::NetworkError>(value["watches"].as_array().cloned().unwrap_or_default())
    })).await;
    let mut result=Vec::new();
    for response in responses { result.extend(response?); }
    Ok(result)
}
