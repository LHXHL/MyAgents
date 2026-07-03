use std::fs;
use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_name: Option<String>,
    pub platform: String,
    pub os_version: Option<String>,
    pub app_version: String,
}

pub fn get_or_create_device_id() -> Result<String, String> {
    let device_id_file = device_id_path()?;

    if device_id_file.exists() {
        match fs::read_to_string(&device_id_file) {
            Ok(id) => {
                let id = id.trim().to_string();
                if !id.is_empty() {
                    return Ok(id);
                }
            }
            Err(_) => {
                // Regenerate below. This matches the legacy command behavior.
            }
        }
    }

    let new_id = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = device_id_file.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create ~/.myagents directory: {}", e))?;
    }
    fs::write(&device_id_file, &new_id)
        .map_err(|e| format!("Failed to write device_id file: {}", e))?;
    Ok(new_id)
}

pub fn current_device_identity() -> Result<DeviceIdentity, String> {
    Ok(DeviceIdentity {
        device_id: get_or_create_device_id()?,
        device_name: local_device_name(),
        platform: platform_identifier(),
        os_version: os_version(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

pub fn platform_identifier() -> String {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-aarch64".to_string();

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "darwin-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "windows-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return "windows-aarch64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x86_64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "linux-aarch64".to_string();

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    return "unknown".to_string();
}

pub fn local_device_name() -> Option<String> {
    normalize_device_name(sysinfo::System::host_name())
        .or_else(|| normalize_device_name(std::env::var("COMPUTERNAME").ok()))
        .or_else(|| normalize_device_name(std::env::var("HOSTNAME").ok()))
}

fn device_id_path() -> Result<PathBuf, String> {
    let home_dir = dirs::home_dir().ok_or_else(|| "Failed to get home directory".to_string())?;
    Ok(home_dir.join(".myagents").join("device_id"))
}

fn normalize_device_name(value: Option<String>) -> Option<String> {
    value
        .map(|name| name.trim().trim_end_matches('.').to_string())
        .filter(|name| !name.is_empty())
}

fn os_version() -> Option<String> {
    sysinfo::System::long_os_version()
        .or_else(sysinfo::System::os_version)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
