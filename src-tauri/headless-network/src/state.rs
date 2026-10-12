use crate::agent_network::NetworkError;
use myagents_agent_network_crypto::EncryptedIdentityStore;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};
use zeroize::{Zeroize, Zeroizing};
pub const ORIGIN: &str = "https://space.myagents.io";
pub const SERVICE_ID: &str = "98b5376a-4750-49e6-ae82-c5de39b7afef";
const DEVICE_NAMESPACE: &str = "headless-device-binding-v1";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PendingLogin {
    pub generation: String,
    pub token: String,
    pub expires_at: u64,
}
impl Drop for PendingLogin {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Account {
    pub binding: String,
    pub principal: String,
    pub token: String,
    pub expires_at: u64,
}
impl Drop for Account {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct State {
    pub version: u8,
    pub device_id: String,
    pub revision: String,
    pub pending: Option<PendingLogin>,
    pub account: Option<Account>,
}
impl State {
    fn validate(&self, device: &str) -> Result<(), NetworkError> {
        let canonical =
            |id: &str| uuid::Uuid::parse_str(id).map(|v| v.to_string()).as_deref() == Ok(id);
        if self.version != 1
            || self.device_id != device
            || !canonical(&self.device_id)
            || !canonical(&self.revision)
            || self.pending.is_some() && self.account.is_some()
        {
            return Err(NetworkError::new("ACCOUNT_STATE_SCOPE_MISMATCH"));
        }
        if self.pending.as_ref().is_some_and(|p| {
            p.generation != self.revision
                || p.token.is_empty()
                || p.token.len() > 16384
                || p.expires_at == 0
        }) || self.account.as_ref().is_some_and(|a| {
            !canonical(&a.binding)
                || a.principal.is_empty()
                || a.principal.len() > 256
                || a.token.is_empty()
                || a.token.len() > 16384
                || a.expires_at == 0
        }) {
            return Err(NetworkError::new("ACCOUNT_STATE_CORRUPT"));
        }
        Ok(())
    }
}
pub(crate) struct Owner {
    pub store: Arc<EncryptedIdentityStore>,
    pub device_id: String,
}
type StateRead = (State, Option<Zeroizing<Vec<u8>>>);
static OWNER: OnceLock<Arc<Owner>> = OnceLock::new();
impl Owner {
    fn namespace(&self) -> String {
        format!("official-headless:{SERVICE_ID}:{}", self.device_id)
    }
    pub fn install(self) -> Result<Arc<Self>, NetworkError> {
        let owner = Arc::new(self);
        OWNER
            .set(owner.clone())
            .map_err(|_| NetworkError::new("OWNER_ALREADY_INITIALIZED"))?;
        Ok(owner)
    }
    pub fn current() -> Result<Arc<Self>, NetworkError> {
        OWNER
            .get()
            .cloned()
            .ok_or_else(|| NetworkError::new("OWNER_UNAVAILABLE"))
    }
    pub fn read(&self) -> Result<StateRead, NetworkError> {
        let binding = self.store.load_state(DEVICE_NAMESPACE)?;
        match binding {
            Some(v) if v.as_slice() != self.device_id.as_bytes() => {
                return Err(NetworkError::new("ACCOUNT_STATE_SCOPE_MISMATCH"))
            }
            Some(_) => {}
            None => self.store.compare_exchange_state(
                DEVICE_NAMESPACE,
                None,
                self.device_id.as_bytes(),
            )?,
        }
        let raw = self.store.load_state(&self.namespace())?;
        let state = match &raw {
            Some(v) => {
                serde_json::from_slice(v).map_err(|_| NetworkError::new("ACCOUNT_STATE_CORRUPT"))?
            }
            None => State {
                version: 1,
                device_id: self.device_id.clone(),
                revision: uuid::Uuid::new_v4().to_string(),
                pending: None,
                account: None,
            },
        };
        state.validate(&self.device_id)?;
        Ok((state, raw))
    }
    pub fn commit(&self, old: Option<&[u8]>, state: &State) -> Result<(), NetworkError> {
        state.validate(&self.device_id)?;
        let bytes = Zeroizing::new(
            serde_json::to_vec(state).map_err(|_| NetworkError::new("ACCOUNT_STATE_CORRUPT"))?,
        );
        self.store
            .compare_exchange_state(&self.namespace(), old, &bytes)?;
        Ok(())
    }
    pub fn ensure_binding(&self, binding: &str) -> Result<(), NetworkError> {
        let (s, _) = self.read()?;
        let a = s
            .account
            .as_ref()
            .ok_or_else(|| NetworkError::new("SPACE_REAUTH_REQUIRED"))?;
        if a.binding != binding {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        if a.expires_at <= jsonwebtoken::get_current_timestamp() {
            return Err(NetworkError::new("ACCOUNT_SESSION_EXPIRED"));
        }
        Ok(())
    }
    pub fn invalidate(&self, binding: &str) -> Result<(), NetworkError> {
        let (mut s, raw) = self.read()?;
        if s.account.as_ref().is_some_and(|a| a.binding == binding) {
            s.account = None;
            s.revision = uuid::Uuid::new_v4().to_string();
            self.commit(raw.as_deref().map(|v| v.as_slice()), &s)?;
        }
        Ok(())
    }
    pub fn cancel(&self) -> Result<(), NetworkError> {
        let (mut s, raw) = self.read()?;
        s.pending = None;
        s.account = None;
        s.revision = uuid::Uuid::new_v4().to_string();
        self.commit(raw.as_deref().map(|v| v.as_slice()), &s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persisted_account_scope_and_pending_generation_are_closed() {
        let id = uuid::Uuid::new_v4().to_string();
        let revision = uuid::Uuid::new_v4().to_string();
        let mut s = State {
            version: 1,
            device_id: id.clone(),
            revision: revision.clone(),
            pending: Some(PendingLogin {
                generation: revision,
                token: "isolated-placeholder".into(),
                expires_at: 1,
            }),
            account: None,
        };
        s.validate(&id).unwrap();
        assert!(s.validate(&uuid::Uuid::new_v4().to_string()).is_err());
        s.pending.as_mut().unwrap().generation = uuid::Uuid::new_v4().to_string();
        assert!(s.validate(&id).is_err());
        let value = serde_json::json!({"version":1,"device_id":id,"revision":s.revision,"pending":null,"account":null,"untrusted":true});
        assert!(serde_json::from_value::<State>(value).is_err());
    }
}
