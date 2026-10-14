//! Runtime resource verification. Build scripts import the shared core directly,
//! so file streaming and its runtime-only callers stay in the application crate.

#[path = "resource_signature_core.rs"]
mod core;
pub(crate) use core::{verify_minisign_bytes, verify_minisign_bytes_with_key};
use core::{public_key, signature};
use minisign_verify::Error as MinisignError;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

pub(crate) fn verify_minisign_file(path: &Path, signature_value: &str) -> Result<(), String> {
    let public_key = public_key()?;
    let signature = signature(signature_value, "artifact signature")?;
    match public_key.verify_stream(&signature) {
        Ok(mut verifier) => {
            let mut file = File::open(path).map_err(|error| format!("open artifact: {error}"))?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = file
                    .read(&mut buffer)
                    .map_err(|error| format!("read artifact: {error}"))?;
                if read == 0 {
                    break;
                }
                verifier.update(&buffer[..read]);
            }
            verifier
                .finalize()
                .map_err(|error| format!("artifact signature mismatch: {error}"))
        }
        Err(MinisignError::UnsupportedLegacyMode) => {
            let bytes = fs::read(path).map_err(|error| format!("read artifact: {error}"))?;
            public_key
                .verify(&bytes, &signature, true)
                .map_err(|error| format!("artifact signature mismatch: {error}"))
        }
        Err(error) => Err(format!(
            "cannot initialize artifact signature verifier: {error}"
        )),
    }
}
