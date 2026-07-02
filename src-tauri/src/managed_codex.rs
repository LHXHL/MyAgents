use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{ChildStderr, ChildStdout, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Utc};
use minisign_verify::{Error as MinisignError, PublicKey, Signature};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::utils::file_lock::{with_file_lock_blocking, FileLockError, FileLockOptions};
use crate::{ulog_error, ulog_info, ulog_warn};

const CODEX_PROVIDER_ID: &str = "codex-sub";
const REQUIRED_VERSION: &str = "0.142.2";
const REQUIRED_RUNTIME_SET: &str = "codex-0.142.2";
const RUNTIME_SETS_BASE_URL: &str = "https://download.myagents.io/runtimes/codex/sets";
// Keep this in sync with `src-tauri/tauri.conf.json > plugins.updater.pubkey`.
// Managed runtime manifests and artifacts use the same minisign trust root as app updates.
const MYAGENTS_MINISIGN_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY3RkQ5QjIzMTE4RTgyRTkKUldUcGdvNFJJNXY5OTB3T2pnUzVUbjFrV203Zk5ZTDg0NVJRdGI0UVRranJzTUsvM0hGcmFlc0IK";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const DOWNLOAD_HOST: &str = "download.myagents.io";
const DOWNLOAD_PATH_PREFIX: &str = "/runtimes/codex/";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_MANIFEST_SIGNATURE_BYTES: u64 = 16 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 900 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 4096;
const MAX_CAPTURED_OUTPUT_CHARS: usize = 1000;
const DOWNLOADING_STATE_TTL_SECS: i64 = 30 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCodexRuntimeInstallState {
    pub status: String,
    pub required_version: Option<String>,
    pub installed_version: Option<String>,
    pub platform: Option<String>,
    pub installed_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub progress_percent: Option<u8>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCodexAuthState {
    pub status: String,
    pub auth_method: Option<String>,
    pub account_email: Option<String>,
    pub verified_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCodexStatus {
    pub runtime_install: ManagedCodexRuntimeInstallState,
    pub auth: ManagedCodexAuthState,
    pub codex_home: Option<String>,
    pub runtime_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCodexLoginState {
    pub status: String,
    pub login_url: Option<String>,
    pub started_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct ManagedCodexLoginRuntimeState {
    status: String,
    login_url: Option<String>,
    started_at: Option<String>,
    error: Option<String>,
    raw_output: String,
}

impl Default for ManagedCodexLoginRuntimeState {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            login_url: None,
            started_at: None,
            error: None,
            raw_output: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledJson {
    version: String,
    platform: String,
    sha256: Option<String>,
    manifest_signature: Option<String>,
    artifact_signature_verified: Option<bool>,
    platform_signature: Option<ManagedCodexSigningVerification>,
    installed_at: Option<String>,
    source_url: Option<String>,
    executable_relative_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCodexManifest {
    schema_version: u32,
    runtime_set: String,
    codex_version: String,
    #[serde(default)]
    platform: Option<String>,
    artifacts: HashMap<String, ManagedCodexArtifact>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCodexArtifact {
    url: String,
    sha256: String,
    signature: String,
    #[serde(default)]
    signing: Option<ManagedCodexArtifactSigning>,
    executable_relative_path: String,
    #[serde(default)]
    file_allowlist: Vec<String>,
    #[serde(default = "default_archive_type")]
    archive_type: String,
    #[serde(default)]
    archive_size_bytes: Option<u64>,
    #[serde(default)]
    unpacked_size_bytes: Option<u64>,
    #[serde(default)]
    entry_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCodexArtifactSigning {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    team_id: Option<String>,
    #[serde(default)]
    signing_identity: Option<String>,
    #[serde(default)]
    publisher: Option<String>,
    #[serde(default)]
    certificate_sha256: Option<String>,
    #[serde(default)]
    notarization: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCodexSigningVerification {
    #[serde(rename = "type")]
    kind: String,
    verified_at: String,
    #[serde(default)]
    team_id: Option<String>,
    #[serde(default)]
    signing_identity: Option<String>,
    #[serde(default)]
    publisher: Option<String>,
    #[serde(default)]
    certificate_sha256: Option<String>,
    #[serde(default)]
    notarization: Option<String>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn default_archive_type() -> String {
    "zip".to_string()
}

fn platform_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

fn manifest_base_url() -> String {
    format!("{}/{}", RUNTIME_SETS_BASE_URL, REQUIRED_RUNTIME_SET)
}

fn manifest_url_for_platform(platform: &str) -> String {
    format!("{}/{}/manifest-v1.json", manifest_base_url(), platform)
}

fn manifest_signature_url_for_platform(platform: &str) -> String {
    format!("{}/{}/manifest-v1.json.sig", manifest_base_url(), platform)
}

fn data_dir() -> Result<PathBuf, String> {
    crate::app_dirs::myagents_data_dir()
        .ok_or_else(|| "[managed-codex] Cannot determine ~/.myagents directory".to_string())
}

fn codex_home() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("codex"))
}

fn runtime_root() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("runtimes").join("codex"))
}

fn installed_json_path() -> Result<PathBuf, String> {
    Ok(runtime_root()?.join("installed.json"))
}

fn required_install_dir(platform: &str) -> Result<PathBuf, String> {
    Ok(runtime_root()?.join(REQUIRED_VERSION).join(platform))
}

fn normalize_out_path(path: PathBuf) -> String {
    crate::sidecar::normalize_external_path(path)
        .to_string_lossy()
        .to_string()
}

fn read_installed_json() -> Option<InstalledJson> {
    let path = installed_json_path().ok()?;
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn managed_codex_binary_path(platform: &str) -> Option<PathBuf> {
    let dir = required_install_dir(platform).ok()?;
    if let Some(meta) = read_installed_json() {
        if meta.version == REQUIRED_VERSION && meta.platform == platform {
            if let Some(rel) = meta.executable_relative_path.as_deref() {
                if let Ok(rel_path) = validate_installed_executable_relative_path(rel) {
                    let candidate = dir.join(rel_path);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![
            dir.join("codex.exe"),
            dir.join("codex.cmd"),
            dir.join("bin").join("codex.exe"),
            dir.join("bin").join("codex.cmd"),
        ]
    } else {
        vec![dir.join("codex"), dir.join("bin").join("codex")]
    };
    candidates.into_iter().find(|p| p.is_file())
}

fn normalize_sha256_hex(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.len() != 64 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "Invalid SHA-256 value in Managed Codex manifest: {}",
            trimmed.chars().take(16).collect::<String>()
        ));
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn non_empty_trimmed(value: Option<&str>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn is_windows_reserved_segment(segment: &str) -> bool {
    let trimmed = segment.trim_end_matches([' ', '.']);
    if trimmed != segment {
        return true;
    }
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn validate_relative_archive_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("Archive entry path is empty".to_string());
    }
    if raw.contains('\\') || raw.contains('\0') || raw.contains("//") {
        return Err(format!(
            "Archive entry contains an unsafe separator: {}",
            raw
        ));
    }

    let mut out = PathBuf::new();
    let mut count = 0usize;
    for component in Path::new(raw).components() {
        match component {
            Component::Normal(segment) => {
                let segment = segment
                    .to_str()
                    .ok_or_else(|| format!("Archive entry is not valid UTF-8: {}", raw))?;
                if segment.is_empty()
                    || segment == "."
                    || segment == ".."
                    || segment.contains(':')
                    || is_windows_reserved_segment(segment)
                {
                    return Err(format!("Archive entry contains unsafe segment: {}", raw));
                }
                count += 1;
                if count > 64 || segment.len() > 255 {
                    return Err(format!(
                        "Archive entry path is too deep or too long: {}",
                        raw
                    ));
                }
                out.push(segment);
            }
            _ => {
                return Err(format!(
                    "Archive entry must be a relative normalized path: {}",
                    raw
                ));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("Archive entry path is empty".to_string());
    }
    Ok(out)
}

fn archive_key_from_path(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => {
                let segment = segment
                    .to_str()
                    .ok_or_else(|| "Archive allowlist path is not valid UTF-8".to_string())?;
                parts.push(segment.to_string());
            }
            _ => return Err("Archive allowlist path must be normalized relative path".to_string()),
        }
    }
    if parts.is_empty() {
        return Err("Archive allowlist path is empty".to_string());
    }
    Ok(parts.join("/"))
}

fn validate_artifact_file_allowlist(
    artifact: &ManagedCodexArtifact,
) -> Result<HashSet<String>, String> {
    if artifact.file_allowlist.is_empty() {
        return Err("Managed Codex artifact fileAllowlist is required".to_string());
    }
    let mut allowed = HashSet::new();
    for raw in &artifact.file_allowlist {
        if raw.ends_with('/') {
            return Err(format!(
                "Managed Codex fileAllowlist entries must be files, got {}",
                raw
            ));
        }
        let path = validate_relative_archive_path(raw)?;
        allowed.insert(archive_key_from_path(&path)?);
    }
    let executable_path = validate_executable_relative_path(&artifact.executable_relative_path)?;
    let executable_key = archive_key_from_path(&executable_path)?;
    if !allowed.contains(&executable_key) {
        return Err(format!(
            "Managed Codex fileAllowlist does not contain executable {}",
            artifact.executable_relative_path
        ));
    }
    Ok(allowed)
}

fn validate_executable_relative_path(raw: &str) -> Result<PathBuf, String> {
    if raw.ends_with('/') {
        return Err("Managed Codex executable path must point to a file".to_string());
    }
    let path = validate_relative_archive_path(raw)?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Managed Codex executable path has no file name".to_string())?;
    if !matches!(file_name, "codex" | "codex.exe" | "codex.cmd") {
        return Err(format!(
            "Managed Codex executable must be codex/codex.exe/codex.cmd, got {}",
            raw
        ));
    }
    Ok(path)
}

fn normalize_executable_relative_path_for_metadata(raw: &str) -> Result<String, String> {
    let path = validate_executable_relative_path(raw)?;
    archive_key_from_path(&path)
}

fn validate_installed_executable_relative_path(raw: &str) -> Result<PathBuf, String> {
    match validate_executable_relative_path(raw) {
        Ok(path) => Ok(path),
        Err(original_err) if raw.contains('\\') => {
            let normalized = raw.replace('\\', "/");
            validate_executable_relative_path(&normalized).map_err(|_| original_err)
        }
        Err(err) => Err(err),
    }
}

fn validate_download_url(raw: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(raw).map_err(|e| format!("Invalid Managed Codex URL: {}", e))?;
    if parsed.scheme() != "https" {
        return Err(format!("Managed Codex URL must use HTTPS: {}", raw));
    }
    if parsed.host_str() != Some(DOWNLOAD_HOST) {
        return Err(format!(
            "Managed Codex URL must be hosted on {}: {}",
            DOWNLOAD_HOST, raw
        ));
    }
    if !parsed.path().starts_with(DOWNLOAD_PATH_PREFIX) {
        return Err(format!(
            "Managed Codex URL must stay under {}: {}",
            DOWNLOAD_PATH_PREFIX, raw
        ));
    }
    if parsed.username() != "" || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err(format!(
            "Managed Codex URL contains unsupported auth/fragment: {}",
            raw
        ));
    }
    Ok(())
}

fn validate_artifact_url(raw: &str, platform: &str) -> Result<(), String> {
    validate_download_url(raw)?;
    let expected_prefix = format!("{}/{}/artifacts/", manifest_base_url(), platform);
    if !raw.starts_with(&expected_prefix) {
        return Err(format!(
            "Managed Codex artifact URL must stay under {}",
            expected_prefix
        ));
    }
    Ok(())
}

fn validate_platform_signing(
    platform: &str,
    signing: Option<&ManagedCodexArtifactSigning>,
) -> Result<(), String> {
    let signing = signing.ok_or_else(|| {
        format!(
            "Managed Codex artifact signing metadata is required for {}",
            platform
        )
    })?;
    match platform {
        "darwin-arm64" | "darwin-x64" => {
            if signing.kind != "codesign" {
                return Err(format!(
                    "Managed Codex macOS artifact must use codesign signing metadata, got {}",
                    signing.kind
                ));
            }
            if non_empty_trimmed(signing.team_id.as_deref()).is_none() {
                return Err(
                    "Managed Codex macOS artifact signing metadata requires teamId".to_string(),
                );
            }
        }
        "win32-x64" => {
            if signing.kind != "authenticode" {
                return Err(format!(
                    "Managed Codex Windows artifact must use authenticode signing metadata, got {}",
                    signing.kind
                ));
            }
            let certificate_sha256 = non_empty_trimmed(signing.certificate_sha256.as_deref())
                .ok_or_else(|| {
                    "Managed Codex Windows artifact signing metadata requires certificateSha256"
                        .to_string()
                })?;
            normalize_sha256_hex(&certificate_sha256)?;
        }
        _ => {
            return Err(format!(
                "Managed Codex platform signing metadata is unsupported for {}",
                platform
            ));
        }
    }
    Ok(())
}

fn validate_manifest_for_platform(
    manifest: ManagedCodexManifest,
    platform: &str,
) -> Result<ManagedCodexArtifact, String> {
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Managed Codex manifest schema: {}",
            manifest.schema_version
        ));
    }
    if manifest.runtime_set != REQUIRED_RUNTIME_SET {
        return Err(format!(
            "Managed Codex manifest runtimeSet mismatch: expected {}, got {}",
            REQUIRED_RUNTIME_SET, manifest.runtime_set
        ));
    }
    if manifest.codex_version != REQUIRED_VERSION {
        return Err(format!(
            "Managed Codex manifest codexVersion mismatch: expected {}, got {}",
            REQUIRED_VERSION, manifest.codex_version
        ));
    }
    if let Some(manifest_platform) = manifest.platform.as_deref() {
        if manifest_platform != platform {
            return Err(format!(
                "Managed Codex manifest platform mismatch: expected {}, got {}",
                platform, manifest_platform
            ));
        }
    }
    let artifact = manifest
        .artifacts
        .get(platform)
        .cloned()
        .ok_or_else(|| format!("Managed Codex manifest has no artifact for {}", platform))?;
    if artifact.archive_type != "zip" {
        return Err(format!(
            "Unsupported Managed Codex archive type for {}: {}",
            platform, artifact.archive_type
        ));
    }
    validate_artifact_url(&artifact.url, platform)?;
    normalize_sha256_hex(&artifact.sha256)?;
    validate_executable_relative_path(&artifact.executable_relative_path)?;
    validate_artifact_file_allowlist(&artifact)?;
    if artifact.signature.trim().is_empty() {
        return Err("Managed Codex artifact signature is required".to_string());
    }
    validate_platform_signing(platform, artifact.signing.as_ref())?;
    if let Some(size) = artifact.archive_size_bytes {
        if size == 0 || size > MAX_ARCHIVE_BYTES {
            return Err(format!(
                "Managed Codex artifact size is outside allowed bounds: {} bytes",
                size
            ));
        }
    }
    if let Some(size) = artifact.unpacked_size_bytes {
        if size == 0 || size > MAX_UNPACKED_BYTES {
            return Err(format!(
                "Managed Codex unpacked size is outside allowed bounds: {} bytes",
                size
            ));
        }
    }
    if let Some(entries) = artifact.entry_count {
        if entries == 0 || entries as usize > MAX_ARCHIVE_ENTRIES {
            return Err(format!(
                "Managed Codex archive entry count is outside allowed bounds: {}",
                entries
            ));
        }
    }
    Ok(artifact)
}

#[allow(clippy::disallowed_methods)]
fn external_http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    let builder = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(30));
    crate::proxy_config::build_blocking_client_with_proxy_for_provider(builder, CODEX_PROVIDER_ID)
        .map_err(|e| format!("[managed-codex] Failed to build HTTP client: {}", e))
}

fn fetch_limited_bytes(
    client: &reqwest::blocking::Client,
    url: &str,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    validate_download_url(url)?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("[managed-codex] Failed to fetch {}: {}", label, e))?
        .error_for_status()
        .map_err(|e| format!("[managed-codex] Failed to fetch {}: {}", label, e))?;
    if response.content_length().unwrap_or(0) > max_bytes {
        return Err(format!(
            "[managed-codex] {} exceeds max size: {} bytes",
            label,
            response.content_length().unwrap_or(0)
        ));
    }
    let mut out = Vec::new();
    let mut total = 0u64;
    let mut buf = [0u8; 16 * 1024];
    loop {
        let read = response
            .read(&mut buf)
            .map_err(|e| format!("[managed-codex] Failed to read {}: {}", label, e))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > max_bytes {
            return Err(format!("[managed-codex] {} exceeded max size", label));
        }
        out.extend_from_slice(&buf[..read]);
    }
    Ok(out)
}

fn download_to_file_with_hash(
    client: &reqwest::blocking::Client,
    url: &str,
    path: &Path,
    max_bytes: u64,
    progress_total_bytes: Option<u64>,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<(u64, String), String> {
    validate_download_url(url)?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("[managed-codex] Failed to download artifact: {}", e))?
        .error_for_status()
        .map_err(|e| format!("[managed-codex] Failed to download artifact: {}", e))?;
    if response.content_length().unwrap_or(0) > max_bytes {
        return Err(format!(
            "[managed-codex] Artifact exceeds max size: {} bytes",
            response.content_length().unwrap_or(0)
        ));
    }
    let total_for_progress = progress_total_bytes.or_else(|| response.content_length());
    on_progress(0, total_for_progress);
    let mut file = File::create(path)
        .map_err(|e| format!("[managed-codex] Failed to create artifact file: {}", e))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buf)
            .map_err(|e| format!("[managed-codex] Failed to read artifact: {}", e))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > max_bytes {
            return Err("[managed-codex] Artifact exceeded max size".to_string());
        }
        hasher.update(&buf[..read]);
        file.write_all(&buf[..read])
            .map_err(|e| format!("[managed-codex] Failed to write artifact: {}", e))?;
        on_progress(total, total_for_progress);
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn base64_to_string(value: &str, label: &str) -> Result<String, String> {
    let bytes = general_purpose::STANDARD
        .decode(value)
        .map_err(|e| format!("[managed-codex] Invalid {} base64: {}", label, e))?;
    String::from_utf8(bytes).map_err(|e| format!("[managed-codex] Invalid {} UTF-8: {}", label, e))
}

fn managed_minisign_public_key() -> Result<PublicKey, String> {
    let decoded = base64_to_string(MYAGENTS_MINISIGN_PUBKEY, "public key")?;
    PublicKey::decode(&decoded)
        .map_err(|e| format!("[managed-codex] Invalid minisign public key: {}", e))
}

fn managed_minisign_signature(signature: &str, label: &str) -> Result<Signature, String> {
    let decoded = base64_to_string(signature, label)?;
    Signature::decode(&decoded).map_err(|e| format!("[managed-codex] Invalid {}: {}", label, e))
}

fn verify_minisign_bytes(bytes: &[u8], signature: &str, label: &str) -> Result<(), String> {
    let public_key = managed_minisign_public_key()?;
    let signature = managed_minisign_signature(signature, label)?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|e| format!("[managed-codex] {} signature mismatch: {}", label, e))
}

fn verify_minisign_file(path: &Path, signature: &str) -> Result<(), String> {
    let public_key = managed_minisign_public_key()?;
    let signature = managed_minisign_signature(signature, "artifact signature")?;
    match public_key.verify_stream(&signature) {
        Ok(mut verifier) => {
            let mut file = File::open(path)
                .map_err(|e| format!("[managed-codex] Failed to open artifact: {}", e))?;
            let mut buf = [0u8; 64 * 1024];
            loop {
                let read = file
                    .read(&mut buf)
                    .map_err(|e| format!("[managed-codex] Failed to read artifact: {}", e))?;
                if read == 0 {
                    break;
                }
                verifier.update(&buf[..read]);
            }
            verifier
                .finalize()
                .map_err(|e| format!("[managed-codex] Artifact signature mismatch: {}", e))
        }
        Err(MinisignError::UnsupportedLegacyMode) => {
            let bytes = fs::read(path)
                .map_err(|e| format!("[managed-codex] Failed to read artifact: {}", e))?;
            public_key
                .verify(&bytes, &signature, true)
                .map_err(|e| format!("[managed-codex] Artifact signature mismatch: {}", e))
        }
        Err(e) => Err(format!(
            "[managed-codex] Cannot initialize artifact signature verifier: {}",
            e
        )),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn truncate_command_output(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes).trim().to_string();
    if text.chars().count() <= MAX_CAPTURED_OUTPUT_CHARS {
        return text;
    }
    let mut truncated = text
        .chars()
        .take(MAX_CAPTURED_OUTPUT_CHARS)
        .collect::<String>();
    truncated.push_str("...<truncated>");
    truncated
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn command_failure(label: &str, output: &Output) -> String {
    let stdout = truncate_command_output(&output.stdout);
    let stderr = truncate_command_output(&output.stderr);
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        output.status.to_string()
    };
    format!("[managed-codex] {} failed: {}", label, detail)
}

#[cfg(target_os = "macos")]
fn parse_keyed_line(output: &str, prefix: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.strip_prefix(prefix)
            .map(str::trim)
            .and_then(|value| non_empty_trimmed(Some(value)))
    })
}

#[cfg(target_os = "macos")]
fn first_authority(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.strip_prefix("Authority=")
            .map(str::trim)
            .and_then(|value| non_empty_trimmed(Some(value)))
    })
}

#[cfg(target_os = "macos")]
fn verify_macos_platform_signature(
    executable: &Path,
    signing: &ManagedCodexArtifactSigning,
) -> Result<ManagedCodexSigningVerification, String> {
    let verify_output = crate::process_cmd::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict", "--verbose=2"])
        .arg(executable)
        .output()
        .map_err(|e| format!("[managed-codex] Failed to spawn codesign verify: {}", e))?;
    if !verify_output.status.success() {
        return Err(command_failure("codesign verify", &verify_output));
    }

    let details_output = crate::process_cmd::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=4"])
        .arg(executable)
        .output()
        .map_err(|e| format!("[managed-codex] Failed to spawn codesign details: {}", e))?;
    let details = format!(
        "{}\n{}",
        String::from_utf8_lossy(&details_output.stdout),
        String::from_utf8_lossy(&details_output.stderr)
    );
    if !details_output.status.success() {
        return Err(command_failure("codesign details", &details_output));
    }

    let actual_team_id = parse_keyed_line(&details, "TeamIdentifier=").ok_or_else(|| {
        "[managed-codex] codesign output did not include TeamIdentifier".to_string()
    })?;
    let expected_team_id = non_empty_trimmed(signing.team_id.as_deref())
        .ok_or_else(|| "[managed-codex] manifest signing metadata missing teamId".to_string())?;
    if actual_team_id != expected_team_id {
        return Err(format!(
            "[managed-codex] codesign Team ID mismatch: expected {}, got {}",
            expected_team_id, actual_team_id
        ));
    }
    let signing_identity = first_authority(&details);
    if let Some(expected_identity) = non_empty_trimmed(signing.signing_identity.as_deref()) {
        let actual = signing_identity.as_deref().unwrap_or("");
        if !actual.contains(&expected_identity) {
            return Err(format!(
                "[managed-codex] codesign identity mismatch: expected {}, got {}",
                expected_identity, actual
            ));
        }
    }

    Ok(ManagedCodexSigningVerification {
        kind: "codesign".to_string(),
        verified_at: now_iso(),
        team_id: Some(actual_team_id),
        signing_identity,
        publisher: None,
        certificate_sha256: None,
        notarization: None,
    })
}

#[cfg(not(target_os = "macos"))]
fn verify_macos_platform_signature(
    _executable: &Path,
    _signing: &ManagedCodexArtifactSigning,
) -> Result<ManagedCodexSigningVerification, String> {
    Err("[managed-codex] macOS codesign verification can only run on macOS".to_string())
}

#[cfg(target_os = "windows")]
fn encode_powershell(script: &str) -> String {
    let mut utf16le = Vec::with_capacity(script.len() * 2);
    for c in script.encode_utf16() {
        utf16le.extend_from_slice(&c.to_le_bytes());
    }
    general_purpose::STANDARD.encode(utf16le)
}

#[cfg(target_os = "windows")]
fn powershell_path() -> PathBuf {
    if let Some(path) = crate::system_binary::find("powershell.exe")
        .or_else(|| crate::system_binary::find("powershell"))
    {
        return path;
    }
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    system_root
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

#[cfg(target_os = "windows")]
fn decode_powershell_text_output(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || looks_like_utf16le(bytes) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).to_string()
}

#[cfg(target_os = "windows")]
fn looks_like_utf16le(bytes: &[u8]) -> bool {
    if bytes.len() < 8 {
        return false;
    }
    let sampled = bytes.iter().skip(1).step_by(2).take(32).count();
    if sampled == 0 {
        return false;
    }
    let nul_odd_bytes = bytes
        .iter()
        .skip(1)
        .step_by(2)
        .take(32)
        .filter(|byte| **byte == 0)
        .count();
    nul_odd_bytes * 2 >= sampled
}

#[cfg(target_os = "windows")]
fn decode_powershell_base64_utf8_output(bytes: &[u8], label: &str) -> Result<String, String> {
    let text = decode_powershell_text_output(bytes);
    let encoded: String = text
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '\u{feff}' && *ch != '\0')
        .collect();
    if encoded.is_empty() {
        return Err(format!("[managed-codex] {} output is empty", label));
    }
    let decoded = general_purpose::STANDARD.decode(encoded).map_err(|e| {
        format!(
            "[managed-codex] {} output is not valid base64: {}",
            label, e
        )
    })?;
    String::from_utf8(decoded)
        .map_err(|e| format!("[managed-codex] {} output is not UTF-8: {}", label, e))
}

#[cfg(target_os = "windows")]
fn verify_windows_platform_signature(
    executable: &Path,
    signing: &ManagedCodexArtifactSigning,
) -> Result<ManagedCodexSigningVerification, String> {
    let executable_utf8 = executable
        .to_str()
        .ok_or_else(|| "[managed-codex] executable path is not UTF-8".to_string())?;
    let encoded_path = general_purpose::STANDARD.encode(executable_utf8.as_bytes());
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_path}'))
$sig = Get-AuthenticodeSignature -LiteralPath $path
$cert = $sig.SignerCertificate
$sha256 = $null
if ($cert -ne $null) {{
  $sha256 = [System.BitConverter]::ToString($cert.GetCertHash('SHA256')).Replace('-', '').ToLowerInvariant()
}}
$json = [ordered]@{{
  status = [string]$sig.Status
  statusMessage = [string]$sig.StatusMessage
  subject = if ($cert -ne $null) {{ [string]$cert.Subject }} else {{ $null }}
  sha256 = $sha256
}} | ConvertTo-Json -Compress
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
"#
    );
    let encoded = encode_powershell(&script);
    let shell = powershell_path();
    let output = crate::process_cmd::new(shell.as_os_str())
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ])
        .output()
        .map_err(|e| format!("[managed-codex] Failed to spawn PowerShell: {}", e))?;
    if !output.status.success() {
        return Err(command_failure("Get-AuthenticodeSignature", &output));
    }
    let stdout = decode_powershell_base64_utf8_output(&output.stdout, "Authenticode")?;
    let parsed: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("[managed-codex] Authenticode JSON parse failed: {}", e))?;
    let status = parsed
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if status != "Valid" {
        let message = parsed
            .get("statusMessage")
            .and_then(Value::as_str)
            .unwrap_or(status);
        return Err(format!(
            "[managed-codex] Authenticode status is not Valid: {}",
            message
        ));
    }

    let actual_sha = parsed
        .get("sha256")
        .and_then(Value::as_str)
        .and_then(|v| non_empty_trimmed(Some(v)))
        .ok_or_else(|| {
            "[managed-codex] Authenticode signer certificate SHA-256 missing".to_string()
        })?;
    let actual_sha = normalize_sha256_hex(&actual_sha)?;
    let expected_sha = signing
        .certificate_sha256
        .as_deref()
        .ok_or_else(|| {
            "[managed-codex] manifest signing metadata missing certificateSha256".to_string()
        })
        .and_then(normalize_sha256_hex)?;
    if actual_sha != expected_sha {
        return Err(format!(
            "[managed-codex] Authenticode certificate SHA-256 mismatch: expected {}, got {}",
            expected_sha, actual_sha
        ));
    }

    let publisher = parsed
        .get("subject")
        .and_then(Value::as_str)
        .and_then(|v| non_empty_trimmed(Some(v)));
    if let Some(expected_publisher) = non_empty_trimmed(signing.publisher.as_deref()) {
        let actual = publisher.as_deref().unwrap_or("").to_ascii_lowercase();
        if !actual.contains(&expected_publisher.to_ascii_lowercase()) {
            return Err(format!(
                "[managed-codex] Authenticode publisher mismatch: expected {}, got {}",
                expected_publisher,
                publisher.as_deref().unwrap_or("<none>")
            ));
        }
    }

    Ok(ManagedCodexSigningVerification {
        kind: "authenticode".to_string(),
        verified_at: now_iso(),
        team_id: None,
        signing_identity: None,
        publisher,
        certificate_sha256: Some(actual_sha),
        notarization: None,
    })
}

#[cfg(not(target_os = "windows"))]
fn verify_windows_platform_signature(
    _executable: &Path,
    _signing: &ManagedCodexArtifactSigning,
) -> Result<ManagedCodexSigningVerification, String> {
    Err("[managed-codex] Windows Authenticode verification can only run on Windows".to_string())
}

fn verify_platform_signature(
    platform: &str,
    executable: &Path,
    signing: &ManagedCodexArtifactSigning,
) -> Result<ManagedCodexSigningVerification, String> {
    validate_platform_signing(platform, Some(signing))?;
    match platform {
        "darwin-arm64" | "darwin-x64" => verify_macos_platform_signature(executable, signing),
        "win32-x64" => verify_windows_platform_signature(executable, signing),
        _ => Err(format!(
            "[managed-codex] Managed Codex does not support platform signing for {}",
            platform
        )),
    }
}

fn fetch_verified_manifest(
    client: &reqwest::blocking::Client,
    platform: &str,
) -> Result<(ManagedCodexManifest, String), String> {
    let manifest_url = manifest_url_for_platform(platform);
    let manifest_signature_url = manifest_signature_url_for_platform(platform);
    let manifest_bytes =
        fetch_limited_bytes(client, &manifest_url, MAX_MANIFEST_BYTES, "manifest")?;
    let signature_bytes = fetch_limited_bytes(
        client,
        &manifest_signature_url,
        MAX_MANIFEST_SIGNATURE_BYTES,
        "manifest signature",
    )?;
    let signature = String::from_utf8(signature_bytes)
        .map_err(|e| format!("[managed-codex] Manifest signature is not UTF-8: {}", e))?;
    let signature = signature.trim();
    if signature.is_empty() {
        return Err("[managed-codex] Managed Codex manifest signature is required".to_string());
    }
    verify_minisign_bytes(&manifest_bytes, signature, "manifest signature")?;
    let manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("[managed-codex] Invalid manifest JSON: {}", e))?;
    Ok((manifest, signature.to_string()))
}

fn zip_entry_is_symlink(mode: Option<u32>) -> bool {
    mode.map(|m| (m & 0o170000) == 0o120000).unwrap_or(false)
}

fn extract_managed_codex_zip(
    archive_path: &Path,
    destination: &Path,
    artifact: &ManagedCodexArtifact,
) -> Result<PathBuf, String> {
    let archive_file = File::open(archive_path)
        .map_err(|e| format!("[managed-codex] Failed to open artifact zip: {}", e))?;
    let mut zip = ZipArchive::new(archive_file)
        .map_err(|e| format!("[managed-codex] Failed to read artifact zip: {}", e))?;
    if zip.is_empty() || zip.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!(
            "[managed-codex] Artifact zip entry count is outside allowed bounds: {}",
            zip.len()
        ));
    }
    if let Some(expected) = artifact.entry_count {
        if expected as usize != zip.len() {
            return Err(format!(
                "[managed-codex] Artifact entry count mismatch: expected {}, got {}",
                expected,
                zip.len()
            ));
        }
    }
    let file_allowlist = validate_artifact_file_allowlist(artifact)?;

    fs::create_dir_all(destination)
        .map_err(|e| format!("[managed-codex] Failed to create staging dir: {}", e))?;
    let mut unpacked_bytes = 0u64;
    for index in 0..zip.len() {
        let mut file = zip
            .by_index(index)
            .map_err(|e| format!("[managed-codex] Failed to read zip entry: {}", e))?;
        let raw_name = file.name().to_string();
        let rel_path = validate_relative_archive_path(raw_name.trim_end_matches('/'))?;
        let rel_key = archive_key_from_path(&rel_path)?;
        if file.is_dir() || raw_name.ends_with('/') {
            let prefix = format!("{}/", rel_key);
            if !file_allowlist
                .iter()
                .any(|allowed| allowed.starts_with(&prefix))
            {
                return Err(format!(
                    "[managed-codex] Directory is not in artifact fileAllowlist: {}",
                    raw_name
                ));
            }
        } else if !file_allowlist.contains(&rel_key) {
            return Err(format!(
                "[managed-codex] File is not in artifact fileAllowlist: {}",
                raw_name
            ));
        }
        if zip_entry_is_symlink(file.unix_mode()) {
            return Err(format!(
                "[managed-codex] Symlinks are not allowed in runtime artifact: {}",
                raw_name
            ));
        }
        unpacked_bytes = unpacked_bytes
            .checked_add(file.size())
            .ok_or_else(|| "[managed-codex] Artifact unpacked size overflow".to_string())?;
        if unpacked_bytes > MAX_UNPACKED_BYTES {
            return Err("[managed-codex] Artifact unpacked size exceeded limit".to_string());
        }

        let out_path = destination.join(rel_path);
        if file.is_dir() || raw_name.ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("[managed-codex] Failed to create directory: {}", e))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("[managed-codex] Failed to create parent dir: {}", e))?;
        }
        let mut out_file = File::create(&out_path)
            .map_err(|e| format!("[managed-codex] Failed to create extracted file: {}", e))?;
        let copied = std::io::copy(&mut file, &mut out_file)
            .map_err(|e| format!("[managed-codex] Failed to extract zip entry: {}", e))?;
        if copied != file.size() {
            return Err(format!(
                "[managed-codex] Zip entry size mismatch for {}: expected {}, got {}",
                raw_name,
                file.size(),
                copied
            ));
        }
        #[cfg(unix)]
        if let Some(mode) = file.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let safe_mode = mode & 0o777;
            if safe_mode != 0 {
                fs::set_permissions(&out_path, fs::Permissions::from_mode(safe_mode)).map_err(
                    |e| format!("[managed-codex] Failed to set file permissions: {}", e),
                )?;
            }
        }
    }
    if let Some(expected) = artifact.unpacked_size_bytes {
        if expected != unpacked_bytes {
            return Err(format!(
                "[managed-codex] Artifact unpacked size mismatch: expected {}, got {}",
                expected, unpacked_bytes
            ));
        }
    }

    let executable_rel = validate_executable_relative_path(&artifact.executable_relative_path)?;
    let executable = destination.join(&executable_rel);
    if !executable.is_file() {
        return Err(format!(
            "[managed-codex] Artifact did not install declared executable: {}",
            artifact.executable_relative_path
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).map_err(|e| {
            format!(
                "[managed-codex] Failed to mark Codex executable as executable: {}",
                e
            )
        })?;
    }
    Ok(executable_rel)
}

fn write_installed_json(meta: &InstalledJson) -> Result<(), String> {
    let path = installed_json_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[managed-codex] Failed to create runtime root: {}", e))?;
    }
    let bytes = serde_json::to_vec_pretty(meta).map_err(|e| {
        format!(
            "[managed-codex] Failed to serialize install metadata: {}",
            e
        )
    })?;
    let tmp = path.with_extension(format!("json.tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&tmp, bytes)
        .map_err(|e| format!("[managed-codex] Failed to write install metadata: {}", e))?;
    fs::rename(&tmp, &path)
        .map_err(|e| format!("[managed-codex] Failed to publish install metadata: {}", e))?;
    Ok(())
}

fn has_path_entry(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(format!(
            "[managed-codex] Failed to inspect path {}: {}",
            path.display(),
            err
        )),
    }
}

fn remove_path_entry(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.is_dir() && !meta.file_type().is_symlink() {
                fs::remove_dir_all(path).map_err(|e| {
                    format!(
                        "[managed-codex] Failed to remove directory {}: {}",
                        path.display(),
                        e
                    )
                })
            } else {
                fs::remove_file(path).map_err(|e| {
                    format!(
                        "[managed-codex] Failed to remove file {}: {}",
                        path.display(),
                        e
                    )
                })
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "[managed-codex] Failed to inspect path {}: {}",
            path.display(),
            err
        )),
    }
}

fn install_verified_artifact(
    platform: &str,
    artifact: &ManagedCodexArtifact,
    archive_path: &Path,
    sha256: &str,
    manifest_signature: &str,
) -> Result<(), String> {
    let root = runtime_root()?;
    fs::create_dir_all(&root)
        .map_err(|e| format!("[managed-codex] Failed to create runtime root: {}", e))?;
    let target = required_install_dir(platform)?;
    let staging = root.join(format!(
        ".staging-{}-{}-{}",
        REQUIRED_VERSION,
        platform,
        uuid::Uuid::new_v4()
    ));
    let backup = root.join(format!(
        ".backup-{}-{}-{}",
        REQUIRED_VERSION,
        platform,
        uuid::Uuid::new_v4()
    ));
    let executable_rel = match extract_managed_codex_zip(archive_path, &staging, artifact) {
        Ok(rel) => rel,
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(err);
        }
    };
    let signing = artifact
        .signing
        .as_ref()
        .ok_or_else(|| "[managed-codex] artifact signing metadata missing".to_string())?;
    let platform_signature =
        match verify_platform_signature(platform, &staging.join(&executable_rel), signing) {
            Ok(result) => result,
            Err(err) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(err);
            }
        };
    ulog_info!(
        "[managed-codex] platform signature verified runtime=codex runtimeSource=managed-provider platform={} kind={} teamId={} certificateSha256={} notarization={}",
        platform,
        platform_signature.kind,
        platform_signature.team_id.as_deref().unwrap_or("<none>"),
        platform_signature.certificate_sha256.as_deref().unwrap_or("<none>"),
        platform_signature.notarization.as_deref().unwrap_or("<none>")
    );

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[managed-codex] Failed to create install parent: {}", e))?;
    }
    if has_path_entry(&target)? {
        fs::rename(&target, &backup)
            .map_err(|e| format!("[managed-codex] Failed to stage existing runtime: {}", e))?;
    }
    if let Err(e) = fs::rename(&staging, &target) {
        if has_path_entry(&backup).unwrap_or(false) {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "[managed-codex] Failed to publish managed runtime: {}",
            e
        ));
    }
    let installed_json = InstalledJson {
        version: REQUIRED_VERSION.to_string(),
        platform: platform.to_string(),
        sha256: Some(sha256.to_string()),
        manifest_signature: Some(manifest_signature.to_string()),
        artifact_signature_verified: Some(true),
        platform_signature: Some(platform_signature),
        installed_at: Some(now_iso()),
        source_url: Some(artifact.url.clone()),
        executable_relative_path: Some(normalize_executable_relative_path_for_metadata(
            &artifact.executable_relative_path,
        )?),
    };
    if let Err(err) = write_installed_json(&installed_json) {
        let _ = remove_path_entry(&target);
        if has_path_entry(&backup).unwrap_or(false) {
            let _ = fs::rename(&backup, &target);
        }
        return Err(err);
    }
    let _ = remove_path_entry(&backup);
    Ok(())
}

fn with_runtime_install_lock<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let lock_path = runtime_root()?.join("install.lock");
    let options = FileLockOptions {
        timeout: Duration::from_secs(30),
        stale: Duration::from_secs(30 * 60),
        poll: Duration::from_millis(100),
    };
    with_file_lock_blocking(&lock_path, options, || {
        f().map_err(|e| FileLockError::Io(std::io::Error::other(e)))
    })
    .map_err(String::from)
}

fn installed_meta_has_required_security(meta: &InstalledJson, platform: &str) -> bool {
    let Some(signature) = meta.manifest_signature.as_deref() else {
        return false;
    };
    if signature.trim().is_empty() || meta.artifact_signature_verified != Some(true) {
        return false;
    }
    let Some(platform_signature) = meta.platform_signature.as_ref() else {
        return false;
    };
    match platform {
        "darwin-arm64" | "darwin-x64" => {
            platform_signature.kind == "codesign"
                && platform_signature
                    .team_id
                    .as_deref()
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false)
        }
        "win32-x64" => {
            platform_signature.kind == "authenticode"
                && platform_signature
                    .certificate_sha256
                    .as_deref()
                    .and_then(|v| normalize_sha256_hex(v).ok())
                    .is_some()
        }
        _ => false,
    }
}

fn runtime_install_state() -> ManagedCodexRuntimeInstallState {
    let checked_at = Some(now_iso());
    let Some(platform) = platform_key() else {
        return ManagedCodexRuntimeInstallState {
            status: "error".to_string(),
            required_version: Some(REQUIRED_VERSION.to_string()),
            installed_version: None,
            platform: None,
            installed_at: None,
            last_checked_at: checked_at,
            downloaded_bytes: None,
            total_bytes: None,
            progress_percent: None,
            error: Some(format!(
                "Managed Codex does not support {}-{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            )),
        };
    };

    let installed = read_installed_json();
    let binary = managed_codex_binary_path(platform);
    match (installed, binary) {
        (Some(meta), Some(_))
            if meta.version == REQUIRED_VERSION
                && meta.platform == platform
                && installed_meta_has_required_security(&meta, platform) =>
        {
            ManagedCodexRuntimeInstallState {
                status: "installed".to_string(),
                required_version: Some(REQUIRED_VERSION.to_string()),
                installed_version: Some(meta.version),
                platform: Some(platform.to_string()),
                installed_at: meta.installed_at,
                last_checked_at: checked_at,
                downloaded_bytes: None,
                total_bytes: None,
                progress_percent: None,
                error: None,
            }
        }
        (Some(meta), Some(_)) => {
            let needs_security_refresh =
                meta.platform == platform && meta.version == REQUIRED_VERSION;
            ManagedCodexRuntimeInstallState {
                status: "update-required".to_string(),
                required_version: Some(REQUIRED_VERSION.to_string()),
                installed_version: Some(meta.version),
                platform: Some(platform.to_string()),
                installed_at: meta.installed_at,
                last_checked_at: checked_at,
                downloaded_bytes: None,
                total_bytes: None,
                progress_percent: None,
                error: if needs_security_refresh {
                    Some(
                        "Managed Codex runtime requires refreshed signed install metadata"
                            .to_string(),
                    )
                } else {
                    None
                },
            }
        }
        (Some(meta), None) => ManagedCodexRuntimeInstallState {
            status: "error".to_string(),
            required_version: Some(REQUIRED_VERSION.to_string()),
            installed_version: Some(meta.version),
            platform: Some(platform.to_string()),
            installed_at: meta.installed_at,
            last_checked_at: checked_at,
            downloaded_bytes: None,
            total_bytes: None,
            progress_percent: None,
            error: Some(
                "Installed metadata exists, but the managed Codex binary is missing".to_string(),
            ),
        },
        (None, _) => ManagedCodexRuntimeInstallState {
            status: "not-installed".to_string(),
            required_version: Some(REQUIRED_VERSION.to_string()),
            installed_version: None,
            platform: Some(platform.to_string()),
            installed_at: None,
            last_checked_at: checked_at,
            downloaded_bytes: None,
            total_bytes: None,
            progress_percent: None,
            error: None,
        },
    }
}

fn managed_env() -> Result<HashMap<String, String>, String> {
    let home = codex_home()?;
    fs::create_dir_all(&home)
        .map_err(|e| format!("[managed-codex] Cannot create CODEX_HOME: {}", e))?;
    fs::create_dir_all(home.join("logs"))
        .map_err(|e| format!("[managed-codex] Cannot create CODEX_HOME/logs: {}", e))?;
    fs::create_dir_all(home.join("sessions"))
        .map_err(|e| format!("[managed-codex] Cannot create CODEX_HOME/sessions: {}", e))?;

    let allow = [
        "PATH",
        "Path",
        "HOME",
        "USERPROFILE",
        "USER",
        "USERNAME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
        "APPDATA",
        "LOCALAPPDATA",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "MYAGENTS_PROXY_INJECTED",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ];
    let mut env = HashMap::new();
    for key in allow {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.to_string(), value);
        }
    }
    env.insert("CODEX_HOME".to_string(), normalize_out_path(home));
    env.insert(
        "MYAGENTS_RUNTIME_SOURCE".to_string(),
        "managed-provider".to_string(),
    );
    Ok(env)
}

fn managed_auth_file() -> Result<PathBuf, String> {
    Ok(codex_home()?.join("auth.json"))
}

fn harden_managed_auth_file_permissions() {
    let Ok(auth_file) = managed_auth_file() else {
        return;
    };
    if !auth_file.is_file() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(err) = fs::set_permissions(&auth_file, fs::Permissions::from_mode(0o600)) {
            ulog_warn!(
                "[managed-codex] failed to harden auth file permissions path={} error={}",
                auth_file.display(),
                err
            );
        }
    }
    #[cfg(target_os = "windows")]
    {
        let Some(auth_path) = auth_file.to_str() else {
            ulog_warn!("[managed-codex] failed to harden auth file permissions: non-UTF8 path");
            return;
        };
        let encoded_path = general_purpose::STANDARD.encode(auth_path.as_bytes());
        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
$path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_path}'))
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
"#
        );
        let encoded = encode_powershell(&script);
        let output = crate::process_cmd::new(powershell_path().as_os_str())
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                &encoded,
            ])
            .output();
        match output {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                ulog_warn!(
                    "[managed-codex] failed to harden auth file ACL: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
            Err(err) => {
                ulog_warn!(
                    "[managed-codex] failed to spawn ACL hardening command: {}",
                    err
                );
            }
        }
    }
}

fn read_child_stdout(mut stdout: ChildStdout) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).trim().to_string()
    })
}

fn read_child_stderr(mut stderr: ChildStderr) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).trim().to_string()
    })
}

fn join_child_output(handle: Option<thread::JoinHandle<String>>) -> String {
    handle.and_then(|h| h.join().ok()).unwrap_or_default()
}

fn login_runtime_state() -> &'static Mutex<ManagedCodexLoginRuntimeState> {
    static STATE: OnceLock<Mutex<ManagedCodexLoginRuntimeState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ManagedCodexLoginRuntimeState::default()))
}

fn login_state_snapshot() -> ManagedCodexLoginState {
    let state = login_runtime_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ManagedCodexLoginState {
        status: state.status.clone(),
        login_url: state.login_url.clone(),
        started_at: state.started_at.clone(),
        error: state.error.clone(),
    }
}

fn extract_first_http_url(raw: &str) -> Option<String> {
    let start = raw.find("https://").or_else(|| raw.find("http://"))?;
    let rest = &raw[start..];
    let end = rest
        .char_indices()
        .find_map(|(idx, ch)| {
            if ch.is_whitespace() || matches!(ch, '"' | '\'' | '<' | '>' | ')' | ']' | '}') {
                Some(idx)
            } else {
                None
            }
        })
        .unwrap_or(rest.len());
    let url = rest[..end].trim_matches(|ch| matches!(ch, '.' | ',' | ';' | ':'));
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url.to_string())
    } else {
        None
    }
}

fn extract_authenticate_url(raw: &str) -> Option<String> {
    let lower = raw.to_lowercase();
    let marker = "navigate to this url to authenticate:";
    if let Some(marker_idx) = lower.find(marker) {
        return extract_first_http_url(&raw[marker_idx + marker.len()..]);
    }
    None
}

fn extract_login_url(raw: &str) -> Option<String> {
    if let Some(authenticate_url) = extract_authenticate_url(raw) {
        return Some(authenticate_url);
    }
    extract_first_http_url(raw).filter(|url| url.starts_with("https://"))
}

fn append_login_output(raw: &str) {
    if raw.is_empty() {
        return;
    }
    let mut state = login_runtime_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.raw_output.push_str(raw);
    if state.raw_output.chars().count() > MAX_CAPTURED_OUTPUT_CHARS * 4 {
        state.raw_output = state
            .raw_output
            .chars()
            .rev()
            .take(MAX_CAPTURED_OUTPUT_CHARS * 3)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }
    if state.login_url.is_none() {
        state.login_url = extract_login_url(&state.raw_output);
    }
    if state.login_url.is_some() && state.status == "starting" {
        state.status = "waiting".to_string();
    }
}

fn login_output_indicates_cancelled(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("login cancelled") || lower.contains("login canceled")
}

fn managed_codex_command(args: &[&str]) -> Result<std::process::Command, String> {
    let platform = platform_key().ok_or_else(|| {
        format!(
            "Managed Codex does not support {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let binary = managed_codex_binary_path(platform).ok_or_else(|| {
        format!(
            "Managed Codex runtime {} is not installed",
            REQUIRED_VERSION
        )
    })?;
    let mut cmd = crate::process_cmd::new(binary);
    cmd.env_clear();
    for (key, value) in managed_env()? {
        cmd.env(key, value);
    }
    cmd.args(args);
    crate::proxy_config::apply_to_subprocess_for_provider(&mut cmd, CODEX_PROVIDER_ID);
    Ok(cmd)
}

fn run_codex_capture(args: &[&str], timeout: Duration) -> Result<(bool, String, String), String> {
    let mut cmd = managed_codex_command(args)?;
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let start = std::time::Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("[managed-codex] Failed to spawn codex: {}", e))?;
    let mut stdout_handle = child.stdout.take().map(read_child_stdout);
    let mut stderr_handle = child.stderr.take().map(read_child_stderr);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                child
                    .wait()
                    .map_err(|e| format!("[managed-codex] Failed to wait for codex: {}", e))?;
                let stdout = join_child_output(stdout_handle.take());
                let stderr = join_child_output(stderr_handle.take());
                return Ok((status.success(), stdout, stderr));
            }
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = join_child_output(stdout_handle.take());
                let _ = join_child_output(stderr_handle.take());
                return Err("[managed-codex] Codex command timed out".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("[managed-codex] Failed to poll codex: {}", e)),
        }
    }
}

fn redact_managed_codex_output(raw: &str) -> String {
    let mut scrubbed = String::with_capacity(raw.len());
    let mut redact_next = false;
    for segment in raw.split_inclusive(|c: char| c.is_whitespace() || matches!(c, ',' | '{' | '}'))
    {
        let lower = segment.to_lowercase();
        let sensitive_key = lower.contains("access_token")
            || lower.contains("refresh_token")
            || lower.contains("id_token")
            || lower.contains("authorization")
            || lower.contains("auth_token")
            || lower.contains("api_key")
            || lower.contains("apikey");
        if sensitive_key {
            if let Some((prefix, _)) = segment.split_once(':') {
                scrubbed.push_str(prefix);
                scrubbed.push_str(":<redacted>");
            } else if let Some((prefix, _)) = segment.split_once('=') {
                scrubbed.push_str(prefix);
                scrubbed.push_str("=<redacted>");
            } else {
                scrubbed.push_str("<redacted>");
            }
            redact_next = !segment.contains(':') && !segment.contains('=');
            continue;
        }
        if redact_next {
            scrubbed.push_str("<redacted>");
            redact_next = false;
            continue;
        }
        scrubbed.push_str(segment);
    }

    let mut redacted = String::new();
    for line in scrubbed.lines() {
        if !redacted.is_empty() {
            redacted.push('\n');
        }
        for (idx, token) in line.split_whitespace().enumerate() {
            if idx > 0 {
                redacted.push(' ');
            }
            let lower = token.to_lowercase();
            if token.starts_with("http://") || token.starts_with("https://") {
                redacted.push_str("<redacted-url>");
            } else if lower == "bearer" {
                redacted.push_str("Bearer <redacted>");
            } else if token.len() >= 24
                && token
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '=' | '/'))
            {
                redacted.push_str("<redacted-token>");
            } else {
                redacted.push_str(token);
            }
        }
    }
    if redacted.chars().count() > MAX_CAPTURED_OUTPUT_CHARS {
        redacted
            .chars()
            .take(MAX_CAPTURED_OUTPUT_CHARS)
            .collect::<String>()
            + "...<truncated>"
    } else {
        redacted
    }
}

fn combine_sanitized_output(stdout: String, stderr: String) -> String {
    redact_managed_codex_output(
        &[stdout, stderr]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn login_status_auth_method_from_output(output: &str) -> Option<&'static str> {
    let lower = output.to_lowercase();
    if lower.contains("api key") || lower.contains("apikey") {
        return Some("api-key");
    }
    if lower.contains("chatgpt")
        || lower.contains("chat gpt")
        || lower.contains("subscription")
        || lower.contains("chat.openai.com")
    {
        return Some("chatgpt");
    }
    None
}

fn login_status_indicates_logged_out(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("not logged in")
        || lower.contains("not authenticated")
        || lower.contains("logged out")
}

fn auth_state_from_login_status() -> ManagedCodexAuthState {
    if runtime_install_state().status != "installed" {
        return ManagedCodexAuthState {
            status: "unknown".to_string(),
            auth_method: None,
            account_email: None,
            verified_at: None,
            error: None,
        };
    }

    harden_managed_auth_file_permissions();

    match run_codex_capture(
        &[
            "-c",
            "cli_auth_credentials_store=\"file\"",
            "login",
            "status",
        ],
        Duration::from_secs(15),
    ) {
        Ok((true, stdout, stderr)) => {
            let combined = format!("{}\n{}", stdout, stderr);
            match login_status_auth_method_from_output(&combined) {
                Some("api-key") => ManagedCodexAuthState {
                    status: "invalid".to_string(),
                    auth_method: Some("api-key".to_string()),
                    account_email: None,
                    verified_at: Some(now_iso()),
                    error: Some("Managed Codex Provider requires ChatGPT subscription login, not API key auth".to_string()),
                },
                Some("chatgpt") => ManagedCodexAuthState {
                    status: "valid".to_string(),
                    auth_method: Some("chatgpt".to_string()),
                    account_email: None,
                    verified_at: Some(now_iso()),
                    error: None,
                },
                _ => ManagedCodexAuthState {
                    status: "invalid".to_string(),
                    auth_method: None,
                    account_email: None,
                    verified_at: Some(now_iso()),
                    error: Some(
                        "Managed Codex could not verify ChatGPT subscription login from Codex status output".to_string(),
                    ),
                },
            }
        }
        Ok((false, stdout, stderr)) => ManagedCodexAuthState {
            status: if login_status_indicates_logged_out(&format!("{}\n{}", stdout, stderr)) {
                "logged-out".to_string()
            } else {
                "invalid".to_string()
            },
            auth_method: None,
            account_email: None,
            verified_at: Some(now_iso()),
            error: Some(combine_sanitized_output(stdout, stderr)),
        },
        Err(err) => ManagedCodexAuthState {
            status: "error".to_string(),
            auth_method: None,
            account_email: None,
            verified_at: Some(now_iso()),
            error: Some(err),
        },
    }
}

fn config_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("config.json"))
}

fn read_persisted_runtime_install_state() -> Option<ManagedCodexRuntimeInstallState> {
    let path = config_path().ok()?;
    let config = crate::config_io::with_config_lock(&path, false, |_| Ok(())).ok()?;
    serde_json::from_value(config.get("managedCodexRuntimeInstall")?.clone()).ok()
}

fn is_fresh_downloading_install_state(
    install: &ManagedCodexRuntimeInstallState,
    platform: &str,
) -> bool {
    if install.status != "downloading"
        || install.required_version.as_deref() != Some(REQUIRED_VERSION)
        || install.platform.as_deref() != Some(platform)
    {
        return false;
    }
    let Some(last_checked_at) = install.last_checked_at.as_deref() else {
        return false;
    };
    let Ok(last_checked) = DateTime::parse_from_rfc3339(last_checked_at) else {
        return false;
    };
    let age = Utc::now().signed_duration_since(last_checked.with_timezone(&Utc));
    age.num_seconds() <= DOWNLOADING_STATE_TTL_SECS
}

fn preserve_active_download_state(
    derived: ManagedCodexRuntimeInstallState,
) -> ManagedCodexRuntimeInstallState {
    if derived.status == "installed" {
        return derived;
    }
    let Some(platform) = platform_key() else {
        return derived;
    };
    let Some(persisted) = read_persisted_runtime_install_state() else {
        return derived;
    };
    if is_fresh_downloading_install_state(&persisted, platform) {
        return persisted;
    }
    derived
}

fn persist_status(
    install: &ManagedCodexRuntimeInstallState,
    auth: &ManagedCodexAuthState,
    _disable_provider: bool,
) -> Result<(), String> {
    let path = config_path()?;
    let install_value = serde_json::to_value(install)
        .map_err(|e| format!("[managed-codex] Cannot serialize install state: {}", e))?;
    let auth_value = serde_json::to_value(auth)
        .map_err(|e| format!("[managed-codex] Cannot serialize auth state: {}", e))?;
    crate::config_io::with_config_lock(&path, false, move |config| {
        if !config.is_object() {
            *config = json!({});
        }
        let obj = config
            .as_object_mut()
            .ok_or_else(|| "[managed-codex] config root is not an object".to_string())?;
        obj.insert("managedCodexRuntimeInstall".to_string(), install_value);
        obj.insert("managedCodexAuth".to_string(), auth_value.clone());

        let provider_status = obj
            .entry("providerVerifyStatus".to_string())
            .or_insert_with(|| json!({}));
        if !provider_status.is_object() {
            *provider_status = json!({});
        }
        let provider_obj = provider_status
            .as_object_mut()
            .ok_or_else(|| "[managed-codex] providerVerifyStatus is not an object".to_string())?;
        let auth_status = auth_value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if auth_status == "valid" {
            provider_obj.insert(
                CODEX_PROVIDER_ID.to_string(),
                json!({
                    "status": "valid",
                    "verifiedAt": auth.verified_at.clone().unwrap_or_else(now_iso),
                    "accountEmail": auth.account_email.clone(),
                }),
            );
        } else if matches!(auth_status, "invalid" | "logged-out" | "error") {
            provider_obj.insert(
                CODEX_PROVIDER_ID.to_string(),
                json!({
                    "status": "invalid",
                    "verifiedAt": auth.verified_at.clone().unwrap_or_else(now_iso),
                }),
            );
        }
        Ok(())
    })?;
    Ok(())
}

fn download_progress_percent(downloaded_bytes: u64, total_bytes: Option<u64>) -> Option<u8> {
    let total = total_bytes?;
    if total == 0 {
        return None;
    }
    Some((((downloaded_bytes as u128) * 100) / (total as u128)).min(100) as u8)
}

fn persist_download_progress(
    platform: &str,
    installed: &ManagedCodexRuntimeInstallState,
    auth: &ManagedCodexAuthState,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    let install = ManagedCodexRuntimeInstallState {
        status: "downloading".to_string(),
        required_version: Some(REQUIRED_VERSION.to_string()),
        installed_version: installed.installed_version.clone(),
        platform: Some(platform.to_string()),
        installed_at: installed.installed_at.clone(),
        last_checked_at: Some(now_iso()),
        downloaded_bytes: Some(downloaded_bytes),
        total_bytes,
        progress_percent: download_progress_percent(downloaded_bytes, total_bytes),
        error: None,
    };
    if let Err(err) = persist_status(&install, auth, false) {
        ulog_warn!(
            "[managed-codex] failed to persist download progress: {}",
            err
        );
    }
}

fn current_status_blocking() -> Result<ManagedCodexStatus, String> {
    let install = preserve_active_download_state(runtime_install_state());
    let auth = auth_state_from_login_status();
    persist_status(&install, &auth, false)?;
    let runtime_path = platform_key()
        .and_then(managed_codex_binary_path)
        .map(normalize_out_path);
    if install.status == "error" || auth.status == "error" || auth.status == "invalid" {
        ulog_warn!(
            "[managed-codex] status runtime=codex runtimeSource=managed-provider installStatus={} installedVersion={} platform={} authStatus={} authMethod={}",
            install.status,
            install.installed_version.as_deref().unwrap_or("<none>"),
            install.platform.as_deref().unwrap_or("<unsupported>"),
            auth.status,
            auth.auth_method.as_deref().unwrap_or("<none>")
        );
    } else {
        ulog_info!(
            "[managed-codex] status runtime=codex runtimeSource=managed-provider installStatus={} installedVersion={} platform={} authStatus={} authMethod={}",
            install.status,
            install.installed_version.as_deref().unwrap_or("<none>"),
            install.platform.as_deref().unwrap_or("<unsupported>"),
            auth.status,
            auth.auth_method.as_deref().unwrap_or("<none>")
        );
    }
    Ok(ManagedCodexStatus {
        runtime_install: install,
        auth,
        codex_home: codex_home().ok().map(normalize_out_path),
        runtime_path,
    })
}

#[tauri::command]
pub async fn cmd_managed_codex_status() -> Result<ManagedCodexStatus, String> {
    tauri::async_runtime::spawn_blocking(current_status_blocking)
        .await
        .map_err(|e| format!("[managed-codex] status task failed: {}", e))?
}

#[tauri::command]
pub async fn cmd_managed_codex_check_update() -> Result<ManagedCodexStatus, String> {
    cmd_managed_codex_status().await
}

#[tauri::command]
pub async fn cmd_managed_codex_download() -> Result<ManagedCodexStatus, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<ManagedCodexStatus, String> {
        with_runtime_install_lock(|| {
            let platform = platform_key().ok_or_else(|| {
                format!(
                    "Managed Codex does not support {}-{}",
                    std::env::consts::OS,
                    std::env::consts::ARCH
                )
            })?;
            ulog_info!(
                "[managed-codex] download requested runtime=codex runtimeSource=managed-provider version={} platform={} manifest={}",
                REQUIRED_VERSION,
                platform,
                manifest_url_for_platform(platform)
            );

            let installed = runtime_install_state();
            if installed.status == "installed" {
                let auth = auth_state_from_login_status();
                persist_status(&installed, &auth, false)?;
                return Ok(ManagedCodexStatus {
                    runtime_install: installed,
                    auth,
                    codex_home: codex_home().ok().map(normalize_out_path),
                    runtime_path: managed_codex_binary_path(platform).map(normalize_out_path),
                });
            }

            let downloading = ManagedCodexRuntimeInstallState {
                status: "downloading".to_string(),
                required_version: Some(REQUIRED_VERSION.to_string()),
                installed_version: installed.installed_version.clone(),
                platform: Some(platform.to_string()),
                installed_at: installed.installed_at.clone(),
                last_checked_at: Some(now_iso()),
                downloaded_bytes: Some(0),
                total_bytes: None,
                progress_percent: Some(0),
                error: None,
            };
            let current_auth = auth_state_from_login_status();
            persist_status(&downloading, &current_auth, false)?;

            let result = (|| -> Result<ManagedCodexStatus, String> {
                let client = external_http_client(Duration::from_secs(15 * 60))?;
                let (manifest, manifest_signature) = fetch_verified_manifest(&client, platform)?;
                let artifact = validate_manifest_for_platform(manifest, platform)?;

                let root = runtime_root()?;
                fs::create_dir_all(&root).map_err(|e| {
                    format!("[managed-codex] Failed to create runtime root: {}", e)
                })?;
                let tmp_dir = root.join(format!(
                    ".download-{}-{}-{}",
                    REQUIRED_VERSION,
                    platform,
                    uuid::Uuid::new_v4()
                ));
                fs::create_dir_all(&tmp_dir).map_err(|e| {
                    format!("[managed-codex] Failed to create download temp dir: {}", e)
                })?;
                let archive_path = tmp_dir.join("codex-runtime.zip");

                let cleanup_result = (|| -> Result<ManagedCodexStatus, String> {
                    let progress_auth = current_auth.clone();
                    let progress_installed = installed.clone();
                    let mut last_progress_percent: Option<u8> = None;
                    let mut last_progress_at = Instant::now() - Duration::from_secs(1);
                    let (downloaded_bytes, actual_sha) = download_to_file_with_hash(
                        &client,
                        &artifact.url,
                        &archive_path,
                        artifact.archive_size_bytes.unwrap_or(MAX_ARCHIVE_BYTES),
                        artifact.archive_size_bytes,
                        |downloaded, total| {
                            let percent = download_progress_percent(downloaded, total);
                            let should_persist = downloaded == 0
                                || percent != last_progress_percent
                                || last_progress_at.elapsed() >= Duration::from_secs(1);
                            if !should_persist {
                                return;
                            }
                            last_progress_percent = percent;
                            last_progress_at = Instant::now();
                            persist_download_progress(
                                platform,
                                &progress_installed,
                                &progress_auth,
                                downloaded,
                                total,
                            );
                        },
                    )?;
                    let expected_sha = normalize_sha256_hex(&artifact.sha256)?;
                    if let Some(expected_size) = artifact.archive_size_bytes {
                        if downloaded_bytes != expected_size {
                            return Err(format!(
                                "[managed-codex] Artifact size mismatch: expected {}, got {}",
                                expected_size, downloaded_bytes
                            ));
                        }
                    }
                    if actual_sha != expected_sha {
                        return Err(format!(
                            "[managed-codex] Artifact SHA-256 mismatch: expected {}, got {}",
                            expected_sha, actual_sha
                        ));
                    }
                    verify_minisign_file(&archive_path, &artifact.signature)?;
                    install_verified_artifact(
                        platform,
                        &artifact,
                        &archive_path,
                        &actual_sha,
                        &manifest_signature,
                    )?;
                    ulog_info!(
                        "[managed-codex] download installed runtime=codex runtimeSource=managed-provider version={} platform={} bytes={} sha256={}",
                        REQUIRED_VERSION,
                        platform,
                        downloaded_bytes,
                        actual_sha
                    );
                    current_status_blocking()
                })();

                let _ = fs::remove_dir_all(&tmp_dir);
                cleanup_result
            })();

            match result {
                Ok(status) => Ok(status),
                Err(err) => {
                    let install = ManagedCodexRuntimeInstallState {
                        status: "error".to_string(),
                        required_version: Some(REQUIRED_VERSION.to_string()),
                        installed_version: installed.installed_version,
                        platform: Some(platform.to_string()),
                        installed_at: installed.installed_at,
                        last_checked_at: Some(now_iso()),
                        downloaded_bytes: None,
                        total_bytes: None,
                        progress_percent: None,
                        error: Some(err.clone()),
                    };
                    let auth = auth_state_from_login_status();
                    persist_status(&install, &auth, false)?;
                    ulog_error!(
                        "[managed-codex] download failed runtime=codex runtimeSource=managed-provider platform={} error={}",
                        platform,
                        err
                    );
                    Err(err)
                }
            }
        })
    })
    .await
    .map_err(|e| format!("[managed-codex] download task failed: {}", e))?
}

fn read_login_stream<R>(mut stream: R)
where
    R: Read + Send + 'static,
{
    let _ = thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(read) => {
                    let chunk = String::from_utf8_lossy(&buf[..read]).to_string();
                    append_login_output(&chunk);
                }
                Err(_) => break,
            }
        }
    });
}

fn persist_login_auth_state(status: &str, error: Option<String>) {
    let auth = ManagedCodexAuthState {
        status: status.to_string(),
        auth_method: None,
        account_email: None,
        verified_at: Some(now_iso()),
        error,
    };
    if let Err(err) = persist_status(&runtime_install_state(), &auth, false) {
        ulog_warn!(
            "[managed-codex] failed to persist login auth state: {}",
            err
        );
    }
}

fn set_login_state(status: &str, error: Option<String>) {
    let mut state = login_runtime_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.status = status.to_string();
    state.error = error;
}

fn finish_login_attempt(ok: bool, output: String) {
    if ok {
        match current_status_blocking() {
            Ok(status) if status.auth.status == "valid" => {
                set_login_state("succeeded", None);
                ulog_info!(
                    "[managed-codex] login done runtime=codex runtimeSource=managed-provider authStatus={}",
                    status.auth.status
                );
            }
            Ok(status) => {
                let message = status.auth.error.unwrap_or_else(|| {
                    "Codex login finished but ChatGPT subscription auth was not verified"
                        .to_string()
                });
                set_login_state("error", Some(message));
            }
            Err(err) => {
                set_login_state("error", Some(err));
            }
        }
        return;
    }

    let message = redact_managed_codex_output(&output);
    if login_output_indicates_cancelled(&output) {
        persist_login_auth_state("logged-out", None);
        set_login_state(
            "cancelled",
            Some("登录已取消，可以重新发起登录。".to_string()),
        );
    } else {
        let error = if message.is_empty() {
            "Codex login failed".to_string()
        } else {
            message
        };
        persist_login_auth_state("error", Some(error.clone()));
        set_login_state("error", Some(error));
    }
}

#[tauri::command]
pub async fn cmd_managed_codex_login_start() -> Result<ManagedCodexLoginState, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<ManagedCodexLoginState, String> {
        let install = runtime_install_state();
        if install.status != "installed" {
            let err = "Managed Codex runtime must be installed before login".to_string();
            persist_login_auth_state("error", Some(err.clone()));
            return Err(err);
        }

        {
            let state = login_runtime_state()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if matches!(state.status.as_str(), "starting" | "waiting") {
                return Ok(ManagedCodexLoginState {
                    status: state.status.clone(),
                    login_url: state.login_url.clone(),
                    started_at: state.started_at.clone(),
                    error: state.error.clone(),
                });
            }
        }

        ulog_info!("[managed-codex] login start runtime=codex runtimeSource=managed-provider");
        let started_at = now_iso();
        {
            let mut state = login_runtime_state()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *state = ManagedCodexLoginRuntimeState {
                status: "starting".to_string(),
                login_url: None,
                started_at: Some(started_at),
                error: None,
                raw_output: String::new(),
            };
        }
        persist_login_auth_state("logging-in", None);

        let mut cmd = managed_codex_command(&[
            "-c",
            "cli_auth_credentials_store=\"file\"",
            "-c",
            "forced_login_method=\"chatgpt\"",
            "login",
        ])?;
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("[managed-codex] Failed to spawn codex login: {}", e))?;
        if let Some(stdout) = child.stdout.take() {
            read_login_stream(stdout);
        }
        if let Some(stderr) = child.stderr.take() {
            read_login_stream(stderr);
        }

        let _ = thread::spawn(move || {
            let started = Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let _ = child.wait();
                        let output = {
                            let state = login_runtime_state()
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            state.raw_output.clone()
                        };
                        finish_login_attempt(status.success(), output);
                        break;
                    }
                    Ok(None) if started.elapsed() > Duration::from_secs(5 * 60) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        persist_login_auth_state("logged-out", None);
                        set_login_state(
                            "error",
                            Some("登录超时，请重新发起 Codex 登录。".to_string()),
                        );
                        break;
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(250)),
                    Err(err) => {
                        persist_login_auth_state("error", Some(err.to_string()));
                        set_login_state(
                            "error",
                            Some(format!(
                                "[managed-codex] Failed to poll codex login: {}",
                                err
                            )),
                        );
                        break;
                    }
                }
            }
        });

        let wait_started = Instant::now();
        loop {
            let snapshot = login_state_snapshot();
            if snapshot.login_url.is_some()
                || matches!(
                    snapshot.status.as_str(),
                    "succeeded" | "error" | "cancelled"
                )
                || wait_started.elapsed() > Duration::from_secs(5)
            {
                return Ok(snapshot);
            }
            thread::sleep(Duration::from_millis(100));
        }
    })
    .await
    .map_err(|e| format!("[managed-codex] login start task failed: {}", e))?
}

#[tauri::command]
pub async fn cmd_managed_codex_login_status() -> Result<ManagedCodexLoginState, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<ManagedCodexLoginState, String> {
        Ok(login_state_snapshot())
    })
    .await
    .map_err(|e| format!("[managed-codex] login status task failed: {}", e))?
}

#[tauri::command]
pub async fn cmd_managed_codex_login() -> Result<ManagedCodexStatus, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<ManagedCodexStatus, String> {
        ulog_info!("[managed-codex] login start runtime=codex runtimeSource=managed-provider");
        let install = runtime_install_state();
        if install.status != "installed" {
            let err = "Managed Codex runtime must be installed before login".to_string();
            let auth = ManagedCodexAuthState {
                status: "error".to_string(),
                auth_method: None,
                account_email: None,
                verified_at: Some(now_iso()),
                error: Some(err.clone()),
            };
            persist_status(&install, &auth, false)?;
            return Err(err);
        }
        let (ok, stdout, stderr) = run_codex_capture(
            &[
                "-c",
                "cli_auth_credentials_store=\"file\"",
                "-c",
                "forced_login_method=\"chatgpt\"",
                "login",
            ],
            Duration::from_secs(300),
        )?;
        if !ok {
            let message = combine_sanitized_output(stdout, stderr);
            let auth = ManagedCodexAuthState {
                status: "error".to_string(),
                auth_method: None,
                account_email: None,
                verified_at: Some(now_iso()),
                error: Some(if message.is_empty() {
                    "Codex login failed".to_string()
                } else {
                    message
                }),
            };
            persist_status(&install, &auth, false)?;
            return Err(auth
                .error
                .unwrap_or_else(|| "Codex login failed".to_string()));
        }
        let status = current_status_blocking()?;
        ulog_info!(
            "[managed-codex] login done runtime=codex runtimeSource=managed-provider authStatus={}",
            status.auth.status
        );
        Ok(status)
    })
    .await
    .map_err(|e| format!("[managed-codex] login task failed: {}", e))?
}

#[tauri::command]
pub async fn cmd_managed_codex_logout() -> Result<ManagedCodexStatus, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<ManagedCodexStatus, String> {
        ulog_info!("[managed-codex] logout start runtime=codex runtimeSource=managed-provider");
        if runtime_install_state().status == "installed" {
            match run_codex_capture(
                &["-c", "cli_auth_credentials_store=\"file\"", "logout"],
                Duration::from_secs(30),
            ) {
                Ok((true, _, _)) => {}
                Ok((false, stdout, stderr)) => {
                    ulog_warn!(
                        "[managed-codex] codex logout exited non-zero stdout={} stderr={}",
                        redact_managed_codex_output(&stdout),
                        redact_managed_codex_output(&stderr)
                    );
                }
                Err(err) => {
                    ulog_warn!("[managed-codex] codex logout failed: {}", err);
                }
            }
        }
        if let Ok(auth_file) = managed_auth_file() {
            remove_path_entry(&auth_file)
                .map_err(|e| format!("[managed-codex] Cannot remove managed auth file: {}", e))?;
        }
        let install = runtime_install_state();
        let auth = ManagedCodexAuthState {
            status: "logged-out".to_string(),
            auth_method: None,
            account_email: None,
            verified_at: Some(now_iso()),
            error: None,
        };
        persist_status(&install, &auth, true)?;
        ulog_info!("[managed-codex] logout done runtime=codex runtimeSource=managed-provider");
        Ok(ManagedCodexStatus {
            runtime_install: install,
            auth,
            codex_home: codex_home().ok().map(normalize_out_path),
            runtime_path: platform_key()
                .and_then(managed_codex_binary_path)
                .map(normalize_out_path),
        })
    })
    .await
    .map_err(|e| format!("[managed-codex] logout task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_artifact(platform: &str) -> ManagedCodexArtifact {
        ManagedCodexArtifact {
            url: format!(
                "{}/{}/artifacts/managed-codex-{}-{}.zip",
                manifest_base_url(),
                platform,
                REQUIRED_VERSION,
                platform
            ),
            sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            signature: "placeholder-signature".to_string(),
            signing: Some(ManagedCodexArtifactSigning {
                kind: "codesign".to_string(),
                team_id: Some("ABCDE12345".to_string()),
                signing_identity: Some("Developer ID Application".to_string()),
                publisher: None,
                certificate_sha256: None,
                notarization: None,
            }),
            executable_relative_path: "bin/codex".to_string(),
            file_allowlist: vec![
                "package.json".to_string(),
                "bin/codex".to_string(),
                "README.md".to_string(),
            ],
            archive_type: "zip".to_string(),
            archive_size_bytes: Some(10 * 1024 * 1024),
            unpacked_size_bytes: Some(20 * 1024 * 1024),
            entry_count: Some(12),
        }
    }

    fn valid_manifest(platform: &str) -> ManagedCodexManifest {
        ManagedCodexManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            runtime_set: REQUIRED_RUNTIME_SET.to_string(),
            codex_version: REQUIRED_VERSION.to_string(),
            platform: Some(platform.to_string()),
            artifacts: HashMap::from([(platform.to_string(), valid_artifact(platform))]),
        }
    }

    #[test]
    fn platform_key_is_limited_to_v1_targets() {
        let key = platform_key();
        if cfg!(target_os = "macos") {
            assert!(matches!(key, Some("darwin-arm64") | Some("darwin-x64")));
        } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
            assert_eq!(key, Some("win32-x64"));
        } else {
            assert_eq!(key, None);
        }
    }

    #[test]
    fn runtime_state_missing_metadata_is_not_installed_or_unsupported() {
        let state = runtime_install_state();
        assert_eq!(state.required_version.as_deref(), Some(REQUIRED_VERSION));
        assert!(matches!(
            state.status.as_str(),
            "not-installed" | "error" | "installed" | "update-required"
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_base64_utf8_output_decodes_utf8_and_utf16le_shell_output() {
        let json =
            r#"{"status":"Valid","statusMessage":"已验证","subject":"CN=OpenAI","sha256":"abc"}"#;
        let encoded = general_purpose::STANDARD.encode(json.as_bytes());

        let utf8_output = format!("{}\r\n", encoded);
        assert_eq!(
            decode_powershell_base64_utf8_output(utf8_output.as_bytes(), "Authenticode")
                .expect("utf8 powershell output"),
            json
        );

        let mut utf16le_output = Vec::new();
        for unit in format!("\u{feff}{}\r\n", encoded).encode_utf16() {
            utf16le_output.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(
            decode_powershell_base64_utf8_output(&utf16le_output, "Authenticode")
                .expect("utf16le powershell output"),
            json
        );
    }

    #[test]
    fn fresh_downloading_state_is_owned_by_download_flow() {
        let state = ManagedCodexRuntimeInstallState {
            status: "downloading".to_string(),
            required_version: Some(REQUIRED_VERSION.to_string()),
            installed_version: None,
            platform: Some("darwin-arm64".to_string()),
            installed_at: None,
            last_checked_at: Some(now_iso()),
            downloaded_bytes: Some(1024),
            total_bytes: Some(4096),
            progress_percent: Some(25),
            error: None,
        };

        assert!(is_fresh_downloading_install_state(&state, "darwin-arm64"));
        assert!(!is_fresh_downloading_install_state(&state, "darwin-x64"));
    }

    #[test]
    fn stale_downloading_state_is_not_preserved() {
        let stale =
            (Utc::now() - chrono::Duration::seconds(DOWNLOADING_STATE_TTL_SECS + 1)).to_rfc3339();
        let state = ManagedCodexRuntimeInstallState {
            status: "downloading".to_string(),
            required_version: Some(REQUIRED_VERSION.to_string()),
            installed_version: None,
            platform: Some("darwin-arm64".to_string()),
            installed_at: None,
            last_checked_at: Some(stale),
            downloaded_bytes: Some(1024),
            total_bytes: Some(4096),
            progress_percent: Some(25),
            error: None,
        };

        assert!(!is_fresh_downloading_install_state(&state, "darwin-arm64"));
    }

    #[test]
    fn installed_metadata_requires_signature_verification_fields() {
        let mut meta = InstalledJson {
            version: REQUIRED_VERSION.to_string(),
            platform: "darwin-arm64".to_string(),
            sha256: Some(
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            ),
            manifest_signature: None,
            artifact_signature_verified: Some(true),
            platform_signature: Some(ManagedCodexSigningVerification {
                kind: "codesign".to_string(),
                verified_at: now_iso(),
                team_id: Some("ABCDE12345".to_string()),
                signing_identity: None,
                publisher: None,
                certificate_sha256: None,
                notarization: None,
            }),
            installed_at: Some(now_iso()),
            source_url: None,
            executable_relative_path: Some("bin/codex".to_string()),
        };
        assert!(!installed_meta_has_required_security(&meta, "darwin-arm64"));
        meta.manifest_signature = Some("manifest.sig".to_string());
        assert!(installed_meta_has_required_security(&meta, "darwin-arm64"));
        meta.artifact_signature_verified = Some(false);
        assert!(!installed_meta_has_required_security(&meta, "darwin-arm64"));
    }

    #[test]
    fn auth_status_requires_chatgpt_not_api_key() {
        assert_eq!(
            login_status_auth_method_from_output("Logged in with ChatGPT subscription"),
            Some("chatgpt")
        );
        assert_eq!(
            login_status_auth_method_from_output("Logged in with API key"),
            Some("api-key")
        );
        assert_eq!(login_status_auth_method_from_output("Logged in"), None);
        assert!(login_status_indicates_logged_out("Not logged in"));
    }

    #[test]
    fn login_output_extracts_authenticate_url() {
        let output = "Starting local login server on http://127.0.0.1:1455\n\
If your browser did not open, navigate to this URL to authenticate: https://auth.openai.com/oauth/authorize?client_id=codex&state=abc\n\
On a remote or headless machine? Use `codex login --device-auth` instead.";

        assert_eq!(
            extract_login_url(output).as_deref(),
            Some("https://auth.openai.com/oauth/authorize?client_id=codex&state=abc")
        );
    }

    #[test]
    fn login_output_ignores_local_callback_url_before_authenticate_url() {
        let output = "Starting local login server on http://127.0.0.1:1455\n";

        assert_eq!(extract_login_url(output), None);
    }

    #[test]
    fn login_output_detects_cancelled_state() {
        assert!(login_output_indicates_cancelled(
            "Error logging in: Login cancelled"
        ));
        assert!(login_output_indicates_cancelled(
            "Error logging in: Login canceled"
        ));
    }

    #[test]
    fn redaction_handles_json_and_bearer_secrets() {
        let raw = r#"{"access_token":"abc123secretvalue","refresh_token":"def456secretvalue"} Authorization: Bearer ghijklmnopqrstuvwxyz123456"#;
        let redacted = redact_managed_codex_output(raw);
        assert!(!redacted.contains("abc123secretvalue"));
        assert!(!redacted.contains("def456secretvalue"));
        assert!(!redacted.contains("ghijklmnopqrstuvwxyz123456"));
        assert!(redacted.contains("<redacted>"));
    }

    #[test]
    fn manifest_accepts_valid_locked_platform_artifact() {
        let artifact =
            validate_manifest_for_platform(valid_manifest("darwin-arm64"), "darwin-arm64")
                .expect("valid manifest");
        assert_eq!(artifact.archive_type, "zip");
        assert_eq!(artifact.executable_relative_path, "bin/codex");
    }

    #[test]
    fn manifest_requires_file_allowlist_covering_executable() {
        let mut manifest = valid_manifest("darwin-arm64");
        manifest
            .artifacts
            .get_mut("darwin-arm64")
            .unwrap()
            .file_allowlist = vec!["package.json".to_string()];
        assert!(validate_manifest_for_platform(manifest, "darwin-arm64")
            .unwrap_err()
            .contains("does not contain executable"));
    }

    #[test]
    fn extraction_rejects_files_outside_manifest_allowlist() {
        let dir = tempfile::tempdir().unwrap();
        let archive_path = dir.path().join("codex.zip");
        let file = File::create(&archive_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("bin/codex", options).unwrap();
        zip.write_all(b"codex").unwrap();
        zip.start_file("evil.dll", options).unwrap();
        zip.write_all(b"evil").unwrap();
        zip.finish().unwrap();

        let mut artifact = valid_artifact("darwin-arm64");
        artifact.file_allowlist = vec!["bin/codex".to_string()];
        artifact.entry_count = Some(2);
        let err = extract_managed_codex_zip(&archive_path, &dir.path().join("out"), &artifact)
            .unwrap_err();
        assert!(err.contains("fileAllowlist"));
    }

    #[test]
    fn manifest_rejects_wrong_version_or_missing_platform() {
        let mut wrong_version = valid_manifest("darwin-arm64");
        wrong_version.codex_version = "0.999.0".to_string();
        assert!(
            validate_manifest_for_platform(wrong_version, "darwin-arm64")
                .unwrap_err()
                .contains("codexVersion mismatch")
        );

        assert!(
            validate_manifest_for_platform(valid_manifest("darwin-arm64"), "win32-x64")
                .unwrap_err()
                .contains("platform mismatch")
        );

        let mut missing_artifact = valid_manifest("darwin-arm64");
        missing_artifact.platform = None;
        assert!(
            validate_manifest_for_platform(missing_artifact, "win32-x64")
                .unwrap_err()
                .contains("no artifact")
        );
    }

    #[test]
    fn manifest_rejects_missing_or_wrong_platform_signing() {
        let mut missing = valid_manifest("darwin-arm64");
        missing.artifacts.get_mut("darwin-arm64").unwrap().signing = None;
        assert!(validate_manifest_for_platform(missing, "darwin-arm64")
            .unwrap_err()
            .contains("signing metadata is required"));

        let mut wrong_kind = valid_manifest("darwin-arm64");
        wrong_kind
            .artifacts
            .get_mut("darwin-arm64")
            .unwrap()
            .signing
            .as_mut()
            .unwrap()
            .kind = "authenticode".to_string();
        assert!(validate_manifest_for_platform(wrong_kind, "darwin-arm64")
            .unwrap_err()
            .contains("codesign"));

        let mut windows = valid_manifest("win32-x64");
        let artifact = windows.artifacts.get_mut("win32-x64").unwrap();
        artifact.executable_relative_path = "codex.exe".to_string();
        artifact.file_allowlist = vec!["codex.exe".to_string()];
        artifact.signing = Some(ManagedCodexArtifactSigning {
            kind: "authenticode".to_string(),
            team_id: None,
            signing_identity: None,
            publisher: Some("OpenAI".to_string()),
            certificate_sha256: None,
            notarization: None,
        });
        assert!(validate_manifest_for_platform(windows, "win32-x64")
            .unwrap_err()
            .contains("certificateSha256"));
    }

    #[test]
    fn manifest_rejects_non_myagents_https_urls() {
        let mut manifest = valid_manifest("darwin-arm64");
        manifest.artifacts.get_mut("darwin-arm64").unwrap().url =
            "https://example.com/runtimes/codex/codex.zip".to_string();
        assert!(validate_manifest_for_platform(manifest, "darwin-arm64")
            .unwrap_err()
            .contains("download.myagents.io"));

        let mut manifest = valid_manifest("darwin-arm64");
        manifest.artifacts.get_mut("darwin-arm64").unwrap().url =
            "http://download.myagents.io/runtimes/codex/codex.zip".to_string();
        assert!(validate_manifest_for_platform(manifest, "darwin-arm64")
            .unwrap_err()
            .contains("HTTPS"));

        let mut manifest = valid_manifest("darwin-arm64");
        manifest.artifacts.get_mut("darwin-arm64").unwrap().url =
            "https://download.myagents.io/runtimes/codex/sets/other-runtime/darwin-arm64/artifacts/codex.zip".to_string();
        assert!(validate_manifest_for_platform(manifest, "darwin-arm64")
            .unwrap_err()
            .contains("artifact URL"));
    }

    #[test]
    fn archive_paths_reject_traversal_absolute_and_windows_reserved_names() {
        assert!(validate_relative_archive_path("bin/codex").is_ok());
        assert!(validate_relative_archive_path("../codex").is_err());
        assert!(validate_relative_archive_path("/bin/codex").is_err());
        assert!(validate_relative_archive_path("bin\\codex.exe").is_err());
        assert!(validate_relative_archive_path("CON").is_err());
        assert!(validate_relative_archive_path("bin/codex:bad").is_err());
    }

    #[test]
    fn executable_path_is_limited_to_codex_binary_names() {
        assert!(validate_executable_relative_path("bin/codex").is_ok());
        assert!(validate_executable_relative_path("bin/codex.exe").is_ok());
        assert!(validate_executable_relative_path("bin/node").is_err());
        assert!(validate_executable_relative_path("bin/codex/").is_err());
    }

    #[test]
    fn executable_metadata_path_is_slash_normalized() {
        assert_eq!(
            normalize_executable_relative_path_for_metadata(
                "vendor/x86_64-pc-windows-msvc/bin/codex.exe"
            )
            .unwrap(),
            "vendor/x86_64-pc-windows-msvc/bin/codex.exe"
        );
        assert!(normalize_executable_relative_path_for_metadata(
            "vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe"
        )
        .is_err());
    }

    #[test]
    fn installed_executable_path_accepts_legacy_windows_separators() {
        let path = validate_installed_executable_relative_path(
            "vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
        )
        .unwrap();
        assert_eq!(
            archive_key_from_path(&path).unwrap(),
            "vendor/x86_64-pc-windows-msvc/bin/codex.exe"
        );
        assert!(validate_installed_executable_relative_path("..\\codex.exe").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn path_entry_helpers_treat_broken_symlink_as_existing_entry() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let broken_link = dir.path().join("auth.json");
        symlink(dir.path().join("missing-target"), &broken_link).unwrap();

        assert!(has_path_entry(&broken_link).unwrap());
        remove_path_entry(&broken_link).unwrap();
        assert!(!has_path_entry(&broken_link).unwrap());
    }

    #[test]
    fn managed_codex_pubkey_matches_tauri_updater_pubkey() {
        let conf_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let content = fs::read_to_string(conf_path).expect("tauri.conf.json");
        let json: serde_json::Value = serde_json::from_str(&content).expect("valid tauri config");
        let updater_pubkey = json
            .get("plugins")
            .and_then(|v| v.get("updater"))
            .and_then(|v| v.get("pubkey"))
            .and_then(|v| v.as_str())
            .expect("updater pubkey");
        assert_eq!(updater_pubkey, MYAGENTS_MINISIGN_PUBKEY);
    }
}
