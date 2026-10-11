//! Explicit isolated storage acceptance tool. No issuer, account or network.
#[cfg(unix)]
use myagents_agent_network_crypto::EncryptedIdentityStore;
use myagents_agent_network_crypto::{CryptoError, KeyScope};
#[cfg(unix)]
use myagents_agent_network_crypto::{DevicePrivateKey, IdentityStore};
#[cfg(unix)]
use std::path::Path;

fn run() -> Result<serde_json::Value, CryptoError> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 5
        || !["init", "load", "same", "conflict", "delete"].contains(&args[0].as_str())
    {
        return Err(CryptoError::InvalidKey);
    }
    use std::io::Read;
    let file = std::fs::File::open(&args[2]).map_err(|_| CryptoError::CredentialUnavailable)?;
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| CryptoError::CredentialUnavailable)?;
    if bytes.len() > 4096 {
        return Err(CryptoError::InvalidKey);
    }
    let scope: KeyScope = serde_json::from_slice(&bytes).map_err(|_| CryptoError::InvalidKey)?;
    let issuer = url::Url::parse(&scope.issuer).map_err(|_| CryptoError::InvalidKey)?;
    let host = issuer.host_str().ok_or(CryptoError::InvalidKey)?;
    if scope.environment != "development"
        || !host.starts_with("isolated")
        || !host.ends_with(".invalid")
    {
        return Err(CryptoError::InvalidKey);
    }
    #[cfg(not(unix))]
    {
        let _ = scope;
        Err(CryptoError::UnsupportedPlatform)
    }
    #[cfg(unix)]
    {
        let store = EncryptedIdentityStore::from_systemd(Path::new(&args[1]), &args[3], &args[4])?;
        if args[0] == "delete" {
            store.delete(&scope)?;
            return Ok(serde_json::json!({"status":"deleted"}));
        }
        if args[0] == "conflict" {
            let _existing = store.load(&scope)?;
        }
        let key = if args[0] == "init" || args[0] == "conflict" {
            DevicePrivateKey::generate()?
        } else {
            store.load(&scope)?
        };
        if args[0] != "load" {
            store.save_pending(&scope, &key)?;
        }
        Ok(serde_json::json!({
            "status":if args[0] == "load" {"loaded"} else {"persisted"},
            "fingerprint":key.public_fingerprint()?
        }))
    }
}

fn main() {
    match run() {
        Ok(value) => println!("{value}"),
        Err(error) => {
            println!(
                "{}",
                serde_json::json!({"status":"error","code":error.to_string()})
            );
            std::process::exit(1);
        }
    }
}
