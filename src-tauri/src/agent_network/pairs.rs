//! Device-pair state is scoped to one authenticated outer connection. Pair
//! sequence high-waters survive idle channel recreation until that scope drops.
use super::channel::{Channel, PairSequences};
use super::crypto::private_roots;
use super::identity::{NetworkIdentity, PeerIdentity};
use super::jwt::VerifiedPeer;
use super::NetworkError;
use myagents_agent_network_protocol::{budget, BusinessObject, DeviceScope};
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub(crate) struct Offer {
    pub channel_id: String,
    pub initiator: DeviceScope,
    pub responder: DeviceScope,
    pub initiator_epoch: String,
    pub responder_epoch: String,
    pub initiator_binding: Option<String>,
    pub responder_binding: Option<String>,
}
pub(crate) struct VerifiedOffer {
    offer: Offer,
    first: VerifiedPeer,
    second: VerifiedPeer,
    identity: PeerIdentity,
    root_certificate: String,
}
impl Offer {
    pub(crate) fn validate_scope(
        &self,
        local: &DeviceScope,
        epoch: &str,
    ) -> Result<(), NetworkError> {
        if !((self.initiator == *local && self.initiator_epoch == epoch)
            || (self.responder == *local && self.responder_epoch == epoch))
            || self.initiator.service_id != self.responder.service_id
            || self.initiator.network_id != self.responder.network_id
            || self.initiator.environment != self.responder.environment
            || self.initiator.principal_id != self.responder.principal_id
            || self.initiator.device_id == self.responder.device_id
            || key(&self.initiator) >= key(&self.responder)
        {
            return Err(NetworkError::new("CHANNEL_SCOPE_MISMATCH"));
        }
        Ok(())
    }
    pub(crate) async fn verify(
        self,
        identity: &NetworkIdentity,
        local: &DeviceScope,
        epoch: &str,
    ) -> Result<VerifiedOffer, NetworkError> {
        self.validate_scope(local, epoch)?;
        let mut verifier = identity.verifier.clone();
        let first = verifier
            .peer(
                self.initiator_binding
                    .as_deref()
                    .ok_or_else(|| NetworkError::new("PEER_BINDING_MISSING"))?,
            )
            .await?;
        let second = verifier
            .peer(
                self.responder_binding
                    .as_deref()
                    .ok_or_else(|| NetworkError::new("PEER_BINDING_MISSING"))?,
            )
            .await?;
        for (scope, peer) in [(&self.initiator, &first), (&self.responder, &second)] {
            if scope.service_id != peer.service_id
                || scope.environment != peer.environment
                || scope.principal_id != peer.principal_id
                || scope.device_id != peer.device_id
                || scope.key_generation != peer.key_generation
            {
                return Err(NetworkError::new("CHANNEL_SCOPE_MISMATCH"));
            }
        }
        let ours = if self.initiator == *local {
            &first
        } else {
            &second
        };
        let verifier_root = identity.root_certificate.clone();
        let identity = identity
            .peer
            .as_ref()
            .ok_or_else(|| NetworkError::new("NETWORK_CERTIFICATE_INVALID"))?;
        if ours.certificate_fingerprint != identity.binding.certificate_fingerprint {
            return Err(NetworkError::new("CHANNEL_SCOPE_MISMATCH"));
        }
        Ok(VerifiedOffer {
            offer: self,
            first,
            second,
            identity: identity.clone(),
            root_certificate: verifier_root,
        })
    }
}
// The server's canonical device key uses this exact ordered full scope tuple.
fn key(scope: &DeviceScope) -> String {
    format!(
        "{}/{}/{}/{}/{}/{}",
        scope.service_id,
        scope.environment,
        scope.network_id,
        scope.principal_id,
        scope.device_id,
        scope.key_generation
    )
}
struct Entry {
    channel: Channel,
    pair: String,
    announced: bool,
    accepted: bool,
    certificate_expires_at: u64,
}
struct PendingOffer {
    accepted: bool,
    bytes: Vec<u8>,
    created_at: Instant,
}
#[derive(Default)]
struct Credits {
    sent: u64,
    returned: u64,
    return_sequence: u64,
    received: u64,
    release_sequence: u64,
}
#[derive(Default)]
pub(crate) struct Pairs {
    memory: super::memory::MemoryBudget,
    allocation: Option<super::memory::Allocation>,
    pending: HashMap<String, PendingOffer>,
    channels: HashMap<String, Entry>,
    sequences: HashMap<String, PairSequences>,
    credits: HashMap<String, Credits>,
    failures: Vec<(String, NetworkError)>,
}
impl Pairs {
    pub(crate) fn new(memory: super::memory::MemoryBudget) -> Self {
        Self {
            memory,
            ..Self::default()
        }
    }
    fn account_buffers(&mut self) -> Result<(), NetworkError> {
        let bytes = self.buffered_bytes();
        match &mut self.allocation {
            Some(allocation) => allocation.resize(bytes),
            None => {
                self.allocation = Some(self.memory.reserve(bytes)?);
                Ok(())
            }
        }
    }

    pub(crate) fn reserve(&mut self, id: &str) -> Result<(), NetworkError> {
        if self.pending.contains_key(id) || self.channels.contains_key(id) {
            return Err(NetworkError::new("CHANNEL_ID_REUSED"));
        }
        let handshakes = self
            .channels
            .values()
            .filter(|entry| !entry.channel.ready())
            .count();
        if self.channels.len() + self.pending.len() >= budget("channels")
            || handshakes + self.pending.len() >= budget("handshakes")
        {
            return Err(NetworkError::new("CHANNEL_CAPACITY"));
        }
        self.credits.insert(id.into(), Credits::default());
        self.pending.insert(
            id.into(),
            PendingOffer {
                accepted: false,
                bytes: Vec::new(),
                created_at: Instant::now(),
            },
        );
        Ok(())
    }
    pub(crate) fn install(
        &mut self,
        verified: VerifiedOffer,
        local: &DeviceScope,
        epoch: &str,
    ) -> Result<(String, bool), NetworkError> {
        let offer = verified.offer;
        let pending = self
            .pending
            .remove(&offer.channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_CLOSED"))?;
        if pending.created_at.elapsed() > Duration::from_millis(budget("handshakeMs") as u64) {
            return Err(NetworkError::new("CHANNEL_HANDSHAKE_TIMEOUT"));
        }
        if self.channels.contains_key(&offer.channel_id) {
            return Err(NetworkError::new("CHANNEL_ID_REUSED"));
        }
        if self.channels.len() >= budget("channels")
            || self
                .channels
                .values()
                .filter(|value| !value.channel.ready())
                .count()
                >= budget("handshakes")
        {
            return Err(NetworkError::new("CHANNEL_CAPACITY"));
        }
        let certificate_expires_at = verified.first.expires_at.min(verified.second.expires_at);
        let initiator = offer.initiator == *local;
        let (peer, peer_epoch, binding) = if initiator {
            (offer.responder, offer.responder_epoch, verified.second)
        } else {
            (offer.initiator, offer.initiator_epoch, verified.first)
        };
        if self
            .channels
            .values()
            .any(|entry| entry.channel.peer() == &peer)
        {
            return Err(NetworkError::new("CHANNEL_PAIR_EXISTS"));
        }
        let pair = format!("{}|{}|{}|{}", key(local), key(&peer), epoch, peer_epoch);
        if !self.sequences.contains_key(&pair) && self.sequences.len() >= budget("catalogItems") {
            return Err(NetworkError::new("PAIR_SEQUENCE_CAPACITY"));
        }
        self.sequences.entry(pair.clone()).or_default();
        let mut channel = Channel::new(
            offer.channel_id.clone(),
            local.clone(),
            peer,
            epoch.into(),
            peer_epoch,
            &verified.identity.tls,
            private_roots(&verified.root_certificate)?,
            &binding,
            initiator,
        )?;
        if !pending.bytes.is_empty() {
            for chunk in pending.bytes.chunks(budget("tlsChunkBytes")) {
                let objects = channel.feed(
                    chunk,
                    self.sequences.get_mut(&pair).expect("installed sequence"),
                )?;
                if !objects.is_empty() {
                    return Err(NetworkError::new("CHANNEL_NOT_READY"));
                }
            }
        }
        self.channels.insert(
            offer.channel_id.clone(),
            Entry {
                channel,
                pair,
                announced: false,
                accepted: pending.accepted,
                certificate_expires_at,
            },
        );
        self.account_buffers()?;
        Ok((offer.channel_id, !initiator))
    }
    pub(crate) fn accepted(&mut self, channel_id: &str) -> Result<(), NetworkError> {
        if let Some(pending) = self.pending.get_mut(channel_id) {
            if pending.accepted {
                return Err(NetworkError::new("CHANNEL_ALREADY_ACCEPTED"));
            }
            pending.accepted = true;
            return Ok(());
        }
        let entry = self
            .channels
            .get_mut(channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?;
        if entry.accepted {
            return Err(NetworkError::new("CHANNEL_ALREADY_ACCEPTED"));
        }
        entry.accepted = true;
        // A TLS initiator already has outbound ClientHello in its bounded writer.
        Ok(())
    }
    pub(crate) fn feed(
        &mut self,
        channel_id: &str,
        bytes: &[u8],
    ) -> Result<(Vec<BusinessObject>, super::memory::Allocation), NetworkError> {
        let channel_bytes = self.channels.get(channel_id).map_or_else(
            || {
                self.pending
                    .get(channel_id)
                    .map_or(0, |entry| entry.bytes.len())
            },
            |entry| entry.channel.buffered_bytes(),
        );
        // Retain the decoded objects' reservation through actor dispatch. An
        // incomplete object can become a complete Value in this very chunk.
        let allocation = self
            .memory
            .reserve((channel_bytes + bytes.len()) * 2 + budget("channelQueueBytes"))?;
        let objects = if let Some(pending) = self.pending.get_mut(channel_id) {
            if !pending.accepted {
                return Err(NetworkError::new("CHANNEL_NOT_ACCEPTED"));
            }
            if pending.bytes.len() + bytes.len() > budget("channelQueueBytes") {
                return Err(NetworkError::new("CHANNEL_BACKPRESSURE"));
            }
            pending.bytes.extend_from_slice(bytes);
            Vec::new()
        } else {
            let entry = self
                .channels
                .get_mut(channel_id)
                .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?;
            if !entry.accepted {
                return Err(NetworkError::new("CHANNEL_NOT_ACCEPTED"));
            }
            entry.channel.feed(
                bytes,
                self.sequences
                    .get_mut(&entry.pair)
                    .expect("installed sequence"),
            )?
        };
        self.account_buffers()?;
        Ok((objects, allocation))
    }
    pub(crate) fn release_credit(
        &mut self,
        id: &str,
        bytes: usize,
    ) -> Result<(u64, u64), NetworkError> {
        let flow = self
            .credits
            .get_mut(id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?;
        flow.received = flow
            .received
            .checked_add(bytes as u64)
            .filter(|x| *x <= 9_007_199_254_740_991)
            .ok_or_else(|| NetworkError::new("CREDIT_OVERFLOW"))?;
        flow.release_sequence += 1;
        Ok((flow.release_sequence, flow.received))
    }
    pub(crate) fn credit(
        &mut self,
        id: &str,
        sequence: u64,
        received: u64,
    ) -> Result<(), NetworkError> {
        // A close can overtake a previously queued credit notification.
        let Some(flow) = self.credits.get_mut(id) else {
            return Ok(());
        };
        if sequence != flow.return_sequence + 1 || received <= flow.returned || received > flow.sent
        {
            return Err(NetworkError::new("CREDIT_INVALID"));
        }
        flow.returned = received;
        flow.return_sequence = sequence;
        Ok(())
    }
    pub(crate) fn next_frame(&mut self) -> Result<Option<Vec<u8>>, NetworkError> {
        let device = self
            .credits
            .values()
            .map(|c| c.sent - c.returned)
            .sum::<u64>();
        let maximum = (budget("tlsChunkBytes") + 22) as u64;
        if device + maximum > budget("socketQueueBytes") as u64 {
            return Ok(None);
        }
        let mut result = None;
        for (id, entry) in self.channels.iter_mut().filter(|(_, entry)| entry.accepted) {
            let flow = self.credits.get_mut(id).expect("reserved channel credits");
            if flow.sent - flow.returned + maximum > budget("channelQueueBytes") as u64 {
                continue;
            }
            let frame = match entry.channel.drain_frame() {
                Ok(frame) => frame,
                Err(error) => {
                    self.failures.push((id.clone(), error));
                    continue;
                }
            };
            if let Some(frame) = frame {
                flow.sent = flow
                    .sent
                    .checked_add(frame.len() as u64)
                    .filter(|x| *x <= 9_007_199_254_740_991)
                    .ok_or_else(|| NetworkError::new("CREDIT_OVERFLOW"))?;
                result = Some(frame);
                break;
            }
        }
        self.account_buffers()?;
        Ok(result)
    }
    pub(crate) fn announce_ready(&mut self) -> Vec<String> {
        self.channels
            .values_mut()
            .filter_map(|entry| {
                if entry.channel.crypto_ready() && !entry.announced {
                    entry.announced = true;
                    Some(entry.channel.id.clone())
                } else {
                    None
                }
            })
            .collect()
    }
    pub(crate) fn ready(&mut self, channel_id: &str) -> Result<(), NetworkError> {
        self.channels
            .get_mut(channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?
            .channel
            .mark_relay_ready()
    }
    pub(crate) fn remove(&mut self, channel_id: &str) {
        self.channels.remove(channel_id);
        self.pending.remove(channel_id);
        self.credits.remove(channel_id);
        // Removal only releases bytes and therefore cannot exceed the budget.
        self.account_buffers().expect("buffer release");
    }
    pub(crate) fn send(
        &mut self,
        channel_id: &str,
        object: BusinessObject,
    ) -> Result<(), NetworkError> {
        let result = self.write_object(channel_id, object);
        if let Err(error) = &result {
            self.remove(channel_id);
            self.failures.push((channel_id.to_owned(), error.clone()));
        }
        result
    }
    pub(crate) fn take_failures(&mut self) -> Vec<(String, NetworkError)> {
        std::mem::take(&mut self.failures)
    }
    fn write_object(
        &mut self,
        channel_id: &str,
        object: BusinessObject,
    ) -> Result<(), NetworkError> {
        let bytes = super::memory::measure(&object)?.0;
        if bytes > budget("objectBytes") {
            return Err(NetworkError::new("MESSAGE_TOO_LARGE"));
        }
        // Validation Value, encoded frame and TLS writer coexist during encode.
        let _encoding = self
            .memory
            .reserve(bytes * 3 + budget("channelQueueBytes"))?;
        let entry = self
            .channels
            .get_mut(channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?;
        entry.channel.send(
            object,
            self.sequences
                .get_mut(&entry.pair)
                .expect("installed sequence"),
        )?;
        self.account_buffers()
    }
    pub(crate) fn ready_for(&self, peer: &DeviceScope, epoch: &str) -> Option<&str> {
        self.channels
            .values()
            .find(|entry| {
                entry.channel.peer() == peer
                    && entry.channel.peer_epoch() == epoch
                    && entry.channel.ready()
            })
            .map(|entry| entry.channel.id.as_str())
    }
    pub(crate) fn has_channel(&self, channel_id: &str) -> bool {
        self.channels.contains_key(channel_id)
    }
    pub(crate) fn peer(&self, channel_id: &str) -> Result<(&DeviceScope, &str), NetworkError> {
        let channel = &self
            .channels
            .get(channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?
            .channel;
        if !channel.ready() {
            return Err(NetworkError::new("CHANNEL_NOT_READY"));
        }
        Ok((channel.peer(), channel.peer_epoch()))
    }
    pub(crate) fn buffered_bytes(&self) -> usize {
        self.channels
            .values()
            .map(|entry| entry.channel.buffered_bytes())
            .sum::<usize>()
            + self
                .pending
                .values()
                .map(|entry| entry.bytes.len())
                .sum::<usize>()
    }
    pub(crate) fn expired(&self) -> Vec<(String, &'static str)> {
        let now = Instant::now();
        self.channels
            .values()
            .filter_map(|entry| {
                if entry.certificate_expires_at <= jsonwebtoken::get_current_timestamp() {
                    Some((entry.channel.id.clone(), "CHANNEL_CERTIFICATE_EXPIRED"))
                } else if !entry.channel.ready()
                    && now.duration_since(entry.channel.created_at)
                        > Duration::from_millis(budget("handshakeMs") as u64)
                {
                    Some((entry.channel.id.clone(), "CHANNEL_HANDSHAKE_TIMEOUT"))
                } else {
                    None
                }
            })
            .chain(self.pending.iter().filter_map(|(id, entry)| {
                (now.duration_since(entry.created_at)
                    > Duration::from_millis(budget("handshakeMs") as u64))
                .then(|| (id.clone(), "CHANNEL_HANDSHAKE_TIMEOUT"))
            }))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_responses_wait_for_credit_without_retiring_the_pair() {
        use myagents_agent_network_protocol::{decode_tls_frame, Outcome, RpcResponse};
        let (sender, mut receiver, send_sequence, mut receive_sequence) =
            super::super::channel::tests::ready_pair();
        let channel = sender.id.clone();
        let mut pairs = Pairs::default();
        pairs.sequences.insert("pair".into(), send_sequence);
        pairs.credits.insert(channel.clone(), Credits::default());
        pairs.channels.insert(
            channel.clone(),
            Entry {
                channel: sender,
                pair: "pair".into(),
                announced: true,
                accepted: true,
                certificate_expires_at: jsonwebtoken::get_current_timestamp() + 3600,
            },
        );
        let response = |text: String| {
            BusinessObject::Response(RpcResponse {
                version: 1,
                sender_sequence: 1,
                op_id: uuid::Uuid::new_v4().to_string(),
                request_id: uuid::Uuid::new_v4().to_string(),
                outcome: Outcome::Get {
                    result: serde_json::json!({"id":"session","messages":[{"id":"message","role":"assistant","timestamp":"2026-10-01T00:00:00Z","content":text}],"hasMoreBefore":false,"isLive":false,"liveSessionState":null,"snapshotRevision":1}),
                },
            })
        };
        pairs
            .send(
                &channel,
                response("x".repeat(budget("channelQueueBytes") * 3)),
            )
            .unwrap();
        let mut received = Vec::new();
        while let Some(frame) = pairs.next_frame().unwrap() {
            received.extend(
                receiver
                    .feed(decode_tls_frame(&frame).unwrap().1, &mut receive_sequence)
                    .unwrap(),
            );
        }
        assert!(received.is_empty());
        pairs.send(&channel, response("second".into())).unwrap();
        assert!(pairs.take_failures().is_empty());
        loop {
            let (seq, bytes) = {
                let flow = &pairs.credits[&channel];
                (flow.return_sequence + 1, flow.sent)
            };
            pairs.credit(&channel, seq, bytes).unwrap();
            let mut drained = false;
            while let Some(frame) = pairs.next_frame().unwrap() {
                drained = true;
                received.extend(
                    receiver
                        .feed(decode_tls_frame(&frame).unwrap().1, &mut receive_sequence)
                        .unwrap(),
                );
            }
            if !drained {
                break;
            }
        }
        assert_eq!(received.len(), 2);
        assert!(pairs.channels.contains_key(&channel));
        pairs.remove(&channel);
        assert_eq!(pairs.buffered_bytes(), 0);
    }
    #[test]
    fn writer_capacity_retires_only_the_affected_pair() {
        let (mut first, _, first_sequence, _) = super::super::channel::tests::ready_pair();
        let (mut other, _, other_sequence, _) = super::super::channel::tests::ready_pair();
        first.id = uuid::Uuid::new_v4().to_string();
        other.id = uuid::Uuid::new_v4().to_string();
        let failed = first.id.clone();
        let healthy = other.id.clone();
        let mut pairs = Pairs::default();
        for (channel, pair, sequence) in [
            (first, "first", first_sequence),
            (other, "other", other_sequence),
        ] {
            pairs.credits.insert(channel.id.clone(), Credits::default());
            pairs.sequences.insert(pair.into(), sequence);
            pairs.channels.insert(
                channel.id.clone(),
                Entry {
                    channel,
                    pair: pair.into(),
                    announced: true,
                    accepted: true,
                    certificate_expires_at: jsonwebtoken::get_current_timestamp() + 3600,
                },
            );
        }
        pairs.account_buffers().unwrap();
        let pressure = pairs
            .memory
            .reserve(budget("connectorBytes") - pairs.buffered_bytes())
            .unwrap();
        let object = BusinessObject::Response(myagents_agent_network_protocol::RpcResponse {
            version: 1,
            sender_sequence: 1,
            op_id: uuid::Uuid::new_v4().to_string(),
            request_id: uuid::Uuid::new_v4().to_string(),
            outcome: super::super::incoming::error_outcome(NetworkError::new("TARGET_BUSY")),
        });
        assert_eq!(
            pairs.send(&failed, object).unwrap_err().code,
            "CONNECTOR_CAPACITY"
        );
        assert!(!pairs.has_channel(&failed));
        assert!(pairs.has_channel(&healthy));
        let failures = pairs.take_failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].0, failed);
        drop(pressure);
        pairs.remove(&healthy);
        assert_eq!(pairs.buffered_bytes(), 0);
    }
    #[test]
    fn accepted_before_verification_is_bounded_and_cancelled_with_offer() {
        let mut pairs = Pairs::default();
        pairs.reserve("offer").unwrap();
        assert_eq!(
            pairs.feed("offer", b"tls").err().unwrap().code,
            "CHANNEL_NOT_ACCEPTED"
        );
        pairs.accepted("offer").unwrap();
        assert!(pairs
            .feed("offer", &vec![1; budget("channelQueueBytes")])
            .unwrap()
            .0
            .is_empty());
        assert_eq!(pairs.buffered_bytes(), budget("channelQueueBytes"));
        assert_eq!(
            pairs.feed("offer", &[1]).err().unwrap().code,
            "CHANNEL_BACKPRESSURE"
        );
        pairs.remove("offer");
        assert_eq!(pairs.buffered_bytes(), 0);
        assert_eq!(
            pairs.accepted("offer").err().unwrap().code,
            "CHANNEL_NOT_FOUND"
        );
    }
    #[test]
    fn verification_jobs_count_towards_handshake_capacity_and_expire() {
        let mut pairs = Pairs::default();
        for i in 0..budget("handshakes") {
            pairs.reserve(&i.to_string()).unwrap();
        }
        assert_eq!(
            pairs.reserve("extra").err().unwrap().code,
            "CHANNEL_CAPACITY"
        );
        pairs.pending.get_mut("0").unwrap().created_at -=
            Duration::from_millis(budget("handshakeMs") as u64 + 1);
        assert_eq!(
            pairs.expired(),
            vec![("0".into(), "CHANNEL_HANDSHAKE_TIMEOUT")]
        );
        pairs.remove("0");
        pairs.reserve("extra").unwrap();
    }
}
