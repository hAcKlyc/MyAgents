//! Desktop explicitly selects the OS credential backend.
use super::{
    account::NetworkAccountSession,
    crypto::{DevicePrivateKey, KeyScope, OsIdentityStore},
    identity::{load_key_with_store, NetworkIdentity},
    NetworkError,
};
use std::sync::Arc;
impl NetworkIdentity {
    pub(crate) async fn initialize(
        account: NetworkAccountSession,
        retired_generation: Option<u64>,
    ) -> Result<Self, NetworkError> {
        Self::initialize_with_store(account, retired_generation, Arc::new(OsIdentityStore)).await
    }
}
pub(crate) async fn load_key(
    scope: &KeyScope,
) -> Result<Option<Arc<DevicePrivateKey>>, NetworkError> {
    load_key_with_store(scope, Arc::new(OsIdentityStore)).await
}
