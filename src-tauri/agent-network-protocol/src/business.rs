use crate::{validate_business, DeviceScope, ProtocolError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum VerifiedCaller {
    #[serde(rename = "external-cli")]
    External { label: String },
    #[serde(rename = "internal-session")]
    Internal {
        source_session_id: String,
        source_agent_id: String,
        label: String,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentParams {
    pub local_agent_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListParams {
    pub local_agent_id: String,
    pub limit: u16,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetParams {
    pub local_agent_id: String,
    pub local_session_id: String,
    pub limit: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionParams { pub local_agent_id: String, pub local_session_id: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartParams {
    pub local_agent_id: String,
    pub prompt: String,
    pub message_id: String,
    pub reply_back: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendParams {
    pub local_agent_id: String,
    pub local_session_id: String,
    pub prompt: String,
    pub message_id: String,
    pub reply_back: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchParams {
    pub local_agent_id: String,
    pub local_session_id: String,
    pub watch_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum Operation {
    #[serde(rename = "agent.show")]
    Show(AgentParams),
    #[serde(rename = "session.list")]
    List(ListParams),
    #[serde(rename = "session.get")]
    Get(GetParams),
    #[serde(rename = "session.state")]
    State(SessionParams),
    #[serde(rename = "session.start")]
    Start(StartParams),
    #[serde(rename = "session.send")]
    Send(SendParams),
    #[serde(rename = "session.watch")]
    Watch(WatchParams),
}
impl Operation {
    pub fn method(&self) -> &'static str {
        match self {
            Self::Show(_) => "agent.show",
            Self::List(_) => "session.list",
            Self::Get(_) => "session.get",
            Self::State(_) => "session.state",
            Self::Start(_) => "session.start",
            Self::Send(_) => "session.send",
            Self::Watch(_) => "session.watch",
        }
    }
    pub fn agent_id(&self) -> &str {
        match self {
            Self::Show(params) => &params.local_agent_id,
            Self::List(params) => &params.local_agent_id,
            Self::Get(params) => &params.local_agent_id,
            Self::State(params) => &params.local_agent_id,
            Self::Start(params) => &params.local_agent_id,
            Self::Send(params) => &params.local_agent_id,
            Self::Watch(params) => &params.local_agent_id,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invocation {
    pub version: u8,
    pub op_id: String,
    pub request_id: String,
    pub sender_sequence: u64,
    pub source: DeviceScope,
    pub caller: VerifiedCaller,
    pub target_mount_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_route_id: Option<String>,
    #[serde(flatten)]
    pub operation: Operation,
}
// Results remain the existing business owners' projections. Their complete
// shared schemas are checked on both encode and decode; no result can select a
// new method or pass arbitrary configuration to an execution owner.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all_fields = "camelCase")]
pub enum Outcome {
    #[serde(rename = "agent.show")]
    Show { result: Value },
    #[serde(rename = "session.list")]
    List { result: Value },
    #[serde(rename = "session.get")]
    Get { result: Value },
    #[serde(rename = "session.state")]
    State { result: Value },
    #[serde(rename = "session.start")]
    Start { result: Value },
    #[serde(rename = "session.send")]
    Send { result: Value },
    #[serde(rename = "session.watch")]
    Watch { result: Value },
    #[serde(rename = "error")]
    Error { error: BusinessError },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BusinessError {
    pub code: String,
    pub message: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RpcResponse {
    pub version: u8,
    pub op_id: String,
    pub request_id: String,
    pub sender_sequence: u64,
    pub outcome: Outcome,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReturnEvent {
    pub version: u8,
    pub op_id: String,
    pub sender_sequence: u64,
    pub return_route_id: String,
    pub event: Value,
    pub source: DeviceScope,
    pub target: DeviceScope,
    pub target_local_session_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReturnAck {
    pub version: u8,
    pub op_id: String,
    pub sender_sequence: u64,
    pub return_route_id: String,
    pub event_id: String,
    pub settlement: ReturnSettlement,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReturnSettlement {
    Delivered,
    Unconfirmed,
    Dropped,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelHello {
    pub version: u8,
    pub sender_sequence: u64,
    pub channel_id: String,
    pub source: DeviceScope,
    pub target: DeviceScope,
    pub source_connection_epoch: String,
    pub target_connection_epoch: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum BusinessObject {
    #[serde(rename = "invoke")]
    Invoke(Invocation),
    #[serde(rename = "response")]
    Response(RpcResponse),
    #[serde(rename = "return-event")]
    Event(ReturnEvent),
    #[serde(rename = "return-ack")]
    Ack(ReturnAck),
    #[serde(rename = "channel.hello")]
    Hello(ChannelHello),
}
impl BusinessObject {
    pub fn parse(value: Value) -> Result<Self, ProtocolError> {
        validate_business(&value)?;
        serde_json::from_value(value).map_err(|_| ProtocolError("PROTOCOL_INVALID"))
    }
    pub fn sequence(&self) -> u64 {
        match self {
            Self::Invoke(value) => value.sender_sequence,
            Self::Response(value) => value.sender_sequence,
            Self::Event(value) => value.sender_sequence,
            Self::Ack(value) => value.sender_sequence,
            Self::Hello(value) => value.sender_sequence,
        }
    }
    pub fn set_sequence(&mut self, sequence: u64) {
        match self {
            Self::Invoke(value) => value.sender_sequence = sequence,
            Self::Response(value) => value.sender_sequence = sequence,
            Self::Event(value) => value.sender_sequence = sequence,
            Self::Ack(value) => value.sender_sequence = sequence,
            Self::Hello(value) => value.sender_sequence = sequence,
        }
    }
}
