//! Read-only projection of relay desired state. The relay remains the authority;
//! these revisions are preconditions for a fresh final permit, never permission.
use super::transport::{NetworkRoute, NetworkTransport};
use super::NetworkError;
use myagents_agent_network_protocol::{budget, DeviceScope};
use serde_json::Value;
use std::collections::HashMap;

pub(crate) struct MountPolicy {
    pub agent_id: String,
    pub enabled: bool,
    pub enable_revision: u64,
}
pub(crate) struct LocalPolicy {
    pub joined: bool,
    pub membership_revision: u64,
    pub mounts: HashMap<String, MountPolicy>,
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, NetworkError> {
    value[key]
        .as_str()
        .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))
}
fn revision(value: &Value, key: &str) -> Result<u64, NetworkError> {
    value[key]
        .as_u64()
        .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))
}
pub(crate) async fn hydrate(
    transport: &NetworkTransport,
    token: &str,
    local: &DeviceScope,
) -> Result<LocalPolicy, NetworkError> {
    let mut cursor = None::<String>;
    let mut scanned = 0;
    let device = loop {
        let page = transport
            .json(
                NetworkRoute::Devices {
                    cursor: cursor.as_deref(),
                    limit: budget("pageMax"),
                },
                token,
                None,
            )
            .await?;
        let items = page["items"]
            .as_array()
            .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?;
        scanned += items.len();
        if let Some(device) = items
            .iter()
            .find(|item| item["deviceId"] == local.device_id)
        {
            break device.clone();
        }
        if page["complete"] == true {
            return Err(NetworkError::new("DEVICE_NOT_REGISTERED"));
        }
        if scanned >= budget("catalogItems") {
            return Err(NetworkError::new("CATALOG_CAPACITY"));
        }
        let next = text(&page, "nextCursor")?.to_owned();
        if cursor.as_ref() == Some(&next) {
            return Err(NetworkError::new("NETWORK_PAGE_INVALID"));
        }
        cursor = Some(next);
    };
    if text(&device, "principalId")? != local.principal_id
        || text(&device, "networkId")? != local.network_id
    {
        return Err(NetworkError::new("NETWORK_METADATA_SCOPE_MISMATCH"));
    }
    let joined = device["joined"]
        .as_bool()
        .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?;
    let membership_revision = revision(&device, "membershipRevision")?;
    let mut mounts = HashMap::new();
    cursor = None;
    loop {
        let page = transport
            .json(
                NetworkRoute::Agents {
                    device_id: &local.device_id,
                    cursor: cursor.as_deref(),
                    limit: budget("pageMax"),
                },
                token,
                None,
            )
            .await?;
        for item in page["items"]
            .as_array()
            .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?
        {
            if text(item, "principalId")? != local.principal_id
                || text(item, "deviceId")? != local.device_id
                || text(item, "networkId")? != local.network_id
            {
                return Err(NetworkError::new("NETWORK_METADATA_SCOPE_MISMATCH"));
            }
            let policy = MountPolicy {
                agent_id: text(item, "localAgentId")?.into(),
                enabled: item["enabled"]
                    .as_bool()
                    .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?,
                enable_revision: revision(item, "enableRevision")?,
            };
            if mounts
                .insert(text(item, "mountId")?.into(), policy)
                .is_some()
            {
                return Err(NetworkError::new("NETWORK_PAGE_INVALID"));
            }
        }
        if page["complete"] == true {
            break;
        }
        if mounts.len() >= budget("catalogItems") {
            return Err(NetworkError::new("CATALOG_CAPACITY"));
        }
        let next = text(&page, "nextCursor")?.to_owned();
        if cursor.as_ref() == Some(&next) {
            return Err(NetworkError::new("NETWORK_PAGE_INVALID"));
        }
        cursor = Some(next);
    }
    Ok(LocalPolicy {
        joined,
        membership_revision,
        mounts,
    })
}
