use super::*;

// ============= Proxy Hot-Reload =============

/// Build the proxy payload from disk config for broadcasting to Sidecars.
fn build_proxy_payload() -> serde_json::Value {
    match proxy_config::read_raw_proxy_settings() {
        Some(s) => {
            let scope = proxy_config::normalized_proxy_scope(&s);
            let enabled = s.enabled && proxy_config::get_proxy_url(&s).is_ok();
            serde_json::json!({
                "enabled": enabled,
                "protocol": s.protocol.unwrap_or_else(|| "http".into()),
                "host": s.host.unwrap_or_else(|| "127.0.0.1".into()),
                "port": s.port.unwrap_or(7890),
                "scope": scope,
            })
        }
        None => serde_json::json!({
            "enabled": false,
            "scope": { "mode": "all" },
        }),
    }
}

/// POST proxy config to a single Sidecar.
async fn post_proxy(client: &reqwest::Client, port: u16, payload: &serde_json::Value) -> bool {
    let url = format!("http://127.0.0.1:{}/api/proxy/set", port);
    match client.post(&url).json(payload).send().await {
        Ok(r) if r.status().is_success() => {
            ulog_info!("[proxy-propagate] Updated sidecar on port {}", port);
            true
        }
        Ok(r) => {
            ulog_warn!("[proxy-propagate] Port {} returned {}", port, r.status());
            false
        }
        Err(e) => {
            ulog_warn!("[proxy-propagate] Port {} unreachable: {}", port, e);
            false
        }
    }
}

/// Propagate proxy settings from disk config to all running Sidecars.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_propagate_proxy(
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    imState: tauri::State<'_, crate::im::ManagedImBots>,
) -> Result<serde_json::Value, String> {
    let payload = build_proxy_payload();

    let client = crate::local_http::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut ok = 0u32;
    let mut fail = 0u32;

    // 1. Tab + Global Sidecars
    let ports = sidecarManager
        .lock()
        .map_err(|e| e.to_string())?
        .get_all_active_ports();
    for port in &ports {
        if post_proxy(&client, *port, &payload).await {
            ok += 1;
        } else {
            fail += 1;
        }
    }

    // 2. IM Bot Sidecars — collect ports under lock, then release before network I/O
    let im_ports: Vec<u16> = {
        let im_guard = imState.lock().await;
        let mut collected = Vec::new();
        for (_bot_id, instance) in im_guard.iter() {
            let router = instance.router.lock().await;
            for port in router.active_sidecar_ports() {
                if !ports.contains(&port) {
                    collected.push(port);
                }
            }
        }
        collected.sort();
        collected.dedup();
        collected
    }; // Both im_guard and router locks released here

    for port in &im_ports {
        if post_proxy(&client, *port, &payload).await {
            ok += 1;
        } else {
            fail += 1;
        }
    }

    ulog_info!("[proxy-propagate] Done: {} updated, {} failed", ok, fail);
    Ok(serde_json::json!({ "updated": ok, "failed": fail }))
}
