use super::*;

// ============ Cron Run Records (execution history) ============

const MAX_RUN_RECORDS: usize = 500;

/// A single execution record for a cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunRecord {
    pub ts: i64,                 // Unix timestamp (ms)
    pub ok: bool,                // Whether execution succeeded
    pub duration_ms: u64,        // Execution duration
    pub content: Option<String>, // AI output text (delivery content)
    pub error: Option<String>,   // Error message on failure
}

/// PRD 0.2.5 R4 — return shape for `trigger_now()`. Echoed back to the
/// caller (CLI / HTTP) so they can display "what got fired, where to look".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerNowInfo {
    pub task_id: String,
    pub session_id: String,
    pub dispatched_at: String,
}

/// Sanitize task_id to prevent path traversal (remove path separators and dots sequences)
fn sanitize_task_id(task_id: &str) -> String {
    task_id.replace(['/', '\\', '\0'], "").replace("..", "")
}

/// Get the JSONL file path for a task's run records
pub(super) fn run_record_path(task_id: &str) -> PathBuf {
    let safe_id = sanitize_task_id(task_id);
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
        .join("cron_runs")
        .join(format!("{}.jsonl", safe_id))
}

/// Append a run record to ~/.myagents/cron_runs/<taskId>.jsonl
/// Truncates to MAX_RUN_RECORDS if exceeded.
pub async fn record_cron_run(task_id: &str, record: &CronRunRecord) -> Result<(), String> {
    let path = run_record_path(task_id);
    let line = serde_json::to_string(record)
        .map_err(|e| format!("Failed to serialize run record: {}", e))?
        + "\n";
    let lock_path = path.with_extension("jsonl.lock");
    crate::utils::file_lock::with_file_lock(
        &lock_path,
        crate::utils::file_lock::FileLockOptions::default(),
        move || {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(crate::utils::file_lock::FileLockError::Io)?;
            }
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(crate::utils::file_lock::FileLockError::Io)?;
            file.write_all(line.as_bytes())
                .map_err(crate::utils::file_lock::FileLockError::Io)?;
            truncate_run_file_if_needed(&path, MAX_RUN_RECORDS);
            Ok(())
        },
    )
    .await
    .map_err(|error| error.to_string())
}

/// Merge run history from a historical Cron projection into its Task id.
/// The legacy file remains untouched as a diagnostic backup.
pub(crate) async fn migrate_cron_run_history(legacy_id: &str, task_id: &str) -> Result<(), String> {
    if legacy_id == task_id {
        return Ok(());
    }
    let source = run_record_path(legacy_id);
    if !source.exists() {
        return Ok(());
    }
    let target = run_record_path(task_id);
    let lock_path = target.with_extension("jsonl.lock");
    crate::utils::file_lock::with_file_lock(
        &lock_path,
        crate::utils::file_lock::FileLockOptions::default(),
        move || {
            let mut records = Vec::new();
            for path in [&target, &source] {
                let Ok(content) = fs::read_to_string(path) else {
                    continue;
                };
                records.extend(
                    content
                        .lines()
                        .filter_map(|line| serde_json::from_str::<CronRunRecord>(line).ok()),
                );
            }
            records.sort_by_key(|record| record.ts);
            let mut seen = HashSet::new();
            records.retain(|record| {
                serde_json::to_string(record)
                    .map(|value| seen.insert(value))
                    .unwrap_or(false)
            });
            if records.len() > MAX_RUN_RECORDS {
                records.drain(..records.len() - MAX_RUN_RECORDS);
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(crate::utils::file_lock::FileLockError::Io)?;
            }
            let content = records
                .into_iter()
                .map(|record| serde_json::to_string(&record))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| {
                    crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        error,
                    ))
                })?
                .join("\n");
            fs::write(&target, format!("{content}\n"))
                .map_err(crate::utils::file_lock::FileLockError::Io)
        },
    )
    .await
    .map_err(|error| error.to_string())
}

/// Read the most recent `limit` run records (returned in chronological order)
pub fn read_cron_runs(task_id: &str, limit: usize) -> Vec<CronRunRecord> {
    let path = run_record_path(task_id);
    if !path.exists() {
        return vec![];
    }

    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let capped = limit.min(100);
    let records: Vec<CronRunRecord> = content
        .lines()
        .rev()
        .take(capped)
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    // Reverse back to chronological order
    records.into_iter().rev().collect()
}

/// Truncate a JSONL file to keep only the last `max` lines
fn truncate_run_file_if_needed(path: &PathBuf, max: usize) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= max {
        return;
    }

    // Keep only the last `max` lines
    let kept: Vec<&str> = lines[lines.len() - max..].to_vec();
    let new_content = kept.join("\n") + "\n";
    let _ = fs::write(path, new_content);
}
