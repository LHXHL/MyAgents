//! Original-call return authority. Only opaque correlation and local owner
//! references survive the admission receipt; no query/result queue or replay.
use super::NetworkError;
use futures_util::{future::{BoxFuture, Shared}, FutureExt};
use tokio::sync::oneshot;
use myagents_agent_network_protocol::{
    budget, DeviceScope, Outcome, ReturnEvent, ReturnSettlement, ServerMessage, SourceOperation,
    SourceRequest, VerifiedCaller,
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
    sync::{Arc, atomic::{AtomicBool, Ordering}},
};

#[derive(Clone)]
pub(crate) enum Correlation {
    Reply(String),
    Watch(String),
}
#[derive(Clone)]
pub(crate) struct ReturnIntent {
    pub source_session: String,
    pub source_agent: String,
    pub target_session: Option<String>,
    pub target_agent: Option<myagents_agent_network_protocol::AgentReference>,
    pub correlation: Correlation,
    pub peer_label: Option<(String, String)>,
}
impl ReturnIntent {
    pub(crate) fn from_request(
        request: &SourceRequest,
        caller: &VerifiedCaller,
    ) -> Result<Option<Self>, NetworkError> {
        let VerifiedCaller::Internal {
            source_session_id,
            source_agent_id,
            ..
        } = caller
        else {
            return Ok(None);
        };
        let correlation = match &request.operation {
            SourceOperation::Start(p) | SourceOperation::Send(p) if p.reply_back => {
                Correlation::Reply(p.message_id.clone())
            }
            SourceOperation::Watch(p) => Correlation::Watch(p.watch_id.clone()),
            _ => return Ok(None),
        };
        let reference = request
            .reference()
            .map_err(|_| NetworkError::new("INVALID_REFERENCE"))?;
        Ok(Some(Self {
            target_agent: Some(reference.agent.clone()),
            source_session: source_session_id.clone(),
            source_agent: source_agent_id.clone(),
            target_session: request
                .reference()
                .map_err(|_| NetworkError::new("INVALID_REFERENCE"))?
                .local_session_id,
            correlation,
            peer_label: None,
        }))
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Route {
    id: String,
    source: DeviceScope,
    target: DeviceScope,
    source_epoch: String,
    target_epoch: String,
}
struct Context {
    intent: ReturnIntent,
    route: Option<Route>,
    pending: Option<(String, [u8; 32])>,
    turn_id: Option<String>,
    notification: Option<String>,
    watch_cancelled: Option<Instant>,
}
struct Receipt {
    route: Route,
    event_id: String,
    digest: [u8; 32],
    settlement: ReturnSettlement,
    at: Instant,
}
#[derive(Default)]
pub(crate) struct SourceReturns {
    contexts: HashMap<String, Context>,
    receipts: HashMap<String, Receipt>,
    notifications: HashMap<String, Notification>,
}
type SettlementFuture = Shared<BoxFuture<'static, ReturnSettlement>>;
struct Notification {
    settlement: SettlementFuture,
    complete: Option<oneshot::Sender<ReturnSettlement>>,
    at: Instant,
}
pub(crate) enum ReturnAdmission {
    Deliver(ReturnIntent),
    Pending,
    Joined(SettlementFuture),
    Cached(ReturnSettlement),
}
impl SourceReturns {
    pub(crate) fn reserve(&mut self, op: &str, intent: ReturnIntent) -> Result<(), NetworkError> {
        self.expire();
        let watches = self
            .contexts
            .values()
            .filter(|c| matches!(&c.intent.correlation, Correlation::Watch(_)))
            .count();
        if self.contexts.len() >= budget("returns")
            || self.contexts.len() + self.receipts.len() >= budget("receipts")
            || matches!(&intent.correlation, Correlation::Watch(_)) && watches >= budget("watches")
        {
            return Err(NetworkError::new("NETWORK_RETURN_CAPACITY"));
        }
        if self.contexts.contains_key(op) || self.receipts.contains_key(op) {
            return Err(NetworkError::new("OP_ID_REUSED"));
        }
        self.contexts.insert(
            op.into(),
            Context {
                intent,
                route: None,
                pending: None,
                turn_id: None,
                notification: None,
                watch_cancelled: None,
            },
        );
        Ok(())
    }
    pub(crate) fn resolved(&mut self, op: &str, target: &super::calls::CallableAgent) {
        if let Some(context) = self.contexts.get_mut(op) {
            context.intent.peer_label = Some((target.name.clone(), target.device_name.clone()));
        }
    }
    /// Lists/cancels only this live caller's observations. A pending Inbox
    /// admission is already irreversible; it is reported and never retracted.
    pub(crate) fn watches(&mut self, source: &str, cancel: Option<&str>, all: bool) -> (serde_json::Value, Vec<String>) {
        let mut items = Vec::new();
        let mut routes = Vec::new();
        self.contexts.retain(|_, context| {
            let Correlation::Watch(id) = &context.intent.correlation else { return true; };
            if context.intent.source_session != source || context.watch_cancelled.is_some() { return true; }
            let target = context.intent.target_agent.as_ref().zip(context.intent.target_session.as_ref())
                .and_then(|(agent, session)| myagents_agent_network_protocol::SessionReference {
                    agent: agent.clone(), local_session_id: session.clone()
                }.encode().ok());
            let selected = all || cancel == Some(id.as_str());
            let cancellable = context.route.is_some() && context.pending.is_none();
            let cancelled = selected && cancellable;
            items.push(serde_json::json!({"watchId":id,"targetSessionId":target,"turnId":context.turn_id,
                "source":"network","cancelled":cancelled,"registrationPending":context.turn_id.is_none(),"deliveryPending":context.pending.is_some()}));
            if cancelled {
                if let Some(route) = &context.route { routes.push(route.id.clone()); }
                // Keep the authenticated route briefly to settle an event
                // already in flight as dropped, using the existing receipt TTL.
                context.watch_cancelled = Some(Instant::now());
            }
            true
        });
        (serde_json::json!({"watches":items}), routes)
    }
    /// Calls has already verified this message against its resolved target.
    pub(crate) fn route(&mut self, message: &ServerMessage) -> Result<(), NetworkError> {
        let ServerMessage::RouteOpened {
            op_id,
            return_route_id,
            source,
            target,
            source_connection_epoch,
            target_connection_epoch,
            ..
        } = message
        else {
            return Err(NetworkError::new("RETURN_ROUTE_INVALID"));
        };
        let Some(context) = self.contexts.get_mut(op_id) else {
            return Ok(());
        };
        let route = Route {
            id: return_route_id.clone(),
            source: source.clone(),
            target: target.clone(),
            source_epoch: source_connection_epoch.clone(),
            target_epoch: target_connection_epoch.clone(),
        };
        if context
            .route
            .as_ref()
            .is_some_and(|previous| previous != &route)
        {
            return Err(NetworkError::new("RETURN_ROUTE_SCOPE_MISMATCH"));
        }
        context.route = Some(route);
        Ok(())
    }
    pub(crate) fn response(&mut self, op: &str, outcome: &Outcome) -> Result<(), NetworkError> {
        let Some(context) = self.contexts.get_mut(op) else {
            return Ok(());
        };
        if context.watch_cancelled.is_some() { return Ok(()); }
        if let Outcome::Start { result } = outcome {
            if let Some(session) = result["sessionId"].as_str() {
                if context
                    .intent
                    .target_session
                    .as_deref()
                    .is_some_and(|expected| expected != session)
                {
                    return Err(NetworkError::new("RETURN_TARGET_SESSION_MISMATCH"));
                }
                context.intent.target_session = Some(session.into());
            }
        }
        if let Outcome::Watch { result } = outcome {
            context.turn_id = result["turnId"].as_str().map(str::to_owned);
        }
        let rejected = match outcome {
            Outcome::Start { result } => result["accepted"] == false,
            Outcome::Send { result } => {
                result["delivered"] == false && result["unconfirmed"] != true
            }
            Outcome::Watch { result } => {
                result["watched"] == false || result["delivery"] != "registered" || result["coalesced"] == true
            }
            Outcome::Error { .. } => true,
            _ => false,
        };
        if rejected && context.pending.is_none() {
            self.contexts.remove(op);
        }
        Ok(())
    }
    pub(crate) fn event(
        &mut self,
        event: &ReturnEvent,
        peer: &DeviceScope,
        peer_epoch: &str,
        local: &DeviceScope,
        local_epoch: &str,
    ) -> Result<ReturnAdmission, NetworkError> {
        // Pair sequence is transport-local and changes when the same logical
        // event is presented on a freshly authenticated channel. Hash borrowed
        // business fields, without cloning a potentially 16 MiB result.
        let (_, digest) = super::memory::measure(&(
            event.version,
            &event.op_id,
            &event.return_route_id,
            &event.event,
            &event.source,
            &event.target,
            &event.target_local_session_id,
        ))?;
        let event_id = event.event["eventId"]
            .as_str()
            .ok_or_else(|| NetworkError::new("RETURN_EVENT_INVALID"))?;
        let validate = |route: &Route| {
            if route.id != event.return_route_id
                || route.source != *local
                || route.target != *peer
                || route.source_epoch != local_epoch
                || route.target_epoch != peer_epoch
                || event.source != route.source
                || event.target != route.target
            {
                return Err(NetworkError::new("RETURN_SCOPE_MISMATCH"));
            }
            Ok(())
        };
        if let Some(receipt) = self.receipts.get(&event.op_id) {
            validate(&receipt.route)?;
            if receipt.event_id != event_id || receipt.digest != digest {
                return Err(NetworkError::new("RETURN_EVENT_COLLISION"));
            }
            return Ok(ReturnAdmission::Cached(receipt.settlement.clone()));
        }
        let context = self
            .contexts
            .get_mut(&event.op_id)
            .ok_or_else(|| NetworkError::new("RETURN_CONTEXT_LOST"))?;
        validate(
            context
                .route
                .as_ref()
                .ok_or_else(|| NetworkError::new("RETURN_CONTEXT_LOST"))?,
        )?;
        if event.event["targetSessionId"] != context.intent.source_session
            || event.event["sourceSessionId"] != event.target_local_session_id
            || context
                .intent
                .target_session
                .as_deref()
                .is_some_and(|expected| expected != event.target_local_session_id)
        {
            return Err(NetworkError::new("RETURN_SESSION_SCOPE_MISMATCH"));
        }
        let correlated = match &context.intent.correlation {
            Correlation::Reply(id) => {
                event.event["type"] == "send.result" && event.event["requestEventId"] == *id
            }
            Correlation::Watch(id) => {
                matches!(
                    event.event["type"].as_str(),
                    Some("watch.completed" | "watch.error" | "watch.already_idle")
                ) && event.event["watchId"] == *id
            }
        };
        if !correlated {
            return Err(NetworkError::new("RETURN_CORRELATION_MISMATCH"));
        }
        if let Some((id, expected)) = &context.pending {
            if id != event_id || expected != &digest {
                return Err(NetworkError::new("RETURN_EVENT_COLLISION"));
            }
            return Ok(ReturnAdmission::Pending);
        }
        context.intent.target_session = Some(event.target_local_session_id.clone());
        context.pending = Some((event_id.into(), digest));
        if context.watch_cancelled.is_some() {
            self.finish(&event.op_id, event_id, ReturnSettlement::Dropped)?;
            return Ok(ReturnAdmission::Cached(ReturnSettlement::Dropped));
        }
        // The target lifecycle supplies the real turn and its Inbox request.
        // Scope includes verified peer/epochs, both Sessions and the request:
        // identical text, a later turn or another request never joins.
        let request = match &context.intent.correlation {
            Correlation::Reply(id) => Some(id.as_str()),
            Correlation::Watch(_) => event.event["requestEventIds"].as_array()
                .filter(|ids| ids.len() == 1).and_then(|ids| ids[0].as_str()),
        };
        let key = event.event["turnId"].as_str().zip(request).map(|(turn, request)| {
            serde_json::to_string(&(context.route.as_ref().expect("validated route").source.clone(),
                peer, local_epoch, peer_epoch, &context.intent.source_session,
                &event.target_local_session_id, &context.intent.target_agent, turn, request))
                .expect("serializable scope")
        });
        if let Some(key) = key {
            context.notification = Some(key.clone());
            if let Some(existing) = self.notifications.get(&key) {
                return Ok(ReturnAdmission::Joined(existing.settlement.clone()));
            }
            let (complete, response) = oneshot::channel();
            let settlement = async move { response.await.unwrap_or(ReturnSettlement::Dropped) }.boxed().shared();
            self.notifications.insert(key, Notification { settlement, complete: Some(complete), at: Instant::now() });
        }
        Ok(ReturnAdmission::Deliver(context.intent.clone()))
    }
    pub(crate) fn finish(
        &mut self,
        op: &str,
        event_id: &str,
        settlement: ReturnSettlement,
    ) -> Result<(), NetworkError> {
        let context = self
            .contexts
            .get(op)
            .ok_or_else(|| NetworkError::new("RETURN_CONTEXT_LOST"))?;
        let (expected, _) = context
            .pending
            .as_ref()
            .ok_or_else(|| NetworkError::new("RETURN_NOT_PENDING"))?;
        if expected != event_id {
            return Err(NetworkError::new("RETURN_EVENT_COLLISION"));
        }
        let context = self.contexts.remove(op).expect("validated current context");
        let (expected, digest) = context.pending.expect("validated pending event");
        if let Some(key) = &context.notification {
            if let Some(notification) = self.notifications.get_mut(key) {
                if let Some(complete) = notification.complete.take() { let _ = complete.send(settlement.clone()); }
            }
        }
        self.receipts.insert(
            op.into(),
            Receipt {
                route: context.route.expect("validated route"),
                event_id: expected,
                digest,
                settlement,
                at: Instant::now(),
            },
        );
        Ok(())
    }
    pub(crate) fn close_route(&mut self, route: &str) {
        self.contexts
            .retain(|_, context| context.watch_cancelled.is_some() || context.pending.is_some() || context.route.as_ref().is_none_or(|r| r.id != route));
    }
    pub(crate) fn prune_unsent(&mut self, calls: &super::calls::Calls) {
        self.contexts
            .retain(|op, c| c.route.is_some() || calls.has_history(op));
    }
    pub(crate) fn expire(&mut self) {
        self.contexts.retain(|_, c| c.watch_cancelled.is_none_or(|at| at.elapsed() < Duration::from_millis(budget("receiptMs") as u64)));
        self.notifications.retain(|_, n| n.at.elapsed() < Duration::from_millis(budget("receiptMs") as u64));
        self.receipts
            .retain(|_, r| r.at.elapsed() < Duration::from_millis(budget("receiptMs") as u64));
    }
    pub(crate) fn bytes(&self) -> usize {
        (self.contexts.len() + self.receipts.len() + self.notifications.len()) * 4096
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.contexts.values().all(|c| c.watch_cancelled.is_some())
    }
}

/// Terminal callbacks enter from the actual live Session process. This record
/// contains only correlation; result bytes exist solely in the bounded pending
/// delivery and are discarded at its deadline or connection boundary.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CallbackRequest {
    pub sidecar_id: String,
    pub reference: crate::inbox::types::NetworkReturnReference,
    pub event: serde_json::Value,
}
pub(crate) struct Callback {
    pub(crate) allocation: Option<super::memory::Allocation>,
    pub target_session: String,
    pub reference: crate::inbox::types::NetworkReturnReference,
    pub event: serde_json::Value,
    pub reply: tokio::sync::oneshot::Sender<Result<ReturnSettlement, NetworkError>>,
    pub queued_at: Instant,
}
struct TargetContext {
    alive: Arc<AtomicBool>,
    route: Route,
    intent: ReturnIntent,
    target_session: String,
}
enum DeliveryPhase {
    Waiting,
    Opening { channel: String, control: String },
    Rebinding { channel: String, control: String },
    Sent { channel: String },
}
struct Delivery {
    callback: Callback,
    event_id: String,
    phase: DeliveryPhase,
    bytes: usize,
}
#[derive(Default)]
pub(crate) struct TargetReturns {
    contexts: HashMap<String, TargetContext>,
    pending: HashMap<String, Delivery>,
    manager: Option<crate::sidecar::ManagedSidecarManager>,
}
impl TargetReturns {
    pub(crate) fn new(manager: crate::sidecar::ManagedSidecarManager) -> Self {
        Self {
            manager: Some(manager),
            contexts: HashMap::new(),
            pending: HashMap::new(),
        }
    }
    pub(crate) fn register(
        &mut self,
        invocation: &myagents_agent_network_protocol::Invocation,
        permit: &ServerMessage,
        target_session: Option<&str>,
    ) -> Result<bool, NetworkError> {
        let VerifiedCaller::Internal {
            source_session_id,
            source_agent_id,
            ..
        } = &invocation.caller
        else {
            return Ok(false);
        };
        let correlation = match &invocation.operation {
            myagents_agent_network_protocol::Operation::Start(p) if p.reply_back => {
                Correlation::Reply(p.message_id.clone())
            }
            myagents_agent_network_protocol::Operation::Send(p) if p.reply_back => {
                Correlation::Reply(p.message_id.clone())
            }
            myagents_agent_network_protocol::Operation::Watch(p) => {
                Correlation::Watch(p.watch_id.clone())
            }
            _ => return Ok(false),
        };
        if self.contexts.len() >= budget("returns")
            || matches!(&correlation, Correlation::Watch(_))
                && self
                    .contexts
                    .values()
                    .filter(|c| matches!(c.intent.correlation, Correlation::Watch(_)))
                    .count()
                    >= budget("watches")
        {
            return Err(NetworkError::new("NETWORK_RETURN_CAPACITY"));
        }
        let ServerMessage::Permit {
            return_route_id,
            source,
            target,
            source_connection_epoch,
            target_connection_epoch,
            ..
        } = permit
        else {
            return Err(NetworkError::new("PERMIT_INVALID"));
        };
        if self.contexts.contains_key(&invocation.op_id) {
            return Err(NetworkError::new("OP_ID_REUSED"));
        }
        self.contexts.insert(
            invocation.op_id.clone(),
            TargetContext {
                alive: Arc::new(AtomicBool::new(true)),
                route: Route {
                    id: return_route_id.clone(),
                    source: source.clone(),
                    target: target.clone(),
                    source_epoch: source_connection_epoch.clone(),
                    target_epoch: target_connection_epoch.clone(),
                },
                intent: ReturnIntent {
                    source_session: source_session_id.clone(),
                    source_agent: source_agent_id.clone(),
                    target_session: None,
                    target_agent: None,
                    correlation,
            peer_label: None,
                },
                target_session: target_session
                    .ok_or_else(|| NetworkError::new("TARGET_SESSION_REQUIRED"))?
                    .into(),
            },
        );
        Ok(true)
    }
    /// The return-route owner fences the already-running registration job.
    pub(crate) fn watch_lifetime(&self, op: &str) -> Option<Arc<AtomicBool>> {
        self.contexts.get(op).filter(|c| matches!(c.intent.correlation, Correlation::Watch(_)))
            .map(|c| c.alive.clone())
    }
    pub(crate) fn enqueue(
        &mut self,
        mut callback: Callback,
        buffered: usize,
    ) -> Result<(), (Callback, NetworkError)> {
        let mut check = || {
            let op = callback.reference.op_id.to_string();
            let context = self
                .contexts
                .get(&op)
                .ok_or_else(|| NetworkError::new("RETURN_CONTEXT_LOST"))?;
            if context.route.id != callback.reference.return_route_id.to_string()
                || context.target_session != callback.target_session
                || callback.event["sourceSessionId"] != context.target_session
                || callback.event["targetSessionId"] != context.intent.source_session
            {
                return Err(NetworkError::new("RETURN_SESSION_SCOPE_MISMATCH"));
            }
            let correlated = match &context.intent.correlation {
                Correlation::Reply(id) => {
                    callback.event["type"] == "send.result"
                        && callback.event["requestEventId"] == *id
                }
                Correlation::Watch(id) => {
                    matches!(
                        callback.event["type"].as_str(),
                        Some("watch.completed" | "watch.error" | "watch.already_idle")
                    ) && callback.event["watchId"] == *id
                }
            };
            if !correlated {
                return Err(NetworkError::new("RETURN_CORRELATION_MISMATCH"));
            }
            let event_id = callback.event["eventId"]
                .as_str()
                .ok_or_else(|| NetworkError::new("RETURN_EVENT_INVALID"))?
                .to_owned();
            let mut object = serde_json::json!({"version":1,"kind":"return-event","senderSequence":1,"opId":op,
                "returnRouteId":context.route.id,"source":context.route.source,"target":context.route.target,
                "targetLocalSessionId":context.target_session,"event":null});
            object["event"] = std::mem::take(&mut callback.event);
            myagents_agent_network_protocol::validate_business(&object)
                .map_err(|_| NetworkError::new("RETURN_EVENT_INVALID"))?;
            let bytes = super::memory::measure(&object)?.0;
            callback.event = object["event"].take();
            if let Some(allocation) = &mut callback.allocation {
                allocation.resize(bytes * 2 + budget("controlBytes"))?;
            }
            if self.pending.contains_key(&op) {
                return Err(NetworkError::new("RETURN_ALREADY_PENDING"));
            }
            if self.pending.len() >= budget("pending")
                || bytes > budget("objectBytes")
                || buffered + self.bytes() + bytes > budget("connectorBytes")
            {
                return Err(NetworkError::new("CONNECTOR_CAPACITY"));
            }
            Ok((op, event_id, bytes))
        };
        match check() {
            Ok((op, event_id, bytes)) => {
                self.pending.insert(
                    op,
                    Delivery {
                        callback,
                        event_id,
                        bytes,
                        phase: DeliveryPhase::Waiting,
                    },
                );
                Ok(())
            }
            Err(error) => Err((callback, error)),
        }
    }
    pub(crate) fn advance(
        &mut self,
        pairs: &super::pairs::Pairs,
        scope: &myagents_agent_network_protocol::ConnectionScope,
    ) -> Vec<super::calls::Control> {
        let mut actions = Vec::new();
        let mut openings: HashMap<(String, String), (String, String)> = self
            .pending
            .iter()
            .filter_map(|(op, d)| {
                if let DeliveryPhase::Opening { channel, control } = &d.phase {
                    let c = &self.contexts[op];
                    Some((
                        (
                            c.route.source.device_id.clone(),
                            c.route.source_epoch.clone(),
                        ),
                        (channel.clone(), control.clone()),
                    ))
                } else {
                    None
                }
            })
            .collect();
        for (op, delivery) in &mut self.pending {
            if !matches!(
                delivery.phase,
                DeliveryPhase::Waiting | DeliveryPhase::Opening { .. }
            ) {
                continue;
            }
            let context = &self.contexts[op];
            if let Some(channel) =
                pairs.ready_for(&context.route.source, &context.route.source_epoch)
            {
                let control = uuid::Uuid::new_v4().to_string();
                actions.push(super::calls::Control {
                    id: control.clone(),
                    message: myagents_agent_network_protocol::ClientMessage::Rebind {
                        scope: scope.clone(),
                        return_route_id: context.route.id.clone(),
                        channel_id: channel.into(),
                    },
                });
                delivery.phase = DeliveryPhase::Rebinding {
                    channel: channel.into(),
                    control,
                };
            } else if matches!(delivery.phase, DeliveryPhase::Waiting) {
                let key = (
                    context.route.source.device_id.clone(),
                    context.route.source_epoch.clone(),
                );
                let (channel, control) = openings
                    .entry(key)
                    .or_insert_with(|| {
                        let channel = uuid::Uuid::new_v4().to_string();
                        let control = uuid::Uuid::new_v4().to_string();
                        actions.push(super::calls::Control {
                            id: control.clone(),
                            message: myagents_agent_network_protocol::ClientMessage::Open {
                                scope: scope.clone(),
                                channel_id: channel.clone(),
                                target_device_id: context.route.source.device_id.clone(),
                                target_key_generation: context.route.source.key_generation,
                                target_connection_epoch: context.route.source_epoch.clone(),
                                target_binding: None,
                            },
                        });
                        (channel, control)
                    })
                    .clone();
                delivery.phase = DeliveryPhase::Opening { channel, control };
            }
        }
        actions
    }
    pub(crate) fn rebound(
        &mut self,
        control_id: &str,
        route: &str,
        channel: &str,
    ) -> Result<myagents_agent_network_protocol::BusinessObject, NetworkError> {
        let op = self
            .pending
            .iter()
            .find_map(|(op, d)| {
                matches!(&d.phase,DeliveryPhase::Rebinding {control,..} if control==control_id)
                    .then(|| op.clone())
            })
            .ok_or_else(|| NetworkError::new("RETURN_NOT_PENDING"))?;
        let context = &self.contexts[&op];
        let delivery = self.pending.get_mut(&op).expect("located delivery");
        if context.route.id != route
            || !matches!(&delivery.phase,DeliveryPhase::Rebinding {channel:expected,..} if expected==channel)
        {
            return Err(NetworkError::new("RETURN_SCOPE_MISMATCH"));
        }
        delivery.phase = DeliveryPhase::Sent {
            channel: channel.into(),
        };
        // The callback has one transmission. Preserve only event ID and reply
        // sender while waiting for the source's real Inbox settlement.
        let event = std::mem::take(&mut delivery.callback.event);
        delivery.bytes = 0;
        Ok(myagents_agent_network_protocol::BusinessObject::Event(
            ReturnEvent {
                version: 1,
                op_id: op,
                sender_sequence: 1,
                return_route_id: route.into(),
                event,
                source: context.route.source.clone(),
                target: context.route.target.clone(),
                target_local_session_id: context.target_session.clone(),
            },
        ))
    }
    pub(crate) fn ack(
        &mut self,
        ack: myagents_agent_network_protocol::ReturnAck,
        channel: &str,
        peer: &DeviceScope,
        epoch: &str,
    ) -> Result<String, NetworkError> {
        let context = self
            .contexts
            .get(&ack.op_id)
            .ok_or_else(|| NetworkError::new("RETURN_CONTEXT_LOST"))?;
        let delivery = self
            .pending
            .get(&ack.op_id)
            .ok_or_else(|| NetworkError::new("RETURN_NOT_PENDING"))?;
        if ack.return_route_id != context.route.id
            || ack.event_id != delivery.event_id
            || peer != &context.route.source
            || epoch != context.route.source_epoch
            || !matches!(&delivery.phase,DeliveryPhase::Sent {channel:expected} if expected==channel)
        {
            return Err(NetworkError::new("RETURN_SCOPE_MISMATCH"));
        }
        let route = context.route.id.clone();
        self.complete(&ack.op_id, Ok(ack.settlement));
        Ok(route)
    }
    fn complete(&mut self, op: &str, result: Result<ReturnSettlement, NetworkError>) {
        if let Some(context) = self.contexts.remove(op) {
            context.alive.store(false, Ordering::Release);
            if let (Some(manager), Correlation::Watch(watch_id)) =
                (&self.manager, context.intent.correlation)
            {
                let manager = manager.clone();
                let target = context.target_session;
                if let (Ok(op_id), Ok(return_route_id)) = (
                    uuid::Uuid::parse_str(op),
                    uuid::Uuid::parse_str(&context.route.id),
                ) {
                    let reference = crate::inbox::types::NetworkReturnReference {
                        op_id,
                        return_route_id,
                    };
                    tauri::async_runtime::spawn(async move {
                        crate::inbox::watch::remove_network_watch(
                            &manager, &target, &watch_id, &reference,
                        )
                        .await;
                    });
                }
            }
        }
        if let Some(delivery) = self.pending.remove(op) {
            let _ = delivery.callback.reply.send(result);
        }
    }
    pub(crate) fn cancel(&mut self, op: &str) {
        self.complete(op, Ok(ReturnSettlement::Dropped));
    }
    pub(crate) fn close_route(&mut self, route: &str) {
        let ops: Vec<_> = self
            .contexts
            .iter()
            .filter(|(_, c)| c.route.id == route)
            .map(|(op, _)| op.clone())
            .collect();
        for op in ops {
            self.cancel(&op);
        }
    }
    pub(crate) fn control_failed(&mut self, control: &str, error: NetworkError) -> bool {
        let ops: Vec<_> = self
            .pending
            .iter()
            .filter_map(|(op, d)| match &d.phase {
                DeliveryPhase::Opening {
                    control: expected, ..
                }
                | DeliveryPhase::Rebinding {
                    control: expected, ..
                } if expected == control => Some(op.clone()),
                _ => None,
            })
            .collect();
        let matched = !ops.is_empty();
        if matches!(
            error.code.as_str(),
            "CHANNEL_PAIR_EXISTS" | "CHANNEL_ALREADY_OPEN"
        ) && ops
            .iter()
            .all(|op| matches!(self.pending[op].phase, DeliveryPhase::Opening { .. }))
        {
            return matched;
        }
        for op in ops {
            self.complete(&op, Err(error.clone()));
        }
        matched
    }
    pub(crate) fn channel_closed(&mut self, channel: &str) {
        // Opening/rebinding may use a replacement authenticated channel. Once
        // transmitted, never resend the private event after an uncertain ACK.
        for delivery in self.pending.values_mut() {
            match &delivery.phase {
                DeliveryPhase::Opening { channel: c, .. }
                | DeliveryPhase::Rebinding { channel: c, .. }
                    if c == channel =>
                {
                    delivery.phase = DeliveryPhase::Waiting
                }
                _ => {}
            }
        }
    }
    pub(crate) fn expire(&mut self) -> Vec<String> {
        let expired: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, d)| d.callback.queued_at.elapsed() >= Duration::from_secs(30))
            .map(|(op, _)| op.clone())
            .collect();
        let mut routes = Vec::new();
        for op in expired {
            routes.push(self.contexts[&op].route.id.clone());
            self.complete(&op, Ok(ReturnSettlement::Unconfirmed));
        }
        routes
    }
    pub(crate) fn bytes(&self) -> usize {
        self.contexts.len() * 4096 + self.pending.values().map(|d| d.bytes).sum::<usize>()
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.contexts.is_empty()
    }
}
impl Drop for TargetReturns {
    fn drop(&mut self) {
        for op in self.contexts.keys().cloned().collect::<Vec<_>>() {
            self.complete(&op, Ok(ReturnSettlement::Dropped));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use myagents_agent_network_protocol::{ConnectionScope, Invocation, Operation, StartParams};
    use serde_json::json;
    fn id(n: u32) -> String {
        format!("00000000-0000-0000-0000-{n:012}")
    }
    fn device(n: u32) -> DeviceScope {
        DeviceScope {
            service_id: id(1),
            environment: "development".into(),
            network_id: id(2),
            principal_id: "account".into(),
            device_id: id(n),
            key_generation: 1,
        }
    }
    fn scope() -> ConnectionScope {
        ConnectionScope {
            service_id: id(1),
            network_id: id(2),
            boot_epoch: id(5),
            connection_epoch: id(6),
        }
    }
    fn intent() -> ReturnIntent {
        ReturnIntent {
            source_session: "caller-session".into(),
            source_agent: "caller-agent".into(),
            target_session: None,
            target_agent: Some(myagents_agent_network_protocol::AgentReference {
                service_id: id(1),
                network_id: id(2),
                mount_id: id(11),
            }),
            correlation: Correlation::Reply(id(10)),
            peer_label: None,
        }
    }
    fn route() -> ServerMessage {
        ServerMessage::RouteOpened {
            scope: scope(),
            return_route_id: id(8),
            op_id: id(9),
            source: device(3),
            target: device(4),
            source_connection_epoch: id(6),
            target_connection_epoch: id(7),
            target_mount_id: id(11),
        }
    }
    fn event() -> ReturnEvent {
        ReturnEvent {
            version: 1,
            op_id: id(9),
            return_route_id: id(8),
            sender_sequence: 3,
            source: device(3),
            target: device(4),
            target_local_session_id: "target-session".into(),
            event: json!({
        "version":1,"type":"send.result","eventId":id(12),"requestEventId":id(10),"sourceSessionId":"target-session","sourceLabel":"Agent","targetSessionId":"caller-session","status":"ok","terminalReason":"completed","createdAt":"2026-10-01T00:00:00Z","payload":"result"}),
        }
    }
    fn source() -> SourceReturns {
        let mut registry = SourceReturns::default();
        registry.reserve(&id(9), intent()).unwrap();
        registry.route(&route()).unwrap();
        registry
    }
    fn admit(
        registry: &mut SourceReturns,
        event: &ReturnEvent,
    ) -> Result<ReturnAdmission, NetworkError> {
        registry.event(event, &device(4), &id(7), &device(3), &id(6))
    }

    fn add_watch(r: &mut SourceReturns) -> ReturnEvent {
        let mut watch_intent = intent();
        watch_intent.target_session = Some("target-session".into());
        watch_intent.correlation = Correlation::Watch(id(20));
        r.reserve(&id(21), watch_intent).unwrap();
        let mut watch_route = route();
        if let ServerMessage::RouteOpened {op_id, return_route_id, ..} = &mut watch_route {
            *op_id=id(21); *return_route_id=id(22);
        }
        r.route(&watch_route).unwrap();
        r.response(&id(21), &Outcome::Watch { result:json!({"watched":true,"delivery":"registered","turnId":"actual-turn"}) }).unwrap();
        let mut watch=event(); watch.op_id=id(21); watch.return_route_id=id(22);
        watch.event=json!({"version":1,"type":"watch.completed","eventId":id(23),"watchId":id(20),
            "sourceSessionId":"target-session","sourceLabel":"Target","targetSessionId":"caller-session",
            "createdAt":"2026-10-01T00:00:00Z","latestResult":"same result","turnId":"actual-turn","requestEventIds":[id(10)]});
        watch
    }
    #[tokio::test]
    async fn watch_and_auto_reply_join_one_admission_in_both_orders_and_keep_each_receipt() {
        for watch_first in [false,true] {
            let mut r=source(); let watch=add_watch(&mut r); let mut reply=event();
            reply.event["turnId"]=json!("actual-turn");
            let (leader,follower)=if watch_first {(&watch,&reply)} else {(&reply,&watch)};
            assert!(matches!(admit(&mut r,leader).unwrap(),ReturnAdmission::Deliver(_)));
            let ReturnAdmission::Joined(settlement)=admit(&mut r,follower).unwrap() else {panic!("one Inbox admission")};
            let leader_id=leader.event["eventId"].as_str().unwrap();
            r.finish(&leader.op_id,leader_id,ReturnSettlement::Unconfirmed).unwrap();
            assert!(matches!(settlement.await,ReturnSettlement::Unconfirmed));
            r.finish(&follower.op_id,follower.event["eventId"].as_str().unwrap(),ReturnSettlement::Unconfirmed).unwrap();
            assert_eq!(r.receipts.len(),2);
            assert!(matches!(admit(&mut r,follower).unwrap(),ReturnAdmission::Cached(ReturnSettlement::Unconfirmed)));
        }
    }
    #[test]
    fn registration_pending_watch_cancels_and_drops_an_authenticated_late_return() {
        let mut r=source(); let watch=add_watch(&mut r);
        r.contexts.get_mut(&watch.op_id).unwrap().turn_id=None; // target registered, receipt still in flight
        let (result,routes)=r.watches("caller-session",Some(&id(20)),false);
        assert_eq!(routes,vec![id(22)]);
        assert_eq!(result["watches"][0]["cancelled"],true);
        assert_eq!(result["watches"][0]["registrationPending"],true);
        assert!(r.watches("caller-session",None,false).0["watches"].as_array().unwrap().is_empty());
        r.close_route(&id(22));
        r.response(&watch.op_id,&Outcome::Watch {result:json!({"watched":true,"delivery":"registered","turnId":"actual-turn"})}).unwrap();
        assert!(matches!(admit(&mut r,&watch).unwrap(),ReturnAdmission::Cached(ReturnSettlement::Dropped)));
        assert!(matches!(admit(&mut r,&watch).unwrap(),ReturnAdmission::Cached(ReturnSettlement::Dropped)));
        assert!(r.contexts.contains_key(&id(9))); // automatic reply remains independent
    }

    #[test]
    fn identical_text_cannot_merge_another_request_or_turn_and_cancellation_is_scoped() {
        let mut r=source(); let mut watch=add_watch(&mut r); let mut reply=event();
        reply.event["turnId"]=json!("actual-turn");
        assert!(matches!(admit(&mut r,&reply).unwrap(),ReturnAdmission::Deliver(_)));
        watch.event["requestEventIds"]=json!([id(99)]);
        assert!(matches!(admit(&mut r,&watch).unwrap(),ReturnAdmission::Deliver(_)));
        let (_,routes)=r.watches("caller-session",None,true);
        assert!(routes.is_empty()); // pending admissions cannot be retracted
        assert_eq!(r.contexts.len(),2);
        let mut r=source(); let mut watch=add_watch(&mut r);
        watch.event["turnId"]=json!("another-turn");
        assert!(matches!(admit(&mut r,&reply).unwrap(),ReturnAdmission::Deliver(_)));
        assert!(matches!(admit(&mut r,&watch).unwrap(),ReturnAdmission::Deliver(_)));
        let mut r=source(); add_watch(&mut r);
        assert!(r.watches("other-session",None,true).1.is_empty());
        assert_eq!(r.watches("caller-session",Some(&id(20)),false).1,vec![id(22)]);
        assert_eq!(r.contexts.values().filter(|c| c.watch_cancelled.is_none()).count(),1); // automatic reply survives cancel-all
    }
    #[test]
    fn equivalent_watch_receipt_retires_only_the_duplicate_route() {
        let mut r=source(); add_watch(&mut r);
        r.response(&id(21),&Outcome::Watch {result:json!({"watched":true,"delivery":"registered","coalesced":true,"watchId":id(30)})}).unwrap();
        assert_eq!(r.contexts.len(),1);
        assert!(r.contexts.contains_key(&id(9)));
    }
    #[test]
    fn reply_before_start_receipt_binds_the_real_session_and_rejects_conflicting_receipt() {
        let mut r = source();
        assert!(matches!(
            admit(&mut r, &event()).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        assert_eq!(
            r.response(
                &id(9),
                &Outcome::Start {
                    result: json!({"sessionId":"other-session","accepted":true})
                }
            )
            .unwrap_err()
            .code,
            "RETURN_TARGET_SESSION_MISMATCH"
        );
        r.response(
            &id(9),
            &Outcome::Start {
                result: json!({"sessionId":"target-session","accepted":true}),
            },
        )
        .unwrap();
        assert_eq!(r.contexts.len(), 1);
    }
    #[test]
    fn duplicate_does_not_redeliver_and_dedup_survives_pair_sequence_change() {
        let mut r = source();
        let mut e = event();
        assert!(matches!(
            admit(&mut r, &e).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        e.sender_sequence = 20;
        assert!(matches!(
            admit(&mut r, &e).unwrap(),
            ReturnAdmission::Pending
        ));
        assert!(r
            .finish(&id(9), &id(99), ReturnSettlement::Delivered)
            .is_err());
        assert_eq!(r.contexts.len(), 1);
        r.finish(&id(9), &id(12), ReturnSettlement::Unconfirmed)
            .unwrap();
        e.sender_sequence = 50;
        assert!(matches!(
            admit(&mut r, &e).unwrap(),
            ReturnAdmission::Cached(ReturnSettlement::Unconfirmed)
        ));
        e.event["payload"] = json!("different");
        assert_eq!(
            admit(&mut r, &e).err().unwrap().code,
            "RETURN_EVENT_COLLISION"
        );
    }
    #[test]
    fn wrong_peer_generation_epoch_session_or_correlation_never_enters_inbox() {
        let mut r = source();
        let mut wrong = device(4);
        wrong.key_generation = 2;
        assert_eq!(
            r.event(&event(), &wrong, &id(7), &device(3), &id(6))
                .err()
                .unwrap()
                .code,
            "RETURN_SCOPE_MISMATCH"
        );
        assert_eq!(
            r.event(&event(), &device(4), &id(99), &device(3), &id(6))
                .err()
                .unwrap()
                .code,
            "RETURN_SCOPE_MISMATCH"
        );
        let mut e = event();
        e.event["targetSessionId"] = json!("other");
        assert_eq!(
            admit(&mut r, &e).err().unwrap().code,
            "RETURN_SESSION_SCOPE_MISMATCH"
        );
        e = event();
        e.event["requestEventId"] = json!(id(99));
        assert_eq!(
            admit(&mut r, &e).err().unwrap().code,
            "RETURN_CORRELATION_MISMATCH"
        );
        let mut altered = route();
        if let ServerMessage::RouteOpened { target, .. } = &mut altered {
            target.key_generation += 1;
        }
        assert_eq!(
            r.route(&altered).unwrap_err().code,
            "RETURN_ROUTE_SCOPE_MISMATCH"
        );
        assert!(matches!(
            admit(&mut r, &event()).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
    }
    fn target() -> TargetReturns {
        let mut r = TargetReturns::default();
        let invocation = Invocation {
            version: 1,
            op_id: id(9),
            request_id: id(13),
            sender_sequence: 1,
            source: device(3),
            caller: VerifiedCaller::Internal {
                source_session_id: "caller-session".into(),
                source_agent_id: "caller-agent".into(),
                label: "Caller".into(),
            },
            target_mount_id: id(11),
            return_route_id: Some(id(8)),
            operation: Operation::Start(StartParams {
                local_agent_id: "target-agent".into(),
                prompt: "query".into(),
                message_id: id(10),
                reply_back: true,
            }),
        };
        let permit = ServerMessage::Permit {
            scope: scope(),
            op_id: id(9),
            attempt_id: id(14),
            permit_id: id(15),
            source: device(3),
            target: device(4),
            source_connection_epoch: id(6),
            target_connection_epoch: id(7),
            target_mount_id: id(11),
            membership_revision: 1,
            enable_revision: 1,
            freshness_ms: 5000,
            return_route_id: id(8),
        };
        assert!(r
            .register(&invocation, &permit, Some("target-session"))
            .unwrap());
        r
    }
    fn callback() -> (
        Callback,
        tokio::sync::oneshot::Receiver<Result<ReturnSettlement, NetworkError>>,
    ) {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        (
            Callback {
                target_session: "target-session".into(),
                reference: crate::inbox::types::NetworkReturnReference {
                    op_id: uuid::Uuid::parse_str(&id(9)).unwrap(),
                    return_route_id: uuid::Uuid::parse_str(&id(8)).unwrap(),
                },
                event: event().event,
                reply,
                queued_at: Instant::now(),
                allocation: None,
            },
            receiver,
        )
    }
    #[tokio::test]
    async fn target_rebind_ack_is_required_before_transmission_and_ack_is_correlated() {
        let mut r = target();
        let (c, reply) = callback();
        assert!(r.enqueue(c, 0).is_ok());
        assert_eq!(
            r.rebound("unsolicited", &id(8), "channel")
                .err()
                .unwrap()
                .code,
            "RETURN_NOT_PENDING"
        );
        r.pending.get_mut(&id(9)).unwrap().phase = DeliveryPhase::Rebinding {
            channel: "channel".into(),
            control: "rebind".into(),
        };
        assert!(r.rebound("rebind", &id(8), "wrong").is_err());
        let object = r.rebound("rebind", &id(8), "channel").unwrap();
        assert!(matches!(
            object,
            myagents_agent_network_protocol::BusinessObject::Event(_)
        ));
        assert!(r.pending[&id(9)].callback.event.is_null());
        assert!(r.rebound("rebind", &id(8), "channel").is_err());
        let ack = myagents_agent_network_protocol::ReturnAck {
            version: 1,
            op_id: id(9),
            sender_sequence: 4,
            return_route_id: id(8),
            event_id: id(12),
            settlement: ReturnSettlement::Delivered,
        };
        assert!(r
            .ack(ack.clone(), "channel", &device(3), "other-epoch")
            .is_err());
        assert_eq!(r.ack(ack, "channel", &device(3), &id(6)).unwrap(), id(8));
        assert!(matches!(
            reply.await.unwrap().unwrap(),
            ReturnSettlement::Delivered
        ));
        assert!(r.is_empty());
    }
    #[tokio::test]
    async fn callback_cannot_choose_another_session_and_transmitted_event_is_never_replayed() {
        let mut r = target();
        let (mut c, _) = callback();
        c.target_session = "other-session".into();
        assert_eq!(
            r.enqueue(c, 0).err().unwrap().1.code,
            "RETURN_SESSION_SCOPE_MISMATCH"
        );
        let (c, reply) = callback();
        assert!(r.enqueue(c, 0).is_ok());
        r.pending.get_mut(&id(9)).unwrap().phase = DeliveryPhase::Sent {
            channel: "channel".into(),
        };
        r.channel_closed("channel");
        assert!(r
            .advance(&super::super::pairs::Pairs::default(), &scope())
            .is_empty());
        r.pending.get_mut(&id(9)).unwrap().callback.queued_at =
            Instant::now() - Duration::from_secs(31);
        assert_eq!(r.expire(), vec![id(8)]);
        assert!(matches!(
            reply.await.unwrap().unwrap(),
            ReturnSettlement::Unconfirmed
        ));
    }
    #[test]
    fn watch_route_close_and_drop_fence_in_flight_registration() {
        for close in [false,true] {
            let mut r=target();
            r.contexts.get_mut(&id(9)).unwrap().intent.correlation=Correlation::Watch(id(20));
            let alive=r.watch_lifetime(&id(9)).unwrap();
            assert!(alive.load(Ordering::Acquire));
            if close { r.close_route(&id(8)); }
            drop(r);
            assert!(!alive.load(Ordering::Acquire));
        }
    }

    #[tokio::test]
    async fn connection_boundary_discards_callback_and_closes_only_its_route() {
        let mut r = target();
        let (c, reply) = callback();
        assert!(r.enqueue(c, 0).is_ok());
        r.close_route(&id(99));
        assert!(!r.is_empty());
        drop(r);
        assert!(matches!(
            reply.await.unwrap().unwrap(),
            ReturnSettlement::Dropped
        ));
        let mut source = source();
        source.close_route(&id(8));
        assert_eq!(
            admit(&mut source, &event()).err().unwrap().code,
            "RETURN_CONTEXT_LOST"
        );
    }
}
