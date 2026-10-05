//! App-owned connection registry. Selection is presentation; every stored active
//! connection keeps its own actor, identity and generation on a shared memory budget.
use super::account::{NetworkAccountSession, SelfhostAccount, SelfhostDescriptor};
use super::actor::{AgentNetwork, ManagedConnection, NetworkSnapshot};
use super::identity::NetworkIdentity;
use super::memory::MemoryBudget;
use super::NetworkError;
use crate::sidecar::ManagedSidecarManager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Listener};
use tokio::sync::Notify;
use zeroize::Zeroizing;
const OFFICIAL: &str = "official";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredConnection {
    pub id: String,
    pub descriptor: SelfhostDescriptor,
    #[serde(default)]
    pub removing: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reenrolling: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_scope: Option<super::crypto::KeyScope>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionView {
    pub id: String,
    pub name: String,
    pub official: bool,
    pub url: Option<String>,
    pub removing: bool,
    pub snapshot: NetworkSnapshot,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistryView {
    pub revision: u64,
    pub selected: String,
    pub connections: Vec<ConnectionView>,
}
pub(crate) type ManagedAgentNetwork = Arc<NetworkRegistry>;
pub(crate) struct NetworkRegistry {
    memory: MemoryBudget,
    connections: Mutex<HashMap<String, ManagedConnection>>,
    stored: Mutex<Vec<StoredConnection>>,
    selected: Mutex<String>,
    revision: AtomicU64,
    stopped: AtomicBool,
    shutdown: Notify,
    mutation: tokio::sync::Mutex<()>,
}
fn config_path() -> Result<std::path::PathBuf, NetworkError> {
    crate::app_dirs::myagents_data_dir()
        .map(|d| d.join("config.json"))
        .ok_or_else(|| NetworkError::new("NETWORK_CONFIG_UNAVAILABLE"))
}
fn persist(stored: Vec<StoredConnection>, selected: String) -> Result<(), NetworkError> {
    let path = config_path()?;
    crate::config_io::with_config_lock(&path, true, move |config| {
        config["agentNetworkConnections"] =
            serde_json::to_value(&stored).map_err(|e| e.to_string())?;
        config["agentNetworkSelectedConnection"] = json!(selected);
        Ok(())
    })
    .map_err(|_| NetworkError::new("NETWORK_CONFIG_WRITE_FAILED"))?;
    Ok(())
}
fn self_account(c: &StoredConnection, key: Option<Zeroizing<String>>) -> NetworkAccountSession {
    NetworkAccountSession::Selfhost(Arc::new(SelfhostAccount {
        connection_id: c.id.clone(),
        descriptor: c.descriptor.clone(),
        active: Arc::new(AtomicBool::new(true)),
        enrollment_key: key,
    }))
}
fn join_enrollment_key(
    existing: bool,
    checkpointed_removal: bool,
    key: Zeroizing<String>,
) -> Option<Zeroizing<String>> {
    if existing && !checkpointed_removal {
        None
    } else {
        Some(key)
    }
}
impl NetworkRegistry {
    pub(crate) fn new() -> ManagedAgentNetwork {
        let memory = MemoryBudget::default();
        let mut connections = HashMap::new();
        connections.insert(
            OFFICIAL.into(),
            AgentNetwork::new(OFFICIAL.into(), None, memory.clone()),
        );
        Arc::new(Self {
            memory,
            connections: Mutex::new(connections),
            stored: Mutex::new(Vec::new()),
            selected: Mutex::new(OFFICIAL.into()),
            revision: AtomicU64::new(0),
            stopped: AtomicBool::new(false),
            shutdown: Notify::new(),
            mutation: tokio::sync::Mutex::new(()),
        })
    }
    pub(crate) fn all(&self) -> Vec<ManagedConnection> {
        self.connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }
    pub(crate) fn connection(&self, id: &str) -> Result<ManagedConnection, NetworkError> {
        self.connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| NetworkError::new("NETWORK_CONNECTION_NOT_FOUND"))
    }
    pub(crate) fn for_reference(
        &self,
        reference: &myagents_agent_network_protocol::AgentReference,
    ) -> Result<ManagedConnection, NetworkError> {
        let id = {
            self.stored
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .find(|c| {
                    c.descriptor.service_id == reference.service_id
                        && c.descriptor.network_id == reference.network_id
                        && !c.removing
                })
                .map(|c| c.id.clone())
        };
        if let Some(id) = id {
            return self.connection(&id);
        }
        let official = self.official();
        if official.snapshot().network_id.as_deref() == Some(&reference.network_id)
            && NetworkAccountSession::capture()
                .and_then(|a| a.service_id().map(str::to_owned))
                .is_ok_and(|service| service == reference.service_id)
        {
            return Ok(official);
        }
        Err(NetworkError::new("NETWORK_SCOPE_MISMATCH"))
    }
    pub(crate) fn official(&self) -> ManagedConnection {
        self.connection(OFFICIAL)
            .expect("official connector remains")
    }
    pub(crate) fn snapshot(&self) -> NetworkSnapshot {
        self.official().snapshot()
    }
    pub(crate) fn memory_budget(&self) -> MemoryBudget {
        self.memory.clone()
    }
    pub(crate) fn current_generation(&self, id: &str) -> Option<u64> {
        self.connection(id).ok().map(|c| c.generation())
    }
    pub(crate) fn auth_boundary<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) {
        self.official().auth_boundary(app);
    }
    pub(crate) fn power_boundary(&self, app: &tauri::AppHandle, suspended: bool) {
        for c in self.all() {
            c.power_boundary(app, suspended);
        }
    }
    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        for c in self.all() {
            c.deactivate();
        }
        self.shutdown.notify_one();
    }
    pub(crate) fn view(&self) -> RegistryView {
        let stored = self.stored.lock().unwrap_or_else(|e| e.into_inner());
        let mut views = vec![ConnectionView {
            id: OFFICIAL.into(),
            name: "MyAgents".into(),
            official: true,
            url: None,
            removing: false,
            snapshot: self.snapshot(),
        }];
        for c in stored.iter() {
            let snapshot = self
                .connection(&c.id)
                .map(|a| a.snapshot())
                .unwrap_or_else(|_| NetworkSnapshot {
                    state: "disconnected",
                    principal_id: Some(c.descriptor.principal_id.clone()),
                    network_id: Some(c.descriptor.network_id.clone()),
                    device_name: None,
                    error: Some(NetworkError::new("NETWORK_REMOVAL_UNCONFIRMED")),
                    revision: 0,
                    auth_generation: 0,
                    connection_id: c.id.clone(),
                });
            views.push(ConnectionView {
                id: c.id.clone(),
                name: c.descriptor.name.clone(),
                official: false,
                url: Some(c.descriptor.issuer.clone()),
                removing: c.removing,
                snapshot,
            });
        }
        RegistryView {
            revision: self.revision.load(Ordering::Acquire),
            selected: self
                .selected
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            connections: views,
        }
    }
    pub(crate) async fn select(
        &self,
        app: &tauri::AppHandle,
        id: String,
    ) -> Result<RegistryView, NetworkError> {
        let _lock = self.mutation.lock().await;
        if id != OFFICIAL
            && !self
                .stored
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .any(|c| c.id == id)
        {
            return Err(NetworkError::new("NETWORK_CONNECTION_NOT_FOUND"));
        }
        let stored = self
            .stored
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let selected = id.clone();
        tokio::task::spawn_blocking(move || persist(stored, selected))
            .await
            .map_err(|_| NetworkError::new("NETWORK_CONFIG_WRITE_FAILED"))??;
        *self.selected.lock().unwrap_or_else(|e| e.into_inner()) = id;
        self.revision.fetch_add(1, Ordering::AcqRel);
        let _ = app.emit("agent-network:connections-changed", self.view());
        Ok(self.view())
    }
    pub(crate) async fn join(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        manager: ManagedSidecarManager,
        url: String,
        key: Zeroizing<String>,
    ) -> Result<RegistryView, NetworkError> {
        let _lock = self.mutation.lock().await;
        let descriptor = super::account::descriptor(&url).await?;
        let existing = {
            self.stored
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .find(|c| c.descriptor.service_id == descriptor.service_id)
                .cloned()
        };
        if let Some(c) = &existing {
            c.descriptor.ensure_same_trust(&descriptor)?;
        }
        if existing.is_none()
            && self
                .stored
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .any(|c| c.descriptor.issuer == descriptor.issuer)
        {
            return Err(NetworkError::new("NETWORK_TRUST_CHANGED"));
        }
        if key.is_empty() || key.len() > 256 {
            return Err(NetworkError::new("ENROLLMENT_KEY_INVALID"));
        }
        let has_existing = existing.is_some();
        let mut stored = existing.unwrap_or_else(|| StoredConnection {
            id: uuid::Uuid::new_v4().to_string(),
            descriptor,
            removing: false,
            reenrolling: false,
            revoked_scope: None,
        });
        let previous_generation = self
            .connection(&stored.id)
            .ok()
            .map(|connection| connection.snapshot().auth_generation)
            .unwrap_or(0);
        if has_existing && !stored.removing {
            match NetworkIdentity::revoked_scope(&self_account(&stored, None)).await {
                Ok(scope) => {
                    stored.removing = true;
                    stored.revoked_scope = Some(scope);
                }
                Err(error) if error.code == "NETWORK_REMOVAL_UNCONFIRMED" => {}
                Err(error) => return Err(error),
            }
        }
        if stored.removing {
            if stored.revoked_scope.is_none() {
                stored.revoked_scope =
                    Some(NetworkIdentity::revoked_scope(&self_account(&stored, None)).await?);
            }
            // Persist the replacement phase before enrollment may commit remotely.
            stored.reenrolling = true;
            let mut checkpoint = self
                .stored
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            *checkpoint
                .iter_mut()
                .find(|c| c.id == stored.id)
                .expect("stored removal") = stored.clone();
            let selected = self
                .selected
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let save = checkpoint.clone();
            tokio::task::spawn_blocking(move || persist(save, selected))
                .await
                .map_err(|_| NetworkError::new("NETWORK_CONFIG_WRITE_FAILED"))??;
            *self.stored.lock().unwrap_or_else(|e| e.into_inner()) = checkpoint;
            if let Some(previous) = self
                .connections
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&stored.id)
            {
                previous.deactivate();
            }
            self.revision.fetch_add(1, Ordering::AcqRel);
            let _ = app.emit("agent-network:connections-changed", self.view());
        }
        // An active existing connection only proves its current private key.
        // Withhold enrollment capability: revocation racing the preflight must
        // fail before mutation and be checkpointed on the next explicit Join.
        let enrollment = self_account(
            &stored,
            join_enrollment_key(has_existing, stored.removing, key),
        );
        let identity = NetworkIdentity::initialize(
            enrollment,
            stored.revoked_scope.as_ref().map(|s| s.key_generation),
        )
        .await?;
        if let Some(scope) = stored.revoked_scope.clone() {
            tokio::task::spawn_blocking(move || super::crypto::OsIdentityStore::delete(&scope))
                .await
                .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))??;
        }
        stored.removing = false;
        stored.reenrolling = false;
        stored.revoked_scope = None;
        let mut next = self
            .stored
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(current) = next.iter_mut().find(|c| c.id == stored.id) {
            *current = stored.clone();
        } else {
            next.push(stored.clone());
        }
        let save = next.clone();
        let selected = stored.id.clone();
        let save_selected = selected.clone();
        tokio::task::spawn_blocking(move || persist(save, save_selected))
            .await
            .map_err(|_| NetworkError::new("NETWORK_CONFIG_WRITE_FAILED"))??;
        let account = self_account(&stored, None);
        let seed = if let Ok(previous) = self.connection(&stored.id) {
            let seed = previous
                .snapshot()
                .auth_generation
                .saturating_add(1)
                .max(self.revision.load(Ordering::Acquire).saturating_add(1));
            previous.deactivate();
            seed
        } else {
            previous_generation
                .saturating_add(1)
                .max(self.revision.load(Ordering::Acquire).saturating_add(1))
        };
        let connector = AgentNetwork::with_generation(
            stored.id.clone(),
            Some(account),
            self.memory.clone(),
            seed,
        );
        // Initialization proves enrollment. The live actor uses only the persisted private key,
        // and drops the temporary enrollment secret with this identity.
        drop(identity);
        self.connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(stored.id.clone(), connector.clone());
        *self.stored.lock().unwrap_or_else(|e| e.into_inner()) = next;
        *self.selected.lock().unwrap_or_else(|e| e.into_inner()) = selected;
        super::actor::start(app.clone(), connector, manager);
        self.revision.fetch_add(1, Ordering::AcqRel);
        let _ = app.emit("agent-network:connections-changed", self.view());
        Ok(self.view())
    }
    pub(crate) async fn remove(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        id: String,
    ) -> Result<RegistryView, NetworkError> {
        let _lock = self.mutation.lock().await;
        if id == OFFICIAL {
            return Err(NetworkError::new("OFFICIAL_NETWORK_CANNOT_REMOVE"));
        }
        let stored = self
            .stored
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| NetworkError::new("NETWORK_CONNECTION_NOT_FOUND"))?;
        let mut next = self
            .stored
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        for c in &mut next {
            if c.id == id {
                c.removing = true;
            }
        }
        let selected = self
            .selected
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let save = next.clone();
        let save_selected = selected.clone();
        tokio::task::spawn_blocking(move || persist(save, save_selected))
            .await
            .map_err(|_| NetworkError::new("NETWORK_CONFIG_WRITE_FAILED"))??;
        *self.stored.lock().unwrap_or_else(|e| e.into_inner()) = next.clone();
        if let Some(connector) = self
            .connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
        {
            connector.deactivate();
        }
        self.revision.fetch_add(1, Ordering::AcqRel);
        let _ = app.emit("agent-network:connections-changed", self.view());
        let scope = if let Some(scope) = cleanup_checkpoint(&stored) {
            scope.clone()
        } else {
            let account = self_account(&stored, None);
            account.validate_instance().await?;
            let device = crate::device_identity::current_device_identity()
                .map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
            let value = account
                .request(
                    crate::space_cloud::agent_network::AccountOperation::IdentityState(
                        device.device_id.clone(),
                    ),
                    None,
                )
                .await?;
            myagents_agent_network_protocol::validate_identity_state(&value)
                .map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
            let state: myagents_agent_network_protocol::IdentityState =
                serde_json::from_value(value)
                    .map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
            let scope = super::crypto::KeyScope {
                issuer: stored.descriptor.issuer.clone(),
                environment: stored.descriptor.environment.clone(),
                service_id: stored.descriptor.service_id.clone(),
                principal_id: stored.descriptor.principal_id.clone(),
                device_id: device.device_id,
                key_generation: state
                    .key_generation
                    .ok_or_else(|| NetworkError::new("IDENTITY_STATE_INVALID"))?,
            };
            if state.service_id != scope.service_id
                || state.environment != scope.environment
                || state.device_id != scope.device_id
            {
                return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
            }
            let key = super::identity::load_key(&scope)
                .await?
                .ok_or_else(|| NetworkError::new("NETWORK_PRIVATE_KEY_MISSING"))?;
            let fingerprint = key.public_fingerprint()?;
            if state.key_fingerprint.as_deref() != Some(&fingerprint) {
                return Err(NetworkError::new("IDENTITY_KEY_MISMATCH"));
            }
            let request =
                async |operation: &str,
                       route: crate::space_cloud::agent_network::AccountOperation| {
                    let proof =
                        super::identity::proof(&account, &scope, &key, operation, &fingerprint)
                            .await?;
                    account.request(route,Some(json!({"deviceId":scope.device_id,"keyFingerprint":fingerprint,"expectedKeyGeneration":scope.key_generation,"challengeId":proof.0,"proof":proof.1}))).await
                };
            let revoke = request(
                "revoke",
                crate::space_cloud::agent_network::AccountOperation::Revoke,
            )
            .await;
            let confirmed = match revoke {
                Ok(value) => value["revoked"] == true,
                Err(_) => request(
                    "revoke-query",
                    crate::space_cloud::agent_network::AccountOperation::RevokeState,
                )
                .await
                .is_ok_and(|v| v["revoked"] == true),
            };
            if !confirmed {
                return Err(NetworkError::new("NETWORK_REMOVAL_UNCONFIRMED"));
            }

            scope
        };
        let already_confirmed = cleanup_checkpoint(&stored).is_some();
        let previous_scope = stored.revoked_scope.clone();
        for c in &mut next {
            if c.id == id {
                c.revoked_scope = Some(scope.clone());
                c.reenrolling = false;
            }
        }
        let checkpoint = next.clone();
        let checkpoint_selected = selected.clone();
        next.retain(|c| c.id != id);
        let selected = if selected == id {
            OFFICIAL.into()
        } else {
            selected
        };
        let owner = self.clone();
        tokio::task::spawn_blocking(move || {
            finish_removal(
                || {
                    // Keep the old scope durable until its deletion succeeds,
                    // retaining the current proof key for a network retry.
                    if let Some(previous) =
                        previous_scope.filter(|old| old.key_generation != scope.key_generation)
                    {
                        super::crypto::OsIdentityStore::delete(&previous)?;
                    }
                    if !already_confirmed {
                        persist(checkpoint.clone(), checkpoint_selected)?;
                        *owner.stored.lock().unwrap_or_else(|e| e.into_inner()) = checkpoint;
                    }
                    Ok(())
                },
                || super::crypto::OsIdentityStore::delete(&scope).map_err(NetworkError::from),
                || {
                    persist(next.clone(), selected.clone())?;
                    *owner.stored.lock().unwrap_or_else(|e| e.into_inner()) = next;
                    *owner.selected.lock().unwrap_or_else(|e| e.into_inner()) = selected;
                    Ok(())
                },
            )
        })
        .await
        .map_err(|_| NetworkError::new("NETWORK_CONFIG_WRITE_FAILED"))??;
        self.revision.fetch_add(1, Ordering::AcqRel);
        let _ = app.emit("agent-network:connections-changed", self.view());
        Ok(self.view())
    }
}
/// One removal lifecycle: durable confirmation precedes credential deletion;
/// forgetting config is last. Any failure leaves the previous recovery point.
fn finish_removal(
    confirm: impl FnOnce() -> Result<(), NetworkError>,
    delete: impl FnOnce() -> Result<(), NetworkError>,
    forget: impl FnOnce() -> Result<(), NetworkError>,
) -> Result<(), NetworkError> {
    confirm()?;
    delete()?;
    forget()
}
/// A checkpoint is sufficient without network IO only if no replacement
/// enrollment was subsequently attempted. The same record carries that phase.
fn cleanup_checkpoint(stored: &StoredConnection) -> Option<&super::crypto::KeyScope> {
    if stored.reenrolling {
        None
    } else {
        stored.revoked_scope.as_ref()
    }
}
fn validate_stored(stored: &[StoredConnection]) -> Result<(), NetworkError> {
    let mut ids = std::collections::HashSet::new();
    let mut services = std::collections::HashSet::new();
    let mut origins = std::collections::HashSet::new();
    for c in stored {
        if uuid::Uuid::parse_str(&c.id)
            .map(|id| id.to_string())
            .as_deref()
            != Ok(&c.id)
            || !ids.insert(&c.id)
            || !services.insert(&c.descriptor.service_id)
            || !origins.insert(&c.descriptor.issuer)
        {
            return Err(NetworkError::new("NETWORK_CONFIG_INVALID"));
        }
        if c.reenrolling && (!c.removing || c.revoked_scope.is_none()) {
            return Err(NetworkError::new("NETWORK_CONFIG_INVALID"));
        }
        let origin = super::account::origin(&c.descriptor.issuer)?;
        c.descriptor.validate(&origin)?;
        if let Some(scope) = &c.revoked_scope {
            if !c.removing
                || scope.issuer != c.descriptor.issuer
                || scope.environment != c.descriptor.environment
                || scope.service_id != c.descriptor.service_id
                || scope.principal_id != c.descriptor.principal_id
                || scope.key_generation == 0
                || uuid::Uuid::parse_str(&scope.device_id).is_err()
            {
                return Err(NetworkError::new("NETWORK_CONFIG_INVALID"));
            }
        }
    }
    Ok(())
}
pub(crate) fn start(
    app: tauri::AppHandle,
    owner: ManagedAgentNetwork,
    manager: ManagedSidecarManager,
) {
    for event in ["app:config-changed", "agent:config-changed"] {
        let owner = owner.clone();
        app.listen(event, move |_| {
            for c in owner.all() {
                c.catalog_changed();
            }
        });
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let monitor = super::power::install(app.clone(), owner.clone());
    super::actor::start(app.clone(), owner.official(), manager.clone());
    tauri::async_runtime::spawn(async move {
        let initialization = owner.mutation.lock().await;
        if let Ok(path) = config_path() {
            match tokio::task::spawn_blocking(move || crate::config_io::read_config_json(&path))
                .await
            {
                Ok(Ok(config)) => {
                    match serde_json::from_value::<Vec<StoredConnection>>(
                        config["agentNetworkConnections"]
                            .as_array()
                            .cloned()
                            .map(Value::Array)
                            .unwrap_or_else(|| json!([])),
                    ) {
                        Ok(stored) if validate_stored(&stored).is_ok() => {
                            let selected = config["agentNetworkSelectedConnection"]
                                .as_str()
                                .unwrap_or(OFFICIAL)
                                .to_string();
                            *owner.selected.lock().unwrap_or_else(|e| e.into_inner()) = if selected
                                == OFFICIAL
                                || stored.iter().any(|c| c.id == selected)
                            {
                                selected
                            } else {
                                OFFICIAL.into()
                            };
                            for c in &stored {
                                if !c.removing {
                                    let connector = AgentNetwork::new(
                                        c.id.clone(),
                                        Some(self_account(c, None)),
                                        owner.memory.clone(),
                                    );
                                    owner
                                        .connections
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner())
                                        .insert(c.id.clone(), connector.clone());
                                    super::actor::start(app.clone(), connector, manager.clone());
                                }
                            }
                            *owner.stored.lock().unwrap_or_else(|e| e.into_inner()) = stored;
                            owner.revision.fetch_add(1, Ordering::AcqRel);
                            let _ = app.emit("agent-network:connections-changed", owner.view());
                        }
                        _ => {
                            crate::ulog_warn!(
                                "[agent-network] invalid persisted connection configuration"
                            );
                        }
                    }
                }
                _ => {
                    crate::ulog_warn!(
                        "[agent-network] failed to read persisted connection configuration"
                    );
                }
            }
        }
        drop(initialization);
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let _monitor = match monitor {
            Ok(m) => m,
            Err(_) => {
                owner.power_boundary(&app, true);
                return;
            }
        };
        #[cfg(target_os = "linux")]
        let mut monitor = match super::power::install_linux().await {
            Ok((m, suspended)) => {
                owner.power_boundary(&app, suspended);
                m
            }
            Err(_) => {
                owner.power_boundary(&app, true);
                return;
            }
        };
        #[cfg(target_os = "linux")]
        loop {
            tokio::select! {_=owner.shutdown.notified()=>break,signal=super::power::next(&mut monitor)=>{match signal{Ok(s)=>owner.power_boundary(&app,s),Err(_)=>{owner.power_boundary(&app,true);break;}}}}
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        owner.shutdown.notified().await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revocation_after_active_preflight_has_no_enrollment_capability() {
        // Active existing record has no revocation checkpoint. Even if issuer
        // revokes before initialization, that context cannot enroll a new key.
        assert!(join_enrollment_key(true, false, Zeroizing::new("unconsumed".into())).is_none());
        // Explicit retry may enroll only after the registry checkpoints removal.
        assert!(join_enrollment_key(true, true, Zeroizing::new("retry".into())).is_some());
        assert!(join_enrollment_key(false, false, Zeroizing::new("first".into())).is_some());
    }
    #[test]
    fn replacement_failure_restart_requires_current_revocation_before_cleanup() {
        let record: StoredConnection = serde_json::from_value(json!({
            "id":"00000000-0000-0000-0000-000000000001",
            "descriptor": {"serviceId":"00000000-0000-0000-0000-000000000002",
                "environment":"development", "principalId":"00000000-0000-0000-0000-000000000003",
                "networkId":"00000000-0000-0000-0000-000000000004", "name":"isolated",
                "issuer":"https://isolated.example", "protocol":1, "capabilities":[],
                "rootCertificate":"fixture", "jwks":{}},
            "removing":true, "reenrolling":true,
            "revokedScope":{"issuer":"https://isolated.example", "environment":"development",
                "serviceId":"00000000-0000-0000-0000-000000000002",
                "principalId":"00000000-0000-0000-0000-000000000003",
                "deviceId":"00000000-0000-0000-0000-000000000005", "keyGeneration":1}
        }))
        .unwrap();
        // Both a lost enrollment ACK and failed final config write retain this
        // real persisted phase. Restart must query/prove the current generation.
        let mut restarted: StoredConnection =
            serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(cleanup_checkpoint(&restarted).is_none());
        // After generation 2 is confirmed revoked, cleanup is network-free;
        // deleting its key then failing config save does not trap the next retry.
        restarted.revoked_scope.as_mut().unwrap().key_generation = 2;
        restarted.reenrolling = false;
        let restarted: StoredConnection =
            serde_json::from_slice(&serde_json::to_vec(&restarted).unwrap()).unwrap();
        assert_eq!(cleanup_checkpoint(&restarted).unwrap().key_generation, 2);
    }
    #[test]
    fn two_generation_cleanup_keeps_old_scope_until_old_key_deletion_succeeds() {
        use std::cell::Cell;
        let old_scope = Cell::new(1);
        let current_key = Cell::new(true);
        let forgotten = Cell::new(false);
        assert!(finish_removal(
            // Failure deleting the old, revoked key precedes checkpoint update.
            || Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE")),
            || {
                current_key.set(false);
                Ok(())
            },
            || {
                forgotten.set(true);
                Ok(())
            },
        )
        .is_err());
        assert_eq!(old_scope.get(), 1);
        assert!(current_key.get());
        assert!(!forgotten.get());
        // Retry deletes old key, checkpoints current, then can delete current.
        finish_removal(
            || {
                old_scope.set(2);
                Ok(())
            },
            || {
                current_key.set(false);
                Ok(())
            },
            || {
                forgotten.set(true);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(old_scope.get(), 2);
        assert!(!current_key.get());
        assert!(forgotten.get());
    }
    #[test]
    fn confirmed_removal_retries_each_local_failure_from_the_durable_checkpoint() {
        use std::cell::Cell;
        let confirmed = Cell::new(false);
        let credential = Cell::new(true);
        let forgotten = Cell::new(false);
        let save = || {
            confirmed.set(true);
            Ok(())
        };
        let delete = || {
            credential.set(false);
            Ok(())
        };
        let forget = || {
            forgotten.set(true);
            Ok(())
        };
        assert!(finish_removal(
            || Err(NetworkError::new("NETWORK_CONFIG_WRITE_FAILED")),
            delete,
            forget
        )
        .is_err());
        assert!(!confirmed.get());
        assert!(credential.get());
        assert!(!forgotten.get());
        assert!(finish_removal(
            save,
            || Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE")),
            forget
        )
        .is_err());
        assert!(confirmed.get());
        assert!(credential.get());
        assert!(!forgotten.get());
        assert!(finish_removal(save, delete, || Err(NetworkError::new(
            "NETWORK_CONFIG_WRITE_FAILED"
        )))
        .is_err());
        assert!(confirmed.get());
        assert!(!credential.get());
        assert!(!forgotten.get());
        // Rehydrated confirmed record needs no remote proof or remaining key.
        finish_removal(
            || {
                assert!(confirmed.get());
                Ok(())
            },
            delete,
            forget,
        )
        .unwrap();
        assert!(forgotten.get());
        assert!(!credential.get());
    }
    #[tokio::test]
    async fn three_connectors_share_capacity_and_selection_has_no_transport_authority() {
        let owner = NetworkRegistry::new();
        let a = AgentNetwork::new("a".into(), None, owner.memory_budget());
        let b = AgentNetwork::new("b".into(), None, owner.memory_budget());
        owner
            .connections
            .lock()
            .unwrap()
            .insert("a".into(), a.clone());
        owner
            .connections
            .lock()
            .unwrap()
            .insert("b".into(), b.clone());
        let official = owner.official();
        let payload = "x".repeat(1024 * 1024);
        let mut leases = Vec::new();
        let connectors = [official.clone(), a.clone(), b.clone()];
        loop {
            let connection = &connectors[leases.len() % 3];
            match connection.reserve_payload(&payload) {
                Ok(lease) => leases.push(lease),
                Err(error) => {
                    assert_eq!(error.code, "CONNECTOR_CAPACITY");
                    break;
                }
            }
        }
        assert!(!leases.is_empty());
        *owner.selected.lock().unwrap() = "b".into();
        assert_eq!(a.generation(), 0);
        assert_eq!(official.generation(), 0);
        a.deactivate();
        assert_ne!(a.generation(), 0);
        assert_eq!(b.generation(), 0);
        assert_eq!(official.generation(), 0);
        drop(leases);
        assert!(b.reserve_payload(&payload).is_ok());
    }
    #[tokio::test]
    async fn replacement_actor_never_reuses_old_authority_generation() {
        let old = AgentNetwork::new("same".into(), None, MemoryBudget::default());
        old.deactivate();
        let seed = old.snapshot().auth_generation + 1;
        let next =
            AgentNetwork::with_generation("same".into(), None, MemoryBudget::default(), seed);
        assert!(next.snapshot().auth_generation > old.snapshot().auth_generation);
        assert_ne!(next.generation(), 0);
    }
}
