//! Local facts come exclusively from the existing persisted identity projection.
//! Failed/partial reads must never be published as an authoritative empty catalog.
use super::NetworkError;
use crate::sidecar::ManagedSidecarManager;
use myagents_agent_network_protocol::{budget, CatalogItem};
use serde::Deserialize;
use std::time::Duration;

pub(crate) async fn read_local_catalog(
    manager: &ManagedSidecarManager,
) -> Result<Vec<CatalogItem>, NetworkError> {
    let dispatch = manager
        .lock()
        .map_err(|_| NetworkError::new("NETWORK_CATALOG_UNAVAILABLE"))?
        .acquire_global_dispatch()
        .map_err(|_| NetworkError::new("NETWORK_CATALOG_UNAVAILABLE"))?;
    let mut response = crate::local_http::json_client(Duration::from_secs(15))
        .post(
            dispatch
                .url_for_path("/api/admin/agent/network-catalog")
                .map_err(|_| NetworkError::new("NETWORK_CATALOG_UNAVAILABLE"))?,
        )
        .header(
            crate::external_cli::INTERNAL_TOKEN_HEADER,
            crate::external_cli::internal_token(),
        )
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| NetworkError::new("NETWORK_CATALOG_UNAVAILABLE"))?;
    if !response.status().is_success() {
        return Err(NetworkError::new("NETWORK_CATALOG_UNAVAILABLE"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| NetworkError::new("NETWORK_CATALOG_UNAVAILABLE"))?
    {
        if bytes.len() + chunk.len() > budget("catalogBytes") {
            return Err(NetworkError::new("NETWORK_CATALOG_TOO_LARGE"));
        }
        bytes.extend_from_slice(&chunk);
    }
    #[derive(Deserialize)]
    struct Envelope {
        success: bool,
        data: Option<Data>,
    }
    #[derive(Deserialize)]
    struct Data {
        items: Vec<CatalogItem>,
    }
    let result: Envelope =
        serde_json::from_slice(&bytes).map_err(|_| NetworkError::new("NETWORK_CATALOG_INVALID"))?;
    if !result.success {
        return Err(NetworkError::new("NETWORK_CATALOG_UNAVAILABLE"));
    }
    let items = result
        .data
        .ok_or_else(|| NetworkError::new("NETWORK_CATALOG_INVALID"))?
        .items;
    if items.len() > budget("catalogItems") {
        return Err(NetworkError::new("NETWORK_CATALOG_TOO_LARGE"));
    }
    // The generation lease survives through response body validation.
    drop(dispatch);
    Ok(items)
}
