//! Small certificate/JWT signer for the self-hosted AgentNet identity service.
//!
//! This crate does not authenticate callers, persist device generations, or
//! implement HTTP admission. Its caller must construct `IdentityRequest` only
//! after those owners have authorized the requested scope.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use myagents_agent_network_crypto::{certificate_chain, certificate_fingerprint};
use myagents_agent_network_protocol::{
    budget, validate_access, validate_bootstrap, validate_signed_peer, PeerBinding,
};
use p256::{
    ecdsa::{signature::Signer as _, Signature as P256Signature, SigningKey as P256SigningKey},
    pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding},
};
use rand_core::OsRng;
use rcgen::{
    BasicConstraints, CertificateParams, CertificateSigningRequestParams, DistinguishedName,
    DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyUsagePurpose, PublicKeyData,
    SignatureAlgorithm, SigningKey as RcgenSigningKey, PKCS_ECDSA_P256_SHA256,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs,
    io::Read,
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawFd, FromRawFd},
    },
    path::Path,
};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const MAX_KEY_FILE: u64 = 64 * 1024;
const ROOT_DAYS: i64 = 3650;
const ISSUING_DAYS: i64 = 1825;
const DEVICE_CERT_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityCoreError {
    UnsafeKeyFile,
    KeyFileExists,
    KeyMaterialInvalid,
    ProfileInvalid,
    ScopeInvalid,
    CsrInvalid,
    TokenInvalid,
    CertificateInvalid,
    Io,
}

impl std::fmt::Display for IdentityCoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::UnsafeKeyFile => "unsafe identity key file",
            Self::KeyFileExists => "identity key file already exists",
            Self::KeyMaterialInvalid => "identity key material invalid",
            Self::ProfileInvalid => "identity issuer profile invalid",
            Self::ScopeInvalid => "identity scope invalid",
            Self::CsrInvalid => "device CSR invalid",
            Self::TokenInvalid => "identity token construction invalid",
            Self::CertificateInvalid => "device certificate construction invalid",
            Self::Io => "identity key file I/O failed",
        })
    }
}
impl std::error::Error for IdentityCoreError {}

#[derive(Clone)]
pub struct IssuerProfile {
    pub issuer: String,
    pub service_id: String,
    pub environment: String,
    pub network_id: String,
}

impl IssuerProfile {
    fn validate(&self) -> Result<(), IdentityCoreError> {
        let url = url::Url::parse(&self.issuer).map_err(|_| IdentityCoreError::ProfileInvalid)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || url.origin().ascii_serialization() != self.issuer
            || !canonical_uuid(&self.service_id)
            || !canonical_uuid(&self.network_id)
            || !["production", "development"].contains(&self.environment.as_str())
        {
            return Err(IdentityCoreError::ProfileInvalid);
        }
        Ok(())
    }
}

/// This is an already-authorized identity scope. HTTP/session authorization and
/// generation compare-and-set are deliberately owned by the future service.
#[derive(Clone)]
pub struct IdentityRequest {
    pub principal_id: String,
    pub device_id: String,
    pub key_generation: u64,
    pub identity_binding_id: String,
    pub session_handle: String,
    pub csr_pem: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedKeys {
    signing_key_pem: String,
    issuing_key_pem: String,
    issuing_certificate_pem: String,
    root_certificate_pem: String,
}

impl Drop for PersistedKeys {
    fn drop(&mut self) {
        self.signing_key_pem.zeroize();
        self.issuing_key_pem.zeroize();
    }
}

pub struct ServiceKeys {
    signing_key_pem: Zeroizing<String>,
    issuing_key_pem: Zeroizing<String>,
    issuing_certificate_pem: String,
    root_certificate_pem: String,
    kid: String,
    jwk: Value,
}

struct RcgenP256Key {
    key: P256SigningKey,
    public_bytes: Vec<u8>,
}

impl RcgenP256Key {
    fn from_pem(pem: &str) -> Result<Self, IdentityCoreError> {
        let key = P256SigningKey::from_pkcs8_pem(pem)
            .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        let public_bytes = key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        Ok(Self { key, public_bytes })
    }

    fn generate() -> Result<(Self, Zeroizing<String>), IdentityCoreError> {
        let key = P256SigningKey::random(&mut OsRng);
        let pem = key
            .to_pkcs8_pem(LineEnding::LF)
            .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        let pem = Zeroizing::new(pem.to_string());
        let public_bytes = key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        Ok((Self { key, public_bytes }, pem))
    }
}

impl PublicKeyData for RcgenP256Key {
    fn der_bytes(&self) -> &[u8] {
        &self.public_bytes
    }
    fn algorithm(&self) -> &'static SignatureAlgorithm {
        &PKCS_ECDSA_P256_SHA256
    }
}

impl RcgenSigningKey for RcgenP256Key {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, rcgen::Error> {
        let signature: P256Signature = self.key.sign(message);
        Ok(signature.to_der().as_bytes().to_vec())
    }
}

impl ServiceKeys {
    /// Load existing stable signing/CA material. Invalid or missing state is
    /// never replaced automatically.
    pub fn load(path: impl AsRef<Path>) -> Result<Self, IdentityCoreError> {
        let file = open_private_file(path.as_ref())?;
        let metadata = file
            .metadata()
            .map_err(|_| IdentityCoreError::UnsafeKeyFile)?;
        if metadata.len() > MAX_KEY_FILE {
            return Err(IdentityCoreError::UnsafeKeyFile);
        }
        let mut bytes = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
        file.take(MAX_KEY_FILE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| IdentityCoreError::Io)?;
        if bytes.len() as u64 > MAX_KEY_FILE {
            return Err(IdentityCoreError::UnsafeKeyFile);
        }
        let persisted: PersistedKeys =
            serde_json::from_slice(&bytes).map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        Self::from_persisted(persisted)
    }

    /// Explicit first-time key creation. Existing paths are never overwritten.
    pub fn generate_initial(path: impl AsRef<Path>) -> Result<Self, IdentityCoreError> {
        let path = path.as_ref();
        let parent_path = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let directory = open_private_directory(parent_path)?;
        let filename = path.file_name().ok_or(IdentityCoreError::UnsafeKeyFile)?;
        let filename =
            CString::new(filename.as_bytes()).map_err(|_| IdentityCoreError::UnsafeKeyFile)?;
        let persisted = generate_key_material()?;
        let bytes = Zeroizing::new(
            serde_json::to_vec(&persisted).map_err(|_| IdentityCoreError::KeyMaterialInvalid)?,
        );
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                filename.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                return Err(IdentityCoreError::KeyFileExists);
            }
            return Err(IdentityCoreError::Io);
        }
        let mut file = unsafe { fs::File::from_raw_fd(fd) };
        use std::io::Write;
        file.write_all(&bytes).map_err(|_| IdentityCoreError::Io)?;
        file.sync_all().map_err(|_| IdentityCoreError::Io)?;
        // Persist the new directory entry. On failure, leave the exclusive file
        // in place so a later start cannot silently replace partially durable state.
        directory.sync_all().map_err(|_| IdentityCoreError::Io)?;
        Self::from_persisted(persisted)
    }

    fn from_persisted(mut p: PersistedKeys) -> Result<Self, IdentityCoreError> {
        let signing_key_pem = Zeroizing::new(std::mem::take(&mut p.signing_key_pem));
        let issuing_key_pem = Zeroizing::new(std::mem::take(&mut p.issuing_key_pem));
        let issuing_certificate_pem = std::mem::take(&mut p.issuing_certificate_pem);
        let root_certificate_pem = std::mem::take(&mut p.root_certificate_pem);
        let signing = P256SigningKey::from_pkcs8_pem(&signing_key_pem)
            .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        let signing_public = signing.verifying_key().to_encoded_point(false);
        let public_jwk = json!({
            "kty":"EC", "crv":"P-256",
            "x":URL_SAFE_NO_PAD.encode(signing_public.x().ok_or(IdentityCoreError::KeyMaterialInvalid)?),
            "y":URL_SAFE_NO_PAD.encode(signing_public.y().ok_or(IdentityCoreError::KeyMaterialInvalid)?)
        });
        let kid = URL_SAFE_NO_PAD.encode(Sha256::digest(
            serde_json::to_vec(&public_jwk).map_err(|_| IdentityCoreError::KeyMaterialInvalid)?,
        ));
        let mut jwk = public_jwk;
        jwk["kid"] = json!(kid);
        jwk["alg"] = json!("ES256");
        jwk["use"] = json!("sig");
        let issuer_key = RcgenP256Key::from_pem(&issuing_key_pem)?;
        let root_chain = certificate_chain(&root_certificate_pem)
            .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        if root_chain.len() != 1 {
            return Err(IdentityCoreError::KeyMaterialInvalid);
        }
        let (remaining, root) = x509_parser::parse_x509_certificate(&root_chain[0])
            .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        if !remaining.is_empty()
            || !root.tbs_certificate.is_ca()
            || !root.validity().is_valid()
            || !root
                .tbs_certificate
                .key_usage()
                .ok()
                .flatten()
                .is_some_and(|ku| ku.value.key_cert_sign())
            || root.verify_signature(None).is_err()
        {
            return Err(IdentityCoreError::KeyMaterialInvalid);
        }
        let ca_chain = certificate_chain(&issuing_certificate_pem)
            .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        if ca_chain.len() != 1 {
            return Err(IdentityCoreError::KeyMaterialInvalid);
        }
        let (remaining, ca) = x509_parser::parse_x509_certificate(&ca_chain[0])
            .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        if !remaining.is_empty()
            || !ca.tbs_certificate.is_ca()
            || !ca.validity().is_valid()
            || !ca
                .tbs_certificate
                .key_usage()
                .ok()
                .flatten()
                .is_some_and(|ku| ku.value.key_cert_sign())
            || ca
                .verify_signature(Some(&root.tbs_certificate.subject_pki))
                .is_err()
            || ca
                .tbs_certificate
                .subject_pki
                .subject_public_key
                .data
                .as_ref()
                != issuer_key.der_bytes()
        {
            return Err(IdentityCoreError::KeyMaterialInvalid);
        }
        // Ensure the CA certificate can be loaded as an rcgen issuer.
        Issuer::from_ca_cert_pem(&issuing_certificate_pem, issuer_key)
            .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        Ok(Self {
            signing_key_pem,
            issuing_key_pem,
            issuing_certificate_pem,
            root_certificate_pem,
            kid,
            jwk,
        })
    }

    pub fn root_certificate_pem(&self) -> &str {
        &self.root_certificate_pem
    }
    pub fn jwks(&self) -> Value {
        json!({"keys":[self.jwk.clone()]})
    }

    pub fn issue(
        &self,
        profile: &IssuerProfile,
        request: &IdentityRequest,
    ) -> Result<IssuedIdentity, IdentityCoreError> {
        profile.validate()?;
        validate_scope(profile, request)?;
        let csr = CertificateSigningRequestParams::from_pem(&request.csr_pem)
            .map_err(|_| IdentityCoreError::CsrInvalid)?;
        if csr.public_key.algorithm() != &PKCS_ECDSA_P256_SHA256 {
            return Err(IdentityCoreError::CsrInvalid);
        }
        // Deliberately discard all CSR subject/extension requests. Only the
        // signature-verified P-256 key crosses into the server-formed leaf.
        let now = OffsetDateTime::now_utc();
        let expires = now.unix_timestamp().max(0) as u64 + DEVICE_CERT_SECONDS;
        let san = format!(
            "{}.devices.{}.invalid",
            request.identity_binding_id, profile.service_id
        );
        let mut params = CertificateParams::new(vec![san.clone()])
            .map_err(|_| IdentityCoreError::CertificateInvalid)?;
        params.is_ca = IsCa::NoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![
            ExtendedKeyUsagePurpose::ClientAuth,
            ExtendedKeyUsagePurpose::ServerAuth,
        ];
        params.not_before = now - Duration::minutes(2);
        params.not_after = now + Duration::seconds(DEVICE_CERT_SECONDS as i64);
        let mut dn = DistinguishedName::new();
        dn.push(
            DnType::CommonName,
            format!("AgentNet device {}", request.device_id),
        );
        params.distinguished_name = dn;
        let issuer_key = RcgenP256Key::from_pem(&self.issuing_key_pem)?;
        let issuer = Issuer::from_ca_cert_pem(&self.issuing_certificate_pem, issuer_key)
            .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        let leaf = csr.public_key;
        let cert = params
            .signed_by(&leaf, &issuer)
            .map_err(|_| IdentityCoreError::CertificateInvalid)?;
        let certificate = cert.pem();
        let cert_der =
            certificate_chain(&certificate).map_err(|_| IdentityCoreError::CertificateInvalid)?;
        if cert_der.len() != 1 {
            return Err(IdentityCoreError::CertificateInvalid);
        }
        let fingerprint = certificate_fingerprint(&cert_der[0]);
        let chain = vec![
            self.issuing_certificate_pem.clone(),
            self.root_certificate_pem.clone(),
        ];
        let binding = PeerBinding {
            service_id: profile.service_id.clone(),
            environment: profile.environment.clone(),
            principal_id: request.principal_id.clone(),
            device_id: request.device_id.clone(),
            key_generation: request.key_generation,
            identity_binding_id: request.identity_binding_id.clone(),
            certificate_fingerprint: fingerprint.clone(),
            san: san.clone(),
            certificate: certificate.clone(),
            expires_at: expires,
        };
        let peer_claims = json!({
            "iss":profile.issuer, "aud":"myagents-agent-peer", "sub":request.principal_id,
            "iat":now.unix_timestamp(), "nbf":now.unix_timestamp(), "exp":expires,
            "jti":Uuid::new_v4().to_string(), "binding":binding
        });
        validate_signed_peer(&peer_claims).map_err(|_| IdentityCoreError::TokenInvalid)?;
        let signed_binding = self.sign_jwt("ma-network-peer+jwt", peer_claims)?;

        let token_exp = now.unix_timestamp() + budget("tokenSeconds") as i64;
        let base_claims = json!({
            "iss":profile.issuer, "aud":profile.service_id, "sub":request.principal_id,
            "iat":now.unix_timestamp(), "nbf":now.unix_timestamp(), "exp":token_exp,
            "jti":Uuid::new_v4().to_string(), "environment":profile.environment,
            "deviceId":request.device_id, "keyGeneration":request.key_generation,
            "sessionHandle":request.session_handle, "cnf":{"jkt":request_jkt(&leaf)?}
        });
        validate_access(&base_claims).map_err(|_| IdentityCoreError::TokenInvalid)?;
        let access_token = self.sign_jwt("ma-network-access+jwt", base_claims.clone())?;
        let mut bootstrap_claims = base_claims;
        bootstrap_claims["networkUrl"] = json!(profile.issuer);
        bootstrap_claims["rootCertificate"] = json!(self.root_certificate_pem);
        validate_bootstrap(&bootstrap_claims).map_err(|_| IdentityCoreError::TokenInvalid)?;
        let bootstrap_grant = self.sign_jwt("ma-network-bootstrap+jwt", bootstrap_claims)?;

        Ok(IssuedIdentity {
            device_id: request.device_id.clone(),
            key_generation: request.key_generation,
            identity_binding_id: request.identity_binding_id.clone(),
            certificate: Some(certificate),
            certificate_chain: chain,
            certificate_fingerprint: Some(fingerprint),
            signed_binding: Some(signed_binding),
            certificate_expires_at: Some(expires),
            access_token,
            access_token_expires_at: token_exp as u64,
            bootstrap_grant,
        })
    }

    fn sign_jwt(&self, typ: &str, claims: Value) -> Result<String, IdentityCoreError> {
        let signing = P256SigningKey::from_pkcs8_pem(&self.signing_key_pem)
            .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        let private_der = signing
            .to_pkcs8_der()
            .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
        let key = EncodingKey::from_ec_der(private_der.as_bytes());
        let mut header = Header::new(Algorithm::ES256);
        header.typ = Some(typ.to_owned());
        header.kid = Some(self.kid.clone());
        jsonwebtoken::encode(&header, &claims, &key).map_err(|_| IdentityCoreError::TokenInvalid)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssuedIdentity {
    pub device_id: String,
    pub key_generation: u64,
    pub identity_binding_id: String,
    pub certificate: Option<String>,
    pub certificate_chain: Vec<String>,
    pub certificate_fingerprint: Option<String>,
    pub signed_binding: Option<String>,
    pub certificate_expires_at: Option<u64>,
    pub access_token: String,
    pub access_token_expires_at: u64,
    pub bootstrap_grant: String,
}

impl IssuedIdentity {
    pub fn as_json(&self) -> Result<Value, IdentityCoreError> {
        serde_json::to_value(self).map_err(|_| IdentityCoreError::TokenInvalid)
    }
}

fn validate_scope(
    _profile: &IssuerProfile,
    request: &IdentityRequest,
) -> Result<(), IdentityCoreError> {
    if request.principal_id.is_empty()
        || request.principal_id.len() > 256
        || !canonical_uuid(&request.device_id)
        || !canonical_uuid(&request.identity_binding_id)
        || !canonical_uuid(&request.session_handle)
        || request.key_generation == 0
        || request.key_generation > 9_007_199_254_740_991
        || request.csr_pem.len() > 65_536
    {
        return Err(IdentityCoreError::ScopeInvalid);
    }
    Ok(())
}

fn request_jkt(key: &impl rcgen::PublicKeyData) -> Result<String, IdentityCoreError> {
    let raw = key.der_bytes();
    if raw.len() != 65 || raw[0] != 4 {
        return Err(IdentityCoreError::CsrInvalid);
    }
    let jwk = json!({"crv":"P-256","kty":"EC","x":URL_SAFE_NO_PAD.encode(&raw[1..33]),"y":URL_SAFE_NO_PAD.encode(&raw[33..])});
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(
        serde_json::to_vec(&jwk).map_err(|_| IdentityCoreError::CsrInvalid)?,
    )))
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|uuid| uuid.to_string() == value)
}

fn open_private_file(path: &Path) -> Result<fs::File, IdentityCoreError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| IdentityCoreError::UnsafeKeyFile)?;
    if !metadata.file_type().is_file()
        || metadata.nlink() != 1
        || metadata.mode() & 0o777 != 0o600
        || metadata.uid() != nix_uid()
    {
        return Err(IdentityCoreError::UnsafeKeyFile);
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| IdentityCoreError::UnsafeKeyFile)?;
    let opened = file
        .metadata()
        .map_err(|_| IdentityCoreError::UnsafeKeyFile)?;
    if !opened.file_type().is_file()
        || opened.nlink() != 1
        || opened.mode() & 0o777 != 0o600
        || opened.uid() != nix_uid()
        || opened.ino() != metadata.ino()
        || opened.dev() != metadata.dev()
    {
        return Err(IdentityCoreError::UnsafeKeyFile);
    }
    Ok(file)
}

/// Open and pin a private owner directory before creating first-run key state.
/// The final path component itself may not be a symlink; intermediate path
/// components resolve normally, but the opened directory must be euid-owned
/// and mode 0700 before it is trusted.
fn open_private_directory(path: &Path) -> Result<fs::File, IdentityCoreError> {
    let mut options = fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let directory = options
        .open(path)
        .map_err(|_| IdentityCoreError::UnsafeKeyFile)?;
    let metadata = directory
        .metadata()
        .map_err(|_| IdentityCoreError::UnsafeKeyFile)?;
    if !metadata.file_type().is_dir()
        || metadata.uid() != nix_uid()
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(IdentityCoreError::UnsafeKeyFile);
    }
    Ok(directory)
}

fn nix_uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn generate_key_material() -> Result<PersistedKeys, IdentityCoreError> {
    let signing = P256SigningKey::random(&mut OsRng);
    let signing_pem = signing
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
    let (root_key, _root_pem) = RcgenP256Key::generate()?;
    let now = OffsetDateTime::now_utc();
    let mut root_params = CertificateParams::new(Vec::<String>::new())
        .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
    root_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    root_params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    root_params.not_before = now - Duration::minutes(2);
    root_params.not_after = now + Duration::days(ROOT_DAYS);
    root_params
        .distinguished_name
        .push(DnType::CommonName, "AgentNet Service Root");
    let root_cert = root_params
        .self_signed(&root_key)
        .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?
        .pem();

    let (issuing_key, issuing_pem) = RcgenP256Key::generate()?;
    let root_issuer = Issuer::from_ca_cert_pem(&root_cert, root_key)
        .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
    let mut issuing_params = CertificateParams::new(Vec::<String>::new())
        .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?;
    issuing_params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    issuing_params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    issuing_params.not_before = now - Duration::minutes(2);
    issuing_params.not_after = now + Duration::days(ISSUING_DAYS);
    issuing_params
        .distinguished_name
        .push(DnType::CommonName, "AgentNet Device Issuer");
    let issuing_cert = issuing_params
        .signed_by(&issuing_key, &root_issuer)
        .map_err(|_| IdentityCoreError::KeyMaterialInvalid)?
        .pem();
    Ok(PersistedKeys {
        signing_key_pem: signing_pem.to_string(),
        issuing_key_pem: issuing_pem.to_string(),
        issuing_certificate_pem: issuing_cert,
        root_certificate_pem: root_cert,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use myagents_agent_network_crypto::{DevicePrivateKey, TlsIdentity};
    use std::os::unix::fs::PermissionsExt;

    fn fixture() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        IssuerProfile,
        IdentityRequest,
        DevicePrivateKey,
    ) {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.path().join("identity-keys.json");
        let device = DevicePrivateKey::generate().unwrap();
        let profile = IssuerProfile {
            issuer: "https://agentnet.example.test".into(),
            service_id: Uuid::new_v4().to_string(),
            environment: "development".into(),
            network_id: Uuid::new_v4().to_string(),
        };
        let request = IdentityRequest {
            principal_id: "oidc:subject-1".into(),
            device_id: Uuid::new_v4().to_string(),
            key_generation: 1,
            identity_binding_id: Uuid::new_v4().to_string(),
            session_handle: Uuid::new_v4().to_string(),
            csr_pem: device.csr().unwrap(),
        };
        (dir, path, profile, request, device)
    }

    #[test]
    fn initial_key_material_is_stable_and_never_overwritten() {
        let (_dir, path, profile, request, device) = fixture();
        let first = ServiceKeys::generate_initial(&path).unwrap();
        let initial = first.issue(&profile, &request).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(2));
        let second = ServiceKeys::load(&path).unwrap();
        let restarted = second.issue(&profile, &request).unwrap();
        assert_eq!(first.jwks(), second.jwks());
        assert_eq!(first.root_certificate_pem(), second.root_certificate_pem());
        assert_eq!(initial.certificate_chain, restarted.certificate_chain);
        assert_ne!(
            initial.certificate_fingerprint,
            restarted.certificate_fingerprint
        );
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(
            ServiceKeys::generate_initial(&path).err().unwrap(),
            IdentityCoreError::KeyFileExists
        );
        let device = std::sync::Arc::new(device);
        for issued in [&initial, &restarted] {
            let mut full = certificate_chain(issued.certificate.as_deref().unwrap()).unwrap();
            for pem in &issued.certificate_chain {
                full.extend(certificate_chain(pem).unwrap());
            }
            TlsIdentity::new(full.clone(), device.clone()).unwrap();
            let (rest, leaf) = x509_parser::parse_x509_certificate(&full[0]).unwrap();
            assert!(rest.is_empty());
            assert!(leaf
                .verify_signature(Some(
                    &x509_parser::parse_x509_certificate(&full[1])
                        .unwrap()
                        .1
                        .tbs_certificate
                        .subject_pki
                ))
                .is_ok());
            assert!(leaf.tbs_certificate.subject_alternative_name().unwrap().unwrap().value.general_names.iter().any(|name| {
                matches!(name, x509_parser::extensions::GeneralName::DNSName(value) if *value == format!("{}.devices.{}.invalid", request.identity_binding_id, profile.service_id))
            }));
            let (_, issuer) = x509_parser::parse_x509_certificate(&full[1]).unwrap();
            assert!(issuer
                .verify_signature(Some(
                    &x509_parser::parse_x509_certificate(&full[2])
                        .unwrap()
                        .1
                        .tbs_certificate
                        .subject_pki
                ))
                .is_ok());
        }
    }

    #[test]
    fn signed_tokens_pass_fixed_claim_schemas_and_verify_from_pinned_jwks() {
        let (_dir, path, profile, request, _device) = fixture();
        let keys = ServiceKeys::generate_initial(&path).unwrap();
        let issued = keys.issue(&profile, &request).unwrap();
        assert_eq!(budget("certificateSeconds") as u64, DEVICE_CERT_SECONDS);
        let access_claims = decode_payload(&issued.access_token);
        assert_eq!(
            access_claims["exp"].as_u64().unwrap() - access_claims["iat"].as_u64().unwrap(),
            budget("tokenSeconds") as u64
        );
        let mut expired_claims = access_claims.clone();
        let now = OffsetDateTime::now_utc().unix_timestamp();
        expired_claims["iat"] = json!(now - 120);
        expired_claims["nbf"] = json!(now - 120);
        expired_claims["exp"] = json!(now - 120);
        expired_claims["jti"] = json!(Uuid::new_v4().to_string());
        let expired = keys
            .sign_jwt("ma-network-access+jwt", expired_claims)
            .unwrap();
        let set: jsonwebtoken::jwk::JwkSet = serde_json::from_value(keys.jwks()).unwrap();
        let header = jsonwebtoken::decode_header(&expired).unwrap();
        let decode_key =
            jsonwebtoken::DecodingKey::from_jwk(set.find(header.kid.as_deref().unwrap()).unwrap())
                .unwrap();
        let mut validation = jsonwebtoken::Validation::new(Algorithm::ES256);
        validation.set_issuer(&[profile.issuer.as_str()]);
        validation.set_audience(&[profile.service_id.as_str()]);
        assert!(jsonwebtoken::decode::<Value>(&expired, &decode_key, &validation).is_err());
        let (token, typ, validator) = (
            &issued.access_token,
            "ma-network-access+jwt",
            validate_access as fn(&Value) -> _,
        );
        let header = jsonwebtoken::decode_header(token).unwrap();
        assert_eq!(header.typ.as_deref(), Some(typ));
        verify_token(token, &keys.jwks(), &profile, &request, validator);
        verify_token(
            &issued.bootstrap_grant,
            &keys.jwks(),
            &profile,
            &request,
            validate_bootstrap,
        );
        let peer_token = issued.signed_binding.clone().unwrap();
        verify_peer_token(&peer_token, &keys.jwks(), &profile, &request);
        let peer = decode_payload(&peer_token);
        validate_signed_peer(&peer).unwrap();
        let binding: PeerBinding = serde_json::from_value(peer["binding"].clone()).unwrap();
        assert_eq!(binding.principal_id, request.principal_id);
        assert_eq!(
            binding.san,
            format!(
                "{}.devices.{}.invalid",
                request.identity_binding_id, profile.service_id
            )
        );
        assert_eq!(
            binding.certificate_fingerprint,
            issued.certificate_fingerprint.unwrap()
        );
        assert_eq!(binding.certificate, issued.certificate.unwrap());
    }

    fn verify_token(
        token: &str,
        jwks: &Value,
        profile: &IssuerProfile,
        req: &IdentityRequest,
        validator: fn(&Value) -> Result<(), myagents_agent_network_protocol::ProtocolError>,
    ) {
        let header = jsonwebtoken::decode_header(token).unwrap();
        let jwk_set: jsonwebtoken::jwk::JwkSet = serde_json::from_value(jwks.clone()).unwrap();
        let jwk = jwk_set.find(header.kid.as_deref().unwrap()).unwrap();
        let key = jsonwebtoken::DecodingKey::from_jwk(jwk).unwrap();
        let mut validation = jsonwebtoken::Validation::new(Algorithm::ES256);
        validation.set_issuer(&[profile.issuer.as_str()]);
        validation.set_audience(&[profile.service_id.as_str()]);
        let claims = jsonwebtoken::decode::<Value>(token, &key, &validation)
            .unwrap()
            .claims;
        validator(&claims).unwrap();
        assert_eq!(claims["sub"], req.principal_id);
        assert_eq!(claims["deviceId"], req.device_id);
        assert_eq!(claims["keyGeneration"], req.key_generation);
        let mut wrong_issuer = jsonwebtoken::Validation::new(Algorithm::ES256);
        wrong_issuer.set_issuer(&["https://wrong.example.test"]);
        wrong_issuer.set_audience(&[profile.service_id.as_str()]);
        assert!(jsonwebtoken::decode::<Value>(token, &key, &wrong_issuer).is_err());
    }

    fn verify_peer_token(
        token: &str,
        jwks: &Value,
        profile: &IssuerProfile,
        req: &IdentityRequest,
    ) {
        let header = jsonwebtoken::decode_header(token).unwrap();
        assert_eq!(header.typ.as_deref(), Some("ma-network-peer+jwt"));
        let set: jsonwebtoken::jwk::JwkSet = serde_json::from_value(jwks.clone()).unwrap();
        let key =
            jsonwebtoken::DecodingKey::from_jwk(set.find(header.kid.as_deref().unwrap()).unwrap())
                .unwrap();
        let mut validation = jsonwebtoken::Validation::new(Algorithm::ES256);
        validation.set_issuer(&[profile.issuer.as_str()]);
        validation.set_audience(&["myagents-agent-peer"]);
        let value = jsonwebtoken::decode::<Value>(token, &key, &validation)
            .unwrap()
            .claims;
        validate_signed_peer(&value).unwrap();
        assert_eq!(value["sub"], req.principal_id);
        assert_eq!(value["binding"]["serviceId"], profile.service_id);
        assert_eq!(value["binding"]["environment"], profile.environment);
        assert_eq!(value["binding"]["deviceId"], req.device_id);
        assert_eq!(value["binding"]["keyGeneration"], req.key_generation);
    }

    fn decode_payload(token: &str) -> Value {
        let payload = token.split('.').nth(1).unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap()
    }

    #[test]
    fn malformed_csr_profile_scope_and_unsafe_file_fail_closed() {
        let (_dir, path, mut profile, mut request, _) = fixture();
        let keys = ServiceKeys::generate_initial(&path).unwrap();
        request.csr_pem = "not a CSR".into();
        assert_eq!(
            keys.issue(&profile, &request).err().unwrap(),
            IdentityCoreError::CsrInvalid
        );
        request.csr_pem = "valid looking".into();
        profile.issuer = "http://agentnet.example.test".into();
        assert_eq!(
            keys.issue(&profile, &request).err().unwrap(),
            IdentityCoreError::ProfileInvalid
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            ServiceKeys::load(&path).err().unwrap(),
            IdentityCoreError::UnsafeKeyFile
        );
    }

    #[test]
    fn initial_generation_requires_private_owner_directory() {
        let dir = tempfile::tempdir().unwrap();
        let key_path = dir.path().join("identity-keys.json");
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            ServiceKeys::generate_initial(&key_path).err().unwrap(),
            IdentityCoreError::UnsafeKeyFile
        );
        assert!(!key_path.exists());
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();

        let alias = dir.path().with_extension("alias");
        std::os::unix::fs::symlink(dir.path(), &alias).unwrap();
        let through_alias = alias.join("identity-keys.json");
        assert_eq!(
            ServiceKeys::generate_initial(&through_alias).err().unwrap(),
            IdentityCoreError::UnsafeKeyFile
        );
        assert!(!dir.path().join("identity-keys.json").exists());
    }

    #[test]
    fn symlink_hardlink_and_corrupt_key_file_are_never_repaired_implicitly() {
        let (_dir, path, _profile, _request, _) = fixture();
        ServiceKeys::generate_initial(&path).unwrap();
        let symlink = path.with_extension("symlink");
        std::os::unix::fs::symlink(&path, &symlink).unwrap();
        assert_eq!(
            ServiceKeys::load(&symlink).err().unwrap(),
            IdentityCoreError::UnsafeKeyFile
        );
        let hardlink = path.with_extension("hardlink");
        fs::hard_link(&path, &hardlink).unwrap();
        assert_eq!(
            ServiceKeys::load(&path).err().unwrap(),
            IdentityCoreError::UnsafeKeyFile
        );

        let corrupt = path.with_extension("corrupt");
        fs::write(&corrupt, b"{corrupt").unwrap();
        fs::set_permissions(&corrupt, fs::Permissions::from_mode(0o600)).unwrap();
        let before = fs::read(&corrupt).unwrap();
        assert_eq!(
            ServiceKeys::load(&corrupt).err().unwrap(),
            IdentityCoreError::KeyMaterialInvalid
        );
        assert_eq!(
            ServiceKeys::generate_initial(&corrupt).err().unwrap(),
            IdentityCoreError::KeyFileExists
        );
        assert_eq!(fs::read(&corrupt).unwrap(), before);
    }

    #[test]
    fn invalid_csr_signature_and_wrong_device_key_are_rejected_by_client_parity() {
        let (_dir, path, profile, mut request, device) = fixture();
        let keys = ServiceKeys::generate_initial(&path).unwrap();
        let encoded = request
            .csr_pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>();
        let mut der = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let last = der.len() - 1;
        der[last] ^= 1;
        request.csr_pem = format!(
            "-----BEGIN CERTIFICATE REQUEST-----\n{}\n-----END CERTIFICATE REQUEST-----\n",
            base64::engine::general_purpose::STANDARD.encode(der)
        );
        assert!(keys.issue(&profile, &request).is_err());
        request.csr_pem = DevicePrivateKey::generate().unwrap().csr().unwrap();
        let issued = keys.issue(&profile, &request).unwrap();
        let leaf = certificate_chain(issued.certificate.as_deref().unwrap()).unwrap();
        assert!(TlsIdentity::new(leaf, std::sync::Arc::new(device)).is_err());
    }
}
