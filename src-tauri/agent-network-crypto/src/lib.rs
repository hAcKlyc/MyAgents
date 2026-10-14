//! Private-key and TLS primitives called exclusively by the Rust App owner.
//! No credential or traffic secret is exposed as a serialized/Debug value.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::DecodePrivateKey;
use rcgen::PublicKeyData;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use rustls::{
    ClientConfig, ClientConnection, Connection, RootCertStore, ServerConfig, ServerConnection,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use std::sync::Arc;
use zeroize::Zeroizing;

pub fn external_tls_config() -> Result<ClientConfig, CryptoError> {
    use rustls_platform_verifier::BuilderVerifierExt;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|_| CryptoError::TlsFailure)?
        .with_platform_verifier()
        .map_err(|_| CryptoError::InvalidCertificate)?
        .with_no_client_auth();
    config.enable_early_data = false;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

/// Explicit per-instance outer HTTPS trust. Device CA never enters this store
/// unless the user separately selected it as public ingress trust.
pub fn external_tls_config_with_ca(pem: Option<&str>) -> Result<ClientConfig, CryptoError> {
    let Some(pem) = pem else { return external_tls_config(); };
    if pem.is_empty() || pem.len() > 65_536 { return Err(CryptoError::InvalidCertificate); }
    let roots = private_roots(pem)?;
    let mut config = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|_| CryptoError::TlsFailure)?
        .with_root_certificates(roots).with_no_client_auth();
    config.enable_early_data = false;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    UnsupportedPlatform,
    CredentialUnavailable,
    CredentialAuthorizationRequired,
    CredentialMissing,
    CredentialConflict,
    CredentialCorrupt,
    CredentialUnsafePath,
    CredentialPersistenceUnconfirmed,
    InvalidKey,
    InvalidCertificate,
    InvalidProof,
    TlsFailure,
    PeerMismatch,
    BufferLimit,
}
impl std::fmt::Display for CryptoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::UnsupportedPlatform => "NETWORK_CREDENTIAL_BACKEND_UNSUPPORTED",
            Self::CredentialAuthorizationRequired => "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED",
            Self::CredentialUnavailable => "NETWORK_CREDENTIAL_STORE_UNAVAILABLE",
            Self::CredentialMissing => "NETWORK_CREDENTIAL_KEY_MISSING",
            Self::CredentialConflict => "NETWORK_CREDENTIAL_GENERATION_CONFLICT",
            Self::CredentialCorrupt => "NETWORK_CREDENTIAL_CORRUPT",
            Self::CredentialUnsafePath => "NETWORK_CREDENTIAL_PATH_UNSAFE",
            Self::CredentialPersistenceUnconfirmed => "NETWORK_CREDENTIAL_PERSISTENCE_UNCONFIRMED",
            Self::InvalidKey => "NETWORK_KEY_INVALID",
            Self::InvalidCertificate => "NETWORK_CERTIFICATE_INVALID",
            Self::InvalidProof => "NETWORK_PROOF_INVALID",
            Self::TlsFailure => "NETWORK_TLS_FAILED",
            Self::PeerMismatch => "NETWORK_PEER_BINDING_MISMATCH",
            Self::BufferLimit => "NETWORK_BUFFER_LIMIT",
        })
    }
}
impl std::error::Error for CryptoError {}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyScope {
    pub issuer: String,
    pub environment: String,
    pub service_id: String,
    pub principal_id: String,
    pub device_id: String,
    pub key_generation: u64,
}
impl KeyScope {
    pub(crate) fn credential_name(&self) -> Result<String, CryptoError> {
        let origin = url::Url::parse(&self.issuer).map_err(|_| CryptoError::InvalidKey)?;
        if origin.scheme() != "https"
            || origin.origin().ascii_serialization() != self.issuer
            || !["production", "development"].contains(&self.environment.as_str())
            || self.principal_id.is_empty()
            || self.principal_id.len() > 256
            || self.key_generation == 0
            || self.key_generation > 9_007_199_254_740_991
            || uuid::Uuid::parse_str(&self.service_id)
                .map(|id| id.to_string())
                .as_deref()
                != Ok(&self.service_id)
            || uuid::Uuid::parse_str(&self.device_id)
                .map(|id| id.to_string())
                .as_deref()
                != Ok(&self.device_id)
        {
            return Err(CryptoError::InvalidKey);
        }
        let scope = serde_json::to_vec(self).map_err(|_| CryptoError::InvalidKey)?;
        Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(scope)))
    }
}

pub struct DevicePrivateKey {
    pub(crate) der: Zeroizing<Vec<u8>>,
}
impl DevicePrivateKey {
    pub fn generate() -> Result<Self, CryptoError> {
        let pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)
            .map_err(|_| CryptoError::InvalidKey)?;
        Self::from_der(Zeroizing::new(pair.serialize_der()))
    }
    pub(crate) fn from_der(der: Zeroizing<Vec<u8>>) -> Result<Self, CryptoError> {
        if der.len() > 4096 {
            return Err(CryptoError::InvalidKey);
        }
        SigningKey::from_pkcs8_der(&der).map_err(|_| CryptoError::InvalidKey)?;
        Ok(Self { der })
    }
    fn rcgen(&self) -> Result<rcgen::KeyPair, CryptoError> {
        rcgen::KeyPair::from_pkcs8_der_and_sign_algo(
            &PrivatePkcs8KeyDer::from(self.der.to_vec()),
            &rcgen::PKCS_ECDSA_P256_SHA256,
        )
        .map_err(|_| CryptoError::InvalidKey)
    }
    pub fn public_fingerprint(&self) -> Result<String, CryptoError> {
        Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(self.rcgen()?.subject_public_key_info())))
    }
    pub fn public_jwk(&self) -> Result<serde_json::Value, CryptoError> {
        let signing = SigningKey::from_pkcs8_der(&self.der).map_err(|_| CryptoError::InvalidKey)?;
        let point = signing.verifying_key().to_encoded_point(false);
        Ok(serde_json::json!({"kty":"EC","crv":"P-256",
            "x":URL_SAFE_NO_PAD.encode(point.x().ok_or(CryptoError::InvalidKey)?),
            "y":URL_SAFE_NO_PAD.encode(point.y().ok_or(CryptoError::InvalidKey)?)}))
    }
    pub fn public_thumbprint(&self) -> Result<String, CryptoError> {
        // serde_json's default ordered map produces RFC 7638's canonical
        // crv/kty/x/y member ordering, with no optional JWK members.
        let bytes = serde_json::to_vec(&self.public_jwk()?).map_err(|_| CryptoError::InvalidKey)?;
        Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(bytes)))
    }
    pub fn dpop(
        &self,
        method: &str,
        url: &url::Url,
        token: &str,
        nonce: Option<&str>,
    ) -> Result<String, CryptoError> {
        let mut url = url.clone();
        url.set_query(None);
        url.set_fragment(None);
        if url.scheme() != "https" || nonce.is_some_and(|n| n.len() > 256) {
            return Err(CryptoError::InvalidProof);
        }
        let header = serde_json::json!({"typ":"dpop+jwt","alg":"ES256","jwk":self.public_jwk()?});
        let mut claims = serde_json::json!({"jti":uuid::Uuid::new_v4().to_string(),"iat":jsonwebtoken::get_current_timestamp(),
            "htm":method,"htu":url.as_str(),"ath":URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))});
        if let Some(nonce) = nonce {
            claims["nonce"] = serde_json::Value::String(nonce.into());
        }
        let encoded = |value: &serde_json::Value| {
            serde_json::to_vec(value)
                .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
                .map_err(|_| CryptoError::InvalidProof)
        };
        let message = format!("{}.{}", encoded(&header)?, encoded(&claims)?);
        let signing = SigningKey::from_pkcs8_der(&self.der).map_err(|_| CryptoError::InvalidKey)?;
        let signature: Signature = signing.sign(message.as_bytes());
        Ok(format!(
            "{}.{}",
            message,
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        ))
    }
    pub fn csr(&self) -> Result<String, CryptoError> {
        let pair = self.rcgen()?;
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new())
            .map_err(|_| CryptoError::InvalidKey)?;
        params.distinguished_name = rcgen::DistinguishedName::new();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "MyAgents Device");
        params
            .serialize_request(&pair)
            .and_then(|csr| csr.pem())
            .map_err(|_| CryptoError::InvalidKey)
    }
    pub fn sign_proof(&self, challenge_id: &str, nonce: &str) -> Result<String, CryptoError> {
        if uuid::Uuid::parse_str(challenge_id)
            .map(|id| id.to_string())
            .as_deref()
            != Ok(challenge_id)
        {
            return Err(CryptoError::InvalidProof);
        }
        let nonce_bytes = URL_SAFE_NO_PAD
            .decode(nonce)
            .map_err(|_| CryptoError::InvalidProof)?;
        if nonce_bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&nonce_bytes) != nonce {
            return Err(CryptoError::InvalidProof);
        }
        let mut input = format!("MyAgents Agent Network PoP v1\n{challenge_id}\n").into_bytes();
        input.extend(nonce_bytes);
        let key = SigningKey::from_pkcs8_der(&self.der).map_err(|_| CryptoError::InvalidKey)?;
        let signature: Signature = key.sign(&input);
        Ok(URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }
    fn rustls_key(&self) -> PrivateKeyDer<'static> {
        PrivatePkcs8KeyDer::from(self.der.to_vec()).into()
    }
}

pub fn certificate_chain(pem: &str) -> Result<Vec<CertificateDer<'static>>, CryptoError> {
    if pem.len() > 65_536 {
        return Err(CryptoError::InvalidCertificate);
    }
    let certs = rustls_pemfile::certs(&mut Cursor::new(pem))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| CryptoError::InvalidCertificate)?;
    if certs.is_empty() || certs.len() > 4 {
        return Err(CryptoError::InvalidCertificate);
    }
    Ok(certs)
}
pub fn certificate_fingerprint(cert: &CertificateDer<'_>) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(cert.as_ref()))
}
pub fn private_roots(pem: &str) -> Result<RootCertStore, CryptoError> {
    let mut roots = RootCertStore::empty();
    for cert in certificate_chain(pem)? {
        roots
            .add(cert)
            .map_err(|_| CryptoError::InvalidCertificate)?;
    }
    Ok(roots)
}

pub struct TlsIdentity {
    pub certificates: Vec<CertificateDer<'static>>,
    key: Arc<DevicePrivateKey>,
}
impl TlsIdentity {
    pub fn new(
        certificates: Vec<CertificateDer<'static>>,
        key: Arc<DevicePrivateKey>,
    ) -> Result<Self, CryptoError> {
        if certificates.is_empty() {
            return Err(CryptoError::InvalidCertificate);
        }
        // Check key consistency independently of a connection's trust roots.
        let provider = rustls::crypto::ring::default_provider();
        let certified =
            rustls::sign::CertifiedKey::from_der(certificates.clone(), key.rustls_key(), &provider)
                .map_err(|_| CryptoError::InvalidKey)?;
        certified
            .keys_match()
            .map_err(|_| CryptoError::InvalidKey)?;
        Ok(Self { certificates, key })
    }
    pub fn client_config(
        &self,
        roots: RootCertStore,
        alpn: &[u8],
    ) -> Result<ClientConfig, CryptoError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut config = ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|_| CryptoError::TlsFailure)?
            .with_root_certificates(roots)
            .with_client_auth_cert(self.certificates.clone(), self.key.rustls_key())
            .map_err(|_| CryptoError::InvalidKey)?;
        config.enable_early_data = false;
        config.resumption = rustls::client::Resumption::disabled();
        config.alpn_protocols = vec![alpn.to_vec()];
        Ok(config)
    }
    pub fn server_config(&self, roots: RootCertStore) -> Result<ServerConfig, CryptoError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = rustls::server::WebPkiClientVerifier::builder_with_provider(
            Arc::new(roots),
            provider.clone(),
        )
        .build()
        .map_err(|_| CryptoError::InvalidCertificate)?;
        let mut config = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|_| CryptoError::TlsFailure)?
            .with_client_cert_verifier(verifier)
            .with_single_cert(self.certificates.clone(), self.key.rustls_key())
            .map_err(|_| CryptoError::InvalidKey)?;
        config.max_early_data_size = 0;
        config.send_tls13_tickets = 0;
        config.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
        config.alpn_protocols = vec![b"myagents-agent/1".to_vec()];
        Ok(config)
    }
}

/// Inner TLS consumes ordered relay chunks. Exact peer binding is mandatory
/// after the standard chain/name checks and before any plaintext is published.
pub struct InnerTls {
    connection: Connection,
    expected_fingerprint: String,
    expected_name: ServerName<'static>,
    verified: bool,
    failed: bool,
    plaintext_reserved: usize,
}
impl InnerTls {
    pub fn client(
        identity: &TlsIdentity,
        roots: RootCertStore,
        expected_san: String,
        expected_fingerprint: String,
    ) -> Result<Self, CryptoError> {
        let config = identity.client_config(roots, b"myagents-agent/1")?;
        let name =
            ServerName::try_from(expected_san).map_err(|_| CryptoError::InvalidCertificate)?;
        let mut connection = ClientConnection::new(Arc::new(config), name.clone())
            .map_err(|_| CryptoError::TlsFailure)?;
        connection.set_buffer_limit(Some(myagents_agent_network_protocol::budget(
            "receiveBytes",
        )));
        Ok(Self {
            connection: Connection::Client(connection),
            expected_fingerprint,
            expected_name: name,
            verified: false,
            failed: false,
            plaintext_reserved: 0,
        })
    }
    pub fn server(
        identity: &TlsIdentity,
        roots: RootCertStore,
        expected_san: String,
        expected_fingerprint: String,
    ) -> Result<Self, CryptoError> {
        let expected_name =
            ServerName::try_from(expected_san).map_err(|_| CryptoError::InvalidCertificate)?;
        let mut connection = ServerConnection::new(Arc::new(identity.server_config(roots)?))
            .map_err(|_| CryptoError::TlsFailure)?;
        connection.set_buffer_limit(Some(myagents_agent_network_protocol::budget(
            "receiveBytes",
        )));
        Ok(Self {
            connection: Connection::Server(connection),
            expected_fingerprint,
            expected_name,
            verified: false,
            failed: false,
            plaintext_reserved: 0,
        })
    }
    pub fn verified(&self) -> bool {
        self.verified && !self.failed
    }
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if self.failed {
            return Err(CryptoError::TlsFailure);
        }
        let result = self.feed_inner(chunk);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn feed_inner(&mut self, chunk: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if chunk.len() > myagents_agent_network_protocol::budget("tlsChunkBytes") {
            return Err(CryptoError::BufferLimit);
        }
        let mut cursor = Cursor::new(chunk);
        let mut plaintext = Vec::new();
        while cursor.position() < chunk.len() as u64 {
            let read = self
                .connection
                .read_tls(&mut cursor)
                .map_err(|_| CryptoError::TlsFailure)?;
            if read == 0 {
                return Err(CryptoError::TlsFailure);
            }
            self.connection
                .process_new_packets()
                .map_err(|_| CryptoError::TlsFailure)?;
            if !self.connection.is_handshaking() && !self.verified {
                let peer = self
                    .connection
                    .peer_certificates()
                    .and_then(|chain| chain.first())
                    .ok_or(CryptoError::PeerMismatch)?;
                let parsed = rustls::server::ParsedCertificate::try_from(peer)
                    .map_err(|_| CryptoError::PeerMismatch)?;
                rustls::client::verify_server_name(&parsed, &self.expected_name)
                    .map_err(|_| CryptoError::PeerMismatch)?;
                if certificate_fingerprint(peer) != self.expected_fingerprint
                    || self.connection.alpn_protocol() != Some(b"myagents-agent/1".as_slice())
                    || self.connection.protocol_version() != Some(rustls::ProtocolVersion::TLSv1_3)
                {
                    return Err(CryptoError::PeerMismatch);
                }
                self.verified = true;
            }
            // Rustls's receive buffer is bounded independently of our frame.
            // Drain each processed batch before reading more records, including
            // a relay chunk that straddles the previous TLS record boundary.
            if self.verified {
                let mut buffer = [0u8; 16_384];
                loop {
                    match self.connection.reader().read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => {
                            if plaintext.len() + count
                                > myagents_agent_network_protocol::budget("receiveBytes")
                            {
                                return Err(CryptoError::BufferLimit);
                            }
                            plaintext.extend_from_slice(&buffer[..count]);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(_) => return Err(CryptoError::TlsFailure),
                    }
                }
            }
        }
        Ok(plaintext)
    }
    pub fn write_plaintext(&mut self, bytes: &[u8]) -> Result<(), CryptoError> {
        if !self.verified() {
            return Err(CryptoError::PeerMismatch);
        }
        if bytes.len() > myagents_agent_network_protocol::budget("objectBytes") + 4 {
            return Err(CryptoError::BufferLimit);
        }
        // Reserve a conservative upper bound including record overhead before
        // writing. Rustls also enforces the independent per-channel hard limit.
        self.plaintext_reserved = self
            .plaintext_reserved
            .checked_add(bytes.len() + bytes.len().div_ceil(16_384) * 64)
            .filter(|value| *value <= myagents_agent_network_protocol::budget("receiveBytes"))
            .ok_or(CryptoError::BufferLimit)?;
        self.connection
            .writer()
            .write_all(bytes)
            .map_err(|_| CryptoError::TlsFailure)
    }
    pub fn buffered_bytes(&self) -> usize {
        self.plaintext_reserved
            + if self.connection.wants_write() {
                myagents_agent_network_protocol::budget("channelQueueBytes")
            } else {
                0
            }
    }
    pub fn drain_chunk(&mut self) -> Result<Option<Vec<u8>>, CryptoError> {
        if self.failed {
            return Err(CryptoError::TlsFailure);
        }
        if !self.connection.wants_write() {
            self.plaintext_reserved = 0;
            return Ok(None);
        }
        struct BoundedWriter {
            bytes: Vec<u8>,
            limit: usize,
        }
        impl Write for BoundedWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                let count = bytes.len().min(self.limit.saturating_sub(self.bytes.len()));
                self.bytes.extend_from_slice(&bytes[..count]);
                Ok(count)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut writer = BoundedWriter {
            bytes: Vec::new(),
            limit: myagents_agent_network_protocol::budget("tlsChunkBytes"),
        };
        while self.connection.wants_write() && writer.bytes.len() < writer.limit {
            if self
                .connection
                .write_tls(&mut writer)
                .map_err(|_| CryptoError::TlsFailure)?
                == 0
            {
                break;
            }
        }
        if writer.bytes.is_empty() {
            self.failed = true;
            return Err(CryptoError::TlsFailure);
        }
        self.plaintext_reserved = self.plaintext_reserved.saturating_sub(writer.bytes.len());
        Ok(Some(writer.bytes))
    }
    #[cfg(any(test, feature = "test-support"))]
    pub fn drain(&mut self) -> Result<Vec<Vec<u8>>, CryptoError> {
        if self.failed {
            return Err(CryptoError::TlsFailure);
        }
        let mut output = Vec::new();
        let mut count = 0;
        while let Some(bytes) = self.drain_chunk()? {
            count += bytes.len();
            if count > myagents_agent_network_protocol::budget("receiveBytes") {
                return Err(CryptoError::BufferLimit);
            }
            output.push(bytes);
        }
        Ok(output)
    }
}

#[cfg(feature = "os-store")]
mod os_store;
#[cfg(feature = "os-store")]
pub use os_store::OsIdentityStore;
#[cfg(all(feature = "os-store", target_os = "macos"))]
mod macos_credential;
#[cfg(all(feature = "os-store", target_os = "macos"))]
mod macos_helper;
#[cfg(all(feature = "os-store", target_os = "macos"))]
pub use macos_helper::run_private_credential_helper;
#[cfg(all(feature = "os-store", target_os = "macos"))]
pub use macos_credential::{
    credential_authorization_required, read_secret_authorized, read_secret_noninteractive,
    delete_secret_noninteractive, write_secret_noninteractive,
};
#[cfg(unix)]
mod encrypted_store;
#[cfg(unix)]
pub use encrypted_store::EncryptedIdentityStore;

pub trait IdentityStore: Send + Sync {
    fn load(&self, scope: &KeyScope) -> Result<DevicePrivateKey, CryptoError>;
    fn save_pending(&self, scope: &KeyScope, key: &DevicePrivateKey) -> Result<(), CryptoError>;
    fn delete(&self, scope: &KeyScope) -> Result<(), CryptoError>;
}

#[cfg(any(test, feature = "test-support"))]
pub mod tests {
    use super::*;
    #[cfg(test)]
    use p256::ecdsa::signature::Verifier;

    pub struct Fixture {
        pub ca: rcgen::Certificate,
        pub first: TlsIdentity,
        pub second: TlsIdentity,
    }
    impl Default for Fixture {
        fn default() -> Self {
            Self::new()
        }
    }
    impl Fixture {
        pub fn new() -> Self {
            let ca_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
            let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
            ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
            ca_params.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign];
            let ca = ca_params.self_signed(&ca_key).unwrap();
            let issuer = rcgen::Issuer::new(ca_params, ca_key);
            let leaf = |name: &str| {
                let key = Arc::new(DevicePrivateKey::generate().unwrap());
                let mut params = rcgen::CertificateParams::new(vec![name.to_string()]).unwrap();
                params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
                params.extended_key_usages = vec![
                    rcgen::ExtendedKeyUsagePurpose::ClientAuth,
                    rcgen::ExtendedKeyUsagePurpose::ServerAuth,
                ];
                let cert = params.signed_by(&key.rcgen().unwrap(), &issuer).unwrap();
                TlsIdentity::new(vec![cert.der().clone()], key).unwrap()
            };
            Self {
                ca,
                first: leaf("first.network.invalid"),
                second: leaf("second.network.invalid"),
            }
        }
        pub fn roots(&self) -> RootCertStore {
            private_roots(&self.ca.pem()).unwrap()
        }
        #[cfg(test)]
        fn peers(&self) -> (InnerTls, InnerTls) {
            (
                InnerTls::client(
                    &self.first,
                    self.roots(),
                    "second.network.invalid".into(),
                    certificate_fingerprint(&self.second.certificates[0]),
                )
                .unwrap(),
                InnerTls::server(
                    &self.second,
                    self.roots(),
                    "first.network.invalid".into(),
                    certificate_fingerprint(&self.first.certificates[0]),
                )
                .unwrap(),
            )
        }
    }
    #[cfg(test)]
    fn handshake(client: &mut InnerTls, server: &mut InnerTls) -> Result<(), CryptoError> {
        for _ in 0..10 {
            for chunk in client.drain()? {
                assert!(server.feed(&chunk)?.is_empty());
            }
            for chunk in server.drain()? {
                assert!(client.feed(&chunk)?.is_empty());
            }
            if client.verified() && server.verified() {
                return Ok(());
            }
        }
        panic!("TLS handshake did not converge");
    }

    #[test]
    fn network_tls_encrypts_full_large_objects_and_recovers_fragmented_records() {
        let fixture = Fixture::new();
        let (mut client, mut server) = fixture.peers();
        handshake(&mut client, &mut server).unwrap();
        let secret = b"private-query-and-full-response-metadata";
        let mut object = vec![b' '; myagents_agent_network_protocol::budget("objectBytes")];
        object[..secret.len()].copy_from_slice(secret);
        let mut framed = (object.len() as u32).to_be_bytes().to_vec();
        framed.extend_from_slice(&object);
        client.write_plaintext(&framed).unwrap();
        let chunks = client.drain().unwrap();
        let mut received = Vec::new();
        for chunk in chunks {
            assert!(!chunk.windows(secret.len()).any(|window| window == secret));
            // Deliberately split TLS records independently of the relay frame.
            for part in chunk.chunks(997) {
                received.extend(server.feed(part).unwrap());
            }
        }
        assert_eq!(received, framed);
        server.write_plaintext(b"complete-response").unwrap();
        let reply: Vec<_> = server
            .drain()
            .unwrap()
            .into_iter()
            .flat_map(|bytes| client.feed(&bytes).unwrap())
            .collect();
        assert_eq!(reply, b"complete-response");
    }

    #[test]
    fn network_tls_rejects_peer_binding_and_both_roles_wrong_names() {
        let fixture = Fixture::new();
        for mismatch in ["fingerprint", "server-name", "client-name"] {
            let client_name = if mismatch == "client-name" {
                "other.network.invalid"
            } else {
                "first.network.invalid"
            };
            let server_name = if mismatch == "server-name" {
                "other.network.invalid"
            } else {
                "second.network.invalid"
            };
            let expected = if mismatch == "fingerprint" {
                "wrong-fingerprint".into()
            } else {
                certificate_fingerprint(&fixture.second.certificates[0])
            };
            let mut client = InnerTls::client(
                &fixture.first,
                fixture.roots(),
                server_name.into(),
                expected,
            )
            .unwrap();
            let mut server = InnerTls::server(
                &fixture.second,
                fixture.roots(),
                client_name.into(),
                certificate_fingerprint(&fixture.first.certificates[0]),
            )
            .unwrap();
            assert!(handshake(&mut client, &mut server).is_err());
            assert!(!client.verified() || !server.verified());
            // A failed channel cannot publish any later buffered plaintext.
            let failed = if client.failed {
                &mut client
            } else {
                &mut server
            };
            assert_eq!(failed.feed(&[]), Err(CryptoError::TlsFailure));
            assert!(failed.write_plaintext(b"query").is_err());
        }
    }

    #[test]
    fn network_tls_rejects_tampering_replay_and_mismatched_private_key() {
        let fixture = Fixture::new();
        assert!(TlsIdentity::new(
            fixture.first.certificates.clone(),
            fixture.second.key.clone()
        )
        .is_err());
        for replay in [true, false] {
            let (mut client, mut server) = fixture.peers();
            handshake(&mut client, &mut server).unwrap();
            client.write_plaintext(b"query").unwrap();
            let mut chunk = client.drain().unwrap().concat();
            if replay {
                assert_eq!(server.feed(&chunk).unwrap(), b"query");
            } else {
                let last = chunk.len() - 1;
                chunk[last] ^= 1;
            }
            assert_eq!(server.feed(&chunk), Err(CryptoError::TlsFailure));
            assert!(!server.verified());
        }
    }

    #[test]
    fn dpop_uses_stable_rfc7638_key_and_canonical_method_uri_and_token_hash() {
        let key = DevicePrivateKey::generate().unwrap();
        let url = url::Url::parse("https://relay.myagents.test/v1/devices?cursor=ignored#ignored")
            .unwrap();
        let proof = key
            .dpop("GET", &url, "isolated-token", Some("test-nonce"))
            .unwrap();
        let segments = proof.split('.').collect::<Vec<_>>();
        assert_eq!(segments.len(), 3);
        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segments[0]).unwrap()).unwrap();
        assert_eq!(header["typ"], "dpop+jwt");
        assert_eq!(header["jwk"], key.public_jwk().unwrap());
        assert!(header["jwk"].get("d").is_none());
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segments[1]).unwrap()).unwrap();
        assert_eq!(claims["htu"], "https://relay.myagents.test/v1/devices");
        assert_eq!(claims["htm"], "GET");
        assert_eq!(claims["nonce"], "test-nonce");
        assert_eq!(
            claims["ath"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(b"isolated-token"))
        );
        assert_eq!(claims.as_object().unwrap().len(), 6);
        let jwk: jsonwebtoken::jwk::Jwk = serde_json::from_value(header["jwk"].clone()).unwrap();
        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::ES256);
        validation.validate_exp = false;
        validation.required_spec_claims.clear();
        let decoded = jsonwebtoken::decode::<serde_json::Value>(
            &proof,
            &jsonwebtoken::DecodingKey::from_jwk(&jwk).unwrap(),
            &validation,
        )
        .unwrap();
        assert_eq!(decoded.claims, claims);
        assert_eq!(
            key.public_thumbprint().unwrap(),
            URL_SAFE_NO_PAD.encode(Sha256::digest(serde_json::to_vec(&header["jwk"]).unwrap()))
        );
        assert_ne!(
            key.public_fingerprint().unwrap(),
            key.public_thumbprint().unwrap()
        );
        assert!(key
            .dpop(
                "GET",
                &url::Url::parse("http://untrusted.test").unwrap(),
                "token",
                None
            )
            .is_err());
    }

    #[test]
    fn network_proof_is_p1363_bound_to_challenge_and_canonical_nonce() {
        let key = DevicePrivateKey::generate().unwrap();
        assert!(key
            .csr()
            .unwrap()
            .starts_with("-----BEGIN CERTIFICATE REQUEST-----"));
        let id = "00000000-0000-4000-8000-000000000001";
        let nonce = URL_SAFE_NO_PAD.encode([42u8; 32]);
        let proof = URL_SAFE_NO_PAD
            .decode(key.sign_proof(id, &nonce).unwrap())
            .unwrap();
        assert_eq!(proof.len(), 64);
        let signature = Signature::from_slice(&proof).unwrap();
        let signing = SigningKey::from_pkcs8_der(&key.der).unwrap();
        let mut message = format!("MyAgents Agent Network PoP v1\n{id}\n").into_bytes();
        message.extend([42u8; 32]);
        signing
            .verifying_key()
            .verify(&message, &signature)
            .unwrap();
        message[0] ^= 1;
        assert!(signing
            .verifying_key()
            .verify(&message, &signature)
            .is_err());
        assert_eq!(
            key.sign_proof(id, &(nonce + "=")),
            Err(CryptoError::InvalidProof)
        );
    }

    #[test]
    #[cfg(feature = "os-store")]
    #[ignore = "Explicit OS integration: creates and deletes isolated real system credentials"]
    fn network_os_credentials_persist_scope_and_never_replace_a_generation() {
        let scope = KeyScope {
            issuer: "https://isolated-credentials.myagents.invalid".into(),
            environment: "development".into(),
            service_id: uuid::Uuid::new_v4().to_string(),
            principal_id: "isolated-test-owner".into(),
            device_id: uuid::Uuid::new_v4().to_string(),
            key_generation: 1,
        };
        struct Cleanup(KeyScope);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = OsIdentityStore::delete(&self.0);
            }
        }
        let _cleanup = Cleanup(scope.clone());
        assert!(matches!(
            OsIdentityStore::load(&scope),
            Err(CryptoError::CredentialMissing)
        ));
        let key = DevicePrivateKey::generate().unwrap();
        OsIdentityStore::save_pending(&scope, &key).unwrap();
        assert_eq!(
            OsIdentityStore::load(&scope)
                .unwrap()
                .public_fingerprint()
                .unwrap(),
            key.public_fingerprint().unwrap()
        );
        OsIdentityStore::save_pending(&scope, &key).unwrap();
        assert_eq!(
            OsIdentityStore::save_pending(&scope, &DevicePrivateKey::generate().unwrap()),
            Err(CryptoError::CredentialConflict)
        );
        let mut other = scope.clone();
        other.principal_id = "isolated-other-account".into();
        assert!(matches!(
            OsIdentityStore::load(&other),
            Err(CryptoError::CredentialMissing)
        ));
        other = scope.clone();
        other.key_generation = 2;
        assert!(matches!(
            OsIdentityStore::load(&other),
            Err(CryptoError::CredentialMissing)
        ));
        other = scope.clone();
        other.environment = "production".into();
        assert!(matches!(
            OsIdentityStore::load(&other),
            Err(CryptoError::CredentialMissing)
        ));
        OsIdentityStore::delete(&scope).unwrap();
        assert!(matches!(
            OsIdentityStore::load(&scope),
            Err(CryptoError::CredentialMissing)
        ));
    }
}
