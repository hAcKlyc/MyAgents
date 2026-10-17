//! App-owned speech workload metadata, recovery, and scheduling authority.
//!
//! The media Worker owns one exact generation's decode/inference state. This
//! module owns durable job identity and decides whether a Worker result may
//! become an Agent artifact or a Record projection.

use crate::local_inference::{
    ComputeWorkloadIdentity, ComputeWorkloadKind, InferenceRuntimeKind, LocalComputeCoordinator,
    LocalComputeLease, LocalComputeYieldSignal, LocalInferenceRuntimeRegistry,
};
use crate::process_cmd;
use crate::record::{
    AudioTrackKind, DiarizationStatus, ManagedRecordStore, RecordKind, RecordLiveTranscriptJournal,
    RecordSpeakerTurn, RecordSpeechBaseline, RecordSpeechProvenance, RecordTranscriptSegment,
    RecordTranscriptTrackOffset, TranscriptionStatus,
};
use crate::record_analytics::{
    self, AnalyticsMediaKind, AnalyticsOutcome, AnalyticsSource, RecordAnalyticsMilestone,
    SpeechAttachmentOperation, SpeechProcessingStage, SpeechResourceOperation,
};
use crate::recording::analysis::{cleanup_analysis_spool, AnalysisSpoolSource};
use crate::speech_model_pack_manager::{SpeechModelPackManager, SpeechModelPackStatus};
use crate::workspace_files::path_safety::{
    ensure_workspace_directory_no_follow, open_workspace_regular_file_no_follow,
    validate_workspace_root,
};
use chrono::{DateTime, Duration, Utc};
use myagents_media_worker_protocol::record_identity::{PersonMatchEvidence, MAX_IDENTITY_PEOPLE};
use myagents_media_worker_protocol::{
    read_worker_response, write_control_frame, write_pcm_frame, Checkpoint, PcmFrame, PcmStreamEnd,
    PcmStreamStart, RecordArtifactInput, SpeakerTurn, StartRequest, TrackKind, WorkerCommand,
    WorkerMetrics, WorkerResponse, WorkerStage, WorkloadIdentity, WorkloadInput, WorkloadKind,
    MAX_MEDIA_SAMPLES_PER_TRACK, MAX_PCM_SAMPLES_PER_FRAME, PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdout, Stdio};
use std::sync::{mpsc as std_mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration as StdDuration, Instant};
use tokio::sync::Notify;
use uuid::Uuid;
use zeroize::Zeroize;

mod record_processing;
use record_processing::{RecordAsrCandidate, RecordProcessingInput};

const JOB_SCHEMA_VERSION: u32 = 1;
const MAX_JOB_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_WORKER_ATTEMPTS: u32 = 3;
const MAX_WORKER_STDERR_BYTES: u64 = 64 * 1024;
const MAX_PENDING_JOBS: usize = 256;
const MAX_AGENT_SOURCE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const AGENT_OUTPUT_DIRECTORY: &str = "myagents_files/speech-transcriptions";
const AGENT_STAGING_MARKER: &str = ".myagents-speech-owner";
const AGENT_PRIVATE_STAGING_TOKEN: &str = ".staging-token";
const AGENT_PUBLISH_INTENT: &str = "publish-intent.json";
const YIELD_GRACE_SECONDS: u64 = 15;
const WORKER_TERMINAL_GRACE: StdDuration = StdDuration::from_secs(30);
const WORKER_CANCEL_GRACE: StdDuration = StdDuration::from_secs(15);
const WORKER_SHUTDOWN_GRACE: StdDuration = StdDuration::from_secs(10);
const LIVE_PAUSE_WARM_GRACE: StdDuration = StdDuration::from_secs(10 * 60);
const MAX_TRANSCRIPT_SEGMENTS: usize = 100_000;
const MAX_TRANSCRIPT_CHARACTERS: usize = 5_000_000;
const MAX_DIARIZATION_TURNS: usize = 200_000;
const LIVE_WORKER_RESPONSE_TIMEOUT: StdDuration = StdDuration::from_secs(120);
const BATCH_WORKER_RESPONSE_TIMEOUT: StdDuration = StdDuration::from_secs(120);
const ATTACHMENT_PROBE_TIMEOUT: StdDuration = StdDuration::from_secs(5);
const MIN_AGENT_DEADLINE: StdDuration = StdDuration::from_secs(30 * 60);
const MAX_AGENT_DEADLINE: StdDuration = StdDuration::from_secs(16 * 60 * 60);
const LIVE_POLL_INTERVAL: StdDuration = StdDuration::from_millis(100);
pub const SPEECH_HISTORY_RETENTION_DAYS: i64 = 30;

pub type ManagedSpeechRecognition = Arc<SpeechRecognitionManager>;

static SPEECH_RECOGNITION: OnceLock<ManagedSpeechRecognition> = OnceLock::new();

pub fn set_global(manager: ManagedSpeechRecognition) -> Result<(), String> {
    SPEECH_RECOGNITION
        .set(manager)
        .map_err(|_| "SpeechRecognitionManager already initialized".to_string())
}

pub fn global() -> Option<&'static ManagedSpeechRecognition> {
    SPEECH_RECOGNITION.get()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechJobState {
    Queued,
    Running,
    Cancelling,
    Succeeded,
    SucceededWithWarnings,
    Failed,
    Cancelled,
    Interrupted,
}

impl SpeechJobState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded
                | Self::SucceededWithWarnings
                | Self::Failed
                | Self::Cancelled
                | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechJobKind {
    AgentAttachmentAsr,
    RecordBackfillAsr,
    RecordDiarization,
}

impl SpeechJobKind {
    fn is_agent(self) -> bool {
        matches!(self, Self::AgentAttachmentAsr)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechJobStage {
    Validating,
    Copying,
    Decoding,
    Transcribing,
    Diarizing,
    Publishing,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SpeechJobOrigin {
    Agent {
        initiator_session_id: String,
        workspace_identity: String,
    },
    Record {
        record_id: String,
    },
}

impl std::fmt::Debug for SpeechJobOrigin {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Agent { .. } => formatter.write_str("SpeechJobOrigin::Agent([REDACTED])"),
            Self::Record { record_id } => formatter
                .debug_struct("SpeechJobOrigin::Record")
                .field("record_id", record_id)
                .finish(),
        }
    }
}

impl SpeechJobOrigin {
    fn agent_session_id(&self) -> Option<&str> {
        match self {
            Self::Agent {
                initiator_session_id,
                ..
            } => Some(initiator_session_id),
            Self::Record { .. } => None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJobSource {
    pub path: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_default_track: Option<bool>,
}

impl std::fmt::Debug for SpeechJobSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SpeechJobSource")
            .field("path", &"[REDACTED]")
            .field("size_bytes", &self.size_bytes)
            .field("has_sha256", &self.sha256.is_some())
            .field("media_kind", &self.media_kind)
            .field("codec", &self.codec)
            .field("duration_ms", &self.duration_ms)
            .field("used_default_track", &self.used_default_track)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJobOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_markdown_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_json_path: Option<String>,
    pub artifact_available: bool,
}

impl std::fmt::Debug for SpeechJobOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SpeechJobOutput")
            .field("paths", &"[REDACTED]")
            .field("artifact_available", &self.artifact_available)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJobError {
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJobMetrics {
    pub source_samples: u64,
    pub segments: u32,
    pub speakers: u32,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_working_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechPipelineSnapshot {
    pub provider: String,
    pub model_pack_revision: String,
    pub onnx_runtime_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithm_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechCandidateReference {
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJob {
    pub schema_version: u32,
    pub job_id: String,
    pub kind: SpeechJobKind,
    pub state: SpeechJobState,
    pub stage: SpeechJobStage,
    pub origin: SpeechJobOrigin,
    pub source: SpeechJobSource,
    pub output: SpeechJobOutput,
    pub pipeline: SpeechPipelineSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_baseline: Option<SpeechCandidateReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_asr_candidate: Option<SpeechCandidateReference>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_generation: Option<u64>,
    #[serde(default)]
    pub worker_attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SpeechJobError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<SpeechJobMetrics>,
}

/// Read-only Record detail projection; the durable speech job remains the
/// authority, so Record manifests do not acquire a second copy of job errors.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordTranscriptionFailure {
    pub code: String,
    pub retryable: bool,
    pub stage: SpeechJobStage,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechResourceStatus {
    NotInstalled,
    NativeUnavailable,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCapabilitySnapshot {
    pub resource_status: SpeechResourceStatus,
    pub model_pack_revision: Option<String>,
    pub onnx_runtime_version: Option<String>,
}

struct ManagerState {
    accepting: bool,
    jobs: HashMap<String, SpeechJob>,
    queue: VecDeque<String>,
    agent_admission_reservations: usize,
    pending_agent: HashMap<String, PendingAgentJob>,
    active_job: Option<(String, u64)>,
    running: Option<RunningWorker>,
    live_sessions: HashMap<String, LiveSessionRegistration>,
    live_running: Option<RunningWorker>,
    next_generation: u64,
}

struct PendingAgentJob {
    source: same_file::Handle,
    source_version: AgentSourceVersion,
    prepared_source: Option<(PathBuf, String)>,
    private_dir: PathBuf,
    private_identity: same_file::Handle,
    staging_dir: PathBuf,
    staging_identity: same_file::Handle,
    staging_token: String,
    output_root_identity: same_file::Handle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPublishIntent {
    schema_version: u32,
    job_id: String,
    staging_directory: String,
    destination_directory: String,
    staging_token: String,
}

impl Drop for PendingAgentJob {
    fn drop(&mut self) {
        cleanup_pending_agent(self);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentSourceVersion {
    len: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
    #[cfg(unix)]
    ctime: i64,
    #[cfg(unix)]
    ctime_nsec: i64,
    #[cfg(windows)]
    last_write_time: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentMediaProbe {
    media_kind: String,
    codec: String,
    duration_ms: Option<u64>,
    used_default_track: bool,
}

struct AgentAdmissionReservation {
    manager: ManagedSpeechRecognition,
    active: bool,
}

impl AgentAdmissionReservation {
    fn release_locked(&mut self, state: &mut ManagerState) {
        if self.active {
            state.agent_admission_reservations =
                state.agent_admission_reservations.saturating_sub(1);
            self.active = false;
        }
    }
}

impl Drop for AgentAdmissionReservation {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut state) = self.manager.state.lock() {
            state.agent_admission_reservations =
                state.agent_admission_reservations.saturating_sub(1);
        }
    }
}

struct LiveSessionRegistration {
    control: Arc<LiveControl>,
    tracks: Vec<AudioTrackKind>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LiveBoundary {
    offsets: Vec<RecordTranscriptTrackOffset>,
}

#[derive(Default)]
struct LiveControlState {
    flushes: VecDeque<LiveBoundary>,
    /// Exact boundary acknowledged after VAD flush, not a transport ACK or
    /// replay checkpoint. Survives unloading this live Worker's models.
    flushed: Option<LiveBoundary>,
    finish: Option<LiveBoundary>,
    cancelled: bool,
    paused: bool,
    pause_epoch: u64,
    pause_timer: Option<tauri::async_runtime::JoinHandle<()>>,
    suspend_requested: bool,
    /// Accepted Worker replay frontiers in Record media coordinates. These
    /// survive Worker attempts, not the capture lifecycle or an App restart.
    replay_floors: Vec<RecordTranscriptTrackOffset>,
}

#[derive(Default)]
struct LiveControl {
    state: Mutex<LiveControlState>,
}

impl LiveControl {
    fn publication_offsets(
        &self,
        mut committed: Vec<RecordTranscriptTrackOffset>,
    ) -> Result<Vec<RecordTranscriptTrackOffset>, &'static str> {
        let state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        for offset in &mut committed {
            if let Some(floor) = state
                .replay_floors
                .iter()
                .find(|floor| floor.track == offset.track)
            {
                offset.sample = offset.sample.max(floor.sample);
            }
        }
        Ok(committed)
    }

    fn observe_replay_checkpoint(
        &self,
        checkpoint: &Checkpoint,
        allowed: &[RecordTranscriptTrackOffset],
    ) -> Result<(), &'static str> {
        if checkpoint.streams.len() != allowed.len() {
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        }
        let mut offsets = Vec::with_capacity(allowed.len());
        for expected in allowed {
            let track = protocol_track(expected.track)?;
            let sample = checkpoint
                .streams
                .iter()
                .find(|stream| stream.track == track)
                .and_then(|stream| stream.replay_record_sample)
                .ok_or("SPEECH_WORKER_PROTOCOL_ERROR")?;
            offsets.push(RecordTranscriptTrackOffset {
                track: expected.track,
                sample,
            });
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        for offset in offsets {
            if let Some(current) = state
                .replay_floors
                .iter_mut()
                .find(|current| current.track == offset.track)
            {
                current.sample = current.sample.max(offset.sample);
            } else {
                state.replay_floors.push(offset);
            }
        }
        Ok(())
    }

    fn snapshot(&self) -> Result<LiveControlStateSnapshot, &'static str> {
        let state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        Ok(LiveControlStateSnapshot {
            flush: state.flushes.front().cloned(),
            finish: state.finish.clone(),
            cancelled: state.cancelled,
            paused: state.paused,
            suspend_requested: state.suspend_requested,
            finish_is_flushed: state.finish.is_some()
                && state.finish == state.flushed
                && state.flushes.is_empty(),
        })
    }

    fn complete_flush(&self, boundary: &LiveBoundary) {
        if let Ok(mut state) = self.state.lock() {
            if state.flushes.front() == Some(boundary) {
                state.flushes.pop_front();
                state.flushed = Some(boundary.clone());
            }
        }
    }

    fn send_yield_if_suspended(
        &self,
        stdin: &Arc<Mutex<std::process::ChildStdin>>,
        identity: &WorkloadIdentity,
    ) -> Result<bool, ()> {
        let state = self.state.lock().map_err(|_| ())?;
        if !state.paused
            || !state.suspend_requested
            || !state.flushes.is_empty()
            || state.finish.is_some()
            || state.cancelled
        {
            return Ok(false);
        }
        send_worker_command(
            stdin,
            &WorkerCommand::Yield {
                protocol_version: PROTOCOL_VERSION,
                identity: identity.clone(),
            },
        )?;
        Ok(true)
    }
}

struct LiveControlStateSnapshot {
    flush: Option<LiveBoundary>,
    finish: Option<LiveBoundary>,
    cancelled: bool,
    paused: bool,
    suspend_requested: bool,
    finish_is_flushed: bool,
}

fn validate_live_admission(state: &ManagerState, record_id: &str) -> Result<(), &'static str> {
    if state.live_sessions.contains_key(record_id) {
        return Err("SPEECH_RECORD_LIVE_ALREADY_ACTIVE");
    }
    // Capture admission and inference settlement have different lifetimes.
    // Finished recordings may still drain under the shared compute lease.
    for session in state.live_sessions.values() {
        let control = session.control.snapshot()?;
        if control.finish.is_none() && !control.cancelled {
            return Err("SPEECH_RECORD_LIVE_ALREADY_ACTIVE");
        }
    }
    Ok(())
}

struct RunningWorker {
    job_id: String,
    generation: u64,
    child: Arc<Mutex<process_cmd::ChildTree>>,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
}

type SpawnedWorker = (
    Arc<Mutex<process_cmd::ChildTree>>,
    Arc<Mutex<std::process::ChildStdin>>,
    ChildStdout,
);

#[derive(Clone)]
struct SpeechExecutionResources {
    worker_path: PathBuf,
    native_manifest_path: PathBuf,
    onnx_runtime_path: PathBuf,
    model_pack_manifest_path: PathBuf,
    provenance: RecordSpeechProvenance,
}

#[derive(Default)]
struct SensitiveTranscriptSegments(Vec<RecordTranscriptSegment>);

impl Drop for SensitiveTranscriptSegments {
    fn drop(&mut self) {
        for segment in &mut self.0 {
            segment.text.zeroize();
            if let Some(language) = &mut segment.language {
                language.zeroize();
            }
        }
    }
}

struct SpeechWorkerCompletion {
    transcripts: SensitiveTranscriptSegments,
    turns: Vec<RecordSpeakerTurn>,
    identity_evidence: Vec<PersonMatchEvidence>,
    metrics: WorkerMetrics,
}

enum SpeechWorkerOutcome {
    Completed(SpeechWorkerCompletion),
    Yielded,
    Failed {
        code: String,
        retryable: bool,
        terminal_received: bool,
    },
}

impl SpeechWorkerOutcome {
    fn settlement_grace(&self) -> StdDuration {
        match self {
            Self::Completed(_)
            | Self::Failed {
                terminal_received: true,
                ..
            } => WORKER_TERMINAL_GRACE,
            Self::Yielded | Self::Failed { .. } => WORKER_CANCEL_GRACE,
        }
    }

    fn needs_cancel(&self) -> bool {
        matches!(
            self,
            Self::Failed {
                terminal_received: false,
                ..
            }
        )
    }
}

struct BatchYieldState {
    sent: Arc<std::sync::atomic::AtomicBool>,
    settled: Arc<std::sync::atomic::AtomicBool>,
}

impl BatchYieldState {
    fn new() -> Self {
        Self {
            sent: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            settled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    fn finish_reading(&self) {
        if !self.sent.load(std::sync::atomic::Ordering::Acquire) {
            self.mark_settled();
        }
    }

    fn mark_settled(&self) {
        self.settled
            .store(true, std::sync::atomic::Ordering::Release);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum LiveAttemptOutcome {
    Finished,
    Suspended,
    Cancelled,
    Failed { code: String, retryable: bool },
}

struct LiveTrackCursor {
    source: AnalysisSpoolSource,
    track: TrackKind,
    generation_start: u64,
    position: u64,
    next_sequence: u64,
    last_sequence: Option<u64>,
    replay_record_start: u64,
    publish_from_record_sample: u64,
}

pub struct SpeechRecognitionManager {
    root: PathBuf,
    native_manifest_path: PathBuf,
    worker_path: PathBuf,
    model_pack: Arc<SpeechModelPackManager>,
    runtime_registry: Arc<LocalInferenceRuntimeRegistry>,
    compute_coordinator: Arc<LocalComputeCoordinator>,
    record_store: ManagedRecordStore,
    state: Mutex<ManagerState>,
    wake: Notify,
}

impl SpeechRecognitionManager {
    pub fn record_transcription_failure(
        &self,
        record_id: &str,
    ) -> Option<RecordTranscriptionFailure> {
        let state = self.state.lock().ok()?;
        let latest = state.jobs.values()
            .filter(|job| job.kind == SpeechJobKind::RecordBackfillAsr
                && matches!(&job.origin, SpeechJobOrigin::Record { record_id: id } if id == record_id))
            .max_by(|a, b| (a.created_at, &a.job_id).cmp(&(b.created_at, &b.job_id)))?;
        if !matches!(
            latest.state,
            SpeechJobState::Failed | SpeechJobState::Interrupted
        ) {
            return None;
        }
        let error = latest.error.as_ref()?;
        if !error.code.starts_with("SPEECH_")
            || error.code.len() > 128
            || !error
                .code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return None;
        }
        Some(RecordTranscriptionFailure {
            code: error.code.clone(),
            retryable: error.retryable,
            stage: latest.stage,
        })
    }

    pub fn initialize(
        data_root: PathBuf,
        resource_root: PathBuf,
        runtime_registry: Arc<LocalInferenceRuntimeRegistry>,
        compute_coordinator: Arc<LocalComputeCoordinator>,
        record_store: ManagedRecordStore,
    ) -> Result<ManagedSpeechRecognition, String> {
        Self::initialize_inner(
            data_root,
            resource_root,
            runtime_registry,
            compute_coordinator,
            record_store,
            true,
        )
    }

    fn initialize_inner(
        data_root: PathBuf,
        resource_root: PathBuf,
        runtime_registry: Arc<LocalInferenceRuntimeRegistry>,
        compute_coordinator: Arc<LocalComputeCoordinator>,
        record_store: ManagedRecordStore,
        start_runner: bool,
    ) -> Result<ManagedSpeechRecognition, String> {
        let root = data_root.join("speech-recognition");
        for directory in [
            root.clone(),
            root.join("jobs"),
            root.join("private"),
            root.join("models"),
        ] {
            ensure_private_directory(&directory)?;
        }

        let native_root = resource_root.join("speech-inference").join("v1");
        let worker_name = if cfg!(windows) {
            "myagents-media-worker.exe"
        } else {
            "myagents-media-worker"
        };
        let runtime_identity = runtime_registry
            .identity(InferenceRuntimeKind::OnnxCpu)
            .ok();
        let native_manifest_path = native_root.join("manifest.json");
        let worker_path = native_root.join(worker_name);
        let model_pack = SpeechModelPackManager::initialize(
            root.join("models"),
            worker_path.clone(),
            native_manifest_path.clone(),
            runtime_identity
                .as_ref()
                .map(|identity| identity.path().to_path_buf()),
            compute_coordinator.clone(),
        )?;
        let mut jobs = load_jobs(&root)?;
        recover_agent_publish_intents(&root, &mut jobs);
        recover_nonterminal_jobs(&root, &mut jobs);
        prune_expired_jobs(&root, &mut jobs);
        let queue = recovered_record_queue(&jobs);

        let manager = Arc::new(Self {
            root: root.clone(),
            native_manifest_path,
            worker_path,
            model_pack,
            runtime_registry,
            compute_coordinator,
            record_store,
            state: Mutex::new(ManagerState {
                accepting: true,
                jobs,
                queue,
                agent_admission_reservations: 0,
                pending_agent: HashMap::new(),
                active_job: None,
                running: None,
                live_sessions: HashMap::new(),
                live_running: None,
                next_generation: 1,
            }),
            wake: Notify::new(),
        });
        if start_runner {
            let runner = Arc::clone(&manager);
            tauri::async_runtime::spawn(async move { runner.run_queue().await });
            if !manager.queue_snapshot()?.is_empty() {
                manager.wake.notify_one();
            }
        }
        Ok(manager)
    }

    pub(crate) fn start_background_resource_validation(self: &Arc<Self>) {
        self.model_pack.start_background_maintenance();
    }

    pub fn capability_snapshot(&self) -> SpeechCapabilitySnapshot {
        let native_ready = plain_file(&self.worker_path) && plain_file(&self.native_manifest_path);
        let model_pack_revision = self.model_pack.active_pack().map(|pack| pack.revision);
        let runtime_identity = self
            .runtime_registry
            .identity(InferenceRuntimeKind::OnnxCpu)
            .ok();
        let resource_status = if !native_ready || runtime_identity.is_none() {
            SpeechResourceStatus::NativeUnavailable
        } else if model_pack_revision.is_none() {
            SpeechResourceStatus::NotInstalled
        } else {
            SpeechResourceStatus::Ready
        };
        SpeechCapabilitySnapshot {
            resource_status,
            model_pack_revision,
            onnx_runtime_version: runtime_identity
                .as_ref()
                .map(|identity| identity.version().to_string()),
        }
    }

    fn execution_resources(&self) -> Result<SpeechExecutionResources, &'static str> {
        if !plain_file(&self.worker_path) || !plain_file(&self.native_manifest_path) {
            return Err("SPEECH_NATIVE_RUNTIME_UNAVAILABLE");
        }
        let active = self
            .model_pack
            .active_pack()
            .ok_or("SPEECH_MODEL_PACK_UNAVAILABLE")?;
        let runtime = self
            .runtime_registry
            .identity(InferenceRuntimeKind::OnnxCpu)
            .map_err(|_| "SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?;
        // The activated pack was fully verified before entering this in-memory
        // state. Admission only snapshots that identity; every media Worker
        // independently re-opens and hashes the exact pack before model use.
        // Re-hashing hundreds of MiB here would block recording start/stop
        // without adding an execution boundary check.
        Ok(SpeechExecutionResources {
            worker_path: self.worker_path.clone(),
            native_manifest_path: self.native_manifest_path.clone(),
            onnx_runtime_path: runtime.path().to_path_buf(),
            model_pack_manifest_path: active.manifest_path,
            provenance: RecordSpeechProvenance {
                algorithm_revision: Some(native_algorithm_revision(&self.native_manifest_path)?),
                provider: "local".into(),
                model_pack_revision: active.revision,
                onnx_runtime_version: runtime.version().to_string(),
            },
        })
    }

    fn execution_resources_for_pipeline(
        &self,
        pipeline: &SpeechPipelineSnapshot,
    ) -> Result<SpeechExecutionResources, &'static str> {
        if !plain_file(&self.worker_path) || !plain_file(&self.native_manifest_path) {
            return Err("SPEECH_NATIVE_RUNTIME_UNAVAILABLE");
        }
        let runtime = self
            .runtime_registry
            .identity(InferenceRuntimeKind::OnnxCpu)
            .map_err(|_| "SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?;
        if pipeline.provider != "local" || pipeline.onnx_runtime_version != runtime.version() {
            return Err("SPEECH_PIPELINE_REVISION_UNAVAILABLE");
        }
        let algorithm_revision = native_algorithm_revision(&self.native_manifest_path)?;
        if pipeline
            .algorithm_revision
            .as_ref()
            .is_some_and(|revision| revision != &algorithm_revision)
        {
            return Err("SPEECH_PIPELINE_REVISION_UNAVAILABLE");
        }
        let model_pack = self
            .model_pack
            .resolve_revision(&pipeline.model_pack_revision)?;
        Ok(SpeechExecutionResources {
            worker_path: self.worker_path.clone(),
            native_manifest_path: self.native_manifest_path.clone(),
            onnx_runtime_path: runtime.path().to_path_buf(),
            model_pack_manifest_path: model_pack.manifest_path,
            provenance: RecordSpeechProvenance {
                algorithm_revision: Some(algorithm_revision),
                provider: "local".into(),
                model_pack_revision: pipeline.model_pack_revision.clone(),
                onnx_runtime_version: runtime.version().to_string(),
            },
        })
    }

    fn reserve_agent_admission(
        self: &Arc<Self>,
    ) -> Result<AgentAdmissionReservation, &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        if !state.accepting {
            return Err("SPEECH_MANAGER_SHUTTING_DOWN");
        }
        if state.queue.len()
            + state.agent_admission_reservations
            + usize::from(state.active_job.is_some())
            >= MAX_PENDING_JOBS
        {
            return Err("SPEECH_QUEUE_FULL");
        }
        state.agent_admission_reservations += 1;
        Ok(AgentAdmissionReservation {
            manager: Arc::clone(self),
            active: true,
        })
    }

    fn probe_agent_source(
        &self,
        source_path: &Path,
        resources: &SpeechExecutionResources,
    ) -> Result<AgentMediaProbe, &'static str> {
        let deadline = Instant::now() + ATTACHMENT_PROBE_TIMEOUT;
        let lifecycle_permit = crate::sidecar::begin_lifecycle_spawn_permit()
            .map_err(|_| "SPEECH_MANAGER_SHUTTING_DOWN")?;
        let probe_id = format!("speech_probe_{}", Uuid::new_v4().simple());
        let identity = WorkloadIdentity {
            workload_id: probe_id.clone(),
            worker_generation: 1,
        };
        let start = WorkerCommand::Start(StartRequest {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            workload_kind: WorkloadKind::AttachmentProbe,
            input: WorkloadInput::Attachment {
                input_path: path_for_protocol(source_path)?,
            },
            native_manifest_path: path_for_protocol(&resources.native_manifest_path)?,
            onnx_runtime_path: path_for_protocol(&resources.onnx_runtime_path)?,
            model_pack_manifest_path: path_for_protocol(&resources.model_pack_manifest_path)?,
        });
        let mut command = process_cmd::new(&resources.worker_path);
        command
            .current_dir(self.root.join("private"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();
        let mut child =
            process_cmd::spawn_tree(&mut command).map_err(|_| "SPEECH_WORKER_START_FAILED")?;
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        drain_worker_stderr(stderr, probe_id, 1);
        let child = Arc::new(Mutex::new(child));
        let stdin = Arc::new(Mutex::new(stdin));
        let result = if send_worker_command(&stdin, &start).is_err() {
            Err("SPEECH_WORKER_PROTOCOL_ERROR")
        } else {
            collect_agent_probe(&identity, stdout, deadline)
        };
        if let Err(code) = result {
            kill_worker(&child);
            drop(lifecycle_permit);
            return Err(code);
        }
        let exit_result = wait_for_probe_exit(&child, deadline);
        if exit_result.is_err() {
            kill_worker(&child);
        }
        drop(lifecycle_permit);
        match exit_result {
            Ok(true) => result,
            Ok(false) => Err("SPEECH_WORKER_CRASHED"),
            Err(code) => Err(code),
        }
    }

    pub fn submit_agent_attachment(
        self: &Arc<Self>,
        initiator_session_id: &str,
        workspace_identity: &Path,
        source_path: &str,
        output_root: Option<&str>,
    ) -> Result<SpeechJob, &'static str> {
        let _update_admission =
            crate::sidecar::begin_lifecycle_spawn_permit().map_err(|_| "UPDATE_BUSY")?;
        let admission_started = Instant::now();
        let result = self.submit_agent_attachment_inner(
            initiator_session_id,
            workspace_identity,
            source_path,
            output_root,
        );
        match &result {
            Ok(job) => emit_attachment_job(
                job,
                SpeechAttachmentOperation::Submit,
                AnalyticsOutcome::Success,
                elapsed_ms(admission_started),
            ),
            Err(code) => {
                let capability = self.capability_snapshot();
                record_analytics::emit(RecordAnalyticsMilestone::SpeechAttachmentJob {
                    event_schema_version: 1,
                    job_id: None,
                    operation: SpeechAttachmentOperation::Submit,
                    source: AnalyticsSource::CliAgent,
                    media_kind: AnalyticsMediaKind::Unknown,
                    outcome: AnalyticsOutcome::Rejected,
                    file_bytes_bucket: None,
                    media_duration_bucket: None,
                    provider: Some("local".to_string()),
                    model_revision: capability.model_pack_revision,
                    duration_ms: elapsed_ms(admission_started),
                    error_code: Some((*code).to_string()),
                });
            }
        }
        result
    }

    fn submit_agent_attachment_inner(
        self: &Arc<Self>,
        initiator_session_id: &str,
        workspace_identity: &Path,
        source_path: &str,
        output_root: Option<&str>,
    ) -> Result<SpeechJob, &'static str> {
        validate_session_id(initiator_session_id)?;
        let workspace_text = workspace_identity
            .to_str()
            .ok_or("SPEECH_PATH_ENCODING_UNSUPPORTED")?;
        let workspace =
            validate_workspace_root(workspace_text).map_err(|_| "SPEECH_WORKSPACE_UNSAFE")?;
        let resources = self
            .execution_resources()
            .map_err(|_| "SPEECH_RESOURCE_REQUIRED")?;
        let (source_path, source_file) =
            open_workspace_regular_file_no_follow(&workspace, source_path, "speech source")
                .map_err(|_| "SPEECH_SOURCE_UNSAFE")?;
        let metadata = source_file.metadata().map_err(|_| "SPEECH_SOURCE_UNSAFE")?;
        if metadata.len() == 0 || metadata.len() > MAX_AGENT_SOURCE_BYTES {
            return Err("SPEECH_MEDIA_LIMIT_EXCEEDED");
        }
        let source_version = agent_source_version(&metadata);
        let source =
            same_file::Handle::from_file(source_file).map_err(|_| "SPEECH_SOURCE_UNSAFE")?;

        let default_output = workspace.join(AGENT_OUTPUT_DIRECTORY);
        let output_text = output_root.unwrap_or_else(|| {
            default_output
                .to_str()
                .expect("Workspace path was already valid UTF-8")
        });
        let (output_root, output_directory) =
            ensure_workspace_directory_no_follow(&workspace, output_text)
                .map_err(|_| "SPEECH_OUTPUT_PATH_UNSAFE")?;
        let output_root_identity = same_file::Handle::from_file(output_directory)
            .map_err(|_| "SPEECH_OUTPUT_PATH_UNSAFE")?;

        let mut admission = self.reserve_agent_admission()?;
        let probe = self.probe_agent_source(&source_path, &resources)?;
        if !same_file::Handle::from_path(&source_path).is_ok_and(|current| current == source)
            || agent_source_version(
                &source
                    .as_file()
                    .metadata()
                    .map_err(|_| "SPEECH_SOURCE_CHANGED")?,
            ) != source_version
        {
            return Err("SPEECH_SOURCE_CHANGED");
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        admission.release_locked(&mut state);
        if !state.accepting {
            return Err("SPEECH_MANAGER_SHUTTING_DOWN");
        }
        if state.queue.len() + usize::from(state.active_job.is_some()) >= MAX_PENDING_JOBS {
            return Err("SPEECH_QUEUE_FULL");
        }

        let job_id = new_job_id();
        let public_dir = output_root.join(&job_id);
        if fs::symlink_metadata(&public_dir).is_ok() {
            return Err("SPEECH_OUTPUT_COLLISION");
        }
        let staging_dir = output_root.join(format!(".myagents-speech-{job_id}.staging"));
        let private_dir = self.root.join("private").join(&job_id);
        ensure_private_directory(&staging_dir).map_err(|_| "SPEECH_PRIVATE_STORAGE_UNAVAILABLE")?;
        if let Err(error) = ensure_private_directory(&private_dir) {
            let _ = fs::remove_dir(&staging_dir);
            crate::ulog_warn!("[speech] failed to create private job input: {}", error);
            return Err("SPEECH_PRIVATE_STORAGE_UNAVAILABLE");
        }
        let private_identity = match same_file::Handle::from_path(&private_dir) {
            Ok(identity) => identity,
            Err(_) => {
                let _ = fs::remove_dir_all(&private_dir);
                let _ = fs::remove_dir(&staging_dir);
                return Err("SPEECH_PRIVATE_STORAGE_UNAVAILABLE");
            }
        };
        let staging_identity = match same_file::Handle::from_path(&staging_dir) {
            Ok(identity) => identity,
            Err(_) => {
                let _ = fs::remove_dir_all(&private_dir);
                let _ = fs::remove_dir(&staging_dir);
                return Err("SPEECH_OUTPUT_PATH_UNSAFE");
            }
        };
        let staging_token = Uuid::new_v4().simple().to_string();
        if write_agent_staging_marker(&staging_dir, &staging_token).is_err()
            || write_agent_private_staging_token(&private_dir, &staging_token).is_err()
        {
            let _ = fs::remove_dir_all(&private_dir);
            let _ = fs::remove_dir_all(&staging_dir);
            return Err("SPEECH_PRIVATE_STORAGE_UNAVAILABLE");
        }

        let now = Utc::now();
        let job = SpeechJob {
            processing_id: None,
            record_baseline: None,
            record_asr_candidate: None,
            schema_version: JOB_SCHEMA_VERSION,
            job_id: job_id.clone(),
            kind: SpeechJobKind::AgentAttachmentAsr,
            state: SpeechJobState::Queued,
            stage: SpeechJobStage::Validating,
            origin: SpeechJobOrigin::Agent {
                initiator_session_id: initiator_session_id.to_string(),
                workspace_identity: workspace.to_string_lossy().into_owned(),
            },
            source: SpeechJobSource {
                path: source_path.to_string_lossy().into_owned(),
                size_bytes: metadata.len(),
                sha256: None,
                media_kind: Some(probe.media_kind),
                codec: Some(probe.codec),
                duration_ms: probe.duration_ms,
                used_default_track: Some(probe.used_default_track),
            },
            output: SpeechJobOutput {
                root_directory: Some(output_root.to_string_lossy().into_owned()),
                job_directory: Some(public_dir.to_string_lossy().into_owned()),
                transcript_markdown_path: Some(
                    public_dir
                        .join("transcript.md")
                        .to_string_lossy()
                        .into_owned(),
                ),
                transcript_json_path: Some(
                    public_dir
                        .join("transcript.json")
                        .to_string_lossy()
                        .into_owned(),
                ),
                artifact_available: false,
            },
            pipeline: pipeline_from_provenance(&resources.provenance),
            created_at: now,
            updated_at: now,
            started_at: None,
            finished_at: None,
            worker_generation: None,
            worker_attempts: 0,
            error: None,
            metrics: None,
        };
        if persist_job(&self.root, &job).is_err() {
            let _ = fs::remove_dir_all(&private_dir);
            let _ = fs::remove_dir_all(&staging_dir);
            return Err("SPEECH_JOB_STORE_WRITE_FAILED");
        }
        state.pending_agent.insert(
            job_id.clone(),
            PendingAgentJob {
                source,
                source_version,
                prepared_source: None,
                private_dir,
                private_identity,
                staging_dir,
                staging_identity,
                staging_token,
                output_root_identity,
            },
        );
        state.queue.push_back(job_id.clone());
        state.jobs.insert(job_id, job.clone());
        drop(state);
        self.wake.notify_one();
        Ok(job)
    }

    pub async fn submit_record_backfill(
        self: &Arc<Self>,
        record_id: &str,
    ) -> Result<SpeechJob, String> {
        let _update_admission = crate::sidecar::begin_lifecycle_spawn_permit()?;
        validate_job_id(record_id).map_err(str::to_string)?;
        let manager = Arc::clone(self);
        let record_id = record_id.to_owned();
        // Admission takes the same Manager -> Store lock order as publication.
        // Disk snapshots run off the async UI executor, inside that boundary.
        let job = tauri::async_runtime::spawn_blocking(move || {
            manager.admit_record_processing(&record_id)
        })
        .await
        .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())??;
        self.wake.notify_one();
        Ok(job)
    }

    fn admit_record_processing(&self, record_id: &str) -> Result<SpeechJob, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        if !state.accepting {
            return Err("SPEECH_MANAGER_SHUTTING_DOWN".into());
        }
        if let Some(existing) = state.jobs.values().find(|job| {
            job.kind == SpeechJobKind::RecordBackfillAsr && !job.state.is_terminal()
                && matches!(&job.origin, SpeechJobOrigin::Record { record_id: existing } if existing == record_id)
        }) { return Ok(existing.clone()); }
        if state.queue.len() + state.agent_admission_reservations >= MAX_PENDING_JOBS {
            return Err("SPEECH_QUEUE_FULL".into());
        }
        let resources = self.execution_resources().map_err(str::to_string)?;
        let baseline =
            tauri::async_runtime::block_on(self.record_store.prepare_speech_processing(record_id))
                .map_err(|_| "SPEECH_RECORD_AUDIO_UNAVAILABLE".to_string())?;
        let source_size = baseline
            .audio_artifacts
            .iter()
            .try_fold(0_u64, |sum, artifact| sum.checked_add(artifact.size_bytes))
            .filter(|size| *size > 0)
            .ok_or("SPEECH_RECORD_AUDIO_UNAVAILABLE")?;
        let runtime = self
            .runtime_registry
            .identity(InferenceRuntimeKind::OnnxCpu)
            .map_err(|_| "SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?;
        let processing_id = new_job_id();
        let pipeline = pipeline_from_provenance(&resources.provenance);
        let source_identity = baseline.audio_identity.clone();
        let input = RecordProcessingInput {
            processing_id: processing_id.clone(),
            baseline,
            pipeline: pipeline.clone(),
            runtime_sha256: runtime.sha256().into(),
            model_manifest_sha256: record_processing::small_file_sha256(
                &resources.model_pack_manifest_path,
            )
            .map_err(str::to_string)?,
        };
        let reference = record_processing::write_candidate(
            &self.root,
            &processing_id,
            record_processing::BASELINE_FILE,
            &input,
        )
        .map_err(str::to_string)?;
        let now = Utc::now();
        let mut job = SpeechJob {
            processing_id: Some(processing_id.clone()),
            record_baseline: Some(reference),
            record_asr_candidate: None,
            schema_version: JOB_SCHEMA_VERSION,
            job_id: processing_id,
            kind: SpeechJobKind::RecordBackfillAsr,
            state: SpeechJobState::Queued,
            stage: SpeechJobStage::Validating,
            origin: SpeechJobOrigin::Record {
                record_id: record_id.into(),
            },
            source: SpeechJobSource {
                path: format!("record:{record_id}"),
                size_bytes: source_size,
                sha256: Some(source_identity),
                media_kind: Some("record/ogg-opus".into()),
                codec: None,
                duration_ms: None,
                used_default_track: None,
            },
            output: empty_output(),
            pipeline,
            created_at: now,
            updated_at: now,
            started_at: None,
            finished_at: None,
            worker_generation: None,
            worker_attempts: 0,
            error: None,
            metrics: None,
        };
        persist_job(&self.root, &job)?;
        if tauri::async_runtime::block_on(self.record_store.update_audio_processing_status(
            record_id,
            Some(TranscriptionStatus::Queued),
            Some(DiarizationStatus::Queued),
        ))
        .is_err()
        {
            job.state = SpeechJobState::Failed;
            job.finished_at = Some(Utc::now());
            job.error = Some(SpeechJobError {
                code: "SPEECH_RECORD_UPDATE_FAILED".into(),
                retryable: true,
            });
            persist_job(&self.root, &job)?;
            state.jobs.insert(job.job_id.clone(), job);
            return Err("SPEECH_RECORD_UPDATE_FAILED".into());
        }
        state.queue.push_back(job.job_id.clone());
        state.jobs.insert(job.job_id.clone(), job.clone());
        log_record_job(&job, "queued");
        Ok(job)
    }

    pub(crate) async fn start_record_live(
        self: &Arc<Self>,
        record_id: &str,
        sources: Vec<AnalysisSpoolSource>,
    ) -> Result<(), String> {
        let _update_admission = crate::sidecar::begin_lifecycle_spawn_permit()?;
        validate_job_id(record_id).map_err(str::to_string)?;
        validate_live_sources(&sources)?;
        let record = self
            .record_store
            .get(record_id)
            .await
            .ok_or_else(|| "SPEECH_RECORD_NOT_FOUND".to_string())?;
        let audio = record
            .audio
            .as_ref()
            .filter(|_| record.kind == RecordKind::Audio)
            .ok_or_else(|| "SPEECH_RECORD_AUDIO_UNAVAILABLE".to_string())?;
        let tracks = sources
            .iter()
            .map(AnalysisSpoolSource::track)
            .collect::<Vec<_>>();
        if tracks.len() != audio.tracks.len()
            || tracks.iter().any(|track| !audio.tracks.contains(track))
        {
            return Err("SPEECH_ANALYSIS_SOURCE_INVALID".to_string());
        }
        let control = Arc::new(LiveControl::default());
        let resources = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
            if !state.accepting {
                return Err("SPEECH_MANAGER_SHUTTING_DOWN".to_string());
            }
            validate_live_admission(&state, record_id).map_err(str::to_string)?;
            let resources = self.execution_resources().map_err(str::to_string)?;
            state.live_sessions.insert(
                record_id.to_string(),
                LiveSessionRegistration {
                    control: control.clone(),
                    tracks,
                },
            );
            resources
        };
        let journal = match self
            .record_store
            .begin_live_transcript(record_id, resources.provenance.clone())
            .await
        {
            Ok(journal) => journal,
            Err(error) => {
                self.remove_live_session(record_id);
                return Err(error);
            }
        };
        let manager = Arc::clone(self);
        let record_id = record_id.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            manager.run_live_session(record_id, sources, resources, control, journal)
        });
        Ok(())
    }

    pub(crate) fn flush_record_live(
        &self,
        record_id: &str,
        offsets: Vec<RecordTranscriptTrackOffset>,
    ) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        let session = state
            .live_sessions
            .get(record_id)
            .ok_or_else(|| "SPEECH_RECORD_LIVE_NOT_ACTIVE".to_string())?;
        let boundary = normalize_live_boundary(&session.tracks, offsets)?;
        let mut control = session
            .control
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        if control.cancelled || control.finish.is_some() {
            return Err("SPEECH_RECORD_LIVE_FINALIZING".to_string());
        }
        if let Some(previous) = control.flushes.back() {
            ensure_boundary_monotonic(previous, &boundary)?;
            if previous == &boundary {
                return Ok(());
            }
        }
        control.flushes.push_back(boundary);
        Ok(())
    }

    pub(crate) fn pause_record_live(
        self: &Arc<Self>,
        record_id: &str,
        offsets: Vec<RecordTranscriptTrackOffset>,
    ) -> Result<(), String> {
        self.pause_record_live_with_grace(record_id, offsets, LIVE_PAUSE_WARM_GRACE)
    }

    fn pause_record_live_with_grace(
        self: &Arc<Self>,
        record_id: &str,
        offsets: Vec<RecordTranscriptTrackOffset>,
        warm_grace: StdDuration,
    ) -> Result<(), String> {
        let (control, boundary) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
            let session = state
                .live_sessions
                .get(record_id)
                .ok_or_else(|| "SPEECH_RECORD_LIVE_NOT_ACTIVE".to_string())?;
            (
                Arc::clone(&session.control),
                normalize_live_boundary(&session.tracks, offsets)?,
            )
        };
        let pause_epoch = {
            let mut state = control
                .state
                .lock()
                .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
            if state.cancelled || state.finish.is_some() {
                return Err("SPEECH_RECORD_LIVE_FINALIZING".to_string());
            }
            if let Some(previous) = state.flushes.back() {
                ensure_boundary_monotonic(previous, &boundary)?;
                if previous != &boundary {
                    state.flushes.push_back(boundary);
                }
            } else {
                state.flushes.push_back(boundary);
            }
            if let Some(timer) = state.pause_timer.take() {
                timer.abort();
            }
            state.paused = true;
            state.suspend_requested = false;
            state.pause_epoch = state.pause_epoch.saturating_add(1).max(1);
            state.pause_epoch
        };
        let manager = Arc::clone(self);
        let record_id = record_id.to_string();
        let timer_control = Arc::clone(&control);
        let timer_record_id = record_id.clone();
        let timer = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(warm_grace).await;
            manager.request_live_suspend_if_paused(&timer_record_id, &timer_control, pause_epoch);
        });
        let mut state = control
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        if state.paused && state.pause_epoch == pause_epoch && !state.cancelled {
            state.pause_timer = Some(timer);
        } else {
            timer.abort();
        }
        Ok(())
    }

    pub(crate) fn resume_record_live(&self, record_id: &str) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        let session = state
            .live_sessions
            .get(record_id)
            .ok_or_else(|| "SPEECH_RECORD_LIVE_NOT_ACTIVE".to_string())?;
        let mut control = session
            .control
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        if control.cancelled || control.finish.is_some() {
            return Err("SPEECH_RECORD_LIVE_FINALIZING".to_string());
        }
        if let Some(timer) = control.pause_timer.take() {
            timer.abort();
        }
        control.paused = false;
        control.suspend_requested = false;
        control.pause_epoch = control.pause_epoch.saturating_add(1).max(1);
        Ok(())
    }

    fn request_live_suspend_if_paused(
        self: &Arc<Self>,
        record_id: &str,
        control: &Arc<LiveControl>,
        pause_epoch: u64,
    ) {
        let Ok(state) = self.state.lock() else {
            return;
        };
        let Some(session) = state.live_sessions.get(record_id) else {
            return;
        };
        if !Arc::ptr_eq(&session.control, control) {
            return;
        }
        let Ok(mut control) = control.state.lock() else {
            return;
        };
        if control.paused
            && control.pause_epoch == pause_epoch
            && !control.cancelled
            && control.finish.is_none()
        {
            control.pause_timer.take();
            control.suspend_requested = true;
            if let Some(running) = state
                .live_running
                .as_ref()
                .filter(|running| running.job_id == record_id)
            {
                self.arm_live_suspend_watchdog(
                    record_id.to_string(),
                    running.generation,
                    Arc::clone(&running.child),
                );
            }
        }
    }

    fn arm_live_suspend_watchdog(
        self: &Arc<Self>,
        record_id: String,
        generation: u64,
        child: Arc<Mutex<process_cmd::ChildTree>>,
    ) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(WORKER_CANCEL_GRACE).await;
            let still_running = manager.state.lock().is_ok_and(|state| {
                state.live_running.as_ref().is_some_and(|running| {
                    running.job_id == record_id
                        && running.generation == generation
                        && Arc::ptr_eq(&running.child, &child)
                })
            });
            if still_running {
                let _ = tauri::async_runtime::spawn_blocking(move || kill_worker(&child)).await;
            }
        });
    }

    pub(crate) fn finish_record_live(
        &self,
        record_id: &str,
        offsets: Vec<RecordTranscriptTrackOffset>,
    ) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        let session = state
            .live_sessions
            .get(record_id)
            .ok_or_else(|| "SPEECH_RECORD_LIVE_NOT_ACTIVE".to_string())?;
        let boundary = normalize_live_boundary(&session.tracks, offsets)?;
        let mut control = session
            .control
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        if control.cancelled {
            return Err("SPEECH_RECORD_LIVE_NOT_ACTIVE".to_string());
        }
        if let Some(existing) = &control.finish {
            return if existing == &boundary {
                Ok(())
            } else {
                Err("SPEECH_RECORD_LIVE_FINALIZE_CONFLICT".to_string())
            };
        }
        if let Some(previous) = control.flushes.back() {
            ensure_boundary_monotonic(previous, &boundary)?;
        }
        if let Some(timer) = control.pause_timer.take() {
            timer.abort();
        }
        control.paused = false;
        control.suspend_requested = false;
        control.pause_epoch = control.pause_epoch.saturating_add(1).max(1);
        control.finish = Some(boundary);
        crate::ulog_info!(
            "[speech] live finish requested recordId={} flushed={}",
            record_id,
            control.finish == control.flushed && control.flushes.is_empty()
        );
        Ok(())
    }

    fn run_live_session(
        self: Arc<Self>,
        record_id: String,
        sources: Vec<AnalysisSpoolSource>,
        resources: SpeechExecutionResources,
        control: Arc<LiveControl>,
        mut journal: RecordLiveTranscriptJournal,
    ) {
        let mut attempts = 0_u32;
        let mut finished = false;
        let mut cancelled = false;
        let mut terminal_error = None;
        while attempts < MAX_WORKER_ATTEMPTS {
            let control_snapshot = match control.snapshot() {
                Ok(snapshot) => snapshot,
                Err(code) => {
                    terminal_error = Some(code.to_string());
                    break;
                }
            };
            if control_snapshot.cancelled {
                cancelled = true;
                break;
            }
            if control_snapshot.finish_is_flushed {
                finished = true;
                break;
            }
            if control_snapshot.paused && control_snapshot.suspend_requested {
                loop {
                    let snapshot = match control.snapshot() {
                        Ok(snapshot) => snapshot,
                        Err(code) => {
                            terminal_error = Some(code.to_string());
                            break;
                        }
                    };
                    if snapshot.cancelled {
                        cancelled = true;
                        break;
                    }
                    if snapshot.finish_is_flushed {
                        finished = true;
                        break;
                    }
                    if !snapshot.paused {
                        break;
                    }
                    thread::sleep(LIVE_POLL_INTERVAL);
                }
                if finished || cancelled || terminal_error.is_some() {
                    break;
                }
                continue;
            }
            let generation = match self.allocate_live_generation(&record_id) {
                Ok(generation) => generation,
                Err(code) => {
                    terminal_error = Some(code.to_string());
                    break;
                }
            };
            attempts = attempts.saturating_add(1);
            let compute = ComputeWorkloadIdentity {
                kind: ComputeWorkloadKind::RecordLive,
                id: record_id.clone(),
                generation,
            };
            let lease = tauri::async_runtime::block_on(self.compute_coordinator.acquire(compute));
            match control.snapshot() {
                Ok(snapshot) if snapshot.cancelled => {
                    cancelled = true;
                    drop(lease);
                    break;
                }
                Ok(snapshot) if snapshot.finish_is_flushed => {
                    finished = true;
                    drop(lease);
                    break;
                }
                Ok(snapshot) if snapshot.paused && snapshot.suspend_requested => {
                    attempts = attempts.saturating_sub(1);
                    drop(lease);
                    continue;
                }
                Ok(_) => {}
                Err(_) => {
                    cancelled = true;
                    drop(lease);
                    break;
                }
            }
            let outcome = self.execute_live_attempt(
                &record_id,
                generation,
                &sources,
                &resources,
                &control,
                &mut journal,
            );
            drop(lease);
            match outcome {
                LiveAttemptOutcome::Finished => {
                    finished = true;
                    break;
                }
                LiveAttemptOutcome::Suspended => {
                    attempts = attempts.saturating_sub(1);
                    terminal_error = None;
                    continue;
                }
                LiveAttemptOutcome::Cancelled => {
                    cancelled = true;
                    break;
                }
                LiveAttemptOutcome::Failed { code, retryable } => {
                    let _ = journal.append_generation_failed(generation, &code);
                    if !retryable {
                        terminal_error = Some(code);
                        break;
                    }
                    terminal_error = Some(code);
                }
            }
        }

        if finished {
            if let Err(error) = journal.finish() {
                crate::ulog_error!(
                    "[speech] live journal finalization failed recordId={} error={}",
                    record_id,
                    error
                );
            }
        } else if !cancelled {
            let code = terminal_error.as_deref().unwrap_or("SPEECH_WORKER_CRASHED");
            if let Err(error) = journal.fail(code) {
                crate::ulog_error!(
                    "[speech] live journal failure commit failed recordId={} error={}",
                    record_id,
                    error
                );
            }
            if let Err(error) = self.project_live_failure_if_owned(&record_id, &control) {
                crate::ulog_warn!(
                    "[speech] live failure projection failed recordId={} code={} error={}",
                    record_id,
                    code,
                    error
                );
            }
            while control
                .snapshot()
                .is_ok_and(|snapshot| !snapshot.cancelled && snapshot.finish.is_none())
            {
                thread::sleep(LIVE_POLL_INTERVAL);
            }
        }

        crate::ulog_info!(
            "[speech] live settled recordId={} finished={} cancelled={} attempts={} failed={}",
            record_id,
            finished,
            cancelled,
            attempts,
            terminal_error.is_some()
        );
        self.clear_live_running(&record_id);
        self.remove_live_session(&record_id);
        for source in &sources {
            if let Err(error) = cleanup_analysis_spool(source.path()) {
                crate::ulog_warn!(
                    "[speech] analysis spool cleanup failed recordId={} track={:?} error={}",
                    record_id,
                    source.track(),
                    error
                );
            }
        }
    }

    fn allocate_live_generation(&self, record_id: &str) -> Result<u64, &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        if !state.accepting || !state.live_sessions.contains_key(record_id) {
            return Err("SPEECH_INTERRUPTED");
        }
        let generation = state.next_generation;
        state.next_generation = state.next_generation.saturating_add(1).max(1);
        Ok(generation)
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_live_attempt(
        &self,
        record_id: &str,
        generation: u64,
        sources: &[AnalysisSpoolSource],
        resources: &SpeechExecutionResources,
        control: &Arc<LiveControl>,
        journal: &mut RecordLiveTranscriptJournal,
    ) -> LiveAttemptOutcome {
        let replay_from = match control.publication_offsets(journal.replay_offsets()) {
            Ok(offsets) => offsets,
            Err(code) => return live_failed(code, false),
        };
        let mut cursors = match live_cursors(sources, &replay_from) {
            Ok(cursors) => cursors,
            Err(code) => return live_failed(code, false),
        };
        let replay_metadata = cursors
            .iter()
            .map(|cursor| RecordTranscriptTrackOffset {
                track: cursor.source.track(),
                sample: cursor.replay_record_start,
            })
            .collect();
        if journal
            .append_generation_started(generation, replay_metadata)
            .is_err()
        {
            return live_failed("SPEECH_JOB_STORE_WRITE_FAILED", false);
        }
        let lifecycle_spawn_permit = match crate::sidecar::begin_lifecycle_spawn_permit() {
            Ok(permit) => permit,
            Err(_) => return LiveAttemptOutcome::Cancelled,
        };
        let (child, stdin, stdout) = match self.spawn_live_worker(record_id, generation, resources)
        {
            Ok(worker) => worker,
            Err("SPEECH_LIVE_SUSPENDED") => return LiveAttemptOutcome::Suspended,
            Err(code) => return live_failed(code, true),
        };
        drop(lifecycle_spawn_permit);
        let identity = WorkloadIdentity {
            workload_id: record_id.to_string(),
            worker_generation: generation,
        };
        let start = WorkerCommand::Start(StartRequest {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            workload_kind: WorkloadKind::RecordLiveAsr,
            input: WorkloadInput::LivePcm {
                streams: cursors
                    .iter()
                    .map(|cursor| PcmStreamStart {
                        channels: cursor.source.channels(),
                        track: cursor.track,
                        first_sequence: cursor.next_sequence,
                        first_sample: cursor.position,
                        publish_from_record_sample: cursor.publish_from_record_sample,
                    })
                    .collect(),
            },
            native_manifest_path: match path_for_protocol(&resources.native_manifest_path) {
                Ok(path) => path,
                Err(code) => {
                    return settle_live_spawn_failure(
                        self, record_id, generation, &child, code, false,
                    )
                }
            },
            onnx_runtime_path: match path_for_protocol(&resources.onnx_runtime_path) {
                Ok(path) => path,
                Err(code) => {
                    return settle_live_spawn_failure(
                        self, record_id, generation, &child, code, false,
                    )
                }
            },
            model_pack_manifest_path: match path_for_protocol(&resources.model_pack_manifest_path) {
                Ok(path) => path,
                Err(code) => {
                    return settle_live_spawn_failure(
                        self, record_id, generation, &child, code, false,
                    )
                }
            },
        });
        if send_worker_command(&stdin, &start).is_err() {
            return settle_live_spawn_failure(
                self,
                record_id,
                generation,
                &child,
                "SPEECH_WORKER_PROTOCOL_ERROR",
                true,
            );
        }
        let responses = spawn_live_response_reader(stdout, generation);
        match receive_live_response(&responses) {
            Ok(WorkerResponse::Ready {
                identity: ready_identity,
                ..
            }) if ready_identity == identity => {}
            Ok(WorkerResponse::Failed {
                identity: failed_identity,
                code,
                ..
            }) if failed_identity == identity => {
                let _ = process_cmd::settle_tree(&child, WORKER_TERMINAL_GRACE);
                self.clear_live_running(record_id);
                return live_failed(&code, worker_code_retryable(&code));
            }
            Ok(mut response) => {
                response.zeroize_sensitive();
                return settle_live_spawn_failure(
                    self,
                    record_id,
                    generation,
                    &child,
                    "SPEECH_WORKER_PROTOCOL_ERROR",
                    true,
                );
            }
            Err((code, retryable)) => {
                return settle_live_spawn_failure(
                    self, record_id, generation, &child, &code, retryable,
                );
            }
        }

        let mut next_worker_revision = 1_u64;
        loop {
            let snapshot = match control.snapshot() {
                Ok(snapshot) => snapshot,
                Err(code) => {
                    return settle_live_spawn_failure(
                        self, record_id, generation, &child, code, false,
                    )
                }
            };
            if snapshot.cancelled {
                let _ = send_worker_command(
                    &stdin,
                    &WorkerCommand::Cancel {
                        protocol_version: PROTOCOL_VERSION,
                        identity: identity.clone(),
                    },
                );
                let _ = process_cmd::settle_tree(&child, WORKER_CANCEL_GRACE);
                self.clear_live_running(record_id);
                return LiveAttemptOutcome::Cancelled;
            }
            if snapshot.suspend_requested
                && snapshot.paused
                && snapshot.flush.is_none()
                && snapshot.finish.is_none()
            {
                let settled = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let yield_sent = control.send_yield_if_suspended(&stdin, &identity);
                if yield_sent.is_err() {
                    return settle_live_spawn_failure(
                        self,
                        record_id,
                        generation,
                        &child,
                        "SPEECH_WORKER_PROTOCOL_ERROR",
                        true,
                    );
                }
                if yield_sent == Ok(false) {
                    continue;
                }
                arm_yield_watchdog(&child, &settled);
                let mut response = receive_live_response(&responses);
                let valid_yield = matches!(
                    &response,
                    Ok(WorkerResponse::Yielded {
                        identity: yielded_identity,
                        checkpoint,
                        ..
                    }) if yielded_identity == &identity
                        && live_checkpoint_matches(&cursors, checkpoint)
                );
                if let Ok(response) = &mut response {
                    response.zeroize_sensitive();
                }
                let _ = process_cmd::settle_tree(&child, WORKER_CANCEL_GRACE);
                settled.store(true, std::sync::atomic::Ordering::Release);
                self.clear_live_running(record_id);
                return if valid_yield {
                    LiveAttemptOutcome::Suspended
                } else {
                    live_failed("SPEECH_WORKER_PROTOCOL_ERROR", true)
                };
            }
            let boundary = snapshot.flush.as_ref().or(snapshot.finish.as_ref());
            let mut progressed = false;
            for cursor in &mut cursors {
                let progress = cursor.source.snapshot();
                if let Some(code) = progress.error_code.as_deref() {
                    return settle_live_spawn_failure(
                        self, record_id, generation, &child, code, false,
                    );
                }
                let requested_end = boundary
                    .and_then(|boundary| boundary_sample(boundary, cursor.source.track()))
                    .unwrap_or(progress.committed_samples);
                if requested_end > progress.committed_samples {
                    if progress.finished {
                        return settle_live_spawn_failure(
                            self,
                            record_id,
                            generation,
                            &child,
                            "SPEECH_ANALYSIS_SOURCE_INVALID",
                            false,
                        );
                    }
                    continue;
                }
                if cursor.position >= requested_end {
                    continue;
                }
                let sample_count = usize::try_from(
                    requested_end
                        .saturating_sub(cursor.position)
                        .min(16_000)
                        .min(MAX_PCM_SAMPLES_PER_FRAME as u64),
                )
                .unwrap_or(MAX_PCM_SAMPLES_PER_FRAME);
                let time_span = match cursor.source.time_span(cursor.position, sample_count) {
                    Ok(span) => span,
                    Err(code) => {
                        return settle_live_spawn_failure(
                            self, record_id, generation, &child, code, false,
                        )
                    }
                };
                let sample_count = time_span.as_ref().map_or(sample_count, |span| {
                    (span.source_end - span.source_start) as usize
                });
                let samples = match cursor.source.read_samples(cursor.position, sample_count) {
                    Ok(samples) if !samples.is_empty() => samples,
                    Ok(_) => continue,
                    Err(code) => {
                        return settle_live_spawn_failure(
                            self, record_id, generation, &child, code, false,
                        )
                    }
                };
                let end_sample = cursor
                    .position
                    .saturating_add((samples.len() / usize::from(cursor.source.channels())) as u64);
                let mut frame = PcmFrame {
                    channels: cursor.source.channels(),
                    time_span,
                    protocol_version: PROTOCOL_VERSION,
                    worker_generation: generation,
                    track: cursor.track,
                    sequence: cursor.next_sequence,
                    start_sample: cursor.position,
                    samples,
                };
                let send_result = send_pcm_frame(&stdin, &frame);
                frame.samples.zeroize();
                if send_result.is_err() {
                    return settle_live_spawn_failure(
                        self,
                        record_id,
                        generation,
                        &child,
                        "SPEECH_WORKER_PROTOCOL_ERROR",
                        true,
                    );
                }
                let response = read_live_frame_settlement(
                    &responses,
                    &identity,
                    journal,
                    control,
                    &mut next_worker_revision,
                    Some((cursor.track, cursor.next_sequence, end_sample)),
                    None,
                );
                match response {
                    Ok(true) => self.record_store.notify_live_transcript_changed(record_id),
                    Ok(false) => {}
                    Err((code, retryable)) => {
                        return settle_live_spawn_failure(
                            self, record_id, generation, &child, &code, retryable,
                        )
                    }
                }
                cursor.position = end_sample;
                cursor.last_sequence = Some(cursor.next_sequence);
                let Some(next_sequence) = cursor.next_sequence.checked_add(1) else {
                    return settle_live_spawn_failure(
                        self,
                        record_id,
                        generation,
                        &child,
                        "SPEECH_RESOURCE_LIMIT",
                        false,
                    );
                };
                cursor.next_sequence = next_sequence;
                progressed = true;
            }

            if let Some(flush) = snapshot.flush.as_ref() {
                if cursors_reached(&cursors, flush) {
                    if send_worker_command(
                        &stdin,
                        &WorkerCommand::Flush {
                            protocol_version: PROTOCOL_VERSION,
                            identity: identity.clone(),
                        },
                    )
                    .is_err()
                    {
                        return settle_live_spawn_failure(
                            self,
                            record_id,
                            generation,
                            &child,
                            "SPEECH_WORKER_PROTOCOL_ERROR",
                            true,
                        );
                    }
                    match read_live_frame_settlement(
                        &responses,
                        &identity,
                        journal,
                        control,
                        &mut next_worker_revision,
                        None,
                        None,
                    ) {
                        Ok(true) => self.record_store.notify_live_transcript_changed(record_id),
                        Ok(false) => {}
                        Err((code, retryable)) => {
                            return settle_live_spawn_failure(
                                self, record_id, generation, &child, &code, retryable,
                            )
                        }
                    }
                    control.complete_flush(flush);
                    continue;
                }
            } else if let Some(finish) = snapshot.finish.as_ref() {
                if cursors_reached(&cursors, finish) {
                    if cursors.iter().all(|cursor| cursor.last_sequence.is_none()) {
                        let _ = send_worker_command(
                            &stdin,
                            &WorkerCommand::Cancel {
                                protocol_version: PROTOCOL_VERSION,
                                identity: identity.clone(),
                            },
                        );
                        let _ = process_cmd::settle_tree(&child, WORKER_CANCEL_GRACE);
                        self.clear_live_running(record_id);
                        return LiveAttemptOutcome::Finished;
                    }
                    let ends = cursors
                        .iter()
                        .map(|cursor| PcmStreamEnd {
                            track: cursor.track,
                            last_sequence: cursor.last_sequence,
                            final_sample: cursor.position,
                        })
                        .collect();
                    let expected_source_samples =
                        cursors.iter().try_fold(0_u64, |total, cursor| {
                            total.checked_add(
                                cursor.position.saturating_sub(cursor.generation_start),
                            )
                        });
                    let Some(expected_source_samples) = expected_source_samples else {
                        return settle_live_spawn_failure(
                            self,
                            record_id,
                            generation,
                            &child,
                            "SPEECH_RESOURCE_LIMIT",
                            false,
                        );
                    };
                    if send_worker_command(
                        &stdin,
                        &WorkerCommand::Finalize {
                            protocol_version: PROTOCOL_VERSION,
                            identity: identity.clone(),
                            streams: ends,
                        },
                    )
                    .is_err()
                    {
                        return settle_live_spawn_failure(
                            self,
                            record_id,
                            generation,
                            &child,
                            "SPEECH_WORKER_PROTOCOL_ERROR",
                            true,
                        );
                    }
                    match read_live_frame_settlement(
                        &responses,
                        &identity,
                        journal,
                        control,
                        &mut next_worker_revision,
                        None,
                        Some(expected_source_samples),
                    ) {
                        Ok(true) => self.record_store.notify_live_transcript_changed(record_id),
                        Ok(false) => {}
                        Err((code, retryable)) => {
                            return settle_live_spawn_failure(
                                self, record_id, generation, &child, &code, retryable,
                            )
                        }
                    }
                    let _ = process_cmd::settle_tree(&child, WORKER_TERMINAL_GRACE);
                    self.clear_live_running(record_id);
                    return LiveAttemptOutcome::Finished;
                }
            }

            if !progressed {
                thread::sleep(LIVE_POLL_INTERVAL);
            }
        }
    }

    fn spawn_live_worker(
        &self,
        record_id: &str,
        generation: u64,
        resources: &SpeechExecutionResources,
    ) -> Result<SpawnedWorker, &'static str> {
        let private_dir = self.root.join("private").join(format!("live-{record_id}"));
        ensure_private_directory(&private_dir).map_err(|_| "SPEECH_JOB_STORE_WRITE_FAILED")?;
        let mut command = process_cmd::new(&resources.worker_path);
        command
            .current_dir(&private_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        let Some(session) = state.live_sessions.get(record_id) else {
            return Err("SPEECH_INTERRUPTED");
        };
        if !state.accepting || state.live_running.is_some() {
            return Err("SPEECH_INTERRUPTED");
        }
        let snapshot = session
            .control
            .snapshot()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        if snapshot.paused && snapshot.suspend_requested {
            return Err("SPEECH_LIVE_SUSPENDED");
        }
        let mut child =
            process_cmd::spawn_tree(&mut command).map_err(|_| "SPEECH_WORKER_START_FAILED")?;
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        drain_worker_stderr(stderr, record_id.to_string(), generation);
        let child = Arc::new(Mutex::new(child));
        let stdin = Arc::new(Mutex::new(stdin));
        state.live_running = Some(RunningWorker {
            job_id: record_id.to_string(),
            generation,
            child: child.clone(),
            stdin: stdin.clone(),
        });
        Ok((child, stdin, stdout))
    }

    fn clear_live_running(&self, record_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            if state
                .live_running
                .as_ref()
                .is_some_and(|running| running.job_id == record_id)
            {
                state.live_running = None;
            }
        }
    }

    fn remove_live_session(&self, record_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.live_sessions.remove(record_id);
        }
    }

    fn project_live_failure_if_owned(
        &self,
        record_id: &str,
        control: &Arc<LiveControl>,
    ) -> Result<bool, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        let Some(session) = state.live_sessions.get(record_id) else {
            return Ok(false);
        };
        if !Arc::ptr_eq(&session.control, control) {
            return Ok(false);
        }
        let control_state = control
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        if control_state.cancelled || control_state.finish.is_some() {
            return Ok(false);
        }
        tauri::async_runtime::block_on(self.record_store.update_audio_processing_status(
            record_id,
            Some(TranscriptionStatus::Failed),
            None,
        ))?;
        Ok(true)
    }

    pub fn get_agent_job(&self, session_id: &str, job_id: &str) -> Result<SpeechJob, &'static str> {
        validate_session_id(session_id)?;
        validate_job_id(job_id)?;
        self.state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?
            .jobs
            .get(job_id)
            .filter(|job| job.kind.is_agent())
            .filter(|job| job.origin.agent_session_id() == Some(session_id))
            .cloned()
            .map(|mut job| {
                job.output.artifact_available = agent_artifact_is_available(&job);
                job
            })
            .ok_or("SPEECH_JOB_NOT_FOUND")
    }

    pub fn list_agent_jobs(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<SpeechJob>, &'static str> {
        validate_session_id(session_id)?;
        if !(1..=100).contains(&limit) {
            return Err("SPEECH_LIST_LIMIT_INVALID");
        }
        let state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        let mut jobs = state
            .jobs
            .values()
            .filter(|job| job.kind.is_agent())
            .filter(|job| job.origin.agent_session_id() == Some(session_id))
            .cloned()
            .collect::<Vec<_>>();
        jobs.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        jobs.truncate(limit);
        for job in &mut jobs {
            job.output.artifact_available = agent_artifact_is_available(job);
        }
        Ok(jobs)
    }

    pub fn cancel_agent_job(
        self: &Arc<Self>,
        session_id: &str,
        job_id: &str,
    ) -> Result<SpeechJob, &'static str> {
        validate_session_id(session_id)?;
        validate_job_id(job_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        let snapshot = state
            .jobs
            .get(job_id)
            .filter(|job| job.kind.is_agent())
            .filter(|job| job.origin.agent_session_id() == Some(session_id))
            .cloned()
            .ok_or("SPEECH_JOB_NOT_FOUND")?;
        match snapshot.state {
            SpeechJobState::Queued => {
                let mut job = snapshot;
                let now = Utc::now();
                job.state = SpeechJobState::Cancelled;
                job.stage = SpeechJobStage::Publishing;
                job.updated_at = now;
                job.finished_at = Some(now);
                job.error = Some(SpeechJobError {
                    code: "SPEECH_CANCELLED".into(),
                    retryable: false,
                });
                persist_job(&self.root, &job).map_err(|_| "SPEECH_JOB_STORE_WRITE_FAILED")?;
                state.queue.retain(|queued| queued != job_id);
                let pending = state.pending_agent.remove(job_id);
                state.jobs.insert(job_id.to_string(), job.clone());
                drop(state);
                if let Some(pending) = pending {
                    cleanup_pending_agent(&pending);
                }
                emit_attachment_job(
                    &job,
                    SpeechAttachmentOperation::Cancel,
                    AnalyticsOutcome::Canceled,
                    0,
                );
                Ok(job)
            }
            SpeechJobState::Running => {
                let mut job = snapshot;
                job.state = SpeechJobState::Cancelling;
                job.updated_at = Utc::now();
                persist_job(&self.root, &job).map_err(|_| "SPEECH_JOB_STORE_WRITE_FAILED")?;
                let running = state.running.as_ref().map(|running| {
                    (
                        running.generation,
                        Arc::clone(&running.stdin),
                        Arc::clone(&running.child),
                    )
                });
                state.jobs.insert(job_id.to_string(), job.clone());
                drop(state);
                if let Some((generation, stdin, child)) = running {
                    let _ = send_worker_command(
                        &stdin,
                        &WorkerCommand::Cancel {
                            protocol_version: PROTOCOL_VERSION,
                            identity: WorkloadIdentity {
                                workload_id: job_id.to_string(),
                                worker_generation: generation,
                            },
                        },
                    );
                    let manager = Arc::clone(self);
                    let id = job_id.to_string();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(WORKER_CANCEL_GRACE).await;
                        if manager.job_is_cancelling_generation(&id, generation) {
                            if let Ok(mut child) = child.lock() {
                                let _ = child.kill_and_wait();
                            }
                        }
                    });
                }
                Ok(job)
            }
            SpeechJobState::Cancelling | SpeechJobState::Cancelled => Ok(snapshot),
            SpeechJobState::Succeeded
            | SpeechJobState::SucceededWithWarnings
            | SpeechJobState::Failed
            | SpeechJobState::Interrupted => Err("SPEECH_JOB_NOT_CANCELLABLE"),
        }
    }

    pub fn shutdown(&self) -> Result<(), String> {
        self.model_pack.cancel_operation();
        let (snapshots, running, live_running, pending_agent) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "speech manager lock poisoned".to_string())?;
            state.accepting = false;
            state.active_job = None;
            state.queue.clear();
            let pending_agent = std::mem::take(&mut state.pending_agent);
            let running = state.running.take();
            let live_running = state.live_running.take();
            for session in state.live_sessions.values() {
                if let Ok(mut control) = session.control.state.lock() {
                    if let Some(timer) = control.pause_timer.take() {
                        timer.abort();
                    }
                    control.cancelled = true;
                }
            }
            let now = Utc::now();
            let mut snapshots = Vec::new();
            for job in state
                .jobs
                .values_mut()
                .filter(|job| !job.state.is_terminal())
            {
                settle_for_process_boundary(job, now);
                snapshots.push(job.clone());
            }
            (snapshots, running, live_running, pending_agent)
        };
        if let Some(running) = running {
            let identity = WorkloadIdentity {
                workload_id: running.job_id.clone(),
                worker_generation: running.generation,
            };
            let _ = send_worker_command(
                &running.stdin,
                &WorkerCommand::Cancel {
                    protocol_version: PROTOCOL_VERSION,
                    identity,
                },
            );
            let _ = process_cmd::settle_tree(&running.child, WORKER_SHUTDOWN_GRACE);
        }
        if let Some(running) = live_running {
            let identity = WorkloadIdentity {
                workload_id: running.job_id.clone(),
                worker_generation: running.generation,
            };
            let _ = send_worker_command(
                &running.stdin,
                &WorkerCommand::Cancel {
                    protocol_version: PROTOCOL_VERSION,
                    identity,
                },
            );
            let _ = process_cmd::settle_tree(&running.child, WORKER_SHUTDOWN_GRACE);
        }
        for job in snapshots {
            persist_job(&self.root, &job)?;
        }
        for pending in pending_agent.into_values() {
            cleanup_pending_agent(&pending);
        }
        self.wake.notify_waiters();
        Ok(())
    }

    pub(crate) fn has_pending_work(&self) -> Result<bool, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "UPDATE_ACTIVITY_UNKNOWN".to_string())?;
        Ok(!state.queue.is_empty()
            || !state.pending_agent.is_empty()
            || state.agent_admission_reservations > 0
            || state.active_job.is_some()
            || state.running.is_some()
            || !state.live_sessions.is_empty()
            || state.live_running.is_some())
    }

    pub fn queue_snapshot(&self) -> Result<Vec<String>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "speech manager lock poisoned".to_string())?;
        let _next_generation = state.next_generation;
        Ok(state.queue.iter().cloned().collect())
    }

    pub fn active_compute_workload(&self) -> Option<String> {
        self.compute_coordinator
            .active_identity()
            .map(|identity| identity.id)
    }

    pub fn model_pack_status(&self) -> SpeechModelPackStatus {
        self.model_pack.status()
    }

    pub async fn install_model_pack(self: &Arc<Self>) -> Result<SpeechModelPackStatus, String> {
        let before = self.model_pack.status();
        let operation = if before.last_error_code.is_some() {
            SpeechResourceOperation::Retry
        } else if before.usable
            && before.active_revision.as_deref() != Some(before.available_revision.as_str())
        {
            SpeechResourceOperation::Update
        } else {
            SpeechResourceOperation::Download
        };
        let started = Instant::now();
        let result = self.model_pack.install().await;
        emit_resource_mutation(operation, &before, &result, elapsed_ms(started));
        result
    }

    pub fn remove_model_pack(&self) -> Result<SpeechModelPackStatus, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        let in_use = state.jobs.values().any(|job| !job.state.is_terminal())
            || state.running.is_some()
            || state.active_job.is_some()
            || !state.live_sessions.is_empty()
            || state.live_running.is_some();
        let before = self.model_pack.status();
        let started = Instant::now();
        let result = self.model_pack.remove(in_use);
        emit_resource_mutation(
            SpeechResourceOperation::Remove,
            &before,
            &result,
            elapsed_ms(started),
        );
        result
    }

    pub fn record_root(&self) -> &Path {
        self.record_store.root_dir()
    }

    async fn run_queue(self: Arc<Self>) {
        let recovering = Arc::clone(&self);
        let recovered =
            tauri::async_runtime::spawn_blocking(move || recovering.recover_record_processing())
                .await;
        if !matches!(recovered, Ok(Ok(()))) {
            crate::ulog_error!("[speech] Record processing recovery failed");
            return;
        }
        self.wake.notify_one();
        loop {
            self.wake.notified().await;
            loop {
                let next = match self.peek_next_job() {
                    Ok(next) => next,
                    Err(error) => {
                        crate::ulog_error!("[speech] queue state error: {}", error);
                        break;
                    }
                };
                let Some((candidate, generation_hint)) = next else {
                    break;
                };
                let compute = ComputeWorkloadIdentity {
                    kind: compute_kind(candidate.kind),
                    id: candidate.job_id.clone(),
                    generation: generation_hint,
                };
                let mut admission = Box::pin(self.compute_coordinator.acquire(compute));
                let lease = loop {
                    tokio::select! {
                        lease = admission.as_mut() => break Some(lease),
                        _ = self.wake.notified() => {
                            let still_selected = self.peek_next_job().ok().flatten().is_some_and(
                                |(selected, selected_generation)| {
                                    selected.job_id == candidate.job_id
                                        && selected_generation == generation_hint
                                },
                            );
                            if !still_selected {
                                break None;
                            }
                        }
                    }
                };
                let Some(lease) = lease else {
                    continue;
                };
                let next = match self.claim_next_job(&candidate.job_id, generation_hint) {
                    Ok(next) => next,
                    Err(error) => {
                        drop(lease);
                        crate::ulog_error!("[speech] queue claim error: {}", error);
                        break;
                    }
                };
                let Some((job, generation)) = next else {
                    drop(lease);
                    continue;
                };
                let resources = self.execution_resources_for_pipeline(&job.pipeline);
                let manager = Arc::clone(&self);
                let job_id = job.job_id.clone();
                let result = match resources {
                    Ok(resources) => {
                        if !self.job_can_execute(&job_id, generation) {
                            drop(lease);
                            self.clear_active(&job_id, generation);
                            continue;
                        }
                        tauri::async_runtime::spawn_blocking(move || {
                            manager.execute_record_job(&job, generation, resources, lease)
                        })
                        .await
                    }
                    Err(code) => {
                        drop(lease);
                        tauri::async_runtime::spawn_blocking(move || {
                            manager.finish_failed(&job, generation, code, false)
                        })
                        .await
                    }
                };
                if let Err(error) = result {
                    let manager = Arc::clone(&self);
                    let failed_job_id = job_id.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        manager.finish_join_failure(&failed_job_id, generation)
                    })
                    .await;
                    crate::ulog_error!("[speech] Worker join failed: {}", error);
                }
                self.clear_active(&job_id, generation);
            }
        }
    }

    fn peek_next_job(&self) -> Result<Option<(SpeechJob, u64)>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "speech manager lock poisoned".to_string())?;
        if !state.accepting || state.active_job.is_some() {
            return Ok(None);
        }
        if state.queue.iter().any(|job_id| {
            !state
                .jobs
                .get(job_id)
                .is_some_and(|job| job.state == SpeechJobState::Queued)
        }) {
            return Err("speech queue contains an ineligible job".to_string());
        }
        let Some((_, job)) = state
            .queue
            .iter()
            .enumerate()
            .filter_map(|(index, job_id)| state.jobs.get(job_id).map(|job| (index, job)))
            .max_by(|(left_index, left), (right_index, right)| {
                compute_kind(left.kind)
                    .priority()
                    .cmp(&compute_kind(right.kind).priority())
                    .then_with(|| right_index.cmp(left_index))
            })
        else {
            return Ok(None);
        };
        Ok(Some((job.clone(), state.next_generation)))
    }

    fn claim_next_job(
        &self,
        expected_job_id: &str,
        expected_generation: u64,
    ) -> Result<Option<(SpeechJob, u64)>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "speech manager lock poisoned".to_string())?;
        if !state.accepting || state.active_job.is_some() {
            return Ok(None);
        }
        if state.next_generation != expected_generation {
            return Ok(None);
        }
        if state.queue.iter().any(|job_id| {
            !state
                .jobs
                .get(job_id)
                .is_some_and(|job| job.state == SpeechJobState::Queued)
        }) {
            return Err("speech queue contains an ineligible job".to_string());
        }
        let Some((queue_index, job_id)) = state
            .queue
            .iter()
            .enumerate()
            .filter_map(|(index, job_id)| state.jobs.get(job_id).map(|job| (index, job_id, job)))
            .max_by(|(left_index, _, left), (right_index, _, right)| {
                compute_kind(left.kind)
                    .priority()
                    .cmp(&compute_kind(right.kind).priority())
                    .then_with(|| right_index.cmp(left_index))
            })
            .map(|(index, job_id, _)| (index, job_id.clone()))
        else {
            return Ok(None);
        };
        if job_id != expected_job_id {
            return Ok(None);
        }
        let generation = state.next_generation;
        let now = Utc::now();
        let mut job = state
            .jobs
            .get(&job_id)
            .cloned()
            .ok_or_else(|| "queued speech job is missing".to_string())?;
        if job.state != SpeechJobState::Queued {
            return Err("speech queue contains an ineligible job".to_string());
        }
        job.state = SpeechJobState::Running;
        job.stage = SpeechJobStage::Validating;
        job.started_at = Some(now);
        job.updated_at = now;
        job.finished_at = None;
        job.worker_generation = Some(generation);
        job.worker_attempts = job.worker_attempts.saturating_add(1);
        job.error = None;
        persist_job(&self.root, &job)?;
        state.queue.remove(queue_index);
        state.jobs.insert(job_id.clone(), job.clone());
        state.active_job = Some((job_id, generation));
        log_record_job(&job, "started");
        state.next_generation = state.next_generation.saturating_add(1).max(1);
        Ok(Some((job, generation)))
    }

    fn execute_record_job(
        self: &Arc<Self>,
        job: &SpeechJob,
        generation: u64,
        resources: SpeechExecutionResources,
        lease: LocalComputeLease,
    ) {
        if job.kind == SpeechJobKind::AgentAttachmentAsr {
            self.execute_agent_job(job, generation, resources, lease);
            return;
        }
        let adopted = match self.bind_legacy_record_processing(job, generation, &resources) {
            Ok(job) => job,
            Err(code) => {
                self.finish_failed(job, generation, code, false);
                return;
            }
        };
        let job = &adopted;
        let frozen = match record_processing::read_input(&self.root, job) {
            Ok(input) => input,
            Err(code) => {
                self.finish_failed(job, generation, code, false);
                return;
            }
        };
        let runtime = self
            .runtime_registry
            .identity(InferenceRuntimeKind::OnnxCpu);
        if !runtime.is_ok_and(|runtime| frozen.runtime_sha256 == runtime.sha256())
            || frozen.pipeline != pipeline_from_provenance(&resources.provenance)
            || record_processing::small_file_sha256(&resources.model_pack_manifest_path).as_ref()
                != Ok(&frozen.model_manifest_sha256)
        {
            self.finish_failed(
                job,
                generation,
                "SPEECH_PIPELINE_REVISION_UNAVAILABLE",
                false,
            );
            return;
        }
        if let Err(code) = self.update_record_running_status(job, generation) {
            self.finish_failed(job, generation, code, true);
            return;
        }
        let input = match self.resolve_record_worker_input(job, generation) {
            Ok(input) => input,
            Err(code) => {
                self.finish_failed(job, generation, code, false);
                return;
            }
        };
        let expected_record_transcript_track = if matches!(
            job.kind,
            SpeechJobKind::RecordBackfillAsr | SpeechJobKind::RecordDiarization
        ) {
            match expected_record_backfill_tracks(&input) {
                Ok(track) => Some(track),
                Err(code) => {
                    self.finish_failed(job, generation, code, false);
                    return;
                }
            }
        } else {
            None
        };
        let lifecycle_spawn_permit = match crate::sidecar::begin_lifecycle_spawn_permit() {
            Ok(permit) => permit,
            Err(_) => {
                self.finish_interrupted_if_needed(job, generation);
                return;
            }
        };
        let (child, stdin, stdout) = match self.spawn_registered_worker(job, generation, &resources)
        {
            Ok(worker) => worker,
            Err(code) => {
                self.finish_failed(job, generation, code, true);
                return;
            }
        };
        drop(lifecycle_spawn_permit);

        let identity = WorkloadIdentity {
            workload_id: job.job_id.clone(),
            worker_generation: generation,
        };
        let start = WorkerCommand::Start(StartRequest {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            workload_kind: protocol_workload_kind(job.kind),
            input,
            native_manifest_path: match path_for_protocol(&resources.native_manifest_path) {
                Ok(path) => path,
                Err(code) => {
                    kill_worker(&child);
                    self.clear_running(&job.job_id, generation);
                    self.finish_failed(job, generation, code, false);
                    return;
                }
            },
            onnx_runtime_path: match path_for_protocol(&resources.onnx_runtime_path) {
                Ok(path) => path,
                Err(code) => {
                    kill_worker(&child);
                    self.clear_running(&job.job_id, generation);
                    self.finish_failed(job, generation, code, false);
                    return;
                }
            },
            model_pack_manifest_path: match path_for_protocol(&resources.model_pack_manifest_path) {
                Ok(path) => path,
                Err(code) => {
                    kill_worker(&child);
                    self.clear_running(&job.job_id, generation);
                    self.finish_failed(job, generation, code, false);
                    return;
                }
            },
        });
        if send_worker_command(&stdin, &start).is_err() {
            kill_worker(&child);
            self.clear_running(&job.job_id, generation);
            self.finish_failed(job, generation, "SPEECH_WORKER_PROTOCOL_ERROR", true);
            return;
        }

        let yield_state = BatchYieldState::new();
        let outcome = self.collect_worker_result(
            job,
            generation,
            &identity,
            expected_record_transcript_track,
            stdout,
            &stdin,
            &child,
            &lease,
            &yield_state,
        );
        yield_state.finish_reading();
        if outcome.needs_cancel() {
            let _ = send_worker_command(
                &stdin,
                &WorkerCommand::Cancel {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                },
            );
        }
        let _ = process_cmd::settle_tree(&child, outcome.settlement_grace());
        yield_state.mark_settled();
        self.clear_running(&job.job_id, generation);
        if !self.job_can_publish(&job.job_id, generation) {
            return;
        }
        match outcome {
            SpeechWorkerOutcome::Completed(completion) => {
                self.publish_record_success(job, generation, &resources.provenance, completion)
            }
            SpeechWorkerOutcome::Yielded => self.requeue_yielded(job, generation),
            SpeechWorkerOutcome::Failed {
                code, retryable, ..
            } => self.finish_failed(job, generation, &code, retryable),
        }
    }

    fn execute_agent_job(
        self: &Arc<Self>,
        job: &SpeechJob,
        generation: u64,
        resources: SpeechExecutionResources,
        lease: LocalComputeLease,
    ) {
        let mut pending = match self.take_pending_agent(&job.job_id, generation) {
            Ok(pending) => pending,
            Err(code) => {
                self.finish_failed(job, generation, code, false);
                return;
            }
        };
        self.update_worker_stage(&job.job_id, generation, WorkerStage::Decoding);
        let (input_path, source_hash) = match pending.prepared_source.clone() {
            Some(prepared) => prepared,
            None => {
                let input_path = pending.private_dir.join("source.media");
                let source_hash = match copy_agent_source(
                    pending.source.as_file_mut(),
                    &input_path,
                    job.source.size_bytes,
                    &pending.source_version,
                    || {
                        if !self.job_can_execute(&job.job_id, generation) {
                            Err("SPEECH_CANCELLED")
                        } else if lease.should_yield() {
                            Err("SPEECH_YIELDED")
                        } else {
                            Ok(())
                        }
                    },
                ) {
                    Ok(hash) => hash,
                    Err(code) => {
                        if code == "SPEECH_YIELDED" {
                            let _ = fs::remove_file(&input_path);
                            self.restore_pending_agent(&job.job_id, generation, pending);
                            self.requeue_yielded(job, generation);
                        } else if code == "SPEECH_CANCELLED" {
                            self.finish_cancelled_if_needed(job, generation);
                            cleanup_pending_agent(&pending);
                        } else {
                            self.finish_agent_failure(
                                job,
                                generation,
                                &code,
                                worker_code_retryable(&code),
                                pending,
                            );
                        }
                        return;
                    }
                };
                pending.prepared_source = Some((input_path.clone(), source_hash.clone()));
                (input_path, source_hash)
            }
        };
        self.update_agent_source_hash(&job.job_id, generation, source_hash);
        let input = match path_for_protocol(&input_path) {
            Ok(input_path) => WorkloadInput::Attachment { input_path },
            Err(code) => {
                self.finish_failed(job, generation, code, false);
                cleanup_pending_agent(&pending);
                return;
            }
        };
        let identity = WorkloadIdentity {
            workload_id: job.job_id.clone(),
            worker_generation: generation,
        };
        let start = WorkerCommand::Start(StartRequest {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            workload_kind: WorkloadKind::AttachmentAsr,
            input,
            native_manifest_path: resources
                .native_manifest_path
                .to_string_lossy()
                .into_owned(),
            onnx_runtime_path: resources.onnx_runtime_path.to_string_lossy().into_owned(),
            model_pack_manifest_path: resources
                .model_pack_manifest_path
                .to_string_lossy()
                .into_owned(),
        });
        let (child, stdin, stdout) = match self.spawn_registered_worker(job, generation, &resources)
        {
            Ok(worker) => worker,
            Err(code) => {
                self.finish_agent_failure(job, generation, code, true, pending);
                return;
            }
        };
        if send_worker_command(&stdin, &start).is_err() {
            kill_worker(&child);
            self.clear_running(&job.job_id, generation);
            self.finish_agent_failure(
                job,
                generation,
                "SPEECH_WORKER_PROTOCOL_ERROR",
                true,
                pending,
            );
            return;
        }
        let yield_state = BatchYieldState::new();
        let outcome = self.collect_worker_result(
            job,
            generation,
            &identity,
            None,
            stdout,
            &stdin,
            &child,
            &lease,
            &yield_state,
        );
        yield_state.finish_reading();
        if outcome.needs_cancel() {
            let _ = send_worker_command(
                &stdin,
                &WorkerCommand::Cancel {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                },
            );
        }
        let _ = process_cmd::settle_tree(&child, outcome.settlement_grace());
        yield_state.mark_settled();
        self.clear_running(&job.job_id, generation);
        if self.job_is_cancelling_generation(&job.job_id, generation) {
            self.finish_cancelled_if_needed(job, generation);
            cleanup_pending_agent(&pending);
            return;
        }
        if !self.job_can_publish(&job.job_id, generation) {
            cleanup_pending_agent(&pending);
            return;
        }
        match outcome {
            SpeechWorkerOutcome::Completed(SpeechWorkerCompletion {
                transcripts,
                turns,
                identity_evidence,
                metrics,
            }) if turns.is_empty() && identity_evidence.is_empty() => {
                let published = self.publish_agent_success(
                    job,
                    generation,
                    &resources.provenance,
                    transcripts,
                    metrics,
                    &pending,
                );
                if published {
                    cleanup_agent_private_input(&pending);
                } else {
                    cleanup_pending_agent(&pending);
                }
            }
            SpeechWorkerOutcome::Completed(_) => {
                self.finish_agent_failure(
                    job,
                    generation,
                    "SPEECH_WORKER_PROTOCOL_ERROR",
                    true,
                    pending,
                );
            }
            SpeechWorkerOutcome::Yielded => {
                self.restore_pending_agent(&job.job_id, generation, pending);
                self.requeue_yielded(job, generation);
            }
            SpeechWorkerOutcome::Failed {
                code, retryable, ..
            } => {
                self.finish_agent_failure(job, generation, &code, retryable, pending);
            }
        }
    }

    fn take_pending_agent(
        &self,
        job_id: &str,
        generation: u64,
    ) -> Result<PendingAgentJob, &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        if !exact_running_generation(&state, job_id, generation) {
            return Err("SPEECH_INTERRUPTED");
        }
        state
            .pending_agent
            .remove(job_id)
            .ok_or("SPEECH_PRIVATE_INPUT_UNAVAILABLE")
    }

    fn restore_pending_agent(&self, job_id: &str, generation: u64, pending: PendingAgentJob) {
        if let Ok(mut state) = self.state.lock() {
            if exact_running_generation(&state, job_id, generation) {
                state.pending_agent.insert(job_id.to_string(), pending);
            } else {
                drop(state);
                cleanup_pending_agent(&pending);
            }
        } else {
            cleanup_pending_agent(&pending);
        }
    }

    fn finish_agent_failure(
        &self,
        job: &SpeechJob,
        generation: u64,
        code: &str,
        retryable: bool,
        pending: PendingAgentJob,
    ) {
        let will_retry = self.state.lock().ok().is_some_and(|state| {
            retryable
                && state.accepting
                && exact_running_generation(&state, &job.job_id, generation)
                && state
                    .jobs
                    .get(&job.job_id)
                    .is_some_and(|current| current.worker_attempts < MAX_WORKER_ATTEMPTS)
        });
        if will_retry {
            self.restore_pending_agent(&job.job_id, generation, pending);
        } else {
            cleanup_pending_agent(&pending);
        }
        self.finish_failed(job, generation, code, retryable);
    }

    fn update_agent_source_hash(&self, job_id: &str, generation: u64, sha256: String) {
        let snapshot = if let Ok(mut state) = self.state.lock() {
            state.jobs.get_mut(job_id).and_then(|job| {
                (job.kind.is_agent()
                    && job.state == SpeechJobState::Running
                    && job.worker_generation == Some(generation))
                .then(|| {
                    job.source.sha256 = Some(sha256);
                    job.stage = SpeechJobStage::Decoding;
                    job.updated_at = Utc::now();
                    job.clone()
                })
            })
        } else {
            None
        };
        if let Some(snapshot) = snapshot {
            let _ = persist_job(&self.root, &snapshot);
        }
    }

    fn update_agent_media_probe(
        &self,
        job_id: &str,
        generation: u64,
        media_kind: String,
        codec: String,
        duration_ms: Option<u64>,
        used_default_track: bool,
    ) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        let current = state
            .jobs
            .get(job_id)
            .filter(|job| {
                job.kind.is_agent()
                    && job.state == SpeechJobState::Running
                    && job.worker_generation == Some(generation)
                    && job.source.media_kind.as_deref() == Some(media_kind.as_str())
                    && job.source.codec.as_deref() == Some(codec.as_str())
                    && job.source.duration_ms == duration_ms
                    && job.source.used_default_track == Some(used_default_track)
            })
            .ok_or("SPEECH_WORKER_PROTOCOL_ERROR")?;
        let mut snapshot = current.clone();
        snapshot.stage = SpeechJobStage::Transcribing;
        snapshot.updated_at = Utc::now();
        persist_job(&self.root, &snapshot).map_err(|_| "SPEECH_JOB_STORE_WRITE_FAILED")?;
        state.jobs.insert(job_id.to_string(), snapshot);
        Ok(())
    }

    fn job_is_cancelling_generation(&self, job_id: &str, generation: u64) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state.active_job.as_ref() == Some(&(job_id.to_string(), generation))
                && state.jobs.get(job_id).is_some_and(|job| {
                    job.state == SpeechJobState::Cancelling
                        && job.worker_generation == Some(generation)
                })
        })
    }

    fn finish_cancelled_if_needed(&self, source_job: &SpeechJob, generation: u64) {
        let snapshot = if let Ok(mut state) = self.state.lock() {
            let active_matches =
                state.active_job.as_ref() == Some(&(source_job.job_id.clone(), generation));
            if !active_matches {
                None
            } else {
                state.jobs.get_mut(&source_job.job_id).and_then(|job| {
                    matches!(
                        job.state,
                        SpeechJobState::Running | SpeechJobState::Cancelling
                    )
                    .then(|| {
                        let now = Utc::now();
                        job.state = SpeechJobState::Cancelled;
                        job.stage = SpeechJobStage::Publishing;
                        job.updated_at = now;
                        job.finished_at = Some(now);
                        job.error = Some(SpeechJobError {
                            code: "SPEECH_CANCELLED".into(),
                            retryable: false,
                        });
                        job.clone()
                    })
                })
            }
        } else {
            None
        };
        if let Some(snapshot) = snapshot {
            let _ = persist_job(&self.root, &snapshot);
        }
    }

    fn publish_agent_success(
        &self,
        source_job: &SpeechJob,
        generation: u64,
        provenance: &RecordSpeechProvenance,
        transcripts: SensitiveTranscriptSegments,
        metrics: WorkerMetrics,
        pending: &PendingAgentJob,
    ) -> bool {
        let publication_job = self.state.lock().ok().and_then(|state| {
            exact_running_generation(&state, &source_job.job_id, generation)
                .then(|| state.jobs.get(&source_job.job_id).cloned())
                .flatten()
        });
        let Some(publication_job) = publication_job else {
            return false;
        };
        if write_agent_artifacts(
            &pending.staging_dir,
            &publication_job,
            provenance,
            &transcripts.0,
        )
        .is_err()
        {
            self.finish_failed(source_job, generation, "SPEECH_PUBLISH_FAILED", false);
            return false;
        }

        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return false,
        };
        if !exact_running_generation(&state, &source_job.job_id, generation)
            || validate_agent_publish_paths(&publication_job, pending).is_err()
        {
            return false;
        }
        let Some(mut publishing_job) = state.jobs.get(&source_job.job_id).cloned() else {
            return false;
        };
        publishing_job.stage = SpeechJobStage::Publishing;
        publishing_job.updated_at = Utc::now();
        if persist_job(&self.root, &publishing_job).is_err() {
            finish_job_locked(
                &self.root,
                &mut state,
                &source_job.job_id,
                generation,
                SpeechJobState::Failed,
                Some(SpeechJobError {
                    code: "SPEECH_JOB_STORE_WRITE_FAILED".into(),
                    retryable: false,
                }),
                None,
            );
            return false;
        }
        state
            .jobs
            .insert(source_job.job_id.clone(), publishing_job.clone());
        let destination = PathBuf::from(
            publication_job
                .output
                .job_directory
                .as_deref()
                .expect("Agent jobs reserve a destination"),
        );
        let intent = AgentPublishIntent {
            schema_version: 1,
            job_id: source_job.job_id.clone(),
            staging_directory: pending.staging_dir.to_string_lossy().into_owned(),
            destination_directory: destination.to_string_lossy().into_owned(),
            staging_token: pending.staging_token.clone(),
        };
        if persist_agent_publish_intent(&self.root, &intent).is_err()
            || publish_agent_staging(pending, &destination).is_err()
        {
            let rolled_back = rollback_agent_publish(
                &destination,
                &pending.staging_dir,
                &pending.staging_identity,
                &pending.staging_token,
            );
            if rolled_back || validate_agent_staging(pending).is_ok() || !destination.exists() {
                let _ = clear_agent_publish_intent(&self.root, &source_job.job_id);
            }
            finish_job_locked(
                &self.root,
                &mut state,
                &source_job.job_id,
                generation,
                SpeechJobState::Failed,
                Some(SpeechJobError {
                    code: "SPEECH_PUBLISH_FAILED".into(),
                    retryable: false,
                }),
                None,
            );
            return false;
        }
        let job_metrics = SpeechJobMetrics {
            source_samples: metrics.source_samples,
            segments: metrics.segments,
            speakers: 0,
            elapsed_ms: metrics.elapsed_ms,
            peak_working_bytes: metrics.peak_working_bytes,
        };
        let used_default_track = state
            .jobs
            .get(&source_job.job_id)
            .and_then(|job| job.source.used_default_track)
            .unwrap_or(false);
        let Some(mut terminal_job) = state.jobs.get(&source_job.job_id).cloned() else {
            let _ = rollback_agent_publish(
                &destination,
                &pending.staging_dir,
                &pending.staging_identity,
                &pending.staging_token,
            );
            return false;
        };
        let now = Utc::now();
        terminal_job.state = if used_default_track {
            SpeechJobState::Succeeded
        } else {
            SpeechJobState::SucceededWithWarnings
        };
        terminal_job.stage = SpeechJobStage::Publishing;
        terminal_job.updated_at = now;
        terminal_job.finished_at = Some(now);
        terminal_job.error = (!used_default_track).then_some(SpeechJobError {
            code: "SPEECH_DEFAULT_AUDIO_TRACK_MISSING".into(),
            retryable: false,
        });
        terminal_job.metrics = Some(job_metrics);
        terminal_job.output.artifact_available = true;
        if persist_job_resolving_unknown(&self.root, &terminal_job).is_err() {
            if rollback_agent_publish(
                &destination,
                &pending.staging_dir,
                &pending.staging_identity,
                &pending.staging_token,
            ) {
                let _ = clear_agent_publish_intent(&self.root, &source_job.job_id);
            }
            finish_job_locked(
                &self.root,
                &mut state,
                &source_job.job_id,
                generation,
                SpeechJobState::Failed,
                Some(SpeechJobError {
                    code: "SPEECH_PUBLISH_FAILED".into(),
                    retryable: false,
                }),
                None,
            );
            return false;
        }
        emit_speech_terminal(&terminal_job);
        state.jobs.insert(source_job.job_id.clone(), terminal_job);

        let cleanup_durable = validate_agent_directory(
            &destination,
            &pending.staging_identity,
            &pending.staging_token,
        )
        .is_ok()
            && fs::remove_file(destination.join(AGENT_STAGING_MARKER))
                .and_then(|_| crate::durable_fs::sync_directory(&destination))
                .is_ok();
        if cleanup_durable {
            let _ = clear_agent_publish_intent(&self.root, &source_job.job_id);
        }
        true
    }

    fn resolve_record_worker_input(
        &self,
        job: &SpeechJob,
        generation: u64,
    ) -> Result<WorkloadInput, &'static str> {
        if !self.job_can_execute(&job.job_id, generation) {
            return Err("SPEECH_INTERRUPTED");
        }
        let SpeechJobOrigin::Record { record_id } = &job.origin else {
            return Err("SPEECH_WORKLOAD_NOT_READY");
        };
        if job.processing_id.is_some() {
            let frozen = record_processing::read_input(&self.root, job)?;
            tauri::async_runtime::block_on(
                self.record_store
                    .validate_speech_processing_input(&frozen.baseline),
            )
            .map_err(|_| "SPEECH_SOURCE_CHANGED")?;
        }
        let record = tauri::async_runtime::block_on(self.record_store.get(record_id))
            .ok_or("SPEECH_RECORD_NOT_FOUND")?;
        let audio = record
            .audio
            .as_ref()
            .filter(|_| record.kind == RecordKind::Audio)
            .ok_or("SPEECH_RECORD_AUDIO_UNAVAILABLE")?;
        if job.kind == SpeechJobKind::AgentAttachmentAsr {
            return Err("SPEECH_WORKLOAD_NOT_READY");
        }
        let mut selected = [AudioTrackKind::Microphone, AudioTrackKind::System]
            .into_iter()
            .filter(|track| audio.tracks.contains(track))
            .collect::<Vec<_>>();
        if selected.is_empty() && audio.tracks.contains(&AudioTrackKind::Mixed) {
            selected.push(AudioTrackKind::Mixed);
        }
        if selected.is_empty() {
            return Err("SPEECH_NO_AUDIO_TRACK");
        }
        let mut total_size = 0_u64;
        let mut inputs = Vec::with_capacity(selected.len());
        for track in selected {
            let media = tauri::async_runtime::block_on(
                self.record_store
                    .resolve_record_media_for_processing(record_id, track),
            )
            .map_err(|code| {
                if code == "SPEECH_CAPTURE_TIME_UNAVAILABLE" {
                    "SPEECH_CAPTURE_TIME_UNAVAILABLE"
                } else {
                    "SPEECH_SOURCE_UNSAFE"
                }
            })?;
            total_size = total_size
                .checked_add(media.size_bytes)
                .ok_or("SPEECH_MEDIA_LIMIT_EXCEEDED")?;
            inputs.push(RecordArtifactInput {
                timeline: media.timeline,
                input_path: path_for_protocol(&media.path)?,
                track: protocol_track(track)?,
            });
        }
        if total_size == 0 || total_size > job.source.size_bytes {
            return Err("SPEECH_SOURCE_CHANGED");
        }
        let identity_anchors = if job.kind == SpeechJobKind::RecordDiarization {
            Some(record_processing::worker_anchors(&self.root, job)?)
        } else {
            None
        };
        Ok(WorkloadInput::RecordArtifacts {
            inputs,
            identity_anchors,
        })
    }

    fn spawn_registered_worker(
        &self,
        job: &SpeechJob,
        generation: u64,
        resources: &SpeechExecutionResources,
    ) -> Result<SpawnedWorker, &'static str> {
        let private_dir = self.root.join("private").join(&job.job_id);
        ensure_private_directory(&private_dir).map_err(|_| "SPEECH_JOB_STORE_WRITE_FAILED")?;
        let mut command = process_cmd::new(&resources.worker_path);
        command
            .current_dir(&private_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();

        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        if !state.accepting
            || !state
                .active_job
                .as_ref()
                .is_some_and(|active| active == &(job.job_id.clone(), generation))
            || !state.jobs.get(&job.job_id).is_some_and(|current| {
                current.state == SpeechJobState::Running
                    && current.worker_generation == Some(generation)
            })
        {
            return Err("SPEECH_INTERRUPTED");
        }
        let mut child =
            process_cmd::spawn_tree(&mut command).map_err(|_| "SPEECH_WORKER_START_FAILED")?;
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        drain_worker_stderr(stderr, job.job_id.clone(), generation);
        let child = Arc::new(Mutex::new(child));
        let stdin = Arc::new(Mutex::new(stdin));
        state.running = Some(RunningWorker {
            job_id: job.job_id.clone(),
            generation,
            child: Arc::clone(&child),
            stdin: Arc::clone(&stdin),
        });
        Ok((child, stdin, stdout))
    }

    #[allow(clippy::too_many_arguments)]
    fn collect_worker_result(
        &self,
        job: &SpeechJob,
        generation: u64,
        identity: &WorkloadIdentity,
        expected_record_transcript_track: Option<Vec<AudioTrackKind>>,
        stdout: ChildStdout,
        stdin: &Arc<Mutex<std::process::ChildStdin>>,
        child: &Arc<Mutex<process_cmd::ChildTree>>,
        lease: &LocalComputeLease,
        yield_state: &BatchYieldState,
    ) -> SpeechWorkerOutcome {
        let responses = start_batch_response_reader(stdout, identity.clone());
        let started_at = Instant::now();
        let mut overall_deadline = MAX_AGENT_DEADLINE;
        let mut ready = false;
        let mut media_probed = false;
        if protocol_workload_kind(job.kind).can_cooperatively_yield() {
            arm_batch_yield_observer(
                lease.yield_signal(),
                stdin,
                child,
                identity,
                &yield_state.sent,
                &yield_state.settled,
            );
        }
        let mut transcripts = SensitiveTranscriptSegments::default();
        let mut turns = Vec::<RecordSpeakerTurn>::new();
        let mut transcript_characters = 0_usize;
        let mut next_transcript_revision = 1_u64;
        let mut speaker_revision = None;
        let mut next_speaker_batch = 0_u32;
        let mut speaker_last_seen = false;
        let mut identity_evidence = Vec::<PersonMatchEvidence>::new();
        let mut identity_last_seen = false;
        let mut next_identity_batch = 0_u32;
        let expected_people = if job.kind == SpeechJobKind::RecordDiarization {
            match record_processing::read_input(&self.root, job) {
                Ok(input) => input
                    .baseline
                    .person_anchors
                    .keys()
                    .copied()
                    .collect::<Vec<_>>(),
                Err(code) => return failed_outcome(code, false),
            }
        } else {
            Vec::new()
        };

        loop {
            let elapsed = started_at.elapsed();
            if elapsed >= overall_deadline {
                kill_worker(child);
                return failed_outcome("SPEECH_DEADLINE_EXCEEDED", false);
            }
            let response_timeout = BATCH_WORKER_RESPONSE_TIMEOUT.min(overall_deadline - elapsed);
            let response = match responses.recv_timeout(response_timeout) {
                Ok(Ok(Some(response))) => response,
                Ok(Ok(None) | Err(_)) | Err(std_mpsc::RecvTimeoutError::Disconnected)
                    if yield_state.sent.load(std::sync::atomic::Ordering::Acquire) =>
                {
                    return SpeechWorkerOutcome::Yielded;
                }
                Ok(Ok(None)) => return failed_outcome("SPEECH_WORKER_CRASHED", true),
                Ok(Err(code)) => return failed_outcome(code, true),
                Err(std_mpsc::RecvTimeoutError::Disconnected) => {
                    return failed_outcome("SPEECH_WORKER_CRASHED", true);
                }
                Err(std_mpsc::RecvTimeoutError::Timeout)
                    if started_at.elapsed() >= overall_deadline =>
                {
                    kill_worker(child);
                    return failed_outcome("SPEECH_DEADLINE_EXCEEDED", false);
                }
                Err(std_mpsc::RecvTimeoutError::Timeout) => {
                    kill_worker(child);
                    return failed_outcome("SPEECH_WORKER_TIMEOUT", true);
                }
            };
            if response.identity() != identity {
                let mut response = response;
                response.zeroize_sensitive();
                return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
            }

            match response {
                WorkerResponse::Ready { .. } if !ready => {
                    ready = true;
                    log_record_job(job, "worker_ready");
                }
                WorkerResponse::Ready { .. } => {
                    return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                }
                WorkerResponse::MediaProbed {
                    media_kind,
                    codec,
                    duration_ms,
                    used_default_track,
                    ..
                } if ready && job.kind == SpeechJobKind::AgentAttachmentAsr && !media_probed => {
                    if let Err(code) = self.update_agent_media_probe(
                        &job.job_id,
                        generation,
                        media_kind,
                        codec,
                        duration_ms,
                        used_default_track,
                    ) {
                        return failed_outcome(code, false);
                    }
                    overall_deadline = duration_ms.map_or(MAX_AGENT_DEADLINE, |duration| {
                        StdDuration::from_millis(duration.saturating_mul(2)).max(MIN_AGENT_DEADLINE)
                    });
                    media_probed = true;
                }
                WorkerResponse::Heartbeat { stage, .. }
                | WorkerResponse::Progress { stage, .. }
                    if ready =>
                {
                    self.update_worker_stage(&job.job_id, generation, stage);
                }
                WorkerResponse::TranscriptSegment {
                    segment_id,
                    track,
                    start_sample,
                    end_sample,
                    text,
                    language,
                    revision,
                    ..
                } if ready
                    && (!job.kind.is_agent() || media_probed)
                    && matches!(
                        job.kind,
                        SpeechJobKind::RecordBackfillAsr | SpeechJobKind::AgentAttachmentAsr
                    ) =>
                {
                    let next_characters = transcript_characters
                        .checked_add(text.chars().count())
                        .filter(|count| *count <= MAX_TRANSCRIPT_CHARACTERS);
                    if revision != next_transcript_revision
                        || transcripts.0.len() >= MAX_TRANSCRIPT_SEGMENTS
                        || next_characters.is_none()
                    {
                        let mut text = text;
                        text.zeroize();
                        let mut language = language;
                        if let Some(language) = &mut language {
                            language.zeroize();
                        }
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    }
                    transcript_characters = next_characters.expect("checked above");
                    let Some(next_revision) = next_transcript_revision.checked_add(1) else {
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    };
                    next_transcript_revision = next_revision;
                    let track = match (job.kind, track) {
                        (SpeechJobKind::AgentAttachmentAsr, TrackKind::Attachment) => {
                            AudioTrackKind::Mixed
                        }
                        (SpeechJobKind::RecordBackfillAsr, track) => {
                            match record_backfill_track(
                                track,
                                expected_record_transcript_track.as_deref(),
                            ) {
                                Ok(track) => track,
                                Err(code) => return failed_outcome(code, false),
                            }
                        }
                        _ => return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true),
                    };
                    transcripts.0.push(RecordTranscriptSegment {
                        segment_id,
                        track,
                        start_sample,
                        end_sample,
                        text,
                        language,
                        revision,
                    });
                }
                WorkerResponse::SpeakerTurnBatch {
                    revision,
                    batch_index,
                    is_last,
                    turns: batch,
                    ..
                } if ready && job.kind == SpeechJobKind::RecordDiarization => {
                    if speaker_last_seen
                        || batch_index != next_speaker_batch
                        || speaker_revision.is_some_and(|expected| expected != revision)
                    {
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    }
                    speaker_revision.get_or_insert(revision);
                    let Some(next_batch) = next_speaker_batch.checked_add(1) else {
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    };
                    if turns
                        .len()
                        .checked_add(batch.len())
                        .map_or(true, |count| count > MAX_DIARIZATION_TURNS)
                    {
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    }
                    next_speaker_batch = next_batch;
                    speaker_last_seen = is_last;
                    let converted = batch
                        .into_iter()
                        .map(|turn| {
                            record_speaker_turn(turn, expected_record_transcript_track.as_deref())
                        })
                        .collect::<Result<Vec<_>, _>>();
                    let batch = match converted {
                        Ok(batch) => batch,
                        Err(code) => return failed_outcome(code, false),
                    };
                    if let (Some(previous), Some(next)) = (turns.last(), batch.first()) {
                        if (
                            previous.start_sample,
                            previous.end_sample,
                            previous.source,
                            previous.global_speaker,
                        ) > (
                            next.start_sample,
                            next.end_sample,
                            next.source,
                            next.global_speaker,
                        ) {
                            return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                        }
                    }
                    turns.extend(batch);
                }
                WorkerResponse::IdentityEvidenceBatch {
                    batch_index,
                    is_last,
                    evidence,
                    ..
                } if ready && speaker_last_seen && job.kind == SpeechJobKind::RecordDiarization => {
                    if identity_last_seen
                        || batch_index != next_identity_batch
                        || identity_evidence.len() + evidence.len() > MAX_IDENTITY_PEOPLE
                        || evidence.iter().enumerate().any(|(index, row)| {
                            expected_people.get(identity_evidence.len() + index)
                                != Some(&row.person_id)
                        })
                    {
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    }
                    next_identity_batch += 1;
                    identity_last_seen = is_last;
                    identity_evidence.extend(evidence);
                }
                WorkerResponse::Pong { .. } if ready => {}
                WorkerResponse::Yielded { .. }
                    if ready && yield_state.sent.load(std::sync::atomic::Ordering::Acquire) =>
                {
                    return SpeechWorkerOutcome::Yielded;
                }
                WorkerResponse::Completed { metrics, .. }
                    if ready && (!job.kind.is_agent() || media_probed) =>
                {
                    if (job.kind == SpeechJobKind::RecordDiarization
                        && (!identity_last_seen
                            || identity_evidence.len() != expected_people.len()))
                        || !completed_shape_matches(
                            job.kind,
                            &transcripts.0,
                            &turns,
                            speaker_last_seen,
                            &metrics,
                        )
                    {
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    }
                    transcripts.0.sort_by(|left, right| {
                        (left.start_sample, left.end_sample, left.segment_id.as_str()).cmp(&(
                            right.start_sample,
                            right.end_sample,
                            right.segment_id.as_str(),
                        ))
                    });
                    return SpeechWorkerOutcome::Completed(SpeechWorkerCompletion {
                        transcripts,
                        turns,
                        identity_evidence,
                        metrics,
                    });
                }
                WorkerResponse::Failed { code, .. } => {
                    let retryable = worker_code_retryable(&code);
                    return SpeechWorkerOutcome::Failed {
                        code,
                        retryable,
                        terminal_received: true,
                    };
                }
                mut response @ WorkerResponse::TranscriptSegment { .. } => {
                    response.zeroize_sensitive();
                    return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                }
                _ => return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true),
            }
        }
    }

    fn update_worker_stage(&self, job_id: &str, generation: u64, stage: WorkerStage) {
        let stage = speech_stage(stage);
        let snapshot = if let Ok(mut state) = self.state.lock() {
            state.jobs.get_mut(job_id).and_then(|job| {
                (job.state == SpeechJobState::Running
                    && job.worker_generation == Some(generation)
                    && job.stage != stage)
                    .then(|| {
                        job.stage = stage;
                        job.updated_at = Utc::now();
                        job.clone()
                    })
            })
        } else {
            None
        };
        if let Some(snapshot) = snapshot {
            log_record_job(&snapshot, "stage_changed");
            let _ = persist_job(&self.root, &snapshot);
        }
    }

    fn publish_record_success(
        &self,
        source_job: &SpeechJob,
        generation: u64,
        provenance: &RecordSpeechProvenance,
        completion: SpeechWorkerCompletion,
    ) {
        let SpeechWorkerCompletion {
            mut transcripts,
            turns,
            identity_evidence,
            metrics,
        } = completion;
        let SpeechJobOrigin::Record { record_id } = &source_job.origin else {
            return;
        };
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if !exact_running_generation(&state, &source_job.job_id, generation) {
            return;
        }
        let frozen = match record_processing::read_input(&self.root, source_job) {
            Ok(frozen) => frozen,
            Err(code) => {
                drop(state);
                self.finish_failed(source_job, generation, code, false);
                return;
            }
        };
        crate::ulog_info!("[speech] worker completed recordId={} jobId={} generation={} kind={:?} workerElapsedMs={} sourceSamples={} segments={} speakers={}",
            record_id, source_job.job_id, generation, source_job.kind, metrics.elapsed_ms,
            metrics.source_samples, metrics.segments, metrics.speakers);
        let job_metrics = SpeechJobMetrics {
            source_samples: metrics.source_samples,
            segments: metrics.segments,
            speakers: metrics.speakers,
            elapsed_ms: metrics.elapsed_ms,
            peak_working_bytes: metrics.peak_working_bytes,
        };
        if source_job.kind == SpeechJobKind::RecordBackfillAsr {
            let candidate = RecordAsrCandidate {
                processing_id: source_job.job_id.clone(),
                worker_generation: generation,
                pipeline: source_job.pipeline.clone(),
                segments: std::mem::take(&mut transcripts.0),
            };
            let reference = match record_processing::write_candidate(
                &self.root,
                &source_job.job_id,
                record_processing::ASR_FILE,
                &candidate,
            ) {
                Ok(reference) => reference,
                Err(code) => {
                    drop(state);
                    self.finish_failed(source_job, generation, code, false);
                    return;
                }
            };
            let mut waiting = source_job.clone();
            waiting.record_asr_candidate = Some(reference);
            waiting.worker_generation = None;
            waiting.stage = SpeechJobStage::Diarizing;
            waiting.updated_at = Utc::now();
            waiting.metrics = Some(job_metrics);
            // Root stays nonterminal while its separately queued speaker stage
            // runs. Its durable candidate reference also repairs a crash in the
            // following enqueue, without rerunning accepted ASR output.
            if persist_job_resolving_unknown(&self.root, &waiting).is_err() {
                drop(state);
                self.finish_failed(
                    source_job,
                    generation,
                    "SPEECH_JOB_STORE_WRITE_FAILED",
                    false,
                );
                return;
            }
            state.jobs.insert(waiting.job_id.clone(), waiting.clone());
            log_record_job(&waiting, "waiting_for_speakers");
            if let Err(code) = enqueue_diarization_locked(&self.root, &mut state, &waiting) {
                self.fail_record_processing_locked(&mut state, &waiting, code, false);
            } else {
                update_record_queued_status(
                    &self.record_store,
                    SpeechJobKind::RecordDiarization,
                    record_id,
                );
                self.wake.notify_one();
            }
            return;
        }
        if source_job.kind != SpeechJobKind::RecordDiarization {
            return;
        }
        let Some(root_job) = source_job
            .processing_id
            .as_ref()
            .and_then(|id| state.jobs.get(id))
            .cloned()
        else {
            return;
        };
        let mut candidate = match record_processing::read_asr(&self.root, &root_job) {
            Ok(candidate) => candidate,
            Err(code) => {
                drop(state);
                self.finish_failed(source_job, generation, code, false);
                return;
            }
        };
        for id in [&source_job.job_id, &root_job.job_id] {
            if let Some(mut job) = state.jobs.get(id).cloned() {
                job.stage = SpeechJobStage::Publishing;
                job.updated_at = Utc::now();
                if persist_job_resolving_unknown(&self.root, &job).is_err() {
                    drop(state);
                    self.finish_failed(source_job, generation, "SPEECH_PUBLISH_FAILED", false);
                    return;
                }
                state.jobs.insert(id.clone(), job);
            }
        }
        let commit = tauri::async_runtime::block_on(self.record_store.commit_speech_processing(
            &frozen.baseline,
            &root_job.job_id,
            std::mem::take(&mut candidate.segments),
            Some(turns),
            identity_evidence,
            provenance.clone(),
        ));
        if commit.is_err() {
            drop(state);
            self.finish_failed(source_job, generation, "SPEECH_PUBLISH_FAILED", false);
            return;
        }
        finish_job_locked(
            &self.root,
            &mut state,
            &source_job.job_id,
            generation,
            SpeechJobState::Succeeded,
            None,
            Some(job_metrics),
        );
        finish_processing_root_locked(
            &self.root,
            &mut state,
            &root_job.job_id,
            SpeechJobState::Succeeded,
            None,
        );
    }

    fn fail_record_processing_locked(
        &self,
        state: &mut ManagerState,
        root_job: &SpeechJob,
        code: &str,
        retryable: bool,
    ) {
        let SpeechJobOrigin::Record { record_id } = &root_job.origin else {
            return;
        };
        let cancelled = matches!(code, "SPEECH_CANCELLED" | "SPEECH_INTERRUPTED");
        let mut failure_intent = root_job.clone();
        failure_intent.error = Some(SpeechJobError {
            code: code.into(),
            retryable,
        });
        failure_intent.updated_at = Utc::now();
        let failure_recorded = persist_job_resolving_unknown(&self.root, &failure_intent).is_ok();
        if !failure_recorded {
            crate::ulog_error!(
                "[speech] Record processing failure metadata could not be persisted"
            );
        }
        state.jobs.insert(root_job.job_id.clone(), failure_intent);
        // A failed failure-intent write cannot authorize a partial publication,
        // but must still revoke the completed execution and settle its jobs.
        if failure_recorded
            && !cancelled
            && root_job.stage == SpeechJobStage::Diarizing
            && !matches!(
                code,
                "SPEECH_PUBLISH_FAILED"
                    | "SPEECH_PIPELINE_REVISION_UNAVAILABLE"
                    | "SPEECH_SOURCE_CHANGED"
            )
            && root_job.record_asr_candidate.is_some()
        {
            if let (Ok(frozen), Ok(mut candidate)) = (
                record_processing::read_input(&self.root, root_job),
                record_processing::read_asr(&self.root, root_job),
            ) {
                if frozen.baseline.transcript_artifact.is_none() {
                    let provenance = RecordSpeechProvenance {
                        provider: root_job.pipeline.provider.clone(),
                        model_pack_revision: root_job.pipeline.model_pack_revision.clone(),
                        onnx_runtime_version: root_job.pipeline.onnx_runtime_version.clone(),
                        algorithm_revision: root_job.pipeline.algorithm_revision.clone(),
                    };
                    let _ =
                        tauri::async_runtime::block_on(self.record_store.commit_speech_processing(
                            &frozen.baseline,
                            &root_job.job_id,
                            std::mem::take(&mut candidate.segments),
                            None,
                            Vec::new(),
                            provenance,
                        ));
                }
            }
        }
        finish_processing_root_locked(
            &self.root,
            state,
            &root_job.job_id,
            if code == "SPEECH_CANCELLED" {
                SpeechJobState::Cancelled
            } else {
                SpeechJobState::Failed
            },
            Some(SpeechJobError {
                code: code.into(),
                retryable,
            }),
        );
        update_record_terminal_status(
            &self.record_store,
            if root_job.record_asr_candidate.is_some() {
                SpeechJobKind::RecordDiarization
            } else {
                SpeechJobKind::RecordBackfillAsr
            },
            record_id,
            false,
        );
    }

    fn requeue_yielded(&self, source_job: &SpeechJob, generation: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if !exact_running_generation(&state, &source_job.job_id, generation) {
            return;
        }
        let snapshot = state.jobs.get_mut(&source_job.job_id).map(|job| {
            job.state = SpeechJobState::Queued;
            job.stage = SpeechJobStage::Validating;
            job.updated_at = Utc::now();
            job.started_at = None;
            job.worker_generation = None;
            job.worker_attempts = job.worker_attempts.saturating_sub(1);
            job.error = None;
            job.clone()
        });
        state.queue.push_front(source_job.job_id.clone());
        if let Some(snapshot) = snapshot {
            let _ = persist_job(&self.root, &snapshot);
        }
        if let SpeechJobOrigin::Record { record_id } = &source_job.origin {
            update_record_queued_status(&self.record_store, source_job.kind, record_id);
        }
    }

    fn finish_failed(&self, source_job: &SpeechJob, generation: u64, code: &str, retryable: bool) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if !exact_running_generation(&state, &source_job.job_id, generation) {
            return;
        }
        let queued = retryable
            && state.accepting
            && state
                .jobs
                .get(&source_job.job_id)
                .is_some_and(|job| job.worker_attempts < MAX_WORKER_ATTEMPTS);
        if queued {
            if let Some(job) = state.jobs.get_mut(&source_job.job_id) {
                job.state = SpeechJobState::Queued;
                job.stage = SpeechJobStage::Validating;
                job.updated_at = Utc::now();
                job.started_at = None;
                job.worker_generation = None;
                job.error = Some(SpeechJobError {
                    code: code.into(),
                    retryable: true,
                });
                let snapshot = job.clone();
                let _ = persist_job(&self.root, &snapshot);
            }
            state.queue.push_back(source_job.job_id.clone());
        } else {
            finish_job_locked(
                &self.root,
                &mut state,
                &source_job.job_id,
                generation,
                if code == "SPEECH_CANCELLED" {
                    SpeechJobState::Cancelled
                } else if code == "SPEECH_INTERRUPTED" {
                    SpeechJobState::Interrupted
                } else {
                    SpeechJobState::Failed
                },
                Some(SpeechJobError {
                    code: code.into(),
                    retryable,
                }),
                None,
            );
        }
        if let SpeechJobOrigin::Record { record_id } = &source_job.origin {
            if queued {
                update_record_queued_status(&self.record_store, source_job.kind, record_id);
            } else {
                if source_job.kind == SpeechJobKind::RecordDiarization {
                    if let Some(root_job) = source_job
                        .processing_id
                        .as_ref()
                        .and_then(|id| state.jobs.get(id))
                        .cloned()
                    {
                        self.fail_record_processing_locked(&mut state, &root_job, code, retryable);
                        return;
                    }
                }
                update_record_terminal_status(
                    &self.record_store,
                    source_job.kind,
                    record_id,
                    false,
                );
                if source_job.kind == SpeechJobKind::RecordBackfillAsr
                    && source_job.processing_id.is_some()
                {
                    record_processing::cleanup_record_private(&self.root, &source_job.job_id);
                }
            }
        }
        if queued {
            self.wake.notify_one();
        }
    }

    fn finish_interrupted_if_needed(&self, job: &SpeechJob, generation: u64) {
        self.finish_failed(job, generation, "SPEECH_INTERRUPTED", true);
    }

    fn finish_join_failure(&self, job_id: &str, generation: u64) {
        let job = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.jobs.get(job_id).cloned());
        if let Some(job) = job {
            self.finish_failed(&job, generation, "SPEECH_WORKER_CRASHED", true);
        }
    }

    fn update_record_running_status(
        &self,
        job: &SpeechJob,
        generation: u64,
    ) -> Result<(), &'static str> {
        let SpeechJobOrigin::Record { record_id } = &job.origin else {
            return Err("SPEECH_WORKLOAD_NOT_READY");
        };
        let state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        if !exact_running_generation(&state, &job.job_id, generation) {
            return Err("SPEECH_INTERRUPTED");
        }
        let result = match job.kind {
            SpeechJobKind::RecordBackfillAsr => {
                tauri::async_runtime::block_on(self.record_store.update_audio_processing_status(
                    record_id,
                    Some(TranscriptionStatus::Finalizing),
                    None,
                ))
            }
            SpeechJobKind::RecordDiarization => {
                tauri::async_runtime::block_on(self.record_store.update_audio_processing_status(
                    record_id,
                    None,
                    Some(DiarizationStatus::Running),
                ))
            }
            SpeechJobKind::AgentAttachmentAsr => return Err("SPEECH_WORKLOAD_NOT_READY"),
        };
        result
            .map(|_| ())
            .map_err(|_| "SPEECH_RECORD_UPDATE_FAILED")
    }

    fn job_can_execute(&self, job_id: &str, generation: u64) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state.accepting && exact_running_generation(&state, job_id, generation)
        })
    }

    fn job_can_publish(&self, job_id: &str, generation: u64) -> bool {
        self.state
            .lock()
            .ok()
            .is_some_and(|state| exact_running_generation(&state, job_id, generation))
    }

    fn clear_running(&self, job_id: &str, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state
                .running
                .as_ref()
                .is_some_and(|running| running.job_id == job_id && running.generation == generation)
            {
                state.running = None;
            }
        }
    }

    fn clear_active(&self, job_id: &str, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state
                .active_job
                .as_ref()
                .is_some_and(|active| active == &(job_id.to_string(), generation))
            {
                state.active_job = None;
            }
        }
    }
}

fn validate_live_sources(sources: &[AnalysisSpoolSource]) -> Result<(), String> {
    if !(1..=2).contains(&sources.len()) {
        return Err("SPEECH_ANALYSIS_SOURCE_INVALID".to_string());
    }
    for (index, source) in sources.iter().enumerate() {
        if source.track() == AudioTrackKind::Mixed
            || sources[index + 1..]
                .iter()
                .any(|other| other.track() == source.track())
        {
            return Err("SPEECH_ANALYSIS_SOURCE_INVALID".to_string());
        }
        let metadata = fs::symlink_metadata(source.path())
            .map_err(|_| "SPEECH_ANALYSIS_SOURCE_UNAVAILABLE".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != 0 {
            return Err("SPEECH_ANALYSIS_SOURCE_INVALID".to_string());
        }
        let progress = source.snapshot();
        if progress.committed_samples != 0 || progress.finished || progress.error_code.is_some() {
            return Err("SPEECH_ANALYSIS_SOURCE_INVALID".to_string());
        }
    }
    Ok(())
}

fn normalize_live_boundary(
    tracks: &[AudioTrackKind],
    offsets: Vec<RecordTranscriptTrackOffset>,
) -> Result<LiveBoundary, String> {
    if offsets.len() != tracks.len() {
        return Err("SPEECH_ANALYSIS_BOUNDARY_INVALID".to_string());
    }
    let mut normalized = Vec::with_capacity(tracks.len());
    for track in tracks {
        let matches = offsets
            .iter()
            .filter(|offset| offset.track == *track)
            .collect::<Vec<_>>();
        if matches.len() != 1 || matches[0].sample > MAX_MEDIA_SAMPLES_PER_TRACK {
            return Err("SPEECH_ANALYSIS_BOUNDARY_INVALID".to_string());
        }
        normalized.push((*matches[0]).clone());
    }
    Ok(LiveBoundary {
        offsets: normalized,
    })
}

fn ensure_boundary_monotonic(previous: &LiveBoundary, next: &LiveBoundary) -> Result<(), String> {
    if previous.offsets.len() != next.offsets.len()
        || previous.offsets.iter().any(|prior| {
            next.offsets
                .iter()
                .find(|offset| offset.track == prior.track)
                .map_or(true, |offset| offset.sample < prior.sample)
        })
    {
        return Err("SPEECH_ANALYSIS_BOUNDARY_INVALID".to_string());
    }
    Ok(())
}

fn boundary_sample(boundary: &LiveBoundary, track: AudioTrackKind) -> Option<u64> {
    boundary
        .offsets
        .iter()
        .find(|offset| offset.track == track)
        .map(|offset| offset.sample)
}

fn live_cursors(
    sources: &[AnalysisSpoolSource],
    replay_from: &[RecordTranscriptTrackOffset],
) -> Result<Vec<LiveTrackCursor>, &'static str> {
    // Rebuild both references at one media position, including bounded AEC
    // history. Publication starts separately at each source's safe frontier.
    let replay_record_start = replay_from
        .iter()
        .map(|offset| offset.sample)
        .min()
        .ok_or("SPEECH_ANALYSIS_SOURCE_INVALID")?
        .saturating_sub(2 * 16_000);
    sources
        .iter()
        .map(|source| {
            let publish_from_record_sample = replay_from
                .iter()
                .find(|offset| offset.track == source.track())
                .ok_or("SPEECH_ANALYSIS_SOURCE_INVALID")?
                .sample;
            let position = source.source_position_for_record(replay_record_start)?;
            let snapshot = source.snapshot();
            if position > snapshot.committed_samples {
                return Err("SPEECH_ANALYSIS_SOURCE_INVALID");
            }
            Ok(LiveTrackCursor {
                source: source.clone(),
                track: protocol_track(source.track())?,
                generation_start: position,
                position,
                next_sequence: 0,
                last_sequence: None,
                replay_record_start,
                publish_from_record_sample,
            })
        })
        .collect()
}

fn cursors_reached(cursors: &[LiveTrackCursor], boundary: &LiveBoundary) -> bool {
    cursors
        .iter()
        .all(|cursor| boundary_sample(boundary, cursor.source.track()) == Some(cursor.position))
}

fn live_checkpoint_matches(cursors: &[LiveTrackCursor], checkpoint: &Checkpoint) -> bool {
    checkpoint.streams.len() == cursors.len()
        && cursors.iter().all(|cursor| {
            checkpoint.streams.iter().any(|stream| {
                stream.track == cursor.track
                    && stream.last_ack_sequence == cursor.last_sequence
                    && stream.analysis_sample == cursor.position
            })
        })
}

fn send_pcm_frame(
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    frame: &PcmFrame,
) -> std::io::Result<()> {
    let mut stdin = stdin
        .lock()
        .map_err(|_| std::io::Error::other("media Worker stdin lock poisoned"))?;
    write_pcm_frame(&mut *stdin, frame)
}

fn spawn_live_response_reader(
    stdout: ChildStdout,
    generation: u64,
) -> std_mpsc::Receiver<Result<WorkerResponse, &'static str>> {
    let (responses, receiver) = std_mpsc::sync_channel(8);
    let thread_name = format!("speech-live-response-{generation}");
    let _ = thread::Builder::new().name(thread_name).spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let response = match read_worker_response(&mut reader) {
                Ok(Some(response)) => Ok(response),
                Ok(None) => Err("SPEECH_WORKER_CRASHED"),
                Err(_) => Err("SPEECH_WORKER_PROTOCOL_ERROR"),
            };
            let terminal = response.is_err();
            if let Err(std_mpsc::SendError(mut unsent)) = responses.send(response) {
                if let Ok(response) = &mut unsent {
                    response.zeroize_sensitive();
                }
                break;
            }
            if terminal {
                break;
            }
        }
    });
    receiver
}

fn receive_live_response(
    responses: &std_mpsc::Receiver<Result<WorkerResponse, &'static str>>,
) -> Result<WorkerResponse, (String, bool)> {
    match responses.recv_timeout(LIVE_WORKER_RESPONSE_TIMEOUT) {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(code)) => Err((code.to_string(), true)),
        Err(std_mpsc::RecvTimeoutError::Timeout) => {
            Err(("SPEECH_WORKER_TIMEOUT".to_string(), true))
        }
        Err(std_mpsc::RecvTimeoutError::Disconnected) => {
            Err(("SPEECH_WORKER_CRASHED".to_string(), true))
        }
    }
}

fn read_live_frame_settlement(
    responses: &std_mpsc::Receiver<Result<WorkerResponse, &'static str>>,
    identity: &WorkloadIdentity,
    journal: &mut RecordLiveTranscriptJournal,
    control: &LiveControl,
    next_worker_revision: &mut u64,
    expected_ack: Option<(TrackKind, u64, u64)>,
    expected_completed_samples: Option<u64>,
) -> Result<bool, (String, bool)> {
    let mut acked = expected_ack.is_none();
    let mut transcript_changed = false;
    loop {
        let response = receive_live_response(responses)?;
        if response.identity() != identity {
            let mut response = response;
            response.zeroize_sensitive();
            return Err(("SPEECH_WORKER_PROTOCOL_ERROR".to_string(), true));
        }
        match response {
            WorkerResponse::InputAck {
                track,
                sequence,
                end_sample,
                ..
            } if !acked && expected_ack == Some((track, sequence, end_sample)) => {
                acked = true;
            }
            WorkerResponse::TranscriptSegment {
                track,
                start_sample,
                end_sample,
                mut text,
                mut language,
                revision,
                ..
            } => {
                if revision != *next_worker_revision {
                    text.zeroize();
                    if let Some(language) = &mut language {
                        language.zeroize();
                    }
                    return Err(("SPEECH_WORKER_PROTOCOL_ERROR".to_string(), true));
                }
                let Some(next_revision) = next_worker_revision.checked_add(1) else {
                    text.zeroize();
                    if let Some(language) = &mut language {
                        language.zeroize();
                    }
                    return Err(("SPEECH_RESOURCE_LIMIT".to_string(), false));
                };
                *next_worker_revision = next_revision;
                let track = match record_source_track(track) {
                    Ok(track) => track,
                    Err(code) => {
                        text.zeroize();
                        if let Some(language) = &mut language {
                            language.zeroize();
                        }
                        return Err((code.to_string(), false));
                    }
                };
                match journal.append_segment(track, start_sample, end_sample, text, language) {
                    Ok(Some(mut segment)) => {
                        segment.zeroize_sensitive();
                        transcript_changed = true;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        return Err(("SPEECH_JOB_STORE_WRITE_FAILED".to_string(), false));
                    }
                }
            }
            WorkerResponse::Heartbeat { checkpoint, .. }
                if expected_completed_samples.is_none() && acked =>
            {
                if let Some((track, sequence, end_sample)) = expected_ack {
                    if !checkpoint.streams.iter().any(|stream| {
                        stream.track == track
                            && stream.last_ack_sequence == Some(sequence)
                            && stream.analysis_sample == end_sample
                    }) {
                        return Err(("SPEECH_WORKER_PROTOCOL_ERROR".to_string(), true));
                    }
                }
                control
                    .observe_replay_checkpoint(&checkpoint, &journal.replay_offsets())
                    .map_err(|code| (code.to_string(), false))?;
                return Ok(transcript_changed);
            }
            WorkerResponse::Heartbeat { .. } if expected_completed_samples.is_some() && acked => {}
            WorkerResponse::Completed { metrics, .. }
                if expected_completed_samples == Some(metrics.source_samples) && acked =>
            {
                return Ok(transcript_changed)
            }
            WorkerResponse::Failed { code, .. } => {
                let retryable = worker_code_retryable(&code);
                return Err((code, retryable));
            }
            mut response => {
                response.zeroize_sensitive();
                return Err(("SPEECH_WORKER_PROTOCOL_ERROR".to_string(), true));
            }
        }
    }
}

fn settle_live_spawn_failure(
    manager: &SpeechRecognitionManager,
    record_id: &str,
    generation: u64,
    child: &Arc<Mutex<process_cmd::ChildTree>>,
    code: &str,
    retryable: bool,
) -> LiveAttemptOutcome {
    let (stdin, should_suspend) = manager.state.lock().map_or((None, false), |state| {
        let stdin = state.live_running.as_ref().and_then(|running| {
            (running.job_id == record_id && running.generation == generation)
                .then(|| Arc::clone(&running.stdin))
        });
        let should_suspend = state
            .live_sessions
            .get(record_id)
            .and_then(|session| session.control.snapshot().ok())
            .is_some_and(|snapshot| {
                snapshot.paused
                    && snapshot.suspend_requested
                    && !snapshot.cancelled
                    && snapshot.finish.is_none()
            });
        (stdin, should_suspend)
    });
    if let Some(stdin) = stdin {
        let _ = send_worker_command(
            &stdin,
            &WorkerCommand::Cancel {
                protocol_version: PROTOCOL_VERSION,
                identity: WorkloadIdentity {
                    workload_id: record_id.to_string(),
                    worker_generation: generation,
                },
            },
        );
    }
    let _ = process_cmd::settle_tree(child, WORKER_CANCEL_GRACE);
    manager.clear_live_running(record_id);
    if should_suspend {
        LiveAttemptOutcome::Suspended
    } else {
        live_failed(code, retryable)
    }
}

fn live_failed(code: &str, retryable: bool) -> LiveAttemptOutcome {
    LiveAttemptOutcome::Failed {
        code: code.to_string(),
        retryable,
    }
}

fn exact_running_generation(state: &ManagerState, job_id: &str, generation: u64) -> bool {
    state
        .active_job
        .as_ref()
        .is_some_and(|(active_id, active_generation)| {
            active_id == job_id && *active_generation == generation
        })
        && state.jobs.get(job_id).is_some_and(|job| {
            job.state == SpeechJobState::Running
                && job.worker_generation == Some(generation)
                && job.processing_id.as_ref().map_or(true, |processing_id| {
                    if job.kind == SpeechJobKind::RecordBackfillAsr {
                        processing_id == job_id
                    } else {
                        state.jobs.get(processing_id).is_some_and(|root| {
                            root.kind == SpeechJobKind::RecordBackfillAsr
                                && root.state == SpeechJobState::Running
                                && matches!(
                                    root.stage,
                                    SpeechJobStage::Diarizing | SpeechJobStage::Publishing
                                )
                                && root.record_asr_candidate.is_some()
                                && root.pipeline == job.pipeline
                                && root.record_baseline == job.record_baseline
                        })
                    }
                })
        })
}

fn compute_kind(kind: SpeechJobKind) -> ComputeWorkloadKind {
    match kind {
        SpeechJobKind::AgentAttachmentAsr => ComputeWorkloadKind::AgentAttachmentAsr,
        SpeechJobKind::RecordBackfillAsr => ComputeWorkloadKind::RecordBackfill,
        SpeechJobKind::RecordDiarization => ComputeWorkloadKind::RecordDiarization,
    }
}

fn protocol_workload_kind(kind: SpeechJobKind) -> WorkloadKind {
    match kind {
        SpeechJobKind::AgentAttachmentAsr => WorkloadKind::AttachmentAsr,
        SpeechJobKind::RecordBackfillAsr => WorkloadKind::RecordBackfillAsr,
        SpeechJobKind::RecordDiarization => WorkloadKind::RecordDiarization,
    }
}

fn protocol_track(track: AudioTrackKind) -> Result<TrackKind, &'static str> {
    match track {
        AudioTrackKind::Microphone => Ok(TrackKind::Microphone),
        AudioTrackKind::System => Ok(TrackKind::System),
        AudioTrackKind::Mixed => Ok(TrackKind::Mixed),
    }
}

fn expected_record_backfill_tracks(
    input: &WorkloadInput,
) -> Result<Vec<AudioTrackKind>, &'static str> {
    let WorkloadInput::RecordArtifacts { inputs, .. } = input else {
        return Err("SPEECH_WORKER_PROTOCOL_ERROR");
    };
    if !(1..=2).contains(&inputs.len()) || (inputs.len() == 2 && inputs[0].track == inputs[1].track)
    {
        return Err("SPEECH_WORKER_PROTOCOL_ERROR");
    }
    inputs
        .iter()
        .map(|input| {
            if input.track == TrackKind::Mixed && inputs.len() == 1 {
                Ok(AudioTrackKind::Mixed)
            } else {
                record_source_track(input.track)
            }
        })
        .collect()
}

fn record_source_track(track: TrackKind) -> Result<AudioTrackKind, &'static str> {
    match track {
        TrackKind::Microphone => Ok(AudioTrackKind::Microphone),
        TrackKind::System => Ok(AudioTrackKind::System),
        TrackKind::Mixed | TrackKind::Attachment => Err("SPEECH_WORKER_PROTOCOL_ERROR"),
    }
}

fn record_backfill_track(
    track: TrackKind,
    expected: Option<&[AudioTrackKind]>,
) -> Result<AudioTrackKind, &'static str> {
    let actual = match track {
        TrackKind::Microphone => Ok(AudioTrackKind::Microphone),
        TrackKind::System => Ok(AudioTrackKind::System),
        TrackKind::Mixed => Ok(AudioTrackKind::Mixed),
        TrackKind::Attachment => Err("SPEECH_WORKER_PROTOCOL_ERROR"),
    }?;
    expected
        .is_some_and(|tracks| tracks.contains(&actual))
        .then_some(actual)
        .ok_or("SPEECH_WORKER_PROTOCOL_ERROR")
}

fn record_speaker_turn(
    turn: SpeakerTurn,
    expected: Option<&[AudioTrackKind]>,
) -> Result<RecordSpeakerTurn, &'static str> {
    Ok(RecordSpeakerTurn {
        source: Some(record_backfill_track(turn.source, expected)?),
        start_sample: turn.start_sample,
        end_sample: turn.end_sample,
        global_speaker: turn.global_speaker,
    })
}

fn speech_stage(stage: WorkerStage) -> SpeechJobStage {
    match stage {
        WorkerStage::Loading | WorkerStage::Decoding => SpeechJobStage::Decoding,
        WorkerStage::Vad | WorkerStage::Transcribing => SpeechJobStage::Transcribing,
        WorkerStage::SegmentingSpeakers
        | WorkerStage::EmbeddingSpeakers
        | WorkerStage::ClusteringSpeakers
        | WorkerStage::ReconcilingSpeakers => SpeechJobStage::Diarizing,
        WorkerStage::Finalizing => SpeechJobStage::Publishing,
    }
}

fn completed_shape_matches(
    kind: SpeechJobKind,
    transcripts: &[RecordTranscriptSegment],
    turns: &[RecordSpeakerTurn],
    speaker_last_seen: bool,
    metrics: &WorkerMetrics,
) -> bool {
    match kind {
        SpeechJobKind::RecordBackfillAsr => {
            turns.is_empty()
                && !speaker_last_seen
                && metrics.segments as usize == transcripts.len()
                && metrics.speakers == 0
        }
        SpeechJobKind::RecordDiarization => {
            if !transcripts.is_empty()
                || !speaker_last_seen
                || metrics.segments as usize != turns.len()
            {
                return false;
            }
            let speakers = turns
                .iter()
                .filter_map(|turn| turn.global_speaker)
                .collect::<std::collections::HashSet<_>>();
            metrics.speakers as usize == speakers.len()
                && speakers
                    .iter()
                    .max()
                    .map_or(true, |maximum| *maximum < metrics.speakers)
        }
        SpeechJobKind::AgentAttachmentAsr => {
            turns.is_empty()
                && !speaker_last_seen
                && metrics.segments as usize == transcripts.len()
                && metrics.speakers == 0
                && transcripts
                    .iter()
                    .all(|segment| segment.track == AudioTrackKind::Mixed)
        }
    }
}

fn path_for_protocol(path: &Path) -> Result<String, &'static str> {
    if !path.is_absolute() {
        return Err("SPEECH_SOURCE_UNSAFE");
    }
    path.to_str()
        .map(str::to_string)
        .ok_or("SPEECH_PATH_ENCODING_UNSUPPORTED")
}

fn send_worker_command(
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    command: &WorkerCommand,
) -> Result<(), ()> {
    stdin
        .lock()
        .map_err(|_| ())
        .and_then(|mut stdin| write_control_frame(&mut *stdin, command).map_err(|_| ()))
}

fn kill_worker(child: &Arc<Mutex<process_cmd::ChildTree>>) {
    if let Ok(mut child) = child.lock() {
        let _ = child.kill_and_wait();
    }
}

fn arm_batch_yield_observer(
    signal: LocalComputeYieldSignal,
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    child: &Arc<Mutex<process_cmd::ChildTree>>,
    identity: &WorkloadIdentity,
    yield_sent: &Arc<std::sync::atomic::AtomicBool>,
    settled: &Arc<std::sync::atomic::AtomicBool>,
) {
    let stdin = Arc::clone(stdin);
    let child = Arc::clone(child);
    let identity = identity.clone();
    let yield_sent = Arc::clone(yield_sent);
    let settled = Arc::clone(settled);
    tauri::async_runtime::spawn(async move {
        loop {
            if settled.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            if signal.should_yield() {
                if yield_sent
                    .compare_exchange(
                        false,
                        true,
                        std::sync::atomic::Ordering::AcqRel,
                        std::sync::atomic::Ordering::Acquire,
                    )
                    .is_ok()
                {
                    let command = WorkerCommand::Yield {
                        protocol_version: PROTOCOL_VERSION,
                        identity,
                    };
                    if send_worker_command(&stdin, &command).is_err() {
                        let _ =
                            tauri::async_runtime::spawn_blocking(move || kill_worker(&child)).await;
                    } else {
                        arm_yield_watchdog(&child, &settled);
                    }
                }
                return;
            }
            tokio::time::sleep(StdDuration::from_millis(25)).await;
        }
    });
}

fn arm_yield_watchdog(
    child: &Arc<Mutex<process_cmd::ChildTree>>,
    settled: &Arc<std::sync::atomic::AtomicBool>,
) {
    let child = Arc::clone(child);
    let settled = Arc::clone(settled);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(YIELD_GRACE_SECONDS)).await;
        if settled.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        let _ = tauri::async_runtime::spawn_blocking(move || kill_worker(&child)).await;
    });
}

fn drain_worker_stderr(mut stderr: ChildStderr, job_id: String, generation: u64) {
    let _ = std::thread::Builder::new()
        .name("speech-worker-stderr".into())
        .spawn(move || {
            let mut buffer = [0_u8; 4 * 1024];
            let mut total = 0_u64;
            loop {
                match stderr.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => total = total.saturating_add(read as u64),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            buffer.zeroize();
            if total > 0 {
                crate::ulog_warn!(
                    "[speech] Worker stderr jobId={} generation={} bytes={} truncated={}",
                    job_id,
                    generation,
                    total.min(MAX_WORKER_STDERR_BYTES),
                    total > MAX_WORKER_STDERR_BYTES
                );
            }
        });
}

fn start_batch_response_reader(
    stdout: ChildStdout,
    identity: WorkloadIdentity,
) -> std_mpsc::Receiver<Result<Option<WorkerResponse>, &'static str>> {
    let (sender, receiver) = std_mpsc::sync_channel(16);
    let _ = std::thread::Builder::new()
        .name("speech-worker-response".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let (response, terminal) = match read_worker_response(&mut reader) {
                    Ok(Some(response)) => (Ok(Some(response)), false),
                    Ok(None) => (Ok(None), true),
                    Err(error) => {
                        // Protocol errors use fixed local messages. Match an
                        // allowlist so neither wire content nor OS/raw paths
                        // can enter diagnostic output.
                        let reason = match error.to_string().as_str() {
                            "invalid worker response shape" => "invalid_response_shape",
                            "invalid worker response JSON" => "invalid_response_json",
                            "unexpected media worker response frame kind" => "unexpected_frame_kind",
                            "media worker frame exceeds fixed limit" => "frame_size_limit",
                            _ => "incomplete_or_unreadable_frame",
                        };
                        crate::ulog_warn!(
                            "[speech] Worker response rejected jobId={} generation={} reason={} ioKind={:?}",
                            identity.workload_id, identity.worker_generation, reason, error.kind()
                        );
                        (Err("SPEECH_WORKER_PROTOCOL_ERROR"), true)
                    },
                };
                if sender.send(response).is_err() || terminal {
                    break;
                }
            }
        });
    receiver
}

fn collect_agent_probe(
    identity: &WorkloadIdentity,
    stdout: ChildStdout,
    deadline: Instant,
) -> Result<AgentMediaProbe, &'static str> {
    let responses = start_batch_response_reader(stdout, identity.clone());
    let mut ready = false;
    let mut probe = None;
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err("SPEECH_WORKER_TIMEOUT");
        };
        match responses.recv_timeout(remaining) {
            Ok(Ok(Some(response))) if response.identity() == identity => match response {
                WorkerResponse::Ready { .. } if !ready && probe.is_none() => ready = true,
                WorkerResponse::MediaProbed {
                    media_kind,
                    codec,
                    duration_ms,
                    used_default_track,
                    ..
                } if ready && probe.is_none() => {
                    probe = Some(AgentMediaProbe {
                        media_kind,
                        codec,
                        duration_ms,
                        used_default_track,
                    });
                }
                WorkerResponse::Failed { code, .. } => return Err(worker_error_code(code)),
                mut response => {
                    response.zeroize_sensitive();
                    return Err("SPEECH_WORKER_PROTOCOL_ERROR");
                }
            },
            Ok(Ok(Some(mut response))) => {
                response.zeroize_sensitive();
                return Err("SPEECH_WORKER_PROTOCOL_ERROR");
            }
            Ok(Ok(None)) if ready => {
                return probe.ok_or("SPEECH_WORKER_PROTOCOL_ERROR");
            }
            Ok(Ok(None) | Err(_)) | Err(std_mpsc::RecvTimeoutError::Disconnected) => {
                return Err("SPEECH_WORKER_PROTOCOL_ERROR");
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => {
                return Err("SPEECH_WORKER_TIMEOUT");
            }
        }
    }
}

fn wait_for_probe_exit(
    child: &Arc<Mutex<process_cmd::ChildTree>>,
    deadline: Instant,
) -> Result<bool, &'static str> {
    loop {
        let status = child
            .lock()
            .map_err(|_| "SPEECH_WORKER_CRASHED")?
            .try_wait()
            .map_err(|_| "SPEECH_WORKER_CRASHED")?;
        if let Some(status) = status {
            return Ok(status.success());
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err("SPEECH_WORKER_TIMEOUT");
        };
        std::thread::sleep(remaining.min(StdDuration::from_millis(10)));
    }
}

fn worker_error_code(code: String) -> &'static str {
    match code.as_str() {
        "SPEECH_SOURCE_UNAVAILABLE" => "SPEECH_SOURCE_UNAVAILABLE",
        "SPEECH_SOURCE_UNSAFE" => "SPEECH_SOURCE_UNSAFE",
        "SPEECH_MEDIA_LIMIT_EXCEEDED" => "SPEECH_MEDIA_LIMIT_EXCEEDED",
        "SPEECH_UNSUPPORTED_CODEC" => "SPEECH_UNSUPPORTED_CODEC",
        "SPEECH_ENCRYPTED_MEDIA" => "SPEECH_ENCRYPTED_MEDIA",
        "SPEECH_NO_AUDIO_TRACK" => "SPEECH_NO_AUDIO_TRACK",
        "SPEECH_CORRUPT_MEDIA" => "SPEECH_CORRUPT_MEDIA",
        _ => "SPEECH_WORKER_PROTOCOL_ERROR",
    }
}

fn failed_outcome(code: &str, retryable: bool) -> SpeechWorkerOutcome {
    SpeechWorkerOutcome::Failed {
        code: code.into(),
        retryable,
        terminal_received: false,
    }
}

fn worker_code_retryable(code: &str) -> bool {
    matches!(
        code,
        "SPEECH_WORKER_IO_ERROR"
            | "SPEECH_WORKER_DISCONNECTED"
            | "SPEECH_WORKER_PROTOCOL_ERROR"
            | "SPEECH_WORKER_CRASHED"
            | "SPEECH_WORKER_START_FAILED"
            | "SPEECH_WORKER_TIMEOUT"
            | "SPEECH_MODEL_LOAD_FAILED"
            | "SPEECH_INFERENCE_FAILED"
    )
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn analytics_outcome(state: SpeechJobState) -> Option<AnalyticsOutcome> {
    match state {
        SpeechJobState::Succeeded => Some(AnalyticsOutcome::Success),
        SpeechJobState::SucceededWithWarnings => Some(AnalyticsOutcome::Partial),
        SpeechJobState::Failed => Some(AnalyticsOutcome::Failed),
        SpeechJobState::Cancelled => Some(AnalyticsOutcome::Canceled),
        SpeechJobState::Interrupted => Some(AnalyticsOutcome::Interrupted),
        SpeechJobState::Queued | SpeechJobState::Running | SpeechJobState::Cancelling => None,
    }
}

fn analytics_media_kind(value: Option<&str>) -> AnalyticsMediaKind {
    match value {
        Some("wav") => AnalyticsMediaKind::Wav,
        Some("aiff") => AnalyticsMediaKind::Aiff,
        Some("mp3") => AnalyticsMediaKind::Mp3,
        Some("flac") => AnalyticsMediaKind::Flac,
        Some("ogg") => AnalyticsMediaKind::Ogg,
        Some("m4a") => AnalyticsMediaKind::M4a,
        Some("mp4") => AnalyticsMediaKind::Mp4,
        Some("mov") => AnalyticsMediaKind::Mov,
        _ => AnalyticsMediaKind::Unknown,
    }
}

fn emit_attachment_job(
    job: &SpeechJob,
    operation: SpeechAttachmentOperation,
    outcome: AnalyticsOutcome,
    duration_ms: u64,
) {
    record_analytics::emit(RecordAnalyticsMilestone::SpeechAttachmentJob {
        event_schema_version: 1,
        job_id: Some(job.job_id.clone()),
        operation,
        source: AnalyticsSource::CliAgent,
        media_kind: analytics_media_kind(job.source.media_kind.as_deref()),
        outcome,
        file_bytes_bucket: Some(record_analytics::media_bytes_bucket(job.source.size_bytes)),
        media_duration_bucket: Some(record_analytics::media_duration_bucket(
            job.source.duration_ms.unwrap_or(0),
        )),
        provider: Some(job.pipeline.provider.clone()),
        model_revision: Some(job.pipeline.model_pack_revision.clone()),
        duration_ms,
        error_code: job.error.as_ref().map(|error| error.code.clone()),
    });
}

// Operational metadata only: never format source paths, model paths, user
// text or Worker payloads. Wall time includes queueing; worker metrics do not.
fn log_record_job(job: &SpeechJob, event: &'static str) {
    let SpeechJobOrigin::Record { record_id } = &job.origin else {
        return;
    };
    let at = job.finished_at.unwrap_or_else(Utc::now);
    let wall_ms = (at - job.created_at).num_milliseconds().max(0);
    let queue_ms = (job.started_at.unwrap_or(at) - job.created_at)
        .num_milliseconds()
        .max(0);
    crate::ulog_info!("[speech] {} recordId={} jobId={} generation={:?} kind={:?} state={:?} stage={:?} wallMs={} queueMs={}",
        event, record_id, job.job_id, job.worker_generation, job.kind, job.state, job.stage, wall_ms, queue_ms);
}

fn emit_speech_terminal(job: &SpeechJob) {
    log_record_job(job, "terminal");
    let Some(outcome) = analytics_outcome(job.state) else {
        return;
    };
    let duration_ms = job.metrics.as_ref().map_or_else(
        || {
            job.finished_at
                .zip(job.started_at)
                .and_then(|(finished, started)| {
                    u64::try_from((finished - started).num_milliseconds().max(0)).ok()
                })
                .unwrap_or(0)
        },
        |metrics| metrics.elapsed_ms,
    );
    match (&job.origin, job.kind) {
        (SpeechJobOrigin::Agent { .. }, SpeechJobKind::AgentAttachmentAsr) => {
            emit_attachment_job(
                job,
                if job.state == SpeechJobState::Cancelled {
                    SpeechAttachmentOperation::Cancel
                } else {
                    SpeechAttachmentOperation::Finish
                },
                outcome,
                duration_ms,
            );
        }
        (SpeechJobOrigin::Record { record_id }, kind) => {
            let stage = match kind {
                SpeechJobKind::RecordBackfillAsr => SpeechProcessingStage::Backfill,
                SpeechJobKind::RecordDiarization => SpeechProcessingStage::Diarization,
                SpeechJobKind::AgentAttachmentAsr => return,
            };
            let metrics = job.metrics.as_ref();
            let source_duration_ms = job.source.duration_ms.unwrap_or_else(|| {
                metrics
                    .map(|metrics| metrics.source_samples.saturating_mul(1_000) / 16_000)
                    .unwrap_or(0)
            });
            record_analytics::emit(RecordAnalyticsMilestone::SpeechProcessingFinish {
                event_schema_version: 1,
                record_id: record_id.clone(),
                stage,
                outcome,
                provider: job.pipeline.provider.clone(),
                model_revision: job.pipeline.model_pack_revision.clone(),
                duration_ms,
                media_duration_bucket: record_analytics::media_duration_bucket(source_duration_ms),
                segment_count_bucket: record_analytics::segment_count_bucket(
                    metrics.map_or(0, |metrics| metrics.segments as usize),
                ),
                speaker_count_bucket: record_analytics::speaker_count_bucket(
                    metrics.map_or(0, |metrics| metrics.speakers as usize),
                ),
                error_code: job.error.as_ref().map(|error| error.code.clone()),
            });
        }
        _ => {}
    }
}

fn emit_resource_mutation(
    operation: SpeechResourceOperation,
    before: &SpeechModelPackStatus,
    result: &Result<SpeechModelPackStatus, String>,
    duration_ms: u64,
) {
    let (outcome, status, error_code) = match result {
        Ok(status) => (
            if status.last_error_code.is_some() {
                AnalyticsOutcome::Partial
            } else {
                AnalyticsOutcome::Success
            },
            status,
            status.last_error_code.clone(),
        ),
        Err(code) => (AnalyticsOutcome::Failed, before, Some(code.clone())),
    };
    record_analytics::emit(RecordAnalyticsMilestone::SpeechResourceMutation {
        event_schema_version: 1,
        operation,
        outcome,
        pack_revision: status.available_revision.clone(),
        resource_bytes: status.installed_model_bytes,
        duration_ms,
        error_code,
    });
}

fn finish_job_locked(
    root: &Path,
    state: &mut ManagerState,
    job_id: &str,
    generation: u64,
    terminal: SpeechJobState,
    error: Option<SpeechJobError>,
    metrics: Option<SpeechJobMetrics>,
) {
    if !exact_running_generation(state, job_id, generation) {
        return;
    }
    if let Some(job) = state.jobs.get_mut(job_id) {
        let now = Utc::now();
        job.state = terminal;
        if matches!(
            terminal,
            SpeechJobState::Succeeded | SpeechJobState::SucceededWithWarnings
        ) {
            job.stage = SpeechJobStage::Publishing;
        }
        job.updated_at = now;
        job.finished_at = Some(now);
        job.error = error;
        job.metrics = metrics;
        job.output.artifact_available = matches!(
            terminal,
            SpeechJobState::Succeeded | SpeechJobState::SucceededWithWarnings
        );
        if persist_job(root, job).is_ok() {
            emit_speech_terminal(job);
        }
    }
}

fn enqueue_diarization_locked(
    root: &Path,
    state: &mut ManagerState,
    root_job: &SpeechJob,
) -> Result<(), &'static str> {
    if root_job.kind != SpeechJobKind::RecordBackfillAsr
        || root_job.processing_id.as_deref() != Some(&root_job.job_id)
        || root_job.record_asr_candidate.is_none()
        || root_job.state.is_terminal()
    {
        return Err("SPEECH_RECORD_CANDIDATE_INVALID");
    }
    let job_id = format!("{}_diarization", root_job.job_id);
    if let Some(existing) = state.jobs.get(&job_id) {
        return if existing.processing_id == root_job.processing_id && !existing.state.is_terminal()
        {
            Ok(())
        } else {
            Err("SPEECH_RECORD_CANDIDATE_INVALID")
        };
    }
    if state.queue.len() + state.agent_admission_reservations >= MAX_PENDING_JOBS {
        return Err("SPEECH_QUEUE_FULL");
    }
    let now = Utc::now();
    let job = SpeechJob {
        schema_version: JOB_SCHEMA_VERSION,
        job_id,
        kind: SpeechJobKind::RecordDiarization,
        state: SpeechJobState::Queued,
        stage: SpeechJobStage::Validating,
        processing_id: root_job.processing_id.clone(),
        record_baseline: root_job.record_baseline.clone(),
        record_asr_candidate: None,
        origin: root_job.origin.clone(),
        source: root_job.source.clone(),
        output: empty_output(),
        pipeline: root_job.pipeline.clone(),
        created_at: now,
        updated_at: now,
        started_at: None,
        finished_at: None,
        worker_generation: None,
        worker_attempts: 0,
        error: None,
        metrics: None,
    };
    persist_job_resolving_unknown(root, &job).map_err(|_| "SPEECH_JOB_STORE_WRITE_FAILED")?;
    state.queue.push_back(job.job_id.clone());
    log_record_job(&job, "queued");
    state.jobs.insert(job.job_id.clone(), job);
    Ok(())
}

fn finish_processing_root_locked(
    root: &Path,
    state: &mut ManagerState,
    processing_id: &str,
    terminal: SpeechJobState,
    error: Option<SpeechJobError>,
) {
    let Some(mut job) = state.jobs.get(processing_id).cloned() else {
        return;
    };
    if job.kind != SpeechJobKind::RecordBackfillAsr || job.state.is_terminal() {
        return;
    }
    let now = Utc::now();
    job.state = terminal;
    job.updated_at = now;
    job.finished_at = Some(now);
    job.worker_generation = None;
    job.error = error;
    job.output.artifact_available = terminal == SpeechJobState::Succeeded;
    if terminal == SpeechJobState::Succeeded {
        job.stage = SpeechJobStage::Publishing;
    }
    if persist_job_resolving_unknown(root, &job).is_ok() {
        emit_speech_terminal(&job);
    } else {
        crate::ulog_error!("[speech] Record processing terminal metadata could not be persisted");
    }
    // As with finish_job_locked, a known execution outcome is terminal in this
    // Manager even if bookkeeping fails. Store remains publication authority;
    // removing candidates prevents stale durable Running jobs publishing later.
    let children = state
        .jobs
        .values()
        .filter(|child| {
            child.job_id != processing_id
                && child.processing_id.as_deref() == Some(processing_id)
                && !child.state.is_terminal()
        })
        .cloned()
        .collect::<Vec<_>>();
    for mut child in children {
        child.state = terminal;
        child.error = job.error.clone();
        child.updated_at = now;
        child.finished_at = Some(now);
        child.worker_generation = None;
        child.output.artifact_available = terminal == SpeechJobState::Succeeded;
        if terminal == SpeechJobState::Succeeded {
            child.stage = SpeechJobStage::Publishing;
        }
        // Recovery repeats this projection from the terminal root or Store if
        // the child write is interrupted.
        let _ = persist_job_resolving_unknown(root, &child);
        state.queue.retain(|id| id != &child.job_id);
        state.jobs.insert(child.job_id.clone(), child);
    }
    state.queue.retain(|id| id != processing_id);
    state.jobs.insert(processing_id.into(), job);
    record_processing::cleanup_record_private(root, processing_id);
}

fn update_record_queued_status(store: &ManagedRecordStore, kind: SpeechJobKind, record_id: &str) {
    let result = match kind {
        SpeechJobKind::RecordBackfillAsr => {
            tauri::async_runtime::block_on(store.update_audio_processing_status(
                record_id,
                Some(TranscriptionStatus::Queued),
                None,
            ))
        }
        SpeechJobKind::RecordDiarization => tauri::async_runtime::block_on(
            store.update_audio_processing_status(record_id, None, Some(DiarizationStatus::Queued)),
        ),
        SpeechJobKind::AgentAttachmentAsr => return,
    };
    if let Err(error) = result {
        crate::ulog_warn!(
            "[speech] failed to project queued status recordId={} error={}",
            record_id,
            error
        );
    }
}

fn update_record_terminal_status(
    store: &ManagedRecordStore,
    kind: SpeechJobKind,
    record_id: &str,
    _succeeded: bool,
) {
    let result = match kind {
        SpeechJobKind::RecordBackfillAsr => {
            tauri::async_runtime::block_on(store.update_audio_processing_status(
                record_id,
                Some(TranscriptionStatus::Failed),
                None,
            ))
        }
        SpeechJobKind::RecordDiarization => tauri::async_runtime::block_on(
            store.update_audio_processing_status(record_id, None, Some(DiarizationStatus::Failed)),
        ),
        SpeechJobKind::AgentAttachmentAsr => return,
    };
    if let Err(error) = result {
        crate::ulog_warn!(
            "[speech] failed to project terminal status recordId={} error={}",
            record_id,
            error
        );
    }
}

fn new_job_id() -> String {
    format!("speech_{}", Uuid::new_v4().simple())
}

fn native_algorithm_revision(path: &Path) -> Result<String, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 256 * 1024 {
        return Err("SPEECH_NATIVE_RUNTIME_UNAVAILABLE");
    }
    let bytes = fs::read(path).map_err(|_| "SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?;
    let native = manifest
        .get("buildFingerprint")
        .and_then(|value| value.as_str())
        .filter(|fingerprint| {
            fingerprint.len() == 64 && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .ok_or("SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?;
    // Worker/native/protocol are content-addressed by prepare. Store publication
    // and human-operation semantics are an App algorithm too; changing them
    // must invalidate an old queued candidate even when the model is unchanged.
    const RECORD_PROCESSING_POLICY: &str = "record-source-processing-v1";
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("{RECORD_PROCESSING_POLICY}:{native}").as_bytes())
    ))
}

fn empty_output() -> SpeechJobOutput {
    SpeechJobOutput {
        root_directory: None,
        job_directory: None,
        transcript_markdown_path: None,
        transcript_json_path: None,
        artifact_available: false,
    }
}

fn pipeline_from_provenance(provenance: &RecordSpeechProvenance) -> SpeechPipelineSnapshot {
    SpeechPipelineSnapshot {
        algorithm_revision: provenance.algorithm_revision.clone(),
        provider: provenance.provider.clone(),
        model_pack_revision: provenance.model_pack_revision.clone(),
        onnx_runtime_version: provenance.onnx_runtime_version.clone(),
    }
}

fn settle_for_process_boundary(job: &mut SpeechJob, now: DateTime<Utc>) {
    job.updated_at = now;
    job.worker_generation = None;
    job.started_at = None;
    if job.kind.is_agent() {
        job.state = SpeechJobState::Interrupted;
        job.finished_at = Some(now);
        job.error = Some(SpeechJobError {
            code: "SPEECH_INTERRUPTED".into(),
            retryable: true,
        });
    } else if job.kind == SpeechJobKind::RecordBackfillAsr && job.record_asr_candidate.is_some() {
        job.state = SpeechJobState::Running;
        job.stage = SpeechJobStage::Diarizing;
        job.finished_at = None;
    } else {
        job.state = SpeechJobState::Queued;
        job.stage = SpeechJobStage::Validating;
        job.finished_at = None;
        job.error = None;
    }
}

fn recovered_record_queue(jobs: &HashMap<String, SpeechJob>) -> VecDeque<String> {
    let mut queued = jobs
        .values()
        .filter(|job| !job.kind.is_agent() && job.state == SpeechJobState::Queued)
        .collect::<Vec<_>>();
    queued.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    queued.iter().map(|job| job.job_id.clone()).collect()
}

fn recover_agent_publish_intents(root: &Path, jobs: &mut HashMap<String, SpeechJob>) {
    for job in jobs.values().filter(|job| job.kind.is_agent()) {
        let Some(output_root) = job.output.root_directory.as_deref().map(Path::new) else {
            continue;
        };
        let Some(destination) = job.output.job_directory.as_deref().map(Path::new) else {
            continue;
        };
        let staging = output_root.join(format!(".myagents-speech-{}.staging", job.job_id));
        let private_dir = root.join("private").join(&job.job_id);
        let private_token = read_agent_token(
            &private_dir.join(AGENT_PRIVATE_STAGING_TOKEN),
            AGENT_PRIVATE_STAGING_TOKEN,
        );
        let intent = read_agent_publish_intent(root, &job.job_id).filter(|intent| {
            intent.schema_version == 1
                && intent.job_id == job.job_id
                && Path::new(&intent.staging_directory) == staging
                && Path::new(&intent.destination_directory) == destination
                && valid_agent_staging_token(&intent.staging_token)
                && private_token
                    .as_deref()
                    .map_or(true, |private| private == intent.staging_token)
        });
        let Some(token) = intent
            .as_ref()
            .map(|intent| intent.staging_token.as_str())
            .or(private_token.as_deref())
        else {
            continue;
        };

        if matches!(
            job.state,
            SpeechJobState::Succeeded | SpeechJobState::SucceededWithWarnings
        ) {
            if let Ok(identity) = same_file::Handle::from_path(destination) {
                if validate_agent_directory(destination, &identity, token).is_ok() {
                    let _cleaned = fs::remove_file(destination.join(AGENT_STAGING_MARKER))
                        .and_then(|_| crate::durable_fs::sync_directory(destination))
                        .is_ok();
                }
            }
            cleanup_agent_owned_directory(&staging, token);
            let _ = clear_agent_publish_intent(root, &job.job_id);
            cleanup_agent_private_directory(root, &private_dir);
            continue;
        }

        // Before terminal metadata commits, an authenticated destination is
        // still private staging even if the directory rename was visible.
        // Never expose or delete a replacement path whose inode/token changed.
        cleanup_agent_owned_directory(destination, token);
        cleanup_agent_owned_directory(&staging, token);
        let destination_owned = agent_directory_has_token(destination, token);
        let staging_owned = agent_directory_has_token(&staging, token);
        if !destination_owned && !staging_owned {
            let _ = clear_agent_publish_intent(root, &job.job_id);
            cleanup_agent_private_directory(root, &private_dir);
        }
    }
}

fn read_agent_publish_intent(root: &Path, job_id: &str) -> Option<AgentPublishIntent> {
    let path = agent_publish_intent_path(root, job_id);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn read_agent_token(path: &Path, label: &str) -> Option<String> {
    let file =
        crate::workspace_files::path_safety::open_regular_file_no_follow(path, label).ok()?;
    let mut token = String::new();
    file.take(128).read_to_string(&mut token).ok()?;
    valid_agent_staging_token(&token).then_some(token)
}

fn agent_directory_has_token(path: &Path, token: &str) -> bool {
    same_file::Handle::from_path(path)
        .is_ok_and(|identity| validate_agent_directory(path, &identity, token).is_ok())
}

fn cleanup_agent_owned_directory(path: &Path, token: &str) {
    let Ok(identity) = same_file::Handle::from_path(path) else {
        return;
    };
    if validate_agent_directory(path, &identity, token).is_err() {
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    for _ in 0..8 {
        let suffix = Uuid::new_v4().simple().to_string();
        let quarantine = parent.join(format!(".myagents-speech-cleanup-{}", &suffix[..12]));
        match crate::durable_fs::rename_directory_noreplace(path, &quarantine) {
            Ok(()) => {
                if validate_agent_directory(&quarantine, &identity, token).is_err() {
                    let _ = crate::durable_fs::rename_directory_noreplace(&quarantine, path);
                    return;
                }
                let _ = fs::remove_dir_all(&quarantine);
                let _ = crate::durable_fs::sync_directory(parent);
                return;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return,
        }
    }
}

fn cleanup_agent_private_directory(root: &Path, private_dir: &Path) {
    let private_root = root.join("private");
    if private_dir.parent() == Some(private_root.as_path())
        && fs::symlink_metadata(private_dir)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        let _ = fs::remove_dir_all(private_dir);
        let _ = crate::durable_fs::sync_directory(&private_root);
    }
}

fn recover_nonterminal_jobs(root: &Path, jobs: &mut HashMap<String, SpeechJob>) {
    let now = Utc::now();
    for job in jobs.values_mut().filter(|job| !job.state.is_terminal()) {
        settle_for_process_boundary(job, now);
        let _ = persist_job(root, job);
    }
}

fn prune_expired_jobs(root: &Path, jobs: &mut HashMap<String, SpeechJob>) {
    let cutoff = Utc::now() - Duration::days(SPEECH_HISTORY_RETENTION_DAYS);
    let expired = jobs
        .iter()
        .filter_map(|(id, job)| {
            let terminal_at = job.finished_at.unwrap_or(job.updated_at);
            (job.state.is_terminal() && terminal_at < cutoff).then_some(id.clone())
        })
        .collect::<Vec<_>>();
    for id in expired {
        jobs.remove(&id);
        let _ = fs::remove_dir_all(root.join("jobs").join(&id));
        let _ = fs::remove_dir_all(root.join("private").join(id));
    }
}

fn load_jobs(root: &Path) -> Result<HashMap<String, SpeechJob>, String> {
    let mut jobs = HashMap::new();
    let entries =
        fs::read_dir(root.join("jobs")).map_err(|error| format!("read speech jobs: {error}"))?;
    for entry in entries.take(10_000).flatten() {
        let directory = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&directory) else {
            continue;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let path = directory.join("job.json");
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() == 0
            || metadata.len() > MAX_JOB_METADATA_BYTES
        {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let Ok(job) = serde_json::from_slice::<SpeechJob>(&bytes) else {
            continue;
        };
        if job.schema_version == JOB_SCHEMA_VERSION
            && entry.file_name().to_string_lossy() == job.job_id
            && validate_job_id(&job.job_id).is_ok()
            && valid_job_shape(&job)
        {
            jobs.insert(job.job_id.clone(), job);
        }
    }
    Ok(jobs)
}

fn valid_job_shape(job: &SpeechJob) -> bool {
    let valid_reference = |reference: &SpeechCandidateReference, limit| {
        reference.size_bytes > 0
            && reference.size_bytes <= limit
            && reference.sha256.len() == 64
            && reference
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
    };
    if job
        .pipeline
        .algorithm_revision
        .as_ref()
        .is_some_and(|revision| {
            revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return false;
    }
    match job.processing_id.as_deref() {
        Some(processing_id) => {
            if job.kind.is_agent()
                || validate_job_id(processing_id).is_err()
                || !job
                    .record_baseline
                    .as_ref()
                    .is_some_and(|reference| valid_reference(reference, 8 * 1024 * 1024))
                || job
                    .record_asr_candidate
                    .as_ref()
                    .is_some_and(|reference| !valid_reference(reference, 64 * 1024 * 1024))
            {
                return false;
            }
            match job.kind {
                SpeechJobKind::RecordBackfillAsr if processing_id != job.job_id => return false,
                SpeechJobKind::RecordDiarization
                    if job.job_id != format!("{processing_id}_diarization")
                        || job.record_asr_candidate.is_some() =>
                {
                    return false
                }
                _ => {}
            }
        }
        None if job.record_baseline.is_some() || job.record_asr_candidate.is_some() => {
            return false
        }
        None => {}
    }
    match (&job.kind, &job.origin) {
        (
            SpeechJobKind::AgentAttachmentAsr,
            SpeechJobOrigin::Agent {
                initiator_session_id,
                workspace_identity,
            },
        ) => {
            validate_session_id(initiator_session_id).is_ok()
                && Path::new(workspace_identity).is_absolute()
        }
        (
            SpeechJobKind::RecordBackfillAsr | SpeechJobKind::RecordDiarization,
            SpeechJobOrigin::Record { record_id },
        ) => validate_job_id(record_id).is_ok(),
        _ => false,
    }
}

fn agent_source_version(metadata: &fs::Metadata) -> AgentSourceVersion {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    #[cfg(windows)]
    use std::os::windows::fs::MetadataExt;

    AgentSourceVersion {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
        #[cfg(unix)]
        ctime: metadata.ctime(),
        #[cfg(unix)]
        ctime_nsec: metadata.ctime_nsec(),
        #[cfg(windows)]
        last_write_time: metadata.last_write_time(),
    }
}

fn copy_agent_source(
    source: &mut File,
    destination: &Path,
    expected_size: u64,
    expected_version: &AgentSourceVersion,
    mut checkpoint: impl FnMut() -> Result<(), &'static str>,
) -> Result<String, String> {
    if agent_source_version(&source.metadata().map_err(|_| "SPEECH_SOURCE_READ_FAILED")?)
        != *expected_version
    {
        return Err("SPEECH_SOURCE_CHANGED".into());
    }
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| "SPEECH_SOURCE_READ_FAILED".to_string())?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| "SPEECH_PRIVATE_STORAGE_UNAVAILABLE".to_string())?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        checkpoint().map_err(str::to_string)?;
        let read = source
            .read(&mut buffer)
            .map_err(|_| "SPEECH_SOURCE_READ_FAILED".to_string())?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| "SPEECH_MEDIA_LIMIT_EXCEEDED".to_string())?;
        if total > MAX_AGENT_SOURCE_BYTES {
            return Err("SPEECH_MEDIA_LIMIT_EXCEEDED".into());
        }
        output
            .write_all(&buffer[..read])
            .map_err(|_| "SPEECH_PRIVATE_STORAGE_UNAVAILABLE".to_string())?;
        digest.update(&buffer[..read]);
    }
    if total != expected_size
        || agent_source_version(&source.metadata().map_err(|_| "SPEECH_SOURCE_READ_FAILED")?)
            != *expected_version
    {
        return Err("SPEECH_SOURCE_CHANGED".into());
    }
    output
        .sync_all()
        .map_err(|_| "SPEECH_PRIVATE_STORAGE_UNAVAILABLE".to_string())?;
    Ok(format!("{:x}", digest.finalize()))
}

fn write_agent_staging_marker(staging: &Path, token: &str) -> Result<(), String> {
    write_agent_token_file(&staging.join(AGENT_STAGING_MARKER), token)?;
    crate::durable_fs::sync_directory(staging)
        .map_err(|error| format!("sync speech staging: {error}"))
}

fn write_agent_private_staging_token(private: &Path, token: &str) -> Result<(), String> {
    write_agent_token_file(&private.join(AGENT_PRIVATE_STAGING_TOKEN), token)?;
    crate::durable_fs::sync_directory(private)
        .map_err(|error| format!("sync speech private input: {error}"))
}

fn write_agent_token_file(path: &Path, token: &str) -> Result<(), String> {
    if !valid_agent_staging_token(token) {
        return Err("speech staging token is invalid".into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("create speech staging marker: {error}"))?;
    file.write_all(token.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("write speech staging marker: {error}"))
}

fn valid_agent_staging_token(token: &str) -> bool {
    token.len() == 32
        && token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_agent_staging(pending: &PendingAgentJob) -> Result<(), &'static str> {
    validate_agent_directory(
        &pending.staging_dir,
        &pending.staging_identity,
        &pending.staging_token,
    )
}

fn validate_agent_directory(
    directory: &Path,
    expected_identity: &same_file::Handle,
    expected_token: &str,
) -> Result<(), &'static str> {
    if !same_file::Handle::from_path(directory).is_ok_and(|current| &current == expected_identity) {
        return Err("SPEECH_OUTPUT_PATH_UNSAFE");
    }
    let marker = directory.join(AGENT_STAGING_MARKER);
    let marker_file = crate::workspace_files::path_safety::open_regular_file_no_follow(
        &marker,
        "speech staging marker",
    )
    .map_err(|_| "SPEECH_OUTPUT_PATH_UNSAFE")?;
    let mut token = String::new();
    marker_file
        .take(128)
        .read_to_string(&mut token)
        .map_err(|_| "SPEECH_OUTPUT_PATH_UNSAFE")?;
    if token != expected_token || !valid_agent_staging_token(&token) {
        return Err("SPEECH_OUTPUT_PATH_UNSAFE");
    }
    Ok(())
}

fn validate_agent_publish_paths(
    job: &SpeechJob,
    pending: &PendingAgentJob,
) -> Result<(), &'static str> {
    let output_root = job
        .output
        .root_directory
        .as_deref()
        .map(Path::new)
        .ok_or("SPEECH_OUTPUT_PATH_UNSAFE")?;
    if !same_file::Handle::from_path(output_root)
        .is_ok_and(|current| current == pending.output_root_identity)
    {
        return Err("SPEECH_OUTPUT_PATH_UNSAFE");
    }
    validate_agent_staging(pending)
}

fn publish_agent_staging(
    pending: &PendingAgentJob,
    destination: &Path,
) -> Result<(), &'static str> {
    let output_root = destination.parent().ok_or("SPEECH_OUTPUT_PATH_UNSAFE")?;
    if !same_file::Handle::from_path(output_root)
        .is_ok_and(|current| current == pending.output_root_identity)
        || validate_agent_staging(pending).is_err()
    {
        return Err("SPEECH_OUTPUT_PATH_UNSAFE");
    }
    crate::durable_fs::rename_directory_noreplace(&pending.staging_dir, destination).map_err(
        |error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "SPEECH_OUTPUT_COLLISION"
            } else {
                "SPEECH_PUBLISH_FAILED"
            }
        },
    )?;
    if validate_agent_directory(
        destination,
        &pending.staging_identity,
        &pending.staging_token,
    )
    .is_err()
        || crate::durable_fs::sync_directory(output_root).is_err()
    {
        let _ = rollback_agent_publish(
            destination,
            &pending.staging_dir,
            &pending.staging_identity,
            &pending.staging_token,
        );
        return Err("SPEECH_PUBLISH_FAILED");
    }
    Ok(())
}

fn rollback_agent_publish(
    destination: &Path,
    staging: &Path,
    expected_identity: &same_file::Handle,
    token: &str,
) -> bool {
    if validate_agent_directory(destination, expected_identity, token).is_err()
        || fs::symlink_metadata(staging).is_ok()
    {
        return false;
    }
    if crate::durable_fs::rename_directory_noreplace(destination, staging).is_err()
        || validate_agent_directory(staging, expected_identity, token).is_err()
    {
        return false;
    }
    destination
        .parent()
        .is_some_and(|root| crate::durable_fs::sync_directory(root).is_ok())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTranscriptArtifact<'a> {
    schema_version: u32,
    job_id: &'a str,
    sample_rate_hz: u32,
    segments: Vec<AgentTranscriptArtifactSegment<'a>>,
    provenance: AgentTranscriptProvenance<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTranscriptArtifactSegment<'a> {
    segment_id: &'a str,
    start_ms: u64,
    end_ms: u64,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTranscriptProvenance<'a> {
    provider: &'a str,
    model_pack_revision: &'a str,
    onnx_runtime_version: &'a str,
    media_kind: &'a str,
    codec: &'a str,
}

fn write_agent_artifacts(
    staging: &Path,
    job: &SpeechJob,
    provenance: &RecordSpeechProvenance,
    transcripts: &[RecordTranscriptSegment],
) -> Result<(), &'static str> {
    let segments = transcripts
        .iter()
        .map(|segment| AgentTranscriptArtifactSegment {
            segment_id: &segment.segment_id,
            start_ms: segment.start_sample.saturating_mul(1_000) / 16_000,
            end_ms: segment.end_sample.saturating_mul(1_000) / 16_000,
            text: &segment.text,
            language: segment.language.as_deref(),
        })
        .collect::<Vec<_>>();
    let artifact = AgentTranscriptArtifact {
        schema_version: 1,
        job_id: &job.job_id,
        sample_rate_hz: 16_000,
        segments,
        provenance: AgentTranscriptProvenance {
            provider: &provenance.provider,
            model_pack_revision: &provenance.model_pack_revision,
            onnx_runtime_version: &provenance.onnx_runtime_version,
            media_kind: job
                .source
                .media_kind
                .as_deref()
                .ok_or("SPEECH_WORKER_PROTOCOL_ERROR")?,
            codec: job
                .source
                .codec
                .as_deref()
                .ok_or("SPEECH_WORKER_PROTOCOL_ERROR")?,
        },
    };
    let json = serde_json::to_vec_pretty(&artifact).map_err(|_| "SPEECH_PUBLISH_FAILED")?;
    let mut markdown = String::from("# Transcript\n\n");
    for segment in &artifact.segments {
        use std::fmt::Write as _;
        writeln!(
            markdown,
            "[{} – {}] {}\n",
            format_agent_timestamp(segment.start_ms),
            format_agent_timestamp(segment.end_ms),
            segment.text
        )
        .map_err(|_| "SPEECH_PUBLISH_FAILED")?;
    }
    write_agent_artifact_file(&staging.join("transcript.json"), &json)?;
    write_agent_artifact_file(&staging.join("transcript.md"), markdown.as_bytes())?;
    crate::durable_fs::sync_directory(staging).map_err(|_| "SPEECH_PUBLISH_FAILED")
}

fn write_agent_artifact_file(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "SPEECH_PUBLISH_FAILED")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "SPEECH_PUBLISH_FAILED")
}

fn format_agent_timestamp(milliseconds: u64) -> String {
    let total_seconds = milliseconds / 1_000;
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        total_seconds / 3_600,
        (total_seconds / 60) % 60,
        total_seconds % 60,
        milliseconds % 1_000
    )
}

fn agent_artifact_is_available(job: &SpeechJob) -> bool {
    job.kind.is_agent()
        && matches!(
            job.state,
            SpeechJobState::Succeeded | SpeechJobState::SucceededWithWarnings
        )
        && job
            .output
            .transcript_markdown_path
            .as_deref()
            .is_some_and(|path| plain_file(Path::new(path)))
        && job
            .output
            .transcript_json_path
            .as_deref()
            .is_some_and(|path| plain_file(Path::new(path)))
}

fn cleanup_agent_private_input(pending: &PendingAgentJob) {
    if same_file::Handle::from_path(&pending.private_dir)
        .is_ok_and(|current| current == pending.private_identity)
    {
        let _ = fs::remove_dir_all(&pending.private_dir);
    }
}

fn cleanup_pending_agent(pending: &PendingAgentJob) {
    cleanup_agent_private_input(pending);
    if same_file::Handle::from_path(&pending.staging_dir)
        .is_ok_and(|current| current == pending.staging_identity)
    {
        let _ = fs::remove_dir_all(&pending.staging_dir);
    }
}

fn agent_publish_intent_path(root: &Path, job_id: &str) -> PathBuf {
    root.join("jobs").join(job_id).join(AGENT_PUBLISH_INTENT)
}

fn persist_agent_publish_intent(root: &Path, intent: &AgentPublishIntent) -> Result<(), String> {
    let content = serde_json::to_string_pretty(intent)
        .map_err(|error| format!("serialize speech publish intent: {error}"))?;
    crate::task::write_atomic_text(&agent_publish_intent_path(root, &intent.job_id), &content)
}

fn clear_agent_publish_intent(root: &Path, job_id: &str) -> Result<(), String> {
    let path = agent_publish_intent_path(root, job_id);
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("remove speech publish intent: {error}")),
    }
    path.parent()
        .ok_or_else(|| "speech publish intent parent missing".to_string())
        .and_then(|parent| {
            crate::durable_fs::sync_directory(parent)
                .map_err(|error| format!("sync speech publish intent directory: {error}"))
        })
}

fn persist_job(root: &Path, job: &SpeechJob) -> Result<(), String> {
    let content = serde_json::to_string_pretty(job)
        .map_err(|error| format!("serialize speech job: {error}"))?;
    crate::task::write_atomic_text(
        &root.join("jobs").join(&job.job_id).join("job.json"),
        &content,
    )
}

fn persist_job_resolving_unknown(root: &Path, job: &SpeechJob) -> Result<(), String> {
    match persist_job(root, job) {
        Ok(()) => Ok(()),
        Err(original) => {
            let path = root.join("jobs").join(&job.job_id).join("job.json");
            let expected = serde_json::to_value(job)
                .map_err(|error| format!("serialize expected speech job: {error}"))?;
            let persisted_matches = fs::read_to_string(&path)
                .ok()
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
                .is_some_and(|actual| actual == expected);
            if persisted_matches
                && path
                    .parent()
                    .is_some_and(|parent| crate::durable_fs::sync_directory(parent).is_ok())
            {
                Ok(())
            } else {
                Err(original)
            }
        }
    }
}

fn validate_job_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("SPEECH_JOB_ID_INVALID");
    }
    Ok(())
}

fn validate_session_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err("SPEECH_SESSION_REQUIRED");
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("create speech store: {error}"))?;
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("inspect speech store: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("speech store path must be a plain directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("protect speech store: {error}"))?;
    }
    Ok(())
}

fn plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

#[tauri::command]
pub fn cmd_speech_model_pack_status(
    manager: tauri::State<'_, ManagedSpeechRecognition>,
) -> SpeechModelPackStatus {
    manager.model_pack_status()
}

#[tauri::command]
pub async fn cmd_speech_model_pack_install(
    manager: tauri::State<'_, ManagedSpeechRecognition>,
) -> Result<SpeechModelPackStatus, String> {
    manager.install_model_pack().await
}

#[tauri::command]
pub fn cmd_speech_model_pack_remove(
    manager: tauri::State<'_, ManagedSpeechRecognition>,
) -> Result<SpeechModelPackStatus, String> {
    manager.remove_model_pack()
}

#[tauri::command]
pub async fn cmd_speech_record_transcribe(
    manager: tauri::State<'_, ManagedSpeechRecognition>,
    record_id: String,
) -> Result<SpeechJob, String> {
    manager.inner().submit_record_backfill(&record_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_inference::LocalInferenceRuntimeRegistry;
    use crate::record::{
        AudioRecordCreateInput, AudioTrackArtifactInput, CaptureStatus, RecordStore,
    };
    use myagents_media_worker_protocol::{
        write_control_frame, Checkpoint, PcmStreamCheckpoint, WorkerMetrics, WorkerResponse,
    };

    #[test]
    fn deterministic_model_stage_failures_do_not_repeat_the_entire_recording() {
        for code in [
            "SPEECH_ASR_FAILED",
            "SPEECH_ASR_RESOURCE_LIMIT",
            "SPEECH_ASR_OUTPUT_INVALID",
            "SPEECH_VAD_FAILED",
            "SPEECH_VAD_OUTPUT_INVALID",
            "SPEECH_DIARIZATION_FAILED",
        ] {
            assert!(!worker_code_retryable(code), "{code}");
        }
        assert!(worker_code_retryable("SPEECH_WORKER_DISCONNECTED"));
    }

    fn fixture_job(
        job_id: &str,
        kind: SpeechJobKind,
        origin: SpeechJobOrigin,
        state: SpeechJobState,
        created_at: DateTime<Utc>,
    ) -> SpeechJob {
        SpeechJob {
            processing_id: None,
            record_baseline: None,
            record_asr_candidate: None,
            schema_version: JOB_SCHEMA_VERSION,
            job_id: job_id.into(),
            kind,
            state,
            stage: SpeechJobStage::Transcribing,
            origin,
            source: SpeechJobSource {
                path: "/private/source".into(),
                size_bytes: 42,
                sha256: None,
                media_kind: None,
                codec: None,
                duration_ms: None,
                used_default_track: None,
            },
            output: SpeechJobOutput {
                root_directory: None,
                job_directory: None,
                transcript_markdown_path: None,
                transcript_json_path: None,
                artifact_available: false,
            },
            pipeline: SpeechPipelineSnapshot {
                algorithm_revision: None,
                provider: "local".into(),
                model_pack_revision: "revision-1".into(),
                onnx_runtime_version: "1.28.0".into(),
            },
            created_at,
            updated_at: created_at,
            started_at: Some(created_at),
            finished_at: None,
            worker_generation: Some(9),
            worker_attempts: 1,
            error: None,
            metrics: None,
        }
    }

    fn manager(root: &tempfile::TempDir) -> ManagedSpeechRecognition {
        let data = root.path().join("data");
        let resources = root.path().join("resources");
        fs::create_dir_all(&resources).unwrap();
        let bundle = resources.join("document-processing/v1");
        fs::create_dir_all(bundle.join("native")).unwrap();
        fs::write(bundle.join("native/runtime.fixture"), b"fixture").unwrap();
        let manifest = serde_json::json!({
            "schemaVersion": 1,
            "platform": std::env::consts::OS,
            "architecture": if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" },
            "files": { "onnxRuntime": { "path": "native/runtime.fixture", "size": 7,
                "sha256": format!("{:x}", Sha256::digest(b"fixture")), "license": "MIT",
                "upstreamRevision": "v1.28.0@test", "artifactSource": "synthetic test",
                "signing": { "kind": "sha256-manifest", "identity": "test" } } },
        });
        fs::write(
            bundle.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let runtime = LocalInferenceRuntimeRegistry::initialize(&resources);
        let records = Arc::new(RecordStore::new(data.join("records"), None));
        SpeechRecognitionManager::initialize_inner(
            data,
            resources,
            runtime,
            LocalComputeCoordinator::new(),
            records,
            false,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn updater_observes_probe_reservation_and_queued_speech_until_released() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        assert!(!manager.has_pending_work().unwrap());
        let reservation = manager.reserve_agent_admission().unwrap();
        assert!(manager.has_pending_work().unwrap());
        drop(reservation);
        assert!(!manager.has_pending_work().unwrap());
        manager
            .state
            .lock()
            .unwrap()
            .queue
            .push_back("pending-speech".into());
        assert!(manager.has_pending_work().unwrap());
        manager.state.lock().unwrap().queue.clear();
        assert!(!manager.has_pending_work().unwrap());
    }

    #[tokio::test]
    async fn text_record_delete_preflight_does_not_project_audio_processing() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let record = manager
            .record_store
            .create_text(crate::record::TextRecordCreateInput {
                content: "Text Record delete regression".to_string(),
                images: Vec::new(),
            })
            .await
            .unwrap();
        manager.cancel_record_processing(&record.id).await.unwrap();
        let retained = manager.record_store.get(&record.id).await.unwrap();
        assert_eq!(retained.kind, RecordKind::Text);
        assert_eq!(retained.content, record.content);
        assert_eq!(retained.revision, record.revision);
        manager.record_store.delete(&record.id).await.unwrap();
        assert!(manager.record_store.get(&record.id).await.is_none());
    }

    #[test]
    fn record_backfill_accepts_only_the_selected_physical_or_real_legacy_sources() {
        let dual_input = WorkloadInput::RecordArtifacts {
            identity_anchors: None,
            inputs: vec![
                RecordArtifactInput {
                    timeline: None,
                    input_path: "/record/microphone.opus".into(),
                    track: TrackKind::Microphone,
                },
                RecordArtifactInput {
                    timeline: None,
                    input_path: "/record/system.opus".into(),
                    track: TrackKind::System,
                },
            ],
        };
        assert_eq!(
            expected_record_backfill_tracks(&dual_input),
            Ok(vec![AudioTrackKind::Microphone, AudioTrackKind::System])
        );
        assert_eq!(
            record_backfill_track(
                TrackKind::Microphone,
                Some(&[AudioTrackKind::Microphone, AudioTrackKind::System])
            ),
            Ok(AudioTrackKind::Microphone)
        );
        assert_eq!(
            record_backfill_track(
                TrackKind::Mixed,
                Some(&[AudioTrackKind::Microphone, AudioTrackKind::System])
            ),
            Err("SPEECH_WORKER_PROTOCOL_ERROR")
        );
        assert_eq!(
            record_backfill_track(TrackKind::Mixed, Some(&[AudioTrackKind::Mixed])),
            Ok(AudioTrackKind::Mixed)
        );
        assert_eq!(
            record_backfill_track(TrackKind::Microphone, Some(&[AudioTrackKind::Mixed])),
            Err("SPEECH_WORKER_PROTOCOL_ERROR")
        );
        assert_eq!(
            record_source_track(TrackKind::Mixed),
            Err("SPEECH_WORKER_PROTOCOL_ERROR")
        );
    }

    async fn staged_record_fixture(
        manager: &ManagedSpeechRecognition,
        record_id: Option<&str>,
        processing_id: &str,
        text: &str,
    ) -> (String, SpeechJob) {
        let record_id = if let Some(id) = record_id {
            id.to_owned()
        } else {
            let record = manager
                .record_store
                .create_audio(AudioRecordCreateInput {
                    title: "Synthetic staged record".into(),
                    tracks: vec![AudioTrackKind::Microphone],
                    transcription_status: TranscriptionStatus::Queued,
                })
                .await
                .unwrap();
            let directory = manager
                .record_store
                .audio_workspace_path(&record.id)
                .await
                .unwrap();
            fs::write(directory.join("audio/microphone.opus"), b"synthetic audio").unwrap();
            manager
                .record_store
                .finalize_audio_capture(
                    &record.id,
                    CaptureStatus::Ready,
                    1_000,
                    vec![AudioTrackArtifactInput {
                        track: AudioTrackKind::Microphone,
                        relative_path: "audio/microphone.opus".into(),
                        timeline: None,
                        capture_time_error: None,
                    }],
                )
                .await
                .unwrap();
            record.id
        };
        let baseline = manager
            .record_store
            .prepare_speech_processing(&record_id)
            .await
            .unwrap();
        let mut job = fixture_job(
            processing_id,
            SpeechJobKind::RecordBackfillAsr,
            SpeechJobOrigin::Record {
                record_id: record_id.clone(),
            },
            SpeechJobState::Running,
            Utc::now(),
        );
        job.processing_id = Some(processing_id.into());
        job.stage = SpeechJobStage::Diarizing;
        job.worker_generation = None;
        let input = RecordProcessingInput {
            processing_id: processing_id.into(),
            baseline,
            pipeline: job.pipeline.clone(),
            runtime_sha256: manager
                .runtime_registry
                .identity(InferenceRuntimeKind::OnnxCpu)
                .unwrap()
                .sha256()
                .into(),
            model_manifest_sha256: "a".repeat(64),
        };
        job.record_baseline = Some(
            record_processing::write_candidate(
                &manager.root,
                processing_id,
                record_processing::BASELINE_FILE,
                &input,
            )
            .unwrap(),
        );
        let candidate = RecordAsrCandidate {
            processing_id: processing_id.into(),
            worker_generation: 7,
            pipeline: job.pipeline.clone(),
            segments: vec![RecordTranscriptSegment {
                segment_id: "same-segment-id".into(),
                track: AudioTrackKind::Microphone,
                start_sample: 0,
                end_sample: 16_000,
                text: text.into(),
                language: None,
                revision: 1,
            }],
        };
        job.record_asr_candidate = Some(
            record_processing::write_candidate(
                &manager.root,
                processing_id,
                record_processing::ASR_FILE,
                &candidate,
            )
            .unwrap(),
        );
        persist_job(&manager.root, &job).unwrap();
        let mut state = manager.state.lock().unwrap();
        state.jobs.insert(job.job_id.clone(), job.clone());
        enqueue_diarization_locked(&manager.root, &mut state, &job).unwrap();
        (record_id, job)
    }

    #[tokio::test]
    async fn processing_recovery_repairs_stage_enqueue_and_committed_manifest_then_cancel_releases_candidates(
    ) {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let (record_id, job) =
            staged_record_fixture(&manager, None, "speech_recover", "kept words").await;
        let child_id = "speech_recover_diarization";
        {
            let mut state = manager.state.lock().unwrap();
            state.jobs.remove(child_id);
            state.queue.clear();
        }
        fs::remove_dir_all(manager.root.join("jobs").join(child_id)).unwrap();
        let recovering = Arc::clone(&manager);
        tauri::async_runtime::spawn_blocking(move || recovering.recover_record_processing())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(manager.queue_snapshot().unwrap(), vec![child_id]);
        assert_eq!(
            manager.state.lock().unwrap().jobs[&job.job_id].record_asr_candidate,
            job.record_asr_candidate
        );
        let input = record_processing::read_input(&manager.root, &job).unwrap();
        let mut candidate = record_processing::read_asr(&manager.root, &job).unwrap();
        let provenance = RecordSpeechProvenance {
            provider: job.pipeline.provider.clone(),
            model_pack_revision: job.pipeline.model_pack_revision.clone(),
            onnx_runtime_version: job.pipeline.onnx_runtime_version.clone(),
            algorithm_revision: None,
        };
        manager
            .record_store
            .commit_speech_processing(
                &input.baseline,
                &job.job_id,
                std::mem::take(&mut candidate.segments),
                Some(vec![RecordSpeakerTurn {
                    source: Some(AudioTrackKind::Microphone),
                    start_sample: 0,
                    end_sample: 16_000,
                    global_speaker: None,
                }]),
                vec![],
                provenance,
            )
            .await
            .unwrap();
        // Simulate committed Record / unfinished job metadata without another
        // inference. Reconciliation must read Store authority, then settle jobs.
        let recovering = Arc::clone(&manager);
        tauri::async_runtime::spawn_blocking(move || recovering.recover_record_processing())
            .await
            .unwrap()
            .unwrap();
        assert!(manager.queue_snapshot().unwrap().is_empty());
        assert_eq!(
            manager.state.lock().unwrap().jobs[&job.job_id].state,
            SpeechJobState::Succeeded
        );
        assert_eq!(
            manager.state.lock().unwrap().jobs[child_id].state,
            SpeechJobState::Succeeded
        );
        assert!(!manager.root.join("private").join(&job.job_id).exists());
        let (_, cancelled) = staged_record_fixture(
            &manager,
            Some(&record_id),
            "speech_cancel",
            "must stay private",
        )
        .await;
        manager.cancel_record_processing(&record_id).await.unwrap();
        assert!(manager.queue_snapshot().unwrap().is_empty());
        assert_eq!(
            manager.state.lock().unwrap().jobs[&cancelled.job_id].state,
            SpeechJobState::Cancelled
        );
        assert_eq!(
            manager.state.lock().unwrap().jobs["speech_cancel_diarization"].state,
            SpeechJobState::Cancelled
        );
        assert!(!manager
            .root
            .join("private")
            .join(&cancelled.job_id)
            .exists());
        assert_eq!(
            manager
                .record_store
                .read_recording_final_transcript(&record_id)
                .await
                .unwrap()
                .unwrap()
                .segments[0]
                .text,
            "kept words"
        );
    }

    #[tokio::test]
    async fn record_processing_metadata_write_failures_settle_and_recover_without_dead_running_jobs(
    ) {
        for scenario in [
            "publish-first",
            "publish-rerun",
            "failure-intent",
            "terminal",
        ] {
            let root = tempfile::tempdir().unwrap();
            let speech = manager(&root);
            let prior_record = if scenario == "publish-rerun" {
                let (id, prior) =
                    staged_record_fixture(&speech, None, "speech_prior", "kept original").await;
                let runner = Arc::clone(&speech);
                tauri::async_runtime::spawn_blocking(move || {
                    let mut state = runner.state.lock().unwrap();
                    runner.fail_record_processing_locked(
                        &mut state,
                        &prior,
                        "SPEECH_INFERENCE_FAILED",
                        false,
                    );
                })
                .await
                .unwrap();
                Some(id)
            } else {
                None
            };
            let (record_id, processing) = staged_record_fixture(
                &speech,
                prior_record.as_deref(),
                "speech_write_failure",
                "candidate words",
            )
            .await;
            let (selected, next_generation) = speech.peek_next_job().unwrap().unwrap();
            let (job, generation) = speech
                .claim_next_job(&selected.job_id, next_generation)
                .unwrap()
                .unwrap();
            let provenance = RecordSpeechProvenance {
                provider: processing.pipeline.provider.clone(),
                model_pack_revision: processing.pipeline.model_pack_revision.clone(),
                onnx_runtime_version: processing.pipeline.onnx_runtime_version.clone(),
                algorithm_revision: processing.pipeline.algorithm_revision.clone(),
            };
            let turns = vec![RecordSpeakerTurn {
                source: Some(AudioTrackKind::Microphone),
                start_sample: 0,
                end_sample: 16_000,
                global_speaker: None,
            }];
            if scenario == "terminal" {
                let input = record_processing::read_input(&speech.root, &processing).unwrap();
                let mut candidate = record_processing::read_asr(&speech.root, &processing).unwrap();
                speech
                    .record_store
                    .commit_speech_processing(
                        &input.baseline,
                        &processing.job_id,
                        std::mem::take(&mut candidate.segments),
                        Some(turns.clone()),
                        vec![],
                        provenance.clone(),
                    )
                    .await
                    .unwrap();
            }
            // A real atomic-write failure, confined to one metadata path. No
            // global failpoint or timing-dependent permission toggles are needed.
            let blocked_id = if scenario.starts_with("publish-") {
                &job.job_id
            } else {
                &processing.job_id
            };
            let path = speech.root.join("jobs").join(blocked_id).join("job.json");
            let backup = path.with_extension("saved");
            fs::rename(&path, &backup).unwrap();
            fs::create_dir(&path).unwrap();
            let runner = Arc::clone(&speech);
            let source = job.clone();
            let processing_id = processing.job_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if scenario.starts_with("publish-") {
                    runner.publish_record_success(
                        &source,
                        generation,
                        &provenance,
                        SpeechWorkerCompletion {
                            transcripts: SensitiveTranscriptSegments::default(),
                            turns,
                            identity_evidence: vec![],
                            metrics: WorkerMetrics {
                                source_samples: 16_000,
                                segments: 1,
                                speakers: 0,
                                elapsed_ms: 5,
                                peak_working_bytes: None,
                            },
                        },
                    );
                } else {
                    let mut state = runner.state.lock().unwrap();
                    if scenario == "failure-intent" {
                        let processing = state.jobs[&processing_id].clone();
                        runner.fail_record_processing_locked(
                            &mut state,
                            &processing,
                            "SPEECH_INFERENCE_FAILED",
                            false,
                        );
                    } else {
                        finish_processing_root_locked(
                            &runner.root,
                            &mut state,
                            &processing_id,
                            SpeechJobState::Succeeded,
                            None,
                        );
                    }
                }
                runner.clear_active(&source.job_id, generation);
            })
            .await
            .unwrap();
            let terminal = if scenario == "terminal" {
                SpeechJobState::Succeeded
            } else {
                SpeechJobState::Failed
            };
            {
                let state = speech.state.lock().unwrap();
                assert_eq!(state.jobs[&processing.job_id].state, terminal, "{scenario}");
                assert_eq!(state.jobs[&job.job_id].state, terminal, "{scenario}");
                assert!(state.active_job.is_none());
                assert!(state.queue.is_empty());
            }
            assert!(!speech
                .root
                .join("private")
                .join(&processing.job_id)
                .exists());
            let visible = speech
                .record_store
                .read_recording_final_transcript(&record_id)
                .await
                .unwrap();
            assert_eq!(
                visible.as_ref().map(|t| t.segments[0].text.as_str()),
                match scenario {
                    "publish-rerun" => Some("kept original"),
                    "terminal" => Some("candidate words"),
                    _ => None,
                }
            );
            // Restore stale metadata, then recover from the real disk state.
            // Store commits or settled child/candidate facts must win over it.
            fs::remove_dir(&path).unwrap();
            fs::rename(&backup, &path).unwrap();
            let restarted = manager(&root);
            let recovering = Arc::clone(&restarted);
            tauri::async_runtime::spawn_blocking(move || recovering.recover_record_processing())
                .await
                .unwrap()
                .unwrap();
            let state = restarted.state.lock().unwrap();
            assert_eq!(
                state.jobs[&processing.job_id].state, terminal,
                "restart {scenario}"
            );
            assert_eq!(
                state.jobs[&job.job_id].state, terminal,
                "restart {scenario}"
            );
            assert!(state.queue.is_empty());
        }
    }

    #[tokio::test]
    async fn waiting_processing_is_deduplicated_and_legacy_speaker_jobs_cannot_reenter_it() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let (record_id, processing) =
            staged_record_fixture(&manager, None, "speech_current", "private words").await;
        // ASR has already staged its candidate; repeated admission must return
        // the whole processing even though its Worker generation has ended.
        let duplicate = manager.submit_record_backfill(&record_id).await.unwrap();
        assert_eq!(duplicate.job_id, processing.job_id);
        let legacy = fixture_job(
            "speech_legacy_speakers",
            SpeechJobKind::RecordDiarization,
            SpeechJobOrigin::Record {
                record_id: record_id.clone(),
            },
            SpeechJobState::Queued,
            Utc::now(),
        );
        persist_job(&manager.root, &legacy).unwrap();
        {
            let mut state = manager.state.lock().unwrap();
            state.queue.push_front(legacy.job_id.clone());
            state.jobs.insert(legacy.job_id.clone(), legacy);
        }
        let before = manager.record_store.get(&record_id).await.unwrap();
        let recovering = Arc::clone(&manager);
        tauri::async_runtime::spawn_blocking(move || recovering.recover_record_processing())
            .await
            .unwrap()
            .unwrap();
        {
            let state = manager.state.lock().unwrap();
            assert_eq!(
                state.jobs["speech_legacy_speakers"].state,
                SpeechJobState::Failed
            );
            assert_eq!(
                state.jobs["speech_legacy_speakers"]
                    .error
                    .as_ref()
                    .unwrap()
                    .code,
                "SPEECH_PIPELINE_REVISION_UNAVAILABLE"
            );
            assert_eq!(state.jobs["speech_current"].state, SpeechJobState::Running);
            assert_eq!(
                state.queue.iter().collect::<Vec<_>>(),
                vec!["speech_current_diarization"]
            );
        }
        assert_eq!(manager.record_store.get(&record_id).await.unwrap(), before);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_fences_late_matching_completion_and_releases_the_worker() {
        use std::os::unix::fs::PermissionsExt;

        for scenario in ["cancel", "delete", "superseded"] {
            let root = tempfile::tempdir().unwrap();
            let manager = manager(&root);
            let (record_id, first) =
                staged_record_fixture(&manager, None, "speech_original", "readable original").await;
            let runner = Arc::clone(&manager);
            tauri::async_runtime::spawn_blocking(move || {
                let mut state = runner.state.lock().unwrap();
                runner.fail_record_processing_locked(
                    &mut state,
                    &first,
                    "SPEECH_INFERENCE_FAILED",
                    false,
                );
            })
            .await
            .unwrap();
            let (_, processing) = staged_record_fixture(
                &manager,
                Some(&record_id),
                "speech_matching",
                "private replacement",
            )
            .await;
            let (selected, next_generation) = manager.peek_next_job().unwrap().unwrap();
            let (job, generation) = manager
                .claim_next_job(&selected.job_id, next_generation)
                .unwrap()
                .unwrap();
            let identity = WorkloadIdentity {
                workload_id: job.job_id.clone(),
                worker_generation: generation,
            };
            let octal_frames = |responses: &[WorkerResponse]| {
                let mut bytes = Vec::new();
                for response in responses {
                    write_control_frame(&mut bytes, response).unwrap();
                }
                bytes
                    .iter()
                    .map(|byte| format!("\\{:03o}", byte))
                    .collect::<String>()
            };
            let before_matching = octal_frames(&[
                WorkerResponse::Ready {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                },
                WorkerResponse::SpeakerTurnBatch {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    revision: 1,
                    batch_index: 0,
                    is_last: true,
                    turns: vec![SpeakerTurn {
                        source: TrackKind::Microphone,
                        start_sample: 0,
                        end_sample: 16_000,
                        global_speaker: None,
                    }],
                },
                WorkerResponse::Heartbeat {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    stage: WorkerStage::ReconcilingSpeakers,
                    checkpoint: Checkpoint {
                        streams: vec![PcmStreamCheckpoint {
                            track: TrackKind::Microphone,
                            last_ack_sequence: None,
                            analysis_sample: 16_000,
                            replay_record_sample: None,
                        }],
                        analysis_sample: 16_000,
                    },
                },
            ]);
            let after_cancel = octal_frames(&[
                WorkerResponse::IdentityEvidenceBatch {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    revision: 1,
                    batch_index: 0,
                    is_last: true,
                    evidence: vec![],
                },
                WorkerResponse::Completed {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    metrics: WorkerMetrics {
                        source_samples: 16_000,
                        segments: 1,
                        speakers: 0,
                        elapsed_ms: 5,
                        peak_working_bytes: None,
                    },
                },
            ]);
            let mut cancel = Vec::new();
            write_control_frame(
                &mut cancel,
                &WorkerCommand::Cancel {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                },
            )
            .unwrap();
            let worker = root.path().join("matching-worker");
            // The fixture waits for the exact cancellation frame, then emits a
            // valid late completion. No timer decides the cancellation race.
            fs::write(&worker, format!(
                "#!/bin/sh\n/usr/bin/printf '{before_matching}'\n/bin/dd bs=1 count={} of=/dev/null 2>/dev/null\n/usr/bin/printf '{after_cancel}'\n",
                cancel.len(),
            )).unwrap();
            fs::set_permissions(&worker, fs::Permissions::from_mode(0o700)).unwrap();
            let resources = SpeechExecutionResources {
                worker_path: worker.clone(),
                native_manifest_path: worker.clone(),
                onnx_runtime_path: worker.clone(),
                model_pack_manifest_path: worker,
                provenance: RecordSpeechProvenance {
                    provider: job.pipeline.provider.clone(),
                    model_pack_revision: job.pipeline.model_pack_revision.clone(),
                    onnx_runtime_version: job.pipeline.onnx_runtime_version.clone(),
                    algorithm_revision: None,
                },
            };
            let (child, stdin, stdout) = manager
                .spawn_registered_worker(&job, generation, &resources)
                .unwrap();
            let lease = manager
                .compute_coordinator
                .acquire(ComputeWorkloadIdentity {
                    kind: ComputeWorkloadKind::RecordDiarization,
                    id: job.job_id.clone(),
                    generation,
                })
                .await;
            let runner = Arc::clone(&manager);
            let execution = tauri::async_runtime::spawn_blocking(move || {
                let yield_state = BatchYieldState::new();
                let outcome = runner.collect_worker_result(
                    &job,
                    generation,
                    &identity,
                    Some(vec![AudioTrackKind::Microphone]),
                    stdout,
                    &stdin,
                    &child,
                    &lease,
                    &yield_state,
                );
                yield_state.mark_settled();
                let _ = process_cmd::settle_tree(&child, StdDuration::from_secs(1));
                runner.clear_running(&job.job_id, generation);
                match outcome {
                    SpeechWorkerOutcome::Completed(completion) => runner.publish_record_success(
                        &job,
                        generation,
                        &resources.provenance,
                        completion,
                    ),
                    SpeechWorkerOutcome::Failed { code, .. } => {
                        panic!("late completion failed: {code}")
                    }
                    SpeechWorkerOutcome::Yielded => panic!("unexpected cooperative yield"),
                }
                runner.clear_active(&job.job_id, generation);
            });
            tokio::time::timeout(StdDuration::from_secs(5), async {
                while manager.state.lock().unwrap().jobs["speech_matching_diarization"].stage
                    != SpeechJobStage::Diarizing
                {
                    tokio::time::sleep(StdDuration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            assert!(manager.compute_coordinator.active_identity().is_some());
            manager.cancel_record_processing(&record_id).await.unwrap();
            if scenario == "delete" {
                manager.record_store.delete(&record_id).await.unwrap();
            }
            if scenario == "superseded" {
                staged_record_fixture(
                    &manager,
                    Some(&record_id),
                    "speech_replacement",
                    "next candidate",
                )
                .await;
            }
            execution.await.unwrap();
            assert!(manager.compute_coordinator.active_identity().is_none());
            assert!(manager.state.lock().unwrap().running.is_none());
            assert!(!manager
                .root
                .join("private")
                .join(&processing.job_id)
                .exists());
            assert!(!manager
                .root
                .join("private/speech_matching_diarization")
                .exists());
            let recovering = Arc::clone(&manager);
            tauri::async_runtime::spawn_blocking(move || recovering.recover_record_processing())
                .await
                .unwrap()
                .unwrap();
            for id in ["speech_matching", "speech_matching_diarization"] {
                assert_eq!(
                    manager.state.lock().unwrap().jobs[id].state,
                    SpeechJobState::Cancelled
                );
            }
            assert_eq!(
                manager.queue_snapshot().unwrap(),
                if scenario == "superseded" {
                    vec!["speech_replacement_diarization".to_owned()]
                } else {
                    vec![]
                }
            );
            if scenario == "delete" {
                assert!(manager.record_store.get(&record_id).await.is_none());
            } else {
                assert_eq!(
                    manager
                        .record_store
                        .read_recording_final_transcript(&record_id)
                        .await
                        .unwrap()
                        .unwrap()
                        .segments[0]
                        .text,
                    "readable original"
                );
            }
        }
    }

    #[tokio::test]
    async fn processing_diarization_failure_publishes_only_the_first_partial_final() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let (record_id, first) =
            staged_record_fixture(&manager, None, "speech_partial", "original readable text").await;
        let runner = Arc::clone(&manager);
        tauri::async_runtime::spawn_blocking(move || {
            let mut state = runner.state.lock().unwrap();
            runner.fail_record_processing_locked(
                &mut state,
                &first,
                "SPEECH_INFERENCE_FAILED",
                false,
            );
        })
        .await
        .unwrap();
        let (_, next) = staged_record_fixture(
            &manager,
            Some(&record_id),
            "speech_failed_rerun",
            "incomplete replacement",
        )
        .await;
        let runner = Arc::clone(&manager);
        tauri::async_runtime::spawn_blocking(move || {
            let mut state = runner.state.lock().unwrap();
            runner.fail_record_processing_locked(
                &mut state,
                &next,
                "SPEECH_INFERENCE_FAILED",
                false,
            );
        })
        .await
        .unwrap();
        let transcript = manager
            .record_store
            .read_recording_final_transcript(&record_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(transcript.processing_id.as_deref(), Some("speech_partial"));
        assert_eq!(transcript.segments[0].text, "original readable text");
        assert!(manager
            .record_store
            .read_diarization_projection(&record_id)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            manager
                .record_transcription_failure(&record_id)
                .unwrap()
                .stage,
            SpeechJobStage::Diarizing
        );
        assert!(!manager.root.join("private/speech_failed_rerun").exists());
    }

    #[test]
    fn live_replay_uses_inference_frontiers_and_never_treats_source_ack_as_record_time() {
        let control = LiveControl::default();
        let committed = vec![RecordTranscriptTrackOffset {
            track: AudioTrackKind::Microphone,
            sample: 50_000,
        }];
        let mut checkpoint = Checkpoint {
            analysis_sample: 2_000_000,
            streams: vec![PcmStreamCheckpoint {
                track: TrackKind::Microphone,
                last_ack_sequence: Some(3),
                analysis_sample: 2_000_000,
                replay_record_sample: None,
            }],
        };
        assert_eq!(
            control.observe_replay_checkpoint(&checkpoint, &committed),
            Err("SPEECH_WORKER_PROTOCOL_ERROR")
        );
        assert_eq!(
            control.publication_offsets(committed.clone()).unwrap(),
            committed
        );
        checkpoint.streams[0].replay_record_sample = Some(1_000_000);
        control
            .observe_replay_checkpoint(&checkpoint, &committed)
            .unwrap();
        assert_eq!(
            control.publication_offsets(committed.clone()).unwrap()[0].sample,
            1_000_000
        );
        // A replacement Worker replays old audio; it cannot lower the retained frontier.
        checkpoint.streams[0].replay_record_sample = Some(900_000);
        control
            .observe_replay_checkpoint(&checkpoint, &committed)
            .unwrap();
        assert_eq!(
            control.publication_offsets(committed).unwrap()[0].sample,
            1_000_000
        );
    }

    #[test]
    fn record_failure_projection_follows_latest_job_and_preserves_failure_stage() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let now = Utc::now();
        let mut job = fixture_job(
            "speech_failed",
            SpeechJobKind::RecordBackfillAsr,
            SpeechJobOrigin::Record {
                record_id: "record-a".into(),
            },
            SpeechJobState::Running,
            now,
        );
        job.worker_generation = Some(7);
        {
            let mut state = manager.state.lock().unwrap();
            state.active_job = Some((job.job_id.clone(), 7));
            state.jobs.insert(job.job_id.clone(), job.clone());
            finish_job_locked(
                &manager.root,
                &mut state,
                &job.job_id,
                7,
                SpeechJobState::Failed,
                Some(SpeechJobError {
                    code: "SPEECH_WORKER_PROTOCOL_ERROR".into(),
                    retryable: true,
                }),
                None,
            );
            assert_eq!(state.jobs[&job.job_id].stage, SpeechJobStage::Transcribing);
        }
        assert_eq!(
            manager.record_transcription_failure("record-a"),
            Some(RecordTranscriptionFailure {
                code: "SPEECH_WORKER_PROTOCOL_ERROR".into(),
                retryable: true,
                stage: SpeechJobStage::Transcribing,
            })
        );
        assert!(manager
            .record_transcription_failure("record-other")
            .is_none());
        job.job_id = "speech_retry".into();
        job.created_at = now + Duration::seconds(1);
        job.state = SpeechJobState::Queued;
        manager
            .state
            .lock()
            .unwrap()
            .jobs
            .insert(job.job_id.clone(), job);
        assert!(
            manager.record_transcription_failure("record-a").is_none(),
            "new retry inherited an old failure"
        );
    }

    #[cfg(unix)]
    fn write_fake_worker(path: &Path, responses: &[WorkerResponse]) {
        use std::os::unix::fs::PermissionsExt;

        let mut wire = Vec::new();
        for response in responses {
            write_control_frame(&mut wire, response).unwrap();
        }
        let octal = wire
            .iter()
            .map(|byte| format!("\\{:03o}", byte))
            .collect::<String>();
        let script = format!("#!/bin/sh\n/bin/sleep 0.05\n/usr/bin/printf '{octal}'\nexit 0\n");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(unix)]
    fn write_buffered_live_worker(path: &Path, responses: &[WorkerResponse]) {
        use std::os::unix::fs::PermissionsExt;

        let mut wire = Vec::new();
        for response in responses {
            write_control_frame(&mut wire, response).unwrap();
        }
        let octal = wire
            .iter()
            .map(|byte| format!("\\{:03o}", byte))
            .collect::<String>();
        let script = format!(
            "#!/bin/sh\n/bin/sleep 0.05\n/usr/bin/printf '{octal}'\n/bin/sleep 0.2\nexit 0\n"
        );
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn restart_interrupts_agent_jobs_but_requeues_record_work_in_fifo_order() {
        let root = tempfile::tempdir().unwrap();
        let initial = manager(&root);
        let now = Utc::now();
        let agent = fixture_job(
            "speech_agent",
            SpeechJobKind::AgentAttachmentAsr,
            SpeechJobOrigin::Agent {
                initiator_session_id: "session-a".into(),
                workspace_identity: root.path().display().to_string(),
            },
            SpeechJobState::Running,
            now,
        );
        let record_late = fixture_job(
            "speech_record_late",
            SpeechJobKind::RecordDiarization,
            SpeechJobOrigin::Record {
                record_id: "record-late".into(),
            },
            SpeechJobState::Running,
            now + Duration::seconds(1),
        );
        let record_early = fixture_job(
            "speech_record_early",
            SpeechJobKind::RecordBackfillAsr,
            SpeechJobOrigin::Record {
                record_id: "record-early".into(),
            },
            SpeechJobState::Running,
            now,
        );
        for job in [&agent, &record_late, &record_early] {
            persist_job(&initial.root, job).unwrap();
        }
        drop(initial);

        let recovered = manager(&root);
        let agent = recovered
            .get_agent_job("session-a", "speech_agent")
            .unwrap();
        assert_eq!(agent.state, SpeechJobState::Interrupted);
        assert_eq!(
            agent.error.as_ref().map(|error| error.code.as_str()),
            Some("SPEECH_INTERRUPTED")
        );
        assert_eq!(
            recovered.queue_snapshot().unwrap(),
            vec!["speech_record_early", "speech_record_late"]
        );
        let jobs = recovered.state.lock().unwrap();
        for id in ["speech_record_early", "speech_record_late"] {
            let job = jobs.jobs.get(id).unwrap();
            assert_eq!(job.state, SpeechJobState::Queued);
            assert_eq!(job.worker_generation, None);
            assert_eq!(job.stage, SpeechJobStage::Validating);
        }
    }

    #[test]
    fn diarization_uses_every_available_physical_record_track() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let record = tauri::async_runtime::block_on(manager.record_store.create_audio(
            AudioRecordCreateInput {
                title: "Meeting".into(),
                tracks: vec![AudioTrackKind::Microphone, AudioTrackKind::System],
                transcription_status: TranscriptionStatus::Ready,
            },
        ))
        .unwrap();
        let record_path =
            tauri::async_runtime::block_on(manager.record_store.audio_workspace_path(&record.id))
                .unwrap();
        fs::write(record_path.join("audio/microphone.opus"), b"microphone").unwrap();
        fs::write(record_path.join("audio/system.opus"), b"system").unwrap();
        let finalized =
            tauri::async_runtime::block_on(manager.record_store.finalize_audio_capture(
                &record.id,
                CaptureStatus::Ready,
                1_000,
                vec![
                    AudioTrackArtifactInput {
                        timeline: None,
                        capture_time_error: None,
                        track: AudioTrackKind::Microphone,
                        relative_path: "audio/microphone.opus".into(),
                    },
                    AudioTrackArtifactInput {
                        timeline: None,
                        capture_time_error: None,
                        track: AudioTrackKind::System,
                        relative_path: "audio/system.opus".into(),
                    },
                ],
            ))
            .unwrap();

        tauri::async_runtime::block_on(staged_record_fixture(
            &manager,
            Some(&record.id),
            "speech_diarization_tracks",
            "synthetic stage",
        ));
        let (selected, generation) = manager.peek_next_job().unwrap().unwrap();
        let (mut job, generation) = manager
            .claim_next_job(&selected.job_id, generation)
            .unwrap()
            .unwrap();
        job.source.size_bytes = finalized.audio.unwrap().size_bytes;
        manager
            .state
            .lock()
            .unwrap()
            .jobs
            .insert(job.job_id.clone(), job.clone());

        let WorkloadInput::RecordArtifacts { inputs, .. } = manager
            .resolve_record_worker_input(&job, generation)
            .unwrap()
        else {
            panic!("record diarization must use Record artifacts");
        };
        assert_eq!(
            inputs.iter().map(|input| input.track).collect::<Vec<_>>(),
            vec![TrackKind::Microphone, TrackKind::System]
        );
    }

    #[test]
    fn agent_visibility_is_exact_session_scoped() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let now = Utc::now();
        for (id, session) in [("speech_a", "session-a"), ("speech_b", "session-b")] {
            let job = fixture_job(
                id,
                SpeechJobKind::AgentAttachmentAsr,
                SpeechJobOrigin::Agent {
                    initiator_session_id: session.into(),
                    workspace_identity: root.path().display().to_string(),
                },
                SpeechJobState::Succeeded,
                now,
            );
            manager.state.lock().unwrap().jobs.insert(id.into(), job);
        }
        assert_eq!(manager.list_agent_jobs("session-a", 20).unwrap().len(), 1);
        assert_eq!(
            manager.get_agent_job("session-a", "speech_b"),
            Err("SPEECH_JOB_NOT_FOUND")
        );
        assert_eq!(
            manager.get_agent_job("session-b", "speech_a"),
            Err("SPEECH_JOB_NOT_FOUND")
        );
        let debug = format!(
            "{:?}",
            manager.get_agent_job("session-a", "speech_a").unwrap()
        );
        assert!(!debug.contains("/private/source"));
        assert!(!debug.contains(root.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn agent_private_copy_rejects_a_source_version_change() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source.wav");
        fs::write(&source_path, b"first").unwrap();
        let mut source = File::open(&source_path).unwrap();
        let version = agent_source_version(&source.metadata().unwrap());
        fs::write(&source_path, b"other-size").unwrap();

        assert_eq!(
            copy_agent_source(
                &mut source,
                &root.path().join("private.media"),
                5,
                &version,
                || Ok(()),
            ),
            Err("SPEECH_SOURCE_CHANGED".into())
        );
    }

    #[test]
    fn agent_admission_reservation_is_bounded_and_released() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let mut reservation = manager.reserve_agent_admission().unwrap();
        assert_eq!(
            manager.state.lock().unwrap().agent_admission_reservations,
            1
        );
        {
            let mut state = manager.state.lock().unwrap();
            reservation.release_locked(&mut state);
            assert_eq!(state.agent_admission_reservations, 0);
        }
        drop(reservation);
        assert_eq!(
            manager.state.lock().unwrap().agent_admission_reservations,
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn attachment_admission_probe_requires_exact_identity_and_clean_eof() {
        let root = tempfile::tempdir().unwrap();
        let worker = root.path().join("probe-worker");
        let identity = WorkloadIdentity {
            workload_id: "speech_probe_test".into(),
            worker_generation: 1,
        };
        write_fake_worker(
            &worker,
            &[
                WorkerResponse::Ready {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                },
                WorkerResponse::MediaProbed {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    media_kind: "m4a".into(),
                    codec: "aac-lc".into(),
                    duration_ms: Some(60_000),
                    used_default_track: true,
                },
            ],
        );
        let mut command = process_cmd::new(&worker);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = process_cmd::spawn_tree(&mut command).unwrap();
        let stdout = child.stdout.take().unwrap();
        assert_eq!(
            collect_agent_probe(&identity, stdout, Instant::now() + ATTACHMENT_PROBE_TIMEOUT,)
                .unwrap(),
            AgentMediaProbe {
                media_kind: "m4a".into(),
                codec: "aac-lc".into(),
                duration_ms: Some(60_000),
                used_default_track: true,
            }
        );
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn agent_publish_writes_only_transcript_artifacts_and_commits_exact_generation() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let output_root = root.path().join("workspace-output");
        let staging = output_root.join(".staging");
        let private = manager.root.join("private").join("speech_publish");
        ensure_private_directory(&staging).unwrap();
        ensure_private_directory(&private).unwrap();
        let token = "0123456789abcdef0123456789abcdef".to_string();
        write_agent_staging_marker(&staging, &token).unwrap();
        write_agent_private_staging_token(&private, &token).unwrap();
        let source_path = root.path().join("source.wav");
        fs::write(&source_path, b"audio").unwrap();
        let source_file = File::open(&source_path).unwrap();
        let source_version = agent_source_version(&source_file.metadata().unwrap());
        let source = same_file::Handle::from_file(source_file).unwrap();
        let pending = PendingAgentJob {
            source,
            source_version,
            prepared_source: None,
            private_dir: private.clone(),
            private_identity: same_file::Handle::from_path(&private).unwrap(),
            staging_dir: staging.clone(),
            staging_identity: same_file::Handle::from_path(&staging).unwrap(),
            staging_token: token,
            output_root_identity: same_file::Handle::from_path(&output_root).unwrap(),
        };
        let mut job = fixture_job(
            "speech_publish",
            SpeechJobKind::AgentAttachmentAsr,
            SpeechJobOrigin::Agent {
                initiator_session_id: "session-a".into(),
                workspace_identity: root.path().display().to_string(),
            },
            SpeechJobState::Running,
            Utc::now(),
        );
        let public = output_root.join(&job.job_id);
        job.output = SpeechJobOutput {
            root_directory: Some(output_root.to_string_lossy().into_owned()),
            job_directory: Some(public.to_string_lossy().into_owned()),
            transcript_markdown_path: Some(
                public.join("transcript.md").to_string_lossy().into_owned(),
            ),
            transcript_json_path: Some(
                public
                    .join("transcript.json")
                    .to_string_lossy()
                    .into_owned(),
            ),
            artifact_available: false,
        };
        job.source.used_default_track = Some(true);
        job.source.media_kind = Some("wav".into());
        job.source.codec = Some("pcm".into());
        {
            let mut state = manager.state.lock().unwrap();
            state.active_job = Some((job.job_id.clone(), 9));
            state.jobs.insert(job.job_id.clone(), job.clone());
        }
        let transcript = SensitiveTranscriptSegments(vec![RecordTranscriptSegment {
            segment_id: "segment-1".into(),
            track: AudioTrackKind::Mixed,
            start_sample: 16_000,
            end_sample: 32_000,
            text: "private words".into(),
            language: Some("en".into()),
            revision: 1,
        }]);
        let provenance = RecordSpeechProvenance {
            algorithm_revision: None,
            provider: "local".into(),
            model_pack_revision: "revision-1".into(),
            onnx_runtime_version: "1.28.0".into(),
        };

        assert!(manager.publish_agent_success(
            &job,
            9,
            &provenance,
            transcript,
            WorkerMetrics {
                source_samples: 32_000,
                segments: 1,
                speakers: 0,
                elapsed_ms: 10,
                peak_working_bytes: None,
            },
            &pending,
        ));
        let markdown = fs::read_to_string(public.join("transcript.md")).unwrap();
        let json = fs::read_to_string(public.join("transcript.json")).unwrap();
        assert!(markdown.contains("00:00:01.000 – 00:00:02.000"));
        assert!(json.contains("private words"));
        assert!(!json.contains("session-a"));
        assert!(!json.contains("source.wav"));
        assert!(!public.join(AGENT_STAGING_MARKER).exists());
        assert_eq!(
            manager.state.lock().unwrap().jobs["speech_publish"].state,
            SpeechJobState::Succeeded
        );
    }

    #[test]
    fn startup_removes_an_uncommitted_authenticated_public_artifact() {
        let root = tempfile::tempdir().unwrap();
        let initial = manager(&root);
        let job_id = "speech_publish_crash";
        let output_root = root.path().join("workspace-output");
        let staging = output_root.join(format!(".myagents-speech-{job_id}.staging"));
        let destination = output_root.join(job_id);
        let private = initial.root.join("private").join(job_id);
        ensure_private_directory(&staging).unwrap();
        ensure_private_directory(&private).unwrap();
        let token = "0123456789abcdef0123456789abcdef";
        write_agent_staging_marker(&staging, token).unwrap();
        write_agent_private_staging_token(&private, token).unwrap();
        fs::write(staging.join("transcript.md"), "private words").unwrap();
        fs::write(staging.join("transcript.json"), "{}").unwrap();
        let mut job = fixture_job(
            job_id,
            SpeechJobKind::AgentAttachmentAsr,
            SpeechJobOrigin::Agent {
                initiator_session_id: "session-a".into(),
                workspace_identity: root.path().display().to_string(),
            },
            SpeechJobState::Running,
            Utc::now(),
        );
        job.stage = SpeechJobStage::Publishing;
        job.output = SpeechJobOutput {
            root_directory: Some(output_root.to_string_lossy().into_owned()),
            job_directory: Some(destination.to_string_lossy().into_owned()),
            transcript_markdown_path: Some(
                destination
                    .join("transcript.md")
                    .to_string_lossy()
                    .into_owned(),
            ),
            transcript_json_path: Some(
                destination
                    .join("transcript.json")
                    .to_string_lossy()
                    .into_owned(),
            ),
            artifact_available: false,
        };
        persist_job(&initial.root, &job).unwrap();
        persist_agent_publish_intent(
            &initial.root,
            &AgentPublishIntent {
                schema_version: 1,
                job_id: job_id.into(),
                staging_directory: staging.to_string_lossy().into_owned(),
                destination_directory: destination.to_string_lossy().into_owned(),
                staging_token: token.into(),
            },
        )
        .unwrap();
        crate::durable_fs::rename_directory_noreplace(&staging, &destination).unwrap();
        crate::durable_fs::sync_directory(&output_root).unwrap();
        drop(initial);

        let recovered = manager(&root);
        let job = recovered.get_agent_job("session-a", job_id).unwrap();
        assert_eq!(job.state, SpeechJobState::Interrupted);
        assert!(!destination.exists());
        assert!(!staging.exists());
        assert!(!private.exists());
        assert!(!agent_publish_intent_path(&recovered.root, job_id).exists());
    }

    #[test]
    fn startup_finishes_cleanup_after_durable_agent_success() {
        let root = tempfile::tempdir().unwrap();
        let initial = manager(&root);
        let job_id = "speech_success_cleanup";
        let output_root = root.path().join("workspace-output");
        let destination = output_root.join(job_id);
        let private = initial.root.join("private").join(job_id);
        ensure_private_directory(&destination).unwrap();
        ensure_private_directory(&private).unwrap();
        let token = "fedcba9876543210fedcba9876543210";
        write_agent_staging_marker(&destination, token).unwrap();
        write_agent_private_staging_token(&private, token).unwrap();
        fs::write(destination.join("transcript.md"), "private words").unwrap();
        fs::write(destination.join("transcript.json"), "{}").unwrap();
        let mut job = fixture_job(
            job_id,
            SpeechJobKind::AgentAttachmentAsr,
            SpeechJobOrigin::Agent {
                initiator_session_id: "session-a".into(),
                workspace_identity: root.path().display().to_string(),
            },
            SpeechJobState::Succeeded,
            Utc::now(),
        );
        job.output = SpeechJobOutput {
            root_directory: Some(output_root.to_string_lossy().into_owned()),
            job_directory: Some(destination.to_string_lossy().into_owned()),
            transcript_markdown_path: Some(
                destination
                    .join("transcript.md")
                    .to_string_lossy()
                    .into_owned(),
            ),
            transcript_json_path: Some(
                destination
                    .join("transcript.json")
                    .to_string_lossy()
                    .into_owned(),
            ),
            artifact_available: true,
        };
        persist_job(&initial.root, &job).unwrap();
        persist_agent_publish_intent(
            &initial.root,
            &AgentPublishIntent {
                schema_version: 1,
                job_id: job_id.into(),
                staging_directory: output_root
                    .join(format!(".myagents-speech-{job_id}.staging"))
                    .to_string_lossy()
                    .into_owned(),
                destination_directory: destination.to_string_lossy().into_owned(),
                staging_token: token.into(),
            },
        )
        .unwrap();
        drop(initial);

        let recovered = manager(&root);
        let job = recovered.get_agent_job("session-a", job_id).unwrap();
        assert_eq!(job.state, SpeechJobState::Succeeded);
        assert!(job.output.artifact_available);
        assert!(!destination.join(AGENT_STAGING_MARKER).exists());
        assert!(!private.exists());
        assert!(!agent_publish_intent_path(&recovered.root, job_id).exists());
    }

    #[test]
    fn shutdown_interrupts_agents_and_keeps_record_jobs_restartable() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let now = Utc::now();
        let jobs = [
            fixture_job(
                "speech_agent",
                SpeechJobKind::AgentAttachmentAsr,
                SpeechJobOrigin::Agent {
                    initiator_session_id: "session-a".into(),
                    workspace_identity: root.path().display().to_string(),
                },
                SpeechJobState::Running,
                now,
            ),
            fixture_job(
                "speech_record",
                SpeechJobKind::RecordBackfillAsr,
                SpeechJobOrigin::Record {
                    record_id: "record-a".into(),
                },
                SpeechJobState::Running,
                now,
            ),
        ];
        {
            let mut state = manager.state.lock().unwrap();
            for job in jobs {
                state.jobs.insert(job.job_id.clone(), job);
            }
        }
        manager.shutdown().unwrap();
        let state = manager.state.lock().unwrap();
        assert_eq!(
            state.jobs.get("speech_agent").unwrap().state,
            SpeechJobState::Interrupted
        );
        assert_eq!(
            state.jobs.get("speech_record").unwrap().state,
            SpeechJobState::Queued
        );
    }

    #[test]
    fn speech_queue_selects_compute_priority_and_preserves_fifo_ties() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let now = Utc::now();
        let jobs = [
            fixture_job(
                "attachment-first",
                SpeechJobKind::AgentAttachmentAsr,
                SpeechJobOrigin::Agent {
                    initiator_session_id: "session-a".into(),
                    workspace_identity: root.path().display().to_string(),
                },
                SpeechJobState::Queued,
                now,
            ),
            fixture_job(
                "backfill-first",
                SpeechJobKind::RecordBackfillAsr,
                SpeechJobOrigin::Record {
                    record_id: "record-a".into(),
                },
                SpeechJobState::Queued,
                now,
            ),
            fixture_job(
                "backfill-second",
                SpeechJobKind::RecordBackfillAsr,
                SpeechJobOrigin::Record {
                    record_id: "record-b".into(),
                },
                SpeechJobState::Queued,
                now,
            ),
        ];
        {
            let mut state = manager.state.lock().unwrap();
            for job in jobs {
                state.queue.push_back(job.job_id.clone());
                state.jobs.insert(job.job_id.clone(), job);
            }
        }

        let (candidate, generation_hint) = manager.peek_next_job().unwrap().unwrap();
        assert_eq!(candidate.job_id, "backfill-first");
        let (claimed, _) = manager
            .claim_next_job(&candidate.job_id, generation_hint)
            .unwrap()
            .unwrap();
        assert_eq!(claimed.job_id, "backfill-first");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn identity_stream_requires_complete_ordered_evidence_for_the_frozen_generation() {
        for variant in [
            "valid",
            "missing",
            "truncated",
            "reordered",
            "duplicate",
            "early",
            "wrong-generation",
            "wrong-person",
            "malformed",
        ] {
            let root = tempfile::tempdir().unwrap();
            let manager = manager(&root);
            let (_, mut root_job) = staged_record_fixture(
                &manager,
                None,
                "speech_identity_stream",
                "private candidate",
            )
            .await;
            let mut input = record_processing::read_input(&manager.root, &root_job).unwrap();
            let anchors = (0..17).map(|person| (person.to_string(), serde_json::json!({
                "audioIdentity": input.baseline.audio_identity,
                "identityScopes": [[{ "source": "microphone", "startSample": 0, "endSample": 16_000 }]],
                "hasUnresolvedActivity": false,
            }))).collect::<serde_json::Map<_, _>>();
            input.baseline.person_anchors =
                serde_json::from_value(serde_json::Value::Object(anchors)).unwrap();
            root_job.record_baseline = Some(
                record_processing::write_candidate(
                    &manager.root,
                    &root_job.job_id,
                    record_processing::BASELINE_FILE,
                    &input,
                )
                .unwrap(),
            );
            let mut job =
                manager.state.lock().unwrap().jobs["speech_identity_stream_diarization"].clone();
            job.record_baseline = root_job.record_baseline.clone();
            let identity = WorkloadIdentity {
                workload_id: job.job_id.clone(),
                worker_generation: 8,
            };
            let evidence = (0..17)
                .map(|person_id| PersonMatchEvidence {
                    person_id,
                    model_labels: vec![],
                    reference_samples: 16_000,
                    reference_covered_samples: 0,
                    candidate_samples: 0,
                    candidate_covered_samples: 0,
                    independent_clean_spans: 0,
                    maximum_voice_distance: 2_000_000,
                    nearest_alternative_distance: 2_000_000,
                    activity_conflict: false,
                    has_unresolved_activity: true,
                })
                .collect::<Vec<_>>();
            let batch = |index, last, rows| WorkerResponse::IdentityEvidenceBatch {
                protocol_version: PROTOCOL_VERSION,
                identity: identity.clone(),
                revision: 1,
                batch_index: index,
                is_last: last,
                evidence: rows,
            };
            let mut responses = vec![
                WorkerResponse::Ready {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                },
                WorkerResponse::SpeakerTurnBatch {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    revision: 1,
                    batch_index: 0,
                    is_last: true,
                    turns: vec![SpeakerTurn {
                        source: TrackKind::Microphone,
                        start_sample: 0,
                        end_sample: 16_000,
                        global_speaker: None,
                    }],
                },
                batch(0, false, evidence[..16].to_vec()),
                batch(1, true, evidence[16..].to_vec()),
                WorkerResponse::Completed {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    metrics: WorkerMetrics {
                        source_samples: 16_000,
                        segments: 1,
                        speakers: 0,
                        elapsed_ms: 5,
                        peak_working_bytes: None,
                    },
                },
            ];
            match variant {
                "missing" => {
                    responses.drain(2..4);
                }
                "truncated" => {
                    responses.remove(3);
                }
                "reordered" => responses.swap(2, 3),
                "duplicate" => {
                    responses.insert(3, batch(0, false, evidence[..16].to_vec()));
                }
                "early" => responses.swap(1, 2),
                "wrong-generation" => {
                    if let WorkerResponse::IdentityEvidenceBatch { identity, .. } =
                        &mut responses[3]
                    {
                        identity.worker_generation -= 1;
                    }
                }
                "wrong-person" => {
                    if let WorkerResponse::IdentityEvidenceBatch { evidence, .. } =
                        &mut responses[3]
                    {
                        evidence[0].person_id = 99;
                    }
                }
                "malformed" => {
                    if let WorkerResponse::IdentityEvidenceBatch { evidence, .. } =
                        &mut responses[3]
                    {
                        evidence[0].maximum_voice_distance = u32::MAX;
                    }
                }
                _ => {}
            }
            let worker = root.path().join("identity-worker");
            write_fake_worker(&worker, &responses);
            let mut command = process_cmd::new(&worker);
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            let mut process = process_cmd::spawn_tree(&mut command).unwrap();
            let stdout = process.stdout.take().unwrap();
            let stdin = Arc::new(Mutex::new(process.stdin.take().unwrap()));
            let child = Arc::new(Mutex::new(process));
            let lease = manager
                .compute_coordinator
                .acquire(ComputeWorkloadIdentity {
                    kind: ComputeWorkloadKind::RecordDiarization,
                    id: job.job_id.clone(),
                    generation: 8,
                })
                .await;
            let runner = Arc::clone(&manager);
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                let yield_state = BatchYieldState::new();
                let outcome = runner.collect_worker_result(
                    &job,
                    8,
                    &identity,
                    Some(vec![AudioTrackKind::Microphone]),
                    stdout,
                    &stdin,
                    &child,
                    &lease,
                    &yield_state,
                );
                yield_state.mark_settled();
                let _ = child.lock().unwrap().kill_and_wait();
                outcome
            })
            .await
            .unwrap();
            if variant == "valid" {
                let SpeechWorkerOutcome::Completed(SpeechWorkerCompletion {
                    identity_evidence,
                    ..
                }) = outcome
                else {
                    panic!("valid bounded abstention evidence must finish normally");
                };
                assert_eq!(identity_evidence, evidence);
            } else {
                let SpeechWorkerOutcome::Failed { code, .. } = outcome else {
                    panic!("invalid stream was accepted: {variant}");
                };
                assert_eq!(code, "SPEECH_WORKER_PROTOCOL_ERROR", "{variant}");
            }
            assert!(manager
                .root
                .join("private/speech_identity_stream/record-asr.json")
                .is_file());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exact_generations_stage_asr_then_publish_one_record_processing() {
        for dual in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let manager = manager(&root);
            let record = manager
                .record_store
                .create_audio(AudioRecordCreateInput {
                    title: "Meeting".into(),
                    tracks: if dual {
                        vec![AudioTrackKind::Microphone, AudioTrackKind::System]
                    } else {
                        vec![AudioTrackKind::Microphone]
                    },
                    transcription_status: TranscriptionStatus::Queued,
                })
                .await
                .unwrap();
            let record_path = manager
                .record_store
                .audio_workspace_path(&record.id)
                .await
                .unwrap();
            fs::write(record_path.join("audio/microphone.opus"), b"owned-audio").unwrap();
            let mut artifacts = vec![AudioTrackArtifactInput {
                timeline: None,
                capture_time_error: None,
                track: AudioTrackKind::Microphone,
                relative_path: "audio/microphone.opus".into(),
            }];
            if dual {
                fs::write(record_path.join("audio/system.opus"), b"owned-system-audio").unwrap();
                artifacts.push(AudioTrackArtifactInput {
                    timeline: None,
                    capture_time_error: None,
                    track: AudioTrackKind::System,
                    relative_path: "audio/system.opus".into(),
                });
            }
            let finalized = manager
                .record_store
                .finalize_audio_capture(&record.id, CaptureStatus::Ready, 1_000, artifacts)
                .await
                .unwrap();

            let mut job = fixture_job(
                "speech_record_execute",
                SpeechJobKind::RecordBackfillAsr,
                SpeechJobOrigin::Record {
                    record_id: record.id.clone(),
                },
                SpeechJobState::Queued,
                Utc::now(),
            );
            job.started_at = None;
            job.worker_generation = None;
            job.worker_attempts = 0;
            job.source.size_bytes = finalized.audio.unwrap().size_bytes;
            {
                let mut state = manager.state.lock().unwrap();
                state.queue.push_back(job.job_id.clone());
                state.jobs.insert(job.job_id.clone(), job);
            }
            let (candidate, generation_hint) = manager.peek_next_job().unwrap().unwrap();
            let (job, generation) = manager
                .claim_next_job(&candidate.job_id, generation_hint)
                .unwrap()
                .unwrap();
            let identity = WorkloadIdentity {
                workload_id: job.job_id.clone(),
                worker_generation: generation,
            };
            let worker = root.path().join("fake-media-worker");
            let mut responses = vec![WorkerResponse::Ready {
                protocol_version: PROTOCOL_VERSION,
                identity: identity.clone(),
            }];
            for (index, track) in [TrackKind::Microphone, TrackKind::System]
                .into_iter()
                .take(if dual { 2 } else { 1 })
                .enumerate()
            {
                responses.push(WorkerResponse::TranscriptSegment {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    segment_id: format!("segment-{}", index + 1),
                    track,
                    start_sample: index as u64 * 4_000,
                    end_sample: 8_000 + index as u64 * 4_000,
                    text: "private transcript".into(),
                    language: Some("en".into()),
                    revision: index as u64 + 1,
                });
            }
            responses.push(WorkerResponse::Completed {
                protocol_version: PROTOCOL_VERSION,
                identity,
                metrics: WorkerMetrics {
                    source_samples: 16_000,
                    segments: if dual { 2 } else { 1 },
                    speakers: 0,
                    elapsed_ms: 5,
                    peak_working_bytes: Some(1024),
                },
            });
            write_fake_worker(&worker, &responses);
            let native_manifest = root.path().join("native-manifest.json");
            let runtime = root.path().join("libonnxruntime.dylib");
            let model_manifest = root.path().join("model-manifest.json");
            for path in [&native_manifest, &runtime, &model_manifest] {
                fs::write(path, b"fixture").unwrap();
            }
            let resources = SpeechExecutionResources {
                worker_path: worker,
                native_manifest_path: native_manifest,
                onnx_runtime_path: runtime,
                model_pack_manifest_path: model_manifest,
                provenance: RecordSpeechProvenance {
                    algorithm_revision: None,
                    provider: "local".into(),
                    model_pack_revision: "revision-1".into(),
                    onnx_runtime_version: "1.28.0".into(),
                },
            };
            let lease = manager
                .compute_coordinator
                .acquire(ComputeWorkloadIdentity {
                    kind: ComputeWorkloadKind::RecordBackfill,
                    id: job.job_id.clone(),
                    generation,
                })
                .await;
            let runner = Arc::clone(&manager);
            let diarization_resources = resources.clone();
            tauri::async_runtime::spawn_blocking(move || {
                runner.execute_record_job(&job, generation, resources, lease)
            })
            .await
            .unwrap();
            manager.clear_active("speech_record_execute", generation);

            assert!(manager
                .record_store
                .read_recording_final_transcript(&record.id)
                .await
                .unwrap()
                .is_none());
            let root_job = manager.state.lock().unwrap().jobs["speech_record_execute"].clone();
            let candidate = record_processing::read_asr(&manager.root, &root_job).unwrap();
            assert_eq!(candidate.segments.len(), if dual { 2 } else { 1 });
            assert_eq!(candidate.segments[0].track, AudioTrackKind::Microphone);
            if dual {
                assert_eq!(candidate.segments[1].track, AudioTrackKind::System);
                assert!(candidate.segments[1].start_sample < candidate.segments[0].end_sample);
            }
            assert_eq!(candidate.segments[0].text, "private transcript");
            assert_eq!(root_job.state, SpeechJobState::Running);
            assert_eq!(root_job.stage, SpeechJobStage::Diarizing);
            assert_eq!(root_job.pipeline.model_pack_revision, "revision-1");
            let (selected, next_generation) = manager.peek_next_job().unwrap().unwrap();
            assert_eq!(selected.kind, SpeechJobKind::RecordDiarization);
            assert_eq!(
                selected.processing_id.as_deref(),
                Some("speech_record_execute")
            );
            let (child, generation) = manager
                .claim_next_job(&selected.job_id, next_generation)
                .unwrap()
                .unwrap();
            let identity = WorkloadIdentity {
                workload_id: child.job_id.clone(),
                worker_generation: generation,
            };
            let turns = [TrackKind::Microphone, TrackKind::System]
                .into_iter()
                .take(if dual { 2 } else { 1 })
                .map(|source| SpeakerTurn {
                    source,
                    start_sample: 0,
                    end_sample: 16_000,
                    global_speaker: Some(0),
                })
                .collect();
            write_fake_worker(
                &diarization_resources.worker_path,
                &[
                    WorkerResponse::Ready {
                        protocol_version: PROTOCOL_VERSION,
                        identity: identity.clone(),
                    },
                    WorkerResponse::SpeakerTurnBatch {
                        protocol_version: PROTOCOL_VERSION,
                        identity: identity.clone(),
                        revision: 1,
                        batch_index: 0,
                        is_last: true,
                        turns,
                    },
                    WorkerResponse::IdentityEvidenceBatch {
                        protocol_version: PROTOCOL_VERSION,
                        identity: identity.clone(),
                        revision: 1,
                        batch_index: 0,
                        is_last: true,
                        evidence: vec![],
                    },
                    WorkerResponse::Completed {
                        protocol_version: PROTOCOL_VERSION,
                        identity,
                        metrics: WorkerMetrics {
                            source_samples: 16_000,
                            segments: if dual { 2 } else { 1 },
                            speakers: 1,
                            elapsed_ms: 5,
                            peak_working_bytes: None,
                        },
                    },
                ],
            );
            let lease = manager
                .compute_coordinator
                .acquire(ComputeWorkloadIdentity {
                    kind: ComputeWorkloadKind::RecordDiarization,
                    id: child.job_id.clone(),
                    generation,
                })
                .await;
            let runner = Arc::clone(&manager);
            tauri::async_runtime::spawn_blocking(move || {
                runner.execute_record_job(&child, generation, diarization_resources, lease)
            })
            .await
            .unwrap();
            let snapshot = manager
                .record_store
                .read_recording_final_transcript(&record.id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                snapshot.processing_id.as_deref(),
                Some("speech_record_execute")
            );
            assert_eq!(snapshot.segments.len(), if dual { 2 } else { 1 });
            assert_eq!(
                manager.state.lock().unwrap().jobs["speech_record_execute"].state,
                SpeechJobState::Succeeded
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn live_worker_streams_committed_pcm_and_publishes_stable_revision() {
        use crate::recording::analysis::TrackAnalysisHandle;
        use crate::recording::audio::SourceFormat;

        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let record = manager
            .record_store
            .create_audio(AudioRecordCreateInput {
                title: "Live meeting".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Live,
            })
            .await
            .unwrap();
        let record_path = manager
            .record_store
            .audio_workspace_path(&record.id)
            .await
            .unwrap();
        let analysis_path = record_path.join("analysis/microphone.pcm16");
        let analysis = TrackAnalysisHandle::start(
            AudioTrackKind::Microphone,
            analysis_path,
            SourceFormat {
                sample_rate: 16_000,
                channels: 1,
            },
        )
        .unwrap();
        analysis.sink.push_i16(&vec![4_000; 16_000]);
        let final_sample = analysis.control().checkpoint().unwrap();
        assert_eq!(final_sample, 16_000);
        let source = analysis.source();
        let control = Arc::new(LiveControl::default());
        let boundary = LiveBoundary {
            offsets: vec![RecordTranscriptTrackOffset {
                track: AudioTrackKind::Microphone,
                sample: final_sample,
            }],
        };
        {
            let mut state = control.state.lock().unwrap();
            state.flushes.push_back(boundary.clone());
            state.finish = Some(boundary);
        }
        manager.state.lock().unwrap().live_sessions.insert(
            record.id.clone(),
            LiveSessionRegistration {
                control: control.clone(),
                tracks: vec![AudioTrackKind::Microphone],
            },
        );
        let generation = manager.allocate_live_generation(&record.id).unwrap();
        let identity = WorkloadIdentity {
            workload_id: record.id.clone(),
            worker_generation: generation,
        };
        let worker = root.path().join("fake-live-worker");
        write_buffered_live_worker(
            &worker,
            &[
                WorkerResponse::Ready {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                },
                WorkerResponse::InputAck {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    track: TrackKind::Microphone,
                    sequence: 0,
                    end_sample: 16_000,
                },
                WorkerResponse::Heartbeat {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    stage: WorkerStage::Vad,
                    checkpoint: Checkpoint {
                        streams: vec![PcmStreamCheckpoint {
                            replay_record_sample: Some(0),
                            track: TrackKind::Microphone,
                            last_ack_sequence: Some(0),
                            analysis_sample: 16_000,
                        }],
                        analysis_sample: 16_000,
                    },
                },
                WorkerResponse::TranscriptSegment {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    segment_id: "worker-local-id".into(),
                    track: TrackKind::Microphone,
                    start_sample: 0,
                    end_sample: 8_000,
                    text: "private live transcript".into(),
                    language: Some("en".into()),
                    revision: 1,
                },
                WorkerResponse::Heartbeat {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    stage: WorkerStage::Vad,
                    checkpoint: Checkpoint {
                        streams: vec![PcmStreamCheckpoint {
                            replay_record_sample: Some(0),
                            track: TrackKind::Microphone,
                            last_ack_sequence: Some(0),
                            analysis_sample: 16_000,
                        }],
                        analysis_sample: 16_000,
                    },
                },
                WorkerResponse::Completed {
                    protocol_version: PROTOCOL_VERSION,
                    identity,
                    metrics: WorkerMetrics {
                        source_samples: 16_000,
                        segments: 1,
                        speakers: 0,
                        elapsed_ms: 5,
                        peak_working_bytes: Some(1_024),
                    },
                },
            ],
        );
        let native_manifest = root.path().join("native-manifest.json");
        let runtime = root.path().join("libonnxruntime.dylib");
        let model_manifest = root.path().join("model-manifest.json");
        for path in [&native_manifest, &runtime, &model_manifest] {
            fs::write(path, b"fixture").unwrap();
        }
        let resources = SpeechExecutionResources {
            worker_path: worker,
            native_manifest_path: native_manifest,
            onnx_runtime_path: runtime,
            model_pack_manifest_path: model_manifest,
            provenance: RecordSpeechProvenance {
                algorithm_revision: None,
                provider: "local".into(),
                model_pack_revision: "revision-1".into(),
                onnx_runtime_version: "1.28.0".into(),
            },
        };
        let mut journal = manager
            .record_store
            .begin_live_transcript(&record.id, resources.provenance.clone())
            .await
            .unwrap();
        let mut record_changes = manager.record_store.subscribe_changes();
        journal
            .append_generation_started(generation, journal.replay_offsets())
            .unwrap();
        assert_eq!(
            manager.execute_live_attempt(
                &record.id,
                generation,
                &[source],
                &resources,
                &control,
                &mut journal,
            ),
            LiveAttemptOutcome::Finished
        );
        journal.finish().unwrap();
        analysis.finish().unwrap();

        let transcript_change = record_changes.try_recv().unwrap();
        assert_eq!(transcript_change.id, record.id);
        assert_eq!(
            transcript_change.kind,
            crate::record::RecordChangeKind::Transcript
        );

        let projection = manager
            .record_store
            .read_live_transcript_revisions(&record.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(projection.segments.len(), 1);
        assert_eq!(projection.segments[0].segment_id, "live-microphone-0-8000");
        assert_eq!(projection.segments[0].text, "private live transcript");
    }

    #[test]
    fn finished_live_session_cannot_overwrite_queued_backfill_status() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let record = tauri::async_runtime::block_on(manager.record_store.create_audio(
            AudioRecordCreateInput {
                title: "Live failure ordering".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Live,
            },
        ))
        .unwrap();
        let control = Arc::new(LiveControl::default());
        manager.state.lock().unwrap().live_sessions.insert(
            record.id.clone(),
            LiveSessionRegistration {
                control: control.clone(),
                tracks: vec![AudioTrackKind::Microphone],
            },
        );

        manager
            .finish_record_live(
                &record.id,
                vec![RecordTranscriptTrackOffset {
                    track: AudioTrackKind::Microphone,
                    sample: 0,
                }],
            )
            .unwrap();
        tauri::async_runtime::block_on(manager.record_store.update_audio_processing_status(
            &record.id,
            Some(TranscriptionStatus::Queued),
            None,
        ))
        .unwrap();

        assert!(!manager
            .project_live_failure_if_owned(&record.id, &control)
            .unwrap());
        let persisted =
            tauri::async_runtime::block_on(manager.record_store.get(&record.id)).unwrap();
        assert_eq!(
            persisted.audio.unwrap().transcription_status,
            TranscriptionStatus::Queued
        );
    }

    #[test]
    fn finished_live_registration_does_not_occupy_next_capture_admission() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let control = Arc::new(LiveControl::default());
        let mut state = manager.state.lock().unwrap();
        state.live_sessions.insert(
            "previous-record".into(),
            LiveSessionRegistration {
                control: control.clone(),
                tracks: vec![AudioTrackKind::Microphone],
            },
        );
        assert!(validate_live_admission(&state, "next-record").is_err());
        control.state.lock().unwrap().paused = true;
        assert!(validate_live_admission(&state, "next-record").is_err());
        control.state.lock().unwrap().finish = Some(LiveBoundary { offsets: vec![] });
        assert_eq!(validate_live_admission(&state, "next-record"), Ok(()));
        assert!(validate_live_admission(&state, "previous-record").is_err());
        let next = Arc::new(LiveControl::default());
        state.live_sessions.insert(
            "next-record".into(),
            LiveSessionRegistration {
                control: next.clone(),
                tracks: vec![AudioTrackKind::Microphone],
            },
        );
        assert!(validate_live_admission(&state, "third-record").is_err());
        next.state.lock().unwrap().cancelled = true;
        assert_eq!(validate_live_admission(&state, "third-record"), Ok(()));
    }

    #[tokio::test]
    async fn stop_after_acknowledged_pause_flush_never_allocates_another_worker() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let record = manager
            .record_store
            .create_audio(AudioRecordCreateInput {
                title: "Paused recording".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Live,
            })
            .await
            .unwrap();
        let control = Arc::new(LiveControl::default());
        let offsets = vec![RecordTranscriptTrackOffset {
            track: AudioTrackKind::Microphone,
            sample: 16_000,
        }];
        let boundary = LiveBoundary {
            offsets: offsets.clone(),
        };
        {
            let mut state = control.state.lock().unwrap();
            state.paused = true;
            state.suspend_requested = true;
            state.flushes.push_back(boundary.clone());
        }
        control.complete_flush(&boundary);
        manager.state.lock().unwrap().live_sessions.insert(
            record.id.clone(),
            LiveSessionRegistration {
                control: control.clone(),
                tracks: vec![AudioTrackKind::Microphone],
            },
        );
        manager.finish_record_live(&record.id, offsets).unwrap();
        let resources = SpeechExecutionResources {
            worker_path: root.path().join("must-not-start-worker"),
            native_manifest_path: root.path().join("unused-native"),
            onnx_runtime_path: root.path().join("unused-runtime"),
            model_pack_manifest_path: root.path().join("unused-model"),
            provenance: RecordSpeechProvenance {
                algorithm_revision: None,
                provider: "local".into(),
                model_pack_revision: "test".into(),
                onnx_runtime_version: "test".into(),
            },
        };
        let journal = manager
            .record_store
            .begin_live_transcript(&record.id, resources.provenance.clone())
            .await
            .unwrap();
        let generation = manager.state.lock().unwrap().next_generation;
        let runner = manager.clone();
        let id = record.id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            runner.run_live_session(id, vec![], resources, control, journal)
        })
        .await
        .unwrap();
        let state = manager.state.lock().unwrap();
        assert_eq!(
            state.next_generation, generation,
            "already-flushed stop restarted inference"
        );
        assert!(!state.live_sessions.contains_key(&record.id));
        assert!(state.live_running.is_none());
    }

    #[test]
    fn only_exact_acknowledged_flush_can_finish_without_inference() {
        let control = LiveControl::default();
        let boundary = LiveBoundary {
            offsets: vec![RecordTranscriptTrackOffset {
                track: AudioTrackKind::Microphone,
                sample: 16_000,
            }],
        };
        {
            let mut state = control.state.lock().unwrap();
            state.flushes.push_back(boundary.clone());
            state.finish = Some(boundary.clone());
        }
        assert!(!control.snapshot().unwrap().finish_is_flushed);
        let mut stale = boundary.clone();
        stale.offsets[0].sample = 8_000;
        control.complete_flush(&stale);
        assert!(!control.snapshot().unwrap().finish_is_flushed);
        control.complete_flush(&boundary);
        assert!(control.snapshot().unwrap().finish_is_flushed);
        control
            .state
            .lock()
            .unwrap()
            .finish
            .as_mut()
            .unwrap()
            .offsets[0]
            .sample += 160;
        assert!(
            !control.snapshot().unwrap().finish_is_flushed,
            "resume tail still needs inference"
        );
    }

    #[tokio::test]
    async fn live_pause_grace_is_epoch_fenced_and_resume_cancels_unload() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let record_id = "record-live-pause";
        let control = Arc::new(LiveControl::default());
        manager.state.lock().unwrap().live_sessions.insert(
            record_id.to_string(),
            LiveSessionRegistration {
                control: Arc::clone(&control),
                tracks: vec![AudioTrackKind::Microphone],
            },
        );
        let offsets = vec![RecordTranscriptTrackOffset {
            track: AudioTrackKind::Microphone,
            sample: 16_000,
        }];

        manager
            .pause_record_live_with_grace(record_id, offsets.clone(), StdDuration::from_millis(10))
            .unwrap();
        manager.resume_record_live(record_id).unwrap();
        tokio::time::sleep(StdDuration::from_millis(30)).await;
        let resumed = control.snapshot().unwrap();
        assert!(!resumed.paused);
        assert!(!resumed.suspend_requested);

        manager
            .pause_record_live_with_grace(record_id, offsets, StdDuration::from_millis(10))
            .unwrap();
        tokio::time::sleep(StdDuration::from_millis(30)).await;
        let paused = control.snapshot().unwrap();
        assert!(paused.paused);
        assert!(paused.suspend_requested);
    }

    #[tokio::test]
    async fn stale_generation_cannot_publish_record_projection() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let record = manager
            .record_store
            .create_audio(AudioRecordCreateInput {
                title: "Meeting".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Queued,
            })
            .await
            .unwrap();
        let record_path = manager
            .record_store
            .audio_workspace_path(&record.id)
            .await
            .unwrap();
        fs::write(record_path.join("audio/microphone.opus"), b"owned-audio").unwrap();
        manager
            .record_store
            .finalize_audio_capture(
                &record.id,
                CaptureStatus::Ready,
                1_000,
                vec![AudioTrackArtifactInput {
                    timeline: None,
                    capture_time_error: None,
                    track: AudioTrackKind::Microphone,
                    relative_path: "audio/microphone.opus".into(),
                }],
            )
            .await
            .unwrap();
        let mut job = fixture_job(
            "speech_stale",
            SpeechJobKind::RecordBackfillAsr,
            SpeechJobOrigin::Record {
                record_id: record.id.clone(),
            },
            SpeechJobState::Running,
            Utc::now(),
        );
        job.worker_generation = Some(2);
        {
            let mut state = manager.state.lock().unwrap();
            state.active_job = Some((job.job_id.clone(), 2));
            state.jobs.insert(job.job_id.clone(), job.clone());
        }
        manager.publish_record_success(
            &job,
            1,
            &RecordSpeechProvenance {
                algorithm_revision: None,
                provider: "local".into(),
                model_pack_revision: "fixture-pack".into(),
                onnx_runtime_version: "1.28.0".into(),
            },
            SpeechWorkerCompletion {
                transcripts: SensitiveTranscriptSegments(vec![RecordTranscriptSegment {
                    segment_id: "segment-1".into(),
                    track: AudioTrackKind::Microphone,
                    start_sample: 0,
                    end_sample: 8_000,
                    text: "must not publish".into(),
                    language: Some("en".into()),
                    revision: 1,
                }]),
                turns: Vec::new(),
                identity_evidence: Vec::new(),
                metrics: WorkerMetrics {
                    source_samples: 16_000,
                    segments: 1,
                    speakers: 0,
                    elapsed_ms: 5,
                    peak_working_bytes: None,
                },
            },
        );
        assert!(manager
            .record_store
            .read_recording_final_transcript(&record.id)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            manager.state.lock().unwrap().jobs["speech_stale"].state,
            SpeechJobState::Running
        );
    }
}
