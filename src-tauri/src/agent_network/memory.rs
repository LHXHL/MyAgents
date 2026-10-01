//! App-scoped transport allocations, including commands that have not reached
//! the connector actor and owner jobs whose response has not been consumed.
//! Reservations are nonblocking: capacity rejection never becomes an outbox.
use super::NetworkError;
use serde::Serialize;
use std::io::{self, Write};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[derive(Clone)]
pub(crate) struct MemoryBudget(Arc<AtomicUsize>);
impl Default for MemoryBudget {
    fn default() -> Self {
        Self(Arc::new(AtomicUsize::new(0)))
    }
}
impl MemoryBudget {
    pub(crate) fn reserve(&self, bytes: usize) -> Result<Allocation, NetworkError> {
        self.charge(bytes)?;
        Ok(Allocation {
            budget: self.clone(),
            bytes,
        })
    }
    fn charge(&self, bytes: usize) -> Result<(), NetworkError> {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes).filter(|next| {
                    *next <= myagents_agent_network_protocol::budget("connectorBytes")
                })
            })
            .map(|_| ())
            .map_err(|_| NetworkError::new("CONNECTOR_CAPACITY"))
    }
}
pub(crate) struct Allocation {
    budget: MemoryBudget,
    bytes: usize,
}
impl Allocation {
    pub(crate) fn resize(&mut self, bytes: usize) -> Result<(), NetworkError> {
        if bytes > self.bytes {
            self.budget.charge(bytes - self.bytes)?;
        } else {
            self.budget
                .0
                .fetch_sub(self.bytes - bytes, Ordering::AcqRel);
        }
        self.bytes = bytes;
        Ok(())
    }
}
impl Drop for Allocation {
    fn drop(&mut self) {
        self.budget.0.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
struct Measure {
    bytes: usize,
    digest: sha2::Sha256,
}
impl Write for Measure {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        use sha2::Digest;
        self.bytes = self
            .bytes
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("encoded size overflow"))?;
        self.digest.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
/// Do not allocate a second whole query/result to count or fingerprint it.
pub(crate) fn measure(value: &impl Serialize) -> Result<(usize, [u8; 32]), NetworkError> {
    use sha2::Digest;
    let mut writer = Measure {
        bytes: 0,
        digest: sha2::Sha256::new(),
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| NetworkError::new("PROTOCOL_INVALID"))?;
    Ok((writer.bytes, writer.digest.finalize().into()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queues_owner_jobs_and_channels_share_one_nonblocking_budget() {
        let budget = MemoryBudget::default();
        let mut queued = budget.reserve(64 * 1024 * 1024).unwrap();
        let owner = budget.reserve(48 * 1024 * 1024).unwrap();
        assert!(budget.reserve(17 * 1024 * 1024).is_err());
        assert!(queued.resize(81 * 1024 * 1024).is_err());
        queued.resize(0).unwrap();
        let channel = budget.reserve(80 * 1024 * 1024).unwrap();
        assert!(budget.reserve(1).is_err());
        drop(owner);
        drop(channel);
        drop(queued);
        assert_eq!(budget.0.load(Ordering::Acquire), 0);
    }
    #[test]
    fn counting_and_fingerprinting_matches_wire_json_without_retaining_a_copy() {
        use sha2::Digest;
        let value = serde_json::json!({"query":"你好", "history":[1,2,3]});
        let encoded = serde_json::to_vec(&value).unwrap();
        assert_eq!(
            measure(&value).unwrap(),
            (encoded.len(), sha2::Sha256::digest(encoded).into())
        );
    }
}
