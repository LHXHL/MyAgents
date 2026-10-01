//! Fresh bounded online discovery. Partial reads retain their authenticated
//! context for draft scope checks, but never masquerade as a complete directory.
use super::{actor::ManagedAgentNetwork, commands::MetadataRequest, NetworkError};
use myagents_agent_network_protocol::budget;
use serde_json::{json, Value};
use std::collections::HashSet;
use tokio::time::{timeout_at, Duration, Instant};

pub(crate) async fn remote(owner: &ManagedAgentNetwork) -> Result<Value, NetworkError> {
    let snapshot = owner.snapshot();
    let generation = owner.generation();
    let device = crate::device_identity::current_device_identity()
        .map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
    let context = json!({"authGeneration":snapshot.auth_generation,"deviceId":device.device_id,
        "deviceName":device.device_name,"platform":device.platform,
        "networkId":snapshot.network_id,"principalId":snapshot.principal_id});
    if snapshot.state != "ready" {
        return Ok(
            json!({"items":[],"complete":snapshot.state=="signedOut","networkStatus":snapshot.state,"context":context}),
        );
    }
    let network = snapshot
        .network_id
        .ok_or_else(|| NetworkError::new("NETWORK_SCOPE_MISMATCH"))?;
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut cursor = None;
    let mut mounts = HashSet::new();
    let mut cursors = HashSet::new();
    let mut items = Vec::new();
    let mut bytes = 0;
    loop {
        let result = timeout_at(
            deadline,
            owner.request(MetadataRequest::Callable {
                network_id: network.clone(),
                cursor: cursor.clone(),
                limit: budget("pageMax"),
            }),
        )
        .await;
        if owner.generation() != generation
            || owner.snapshot().auth_generation != snapshot.auth_generation
        {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        let page = match result {
            Ok(Ok(page)) => page,
            _ => {
                return Ok(
                    json!({"items":items,"complete":false,"networkStatus":"error","context":context}),
                )
            }
        };
        let entries = page["items"]
            .as_array()
            .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?;
        for entry in entries {
            let mount = entry["mountId"]
                .as_str()
                .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?;
            if !mounts.insert(mount.to_owned()) {
                return Err(NetworkError::new("NETWORK_PAGE_INVALID"));
            }
            if entry["source"]["networkId"] != network {
                return Err(NetworkError::new("NETWORK_SCOPE_MISMATCH"));
            }
            // Peer certificates and live transport credentials belong to the
            // connector. They are not needed by CLI listing or the composer.
            let item = json!({"localAgentId":entry["localAgentId"],"selector":entry["selector"],
                "name":entry["name"],"isLocal":false,"deviceId":entry["deviceId"],
                "deviceName":entry["deviceName"],"platform":entry["platform"],
                "description":entry["description"],"source":entry["source"]});
            bytes += serde_json::to_vec(&item)
                .map_err(|_| NetworkError::new("NETWORK_METADATA_INVALID"))?
                .len();
            if items.len() >= budget("catalogItems") || bytes > budget("catalogBytes") {
                return Ok(
                    json!({"items":items,"complete":false,"networkStatus":"incomplete","context":context}),
                );
            }
            items.push(item);
        }
        if page["complete"] == true {
            return Ok(
                json!({"items":items,"complete":true,"networkStatus":"ready","context":context}),
            );
        }
        let next = page["nextCursor"]
            .as_str()
            .ok_or_else(|| NetworkError::new("NETWORK_PAGE_INVALID"))?;
        if !cursors.insert(next.to_owned()) {
            return Err(NetworkError::new("NETWORK_PAGE_INVALID"));
        }
        cursor = Some(next.into());
    }
}
