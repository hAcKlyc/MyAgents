//! Desktop parent policy around the unchanged, signed credential-reader v1.
//! The build checks all imported source bytes before generating its private copy.
include!(concat!(env!("OUT_DIR"), "/parent_crypto.rs"));

#[cfg(all(feature = "os-store", target_os = "macos"))]
pub use macos_helper::{set_parent_diagnostic_sink, ParentDiagnostic};

#[cfg(test)]
#[path = "../build-support.rs"]
mod generation_tests;
