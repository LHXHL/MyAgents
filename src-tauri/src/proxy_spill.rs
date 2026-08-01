//! Bounded large-response spill path for `sse_proxy::proxy_http_request`.
//!
//! This module deliberately owns only proxy responses that are currently being
//! written plus failed-cleanup debt. Successfully committed body/meta pairs are
//! handed to the existing `/refs/:id` TTL lifecycle; attachments and Node-side
//! refs stay outside this budget.

use std::collections::VecDeque;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::StreamExt;
use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

pub(crate) const PROXY_STREAM_THRESHOLD_BYTES: u64 = 1024 * 1024;
pub(crate) const LOOPBACK_RESPONSE_MAX_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const EXTERNAL_RESPONSE_MAX_BYTES: u64 = 8 * 1024 * 1024;
const PROXY_SPILL_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;
const REF_COMMIT_MAX_ATTEMPTS: usize = 8;
const PREVIEW_BYTES: usize = 8 * 1024;
const ORPHAN_RETRIES_PER_SPILL: usize = 16;

#[derive(Clone, Copy)]
pub(crate) struct ResponsePolicy {
    pub(crate) max_bytes: u64,
    pub(crate) spill_threshold_bytes: u64,
    pub(crate) allow_spill: bool,
}

impl ResponsePolicy {
    pub(crate) fn for_target(is_loopback: bool) -> Self {
        if is_loopback {
            Self {
                max_bytes: LOOPBACK_RESPONSE_MAX_BYTES,
                spill_threshold_bytes: PROXY_STREAM_THRESHOLD_BYTES,
                allow_spill: true,
            }
        } else {
            Self {
                max_bytes: EXTERNAL_RESPONSE_MAX_BYTES,
                spill_threshold_bytes: EXTERNAL_RESPONSE_MAX_BYTES,
                allow_spill: false,
            }
        }
    }

    pub(crate) fn check_content_length(self, content_length: Option<u64>) -> Result<(), String> {
        if let Some(length) = content_length {
            if length > self.max_bytes {
                return Err(format!(
                    "[proxy] response Content-Length {} exceeds {} byte limit",
                    length, self.max_bytes
                ));
            }
        }
        Ok(())
    }
}

pub(crate) struct SpilledBody {
    pub(crate) ref_url: String,
    pub(crate) mimetype: String,
    pub(crate) size_bytes: u64,
}

pub(crate) enum StreamOutcome {
    Buffered(Vec<u8>),
    Spilled(SpilledBody),
    Failed(String),
}

struct OrphanGroup {
    paths: Vec<PathBuf>,
    bytes: u64,
}

#[derive(Default)]
struct BudgetState {
    active_bytes: u64,
    orphan_debt_bytes: u64,
    orphans: VecDeque<OrphanGroup>,
}

/// App-lifetime owner for proxy spill reservations and known cleanup debt.
pub(crate) struct ProxySpillManager {
    refs_dir: PathBuf,
    max_bytes: u64,
    state: Mutex<BudgetState>,
}

impl ProxySpillManager {
    pub(crate) fn new(refs_dir: PathBuf) -> Self {
        Self::with_limit(refs_dir, PROXY_SPILL_BUDGET_BYTES)
    }

    fn with_limit(refs_dir: PathBuf, max_bytes: u64) -> Self {
        Self {
            refs_dir,
            max_bytes,
            state: Mutex::new(BudgetState::default()),
        }
    }

    /// Run after the single-instance lock is acquired, before renderer
    /// requests can create new proxy spills.
    pub(crate) fn recover_startup_orphans(&self) -> Result<usize, String> {
        let entries = match std::fs::read_dir(&self.refs_dir) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(0),
            Err(error) => {
                return Err(format!(
                    "[proxy] failed to scan refs directory {}: {}",
                    self.refs_dir.display(),
                    error
                ))
            }
        };
        let names = entries
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let mut unresolved = Vec::new();
        let mut removed = 0;

        for name in entries {
            let is_body_orphan = is_ref_id(&name) && !names.contains(&format!("{name}.meta.json"));
            let is_body_part = name.strip_suffix(".part").is_some_and(is_ref_id);
            let is_meta_part = name.strip_suffix(".meta.json.part").is_some_and(is_ref_id);
            if !is_body_orphan && !is_body_part && !is_meta_part {
                continue;
            }

            let path = self.refs_dir.join(name);
            let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            match std::fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(_) => unresolved.push(OrphanGroup {
                    paths: vec![path],
                    bytes,
                }),
            }
        }

        if !unresolved.is_empty() {
            let mut state = self
                .state
                .try_lock()
                .map_err(|_| "[proxy] spill manager busy during startup recovery".to_string())?;
            for orphan in unresolved {
                state.orphan_debt_bytes = state.orphan_debt_bytes.saturating_add(orphan.bytes);
                state.orphans.push_back(orphan);
            }
        }
        Ok(removed)
    }

    async fn prepare_spill(&self) -> Result<(), String> {
        tokio::fs::create_dir_all(&self.refs_dir)
            .await
            .map_err(|error| format!("[proxy] failed to create refs directory: {error}"))?;
        self.retry_orphans().await;
        Ok(())
    }

    /// Retry only when new disk growth is requested. There is no permanent GC
    /// worker; one spill demand processes at most a small fixed number of
    /// known groups.
    async fn retry_orphans(&self) {
        let mut state = self.state.lock().await;
        let attempts = state.orphans.len().min(ORPHAN_RETRIES_PER_SPILL);
        for _ in 0..attempts {
            let Some(mut orphan) = state.orphans.pop_front() else {
                break;
            };
            let mut remaining = Vec::new();
            for path in orphan.paths {
                match tokio::fs::remove_file(&path).await {
                    Ok(()) => {}
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(_) => remaining.push(path),
                }
            }
            if remaining.is_empty() {
                state.orphan_debt_bytes = state.orphan_debt_bytes.saturating_sub(orphan.bytes);
            } else {
                orphan.paths = remaining;
                state.orphans.push_back(orphan);
            }
        }
    }

    async fn reserve(&self, additional_bytes: u64) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let used = state
            .active_bytes
            .checked_add(state.orphan_debt_bytes)
            .ok_or_else(|| "[proxy] spill budget overflow".to_string())?;
        let requested = used
            .checked_add(additional_bytes)
            .ok_or_else(|| "[proxy] spill budget overflow".to_string())?;
        if requested > self.max_bytes {
            return Err(format!(
                "[proxy] spill budget exceeded: requested {} bytes with {} of {} bytes in use",
                additional_bytes, used, self.max_bytes
            ));
        }
        state.active_bytes += additional_bytes;
        Ok(())
    }

    async fn finish(&self, reserved_bytes: u64, orphan: Option<OrphanGroup>) {
        let mut state = self.state.lock().await;
        debug_assert!(state.active_bytes >= reserved_bytes);
        state.active_bytes = state.active_bytes.saturating_sub(reserved_bytes);
        if let Some(orphan) = orphan {
            state.orphan_debt_bytes = state.orphan_debt_bytes.saturating_add(orphan.bytes);
            state.orphans.push_back(orphan);
        }
    }

    #[cfg(test)]
    async fn budget_snapshot(&self) -> (u64, u64, usize) {
        let state = self.state.lock().await;
        (
            state.active_bytes,
            state.orphan_debt_bytes,
            state.orphans.len(),
        )
    }
}

struct SpillState {
    file: Option<File>,
    id: String,
    body_part_path: PathBuf,
    body_path: PathBuf,
    meta_part_path: PathBuf,
    meta_path: PathBuf,
    cleanup_paths: Vec<PathBuf>,
    reserved_bytes: u64,
}

fn is_ref_id(value: &str) -> bool {
    (8..=32).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

async fn path_exists(path: &Path) -> Result<bool, String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "[proxy] failed to inspect spill target {}: {}",
            path.display(),
            error
        )),
    }
}

async fn any_path_exists(paths: &[&Path]) -> Result<bool, String> {
    for path in paths {
        if path_exists(path).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn init_spill(manager: &Arc<ProxySpillManager>) -> Result<SpillState, String> {
    init_spill_with(manager, || uuid::Uuid::new_v4().simple().to_string()).await
}

async fn init_spill_with<F>(
    manager: &Arc<ProxySpillManager>,
    mut next_id: F,
) -> Result<SpillState, String>
where
    F: FnMut() -> String,
{
    manager.prepare_spill().await?;
    for _ in 0..REF_COMMIT_MAX_ATTEMPTS {
        let id = next_id();
        if id.len() != 32
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("[proxy] ref id source returned a non-32-hex id".to_string());
        }
        let body_part_path = manager.refs_dir.join(format!("{id}.part"));
        let body_path = manager.refs_dir.join(&id);
        let meta_part_path = manager.refs_dir.join(format!("{id}.meta.json.part"));
        let meta_path = manager.refs_dir.join(format!("{id}.meta.json"));
        let file = match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&body_part_path)
            .await
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "[proxy] failed to claim spill part {}: {}",
                    body_part_path.display(),
                    error
                ))
            }
        };

        let target_exists = match any_path_exists(&[&body_path, &meta_part_path, &meta_path]).await
        {
            Ok(exists) => exists,
            Err(error) => {
                drop(file);
                let _ = tokio::fs::remove_file(&body_part_path).await;
                return Err(error);
            }
        };
        if target_exists {
            drop(file);
            let _ = tokio::fs::remove_file(&body_part_path).await;
            continue;
        }

        return Ok(SpillState {
            file: Some(file),
            id,
            body_part_path: body_part_path.clone(),
            body_path,
            meta_part_path,
            meta_path,
            cleanup_paths: vec![body_part_path],
            reserved_bytes: 0,
        });
    }

    Err(format!(
        "[proxy] ref commit collided {REF_COMMIT_MAX_ATTEMPTS} times"
    ))
}

async fn write_reserved(
    manager: &ProxySpillManager,
    spill: &mut SpillState,
    bytes: &[u8],
) -> Result<(), String> {
    let byte_count = bytes.len() as u64;
    manager.reserve(byte_count).await?;
    spill.reserved_bytes += byte_count;
    spill
        .file
        .as_mut()
        .expect("spill file must be open while streaming")
        .write_all(bytes)
        .await
        .map_err(|error| format!("[proxy] failed to write spill body: {error}"))
}

async fn remove_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut remaining = Vec::new();
    for path in paths {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => remaining.push(path),
        }
    }
    remaining
}

async fn fail_spill(
    manager: &ProxySpillManager,
    mut spill: SpillState,
    error: String,
) -> StreamOutcome {
    drop(spill.file.take());
    let remaining = remove_paths(spill.cleanup_paths).await;
    let orphan = (!remaining.is_empty()).then_some(OrphanGroup {
        paths: remaining,
        bytes: spill.reserved_bytes,
    });
    manager.finish(spill.reserved_bytes, orphan).await;
    StreamOutcome::Failed(error)
}

async fn finish_spill(
    manager: &ProxySpillManager,
    mut spill: SpillState,
    content_type: &str,
    request_url: &str,
    size_bytes: u64,
    preview_buf: &[u8],
) -> StreamOutcome {
    let file = spill
        .file
        .as_mut()
        .expect("spill file must remain open until commit");
    if let Err(error) = file.flush().await {
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to flush spill body: {error}"),
        )
        .await;
    }
    if let Err(error) = file.sync_data().await {
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to sync spill body: {error}"),
        )
        .await;
    }
    drop(spill.file.take());

    if let Err(error) = tokio::fs::hard_link(&spill.body_part_path, &spill.body_path).await {
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to expose spill body without clobber: {error}"),
        )
        .await;
    }
    spill.cleanup_paths.push(spill.body_path.clone());

    let mimetype = if content_type.is_empty() {
        "application/octet-stream".to_string()
    } else {
        content_type.to_string()
    };
    let expires_at_ms = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0))
    .saturating_add(60 * 60 * 1000);
    let metadata = serde_json::json!({
        "kind": "ref",
        "id": spill.id,
        "sizeBytes": size_bytes,
        "mimetype": mimetype,
        "preview": BASE64.encode(preview_buf),
        "expiresAt": expires_at_ms,
    });
    let meta_bytes = match serde_json::to_vec(&metadata) {
        Ok(bytes) => bytes,
        Err(error) => {
            return fail_spill(
                manager,
                spill,
                format!("[proxy] failed to serialize ref metadata: {error}"),
            )
            .await
        }
    };
    if let Err(error) = manager.reserve(meta_bytes.len() as u64).await {
        return fail_spill(manager, spill, error).await;
    }
    spill.reserved_bytes += meta_bytes.len() as u64;

    let mut meta_file = match OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&spill.meta_part_path)
        .await
    {
        Ok(file) => file,
        Err(error) => {
            return fail_spill(
                manager,
                spill,
                format!("[proxy] failed to claim ref metadata part: {error}"),
            )
            .await
        }
    };
    spill.cleanup_paths.push(spill.meta_part_path.clone());
    if let Err(error) = meta_file.write_all(&meta_bytes).await {
        drop(meta_file);
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to write ref metadata: {error}"),
        )
        .await;
    }
    if let Err(error) = meta_file.flush().await {
        drop(meta_file);
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to flush ref metadata: {error}"),
        )
        .await;
    }
    if let Err(error) = meta_file.sync_data().await {
        drop(meta_file);
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to sync ref metadata: {error}"),
        )
        .await;
    }
    drop(meta_file);

    if let Err(error) = tokio::fs::hard_link(&spill.meta_part_path, &spill.meta_path).await {
        return fail_spill(
            manager,
            spill,
            format!("[proxy] failed to expose ref metadata without clobber: {error}"),
        )
        .await;
    }

    // Meta is the reader-visible commit marker. Keep the final pair and remove
    // only the hard-link aliases. If unlink is blocked, the existing stale-part
    // GC can retry; aliases do not consume additional file blocks or budget.
    let _ = remove_paths(vec![
        spill.body_part_path.clone(),
        spill.meta_part_path.clone(),
    ])
    .await;
    manager.finish(spill.reserved_bytes, None).await;

    let ref_url = origin_of(request_url)
        .map(|origin| format!("{origin}/refs/{}", spill.id))
        .unwrap_or_else(|| format!("http://127.0.0.1/refs/{}", spill.id));
    StreamOutcome::Spilled(SpilledBody {
        ref_url,
        mimetype,
        size_bytes,
    })
}

pub(crate) async fn stream_response_body(
    response: reqwest::Response,
    content_type: &str,
    request_url: &str,
    policy: ResponsePolicy,
    force_spill: bool,
    manager: Arc<ProxySpillManager>,
) -> StreamOutcome {
    let threshold = policy.spill_threshold_bytes as usize;
    let mut spill = if force_spill && policy.allow_spill {
        match init_spill(&manager).await {
            Ok(spill) => Some(spill),
            Err(error) => return StreamOutcome::Failed(error),
        }
    } else {
        None
    };
    let mut buffer = Vec::new();
    let mut size_bytes = 0_u64;
    let mut preview_buf = Vec::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(chunk) => chunk,
            Err(error) => {
                let message = format!("[proxy] upstream stream error: {error}");
                return match spill {
                    Some(spill) => fail_spill(&manager, spill, message).await,
                    None => StreamOutcome::Failed(message),
                };
            }
        };
        let next_size = match size_bytes.checked_add(chunk.len() as u64) {
            Some(size) if size <= policy.max_bytes => size,
            _ => {
                let message = format!(
                    "[proxy] response body exceeds {} byte limit",
                    policy.max_bytes
                );
                return match spill {
                    Some(spill) => fail_spill(&manager, spill, message).await,
                    None => StreamOutcome::Failed(message),
                };
            }
        };
        size_bytes = next_size;
        if preview_buf.len() < PREVIEW_BYTES {
            let take = PREVIEW_BYTES
                .saturating_sub(preview_buf.len())
                .min(chunk.len());
            preview_buf.extend_from_slice(&chunk[..take]);
        }

        if let Some(active_spill) = spill.as_mut() {
            if let Err(error) = write_reserved(&manager, active_spill, &chunk).await {
                let active_spill = spill.take().expect("active spill exists");
                return fail_spill(&manager, active_spill, error).await;
            }
        } else if policy.allow_spill && buffer.len().saturating_add(chunk.len()) > threshold {
            let mut active_spill = match init_spill(&manager).await {
                Ok(spill) => spill,
                Err(error) => return StreamOutcome::Failed(error),
            };
            if let Err(error) = write_reserved(&manager, &mut active_spill, &buffer).await {
                return fail_spill(&manager, active_spill, error).await;
            }
            if let Err(error) = write_reserved(&manager, &mut active_spill, &chunk).await {
                return fail_spill(&manager, active_spill, error).await;
            }
            buffer.clear();
            buffer.shrink_to_fit();
            spill = Some(active_spill);
        } else {
            buffer.extend_from_slice(&chunk);
        }
    }

    match spill {
        Some(spill) => {
            finish_spill(
                &manager,
                spill,
                content_type,
                request_url,
                size_bytes,
                &preview_buf,
            )
            .await
        }
        None => StreamOutcome::Buffered(buffer),
    }
}

fn origin_of(absolute_url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(absolute_url).ok()?;
    let host = parsed.host_str()?;
    let host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let port = parsed
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!("{}://{host}{port}", parsed.scheme()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn response_with_body(
        body: Vec<u8>,
        declared_length: Option<u64>,
    ) -> (reqwest::Response, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind response server");
        let address = listener.local_addr().expect("response server address");
        tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            let length_header = declared_length
                .map(|length| format!("Content-Length: {length}\r\n"))
                .unwrap_or_default();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n{length_header}Connection: close\r\n\r\n"
            );
            socket
                .write_all(headers.as_bytes())
                .await
                .expect("write headers");
            socket.write_all(&body).await.expect("write body");
            let _ = socket.shutdown().await;
        });
        let url = format!("http://{address}/api/test");
        let response = crate::local_http::builder()
            .build()
            .expect("test client")
            .get(&url)
            .send()
            .await
            .expect("test response");
        (response, url)
    }

    #[tokio::test]
    async fn reservation_cap_is_atomic_across_concurrent_requests() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(root.path().to_path_buf(), 10));

        let (first, second) = tokio::join!(manager.reserve(7), manager.reserve(7));
        assert_ne!(first.is_ok(), second.is_ok());
        assert_eq!(manager.budget_snapshot().await.0, 7);
    }

    #[tokio::test]
    async fn failed_deletion_stays_debt_until_a_demand_retry_settles_it() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(root.path().to_path_buf(), 10));
        let undeletable = root.path().join("undeletable.part");
        std::fs::create_dir(&undeletable).expect("directory makes remove_file fail");

        manager.reserve(8).await.expect("reserve");
        manager
            .finish(
                8,
                Some(OrphanGroup {
                    paths: vec![undeletable.clone()],
                    bytes: 8,
                }),
            )
            .await;
        manager.retry_orphans().await;
        assert!(manager.reserve(3).await.is_err());
        std::fs::remove_dir(&undeletable).expect("remove test blocker");
        manager.retry_orphans().await;
        assert_eq!(manager.budget_snapshot().await, (0, 0, 0));
        manager.reserve(10).await.expect("debt released");
    }

    #[test]
    fn startup_recovery_only_removes_protocol_orphans() {
        let root = tempfile::tempdir().expect("temp refs");
        let complete = "1".repeat(32);
        std::fs::write(root.path().join(&complete), b"body").expect("complete body");
        std::fs::write(root.path().join(format!("{complete}.meta.json")), b"{}")
            .expect("complete meta");
        let orphan = "2".repeat(32);
        let body_part = format!("{}.part", "3".repeat(32));
        let meta_part = format!("{}.meta.json.part", "4".repeat(32));
        for name in [&orphan, &body_part, &meta_part, "unrelated-file"] {
            std::fs::write(root.path().join(name), b"x").expect("fixture");
        }
        let manager = ProxySpillManager::with_limit(root.path().to_path_buf(), 100);

        assert_eq!(manager.recover_startup_orphans().expect("recover"), 3);
        assert!(root.path().join(&complete).exists());
        assert!(root.path().join(format!("{complete}.meta.json")).exists());
        assert!(root.path().join("unrelated-file").exists());
        assert!(!root.path().join(orphan).exists());
        assert!(!root.path().join(body_part).exists());
        assert!(!root.path().join(meta_part).exists());
    }

    #[tokio::test]
    async fn claim_retries_every_existing_protocol_target_without_overwrite() {
        for suffix in ["", ".part", ".meta.json", ".meta.json.part"] {
            let root = tempfile::tempdir().expect("temp refs");
            let manager = Arc::new(ProxySpillManager::with_limit(
                root.path().to_path_buf(),
                1024,
            ));
            let collision = "a".repeat(32);
            let committed = "b".repeat(32);
            let collision_path = root.path().join(format!("{collision}{suffix}"));
            std::fs::write(&collision_path, b"existing").expect("collision fixture");
            let mut ids = vec![collision, committed.clone()].into_iter();

            let spill = init_spill_with(&manager, || ids.next().expect("candidate"))
                .await
                .expect("retry candidate");

            assert_eq!(spill.id, committed);
            assert_eq!(
                std::fs::read(&collision_path).expect("old bytes"),
                b"existing"
            );
            let _ = fail_spill(&manager, spill, "test cleanup".to_string()).await;
        }
    }

    #[test]
    fn target_policies_bound_loopback_and_external_responses() {
        let loopback = ResponsePolicy::for_target(true);
        assert_eq!(loopback.max_bytes, LOOPBACK_RESPONSE_MAX_BYTES);
        assert!(loopback.allow_spill);
        let external = ResponsePolicy::for_target(false);
        assert_eq!(external.max_bytes, EXTERNAL_RESPONSE_MAX_BYTES);
        assert!(!external.allow_spill);
        assert!(external
            .check_content_length(Some(EXTERNAL_RESPONSE_MAX_BYTES + 1))
            .is_err());
    }

    #[tokio::test]
    async fn loopback_spill_commits_a_32_hex_body_meta_pair() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(
            root.path().to_path_buf(),
            1024,
        ));
        let body = vec![7_u8; 32];
        let (response, url) = response_with_body(body.clone(), Some(body.len() as u64)).await;
        let policy = ResponsePolicy {
            max_bytes: 64,
            spill_threshold_bytes: 16,
            allow_spill: true,
        };

        let outcome = stream_response_body(
            response,
            "application/octet-stream",
            &url,
            policy,
            true,
            manager.clone(),
        )
        .await;
        let StreamOutcome::Spilled(spilled) = outcome else {
            panic!("response should spill");
        };
        let id = spilled.ref_url.rsplit('/').next().expect("ref id");
        assert!(id.len() == 32 && is_ref_id(id));
        assert_eq!(std::fs::read(root.path().join(id)).expect("body"), body);
        let metadata: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.path().join(format!("{id}.meta.json"))).expect("metadata"),
        )
        .expect("metadata json");
        assert_eq!(metadata["id"], id);
        assert_eq!(metadata["sizeBytes"], 32);
        assert!(!root.path().join(format!("{id}.part")).exists());
        assert!(!root.path().join(format!("{id}.meta.json.part")).exists());
        assert_eq!(manager.budget_snapshot().await, (0, 0, 0));
    }

    #[tokio::test]
    async fn external_response_stays_bounded_in_memory_and_never_creates_a_ref() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(
            root.path().to_path_buf(),
            1024,
        ));
        let body = vec![8_u8; 32];
        let (response, url) = response_with_body(body.clone(), None).await;
        let policy = ResponsePolicy {
            max_bytes: 64,
            spill_threshold_bytes: 16,
            allow_spill: false,
        };

        let outcome = stream_response_body(
            response,
            "application/octet-stream",
            &url,
            policy,
            false,
            manager,
        )
        .await;

        let StreamOutcome::Buffered(buffered) = outcome else {
            panic!("external response must remain buffered");
        };
        assert_eq!(buffered, body);
        assert!(std::fs::read_dir(root.path())
            .expect("refs dir")
            .next()
            .is_none());
    }

    #[tokio::test]
    async fn actual_stream_size_is_capped_when_content_length_is_absent() {
        let root = tempfile::tempdir().expect("temp refs");
        let manager = Arc::new(ProxySpillManager::with_limit(
            root.path().to_path_buf(),
            1024,
        ));
        let (response, url) = response_with_body(vec![9_u8; 17], None).await;
        let policy = ResponsePolicy {
            max_bytes: 16,
            spill_threshold_bytes: 8,
            allow_spill: true,
        };

        let outcome = stream_response_body(
            response,
            "application/octet-stream",
            &url,
            policy,
            false,
            manager.clone(),
        )
        .await;

        assert!(matches!(outcome, StreamOutcome::Failed(_)));
        assert_eq!(manager.budget_snapshot().await, (0, 0, 0));
        assert!(std::fs::read_dir(root.path())
            .expect("refs dir")
            .next()
            .is_none());
    }

    #[test]
    fn origin_uses_the_loopback_request_authority() {
        assert_eq!(
            origin_of("http://127.0.0.1:31415/api/test?x=1"),
            Some("http://127.0.0.1:31415".to_string())
        );
        assert_eq!(
            origin_of("http://[::1]:31415/api/test"),
            Some("http://[::1]:31415".to_string())
        );
    }
}
