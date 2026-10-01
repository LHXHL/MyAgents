// Session Router — maps IM peers to Sidecar instances
// Handles: peer→Sidecar mapping, crash recovery, idle session collection, and HTTP client factory.
//
// Concurrency model:
//   Global semaphore + per-peer locks live OUTSIDE the router (in the processing loop).
//   The router lock is only held briefly for data operations (ensure_sidecar, record_response).
//   SSE streaming to Sidecars happens WITHOUT the router lock, enabling true per-peer parallelism.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::{ulog_info, ulog_warn};
use reqwest::Client;
use tauri::{AppHandle, Runtime};

use crate::sidecar::{
    ensure_session_sidecar_with_runtime_identity_override_lifecycle, release_session_sidecar,
    resolve_session_runtime_identity_full, ManagedSidecarManager, SidecarOwner,
};

use super::types::{ImMessage, ImSourceType, PeerSession};

/// Max concurrent AI requests across all peers
pub const GLOBAL_CONCURRENCY: usize = 8;
/// Idle session timeout (30 minutes)
const IDLE_TIMEOUT_SECS: u64 = 1800;
/// Max Sidecar restart attempts (reserved for future reconnect logic)
#[allow(dead_code)]
const MAX_RESTART_ATTEMPTS: u32 = 5;
/// Initial restart backoff (seconds)
#[allow(dead_code)]
const INITIAL_RESTART_BACKOFF_SECS: u64 = 1;
/// Max restart backoff (seconds)
#[allow(dead_code)]
const MAX_RESTART_BACKOFF_SECS: u64 = 30;
/// HTTP timeout for Sidecar API calls
const SIDECAR_HTTP_TIMEOUT_SECS: u64 = 300;

fn short_id(s: &str) -> String {
    s.chars().take(8).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PeerMetadataDisposition {
    Indexed,
    BirthPending,
    RotateStale,
}

/// A source Session may be frozen only when SessionStore currently owns its
/// metadata. Missing birth-pending and stale Router bindings have no durable
/// source to preserve and must be replaced without resurrecting the old ID.
pub(crate) fn peer_binding_source_requires_freeze(
    disposition: Option<PeerMetadataDisposition>,
) -> bool {
    matches!(disposition, Some(PeerMetadataDisposition::Indexed))
}

fn reconcile_peer_metadata_with_lookup<F>(
    restored_metadata_birth_pending: bool,
    restored_metadata_indexed: bool,
    session_id: &str,
    metadata_exists: F,
) -> PeerMetadataDisposition
where
    F: FnOnce(&str) -> bool,
{
    if metadata_exists(session_id) {
        return PeerMetadataDisposition::Indexed;
    }
    if restored_metadata_birth_pending && !restored_metadata_indexed {
        return PeerMetadataDisposition::BirthPending;
    }
    PeerMetadataDisposition::RotateStale
}

/// Result of Phase 1 of ensure_sidecar: either the sidecar is healthy, or we need to create one.
pub enum EnsureSidecarPrep {
    /// Existing sidecar is healthy — return immediately with port.
    Healthy(u16),
    /// Need to create/restart sidecar — extracted info for Phase 2.
    NeedCreate(EnsureSidecarInfo),
}

/// Info extracted from router state needed to create a sidecar (Phase 2).
/// Cloned out so the router lock can be released during the blocking create.
#[derive(Clone)]
pub struct EnsureSidecarInfo {
    pub session_key: String,
    pub session_id: String,
    pub workspace: PathBuf,
    pub prev_count: u32,
    pub metadata_birth_pending: bool,
    pub metadata_indexed: bool,
    pub runtime_override: Option<String>,
    pub runtime_source_override: Option<String>,
}

/// Transient proof for one peer binding mutation. It is never persisted as a
/// second state owner: the Router remains authoritative, while this snapshot
/// only permits exact rollback if the durable projection fails.
#[derive(Debug, Clone)]
pub struct PeerBindingTransition {
    session_key: String,
    prior: Option<PeerSession>,
    target_session_id: String,
}

impl PeerBindingTransition {
    pub fn old_session_id(&self) -> Option<&str> {
        self.prior.as_ref().map(|peer| peer.session_id.as_str())
    }

    pub fn target_session_id(&self) -> &str {
        &self.target_session_id
    }
}

impl EnsureSidecarInfo {
    pub fn with_runtime_identity(
        mut self,
        runtime_override: Option<&str>,
        runtime_source_override: Option<&str>,
    ) -> Self {
        self.runtime_override = runtime_override.map(str::to_string);
        self.runtime_source_override = runtime_source_override.map(str::to_string);
        self
    }
}

/// Error from Sidecar routing — distinguishes bufferable vs non-bufferable failures.
#[derive(Debug)]
pub enum RouteError {
    /// Sidecar setup failed (ensure_sidecar error)
    Setup(String),
    /// HTTP request failed (connection error, timeout) — message should be buffered
    Unavailable(String),
    /// Sidecar returned non-success HTTP status
    Response(u16, String),
}

impl RouteError {
    pub fn should_buffer(&self) -> bool {
        matches!(self, Self::Unavailable(_))
    }
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Setup(e) => write!(f, "{}", e),
            Self::Unavailable(e) => write!(f, "Sidecar unavailable: {}", e),
            Self::Response(status, body) => write!(f, "Sidecar returned {}: {}", status, body),
        }
    }
}

pub struct SessionRouter {
    peer_sessions: HashMap<String, PeerSession>,
    default_workspace: PathBuf,
    http_client: Client,
    /// Agent ID (if this router belongs to an Agent channel). None for legacy IM bots.
    agent_id: Option<String>,
}

/// Private peer target selected for heartbeat/cron delivery.
#[derive(Debug, Clone)]
pub struct HeartbeatPeerTarget {
    pub session_key: String,
    pub source: String,
    pub source_id: String,
    pub last_active: Instant,
}

/// Create an HTTP client configured for local Sidecar communication.
pub fn create_sidecar_http_client() -> Client {
    crate::local_http::json_client(Duration::from_secs(SIDECAR_HTTP_TIMEOUT_SECS))
}

/// HTTP client for SSE streaming (read_timeout as idle timeout, not overall timeout).
/// No overall timeout — the stream stays open until the turn completes.
/// read_timeout acts as idle timeout: if no bytes arrive within 300s, the connection drops.
/// Heartbeat from Sidecar is 15s; 300s margin covers cold-start SDK initialization.
pub fn create_sidecar_stream_client() -> Client {
    crate::local_http::sse_client()
}

impl SessionRouter {
    pub fn new(default_workspace: PathBuf) -> Self {
        Self {
            peer_sessions: HashMap::new(),
            default_workspace,
            http_client: create_sidecar_http_client(),
            agent_id: None,
        }
    }

    /// Create a router for an Agent channel (uses `agent:` session key format).
    pub fn new_for_agent(default_workspace: PathBuf, agent_id: String) -> Self {
        Self {
            peer_sessions: HashMap::new(),
            default_workspace,
            http_client: create_sidecar_http_client(),
            agent_id: Some(agent_id),
        }
    }

    /// Generate session key from IM message.
    /// If agent_id is set, uses new format: agent:{agentId}:{channelType}:{type}:{id}
    /// Otherwise falls back to legacy: im:{platform}:{type}:{id}
    pub fn session_key(&self, msg: &ImMessage) -> String {
        if let Some(ref agent_id) = self.agent_id {
            let source = match msg.source_type {
                ImSourceType::Private => "private",
                ImSourceType::Group => "group",
            };
            format!(
                "agent:{}:{}:{}:{}",
                agent_id, msg.platform, source, msg.chat_id
            )
        } else {
            msg.session_key()
        }
    }

    fn display_name_from_message(msg: &ImMessage) -> Option<String> {
        match msg.source_type {
            ImSourceType::Private => msg
                .sender_name
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| Some(msg.sender_id.clone())),
            ImSourceType::Group => msg
                .hint_group_name
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| Some(msg.chat_id.clone())),
        }
    }

    /// Update human-readable peer metadata from the latest inbound message.
    /// Routing remains keyed by `session_key`; these fields only make status
    /// snapshots explicit enough for desktop handover UI to target a specific
    /// private/group chat instead of the whole channel.
    pub fn update_peer_metadata_from_message(&mut self, session_key: &str, msg: &ImMessage) {
        if let Some(ps) = self.peer_sessions.get_mut(session_key) {
            ps.source_display_name = Self::display_name_from_message(msg);
            ps.last_sender_name = msg
                .sender_name
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
        }
    }

    /// Ensure a Sidecar is running for the given session key.
    /// Returns `(port, is_new_sidecar)` — `is_new_sidecar` is true when a new Sidecar was created
    /// (caller should sync AI config like model/MCP after creation).
    ///
    /// IMPORTANT: This method holds the router lock for the ENTIRE duration including
    /// the blocking `ensure_session_sidecar` call (up to 5 minutes). For callers that can
    /// release the lock between phases, use the 3-phase split instead:
    /// `prepare_ensure_sidecar` → `create_sidecar_blocking` → `commit_ensure_sidecar`.
    /// This single-lock method is kept for the message processing loop where per-peer locks
    /// already serialize same-peer access.
    pub async fn ensure_sidecar<R: Runtime>(
        &mut self,
        session_key: &str,
        app_handle: &AppHandle<R>,
        manager: &ManagedSidecarManager,
    ) -> Result<(u16, bool), String> {
        self.ensure_sidecar_with_runtime_identity(session_key, app_handle, manager, None, None)
            .await
    }

    pub async fn ensure_sidecar_with_runtime_identity<R: Runtime>(
        &mut self,
        session_key: &str,
        app_handle: &AppHandle<R>,
        manager: &ManagedSidecarManager,
        runtime_override: Option<&str>,
        runtime_source_override: Option<&str>,
    ) -> Result<(u16, bool), String> {
        // Phase 1: Check existing healthy sidecar (brief)
        let prep = self.prepare_ensure_sidecar(session_key, manager).await;
        if let EnsureSidecarPrep::Healthy(port) = prep {
            return Ok((port, false));
        }

        // Phase 2: Create sidecar (blocking — holds lock the entire time)
        let info = match prep {
            EnsureSidecarPrep::NeedCreate(info) => {
                info.with_runtime_identity(runtime_override, runtime_source_override)
            }
            EnsureSidecarPrep::Healthy(_) => unreachable!(),
        };
        // The manager owns process-birth disposition; existing Session metadata
        // supplies execution configuration for both new and reused processes.
        let (port, is_new) =
            Self::create_sidecar_blocking(info.clone(), app_handle, manager).await?;

        // Phase 3: Write result back
        self.commit_ensure_sidecar(session_key, &info, port);

        Ok((port, is_new))
    }

    // ---- Split ensure_sidecar into 3 phases for lock-free blocking ----

    /// Phase 1: Check if sidecar is healthy, or extract info needed to create one.
    /// If unhealthy, zeros `sidecar_port` to prevent idle-collector from killing
    /// the sidecar that Phase 2 will create (TOCTOU guard).
    /// Holds the lock briefly (health check ~4.5s worst case).
    pub async fn prepare_ensure_sidecar(
        &mut self,
        session_key: &str,
        manager: &ManagedSidecarManager,
    ) -> EnsureSidecarPrep {
        if let Some(session_id) = self
            .peer_sessions
            .get(session_key)
            .map(|peer| peer.session_id.clone())
        {
            let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[&session_id]).await;
            let has_live_owner = manager
                .lock()
                .is_ok_and(|state| state.session_has_owners(&session_id));
            match crate::sidecar::has_persisted_session_owner(&session_id).await {
                Ok(false) if !has_live_owner => {
                    self.reconcile_peer_session_metadata_before_use(session_key, manager)
                        .await
                }
                Ok(_) => {}
                Err(error) => ulog_warn!(
                    "[im-router] Skipping Session identity reconciliation for {}: {}",
                    session_id,
                    error
                ),
            }
        }

        // Check existing peer session
        if let Some(ps) = self.peer_sessions.get(session_key) {
            if ps.sidecar_port > 0 {
                if self.check_sidecar_health(ps.sidecar_port).await {
                    return EnsureSidecarPrep::Healthy(ps.sidecar_port);
                }
                ulog_warn!(
                    "[im-router] Sidecar on port {} unhealthy for {}",
                    ps.sidecar_port,
                    session_key
                );
            }
        }
        // Zero the port BEFORE releasing the lock. This prevents idle-collector
        // from calling release_session_sidecar on a sidecar that Phase 2 is about
        // to create (idle-collector skips entries with port=0).
        if let Some(ps) = self.peer_sessions.get_mut(session_key) {
            ps.sidecar_port = 0;
        }

        let peer_session = self.peer_sessions.get(session_key);
        let prev_count = peer_session.map(|ps| ps.message_count).unwrap_or(0);
        let metadata_birth_pending = peer_session
            .map(|ps| ps.metadata_birth_pending)
            .unwrap_or(true);
        let metadata_indexed = peer_session.map(|ps| ps.metadata_indexed).unwrap_or(false);

        let workspace = self
            .peer_sessions
            .get(session_key)
            .map(|ps| ps.workspace_path.clone())
            .unwrap_or_else(|| self.default_workspace.clone());

        let session_id = self
            .peer_sessions
            .get(session_key)
            .map(|ps| ps.session_id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        EnsureSidecarPrep::NeedCreate(EnsureSidecarInfo {
            session_key: session_key.to_string(),
            session_id,
            workspace,
            prev_count,
            metadata_birth_pending,
            metadata_indexed,
            runtime_override: None,
            runtime_source_override: None,
        })
    }

    pub(crate) fn classify_peer_session_metadata_for_binding_rotation_with_lookup<F>(
        &self,
        session_key: &str,
        metadata_exists: F,
    ) -> Option<PeerMetadataDisposition>
    where
        F: FnOnce(&str) -> bool,
    {
        let peer = self.peer_sessions.get(session_key)?;
        Some(reconcile_peer_metadata_with_lookup(
            peer.metadata_birth_pending,
            peer.metadata_indexed,
            &peer.session_id,
            metadata_exists,
        ))
    }

    /// Classify the source binding against SessionStore without mutating the
    /// Router or Sidecar owners. Binding rotations need this read before freeze
    /// while preserving their exact stage/persist/release rollback boundary.
    pub(crate) fn classify_peer_session_metadata_for_binding_rotation(
        &self,
        session_key: &str,
    ) -> Option<PeerMetadataDisposition> {
        self.classify_peer_session_metadata_for_binding_rotation_with_lookup(session_key, |sid| {
            resolve_session_runtime_identity_full(sid).is_some()
        })
    }

    async fn reconcile_peer_session_metadata_before_use(
        &mut self,
        session_key: &str,
        manager: &ManagedSidecarManager,
    ) {
        let Some(snapshot) = self.peer_sessions.get(session_key) else {
            return;
        };

        let disposition = self
            .classify_peer_session_metadata_for_binding_rotation(session_key)
            .expect("peer binding exists after snapshot lookup");

        match disposition {
            PeerMetadataDisposition::Indexed => {
                if let Some(ps) = self.peer_sessions.get_mut(session_key) {
                    ps.metadata_birth_pending = false;
                    ps.metadata_indexed = true;
                }
            }
            PeerMetadataDisposition::BirthPending => {
                if let Some(ps) = self.peer_sessions.get_mut(session_key) {
                    ps.metadata_birth_pending = true;
                    ps.metadata_indexed = false;
                }
            }
            PeerMetadataDisposition::RotateStale => {
                let old_session_id = snapshot.session_id.clone();
                let new_session_id = uuid::Uuid::new_v4().to_string();
                let owner = SidecarOwner::Agent(session_key.to_string());
                if let Err(e) = release_session_sidecar(manager, &old_session_id, &owner).await {
                    ulog_warn!(
                        "[im-router] Failed to release stale unindexed peer session {} for {}: {}",
                        short_id(&old_session_id),
                        session_key,
                        e
                    );
                }
                if let Some(ps) = self.peer_sessions.get_mut(session_key) {
                    ps.session_id = new_session_id.clone();
                    ps.sidecar_port = 0;
                    ps.message_count = 0;
                    ps.metadata_birth_pending = true;
                    ps.metadata_indexed = false;
                    ps.last_active = Instant::now();
                }
                ulog_info!(
                    "[im-router] Rotated stale unindexed peer session before use: {} -> {} (session_key={})",
                    short_id(&old_session_id),
                    short_id(&new_session_id),
                    session_key
                );
            }
        }
    }

    /// Phase 2: Create the sidecar (blocking, up to 5 minutes). Does NOT hold the router lock.
    /// This is a static method — callers invoke it after releasing the lock.
    ///
    /// Returns `(port, is_new)`. `is_new` is the AUTHORITATIVE value from
    /// `ensure_session_sidecar` (decided inside the manager lock): false when the
    /// manager reused an already-healthy Sidecar (adding only the Agent owner),
    /// true when it spawned one. Execution configuration remains Session-owned.
    pub async fn create_sidecar_blocking<R: Runtime>(
        info: EnsureSidecarInfo,
        app_handle: &AppHandle<R>,
        manager: &ManagedSidecarManager,
    ) -> Result<(u16, bool), String> {
        let owner = SidecarOwner::Agent(info.session_key.clone());
        let app_clone = app_handle.clone();
        let manager_clone = Arc::clone(manager);
        let sid = info.session_id.clone();
        let ws = info.workspace.clone();
        let runtime_override = info.runtime_override.clone();
        let runtime_source_override = info.runtime_source_override.clone();

        let result = ensure_session_sidecar_with_runtime_identity_override_lifecycle(
            app_clone,
            manager_clone,
            sid,
            ws,
            owner,
            runtime_override,
            runtime_source_override,
        )
        .await
        .map_err(|e| format!("Failed to ensure Sidecar: {}", e))?;

        ulog_info!(
            "[im-router] Sidecar ready for {} on port {} (workspace={}, is_new={})",
            info.session_key,
            result.port,
            info.workspace.display(),
            result.is_new,
        );

        Ok((result.port, result.is_new))
    }

    /// Phase 3: Write the new sidecar port back into the peer session map.
    /// Holds the lock briefly.
    pub fn commit_ensure_sidecar(
        &mut self,
        session_key: &str,
        info: &EnsureSidecarInfo,
        port: u16,
    ) {
        let (source_type, source_id) = parse_session_key(session_key);
        self.peer_sessions.insert(
            session_key.to_string(),
            PeerSession {
                session_key: session_key.to_string(),
                session_id: info.session_id.clone(),
                sidecar_port: port,
                workspace_path: info.workspace.clone(),
                source_type,
                source_id,
                source_display_name: None,
                last_sender_name: None,
                message_count: info.prev_count,
                metadata_birth_pending: info.metadata_birth_pending,
                metadata_indexed: info.metadata_indexed,
                last_active: Instant::now(),
            },
        );
    }

    /// Get a reference to a peer session by session_key.
    pub fn default_workspace_path(&self) -> PathBuf {
        self.default_workspace.clone()
    }

    pub fn get_peer_session(&self, session_key: &str) -> Option<&PeerSession> {
        self.peer_sessions.get(session_key)
    }

    /// Record a successful response only for the binding that admitted the
    /// turn. `/new` may rotate this stable peer key while A is still finishing;
    /// that stale terminal must not materialize or increment the pending B.
    pub fn record_response_if_bound(
        &mut self,
        session_key: &str,
        admitted_session_id: &str,
    ) -> bool {
        let Some(peer) = self.peer_sessions.get_mut(session_key) else {
            return false;
        };
        if peer.session_id != admitted_session_id {
            return false;
        }
        peer.message_count += 1;
        peer.metadata_birth_pending = false;
        peer.metadata_indexed = true;
        peer.last_active = Instant::now();
        true
    }

    /// Check if Sidecar is healthy via HTTP.
    /// Uses retry with increasing timeout to avoid false positives when Bun is
    /// temporarily busy (MCP tool execution, heavy computation, GC pause).
    async fn check_sidecar_health(&self, port: u16) -> bool {
        let url = format!("http://127.0.0.1:{}/health", port);
        // Retry once with longer timeout before declaring unhealthy.
        // First attempt: 1.5s (handles normal load).
        // Retry: 3s (handles heavy MCP processing / GC pauses).
        for timeout_ms in [1500u64, 3000] {
            match self
                .http_client
                .get(&url)
                .timeout(Duration::from_millis(timeout_ms))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => return true,
                _ => {}
            }
        }
        false
    }

    /// Collect idle sessions that haven't been active for IDLE_TIMEOUT_SECS.
    /// Releases the Sidecar process but preserves the PeerSession (with port=0)
    /// so that the stable session_id can be reused for resume on next message.
    /// Returns the list of session_keys collected so callers can cancel any
    /// associated ImEventConsumer tasks (Pattern C lifecycle hook).
    pub async fn collect_idle_sessions(&mut self, manager: &ManagedSidecarManager) -> Vec<String> {
        let now = Instant::now();
        let idle_keys: Vec<String> = self
            .peer_sessions
            .iter()
            .filter(|(_, ps)| {
                ps.sidecar_port > 0
                    && now.duration_since(ps.last_active).as_secs() >= IDLE_TIMEOUT_SECS
            })
            .map(|(k, _)| k.clone())
            .collect();

        for key in &idle_keys {
            if let Some(ps) = self.peer_sessions.get_mut(key) {
                ulog_info!(
                    "[im-router] Collecting idle session {} (inactive for {}s, preserving session_id={})",
                    key,
                    now.duration_since(ps.last_active).as_secs(),
                    &ps.session_id,
                );
                let owner = SidecarOwner::Agent(key.clone());
                let _ = release_session_sidecar(manager, &ps.session_id, &owner).await;
                ps.sidecar_port = 0; // Sidecar released, but session preserved for resume
            }
        }
        idle_keys
    }

    /// Get workspace path for a peer session (for attachment file saving).
    pub fn peer_session_workspace(&self, session_key: &str) -> Option<PathBuf> {
        self.peer_sessions
            .get(session_key)
            .map(|ps| ps.workspace_path.clone())
    }

    /// Get the default workspace path.
    pub fn default_workspace(&self) -> &PathBuf {
        &self.default_workspace
    }

    /// Find any active session with a running Sidecar.
    /// Returns (port, source_string, source_id) for cron tasks etc.
    /// Picks the most recently active session for deterministic behavior.
    pub fn find_any_active_session(&self) -> Option<(u16, String, String)> {
        self.peer_sessions
            .values()
            .filter(|ps| ps.sidecar_port > 0)
            .max_by_key(|ps| ps.last_active)
            .map(|ps| {
                (
                    ps.sidecar_port,
                    session_key_to_source_str(&ps.session_key),
                    ps.source_id.clone(),
                )
            })
    }

    /// Find any peer session (regardless of sidecar status).
    /// Returns (session_key, source_string, source_id).
    /// Used by heartbeat/cron to find a session to wake up even if sidecar was idle-collected.
    /// Picks the most recently active session for deterministic behavior.
    pub fn find_any_peer_session(&self) -> Option<(String, String, String)> {
        self.latest_private_peer_session_target()
            .map(|target| (target.session_key, target.source, target.source_id))
    }

    /// Return a private peer target by exact session key.
    /// Explicit Agent-level heartbeat targets use this and never fallback to
    /// another peer if it returns None.
    pub fn get_private_peer_session_target(
        &self,
        session_key: &str,
    ) -> Option<HeartbeatPeerTarget> {
        self.peer_sessions
            .get(session_key)
            .filter(|ps| ps.source_type == ImSourceType::Private)
            .map(peer_to_heartbeat_target)
    }

    /// Return the latest private peer target, ignoring sidecar liveness.
    /// Used only by legacy per-bot wakes that have no explicit Agent target.
    pub fn latest_private_peer_session_target(&self) -> Option<HeartbeatPeerTarget> {
        self.peer_sessions
            .values()
            .filter(|ps| ps.source_type == ImSourceType::Private)
            .max_by_key(|ps| ps.last_active)
            .map(peer_to_heartbeat_target)
    }

    pub fn active_private_peer_session_port(&self, session_key: &str) -> Option<u16> {
        self.peer_sessions
            .get(session_key)
            .filter(|ps| ps.source_type == ImSourceType::Private)
            .filter(|ps| ps.sidecar_port > 0)
            .map(|ps| ps.sidecar_port)
    }

    pub fn latest_active_private_peer_session_port(&self) -> Option<u16> {
        self.peer_sessions
            .values()
            .filter(|ps| ps.source_type == ImSourceType::Private)
            .filter(|ps| ps.sidecar_port > 0)
            .max_by_key(|ps| ps.last_active)
            .map(|ps| ps.sidecar_port)
    }

    pub fn peer_source_type(&self, session_key: &str) -> Option<ImSourceType> {
        self.peer_sessions
            .get(session_key)
            .map(|ps| ps.source_type.clone())
    }

    /// Touch session activity timestamp to prevent idle collection.
    /// Called after heartbeat successfully uses a sidecar.
    pub fn touch_session_activity(&mut self, session_key: &str) {
        if let Some(ps) = self.peer_sessions.get_mut(session_key) {
            ps.last_active = Instant::now();
        }
    }

    /// True only while this peer binding points at a Rust-minted session_id that
    /// has not yet been accepted by the sidecar as a real MyAgents session.
    pub fn metadata_birth_pending(&self, session_key: &str) -> bool {
        self.peer_sessions
            .get(session_key)
            .map(|ps| ps.metadata_birth_pending)
            .unwrap_or(false)
    }

    /// The sidecar accepted the first enqueue for this exact peer-session
    /// incarnation. The expected id fences delayed ACKs from an older binding:
    /// `session_key` is stable across runtime/model rotations, `session_id` is not.
    pub fn mark_metadata_birth_consumed_if_session(
        &mut self,
        session_key: &str,
        expected_session_id: &str,
    ) -> bool {
        let Some(ps) = self.peer_sessions.get_mut(session_key) else {
            return false;
        };
        if ps.session_id != expected_session_id || !ps.metadata_birth_pending {
            return false;
        }
        ps.metadata_birth_pending = false;
        ps.metadata_indexed = true;
        true
    }

    // ===== Surface handover helpers (PRD 0.2.14) =====

    /// True if a peer_session entry exists for the given session_key.
    /// Used by `cmd_session_new_with_surface_migration` to find which channel
    /// owns a session_key without exposing the full HashMap.
    pub fn has_peer_session(&self, session_key: &str) -> bool {
        self.peer_sessions.contains_key(session_key)
    }

    /// Snapshot a peer_session for read-only inspection (e.g. capture
    /// `prior_session_id` before we overwrite the entry during handover).
    pub fn peer_session_snapshot(&self, session_key: &str) -> Option<PeerSession> {
        self.peer_sessions.get(session_key).cloned()
    }

    /// Insert-or-replace a peer_session — used by handover to redirect a
    /// channel binding to a new session_id. Caller is responsible for
    /// SidecarOwner accounting (release old, ensure new) — this method only
    /// touches the router's HashMap.
    pub fn upsert_peer_session(&mut self, ps: PeerSession) {
        self.peer_sessions.insert(ps.session_key.clone(), ps);
    }

    /// Stage the owner-scoped `/new` binding. The old Sidecar identity is not
    /// touched; its Agent owner is released only after the caller durably
    /// projects this pending peer state.
    pub fn stage_new_session_binding(&mut self, session_key: &str) -> PeerBindingTransition {
        let prior = self.peer_sessions.get(session_key).cloned();
        let target_session_id = uuid::Uuid::new_v4().to_string();
        let next = match prior.as_ref() {
            Some(peer) => PeerSession {
                session_id: target_session_id.clone(),
                sidecar_port: 0,
                message_count: 0,
                metadata_birth_pending: true,
                metadata_indexed: false,
                last_active: Instant::now(),
                ..peer.clone()
            },
            None => {
                let (source_type, source_id) = parse_session_key(session_key);
                PeerSession {
                    session_key: session_key.to_string(),
                    session_id: target_session_id.clone(),
                    sidecar_port: 0,
                    workspace_path: self.default_workspace.clone(),
                    source_type,
                    source_id,
                    source_display_name: None,
                    last_sender_name: None,
                    message_count: 0,
                    metadata_birth_pending: true,
                    metadata_indexed: false,
                    last_active: Instant::now(),
                }
            }
        };
        self.peer_sessions.insert(session_key.to_string(), next);
        PeerBindingTransition {
            session_key: session_key.to_string(),
            prior,
            target_session_id,
        }
    }

    /// A metadata-first IM birth uses the returned Product Session id, never a second UUID.
    pub fn stage_materialized_session_binding(
        &mut self,
        session_key: &str,
        session_id: &str,
    ) -> PeerBindingTransition {
        let mut transition = self.stage_new_session_binding(session_key);
        transition.target_session_id = session_id.to_string();
        if let Some(peer) = self.peer_sessions.get_mut(session_key) {
            peer.session_id = session_id.to_string();
            peer.metadata_birth_pending = false;
            peer.metadata_indexed = true;
        }
        transition
    }

    /// Stage the desktop Tab + Agent migration after owner admission. Unlike
    /// `/new`, the same live Sidecar port follows the exact participating
    /// surfaces and Node is given this exact target identity before the command
    /// reports success.
    pub fn stage_surface_session_migration(
        &mut self,
        session_key: &str,
        expected_old_session_id: &str,
        target_session_id: &str,
    ) -> Result<PeerBindingTransition, String> {
        let prior = self
            .peer_sessions
            .get(session_key)
            .cloned()
            .ok_or_else(|| format!("No peer binding for {session_key}"))?;
        if prior.session_id != expected_old_session_id {
            return Err(format!(
                "Peer binding changed before surface migration: expected {}, found {}",
                expected_old_session_id, prior.session_id
            ));
        }
        let next = PeerSession {
            session_id: target_session_id.to_string(),
            message_count: 0,
            metadata_birth_pending: false,
            metadata_indexed: true,
            last_active: Instant::now(),
            ..prior.clone()
        };
        self.peer_sessions.insert(session_key.to_string(), next);
        Ok(PeerBindingTransition {
            session_key: session_key.to_string(),
            prior: Some(prior),
            target_session_id: target_session_id.to_string(),
        })
    }

    /// Restore only the exact transition target. A later binding incarnation
    /// wins and cannot be overwritten by stale rollback work.
    pub fn rollback_peer_binding_transition(&mut self, transition: &PeerBindingTransition) -> bool {
        let current_matches = self
            .peer_sessions
            .get(&transition.session_key)
            .is_some_and(|peer| peer.session_id == transition.target_session_id);
        if !current_matches {
            return false;
        }
        if let Some(prior) = transition.prior.clone() {
            self.peer_sessions
                .insert(transition.session_key.clone(), prior);
        } else {
            self.peer_sessions.remove(&transition.session_key);
        }
        true
    }

    /// Remove every peer_session bound to `session_id` except `keep_session_key`.
    ///
    /// Handover uses this to enforce the global invariant that a desktop
    /// session can be bound to only one live IM channel at a time. The router
    /// only owns its local HashMap; the caller remains responsible for
    /// SidecarOwner release and any cross-router coordination.
    pub fn remove_peer_sessions_for_session_except(
        &mut self,
        session_id: &str,
        keep_session_key: Option<&str>,
    ) -> Vec<PeerSession> {
        let keys: Vec<String> = self
            .peer_sessions
            .iter()
            .filter(|(key, ps)| {
                ps.session_id == session_id
                    && keep_session_key.map_or(true, |keep| key.as_str() != keep)
            })
            .map(|(key, _)| key.clone())
            .collect();

        keys.into_iter()
            .filter_map(|key| self.peer_sessions.remove(&key))
            .collect()
    }

    /// Pick the most-recently-active peer_session_key in this channel.
    /// Used as the handover target — preserves "talk to the same chat,
    /// different session backend" semantics.
    pub fn most_recent_peer_session_key(&self) -> Option<String> {
        self.peer_sessions
            .values()
            .max_by_key(|ps| ps.last_active)
            .map(|ps| ps.session_key.clone())
    }

    /// Iterate over the channel's peer_sessions (read-only). Used by the
    /// mirror endpoint (`/api/im/mirror`) to find which channel binds a given
    /// session_id without exposing the full HashMap.
    pub fn peer_sessions_iter(&self) -> impl Iterator<Item = &PeerSession> {
        self.peer_sessions.values()
    }

    /// Session identities retained by channel→conversation bindings, even
    /// when their Sidecars were collected or released for hot reload.
    pub fn bound_session_ids(&self) -> Vec<String> {
        let mut session_ids = self
            .peer_sessions
            .values()
            .map(|peer| peer.session_id.clone())
            .collect::<Vec<_>>();
        session_ids.sort();
        session_ids.dedup();
        session_ids
    }

    /// Snapshot the set of peer_session_keys currently bound. Used by the
    /// runtime-change orchestrator (`runtime_change.rs`) to iterate without
    /// holding a borrow into the HashMap during async freeze HTTP calls.
    pub fn peer_session_keys(&self) -> Vec<String> {
        self.peer_sessions.keys().cloned().collect()
    }

    /// Get active peer session info (for health state)
    pub fn active_sessions(&self) -> Vec<super::types::ImActiveSession> {
        let now_instant = Instant::now();
        let now_utc = chrono::Utc::now();
        let mut sessions: Vec<_> = self
            .peer_sessions
            .values()
            .map(|ps| super::types::ImActiveSession {
                session_key: ps.session_key.clone(),
                session_id: ps.session_id.clone(),
                source_type: ps.source_type.clone(),
                source_id: Some(ps.source_id.clone()),
                source_display_name: ps.source_display_name.clone(),
                last_sender_name: ps.last_sender_name.clone(),
                workspace_path: ps.workspace_path.display().to_string(),
                message_count: ps.message_count,
                metadata_birth_pending: ps.metadata_birth_pending,
                metadata_indexed: ps.metadata_indexed,
                last_active: chrono::Duration::from_std(
                    now_instant.saturating_duration_since(ps.last_active),
                )
                .ok()
                .and_then(|age| now_utc.checked_sub_signed(age))
                .unwrap_or(now_utc)
                .to_rfc3339(),
            })
            .collect();
        sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));
        sessions
    }

    /// Restore peer sessions from persisted health state (startup recovery).
    /// Sidecar ports are set to 0 — the first message will trigger re-creation.
    ///
    /// Session IDs are restored from persisted state so Bun can resume the conversation
    /// via --session-id → SDK resume. This preserves IM conversation history across app restarts.
    ///
    /// Workspace is always set to the current `default_workspace` (from settings),
    /// NOT the persisted value. This ensures workspace changes take effect on restart.
    pub async fn restore_sessions(&mut self, sessions: &[super::types::ImActiveSession]) {
        let session_ids = sessions
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>();
        let _lifecycle = crate::sidecar::acquire_session_lifecycle(&session_ids).await;
        let mut sessions = sessions.to_vec();
        for session in &mut sessions {
            match crate::sidecar::has_persisted_session_owner(&session.session_id).await {
                Ok(true) => {
                    // Missing SessionStore metadata normally rotates a stale IM binding.
                    // A durable Goal/task owns this identity, so keep it birth-pending
                    // until its owner has reconciled instead of silently forking it.
                    session.metadata_birth_pending = true;
                    session.metadata_indexed = false;
                }
                Ok(false) => {}
                Err(error) => {
                    session.metadata_birth_pending = true;
                    session.metadata_indexed = false;
                    ulog_warn!(
                        "[im-router] Preserving restored Session identity {} because owner lookup failed: {}",
                        short_id(&session.session_id),
                        error
                    );
                }
            }
        }
        self.restore_sessions_with_metadata_lookup(&sessions, |sid| {
            resolve_session_runtime_identity_full(sid).is_some()
        });
    }

    fn restore_sessions_with_metadata_lookup<F>(
        &mut self,
        sessions: &[super::types::ImActiveSession],
        metadata_exists: F,
    ) where
        F: Fn(&str) -> bool,
    {
        for s in sessions {
            // TD-2: Migrate session key format if router has agent_id but key uses legacy "im:" prefix.
            // Old keys: im:{platform}:{type}:{id} → new: agent:{agentId}:{platform}:{type}:{id}
            let session_key = if let Some(ref agent_id) = self.agent_id {
                if s.session_key.starts_with("im:") {
                    // Translate: im:{platform}:{type}:{id} → agent:{agentId}:{platform}:{type}:{id}
                    let rest = s.session_key.strip_prefix("im:").unwrap_or(&s.session_key);
                    let migrated = format!("agent:{}:{}", agent_id, rest);
                    ulog_info!(
                        "[im-router] Migrated session key: {} → {}",
                        s.session_key,
                        migrated
                    );
                    migrated
                } else {
                    s.session_key.clone()
                }
            } else {
                s.session_key.clone()
            };
            let (source_type, source_id) = parse_session_key(&session_key);
            let disposition = reconcile_peer_metadata_with_lookup(
                s.metadata_birth_pending,
                s.metadata_indexed,
                &s.session_id,
                &metadata_exists,
            );
            let (session_id, message_count, metadata_birth_pending, metadata_indexed) =
                match disposition {
                    PeerMetadataDisposition::Indexed => {
                        (s.session_id.clone(), s.message_count, false, true)
                    }
                    PeerMetadataDisposition::BirthPending => {
                        (s.session_id.clone(), s.message_count, true, false)
                    }
                    PeerMetadataDisposition::RotateStale => {
                        let new_session_id = uuid::Uuid::new_v4().to_string();
                        ulog_info!(
                            "[im-router] Rotated stale restored peer session: {} -> {} (session_key={})",
                            short_id(&s.session_id),
                            short_id(&new_session_id),
                            session_key
                        );
                        (new_session_id, 0, true, false)
                    }
                };
            self.peer_sessions.insert(
                session_key.clone(),
                PeerSession {
                    session_key: session_key.clone(),
                    session_id,
                    sidecar_port: 0, // Sidecar not running yet; ensure_sidecar will start it
                    workspace_path: self.default_workspace.clone(),
                    source_type,
                    source_id,
                    source_display_name: s.source_display_name.clone(),
                    last_sender_name: s.last_sender_name.clone(),
                    message_count,
                    metadata_birth_pending,
                    metadata_indexed,
                    last_active: Instant::now(),
                },
            );
        }
        if !sessions.is_empty() {
            ulog_info!(
                "[im-router] Restored {} peer session(s) from previous run (workspace={})",
                sessions.len(),
                self.default_workspace.display(),
            );
        }
    }

    /// Get all unique active Sidecar ports (for hot-reload config broadcast).
    pub fn active_sidecar_ports(&self) -> Vec<u16> {
        let mut seen = std::collections::HashSet::new();
        self.peer_sessions
            .values()
            .filter(|ps| ps.sidecar_port > 0)
            .filter_map(|ps| {
                if seen.insert(ps.sidecar_port) {
                    Some(ps.sidecar_port)
                } else {
                    None
                }
            })
            .collect()
    }

    /// Update default workspace path (hot-reload, only affects new sessions).
    pub fn set_default_workspace(&mut self, path: PathBuf) {
        self.default_workspace = path;
    }

    /// Get a reference to the HTTP client (for callers that need to sync config outside the lock).
    pub fn http_client(&self) -> &Client {
        &self.http_client
    }

    /// Release all sessions and DROP the peer→session binding map.
    ///
    /// **Destructive.** Use only when the bot itself is being torn down
    /// (`shutdown_bot_instance`) — after a successful call, `peer_sessions` is
    /// empty, so any handover / message-routing / `most_recent_peer_session_key`
    /// lookup will treat the channel as if it had never seen a chat. Failed
    /// releases retain their binding so the lifecycle owner can report the
    /// incomplete teardown instead of silently losing retry evidence. For
    /// hot-reload paths that just need sidecars to restart (e.g. runtime
    /// switch), use [`Self::release_all_sidecars_preserve_bindings`] instead.
    pub async fn release_all(&mut self, manager: &ManagedSidecarManager) -> Result<usize, String> {
        let count = self.peer_sessions.len();
        let keys: Vec<String> = self.peer_sessions.keys().cloned().collect();
        let mut released = 0usize;
        let mut failures = Vec::new();
        for key in keys {
            if let Some(ps) = self.peer_sessions.get(&key) {
                let owner = SidecarOwner::Agent(key.clone());
                match release_session_sidecar(manager, &ps.session_id, &owner).await {
                    Ok(_) => {
                        self.peer_sessions.remove(&key);
                        released += 1;
                    }
                    Err(error) => failures.push(format!("{}: {}", ps.session_id, error)),
                }
            }
        }
        if released > 0 {
            ulog_info!(
                "[im-router] release_all: dropped {} peer_session(s) and released their sidecars",
                released,
            );
        }
        if failures.is_empty() {
            Ok(released)
        } else {
            Err(format!(
                "failed to release {} of {} Sidecar owner(s): {}",
                failures.len(),
                count,
                failures.join("; ")
            ))
        }
    }

    /// Release running Sidecars but PRESERVE the peer→session bindings.
    ///
    /// Used by hot-reload paths where the next IM message must spawn a fresh
    /// Sidecar (e.g. runtime change from `builtin` → `claude-code`), but the
    /// channel→chat binding must survive so handover / message routing /
    /// `/new` resume keep working. Each entry's `sidecar_port` is zeroed —
    /// `prepare_ensure_sidecar` will see the existing peer_session and re-mint
    /// the Sidecar on the next dispatch, reusing the same `session_id` so the
    /// SDK conversation resumes seamlessly.
    pub async fn release_all_sidecars_preserve_bindings(
        &mut self,
        manager: &ManagedSidecarManager,
    ) {
        let mut released = 0_usize;
        let keys: Vec<String> = self.peer_sessions.keys().cloned().collect();
        for key in keys {
            if let Some(ps) = self.peer_sessions.get_mut(&key) {
                let owner = SidecarOwner::Agent(key.clone());
                let _ = release_session_sidecar(manager, &ps.session_id, &owner).await;
                ps.sidecar_port = 0;
                released += 1;
            }
        }
        if released > 0 {
            ulog_info!(
                "[im-router] Released {} sidecar(s); {} peer_session binding(s) preserved for resume",
                released,
                self.peer_sessions.len(),
            );
        }
    }
}

/// Derive source string (e.g. "telegram_private") from session key.
fn session_key_to_source_str(session_key: &str) -> String {
    if session_key.contains("telegram") && session_key.contains("private") {
        "telegram_private".to_string()
    } else if session_key.contains("telegram") && session_key.contains("group") {
        "telegram_group".to_string()
    } else if session_key.contains("feishu") && session_key.contains("private") {
        "feishu_private".to_string()
    } else if session_key.contains("feishu") && session_key.contains("group") {
        "feishu_group".to_string()
    } else {
        "telegram_private".to_string()
    }
}

fn peer_to_heartbeat_target(ps: &PeerSession) -> HeartbeatPeerTarget {
    HeartbeatPeerTarget {
        session_key: ps.session_key.clone(),
        source: session_key_to_source_str(&ps.session_key),
        source_id: ps.source_id.clone(),
        last_active: ps.last_active,
    }
}

/// Parse session key into (source_type, source_id)
/// Supports both legacy and new format:
///   Legacy: im:{platform}:{private|group}:{id}
///   New:    agent:{agentId}:{channelType}:{private|group}:{id}
///
/// NOTE: Both channelType AND source_id may contain colons:
///   - channelType: "openclaw:feishu" (OpenClaw plugin names)
///   - source_id:   "group:abc123"    (DingTalk group chat IDs)
/// We search FORWARD from the platform start position for the FIRST
/// "private"/"group" token, since platform names never contain these words
/// while source_id may (e.g. DingTalk "group:{openConversationId}").
pub fn parse_session_key(session_key: &str) -> (ImSourceType, String) {
    let parts: Vec<&str> = session_key.split(':').collect();

    // Determine where to start searching (skip fixed prefix fields)
    let search_start = if parts.len() >= 5 && parts[0] == "agent" {
        2 // agent:{agentId}: — platform starts at index 2
    } else if parts.len() >= 4 {
        1 // im: — platform starts at index 1
    } else {
        return (ImSourceType::Private, session_key.to_string());
    };

    // Find the FIRST "private" or "group" after the prefix — this is the source_type marker.
    // Platform names (telegram, feishu, dingtalk, openclaw:xxx) don't contain these words.
    if let Some(rel_pos) = parts[search_start..]
        .iter()
        .position(|p| *p == "private" || *p == "group")
    {
        let abs_pos = search_start + rel_pos;
        let source_type = match parts[abs_pos] {
            "group" => ImSourceType::Group,
            _ => ImSourceType::Private,
        };
        let source_id = parts[abs_pos + 1..].join(":");
        (source_type, source_id)
    } else {
        (ImSourceType::Private, session_key.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use super::{
        parse_session_key, peer_binding_source_requires_freeze,
        reconcile_peer_metadata_with_lookup, EnsureSidecarInfo, EnsureSidecarPrep,
        PeerMetadataDisposition, SessionRouter,
    };
    use crate::im::types::{ImActiveSession, PeerSession};
    use crate::sidecar::{SidecarManager, SidecarOwner};

    fn peer(session_key: &str, session_id: &str) -> PeerSession {
        let (source_type, source_id) = parse_session_key(session_key);
        PeerSession {
            session_key: session_key.to_string(),
            session_id: session_id.to_string(),
            sidecar_port: 0,
            workspace_path: PathBuf::from("/tmp/workspace"),
            source_type,
            source_id,
            source_display_name: None,
            last_sender_name: None,
            message_count: 0,
            metadata_birth_pending: false,
            metadata_indexed: true,
            last_active: Instant::now(),
        }
    }

    #[test]
    fn heartbeat_private_target_helper_rejects_group_session() {
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        router.upsert_peer_session(peer("agent:a:openclaw:weixin:group:g1", "g1"));
        router.upsert_peer_session(peer("agent:a:openclaw:weixin:private:u1", "p1"));

        assert!(router
            .get_private_peer_session_target("agent:a:openclaw:weixin:group:g1")
            .is_none());
        assert_eq!(
            router
                .get_private_peer_session_target("agent:a:openclaw:weixin:private:u1")
                .map(|target| target.session_key),
            Some("agent:a:openclaw:weixin:private:u1".to_string())
        );
    }

    #[test]
    fn latest_private_heartbeat_target_ignores_newer_group() {
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        let mut old_private = peer("agent:a:openclaw:weixin:private:old", "p-old");
        old_private.last_active = Instant::now() - std::time::Duration::from_secs(60);
        let mut current_private = peer("agent:a:openclaw:weixin:private:current", "p-current");
        current_private.last_active = Instant::now() - std::time::Duration::from_secs(10);
        let newer_group = peer("agent:a:openclaw:weixin:group:g1", "g1");
        router.upsert_peer_session(old_private);
        router.upsert_peer_session(current_private);
        router.upsert_peer_session(newer_group);

        assert_eq!(
            router
                .latest_private_peer_session_target()
                .map(|target| target.session_key),
            Some("agent:a:openclaw:weixin:private:current".to_string())
        );
    }

    #[test]
    fn remove_peer_sessions_for_session_except_preserves_target_binding() {
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        router.upsert_peer_session(peer("agent:a:openclaw:feishu:private:source", "s1"));
        router.upsert_peer_session(peer("agent:a:openclaw:feishu:private:target", "s1"));
        router.upsert_peer_session(peer("agent:a:openclaw:feishu:private:other", "s2"));

        let removed = router.remove_peer_sessions_for_session_except(
            "s1",
            Some("agent:a:openclaw:feishu:private:target"),
        );

        assert_eq!(removed.len(), 1);
        assert_eq!(
            removed[0].session_key,
            "agent:a:openclaw:feishu:private:source"
        );
        assert!(router
            .peer_session_snapshot("agent:a:openclaw:feishu:private:target")
            .is_some());
        assert!(router
            .peer_session_snapshot("agent:a:openclaw:feishu:private:other")
            .is_some());
        assert!(router
            .peer_session_snapshot("agent:a:openclaw:feishu:private:source")
            .is_none());
    }

    #[test]
    fn remove_peer_sessions_for_session_without_keep_removes_all_matching_bindings() {
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        router.upsert_peer_session(peer("agent:a:feishu:private:same-key", "s1"));
        router.upsert_peer_session(peer("agent:a:feishu:private:other", "s2"));

        let removed = router.remove_peer_sessions_for_session_except("s1", None);

        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].session_key, "agent:a:feishu:private:same-key");
        assert!(router
            .peer_session_snapshot("agent:a:feishu:private:same-key")
            .is_none());
        assert!(router
            .peer_session_snapshot("agent:a:feishu:private:other")
            .is_some());
    }

    #[test]
    fn bound_session_ids_survive_sidecar_release_state() {
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        router.upsert_peer_session(peer("agent:a:feishu:private:first", "session-b"));
        router.upsert_peer_session(peer("agent:a:feishu:private:second", "session-a"));
        router.upsert_peer_session(peer("agent:a:feishu:private:duplicate", "session-b"));

        assert_eq!(
            router.bound_session_ids(),
            vec!["session-a".to_string(), "session-b".to_string()]
        );
    }

    #[test]
    fn new_binding_stage_is_lazy_and_exactly_rollbackable() {
        let session_key = "agent:a:feishu:private:user";
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        let mut original = peer(session_key, "session-a");
        original.sidecar_port = 32100;
        original.message_count = 7;
        router.upsert_peer_session(original.clone());

        let transition = router.stage_new_session_binding(session_key);
        let pending = router
            .peer_session_snapshot(session_key)
            .expect("pending binding");
        assert_ne!(pending.session_id, "session-a");
        assert_eq!(pending.sidecar_port, 0);
        assert_eq!(pending.message_count, 0);
        assert!(pending.metadata_birth_pending);
        assert!(!pending.metadata_indexed);

        assert!(router.rollback_peer_binding_transition(&transition));
        let restored = router
            .peer_session_snapshot(session_key)
            .expect("restored binding");
        assert_eq!(restored.session_id, original.session_id);
        assert_eq!(restored.sidecar_port, original.sidecar_port);
        assert_eq!(restored.message_count, original.message_count);
    }

    #[test]
    fn new_binding_stage_materializes_a_missing_peer_as_lazy_state() {
        let session_key = "agent:a:feishu:private:user";
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));

        let transition = router.stage_new_session_binding(session_key);
        let pending = router
            .peer_session_snapshot(session_key)
            .expect("new pending binding");
        assert_eq!(pending.session_id, transition.target_session_id());
        assert_eq!(pending.sidecar_port, 0);
        assert!(pending.metadata_birth_pending);
        assert!(!pending.metadata_indexed);

        assert!(router.rollback_peer_binding_transition(&transition));
        assert!(router.peer_session_snapshot(session_key).is_none());
    }

    #[test]
    fn stale_binding_transition_cannot_overwrite_a_newer_binding() {
        let session_key = "agent:a:feishu:private:user";
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        router.upsert_peer_session(peer(session_key, "session-a"));
        let transition = router.stage_new_session_binding(session_key);
        router.upsert_peer_session(peer(session_key, "session-c"));

        assert!(!router.rollback_peer_binding_transition(&transition));
        assert_eq!(
            router
                .peer_session_snapshot(session_key)
                .expect("newer binding")
                .session_id,
            "session-c"
        );
    }

    #[test]
    fn stale_terminal_cannot_materialize_the_binding_created_by_new() {
        let session_key = "agent:a:feishu:private:user";
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        router.upsert_peer_session(peer(session_key, "session-a"));

        let transition = router.stage_new_session_binding(session_key);
        let target = transition.target_session_id().to_string();

        assert!(!router.record_response_if_bound(session_key, "session-a"));
        let pending = router
            .peer_session_snapshot(session_key)
            .expect("pending binding");
        assert_eq!(pending.session_id, target);
        assert_eq!(pending.message_count, 0);
        assert!(pending.metadata_birth_pending);
        assert!(!pending.metadata_indexed);

        assert!(router.record_response_if_bound(session_key, &target));
        let materialized = router
            .peer_session_snapshot(session_key)
            .expect("materialized binding");
        assert_eq!(materialized.message_count, 1);
        assert!(!materialized.metadata_birth_pending);
        assert!(materialized.metadata_indexed);
    }

    #[test]
    fn surface_stage_requires_the_current_source_binding() {
        let session_key = "agent:a:feishu:private:user";
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        router.upsert_peer_session(peer(session_key, "session-newer"));

        let error = router
            .stage_surface_session_migration(session_key, "session-stale", "session-target")
            .expect_err("stale source must fail closed");
        assert!(error.contains("binding changed"));
        assert_eq!(
            router
                .peer_session_snapshot(session_key)
                .expect("binding preserved")
                .session_id,
            "session-newer"
        );
    }

    #[test]
    fn metadata_birth_pending_is_consumed_after_first_enqueue() {
        let session_key = "agent:a:feishu:private:user";
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        let info = EnsureSidecarInfo {
            session_key: session_key.to_string(),
            session_id: "new-session".to_string(),
            workspace: PathBuf::from("/tmp/workspace"),
            prev_count: 0,
            metadata_birth_pending: true,
            metadata_indexed: false,
            runtime_override: None,
            runtime_source_override: None,
        };

        router.commit_ensure_sidecar(session_key, &info, 1234);
        assert!(router.metadata_birth_pending(session_key));
        assert!(
            !router
                .peer_session_snapshot(session_key)
                .expect("peer session exists")
                .metadata_indexed
        );

        assert!(router.mark_metadata_birth_consumed_if_session(session_key, "new-session"));
        assert!(!router.metadata_birth_pending(session_key));
        assert!(
            router
                .peer_session_snapshot(session_key)
                .expect("peer session exists")
                .metadata_indexed
        );
    }

    #[test]
    fn stale_session_ack_cannot_consume_new_binding_birth_authority() {
        let session_key = "agent:a:feishu:private:user";
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        let old_info = EnsureSidecarInfo {
            session_key: session_key.to_string(),
            session_id: "session-a".to_string(),
            workspace: PathBuf::from("/tmp/workspace"),
            prev_count: 0,
            metadata_birth_pending: true,
            metadata_indexed: false,
            runtime_override: None,
            runtime_source_override: None,
        };
        let new_info = EnsureSidecarInfo {
            session_id: "session-b".to_string(),
            ..old_info.clone()
        };

        router.commit_ensure_sidecar(session_key, &old_info, 1234);
        router.commit_ensure_sidecar(session_key, &new_info, 5678);

        assert!(!router.mark_metadata_birth_consumed_if_session(session_key, "session-a"));
        let current = router
            .peer_session_snapshot(session_key)
            .expect("new binding should remain present");
        assert_eq!(current.session_id, "session-b");
        assert!(current.metadata_birth_pending);
        assert!(!current.metadata_indexed);

        assert!(router.mark_metadata_birth_consumed_if_session(session_key, "session-b"));
        assert!(!router.metadata_birth_pending(session_key));
    }

    #[test]
    fn active_session_restore_preserves_metadata_birth_pending() {
        let session_key = "agent:a:feishu:private:user";
        let mut router =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        let mut pending = peer(session_key, "birth-pending-session");
        pending.metadata_birth_pending = true;
        pending.metadata_indexed = false;
        router.upsert_peer_session(pending);

        let active = router.active_sessions();
        assert_eq!(active.len(), 1);
        assert!(active[0].metadata_birth_pending);

        let mut restored =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        restored.restore_sessions_with_metadata_lookup(&active, |_| false);

        assert!(restored.metadata_birth_pending(session_key));
    }

    #[test]
    fn active_session_legacy_json_defaults_rotate_when_metadata_missing() {
        let session_key = "agent:a:feishu:private:user";
        let mut router =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        router.upsert_peer_session(peer(session_key, "legacy-session"));

        let mut active = router.active_sessions();
        let mut legacy_value = serde_json::to_value(active.remove(0)).unwrap();
        legacy_value
            .as_object_mut()
            .expect("active session serializes as an object")
            .remove("metadataBirthPending");
        legacy_value
            .as_object_mut()
            .expect("active session serializes as an object")
            .remove("metadataIndexed");

        let restored_active: ImActiveSession = serde_json::from_value(legacy_value).unwrap();
        assert!(!restored_active.metadata_birth_pending);
        assert!(!restored_active.metadata_indexed);

        let mut restored =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        restored.restore_sessions_with_metadata_lookup(&[restored_active], |_| false);

        let restored_peer = restored
            .peer_session_snapshot(session_key)
            .expect("peer session exists");
        assert_ne!(restored_peer.session_id, "legacy-session");
        assert_eq!(restored_peer.message_count, 0);
        assert!(restored_peer.metadata_birth_pending);
        assert!(!restored_peer.metadata_indexed);
    }

    #[test]
    fn restored_peer_metadata_reconciles_with_session_index() {
        assert_eq!(
            reconcile_peer_metadata_with_lookup(false, true, "indexed-present", |sid| sid
                == "indexed-present",),
            PeerMetadataDisposition::Indexed,
        );
        assert_eq!(
            reconcile_peer_metadata_with_lookup(false, true, "deleted-after-indexed", |_| false,),
            PeerMetadataDisposition::RotateStale,
        );
        assert_eq!(
            reconcile_peer_metadata_with_lookup(false, false, "legacy-present", |sid| sid
                == "legacy-present",),
            PeerMetadataDisposition::Indexed,
        );
        assert_eq!(
            reconcile_peer_metadata_with_lookup(true, false, "birth-pending", |_| false,),
            PeerMetadataDisposition::BirthPending,
        );
        assert_eq!(
            reconcile_peer_metadata_with_lookup(false, false, "legacy-unindexed", |_| false,),
            PeerMetadataDisposition::RotateStale,
        );
    }

    #[test]
    fn restore_sessions_rotates_stale_indexed_peer_session() {
        let session_key = "agent:a:feishu:private:user";
        let mut router =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        router.upsert_peer_session(peer(session_key, "deleted-after-indexed"));

        let active = router.active_sessions();
        let mut restored =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        restored.restore_sessions_with_metadata_lookup(&active, |_| false);

        let restored_peer = restored
            .peer_session_snapshot(session_key)
            .expect("peer session exists");
        assert_ne!(restored_peer.session_id, "deleted-after-indexed");
        assert_eq!(restored_peer.message_count, 0);
        assert!(restored_peer.metadata_birth_pending);
        assert!(!restored_peer.metadata_indexed);
    }

    #[tokio::test]
    async fn accepted_unpublished_peer_keeps_its_owned_identity_on_next_ingress() {
        for owner in [
            SidecarOwner::Agent("peer-v2".into()),
            SidecarOwner::Companion("floating-ball".into()),
        ] {
            let session_id = format!("unpublished-{}", uuid::Uuid::new_v4());
            let mut router = SessionRouter::new(PathBuf::from("/synthetic"));
            let mut binding = peer("peer-v2", &session_id);
            binding.sidecar_port = 0; // A stale port cache must not rotate a live identity.
            binding.metadata_birth_pending = true;
            binding.metadata_indexed = false;
            router.upsert_peer_session(binding);
            router.mark_metadata_birth_consumed_if_session("peer-v2", &session_id);
            let manager = Arc::new(Mutex::new(SidecarManager::new()));
            manager
                .lock()
                .unwrap()
                .insert_test_ready_frontend_sidecar(&session_id, 1234, owner);
            let EnsureSidecarPrep::NeedCreate(info) =
                router.prepare_ensure_sidecar("peer-v2", &manager).await
            else {
                panic!("stale port cache must go through authoritative ensure");
            };
            assert_eq!(info.session_id, session_id);
            assert!(
                !info.metadata_birth_pending,
                "ordinary continuation cannot mint the Session again"
            );
        }
    }

    #[tokio::test]
    async fn reset_path_rotates_stale_indexed_peer_before_freeze() {
        let session_key = "agent:a:feishu:private:user";
        let mut router =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        let mut stale = peer(session_key, "deleted-before-new-command");
        stale.message_count = 3;
        stale.metadata_birth_pending = false;
        stale.metadata_indexed = true;
        router.upsert_peer_session(stale);
        let manager = Arc::new(Mutex::new(SidecarManager::new()));

        router
            .reconcile_peer_session_metadata_before_use(session_key, &manager)
            .await;

        let reconciled = router
            .peer_session_snapshot(session_key)
            .expect("peer session remains bound after stale rotation");
        assert_ne!(reconciled.session_id, "deleted-before-new-command");
        assert_eq!(reconciled.sidecar_port, 0);
        assert_eq!(reconciled.message_count, 0);
        assert!(reconciled.metadata_birth_pending);
        assert!(!reconciled.metadata_indexed);
    }

    #[test]
    fn binding_rotation_classifies_stale_metadata_without_mutating_the_source_binding() {
        let session_key = "agent:a:feishu:private:user";
        let mut router =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        let mut stale = peer(session_key, "deleted-before-new-command");
        stale.sidecar_port = 32100;
        stale.message_count = 3;
        stale.metadata_birth_pending = false;
        stale.metadata_indexed = true;
        router.upsert_peer_session(stale.clone());

        let disposition = router
            .classify_peer_session_metadata_for_binding_rotation_with_lookup(session_key, |_| false)
            .expect("peer binding exists");

        assert_eq!(disposition, PeerMetadataDisposition::RotateStale);
        let source_after_classification = router
            .peer_session_snapshot(session_key)
            .expect("classification must keep the source binding");
        assert_eq!(source_after_classification.session_id, stale.session_id);
        assert_eq!(source_after_classification.sidecar_port, stale.sidecar_port);
        assert_eq!(
            source_after_classification.message_count,
            stale.message_count
        );
        assert_eq!(
            source_after_classification.metadata_birth_pending,
            stale.metadata_birth_pending,
        );
        assert_eq!(
            source_after_classification.metadata_indexed,
            stale.metadata_indexed,
        );
    }

    #[test]
    fn binding_rotation_freezes_only_sources_owned_by_session_store() {
        assert!(peer_binding_source_requires_freeze(Some(
            PeerMetadataDisposition::Indexed,
        )));
        assert!(!peer_binding_source_requires_freeze(Some(
            PeerMetadataDisposition::BirthPending,
        )));
        assert!(!peer_binding_source_requires_freeze(Some(
            PeerMetadataDisposition::RotateStale,
        )));
        assert!(!peer_binding_source_requires_freeze(None));
    }

    #[test]
    fn restore_sessions_promotes_legacy_indexed_peer_sessions() {
        let session_key = "agent:a:feishu:private:user";
        let mut router =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        router.upsert_peer_session(peer(session_key, "legacy-present"));

        let mut active = router.active_sessions();
        active[0].metadata_indexed = false;

        let mut restored =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        restored.restore_sessions_with_metadata_lookup(&active, |sid| sid == "legacy-present");

        assert!(
            restored
                .peer_session_snapshot(session_key)
                .expect("peer session exists")
                .metadata_indexed
        );
    }

    #[test]
    fn restore_sessions_clears_birth_pending_when_metadata_exists() {
        let session_key = "agent:a:feishu:private:user";
        let mut router =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        let mut pending = peer(session_key, "legacy-present");
        pending.metadata_birth_pending = true;
        pending.metadata_indexed = false;
        router.upsert_peer_session(pending);

        let active = router.active_sessions();
        let mut restored =
            SessionRouter::new_for_agent(PathBuf::from("/tmp/workspace"), "a".to_string());
        restored.restore_sessions_with_metadata_lookup(&active, |sid| sid == "legacy-present");

        let restored_peer = restored
            .peer_session_snapshot(session_key)
            .expect("peer session exists");
        assert!(!restored_peer.metadata_birth_pending);
        assert!(restored_peer.metadata_indexed);
    }
}
