//! Renderer requests contain only network metadata. The App actor holds all
//! credentials; no request may choose an account origin or arbitrary HTTP route.
use super::transport::NetworkRoute;
use super::NetworkError;
use myagents_agent_network_protocol::budget;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum MetadataRequest {
    Network,
    Devices {
        cursor: Option<String>,
        limit: usize,
    },
    Agents {
        device_id: String,
        cursor: Option<String>,
        limit: usize,
    },
    Callable {
        network_id: String,
        cursor: Option<String>,
        limit: usize,
    },
    Membership {
        network_id: String,
        device_id: String,
        joined: bool,
        mutation_id: String,
        expected_membership_revision: u64,
    },
    Enabled {
        network_id: String,
        mount_id: String,
        enabled: bool,
        mutation_id: String,
        expected_membership_revision: u64,
        expected_enable_revision: u64,
    },
    Description {
        network_id: String,
        mount_id: String,
        description: Option<String>,
        mutation_id: String,
        expected_membership_revision: u64,
        expected_description_revision: u64,
    },
    Receipt {
        mutation_id: String,
    },
}
impl MetadataRequest {
    pub(crate) fn route(&self) -> NetworkRoute<'_> {
        match self {
            Self::Network => NetworkRoute::Network,
            Self::Devices { cursor, limit } => NetworkRoute::Devices {
                cursor: cursor.as_deref(),
                limit: *limit,
            },
            Self::Agents {
                device_id,
                cursor,
                limit,
            } => NetworkRoute::Agents {
                device_id,
                cursor: cursor.as_deref(),
                limit: *limit,
            },
            Self::Callable {
                network_id,
                cursor,
                limit,
            } => NetworkRoute::Callable {
                network_id,
                cursor: cursor.as_deref(),
                limit: *limit,
            },
            Self::Membership {
                network_id,
                device_id,
                joined,
                ..
            } => NetworkRoute::Membership {
                network_id,
                device_id,
                joined: *joined,
            },
            Self::Enabled {
                network_id,
                mount_id,
                ..
            }
            | Self::Description {
                network_id,
                mount_id,
                ..
            } => NetworkRoute::Mount {
                network_id,
                mount_id,
            },
            Self::Receipt { mutation_id } => NetworkRoute::Receipt { mutation_id },
        }
    }
    pub(crate) fn body(&self) -> Result<Option<Value>, NetworkError> {
        let value = match self {
            Self::Membership {
                mutation_id,
                expected_membership_revision,
                ..
            } => Some(json!({"mutationId":mutation_id,
                "expectedMembershipRevision":expected_membership_revision})),
            Self::Enabled {
                mutation_id,
                expected_membership_revision,
                expected_enable_revision,
                enabled,
                ..
            } => Some(json!({
                "mutationId":mutation_id,"expectedMembershipRevision":expected_membership_revision,
                "expectedEnableRevision":expected_enable_revision,"enabled":enabled})),
            Self::Description {
                mutation_id,
                expected_membership_revision,
                expected_description_revision,
                description,
                ..
            } => {
                if description
                    .as_ref()
                    .is_some_and(|value| value.len() > budget("descriptionBytes"))
                {
                    return Err(NetworkError::new("DESCRIPTION_TOO_LARGE"));
                }
                Some(
                    json!({"mutationId":mutation_id,"expectedMembershipRevision":expected_membership_revision,
                    "expectedDescriptionRevision":expected_description_revision,"description":description}),
                )
            }
            Self::Network
            | Self::Devices { .. }
            | Self::Agents { .. }
            | Self::Callable { .. }
            | Self::Receipt { .. } => None,
        };
        if let Some(value) = &value {
            let membership = matches!(self, Self::Membership { .. });
            myagents_agent_network_protocol::validate_mutation(membership, value)
                .map_err(|_| NetworkError::new("MUTATION_INVALID"))?;
        }
        Ok(value)
    }
}
#[tauri::command]
pub(crate) fn cmd_agent_network_snapshot(
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
) -> super::actor::NetworkSnapshot {
    state.snapshot()
}
#[tauri::command]
pub(crate) async fn cmd_agent_network_request(
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    request: MetadataRequest,
) -> Result<Value, NetworkError> {
    state.request(request).await
}

#[tauri::command]
pub(crate) async fn cmd_agent_discovery(
    manager: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
) -> Result<Value, NetworkError> {
    super::local_owner::discovery(&manager).await
}
