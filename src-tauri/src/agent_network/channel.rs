//! Device-pair crypto channel; Session execution remains outside this owner.
//! Pair sequences outlive an idle TLS channel and are cleared only at an outer
//! account/connection epoch boundary, so receipt expiry cannot admit a replay.
use super::crypto::{InnerTls, TlsIdentity};
use super::jwt::VerifiedPeer;
use super::NetworkError;
use myagents_agent_network_protocol::{
    encode_object, encode_tls_frame, BusinessObject, ChannelHello, DeviceScope, ObjectDecoder,
    ReceiveSequence,
};
use rustls::RootCertStore;
use std::time::Instant;

#[derive(Default)]
pub(crate) struct PairSequences {
    incoming: ReceiveSequence,
    outgoing: u64,
}
impl PairSequences {
    fn next(&mut self) -> Result<u64, NetworkError> {
        self.outgoing = self
            .outgoing
            .checked_add(1)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or_else(|| NetworkError::new("CHANNEL_SEQUENCE_EXHAUSTED"))?;
        Ok(self.outgoing)
    }
}
pub(crate) struct Channel {
    pub id: String,
    local: DeviceScope,
    peer: DeviceScope,
    local_epoch: String,
    peer_epoch: String,
    tls: InnerTls,
    decoder: ObjectDecoder,
    hello_sent: bool,
    peer_hello: bool,
    relay_ready: bool,
    failed: bool,
    pub created_at: Instant,
    pub last_activity: Instant,
}
impl Channel {
    pub(crate) fn new(
        id: String,
        local: DeviceScope,
        peer: DeviceScope,
        local_epoch: String,
        peer_epoch: String,
        identity: &TlsIdentity,
        roots: RootCertStore,
        binding: &VerifiedPeer,
        initiator: bool,
    ) -> Result<Self, NetworkError> {
        if local.service_id != peer.service_id
            || local.environment != peer.environment
            || local.network_id != peer.network_id
            || local.principal_id != peer.principal_id
            || local.device_id == peer.device_id
            || binding.service_id != peer.service_id
            || binding.environment != peer.environment
            || binding.principal_id != peer.principal_id
            || binding.device_id != peer.device_id
            || binding.key_generation != peer.key_generation
        {
            return Err(NetworkError::new("CHANNEL_SCOPE_MISMATCH"));
        }
        let tls = if initiator {
            InnerTls::client(
                identity,
                roots,
                binding.san.clone(),
                binding.certificate_fingerprint.clone(),
            )?
        } else {
            InnerTls::server(
                identity,
                roots,
                binding.san.clone(),
                binding.certificate_fingerprint.clone(),
            )?
        };
        let now = Instant::now();
        Ok(Self {
            id,
            local,
            peer,
            local_epoch,
            peer_epoch,
            tls,
            decoder: ObjectDecoder::default(),
            hello_sent: false,
            peer_hello: false,
            relay_ready: false,
            failed: false,
            created_at: now,
            last_activity: now,
        })
    }
    pub(crate) fn peer(&self) -> &DeviceScope {
        &self.peer
    }
    pub(crate) fn peer_epoch(&self) -> &str {
        &self.peer_epoch
    }
    pub(crate) fn crypto_ready(&self) -> bool {
        !self.failed && self.tls.verified() && self.hello_sent && self.peer_hello
    }
    pub(crate) fn ready(&self) -> bool {
        self.crypto_ready() && self.relay_ready
    }
    pub(crate) fn mark_relay_ready(&mut self) -> Result<(), NetworkError> {
        if !self.crypto_ready() {
            return Err(NetworkError::new("CHANNEL_NOT_READY"));
        }
        self.relay_ready = true;
        Ok(())
    }
    pub(crate) fn feed(
        &mut self,
        bytes: &[u8],
        sequences: &mut PairSequences,
    ) -> Result<Vec<BusinessObject>, NetworkError> {
        if self.failed {
            return Err(NetworkError::new("CHANNEL_CLOSED"));
        }
        let result = self.feed_inner(bytes, sequences);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn feed_inner(
        &mut self,
        bytes: &[u8],
        sequences: &mut PairSequences,
    ) -> Result<Vec<BusinessObject>, NetworkError> {
        let plaintext = self.tls.feed(bytes)?;
        self.last_activity = Instant::now();
        if self.tls.verified() && !self.hello_sent {
            let hello = BusinessObject::Hello(ChannelHello {
                version: 1,
                sender_sequence: sequences.next()?,
                channel_id: self.id.clone(),
                source: self.local.clone(),
                target: self.peer.clone(),
                source_connection_epoch: self.local_epoch.clone(),
                target_connection_epoch: self.peer_epoch.clone(),
            });
            self.write_object(&hello)?;
            self.hello_sent = true;
        }
        let mut business = Vec::new();
        for object in self.decoder.push(&plaintext).map_err(protocol_error)? {
            let object = BusinessObject::parse(object).map_err(protocol_error)?;
            sequences
                .incoming
                .observe(object.sequence())
                .map_err(protocol_error)?;
            if !self.peer_hello {
                match object {
                    BusinessObject::Hello(hello)
                        if hello.channel_id == self.id
                            && hello.source == self.peer
                            && hello.target == self.local
                            && hello.source_connection_epoch == self.peer_epoch
                            && hello.target_connection_epoch == self.local_epoch =>
                    {
                        self.peer_hello = true
                    }
                    _ => return Err(NetworkError::new("CHANNEL_HELLO_MISMATCH")),
                }
            } else {
                if !self.ready() || matches!(object, BusinessObject::Hello(_)) {
                    return Err(NetworkError::new("CHANNEL_NOT_READY"));
                }
                if let BusinessObject::Invoke(ref invocation) = object {
                    if invocation.source != self.peer {
                        return Err(NetworkError::new("CHANNEL_SCOPE_MISMATCH"));
                    }
                }
                business.push(object);
            }
        }
        Ok(business)
    }
    pub(crate) fn send(
        &mut self,
        mut object: BusinessObject,
        sequences: &mut PairSequences,
    ) -> Result<(), NetworkError> {
        if !self.ready() {
            return Err(NetworkError::new("CHANNEL_NOT_READY"));
        }
        if matches!(object, BusinessObject::Hello(_)) {
            return Err(NetworkError::new("PROTOCOL_INVALID"));
        }
        object.set_sequence(sequences.next()?);
        self.write_object(&object)
    }
    fn write_object(&mut self, object: &BusinessObject) -> Result<(), NetworkError> {
        let value =
            serde_json::to_value(object).map_err(|_| NetworkError::new("PROTOCOL_INVALID"))?;
        let bytes = encode_object(&value).map_err(protocol_error)?;
        self.tls.write_plaintext(&bytes)?;
        self.last_activity = Instant::now();
        Ok(())
    }
    pub(crate) fn drain_frame(&mut self) -> Result<Option<Vec<u8>>, NetworkError> {
        if self.failed {
            return Err(NetworkError::new("CHANNEL_CLOSED"));
        }
        let Some(bytes) = self.tls.drain_chunk()? else {
            return Ok(None);
        };
        Ok(Some(
            encode_tls_frame(&self.id, &bytes).map_err(protocol_error)?,
        ))
    }
    pub(crate) fn buffered_bytes(&self) -> usize {
        self.decoder.buffered_bytes() + self.tls.buffered_bytes()
    }
}
fn protocol_error(error: myagents_agent_network_protocol::ProtocolError) -> NetworkError {
    NetworkError::cloud(error.0, 400)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::crypto::{certificate_fingerprint, tests::Fixture};
    use super::*;
    use myagents_agent_network_protocol::{decode_tls_frame, PeerBinding};
    pub(crate) fn ready_pair() -> (Channel, Channel, PairSequences, PairSequences) {
        let fixture = Fixture::new();
        let scope = |n| DeviceScope {
            service_id: "00000000-0000-0000-0000-000000000001".into(),
            environment: "development".into(),
            network_id: "00000000-0000-0000-0000-000000000002".into(),
            principal_id: "account".into(),
            device_id: format!("00000000-0000-0000-0000-{n:012}"),
            key_generation: 1,
        };
        let first = scope(3);
        let second = scope(4);
        let binding = |scope: &DeviceScope, identity: &TlsIdentity, name: &str| {
            VerifiedPeer::fixture(PeerBinding {
                service_id: scope.service_id.clone(),
                environment: scope.environment.clone(),
                principal_id: scope.principal_id.clone(),
                device_id: scope.device_id.clone(),
                key_generation: 1,
                identity_binding_id: "00000000-0000-0000-0000-000000000005".into(),
                certificate_fingerprint: certificate_fingerprint(&identity.certificates[0]),
                san: name.into(),
                certificate: String::new(),
                expires_at: jsonwebtoken::get_current_timestamp() + 3600,
            })
        };
        let id = "00000000-0000-0000-0000-000000000006";
        let mut a = Channel::new(
            id.into(),
            first.clone(),
            second.clone(),
            "00000000-0000-0000-0000-000000000007".into(),
            "00000000-0000-0000-0000-000000000008".into(),
            &fixture.first,
            fixture.roots(),
            &binding(&second, &fixture.second, "second.network.invalid"),
            true,
        )
        .unwrap();
        let mut b = Channel::new(
            id.into(),
            second.clone(),
            first.clone(),
            "00000000-0000-0000-0000-000000000008".into(),
            "00000000-0000-0000-0000-000000000007".into(),
            &fixture.second,
            fixture.roots(),
            &binding(&first, &fixture.first, "first.network.invalid"),
            false,
        )
        .unwrap();
        let mut sa = PairSequences::default();
        let mut sb = PairSequences::default();
        for _ in 0..20 {
            while let Some(frame) = a.drain_frame().unwrap() {
                b.feed(decode_tls_frame(&frame).unwrap().1, &mut sb)
                    .unwrap();
            }
            while let Some(frame) = b.drain_frame().unwrap() {
                a.feed(decode_tls_frame(&frame).unwrap().1, &mut sa)
                    .unwrap();
            }
            if a.crypto_ready() && b.crypto_ready() {
                a.mark_relay_ready().unwrap();
                b.mark_relay_ready().unwrap();
                return (a, b, sa, sb);
            }
        }
        panic!("pair handshake did not complete")
    }
}
