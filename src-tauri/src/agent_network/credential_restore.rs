//! Cancellable, bounded explicit credential reads. Terminal UUIDs also fence
//! cancellation arriving before the asynchronous command registers its work.
use super::NetworkError;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

const MAX_OPERATIONS: usize = 4;
const MAX_TERMINAL: usize = 128;
const TERMINAL_TTL: Duration = Duration::from_secs(300);
#[derive(Default)]
pub(super) struct RestoreOperations {
    active: HashMap<String, (String, Arc<AtomicBool>)>,
    terminal: HashMap<String, Instant>,
}
fn validate_id(id: &str) -> Result<(), NetworkError> {
    if uuid::Uuid::parse_str(id)
        .map(|id| id.to_string())
        .as_deref()
        != Ok(id)
    {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    Ok(())
}
impl RestoreOperations {
    fn prune(&mut self) {
        self.terminal
            .retain(|_, time| time.elapsed() < TERMINAL_TTL);
    }
    pub(super) fn begin(
        &mut self,
        id: &str,
        connection: &str,
    ) -> Result<Arc<AtomicBool>, NetworkError> {
        validate_id(id)?;
        self.prune();
        if self.terminal.contains_key(id) || self.active.contains_key(id) {
            return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
        }
        if self.active.len() >= MAX_OPERATIONS
            || self.terminal.len() + self.active.len() >= MAX_TERMINAL
        {
            return Err(NetworkError::new("NETWORK_REQUEST_CAPACITY"));
        }
        if self.active.values().any(|(other, _)| other == connection) {
            return Err(NetworkError::new("NETWORK_REQUEST_CAPACITY"));
        }
        let token = Arc::new(AtomicBool::new(false));
        self.active
            .insert(id.into(), (connection.into(), token.clone()));
        Ok(token)
    }
    pub(super) fn cancel(&mut self, id: &str) -> Result<(), NetworkError> {
        validate_id(id)?;
        self.prune();
        if let Some((_, token)) = self.active.get(id) {
            token.store(true, Ordering::Release);
        } else if !self.terminal.contains_key(id) {
            if self.terminal.len() + self.active.len() >= MAX_TERMINAL {
                return Err(NetworkError::new("NETWORK_REQUEST_CAPACITY"));
            }
            self.terminal.insert(id.into(), Instant::now());
        }
        Ok(())
    }
    pub(super) fn current(&self, id: &str, token: &Arc<AtomicBool>) -> bool {
        !token.load(Ordering::Acquire)
            && self
                .active
                .get(id)
                .is_some_and(|(_, current)| Arc::ptr_eq(current, token))
    }
    pub(super) fn finish(&mut self, id: &str, token: &Arc<AtomicBool>) {
        if self
            .active
            .get(id)
            .is_some_and(|(_, current)| Arc::ptr_eq(current, token))
        {
            self.active.remove(id);
            self.prune();
            // begin reserved a slot; at most four active completions may fill it.
            self.terminal.insert(id.into(), Instant::now());
        }
    }
    pub(super) fn cancel_all(&mut self) {
        for (_, token) in self.active.values() {
            token.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    #[test]
    fn early_cancel_and_replayed_terminal_id_never_register() {
        let mut operations = RestoreOperations::default();
        let early = id();
        operations.cancel(&early).unwrap();
        assert!(operations.begin(&early, "owned").is_err());
        let done = id();
        let token = operations.begin(&done, "owned").unwrap();
        operations.finish(&done, &token);
        assert!(operations.begin(&done, "owned").is_err());
    }
    #[test]
    fn cancellation_is_scoped_and_late_result_cannot_replace_new_operation() {
        let mut operations = RestoreOperations::default();
        let first = id();
        let other = id();
        let cancelled = operations.begin(&first, "one").unwrap();
        let untouched = operations.begin(&other, "two").unwrap();
        operations.cancel(&first).unwrap();
        assert!(!operations.current(&first, &cancelled));
        assert!(operations.current(&other, &untouched));
        operations.finish(&first, &cancelled);
        let next = id();
        let replacement = operations.begin(&next, "one").unwrap();
        operations.finish(&first, &cancelled);
        assert!(operations.current(&next, &replacement));
        operations.cancel_all();
        assert!(!operations.current(&next, &replacement));
    }
    #[test]
    fn operations_and_cancel_tombstones_have_fixed_capacity() {
        let mut operations = RestoreOperations::default();
        for n in 0..MAX_OPERATIONS {
            operations.begin(&id(), &n.to_string()).unwrap();
        }
        assert!(operations.begin(&id(), "extra").is_err());
        let mut operations = RestoreOperations::default();
        for _ in 0..MAX_TERMINAL {
            operations.cancel(&id()).unwrap();
        }
        assert!(operations.cancel(&id()).is_err());
        assert!(operations.begin(&id(), "one").is_err());
    }
}
