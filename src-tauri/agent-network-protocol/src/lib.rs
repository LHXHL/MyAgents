//! Neutral v1 transport codec. The verified artifact JSON Schemas validate all
//! incoming data before typed dispatch; validation errors never print payloads.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;
mod control;
pub use control::*;
mod business;
pub use business::*;
mod request;
pub use request::*;

static BUDGETS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        concat!(env!("OUT_DIR"), "/schemas/budgets.json")
    ))
    .expect("artifact protocol budgets")
});

pub fn budget(key: &str) -> usize {
    BUDGETS[key].as_u64().expect("known budget") as usize
}

pub fn remote_deadline(method: &str, layer: &str) -> Option<u64> {
    BUDGETS["remoteDeadlines"][method][layer].as_u64()
}

macro_rules! validator {
    ($name:ident, $file:expr) => {
        static $name: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
            let schema: Value =
                serde_json::from_str(include_str!($file)).expect("protocol schema JSON");
            jsonschema::validator_for(&schema).expect("valid built-in protocol schema")
        });
    };
}
validator!(
    BUSINESS,
    concat!(env!("OUT_DIR"), "/schemas/business.json")
);
validator!(SOURCE_REQUEST, concat!(env!("OUT_DIR"), "/schemas/sourceRequest.json"));
validator!(
    CONTROL,
    concat!(env!("OUT_DIR"), "/schemas/clientControl.json")
);
validator!(
    CATALOG,
    concat!(env!("OUT_DIR"), "/schemas/catalog.json")
);
validator!(
    PEER,
    concat!(env!("OUT_DIR"), "/schemas/peerBinding.json")
);
validator!(
    SERVER_CONTROL,
    concat!(env!("OUT_DIR"), "/schemas/serverControl.json")
);
validator!(
    ACCESS,
    concat!(env!("OUT_DIR"), "/schemas/accessClaims.json")
);
validator!(
    BOOTSTRAP,
    concat!(env!("OUT_DIR"), "/schemas/bootstrapClaims.json")
);
validator!(
    SIGNED_PEER,
    concat!(env!("OUT_DIR"), "/schemas/signedPeerClaims.json")
);
validator!(
    IDENTITY_STATE,
    concat!(env!("OUT_DIR"), "/schemas/identityState.json")
);

validator!(
    MEMBERSHIP_MUTATION,
    concat!(env!("OUT_DIR"), "/schemas/membershipMutation.json")
);
validator!(
    MOUNT_MUTATION,
    concat!(env!("OUT_DIR"), "/schemas/mountMutation.json")
);
validator!(DEVICE_NAME_MUTATION, concat!(env!("OUT_DIR"), "/schemas/deviceNameMutation.json"));
pub fn validate_device_name_mutation(value: &Value) -> Result<(), ProtocolError> {
    // JSON Schema maxLength counts code points; the shared TS contract counts
    // UTF-16 units. Keep supplementary characters inside the same UI budget.
    if DEVICE_NAME_MUTATION.is_valid(value)
        && value["name"].as_str().is_some_and(|name| name.encode_utf16().count() <= 160)
    {
        Ok(())
    } else {
        Err(ProtocolError("MUTATION_INVALID"))
    }
}
pub fn validate_mutation(membership: bool, value: &Value) -> Result<(), ProtocolError> {
    let validator = if membership {
        &*MEMBERSHIP_MUTATION
    } else {
        &*MOUNT_MUTATION
    };
    if validator.is_valid(value) {
        Ok(())
    } else {
        Err(ProtocolError("MUTATION_INVALID"))
    }
}

pub fn validate_server_control(value: &Value) -> Result<(), ProtocolError> {
    if SERVER_CONTROL.is_valid(value) {
        Ok(())
    } else {
        Err(ProtocolError("CONTROL_INVALID"))
    }
}
pub fn validate_access(value: &Value) -> Result<(), ProtocolError> {
    if ACCESS.is_valid(value) {
        Ok(())
    } else {
        Err(ProtocolError("NETWORK_TOKEN_INVALID"))
    }
}
pub fn validate_bootstrap(value: &Value) -> Result<(), ProtocolError> {
    if BOOTSTRAP.is_valid(value) {
        Ok(())
    } else {
        Err(ProtocolError("NETWORK_BOOTSTRAP_INVALID"))
    }
}
pub fn validate_signed_peer(value: &Value) -> Result<(), ProtocolError> {
    if SIGNED_PEER.is_valid(value) {
        Ok(())
    } else {
        Err(ProtocolError("PEER_BINDING_INVALID"))
    }
}
pub fn validate_identity_state(value: &Value) -> Result<(), ProtocolError> {
    if IDENTITY_STATE.is_valid(value) {
        Ok(())
    } else {
        Err(ProtocolError("IDENTITY_STATE_INVALID"))
    }
}

validator!(
    METADATA_NETWORK,
    concat!(env!("OUT_DIR"), "/schemas/metadata-network.json")
);
validator!(
    METADATA_DEVICES,
    concat!(env!("OUT_DIR"), "/schemas/metadata-devices.json")
);
validator!(
    METADATA_AGENTS,
    concat!(env!("OUT_DIR"), "/schemas/metadata-agents.json")
);
validator!(
    METADATA_CALLABLE,
    concat!(env!("OUT_DIR"), "/schemas/metadata-callable.json")
);
validator!(METADATA_CALLABLE_AGENT, concat!(env!("OUT_DIR"), "/schemas/metadata-callableAgent.json"));
validator!(
    METADATA_MEMBERSHIP,
    concat!(env!("OUT_DIR"), "/schemas/metadata-membership.json")
);
validator!(
    METADATA_MOUNT,
    concat!(env!("OUT_DIR"), "/schemas/metadata-mount.json")
);
validator!(
    METADATA_CATALOG,
    concat!(env!("OUT_DIR"), "/schemas/metadata-catalog.json")
);
validator!(
    METADATA_RECEIPT,
    concat!(env!("OUT_DIR"), "/schemas/metadata-receipt.json")
);
validator!(METADATA_DEVICE_NAME, concat!(env!("OUT_DIR"), "/schemas/metadata-deviceName.json"));

#[derive(Clone, Copy)]
pub enum MetadataKind {
    Network,
    Devices,
    Agents,
    Callable,
    CallableAgent,
    Membership,
    Mount,
    Catalog,
    Receipt,
    DeviceName,
}
pub fn validate_metadata(kind: MetadataKind, value: &Value) -> Result<(), ProtocolError> {
    let validator = match kind {
        MetadataKind::Network => &*METADATA_NETWORK,
        MetadataKind::Devices => &*METADATA_DEVICES,
        MetadataKind::Agents => &*METADATA_AGENTS,
        MetadataKind::Callable => &*METADATA_CALLABLE,
        MetadataKind::CallableAgent => &*METADATA_CALLABLE_AGENT,
        MetadataKind::Membership => &*METADATA_MEMBERSHIP,
        MetadataKind::Mount => &*METADATA_MOUNT,
        MetadataKind::Catalog => &*METADATA_CATALOG,
        MetadataKind::Receipt => &*METADATA_RECEIPT,
        MetadataKind::DeviceName => &*METADATA_DEVICE_NAME,
    };
    if validator.is_valid(value) {
        Ok(())
    } else {
        Err(ProtocolError("NETWORK_RESPONSE_INVALID"))
    }
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerBinding {
    pub service_id: String,
    pub environment: String,
    pub principal_id: String,
    pub device_id: String,
    pub key_generation: u64,
    pub identity_binding_id: String,
    pub certificate_fingerprint: String,
    pub san: String,
    pub certificate: String,
    pub expires_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityState {
    pub service_id: String,
    pub environment: String,
    pub device_id: String,
    pub key_generation: Option<u64>,
    pub key_fingerprint: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogItem {
    pub local_agent_id: String,
    pub local_workspace_id: String,
    pub name: String,
    pub path: String,
    pub lifecycle: CatalogLifecycle,
    pub exposure_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogLifecycle {
    Active,
    Archived,
    Removed,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSnapshot {
    pub version: u8,
    pub connection_epoch: String,
    pub catalog_seq: u64,
    pub items: Vec<CatalogItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError(pub &'static str);
impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ProtocolError {}

fn uuid(value: &str) -> Result<String, ProtocolError> {
    let id = uuid::Uuid::parse_str(value).map_err(|_| ProtocolError("INVALID_REFERENCE"))?;
    if id.to_string() != value {
        return Err(ProtocolError("INVALID_REFERENCE"));
    }
    Ok(value.to_owned())
}

pub fn valid_local_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 100
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentReference {
    pub service_id: String,
    pub network_id: String,
    pub mount_id: String,
}
impl AgentReference {
    pub fn parse(value: &str) -> Result<Self, ProtocolError> {
        let p: Vec<_> = value.split(':').collect();
        if p.len() != 5 || p[0] != "ma-agent" || p[1] != "1" {
            return Err(ProtocolError("INVALID_REFERENCE"));
        }
        Ok(Self {
            service_id: uuid(p[2])?,
            network_id: uuid(p[3])?,
            mount_id: uuid(p[4])?,
        })
    }
    pub fn encode(&self) -> Result<String, ProtocolError> {
        Ok(format!(
            "ma-agent:1:{}:{}:{}",
            uuid(&self.service_id)?,
            uuid(&self.network_id)?,
            uuid(&self.mount_id)?
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionReference {
    pub agent: AgentReference,
    pub local_session_id: String,
}
impl SessionReference {
    pub fn parse(value: &str) -> Result<Self, ProtocolError> {
        let p: Vec<_> = value.split(':').collect();
        if p.len() != 6 || p[0] != "ma-session" || p[1] != "1" {
            return Err(ProtocolError("INVALID_REFERENCE"));
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(p[5])
            .map_err(|_| ProtocolError("INVALID_REFERENCE"))?;
        let local_session_id =
            String::from_utf8(bytes).map_err(|_| ProtocolError("INVALID_REFERENCE"))?;
        let result = Self {
            agent: AgentReference {
                service_id: uuid(p[2])?,
                network_id: uuid(p[3])?,
                mount_id: uuid(p[4])?,
            },
            local_session_id,
        };
        if result.encode()? != value {
            return Err(ProtocolError("INVALID_REFERENCE"));
        }
        Ok(result)
    }
    pub fn encode(&self) -> Result<String, ProtocolError> {
        if !valid_local_session_id(&self.local_session_id) {
            return Err(ProtocolError("INVALID_REFERENCE"));
        }
        Ok(format!(
            "ma-session:1:{}:{}:{}:{}",
            uuid(&self.agent.service_id)?,
            uuid(&self.agent.network_id)?,
            uuid(&self.agent.mount_id)?,
            URL_SAFE_NO_PAD.encode(&self.local_session_id)
        ))
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceScope {
    pub service_id: String,
    pub environment: String,
    pub network_id: String,
    pub principal_id: String,
    pub device_id: String,
    pub key_generation: u64,
}

pub fn validate_business(value: &Value) -> Result<(), ProtocolError> {
    if !BUSINESS.is_valid(value) {
        return Err(ProtocolError("PROTOCOL_INVALID"));
    }
    if value["kind"] == "invoke"
        && value["caller"]["kind"] == "external-cli"
        && (value.get("returnRouteId").is_some()
            || value["method"] == "session.watch"
            || value["params"]["replyBack"] == true)
    {
        return Err(ProtocolError("EXTERNAL_CLI_CAPABILITY_NOT_OPEN"));
    }
    Ok(())
}
pub fn validate_control(value: &Value) -> Result<(), ProtocolError> {
    if CONTROL.is_valid(value) {
        Ok(())
    } else {
        Err(ProtocolError("PROTOCOL_INVALID"))
    }
}
pub fn validate_catalog(value: &Value) -> Result<(), ProtocolError> {
    if CATALOG.is_valid(value) {
        Ok(())
    } else {
        Err(ProtocolError("PROTOCOL_INVALID"))
    }
}
pub fn validate_peer(value: &Value) -> Result<(), ProtocolError> {
    if PEER.is_valid(value) {
        Ok(())
    } else {
        Err(ProtocolError("PROTOCOL_INVALID"))
    }
}

pub fn encode_tls_frame(channel_id: &str, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    uuid(channel_id)?;
    if payload.is_empty() || payload.len() > budget("tlsChunkBytes") {
        return Err(ProtocolError("MESSAGE_TOO_LARGE"));
    }
    let channel = uuid::Uuid::parse_str(channel_id).map_err(|_| ProtocolError("INVALID_FRAME"))?;
    let mut frame = Vec::with_capacity(22 + payload.len());
    frame.extend_from_slice(&[1, 1]);
    frame.extend_from_slice(channel.as_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}
pub fn decode_tls_frame(frame: &[u8]) -> Result<(String, &[u8]), ProtocolError> {
    if frame.len() <= 22 || frame[0] != 1 || frame[1] != 1 {
        return Err(ProtocolError("INVALID_FRAME"));
    }
    let length = u32::from_be_bytes(
        frame[18..22]
            .try_into()
            .map_err(|_| ProtocolError("INVALID_FRAME"))?,
    ) as usize;
    if length == 0 || length > budget("tlsChunkBytes") || length != frame.len() - 22 {
        return Err(ProtocolError("INVALID_FRAME"));
    }
    let id = uuid::Uuid::from_slice(&frame[2..18]).map_err(|_| ProtocolError("INVALID_FRAME"))?;
    Ok((id.to_string(), &frame[22..]))
}

pub fn encode_object(value: &Value) -> Result<Vec<u8>, ProtocolError> {
    validate_business(value)?;
    let body = serde_json::to_vec(value).map_err(|_| ProtocolError("PROTOCOL_INVALID"))?;
    if body.len() > budget("objectBytes") {
        return Err(ProtocolError("MESSAGE_TOO_LARGE"));
    }
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// A caller supplies bounded TLS plaintext chunks. Prefix and body may span
/// arbitrarily many records; no object is exposed until fully validated.
#[derive(Default)]
pub struct ObjectDecoder {
    bytes: Vec<u8>,
}
impl ObjectDecoder {
    pub fn buffered_bytes(&self) -> usize {
        self.bytes.capacity()
    }
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, ProtocolError> {
        if chunk.len() > budget("receiveBytes").saturating_sub(self.bytes.len()) {
            return Err(ProtocolError("RESOURCE_EXHAUSTED"));
        }
        self.bytes.try_reserve_exact(chunk.len()).map_err(|_| ProtocolError("RESOURCE_EXHAUSTED"))?;
        self.bytes.extend_from_slice(chunk);
        let mut objects = Vec::new();
        let mut consumed = 0;
        while self.bytes.len() - consumed >= 4 {
            let size = u32::from_be_bytes(
                self.bytes[consumed..consumed + 4]
                    .try_into()
                    .expect("four bytes"),
            ) as usize;
            if size == 0 || size > budget("objectBytes") {
                return Err(ProtocolError("MESSAGE_TOO_LARGE"));
            }
            if self.bytes.len() - consumed < size + 4 {
                break;
            }
            let object: Value =
                serde_json::from_slice(&self.bytes[consumed + 4..consumed + 4 + size])
                    .map_err(|_| ProtocolError("PROTOCOL_INVALID"))?;
            validate_business(&object)?;
            objects.push(object);
            consumed += size + 4;
        }
        if consumed != 0 {
            // A completed large object must release its backing allocation;
            // sixteen idle channels cannot retain sixteen invisible 16MiB slabs.
            self.bytes = self.bytes[consumed..].to_vec();
        }
        Ok(objects)
    }
}

/// Retained by the device-pair/connection-epoch owner across idle TLS channel
/// recreation. Advance synchronously before dispatch awaits; never reset at TTL.
#[derive(Default)]
pub struct ReceiveSequence {
    high_water: u64,
}
impl ReceiveSequence {
    pub fn observe(&mut self, sequence: u64) -> Result<(), ProtocolError> {
        if sequence == 0 || sequence > 9_007_199_254_740_991 || sequence <= self.high_water {
            return Err(ProtocolError("DUPLICATE_OBJECT"));
        }
        self.high_water = sequence;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn catalog_icon_names_and_legacy_catalogs_are_supported() {
        let mut value = json!({"version":1,"connectionEpoch":"11111111-1111-4111-8111-111111111111","catalogSeq":1,
            "items":[{"localAgentId":"agent","localWorkspaceId":"workspace","name":"Agent","path":"/workspace","lifecycle":"active","exposureRevision":0}]});
        validate_catalog(&value).unwrap();
        let old: CatalogSnapshot = serde_json::from_value(value.clone()).unwrap();
        assert!(old.items[0].icon.is_none());
        value["items"][0]["icon"] = json!("lightning");
        validate_catalog(&value).unwrap();
        let current: CatalogSnapshot = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(current.items[0].icon.as_deref(), Some("lightning"));
        assert_eq!(serde_json::to_value(current).unwrap(), value);
        value["items"][0]["icon"] = json!("x".repeat(257));
        assert!(validate_catalog(&value).is_err());
    }

    #[test]
    fn reference_roundtrip_and_path_rejection() {
        let agent = AgentReference::parse("ma-agent:1:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333").unwrap();
        let session = SessionReference {
            agent,
            local_session_id: "session-123-ABC".to_owned(),
        };
        assert_eq!(
            SessionReference::parse(&session.encode().unwrap()).unwrap(),
            session
        );
        assert!(SessionReference::parse(&(session.encode().unwrap() + "=")).is_err());
        assert!(!valid_local_session_id("../secrets"));
    }
    #[test]
    fn partial_object_is_not_dispatched_and_invalid_json_is_rejected() {
        let value = json!({"version":1,"kind":"return-ack","opId":"11111111-1111-4111-8111-111111111111","senderSequence":1,
            "returnRouteId":"22222222-2222-4222-8222-222222222222","eventId":"33333333-3333-4333-8333-333333333333","settlement":"delivered"});
        let frame = encode_object(&value).unwrap();
        let mut decoder = ObjectDecoder::default();
        for chunk in frame[..frame.len() - 1].chunks(3) {
            assert!(decoder.push(chunk).unwrap().is_empty());
        }
        assert_eq!(
            decoder.push(&frame[frame.len() - 1..]).unwrap(),
            vec![value]
        );
        assert_eq!(decoder.buffered_bytes(), 0);
        assert!(decoder.push(&[0xff, 0xff, 0xff, 0xff]).is_err());
    }
    #[test]
    fn large_completed_objects_release_the_receive_allocation() {
        let value = json!({"version":1,"kind":"response","opId":"11111111-1111-4111-8111-111111111111",
            "requestId":"22222222-2222-4222-8222-222222222222","senderSequence":1,
            "outcome":{"method":"session.get","result":{"id":"session-a","messages":[
                {"id":"message-a","role":"assistant","timestamp":"now","content":"x".repeat(1_048_576)}],
                "hasMoreBefore":false,"isLive":false,"liveSessionState":null,"snapshotRevision":1}}});
        let frame = encode_object(&value).unwrap();
        let mut decoder = ObjectDecoder::default();
        assert!(decoder.push(&frame[..frame.len() - 1]).unwrap().is_empty());
        assert!(decoder.buffered_bytes() >= 1_048_576);
        assert_eq!(decoder.push(&frame[frame.len() - 1..]).unwrap().len(), 1);
        assert_eq!(decoder.buffered_bytes(), 0);
    }
    #[test]
    fn sequence_survives_receipt_expiry_and_rejects_replay_before_async_dispatch() {
        let mut state = ReceiveSequence::default();
        state.observe(1).unwrap();
        state.observe(4).unwrap();
        assert!(state.observe(1).is_err());
        assert!(state.observe(4).is_err());
        assert!(state.observe(9_007_199_254_740_992).is_err());
        state.observe(5).unwrap();
    }
    #[test]
    fn frame_roundtrip_and_strict_scope() {
        let id = "11111111-1111-4111-8111-111111111111";
        let frame = encode_tls_frame(id, b"ciphertext").unwrap();
        assert_eq!(
            decode_tls_frame(&frame).unwrap(),
            (id.to_owned(), b"ciphertext".as_slice())
        );
        assert!(decode_tls_frame(&frame[..frame.len() - 1]).is_err());
        assert!(validate_control(&json!({"version":1,"type":"hello","controlId":id,"clientVersion":"0.4.23","capabilities":[],"userId":"forged"})).is_err());
    }
}
