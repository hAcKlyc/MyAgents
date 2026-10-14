//! Durable authentication foundation for an independently owned AgentNet issuer.
//!
//! This crate deliberately does not advertise AgentNet capabilities or provide a
//! successful network stub. OIDC is verified by `OidcVerifier`; only that module
//! can construct a `VerifiedSubject`, which is the only input accepted by the
//! durable account/session owner.

mod admin_http;
mod admin_store;
mod community_http;
mod community_store;
#[cfg(test)]
mod execution_browser_fixture;
mod execution_gate;
mod execution_http;
mod execution_store;
mod feedback_http;
mod feedback_store;
mod identity_http;
mod instance_http;
mod model_center_authority;
mod model_center_gateway;
mod model_center_http;
mod model_center_store;
mod model_center_types;
mod network_http;
mod oidc;
mod relay_controller;
mod relay_http;
mod relay_transport;
mod server;
mod store;
#[cfg(test)]
mod transactions;

pub use community_http::CommunityService;
pub use feedback_http::FeedbackService;
pub use identity_http::IdentityHttpConfig;
pub use network_http::NetworkHttpConfig;
pub use oidc::{OidcVerifier, VerifiedSubject};
pub use server::{ServiceFileConfig, serve_from_config};
pub use store::{AccountProjection, AuthError, AuthStore, IssuedSession, SessionProjection};
#[cfg(test)]
pub use transactions::{LoginCallback, LoginStart, LoginTransactions};

use std::time::Duration;

/// Explicit operator initialization. Existing keys are never overwritten.
pub fn initialize_identity_keys(path: impl AsRef<std::path::Path>) -> Result<(), AuthError> {
    if !path.as_ref().is_absolute() {
        return Err(AuthError::Configuration);
    }
    myagents_agentnet_identity_core::ServiceKeys::generate_initial(path)
        .map(|_| ())
        .map_err(|_| AuthError::Configuration)
}

/// Public service configuration contains no user/session secrets.
#[derive(Clone)]
pub struct AuthConfig {
    pub network_id: String,
    pub login_ttl: Duration,
    pub session_ttl: Duration,
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use rsa::RsaPrivateKey;
    use rsa::pkcs1::EncodeRsaPrivateKey;
    use rsa::traits::PublicKeyParts;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::sync::{Arc, Barrier};
    use std::time::Duration;
    use tempfile::TempDir;
    use zeroize::Zeroizing;

    const ISSUER: &str = "https://dex.example.test";
    const CLIENT: &str = "agentnet-desktop";
    const NETWORK: &str = "11111111-1111-4111-8111-111111111111";
    const DEVICE_A: &str = "22222222-2222-4222-8222-222222222222";
    const DEVICE_B: &str = "33333333-3333-4333-8333-333333333333";

    struct SigningFixture {
        key: RsaPrivateKey,
        jwks: Value,
    }

    impl SigningFixture {
        fn new() -> Self {
            let key = RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048).unwrap();
            let modulus = URL_SAFE_NO_PAD.encode(key.n().to_bytes_be());
            let exponent = URL_SAFE_NO_PAD.encode(key.e().to_bytes_be());
            Self {
                key,
                jwks: json!({"keys":[{
                    "kty":"RSA",
                    "n":modulus,
                    "e":exponent,
                    "kid":"test-signing-key","alg":"RS256","use":"sig"
                }]}),
            }
        }

        fn verifier(&self, issuer: &str) -> OidcVerifier {
            OidcVerifier::new(issuer, CLIENT, self.jwks.clone()).unwrap()
        }

        fn token(&self, issuer: &str, subject: &str, nonce: &str, audience: &str) -> String {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let mut header = Header::new(Algorithm::RS256);
            header.kid = Some("test-signing-key".into());
            header.typ = Some("JWT".into());
            let claims = json!({
                "iss": issuer,
                "sub": subject,
                "aud": audience,
                "iat": now,
                "exp": now + 600,
                "nonce": nonce
            });
            let der = self.key.to_pkcs1_der().unwrap();
            let encoding = EncodingKey::from_rsa_der(der.as_bytes());
            encode(&header, &claims, &encoding).unwrap()
        }
    }

    fn config() -> AuthConfig {
        AuthConfig {
            network_id: NETWORK.into(),
            login_ttl: Duration::from_secs(300),
            session_ttl: Duration::from_secs(3600),
        }
    }

    fn private_dir() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        dir
    }

    fn pkce() -> (&'static str, String) {
        let verifier = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-._~";
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        (verifier, challenge)
    }

    fn finish(
        transactions: &LoginTransactions,
        store: &AuthStore,
        verifier: &OidcVerifier,
        start: &LoginStart,
        device: &str,
        pkce_verifier: &str,
        token: &str,
    ) -> Result<IssuedSession, AuthError> {
        let pkce_verifier = Zeroizing::new(pkce_verifier.to_owned());
        let id_token = Zeroizing::new(token.to_owned());
        transactions.complete_with_id_token(
            store,
            verifier,
            LoginCallback {
                transaction_id: &start.transaction_id,
                state: start.state.as_str(),
                device_id: device,
                pkce_verifier: &pkce_verifier,
                id_token: &id_token,
            },
        )
    }

    #[test]
    fn oidc_verifier_rejects_wrong_issuer_audience_and_nonce() {
        let fixture = SigningFixture::new();
        let verifier = fixture.verifier(ISSUER);
        let good = Zeroizing::new(fixture.token(ISSUER, "dex-user-1", "right-nonce", CLIENT));
        assert_eq!(
            verifier
                .verify_id_token(&good, "right-nonce")
                .unwrap()
                .subject(),
            "dex-user-1"
        );
        for (issuer, audience, nonce) in [
            ("https://attacker.example", CLIENT, "right-nonce"),
            (ISSUER, "another-client", "right-nonce"),
            (ISSUER, CLIENT, "wrong-nonce"),
        ] {
            let token = Zeroizing::new(fixture.token(issuer, "dex-user-1", nonce, audience));
            assert_eq!(
                verifier.verify_id_token(&token, "right-nonce").unwrap_err(),
                AuthError::OidcRejected
            );
        }
    }

    #[test]
    fn login_is_device_bound_pkce_nonce_bound_single_use_and_durable() {
        let dir = private_dir();
        let config = config();
        let store = AuthStore::open(dir.path(), &config).unwrap();
        let fixture = SigningFixture::new();
        let oidc = fixture.verifier(ISSUER);
        let transactions = LoginTransactions::new(&config).unwrap();
        let (pkce_verifier, challenge) = pkce();
        let started = transactions.begin(DEVICE_A, &challenge).unwrap();
        let id_token = fixture.token(ISSUER, "dex-user-1", &started.nonce, CLIENT);
        assert_eq!(
            finish(
                &transactions,
                &store,
                &oidc,
                &started,
                DEVICE_B,
                pkce_verifier,
                &id_token
            )
            .unwrap_err(),
            AuthError::LoginProof
        );
        assert_eq!(
            finish(
                &transactions,
                &store,
                &oidc,
                &started,
                DEVICE_A,
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~",
                &id_token
            )
            .unwrap_err(),
            AuthError::LoginProof
        );
        let wrong_state = LoginStart {
            transaction_id: started.transaction_id.clone(),
            state: Zeroizing::new("wrong-state".into()),
            nonce: Zeroizing::new(started.nonce.to_string()),
            expires_at: started.expires_at,
        };
        assert_eq!(
            finish(
                &transactions,
                &store,
                &oidc,
                &wrong_state,
                DEVICE_A,
                pkce_verifier,
                &id_token
            )
            .unwrap_err(),
            AuthError::LoginProof
        );
        let session = finish(
            &transactions,
            &store,
            &oidc,
            &started,
            DEVICE_A,
            pkce_verifier,
            &id_token,
        )
        .unwrap();
        let account = session.account.clone();
        let bearer = session.into_token();
        assert_eq!(account.network_id, NETWORK);
        let projection = store.validate_session(&bearer).unwrap();
        assert_eq!(projection.device_id, DEVICE_A);
        assert_eq!(
            uuid::Uuid::parse_str(&projection.session_handle)
                .unwrap()
                .to_string(),
            projection.session_handle
        );
        assert_eq!(
            store
                .validate_session_handle(&projection.session_handle)
                .unwrap(),
            projection
        );
        assert_eq!(
            finish(
                &transactions,
                &store,
                &oidc,
                &started,
                DEVICE_A,
                pkce_verifier,
                &id_token
            )
            .unwrap_err(),
            AuthError::LoginTransaction
        );
        drop(store);

        let reopened = AuthStore::open(dir.path(), &config).unwrap();
        assert_eq!(reopened.validate_session(&bearer).unwrap().account, account);
        assert_eq!(
            reopened
                .validate_session_handle(&projection.session_handle)
                .unwrap(),
            projection
        );
        let raw_db = std::fs::read(dir.path().join("auth.sqlite3")).unwrap();
        assert!(
            !raw_db
                .windows(bearer.len())
                .any(|window| window == bearer.as_bytes())
        );
        reopened.expire_session_for_test(&bearer).unwrap();
        assert_eq!(
            reopened.validate_session(&bearer).unwrap_err(),
            AuthError::SessionRejected
        );
        assert_eq!(
            reopened
                .validate_session_handle(&projection.session_handle)
                .unwrap_err(),
            AuthError::SessionRejected
        );

        let second_start = transactions.begin(DEVICE_B, &challenge).unwrap();
        let second_token = fixture.token(ISSUER, "dex-user-1", &second_start.nonce, CLIENT);
        let second_session = finish(
            &transactions,
            &reopened,
            &oidc,
            &second_start,
            DEVICE_B,
            pkce_verifier,
            &second_token,
        )
        .unwrap();
        assert_eq!(second_session.account, account);
        let second_bearer = second_session.into_token();
        let second_projection = reopened.validate_session(&second_bearer).unwrap();
        assert_ne!(second_projection.session_handle, projection.session_handle);
        reopened.revoke_session(&second_bearer).unwrap();
        assert_eq!(
            reopened.validate_session(&second_bearer).unwrap_err(),
            AuthError::SessionRejected
        );
        assert_eq!(
            reopened
                .validate_session_handle(&second_projection.session_handle)
                .unwrap_err(),
            AuthError::SessionRejected
        );
    }

    #[test]
    fn login_expiring_during_oidc_verification_cannot_issue_session() {
        use std::cell::Cell;
        let dir = private_dir();
        let config = config();
        let store = AuthStore::open(dir.path(), &config).unwrap();
        let fixture = SigningFixture::new();
        let oidc = fixture.verifier(ISSUER);
        let transactions = LoginTransactions::new(&config).unwrap();
        let (pkce_verifier, challenge) = pkce();
        let started = transactions.begin(DEVICE_A, &challenge).unwrap();
        let token =
            Zeroizing::new(fixture.token(ISSUER, "dex-user-expiring", &started.nonce, CLIENT));
        let verifier = Zeroizing::new(pkce_verifier.to_owned());
        let reads = Cell::new(0);
        let result = transactions.complete_with_id_token_using_clock(
            &store,
            &oidc,
            LoginCallback {
                transaction_id: &started.transaction_id,
                state: &started.state,
                device_id: DEVICE_A,
                pkce_verifier: &verifier,
                id_token: &token,
            },
            || {
                let current = reads.get();
                reads.set(current + 1);
                Ok(if current == 0 {
                    started.expires_at - 300
                } else {
                    started.expires_at
                })
            },
        );
        assert_eq!(result.unwrap_err(), AuthError::LoginTransaction);
        let connection = rusqlite::Connection::open(dir.path().join("auth.sqlite3")).unwrap();
        let session_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(session_count, 0);
    }

    #[test]
    fn same_subject_on_another_issuer_is_a_different_principal() {
        let dir = private_dir();
        let config = config();
        let store = AuthStore::open(dir.path(), &config).unwrap();
        let fixture = SigningFixture::new();
        let transactions = LoginTransactions::new(&config).unwrap();
        let (verifier, challenge) = pkce();
        let first = transactions.begin(DEVICE_A, &challenge).unwrap();
        let first_id = fixture.token(ISSUER, "same-subject", &first.nonce, CLIENT);
        let first_session = finish(
            &transactions,
            &store,
            &fixture.verifier(ISSUER),
            &first,
            DEVICE_A,
            verifier,
            &first_id,
        )
        .unwrap();
        let second = transactions.begin(DEVICE_B, &challenge).unwrap();
        let other_issuer = "https://other-dex.example";
        let second_id = fixture.token(other_issuer, "same-subject", &second.nonce, CLIENT);
        let second_session = finish(
            &transactions,
            &store,
            &fixture.verifier(other_issuer),
            &second,
            DEVICE_B,
            verifier,
            &second_id,
        )
        .unwrap();
        assert_ne!(
            first_session.account.principal_id,
            second_session.account.principal_id
        );
    }

    #[test]
    fn concurrent_callback_replay_can_commit_only_once() {
        let dir = private_dir();
        let config = config();
        let store = Arc::new(AuthStore::open(dir.path(), &config).unwrap());
        let fixture = SigningFixture::new();
        let oidc = Arc::new(fixture.verifier(ISSUER));
        let transactions = Arc::new(LoginTransactions::new(&config).unwrap());
        let (pkce_verifier, challenge) = pkce();
        let start = transactions.begin(DEVICE_A, &challenge).unwrap();
        let id_token = fixture.token(ISSUER, "concurrent-user", &start.nonce, CLIENT);
        let barrier = Arc::new(Barrier::new(3));
        let mut joins = Vec::new();
        for _ in 0..2 {
            let store = store.clone();
            let oidc = oidc.clone();
            let transactions = transactions.clone();
            let barrier = barrier.clone();
            let state = start.state.to_string();
            let txid = start.transaction_id.clone();
            let token = id_token.clone();
            let verifier = Zeroizing::new(pkce_verifier.to_owned());
            joins.push(std::thread::spawn(move || {
                barrier.wait();
                transactions.complete_with_id_token(
                    &store,
                    &oidc,
                    LoginCallback {
                        transaction_id: &txid,
                        state: &state,
                        device_id: DEVICE_A,
                        pkce_verifier: &verifier,
                        id_token: &Zeroizing::new(token),
                    },
                )
            }));
        }
        barrier.wait();
        let results: Vec<_> = joins.into_iter().map(|join| join.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    }

    #[test]
    fn cancel_expiry_and_unsafe_paths_fail_closed() {
        let config = config();
        let dir = private_dir();
        let transactions = LoginTransactions::new(&config).unwrap();
        let (_, challenge) = pkce();
        let started = transactions.begin(DEVICE_A, &challenge).unwrap();
        assert!(
            !transactions
                .cancel(&started.transaction_id, DEVICE_B)
                .unwrap()
        );
        assert!(
            transactions
                .cancel(&started.transaction_id, DEVICE_A)
                .unwrap()
        );
        let expired = transactions.begin(DEVICE_A, &challenge).unwrap();
        transactions
            .expire_for_test(&expired.transaction_id)
            .unwrap();
        let dir_for_expiry = private_dir();
        let store_for_expiry = AuthStore::open(dir_for_expiry.path(), &config).unwrap();
        let fixture = SigningFixture::new();
        assert_eq!(
            transactions
                .complete_with_id_token(
                    &store_for_expiry,
                    &fixture.verifier(ISSUER),
                    LoginCallback {
                        transaction_id: &expired.transaction_id,
                        state: expired.state.as_str(),
                        device_id: DEVICE_A,
                        pkce_verifier: &Zeroizing::new(
                            "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-._~"
                                .to_owned()
                        ),
                        id_token: &Zeroizing::new("unused".to_owned()),
                    },
                )
                .unwrap_err(),
            AuthError::LoginTransaction
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(matches!(
                AuthStore::open(dir.path(), &config),
                Err(AuthError::UnsafePath)
            ));
        }

        let private = private_dir();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::os::unix::fs::symlink("/etc/passwd", private.path().join("auth.sqlite3")).unwrap();
            assert!(matches!(
                AuthStore::open(private.path(), &config),
                Err(AuthError::UnsafePath)
            ));
            std::fs::remove_file(private.path().join("auth.sqlite3")).unwrap();
            std::fs::write(private.path().join("auth.sqlite3"), b"unsafe").unwrap();
            std::fs::set_permissions(
                private.path().join("auth.sqlite3"),
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap();
            std::fs::hard_link(
                private.path().join("auth.sqlite3"),
                private.path().join("hardlink"),
            )
            .unwrap();
            assert!(matches!(
                AuthStore::open(private.path(), &config),
                Err(AuthError::UnsafePath)
            ));
        }
    }
}
