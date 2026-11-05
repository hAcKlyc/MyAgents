// browser.rs — Embedded browser panel (Tauri Multi-Webview)
//
// Manages child Webview instances for in-app web browsing.
// Each Chat Tab can have one browser Webview. The Webview floats
// above the React DOM at OS level, positioned by frontend coordinates.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url,
};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{ulog_info, ulog_warn};
use std::path::Path;

#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

/// User-Agent for the embedded browser webview.
///
/// The default WebView UA on each platform is missing parts (macOS WKWebView
/// drops the `Version/X Safari/Y` suffix; Windows WebView2 advertises Edge
/// instead of Chrome; Linux WebKitGTK is rarer and frequently fingerprinted
/// as a bot) which several big sites — baidu.com main page is the canonical
/// case — flag and respond to with degraded/empty pages or redirect chains.
/// (A user session log showed baidu.com cycling at ~30 redirects/sec.)
///
/// We pretend to be a recent stable Chrome on each host OS rather than the
/// host engine's actual identity: most sites — especially the CN ecosystem —
/// optimize for Chrome and the recognition rate is highest there. The
/// tradeoff is that some UA-sniffing sites may serve Blink-only code paths
/// that the host engine (WebKit on macOS, WebKit2GTK on Linux) doesn't
/// implement identically. Worth it for the "things actually load" win.
#[cfg(target_os = "macos")]
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
#[cfg(target_os = "windows")]
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
#[cfg(target_os = "linux")]
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/// Document-start init script injected into every page in the embedded
/// browser. Two responsibilities:
///
/// 1. **`window.open` shim** — we don't have multi-tab; route programmatic
///    `window.open(url)` calls to the same page so the user actually sees
///    something happen instead of a silently-blocked popup. (WKWebView's
///    `javaScriptCanOpenWindowsAutomatically` defaults to false and isn't
///    exposed by wry, so non-user-gesture window.open never reaches our
///    on_new_window handler.) The `<a target="_blank">` path goes through
///    on_new_window → navigate-current-webview separately.
///
/// 2. **Cmd/Ctrl/middle-click escape hatch** — power users expect modifier+
///    click to open in the system browser. Since wry's on_new_window doesn't
///    surface modifier state, we intercept the click in JS and signal Rust
///    via a navigation to a custom `myagents-internal://open-external/?url=`
///    scheme. on_navigation parses the request, opens the target in the OS
///    default browser, and cancels the navigation so the current page stays.
///    An iframe is used so the trigger doesn't replace the visible page.
const BROWSER_INIT_SCRIPT: &str = r#"
(function() {
  if (window.__myagentsBrowserShimInstalled) return;
  window.__myagentsBrowserShimInstalled = true;

  // 1. Route window.open() to current page (no multi-tab support).
  var origOpen = window.open;
  window.open = function(url, target, features) {
    if (url && /^https?:/i.test(String(url))) {
      window.location.href = String(url);
      return window;
    }
    return origOpen ? origOpen.apply(this, arguments) : null;
  };

  // 2. Cmd/Ctrl/middle-click on links → external browser via custom scheme.
  function handleClick(e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.href;
    if (!href || !/^https?:/i.test(href)) return;
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      var ifr = document.createElement('iframe');
      ifr.src = 'myagents-internal://open-external/?url=' + encodeURIComponent(href);
      ifr.style.display = 'none';
      (document.documentElement || document.body).appendChild(ifr);
      setTimeout(function() {
        if (ifr.parentNode) ifr.parentNode.removeChild(ifr);
      }, 100);
    }
  }
  document.addEventListener('click', handleClick, true);
  document.addEventListener('auxclick', handleClick, true);
})();
"#;

/// Spawn the OS default-browser opener for a URL. URL must already be
/// validated as http/https/mailto by the caller — we don't want to hand
/// arbitrary schemes (`file:`, `javascript:`, etc.) to the system opener.
///
/// `pub(crate)` so the main-window navigation handler (`lib.rs::setup`) can
/// reuse the same exec path when it intercepts an external-frame navigation
/// and reroutes it to the OS default browser.
pub(crate) fn spawn_external_open(url: &str) {
    if let Err(e) = open_external(url) {
        let target = Url::parse(url)
            .map(|parsed| describe_url_for_log(&parsed))
            .unwrap_or_else(|_| "<invalid>".to_string());
        ulog_info!(
            "[browser] spawn_external_open failed target={}: {}",
            target,
            e
        );
    }
}

/// Hand an already-validated URL to the OS and report synchronous spawn
/// failures to callers that need an explicit retry/copy affordance.
pub(crate) fn open_external(url: &str) -> Result<(), String> {
    // All three platform arms route through process_cmd::new for the
    // single-mental-model rule. The Windows arm in particular benefits —
    // `cmd /C start` is a console-subsystem binary, so CREATE_NO_WINDOW
    // (set inside process_cmd::new) actually suppresses a brief CMD window
    // flash that the previous raw Command::new spawn would have produced.
    // macOS `open` and Linux `xdg-open` are unaffected (CREATE_NO_WINDOW
    // is Windows-only).
    #[cfg(target_os = "macos")]
    let res = crate::process_cmd::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string());
    #[cfg(target_os = "windows")]
    let res = shell_execute_open(url);
    #[cfg(target_os = "linux")]
    let res = crate::process_cmd::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string());

    res
}

#[cfg(target_os = "windows")]
fn shell_execute_open(url: &str) -> Result<(), String> {
    let operation = wide_null_terminated("open");
    let target = wide_null_terminated(url);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "ShellExecuteW failed with code {}",
            result as isize
        ))
    }
}

#[cfg(target_os = "windows")]
fn wide_null_terminated(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A webview's container bounds are "degenerate" when width or height is
/// non-positive. The renderer positions the OS-level webview over a React div
/// via `getBoundingClientRect()`, and that div momentarily reports 0×N (or
/// 0×0 when `display:none`) while the split panel slides in behind a 300ms
/// width transition. Applying such bounds collapses the webview and floats it
/// over the chat area (issue #290). The renderer already filters these, but we
/// re-check here so no caller can poison the cached geometry that `SHOW`
/// restores from. NaN is non-finite, so it's caught too.
fn is_degenerate_bounds(width: f64, height: f64) -> bool {
    let usable = width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0;
    !usable
}

/// Parse a URL string that may be an absolute file path or an http(s) URL.
/// Handles both Unix (`/Users/...`) and Windows (`C:\Users\...`) paths.
fn parse_url_or_path(url: &str) -> Result<Url, String> {
    let path = Path::new(url);
    let parsed: Url = if path.is_absolute() {
        Url::from_file_path(path).map_err(|_| format!("Invalid file path: {}", url))?
    } else {
        url.parse().map_err(|e| format!("Invalid URL: {e}"))?
    };
    if parsed.scheme() == "file" {
        let local = parsed
            .to_file_path()
            .map_err(|_| "Invalid local file URL")?;
        let resolved = crate::workspace_files::read_preview::resolve_local_preview_path(
            &local.to_string_lossy(),
        )?;
        let normalized = crate::sidecar::normalize_external_path(resolved);
        let mut validated =
            Url::from_file_path(normalized).map_err(|_| "Invalid local file path")?;
        validated.set_fragment(parsed.fragment());
        validated.set_query(parsed.query());
        Ok(validated)
    } else {
        Ok(parsed)
    }
}

/// Per-tab browser session.
struct BrowserSession {
    webview_label: String,
    #[allow(dead_code)]
    tab_id: String,
    visible: bool,
    /// Cache last-known position/size for show-after-hide restoration.
    last_x: f64,
    last_y: f64,
    last_width: f64,
    last_height: f64,
}

enum BrowserGeneration {
    Creating {
        webview_label: String,
    },
    Live(BrowserSession),
    /// Close was requested before `add_child()` settled. There is no native
    /// resource to close yet; the settling create must perform that close.
    RetiringBirth,
    /// A native resource exists and remains owned until close succeeds.
    RetiringNative {
        webview_label: String,
    },
}

#[derive(Default)]
struct BrowserTabLifecycle {
    desired_token: Option<String>,
    generations: HashMap<String, BrowserGeneration>,
    /// Exact close commands can overtake their async create command. Keep a
    /// process-local tombstone so that late create is rejected before it can
    /// supersede a newer generation.
    retired_before_admit: HashSet<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum CreateSettlement {
    Publish,
    Retire(NativeClose),
}

#[derive(Debug, PartialEq, Eq)]
enum CreateAdmission {
    Create(Vec<NativeClose>),
    Retired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeClose {
    lifecycle_token: String,
    webview_label: String,
}

/// Transient authority for one native child WebView generation.
///
/// `tab_id` is durable UI scope; `lifecycle_token` is resource-instance
/// identity. A Creating reservation is installed before `add_child()`, so an
/// exact close can retire an admitted birth even while native creation is in
/// flight. This registry is intentionally process-local and non-persistent.
#[derive(Default)]
struct BrowserLifecycleRegistry {
    tabs: HashMap<String, BrowserTabLifecycle>,
}

impl BrowserLifecycleRegistry {
    fn admit_create(
        &mut self,
        tab_id: &str,
        lifecycle_token: &str,
        webview_label: &str,
    ) -> Result<CreateAdmission, String> {
        let tab = self.tabs.entry(tab_id.to_string()).or_default();
        if tab.retired_before_admit.remove(lifecycle_token) {
            self.remove_empty_tab(tab_id);
            return Ok(CreateAdmission::Retired);
        }
        if tab.generations.contains_key(lifecycle_token) {
            return Err(format!(
                "Browser generation already admitted for tab {tab_id}"
            ));
        }

        let mut close_now = Vec::new();
        for (token, generation) in &mut tab.generations {
            match generation {
                BrowserGeneration::Creating { .. } => {
                    *generation = BrowserGeneration::RetiringBirth;
                }
                BrowserGeneration::Live(session) => {
                    let webview_label = session.webview_label.clone();
                    *generation = BrowserGeneration::RetiringNative {
                        webview_label: webview_label.clone(),
                    };
                    close_now.push(NativeClose {
                        lifecycle_token: token.clone(),
                        webview_label,
                    });
                }
                BrowserGeneration::RetiringBirth | BrowserGeneration::RetiringNative { .. } => {}
            }
        }

        tab.desired_token = Some(lifecycle_token.to_string());
        tab.generations.insert(
            lifecycle_token.to_string(),
            BrowserGeneration::Creating {
                webview_label: webview_label.to_string(),
            },
        );
        Ok(CreateAdmission::Create(close_now))
    }

    fn settle_create_success(
        &mut self,
        tab_id: &str,
        lifecycle_token: &str,
        session: BrowserSession,
    ) -> CreateSettlement {
        let label = session.webview_label.clone();
        let tab = self.tabs.entry(tab_id.to_string()).or_default();
        let generation = tab.generations.remove(lifecycle_token);
        let should_publish = matches!(
            generation,
            Some(BrowserGeneration::Creating { ref webview_label })
                if webview_label == &label
        ) && tab.desired_token.as_deref() == Some(lifecycle_token);
        if should_publish {
            tab.generations.insert(
                lifecycle_token.to_string(),
                BrowserGeneration::Live(session),
            );
            CreateSettlement::Publish
        } else {
            tab.generations.insert(
                lifecycle_token.to_string(),
                BrowserGeneration::RetiringNative {
                    webview_label: label.clone(),
                },
            );
            if tab.desired_token.as_deref() == Some(lifecycle_token) {
                tab.desired_token = None;
            }
            CreateSettlement::Retire(NativeClose {
                lifecycle_token: lifecycle_token.to_string(),
                webview_label: label,
            })
        }
    }

    fn settle_create_failure(&mut self, tab_id: &str, lifecycle_token: &str) {
        let Some(tab) = self.tabs.get_mut(tab_id) else {
            return;
        };
        tab.generations.remove(lifecycle_token);
        if tab.desired_token.as_deref() == Some(lifecycle_token) {
            tab.desired_token = None;
        }
        self.remove_empty_tab(tab_id);
    }

    fn close(&mut self, tab_id: &str, lifecycle_token: &str) -> Option<NativeClose> {
        let tab = self.tabs.entry(tab_id.to_string()).or_default();
        let Some(generation) = tab.generations.get_mut(lifecycle_token) else {
            tab.retired_before_admit.insert(lifecycle_token.to_string());
            return None;
        };
        let close_now = match generation {
            BrowserGeneration::Creating { .. } => {
                *generation = BrowserGeneration::RetiringBirth;
                None
            }
            BrowserGeneration::Live(session) => {
                let webview_label = session.webview_label.clone();
                *generation = BrowserGeneration::RetiringNative {
                    webview_label: webview_label.clone(),
                };
                Some(NativeClose {
                    lifecycle_token: lifecycle_token.to_string(),
                    webview_label,
                })
            }
            BrowserGeneration::RetiringBirth => None,
            BrowserGeneration::RetiringNative { webview_label } => Some(NativeClose {
                lifecycle_token: lifecycle_token.to_string(),
                webview_label: webview_label.clone(),
            }),
        };
        if tab.desired_token.as_deref() == Some(lifecycle_token) {
            tab.desired_token = None;
        }
        close_now
    }

    fn settle_native_close_success(&mut self, tab_id: &str, close: &NativeClose) {
        let Some(tab) = self.tabs.get_mut(tab_id) else {
            return;
        };
        let matches_exact_native = matches!(
            tab.generations.get(&close.lifecycle_token),
            Some(BrowserGeneration::RetiringNative { webview_label })
                if webview_label == &close.webview_label
        );
        if matches_exact_native {
            tab.generations.remove(&close.lifecycle_token);
        }
        self.remove_empty_tab(tab_id);
    }

    fn live_session(&self, tab_id: &str, lifecycle_token: &str) -> Option<&BrowserSession> {
        match self.tabs.get(tab_id)?.generations.get(lifecycle_token)? {
            BrowserGeneration::Live(session) => Some(session),
            BrowserGeneration::Creating { .. }
            | BrowserGeneration::RetiringBirth
            | BrowserGeneration::RetiringNative { .. } => None,
        }
    }

    fn live_session_mut(
        &mut self,
        tab_id: &str,
        lifecycle_token: &str,
    ) -> Option<&mut BrowserSession> {
        match self
            .tabs
            .get_mut(tab_id)?
            .generations
            .get_mut(lifecycle_token)?
        {
            BrowserGeneration::Live(session) => Some(session),
            BrowserGeneration::Creating { .. }
            | BrowserGeneration::RetiringBirth
            | BrowserGeneration::RetiringNative { .. } => None,
        }
    }

    #[cfg(test)]
    fn has_generation(&self, tab_id: &str, lifecycle_token: &str) -> bool {
        self.tabs
            .get(tab_id)
            .is_some_and(|tab| tab.generations.contains_key(lifecycle_token))
    }

    fn drain_native(&mut self) -> Vec<String> {
        let mut labels = Vec::new();
        for tab in self.tabs.values_mut() {
            for generation in tab.generations.values() {
                match generation {
                    BrowserGeneration::Live(session) => {
                        labels.push(session.webview_label.clone());
                    }
                    BrowserGeneration::RetiringNative { webview_label } => {
                        labels.push(webview_label.clone());
                    }
                    BrowserGeneration::Creating { .. } | BrowserGeneration::RetiringBirth => {}
                }
            }
        }
        self.tabs.clear();
        labels
    }

    /// A replacement renderer cannot run the old BrowserPanel effect cleanup.
    /// Retire exact generations through the normal close transition, including
    /// admitted births which must close themselves when add_child settles.
    fn retire_renderer(&mut self) -> Vec<(String, NativeClose)> {
        let generations: Vec<_> = self
            .tabs
            .iter()
            .flat_map(|(tab_id, tab)| {
                tab.generations
                    .keys()
                    .map(move |token| (tab_id.clone(), token.clone()))
            })
            .collect();
        generations
            .into_iter()
            .filter_map(|(tab_id, token)| self.close(&tab_id, &token).map(|close| (tab_id, close)))
            .collect()
    }

    fn native_count(&self) -> usize {
        self.tabs
            .values()
            .map(|tab| {
                tab.generations
                    .values()
                    .filter(|generation| {
                        matches!(
                            generation,
                            BrowserGeneration::Live(_) | BrowserGeneration::RetiringNative { .. }
                        )
                    })
                    .count()
            })
            .sum()
    }

    fn remove_empty_tab(&mut self, tab_id: &str) {
        if self.tabs.get(tab_id).is_some_and(|tab| {
            tab.generations.is_empty()
                && tab.retired_before_admit.is_empty()
                && tab.desired_token.is_none()
        }) {
            self.tabs.remove(tab_id);
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

pub struct BrowserManager {
    lifecycle: Mutex<BrowserLifecycleRegistry>,
}

impl BrowserManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            lifecycle: Mutex::new(BrowserLifecycleRegistry::default()),
        })
    }

    pub(crate) async fn retire_renderer_resources<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<(), String> {
        let retiring = self.lifecycle.lock().await.retire_renderer();
        for (tab_id, close) in retiring {
            close_webview_label(app, &close.webview_label)?;
            self.lifecycle
                .lock()
                .await
                .settle_native_close_success(&tab_id, &close);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) async fn insert_test_live_browser(&self, tab_id: &str, token: &str, label: &str) {
        let mut lifecycle = self.lifecycle.lock().await;
        lifecycle.admit_create(tab_id, token, label).unwrap();
        assert_eq!(
            lifecycle.settle_create_success(
                tab_id,
                token,
                BrowserSession {
                    webview_label: label.into(),
                    tab_id: tab_id.into(),
                    visible: true,
                    last_x: 0.,
                    last_y: 0.,
                    last_width: 200.,
                    last_height: 200.,
                }
            ),
            CreateSettlement::Publish
        );
    }
}

fn validate_lifecycle_token(lifecycle_token: &str) -> Result<(), String> {
    Uuid::parse_str(lifecycle_token)
        .map(|_| ())
        .map_err(|_| "Invalid browser lifecycle token".to_string())
}

fn browser_event_name(kind: &str, tab_id: &str, lifecycle_token: &str) -> String {
    format!("browser:{kind}:{tab_id}:{lifecycle_token}")
}

fn describe_url_for_log(url: &Url) -> String {
    match url.scheme() {
        "file" => "file://<local>".to_string(),
        scheme => url
            .host_str()
            .map(|host| format!("{scheme}://{host}"))
            .unwrap_or_else(|| format!("{scheme}:<internal>")),
    }
}

fn close_webview_label<R: tauri::Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    if let Some(webview) = app.get_webview(label) {
        webview.close().map_err(|error| {
            ulog_warn!("[browser] close failed label={}: {}", label, error);
            format!("Failed to close browser webview label={label}: {error}")
        })?;
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────
// IPC Commands
// ──────────────────────────────────────────────────────────

/// Create a child Webview for the given tab, positioned at (x, y) with (width, height).
#[tauri::command]
pub async fn cmd_browser_create(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    lifecycle_token: String,
    url: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let _lifecycle_spawn_permit = crate::sidecar::begin_lifecycle_spawn_permit()?;
    validate_lifecycle_token(&lifecycle_token)?;
    let label = format!("browser-{}-{}", tab_id, lifecycle_token);
    let BrowserBounds {
        x,
        y,
        width,
        height,
    } = bounds;

    ulog_info!(
        "[browser] cmd_browser_create: tab={} generation={} pos=({},{}) size={}x{}",
        tab_id,
        lifecycle_token,
        x,
        y,
        width,
        height
    );

    // Clamp degenerate bounds up to a 1px floor so the OS webview is never born
    // collapsed and — critically — the cached `last_width/height` (which SHOW
    // restores from) can never be seeded with zeros (issue #290). The renderer
    // already defers creation until the container is laid out, so this only
    // fires for an unexpected/future caller; the post-create ResizeObserver
    // immediately corrects the size. NaN/non-finite are caught by the same
    // guard since they aren't `> 0.0`.
    let (width, height) = if is_degenerate_bounds(width, height) {
        ulog_info!(
            "[browser] cmd_browser_create: clamping degenerate bounds {}x{} to 1px floor for tab {}",
            width, height, tab_id
        );
        (width.max(1.0), height.max(1.0))
    } else {
        (width, height)
    };

    let parsed_url = parse_url_or_path(&url)?;

    // Resolve fallible prerequisites before reserving, then publish birth
    // intent before the native add_child call. A matching close can now see
    // and retire this exact generation throughout native creation.
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let admission = state
        .lifecycle
        .lock()
        .await
        .admit_create(&tab_id, &lifecycle_token, &label)?;
    let CreateAdmission::Create(superseded_generations) = admission else {
        ulog_info!(
            "[browser] create skipped for pre-retired tab={} generation={}",
            tab_id,
            lifecycle_token
        );
        return Ok(());
    };
    for superseded in superseded_generations {
        if let Err(error) = close_webview_label(&app, &superseded.webview_label) {
            state
                .lifecycle
                .lock()
                .await
                .settle_create_failure(&tab_id, &lifecycle_token);
            return Err(error);
        }
        state
            .lifecycle
            .lock()
            .await
            .settle_native_close_success(&tab_id, &superseded);
    }

    // Clone values for closures
    let app_nav = app.clone();
    let tab_id_nav = tab_id.clone();
    let lifecycle_token_nav = lifecycle_token.clone();
    let app_load = app.clone();
    let tab_id_load = tab_id.clone();
    let lifecycle_token_load = lifecycle_token.clone();
    let app_new_win = app.clone();
    let label_new_win = label.clone();

    let builder = WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed_url.clone()))
        .scroll_bar_style(crate::webview_policy::scroll_bar_style())
        .user_agent(BROWSER_USER_AGENT)
        .initialization_script(BROWSER_INIT_SCRIPT)
        .on_navigation(move |nav_url| {
            let scheme = nav_url.scheme();
            // Security: block dangerous schemes; allow everything else.
            // file: is allowed — used for local HTML preview; the webview is
            // already sandboxed (browser.json zero Tauri permissions).
            if scheme == "javascript" {
                ulog_info!(
                    "[browser] on_navigation BLOCKED target={}",
                    describe_url_for_log(nav_url)
                );
                return false;
            }
            // Internal signaling channel: BROWSER_INIT_SCRIPT triggers an
            // iframe nav to myagents-internal://open-external/?url=… on
            // Cmd/Ctrl/middle-click. Hand the URL to the OS default browser
            // and cancel the navigation so the current page is undisturbed.
            if scheme == "myagents-internal" && nav_url.host_str() == Some("open-external") {
                let target_str = nav_url
                    .query_pairs()
                    .find(|(k, _)| k == "url")
                    .map(|(_, v)| v.into_owned());
                if let Some(target_str) = target_str {
                    if let Ok(target) = Url::parse(&target_str) {
                        if matches!(target.scheme(), "http" | "https" | "mailto") {
                            ulog_info!(
                                "[browser] open-external (Cmd/Ctrl/middle-click) target={}",
                                describe_url_for_log(&target)
                            );
                            spawn_external_open(target.as_str());
                        } else {
                            ulog_info!(
                                "[browser] open-external rejected non-allowlisted scheme: {}",
                                target.scheme()
                            );
                        }
                    }
                }
                return false;
            }
            // Emit URL changes for http/https/file (skip about:, data:, blob: noise)
            if scheme == "http" || scheme == "https" || scheme == "file" {
                ulog_info!(
                    "[browser] on_navigation ALLOW target={}",
                    describe_url_for_log(nav_url)
                );
                let _ = app_nav.emit(
                    &browser_event_name("url-changed", &tab_id_nav, &lifecycle_token_nav),
                    nav_url.to_string(),
                );
            } else {
                ulog_info!(
                    "[browser] on_navigation ALLOW target={}",
                    describe_url_for_log(nav_url)
                );
            }
            true
        })
        .on_page_load(move |_webview, payload| {
            let url_str = payload.url().to_string();
            let event_name = browser_event_name("loading", &tab_id_load, &lifecycle_token_load);
            match payload.event() {
                PageLoadEvent::Started => {
                    ulog_info!(
                        "[browser] on_page_load STARTED target={}",
                        describe_url_for_log(payload.url())
                    );
                    let _ = app_load.emit(&event_name, true);
                }
                PageLoadEvent::Finished => {
                    ulog_info!(
                        "[browser] on_page_load FINISHED target={}",
                        describe_url_for_log(payload.url())
                    );
                    let _ = app_load.emit(&event_name, false);
                    // Use the load-event's payload URL — calling _webview.url()
                    // here panics inside wry's url_from_webview when WKWebView.URL
                    // is nil (notably for about:blank in transient states), which
                    // tao's stop_app_on_panic then escalates to a process crash.
                    let _ = app_load.emit(
                        &browser_event_name("url-changed", &tab_id_load, &lifecycle_token_load),
                        url_str.clone(),
                    );
                }
            }
        })
        .on_new_window(move |url, _features| {
            ulog_info!(
                "[browser] on_new_window target={} — redirecting to exact generation",
                describe_url_for_log(&url)
            );
            // Redirect target="_blank" / window.open() into the current webview
            let app = app_new_win.clone();
            let lbl = label_new_win.clone();
            let nav_url = url.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(webview) = app.get_webview(&lbl) {
                    let _ = webview.navigate(nav_url);
                }
            });
            tauri::webview::NewWindowResponse::Deny
        });

    let position = LogicalPosition::new(x, y);
    let size = LogicalSize::new(width, height);

    ulog_info!(
        "[browser] Calling window.add_child for label='{}' target={}",
        label,
        describe_url_for_log(&parsed_url)
    );
    if let Err(error) = window.add_child(builder, position, size) {
        state
            .lifecycle
            .lock()
            .await
            .settle_create_failure(&tab_id, &lifecycle_token);
        ulog_info!("[browser] add_child FAILED: {}", error);
        return Err(format!("Failed to create browser webview: {error}"));
    }

    ulog_info!("[browser] add_child SUCCESS for label='{}'", label);

    // NOTE: do NOT call `app.get_webview(&label).url()` here as a "health check".
    // wry's url_from_webview unwraps WKWebView.URL which may be nil for a
    // freshly-created webview (especially about:blank), and that unwrap panic
    // crashes the whole event loop via tao's stop_app_on_panic. See
    // wry-0.54.4/src/wkwebview/mod.rs:1349. add_child returning Ok is itself
    // sufficient evidence that the webview was created.

    let settlement = state.lifecycle.lock().await.settle_create_success(
        &tab_id,
        &lifecycle_token,
        BrowserSession {
            webview_label: label.clone(),
            tab_id: tab_id.clone(),
            visible: true,
            last_x: x,
            last_y: y,
            last_width: width,
            last_height: height,
        },
    );
    match settlement {
        CreateSettlement::Publish => {
            ulog_info!(
                "[browser] Created webview '{}' for tab {} generation={} — published",
                label,
                tab_id,
                lifecycle_token
            );
        }
        CreateSettlement::Retire(retired) => {
            close_webview_label(&app, &retired.webview_label)?;
            state
                .lifecycle
                .lock()
                .await
                .settle_native_close_success(&tab_id, &retired);
            ulog_info!(
                "[browser] Retired stale birth '{}' for tab {} generation={}",
                retired.webview_label,
                tab_id,
                lifecycle_token
            );
        }
    }
    Ok(())
}

/// Navigate the existing browser webview to a new URL.
#[tauri::command]
pub async fn cmd_browser_navigate(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    lifecycle_token: String,
    url: String,
) -> Result<(), String> {
    validate_lifecycle_token(&lifecycle_token)?;
    ulog_info!(
        "[browser] cmd_browser_navigate: tab={} generation={}",
        tab_id,
        lifecycle_token
    );
    let lifecycle = state.lifecycle.lock().await;
    let session = lifecycle
        .live_session(&tab_id, &lifecycle_token)
        .ok_or_else(|| format!("No matching browser generation for tab {}", tab_id))?;

    let parsed_url = parse_url_or_path(&url)?;
    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .navigate(parsed_url)
        .map_err(|e| format!("Navigation failed: {e}"))
}

/// Go back in browser history.
#[tauri::command]
pub async fn cmd_browser_go_back(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    lifecycle_token: String,
) -> Result<(), String> {
    validate_lifecycle_token(&lifecycle_token)?;
    let lifecycle = state.lifecycle.lock().await;
    let session = lifecycle
        .live_session(&tab_id, &lifecycle_token)
        .ok_or_else(|| format!("No matching browser generation for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .eval("window.history.back()")
        .map_err(|e| format!("Go back failed: {e}"))
}

/// Go forward in browser history.
#[tauri::command]
pub async fn cmd_browser_go_forward(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    lifecycle_token: String,
) -> Result<(), String> {
    validate_lifecycle_token(&lifecycle_token)?;
    let lifecycle = state.lifecycle.lock().await;
    let session = lifecycle
        .live_session(&tab_id, &lifecycle_token)
        .ok_or_else(|| format!("No matching browser generation for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .eval("window.history.forward()")
        .map_err(|e| format!("Go forward failed: {e}"))
}

/// Reload the current page.
#[tauri::command]
pub async fn cmd_browser_reload(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    lifecycle_token: String,
) -> Result<(), String> {
    validate_lifecycle_token(&lifecycle_token)?;
    let lifecycle = state.lifecycle.lock().await;
    let session = lifecycle
        .live_session(&tab_id, &lifecycle_token)
        .ok_or_else(|| format!("No matching browser generation for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview.reload().map_err(|e| format!("Reload failed: {e}"))
}

/// Stop the current load without navigating or replacing this generation.
#[tauri::command]
pub async fn cmd_browser_stop(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    lifecycle_token: String,
) -> Result<(), String> {
    validate_lifecycle_token(&lifecycle_token)?;
    let lifecycle = state.lifecycle.lock().await;
    let session = lifecycle
        .live_session(&tab_id, &lifecycle_token)
        .ok_or_else(|| format!("No matching browser generation for tab {}", tab_id))?;
    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;
    webview
        .eval("window.stop()")
        .map_err(|e| format!("Stop loading failed: {e}"))?;
    // A stopped navigation need not emit PageLoadEvent::Finished.
    let _ = app.emit(
        &browser_event_name("loading", &tab_id, &lifecycle_token),
        false,
    );
    Ok(())
}

/// Update webview position and size.
#[tauri::command]
pub async fn cmd_browser_resize(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    lifecycle_token: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    validate_lifecycle_token(&lifecycle_token)?;
    let BrowserBounds {
        x,
        y,
        width,
        height,
    } = bounds;
    // Drop degenerate resizes (width/height ≤ 0) instead of collapsing the
    // webview and caching zeros that a later SHOW would restore (issue #290).
    // Keep the last good geometry untouched so the next valid resize wins.
    if is_degenerate_bounds(width, height) {
        ulog_info!(
            "[browser] cmd_browser_resize: ignoring degenerate bounds for tab {} — pos=({},{}) size={}x{}",
            tab_id,
            x,
            y,
            width,
            height
        );
        return Ok(());
    }

    let mut lifecycle = state.lifecycle.lock().await;
    let session = lifecycle
        .live_session_mut(&tab_id, &lifecycle_token)
        .ok_or_else(|| format!("No matching browser generation for tab {}", tab_id))?;

    // Update cached position
    session.last_x = x;
    session.last_y = y;
    session.last_width = width;
    session.last_height = height;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    // Propagate (don't swallow) native geometry failures: the renderer's
    // reconciler marks bounds as synced when this command resolves, so a
    // silently-dropped set_position/set_size would park the OS webview at
    // stale bounds with no retry scheduled and zero diagnostic trail (issue
    // #339 post-mortem). Returning Err makes the renderer clear its synced
    // marker and retry on the next frame. Errors are exceptional (webview
    // teardown races), so the log cannot spam.
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| {
            ulog_warn!(
                "[browser] set_position({}, {}) failed for tab {}: {}",
                x,
                y,
                tab_id,
                e
            );
            format!("set_position failed: {e}")
        })?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| {
            ulog_warn!(
                "[browser] set_size({}x{}) failed for tab {}: {}",
                width,
                height,
                tab_id,
                e
            );
            format!("set_size failed: {e}")
        })?;
    Ok(())
}

/// Show the browser webview (restore from hidden state).
#[tauri::command]
pub async fn cmd_browser_show(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    lifecycle_token: String,
) -> Result<(), String> {
    validate_lifecycle_token(&lifecycle_token)?;
    let mut lifecycle = state.lifecycle.lock().await;
    let session = lifecycle
        .live_session_mut(&tab_id, &lifecycle_token)
        .ok_or_else(|| format!("No matching browser generation for tab {}", tab_id))?;

    if session.visible {
        return Ok(());
    }

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    // Restore position and show
    if let Err(e) = webview.set_position(LogicalPosition::new(session.last_x, session.last_y)) {
        ulog_warn!(
            "[browser] SHOW set_position failed for tab {}: {}",
            tab_id,
            e
        );
    }
    if let Err(e) = webview.set_size(LogicalSize::new(session.last_width, session.last_height)) {
        ulog_warn!("[browser] SHOW set_size failed for tab {}: {}", tab_id, e);
    }
    let _ = webview.show();
    session.visible = true;
    ulog_info!(
        "[browser] SHOW webview '{}' at ({},{}) {}x{}",
        session.webview_label,
        session.last_x,
        session.last_y,
        session.last_width,
        session.last_height
    );
    Ok(())
}

/// Hide the browser webview (move off-screen).
#[tauri::command]
pub async fn cmd_browser_hide(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    lifecycle_token: String,
) -> Result<(), String> {
    validate_lifecycle_token(&lifecycle_token)?;
    let mut lifecycle = state.lifecycle.lock().await;
    let session = lifecycle
        .live_session_mut(&tab_id, &lifecycle_token)
        .ok_or_else(|| format!("No matching browser generation for tab {}", tab_id))?;

    if !session.visible {
        return Ok(());
    }

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    let _ = webview.hide();
    session.visible = false;
    ulog_info!("[browser] HIDE webview '{}'", session.webview_label);
    Ok(())
}

/// Destroy the browser webview for a tab.
#[tauri::command]
pub async fn cmd_browser_close(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    lifecycle_token: String,
) -> Result<(), String> {
    validate_lifecycle_token(&lifecycle_token)?;
    let close_now = state
        .lifecycle
        .lock()
        .await
        .close(&tab_id, &lifecycle_token);
    if let Some(close) = close_now {
        close_webview_label(&app, &close.webview_label)?;
        state
            .lifecycle
            .lock()
            .await
            .settle_native_close_success(&tab_id, &close);
        ulog_info!(
            "[browser] Closed webview '{}' for tab {} generation={}",
            close.webview_label,
            tab_id,
            lifecycle_token
        );
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────

/// Close all browser webviews (app exit cleanup).
pub async fn close_all_browsers(state: &Arc<BrowserManager>, app: &AppHandle) {
    let mut lifecycle = state.lifecycle.lock().await;
    let count = lifecycle.native_count();
    for label in lifecycle.drain_native() {
        let _ = close_webview_label(app, &label);
    }
    if count > 0 {
        ulog_info!("[browser] Closed {} browser(s) on shutdown", count);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn local_browser_urls_are_validated_without_loading_source() {
        let ws = crate::workspace_files::test_support::make_test_workspace("browser_url");
        let path = ws.join("报告 #1.html");
        std::fs::write(&path, "x".repeat(4_037_468)).unwrap();
        let parsed = super::parse_url_or_path(&path.to_string_lossy()).unwrap();
        let mut anchored = parsed.clone();
        anchored.set_fragment(Some("summary"));
        assert_eq!(
            super::parse_url_or_path(anchored.as_str())
                .unwrap()
                .fragment(),
            Some("summary")
        );
        assert!(super::parse_url_or_path(&ws.to_string_lossy()).is_err());
        assert!(super::parse_url_or_path(&ws.join("missing.html").to_string_lossy()).is_err());
        assert_eq!(
            super::parse_url_or_path("https://example.com/report")
                .unwrap()
                .scheme(),
            "https"
        );
        std::fs::remove_dir_all(ws).unwrap();
    }

    #[cfg(target_os = "windows")]
    use super::wide_null_terminated;
    use super::{
        is_degenerate_bounds, BrowserLifecycleRegistry, CreateAdmission, CreateSettlement,
        NativeClose,
    };

    // Issue #290: the renderer can hand us a 0-width container reading while
    // the split panel's width transition is mid-flight. These must be rejected
    // so the OS webview is never collapsed / mis-positioned over the chat.
    #[test]
    fn degenerate_bounds_are_rejected() {
        assert!(is_degenerate_bounds(0.0, 662.0)); // the exact bug read
        assert!(is_degenerate_bounds(640.0, 0.0));
        assert!(is_degenerate_bounds(0.0, 0.0));
        assert!(is_degenerate_bounds(-1.0, 600.0));
        assert!(is_degenerate_bounds(600.0, -1.0));
        assert!(is_degenerate_bounds(f64::NAN, 600.0));
    }

    #[test]
    fn real_bounds_are_accepted() {
        assert!(!is_degenerate_bounds(694.0, 662.0));
        assert!(!is_degenerate_bounds(1.0, 1.0));
    }

    #[test]
    fn renderer_retirement_covers_live_and_pending_births_without_touching_replacements() {
        let mut registry = BrowserLifecycleRegistry::default();
        registry
            .admit_create("live", "old-live", "browser-live")
            .unwrap();
        registry.settle_create_success("live", "old-live", session("browser-live"));
        registry
            .admit_create("pending", "old-pending", "browser-pending")
            .unwrap();

        let retiring = registry.retire_renderer();
        assert_eq!(retiring.len(), 1);
        assert_eq!(retiring[0].0, "live");
        assert!(registry.live_session("live", "old-live").is_none());
        // An unsuccessful native close remains tracked and is retryable.
        assert_eq!(registry.retire_renderer(), retiring);

        registry.admit_create("live", "new", "browser-new").unwrap();
        registry.settle_create_success("live", "new", session("browser-new"));
        registry.settle_native_close_success("live", &retiring[0].1);
        assert!(registry.live_session("live", "new").is_some());
        let late_close = match registry.settle_create_success(
            "pending",
            "old-pending",
            session("browser-pending"),
        ) {
            CreateSettlement::Retire(close) => close,
            CreateSettlement::Publish => panic!("old renderer birth must not publish"),
        };
        registry.settle_native_close_success("pending", &late_close);
        assert!(!registry.has_generation("pending", "old-pending"));
    }

    #[test]
    fn close_during_create_retires_the_late_native_birth_once() {
        let mut registry = BrowserLifecycleRegistry::default();
        let admitted = registry
            .admit_create("tab-a", "generation-a", "browser-a")
            .unwrap();
        assert_eq!(admitted, CreateAdmission::Create(Vec::new()));
        assert!(registry.close("tab-a", "generation-a").is_none());

        let retired = NativeClose {
            lifecycle_token: "generation-a".to_string(),
            webview_label: "browser-a".to_string(),
        };
        assert_eq!(
            registry.settle_create_success("tab-a", "generation-a", session("browser-a")),
            CreateSettlement::Retire(retired.clone())
        );
        assert!(registry.has_generation("tab-a", "generation-a"));
        registry.settle_native_close_success("tab-a", &retired);
        assert!(!registry.has_generation("tab-a", "generation-a"));
    }

    #[test]
    fn close_that_overtakes_create_tombstones_only_that_exact_generation() {
        let mut registry = BrowserLifecycleRegistry::default();
        assert!(registry.close("tab-a", "generation-a").is_none());
        registry
            .admit_create("tab-a", "generation-b", "browser-b")
            .unwrap();
        assert_eq!(
            registry.settle_create_success("tab-a", "generation-b", session("browser-b")),
            CreateSettlement::Publish,
        );

        assert_eq!(
            registry
                .admit_create("tab-a", "generation-a", "browser-a")
                .unwrap(),
            CreateAdmission::Retired,
        );
        assert_eq!(
            registry
                .live_session("tab-a", "generation-b")
                .map(|value| value.webview_label.as_str()),
            Some("browser-b"),
        );
    }

    #[test]
    fn reopening_supersedes_creating_and_live_generations_without_stale_writes() {
        let mut registry = BrowserLifecycleRegistry::default();
        registry
            .admit_create("tab-a", "generation-a", "browser-a")
            .unwrap();
        registry
            .admit_create("tab-a", "generation-b", "browser-b")
            .unwrap();

        let retired_a =
            match registry.settle_create_success("tab-a", "generation-a", session("browser-a")) {
                CreateSettlement::Retire(close) => close,
                CreateSettlement::Publish => panic!("stale generation must retire"),
            };
        registry.settle_native_close_success("tab-a", &retired_a);
        assert_eq!(
            registry.settle_create_success("tab-a", "generation-b", session("browser-b")),
            CreateSettlement::Publish,
        );
        assert!(registry.live_session("tab-a", "generation-a").is_none());
        assert_eq!(
            registry
                .live_session("tab-a", "generation-b")
                .map(|value| value.webview_label.as_str()),
            Some("browser-b"),
        );

        assert!(registry.close("tab-a", "generation-a").is_none());
        assert_eq!(
            registry
                .live_session("tab-a", "generation-b")
                .map(|value| value.webview_label.as_str()),
            Some("browser-b"),
        );
    }

    #[test]
    fn superseding_a_live_generation_returns_only_its_exact_native_label() {
        let mut registry = BrowserLifecycleRegistry::default();
        registry
            .admit_create("tab-a", "generation-a", "browser-a")
            .unwrap();
        assert_eq!(
            registry.settle_create_success("tab-a", "generation-a", session("browser-a")),
            CreateSettlement::Publish,
        );

        assert_eq!(
            registry
                .admit_create("tab-a", "generation-b", "browser-b")
                .unwrap(),
            CreateAdmission::Create(vec![NativeClose {
                lifecycle_token: "generation-a".to_string(),
                webview_label: "browser-a".to_string(),
            }])
        );
        assert!(registry.live_session("tab-a", "generation-a").is_none());
    }

    #[test]
    fn native_close_failure_keeps_exact_generation_tracked_for_retry_and_shutdown() {
        let mut registry = BrowserLifecycleRegistry::default();
        registry
            .admit_create("tab-a", "generation-a", "browser-a")
            .unwrap();
        assert_eq!(
            registry.settle_create_success("tab-a", "generation-a", session("browser-a")),
            CreateSettlement::Publish,
        );

        let first_close = registry.close("tab-a", "generation-a").unwrap();
        assert!(registry.has_generation("tab-a", "generation-a"));
        assert_eq!(
            registry.close("tab-a", "generation-a"),
            Some(first_close.clone()),
        );
        assert_eq!(registry.native_count(), 1);
        assert_eq!(registry.drain_native(), vec!["browser-a".to_string()]);
    }

    #[test]
    fn stale_non_close_lookup_never_resolves_to_the_new_live_generation() {
        let mut registry = BrowserLifecycleRegistry::default();
        registry
            .admit_create("tab-a", "generation-a", "browser-a")
            .unwrap();
        registry
            .admit_create("tab-a", "generation-b", "browser-b")
            .unwrap();
        let retired_a =
            match registry.settle_create_success("tab-a", "generation-a", session("browser-a")) {
                CreateSettlement::Retire(close) => close,
                CreateSettlement::Publish => panic!("stale generation must retire"),
            };
        registry.settle_native_close_success("tab-a", &retired_a);
        assert_eq!(
            registry.settle_create_success("tab-a", "generation-b", session("browser-b")),
            CreateSettlement::Publish,
        );

        assert!(registry.live_session("tab-a", "generation-a").is_none());
        assert!(registry.live_session_mut("tab-a", "generation-a").is_none());
        assert_eq!(
            registry
                .live_session("tab-a", "generation-b")
                .map(|session| session.webview_label.as_str()),
            Some("browser-b"),
        );
    }

    #[test]
    fn failed_birth_clears_only_its_reservation_and_allows_a_retry() {
        let mut registry = BrowserLifecycleRegistry::default();
        registry
            .admit_create("tab-a", "generation-a", "browser-a")
            .unwrap();
        registry.settle_create_failure("tab-a", "generation-a");
        assert!(!registry.has_generation("tab-a", "generation-a"));
        assert!(registry
            .admit_create("tab-a", "generation-b", "browser-b")
            .is_ok());
    }

    fn session(label: &str) -> super::BrowserSession {
        super::BrowserSession {
            webview_label: label.to_string(),
            tab_id: "tab-a".to_string(),
            visible: true,
            last_x: 0.0,
            last_y: 0.0,
            last_width: 640.0,
            last_height: 480.0,
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_external_open_preserves_oauth_query_parameters() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=437924003108-example.apps.googleusercontent.com&response_type=code&scope=openid%20email&redirect_uri=https%3A%2F%2Fspace.myagents.io%2Fapi%2Fauth%2Fgoogle%2Fcallback&state=abc";
        let encoded = wide_null_terminated(url);
        assert_eq!(encoded.last().copied(), Some(0));
        assert_eq!(
            String::from_utf16(&encoded[..encoded.len() - 1]).unwrap(),
            url
        );
    }
}
