//! App-owned local document conversion queue and Worker lifecycle.

use crate::durable_fs::{rename_directory_noreplace, sync_directory};
use crate::local_inference::{
    ComputeWorkloadIdentity, ComputeWorkloadKind, InferenceRuntimeKind, LocalComputeCoordinator,
    LocalComputeLease, LocalComputeYieldSignal, LocalInferenceRuntimeIdentity,
    LocalInferenceRuntimeRegistry,
};
use crate::process_cmd;
use crate::workspace_files::path_safety::open_regular_file_no_follow;
use chrono::{DateTime, Duration, Local, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::Duration as StdDuration;
use tokio::sync::Notify;

const QUEUE_LIMIT: usize = 16;
const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 128 * 1024 * 1024;
const MIN_FREE_RESERVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CONTROL_FRAME_BYTES: usize = 1024 * 1024;
const MAX_WORKER_STDERR_DIAGNOSTIC_BYTES: usize = 64 * 1024;
pub const DOCUMENT_HISTORY_RETENTION_DAYS: i64 = 30;
const PROTOCOL_VERSION: u32 = 3;
const WORKER_TERMINAL_GRACE: StdDuration = StdDuration::from_secs(30);
const WORKER_CANCEL_GRACE: StdDuration = StdDuration::from_secs(15);
const WORKER_SHUTDOWN_GRACE: StdDuration = StdDuration::from_secs(10);
const OCR_YIELD_GRACE_SECONDS: u64 = 15;
const PIPELINE_VERSION: &str = "anydoc-0.1.9_ppocrv6-small_v1";
const JOB_ID_RANDOM_HEX: usize = 12;
const JOB_DEADLINE_SECONDS: u64 = 30 * 60;
const STAGING_OWNER_MARKER: &str = ".myagents-owner";
const PRIVATE_STAGING_TOKEN: &str = "staging-owner";
const PUBLISH_INTENT_FILE: &str = "publish-intent.json";

pub type ManagedDocumentProcessing = Arc<DocumentProcessingManager>;

static DOCUMENT_PROCESSING: OnceLock<ManagedDocumentProcessing> = OnceLock::new();

pub fn set_global(manager: ManagedDocumentProcessing) -> Result<(), String> {
    DOCUMENT_PROCESSING
        .set(manager)
        .map_err(|_| "DocumentProcessingManager already initialized".to_string())
}

pub fn global() -> Option<&'static ManagedDocumentProcessing> {
    DOCUMENT_PROCESSING.get()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentJobState {
    Queued,
    Running,
    Cancelling,
    Succeeded,
    SucceededWithWarnings,
    Failed,
    Cancelled,
    Interrupted,
}

impl DocumentJobState {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentWarning {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryHint {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentJobError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_hint: Option<RecoveryHint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSource {
    pub path: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentOutput {
    pub root_directory: String,
    pub job_directory: String,
    pub document_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets_directory: Option<String>,
    pub artifact_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetrics {
    pub duration_ms: u64,
    pub source_bytes: u64,
    pub output_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages_total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages_native: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages_ocr: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets_written: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPipeline {
    #[serde(alias = "pipelineVersion")]
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anydoc_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_inspector_version: Option<String>,
    #[serde(alias = "ocrModel", skip_serializing_if = "Option::is_none")]
    pub ocr_model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_model_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onnx_runtime_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdfium_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentJob {
    pub job_id: String,
    pub state: DocumentJobState,
    pub stage: String,
    pub source: DocumentSource,
    pub output: DocumentOutput,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub warnings: Vec<DocumentWarning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<DocumentJobError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<DocumentMetrics>,
    #[serde(alias = "provenance")]
    pub pipeline: DocumentPipeline,
}

fn document_job_state_name(state: DocumentJobState) -> &'static str {
    match state {
        DocumentJobState::Queued => "queued",
        DocumentJobState::Running => "running",
        DocumentJobState::Cancelling => "cancelling",
        DocumentJobState::Succeeded => "succeeded",
        DocumentJobState::SucceededWithWarnings => "succeeded_with_warnings",
        DocumentJobState::Failed => "failed",
        DocumentJobState::Cancelled => "cancelled",
        DocumentJobState::Interrupted => "interrupted",
    }
}

fn document_log_token(value: Option<&str>) -> &str {
    value
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        })
        .unwrap_or("unknown")
}

/// Emit manager-owned semantic diagnostics only. This projection deliberately
/// has no source/output path, display name, password, warning message, or body
/// field, so future transport/Worker payload changes cannot widen log content.
fn log_document_job(event: &'static str, job: &DocumentJob) {
    let metrics = job.metrics.as_ref();
    let error = job.error.as_ref();
    crate::ulog_info!(
        "[document] event={} jobId={} state={} stage={} format={} artifactAvailable={} warnings={} durationMs={} pagesTotal={} pagesOcr={} assetsWritten={} errorCode={} retryable={}",
        event,
        job.job_id,
        document_job_state_name(job.state),
        document_log_token(Some(&job.stage)),
        document_log_token(job.source.format.as_deref()),
        job.output.artifact_available,
        job.warnings.len(),
        metrics.map_or(0, |metrics| metrics.duration_ms),
        metrics.and_then(|metrics| metrics.pages_total).unwrap_or(0),
        metrics.and_then(|metrics| metrics.pages_ocr).unwrap_or(0),
        metrics.and_then(|metrics| metrics.assets_written).unwrap_or(0),
        document_log_token(error.map(|error| error.code.as_str())),
        error.is_some_and(|error| error.retryable),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSubmitRequest {
    pub source_path: String,
    pub output_root: Option<String>,
    pub current_workspace: Option<String>,
    pub password: Option<SecretString>,
}

pub struct SecretString(String);

impl SecretString {
    fn expose(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SecretString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self)
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.0.zeroize();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentServiceError {
    pub code: String,
    pub message: String,
    pub suggestion: String,
    pub recovery_hint: RecoveryHint,
}

impl DocumentServiceError {
    fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        suggestion: impl Into<String>,
    ) -> Self {
        let code = code.into();
        let message = message.into();
        let suggestion = suggestion.into();
        Self {
            code,
            message,
            recovery_hint: RecoveryHint {
                message: suggestion.clone(),
                recovery_command: None,
            },
            suggestion,
        }
    }

    fn with_command(mut self, command: impl Into<String>) -> Self {
        self.recovery_hint.recovery_command = Some(command.into());
        self
    }
}

struct PendingJob {
    source: same_file::Handle,
    source_version: SourceVersion,
    password: Option<SecretString>,
    private_dir: PathBuf,
    staging_dir: PathBuf,
    staging_identity: same_file::Handle,
    staging_token: String,
    output_root_identity: same_file::Handle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceVersion {
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

struct RunningWorker {
    job_id: String,
    generation: u64,
    child: Arc<Mutex<process_cmd::ChildTree>>,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
}

type SpawnedWorker = (
    Arc<Mutex<process_cmd::ChildTree>>,
    Arc<Mutex<std::process::ChildStdin>>,
    std::process::ChildStdout,
);

struct PublishAttempt<'a> {
    job_id: &'a str,
    generation: u64,
    deadline: std::time::Instant,
    staging: &'a Path,
    destination: &'a Path,
    staging_identity: &'a same_file::Handle,
    staging_token: &'a str,
    output_root_identity: &'a same_file::Handle,
    warnings: Vec<DocumentWarning>,
    detected_format: Option<String>,
    metrics: Option<WorkerMetrics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishIntent {
    schema_version: u32,
    job_id: String,
    staging_directory: String,
    destination_directory: String,
    staging_token: String,
}

struct ManagerState {
    accepting: bool,
    jobs: HashMap<String, DocumentJob>,
    queue: VecDeque<String>,
    pending: HashMap<String, PendingJob>,
    active_job: Option<(String, u64)>,
    running: Option<RunningWorker>,
    next_generation: u64,
    resource_error: Option<DocumentServiceError>,
}

pub struct DocumentProcessingManager {
    root: PathBuf,
    worker_path: PathBuf,
    manifest_path: PathBuf,
    onnx_runtime_path: PathBuf,
    onnx_runtime_version: String,
    runtime_registry: Arc<LocalInferenceRuntimeRegistry>,
    compute_coordinator: Arc<LocalComputeCoordinator>,
    state: Mutex<ManagerState>,
    wake: Notify,
}

impl DocumentProcessingManager {
    pub fn initialize(
        data_root: PathBuf,
        resource_root: PathBuf,
        runtime_registry: Arc<LocalInferenceRuntimeRegistry>,
        compute_coordinator: Arc<LocalComputeCoordinator>,
    ) -> Result<ManagedDocumentProcessing, String> {
        let root = data_root.join("document-processing");
        let jobs_root = root.join("jobs");
        fs::create_dir_all(&jobs_root)
            .map_err(|error| format!("Failed to create document-processing store: {error}"))?;
        set_private_permissions(&root)
            .and_then(|_| set_private_permissions(&jobs_root))
            .map_err(|error| format!("Failed to protect document-processing store: {error}"))?;
        let resource_dir = resource_root.join("document-processing").join("v1");
        let worker_name = if cfg!(windows) {
            "myagents-document-worker.exe"
        } else {
            "myagents-document-worker"
        };
        let worker_path = resource_dir.join(worker_name);
        let manifest_path = resource_dir.join("manifest.json");
        let runtime_validation = validate_resource_surface(
            &worker_path,
            &manifest_path,
            runtime_registry.as_ref(),
            false,
            &|| false,
        );
        let resource_error = runtime_validation.as_ref().err().cloned();
        let (onnx_runtime_path, onnx_runtime_version) = runtime_validation
            .ok()
            .map(|identity| {
                (
                    identity.path().to_path_buf(),
                    identity.version().to_string(),
                )
            })
            .unwrap_or_else(|| (resource_dir.join("invalid-onnx-runtime"), "unknown".into()));
        let mut jobs = load_jobs(&root)?;
        recover_publish_intents(&root, &mut jobs);
        recover_nonterminal_jobs(&root, &mut jobs);
        for job in jobs.values() {
            cleanup_stale_job_paths(&root, job);
        }
        prune_expired_jobs(&root, &mut jobs);
        let manager = Arc::new(Self {
            root,
            worker_path,
            manifest_path,
            onnx_runtime_path,
            onnx_runtime_version,
            runtime_registry: Arc::clone(&runtime_registry),
            compute_coordinator,
            state: Mutex::new(ManagerState {
                accepting: true,
                jobs,
                queue: VecDeque::new(),
                pending: HashMap::new(),
                active_job: None,
                running: None,
                next_generation: 1,
                resource_error,
            }),
            wake: Notify::new(),
        });
        let runner = Arc::clone(&manager);
        tauri::async_runtime::spawn(async move { runner.run_queue().await });
        Ok(manager)
    }

    pub(crate) fn start_background_resource_validation(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        let runtime_registry = Arc::clone(&self.runtime_registry);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(StdDuration::from_secs(10)).await;
                let lease = manager
                    .compute_coordinator
                    .acquire(ComputeWorkloadIdentity {
                        kind: ComputeWorkloadKind::BackgroundResourceValidation,
                        id: "document-resource-validation".to_string(),
                        generation: 1,
                    })
                    .await;
                let signal = lease.yield_signal();
                let validator = Arc::clone(&manager);
                let registry = Arc::clone(&runtime_registry);
                let result = tauri::async_runtime::spawn_blocking(move || {
                    validate_resource_surface(
                        &validator.worker_path,
                        &validator.manifest_path,
                        registry.as_ref(),
                        true,
                        &|| signal.should_yield(),
                    )
                })
                .await;
                drop(lease);
                match result {
                    Ok(Err(error)) if error.code == "DOCUMENT_RESOURCE_VALIDATION_YIELDED" => {
                        continue;
                    }
                    Ok(result) => {
                        match &result {
                            Ok(_) => crate::ulog_info!(
                                "[document] background resource verification completed"
                            ),
                            Err(error) => crate::ulog_warn!(
                                "[document] background resource verification failed code={}",
                                error.code
                            ),
                        }
                        if let Ok(mut state) = manager.state.lock() {
                            state.resource_error = result.err();
                        }
                        break;
                    }
                    Err(_) => {
                        crate::ulog_warn!(
                            "[document] background resource verification task failed"
                        );
                        if let Ok(mut state) = manager.state.lock() {
                            state.resource_error =
                                Some(resource_error("DOCUMENT_RESOURCE_INVALID"));
                        }
                        break;
                    }
                }
            }
        });
    }

    pub fn submit(
        &self,
        request: DocumentSubmitRequest,
    ) -> Result<DocumentJob, DocumentServiceError> {
        let _update_admission = crate::sidecar::begin_lifecycle_spawn_permit().map_err(|_| {
            DocumentServiceError::new(
                "UPDATE_BUSY",
                "Restart update is being prepared.",
                "Retry this operation after the update attempt.",
            )
        })?;
        let source_path =
            require_absolute_path(&request.source_path, "DOCUMENT_SOURCE_PATH_INVALID")?;
        reject_link_ancestors(&source_path, false)?;
        let lexical_metadata = fs::symlink_metadata(&source_path).map_err(|error| {
            let (code, message) = match error.kind() {
                std::io::ErrorKind::NotFound => (
                    "DOCUMENT_SOURCE_NOT_FOUND",
                    "The source file does not exist.",
                ),
                std::io::ErrorKind::PermissionDenied => (
                    "DOCUMENT_SOURCE_PERMISSION_DENIED",
                    "The source file cannot be opened with the current user's permissions.",
                ),
                _ => (
                    "DOCUMENT_SOURCE_PERMISSION_DENIED",
                    "The source file cannot be safely inspected.",
                ),
            };
            DocumentServiceError::new(
                code,
                message,
                "Check the source path and permissions, then retry.",
            )
        })?;
        if !lexical_metadata.is_file() || lexical_metadata.file_type().is_symlink() {
            return Err(DocumentServiceError::new(
                "DOCUMENT_SOURCE_NOT_FILE",
                "--file must point to one readable regular file, not a directory or link.",
                "Choose one supported local document and retry.",
            ));
        }
        let source =
            open_regular_file_no_follow(&source_path, "document source").map_err(|_| {
                DocumentServiceError::new(
                    "DOCUMENT_SOURCE_PERMISSION_DENIED",
                    "The source file cannot be opened without following links.",
                    "Check file permissions and retry.",
                )
            })?;
        let source_metadata = source.metadata().map_err(|_| {
            DocumentServiceError::new(
                "DOCUMENT_SOURCE_PERMISSION_DENIED",
                "The source file could not be inspected.",
                "Check file permissions and retry.",
            )
        })?;
        if source_metadata.len() == 0 || source_metadata.len() > MAX_SOURCE_BYTES {
            return Err(DocumentServiceError::new(
                "DOCUMENT_RESOURCE_LIMIT",
                "The source must be non-empty and no larger than 512 MiB.",
                "Choose a smaller source file and retry.",
            ));
        }
        let source_version = source_version(&source_metadata);
        let source = same_file::Handle::from_file(source).map_err(|_| {
            DocumentServiceError::new(
                "DOCUMENT_SOURCE_PERMISSION_DENIED",
                "The source file identity could not be held safely.",
                "Choose a stable local source file and retry.",
            )
        })?;
        let display_name = source_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                DocumentServiceError::new(
                    "DOCUMENT_SOURCE_PATH_INVALID",
                    "The source filename is not valid Unicode.",
                    "Rename the source file and retry.",
                )
            })?
            .to_string();
        let format = supported_extension(&source_path).ok_or_else(|| {
            DocumentServiceError::new(
                "DOCUMENT_UNSUPPORTED_FORMAT",
                "The source extension is not in the supported document/image allowlist.",
                "Run `myagents anydoc convert --help` to see supported formats.",
            )
            .with_command("myagents anydoc convert --help")
        })?;
        let output_root = resolve_output_root(
            request.output_root.as_deref(),
            request.current_workspace.as_deref(),
        )?;
        let output_root = prepare_output_root(&output_root)?;
        ensure_free_space(
            &output_root,
            MAX_OUTPUT_BYTES.saturating_add(MIN_FREE_RESERVE_BYTES),
            "output",
        )?;
        ensure_free_space(
            &self.root,
            source_metadata.len().saturating_add(MIN_FREE_RESERVE_BYTES),
            "private",
        )?;

        self.runtime_registry
            .identity(InferenceRuntimeKind::OnnxCpu)
            .map_err(|_| resource_error("DOCUMENT_RESOURCE_INVALID"))?;

        let mut state = self.state.lock().map_err(|_| manager_unavailable())?;
        if !state.accepting {
            return Err(DocumentServiceError::new(
                "DOCUMENT_MANAGER_SHUTTING_DOWN",
                "MyAgents is shutting down and cannot accept a new conversion.",
                "Restart MyAgents, then submit the conversion again.",
            ));
        }
        if let Some(error) = state.resource_error.clone() {
            return Err(error);
        }
        if state.queue.len() + usize::from(state.active_job.is_some()) >= QUEUE_LIMIT {
            return Err(DocumentServiceError::new(
                "DOCUMENT_QUEUE_FULL",
                "The document conversion queue is full (16 jobs).",
                "Wait for an existing job to finish or cancel one, then retry.",
            )
            .with_command("myagents anydoc list"));
        }
        let (job_id, staging_dir, public_dir) = reserve_job_identity(&output_root, &state.jobs)?;
        let output_root_identity = same_file::Handle::from_path(&output_root).map_err(|_| {
            let _ = fs::remove_dir(&staging_dir);
            DocumentServiceError::new(
                "DOCUMENT_OUTPUT_PATH_UNSAFE",
                "The output root identity could not be held safely for this job.",
                "Choose a stable local output directory and retry.",
            )
        })?;
        let private_dir = self.root.join("jobs").join(&job_id);
        let input_dir = private_dir.join("input");
        if let Err(error) = fs::create_dir_all(&input_dir) {
            let _ = fs::remove_dir(&staging_dir);
            return Err(DocumentServiceError::new(
                "DOCUMENT_PRIVATE_STORAGE_UNAVAILABLE",
                format!("The private job directory could not be created: {error}"),
                "Check free disk space and MyAgents data-directory permissions.",
            ));
        }
        if set_private_permissions(&private_dir)
            .and_then(|_| set_private_permissions(&staging_dir))
            .is_err()
        {
            let _ = fs::remove_dir_all(&private_dir);
            let _ = fs::remove_dir(&staging_dir);
            return Err(DocumentServiceError::new(
                "DOCUMENT_PRIVATE_STORAGE_UNAVAILABLE",
                "The job directories could not be restricted to the current user.",
                "Choose a local output directory with normal user permissions and retry.",
            ));
        }
        let staging_identity = same_file::Handle::from_path(&staging_dir).map_err(|_| {
            let _ = fs::remove_dir_all(&private_dir);
            let _ = fs::remove_dir(&staging_dir);
            DocumentServiceError::new(
                "DOCUMENT_OUTPUT_PATH_UNSAFE",
                "The reserved staging directory identity could not be held safely.",
                "Choose a stable local output directory and retry.",
            )
        })?;
        let staging_token = uuid::Uuid::new_v4().simple().to_string();
        if write_staging_ownership(&private_dir, &staging_dir, &staging_token).is_err() {
            let _ = fs::remove_dir_all(&private_dir);
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(DocumentServiceError::new(
                "DOCUMENT_PRIVATE_STORAGE_UNAVAILABLE",
                "The staging ownership marker could not be saved.",
                "Check output and MyAgents data-directory permissions, then retry.",
            ));
        }
        let now = Utc::now();
        let document_path = public_dir.join("document.md");
        let job = DocumentJob {
            job_id: job_id.clone(),
            state: DocumentJobState::Queued,
            stage: "queued".into(),
            source: DocumentSource {
                path: source_path.to_string_lossy().into_owned(),
                display_name,
                format: Some(format.into()),
                size_bytes: source_metadata.len(),
                sha256: None,
            },
            output: DocumentOutput {
                root_directory: output_root.to_string_lossy().into_owned(),
                job_directory: public_dir.to_string_lossy().into_owned(),
                document_path: document_path.to_string_lossy().into_owned(),
                assets_directory: None,
                artifact_available: false,
            },
            created_at: now,
            updated_at: now,
            started_at: None,
            finished_at: None,
            warnings: Vec::new(),
            error: None,
            metrics: None,
            pipeline: default_pipeline(&self.onnx_runtime_version),
        };
        if persist_job(&self.root, &job).is_err() {
            let _ = fs::remove_dir_all(&private_dir);
            let _ = fs::remove_dir(&staging_dir);
            return Err(DocumentServiceError::new(
                "DOCUMENT_JOB_STORE_WRITE_FAILED",
                "The document job metadata could not be saved.",
                "Check free disk space and retry.",
            ));
        }
        state.pending.insert(
            job_id.clone(),
            PendingJob {
                source,
                source_version,
                password: request.password,
                private_dir,
                staging_dir,
                staging_identity,
                staging_token,
                output_root_identity,
            },
        );
        state.queue.push_back(job_id.clone());
        state.jobs.insert(job_id, job.clone());
        drop(state);
        log_document_job("accepted", &job);
        self.wake.notify_one();
        Ok(job)
    }

    pub fn get(&self, job_id: &str) -> Result<DocumentJob, DocumentServiceError> {
        validate_job_id(job_id)?;
        let mut job = self
            .state
            .lock()
            .map_err(|_| manager_unavailable())?
            .jobs
            .get(job_id)
            .cloned()
            .ok_or_else(|| job_not_found(job_id))?;
        job.output.artifact_available = artifact_is_available(&job);
        Ok(job)
    }

    pub fn list(&self, limit: usize) -> Result<Vec<DocumentJob>, DocumentServiceError> {
        if !(1..=100).contains(&limit) {
            return Err(DocumentServiceError::new(
                "DOCUMENT_LIST_LIMIT_INVALID",
                "--limit must be an integer from 1 to 100.",
                "Retry with `--limit 20` or another value in the allowed range.",
            ));
        }
        let state = self.state.lock().map_err(|_| manager_unavailable())?;
        let mut jobs = state.jobs.values().cloned().collect::<Vec<_>>();
        jobs.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        jobs.truncate(limit);
        for job in &mut jobs {
            job.output.artifact_available = artifact_is_available(job);
        }
        Ok(jobs)
    }

    pub fn cancel(self: &Arc<Self>, job_id: &str) -> Result<DocumentJob, DocumentServiceError> {
        validate_job_id(job_id)?;
        let mut state = self.state.lock().map_err(|_| manager_unavailable())?;
        let snapshot = state
            .jobs
            .get(job_id)
            .cloned()
            .ok_or_else(|| job_not_found(job_id))?;
        match snapshot.state {
            DocumentJobState::Queued => {
                let now = Utc::now();
                let mut job = snapshot;
                job.state = DocumentJobState::Cancelled;
                job.stage = "finalizing".into();
                job.updated_at = now;
                job.finished_at = Some(now);
                job.error = Some(cancelled_error());
                persist_job(&self.root, &job).map_err(store_error)?;
                state.queue.retain(|queued| queued != job_id);
                let pending = state.pending.remove(job_id);
                state.jobs.insert(job_id.to_string(), job.clone());
                drop(state);
                if let Some(pending) = pending {
                    cleanup_pending(&pending);
                }
                log_document_job("terminal", &job);
                Ok(job)
            }
            DocumentJobState::Running => {
                let now = Utc::now();
                let mut job = snapshot;
                job.state = DocumentJobState::Cancelling;
                job.updated_at = now;
                let running = state.running.as_ref().map(|running| {
                    (
                        running.generation,
                        Arc::clone(&running.stdin),
                        Arc::clone(&running.child),
                    )
                });
                persist_job(&self.root, &job).map_err(store_error)?;
                state.jobs.insert(job_id.to_string(), job.clone());
                drop(state);
                log_document_job("cancel_requested", &job);
                if let Some((generation, stdin, child)) = running {
                    let _ = send_cancel(&stdin, job_id, generation);
                    let manager = Arc::clone(self);
                    let id = job_id.to_string();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(WORKER_CANCEL_GRACE).await;
                        if manager.is_running_generation(&id, generation) {
                            if let Ok(mut child) = child.lock() {
                                let _ = child.kill_and_wait();
                            }
                        }
                    });
                }
                Ok(job)
            }
            DocumentJobState::Cancelling | DocumentJobState::Cancelled => Ok(snapshot),
            _ => Err(DocumentServiceError::new(
                "DOCUMENT_JOB_NOT_CANCELLABLE",
                format!("Job {job_id} is already terminal and cannot be cancelled."),
                "Submit a new conversion if you need a fresh artifact.",
            )),
        }
    }

    pub(crate) fn has_pending_work(&self) -> Result<bool, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "UPDATE_ACTIVITY_UNKNOWN".to_string())?;
        Ok(!state.queue.is_empty()
            || !state.pending.is_empty()
            || state.active_job.is_some()
            || state.running.is_some())
    }

    pub fn shutdown(&self) -> Result<(), String> {
        let (pending, running, interrupted) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "document manager lock poisoned".to_string())?;
            state.accepting = false;
            let now = Utc::now();
            let ids = state
                .jobs
                .iter()
                .filter_map(|(id, job)| (!job.state.is_terminal()).then_some(id.clone()))
                .collect::<Vec<_>>();
            let mut interrupted = Vec::new();
            for id in ids {
                let job = state.jobs.get_mut(&id).expect("collected job id");
                job.state = DocumentJobState::Interrupted;
                job.stage = "finalizing".into();
                job.updated_at = now;
                job.finished_at = Some(now);
                job.error = Some(interrupted_error(&id));
                interrupted.push(job.clone());
            }
            state.queue.clear();
            let pending = state
                .pending
                .drain()
                .map(|(_, pending)| pending)
                .collect::<Vec<_>>();
            state.active_job = None;
            let running = state.running.take();
            (pending, running, interrupted)
        };
        let mut persistence_error = None;
        for job in interrupted {
            if let Err(error) = persist_job(&self.root, &job) {
                persistence_error.get_or_insert(error);
            }
            log_document_job("terminal", &job);
        }
        for pending in pending {
            cleanup_pending(&pending);
        }
        if let Some(running) = running {
            let _ = send_cancel(&running.stdin, &running.job_id, running.generation);
            let _ = process_cmd::settle_tree(&running.child, WORKER_SHUTDOWN_GRACE);
        }
        match persistence_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn is_running_generation(&self, job_id: &str, generation: u64) -> bool {
        self.state
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .running
                    .as_ref()
                    .map(|running| running.job_id == job_id && running.generation == generation)
            })
            .unwrap_or(false)
    }

    async fn run_queue(self: Arc<Self>) {
        loop {
            self.wake.notified().await;
            loop {
                let next = match self.take_next_job() {
                    Ok(next) => next,
                    Err(error) => {
                        crate::ulog_error!("[document] queue state error: {}", error);
                        break;
                    }
                };
                let Some((job, pending, generation)) = next else {
                    break;
                };
                let manager = Arc::clone(&self);
                let job_id = job.job_id.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    manager.execute_job(&job, pending, generation)
                })
                .await;
                if let Err(error) = result {
                    self.finish_failed(&job_id, generation, "DOCUMENT_WORKER_CRASHED", true);
                    crate::ulog_error!("[document] Worker join failed: {}", error);
                }
                self.clear_active(&job_id, generation);
            }
        }
    }

    fn take_next_job(&self) -> Result<Option<(DocumentJob, PendingJob, u64)>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "manager lock poisoned".to_string())?;
        if !state.accepting || state.active_job.is_some() {
            return Ok(None);
        }
        let Some(job_id) = state.queue.front().cloned() else {
            return Ok(None);
        };
        if !state.pending.contains_key(&job_id) {
            return Err("queued job is missing its live admission resources".into());
        }
        let generation = state.next_generation;
        let now = Utc::now();
        let mut job = state
            .jobs
            .get(&job_id)
            .cloned()
            .ok_or_else(|| "queued job missing".to_string())?;
        job.state = DocumentJobState::Running;
        job.stage = "admitting".into();
        job.started_at = Some(now);
        job.updated_at = now;
        persist_job(&self.root, &job)?;
        state.queue.pop_front();
        let pending = state
            .pending
            .remove(&job_id)
            .expect("pending checked above");
        state.jobs.insert(job_id.clone(), job.clone());
        state.next_generation = state.next_generation.saturating_add(1).max(1);
        state.active_job = Some((job_id, generation));
        log_document_job("started", &job);
        Ok(Some((job, pending, generation)))
    }

    fn execute_job(self: &Arc<Self>, job: &DocumentJob, mut pending: PendingJob, generation: u64) {
        let deadline = std::time::Instant::now()
            .checked_add(std::time::Duration::from_secs(JOB_DEADLINE_SECONDS))
            .unwrap_or_else(std::time::Instant::now);
        let input_path = pending.private_dir.join("input").join("source.bin");
        let source_hash = match copy_source(
            pending.source.as_file_mut(),
            &input_path,
            job.source.size_bytes,
            &pending.source_version,
            || {
                if std::time::Instant::now() >= deadline {
                    Err("DOCUMENT_TIMEOUT")
                } else if self.job_can_start_worker(&job.job_id, generation) {
                    Ok(())
                } else {
                    Err("DOCUMENT_CANCELLED")
                }
            },
        ) {
            Ok(hash) => hash,
            Err(code) => {
                if code == "DOCUMENT_CANCELLED" {
                    self.finish_cancelled_if_needed(&job.job_id, generation);
                } else {
                    self.finish_failed(
                        &job.job_id,
                        generation,
                        &code,
                        worker_code_retryable(&code),
                    );
                }
                cleanup_pending(&pending);
                return;
            }
        };
        self.update_source_hash(&job.job_id, source_hash);
        // Only process birth is covered by the app-wide lifecycle permit.
        // Admission copy is cancellable owner work and must never make update
        // or App exit wait before the Manager has a ChildTree it can settle.
        let lifecycle_spawn_permit = match crate::sidecar::begin_lifecycle_spawn_permit() {
            Ok(permit) => permit,
            Err(_) => {
                self.finish_interrupted_if_needed(&job.job_id, generation);
                cleanup_pending(&pending);
                return;
            }
        };
        let (child, stdin, mut stdout) =
            match self.spawn_registered_worker(job, &pending.private_dir, generation) {
                Ok(worker) => worker,
                Err("DOCUMENT_CANCELLED") => {
                    self.finish_cancelled_if_needed(&job.job_id, generation);
                    cleanup_pending(&pending);
                    return;
                }
                Err(code) => {
                    self.finish_failed(&job.job_id, generation, code, true);
                    cleanup_pending(&pending);
                    return;
                }
            };
        drop(lifecycle_spawn_permit);
        let watchdog_manager = Arc::clone(self);
        let watchdog_job_id = job.job_id.clone();
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(remaining).await;
            watchdog_manager.timeout_running_job(&watchdog_job_id, generation);
        });
        let write_result = {
            let start = WorkerStartRequest {
                message_type: "start",
                protocol_version: PROTOCOL_VERSION,
                job_id: &job.job_id,
                worker_generation: generation,
                input_path: &input_path,
                source_name: &job.source.display_name,
                staging_path: &pending.staging_dir,
                resource_manifest_path: &self.manifest_path,
                onnx_runtime_path: &self.onnx_runtime_path,
                password: pending.password.as_ref().map(SecretString::expose),
            };
            stdin
                .lock()
                .map_err(|_| ())
                .and_then(|mut stdin| write_frame(&mut *stdin, &start).map_err(|_| ()))
        };
        // Keep the Manager-side secret only for the lifetime of this admitted
        // job. A live-ASR preemption may restart the exact Worker generation;
        // retaining this already-owned copy avoids changing the job ID or
        // asking the user for the password again. cleanup_pending/drop still
        // zeroizes it at terminal settlement.
        if write_result.is_err() {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill_and_wait();
            }
            self.finish_failed(
                &job.job_id,
                generation,
                "DOCUMENT_WORKER_PROTOCOL_ERROR",
                true,
            );
            cleanup_pending(&pending);
            return;
        }
        let worker_settled = Arc::new(AtomicBool::new(false));
        let requeue_for_live = Arc::new(AtomicBool::new(false));
        let mut ocr_lease: Option<LocalComputeLease> = None;
        let terminal = read_worker_responses(
            &mut stdout,
            &job.job_id,
            generation,
            |response| self.handle_progress(&job.job_id, generation, response),
            || {
                if ocr_lease.is_some() {
                    return Err(WorkerResponseReadError::Protocol(
                        "worker requested the OCR lease twice".into(),
                    ));
                }
                let lease = tauri::async_runtime::block_on(self.compute_coordinator.acquire(
                    ComputeWorkloadIdentity {
                        kind: ComputeWorkloadKind::DocumentOcr,
                        id: job.job_id.clone(),
                        generation,
                    },
                ));
                if !self.job_can_start_worker(&job.job_id, generation) {
                    drop(lease);
                    return Err(WorkerResponseReadError::Crashed(
                        "document generation lost OCR admission".into(),
                    ));
                }
                send_ocr_lease_grant(&stdin, &job.job_id, generation).map_err(|_| {
                    WorkerResponseReadError::Protocol("OCR lease grant failed".into())
                })?;
                arm_document_ocr_yield(
                    lease.yield_signal(),
                    Arc::clone(&stdin),
                    Arc::clone(&child),
                    job.job_id.clone(),
                    generation,
                    Arc::clone(&worker_settled),
                    Arc::clone(&requeue_for_live),
                );
                ocr_lease = Some(lease);
                Ok(())
            },
            || {
                arm_worker_settlement_deadline(
                    Arc::clone(&child),
                    Arc::clone(&worker_settled),
                    WORKER_TERMINAL_GRACE,
                );
            },
        );
        let natural_grace = if terminal.is_ok() {
            WORKER_TERMINAL_GRACE
        } else {
            let _ = send_cancel(&stdin, &job.job_id, generation);
            WORKER_CANCEL_GRACE
        };
        let _ = process_cmd::settle_tree(&child, natural_grace);
        worker_settled.store(true, Ordering::Release);
        drop(ocr_lease);
        if requeue_for_live.load(Ordering::Acquire) {
            self.settle_ocr_yield(&job.job_id, generation, pending);
            return;
        }
        let cancelling = self
            .state
            .lock()
            .ok()
            .and_then(|state| {
                state.jobs.get(&job.job_id).map(|job| {
                    matches!(
                        job.state,
                        DocumentJobState::Cancelling | DocumentJobState::Interrupted
                    )
                })
            })
            .unwrap_or(false);
        if cancelling {
            self.finish_cancelled_if_needed(&job.job_id, generation);
            cleanup_pending(&pending);
            return;
        }
        match terminal {
            Ok(WorkerTerminal {
                success: true,
                warnings,
                detected_format,
                metrics,
                ..
            }) => {
                if let Err(code) = self.publish_succeeded(PublishAttempt {
                    job_id: &job.job_id,
                    generation,
                    deadline,
                    staging: &pending.staging_dir,
                    destination: Path::new(&job.output.job_directory),
                    staging_identity: &pending.staging_identity,
                    staging_token: &pending.staging_token,
                    output_root_identity: &pending.output_root_identity,
                    warnings,
                    detected_format,
                    metrics,
                }) {
                    self.finish_failed(&job.job_id, generation, code, worker_code_retryable(code));
                    cleanup_pending(&pending);
                    return;
                }
                cleanup_private_input(&pending.private_dir);
            }
            Ok(WorkerTerminal {
                code: Some(code), ..
            }) => {
                self.finish_failed(&job.job_id, generation, &code, worker_code_retryable(&code));
                cleanup_pending(&pending);
            }
            Err(error) => {
                crate::ulog_warn!(
                    "[document] Worker response rejected code={} detail={:?}",
                    error.code(),
                    error
                );
                self.finish_failed(&job.job_id, generation, error.code(), true);
                cleanup_pending(&pending);
            }
            Ok(_) => unreachable!("WorkerTerminal success/code shapes are exhaustive"),
        }
    }

    fn spawn_registered_worker(
        &self,
        job: &DocumentJob,
        private_dir: &Path,
        generation: u64,
    ) -> Result<SpawnedWorker, &'static str> {
        let mut command = process_cmd::new(&self.worker_path);
        command
            .current_dir(private_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();

        // Shutdown/cancel and the final spawn gate share this lock. Once a
        // process exists it is already visible as `running`, so App exit can
        // never miss a late Worker between OS spawn and Manager registration.
        let mut state = self
            .state
            .lock()
            .map_err(|_| "DOCUMENT_MANAGER_UNAVAILABLE")?;
        let can_spawn = state.accepting
            && state
                .jobs
                .get(&job.job_id)
                .is_some_and(|job| job.state == DocumentJobState::Running)
            && state
                .active_job
                .as_ref()
                .is_some_and(|(active_id, active_generation)| {
                    active_id == &job.job_id && *active_generation == generation
                });
        if !can_spawn {
            return Err("DOCUMENT_CANCELLED");
        }

        let mut child =
            process_cmd::spawn_tree(&mut command).map_err(|_| "DOCUMENT_WORKER_START_FAILED")?;
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill_and_wait();
            return Err("DOCUMENT_WORKER_PROTOCOL_ERROR");
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill_and_wait();
            return Err("DOCUMENT_WORKER_PROTOCOL_ERROR");
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill_and_wait();
            return Err("DOCUMENT_WORKER_PROTOCOL_ERROR");
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

    fn handle_progress(&self, job_id: &str, generation: u64, response: WorkerProgress) {
        if response.generation != generation || response.job_id != job_id {
            return;
        }
        let stage = match response.stage.as_str() {
            "inspecting" => "inspecting",
            "decrypting" => "decrypting",
            "extracting" => "extracting",
            "rendering" => "rendering",
            "ocr" => "ocr",
            "writing" => "assembling",
            "validating" => "finalizing",
            _ => return,
        };
        let changed = if let Ok(mut state) = self.state.lock() {
            if let Some(job) = state.jobs.get_mut(job_id) {
                if job.state == DocumentJobState::Running {
                    let stage_changed = job.stage != stage;
                    job.stage = stage.into();
                    job.updated_at = Utc::now();
                    stage_changed.then(|| job.clone())
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        if let Some(job) = changed {
            log_document_job("stage_changed", &job);
        }
    }

    fn update_source_hash(&self, job_id: &str, hash: String) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(job) = state.jobs.get_mut(job_id) {
                job.source.sha256 = Some(hash);
                job.updated_at = Utc::now();
                let snapshot = job.clone();
                let _ = persist_job(&self.root, &snapshot);
            }
        }
    }

    fn clear_active(&self, job_id: &str, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state
                .active_job
                .as_ref()
                .is_some_and(|(active_id, active_generation)| {
                    active_id == job_id && *active_generation == generation
                })
            {
                state.active_job = None;
            }
        }
    }

    fn settle_ocr_yield(&self, job_id: &str, generation: u64, mut pending: PendingJob) {
        let state_allows_retry = self.state.lock().ok().is_some_and(|state| {
            state.jobs.get(job_id).is_some_and(|job| {
                job.state == DocumentJobState::Running
                    && state
                        .active_job
                        .as_ref()
                        .is_some_and(|active| active == &(job_id.to_string(), generation))
            })
        });
        if !state_allows_retry {
            self.finish_cancelled_if_needed(job_id, generation);
            cleanup_pending(&pending);
            return;
        }
        if prepare_pending_for_retry(&mut pending).is_err() {
            self.finish_failed(job_id, generation, "DOCUMENT_PUBLISH_FAILED", true);
            cleanup_pending(&pending);
            return;
        }

        let snapshot = {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => {
                    cleanup_pending(&pending);
                    return;
                }
            };
            let can_requeue = state.jobs.get(job_id).is_some_and(|job| {
                job.state == DocumentJobState::Running
                    && state
                        .active_job
                        .as_ref()
                        .is_some_and(|active| active == &(job_id.to_string(), generation))
            });
            if !can_requeue {
                drop(state);
                self.finish_cancelled_if_needed(job_id, generation);
                cleanup_pending(&pending);
                return;
            }
            let mut job = state.jobs.get(job_id).cloned().expect("checked above");
            job.state = DocumentJobState::Queued;
            job.stage = "queued".into();
            job.started_at = None;
            job.updated_at = Utc::now();
            job.finished_at = None;
            job.error = None;
            if persist_job(&self.root, &job).is_err() {
                drop(state);
                self.finish_failed(job_id, generation, "DOCUMENT_JOB_STORE_WRITE_FAILED", true);
                cleanup_pending(&pending);
                return;
            }
            clear_running_locked(&mut state, job_id, generation);
            state.active_job = None;
            state.pending.insert(job_id.to_string(), pending);
            state.queue.push_front(job_id.to_string());
            state.jobs.insert(job_id.to_string(), job.clone());
            job
        };
        log_document_job("ocr_yield_requeued", &snapshot);
        self.wake.notify_one();
    }

    fn job_can_start_worker(&self, job_id: &str, generation: u64) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state.accepting
                && state
                    .jobs
                    .get(job_id)
                    .is_some_and(|job| job.state == DocumentJobState::Running)
                && state
                    .active_job
                    .as_ref()
                    .is_some_and(|(active_id, active_generation)| {
                        active_id == job_id && *active_generation == generation
                    })
        })
    }

    fn timeout_running_job(&self, job_id: &str, generation: u64) {
        let child = {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            let generation_matches = state.running.as_ref().is_some_and(|running| {
                running.job_id == job_id && running.generation == generation
            });
            if !generation_matches {
                return;
            }
            let now = Utc::now();
            let Some(job) = state.jobs.get_mut(job_id) else {
                return;
            };
            if job.state != DocumentJobState::Running {
                return;
            }
            job.state = DocumentJobState::Failed;
            job.stage = "finalizing".into();
            job.updated_at = now;
            job.finished_at = Some(now);
            job.error = Some(worker_error(job_id, "DOCUMENT_TIMEOUT", true));
            let snapshot = job.clone();
            let _ = persist_job(&self.root, &snapshot);
            log_document_job("terminal", &snapshot);
            state
                .running
                .as_ref()
                .map(|running| Arc::clone(&running.child))
        };
        if let Some(child) = child {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill_and_wait();
            }
        }
    }

    fn publish_succeeded(&self, attempt: PublishAttempt<'_>) -> Result<(), &'static str> {
        let PublishAttempt {
            job_id,
            generation,
            deadline,
            staging,
            destination,
            staging_identity,
            staging_token,
            output_root_identity,
            warnings,
            detected_format,
            metrics,
        } = attempt;
        let mut state = self.state.lock().map_err(|_| "DOCUMENT_PUBLISH_FAILED")?;
        let generation_matches =
            state
                .active_job
                .as_ref()
                .is_some_and(|(active_id, active_generation)| {
                    active_id == job_id && *active_generation == generation
                });
        let can_publish = generation_matches
            && state
                .jobs
                .get(job_id)
                .is_some_and(|job| job.state == DocumentJobState::Running);
        if !can_publish {
            return Err("DOCUMENT_CANCELLED");
        }
        if std::time::Instant::now() >= deadline {
            return Err("DOCUMENT_TIMEOUT");
        }
        let intent = PublishIntent {
            schema_version: 1,
            job_id: job_id.to_string(),
            staging_directory: staging.to_string_lossy().into_owned(),
            destination_directory: destination.to_string_lossy().into_owned(),
            staging_token: staging_token.to_string(),
        };
        persist_publish_intent(&self.root, &intent)
            .map_err(|_| "DOCUMENT_JOB_STORE_WRITE_FAILED")?;
        if std::time::Instant::now() >= deadline {
            let _ = clear_publish_intent(&self.root, job_id);
            return Err("DOCUMENT_TIMEOUT");
        }
        publish(
            staging,
            destination,
            staging_identity,
            staging_token,
            output_root_identity,
            deadline,
        )?;
        let mut job = state
            .jobs
            .get(job_id)
            .cloned()
            .ok_or("DOCUMENT_PUBLISH_FAILED")?;
        // Capture the logical commit point only after all potentially slow
        // artifact IO. This lock is also the timeout/cancel arbiter, so a
        // Worker terminal frame can never win merely because the watchdog is
        // waiting for this lock after the deadline.
        if std::time::Instant::now() >= deadline {
            if rollback_published_artifact_durable(
                destination,
                staging,
                staging_identity,
                staging_token,
            ) {
                let _ = clear_publish_intent(&self.root, job_id);
            }
            return Err("DOCUMENT_TIMEOUT");
        }
        let now = Utc::now();
        job.state = if warnings.is_empty() {
            DocumentJobState::Succeeded
        } else {
            DocumentJobState::SucceededWithWarnings
        };
        job.stage = "finalizing".into();
        job.updated_at = now;
        job.finished_at = Some(now);
        job.output.artifact_available = true;
        job.source.format = detected_format;
        let assets = destination.join("assets");
        job.output.assets_directory = assets
            .is_dir()
            .then(|| assets.to_string_lossy().into_owned());
        job.warnings = warnings;
        job.metrics = metrics.map(|metrics| DocumentMetrics {
            duration_ms: metrics.elapsed_ms,
            source_bytes: metrics.source_bytes,
            output_bytes: metrics.output_bytes,
            pages_total: (metrics.pages_total > 0).then_some(metrics.pages_total),
            pages_native: (metrics.pages_total > 0)
                .then_some(metrics.pages_total.saturating_sub(metrics.pages_ocr)),
            pages_ocr: (metrics.pages_total > 0).then_some(metrics.pages_ocr),
            assets_written: Some(metrics.assets_written),
        });
        if let Err(_error) = persist_job_resolving_unknown(&self.root, &job) {
            // Publishing and terminal metadata form one product commit. If
            // the private metadata write fails, move the just-published
            // directory back to its hidden staging identity before reporting
            // failure so callers never observe a successful-looking orphan.
            if rollback_published_artifact_durable(
                destination,
                staging,
                staging_identity,
                staging_token,
            ) {
                crate::ulog_warn!(
                    "[document] terminal metadata write had unknown outcome; artifact rolled back and intent retained error_kind=store"
                );
                return Err("DOCUMENT_PUBLISH_FAILED");
            }
            crate::ulog_error!(
                "[document] terminal metadata write and publish rollback both failed jobId={}",
                job_id
            );
            // The durable intent remains. Startup will authenticate the
            // marker and quarantine/rollback the public directory before it
            // recovers the still-nonterminal job as interrupted.
            return Err("DOCUMENT_PUBLISH_FAILED");
        }
        // From this point terminal success is durable and irreversible. Any
        // later output deletion/substitution is user-owned artifact lifecycle
        // and affects only derived artifactAvailable, never job history.
        let destination_is_expected = same_file::Handle::from_path(destination)
            .is_ok_and(|actual| &actual == staging_identity);
        let marker = destination.join(STAGING_OWNER_MARKER);
        let marker_cleanup_durable = if destination_is_expected {
            match fs::read_to_string(&marker) {
                Ok(actual) if actual == staging_token => fs::remove_file(&marker)
                    .and_then(|_| sync_directory(destination))
                    .is_ok(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    sync_directory(destination).is_ok()
                }
                _ => true,
            }
        } else {
            true
        };
        if marker_cleanup_durable {
            let _ = clear_publish_intent(&self.root, job_id);
        } else {
            crate::ulog_warn!("[document] committed publish cleanup deferred to startup");
        }
        log_document_job("terminal", &job);
        state.jobs.insert(job_id.to_string(), job);
        clear_running_locked(&mut state, job_id, generation);
        Ok(())
    }

    fn finish_failed(&self, job_id: &str, generation: u64, code: &str, retryable: bool) {
        if let Ok(mut state) = self.state.lock() {
            let generation_matches =
                state
                    .active_job
                    .as_ref()
                    .is_some_and(|(active_id, active_generation)| {
                        active_id == job_id && *active_generation == generation
                    });
            if generation_matches {
                if let Some(job) = state.jobs.get_mut(job_id) {
                    if job.state == DocumentJobState::Cancelling {
                        let now = Utc::now();
                        job.state = DocumentJobState::Cancelled;
                        job.stage = "finalizing".into();
                        job.updated_at = now;
                        job.finished_at = Some(now);
                        job.error = Some(cancelled_error());
                        let snapshot = job.clone();
                        let _ = persist_job(&self.root, &snapshot);
                        log_document_job("terminal", &snapshot);
                    } else if !job.state.is_terminal() {
                        let now = Utc::now();
                        job.state = DocumentJobState::Failed;
                        job.stage = "finalizing".into();
                        job.updated_at = now;
                        job.finished_at = Some(now);
                        job.error = Some(worker_error(job_id, code, retryable));
                        let snapshot = job.clone();
                        let _ = persist_job(&self.root, &snapshot);
                        log_document_job("terminal", &snapshot);
                    }
                }
                clear_running_locked(&mut state, job_id, generation);
            }
        }
    }

    fn finish_cancelled_if_needed(&self, job_id: &str, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            let generation_matches =
                state
                    .active_job
                    .as_ref()
                    .is_some_and(|(active_id, active_generation)| {
                        active_id == job_id && *active_generation == generation
                    });
            if !generation_matches {
                return;
            }
            if let Some(job) = state.jobs.get_mut(job_id) {
                if job.state == DocumentJobState::Cancelling {
                    let now = Utc::now();
                    job.state = DocumentJobState::Cancelled;
                    job.stage = "finalizing".into();
                    job.updated_at = now;
                    job.finished_at = Some(now);
                    job.error = Some(cancelled_error());
                    let snapshot = job.clone();
                    let _ = persist_job(&self.root, &snapshot);
                    log_document_job("terminal", &snapshot);
                }
            }
            clear_running_locked(&mut state, job_id, generation);
        }
    }

    fn finish_interrupted_if_needed(&self, job_id: &str, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            let generation_matches =
                state
                    .active_job
                    .as_ref()
                    .is_some_and(|(active_id, active_generation)| {
                        active_id == job_id && *active_generation == generation
                    });
            if !generation_matches {
                return;
            }
            if let Some(job) = state.jobs.get_mut(job_id) {
                let now = Utc::now();
                if job.state == DocumentJobState::Cancelling {
                    job.state = DocumentJobState::Cancelled;
                    job.error = Some(cancelled_error());
                } else if job.state == DocumentJobState::Running {
                    job.state = DocumentJobState::Interrupted;
                    job.error = Some(interrupted_error(job_id));
                } else {
                    return;
                }
                job.stage = "finalizing".into();
                job.updated_at = now;
                job.finished_at = Some(now);
                let snapshot = job.clone();
                let _ = persist_job(&self.root, &snapshot);
                log_document_job("terminal", &snapshot);
            }
            clear_running_locked(&mut state, job_id, generation);
        }
    }
}

fn drain_worker_stderr(mut stderr: std::process::ChildStderr, job_id: String, generation: u64) {
    std::thread::spawn(move || {
        let mut total = 0_usize;
        let mut buffer = [0_u8; 4096];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => total = total.saturating_add(read),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        if total > 0 {
            crate::ulog_warn!(
                "[document] Worker wrote redacted stderr jobId={} generation={} bytes={} truncated={}",
                job_id,
                generation,
                total.min(MAX_WORKER_STDERR_DIAGNOSTIC_BYTES),
                total > MAX_WORKER_STDERR_DIAGNOSTIC_BYTES
            );
        }
    });
}

fn clear_running_locked(state: &mut ManagerState, job_id: &str, generation: u64) {
    if state
        .running
        .as_ref()
        .is_some_and(|running| running.job_id == job_id && running.generation == generation)
    {
        state.running = None;
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum WorkerMessage {
    Ready {
        protocol_version: u32,
        job_id: String,
        worker_generation: u64,
    },
    Progress {
        protocol_version: u32,
        job_id: String,
        worker_generation: u64,
        stage: String,
        current: Option<u32>,
        total: Option<u32>,
        unit: Option<String>,
    },
    OcrLeaseRequested {
        protocol_version: u32,
        job_id: String,
        worker_generation: u64,
    },
    Completed {
        protocol_version: u32,
        job_id: String,
        worker_generation: u64,
        result: WorkerCompleted,
    },
    Failed {
        protocol_version: u32,
        job_id: String,
        worker_generation: u64,
        error: WorkerFailure,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerCompleted {
    #[serde(default)]
    warnings: Vec<DocumentWarning>,
    detected_format: String,
    metrics: WorkerMetrics,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerFailure {
    code: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerStartRequest<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    protocol_version: u32,
    job_id: &'a str,
    worker_generation: u64,
    input_path: &'a Path,
    source_name: &'a str,
    staging_path: &'a Path,
    resource_manifest_path: &'a Path,
    onnx_runtime_path: &'a Path,
    password: Option<&'a str>,
}

struct WorkerProgress {
    job_id: String,
    generation: u64,
    stage: String,
}
#[derive(Debug)]
struct WorkerTerminal {
    success: bool,
    code: Option<String>,
    warnings: Vec<DocumentWarning>,
    detected_format: Option<String>,
    metrics: Option<WorkerMetrics>,
}

#[derive(Debug, PartialEq, Eq)]
enum WorkerResponseReadError {
    Protocol(String),
    Crashed(String),
}

impl WorkerResponseReadError {
    fn code(&self) -> &'static str {
        match self {
            Self::Protocol(_) => "DOCUMENT_WORKER_PROTOCOL_ERROR",
            Self::Crashed(_) => "DOCUMENT_WORKER_CRASHED",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerMetrics {
    source_bytes: u64,
    output_bytes: u64,
    pages_total: u32,
    pages_ocr: u32,
    assets_written: u32,
    elapsed_ms: u64,
}

fn read_worker_responses(
    stdout: &mut impl Read,
    expected_job_id: &str,
    expected_generation: u64,
    mut progress: impl FnMut(WorkerProgress),
    mut acquire_ocr_lease: impl FnMut() -> Result<(), WorkerResponseReadError>,
    mut terminal_received: impl FnMut(),
) -> Result<WorkerTerminal, WorkerResponseReadError> {
    let mut ready = false;
    let mut ocr_lease_requested = false;
    let mut terminal = None;
    loop {
        let payload = match read_frame(stdout) {
            Ok(Some(payload)) => payload,
            Ok(None) => {
                return terminal.ok_or_else(|| {
                    WorkerResponseReadError::Crashed(
                        "worker stdout closed before a terminal response".into(),
                    )
                });
            }
            Err(error) => return Err(WorkerResponseReadError::Protocol(error)),
        };
        if terminal.is_some() {
            return Err(WorkerResponseReadError::Protocol(
                "worker emitted a frame after terminal".into(),
            ));
        }
        let message: WorkerMessage = serde_json::from_slice(&payload)
            .map_err(|_| WorkerResponseReadError::Protocol("invalid worker JSON".into()))?;
        match message {
            WorkerMessage::Ready {
                protocol_version,
                job_id,
                worker_generation,
            } => {
                validate_worker_identity(
                    protocol_version,
                    &job_id,
                    worker_generation,
                    expected_job_id,
                    expected_generation,
                    "ready",
                )?;
                if ready {
                    return Err(WorkerResponseReadError::Protocol(
                        "worker emitted duplicate ready".into(),
                    ));
                }
                ready = true;
            }
            WorkerMessage::Progress {
                protocol_version,
                job_id,
                worker_generation,
                stage,
                current,
                total,
                unit,
            } => {
                validate_worker_identity(
                    protocol_version,
                    &job_id,
                    worker_generation,
                    expected_job_id,
                    expected_generation,
                    "progress",
                )?;
                if !ready {
                    return Err(WorkerResponseReadError::Protocol(
                        "progress arrived before ready".into(),
                    ));
                }
                if !is_worker_stage(&stage) {
                    return Err(WorkerResponseReadError::Protocol(
                        "worker progress stage invalid".into(),
                    ));
                }
                let progress_shape_valid = match (&current, &total, &unit) {
                    (None, None, None) => true,
                    (Some(current), Some(total), Some(unit)) => {
                        *total > 0
                            && current <= total
                            && matches!(unit.as_str(), "page" | "slide" | "sheet" | "block")
                    }
                    _ => false,
                };
                if !progress_shape_valid {
                    return Err(WorkerResponseReadError::Protocol(
                        "worker progress shape invalid".into(),
                    ));
                }
                progress(WorkerProgress {
                    job_id,
                    generation: worker_generation,
                    stage,
                });
            }
            WorkerMessage::OcrLeaseRequested {
                protocol_version,
                job_id,
                worker_generation,
            } => {
                validate_worker_identity(
                    protocol_version,
                    &job_id,
                    worker_generation,
                    expected_job_id,
                    expected_generation,
                    "ocr lease request",
                )?;
                if !ready || ocr_lease_requested {
                    return Err(WorkerResponseReadError::Protocol(
                        "OCR lease request ordering invalid".into(),
                    ));
                }
                acquire_ocr_lease()?;
                ocr_lease_requested = true;
            }
            WorkerMessage::Completed {
                protocol_version,
                job_id,
                worker_generation,
                result,
            } => {
                validate_worker_identity(
                    protocol_version,
                    &job_id,
                    worker_generation,
                    expected_job_id,
                    expected_generation,
                    "terminal",
                )?;
                if !ready
                    || result.detected_format.trim().is_empty()
                    || (result.metrics.pages_ocr > 0) != ocr_lease_requested
                {
                    return Err(WorkerResponseReadError::Protocol(
                        "completed response shape invalid".into(),
                    ));
                }
                terminal = Some(WorkerTerminal {
                    success: true,
                    code: None,
                    warnings: result.warnings,
                    detected_format: Some(result.detected_format),
                    metrics: Some(result.metrics),
                });
                terminal_received();
            }
            WorkerMessage::Failed {
                protocol_version,
                job_id,
                worker_generation,
                error,
            } => {
                validate_worker_identity(
                    protocol_version,
                    &job_id,
                    worker_generation,
                    expected_job_id,
                    expected_generation,
                    "terminal",
                )?;
                if !ready || !is_worker_failure_code(&error.code) || error.message.trim().is_empty()
                {
                    return Err(WorkerResponseReadError::Protocol(
                        "failed response shape invalid".into(),
                    ));
                }
                terminal = Some(WorkerTerminal {
                    success: false,
                    code: Some(error.code),
                    warnings: Vec::new(),
                    detected_format: None,
                    metrics: None,
                });
                terminal_received();
            }
        }
    }
}

fn validate_worker_identity(
    protocol_version: u32,
    job_id: &str,
    worker_generation: u64,
    expected_job_id: &str,
    expected_generation: u64,
    kind: &str,
) -> Result<(), WorkerResponseReadError> {
    if protocol_version != PROTOCOL_VERSION {
        return Err(WorkerResponseReadError::Protocol(
            "protocol version mismatch".into(),
        ));
    }
    if job_id != expected_job_id || worker_generation != expected_generation {
        return Err(WorkerResponseReadError::Protocol(format!(
            "{kind} identity mismatch"
        )));
    }
    Ok(())
}

fn is_worker_stage(stage: &str) -> bool {
    matches!(
        stage,
        "inspecting" | "decrypting" | "extracting" | "rendering" | "ocr" | "writing" | "validating"
    )
}

fn is_worker_failure_code(code: &str) -> bool {
    matches!(
        code,
        "DOCUMENT_CANCELLED"
            | "DOCUMENT_ENCRYPTION_SCHEME_UNSUPPORTED"
            | "DOCUMENT_INPUT_READ_FAILED"
            | "DOCUMENT_MALFORMED"
            | "DOCUMENT_NO_USABLE_CONTENT"
            | "DOCUMENT_OCR_RUNTIME_UNAVAILABLE"
            | "DOCUMENT_PAGE_RENDER_FAILED"
            | "DOCUMENT_PASSWORD_INVALID"
            | "DOCUMENT_PASSWORD_REQUIRED"
            | "DOCUMENT_PDFIUM_LOAD_FAILED"
            | "DOCUMENT_PUBLISH_FAILED"
            | "DOCUMENT_RESOURCE_INVALID"
            | "DOCUMENT_RESOURCE_LIMIT"
            | "DOCUMENT_RESOURCE_MANIFEST_INVALID"
            | "DOCUMENT_RESOURCE_MISSING"
            | "DOCUMENT_RESOURCE_TARGET_MISMATCH"
            | "DOCUMENT_SOURCE_CHANGED"
            | "DOCUMENT_UNSUPPORTED_FORMAT"
            | "DOCUMENT_WORKER_PROTOCOL_ERROR"
    )
}

fn copy_source(
    source: &mut File,
    destination: &Path,
    expected_size: u64,
    expected_version: &SourceVersion,
    mut checkpoint: impl FnMut() -> Result<(), &'static str>,
) -> Result<String, String> {
    if source_version(
        &source
            .metadata()
            .map_err(|_| "DOCUMENT_INPUT_READ_FAILED")?,
    ) != *expected_version
    {
        return Err("DOCUMENT_SOURCE_CHANGED".into());
    }
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| "DOCUMENT_INPUT_READ_FAILED".to_string())?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| "DOCUMENT_PRIVATE_STORAGE_UNAVAILABLE".to_string())?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        checkpoint().map_err(str::to_string)?;
        let read = source
            .read(&mut buffer)
            .map_err(|_| "DOCUMENT_INPUT_READ_FAILED".to_string())?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > MAX_SOURCE_BYTES {
            return Err("DOCUMENT_RESOURCE_LIMIT".into());
        }
        output
            .write_all(&buffer[..read])
            .map_err(|_| "DOCUMENT_PRIVATE_STORAGE_UNAVAILABLE".to_string())?;
        digest.update(&buffer[..read]);
    }
    if total != expected_size {
        return Err("DOCUMENT_SOURCE_CHANGED".into());
    }
    if source_version(
        &source
            .metadata()
            .map_err(|_| "DOCUMENT_INPUT_READ_FAILED")?,
    ) != *expected_version
    {
        return Err("DOCUMENT_SOURCE_CHANGED".into());
    }
    output
        .sync_all()
        .map_err(|_| "DOCUMENT_PRIVATE_STORAGE_UNAVAILABLE".to_string())?;
    Ok(format!("{:x}", digest.finalize()))
}

fn source_version(metadata: &fs::Metadata) -> SourceVersion {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    #[cfg(windows)]
    use std::os::windows::fs::MetadataExt;

    SourceVersion {
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

fn unsafe_publish_path(
    stage: &'static str,
    error_kind: Option<std::io::ErrorKind>,
) -> &'static str {
    crate::ulog_warn!(
        "[document] publish path rejected stage={} error_kind={:?}",
        stage,
        error_kind,
    );
    "DOCUMENT_OUTPUT_PATH_UNSAFE"
}

fn publish(
    staging: &Path,
    destination: &Path,
    staging_identity: &same_file::Handle,
    staging_token: &str,
    output_root_identity: &same_file::Handle,
    deadline: std::time::Instant,
) -> Result<(), &'static str> {
    let root = destination
        .parent()
        .ok_or_else(|| unsafe_publish_path("destination_parent", None))?;
    reject_link_ancestors(root, false)
        .map_err(|_| unsafe_publish_path("output_ancestors", None))?;
    let current_identity = same_file::Handle::from_path(root)
        .map_err(|error| unsafe_publish_path("output_identity_open", Some(error.kind())))?;
    if &current_identity != output_root_identity {
        return Err(unsafe_publish_path("output_identity_changed", None));
    }
    validate_staging_identity(staging, staging_identity, staging_token)
        .map_err(|_| unsafe_publish_path("staging_identity", None))?;
    if std::time::Instant::now() >= deadline {
        return Err("DOCUMENT_TIMEOUT");
    }
    // Keep the owner marker inside the atomic rename. The destination is
    // re-opened and compared with the retained staging handle. The marker
    // remains until terminal job metadata is durably committed, so startup
    // can authenticate and roll back an incomplete product commit.
    if let Err(error) = rename_directory_noreplace(staging, destination) {
        crate::ulog_warn!(
            "[document] publish rename failed error_kind={:?}",
            error.kind()
        );
        return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
            "DOCUMENT_OUTPUT_COLLISION"
        } else {
            "DOCUMENT_PUBLISH_FAILED"
        });
    }
    if validate_staging_identity(destination, staging_identity, staging_token).is_err() {
        quarantine_rejected_path(destination, staging, staging_identity, staging_token);
        return Err(unsafe_publish_path("published_staging_identity", None));
    }
    if std::time::Instant::now() >= deadline {
        let _ = rollback_published_artifact_durable(
            destination,
            staging,
            staging_identity,
            staging_token,
        );
        return Err("DOCUMENT_TIMEOUT");
    }
    let published_identity = same_file::Handle::from_path(destination)
        .map_err(|error| unsafe_publish_path("published_identity_open", Some(error.kind())))?;
    if &published_identity != staging_identity {
        quarantine_rejected_path(destination, staging, staging_identity, staging_token);
        return Err(unsafe_publish_path("published_identity_changed", None));
    }
    if std::time::Instant::now() >= deadline {
        let _ = rollback_published_artifact_durable(
            destination,
            staging,
            staging_identity,
            staging_token,
        );
        return Err("DOCUMENT_TIMEOUT");
    }
    if sync_directory(root).is_err() {
        let _ = rollback_published_artifact_durable(
            destination,
            staging,
            staging_identity,
            staging_token,
        );
        return Err("DOCUMENT_PUBLISH_FAILED");
    }
    Ok(())
}

/// Restores a just-published directory to private staging and makes the
/// directory-entry rename durable. Callers must not clear the publish intent
/// based only on the kernel-visible rename result.
fn rollback_published_artifact_durable(
    destination: &Path,
    staging: &Path,
    expected: &same_file::Handle,
    token: &str,
) -> bool {
    rollback_published_artifact(destination, staging, expected, token)
        && destination
            .parent()
            .is_some_and(|output_root| sync_directory(output_root).is_ok())
}

fn rollback_published_artifact(
    destination: &Path,
    staging: &Path,
    expected: &same_file::Handle,
    token: &str,
) -> bool {
    let destination_is_expected =
        same_file::Handle::from_path(destination).is_ok_and(|actual| &actual == expected);
    if destination_is_expected {
        if fs::symlink_metadata(staging).is_ok() && !move_to_random_quarantine(staging) {
            quarantine_rejected_path(destination, staging, expected, token);
            return false;
        }
        if rename_directory_noreplace(destination, staging).is_err() {
            quarantine_rejected_path(destination, staging, expected, token);
            return false;
        }
        let marker = staging.join(STAGING_OWNER_MARKER);
        if !marker.exists() {
            let _ = write_marker_file(&marker, token);
        }
        if validate_staging_identity(staging, expected, token).is_ok() {
            return true;
        }
        quarantine_rejected_path(staging, destination, expected, token);
        return false;
    }
    quarantine_rejected_path(destination, staging, expected, token);
    crate::ulog_warn!("[document] published artifact rollback required quarantine");
    false
}

fn quarantine_rejected_path(
    path: &Path,
    preferred_restore_path: &Path,
    expected: &same_file::Handle,
    token: &str,
) {
    if same_file::Handle::from_path(path).is_ok_and(|actual| &actual == expected)
        && rename_directory_noreplace(path, preferred_restore_path).is_ok()
    {
        let marker = preferred_restore_path.join(STAGING_OWNER_MARKER);
        if !marker.exists() {
            let _ = write_marker_file(&marker, token);
        }
        return;
    }
    let _ = move_to_random_quarantine(path);
}

fn move_to_random_quarantine(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    for _ in 0..8 {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let quarantine = parent.join(format!(".myagents-anydoc-rejected-{}", &suffix[..12]));
        match rename_directory_noreplace(path, &quarantine) {
            Ok(()) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return false,
        }
    }
    false
}

fn reserve_job_identity(
    output_root: &Path,
    jobs: &HashMap<String, DocumentJob>,
) -> Result<(String, PathBuf, PathBuf), DocumentServiceError> {
    for _ in 0..64 {
        let random = uuid::Uuid::new_v4().simple().to_string();
        let id = format!(
            "{}_{}",
            Local::now().format("%Y%m%d"),
            &random[..JOB_ID_RANDOM_HEX]
        );
        if jobs.contains_key(&id) {
            continue;
        }
        let public = output_root.join(&id);
        if fs::symlink_metadata(&public).is_ok() {
            continue;
        }
        let staging = output_root.join(format!(".myagents-anydoc-{id}.staging"));
        match fs::create_dir(&staging) {
            Ok(()) => return Ok((id, staging, public)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
                    "DOCUMENT_OUTPUT_PERMISSION_DENIED"
                } else {
                    "DOCUMENT_OUTPUT_UNWRITABLE"
                };
                return Err(DocumentServiceError::new(
                    code,
                    "The output root cannot reserve a private staging directory.",
                    "Choose a writable output directory and retry.",
                ));
            }
        }
    }
    Err(DocumentServiceError::new(
        "DOCUMENT_JOB_ID_EXHAUSTED",
        "A unique document job directory could not be reserved.",
        "Retry the conversion; no output was overwritten.",
    ))
}

fn resolve_output_root(
    output: Option<&str>,
    workspace: Option<&str>,
) -> Result<PathBuf, DocumentServiceError> {
    let value = match output.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_string(),
        None => {
            let workspace = workspace
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    DocumentServiceError::new(
                        "DOCUMENT_WORKSPACE_REQUIRED",
                        "No current Workspace is available for the default output directory.",
                        "Pass an explicit --output directory and retry.",
                    )
                })?;
            Path::new(workspace)
                .join("myagents_files")
                .join("document-conversions")
                .to_string_lossy()
                .into_owned()
        }
    };
    let path = require_absolute_path(&value, "DOCUMENT_OUTPUT_PATH_INVALID")?;
    if looks_like_file_output(&path) {
        let parent = path.parent().unwrap_or(Path::new("."));
        return Err(DocumentServiceError::new(
            "DOCUMENT_OUTPUT_NOT_DIRECTORY",
            "--output must point to a directory, not a file.",
            "Choose an output root; the tool creates <job-id>/document.md inside it.",
        )
        .with_command(format!(
            "myagents anydoc convert --file <input> --output \"{}\"",
            parent.display()
        )));
    }
    Ok(path)
}

fn prepare_output_root(path: &Path) -> Result<PathBuf, DocumentServiceError> {
    reject_link_ancestors(path, true)?;
    fs::create_dir_all(path).map_err(|error| {
        let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
            "DOCUMENT_OUTPUT_PERMISSION_DENIED"
        } else {
            "DOCUMENT_OUTPUT_UNWRITABLE"
        };
        DocumentServiceError::new(
            code,
            "The output directory could not be created.",
            "Choose a writable output directory and retry.",
        )
    })?;
    // Re-check the entire realized path after create_dir_all. A missing
    // component observed above can be replaced with a link by another actor
    // before creation completes; the post-create walk closes that window.
    reject_link_ancestors(path, false)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        DocumentServiceError::new(
            "DOCUMENT_OUTPUT_UNWRITABLE",
            "The output directory cannot be inspected.",
            "Choose another output directory.",
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(DocumentServiceError::new(
            "DOCUMENT_OUTPUT_NOT_DIRECTORY",
            "--output must point to a regular directory.",
            "Choose another output directory.",
        ));
    }
    path.canonicalize().map_err(|_| {
        DocumentServiceError::new(
            "DOCUMENT_OUTPUT_UNWRITABLE",
            "The output directory could not be resolved after creation.",
            "Choose a stable local output directory and retry.",
        )
    })
}

fn ensure_free_space(
    path: &Path,
    required: u64,
    target: &'static str,
) -> Result<(), DocumentServiceError> {
    let available = crate::filesystem_capacity::available_space(path).map_err(|error| {
        crate::ulog_warn!(
            "[document] disk capacity unavailable target={} error_kind={:?} os_code={:?}",
            target,
            error.kind(),
            error.raw_os_error(),
        );
        DocumentServiceError::new(
            "DOCUMENT_DISK_SPACE_UNAVAILABLE",
            "Free disk space could not be determined for the document job.",
            "Choose a local output directory on a mounted volume and retry.",
        )
    })?;
    if available < required {
        return Err(DocumentServiceError::new(
            "DOCUMENT_INSUFFICIENT_DISK_SPACE",
            "There is not enough free disk space to convert this document safely.",
            "Free disk space or choose another output directory, then retry.",
        ));
    }
    Ok(())
}

fn reject_link_ancestors(path: &Path, allow_missing: bool) -> Result<(), DocumentServiceError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            // A Windows prefix such as `\\?\C:` is not a complete path until
            // RootDir is appended. Inspecting that prefix alone fails even
            // though the eventual canonical output directory is safe.
            Component::Prefix(_) => {
                current.push(component.as_os_str());
                continue;
            }
            Component::RootDir => current.push(component.as_os_str()),
            Component::Normal(part) => current.push(part),
            _ => {
                return Err(DocumentServiceError::new(
                    "DOCUMENT_PATH_UNSAFE",
                    "The path contains traversal components.",
                    "Use a direct absolute path without `..`.",
                ))
            }
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || metadata_is_reparse(&metadata) => {
                return Err(DocumentServiceError::new(
                    "DOCUMENT_PATH_LINK_REJECTED",
                    "Document paths cannot traverse symlinks or Windows reparse points.",
                    "Choose a direct local path and retry.",
                ));
            }
            Ok(_) => {}
            Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) if !allow_missing && error.kind() == std::io::ErrorKind::NotFound => {
                return Err(DocumentServiceError::new(
                    "DOCUMENT_PATH_NOT_FOUND",
                    "The requested path does not exist.",
                    "Check the path and retry.",
                ));
            }
            Err(_) => {
                return Err(DocumentServiceError::new(
                    "DOCUMENT_PATH_UNREADABLE",
                    "The requested path cannot be safely inspected.",
                    "Check path permissions and retry.",
                ))
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn metadata_is_reparse(_: &fs::Metadata) -> bool {
    false
}

fn require_absolute_path(value: &str, code: &str) -> Result<PathBuf, DocumentServiceError> {
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(DocumentServiceError::new(
            code,
            "Document paths must be lexical absolute paths.",
            "Resolve the path from the CLI working directory and retry.",
        ));
    }
    Ok(path)
}

fn looks_like_file_output(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "doc"
                    | "docx"
                    | "docm"
                    | "ppt"
                    | "pps"
                    | "pot"
                    | "pptx"
                    | "pptm"
                    | "ppsx"
                    | "ppsm"
                    | "xls"
                    | "xlsx"
                    | "xlsm"
                    | "xlsb"
                    | "odt"
                    | "ods"
                    | "odp"
                    | "rtf"
                    | "epub"
                    | "csv"
                    | "pdf"
                    | "png"
                    | "jpg"
                    | "jpeg"
                    | "webp"
            )
        })
}

fn supported_extension(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "doc" => Some("doc"),
        "docx" => Some("docx"),
        "docm" => Some("docm"),
        "ppt" => Some("ppt"),
        "pps" => Some("pps"),
        "pot" => Some("pot"),
        "pptx" => Some("pptx"),
        "pptm" => Some("pptm"),
        "ppsx" => Some("ppsx"),
        "ppsm" => Some("ppsm"),
        "xls" => Some("xls"),
        "xlsx" => Some("xlsx"),
        "xlsm" => Some("xlsm"),
        "xlsb" => Some("xlsb"),
        "odt" => Some("odt"),
        "ods" => Some("ods"),
        "odp" => Some("odp"),
        "rtf" => Some("rtf"),
        "epub" => Some("epub"),
        "csv" => Some("csv"),
        "pdf" => Some("pdf"),
        "png" => Some("png"),
        "jpg" => Some("jpeg"),
        "jpeg" => Some("jpeg"),
        "webp" => Some("webp"),
        _ => None,
    }
}

fn validate_job_id(value: &str) -> Result<(), DocumentServiceError> {
    let valid = value.len() == 21
        && value.as_bytes().get(8) == Some(&b'_')
        && value[..8].bytes().all(|byte| byte.is_ascii_digit())
        && value[9..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    if valid {
        Ok(())
    } else {
        Err(DocumentServiceError::new(
            "DOCUMENT_JOB_ID_INVALID",
            "The job ID must look like YYYYMMDD_<12 lowercase hex>.",
            "Copy the job ID from `myagents anydoc list` and retry.",
        )
        .with_command("myagents anydoc list"))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagerResourceManifest {
    schema_version: u32,
    pipeline_version: String,
    platform: String,
    architecture: String,
    worker: ManagerResourceFile,
    files: ManagerResourceFiles,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagerResourceFiles {
    onnx_runtime: ManagerResourceFile,
    pdfium: ManagerResourceFile,
    detector_model: ManagerResourceFile,
    recognizer_model: ManagerResourceFile,
    dictionary: ManagerResourceFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagerResourceFile {
    path: String,
    sha256: String,
    size: u64,
    license: String,
    upstream_revision: String,
    artifact_source: String,
    signing: ResourceSigning,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceSigning {
    kind: String,
    identity: String,
}

fn validate_resource_surface(
    worker: &Path,
    manifest: &Path,
    runtime_registry: &LocalInferenceRuntimeRegistry,
    verify_digests: bool,
    should_yield: &dyn Fn() -> bool,
) -> Result<LocalInferenceRuntimeIdentity, DocumentServiceError> {
    let manifest_metadata =
        fs::symlink_metadata(manifest).map_err(|_| resource_error("DOCUMENT_RESOURCE_MISSING"))?;
    if !manifest_metadata.is_file()
        || manifest_metadata.file_type().is_symlink()
        || manifest_metadata.len() == 0
        || manifest_metadata.len() > MAX_CONTROL_FRAME_BYTES as u64
    {
        return Err(resource_error("DOCUMENT_RESOURCE_INVALID"));
    }
    let bytes = fs::read(manifest).map_err(|_| resource_error("DOCUMENT_RESOURCE_INVALID"))?;
    let parsed: ManagerResourceManifest = serde_json::from_slice(&bytes)
        .map_err(|_| resource_error("DOCUMENT_RESOURCE_MANIFEST_INVALID"))?;
    let expected_platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err(resource_error("DOCUMENT_RUNTIME_UNSUPPORTED_PLATFORM"));
    };
    let expected_architecture = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        return Err(resource_error("DOCUMENT_RUNTIME_UNSUPPORTED_PLATFORM"));
    };
    if parsed.schema_version != 1
        || parsed.pipeline_version != PIPELINE_VERSION
        || parsed.platform != expected_platform
        || parsed.architecture != expected_architecture
        || parsed.worker.sha256.len() != 64
        || parsed.worker.size == 0
        || parsed.worker.license.trim().is_empty()
        || parsed.worker.upstream_revision.trim().is_empty()
        || parsed.worker.artifact_source.trim().is_empty()
        || parsed.worker.signing.kind.trim().is_empty()
        || parsed.worker.signing.identity.trim().is_empty()
    {
        return Err(resource_error("DOCUMENT_RESOURCE_TARGET_MISMATCH"));
    }
    let root = manifest
        .parent()
        .ok_or_else(|| resource_error("DOCUMENT_RESOURCE_MANIFEST_INVALID"))?;
    let expected_worker = resource_path(root, &parsed.worker)?;
    if expected_worker != worker {
        return Err(resource_error("DOCUMENT_RESOURCE_MANIFEST_INVALID"));
    }
    let _worker_metadata =
        verify_resource_file(root, &parsed.worker, verify_digests, should_yield)?;
    for file in [
        &parsed.files.pdfium,
        &parsed.files.detector_model,
        &parsed.files.recognizer_model,
        &parsed.files.dictionary,
    ] {
        verify_resource_file(root, file, verify_digests, should_yield)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if _worker_metadata.permissions().mode() & 0o111 == 0 {
            return Err(resource_error("DOCUMENT_RESOURCE_INVALID"));
        }
    }
    runtime_registry
        .verify_manifest_reference(
            InferenceRuntimeKind::OnnxCpu,
            root,
            &parsed.files.onnx_runtime.path,
            &parsed.files.onnx_runtime.sha256,
            parsed.files.onnx_runtime.size,
            &parsed.files.onnx_runtime.upstream_revision,
        )
        .map_err(|error| {
            crate::ulog_warn!(
                "[document] shared runtime identity rejected code={}",
                error.code()
            );
            resource_error(if error.code() == "LOCAL_RUNTIME_TARGET_MISMATCH" {
                "DOCUMENT_RESOURCE_TARGET_MISMATCH"
            } else {
                "DOCUMENT_RESOURCE_INVALID"
            })
        })
}

fn resource_path(
    root: &Path,
    resource: &ManagerResourceFile,
) -> Result<PathBuf, DocumentServiceError> {
    let relative = Path::new(&resource.path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(resource_error("DOCUMENT_RESOURCE_MANIFEST_INVALID"));
    }
    Ok(root.join(relative))
}

fn verify_resource_file(
    root: &Path,
    resource: &ManagerResourceFile,
    verify_digest: bool,
    should_yield: &dyn Fn() -> bool,
) -> Result<fs::Metadata, DocumentServiceError> {
    if resource.sha256.len() != 64
        || resource.size == 0
        || resource.license.trim().is_empty()
        || resource.upstream_revision.trim().is_empty()
        || resource.artifact_source.trim().is_empty()
        || resource.signing.kind.trim().is_empty()
        || resource.signing.identity.trim().is_empty()
    {
        return Err(resource_error("DOCUMENT_RESOURCE_MANIFEST_INVALID"));
    }
    let path = resource_path(root, resource)?;
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| resource_error("DOCUMENT_RESOURCE_MISSING"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != resource.size {
        return Err(resource_error("DOCUMENT_RESOURCE_INVALID"));
    }
    if verify_digest {
        let digest = sha256_file_interruptible(&path, should_yield)
            .map_err(|_| resource_error("DOCUMENT_RESOURCE_INVALID"))?
            .ok_or_else(|| resource_error("DOCUMENT_RESOURCE_VALIDATION_YIELDED"))?;
        if digest != resource.sha256.to_ascii_lowercase() {
            return Err(resource_error("DOCUMENT_RESOURCE_INVALID"));
        }
    }
    Ok(metadata)
}

fn sha256_file_interruptible(
    path: &Path,
    should_yield: &dyn Fn() -> bool,
) -> std::io::Result<Option<String>> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        if should_yield() {
            return Ok(None);
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(Some(format!("{:x}", digest.finalize())))
}

fn resource_error(code: &str) -> DocumentServiceError {
    DocumentServiceError::new(
        code,
        "Bundled document-processing resources are missing, corrupt, or incompatible with this build.",
        "Reinstall this MyAgents build and retry.",
    )
}

fn default_pipeline(onnx_runtime_version: &str) -> DocumentPipeline {
    DocumentPipeline {
        version: PIPELINE_VERSION.into(),
        anydoc_version: Some("0.1.9+myagents-assets.1".into()),
        pdf_inspector_version: Some("1.14.2".into()),
        ocr_model_id: Some(
            "PaddlePaddle/PP-OCRv6_small_det_onnx + PP-OCRv6_small_rec_onnx".into(),
        ),
        ocr_model_revision: Some(
            "det@28fe5895c24fd108c19eb3e8479f4ab385fbfc62;rec@b8f84f0b80c529de40b4fbb3544b84fa7233a513"
                .into(),
        ),
        onnx_runtime_version: Some(onnx_runtime_version.into()),
        pdfium_revision: Some("chromium/7999".into()),
    }
}

fn persist_job(root: &Path, job: &DocumentJob) -> Result<(), String> {
    let path = root.join("jobs").join(&job.job_id).join("job.json");
    let content =
        serde_json::to_string_pretty(job).map_err(|error| format!("serialize job: {error}"))?;
    crate::task::write_atomic_text(&path, &content)?;
    sync_directory(path.parent().ok_or("job metadata parent missing")?)
        .map_err(|error| format!("sync job metadata directory: {error}"))
}

fn persist_job_resolving_unknown(root: &Path, job: &DocumentJob) -> Result<(), String> {
    match persist_job(root, job) {
        Ok(()) => Ok(()),
        Err(original) => {
            let path = root.join("jobs").join(&job.job_id).join("job.json");
            let expected = serde_json::to_value(job)
                .map_err(|error| format!("serialize expected terminal job: {error}"))?;
            let persisted_matches = fs::read_to_string(&path)
                .ok()
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
                .is_some_and(|actual| actual == expected);
            if persisted_matches
                && path
                    .parent()
                    .is_some_and(|parent| sync_directory(parent).is_ok())
            {
                Ok(())
            } else {
                Err(original)
            }
        }
    }
}

fn publish_intent_path(root: &Path, job_id: &str) -> PathBuf {
    root.join("jobs").join(job_id).join(PUBLISH_INTENT_FILE)
}

fn persist_publish_intent(root: &Path, intent: &PublishIntent) -> Result<(), String> {
    let content = serde_json::to_string_pretty(intent)
        .map_err(|error| format!("serialize publish intent: {error}"))?;
    let path = publish_intent_path(root, &intent.job_id);
    crate::task::write_atomic_text(&path, &content)?;
    sync_directory(path.parent().ok_or("publish intent parent missing")?)
        .map_err(|error| format!("sync publish intent directory: {error}"))
}

fn clear_publish_intent(root: &Path, job_id: &str) -> Result<(), String> {
    let path = publish_intent_path(root, job_id);
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("remove publish intent: {error}")),
    }
    if let Some(parent) = path.parent() {
        sync_directory(parent)
            .map_err(|error| format!("sync publish intent directory: {error}"))?;
    }
    Ok(())
}

fn recover_publish_intents(root: &Path, jobs: &mut HashMap<String, DocumentJob>) {
    let ids = jobs.keys().cloned().collect::<Vec<_>>();
    for job_id in ids {
        let intent_path = publish_intent_path(root, &job_id);
        if !intent_path.is_file() {
            continue;
        }
        let Some(job) = jobs.get_mut(&job_id) else {
            continue;
        };
        let private_token =
            fs::read_to_string(root.join("jobs").join(&job_id).join(PRIVATE_STAGING_TOKEN))
                .ok()
                .map(|token| token.trim().to_string())
                .filter(|token| valid_staging_token(token));
        let parsed = fs::read_to_string(&intent_path)
            .ok()
            .and_then(|content| serde_json::from_str::<PublishIntent>(&content).ok());
        let staging = Path::new(&job.output.root_directory)
            .join(format!(".myagents-anydoc-{job_id}.staging"));
        let destination = PathBuf::from(&job.output.job_directory);
        let token = parsed
            .filter(|intent| {
                intent.schema_version == 1
                    && intent.job_id == job_id
                    && Path::new(&intent.staging_directory) == staging
                    && Path::new(&intent.destination_directory) == destination
                    && valid_staging_token(&intent.staging_token)
                    && private_token.as_deref() == Some(intent.staging_token.as_str())
            })
            .map(|intent| intent.staging_token)
            .or(private_token);
        let Some(token) = token else {
            crate::ulog_warn!(
                "[document] publish intent could not be authenticated jobId={}",
                job_id
            );
            continue;
        };

        if matches!(
            job.state,
            DocumentJobState::Succeeded | DocumentJobState::SucceededWithWarnings
        ) {
            if destination.exists() {
                let marker = destination.join(STAGING_OWNER_MARKER);
                let cleanup_durable = match fs::read_to_string(&marker) {
                    Ok(actual) if actual == token => fs::remove_file(&marker)
                        .and_then(|_| sync_directory(&destination))
                        .is_ok(),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        sync_directory(&destination).is_ok()
                    }
                    // Durable success is irreversible. A changed artifact is
                    // user-owned lifecycle, so never move it or rewrite job
                    // history merely to clean stale recovery metadata.
                    _ => true,
                };
                if cleanup_durable {
                    cleanup_owned_staging(&staging, None, &token);
                    let staging_cleanup_durable =
                        !fs::read_to_string(staging.join(STAGING_OWNER_MARKER))
                            .is_ok_and(|actual| actual == token)
                            && destination
                                .parent()
                                .is_some_and(|parent| sync_directory(parent).is_ok());
                    if staging_cleanup_durable {
                        let _ = clear_publish_intent(root, &job_id);
                    }
                }
                continue;
            }

            // persist_job may have reported a directory-sync error after its
            // success rename. If rollback restored authenticated staging, the
            // durable success authority wins and recovery completes publish.
            if let Ok(staging_identity) = same_file::Handle::from_path(&staging) {
                if validate_staging_identity(&staging, &staging_identity, &token).is_ok() {
                    if let Some(output_root) = destination.parent() {
                        if let Ok(output_identity) = same_file::Handle::from_path(output_root) {
                            let recovered = publish(
                                &staging,
                                &destination,
                                &staging_identity,
                                &token,
                                &output_identity,
                                std::time::Instant::now() + std::time::Duration::from_secs(60),
                            )
                            .is_ok();
                            if recovered {
                                let marker = destination.join(STAGING_OWNER_MARKER);
                                if fs::remove_file(&marker)
                                    .and_then(|_| sync_directory(&destination))
                                    .is_ok()
                                {
                                    let _ = clear_publish_intent(root, &job_id);
                                }
                            }
                            // Authenticated staging is a live recovery duty.
                            // Keep the intent on any failure and retry later.
                            continue;
                        }
                    }
                }
            }
            // The user may have deleted the artifact after success. History
            // remains terminal; artifactAvailable is derived at query time.
            let _ = clear_publish_intent(root, &job_id);
            continue;
        }

        // The terminal metadata never committed. An authenticated public
        // directory is still only staging and must be removed before ordinary
        // nonterminal recovery marks the job interrupted.
        let marker_matches = fs::read_to_string(destination.join(STAGING_OWNER_MARKER))
            .is_ok_and(|actual| actual == token);
        if marker_matches {
            cleanup_owned_staging(&destination, None, &token);
        }
        cleanup_owned_staging(&staging, None, &token);
        let owned_destination_remains = fs::read_to_string(destination.join(STAGING_OWNER_MARKER))
            .is_ok_and(|actual| actual == token);
        let owned_staging_remains = fs::read_to_string(staging.join(STAGING_OWNER_MARKER))
            .is_ok_and(|actual| actual == token);
        let output_mutations_durable = destination
            .parent()
            .is_some_and(|parent| sync_directory(parent).is_ok());
        if !owned_destination_remains && !owned_staging_remains && output_mutations_durable {
            let _ = clear_publish_intent(root, &job_id);
        }
    }
}

fn load_jobs(root: &Path) -> Result<HashMap<String, DocumentJob>, String> {
    let mut jobs = HashMap::new();
    for entry in fs::read_dir(root.join("jobs"))
        .map_err(|error| format!("read document jobs: {error}"))?
        .take(10_000)
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let job_path = path.join("job.json");
        let Ok(metadata) = fs::symlink_metadata(&job_path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_CONTROL_FRAME_BYTES as u64 {
            continue;
        }
        let Ok(content) = fs::read_to_string(&job_path) else {
            continue;
        };
        let Ok(job) = serde_json::from_str::<DocumentJob>(&content) else {
            continue;
        };
        if entry.file_name().to_string_lossy() == job.job_id && validate_job_id(&job.job_id).is_ok()
        {
            jobs.insert(job.job_id.clone(), job);
        }
    }
    Ok(jobs)
}

fn recover_nonterminal_jobs(root: &Path, jobs: &mut HashMap<String, DocumentJob>) {
    for job in jobs.values_mut().filter(|job| !job.state.is_terminal()) {
        let now = Utc::now();
        job.state = DocumentJobState::Interrupted;
        job.stage = "finalizing".into();
        job.updated_at = now;
        job.finished_at = Some(now);
        job.error = Some(interrupted_error(&job.job_id));
        let _ = persist_job(root, job);
        log_document_job("recovered_terminal", job);
    }
}

fn prune_expired_jobs(root: &Path, jobs: &mut HashMap<String, DocumentJob>) {
    let cutoff = Utc::now() - Duration::days(DOCUMENT_HISTORY_RETENTION_DAYS);
    let expired = jobs
        .iter()
        .filter_map(|(id, job)| {
            let terminal_at = job.finished_at.unwrap_or(job.updated_at);
            (job.state.is_terminal() && terminal_at < cutoff).then_some(id.clone())
        })
        .collect::<Vec<_>>();
    for id in expired {
        jobs.remove(&id);
        let _ = fs::remove_dir_all(root.join("jobs").join(id));
    }
}

fn cleanup_stale_job_paths(root: &Path, job: &DocumentJob) {
    let private_dir = root.join("jobs").join(&job.job_id);
    let token = fs::read_to_string(private_dir.join(PRIVATE_STAGING_TOKEN)).ok();
    let _ = fs::remove_dir_all(private_dir.join("input"));
    let staging = Path::new(&job.output.root_directory)
        .join(format!(".myagents-anydoc-{}.staging", job.job_id));
    if let Some(token) = token.filter(|token| valid_staging_token(token.trim())) {
        cleanup_owned_staging(&staging, None, token.trim());
    }
}

fn cleanup_pending(pending: &PendingJob) {
    cleanup_owned_staging(
        &pending.staging_dir,
        Some(&pending.staging_identity),
        &pending.staging_token,
    );
    cleanup_private_input(&pending.private_dir);
}

fn prepare_pending_for_retry(pending: &mut PendingJob) -> Result<(), String> {
    validate_staging_identity(
        &pending.staging_dir,
        &pending.staging_identity,
        &pending.staging_token,
    )?;
    cleanup_owned_staging(
        &pending.staging_dir,
        Some(&pending.staging_identity),
        &pending.staging_token,
    );
    if pending.staging_dir.exists() {
        return Err("staging retry cleanup failed".into());
    }
    fs::create_dir(&pending.staging_dir)
        .map_err(|_| "staging retry reservation failed".to_string())?;
    set_private_permissions(&pending.staging_dir)
        .map_err(|_| "staging retry reservation failed".to_string())?;
    write_marker_file(
        &pending.staging_dir.join(STAGING_OWNER_MARKER),
        &pending.staging_token,
    )
    .map_err(|_| "staging retry reservation failed".to_string())?;
    pending.staging_identity = same_file::Handle::from_path(&pending.staging_dir)
        .map_err(|_| "staging retry identity unavailable".to_string())?;
    if let Some(parent) = pending.staging_dir.parent() {
        sync_directory(parent)
            .map_err(|_| "staging retry reservation was not durable".to_string())?;
    }
    cleanup_private_input(&pending.private_dir);
    let input = pending.private_dir.join("input");
    fs::create_dir(&input).map_err(|_| "private retry input unavailable".to_string())?;
    set_private_permissions(&input).map_err(|_| "private retry input unavailable".to_string())
}

fn cleanup_private_input(private_dir: &Path) {
    let _ = fs::remove_dir_all(private_dir.join("input"));
}

fn write_staging_ownership(
    private_dir: &Path,
    staging_dir: &Path,
    token: &str,
) -> std::io::Result<()> {
    if !valid_staging_token(token) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid staging token",
        ));
    }
    write_marker_file(&private_dir.join(PRIVATE_STAGING_TOKEN), token)?;
    write_marker_file(&staging_dir.join(STAGING_OWNER_MARKER), token)
}

fn write_marker_file(path: &Path, token: &str) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(token.as_bytes())?;
    file.sync_all()
}

fn valid_staging_token(token: &str) -> bool {
    token.len() == 32
        && token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_staging_identity(
    path: &Path,
    expected: &same_file::Handle,
    token: &str,
) -> Result<(), String> {
    let actual = same_file::Handle::from_path(path)
        .map_err(|_| "staging identity unavailable".to_string())?;
    if &actual != expected {
        return Err("staging identity changed".into());
    }
    let marker = fs::read_to_string(path.join(STAGING_OWNER_MARKER))
        .map_err(|_| "staging owner marker missing".to_string())?;
    if marker != token {
        return Err("staging owner marker changed".into());
    }
    Ok(())
}

fn cleanup_owned_staging(path: &Path, retained_identity: Option<&same_file::Handle>, token: &str) {
    let initial_identity = match same_file::Handle::from_path(path) {
        Ok(identity) => identity,
        Err(_) => return,
    };
    if retained_identity.is_some_and(|expected| expected != &initial_identity)
        || validate_staging_identity(path, &initial_identity, token).is_err()
    {
        crate::ulog_warn!("[document] skipped staging cleanup because its owner identity changed");
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    for _ in 0..8 {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let quarantine = parent.join(format!(".myagents-anydoc-cleanup-{}", &suffix[..12]));
        match rename_directory_noreplace(path, &quarantine) {
            Ok(()) => {
                // Re-open after the atomic move. If another process replaced
                // the path between validation and rename, its directory is
                // moved aside but never deleted; only the retained inode can
                // pass this check.
                if validate_staging_identity(&quarantine, &initial_identity, token).is_err() {
                    let _ = rename_directory_noreplace(&quarantine, path);
                    crate::ulog_warn!(
                        "[document] skipped staging cleanup after post-move identity mismatch"
                    );
                    return;
                }
                if let Err(error) = fs::remove_dir_all(&quarantine) {
                    crate::ulog_warn!(
                        "[document] app-owned staging cleanup failed error_kind={:?}",
                        error.kind()
                    );
                }
                return;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                crate::ulog_warn!(
                    "[document] app-owned staging quarantine failed error_kind={:?}",
                    error.kind()
                );
                return;
            }
        }
    }
}

fn artifact_is_available(job: &DocumentJob) -> bool {
    if !matches!(
        job.state,
        DocumentJobState::Succeeded | DocumentJobState::SucceededWithWarnings
    ) {
        return false;
    }
    fs::symlink_metadata(&job.output.document_path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

fn set_private_permissions(_path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn read_frame(reader: &mut impl Read) -> Result<Option<Vec<u8>>, String> {
    let mut prefix = [0_u8; 4];
    loop {
        match reader.read(&mut prefix[..1]) {
            Ok(0) => return Ok(None),
            Ok(1) => break,
            Ok(_) => unreachable!("one-byte read returned more than one byte"),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("control frame prefix read failed".into()),
        }
    }
    reader
        .read_exact(&mut prefix[1..])
        .map_err(|_| "control frame prefix truncated".to_string())?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > MAX_CONTROL_FRAME_BYTES {
        return Err("control frame length invalid".into());
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|_| "control frame payload read failed".to_string())?;
    Ok(Some(payload))
}

fn write_frame(writer: &mut impl Write, value: &impl Serialize) -> Result<(), String> {
    use zeroize::Zeroize;

    let mut payload =
        serde_json::to_vec(value).map_err(|_| "control frame serialization failed".to_string())?;
    if payload.is_empty() || payload.len() > MAX_CONTROL_FRAME_BYTES {
        payload.zeroize();
        return Err("control frame length invalid".into());
    }
    let result = writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .and_then(|_| writer.write_all(&payload))
        .and_then(|_| writer.flush())
        .map_err(|_| "control frame write failed".to_string());
    payload.zeroize();
    result
}

fn send_cancel(
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    job_id: &str,
    generation: u64,
) -> Result<(), String> {
    let value = serde_json::json!({ "type": "cancel", "protocolVersion": PROTOCOL_VERSION, "jobId": job_id, "workerGeneration": generation });
    let mut stdin = stdin
        .lock()
        .map_err(|_| "Worker stdin lock failed".to_string())?;
    write_frame(&mut *stdin, &value)
}

fn send_ocr_lease_grant(
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    job_id: &str,
    generation: u64,
) -> Result<(), String> {
    let value = serde_json::json!({
        "type": "grant_ocr_lease",
        "protocolVersion": PROTOCOL_VERSION,
        "jobId": job_id,
        "workerGeneration": generation,
    });
    let mut stdin = stdin
        .lock()
        .map_err(|_| "Worker stdin lock failed".to_string())?;
    write_frame(&mut *stdin, &value)
}

#[allow(clippy::too_many_arguments)]
fn arm_document_ocr_yield(
    signal: LocalComputeYieldSignal,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
    child: Arc<Mutex<process_cmd::ChildTree>>,
    job_id: String,
    generation: u64,
    settled: Arc<AtomicBool>,
    requeue_for_live: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            if settled.load(Ordering::Acquire) {
                return;
            }
            if signal.should_yield() {
                requeue_for_live.store(true, Ordering::Release);
                let _ = send_cancel(&stdin, &job_id, generation);
                tokio::time::sleep(std::time::Duration::from_secs(OCR_YIELD_GRACE_SECONDS)).await;
                if !settled.load(Ordering::Acquire) {
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        if let Ok(mut child) = child.lock() {
                            let _ = child.kill_and_wait();
                        }
                    })
                    .await;
                }
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });
}

fn arm_worker_settlement_deadline(
    child: Arc<Mutex<process_cmd::ChildTree>>,
    settled: Arc<AtomicBool>,
    grace: StdDuration,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(grace).await;
        if settled.load(Ordering::Acquire) {
            return;
        }
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill_and_wait();
            }
        })
        .await;
    });
}

fn job_not_found(job_id: &str) -> DocumentServiceError {
    DocumentServiceError::new(
        "DOCUMENT_JOB_NOT_FOUND",
        format!("Document job {job_id} was not found."),
        "List recent jobs and copy the exact ID.",
    )
    .with_command("myagents anydoc list")
}
fn manager_unavailable() -> DocumentServiceError {
    DocumentServiceError::new(
        "DOCUMENT_MANAGER_UNAVAILABLE",
        "The document manager is unavailable.",
        "Restart MyAgents and retry.",
    )
}
fn store_error(_message: String) -> DocumentServiceError {
    DocumentServiceError::new(
        "DOCUMENT_JOB_STORE_WRITE_FAILED",
        "The document job metadata could not be saved.",
        "Check free disk space and retry.",
    )
}

fn cancelled_error() -> DocumentJobError {
    DocumentJobError {
        code: "DOCUMENT_CANCELLED".into(),
        message: "The conversion was cancelled.".into(),
        retryable: true,
        recovery_hint: Some(RecoveryHint {
            message: "Submit the source again to create a new job.".into(),
            recovery_command: Some("myagents anydoc convert --file <input>".into()),
        }),
    }
}
fn interrupted_error(job_id: &str) -> DocumentJobError {
    DocumentJobError {
        code: "DOCUMENT_INTERRUPTED".into(),
        message: format!("Job {job_id} was interrupted by App shutdown or restart."),
        retryable: true,
        recovery_hint: Some(RecoveryHint {
            message: "Submit the conversion again; interrupted jobs are not resumed.".into(),
            recovery_command: Some("myagents anydoc convert --file <input>".into()),
        }),
    }
}
fn worker_error(job_id: &str, code: &str, retryable: bool) -> DocumentJobError {
    let (message, recovery_message, command) = match code {
        "DOCUMENT_PASSWORD_REQUIRED" => (
            "This document is encrypted and requires --password.",
            "Submit a new job with the document password.",
            Some("myagents anydoc convert --file <input> --password <password>"),
        ),
        "DOCUMENT_PASSWORD_INVALID" => (
            "The supplied document password is incorrect.",
            "Check the password and submit a new job.",
            Some("myagents anydoc convert --file <input> --password <password>"),
        ),
        "DOCUMENT_ENCRYPTION_SCHEME_UNSUPPORTED" => (
            "This document encryption scheme is not supported.",
            "Open and save an unencrypted copy in the source application, then retry.",
            None,
        ),
        "DOCUMENT_UNSUPPORTED_FORMAT" => (
            "This file format is not supported by the local document converter.",
            "Inspect the supported formats and choose one local file.",
            Some("myagents anydoc convert --help"),
        ),
        "DOCUMENT_RESOURCE_LIMIT" => (
            "The document exceeds a fixed processing safety limit.",
            "Choose a smaller document or split it before retrying.",
            Some("myagents anydoc convert --help"),
        ),
        "DOCUMENT_SOURCE_CHANGED" | "DOCUMENT_INPUT_READ_FAILED" => (
            "The source changed or became unreadable while the job was being admitted.",
            "Wait for the source application to finish saving, then submit a new job.",
            Some("myagents anydoc convert --file <input>"),
        ),
        "DOCUMENT_NO_USABLE_CONTENT" | "DOCUMENT_OCR_NO_TEXT" => (
            "No usable text could be recovered from this document.",
            "Check that the file is readable and contains supported text or document images.",
            None,
        ),
        "DOCUMENT_MALFORMED" => (
            "The document is damaged or could not be parsed safely.",
            "Open the source in its native application, resave it, and retry.",
            Some("myagents anydoc convert --file <input>"),
        ),
        "DOCUMENT_RESOURCE_MISSING"
        | "DOCUMENT_RESOURCE_INVALID"
        | "DOCUMENT_RESOURCE_MANIFEST_INVALID"
        | "DOCUMENT_RESOURCE_TARGET_MISMATCH"
        | "DOCUMENT_OCR_RUNTIME_UNAVAILABLE"
        | "DOCUMENT_PDFIUM_LOAD_FAILED" => (
            "A bundled document-processing resource is missing, corrupt, or could not be loaded.",
            "Reinstall this MyAgents build and retry.",
            None,
        ),
        "DOCUMENT_TIMEOUT" => (
            "The conversion exceeded the 30 minute job deadline.",
            "Split the document into a smaller input and submit a new job.",
            Some("myagents anydoc convert --file <input>"),
        ),
        "DOCUMENT_WORKER_CRASHED"
        | "DOCUMENT_WORKER_START_FAILED"
        | "DOCUMENT_WORKER_PROTOCOL_ERROR" => (
            "The isolated document Worker exited or failed its private protocol.",
            "Restart MyAgents if the error repeats, then submit a new job.",
            Some("myagents anydoc convert --file <input>"),
        ),
        "DOCUMENT_PUBLISH_FAILED" | "DOCUMENT_STAGING_WRITE_FAILED" => (
            "The converted artifact could not be published safely.",
            "Check output permissions and free disk space, then submit a new job.",
            Some("myagents anydoc convert --file <input>"),
        ),
        "DOCUMENT_OUTPUT_COLLISION" => (
            "The reserved output job directory was created by another process before publish.",
            "Submit the conversion again to reserve a new unique job directory.",
            Some("myagents anydoc convert --file <input>"),
        ),
        "DOCUMENT_OUTPUT_PATH_UNSAFE" | "DOCUMENT_OUTPUT_PERMISSION_DENIED" => (
            "The output directory changed or is no longer writable.",
            "Choose a stable writable output directory and submit a new job.",
            Some("myagents anydoc convert --file <input> --output <directory>"),
        ),
        _ => (
            "The document could not be converted safely.",
            "Inspect this terminal job, then submit a new job after correcting the source.",
            Some("myagents anydoc status <job-id>"),
        ),
    };
    DocumentJobError {
        code: code.into(),
        message: message.into(),
        retryable,
        recovery_hint: Some(RecoveryHint {
            message: recovery_message.into(),
            recovery_command: command.map(|command| command.replace("<job-id>", job_id)),
        }),
    }
}

fn worker_code_retryable(code: &str) -> bool {
    matches!(
        code,
        "DOCUMENT_PASSWORD_REQUIRED"
            | "DOCUMENT_PASSWORD_INVALID"
            | "DOCUMENT_SOURCE_CHANGED"
            | "DOCUMENT_INPUT_READ_FAILED"
            | "DOCUMENT_RESOURCE_MISSING"
            | "DOCUMENT_RESOURCE_INVALID"
            | "DOCUMENT_RESOURCE_MANIFEST_INVALID"
            | "DOCUMENT_RESOURCE_TARGET_MISMATCH"
            | "DOCUMENT_OCR_RUNTIME_UNAVAILABLE"
            | "DOCUMENT_PDFIUM_LOAD_FAILED"
            | "DOCUMENT_TIMEOUT"
            | "DOCUMENT_WORKER_CRASHED"
            | "DOCUMENT_WORKER_START_FAILED"
            | "DOCUMENT_WORKER_PROTOCOL_ERROR"
            | "DOCUMENT_PUBLISH_FAILED"
            | "DOCUMENT_STAGING_WRITE_FAILED"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn document_log_tokens_reject_paths_and_multiline_payloads() {
        assert_eq!(
            document_log_token(Some("succeeded_with_warnings")),
            "succeeded_with_warnings"
        );
        assert_eq!(
            document_log_token(Some("/Users/private/document.pdf")),
            "unknown"
        );
        assert_eq!(document_log_token(Some("secret\nbody")), "unknown");
        assert_eq!(document_log_token(Some(&"x".repeat(65))), "unknown");
    }

    fn test_job(job_id: &str, output_root: &Path, state: DocumentJobState) -> DocumentJob {
        let now = Utc::now();
        DocumentJob {
            job_id: job_id.into(),
            state,
            stage: "running".into(),
            source: DocumentSource {
                path: output_root
                    .join("source.pdf")
                    .to_string_lossy()
                    .into_owned(),
                display_name: "source.pdf".into(),
                format: Some("pdf".into()),
                size_bytes: 4,
                sha256: None,
            },
            output: DocumentOutput {
                root_directory: output_root.to_string_lossy().into_owned(),
                job_directory: output_root.join(job_id).to_string_lossy().into_owned(),
                document_path: output_root
                    .join(job_id)
                    .join("document.md")
                    .to_string_lossy()
                    .into_owned(),
                assets_directory: None,
                artifact_available: false,
            },
            created_at: now,
            updated_at: now,
            started_at: Some(now),
            finished_at: None,
            warnings: Vec::new(),
            error: None,
            metrics: None,
            pipeline: default_pipeline("1.28.0"),
        }
    }

    fn test_manager(root: &Path, job: DocumentJob, generation: u64) -> ManagedDocumentProcessing {
        fs::create_dir_all(root.join("jobs").join(&job.job_id)).unwrap();
        persist_job(root, &job).unwrap();
        let job_id = job.job_id.clone();
        Arc::new(DocumentProcessingManager {
            root: root.to_path_buf(),
            worker_path: root.join("unused-worker"),
            manifest_path: root.join("unused-manifest"),
            onnx_runtime_path: root.join("unused-onnx-runtime"),
            onnx_runtime_version: "1.28.0".into(),
            runtime_registry: LocalInferenceRuntimeRegistry::initialize(root),
            compute_coordinator: LocalComputeCoordinator::new(),
            state: Mutex::new(ManagerState {
                accepting: true,
                jobs: HashMap::from([(job_id.clone(), job)]),
                queue: VecDeque::new(),
                pending: HashMap::new(),
                active_job: Some((job_id, generation)),
                running: None,
                next_generation: generation + 1,
                resource_error: None,
            }),
            wake: Notify::new(),
        })
    }

    #[test]
    fn updater_observes_queued_and_active_document_owner_until_settlement() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let manager = test_manager(
            data.path(),
            test_job(job_id, output.path(), DocumentJobState::Running),
            3,
        );
        assert!(manager.has_pending_work().unwrap());
        {
            let mut state = manager.state.lock().unwrap();
            state.active_job = None;
            state.queue.push_back(job_id.into());
        }
        assert!(manager.has_pending_work().unwrap());
        manager.state.lock().unwrap().queue.clear();
        assert!(!manager.has_pending_work().unwrap());
    }

    #[test]
    fn updater_does_not_treat_poisoned_document_owner_as_idle() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let manager = test_manager(
            data.path(),
            test_job(
                "20260815_7f3a91c2b6d4",
                output.path(),
                DocumentJobState::Running,
            ),
            3,
        );
        let poisoned = Arc::clone(&manager);
        let _ = std::thread::spawn(move || {
            let _state = poisoned.state.lock().unwrap();
            panic!("controlled document owner poison");
        })
        .join();
        assert_eq!(
            manager.has_pending_work().unwrap_err(),
            "UPDATE_ACTIVITY_UNKNOWN"
        );
    }

    #[test]
    fn repeated_progress_stage_still_refreshes_public_updated_at() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let generation = 3;
        let mut job = test_job(job_id, output.path(), DocumentJobState::Running);
        job.stage = "ocr".into();
        job.updated_at = Utc::now() - chrono::Duration::seconds(1);
        let previous_updated_at = job.updated_at;
        let manager = test_manager(data.path(), job, generation);

        manager.handle_progress(
            job_id,
            generation,
            WorkerProgress {
                job_id: job_id.into(),
                generation,
                stage: "ocr".into(),
            },
        );

        let current = manager.get(job_id).unwrap();
        assert_eq!(current.stage, "ocr");
        assert!(current.updated_at > previous_updated_at);
    }

    #[test]
    fn resource_digest_validation_can_yield_between_chunks() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("resource.bin");
        fs::write(&path, vec![7_u8; 256 * 1024]).unwrap();

        assert!(sha256_file_interruptible(&path, &|| true)
            .unwrap()
            .is_none());
        let digest = sha256_file_interruptible(&path, &|| false)
            .unwrap()
            .unwrap();
        assert_eq!(
            digest,
            format!("{:x}", Sha256::digest(vec![7_u8; 256 * 1024]))
        );
    }

    #[test]
    fn job_ids_have_date_and_lower_hex_shape() {
        let root = tempfile::tempdir().unwrap();
        let (id, staging, public) = reserve_job_identity(root.path(), &HashMap::new()).unwrap();
        assert!(validate_job_id(&id).is_ok());
        assert!(staging.is_dir());
        assert!(!public.exists());
    }

    #[test]
    fn output_file_hint_is_rejected_as_directory() {
        assert!(looks_like_file_output(Path::new("/tmp/report.md")));
        assert!(!looks_like_file_output(Path::new("/tmp/reports")));
    }

    #[test]
    fn secret_debug_never_contains_value() {
        let secret = SecretString("real-marker-password".into());
        assert_eq!(format!("{secret:?}"), "[REDACTED]");
    }

    #[test]
    fn job_id_validation_rejects_uppercase_and_wrong_lengths() {
        assert!(validate_job_id("20260815_7f3a91c2b6d4").is_ok());
        assert!(validate_job_id("20260815_7F3a91c2b6d4").is_err());
        assert!(validate_job_id("20260815_1234").is_err());
    }

    #[test]
    fn source_copy_rejects_same_inode_same_size_mutation_before_admission() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source.bin");
        fs::write(&source_path, b"aaaa").unwrap();
        let mut source = File::open(&source_path).unwrap();
        let expected = source_version(&source.metadata().unwrap());

        fs::write(&source_path, b"bbbb").unwrap();
        let error = copy_source(
            &mut source,
            &root.path().join("copy.bin"),
            4,
            &expected,
            || Ok(()),
        )
        .unwrap_err();

        assert_eq!(error, "DOCUMENT_SOURCE_CHANGED");
    }

    #[test]
    fn source_copy_rejects_same_inode_mutation_during_copy() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source.bin");
        fs::write(&source_path, vec![b'a'; 384 * 1024]).unwrap();
        let mut source = File::open(&source_path).unwrap();
        let expected = source_version(&source.metadata().unwrap());
        let mut checkpoints = 0;

        let error = copy_source(
            &mut source,
            &root.path().join("copy.bin"),
            expected.len,
            &expected,
            || {
                checkpoints += 1;
                if checkpoints == 2 {
                    fs::write(&source_path, vec![b'b'; 384 * 1024]).unwrap();
                }
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error, "DOCUMENT_SOURCE_CHANGED");
    }

    #[test]
    fn source_copy_preserves_exact_checkpoint_error() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source.bin");
        fs::write(&source_path, b"data").unwrap();
        let mut source = File::open(&source_path).unwrap();
        let expected = source_version(&source.metadata().unwrap());

        let error = copy_source(
            &mut source,
            &root.path().join("copy.bin"),
            expected.len,
            &expected,
            || Err("DOCUMENT_TIMEOUT"),
        )
        .unwrap_err();

        assert_eq!(error, "DOCUMENT_TIMEOUT");
    }

    #[test]
    fn cleanup_does_not_follow_a_replaced_staging_path() {
        let root = tempfile::tempdir().unwrap();
        let output_root = root.path().join("output");
        let private_dir = root.path().join("private");
        let input_dir = private_dir.join("input");
        let staging = output_root.join("staging");
        fs::create_dir_all(&input_dir).unwrap();
        fs::create_dir_all(&staging).unwrap();
        let token = "a".repeat(32);
        write_staging_ownership(&private_dir, &staging, &token).unwrap();
        let staging_identity = same_file::Handle::from_path(&staging).unwrap();
        let output_root_identity = same_file::Handle::from_path(&output_root).unwrap();
        let source_path = root.path().join("source.bin");
        fs::write(&source_path, b"data").unwrap();
        let source_file = File::open(&source_path).unwrap();
        let source_version = source_version(&source_file.metadata().unwrap());
        let pending = PendingJob {
            source: same_file::Handle::from_file(source_file).unwrap(),
            source_version,
            password: None,
            private_dir,
            staging_dir: staging.clone(),
            staging_identity,
            staging_token: token.clone(),
            output_root_identity,
        };

        fs::rename(&staging, output_root.join("original-staging")).unwrap();
        fs::create_dir(&staging).unwrap();
        write_marker_file(&staging.join(STAGING_OWNER_MARKER), &token).unwrap();
        fs::write(staging.join("attacker-owned.txt"), b"keep").unwrap();

        cleanup_pending(&pending);

        assert!(staging.join("attacker-owned.txt").is_file());
    }

    #[test]
    fn live_preemption_requeues_exact_document_job_without_partial_staging() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let generation = 3;
        let job = test_job(job_id, output.path(), DocumentJobState::Running);
        let manager = test_manager(data.path(), job, generation);

        let private_dir = data.path().join("jobs").join(job_id);
        let input_dir = private_dir.join("input");
        fs::create_dir(&input_dir).unwrap();
        fs::write(input_dir.join("source.bin"), b"private input").unwrap();
        let staging = output.path().join(format!(".{job_id}.staging"));
        fs::create_dir(&staging).unwrap();
        let token = "a".repeat(32);
        write_staging_ownership(&private_dir, &staging, &token).unwrap();
        fs::write(staging.join("document.md"), b"partial output").unwrap();
        fs::create_dir(staging.join("assets")).unwrap();
        fs::write(staging.join("assets/partial.png"), b"partial asset").unwrap();

        let source_path = data.path().join("source.pdf");
        fs::write(&source_path, b"data").unwrap();
        let source_file = File::open(&source_path).unwrap();
        let source_version = source_version(&source_file.metadata().unwrap());
        let pending = PendingJob {
            source: same_file::Handle::from_file(source_file).unwrap(),
            source_version,
            password: Some(SecretString("retry-secret".into())),
            private_dir: private_dir.clone(),
            staging_dir: staging.clone(),
            staging_identity: same_file::Handle::from_path(&staging).unwrap(),
            staging_token: token.clone(),
            output_root_identity: same_file::Handle::from_path(output.path()).unwrap(),
        };

        manager.settle_ocr_yield(job_id, generation, pending);

        let state = manager.state.lock().unwrap();
        assert_eq!(state.jobs[job_id].state, DocumentJobState::Queued);
        assert_eq!(state.jobs[job_id].stage, "queued");
        assert_eq!(state.queue.front().map(String::as_str), Some(job_id));
        assert!(state.pending.contains_key(job_id));
        assert!(state.active_job.is_none());
        assert!(!staging.join("document.md").exists());
        assert!(!staging.join("assets").exists());
        assert_eq!(
            fs::read_to_string(staging.join(STAGING_OWNER_MARKER)).unwrap(),
            token
        );
        assert!(input_dir.is_dir());
        assert_eq!(fs::read_dir(input_dir).unwrap().count(), 0);
    }

    #[test]
    fn publish_rename_never_replaces_an_existing_destination() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("destination");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(source.join("source.txt"), b"source").unwrap();
        fs::write(destination.join("destination.txt"), b"destination").unwrap();

        assert!(rename_directory_noreplace(&source, &destination).is_err());
        assert!(source.join("source.txt").is_file());
        assert!(destination.join("destination.txt").is_file());

        let empty_source = root.path().join("empty-source");
        let empty_destination = root.path().join("empty-destination");
        fs::create_dir(&empty_source).unwrap();
        fs::create_dir(&empty_destination).unwrap();
        assert!(rename_directory_noreplace(&empty_source, &empty_destination).is_err());
        assert!(empty_source.is_dir());
        assert!(empty_destination.is_dir());
    }

    #[test]
    fn publish_reports_a_stable_collision_and_restores_its_owner_marker() {
        let root = tempfile::tempdir().unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        let staging = root_path.join("staging");
        let destination = root_path.join("destination");
        fs::create_dir(&staging).unwrap();
        fs::create_dir(&destination).unwrap();
        let token = "f".repeat(32);
        write_marker_file(&staging.join(STAGING_OWNER_MARKER), &token).unwrap();
        let staging_identity = same_file::Handle::from_path(&staging).unwrap();
        let root_identity = same_file::Handle::from_path(&root_path).unwrap();

        assert_eq!(
            publish(
                &staging,
                &destination,
                &staging_identity,
                &token,
                &root_identity,
                std::time::Instant::now() + std::time::Duration::from_secs(60),
            ),
            Err("DOCUMENT_OUTPUT_COLLISION")
        );
        assert_eq!(
            fs::read_to_string(staging.join(STAGING_OWNER_MARKER)).unwrap(),
            token
        );
    }

    #[cfg(windows)]
    #[test]
    fn publish_accepts_canonical_windows_verbatim_output_root() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        fs::create_dir(&output).unwrap();
        let canonical = fs::canonicalize(&output).unwrap();
        assert!(matches!(
            canonical.components().next(),
            Some(Component::Prefix(_))
        ));
        reject_link_ancestors(&canonical, false).unwrap();

        let staging = canonical.join("staging");
        let destination = canonical.join("published");
        fs::create_dir(&staging).unwrap();
        let token = "f".repeat(32);
        write_marker_file(&staging.join(STAGING_OWNER_MARKER), &token).unwrap();
        let staging_identity = same_file::Handle::from_path(&staging).unwrap();
        let root_identity = same_file::Handle::from_path(&canonical).unwrap();
        publish(
            &staging,
            &destination,
            &staging_identity,
            &token,
            &root_identity,
            std::time::Instant::now() + std::time::Duration::from_secs(60),
        )
        .unwrap();
        assert!(destination.is_dir());
    }

    #[test]
    fn cancel_wins_if_it_races_with_successful_publish() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let generation = 3;
        let job = test_job(job_id, output.path(), DocumentJobState::Running);
        let manager = test_manager(data.path(), job, generation);
        let staging = output.path().join("staging");
        fs::create_dir(&staging).unwrap();
        let token = "b".repeat(32);
        write_marker_file(&staging.join(STAGING_OWNER_MARKER), &token).unwrap();
        let staging_identity = same_file::Handle::from_path(&staging).unwrap();
        let output_identity = same_file::Handle::from_path(output.path()).unwrap();

        let cancelling = manager.cancel(job_id).unwrap();
        assert_eq!(cancelling.state, DocumentJobState::Cancelling);
        assert_eq!(
            manager.publish_succeeded(PublishAttempt {
                job_id,
                generation,
                deadline: std::time::Instant::now() + std::time::Duration::from_secs(60),
                staging: &staging,
                destination: &output.path().join(job_id),
                staging_identity: &staging_identity,
                staging_token: &token,
                output_root_identity: &output_identity,
                warnings: Vec::new(),
                detected_format: Some("pdf".into()),
                metrics: None,
            }),
            Err("DOCUMENT_CANCELLED")
        );

        manager.finish_cancelled_if_needed(job_id, generation);
        assert_eq!(
            manager.get(job_id).unwrap().state,
            DocumentJobState::Cancelled
        );
        assert!(!output.path().join(job_id).exists());
    }

    #[test]
    fn successful_terminal_cannot_publish_after_its_deadline() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let generation = 3;
        let job = test_job(job_id, output.path(), DocumentJobState::Running);
        let manager = test_manager(data.path(), job, generation);
        let staging = output.path().join("staging");
        fs::create_dir(&staging).unwrap();
        let token = "c".repeat(32);
        write_marker_file(&staging.join(STAGING_OWNER_MARKER), &token).unwrap();
        let staging_identity = same_file::Handle::from_path(&staging).unwrap();
        let output_identity = same_file::Handle::from_path(output.path()).unwrap();

        assert_eq!(
            manager.publish_succeeded(PublishAttempt {
                job_id,
                generation,
                deadline: std::time::Instant::now(),
                staging: &staging,
                destination: &output.path().join(job_id),
                staging_identity: &staging_identity,
                staging_token: &token,
                output_root_identity: &output_identity,
                warnings: Vec::new(),
                detected_format: Some("pdf".into()),
                metrics: None,
            }),
            Err("DOCUMENT_TIMEOUT")
        );
        assert!(staging.is_dir());
        assert!(!output.path().join(job_id).exists());
    }

    #[test]
    fn successful_publish_commits_job_then_clears_recovery_markers() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let output_path = fs::canonicalize(output.path()).unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let generation = 3;
        let job = test_job(job_id, &output_path, DocumentJobState::Running);
        let manager = test_manager(data.path(), job, generation);
        let private_dir = data.path().join("jobs").join(job_id);
        let staging = output_path.join("staging");
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("document.md"), b"committed").unwrap();
        let token = "9".repeat(32);
        write_staging_ownership(&private_dir, &staging, &token).unwrap();
        let staging_identity = same_file::Handle::from_path(&staging).unwrap();
        let output_identity = same_file::Handle::from_path(&output_path).unwrap();
        let destination = output_path.join(job_id);

        manager
            .publish_succeeded(PublishAttempt {
                job_id,
                generation,
                deadline: std::time::Instant::now() + std::time::Duration::from_secs(60),
                staging: &staging,
                destination: &destination,
                staging_identity: &staging_identity,
                staging_token: &token,
                output_root_identity: &output_identity,
                warnings: Vec::new(),
                detected_format: Some("pdf".into()),
                metrics: None,
            })
            .unwrap();

        assert_eq!(
            manager.get(job_id).unwrap().state,
            DocumentJobState::Succeeded
        );
        assert!(destination.join("document.md").is_file());
        assert!(!destination.join(STAGING_OWNER_MARKER).exists());
        assert!(!publish_intent_path(data.path(), job_id).exists());
        assert_eq!(
            load_jobs(data.path()).unwrap()[job_id].state,
            DocumentJobState::Succeeded
        );
    }

    #[test]
    fn rollback_never_replaces_a_recreated_staging_path() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("published");
        let staging = root.path().join("staging");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("document.md"), b"owned artifact").unwrap();
        let expected = same_file::Handle::from_path(&destination).unwrap();
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("replacement.txt"), b"preserve").unwrap();
        let token = "d".repeat(32);

        assert!(rollback_published_artifact(
            &destination,
            &staging,
            &expected,
            &token,
        ));
        assert!(!destination.exists());
        assert_eq!(
            fs::read(staging.join("document.md")).unwrap(),
            b"owned artifact"
        );
        assert_eq!(
            fs::read_to_string(staging.join(STAGING_OWNER_MARKER)).unwrap(),
            token
        );
        assert!(fs::read_dir(root.path()).unwrap().any(|entry| {
            let path = entry.unwrap().path();
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(".myagents-anydoc-rejected-"))
                && path.join("replacement.txt").is_file()
        }));
    }

    #[test]
    fn rollback_quarantines_a_substituted_public_destination() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("published");
        let staging = root.path().join("staging");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("document.md"), b"owned artifact").unwrap();
        let expected = same_file::Handle::from_path(&destination).unwrap();
        fs::rename(&destination, root.path().join("moved-owned-artifact")).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("replacement.txt"), b"preserve").unwrap();

        assert!(!rollback_published_artifact(
            &destination,
            &staging,
            &expected,
            &"e".repeat(32),
        ));
        assert!(!destination.exists());
        assert!(!staging.exists());
        assert!(fs::read_dir(root.path()).unwrap().any(|entry| {
            let path = entry.unwrap().path();
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(".myagents-anydoc-rejected-"))
                && path.join("replacement.txt").is_file()
        }));
    }

    #[test]
    fn startup_publish_intent_finishes_a_durable_success_commit() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let mut job = test_job(job_id, output.path(), DocumentJobState::Succeeded);
        job.finished_at = Some(Utc::now());
        job.output.artifact_available = true;
        let private_dir = data.path().join("jobs").join(job_id);
        let destination = output.path().join(job_id);
        let staging = output
            .path()
            .join(format!(".myagents-anydoc-{job_id}.staging"));
        fs::create_dir_all(&private_dir).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("document.md"), b"committed").unwrap();
        let token = "f".repeat(32);
        write_staging_ownership(&private_dir, &destination, &token).unwrap();
        persist_job(data.path(), &job).unwrap();
        persist_publish_intent(
            data.path(),
            &PublishIntent {
                schema_version: 1,
                job_id: job_id.into(),
                staging_directory: staging.to_string_lossy().into_owned(),
                destination_directory: destination.to_string_lossy().into_owned(),
                staging_token: token,
            },
        )
        .unwrap();
        let mut jobs = HashMap::from([(job_id.to_string(), job)]);

        recover_publish_intents(data.path(), &mut jobs);

        assert_eq!(jobs[job_id].state, DocumentJobState::Succeeded);
        assert!(destination.join("document.md").is_file());
        assert!(!destination.join(STAGING_OWNER_MARKER).exists());
        assert!(!publish_intent_path(data.path(), job_id).exists());
    }

    #[test]
    fn startup_durable_success_republishes_authenticated_staging() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let output_path = fs::canonicalize(output.path()).unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let mut job = test_job(job_id, &output_path, DocumentJobState::Succeeded);
        job.finished_at = Some(Utc::now());
        job.output.artifact_available = true;
        let private_dir = data.path().join("jobs").join(job_id);
        let destination = output_path.join(job_id);
        let staging = output_path.join(format!(".myagents-anydoc-{job_id}.staging"));
        fs::create_dir_all(&private_dir).unwrap();
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("document.md"), b"unknown commit outcome").unwrap();
        let token = "7".repeat(32);
        write_staging_ownership(&private_dir, &staging, &token).unwrap();
        persist_job(data.path(), &job).unwrap();
        persist_publish_intent(
            data.path(),
            &PublishIntent {
                schema_version: 1,
                job_id: job_id.into(),
                staging_directory: staging.to_string_lossy().into_owned(),
                destination_directory: destination.to_string_lossy().into_owned(),
                staging_token: token,
            },
        )
        .unwrap();
        let mut jobs = HashMap::from([(job_id.to_string(), job)]);

        recover_publish_intents(data.path(), &mut jobs);

        assert_eq!(jobs[job_id].state, DocumentJobState::Succeeded);
        assert_eq!(
            fs::read(destination.join("document.md")).unwrap(),
            b"unknown commit outcome"
        );
        assert!(!destination.join(STAGING_OWNER_MARKER).exists());
        assert!(!staging.exists());
        assert!(!publish_intent_path(data.path(), job_id).exists());
    }

    #[test]
    fn startup_durable_success_never_rewrites_history_after_artifact_deletion() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let mut job = test_job(job_id, output.path(), DocumentJobState::Succeeded);
        job.finished_at = Some(Utc::now());
        job.output.artifact_available = true;
        let private_dir = data.path().join("jobs").join(job_id);
        let staging = output
            .path()
            .join(format!(".myagents-anydoc-{job_id}.staging"));
        fs::create_dir_all(&private_dir).unwrap();
        let token = "8".repeat(32);
        fs::write(private_dir.join(PRIVATE_STAGING_TOKEN), &token).unwrap();
        persist_job(data.path(), &job).unwrap();
        persist_publish_intent(
            data.path(),
            &PublishIntent {
                schema_version: 1,
                job_id: job_id.into(),
                staging_directory: staging.to_string_lossy().into_owned(),
                destination_directory: job.output.job_directory.clone(),
                staging_token: token,
            },
        )
        .unwrap();
        let mut jobs = HashMap::from([(job_id.to_string(), job)]);

        recover_publish_intents(data.path(), &mut jobs);

        assert_eq!(jobs[job_id].state, DocumentJobState::Succeeded);
        assert!(!Path::new(&jobs[job_id].output.job_directory).exists());
        assert!(!publish_intent_path(data.path(), job_id).exists());
        assert_eq!(
            load_jobs(data.path()).unwrap()[job_id].state,
            DocumentJobState::Succeeded
        );
    }

    #[test]
    fn startup_publish_intent_removes_uncommitted_public_artifact() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let job = test_job(job_id, output.path(), DocumentJobState::Running);
        let private_dir = data.path().join("jobs").join(job_id);
        let destination = output.path().join(job_id);
        let staging = output
            .path()
            .join(format!(".myagents-anydoc-{job_id}.staging"));
        fs::create_dir_all(&private_dir).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("document.md"), b"not committed").unwrap();
        let token = "a".repeat(32);
        write_staging_ownership(&private_dir, &destination, &token).unwrap();
        persist_job(data.path(), &job).unwrap();
        persist_publish_intent(
            data.path(),
            &PublishIntent {
                schema_version: 1,
                job_id: job_id.into(),
                staging_directory: staging.to_string_lossy().into_owned(),
                destination_directory: destination.to_string_lossy().into_owned(),
                staging_token: token,
            },
        )
        .unwrap();
        let mut jobs = HashMap::from([(job_id.to_string(), job)]);

        recover_publish_intents(data.path(), &mut jobs);
        recover_nonterminal_jobs(data.path(), &mut jobs);

        assert_eq!(jobs[job_id].state, DocumentJobState::Interrupted);
        assert!(!destination.exists());
        assert!(!publish_intent_path(data.path(), job_id).exists());
        assert_eq!(
            load_jobs(data.path()).unwrap()[job_id].state,
            DocumentJobState::Interrupted
        );
    }

    #[test]
    fn restart_cleanup_retries_terminal_private_and_owned_staging_paths() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let job = test_job(job_id, output.path(), DocumentJobState::Failed);
        let private_dir = data.path().join("jobs").join(job_id);
        let input_dir = private_dir.join("input");
        let staging = output
            .path()
            .join(format!(".myagents-anydoc-{job_id}.staging"));
        fs::create_dir_all(&input_dir).unwrap();
        fs::create_dir(&staging).unwrap();
        let token = "c".repeat(32);
        write_staging_ownership(&private_dir, &staging, &token).unwrap();

        cleanup_stale_job_paths(data.path(), &job);

        assert!(!input_dir.exists());
        assert!(!staging.exists());
    }

    #[test]
    fn restart_cleanup_preserves_staging_with_a_changed_owner_marker() {
        let data = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let job_id = "20260815_7f3a91c2b6d4";
        let job = test_job(job_id, output.path(), DocumentJobState::Interrupted);
        let private_dir = data.path().join("jobs").join(job_id);
        let staging = output
            .path()
            .join(format!(".myagents-anydoc-{job_id}.staging"));
        fs::create_dir_all(&private_dir).unwrap();
        fs::create_dir(&staging).unwrap();
        fs::write(private_dir.join(PRIVATE_STAGING_TOKEN), "d".repeat(32)).unwrap();
        fs::write(staging.join(STAGING_OWNER_MARKER), "e".repeat(32)).unwrap();
        fs::write(staging.join("keep.txt"), b"keep").unwrap();

        cleanup_stale_job_paths(data.path(), &job);

        assert!(staging.join("keep.txt").is_file());
    }

    #[test]
    fn framed_protocol_rejects_partial_prefixes_and_wrong_terminal_identity() {
        assert!(read_frame(&mut Cursor::new(Vec::<u8>::new()))
            .unwrap()
            .is_none());
        assert_eq!(
            read_frame(&mut Cursor::new(vec![0_u8, 0])).unwrap_err(),
            "control frame prefix truncated",
        );

        let mut bytes = Vec::new();
        write_frame(
            &mut bytes,
            &serde_json::json!({
                "type": "ready",
                "protocolVersion": PROTOCOL_VERSION,
                "jobId": "20260815_bbbbbbbbbbbb",
                "workerGeneration": 7
            }),
        )
        .unwrap();
        write_frame(
            &mut bytes,
            &serde_json::json!({
                "type": "completed",
                "protocolVersion": PROTOCOL_VERSION,
                "jobId": "20260815_aaaaaaaaaaaa",
                "workerGeneration": 7,
                "result": {
                    "warnings": [],
                    "detectedFormat": "pdf",
                    "metrics": {
                        "sourceBytes": 1, "outputBytes": 1, "pagesTotal": 1,
                        "pagesOcr": 0, "assetsWritten": 0, "elapsedMs": 1
                    }
                }
            }),
        )
        .unwrap();
        let error = read_worker_responses(
            &mut Cursor::new(bytes),
            "20260815_bbbbbbbbbbbb",
            7,
            |_| {},
            || Ok(()),
            || {},
        )
        .unwrap_err();
        assert_eq!(
            error,
            WorkerResponseReadError::Protocol("terminal identity mismatch".into())
        );
    }

    #[test]
    fn framed_protocol_rejects_wrong_progress_identity_and_malformed_success() {
        let mut wrong_progress = Vec::new();
        write_frame(
            &mut wrong_progress,
            &serde_json::json!({
                "type": "ready",
                "protocolVersion": PROTOCOL_VERSION,
                "jobId": "20260815_bbbbbbbbbbbb",
                "workerGeneration": 7
            }),
        )
        .unwrap();
        write_frame(
            &mut wrong_progress,
            &serde_json::json!({
                "type": "progress",
                "protocolVersion": PROTOCOL_VERSION,
                "jobId": "20260815_aaaaaaaaaaaa",
                "workerGeneration": 7,
                "stage": "ocr"
            }),
        )
        .unwrap();
        assert_eq!(
            read_worker_responses(
                &mut Cursor::new(wrong_progress),
                "20260815_bbbbbbbbbbbb",
                7,
                |_| {},
                || Ok(()),
                || {},
            )
            .unwrap_err(),
            WorkerResponseReadError::Protocol("progress identity mismatch".into()),
        );

        let mut malformed_terminal = Vec::new();
        write_frame(
            &mut malformed_terminal,
            &serde_json::json!({
                "type": "ready",
                "protocolVersion": PROTOCOL_VERSION,
                "jobId": "20260815_bbbbbbbbbbbb",
                "workerGeneration": 7
            }),
        )
        .unwrap();
        write_frame(
            &mut malformed_terminal,
            &serde_json::json!({
                "type": "completed",
                "protocolVersion": PROTOCOL_VERSION,
                "jobId": "20260815_bbbbbbbbbbbb",
                "workerGeneration": 7,
                "result": {
                    "warnings": [],
                    "detectedFormat": "",
                    "metrics": {
                        "sourceBytes": 1, "outputBytes": 1, "pagesTotal": 1,
                        "pagesOcr": 0, "assetsWritten": 0, "elapsedMs": 1
                    }
                }
            }),
        )
        .unwrap();
        assert_eq!(
            read_worker_responses(
                &mut Cursor::new(malformed_terminal),
                "20260815_bbbbbbbbbbbb",
                7,
                |_| {},
                || Ok(()),
                || {},
            )
            .unwrap_err(),
            WorkerResponseReadError::Protocol("completed response shape invalid".into()),
        );
    }

    #[test]
    fn framed_protocol_requires_one_ocr_lease_before_reporting_ocr_pages() {
        let job_id = "20260815_bbbbbbbbbbbb";
        let mut bytes = Vec::new();
        for value in [
            serde_json::json!({
                "type": "ready", "protocolVersion": PROTOCOL_VERSION,
                "jobId": job_id, "workerGeneration": 7
            }),
            serde_json::json!({
                "type": "ocr_lease_requested", "protocolVersion": PROTOCOL_VERSION,
                "jobId": job_id, "workerGeneration": 7
            }),
            serde_json::json!({
                "type": "completed", "protocolVersion": PROTOCOL_VERSION,
                "jobId": job_id, "workerGeneration": 7,
                "result": {
                    "warnings": [], "detectedFormat": "png",
                    "metrics": {
                        "sourceBytes": 1, "outputBytes": 1, "pagesTotal": 1,
                        "pagesOcr": 1, "assetsWritten": 0, "elapsedMs": 1
                    }
                }
            }),
        ] {
            write_frame(&mut bytes, &value).unwrap();
        }
        let mut grants = 0;
        let terminal = read_worker_responses(
            &mut Cursor::new(bytes),
            job_id,
            7,
            |_| {},
            || {
                grants += 1;
                Ok(())
            },
            || {},
        )
        .unwrap();
        assert!(terminal.success);
        assert_eq!(grants, 1);

        let mut missing_request = Vec::new();
        for value in [
            serde_json::json!({
                "type": "ready", "protocolVersion": PROTOCOL_VERSION,
                "jobId": job_id, "workerGeneration": 7
            }),
            serde_json::json!({
                "type": "completed", "protocolVersion": PROTOCOL_VERSION,
                "jobId": job_id, "workerGeneration": 7,
                "result": {
                    "warnings": [], "detectedFormat": "png",
                    "metrics": {
                        "sourceBytes": 1, "outputBytes": 1, "pagesTotal": 1,
                        "pagesOcr": 1, "assetsWritten": 0, "elapsedMs": 1
                    }
                }
            }),
        ] {
            write_frame(&mut missing_request, &value).unwrap();
        }
        assert_eq!(
            read_worker_responses(
                &mut Cursor::new(missing_request),
                job_id,
                7,
                |_| {},
                || Ok(()),
                || {},
            )
            .unwrap_err(),
            WorkerResponseReadError::Protocol("completed response shape invalid".into())
        );
    }

    #[test]
    fn framed_protocol_rejects_unknown_stage_and_post_terminal_frames() {
        let mut duplicate_ready = Vec::new();
        for _ in 0..2 {
            write_frame(
                &mut duplicate_ready,
                &serde_json::json!({
                    "type": "ready", "protocolVersion": PROTOCOL_VERSION,
                    "jobId": "20260815_bbbbbbbbbbbb", "workerGeneration": 7
                }),
            )
            .unwrap();
        }
        assert_eq!(
            read_worker_responses(
                &mut Cursor::new(duplicate_ready),
                "20260815_bbbbbbbbbbbb",
                7,
                |_| {},
                || Ok(()),
                || {},
            )
            .unwrap_err(),
            WorkerResponseReadError::Protocol("worker emitted duplicate ready".into()),
        );

        let mut unknown_failure = Vec::new();
        for value in [
            serde_json::json!({
                "type": "ready", "protocolVersion": PROTOCOL_VERSION,
                "jobId": "20260815_bbbbbbbbbbbb", "workerGeneration": 7
            }),
            serde_json::json!({
                "type": "failed", "protocolVersion": PROTOCOL_VERSION,
                "jobId": "20260815_bbbbbbbbbbbb", "workerGeneration": 7,
                "error": { "code": "DOCUMENT_INVENTED", "message": "invented" }
            }),
        ] {
            write_frame(&mut unknown_failure, &value).unwrap();
        }
        assert_eq!(
            read_worker_responses(
                &mut Cursor::new(unknown_failure),
                "20260815_bbbbbbbbbbbb",
                7,
                |_| {},
                || Ok(()),
                || {},
            )
            .unwrap_err(),
            WorkerResponseReadError::Protocol("failed response shape invalid".into()),
        );

        let mut unknown_stage = Vec::new();
        for value in [
            serde_json::json!({
                "type": "ready", "protocolVersion": PROTOCOL_VERSION,
                "jobId": "20260815_bbbbbbbbbbbb", "workerGeneration": 7
            }),
            serde_json::json!({
                "type": "progress", "protocolVersion": PROTOCOL_VERSION,
                "jobId": "20260815_bbbbbbbbbbbb", "workerGeneration": 7,
                "stage": "invented"
            }),
        ] {
            write_frame(&mut unknown_stage, &value).unwrap();
        }
        assert_eq!(
            read_worker_responses(
                &mut Cursor::new(unknown_stage),
                "20260815_bbbbbbbbbbbb",
                7,
                |_| {},
                || Ok(()),
                || {},
            )
            .unwrap_err(),
            WorkerResponseReadError::Protocol("worker progress stage invalid".into()),
        );

        let completed = serde_json::json!({
            "type": "completed", "protocolVersion": PROTOCOL_VERSION,
            "jobId": "20260815_bbbbbbbbbbbb", "workerGeneration": 7,
            "result": {
                "warnings": [], "detectedFormat": "pdf",
                "metrics": {
                    "sourceBytes": 1, "outputBytes": 1, "pagesTotal": 1,
                    "pagesOcr": 0, "assetsWritten": 0, "elapsedMs": 1
                }
            }
        });
        let mut duplicate = Vec::new();
        write_frame(
            &mut duplicate,
            &serde_json::json!({
                "type": "ready", "protocolVersion": PROTOCOL_VERSION,
                "jobId": "20260815_bbbbbbbbbbbb", "workerGeneration": 7
            }),
        )
        .unwrap();
        write_frame(&mut duplicate, &completed).unwrap();
        write_frame(&mut duplicate, &completed).unwrap();
        assert_eq!(
            read_worker_responses(
                &mut Cursor::new(duplicate),
                "20260815_bbbbbbbbbbbb",
                7,
                |_| {},
                || Ok(()),
                || {},
            )
            .unwrap_err(),
            WorkerResponseReadError::Protocol("worker emitted a frame after terminal".into()),
        );
    }

    #[test]
    fn password_recovery_uses_a_placeholder_only() {
        let error = worker_error("20260815_7f3a91c2b6d4", "DOCUMENT_PASSWORD_INVALID", false);
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(serialized.contains("<password>"));
        assert!(!serialized.contains("marker-secret"));
    }

    #[test]
    fn public_job_json_uses_the_prd_pipeline_and_metric_contract() {
        let now = Utc::now();
        let job = DocumentJob {
            job_id: "20260815_7f3a91c2b6d4".into(),
            state: DocumentJobState::Succeeded,
            stage: "finalizing".into(),
            source: DocumentSource {
                path: "/input/report.pdf".into(),
                display_name: "report.pdf".into(),
                format: Some("pdf".into()),
                size_bytes: 128,
                sha256: Some("a".repeat(64)),
            },
            output: DocumentOutput {
                root_directory: "/output".into(),
                job_directory: "/output/20260815_7f3a91c2b6d4".into(),
                document_path: "/output/20260815_7f3a91c2b6d4/document.md".into(),
                assets_directory: None,
                artifact_available: true,
            },
            created_at: now,
            updated_at: now,
            started_at: Some(now),
            finished_at: Some(now),
            warnings: Vec::new(),
            error: None,
            metrics: Some(DocumentMetrics {
                duration_ms: 42,
                source_bytes: 128,
                output_bytes: 64,
                pages_total: Some(3),
                pages_native: Some(2),
                pages_ocr: Some(1),
                assets_written: Some(0),
            }),
            pipeline: default_pipeline("1.28.0"),
        };

        let value = serde_json::to_value(job).unwrap();
        assert!(value.get("pipeline").is_some());
        assert!(value.get("provenance").is_none());
        assert_eq!(value["pipeline"]["version"], PIPELINE_VERSION);
        assert_eq!(value["metrics"]["pagesTotal"], 3);
        assert_eq!(value["metrics"]["pagesNative"], 2);
        assert_eq!(value["metrics"]["pagesOcr"], 1);
        assert_eq!(value["metrics"]["assetsWritten"], 0);
        assert!(value["metrics"].get("pages").is_none());
        assert!(value["metrics"].get("ocrPages").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn output_paths_reject_symlink_ancestors() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        let alias = root.path().join("alias");
        fs::create_dir(&real).unwrap();
        symlink(&real, &alias).unwrap();
        let error = prepare_output_root(&alias.join("converted")).unwrap_err();
        assert_eq!(error.code, "DOCUMENT_PATH_LINK_REJECTED");
    }
}
