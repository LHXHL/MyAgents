use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Emitter;

const CONFIG_KEY: &str = "externalCliAccess";
pub const INTERNAL_TOKEN_HEADER: &str = "x-myagents-internal-cli-token";
pub const INTERNAL_TOKEN_ENV: &str = "MYAGENTS_INTERNAL_CLI_TOKEN";

static INTERNAL_TOKEN: OnceLock<String> = OnceLock::new();

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCliAccessState {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub launcher_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredExternalCliAccess {
    #[serde(default)]
    enabled: bool,
    token: Option<String>,
    created_at: Option<String>,
}

fn new_secret(prefix: &str) -> String {
    format!(
        "{prefix}_{}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub fn internal_token() -> &'static str {
    INTERNAL_TOKEN
        .get_or_init(|| new_secret("mai"))
        .as_str()
}

pub fn inject_internal_token(command: &mut std::process::Command) {
    command.env(INTERNAL_TOKEN_ENV, internal_token());
}

pub fn inject_internal_token_builder(command: &mut portable_pty::CommandBuilder) {
    command.env(INTERNAL_TOKEN_ENV, internal_token());
}

pub fn internal_request_is_valid(headers: &HeaderMap) -> bool {
    headers
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|candidate| constant_time_eq(candidate.as_bytes(), internal_token().as_bytes()))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left_byte, right_byte) in left.iter().zip(right) {
        difference |= left_byte ^ right_byte;
    }
    difference == 0
}

fn config_path() -> Result<PathBuf, String> {
    crate::app_dirs::myagents_data_dir()
        .map(|dir| dir.join("config.json"))
        .ok_or_else(|| "MyAgents data directory is unavailable".to_string())
}

fn launcher_path() -> String {
    let file_name = if cfg!(windows) { "myagents.cmd" } else { "myagents" };
    crate::app_dirs::myagents_data_dir()
        .map(|dir| dir.join("bin").join(file_name))
        .unwrap_or_else(|| PathBuf::from(file_name))
        .to_string_lossy()
        .into_owned()
}

fn parse_state(config: &serde_json::Value, reveal_token: bool) -> ExternalCliAccessState {
    let stored = config
        .get(CONFIG_KEY)
        .cloned()
        .and_then(|value| serde_json::from_value::<StoredExternalCliAccess>(value).ok())
        .unwrap_or(StoredExternalCliAccess {
            enabled: false,
            token: None,
            created_at: None,
        });
    ExternalCliAccessState {
        enabled: stored.enabled,
        token: reveal_token.then_some(stored.token).flatten(),
        created_at: stored.created_at,
        launcher_path: launcher_path(),
    }
}

fn emit_config_changed() {
    if let Some(app) = crate::logger::get_app_handle() {
        let _ = app.emit("app:config-changed", ());
        let _ = app.emit("external-cli-access-changed", ());
    }
}

#[tauri::command]
pub async fn cmd_get_external_cli_access() -> Result<ExternalCliAccessState, String> {
    let config = crate::config_io::read_config_json(&config_path()?)?;
    Ok(parse_state(&config, true))
}

#[tauri::command]
pub async fn cmd_set_external_cli_enabled(
    enabled: bool,
) -> Result<ExternalCliAccessState, String> {
    let path = config_path()?;
    let config = crate::config_io::with_config_lock(&path, false, move |config| {
        let current = parse_state(config, true);
        let token = current
            .token
            .or_else(|| enabled.then(|| new_secret("mae")));
        let created_at = current.created_at.or_else(|| {
            token
                .as_ref()
                .map(|_| chrono::Utc::now().to_rfc3339())
        });
        config[CONFIG_KEY] = serde_json::json!({
            "enabled": enabled,
            "token": token,
            "createdAt": created_at,
        });
        Ok(())
    })?;
    emit_config_changed();
    Ok(parse_state(&config, true))
}

#[tauri::command]
pub async fn cmd_reset_external_cli_token() -> Result<ExternalCliAccessState, String> {
    let path = config_path()?;
    let config = crate::config_io::with_config_lock(&path, false, |config| {
        let current = parse_state(config, true);
        config[CONFIG_KEY] = serde_json::json!({
            "enabled": current.enabled,
            "token": new_secret("mae"),
            "createdAt": chrono::Utc::now().to_rfc3339(),
        });
        Ok(())
    })?;
    emit_config_changed();
    Ok(parse_state(&config, true))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCliAdmission {
    pub allowed: bool,
    pub code: &'static str,
}

pub fn authorize_external_token(token: &str) -> Result<ExternalCliAdmission, String> {
    let config = crate::config_io::read_config_json(&config_path()?)?;
    let state = parse_state(&config, true);
    if !state.enabled {
        return Ok(ExternalCliAdmission {
            allowed: false,
            code: "external_cli_disabled",
        });
    }
    let Some(expected) = state.token else {
        return Ok(ExternalCliAdmission {
            allowed: false,
            code: "external_cli_token_missing",
        });
    };
    if token.is_empty() || !constant_time_eq(token.as_bytes(), expected.as_bytes()) {
        return Ok(ExternalCliAdmission {
            allowed: false,
            code: "external_cli_token_invalid",
        });
    }
    Ok(ExternalCliAdmission {
        allowed: true,
        code: "ok",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_comparison_requires_equal_bytes() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    #[test]
    fn internal_token_is_stable_for_process_lifetime() {
        let first = internal_token().to_string();
        assert_eq!(first, internal_token());
        assert!(first.starts_with("mai_"));
        assert!(first.len() > 64);
    }

    #[test]
    fn internal_request_requires_the_exact_process_capability() {
        let mut headers = HeaderMap::new();
        assert!(!internal_request_is_valid(&headers));
        headers.insert(INTERNAL_TOKEN_HEADER, "wrong".parse().unwrap());
        assert!(!internal_request_is_valid(&headers));
        headers.insert(
            INTERNAL_TOKEN_HEADER,
            internal_token().parse().expect("internal token header"),
        );
        assert!(internal_request_is_valid(&headers));
    }
}
