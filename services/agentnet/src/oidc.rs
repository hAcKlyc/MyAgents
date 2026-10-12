use openidconnect::core::{CoreIdToken, CoreIdTokenVerifier, CoreJsonWebKeySet};
use openidconnect::{ClientId, IssuerUrl, Nonce};
use serde_json::Value;
use std::str::FromStr;
use zeroize::Zeroizing;

use crate::AuthError;

/// The verifier is configured from operator-controlled OIDC issuer metadata and
/// keys. Callers cannot supply an issuer, audience, JWKS URL, or subject per login.
pub struct OidcVerifier {
    issuer: IssuerUrl,
    client_id: ClientId,
    keys: CoreJsonWebKeySet,
}

impl OidcVerifier {
    pub fn new(issuer: &str, client_id: &str, jwks: Value) -> Result<Self, AuthError> {
        let issuer = IssuerUrl::new(issuer.to_owned()).map_err(|_| AuthError::OidcConfiguration)?;
        if issuer.url().scheme() != "https" || client_id.is_empty() || client_id.len() > 512 {
            return Err(AuthError::OidcConfiguration);
        }
        let keys: CoreJsonWebKeySet =
            serde_json::from_value(jwks).map_err(|_| AuthError::OidcConfiguration)?;
        if keys.keys().is_empty() || keys.keys().len() > 32 {
            return Err(AuthError::OidcConfiguration);
        }
        Ok(Self {
            issuer,
            client_id: ClientId::new(client_id.to_owned()),
            keys,
        })
    }

    /// Verifies signature, issuer, audience and nonce using openidconnect's
    /// standards-based verifier. This accepts an ID token only; no API surface
    /// accepts a caller-asserted `iss` or `sub`.
    pub fn verify_id_token(
        &self,
        token: &Zeroizing<String>,
        expected_nonce: &str,
    ) -> Result<VerifiedSubject, AuthError> {
        if token.is_empty() || token.len() > 32_768 || expected_nonce.len() > 256 {
            return Err(AuthError::OidcRejected);
        }
        let id_token = CoreIdToken::from_str(token).map_err(|_| AuthError::OidcRejected)?;
        let verifier = CoreIdTokenVerifier::new_public_client(
            self.client_id.clone(),
            self.issuer.clone(),
            self.keys.clone(),
        );
        let claims = id_token
            .claims(&verifier, &Nonce::new(expected_nonce.to_owned()))
            .map_err(|_| AuthError::OidcRejected)?;
        let issuer = claims.issuer().as_str().to_owned();
        let subject = claims.subject().as_str().to_owned();
        if issuer != self.issuer.as_str() || subject.is_empty() || subject.len() > 512 {
            return Err(AuthError::OidcRejected);
        }
        Ok(VerifiedSubject { issuer, subject })
    }
}

/// A verified OIDC identity. Fields and constructor are private so database
/// owner APIs cannot be called with an arbitrary subject string.
#[derive(Clone, Debug)]
pub struct VerifiedSubject {
    issuer: String,
    subject: String,
}

impl VerifiedSubject {
    pub(crate) fn from_verified_claims(
        issuer: String,
        subject: String,
    ) -> Result<Self, crate::AuthError> {
        if issuer.is_empty() || issuer.len() > 2048 || subject.is_empty() || subject.len() > 512 {
            return Err(crate::AuthError::OidcRejected);
        }
        Ok(Self { issuer, subject })
    }

    pub(crate) fn issuer(&self) -> &str {
        &self.issuer
    }

    pub(crate) fn subject(&self) -> &str {
        &self.subject
    }
}
