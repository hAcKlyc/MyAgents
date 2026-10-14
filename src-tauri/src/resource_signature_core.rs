//! Shared verification for first-party downloadable resource manifests.
//!
//! Upstream downloadable resources retain the MyAgents trust root. MoXBots
//! app updates use their independent configured key. Resource owners still own their
//! manifest schema, download allowlist, staging, and activation lifecycle.

use base64::{engine::general_purpose, Engine as _};
use minisign_verify::{PublicKey, Signature};

// Keep this in sync with `tauri.conf.json > plugins.updater.pubkey`.
pub(crate) const MYAGENTS_MINISIGN_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY3RkQ5QjIzMTE4RTgyRTkKUldUcGdvNFJJNXY5OTB3T2pnUzVUbjFrV203Zk5ZTDg0NVJRdGI0UVRranJzTUsvM0hGcmFlc0IK";

fn decode_base64_text(value: &str, label: &str) -> Result<String, String> {
    let bytes = general_purpose::STANDARD
        .decode(value)
        .map_err(|error| format!("invalid {label} base64: {error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("invalid {label} UTF-8: {error}"))
}

pub(super) fn public_key() -> Result<PublicKey, String> {
    decode_public_key(MYAGENTS_MINISIGN_PUBKEY)
}

fn decode_public_key(value: &str) -> Result<PublicKey, String> {
    let decoded = decode_base64_text(value, "public key")?;
    PublicKey::decode(&decoded).map_err(|error| format!("invalid minisign public key: {error}"))
}

pub(super) fn signature(value: &str, label: &str) -> Result<Signature, String> {
    let decoded = decode_base64_text(value, label)?;
    Signature::decode(&decoded).map_err(|error| format!("invalid {label}: {error}"))
}

pub(crate) fn verify_minisign_bytes(
    bytes: &[u8],
    signature_value: &str,
    label: &str,
) -> Result<(), String> {
    verify_minisign_bytes_with_key(bytes, signature_value, MYAGENTS_MINISIGN_PUBKEY, label)
}

pub(crate) fn verify_minisign_bytes_with_key(
    bytes: &[u8],
    signature_value: &str,
    public_key_value: &str,
    label: &str,
) -> Result<(), String> {
    let public_key = decode_public_key(public_key_value)?;
    let signature = signature(signature_value, label)?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|error| format!("{label} signature mismatch: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};

    #[test]
    fn moxbots_update_key_verifies_final_bytes_and_rejects_tampering() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../test-fixtures/moxbots-updater-signature.json"
        )).unwrap();
        let bytes = fixture["bytes"].as_str().unwrap().as_bytes();
        let key = fixture["pubkey"].as_str().unwrap();
        let signature_value = fixture["signature"].as_str().unwrap();
        let profile: serde_json::Value = serde_json::from_str(include_str!(
            "../tauri.moxbot.conf.json"
        )).unwrap();
        assert_eq!(profile["plugins"]["updater"]["pubkey"], key);
        verify_minisign_bytes_with_key(bytes, signature_value, key, "app update").unwrap();
        assert!(verify_minisign_bytes_with_key(b"changed bytes", signature_value, key, "app update").is_err());
        assert!(verify_minisign_bytes_with_key(bytes, signature_value, MYAGENTS_MINISIGN_PUBKEY, "app update").is_err());
        let decoded = decode_base64_text(signature_value, "signature").unwrap();
        let changed = decoded.replace("trusted comment:", "trusted comment: altered");
        let changed = general_purpose::STANDARD.encode(changed);
        assert!(verify_minisign_bytes_with_key(bytes, &changed, key, "app update").is_err());
    }

    #[test]
    fn shared_pubkey_matches_tauri_updater_pubkey() {
        let conf_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let content = fs::read_to_string(conf_path).expect("tauri.conf.json");
        let json: serde_json::Value = serde_json::from_str(&content).expect("valid tauri config");
        let updater_pubkey = json
            .get("plugins")
            .and_then(|value| value.get("updater"))
            .and_then(|value| value.get("pubkey"))
            .and_then(|value| value.as_str())
            .expect("updater pubkey");
        assert_eq!(updater_pubkey, MYAGENTS_MINISIGN_PUBKEY);
    }
}
