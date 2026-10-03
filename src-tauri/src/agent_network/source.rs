//! Fixed Node Host → App entry. Host provenance is supplied only after the
//! existing CLI capability gate; source Session identity comes from the live
//! Sidecar generation, never from query parameters or a remote device.
use super::{actor::ManagedAgentNetwork, catalog::read_local_catalog, NetworkError};
use crate::sidecar::ManagedSidecarManager;
use myagents_agent_network_protocol::{SourceRequest, VerifiedCaller};
use serde::Deserialize;
use std::time::Instant;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InvokeRequest {
    pub sidecar_id: String,
    pub source_kind: SourceKind,
    pub request: SourceRequest,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SourceKind {
    InternalSession,
    ExternalCli,
}

pub(crate) async fn invoke(
    owner: &ManagedAgentNetwork,
    manager: &ManagedSidecarManager,
    generation: u64,
    input: InvokeRequest,
    queued_at: Instant,
) -> Result<super::calls::CallResult, NetworkError> {
    // Account for the query during original source identity/catalog preparation,
    // not only after it reaches the connector command queue.
    let allocation = owner.reserve_payload(&input.request)?;
    let request = input.request;
    let network_generation = owner.generation();
    let live_source = {
        let manager = manager
            .lock()
            .map_err(|_| NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?;
        if !manager.is_live_process(&input.sidecar_id, generation) {
            return Err(NetworkError::new("SOURCE_GENERATION_CHANGED"));
        }
        match input.source_kind {
            SourceKind::ExternalCli => None,
            SourceKind::InternalSession => Some(
                manager
                    .resolve_session_process_source(&input.sidecar_id, generation)
                    .ok_or_else(|| NetworkError::new("SOURCE_SESSION_REQUIRED"))?,
            ),
        }
    };
    let caller = if let Some(source) = live_source {
        let catalog = read_local_catalog(manager).await?;
        let path = crate::cron_task::normalize_path(&source.workspace_path.to_string_lossy());
        let mut identities = catalog.iter().filter(|item| {
            let canonical = std::fs::canonicalize(&item.path)
                .unwrap_or_else(|_| std::path::PathBuf::from(&item.path));
            crate::cron_task::normalize_path(&canonical.to_string_lossy()) == path
        });
        let identity = identities
            .next()
            .ok_or_else(|| NetworkError::new("SOURCE_AGENT_NOT_FOUND"))?;
        if identities.next().is_some() {
            return Err(NetworkError::new("SOURCE_AGENT_IDENTITY_CONFLICT"));
        }
        let current = manager
            .lock()
            .map_err(|_| NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?
            .resolve_session_process_source(&input.sidecar_id, generation)
            .ok_or_else(|| NetworkError::new("SOURCE_GENERATION_CHANGED"))?;
        if current.product_session_id != source.product_session_id
            || current.workspace_path != source.workspace_path
        {
            return Err(NetworkError::new("SOURCE_GENERATION_CHANGED"));
        }
        VerifiedCaller::Internal {
            source_session_id: current.product_session_id,
            source_agent_id: identity.local_agent_id.clone(),
            label: identity.name.chars().take(320).collect(),
        }
    } else {
        VerifiedCaller::External {
            label: "External CLI".into(),
        }
    };
    // Catalog preparation cannot reset either the deadline or auth generation.
    if !manager
        .lock()
        .map_err(|_| NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?
        .is_live_process(&input.sidecar_id, generation)
    {
        return Err(NetworkError::new("SOURCE_GENERATION_CHANGED"));
    }
    owner
        .invoke(request, caller, queued_at, network_generation, allocation)
        .await
}

pub(crate) async fn return_event(
    owner: &ManagedAgentNetwork,
    manager: &ManagedSidecarManager,
    generation: u64,
    input: super::returns::CallbackRequest,
) -> Result<myagents_agent_network_protocol::ReturnSettlement, NetworkError> {
    let source = {
        let state = manager
            .lock()
            .map_err(|_| NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?;
        state
            .resolve_session_process_source(&input.sidecar_id, generation)
            .ok_or_else(|| NetworkError::new("SOURCE_GENERATION_CHANGED"))?
    };
    if input.event["sourceSessionId"] != source.product_session_id {
        return Err(NetworkError::new("RETURN_SESSION_SCOPE_MISMATCH"));
    }
    owner
        .return_event(source.product_session_id, input.reference, input.event)
        .await
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WatchesRequest {
    pub sidecar_id: String,
    pub cancel: Option<String>,
    #[serde(default)] pub all: bool,
}
pub(crate) async fn watches(owner:&ManagedAgentNetwork, manager:&ManagedSidecarManager, generation:u64, input:WatchesRequest) -> Result<serde_json::Value,NetworkError> {
    if input.all && input.cancel.is_some() { return Err(NetworkError::new("NETWORK_ARGUMENT_INVALID")); }
    let network_generation=owner.generation();
    let source=manager.lock().map_err(|_|NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?
        .resolve_session_process_source(&input.sidecar_id,generation)
        .ok_or_else(||NetworkError::new("SOURCE_SESSION_REQUIRED"))?;
    let mut result=owner.watches(source.product_session_id.clone(),input.cancel.clone(),input.all,network_generation).await?;
    let local=crate::inbox::watch::manage_local_watches(manager,&source.product_session_id,input.cancel.as_deref(),input.all).await?;
    result["watches"].as_array_mut().expect("owner projection").extend(local);
    if !manager.lock().map_err(|_|NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?.is_live_process(&input.sidecar_id,generation) {
        return Err(NetworkError::new("SOURCE_GENERATION_CHANGED"));
    }
    Ok(result)
}
