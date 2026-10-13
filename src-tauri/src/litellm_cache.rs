//! LiteLLM model-data cache (single-owner background refresh).
//!
//! Periodically fetches BerriAI/litellm's `model_prices_and_context_window.json`
//! (~1.5MB community catalog of model context windows + output limits) and
//! stores it raw under `~/.myagents/cache/`. The Node sidecar reads it as the
//! LOWEST-priority source in `model-capabilities.ts` — a fallback context window
//! for third-party models whose `/v1/models` doesn't report one.
//!
//! Why Rust (not the sidecar): the Tauri process is the single always-alive
//! owner. Sidecars are per-Tab and ephemeral; running the fetch there would mean
//! N concurrent downloads racing the same file. This mirrors `updater.rs`'s
//! startup-check + background-loop pattern.
//!
//! Cadence: startup conditional check (after a short delay) + a 24h interval.
//! "Conditional" = HTTP ETag / `If-None-Match` → a `304 Not Modified` costs only
//! response headers, so even a per-launch check transfers ~0 bytes when the file
//! is unchanged (verified: GitHub raw returns an ETag and honours If-None-Match;
//! it does NOT send Last-Modified, so ETag is the only usable validator).
//!
//! Gated by `config.json::liteLLMModelDataRefresh` (default true; toggled in the
//! Settings → developer section).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::{ulog_info, ulog_warn};

const LITELLM_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const DATA_FILE: &str = "litellm_model_prices.json";
const META_FILE: &str = "litellm_model_prices.json.meta";

/// Reject an absurd/poisoned download before it ever reaches the sidecar parser.
/// The file is ~1.5MB today; 24MB is generous headroom.
const MAX_BYTES: u64 = 24 * 1024 * 1024;
/// Delay before the first check, so the updater HTTPS round-trip and the user's
/// first action aren't racing a cold start (mirrors `updater.rs`'s 60s).
const STARTUP_DELAY_SECS: u64 = 90;
/// Re-ask the server "changed?" once a day. Cheap (304) when unchanged.
const REFRESH_INTERVAL_SECS: u64 = 24 * 60 * 60;
/// Don't re-hit the network if we already checked within this window — guards
/// against request spam on rapid app restarts (the in-process loop spaces calls
/// 24h apart; this only matters across launches).
const MIN_RECHECK_SECS: u64 = 60 * 60;
const HTTP_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct CacheMeta {
    #[serde(default)]
    etag: Option<String>,
    #[serde(default)]
    fetched_at_secs: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum RefreshOutcome {
    Disabled,
    Throttled,
    NotModified,
    Updated,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cache_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    Ok(home.join(crate::app_dirs::APP_DATA_DIR_NAME).join("cache"))
}

/// Parse `liteLLMModelDataRefresh` out of a config.json string. PURE — testable.
/// Returns None when the file is unparseable or the key is absent (caller
/// defaults to enabled). BOM-tolerant (Windows editors inject it).
fn parse_enabled_flag(config_json: &str) -> Option<bool> {
    let trimmed = config_json.trim_start_matches('\u{feff}');
    #[derive(serde::Deserialize)]
    struct Partial {
        #[serde(rename = "liteLLMModelDataRefresh")]
        flag: Option<bool>,
    }
    let parsed: Partial = serde_json::from_str(trimmed).ok()?;
    parsed.flag
}

/// Read the toggle from `~/.myagents/config.json`. Default ON: a missing file,
/// missing key, or parse error all mean "enabled" — the feature opts users IN.
fn is_enabled() -> bool {
    let Some(home) = dirs::home_dir() else {
        return true;
    };
    let path = home.join(crate::app_dirs::APP_DATA_DIR_NAME).join("config.json");
    match fs::read_to_string(&path) {
        Ok(content) => parse_enabled_flag(&content).unwrap_or(true),
        Err(_) => true,
    }
}

fn parse_meta(content: &str) -> Option<CacheMeta> {
    serde_json::from_str(content.trim_start_matches('\u{feff}')).ok()
}

fn read_meta(meta_path: &Path) -> Option<CacheMeta> {
    fs::read_to_string(meta_path)
        .ok()
        .as_deref()
        .and_then(parse_meta)
}

/// Decide whether to hit the network. PURE — testable.
/// Throttle on the last ATTEMPT timestamp (meta is written on success AND
/// failure), regardless of whether a cache body exists — otherwise a
/// persistently-blocked GitHub (no proxy, offline) would re-hit the network on
/// every launch because "no data → always fetch". Missing/zeroed meta → fetch.
fn should_fetch(meta: Option<&CacheMeta>, now: u64, min_recheck_secs: u64) -> bool {
    match meta {
        Some(m) if m.fetched_at_secs > 0 => {
            now.saturating_sub(m.fetched_at_secs) >= min_recheck_secs
        }
        _ => true,
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("write tmp failed: {e}"))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp); // don't leave a stale tmp behind (mirrors updater.rs)
        return Err(format!("rename failed: {e}"));
    }
    Ok(())
}

fn write_meta(meta_path: &Path, meta: &CacheMeta) -> Result<(), String> {
    let json = serde_json::to_vec(meta).map_err(|e| format!("serialize meta failed: {e}"))?;
    write_atomic(meta_path, &json)
}

fn build_client() -> Result<reqwest::Client, String> {
    // External host (GitHub) — `local_http` is localhost-only, so we build a
    // normal proxy-aware client. Per clippy.toml the bare builder needs an
    // explicit allow at external-host call sites (R2 / updater do the same).
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent(concat!("MyAgents/", env!("CARGO_PKG_VERSION")));
    crate::proxy_config::build_client_with_proxy(builder)
}

/// One conditional refresh. Returns the outcome or an error string (logged by
/// the caller; never panics — a bad refresh must not take down the app).
async fn refresh_once() -> Result<RefreshOutcome, String> {
    if !is_enabled() {
        return Ok(RefreshOutcome::Disabled);
    }

    let dir = cache_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create cache dir failed: {e}"))?;
    let data_path = dir.join(DATA_FILE);
    let meta_path = dir.join(META_FILE);

    let meta = read_meta(&meta_path);
    let now = now_secs();
    if !should_fetch(meta.as_ref(), now, MIN_RECHECK_SECS) {
        return Ok(RefreshOutcome::Throttled);
    }

    let prev_etag = meta.and_then(|m| m.etag);
    let result = fetch_and_store(&data_path, &meta_path, prev_etag.clone(), now).await;
    if result.is_err() {
        // Record the ATTEMPT so the throttle covers failures too — otherwise a
        // blocked/offline GitHub (common without a proxy) gets re-hit on every
        // launch. Preserve the prior etag so a later success can still 304.
        let _ = write_meta(
            &meta_path,
            &CacheMeta {
                etag: prev_etag,
                fetched_at_secs: now,
            },
        );
    }
    result
}

/// Network half: conditional GET → handle 304 / 200, bounded read, validate,
/// store. Writes meta on success (304 and 200). Errors propagate to the caller,
/// which records the attempt timestamp.
async fn fetch_and_store(
    data_path: &Path,
    meta_path: &Path,
    prev_etag: Option<String>,
    now: u64,
) -> Result<RefreshOutcome, String> {
    let client = build_client()?;
    let mut req = client.get(LITELLM_URL);
    // Only send If-None-Match when we actually have the matching body on disk.
    if data_path.exists() {
        if let Some(tag) = prev_etag.as_deref() {
            req = req.header(reqwest::header::IF_NONE_MATCH, tag);
        }
    }

    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();

    if status == reqwest::StatusCode::NOT_MODIFIED {
        // Unchanged — keep the body, just record that we checked (so the 24h /
        // restart throttle advances). Preserve the existing etag.
        write_meta(
            meta_path,
            &CacheMeta {
                etag: prev_etag,
                fetched_at_secs: now,
            },
        )?;
        return Ok(RefreshOutcome::NotModified);
    }
    if !status.is_success() {
        return Err(format!("upstream HTTP {status}"));
    }

    // Fast reject when the length is advertised…
    if let Some(len) = resp.content_length() {
        if len > MAX_BYTES {
            return Err(format!("oversize body: content-length {len} > {MAX_BYTES}"));
        }
    }
    let new_etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    // …and a hard bound while streaming, so a chunked response with no
    // Content-Length (captive portal / hostile proxy) can't OOM us before the
    // check. Abort as soon as the accumulator would exceed the cap.
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("read body failed: {e}"))?
    {
        if body.len() as u64 + chunk.len() as u64 > MAX_BYTES {
            return Err(format!("oversize body: exceeds {MAX_BYTES} bytes"));
        }
        body.extend_from_slice(&chunk);
    }
    // Validate it's actually JSON before we let the sidecar trust it — a captive
    // portal / error page returned with 200 would otherwise poison the cache.
    serde_json::from_slice::<serde_json::Value>(&body)
        .map_err(|e| format!("upstream returned non-JSON: {e}"))?;

    write_atomic(data_path, &body)?;
    write_meta(
        meta_path,
        &CacheMeta {
            etag: new_etag,
            fetched_at_secs: now,
        },
    )?;
    ulog_info!("[litellm] cache updated ({} bytes)", body.len());
    Ok(RefreshOutcome::Updated)
}

/// Background loop: one check shortly after startup, then every 24h. Spawned
/// from `lib.rs` setup via `tauri::async_runtime::spawn`.
pub async fn start_periodic_refresh() {
    tokio::time::sleep(Duration::from_secs(STARTUP_DELAY_SECS)).await;
    loop {
        match refresh_once().await {
            Ok(outcome) => ulog_info!("[litellm] refresh: {outcome:?}"),
            Err(e) => ulog_warn!("[litellm] refresh failed: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(REFRESH_INTERVAL_SECS)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_enabled_flag_reads_the_toggle() {
        assert_eq!(
            parse_enabled_flag(r#"{"liteLLMModelDataRefresh": false}"#),
            Some(false)
        );
        assert_eq!(
            parse_enabled_flag(r#"{"liteLLMModelDataRefresh": true}"#),
            Some(true)
        );
        // absent key → None (caller defaults to enabled)
        assert_eq!(parse_enabled_flag(r#"{"theme":"dark"}"#), None);
        // BOM-prefixed config still parses
        assert_eq!(
            parse_enabled_flag("\u{feff}{\"liteLLMModelDataRefresh\": false}"),
            Some(false)
        );
        // garbage → None
        assert_eq!(parse_enabled_flag("not json"), None);
    }

    #[test]
    fn parse_meta_roundtrips() {
        let m = parse_meta(r#"{"etag":"\"abc\"","fetched_at_secs":1700000000}"#).unwrap();
        assert_eq!(m.etag.as_deref(), Some("\"abc\""));
        assert_eq!(m.fetched_at_secs, 1_700_000_000);
        assert!(parse_meta("garbage").is_none());
    }

    #[test]
    fn should_fetch_throttles_on_last_attempt_even_without_a_cache_body() {
        // A recent ATTEMPT (success OR failure writes meta) throttles regardless
        // of whether data exists — so offline/blocked GitHub isn't re-hit every
        // launch. This is the #277-review fix (Codex finding #4).
        let recent = CacheMeta {
            etag: Some("x".into()),
            fetched_at_secs: 1_000_000,
        };
        assert!(!should_fetch(
            Some(&recent),
            1_000_000 + 10,
            MIN_RECHECK_SECS
        ));
        // zeroed/garbage timestamp → fetch
        let zero = CacheMeta {
            etag: None,
            fetched_at_secs: 0,
        };
        assert!(should_fetch(Some(&zero), 1_000_000, MIN_RECHECK_SECS));
    }

    #[test]
    fn should_fetch_respects_recheck_floor() {
        let meta = CacheMeta {
            etag: Some("x".into()),
            fetched_at_secs: 1_000_000,
        };
        // within the floor → skip
        assert!(!should_fetch(Some(&meta), 1_000_000 + 10, MIN_RECHECK_SECS));
        // past the floor → fetch
        assert!(should_fetch(
            Some(&meta),
            1_000_000 + MIN_RECHECK_SECS,
            MIN_RECHECK_SECS
        ));
        // never attempted → fetch
        assert!(should_fetch(None, 1_000_000, MIN_RECHECK_SECS));
    }
}
