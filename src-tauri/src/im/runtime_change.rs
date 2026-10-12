//! Offline legacy preservation. Complete snapshots are written by the Session engine.
use crate::utils::file_lock::{with_file_lock, FileLockOptions};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileLockFreezeOutcome {
    Frozen,
    PreservedLegacy,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PeerFileLockFreezeDisposition {
    Frozen,
    PreservedLegacy,
    MissingBirthPending,
    MissingUnindexedPeerSession,
}

pub(crate) fn resolve_peer_file_lock_freeze_outcome(
    outcome: FileLockFreezeOutcome,
    metadata_birth_pending: bool,
    metadata_indexed: bool,
    session_id: &str,
) -> Result<PeerFileLockFreezeDisposition, String> {
    match outcome {
        FileLockFreezeOutcome::Frozen => Ok(PeerFileLockFreezeDisposition::Frozen),
        FileLockFreezeOutcome::PreservedLegacy => {
            Ok(PeerFileLockFreezeDisposition::PreservedLegacy)
        }
        FileLockFreezeOutcome::Missing if metadata_birth_pending => {
            Ok(PeerFileLockFreezeDisposition::MissingBirthPending)
        }
        FileLockFreezeOutcome::Missing if !metadata_indexed => {
            Ok(PeerFileLockFreezeDisposition::MissingUnindexedPeerSession)
        }
        FileLockFreezeOutcome::Missing => {
            Err(format!("session {} not found in sessions.json", session_id))
        }
    }
}

/// Offline compatibility check only. Never reconstruct old execution settings
/// from today's Channel template. Unknown legacy history remains untouched;
/// resuming it requires the live Sidecar snapshot writer, or an explicit /new.
pub(crate) async fn freeze_via_file_lock_status(
    session_id: &str,
) -> Result<FileLockFreezeOutcome, String> {
    let myagents_dir = dirs::home_dir()
        .ok_or_else(|| "home_dir unavailable".to_string())?
        .join(crate::app_dirs::APP_DATA_DIR_NAME);
    let sessions_path = myagents_dir.join("sessions.json");
    let lock_path = myagents_dir.join("sessions.lock");

    let session_id_owned = session_id.to_string();

    let result = with_file_lock(
        &lock_path,
        FileLockOptions::default(),
        move || -> Result<FileLockFreezeOutcome, crate::utils::file_lock::FileLockError> {
            let content = match std::fs::read_to_string(&sessions_path) {
                Ok(s) => s,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(FileLockFreezeOutcome::Missing);
                }
                Err(e) => {
                    return Err(crate::utils::file_lock::FileLockError::Io(e));
                }
            };
            let sessions: Value = serde_json::from_str(&content).map_err(|e| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("parse sessions.json: {}", e),
                ))
            })?;
            let arr = match sessions.as_array() {
                Some(a) => a,
                None => {
                    return Err(crate::utils::file_lock::FileLockError::Io(
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "sessions.json must contain a SessionMetadata array",
                        ),
                    ));
                }
            };
            for entry in arr {
                if entry.get("id").and_then(Value::as_str) == Some(session_id_owned.as_str()) {
                    return Ok(
                        if entry
                            .get("configSnapshotAt")
                            .and_then(Value::as_str)
                            .is_some()
                        {
                            FileLockFreezeOutcome::Frozen
                        } else {
                            FileLockFreezeOutcome::PreservedLegacy
                        },
                    );
                }
            }
            Ok(FileLockFreezeOutcome::Missing)
        },
    )
    .await;

    match result {
        Ok(outcome) => Ok(outcome),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_lock_freeze_is_skipped_for_unindexed_peer_sessions() {
        assert_eq!(
            resolve_peer_file_lock_freeze_outcome(
                FileLockFreezeOutcome::Frozen,
                false,
                true,
                "persisted-session",
            )
            .unwrap(),
            PeerFileLockFreezeDisposition::Frozen
        );
        assert_eq!(
            resolve_peer_file_lock_freeze_outcome(
                FileLockFreezeOutcome::Missing,
                true,
                false,
                "birth-pending-session",
            )
            .unwrap(),
            PeerFileLockFreezeDisposition::MissingBirthPending
        );
        assert_eq!(
            resolve_peer_file_lock_freeze_outcome(
                FileLockFreezeOutcome::Missing,
                false,
                false,
                "legacy-unindexed-peer-session",
            )
            .unwrap(),
            PeerFileLockFreezeDisposition::MissingUnindexedPeerSession
        );

        let err = resolve_peer_file_lock_freeze_outcome(
            FileLockFreezeOutcome::Missing,
            false,
            true,
            "persisted-session",
        )
        .unwrap_err();
        assert_eq!(err, "session persisted-session not found in sessions.json");
    }
}
