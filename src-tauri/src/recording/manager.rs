//! App-global recording state machine and admission owner.

use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, Mutex};

use super::analysis::{
    analysis_spool_relative_path, cleanup_analysis_spool, AnalysisControl, TrackAnalysisHandle,
};
use super::archive::{
    recover_ogg_opus_archive, ArchiveResult, TrackArchiveHandle, ARCHIVE_SAMPLE_RATE,
};
use super::capture::{
    CaptureBackend, CaptureEvent, CapturePlan, CaptureSelection, CaptureSession, CaptureSinks,
    CaptureTrackSink, PlatformCaptureBackend, PreparedSource,
};
use super::lifecycle::{LifecycleEvent, LifecycleJournal};
use crate::record::{
    audio_track_relative_path, AudioRecordCreateInput, AudioTrackArtifactInput, AudioTrackKind,
    CaptureStatus, ManagedRecordStore, Record, RecordArchiveFilter, RecordKind, RecordListFilter,
    RecordTranscriptTrackOffset, TranscriptionStatus,
};
use crate::record_analytics::{
    self, AnalyticsOutcome, AnalyticsSource, AnalyticsSurface, CaptureSources,
    RecordAnalyticsMilestone, RecordingFinishReason, RecordingRecoveryOutcome, SpeechResourceState,
    SystemAudioCapability, TranscriptionMode,
};
use crate::speech_recognition::{self, SpeechResourceStatus};
use crate::wake_lock::WakeLock;
use crate::{ulog_info, ulog_warn};

const MIN_RECORDING_FREE_BYTES: u64 = 512 * 1024 * 1024;
const MONITOR_INTERVAL: Duration = Duration::from_secs(10);
const CAPTURE_RECOVERY_ATTEMPTS: usize = 5;
#[cfg(not(test))]
const CAPTURE_RECOVERY_BACKOFF: Duration = Duration::from_millis(500);
#[cfg(test)]
const CAPTURE_RECOVERY_BACKOFF: Duration = Duration::from_millis(10);
const COMPLETED_OPERATION_LIMIT: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingWarning {
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSourceActivity {
    pub track: AudioTrackKind,
    pub level_percent: u8,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSnapshot {
    pub record_id: String,
    pub revision: u64,
    pub generation: u64,
    pub capture_status: CaptureStatus,
    pub started_at_wall_time: i64,
    pub media_duration_ms: u64,
    pub paused_wall_ms: u64,
    pub sources: Vec<PreparedSource>,
    pub source_activity: Vec<RecordingSourceActivity>,
    pub warnings: Vec<RecordingWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingChange {
    pub sequence: u64,
    pub record_id: String,
    pub revision: u64,
    pub capture_status: CaptureStatus,
    pub snapshot: Option<RecordingSnapshot>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartInput {
    pub operation_id: String,
    #[serde(default)]
    pub selection: CaptureSelection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartResult {
    pub snapshot: RecordingSnapshot,
    pub attached_to_existing: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingCommandInput {
    pub record_id: String,
    pub expected_revision: u64,
    pub operation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSourceCommandInput {
    pub record_id: String,
    pub operation_id: String,
    pub track: AudioTrackKind,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperationKind {
    Start,
    Pause,
    Resume,
    SetSource,
    Stop,
}

struct OperationResult {
    kind: OperationKind,
    snapshot: RecordingSnapshot,
}

#[derive(Default)]
struct ManagerState {
    slot: Option<RecordingSlot>,
    operation_results: HashMap<String, OperationResult>,
    operation_order: VecDeque<String>,
}

enum RecordingSlot {
    Live(ActiveRecording),
    Settling(RecordingSnapshot),
}

impl RecordingSlot {
    fn snapshot(&self) -> RecordingSnapshot {
        match self {
            Self::Live(active) => active.snapshot(),
            Self::Settling(snapshot) => snapshot.clone(),
        }
    }
}

struct ActiveRecording {
    record_id: String,
    revision: u64,
    generation: u64,
    capture_status: CaptureStatus,
    started_at_wall_time: i64,
    media_before_segment_ms: u64,
    segment_started: Option<Instant>,
    pause_started: Option<Instant>,
    paused_wall_ms: u64,
    pause_count: usize,
    capture_plan: CapturePlan,
    sources: Vec<PreparedSource>,
    source_sinks: Vec<(AudioTrackKind, CaptureTrackSink)>,
    warnings: Vec<RecordingWarning>,
    journal: LifecycleJournal,
    time_journal_cursors: Vec<(AudioTrackKind, usize)>,
    session: Option<Arc<StdMutex<Box<dyn CaptureSession>>>>,
    archives: Vec<TrackArchiveHandle>,
    analyses: Vec<TrackAnalysisHandle>,
    live_transcription: bool,
    live_analysis_enabled: bool,
    _wake_lock: Option<WakeLock>,
}

impl ActiveRecording {
    fn checkpoint_capture_times(&mut self) -> Result<(), String> {
        for (track, sink) in &self.source_sinks {
            let Some(timeline) = sink.timeline()? else {
                continue;
            };
            let cursor = self
                .time_journal_cursors
                .iter()
                .find(|(kind, _)| kind == track)
                .map_or(0, |(_, cursor)| *cursor);
            let from_index = cursor.saturating_sub(1);
            if from_index >= timeline.spans.len() {
                return Err("RECORDING_CAPTURE_TIME_INVALID".to_string());
            }
            self.journal.append(
                now_ms(),
                self.media_duration_ms(),
                LifecycleEvent::CaptureTrackTime {
                    track: *track,
                    from_index,
                    spans: timeline.spans[from_index..].to_vec(),
                },
            )?;
            if let Some((_, cursor)) = self
                .time_journal_cursors
                .iter_mut()
                .find(|(kind, _)| kind == track)
            {
                *cursor = timeline.spans.len();
            } else {
                self.time_journal_cursors
                    .push((*track, timeline.spans.len()));
            }
        }
        Ok(())
    }

    fn media_duration_ms(&self) -> u64 {
        self.media_before_segment_ms.saturating_add(
            self.segment_started
                .map(|started| duration_ms(started.elapsed()))
                .unwrap_or(0),
        )
    }

    fn snapshot(&self) -> RecordingSnapshot {
        RecordingSnapshot {
            record_id: self.record_id.clone(),
            revision: self.revision,
            generation: self.generation,
            capture_status: self.capture_status,
            started_at_wall_time: self.started_at_wall_time,
            media_duration_ms: self.media_duration_ms(),
            paused_wall_ms: self.paused_wall_ms.saturating_add(
                self.pause_started
                    .map(|started| duration_ms(started.elapsed()))
                    .unwrap_or(0),
            ),
            sources: self.sources.clone(),
            source_activity: self
                .sources
                .iter()
                .map(|source| {
                    let sink = self
                        .source_sinks
                        .iter()
                        .find(|(track, _)| *track == source.track)
                        .map(|(_, sink)| sink);
                    let enabled = sink.is_none_or(CaptureTrackSink::enabled);
                    RecordingSourceActivity {
                        track: source.track,
                        level_percent: if self.capture_status == CaptureStatus::Recording && enabled
                        {
                            sink.map(|sink| sink.activity().level_percent())
                                .unwrap_or(0)
                        } else {
                            0
                        },
                        enabled,
                    }
                })
                .collect(),
            warnings: self.warnings.clone(),
        }
    }
}

pub struct RecordingManager {
    state: Mutex<ManagerState>,
    operation_gate: Mutex<()>,
    record_store: ManagedRecordStore,
    backend: Arc<dyn CaptureBackend>,
    changes: broadcast::Sender<RecordingChange>,
    change_sequence: AtomicU64,
    next_generation: AtomicU64,
    acquire_wake_lock: bool,
}

pub type ManagedRecordingManager = Arc<RecordingManager>;

impl RecordingManager {
    pub fn new(record_store: ManagedRecordStore) -> ManagedRecordingManager {
        Self::with_backend(record_store, Arc::new(PlatformCaptureBackend), true)
    }

    fn with_backend(
        record_store: ManagedRecordStore,
        backend: Arc<dyn CaptureBackend>,
        acquire_wake_lock: bool,
    ) -> ManagedRecordingManager {
        let (changes, _) = broadcast::channel(128);
        Arc::new(Self {
            state: Mutex::new(ManagerState::default()),
            operation_gate: Mutex::new(()),
            record_store,
            backend,
            changes,
            change_sequence: AtomicU64::new(0),
            next_generation: AtomicU64::new(0),
            acquire_wake_lock,
        })
    }

    pub fn subscribe_changes(&self) -> broadcast::Receiver<RecordingChange> {
        self.changes.subscribe()
    }

    pub async fn snapshot(&self) -> Option<RecordingSnapshot> {
        self.state
            .lock()
            .await
            .slot
            .as_ref()
            .map(RecordingSlot::snapshot)
    }

    /// Reconciles Records that were left in a slot-owning state by a prior
    /// process. Recovery never opens a capture device or repopulates the live
    /// slot; it only repairs durable checkpoints and commits a terminal state.
    pub async fn recover_interrupted(self: &Arc<Self>) {
        let _operation = self.operation_gate.lock().await;
        let records = self
            .record_store
            .list_full(RecordListFilter {
                kind: Some(RecordKind::Audio),
                archived: Some(RecordArchiveFilter::All),
                ..RecordListFilter::default()
            })
            .await;
        for record in records {
            let Some(audio) = record.audio.as_ref() else {
                continue;
            };
            if !is_slot_owning_status(audio.capture_status) {
                continue;
            }
            let record_id = record.id.clone();
            if let Err(error) = self.recover_record(record).await {
                ulog_warn!("[recording] startup recovery failed: {}", error);
                record_analytics::emit(RecordAnalyticsMilestone::RecordingRecovery {
                    event_schema_version: 1,
                    record_id,
                    outcome: RecordingRecoveryOutcome::Unrecoverable,
                    error_code: Some("RECORDING_RECOVERY_FAILED".to_string()),
                });
            }
        }
    }

    async fn recover_record(&self, record: Record) -> Result<(), String> {
        let workspace = self.record_store.audio_workspace_path(&record.id).await?;
        let tracks = record
            .audio
            .as_ref()
            .map(|audio| audio.tracks.clone())
            .unwrap_or_default();
        let live_revision_path = workspace.join("transcript/revisions.jsonl");
        let resume_transcription =
            fs::symlink_metadata(&live_revision_path).is_ok_and(|metadata| {
                metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() > 0
            });
        let repair_inputs: Vec<(AudioTrackKind, std::path::PathBuf)> = tracks
            .iter()
            .copied()
            .map(|track| (track, workspace.join(audio_track_relative_path(track))))
            .filter(|(_, path)| path.exists())
            .collect();
        let repair_results = tokio::task::spawn_blocking(move || {
            repair_inputs
                .into_iter()
                .map(|(track, path)| (track, recover_ogg_opus_archive(&path)))
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|error| format!("recording recovery worker panicked: {error}"))?;

        let timing_entries = LifecycleJournal::read_entries(&workspace, &record.id);
        let mut artifacts = Vec::new();
        let mut repaired_tracks = Vec::new();
        let mut unrecoverable_tracks = 0_usize;
        let mut media_samples = 0_u64;
        for (track, result) in repair_results {
            match result {
                Ok(Some(recovered)) => {
                    let timing = timing_entries
                        .as_ref()
                        .map_err(|_| "capture journal unavailable".to_string())
                        .and_then(|entries| {
                            LifecycleJournal::recover_track_time(
                                entries,
                                track,
                                recovered.media_samples_48k / 3,
                            )
                        });
                    let (timeline, capture_time_error) = match timing {
                        Ok(timeline) => (timeline, None),
                        Err(_) => (None, Some("RECORDING_CAPTURE_TIME_UNAVAILABLE".to_string())),
                    };
                    artifacts.push(AudioTrackArtifactInput {
                        timeline,
                        capture_time_error,
                        track,
                        relative_path: audio_track_relative_path(track),
                    });
                    media_samples = media_samples.max(recovered.media_samples_48k);
                    if recovered.repaired {
                        repaired_tracks.push(format!("{track:?}").to_ascii_lowercase());
                    }
                }
                Ok(None) => unrecoverable_tracks = unrecoverable_tracks.saturating_add(1),
                Err(error) => {
                    unrecoverable_tracks = unrecoverable_tracks.saturating_add(1);
                    ulog_warn!(
                        "[recording] skipped unrecoverable track recordId={} track={:?} error={}",
                        record.id,
                        track,
                        error
                    );
                }
            }
        }
        let media_ms = media_samples.saturating_mul(1_000) / ARCHIVE_SAMPLE_RATE as u64;
        let status = if artifacts.is_empty() {
            CaptureStatus::Failed
        } else {
            CaptureStatus::Interrupted
        };
        let has_artifacts = !artifacts.is_empty();
        let mut terminal = if artifacts.is_empty() {
            self.record_store
                .update_audio_capture(&record.id, status, 0, Some(Vec::new()))
                .await?
        } else {
            self.record_store
                .finalize_audio_capture(&record.id, status, media_ms, artifacts)
                .await?
        };
        for track in tracks {
            let Ok(relative_path) = analysis_spool_relative_path(track) else {
                continue;
            };
            let path = workspace.join(relative_path);
            if let Err(error) = cleanup_analysis_spool(&path) {
                ulog_warn!(
                    "[recording] recovery analysis cleanup failed recordId={} track={:?} error={}",
                    record.id,
                    track,
                    error
                );
            }
        }
        if resume_transcription {
            terminal = self
                .record_store
                .update_audio_processing_status(
                    &record.id,
                    Some(if has_artifacts {
                        TranscriptionStatus::Recovering
                    } else {
                        TranscriptionStatus::Failed
                    }),
                    None,
                )
                .await?;
            if has_artifacts {
                if let Some(speech) = speech_recognition::global() {
                    match speech.submit_record_backfill(&record.id).await {
                        Ok(_) => {
                            if let Some(latest) = self.record_store.get(&record.id).await {
                                terminal = latest;
                            }
                        }
                        Err(error) => {
                            ulog_warn!(
                                "[recording] recovery backfill admission failed recordId={} error={}",
                                record.id,
                                error
                            );
                            terminal = self
                                .record_store
                                .update_audio_processing_status(
                                    &record.id,
                                    Some(TranscriptionStatus::Failed),
                                    None,
                                )
                                .await?;
                        }
                    }
                }
            }
        }
        let mut journal = LifecycleJournal::open(&workspace, &record.id)?;
        journal.append(
            now_ms(),
            media_ms,
            LifecycleEvent::RecoveryCommitted {
                repaired_tracks,
                reason: "app_restart".to_string(),
            },
        )?;
        self.emit_change(
            snapshot_from_record(&terminal, 0, Vec::new(), Vec::new()),
            false,
        );
        ulog_info!(
            "[recording] startup recovery committed recordId={} status={:?} mediaMs={}",
            record.id,
            status,
            media_ms
        );
        record_analytics::emit(RecordAnalyticsMilestone::RecordingRecovery {
            event_schema_version: 1,
            record_id: record.id,
            outcome: if !has_artifacts {
                RecordingRecoveryOutcome::Unrecoverable
            } else if unrecoverable_tracks > 0 {
                RecordingRecoveryOutcome::Partial
            } else {
                RecordingRecoveryOutcome::Repaired
            },
            error_code: (unrecoverable_tracks > 0)
                .then(|| "RECORDING_TRACK_RECOVERY_PARTIAL".to_string()),
        });
        Ok(())
    }

    pub async fn start(
        self: &Arc<Self>,
        input: RecordingStartInput,
    ) -> Result<RecordingStartResult, String> {
        let _update_admission = crate::sidecar::begin_lifecycle_spawn_permit()?;
        let selection = input.selection;
        let result = self.start_inner(input).await;
        if let Err(error) = &result {
            ulog_warn!(
                "[recording] start failed code={}",
                normalized_recording_error(error, "RECORDING_START_FAILED")
            );
        }
        let capability = speech_recognition::global().map(|manager| manager.capability_snapshot());
        let resource_state = match capability.as_ref().map(|value| value.resource_status) {
            Some(SpeechResourceStatus::Ready) => SpeechResourceState::Ready,
            Some(SpeechResourceStatus::NotInstalled) | None => SpeechResourceState::NotInstalled,
            Some(SpeechResourceStatus::NativeUnavailable) => SpeechResourceState::NativeUnavailable,
        };
        let (record_id, capture_sources, transcription_mode, system_audio_capability) =
            match &result {
                Ok(result) => (
                    Some(result.snapshot.record_id.clone()),
                    analytics_capture_sources(&result.snapshot.sources),
                    if capability
                        .as_ref()
                        .is_some_and(|value| value.resource_status == SpeechResourceStatus::Ready)
                    {
                        TranscriptionMode::Live
                    } else {
                        TranscriptionMode::Unavailable
                    },
                    if !selection.system {
                        SystemAudioCapability::NotRequested
                    } else if result
                        .snapshot
                        .sources
                        .iter()
                        .any(|source| source.track == AudioTrackKind::System)
                    {
                        SystemAudioCapability::Available
                    } else {
                        SystemAudioCapability::Unavailable
                    },
                ),
                Err(_) => (
                    None,
                    analytics_requested_sources(selection),
                    if resource_state == SpeechResourceState::Ready {
                        TranscriptionMode::Live
                    } else {
                        TranscriptionMode::Unavailable
                    },
                    if selection.system {
                        SystemAudioCapability::Unavailable
                    } else {
                        SystemAudioCapability::NotRequested
                    },
                ),
            };
        if result.as_ref().is_err()
            || result
                .as_ref()
                .is_ok_and(|value| !value.attached_to_existing)
        {
            record_analytics::emit(RecordAnalyticsMilestone::RecordingStartResult {
                event_schema_version: 1,
                record_id,
                ok: result.is_ok(),
                capture_sources,
                transcription_mode,
                resource_state,
                system_audio_capability,
                error_code: result
                    .as_ref()
                    .err()
                    .map(|error| normalized_recording_error(error, "RECORDING_START_FAILED")),
            });
        }
        result
    }

    async fn start_inner(
        self: &Arc<Self>,
        input: RecordingStartInput,
    ) -> Result<RecordingStartResult, String> {
        validate_operation_id(&input.operation_id)?;
        let _operation = self.operation_gate.lock().await;
        {
            let mut state = self.state.lock().await;
            if let Some(result) =
                operation_result(&state, &input.operation_id, OperationKind::Start)?
            {
                return Ok(RecordingStartResult {
                    snapshot: result,
                    attached_to_existing: true,
                });
            }
            if let Some(slot) = state.slot.as_ref() {
                let snapshot = slot.snapshot();
                remember_operation(
                    &mut state,
                    input.operation_id,
                    OperationKind::Start,
                    snapshot.clone(),
                );
                return Ok(RecordingStartResult {
                    snapshot,
                    attached_to_existing: true,
                });
            }
        }

        ensure_disk_budget(self.record_store.root_dir())?;
        let backend = self.backend.clone();
        let selection = input.selection;
        let plan = tokio::task::spawn_blocking(move || backend.preflight(selection))
            .await
            .map_err(|error| format!("recording preflight panicked: {error}"))??;
        ensure_disk_budget(self.record_store.root_dir())?;

        let title = format!("录音 {}", Local::now().format("%Y-%m-%d %H:%M"));
        let tracks = plan.sources.iter().map(|source| source.track).collect();
        let speech = speech_recognition::global()
            .filter(|manager| {
                manager.capability_snapshot().resource_status == SpeechResourceStatus::Ready
            })
            .cloned();
        let initial_transcription_status = if speech.is_some() {
            TranscriptionStatus::NotStarted
        } else {
            TranscriptionStatus::Unavailable
        };
        let mut record = self
            .record_store
            .create_audio(AudioRecordCreateInput {
                title,
                tracks,
                transcription_status: initial_transcription_status,
            })
            .await?;
        record_analytics::emit_record_create(
            &record,
            AnalyticsSource::Desktop,
            AnalyticsSurface::LauncherInput,
        );
        let workspace = match self.record_store.audio_workspace_path(&record.id).await {
            Ok(workspace) => workspace,
            Err(error) => {
                self.fail_created_record(&record, "workspace_unavailable")
                    .await;
                return Err(error);
            }
        };
        let mut journal = match LifecycleJournal::open(&workspace, &record.id) {
            Ok(journal) => journal,
            Err(error) => {
                self.fail_created_record(&record, "journal_open_failed")
                    .await;
                return Err(error);
            }
        };
        let started_at_wall_time = now_ms();
        if let Err(error) = journal.append(
            started_at_wall_time,
            0,
            LifecycleEvent::CaptureAdmitted {
                operation_id: input.operation_id.clone(),
                sources: plan
                    .sources
                    .iter()
                    .map(|source| format!("{:?}", source.track).to_ascii_lowercase())
                    .collect(),
            },
        ) {
            self.fail_created_record(&record, "journal_admission_failed")
                .await;
            return Err(error);
        }

        let (wake_lock, wake_warning) = if self.acquire_wake_lock {
            match WakeLock::acquire(&format!("MyAgents recording {}", record.id)) {
                Ok(lock) => (Some(lock), None),
                Err(error) => {
                    if let Err(journal_error) = journal.append(
                        now_ms(),
                        0,
                        LifecycleEvent::WakeLockWarning {
                            error_code: "RECORDING_WAKE_LOCK_UNAVAILABLE".to_string(),
                        },
                    ) {
                        self.fail_created_record(&record, "wake_warning_journal_failed")
                            .await;
                        return Err(journal_error);
                    }
                    ulog_warn!("[recording] wake-lock unavailable: {}", error);
                    (
                        None,
                        Some(RecordingWarning {
                            code: "RECORDING_WAKE_LOCK_UNAVAILABLE".to_string(),
                        }),
                    )
                }
            }
        } else {
            (None, None)
        };

        let archives = match start_archives(&workspace, &plan) {
            Ok(archives) => archives,
            Err(error) => {
                let failed = self
                    .record_store
                    .update_audio_capture(&record.id, CaptureStatus::Failed, 0, None)
                    .await?;
                self.emit_change(
                    snapshot_from_record(&failed, 0, Vec::new(), Vec::new()),
                    false,
                );
                return Err(error);
            }
        };
        let (analyses, live_transcription) = if let Some(speech) = speech.as_ref() {
            match start_analyses(&workspace, &plan) {
                Ok(analyses) => {
                    let sources = analyses.iter().map(TrackAnalysisHandle::source).collect();
                    match speech.start_record_live(&record.id, sources).await {
                        Ok(()) => {
                            match self
                                .record_store
                                .update_audio_processing_status(
                                    &record.id,
                                    Some(TranscriptionStatus::Queued),
                                    None,
                                )
                                .await
                            {
                                Ok(queued) => record = queued,
                                Err(error) => ulog_warn!(
                                    "[recording] live queued status commit failed recordId={} error={}",
                                    record.id,
                                    error
                                ),
                            }
                            (analyses, true)
                        }
                        Err(error) => {
                            ulog_warn!(
                                "[recording] live transcription admission failed recordId={} error={}",
                                record.id,
                                error
                            );
                            cleanup_rejected_analyses(analyses);
                            record = self
                                .record_store
                                .update_audio_processing_status(
                                    &record.id,
                                    Some(TranscriptionStatus::Failed),
                                    None,
                                )
                                .await?;
                            (Vec::new(), false)
                        }
                    }
                }
                Err(error) => {
                    ulog_warn!(
                        "[recording] analysis spool admission failed recordId={} error={}",
                        record.id,
                        error
                    );
                    record = self
                        .record_store
                        .update_audio_processing_status(
                            &record.id,
                            Some(TranscriptionStatus::Failed),
                            None,
                        )
                        .await?;
                    (Vec::new(), false)
                }
            }
        } else {
            (Vec::new(), false)
        };
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let mut warnings = plan
            .warnings
            .iter()
            .cloned()
            .map(|code| RecordingWarning { code })
            .collect::<Vec<_>>();
        if let Some(warning) = wake_warning {
            warnings.push(warning);
        }
        let preparing = ActiveRecording {
            record_id: record.id.clone(),
            revision: record.revision,
            generation,
            capture_status: CaptureStatus::Preparing,
            started_at_wall_time,
            media_before_segment_ms: 0,
            segment_started: None,
            pause_started: None,
            paused_wall_ms: 0,
            pause_count: 0,
            capture_plan: plan.clone(),
            sources: plan.sources.clone(),
            source_sinks: Vec::new(),
            warnings,
            journal,
            time_journal_cursors: Vec::new(),
            session: None,
            archives,
            analyses,
            live_transcription,
            live_analysis_enabled: live_transcription,
            _wake_lock: wake_lock,
        };
        let preparing_snapshot = preparing.snapshot();
        {
            let mut state = self.state.lock().await;
            state.slot = Some(RecordingSlot::Live(preparing));
            remember_operation(
                &mut state,
                input.operation_id.clone(),
                OperationKind::Start,
                preparing_snapshot.clone(),
            );
        }
        self.emit_change(preparing_snapshot, true);

        let sinks = {
            let mut state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                return Err("recording admission was superseded".to_string());
            };
            let (sinks, source_sinks) = capture_sinks(&active.archives, &active.analyses);
            // Device callbacks can run before open() returns. The owner must
            // publish their media epoch before allowing that first callback.
            let started = Instant::now();
            active.segment_started = Some(started);
            for (_, sink) in &source_sinks {
                sink.set_media_epoch(Some(started), 0);
            }
            active.source_sinks = source_sinks;
            sinks
        };
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let backend = self.backend.clone();
        let open_result = tokio::task::spawn_blocking(move || backend.open(&plan, sinks, event_tx))
            .await
            .map_err(|error| format!("capture backend panicked: {error}"))?;
        let session = match open_result {
            Ok(session) => session,
            Err(error) => {
                self.settle_generation_locked(
                    generation,
                    CaptureStatus::Failed,
                    RecordingFinishReason::DeviceOpenFailed,
                    None,
                )
                .await?;
                return Err(error);
            }
        };

        let session = Arc::new(StdMutex::new(session));
        {
            let mut state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                return Err("recording admission was superseded".to_string());
            };
            if active.generation != generation {
                return Err("recording generation changed during admission".to_string());
            }
            active.session = Some(session);
        }
        let mut updated = match self
            .record_store
            .update_audio_capture(&record.id, CaptureStatus::Recording, 0, None)
            .await
        {
            Ok(updated) => updated,
            Err(error) => {
                let _ = self
                    .settle_generation_locked(
                        generation,
                        CaptureStatus::Interrupted,
                        RecordingFinishReason::RecordingStateCommitFailed,
                        None,
                    )
                    .await;
                return Err(error);
            }
        };
        if live_transcription {
            match self
                .record_store
                .update_audio_processing_status(&record.id, Some(TranscriptionStatus::Live), None)
                .await
            {
                Ok(live) => updated = live,
                Err(error) => ulog_warn!(
                    "[recording] live transcription status commit failed recordId={} error={}",
                    record.id,
                    error
                ),
            }
        }
        let snapshot_result = {
            let mut state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                return Err("recording admission was superseded".to_string());
            };
            if active.generation != generation {
                return Err("recording generation changed during admission".to_string());
            }
            active.revision = updated.revision;
            active.capture_status = CaptureStatus::Recording;
            active
                .journal
                .append(
                    now_ms(),
                    0,
                    LifecycleEvent::CaptureStatusChanged {
                        from: "preparing".to_string(),
                        to: "recording".to_string(),
                        reason: "devices_opened".to_string(),
                    },
                )
                .map(|_| active.snapshot())
        };
        let snapshot = match snapshot_result {
            Ok(snapshot) => {
                let mut state = self.state.lock().await;
                remember_operation(
                    &mut state,
                    input.operation_id,
                    OperationKind::Start,
                    snapshot.clone(),
                );
                snapshot
            }
            Err(error) => {
                let _ = self
                    .settle_generation_locked(
                        generation,
                        CaptureStatus::Interrupted,
                        RecordingFinishReason::RecordingJournalCommitFailed,
                        None,
                    )
                    .await;
                return Err(error);
            }
        };
        self.emit_change(snapshot.clone(), true);
        self.spawn_monitor(generation, event_rx);
        ulog_info!(
            "[recording] admitted recordId={} generation={}",
            snapshot.record_id,
            generation
        );
        Ok(RecordingStartResult {
            snapshot,
            attached_to_existing: false,
        })
    }

    async fn fail_created_record(&self, record: &Record, reason: &str) {
        match self
            .record_store
            .update_audio_capture(&record.id, CaptureStatus::Failed, 0, Some(Vec::new()))
            .await
        {
            Ok(failed) => self.emit_change(
                snapshot_from_record(&failed, 0, Vec::new(), Vec::new()),
                false,
            ),
            Err(error) => ulog_warn!(
                "[recording] failed to terminalize rejected Record recordId={} reason={} error={}",
                record.id,
                reason,
                error
            ),
        }
    }

    pub async fn pause(
        self: &Arc<Self>,
        input: RecordingCommandInput,
    ) -> Result<RecordingSnapshot, String> {
        self.transition_pause(input, true).await
    }

    pub async fn resume(
        self: &Arc<Self>,
        input: RecordingCommandInput,
    ) -> Result<RecordingSnapshot, String> {
        self.transition_pause(input, false).await
    }

    async fn transition_pause(
        self: &Arc<Self>,
        input: RecordingCommandInput,
        pause: bool,
    ) -> Result<RecordingSnapshot, String> {
        validate_operation_id(&input.operation_id)?;
        let kind = if pause {
            OperationKind::Pause
        } else {
            OperationKind::Resume
        };
        let _operation = self.operation_gate.lock().await;
        {
            let state = self.state.lock().await;
            if let Some(result) = operation_result(&state, &input.operation_id, kind)? {
                return Ok(result);
            }
        }
        self.validate_command_revision(&input).await?;

        let (
            session,
            generation,
            media_ms,
            paused_started_at,
            analysis_controls,
            live_analysis_enabled,
            record_id,
        ) = {
            let mut state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                return Err("RECORDING_NOT_ACTIVE".to_string());
            };
            if active.record_id != input.record_id {
                return Err("RECORDING_RECORD_MISMATCH".to_string());
            }
            if pause && active.capture_status == CaptureStatus::Paused
                || !pause && active.capture_status == CaptureStatus::Recording
            {
                let snapshot = active.snapshot();
                remember_operation(&mut state, input.operation_id, kind, snapshot.clone());
                return Ok(snapshot);
            }
            let expected = if pause {
                CaptureStatus::Recording
            } else {
                CaptureStatus::Paused
            };
            if active.capture_status != expected {
                return Err("RECORDING_TRANSITION_NOT_ALLOWED".to_string());
            }
            let media_ms = active.media_duration_ms();
            let transition_started = Instant::now();
            active.media_before_segment_ms = media_ms;
            active.segment_started = (!pause).then_some(transition_started);
            if pause {
                active.pause_started = Some(transition_started);
            }
            for (_, sink) in &active.source_sinks {
                sink.set_media_epoch(active.segment_started, media_ms);
            }
            for archive in &active.archives {
                archive.sink.set_accepting(!pause);
            }
            let analysis_controls = active
                .analyses
                .iter()
                .map(|analysis| (analysis.track, analysis.control()))
                .collect::<Vec<_>>();
            for (_, control) in &analysis_controls {
                control.set_accepting(!pause && active.live_analysis_enabled);
            }
            (
                active
                    .session
                    .as_ref()
                    .cloned()
                    .ok_or_else(|| "capture session missing".to_string())?,
                active.generation,
                media_ms,
                active.pause_started,
                analysis_controls,
                active.live_analysis_enabled,
                active.record_id.clone(),
            )
        };
        let result = tokio::task::spawn_blocking(move || {
            let mut session = session
                .lock()
                .map_err(|_| "capture session lock poisoned".to_string())?;
            if pause {
                session.pause()
            } else {
                session.resume()
            }
        })
        .await
        .map_err(|error| format!("capture transition panicked: {error}"))?;
        if let Err(error) = result {
            self.settle_generation_locked(
                generation,
                CaptureStatus::Interrupted,
                RecordingFinishReason::PauseResumeFailed,
                None,
            )
            .await?;
            return Err(error);
        }

        let mut live_control_ok = if pause && live_analysis_enabled {
            let checkpoint =
                match tokio::task::spawn_blocking(move || checkpoint_analyses(&analysis_controls))
                    .await
                {
                    Ok(checkpoint) => checkpoint,
                    Err(error) => Err(format!("analysis checkpoint panicked: {error}")),
                };
            match checkpoint {
                Ok(offsets) => {
                    if let Some(speech) = speech_recognition::global() {
                        if let Err(error) = speech.pause_record_live(&record_id, offsets) {
                            ulog_warn!(
                                "[recording] live pause flush failed recordId={} error={}",
                                record_id,
                                error
                            );
                            false
                        } else {
                            true
                        }
                    } else {
                        ulog_warn!(
                            "[recording] live pause owner unavailable recordId={}",
                            record_id
                        );
                        false
                    }
                }
                Err(error) => {
                    ulog_warn!(
                        "[recording] analysis pause checkpoint failed recordId={} error={}",
                        record_id,
                        error
                    );
                    false
                }
            }
        } else {
            true
        };

        let status = if pause {
            CaptureStatus::Paused
        } else {
            CaptureStatus::Recording
        };
        let updated = match self
            .record_store
            .update_audio_capture(&input.record_id, status, media_ms, None)
            .await
        {
            Ok(updated) => updated,
            Err(error) => {
                let _ = self
                    .settle_generation_locked(
                        generation,
                        CaptureStatus::Interrupted,
                        RecordingFinishReason::PauseResumeStateCommitFailed,
                        None,
                    )
                    .await;
                return Err(error);
            }
        };
        if !pause && live_analysis_enabled {
            live_control_ok = if let Some(speech) = speech_recognition::global() {
                if let Err(error) = speech.resume_record_live(&record_id) {
                    ulog_warn!(
                        "[recording] live resume failed recordId={} error={}",
                        record_id,
                        error
                    );
                    false
                } else {
                    true
                }
            } else {
                ulog_warn!(
                    "[recording] live resume owner unavailable recordId={}",
                    record_id
                );
                false
            };
        }
        let snapshot_result = {
            let mut state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                return Err("recording ended during transition".to_string());
            };
            if active.generation != generation {
                return Err("recording generation changed during transition".to_string());
            }
            active.revision = updated.revision;
            active.capture_status = status;
            if !live_control_ok {
                active.live_analysis_enabled = false;
            }
            let journal_result = if pause {
                active.media_before_segment_ms = media_ms;
                active.segment_started = None;
                let result = active.journal.append(
                    now_ms(),
                    media_ms,
                    LifecycleEvent::PauseStarted {
                        operation_id: input.operation_id.clone(),
                    },
                );
                if result.is_ok() {
                    active.pause_count = active.pause_count.saturating_add(1);
                }
                result
            } else {
                let paused_wall_ms = paused_started_at
                    .and_then(|started| {
                        active
                            .segment_started
                            .and_then(|resumed| resumed.checked_duration_since(started))
                    })
                    .map(duration_ms)
                    .unwrap_or(0);
                active.paused_wall_ms = active.paused_wall_ms.saturating_add(paused_wall_ms);
                active.pause_started = None;
                active.journal.append(
                    now_ms(),
                    media_ms,
                    LifecycleEvent::PauseEnded {
                        operation_id: input.operation_id.clone(),
                        paused_wall_ms,
                    },
                )
            };
            journal_result.map(|_| active.snapshot())
        };
        let snapshot = match snapshot_result {
            Ok(snapshot) => {
                let mut state = self.state.lock().await;
                remember_operation(&mut state, input.operation_id, kind, snapshot.clone());
                snapshot
            }
            Err(error) => {
                let _ = self
                    .settle_generation_locked(
                        generation,
                        CaptureStatus::Interrupted,
                        RecordingFinishReason::PauseResumeJournalFailed,
                        None,
                    )
                    .await;
                return Err(error);
            }
        };
        self.emit_change(snapshot.clone(), true);
        Ok(snapshot)
    }

    pub async fn stop(
        self: &Arc<Self>,
        input: RecordingCommandInput,
    ) -> Result<RecordingSnapshot, String> {
        validate_operation_id(&input.operation_id)?;
        let _operation = self.operation_gate.lock().await;
        {
            let state = self.state.lock().await;
            if let Some(result) =
                operation_result(&state, &input.operation_id, OperationKind::Stop)?
            {
                return Ok(result);
            }
        }
        self.validate_command_revision(&input).await?;
        let generation = {
            let state = self.state.lock().await;
            let Some(slot) = state.slot.as_ref() else {
                return Err("RECORDING_NOT_ACTIVE".to_string());
            };
            let snapshot = slot.snapshot();
            if snapshot.record_id != input.record_id {
                return Err("RECORDING_RECORD_MISMATCH".to_string());
            }
            snapshot.generation
        };
        self.settle_generation_locked(
            generation,
            CaptureStatus::Ready,
            RecordingFinishReason::UserStop,
            Some(input.operation_id),
        )
        .await
    }

    pub async fn set_source_enabled(
        self: &Arc<Self>,
        input: RecordingSourceCommandInput,
    ) -> Result<RecordingSnapshot, String> {
        validate_operation_id(&input.operation_id)?;
        if input.track == AudioTrackKind::Mixed {
            return Err("RECORDING_SOURCE_NOT_PHYSICAL".to_string());
        }
        let _operation = self.operation_gate.lock().await;
        {
            let state = self.state.lock().await;
            if let Some(result) =
                operation_result(&state, &input.operation_id, OperationKind::SetSource)?
            {
                return Ok(result);
            }
        }
        let snapshot = {
            let mut state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                return Err("RECORDING_NOT_ACTIVE".to_string());
            };
            if active.record_id != input.record_id {
                return Err("RECORDING_RECORD_MISMATCH".to_string());
            }
            if !matches!(
                active.capture_status,
                CaptureStatus::Recording | CaptureStatus::Paused
            ) {
                return Err("RECORDING_TRANSITION_NOT_ALLOWED".to_string());
            }
            let Some((_, sink)) = active
                .source_sinks
                .iter()
                .find(|(track, _)| *track == input.track)
            else {
                return Err("RECORDING_SOURCE_NOT_ACTIVE".to_string());
            };
            sink.set_enabled(input.enabled);
            let snapshot = active.snapshot();
            remember_operation(
                &mut state,
                input.operation_id,
                OperationKind::SetSource,
                snapshot.clone(),
            );
            snapshot
        };
        self.emit_change(snapshot.clone(), true);
        Ok(snapshot)
    }

    pub async fn stop_for_app_exit(self: &Arc<Self>) -> Result<(), String> {
        let _operation = self.operation_gate.lock().await;
        let generation = {
            let state = self.state.lock().await;
            let Some(slot) = state.slot.as_ref() else {
                return Ok(());
            };
            slot.snapshot().generation
        };
        let snapshot = self
            .settle_generation_locked(
                generation,
                CaptureStatus::Ready,
                RecordingFinishReason::AppExit,
                None,
            )
            .await?;
        if matches!(
            snapshot.capture_status,
            CaptureStatus::Ready | CaptureStatus::Interrupted | CaptureStatus::Failed
        ) {
            Ok(())
        } else {
            Err("RECORDING_EXIT_FINALIZATION_INCOMPLETE".to_string())
        }
    }

    async fn validate_command_revision(&self, input: &RecordingCommandInput) -> Result<(), String> {
        let control_revision = {
            let state = self.state.lock().await;
            let Some(slot) = state.slot.as_ref() else {
                return Err("RECORDING_NOT_ACTIVE".to_string());
            };
            let snapshot = slot.snapshot();
            if snapshot.record_id != input.record_id {
                return Err("RECORDING_RECORD_MISMATCH".to_string());
            }
            snapshot.revision
        };
        let record = self
            .record_store
            .get(&input.record_id)
            .await
            .ok_or_else(|| "RECORDING_RECORD_NOT_FOUND".to_string())?;
        // RecordStore owns one monotonic revision for every persisted change,
        // including live notes and metadata. RecordingManager owns the capture
        // control fence. Revisions advanced only by RecordStore content writes
        // are therefore valid, while anything older than the last control
        // transition (or newer than durable state) is stale/invalid.
        if input.expected_revision < control_revision || input.expected_revision > record.revision {
            return Err(format!(
                "RECORDING_REVISION_CONFLICT expected={} control={} record={}",
                input.expected_revision, control_revision, record.revision
            ));
        }
        Ok(())
    }

    async fn settle_generation(
        self: &Arc<Self>,
        generation: u64,
        desired_terminal: CaptureStatus,
        reason: RecordingFinishReason,
        operation_id: Option<String>,
    ) -> Result<RecordingSnapshot, String> {
        let _operation = self.operation_gate.lock().await;
        self.settle_generation_locked(generation, desired_terminal, reason, operation_id)
            .await
    }

    async fn settle_generation_locked(
        self: &Arc<Self>,
        generation: u64,
        desired_terminal: CaptureStatus,
        reason: RecordingFinishReason,
        operation_id: Option<String>,
    ) -> Result<RecordingSnapshot, String> {
        let mut active = {
            let mut state = self.state.lock().await;
            let Some(slot) = state.slot.take() else {
                return Err("RECORDING_NOT_ACTIVE".to_string());
            };
            match slot {
                RecordingSlot::Live(active) if active.generation == generation => active,
                other => {
                    let snapshot = other.snapshot();
                    state.slot = Some(other);
                    return Ok(snapshot);
                }
            }
        };
        let media_ms = active.media_duration_ms();
        active.capture_status = CaptureStatus::Stopping;
        active.media_before_segment_ms = media_ms;
        active.segment_started = None;
        for (_, sink) in &active.source_sinks {
            sink.set_media_epoch(None, media_ms);
        }
        for archive in &active.archives {
            archive.sink.set_accepting(false);
        }
        for analysis in &active.analyses {
            analysis.control().set_accepting(false);
        }
        if let Err(error) = active.journal.append(
            now_ms(),
            media_ms,
            LifecycleEvent::CaptureStatusChanged {
                from: "active".to_string(),
                to: "stopping".to_string(),
                reason: reason.as_str().to_string(),
            },
        ) {
            ulog_warn!(
                "[recording] failed to journal stopping recordId={} error={}",
                active.record_id,
                error
            );
        }
        let stopping_record = self
            .record_store
            .update_audio_capture(&active.record_id, CaptureStatus::Stopping, media_ms, None)
            .await;
        match stopping_record {
            Ok(stopping_record) => active.revision = stopping_record.revision,
            Err(error) => ulog_warn!(
                "[recording] failed to persist stopping state recordId={} error={}",
                active.record_id,
                error
            ),
        }
        let stopping = active.snapshot();
        {
            self.state.lock().await.slot = Some(RecordingSlot::Settling(stopping.clone()));
        }
        self.emit_change(stopping, true);

        let session = active.session.take();
        let archives = std::mem::take(&mut active.archives);
        let analyses = std::mem::take(&mut active.analyses);
        let settled = match tokio::task::spawn_blocking(move || {
            settle_capture_resources(session, archives, analyses)
        })
        .await
        {
            Ok(settled) => settled,
            Err(error) => {
                let error = format!("recording finalization panicked: {error}");
                self.release_failed_settlement(generation, &active.record_id, &error)
                    .await;
                return Err(error);
            }
        };

        let finalizing_record = self
            .record_store
            .update_audio_capture(&active.record_id, CaptureStatus::Finalizing, media_ms, None)
            .await;
        let mut finalizing = active.snapshot();
        match finalizing_record {
            Ok(finalizing_record) => finalizing.revision = finalizing_record.revision,
            Err(error) => ulog_warn!(
                "[recording] failed to persist finalizing state recordId={} error={}",
                active.record_id,
                error
            ),
        }
        finalizing.capture_status = CaptureStatus::Finalizing;
        {
            self.state.lock().await.slot = Some(RecordingSlot::Settling(finalizing.clone()));
        }
        self.emit_change(finalizing, true);

        let overrun_samples = settled
            .archives
            .iter()
            .map(|archive| archive.overrun_samples)
            .sum::<u64>();
        let mut terminal = desired_terminal;
        if let Err(error) = active.checkpoint_capture_times() {
            ulog_warn!(
                "[recording] final capture time checkpoint failed: {}",
                error
            );
            terminal = CaptureStatus::Interrupted;
        }
        if !settled.archive_errors.is_empty() || overrun_samples > 0 {
            terminal = CaptureStatus::Interrupted;
        }
        let usable_archives: Vec<&ArchiveResult> = settled
            .archives
            .iter()
            .filter(|archive| archive.media_samples_48k > 0)
            .collect();
        if usable_archives.is_empty() {
            terminal = if desired_terminal == CaptureStatus::Failed {
                CaptureStatus::Failed
            } else {
                CaptureStatus::Interrupted
            };
        }
        let archive_media_ms = usable_archives
            .iter()
            .map(|archive| {
                archive.media_samples_48k.saturating_mul(1_000) / ARCHIVE_SAMPLE_RATE as u64
            })
            .max()
            .unwrap_or(media_ms);
        let final_media_ms = media_ms.max(archive_media_ms);
        let artifacts: Vec<AudioTrackArtifactInput> = usable_archives
            .iter()
            .map(|archive| {
                let timing = active
                    .source_sinks
                    .iter()
                    .find(|(track, _)| *track == archive.track)
                    .map(|(_, sink)| sink.timeline())
                    .transpose()
                    .map(|timeline| timeline.flatten());
                let (timeline, capture_time_error) = match timing {
                    Ok(Some(timeline)) => match timeline.prefix(archive.media_samples_48k / 3) {
                        Some(timeline) => (Some(timeline), None),
                        None => (None, Some("RECORDING_CAPTURE_TIME_INVALID".to_string())),
                    },
                    Ok(None) => (None, None),
                    Err(_) => (None, Some("RECORDING_CAPTURE_TIME_UNAVAILABLE".to_string())),
                };
                AudioTrackArtifactInput {
                    track: archive.track,
                    relative_path: audio_track_relative_path(archive.track),
                    timeline,
                    capture_time_error,
                }
            })
            .collect();
        if artifacts
            .iter()
            .any(|artifact| artifact.capture_time_error.is_some())
        {
            terminal = CaptureStatus::Interrupted;
        }
        let has_usable_archives = !artifacts.is_empty();
        let terminal_record_result = if artifacts.is_empty() {
            self.record_store
                .update_audio_capture(
                    &active.record_id,
                    terminal,
                    final_media_ms,
                    Some(Vec::new()),
                )
                .await
        } else {
            self.record_store
                .finalize_audio_capture(&active.record_id, terminal, final_media_ms, artifacts)
                .await
        };
        let mut terminal_record = match terminal_record_result {
            Ok(record) => record,
            Err(error) => {
                ulog_warn!(
                    "[recording] terminal manifest commit failed recordId={} error={}",
                    active.record_id,
                    error
                );
                self.release_failed_settlement(generation, &active.record_id, &error)
                    .await;
                return Err(error);
            }
        };
        if let Err(error) = active.journal.append(
            now_ms(),
            final_media_ms,
            LifecycleEvent::ArchiveFinalized {
                tracks: usable_archives
                    .iter()
                    .map(|archive| format!("{:?}", archive.track).to_ascii_lowercase())
                    .collect(),
                size_bytes: usable_archives
                    .iter()
                    .map(|archive| archive.size_bytes)
                    .sum(),
                overrun_samples,
            },
        ) {
            ulog_warn!(
                "[recording] terminal manifest is durable but lifecycle append failed recordId={} error={}",
                active.record_id,
                error
            );
        }
        if active.live_transcription {
            if let Some(speech) = speech_recognition::global() {
                if let Err(error) =
                    speech.finish_record_live(&active.record_id, settled.analysis_offsets.clone())
                {
                    ulog_warn!(
                        "[recording] live final boundary failed recordId={} error={}",
                        active.record_id,
                        error
                    );
                }
                if has_usable_archives {
                    if let Err(error) = speech.submit_record_backfill(&active.record_id).await {
                        ulog_warn!(
                            "[recording] final transcript backfill admission failed recordId={} error={}",
                            active.record_id,
                            error
                        );
                        if let Ok(failed) = self
                            .record_store
                            .update_audio_processing_status(
                                &active.record_id,
                                Some(TranscriptionStatus::Failed),
                                None,
                            )
                            .await
                        {
                            terminal_record = failed;
                        }
                    }
                } else if let Ok(failed) = self
                    .record_store
                    .update_audio_processing_status(
                        &active.record_id,
                        Some(TranscriptionStatus::Failed),
                        None,
                    )
                    .await
                {
                    terminal_record = failed;
                }
                if let Some(latest) = self.record_store.get(&active.record_id).await {
                    terminal_record = latest;
                }
            }
        }
        let terminal_snapshot = RecordingSnapshot {
            record_id: active.record_id.clone(),
            revision: terminal_record.revision,
            generation,
            capture_status: terminal,
            started_at_wall_time: active.started_at_wall_time,
            media_duration_ms: final_media_ms,
            paused_wall_ms: active.snapshot().paused_wall_ms,
            sources: active.sources,
            source_activity: Vec::new(),
            warnings: active.warnings,
        };
        {
            let mut state = self.state.lock().await;
            state.slot = None;
            if let Some(operation_id) = operation_id {
                remember_operation(
                    &mut state,
                    operation_id,
                    OperationKind::Stop,
                    terminal_snapshot.clone(),
                );
            }
        }
        self.emit_change(terminal_snapshot.clone(), false);
        let audio_bytes = terminal_record
            .audio
            .as_ref()
            .map_or(0, |audio| audio.size_bytes);
        let analytics_store = self.record_store.clone();
        let analytics_record_id = terminal_snapshot.record_id.clone();
        let analytics_capture_status = terminal_snapshot.capture_status;
        let analytics_pause_count = active.pause_count;
        tauri::async_runtime::spawn(async move {
            emit_recording_finish_analytics(
                analytics_store,
                analytics_record_id,
                analytics_capture_status,
                reason,
                final_media_ms,
                analytics_pause_count,
                audio_bytes,
            )
            .await;
        });
        if !settled.archive_errors.is_empty() {
            ulog_warn!(
                "[recording] finalized interrupted recordId={} errors={}",
                terminal_snapshot.record_id,
                settled.archive_errors.join("; ")
            );
        }
        if !settled.analysis_errors.is_empty() {
            ulog_warn!(
                "[recording] live analysis degraded recordId={} errors={}",
                terminal_snapshot.record_id,
                settled.analysis_errors.join("; ")
            );
        }
        Ok(terminal_snapshot)
    }

    async fn release_failed_settlement(&self, generation: u64, record_id: &str, error: &str) {
        let released = {
            let mut state = self.state.lock().await;
            match state.slot.take() {
                Some(RecordingSlot::Settling(snapshot)) if snapshot.generation == generation => {
                    Some(snapshot)
                }
                other => {
                    state.slot = other;
                    None
                }
            }
        };
        if let Some(snapshot) = released {
            self.emit_change(snapshot, false);
        }
        ulog_warn!(
            "[recording] released failed settlement for startup recovery recordId={} generation={} error={}",
            record_id,
            generation,
            error
        );
    }

    async fn recover_capture(
        self: &Arc<Self>,
        generation: u64,
        failed_source: AudioTrackKind,
        error_code: String,
    ) {
        let _operation = self.operation_gate.lock().await;
        let Some((
            old_session,
            capture_plan,
            sinks,
            prior_status,
            media_ms,
            analysis_controls,
            live_analysis_enabled,
            record_id,
            frozen_snapshot,
            repaired_tracks,
        )) = ({
            let mut state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                return;
            };
            if active.generation != generation
                || !matches!(
                    active.capture_status,
                    CaptureStatus::Recording | CaptureStatus::Paused
                )
            {
                return;
            }

            let prior_status = active.capture_status;
            let media_ms = active.media_duration_ms();
            for (_, sink) in &active.source_sinks {
                sink.set_media_epoch(None, media_ms);
            }
            for archive in &active.archives {
                archive.sink.set_accepting(false);
            }
            let analysis_controls = active
                .analyses
                .iter()
                .map(|analysis| (analysis.track, analysis.control()))
                .collect::<Vec<_>>();
            for (_, control) in &analysis_controls {
                control.set_accepting(false);
            }
            if prior_status == CaptureStatus::Recording {
                active.media_before_segment_ms = media_ms;
                active.segment_started = None;
            }
            let sinks = CaptureSinks {
                microphone: active
                    .source_sinks
                    .iter()
                    .find(|(track, _)| *track == AudioTrackKind::Microphone)
                    .map(|(_, sink)| sink.clone()),
                system: active
                    .source_sinks
                    .iter()
                    .find(|(track, _)| *track == AudioTrackKind::System)
                    .map(|(_, sink)| sink.clone()),
            };
            let repaired_tracks = active
                .capture_plan
                .sources
                .iter()
                .map(|source| format!("{:?}", source.track).to_ascii_lowercase())
                .collect();
            Some((
                active.session.take(),
                active.capture_plan.clone(),
                sinks,
                prior_status,
                media_ms,
                analysis_controls,
                active.live_analysis_enabled,
                active.record_id.clone(),
                active.snapshot(),
                repaired_tracks,
            ))
        })
        else {
            return;
        };
        self.emit_change(frozen_snapshot, true);

        if let Some(old_session) = old_session {
            let stop_result = tokio::task::spawn_blocking(move || {
                old_session
                    .lock()
                    .map_err(|_| "capture session lock poisoned".to_string())?
                    .stop()
            })
            .await;
            match stop_result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => ulog_warn!(
                    "[recording] failed capture session stop before reopen recordId={} error={}",
                    record_id,
                    error
                ),
                Err(error) => ulog_warn!(
                    "[recording] capture session stop panicked before reopen recordId={} error={}",
                    record_id,
                    error
                ),
            }
        }

        let gap_result = {
            let mut state = self.state.lock().await;
            match state.slot.as_mut() {
                Some(RecordingSlot::Live(active))
                    if active.generation == generation && active.capture_status == prior_status =>
                {
                    active.journal.append(
                        now_ms(),
                        media_ms,
                        LifecycleEvent::DeviceGap {
                            source: format!("{failed_source:?}").to_ascii_lowercase(),
                            error_code,
                        },
                    )
                }
                Some(_) => Err("recording changed during capture recovery".to_string()),
                None => Err("recording ended during capture recovery".to_string()),
            }
        };
        if let Err(error) = gap_result {
            ulog_warn!(
                "[recording] capture gap commit failed recordId={} error={}",
                record_id,
                error
            );
            if let Err(settle_error) = self
                .settle_generation_locked(
                    generation,
                    CaptureStatus::Interrupted,
                    RecordingFinishReason::RecordingJournalCommitFailed,
                    None,
                )
                .await
            {
                ulog_warn!(
                    "[recording] capture gap failure settlement failed recordId={} error={}",
                    record_id,
                    settle_error
                );
            }
            return;
        }

        let resume_live_analysis = if live_analysis_enabled {
            let checkpoint =
                tokio::task::spawn_blocking(move || checkpoint_analyses(&analysis_controls)).await;
            match checkpoint {
                Ok(Ok(offsets)) => {
                    if let Some(speech) = speech_recognition::global() {
                        if let Err(error) = speech.flush_record_live(&record_id, offsets) {
                            ulog_warn!(
                                "[recording] live device-gap flush failed recordId={} error={}",
                                record_id,
                                error
                            );
                            false
                        } else {
                            true
                        }
                    } else {
                        ulog_warn!(
                            "[recording] live device-gap owner unavailable recordId={}",
                            record_id
                        );
                        false
                    }
                }
                Ok(Err(error)) => {
                    ulog_warn!(
                        "[recording] analysis device-gap checkpoint failed recordId={} error={}",
                        record_id,
                        error
                    );
                    false
                }
                Err(error) => {
                    ulog_warn!(
                        "[recording] analysis device-gap checkpoint panicked recordId={} error={}",
                        record_id,
                        error
                    );
                    false
                }
            }
        } else {
            false
        };

        let mut reopened = None;
        for attempt in 1..=CAPTURE_RECOVERY_ATTEMPTS {
            if attempt > 1 {
                tokio::time::sleep(CAPTURE_RECOVERY_BACKOFF).await;
            }
            let backend = self.backend.clone();
            let plan = capture_plan.clone();
            let attempt_sinks = sinks.clone();
            let (event_tx, event_rx) = mpsc::unbounded_channel();
            let open_result = tokio::task::spawn_blocking(move || {
                let mut session = backend.open(&plan, attempt_sinks, event_tx)?;
                if prior_status == CaptureStatus::Paused {
                    if let Err(error) = session.pause() {
                        let _ = session.stop();
                        return Err(error);
                    }
                }
                Ok(session)
            })
            .await;
            match open_result {
                Ok(Ok(session)) => {
                    reopened = Some((session, event_rx));
                    break;
                }
                Ok(Err(error)) => ulog_warn!(
                    "[recording] capture reopen attempt failed recordId={} attempt={}/{} error={}",
                    record_id,
                    attempt,
                    CAPTURE_RECOVERY_ATTEMPTS,
                    error
                ),
                Err(error) => ulog_warn!(
                    "[recording] capture reopen attempt panicked recordId={} attempt={}/{} error={}",
                    record_id,
                    attempt,
                    CAPTURE_RECOVERY_ATTEMPTS,
                    error
                ),
            }
        }

        let Some((session, event_rx)) = reopened else {
            if let Err(error) = self
                .settle_generation_locked(
                    generation,
                    CaptureStatus::Interrupted,
                    RecordingFinishReason::DeviceFatal,
                    None,
                )
                .await
            {
                ulog_warn!(
                    "[recording] exhausted capture recovery settlement failed recordId={} error={}",
                    record_id,
                    error
                );
            }
            return;
        };
        let session = Arc::new(StdMutex::new(session));
        let snapshot_result = {
            let mut state = self.state.lock().await;
            match state.slot.as_mut() {
                Some(RecordingSlot::Live(active))
                    if active.generation == generation && active.capture_status == prior_status =>
                {
                    match active.journal.append(
                        now_ms(),
                        media_ms,
                        LifecycleEvent::RecoveryCommitted {
                            repaired_tracks,
                            reason: "device_reopened".to_string(),
                        },
                    ) {
                        Ok(_) => {
                            active.session = Some(session.clone());
                            active.live_analysis_enabled &= resume_live_analysis;
                            if prior_status == CaptureStatus::Recording {
                                active.segment_started = Some(Instant::now());
                                for (_, sink) in &active.source_sinks {
                                    sink.set_media_epoch(active.segment_started, media_ms);
                                }
                                for archive in &active.archives {
                                    archive.sink.set_accepting(true);
                                }
                                for analysis in &active.analyses {
                                    analysis
                                        .control()
                                        .set_accepting(active.live_analysis_enabled);
                                }
                            }
                            Ok(active.snapshot())
                        }
                        Err(error) => Err(error),
                    }
                }
                Some(_) => Err("recording changed during capture recovery".to_string()),
                None => Err("recording ended during capture recovery".to_string()),
            }
        };
        match snapshot_result {
            Ok(snapshot) => {
                self.emit_change(snapshot, true);
                self.spawn_monitor(generation, event_rx);
            }
            Err(error) => {
                ulog_warn!(
                    "[recording] capture recovery commit failed recordId={} error={}",
                    record_id,
                    error
                );
                let stop_result = tokio::task::spawn_blocking(move || {
                    session
                        .lock()
                        .map_err(|_| "capture session lock poisoned".to_string())?
                        .stop()
                })
                .await;
                match stop_result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => ulog_warn!(
                        "[recording] recovered capture cleanup failed recordId={} error={}",
                        record_id,
                        error
                    ),
                    Err(error) => ulog_warn!(
                        "[recording] recovered capture cleanup panicked recordId={} error={}",
                        record_id,
                        error
                    ),
                }
                if let Err(settle_error) = self
                    .settle_generation_locked(
                        generation,
                        CaptureStatus::Interrupted,
                        RecordingFinishReason::DeviceFatal,
                        None,
                    )
                    .await
                {
                    ulog_warn!(
                        "[recording] recovery commit failure settlement failed recordId={} error={}",
                        record_id,
                        settle_error
                    );
                }
            }
        }
    }

    fn spawn_monitor(
        self: &Arc<Self>,
        generation: u64,
        mut events: mpsc::UnboundedReceiver<CaptureEvent>,
    ) {
        let manager = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(MONITOR_INTERVAL);
            interval.tick().await;
            loop {
                tokio::select! {
                    event = events.recv() => {
                        let Some(event) = event else { break; };
                        let Some(manager) = manager.upgrade() else { break; };
                        match &event {
                            CaptureEvent::DeviceGap { .. } => {
                                manager.record_capture_event(generation, &event).await;
                            }
                            CaptureEvent::Fatal { track, code } => {
                                manager
                                    .recover_capture(generation, *track, code.clone())
                                    .await;
                                break;
                            }
                        }
                    }
                    _ = interval.tick() => {
                        let Some(manager) = manager.upgrade() else { break; };
                        if !manager.is_generation_active(generation).await { break; }
                        let timing = {
                            let mut state = manager.state.lock().await;
                            match state.slot.as_mut() {
                                Some(RecordingSlot::Live(active)) if active.generation == generation => active.checkpoint_capture_times(),
                                _ => break,
                            }
                        };
                        if let Err(error) = timing {
                            ulog_warn!("[recording] capture time checkpoint failed: {}", error);
                            let _ = manager.settle_generation(generation, CaptureStatus::Interrupted,
                                RecordingFinishReason::RecordingJournalCommitFailed, None).await;
                            break;
                        }
                        if let Err(error) = ensure_disk_budget(manager.record_store.root_dir()) {
                            ulog_warn!("[recording] low disk safe stop: {}", error);
                            let _ = manager
                                .settle_generation(
                                    generation,
                                    CaptureStatus::Interrupted,
                                    RecordingFinishReason::LowDisk,
                                    None,
                                )
                                .await;
                            break;
                        }
                    }
                }
            }
        });
    }

    async fn record_capture_event(&self, generation: u64, event: &CaptureEvent) {
        let mut state = self.state.lock().await;
        let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
            return;
        };
        if active.generation != generation {
            return;
        }
        let (track, code) = match event {
            CaptureEvent::DeviceGap { track, code } | CaptureEvent::Fatal { track, code } => {
                (*track, code.clone())
            }
        };
        let _ = active.journal.append(
            now_ms(),
            active.media_duration_ms(),
            LifecycleEvent::DeviceGap {
                source: format!("{track:?}").to_ascii_lowercase(),
                error_code: code,
            },
        );
    }

    async fn is_generation_active(&self, generation: u64) -> bool {
        self.state.lock().await.slot.as_ref().is_some_and(|slot| {
            slot.snapshot().generation == generation
                && matches!(
                    slot.snapshot().capture_status,
                    CaptureStatus::Preparing | CaptureStatus::Recording | CaptureStatus::Paused
                )
        })
    }

    fn emit_change(&self, snapshot: RecordingSnapshot, active: bool) {
        let sequence = self.change_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.changes.send(RecordingChange {
            sequence,
            record_id: snapshot.record_id.clone(),
            revision: snapshot.revision,
            capture_status: snapshot.capture_status,
            snapshot: active.then_some(snapshot),
        });
    }
}

struct SettledResources {
    archives: Vec<ArchiveResult>,
    archive_errors: Vec<String>,
    analysis_offsets: Vec<RecordTranscriptTrackOffset>,
    analysis_errors: Vec<String>,
}

fn settle_capture_resources(
    session: Option<Arc<StdMutex<Box<dyn CaptureSession>>>>,
    archives: Vec<TrackArchiveHandle>,
    analyses: Vec<TrackAnalysisHandle>,
) -> SettledResources {
    let mut archive_errors = Vec::new();
    if let Some(session) = session {
        match session.lock() {
            Ok(mut session) => {
                if let Err(error) = session.stop() {
                    archive_errors.push(error);
                }
            }
            Err(_) => archive_errors.push("capture session lock poisoned".to_string()),
        }
    }
    let mut finalized = Vec::new();
    for archive in archives {
        match archive.finish() {
            Ok(result) => finalized.push(result),
            Err(error) => archive_errors.push(error),
        }
    }
    let mut analysis_offsets = Vec::with_capacity(analyses.len());
    let mut analysis_errors = Vec::new();
    for analysis in analyses {
        let track = analysis.track;
        let source = analysis.source();
        match analysis.finish() {
            Ok(result) => {
                debug_assert_eq!(result.track, track);
                debug_assert_eq!(result.path, source.path());
                if result.overrun_samples > 0 {
                    analysis_errors.push("SPEECH_ANALYSIS_OVERRUN".to_string());
                }
                analysis_offsets.push(RecordTranscriptTrackOffset {
                    track,
                    sample: result.samples_16k,
                });
            }
            Err(error) => {
                analysis_errors.push(error);
                analysis_offsets.push(RecordTranscriptTrackOffset {
                    track,
                    sample: source.snapshot().committed_samples,
                });
            }
        }
    }
    SettledResources {
        archives: finalized,
        archive_errors,
        analysis_offsets,
        analysis_errors,
    }
}

fn start_archives(workspace: &Path, plan: &CapturePlan) -> Result<Vec<TrackArchiveHandle>, String> {
    let mut archives = Vec::with_capacity(plan.sources.len());
    for source in &plan.sources {
        let path = workspace.join(audio_track_relative_path(source.track));
        match TrackArchiveHandle::start(source.track, path, source.format.into()) {
            Ok(archive) => archives.push(archive),
            Err(error) => {
                for archive in archives {
                    let _ = archive.finish();
                }
                return Err(error);
            }
        }
    }
    Ok(archives)
}

fn start_analyses(
    workspace: &Path,
    plan: &CapturePlan,
) -> Result<Vec<TrackAnalysisHandle>, String> {
    let mut analyses = Vec::with_capacity(plan.sources.len());
    for source in &plan.sources {
        let path = workspace.join(analysis_spool_relative_path(source.track)?);
        match TrackAnalysisHandle::start(source.track, path, source.format.into()) {
            Ok(analysis) => analyses.push(analysis),
            Err(error) => {
                cleanup_rejected_analyses(analyses);
                return Err(error);
            }
        }
    }
    Ok(analyses)
}

fn cleanup_rejected_analyses(analyses: Vec<TrackAnalysisHandle>) {
    for analysis in analyses {
        let path = analysis.source().path().to_path_buf();
        let _ = analysis.finish();
        if let Err(error) = cleanup_analysis_spool(&path) {
            ulog_warn!(
                "[recording] rejected analysis cleanup failed path={} error={}",
                path.display(),
                error
            );
        }
    }
}

fn checkpoint_analyses(
    controls: &[(AudioTrackKind, AnalysisControl)],
) -> Result<Vec<RecordTranscriptTrackOffset>, String> {
    controls
        .iter()
        .map(|(track, control)| {
            control
                .checkpoint()
                .map(|sample| RecordTranscriptTrackOffset {
                    track: *track,
                    sample,
                })
        })
        .collect()
}

fn capture_sinks(
    archives: &[TrackArchiveHandle],
    analyses: &[TrackAnalysisHandle],
) -> (CaptureSinks, Vec<(AudioTrackKind, CaptureTrackSink)>) {
    let mut sinks = CaptureSinks {
        microphone: None,
        system: None,
    };
    let mut source_sinks = Vec::new();
    for archive in archives {
        let analysis = analyses
            .iter()
            .find(|analysis| analysis.track == archive.track)
            .map(|analysis| analysis.sink.clone());
        let sink = CaptureTrackSink::new(archive.sink.clone(), analysis);
        source_sinks.push((archive.track, sink.clone()));
        match archive.track {
            AudioTrackKind::Microphone => sinks.microphone = Some(sink),
            AudioTrackKind::System => sinks.system = Some(sink),
            _ => {}
        }
    }
    (sinks, source_sinks)
}

fn operation_result(
    state: &ManagerState,
    operation_id: &str,
    expected_kind: OperationKind,
) -> Result<Option<RecordingSnapshot>, String> {
    let Some(result) = state.operation_results.get(operation_id) else {
        return Ok(None);
    };
    if result.kind != expected_kind {
        return Err("RECORDING_OPERATION_ID_REUSED".to_string());
    }
    Ok(Some(result.snapshot.clone()))
}

fn remember_operation(
    state: &mut ManagerState,
    operation_id: String,
    kind: OperationKind,
    snapshot: RecordingSnapshot,
) {
    if let Some(result) = state.operation_results.get_mut(&operation_id) {
        *result = OperationResult { kind, snapshot };
        return;
    }
    state.operation_order.push_back(operation_id.clone());
    state
        .operation_results
        .insert(operation_id, OperationResult { kind, snapshot });
    while state.operation_order.len() > COMPLETED_OPERATION_LIMIT {
        if let Some(expired) = state.operation_order.pop_front() {
            state.operation_results.remove(&expired);
        }
    }
}

fn validate_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("RECORDING_OPERATION_ID_INVALID".to_string());
    }
    Ok(())
}

fn analytics_requested_sources(selection: CaptureSelection) -> CaptureSources {
    match (selection.microphone, selection.system) {
        (true, true) => CaptureSources::MicrophoneSystem,
        (true, false) => CaptureSources::Microphone,
        (false, true) => CaptureSources::System,
        (false, false) => CaptureSources::None,
    }
}

fn analytics_capture_sources(sources: &[PreparedSource]) -> CaptureSources {
    let microphone = sources
        .iter()
        .any(|source| source.track == AudioTrackKind::Microphone);
    let system = sources
        .iter()
        .any(|source| source.track == AudioTrackKind::System);
    analytics_requested_sources(CaptureSelection { microphone, system })
}

fn normalized_recording_error(error: &str, fallback: &str) -> String {
    let candidate = error.split_whitespace().next().unwrap_or_default();
    if candidate.len() <= 64
        && (candidate.starts_with("RECORDING_") || candidate.starts_with("CAPTURE_"))
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        candidate.to_string()
    } else {
        fallback.to_string()
    }
}

async fn emit_recording_finish_analytics(
    record_store: ManagedRecordStore,
    record_id: String,
    capture_status: CaptureStatus,
    reason: RecordingFinishReason,
    media_ms: u64,
    pause_count: usize,
    audio_bytes: u64,
) {
    let timeline = record_store.read_timeline(&record_id).await.ok();
    let (note_count, mark_count) = timeline.map_or((0, 0), |timeline| {
        timeline
            .items
            .into_iter()
            .fold((0, 0), |(notes, marks), item| match item {
                crate::record::RecordTimelineItem::Note { .. } => (notes + 1, marks),
                crate::record::RecordTimelineItem::Mark { .. } => (notes, marks + 1),
            })
    });
    let covered_ms = record_store
        .read_transcript_projection(&record_id)
        .await
        .ok()
        .flatten()
        .map_or(0, |transcript| transcript_covered_ms(&transcript.segments));
    let finalizations = record_store
        .read_live_segment_finalizations(&record_id)
        .await
        .unwrap_or_default();
    let latency_buckets = record_store
        .audio_workspace_path(&record_id)
        .await
        .ok()
        .and_then(|workspace| recording_latency_buckets(&workspace, &record_id, &finalizations));
    record_analytics::emit(RecordAnalyticsMilestone::RecordingFinish {
        event_schema_version: 1,
        record_id,
        outcome: match capture_status {
            CaptureStatus::Ready => AnalyticsOutcome::Success,
            CaptureStatus::Interrupted => AnalyticsOutcome::Partial,
            _ => AnalyticsOutcome::Failed,
        },
        finish_reason: reason,
        media_duration_bucket: record_analytics::media_duration_bucket(media_ms),
        pause_count_bucket: record_analytics::small_count_bucket(pause_count),
        note_count_bucket: record_analytics::small_count_bucket(note_count),
        mark_count_bucket: record_analytics::small_count_bucket(mark_count),
        audio_bytes_bucket: record_analytics::media_bytes_bucket(audio_bytes),
        live_transcript_coverage: record_analytics::transcript_coverage_bucket(
            covered_ms, media_ms,
        ),
        segment_latency_p50_bucket: latency_buckets.map(|value| value.0),
        segment_latency_p95_bucket: latency_buckets.map(|value| value.1),
    });
}

fn transcript_covered_ms(segments: &[crate::record::RecordTranscriptSegment]) -> u64 {
    let mut microphone = Vec::new();
    let mut system = Vec::new();
    for segment in segments {
        match segment.track {
            AudioTrackKind::Microphone => {
                microphone.push((segment.start_sample, segment.end_sample))
            }
            AudioTrackKind::System => system.push((segment.start_sample, segment.end_sample)),
            AudioTrackKind::Mixed => {}
        }
    }
    let covered_samples = [microphone, system]
        .into_iter()
        .map(|mut intervals| {
            intervals.sort_unstable();
            let mut covered = 0_u64;
            let mut current: Option<(u64, u64)> = None;
            for (start, end) in intervals {
                current = match current {
                    None => Some((start, end)),
                    Some((current_start, current_end)) if start <= current_end => {
                        Some((current_start, current_end.max(end)))
                    }
                    Some((current_start, current_end)) => {
                        covered = covered.saturating_add(current_end.saturating_sub(current_start));
                        Some((start, end))
                    }
                };
            }
            if let Some((start, end)) = current {
                covered = covered.saturating_add(end.saturating_sub(start));
            }
            covered
        })
        .max()
        .unwrap_or(0);
    covered_samples.saturating_mul(1_000) / 16_000
}

fn recording_latency_buckets(
    workspace: &Path,
    record_id: &str,
    finalizations: &[crate::record::RecordSegmentFinalization],
) -> Option<(
    record_analytics::SegmentLatencyBucket,
    record_analytics::SegmentLatencyBucket,
)> {
    if finalizations.is_empty() {
        return None;
    }
    let lifecycle = LifecycleJournal::read_entries(workspace, record_id).ok()?;
    let capture_started_at = lifecycle.iter().find_map(|entry| match &entry.event {
        LifecycleEvent::CaptureStatusChanged { to, .. } if to == "recording" => {
            Some(entry.wall_time_ms)
        }
        _ => None,
    })?;
    let pauses = lifecycle
        .iter()
        .filter_map(|entry| match entry.event {
            LifecycleEvent::PauseEnded { paused_wall_ms, .. } => {
                Some((entry.media_ms, paused_wall_ms))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let mut latencies = finalizations
        .iter()
        .map(|finalization| {
            let prior_pause_ms = pauses
                .iter()
                .filter(|(media_ms, _)| *media_ms < finalization.media_ms)
                .map(|(_, paused_ms)| *paused_ms)
                .sum::<u64>();
            let expected_wall_time = capture_started_at
                .saturating_add(i64::try_from(finalization.media_ms).unwrap_or(i64::MAX))
                .saturating_add(i64::try_from(prior_pause_ms).unwrap_or(i64::MAX));
            u64::try_from(
                finalization
                    .wall_time_ms
                    .saturating_sub(expected_wall_time)
                    .max(0),
            )
            .unwrap_or(0)
        })
        .collect::<Vec<_>>();
    latencies.sort_unstable();
    let p50 = latencies[(latencies.len() - 1) / 2];
    let p95_index = latencies
        .len()
        .saturating_mul(95)
        .div_ceil(100)
        .saturating_sub(1);
    let p95 = latencies[p95_index.min(latencies.len() - 1)];
    Some((
        record_analytics::segment_latency_bucket(p50),
        record_analytics::segment_latency_bucket(p95),
    ))
}

fn ensure_disk_budget(path: &Path) -> Result<(), String> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let available = crate::filesystem_capacity::available_space(&canonical).map_err(|error| {
        ulog_warn!(
            "[recording] disk capacity unavailable target=record_store error_kind={:?} os_code={:?}",
            error.kind(),
            error.raw_os_error(),
        );
        "RECORDING_DISK_UNAVAILABLE".to_string()
    })?;
    if available < MIN_RECORDING_FREE_BYTES {
        return Err("RECORDING_DISK_LOW".to_string());
    }
    Ok(())
}

fn is_slot_owning_status(status: CaptureStatus) -> bool {
    matches!(
        status,
        CaptureStatus::Preparing
            | CaptureStatus::Recording
            | CaptureStatus::Paused
            | CaptureStatus::Stopping
            | CaptureStatus::Finalizing
    )
}

fn snapshot_from_record(
    record: &Record,
    generation: u64,
    sources: Vec<PreparedSource>,
    warnings: Vec<RecordingWarning>,
) -> RecordingSnapshot {
    let audio = record.audio.as_ref();
    RecordingSnapshot {
        record_id: record.id.clone(),
        revision: record.revision,
        generation,
        capture_status: audio.map_or(CaptureStatus::Failed, |audio| audio.capture_status),
        started_at_wall_time: record.created_at,
        media_duration_ms: audio.map_or(0, |audio| audio.media_duration_ms),
        paused_wall_ms: 0,
        sources,
        source_activity: Vec::new(),
        warnings,
    }
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[tauri::command]
pub async fn cmd_recording_snapshot(
    state: tauri::State<'_, ManagedRecordingManager>,
) -> Result<Option<RecordingSnapshot>, String> {
    Ok(state.snapshot().await)
}

#[tauri::command]
pub async fn cmd_recording_start(
    state: tauri::State<'_, ManagedRecordingManager>,
    input: RecordingStartInput,
) -> Result<RecordingStartResult, String> {
    state.inner().start(input).await
}

#[tauri::command]
pub async fn cmd_recording_pause(
    state: tauri::State<'_, ManagedRecordingManager>,
    input: RecordingCommandInput,
) -> Result<RecordingSnapshot, String> {
    state.inner().pause(input).await
}

#[tauri::command]
pub async fn cmd_recording_resume(
    state: tauri::State<'_, ManagedRecordingManager>,
    input: RecordingCommandInput,
) -> Result<RecordingSnapshot, String> {
    state.inner().resume(input).await
}

#[tauri::command]
pub async fn cmd_recording_set_source_enabled(
    state: tauri::State<'_, ManagedRecordingManager>,
    input: RecordingSourceCommandInput,
) -> Result<RecordingSnapshot, String> {
    state.inner().set_source_enabled(input).await
}

#[tauri::command]
pub async fn cmd_recording_stop(
    state: tauri::State<'_, ManagedRecordingManager>,
    input: RecordingCommandInput,
) -> Result<RecordingSnapshot, String> {
    state.inner().stop(input).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::{RecordNoteCreateInput, RecordStore};
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::thread::JoinHandle;
    use tempfile::tempdir;

    fn assert_audio_artifacts(record: &Record, expected: usize) {
        let audio_artifacts = record
            .artifacts
            .iter()
            .filter(|artifact| artifact.kind == "audio/ogg-opus")
            .collect::<Vec<_>>();
        assert_eq!(audio_artifacts.len(), expected);
        assert!(audio_artifacts
            .iter()
            .all(|artifact| artifact.size_bytes > 0));
    }

    #[test]
    fn transcript_latency_uses_media_time_and_completed_pauses() {
        let root = tempdir().unwrap();
        let record_id = "record-latency";
        let mut journal = LifecycleJournal::open(root.path(), record_id).unwrap();
        journal
            .append(
                1_000,
                0,
                LifecycleEvent::CaptureStatusChanged {
                    from: "preparing".into(),
                    to: "recording".into(),
                    reason: "devices_opened".into(),
                },
            )
            .unwrap();
        journal
            .append(
                2_000,
                1_000,
                LifecycleEvent::PauseStarted {
                    operation_id: "pause-1".into(),
                },
            )
            .unwrap();
        journal
            .append(
                5_000,
                1_000,
                LifecycleEvent::PauseEnded {
                    operation_id: "resume-1".into(),
                    paused_wall_ms: 3_000,
                },
            )
            .unwrap();

        let buckets = recording_latency_buckets(
            root.path(),
            record_id,
            &[
                crate::record::RecordSegmentFinalization {
                    wall_time_ms: 2_500,
                    media_ms: 1_000,
                },
                crate::record::RecordSegmentFinalization {
                    wall_time_ms: 7_000,
                    media_ms: 2_000,
                },
            ],
        )
        .unwrap();
        assert_eq!(
            buckets.0,
            record_analytics::SegmentLatencyBucket::FiveHundredToOneThousandMilliseconds
        );
        assert_eq!(
            buckets.1,
            record_analytics::SegmentLatencyBucket::OneToTwoSeconds
        );
    }

    struct FakeBackend;

    impl CaptureBackend for FakeBackend {
        fn preflight(&self, selection: CaptureSelection) -> Result<CapturePlan, String> {
            let mut sources = Vec::new();
            if selection.microphone {
                sources.push(PreparedSource {
                    track: AudioTrackKind::Microphone,
                    label: "fake microphone".to_string(),
                    format: super::super::capture::CaptureFormat {
                        sample_rate: 48_000,
                        channels: 1,
                    },
                });
            }
            if selection.system {
                sources.push(PreparedSource {
                    track: AudioTrackKind::System,
                    label: "fake system".to_string(),
                    format: super::super::capture::CaptureFormat {
                        sample_rate: 48_000,
                        channels: 2,
                    },
                });
            }
            Ok(CapturePlan::for_test(sources))
        }

        fn open(
            &self,
            _plan: &CapturePlan,
            sinks: CaptureSinks,
            _events: mpsc::UnboundedSender<CaptureEvent>,
        ) -> Result<Box<dyn CaptureSession>, String> {
            Ok(Box::new(FakeSession::start(sinks)))
        }
    }

    struct RecoveringBackend {
        open_count: AtomicUsize,
        recovery_failures: usize,
    }

    impl RecoveringBackend {
        fn new(recovery_failures: usize) -> Self {
            Self {
                open_count: AtomicUsize::new(0),
                recovery_failures,
            }
        }

        fn open_count(&self) -> usize {
            self.open_count.load(Ordering::Acquire)
        }
    }

    impl CaptureBackend for RecoveringBackend {
        fn preflight(&self, selection: CaptureSelection) -> Result<CapturePlan, String> {
            FakeBackend.preflight(selection)
        }

        fn open(
            &self,
            _plan: &CapturePlan,
            sinks: CaptureSinks,
            events: mpsc::UnboundedSender<CaptureEvent>,
        ) -> Result<Box<dyn CaptureSession>, String> {
            let open_index = self.open_count.fetch_add(1, Ordering::AcqRel);
            if open_index > 0 && open_index <= self.recovery_failures {
                return Err("RECORDING_DEVICE_CHANGED".to_string());
            }
            let session = FakeSession::start(sinks);
            if open_index == 0 {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(100));
                    let _ = events.send(CaptureEvent::Fatal {
                        track: AudioTrackKind::Microphone,
                        code: "CPAL_DEVICECHANGED".to_string(),
                    });
                });
            }
            Ok(Box::new(session))
        }
    }

    struct FakeSession {
        running: Arc<AtomicBool>,
        paused: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl FakeSession {
        fn start(sinks: CaptureSinks) -> Self {
            let running = Arc::new(AtomicBool::new(true));
            let paused = Arc::new(AtomicBool::new(false));
            let running_worker = running.clone();
            let paused_worker = paused.clone();
            let worker = std::thread::spawn(move || {
                while running_worker.load(Ordering::Acquire) {
                    if !paused_worker.load(Ordering::Acquire) {
                        if let Some(sink) = sinks.microphone.as_ref() {
                            sink.push_f32(&[0.05; 480]);
                        }
                        if let Some(sink) = sinks.system.as_ref() {
                            sink.push_f32(&[0.03; 960]);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            });
            Self {
                running,
                paused,
                worker: Some(worker),
            }
        }
    }

    impl CaptureSession for FakeSession {
        fn pause(&mut self) -> Result<(), String> {
            self.paused.store(true, Ordering::Release);
            Ok(())
        }

        fn resume(&mut self) -> Result<(), String> {
            self.paused.store(false, Ordering::Release);
            Ok(())
        }

        fn stop(&mut self) -> Result<(), String> {
            self.running.store(false, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                worker
                    .join()
                    .map_err(|_| "fake capture panic".to_string())?;
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn one_global_slot_pause_freeze_and_durable_stop() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let manager = RecordingManager::with_backend(store.clone(), Arc::new(FakeBackend), false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "start-1".to_string(),
                selection: CaptureSelection::default(),
            })
            .await
            .unwrap();
        let attached = manager
            .start(RecordingStartInput {
                operation_id: "start-2".to_string(),
                selection: CaptureSelection::default(),
            })
            .await
            .unwrap();
        assert!(attached.attached_to_existing);
        assert_eq!(attached.snapshot.record_id, started.snapshot.record_id);

        tokio::time::sleep(Duration::from_millis(35)).await;
        let activity = manager.snapshot().await.unwrap().source_activity;
        assert_eq!(activity.len(), 2);
        assert!(activity.iter().all(|source| source.level_percent > 0));
        let paused = manager
            .pause(RecordingCommandInput {
                record_id: started.snapshot.record_id.clone(),
                expected_revision: started.snapshot.revision,
                operation_id: "pause-1".to_string(),
            })
            .await
            .unwrap();
        let frozen = paused.media_duration_ms;
        assert!(paused
            .source_activity
            .iter()
            .all(|source| source.level_percent == 0));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(manager.snapshot().await.unwrap().media_duration_ms, frozen);
        let resumed = manager
            .resume(RecordingCommandInput {
                record_id: paused.record_id.clone(),
                expected_revision: paused.revision,
                operation_id: "resume-1".to_string(),
            })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(25)).await;
        let stopped = manager
            .stop(RecordingCommandInput {
                record_id: resumed.record_id.clone(),
                expected_revision: resumed.revision,
                operation_id: "stop-1".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(stopped.capture_status, CaptureStatus::Ready);
        assert!(manager.snapshot().await.is_none());

        let record = store.get(&stopped.record_id).await.unwrap();
        assert_eq!(
            record.audio.as_ref().unwrap().capture_status,
            CaptureStatus::Ready
        );
        assert_audio_artifacts(&record, 2);
    }

    #[tokio::test]
    async fn timeline_notes_do_not_invalidate_pause_or_stop_controls() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let manager = RecordingManager::with_backend(store.clone(), Arc::new(FakeBackend), false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "start-with-notes".to_string(),
                selection: CaptureSelection::default(),
            })
            .await
            .unwrap();

        let first_timeline = store
            .add_note(RecordNoteCreateInput {
                record_id: started.snapshot.record_id.clone(),
                operation_id: "11111111-1111-4111-8111-111111111111".to_string(),
                anchor_media_ms: 1_000,
                started_at_wall_time: 1_700_000_000_000,
                submitted_at_wall_time: 1_700_000_001_000,
                text: "first live note".to_string(),
            })
            .await
            .unwrap();
        assert!(first_timeline.revision > started.snapshot.revision);

        let paused = manager
            .pause(RecordingCommandInput {
                record_id: started.snapshot.record_id.clone(),
                expected_revision: started.snapshot.revision,
                operation_id: "pause-after-note".to_string(),
            })
            .await
            .unwrap();

        let second_timeline = store
            .add_note(RecordNoteCreateInput {
                record_id: paused.record_id.clone(),
                operation_id: "22222222-2222-4222-8222-222222222222".to_string(),
                anchor_media_ms: 2_000,
                started_at_wall_time: 1_700_000_002_000,
                submitted_at_wall_time: 1_700_000_003_000,
                text: "second live note".to_string(),
            })
            .await
            .unwrap();
        assert!(second_timeline.revision > paused.revision);

        let stopped = manager
            .stop(RecordingCommandInput {
                record_id: paused.record_id,
                expected_revision: paused.revision,
                operation_id: "stop-after-note".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(stopped.capture_status, CaptureStatus::Ready);
    }

    #[tokio::test]
    async fn one_source_can_be_excluded_and_restored_inside_the_same_generation() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let manager = RecordingManager::with_backend(store.clone(), Arc::new(FakeBackend), false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "start-source-toggle".to_string(),
                selection: CaptureSelection {
                    microphone: true,
                    system: false,
                },
            })
            .await
            .unwrap();

        let updated_record = store
            .update_audio_metadata(crate::record::AudioRecordMetadataUpdateInput {
                id: started.snapshot.record_id.clone(),
                expected_revision: started.snapshot.revision,
                title: "Renamed while recording".to_string(),
                tags: vec!["meeting".to_string()],
            })
            .await
            .unwrap();

        let disabled = manager
            .set_source_enabled(RecordingSourceCommandInput {
                record_id: started.snapshot.record_id.clone(),
                operation_id: "disable-microphone".to_string(),
                track: AudioTrackKind::Microphone,
                enabled: false,
            })
            .await
            .unwrap();
        assert_eq!(disabled.generation, started.snapshot.generation);
        assert_eq!(disabled.source_activity.len(), 1);
        assert!(!disabled.source_activity[0].enabled);
        assert_eq!(disabled.source_activity[0].level_percent, 0);

        let enabled = manager
            .set_source_enabled(RecordingSourceCommandInput {
                record_id: disabled.record_id.clone(),
                operation_id: "enable-microphone".to_string(),
                track: AudioTrackKind::Microphone,
                enabled: true,
            })
            .await
            .unwrap();
        assert_eq!(enabled.generation, started.snapshot.generation);
        assert!(enabled.source_activity[0].enabled);

        let stopped = manager
            .stop(RecordingCommandInput {
                record_id: enabled.record_id,
                expected_revision: updated_record.revision,
                operation_id: "stop-source-toggle".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(stopped.capture_status, CaptureStatus::Ready);
    }

    #[tokio::test]
    async fn stopping_while_paused_commits_ready_audio_artifacts() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let manager = RecordingManager::with_backend(store.clone(), Arc::new(FakeBackend), false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "start-paused-stop".to_string(),
                selection: CaptureSelection::default(),
            })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(35)).await;
        let paused = manager
            .pause(RecordingCommandInput {
                record_id: started.snapshot.record_id,
                expected_revision: started.snapshot.revision,
                operation_id: "pause-before-stop".to_string(),
            })
            .await
            .unwrap();

        // Paused capture remains slot-owned; a confirmed update must not
        // mistake lack of advancing media time for completion.
        assert_eq!(
            manager.snapshot().await.unwrap().capture_status,
            CaptureStatus::Paused
        );

        let stopped = manager
            .stop(RecordingCommandInput {
                record_id: paused.record_id,
                expected_revision: paused.revision,
                operation_id: "stop-while-paused".to_string(),
            })
            .await
            .unwrap();

        assert_eq!(stopped.capture_status, CaptureStatus::Ready);
        let record = store.get(&stopped.record_id).await.unwrap();
        assert_eq!(
            record.audio.as_ref().unwrap().capture_status,
            CaptureStatus::Ready
        );
        assert_audio_artifacts(&record, 2);
    }

    #[tokio::test]
    async fn transient_device_failure_reopens_same_generation_without_counting_gap() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let backend = Arc::new(RecoveringBackend::new(1));
        let manager = RecordingManager::with_backend(store.clone(), backend.clone(), false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "start-recover".to_string(),
                selection: CaptureSelection {
                    microphone: true,
                    system: true,
                },
            })
            .await
            .unwrap();
        let workspace = store
            .audio_workspace_path(&started.snapshot.record_id)
            .await
            .unwrap();

        let recovered_entries = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let entries =
                    LifecycleJournal::read_entries(&workspace, &started.snapshot.record_id)
                        .unwrap();
                if entries.iter().any(|entry| {
                    matches!(
                        &entry.event,
                        LifecycleEvent::RecoveryCommitted { reason, .. }
                            if reason == "device_reopened"
                    )
                }) {
                    break entries;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("capture should recover within the bounded attempts");
        assert_eq!(backend.open_count(), 3);

        let gap_media_ms = recovered_entries
            .iter()
            .find_map(|entry| {
                matches!(&entry.event, LifecycleEvent::DeviceGap { .. }).then_some(entry.media_ms)
            })
            .unwrap();
        let recovery_media_ms = recovered_entries
            .iter()
            .find_map(|entry| {
                matches!(
                    &entry.event,
                    LifecycleEvent::RecoveryCommitted { reason, .. }
                        if reason == "device_reopened"
                )
                .then_some(entry.media_ms)
            })
            .unwrap();
        assert_eq!(recovery_media_ms, gap_media_ms);
        let repaired_tracks = recovered_entries
            .iter()
            .find_map(|entry| match &entry.event {
                LifecycleEvent::RecoveryCommitted {
                    repaired_tracks,
                    reason,
                } if reason == "device_reopened" => Some(repaired_tracks.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(repaired_tracks, vec!["microphone", "system"]);

        tokio::time::sleep(Duration::from_millis(30)).await;
        let active = manager.snapshot().await.unwrap();
        assert_eq!(active.generation, started.snapshot.generation);
        assert_eq!(active.capture_status, CaptureStatus::Recording);
        let stopped = manager
            .stop(RecordingCommandInput {
                record_id: active.record_id,
                expected_revision: active.revision,
                operation_id: "stop-recovered".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(stopped.capture_status, CaptureStatus::Ready);
        let record = store.get(&stopped.record_id).await.unwrap();
        assert_audio_artifacts(&record, 2);
    }

    #[tokio::test]
    async fn recovery_gap_commit_failure_interrupts_without_reopening_devices() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let backend = Arc::new(RecoveringBackend::new(0));
        let manager = RecordingManager::with_backend(store.clone(), backend.clone(), false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "start-gap-commit-failure".to_string(),
                selection: CaptureSelection {
                    microphone: true,
                    system: false,
                },
            })
            .await
            .unwrap();
        let workspace = store
            .audio_workspace_path(&started.snapshot.record_id)
            .await
            .unwrap();
        let journal_path = workspace.join("lifecycle.jsonl");
        let original_permissions = fs::metadata(&journal_path).unwrap().permissions();
        let mut read_only_permissions = original_permissions.clone();
        read_only_permissions.set_readonly(true);
        fs::set_permissions(&journal_path, read_only_permissions).unwrap();

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let interrupted = store
                    .get(&started.snapshot.record_id)
                    .await
                    .and_then(|record| record.audio)
                    .is_some_and(|audio| audio.capture_status == CaptureStatus::Interrupted);
                if interrupted && manager.snapshot().await.is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("journal failure should interrupt and release the capture slot");

        assert_eq!(backend.open_count(), 1);
        let record = store.get(&started.snapshot.record_id).await.unwrap();
        assert_eq!(
            record.audio.as_ref().unwrap().capture_status,
            CaptureStatus::Interrupted
        );
        assert_audio_artifacts(&record, 1);

        fs::set_permissions(&journal_path, original_permissions).unwrap();
        let entries = LifecycleJournal::read_entries(&workspace, &record.id).unwrap();
        assert!(!entries.iter().any(|entry| matches!(
            &entry.event,
            LifecycleEvent::DeviceGap { .. } | LifecycleEvent::RecoveryCommitted { .. }
        )));
    }

    #[tokio::test]
    async fn live_boundary_failure_keeps_analysis_closed_after_recovery() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let backend = Arc::new(RecoveringBackend::new(0));
        let manager = RecordingManager::with_backend(store.clone(), backend, false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "start-live-boundary-failure".to_string(),
                selection: CaptureSelection {
                    microphone: true,
                    system: false,
                },
            })
            .await
            .unwrap();
        let workspace = store
            .audio_workspace_path(&started.snapshot.record_id)
            .await
            .unwrap();
        let analysis = TrackAnalysisHandle::start(
            AudioTrackKind::Microphone,
            workspace.join(analysis_spool_relative_path(AudioTrackKind::Microphone).unwrap()),
            super::super::audio::SourceFormat {
                sample_rate: 48_000,
                channels: 1,
            },
        )
        .unwrap();
        {
            let mut state = manager.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                panic!("recording should be live");
            };
            active.analyses.push(analysis);
            active.live_transcription = true;
            active.live_analysis_enabled = true;
        }

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let state = manager.state.lock().await;
                if let Some(RecordingSlot::Live(active)) = state.slot.as_ref() {
                    if active.session.is_some() && !active.live_analysis_enabled {
                        assert_eq!(active.analyses[0].sink.push_f32(&[0.5; 480]), 0);
                        return;
                    }
                }
                drop(state);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("failed live boundary should degrade analysis without losing archive capture");

        let active = manager.snapshot().await.unwrap();
        let stopped = manager
            .stop(RecordingCommandInput {
                record_id: active.record_id,
                expected_revision: active.revision,
                operation_id: "stop-live-boundary-failure".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(stopped.capture_status, CaptureStatus::Ready);
        let record = store.get(&stopped.record_id).await.unwrap();
        assert_audio_artifacts(&record, 1);
    }

    #[tokio::test]
    async fn paused_capture_recovers_without_advancing_media_time() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let backend = Arc::new(RecoveringBackend::new(0));
        let manager = RecordingManager::with_backend(store, backend.clone(), false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "start-paused-recovery".to_string(),
                selection: CaptureSelection {
                    microphone: true,
                    system: false,
                },
            })
            .await
            .unwrap();
        let paused = manager
            .pause(RecordingCommandInput {
                record_id: started.snapshot.record_id,
                expected_revision: started.snapshot.revision,
                operation_id: "pause-before-recovery".to_string(),
            })
            .await
            .unwrap();
        let frozen_media_ms = paused.media_duration_ms;

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let snapshot = manager.snapshot().await.unwrap();
                if snapshot.capture_status == CaptureStatus::Paused && backend.open_count() >= 2 {
                    let state = manager.state.lock().await;
                    if matches!(
                        state.slot.as_ref(),
                        Some(RecordingSlot::Live(active)) if active.session.is_some()
                    ) {
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("paused capture should reopen in the paused state");
        tokio::time::sleep(Duration::from_millis(30)).await;
        let recovered = manager.snapshot().await.unwrap();
        assert_eq!(recovered.capture_status, CaptureStatus::Paused);
        assert_eq!(recovered.media_duration_ms, frozen_media_ms);

        let resumed = manager
            .resume(RecordingCommandInput {
                record_id: recovered.record_id,
                expected_revision: recovered.revision,
                operation_id: "resume-after-recovery".to_string(),
            })
            .await
            .unwrap();
        let stopped = manager
            .stop(RecordingCommandInput {
                record_id: resumed.record_id,
                expected_revision: resumed.revision,
                operation_id: "stop-paused-recovery".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(stopped.capture_status, CaptureStatus::Ready);
    }

    #[tokio::test]
    async fn settlement_error_releases_only_the_matching_generation() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let manager = RecordingManager::with_backend(store, Arc::new(FakeBackend), false);
        let snapshot = RecordingSnapshot {
            record_id: "failed-settlement".to_string(),
            revision: 1,
            generation: 7,
            capture_status: CaptureStatus::Finalizing,
            started_at_wall_time: 1,
            media_duration_ms: 10,
            paused_wall_ms: 0,
            sources: Vec::new(),
            source_activity: Vec::new(),
            warnings: Vec::new(),
        };
        manager.state.lock().await.slot = Some(RecordingSlot::Settling(snapshot));

        assert_eq!(
            manager.snapshot().await.unwrap().capture_status,
            CaptureStatus::Finalizing
        );

        manager
            .release_failed_settlement(7, "failed-settlement", "injected failure")
            .await;

        assert!(manager.snapshot().await.is_none());
    }

    #[tokio::test]
    async fn exhausted_device_recovery_safely_interrupts_and_releases_slot() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let backend = Arc::new(RecoveringBackend::new(usize::MAX));
        let manager = RecordingManager::with_backend(store.clone(), backend.clone(), false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "start-unrecoverable".to_string(),
                selection: CaptureSelection {
                    microphone: true,
                    system: false,
                },
            })
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let interrupted = store
                    .get(&started.snapshot.record_id)
                    .await
                    .and_then(|record| record.audio)
                    .is_some_and(|audio| audio.capture_status == CaptureStatus::Interrupted);
                if interrupted && manager.snapshot().await.is_none() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("failed recovery should release the global slot");
        assert_eq!(backend.open_count(), 1 + CAPTURE_RECOVERY_ATTEMPTS);
        assert!(manager.snapshot().await.is_none());

        let record = store.get(&started.snapshot.record_id).await.unwrap();
        assert_eq!(
            record.audio.as_ref().unwrap().capture_status,
            CaptureStatus::Interrupted
        );
        assert_audio_artifacts(&record, 1);
        let workspace = store.audio_workspace_path(&record.id).await.unwrap();
        let entries = LifecycleJournal::read_entries(&workspace, &record.id).unwrap();
        assert!(entries
            .iter()
            .any(|entry| matches!(&entry.event, LifecycleEvent::DeviceGap { .. })));
        assert!(!entries.iter().any(|entry| {
            matches!(
                &entry.event,
                LifecycleEvent::RecoveryCommitted { reason, .. }
                    if reason == "device_reopened"
            )
        }));
    }

    #[tokio::test]
    async fn exact_revision_and_operation_kind_are_enforced() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let manager = RecordingManager::with_backend(store, Arc::new(FakeBackend), false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "same-op".to_string(),
                selection: CaptureSelection {
                    microphone: true,
                    system: false,
                },
            })
            .await
            .unwrap();
        let wrong_kind = manager
            .pause(RecordingCommandInput {
                record_id: started.snapshot.record_id.clone(),
                expected_revision: started.snapshot.revision,
                operation_id: "same-op".to_string(),
            })
            .await
            .unwrap_err();
        assert_eq!(wrong_kind, "RECORDING_OPERATION_ID_REUSED");
        let stale = manager
            .pause(RecordingCommandInput {
                record_id: started.snapshot.record_id,
                expected_revision: 1,
                operation_id: "pause-stale".to_string(),
            })
            .await
            .unwrap_err();
        assert!(stale.starts_with("RECORDING_REVISION_CONFLICT"));
    }

    #[tokio::test]
    async fn startup_recovery_never_reopens_devices_and_commits_available_audio() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let record = store
            .create_audio(AudioRecordCreateInput {
                title: "recover me".to_string(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Unavailable,
            })
            .await
            .unwrap();
        let workspace = store.audio_workspace_path(&record.id).await.unwrap();
        let archive = TrackArchiveHandle::start(
            AudioTrackKind::Microphone,
            workspace.join(audio_track_relative_path(AudioTrackKind::Microphone)),
            super::super::audio::SourceFormat {
                sample_rate: 48_000,
                channels: 1,
            },
        )
        .unwrap();
        archive.sink.push_f32(&vec![0.04; 96_000]);
        archive.finish().unwrap();
        let analysis_spool = workspace.join("analysis/microphone.pcm16");
        std::fs::write(&analysis_spool, b"private-crash-spool").unwrap();
        store
            .update_audio_capture(&record.id, CaptureStatus::Recording, 2_000, None)
            .await
            .unwrap();

        let manager = RecordingManager::with_backend(store.clone(), Arc::new(FakeBackend), false);
        manager.recover_interrupted().await;
        assert!(manager.snapshot().await.is_none());
        let recovered = store.get(&record.id).await.unwrap();
        assert_eq!(
            recovered.audio.as_ref().unwrap().capture_status,
            CaptureStatus::Interrupted
        );
        assert_audio_artifacts(&recovered, 1);
        assert!(recovered.audio.as_ref().unwrap().media_duration_ms >= 2_000);
        assert!(!analysis_spool.exists());
        assert_eq!(
            recovered.audio.as_ref().unwrap().transcription_status,
            TranscriptionStatus::Unavailable,
            "a historical recording without a live journal is never auto-submitted"
        );

        let accepted = store
            .create_audio(AudioRecordCreateInput {
                title: "recover accepted live transcription".to_string(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::NotStarted,
            })
            .await
            .unwrap();
        let accepted_workspace = store.audio_workspace_path(&accepted.id).await.unwrap();
        drop(
            store
                .begin_live_transcript(
                    &accepted.id,
                    crate::record::RecordSpeechProvenance {
                        algorithm_revision: None,
                        provider: "local".into(),
                        model_pack_revision: "fixture-pack".into(),
                        onnx_runtime_version: "1.28.0".into(),
                    },
                )
                .await
                .unwrap(),
        );
        let accepted_archive = TrackArchiveHandle::start(
            AudioTrackKind::Microphone,
            accepted_workspace.join(audio_track_relative_path(AudioTrackKind::Microphone)),
            super::super::audio::SourceFormat {
                sample_rate: 48_000,
                channels: 1,
            },
        )
        .unwrap();
        accepted_archive.sink.push_f32(&vec![0.04; 48_000]);
        accepted_archive.finish().unwrap();
        let accepted_spool = accepted_workspace.join("analysis/microphone.pcm16");
        std::fs::write(&accepted_spool, b"accepted-private-crash-spool").unwrap();
        store
            .update_audio_capture(&accepted.id, CaptureStatus::Recording, 1_000, None)
            .await
            .unwrap();
        manager.recover_interrupted().await;
        let accepted = store.get(&accepted.id).await.unwrap();
        assert_eq!(
            accepted.audio.as_ref().unwrap().transcription_status,
            TranscriptionStatus::Recovering,
            "the durable live journal is the exact auto-recovery admission marker"
        );
        assert!(!accepted_spool.exists());

        let empty = store
            .create_audio(AudioRecordCreateInput {
                title: "never opened".to_string(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Unavailable,
            })
            .await
            .unwrap();
        manager.recover_interrupted().await;
        let empty = store.get(&empty.id).await.unwrap();
        assert_eq!(
            empty.audio.as_ref().unwrap().capture_status,
            CaptureStatus::Failed
        );
        assert!(empty.artifacts.is_empty());
    }
}
