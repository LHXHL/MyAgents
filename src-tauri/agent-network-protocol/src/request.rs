//! Source-side addressing contract. Only the resolved mount can supply the
//! target's local Agent identity; a qualified Session supplies its exact ID.
use crate::{AgentReference, Operation, ProtocolError, SessionReference, VerifiedCaller, SOURCE_REQUEST};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRequest {
    pub selector: String,
    pub request_id: String,
    pub operation: SourceOperation,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum SourceOperation {
    #[serde(rename = "agent.show")]
    Show(EmptyParams),
    #[serde(rename = "session.list")]
    List(SourceListParams),
    #[serde(rename = "session.get")]
    Get(SourceGetParams),
    #[serde(rename = "session.start")]
    Start(MessageParams),
    #[serde(rename = "session.send")]
    Send(MessageParams),
    #[serde(rename = "session.watch")]
    Watch(SourceWatchParams),
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceListParams { pub limit: u16 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceGetParams {
    pub limit: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageParams { pub prompt: String, pub message_id: String, pub reply_back: bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceWatchParams { pub watch_id: String }

pub struct ResolvedReference { pub agent: AgentReference, pub local_session_id: Option<String> }
impl SourceRequest {
    pub fn parse(value: Value) -> Result<Self, ProtocolError> {
        if !SOURCE_REQUEST.is_valid(&value) { return Err(ProtocolError("PROTOCOL_INVALID")); }
        let request: Self = serde_json::from_value(value).map_err(|_| ProtocolError("PROTOCOL_INVALID"))?;
        request.reference()?;
        Ok(request)
    }
    pub fn reference(&self) -> Result<ResolvedReference, ProtocolError> {
        match self.operation {
            SourceOperation::Show(_) | SourceOperation::List(_) | SourceOperation::Start(_) =>
                Ok(ResolvedReference { agent: AgentReference::parse(&self.selector)?, local_session_id: None }),
            _ => { let session = SessionReference::parse(&self.selector)?;
                Ok(ResolvedReference { agent: session.agent, local_session_id: Some(session.local_session_id) }) },
        }
    }
    pub fn method(&self) -> &'static str {
        match self.operation {
            SourceOperation::Show(_) => "agent.show", SourceOperation::List(_) => "session.list",
            SourceOperation::Get(_) => "session.get", SourceOperation::Start(_) => "session.start",
            SourceOperation::Send(_) => "session.send", SourceOperation::Watch(_) => "session.watch",
        }
    }
    pub fn bind(&self, local_agent_id: &str, caller: &VerifiedCaller) -> Result<Operation, ProtocolError> {
        if matches!(caller, VerifiedCaller::External { .. }) && match &self.operation {
            SourceOperation::Watch(_) => true,
            SourceOperation::Start(params) | SourceOperation::Send(params) => params.reply_back,
            _ => false,
        } { return Err(ProtocolError("EXTERNAL_CLI_CAPABILITY_NOT_OPEN")); }
        let mut value = serde_json::to_value(&self.operation).map_err(|_| ProtocolError("PROTOCOL_INVALID"))?;
        let params = value["params"].as_object_mut().ok_or(ProtocolError("PROTOCOL_INVALID"))?;
        params.insert("localAgentId".into(), Value::String(local_agent_id.into()));
        if let Some(id) = self.reference()?.local_session_id {
            params.insert("localSessionId".into(), Value::String(id));
        }
        serde_json::from_value(value).map_err(|_| ProtocolError("PROTOCOL_INVALID"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn request(method: &str, selector: &str, params: Value) -> Value {
        json!({"selector":selector,"requestId":"00000000-0000-0000-0000-000000000003",
            "operation":{"method":method,"params":params}})
    }
    const AGENT: &str = "ma-agent:1:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002:00000000-0000-0000-0000-000000000004";
    #[test]
    fn selectors_cannot_select_a_different_target_type_or_override_identity() {
        assert!(SourceRequest::parse(request("session.get", AGENT, json!({"limit":5}))).is_err());
        assert!(SourceRequest::parse(request("agent.show", AGENT, json!({"localAgentId":"injected"}))).is_err());
        assert!(SourceRequest::parse(request("session.start", AGENT, json!({"prompt":"x","messageId":"00000000-0000-0000-0000-000000000005","replyBack":false,"runtime":"codex"}))).is_err());
    }
    #[test]
    fn mount_resolution_and_host_provenance_bind_the_operation() {
        let caller = VerifiedCaller::External { label: "External CLI".into() };
        let req = SourceRequest::parse(request("session.start", AGENT, json!({"prompt":"x","messageId":"00000000-0000-0000-0000-000000000005","replyBack":false}))).unwrap();
        assert_eq!(req.bind("resolved-agent", &caller).unwrap().agent_id(), "resolved-agent");
        let mut denied = req.clone();
        if let SourceOperation::Start(params) = &mut denied.operation { params.reply_back = true; }
        assert!(matches!(denied.bind("resolved-agent", &caller), Err(ProtocolError("EXTERNAL_CLI_CAPABILITY_NOT_OPEN"))));
    }
}
