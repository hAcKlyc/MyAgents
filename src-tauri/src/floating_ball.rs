// Floating ball desktop companion (PRD 0.2.35/0.2.34 desktop pet).
//
// Platform-native floating tool windows. Peek mode must not activate the app,
// so the user's frontmost app keeps focus:
//
//   fb-ball       92×92 transparent panel, can_become_key_window = false.
//                 Pure visual + mouse target. Hover/click logic lives in the
//                 webview (src/renderer/floating-ball/BallWindow.tsx).
//   fb-companion  chat panel. Peek is visual-only; pin activates/focuses the
//                 companion long enough for keyboard input and restores the
//                 previous foreground window when hidden where the OS allows.
//   fb-shield     macOS-only transparent panel shown below ball/companion while
//                 pinned. It owns first outside-click consumption so dismissing
//                 the companion does not also activate/click the app underneath.
//
// Context probes (frontmost app / selection where supported / screenshot) are
// Tauri commands (D9: OS-level work goes through Rust invoke, never sidecar
// HTTP). Selection capture is only called on explicit summon — never on hover
// (PRD D3 red line: the macOS clipboard fallback inside get-selected-text
// simulates Cmd+C and must never run on a fly-by hover).
//
// macOS and Windows provide native floating-window implementations; Linux and
// other desktop targets compile a stub that reports `supported: false`.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

const FLOATING_BALL_COMPANION_OWNER_ID: &str = "floating-ball";
static COMPANION_OWNER_ADMITTED: AtomicBool = AtomicBool::new(false);
#[cfg(any(target_os = "macos", target_os = "windows"))]
static NATIVE_LIFECYCLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn lock_native_lifecycle() -> std::sync::MutexGuard<'static, ()> {
    NATIVE_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn sidecar_owner_admitted(owner: &crate::sidecar::SidecarOwner) -> bool {
    !is_floating_ball_companion_owner(owner) || COMPANION_OWNER_ADMITTED.load(Ordering::SeqCst)
}

fn is_floating_ball_companion_owner(owner: &crate::sidecar::SidecarOwner) -> bool {
    matches!(
        owner,
        crate::sidecar::SidecarOwner::Companion(owner_id)
            if owner_id == FLOATING_BALL_COMPANION_OWNER_ID
    )
}

fn lifecycle_generation_is_current(current: u64, captured: u64) -> bool {
    current == captured
}

fn startup_enable_is_authorized(admitted: bool, dev_gate: bool, enabled: bool) -> bool {
    admitted && dev_gate && enabled
}

fn set_companion_owner_admitted(admitted: bool) {
    COMPANION_OWNER_ADMITTED.store(admitted, Ordering::SeqCst);
}

fn floating_ball_companion_owner() -> crate::sidecar::SidecarOwner {
    crate::sidecar::SidecarOwner::Companion(FLOATING_BALL_COMPANION_OWNER_ID.to_string())
}

#[cfg(any(target_os = "macos", test))]
const MACOS_SURFACE_LABELS: &[&str] = &["fb-companion", "fb-shield", "fb-ball"];
#[cfg(any(target_os = "windows", test))]
const WINDOWS_SURFACE_LABELS: &[&str] = &["fb-companion", "fb-ball"];

#[cfg(test)]
mod lifecycle_policy_tests {
    use super::{
        is_floating_ball_companion_owner, lifecycle_generation_is_current,
        startup_enable_is_authorized, MACOS_SURFACE_LABELS, WINDOWS_SURFACE_LABELS,
    };
    use crate::sidecar::SidecarOwner;

    #[test]
    fn native_teardown_covers_the_complete_platform_surface_set() {
        assert_eq!(
            MACOS_SURFACE_LABELS,
            &["fb-companion", "fb-shield", "fb-ball"]
        );
        assert_eq!(WINDOWS_SURFACE_LABELS, &["fb-companion", "fb-ball"]);
    }

    #[test]
    fn only_the_exact_desktop_pet_companion_owner_uses_feature_admission() {
        assert!(is_floating_ball_companion_owner(&SidecarOwner::Companion(
            "floating-ball".to_string()
        )));
        assert!(!is_floating_ball_companion_owner(&SidecarOwner::Companion(
            "other".to_string()
        )));
        assert!(!is_floating_ball_companion_owner(&SidecarOwner::Tab(
            "floating-ball".to_string()
        )));
    }

    #[test]
    fn retired_poller_generation_cannot_act_on_recreated_surface_labels() {
        assert!(lifecycle_generation_is_current(7, 7));
        assert!(!lifecycle_generation_is_current(8, 7));
    }

    #[test]
    fn newer_disable_cancels_delayed_startup_enable_even_before_config_commit() {
        assert!(startup_enable_is_authorized(true, true, true));
        assert!(!startup_enable_is_authorized(false, true, true));
        assert!(!startup_enable_is_authorized(true, false, true));
        assert!(!startup_enable_is_authorized(true, true, false));
    }
}

/// Renderer-facing snapshot of what this build can do.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbCapabilities {
    pub supported: bool,
    pub active: bool,
}

/// Eager context captured at explicit summon time (PRD §5.1).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbContext {
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub selection: Option<String>,
}

/// 📷 快门结果：图 + 快门按下那一刻的前台窗口标识。引用条用窗口名当
/// 标签（比"屏幕截图 · 刚刚"信息量大），缩略图/大图直接用 data URL。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbScreenshot {
    pub data_url: String,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
}

/// Persisted ball placement — `~/.myagents/floating_ball.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FbPlacement {
    pub dock: String, // "left" | "right"
    /// Vertical position as a fraction of the monitor work-area height, so the
    /// ball lands in the same relative spot across resolution changes.
    pub y_ratio: f64,
    /// 吸附时所在显示器（tao monitor name，形如 "Monitor #<model>"）。boot
    /// 恢复按名匹配，找不到（拔了外接屏）回退球心所在屏/主屏。旧配置文件
    /// 无此字段 → None（serde default，红线同 CronTask 新字段）。
    #[serde(default)]
    pub monitor: Option<String>,
}

impl Default for FbPlacement {
    fn default() -> Self {
        Self {
            dock: "right".to_string(),
            y_ratio: 0.36,
            monitor: None,
        }
    }
}

/// Mirror of the renderer's gate fields in `~/.myagents/config.json`.
/// Read directly from disk (same pattern as `global_shortcut::load_config`)
/// so startup doesn't depend on the frontend being mounted.
#[derive(Debug, Clone)]
pub struct FbConfig {
    pub dev_gate: bool,
    pub enabled: bool,
}

impl Default for FbConfig {
    fn default() -> Self {
        Self {
            dev_gate: true,
            enabled: false,
        }
    }
}

pub fn load_fb_config() -> FbConfig {
    let Some(dir) = crate::app_dirs::myagents_data_dir() else {
        return FbConfig::default();
    };
    let Ok(content) = std::fs::read_to_string(dir.join("config.json")) else {
        return FbConfig::default();
    };
    let Ok(cfg) = serde_json::from_str::<serde_json::Value>(crate::utils::bom::strip_bom(&content))
    else {
        return FbConfig::default();
    };
    FbConfig {
        dev_gate: cfg
            .get("floatingBallDevGate")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        enabled: cfg
            .get("floatingBallEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

// ════════════════════════════════════════════════════════════════════════
// macOS implementation
// ════════════════════════════════════════════════════════════════════════
#[cfg(target_os = "macos")]
mod imp {
    use super::{FbCapabilities, FbContext, FbPlacement};
    use crate::{ulog_error, ulog_info, ulog_warn};
    use serde::Serialize;
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    };
    use tauri::{
        AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
    };
    use tauri_nspanel::{
        tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt,
    };

    pub const BALL_LABEL: &str = "fb-ball";
    pub const SHIELD_LABEL: &str = "fb-shield";
    pub const COMPANION_LABEL: &str = "fb-companion";

    const BALL_WIN: f64 = 92.0;
    const EDGE_MARGIN: f64 = 6.0;
    const COMPANION_W: f64 = 440.0;
    const COMPANION_H: f64 = 660.0;
    const COMPANION_GAP: f64 = 10.0;

    type RunningApplication =
        tauri_nspanel::objc2::rc::Retained<tauri_nspanel::objc2_app_kit::NSRunningApplication>;

    thread_local! {
        static PIN_FOREGROUND_APP: RefCell<Option<RunningApplication>> = const { RefCell::new(None) };
    }

    tauri_panel! {
        // The ball never takes keyboard focus — pure visual + mouse target.
        panel!(FbBallPanel {
            config: {
                can_become_key_window: false,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })

        // Invisible click shield shown only while the companion is pinned.
        // It sits below the ball/companion but above normal app windows, so
        // the first outside click dismisses us instead of reaching the app
        // underneath.
        panel!(FbShieldPanel {
            config: {
                can_become_key_window: false,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })

        // The companion can become key (so the user can type) but only when we
        // explicitly call make_key_window — `becomes_key_only_if_needed` keeps
        // order_front_regardless (peek) from stealing focus.
        panel!(FbCompanionPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                becomes_key_only_if_needed: true,
                is_floating_panel: true
            }
        })
    }

    fn remember_pin_foreground_app() {
        let Some(_mtm) = tauri_nspanel::objc2::MainThreadMarker::new() else {
            return;
        };
        let ws = tauri_nspanel::objc2_app_kit::NSWorkspace::sharedWorkspace();
        let previous = ws.frontmostApplication();
        let current = tauri_nspanel::objc2_app_kit::NSRunningApplication::currentApplication();
        let previous_present = previous.is_some();
        let current_active = current.isActive();
        PIN_FOREGROUND_APP.with(|slot| {
            if slot.borrow().is_some() {
                return;
            }
            *slot.borrow_mut() = if current_active {
                None
            } else {
                previous.filter(|app| !app.isTerminated())
            };
        });
        ulog_info!(
            "[fb] remember_pin_foreground_app previous_present={} current_active={}",
            previous_present,
            current_active
        );
    }

    fn activate_current_app_for_text_input() {
        let Some(mtm) = tauri_nspanel::objc2::MainThreadMarker::new() else {
            return;
        };
        ulog_info!(
            "[fb] activate_current_app_for_text_input before app_active={}",
            current_app_active()
        );
        tauri_nspanel::objc2_app_kit::NSApplication::sharedApplication(mtm).activate();
        ulog_info!(
            "[fb] activate_current_app_for_text_input after app_active={}",
            current_app_active()
        );
    }

    fn companion_is_key_window(app: &AppHandle) -> bool {
        let Some(companion) = app.get_webview_window(COMPANION_LABEL) else {
            return false;
        };
        let Ok(ns_window_ptr) = companion.ns_window() else {
            return false;
        };
        if ns_window_ptr.is_null() {
            return false;
        }
        // SAFETY: This is called from main-thread native window operations or
        // run_on_main_thread fade cleanup. The NSWindow pointer is borrowed only
        // synchronously while `companion` is alive.
        let ns_window: &tauri_nspanel::objc2_app_kit::NSWindow =
            unsafe { &*(ns_window_ptr as *const tauri_nspanel::objc2_app_kit::NSWindow) };
        ns_window.isKeyWindow()
    }

    fn restore_pin_foreground_app(restore_allowed: bool) {
        let previous = PIN_FOREGROUND_APP.with(|slot| slot.borrow_mut().take());
        if !restore_allowed {
            ulog_info!(
                "[fb] restore_pin_foreground_app skipped restore_allowed=false had_previous={}",
                previous.is_some()
            );
            return;
        }
        let Some(previous) = previous else {
            ulog_info!("[fb] restore_pin_foreground_app skipped no_previous");
            return;
        };
        if previous.isTerminated() {
            ulog_info!("[fb] restore_pin_foreground_app skipped previous_terminated=true");
            return;
        }
        let Some(mtm) = tauri_nspanel::objc2::MainThreadMarker::new() else {
            ulog_info!("[fb] restore_pin_foreground_app skipped no_main_thread_marker");
            return;
        };
        let current = tauri_nspanel::objc2_app_kit::NSRunningApplication::currentApplication();
        if !current.isActive() {
            ulog_info!("[fb] restore_pin_foreground_app skipped current_active=false");
            return;
        }
        ulog_info!("[fb] restore_pin_foreground_app yielding activation to previous app");
        tauri_nspanel::objc2_app_kit::NSApplication::sharedApplication(mtm)
            .yieldActivationToApplication(&previous);
        let _ = previous.activateFromApplication_options(
            &current,
            tauri_nspanel::objc2_app_kit::NSApplicationActivationOptions::empty(),
        );
    }

    pub fn suppress_pin_foreground_restore() {
        restore_pin_foreground_app(false);
    }

    // ── Hover detection: NSEvent.mouseLocation polling ──
    //
    // Why polling and not NSTrackingArea / DOM mouseenter: while our app is
    // inactive (the PERMANENT state for nonactivating panels) WKWebView gets
    // no hover/mouseMoved events, so DOM mouseenter never fires. tauri-nspanel
    // tracking areas are owned by the content view (= the WKWebView), whose
    // own mouseEntered: override swallows events instead of bubbling them to
    // the panel subclass — user-verified dead end. NSEvent.mouseLocation is a
    // permission-free class-property query (NOT an event tap / NOT Input
    // Monitoring), and an 8Hz main-thread peek is unmeasurable CPU-wise.
    static HOVER_POLLER_GENERATION: AtomicU64 = AtomicU64::new(0);
    static FLOATING_ACTIVE: AtomicBool = AtomicBool::new(false);
    static COMPANION_PINNED: AtomicBool = AtomicBool::new(false);

    #[derive(Debug, Clone, Copy)]
    struct NativeDragSession {
        grab_x: f64,
        grab_y: f64,
        last_x: f64,
        last_y: f64,
    }

    static BALL_DRAG: Mutex<Option<NativeDragSession>> = Mutex::new(None);
    static COMPANION_DRAG: Mutex<Option<NativeDragSession>> = Mutex::new(None);

    fn mouse_in_window(win: &tauri::WebviewWindow, mouse_top_left: (f64, f64)) -> bool {
        let Ok(scale) = win.scale_factor() else {
            return false;
        };
        let Ok(pos) = win.outer_position() else {
            return false;
        };
        let Ok(size) = win.outer_size() else {
            return false;
        };
        let pos = pos.to_logical::<f64>(scale);
        let size = size.to_logical::<f64>(scale);
        let (mx, my) = mouse_top_left;
        mx >= pos.x && mx <= pos.x + size.width && my >= pos.y && my <= pos.y + size.height
    }

    #[derive(Debug, Clone)]
    struct HoverProbe {
        mouse: Option<(f64, f64)>,
        ball_in: Option<bool>,
        comp_in: Option<bool>,
        ball_raw_in: Option<bool>,
        comp_raw_in: Option<bool>,
        ball_frame: String,
        comp_frame: String,
        main_frame: String,
        app_active: bool,
    }

    fn fmt_mouse(mouse: Option<(f64, f64)>) -> String {
        match mouse {
            Some((x, y)) => format!("({x:.1},{y:.1})"),
            None => "unavailable".to_string(),
        }
    }

    fn current_app_active() -> bool {
        tauri_nspanel::objc2_app_kit::NSRunningApplication::currentApplication().isActive()
    }

    fn window_debug_frame(win: Option<&tauri::WebviewWindow>) -> String {
        let Some(win) = win else {
            return "missing".to_string();
        };
        let visible = win.is_visible().unwrap_or(false);
        let focused = win.is_focused().unwrap_or(false);
        let frame = match (win.scale_factor(), win.outer_position(), win.outer_size()) {
            (Ok(scale), Ok(pos), Ok(size)) => {
                let pos = pos.to_logical::<f64>(scale);
                let size = size.to_logical::<f64>(scale);
                format!(
                    "pos=({:.1},{:.1}) size=({:.1},{:.1}) scale={:.2}",
                    pos.x, pos.y, size.width, size.height, scale
                )
            }
            _ => "frame=unavailable".to_string(),
        };
        format!("visible={visible} focused={focused} {frame}")
    }

    fn window_debug_frame_by_label(app: &AppHandle, label: &str) -> String {
        match app.get_webview_window(label) {
            Some(win) => window_debug_frame(Some(&win)),
            None => window_debug_frame(None),
        }
    }

    /// Current mouse position in Tauri's coordinate space (top-left origin,
    /// logical points). NSEvent.mouseLocation is bottom-left-origin global
    /// points; flip Y against the primary screen height.
    fn mouse_location_top_left() -> Option<(f64, f64)> {
        // Only ever called from run_on_main_thread — marker acquisition is a
        // checked no-op there.
        let mtm = tauri_nspanel::objc2::MainThreadMarker::new()?;
        let loc = tauri_nspanel::objc2_app_kit::NSEvent::mouseLocation();
        let screens = tauri_nspanel::objc2_app_kit::NSScreen::screens(mtm);
        let primary = screens.iter().next()?;
        let height = primary.frame().size.height;
        Some((loc.x, height - loc.y))
    }

    fn window_origin(win: &tauri::WebviewWindow) -> Result<(f64, f64), String> {
        let scale = win
            .scale_factor()
            .map_err(|e| format!("[fb] read window scale: {e}"))?;
        let pos = win
            .outer_position()
            .map_err(|e| format!("[fb] read window position: {e}"))?
            .to_logical::<f64>(scale);
        Ok((pos.x, pos.y))
    }

    fn start_native_drag(
        app: &AppHandle,
        label: &str,
        slot: &Mutex<Option<NativeDragSession>>,
    ) -> Result<(), String> {
        let win = app
            .get_webview_window(label)
            .ok_or_else(|| format!("[fb] {label} window missing"))?;
        let (mx, my) = mouse_location_top_left().ok_or("[fb] mouse location unavailable")?;
        let (wx, wy) = window_origin(&win)?;
        let mut guard = slot
            .lock()
            .map_err(|_| "[fb] native drag lock poisoned".to_string())?;
        *guard = Some(NativeDragSession {
            grab_x: mx - wx,
            grab_y: my - wy,
            last_x: wx,
            last_y: wy,
        });
        Ok(())
    }

    fn move_native_drag_to_mouse(
        app: &AppHandle,
        label: &str,
        slot: &Mutex<Option<NativeDragSession>>,
    ) -> Result<Option<(f64, f64)>, String> {
        let win = app
            .get_webview_window(label)
            .ok_or_else(|| format!("[fb] {label} window missing"))?;
        let Some((mx, my)) = mouse_location_top_left() else {
            return Ok(None);
        };
        let mut guard = slot
            .lock()
            .map_err(|_| "[fb] native drag lock poisoned".to_string())?;
        let Some(session) = guard.as_mut() else {
            return Ok(None);
        };
        let x = mx - session.grab_x;
        let y = my - session.grab_y;
        session.last_x = x;
        session.last_y = y;
        let _ = win.set_position(LogicalPosition::new(x, y));
        Ok(Some((x, y)))
    }

    fn end_native_drag(
        slot: &Mutex<Option<NativeDragSession>>,
    ) -> Result<Option<NativeDragSession>, String> {
        let mut guard = slot
            .lock()
            .map_err(|_| "[fb] native drag lock poisoned".to_string())?;
        Ok(guard.take())
    }

    pub fn start_ball_drag(app: &AppHandle) -> Result<(), String> {
        start_native_drag(app, BALL_LABEL, &BALL_DRAG)
    }

    pub fn move_ball_drag(app: &AppHandle) -> Result<(), String> {
        let _ = move_native_drag_to_mouse(app, BALL_LABEL, &BALL_DRAG)?;
        Ok(())
    }

    pub fn end_ball_drag(app: &AppHandle) -> Result<SnapResult, String> {
        let session = end_native_drag(&BALL_DRAG)?.ok_or("[fb] ball native drag is not active")?;
        let (x, y) = if let Some((mx, my)) = mouse_location_top_left() {
            (mx - session.grab_x, my - session.grab_y)
        } else {
            (session.last_x, session.last_y)
        };
        snap_ball(app, x, y)
    }

    pub fn cancel_ball_drag() -> Result<(), String> {
        let _ = end_native_drag(&BALL_DRAG)?;
        Ok(())
    }

    pub fn start_companion_drag(app: &AppHandle) -> Result<(), String> {
        start_native_drag(app, COMPANION_LABEL, &COMPANION_DRAG)
    }

    pub fn move_companion_drag(app: &AppHandle) -> Result<(), String> {
        let _ = move_native_drag_to_mouse(app, COMPANION_LABEL, &COMPANION_DRAG)?;
        Ok(())
    }

    pub fn end_companion_drag() -> Result<(), String> {
        let _ = end_native_drag(&COMPANION_DRAG)?;
        Ok(())
    }

    fn start_hover_poller(app: &AppHandle) {
        let generation = HOVER_POLLER_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut ball_inside = false;
            let mut comp_inside = false;
            let mut ball_raw_inside = false;
            let mut comp_raw_inside = false;
            loop {
                if !super::lifecycle_generation_is_current(
                    HOVER_POLLER_GENERATION.load(Ordering::SeqCst),
                    generation,
                ) {
                    break;
                }
                // 60ms ≈ 16Hz：hover 响应的第一段延迟就是这个间隔，120ms 在
                // 体感上"卡"（用户验收反馈）；16Hz 的 mouseLocation 查询 CPU
                // 仍不可测量。
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                if !super::lifecycle_generation_is_current(
                    HOVER_POLLER_GENERATION.load(Ordering::SeqCst),
                    generation,
                ) {
                    break;
                }
                let _lifecycle_guard = super::lock_native_lifecycle();
                if !super::lifecycle_generation_is_current(
                    HOVER_POLLER_GENERATION.load(Ordering::SeqCst),
                    generation,
                ) {
                    break;
                }
                let app2 = app.clone();
                let (tx, rx) = std::sync::mpsc::channel::<HoverProbe>();
                let dispatched = app
                    .run_on_main_thread(move || {
                        let mouse = mouse_location_top_left();
                        let ball = app2
                            .get_webview_window(BALL_LABEL)
                            .filter(|w| w.is_visible().unwrap_or(false));
                        let comp = app2
                            .get_webview_window(COMPANION_LABEL)
                            .filter(|w| w.is_visible().unwrap_or(false));
                        let app_active = current_app_active();
                        let ball_raw_in = match (&mouse, &ball) {
                            (Some(m), Some(w)) => Some(mouse_in_window(w, *m)),
                            _ => ball.as_ref().map(|_| false),
                        };
                        let comp_raw_in = match (&mouse, &comp) {
                            (Some(m), Some(w)) => Some(mouse_in_window(w, *m)),
                            _ => comp.as_ref().map(|_| false),
                        };
                        // Peek is intentionally nonactivating: MyAgents is
                        // normally inactive while the user works in another
                        // app. Therefore app_active is diagnostic context, not
                        // a hover gate; the geometry hit-test remains the
                        // source of truth.
                        let ball_in = ball_raw_in;
                        let comp_in = comp_raw_in;
                        let probe = HoverProbe {
                            mouse,
                            ball_in,
                            comp_in,
                            ball_raw_in,
                            comp_raw_in,
                            ball_frame: window_debug_frame(ball.as_ref()),
                            comp_frame: window_debug_frame(comp.as_ref()),
                            main_frame: window_debug_frame_by_label(&app2, "main"),
                            app_active,
                        };
                        let _ = tx.send(probe);
                    })
                    .is_ok();
                if !dispatched {
                    break;
                }
                let Ok(probe) = rx.recv() else {
                    break;
                };
                if let Some(raw_inside) = probe.ball_raw_in {
                    if raw_inside != ball_raw_inside {
                        ball_raw_inside = raw_inside;
                        ulog_info!(
                            "[fb] native-hover-raw target=ball raw_inside={} effective_inside={:?} mouse={} app_active={} ball=[{}] companion=[{}] main=[{}]",
                            raw_inside,
                            probe.ball_in,
                            fmt_mouse(probe.mouse),
                            probe.app_active,
                            probe.ball_frame,
                            probe.comp_frame,
                            probe.main_frame
                        );
                    }
                }
                if let Some(raw_inside) = probe.comp_raw_in {
                    if raw_inside != comp_raw_inside {
                        comp_raw_inside = raw_inside;
                        ulog_info!(
                            "[fb] native-hover-raw target=companion raw_inside={} effective_inside={:?} mouse={} app_active={} ball=[{}] companion=[{}] main=[{}]",
                            raw_inside,
                            probe.comp_in,
                            fmt_mouse(probe.mouse),
                            probe.app_active,
                            probe.ball_frame,
                            probe.comp_frame,
                            probe.main_frame
                        );
                    }
                }
                if let Some(inside) = probe.ball_in {
                    if inside != ball_inside {
                        ball_inside = inside;
                        ulog_info!(
                            "[fb] native-hover target=ball inside={} raw_inside={:?} mouse={} app_active={} ball=[{}] companion=[{}] main=[{}]",
                            inside,
                            probe.ball_raw_in,
                            fmt_mouse(probe.mouse),
                            probe.app_active,
                            probe.ball_frame,
                            probe.comp_frame,
                            probe.main_frame
                        );
                        let _ = app.emit_to(
                            BALL_LABEL,
                            "fb:native-hover",
                            serde_json::json!({
                                "inside": inside,
                                "appActive": probe.app_active,
                                "rawInside": probe.ball_raw_in,
                            }),
                        );
                    }
                }
                if let Some(inside) = probe.comp_in {
                    if inside != comp_inside {
                        comp_inside = inside;
                        ulog_info!(
                            "[fb] native-hover target=companion inside={} raw_inside={:?} mouse={} app_active={} ball=[{}] companion=[{}] main=[{}]",
                            inside,
                            probe.comp_raw_in,
                            fmt_mouse(probe.mouse),
                            probe.app_active,
                            probe.ball_frame,
                            probe.comp_frame,
                            probe.main_frame
                        );
                        let _ = app.emit_to(
                            COMPANION_LABEL,
                            "fb:native-hover",
                            serde_json::json!({
                                "inside": inside,
                                "appActive": probe.app_active,
                                "rawInside": probe.comp_raw_in,
                            }),
                        );
                    }
                }
            }
            ulog_info!("[fb] hover poller stopped");
        });
        ulog_info!("[fb] hover poller started");
    }

    fn stop_hover_poller() {
        HOVER_POLLER_GENERATION.fetch_add(1, Ordering::SeqCst);
    }

    fn placement_path() -> Option<PathBuf> {
        crate::app_dirs::myagents_data_dir().map(|d| d.join("floating_ball.json"))
    }

    fn load_placement() -> FbPlacement {
        placement_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save_placement(p: &FbPlacement) {
        if let Some(path) = placement_path() {
            if let Ok(json) = serde_json::to_string(p) {
                let _ = std::fs::write(path, json);
            }
        }
    }

    /// 显示器 work area（逻辑点）。`Monitor::work_area()` = NSScreen
    /// visibleFrame——菜单栏 / Dock / 刘海都已扣除（review fix: an earlier
    /// draft hand-rolled a 28px inset and could clamp the ball under the
    /// Dock）。
    fn monitor_work_area(m: &tauri::Monitor) -> (f64, f64, f64, f64) {
        let scale = m.scale_factor();
        let area = m.work_area();
        let pos = area.position.to_logical::<f64>(scale);
        let size = area.size.to_logical::<f64>(scale);
        (pos.x, pos.y, size.width, size.height)
    }

    /// 点（全局逻辑点空间）落在哪个显示器；落缝隙/越界取最近者。**不**用
    /// `current_monitor()`（= NSWindow.screen，拖拽中途读到的可能是旧屏 +
    /// None→主屏回退，吸边就把球弹回原屏）。在全局逻辑点空间（各显示器
    /// position/size ÷ 各自 scale 还原出的 CG 点空间）对全显示器列表做包含判定。
    fn monitor_for_point(app: &AppHandle, cx: f64, cy: f64) -> Option<tauri::Monitor> {
        let monitors = app.available_monitors().ok()?;
        let mut nearest: Option<(f64, tauri::Monitor)> = None;
        for m in monitors {
            let ms = m.scale_factor();
            let mp = m.position().to_logical::<f64>(ms);
            let msz = m.size().to_logical::<f64>(ms);
            let inside =
                cx >= mp.x && cx < mp.x + msz.width && cy >= mp.y && cy < mp.y + msz.height;
            if inside {
                return Some(m);
            }
            let dx = (mp.x - cx).max(cx - (mp.x + msz.width)).max(0.0);
            let dy = (mp.y - cy).max(cy - (mp.y + msz.height)).max(0.0);
            let d2 = dx * dx + dy * dy;
            if nearest.as_ref().map(|(best, _)| d2 < *best).unwrap_or(true) {
                nearest = Some((d2, m));
            }
        }
        nearest.map(|(_, m)| m)
    }

    /// 球中心所在的显示器，回读球当前 frame。**仅**用于 boot / companion
    /// 定位等没有光标上下文的路径——拖拽吸附改走 `snap_ball` 传入的权威落点
    /// （不回读，见 `snap_ball` 注释）。
    fn monitor_for_ball_center(app: &AppHandle) -> Option<tauri::Monitor> {
        let ball = app.get_webview_window(BALL_LABEL)?;
        let scale = ball.scale_factor().ok()?;
        let pos = ball.outer_position().ok()?.to_logical::<f64>(scale);
        monitor_for_point(app, pos.x + BALL_WIN / 2.0, pos.y + BALL_WIN / 2.0)
    }

    /// Work area of the monitor the ball lives on (logical coordinates),
    /// falling back to the primary monitor.
    fn work_area(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
        let monitor =
            monitor_for_ball_center(app).or_else(|| app.primary_monitor().ok().flatten())?;
        Some(monitor_work_area(&monitor))
    }

    fn virtual_screen_rect(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
        let monitors = app.available_monitors().ok()?;
        let mut min_x = f64::INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for monitor in monitors {
            let scale = monitor.scale_factor();
            let pos = monitor.position().to_logical::<f64>(scale);
            let size = monitor.size().to_logical::<f64>(scale);
            min_x = min_x.min(pos.x);
            min_y = min_y.min(pos.y);
            max_x = max_x.max(pos.x + size.width);
            max_y = max_y.max(pos.y + size.height);
        }
        if !min_x.is_finite() || !min_y.is_finite() || !max_x.is_finite() || !max_y.is_finite() {
            return None;
        }
        Some((min_x, min_y, max_x - min_x, max_y - min_y))
    }

    fn position_click_shield(app: &AppHandle, shield: &tauri::WebviewWindow) {
        let (x, y, w, h) = virtual_screen_rect(app).unwrap_or((0.0, 0.0, 1440.0, 900.0));
        let _ = shield.set_position(LogicalPosition::new(x, y));
        let _ = shield.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)));
    }

    fn show_click_shield(app: &AppHandle) {
        let Some(shield) = app.get_webview_window(SHIELD_LABEL) else {
            return;
        };
        position_click_shield(app, &shield);
        if let Ok(panel) = app.get_webview_panel(SHIELD_LABEL) {
            panel.set_alpha_value(1.0);
            panel.order_front_regardless();
            panel.show();
        }
    }

    fn hide_click_shield(app: &AppHandle) {
        if let Ok(panel) = app.get_webview_panel(SHIELD_LABEL) {
            panel.hide();
        }
    }

    fn ball_xy_for_placement(app: &AppHandle, p: &FbPlacement) -> (f64, f64) {
        // 优先按持久化的显示器名恢复（boot 时球还停在出生位置，球心定位
        // 不可信）；找不到该屏（外接屏已拔）再回退球心所在屏/主屏。
        let monitor = p
            .monitor
            .as_deref()
            .and_then(|name| {
                app.available_monitors()
                    .ok()?
                    .into_iter()
                    .find(|m| m.name().map(|n| n.as_str()) == Some(name))
            })
            .or_else(|| monitor_for_ball_center(app))
            .or_else(|| app.primary_monitor().ok().flatten());
        let (ax, ay, aw, ah) = monitor
            .map(|m| monitor_work_area(&m))
            .unwrap_or((0.0, 28.0, 1440.0, 872.0));
        let x = if p.dock == "left" {
            ax + EDGE_MARGIN
        } else {
            ax + aw - BALL_WIN - EDGE_MARGIN
        };
        let y = (ay + p.y_ratio * ah).clamp(ay, ay + ah - BALL_WIN);
        (x, y)
    }

    fn ensure_ball_panel(app: &AppHandle, win: &tauri::WebviewWindow) -> Result<(), String> {
        if app.get_webview_panel(BALL_LABEL).is_ok() {
            return Ok(());
        }
        let panel = win
            .to_panel::<FbBallPanel>()
            .map_err(|e| format!("[fb] ball to_panel: {e}"))?;
        panel.set_level(PanelLevel::Floating.value());
        panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .full_screen_auxiliary()
                .can_join_all_spaces()
                .stationary()
                .ignores_cycle()
                .into(),
        );
        panel.set_hides_on_deactivate(false);
        panel.set_released_when_closed(false);
        Ok(())
    }

    fn ensure_shield_panel(app: &AppHandle, win: &tauri::WebviewWindow) -> Result<(), String> {
        if app.get_webview_panel(SHIELD_LABEL).is_ok() {
            return Ok(());
        }
        let panel = win
            .to_panel::<FbShieldPanel>()
            .map_err(|e| format!("[fb] shield to_panel: {e}"))?;
        panel.set_level(PanelLevel::Floating.value().saturating_sub(1));
        panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .full_screen_auxiliary()
                .can_join_all_spaces()
                .stationary()
                .ignores_cycle()
                .into(),
        );
        panel.set_hides_on_deactivate(false);
        panel.set_released_when_closed(false);
        Ok(())
    }

    fn ensure_companion_panel(app: &AppHandle, win: &tauri::WebviewWindow) -> Result<(), String> {
        if app.get_webview_panel(COMPANION_LABEL).is_ok() {
            return Ok(());
        }
        let panel = win
            .to_panel::<FbCompanionPanel>()
            .map_err(|e| format!("[fb] companion to_panel: {e}"))?;
        panel.set_level(PanelLevel::Floating.value());
        panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .full_screen_auxiliary()
                .can_join_all_spaces()
                .stationary()
                .ignores_cycle()
                .into(),
        );
        panel.set_hides_on_deactivate(false);
        panel.set_released_when_closed(false);
        panel.set_works_when_modal(true);
        Ok(())
    }

    fn ensure_windows(app: &AppHandle) -> Result<(), String> {
        if app.get_webview_window(BALL_LABEL).is_none() {
            let win = WebviewWindowBuilder::new(app, BALL_LABEL, WebviewUrl::default())
                .scroll_bar_style(crate::webview_policy::scroll_bar_style())
                .title("MyAgents Ball")
                .inner_size(BALL_WIN, BALL_WIN)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .visible(false)
                .skip_taskbar(true)
                // 非 key 窗口的第一次点击必须直达 webview。wry 默认 false：
                // WKWebView 子类的 acceptsFirstMouse: 返回 NO → AppKit 把
                // first mouse 消费成"选中窗口"，DOM 收不到 mousedown/click
                // （0612 二轮实测：peek 面板第一下轻触/点按无反应，第二下才
                // 激活——第一下只让 panel 变成了 key window）。fb 两窗永远
                // 以非 key 态接受第一击，必须显式开。
                .accept_first_mouse(true)
                .build()
                .map_err(|e| format!("[fb] create ball window: {e}"))?;

            ensure_ball_panel(app, &win)?;

            let placement = load_placement();
            let (x, y) = ball_xy_for_placement(app, &placement);
            let _ = win.set_position(LogicalPosition::new(x, y));
        }

        if app.get_webview_window(SHIELD_LABEL).is_none() {
            let win = WebviewWindowBuilder::new(app, SHIELD_LABEL, WebviewUrl::default())
                .scroll_bar_style(crate::webview_policy::scroll_bar_style())
                .title("MyAgents Floating Shield")
                .inner_size(1.0, 1.0)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .visible(false)
                .skip_taskbar(true)
                .accept_first_mouse(true)
                .build()
                .map_err(|e| format!("[fb] create shield window: {e}"))?;

            position_click_shield(app, &win);
            ensure_shield_panel(app, &win)?;
        }

        if app.get_webview_window(COMPANION_LABEL).is_none() {
            let win = WebviewWindowBuilder::new(app, COMPANION_LABEL, WebviewUrl::default())
                .scroll_bar_style(crate::webview_policy::scroll_bar_style())
                .title("MyAgents Companion")
                .inner_size(COMPANION_W, COMPANION_H)
                .resizable(false) // JS-driven resize via cmd_fb_set_companion_size
                .decorations(false)
                .transparent(true)
                // Native window shadows follow the rectangular NSWindow, not the
                // DOM panel radius, so they show up as square corners around the
                // transparent companion. The panel owns its visual treatment in CSS.
                .shadow(false)
                .visible(false)
                .skip_taskbar(true)
                // 同球窗：peek 态（非 key）的第一击必须进 DOM，见上注释。
                .accept_first_mouse(true)
                .build()
                .map_err(|e| format!("[fb] create companion window: {e}"))?;

            // Park it next to the ball IMMEDIATELY. Without an initial
            // position Tauri centers the window — the first show would
            // flash a center-screen frame before our reposition lands
            // (user-verified symptom).
            position_companion_near_ball(app, &win);

            // Visual surface is DOM-only (fb.css). macOS native vibrancy made
            // peek read as a cool, opaque Sidebar material while pin read as
            // warm paper, so hover and click felt like two different panels.
            // Keep Rust responsible only for window/focus/position lifecycle.

            ensure_companion_panel(app, &win)?;
        }

        // A failed destroy may leave a regular Tauri window after the panel
        // registry was correctly detached. Compensation re-enables by
        // restoring the exact platform panel class before showing anything.
        if let Some(win) = app.get_webview_window(BALL_LABEL) {
            ensure_ball_panel(app, &win)?;
        }
        if let Some(win) = app.get_webview_window(SHIELD_LABEL) {
            ensure_shield_panel(app, &win)?;
        }
        if let Some(win) = app.get_webview_window(COMPANION_LABEL) {
            ensure_companion_panel(app, &win)?;
        }
        Ok(())
    }

    pub fn enable(app: &AppHandle) -> Result<(), String> {
        use tauri::Emitter;
        FLOATING_ACTIVE.store(false, Ordering::SeqCst);
        ensure_windows(app)?;
        ulog_info!(
            "[fb] enable begin mouse={} app_active={} main=[{}] ball=[{}] companion=[{}]",
            fmt_mouse(mouse_location_top_left()),
            current_app_active(),
            window_debug_frame_by_label(app, "main"),
            window_debug_frame_by_label(app, BALL_LABEL),
            window_debug_frame_by_label(app, COMPANION_LABEL)
        );
        if let Ok(panel) = app.get_webview_panel(BALL_LABEL) {
            panel.order_front_regardless();
            panel.show();
        }
        FLOATING_ACTIVE.store(true, Ordering::SeqCst);
        ulog_info!(
            "[fb] enable after ball show app_active={} main=[{}] ball=[{}]",
            current_app_active(),
            window_debug_frame_by_label(app, "main"),
            window_debug_frame_by_label(app, BALL_LABEL)
        );
        // Re-enable after a disable: tell the companion to re-acquire its
        // sidecar owner + SSE. On the very first enable the companion webview
        // may not have listeners yet — harmless, its boot path covers that.
        let _ = app.emit_to(
            COMPANION_LABEL,
            "fb:lifecycle",
            serde_json::json!({ "active": true }),
        );
        start_hover_poller(app);
        ulog_info!("[fb] floating ball enabled");
        Ok(())
    }

    fn destroy_surface(app: &AppHandle, label: &str) -> Result<(), String> {
        if let Ok(panel) = app.get_webview_panel(label) {
            panel.hide();
            let window = panel
                .to_window()
                .ok_or_else(|| format!("stage=panel-detach label={label}"))?;
            window
                .destroy()
                .map_err(|error| format!("stage=window-destroy label={label} error={error}"))?;
        } else if let Some(window) = app.get_webview_window(label) {
            window
                .destroy()
                .map_err(|error| format!("stage=window-destroy label={label} error={error}"))?;
        }
        Ok(())
    }

    pub fn disable(app: &AppHandle) -> Result<(), String> {
        ulog_info!(
            "[fb] disable begin app_active={} main=[{}] ball=[{}] companion=[{}]",
            current_app_active(),
            window_debug_frame_by_label(app, "main"),
            window_debug_frame_by_label(app, BALL_LABEL),
            window_debug_frame_by_label(app, COMPANION_LABEL)
        );
        FLOATING_ACTIVE.store(false, Ordering::SeqCst);
        // 作废 in-flight 渐变 task（否则它会在已隐藏的窗口上继续步进 alpha）。
        let _ = next_companion_gen();
        COMPANION_PINNED.store(false, Ordering::SeqCst);
        if let Ok(mut drag) = BALL_DRAG.lock() {
            *drag = None;
        }
        if let Ok(mut drag) = COMPANION_DRAG.lock() {
            *drag = None;
        }
        hide_click_shield(app);
        if let Ok(panel) = app.get_webview_panel(COMPANION_LABEL) {
            let should_restore = companion_is_key_window(app);
            panel.hide();
            restore_pin_foreground_app(should_restore);
        } else {
            restore_pin_foreground_app(false);
        }
        if let Ok(panel) = app.get_webview_panel(BALL_LABEL) {
            panel.hide();
        }
        stop_hover_poller();
        let mut errors = Vec::new();
        for label in super::MACOS_SURFACE_LABELS {
            if let Err(error) = destroy_surface(app, label) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            ulog_info!("[fb] floating ball disabled and surfaces destroyed");
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub fn capabilities(app: &AppHandle) -> FbCapabilities {
        let active = app
            .get_webview_window(BALL_LABEL)
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false);
        FbCapabilities {
            supported: true,
            active,
        }
    }

    /// Compute + apply the companion's dock-aware position next to the ball.
    fn position_companion_near_ball(app: &AppHandle, companion: &tauri::WebviewWindow) {
        let Some(ball) = app.get_webview_window(BALL_LABEL) else {
            return;
        };
        let scale = ball.scale_factor().unwrap_or(2.0);
        let Ok(bpos) = ball.outer_position() else {
            return;
        };
        let bpos = bpos.to_logical::<f64>(scale);
        let Ok(csize) = companion.outer_size() else {
            return;
        };
        let csize = csize.to_logical::<f64>(scale);
        let (ax, ay, aw, ah) = work_area(app).unwrap_or((0.0, 28.0, 1440.0, 872.0));

        // Ball on the right half → companion opens to its left, and vice versa.
        let dock_right = bpos.x + BALL_WIN / 2.0 > ax + aw / 2.0;
        let mut x = if dock_right {
            bpos.x - COMPANION_GAP - csize.width
        } else {
            bpos.x + BALL_WIN + COMPANION_GAP
        };
        x = x.clamp(ax + 8.0, ax + aw - csize.width - 8.0);
        let mut y = bpos.y + BALL_WIN / 2.0 - csize.height * 0.25;
        y = y.clamp(ay + 8.0, (ay + ah - csize.height - 8.0).max(ay + 8.0));
        let _ = companion.set_position(LogicalPosition::new(x, y));
    }

    // ── 伴侣窗出入场渐变（窗口层 alpha） ──
    //
    // 为什么仍在 NSWindow 层做：整块 transparent webview 需要跟 DOM 内容
    // 一起淡入淡出；只改 DOM opacity 会留下平台窗口层的时序差异。
    // NSWindow.alphaValue 把纸片和内容作为一个整体处理。
    //
    // 为什么是 Rust 步进而不是 NSAnimationContext + animator：隐式动画在本
    // app 实测**不产生动画**——setAlphaValue 瞬间生效（0612 真机 + 日志取
    // 证：fade-out start 跑了、肉眼是瞬灭；入场的"渐进感"其实全靠 DOM 升
    // 起在掩护）。成因合理推测是 app 永不激活（nonactivating panel 形态）
    // 下 AppKit 不驱动隐式窗口动画——与 NSTrackingArea 失灵同类，平台惯用
    // 机制在此形态下失效，换确定性方案。set_alpha_value 是经过生产验证的
    // 原语（peek 半透明曾走它）。
    //
    // generation 计数器 = 渐变所有权：每次 show/pin/hide 取新 gen，旧渐变
    // task 在下一步发现 gen 过期即退出；淡出半程被重新唤起时，新渐变从
    // tracked alpha（当前值）起步——天然 retarget、无跳变。
    const FADE_IN_PEEK_MS: u64 = 180;
    const FADE_IN_PIN_MS: u64 = 120;
    // 出场与 peek 入场同长（成对，0612 三轮反馈）。
    const FADE_OUT_MS: u64 = 180;

    static COMPANION_VIS_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    /// 当前窗口 alpha 的镜像（千分位定点），渐变起点采样用——NSWindow 没有
    /// 方便的跨线程 getter，写侧只有我们自己。
    static COMPANION_ALPHA_MILLI: std::sync::atomic::AtomicU32 =
        std::sync::atomic::AtomicU32::new(1000);

    fn next_companion_gen() -> u64 {
        COMPANION_VIS_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }

    fn tracked_alpha() -> f64 {
        COMPANION_ALPHA_MILLI.load(std::sync::atomic::Ordering::SeqCst) as f64 / 1000.0
    }

    fn set_tracked_alpha(a: f64) {
        COMPANION_ALPHA_MILLI.store(
            (a.clamp(0.0, 1.0) * 1000.0).round() as u32,
            std::sync::atomic::Ordering::SeqCst,
        );
    }

    /// 确定性步进渐变：从 tracked alpha 渐变到 `to`，smoothstep 缓动；
    /// `hide_when_done` 时收尾 orderOut + alpha 复位。调用方先拿
    /// `next_companion_gen()` 再传入——gen 一换，旧 task 自行退出。
    fn fade_companion_to(
        app: &AppHandle,
        generation: u64,
        to: f64,
        duration_ms: u64,
        hide_when_done: bool,
    ) {
        let from = tracked_alpha();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            use std::sync::atomic::Ordering;
            const STEP_MS: u64 = 13; // ~75Hz；180ms ≈ 13 步，步进 alpha < 0.08 不可察
            let steps = (duration_ms / STEP_MS).max(1);
            for i in 1..=steps {
                tokio::time::sleep(std::time::Duration::from_millis(STEP_MS)).await;
                if COMPANION_VIS_GEN.load(Ordering::SeqCst) != generation {
                    return; // 被更新的 show/pin/hide 接管
                }
                let t = i as f64 / steps as f64;
                let eased = t * t * (3.0 - 2.0 * t); // smoothstep
                let a = from + (to - from) * eased;
                set_tracked_alpha(a);
                let app2 = app.clone();
                let dispatched = app
                    .run_on_main_thread(move || {
                        if let Ok(panel) = app2.get_webview_panel(COMPANION_LABEL) {
                            panel.set_alpha_value(a);
                        }
                    })
                    .is_ok();
                if !dispatched {
                    return;
                }
            }
            if hide_when_done {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                if COMPANION_VIS_GEN.load(Ordering::SeqCst) != generation {
                    return; // 淡出收尾前又被唤起，orderOut 作废
                }
                set_tracked_alpha(1.0);
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let should_restore = companion_is_key_window(&app2);
                    ulog_info!(
                        "[fb] hide_companion fade-out complete gen={} should_restore={} app_active={} main=[{}] companion=[{}]",
                        generation,
                        should_restore,
                        current_app_active(),
                        window_debug_frame_by_label(&app2, "main"),
                        window_debug_frame_by_label(&app2, COMPANION_LABEL)
                    );
                    if let Ok(panel) = app2.get_webview_panel(COMPANION_LABEL) {
                        panel.hide();
                        panel.set_alpha_value(1.0); // 复位（下次 show 会先归零）
                    }
                    hide_click_shield(&app2);
                    restore_pin_foreground_app(should_restore);
                });
            }
        });
    }

    /// Position the companion next to the ball (dock-aware) and show it.
    /// mode = "peek" (no keyboard focus) | "pin" (becomes key window).
    pub fn show_companion(app: &AppHandle, mode: &str) -> Result<(), String> {
        if !FLOATING_ACTIVE.load(Ordering::SeqCst) {
            return Err("[fb] floating ball is disabled".to_string());
        }
        ensure_windows(app)?;
        ulog_info!(
            "[fb] show_companion begin mode={} mouse={} app_active={} main=[{}] ball=[{}] companion=[{}]",
            mode,
            fmt_mouse(mouse_location_top_left()),
            current_app_active(),
            window_debug_frame_by_label(app, "main"),
            window_debug_frame_by_label(app, BALL_LABEL),
            window_debug_frame_by_label(app, COMPANION_LABEL)
        );
        let companion = app
            .get_webview_window(COMPANION_LABEL)
            .ok_or("[fb] companion window missing")?;
        let pin_mode = mode == "pin";
        if !pin_mode && (COMPANION_PINNED.load(Ordering::SeqCst) || companion_is_key_window(app)) {
            ulog_info!(
                "[fb] show_companion ignored stale peek while pinned app_active={} key={} companion=[{}]",
                current_app_active(),
                companion_is_key_window(app),
                window_debug_frame_by_label(app, COMPANION_LABEL)
            );
            return Ok(());
        }
        position_companion_near_ball(app, &companion);

        let panel = app
            .get_webview_panel(COMPANION_LABEL)
            .map_err(|_| "[fb] companion panel missing".to_string())?;
        // 任何一次 show 都让 generation 前进——立刻作废 in-flight 的淡出
        // task（含其收尾 orderOut），再开始本次渐显。
        let generation = next_companion_gen();
        let was_visible = companion.is_visible().unwrap_or(false);
        if !was_visible {
            // 从隐藏出场：alpha 先归零再 orderFront，首帧不闪全亮。
            panel.set_alpha_value(0.0);
            set_tracked_alpha(0.0);
        }
        ulog_info!(
            "[fb] show_companion native-show begin mode={} was_visible={} gen={} app_active={} companion=[{}]",
            mode,
            was_visible,
            generation,
            current_app_active(),
            window_debug_frame_by_label(app, COMPANION_LABEL)
        );
        if pin_mode {
            COMPANION_PINNED.store(true, Ordering::SeqCst);
            show_click_shield(app);
            ulog_info!(
                "[fb] show_companion pin-focus begin app_active={} key={} main=[{}] companion=[{}]",
                current_app_active(),
                companion_is_key_window(app),
                window_debug_frame_by_label(app, "main"),
                window_debug_frame_by_label(app, COMPANION_LABEL)
            );
            remember_pin_foreground_app();
            activate_current_app_for_text_input();
            panel.show_and_make_key();
        } else {
            COMPANION_PINNED.store(false, Ordering::SeqCst);
            hide_click_shield(app);
            panel.order_front_regardless();
            panel.show();
        }
        ulog_info!(
            "[fb] show_companion after-show mode={} app_active={} key={} companion=[{}] main=[{}]",
            mode,
            current_app_active(),
            companion_is_key_window(app),
            window_debug_frame_by_label(app, COMPANION_LABEL),
            window_debug_frame_by_label(app, "main")
        );
        // Peek: visible but never key — D1. 半透明完全由 DOM 暖纸表达。
        // 已可见时（含淡出半程被重新唤起）从 tracked alpha 续渐到 1，无跳变。
        let dur = if pin_mode {
            FADE_IN_PIN_MS
        } else {
            FADE_IN_PEEK_MS
        };
        fade_companion_to(app, generation, 1.0, dur, false);
        Ok(())
    }

    /// Promote an already-visible peek to pinned (keyboard focus).
    pub fn pin_companion(app: &AppHandle) -> Result<(), String> {
        if !FLOATING_ACTIVE.load(Ordering::SeqCst) {
            return Err("[fb] floating ball is disabled".to_string());
        }
        let panel = app
            .get_webview_panel(COMPANION_LABEL)
            .map_err(|_| "[fb] companion panel missing".to_string())?;
        let generation = next_companion_gen();
        ulog_info!(
            "[fb] pin_companion begin gen={} mouse={} app_active={} key={} main=[{}] companion=[{}]",
            generation,
            fmt_mouse(mouse_location_top_left()),
            current_app_active(),
            companion_is_key_window(app),
            window_debug_frame_by_label(app, "main"),
            window_debug_frame_by_label(app, COMPANION_LABEL)
        );
        COMPANION_PINNED.store(true, Ordering::SeqCst);
        show_click_shield(app);
        remember_pin_foreground_app();
        activate_current_app_for_text_input();
        panel.show_and_make_key();
        ulog_info!(
            "[fb] pin_companion end gen={} app_active={} key={} main=[{}] companion=[{}]",
            generation,
            current_app_active(),
            companion_is_key_window(app),
            window_debug_frame_by_label(app, "main"),
            window_debug_frame_by_label(app, COMPANION_LABEL)
        );
        // peek→pin 时窗口已在 alpha 1（渐变是 no-op）；这里只救"淡出半程
        // 被点住"的边角——从 tracked alpha 续渐回 1。
        fade_companion_to(app, generation, 1.0, FADE_IN_PIN_MS, false);
        Ok(())
    }

    pub fn hide_companion(app: &AppHandle) {
        COMPANION_PINNED.store(false, Ordering::SeqCst);
        let Some(win) = app.get_webview_window(COMPANION_LABEL) else {
            hide_click_shield(app);
            restore_pin_foreground_app(false);
            return;
        };
        if !win.is_visible().unwrap_or(false) {
            hide_click_shield(app);
            restore_pin_foreground_app(false);
            return;
        }
        let generation = next_companion_gen();
        ulog_info!(
            "[fb] hide_companion fade-out start gen={} mouse={} app_active={} key={} main=[{}] companion=[{}]",
            generation,
            fmt_mouse(mouse_location_top_left()),
            current_app_active(),
            companion_is_key_window(app),
            window_debug_frame_by_label(app, "main"),
            window_debug_frame_by_label(app, COMPANION_LABEL)
        );
        // 渐隐到 0 后由 fade task 收尾 orderOut（hide_when_done）。
        // hide()/orderOut is sufficient for pure nonactivating panels. Pin now
        // activates MyAgents so IME/text services attach to WKWebView, so the
        // fade-out completion explicitly yields activation back to the app that
        // was frontmost before pin. (Do NOT call resign_key_window directly;
        // AppKit docs reserve it as a system callback.)
        fade_companion_to(app, generation, 0.0, FADE_OUT_MS, true);
    }

    /// Legacy absolute-position command kept for compatibility. Runtime drag
    /// no longer feeds browser `screenX/Y` into this path; multi-display window
    /// movement is owned by `start/move/end_*_drag`, which reads native mouse
    /// location and native window frame on the main thread.
    pub fn move_ball_to(app: &AppHandle, x: f64, y: f64) -> Result<(), String> {
        let ball = app
            .get_webview_window(BALL_LABEL)
            .ok_or("[fb] ball window missing")?;
        let _ = ball.set_position(LogicalPosition::new(x, y));
        Ok(())
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SnapResult {
        pub dock: String,
    }

    /// 吸附决策（纯函数，可单测）：球落点 + 显示器 work area → 停靠边 + 高度比。
    /// `cx` = 球心 x；`ball_y` = 球原点 y；`ax/ay/aw/ah` = work area 左/顶/宽/高。
    fn snap_decision(
        cx: f64,
        ball_y: f64,
        ax: f64,
        ay: f64,
        aw: f64,
        ah: f64,
    ) -> (&'static str, f64) {
        let dock = if cx < ax + aw / 2.0 { "left" } else { "right" };
        let y_ratio = ((ball_y - ay) / ah).clamp(0.02, 0.92);
        (dock, y_ratio)
    }

    /// 吸附到最近屏幕边并持久化。落点 (ball_x, ball_y) 来自同一 native drag
    /// session 的最终位置，**不回读** `outer_position`——回读会撞上 set_frame 的
    /// GCD 异步：读到拖拽尾帧尚未落地的旧值，按旧屏/主屏吸回 = 跨屏拖不过去。
    /// 仍 channel-join 到主线程，因为 work_area / available_monitors 读 NSScreen
    /// 须主线程。
    pub fn snap_ball(app: &AppHandle, ball_x: f64, ball_y: f64) -> Result<SnapResult, String> {
        let ball = app
            .get_webview_window(BALL_LABEL)
            .ok_or("[fb] ball window missing")?;
        let (cx, cy) = (ball_x + BALL_WIN / 2.0, ball_y + BALL_WIN / 2.0);
        let monitor =
            monitor_for_point(app, cx, cy).or_else(|| app.primary_monitor().ok().flatten());
        let (ax, ay, aw, ah) = monitor
            .as_ref()
            .map(monitor_work_area)
            .unwrap_or((0.0, 28.0, 1440.0, 872.0));
        let (dock, y_ratio) = snap_decision(cx, ball_y, ax, ay, aw, ah);
        let placement = FbPlacement {
            dock: dock.to_string(),
            y_ratio,
            monitor: monitor.as_ref().and_then(|m| m.name().cloned()),
        };
        let (x, y) = ball_xy_for_placement(app, &placement);
        let _ = ball.set_position(LogicalPosition::new(x, y));
        save_placement(&placement);
        Ok(SnapResult {
            dock: dock.to_string(),
        })
    }

    pub fn set_companion_size(app: &AppHandle, width: f64, height: f64) -> Result<(), String> {
        let companion = app
            .get_webview_window(COMPANION_LABEL)
            .ok_or("[fb] companion window missing")?;
        let _ = companion.set_size(LogicalSize::new(width.max(360.0), height.max(320.0)));
        Ok(())
    }

    /// Legacy absolute-position command kept for the resize edge path. Free
    /// movement drag uses `cmd_fb_drag_companion_*`, not browser-derived
    /// absolute coordinates.
    pub fn move_companion_to(app: &AppHandle, x: f64, y: f64) -> Result<(), String> {
        let companion = app
            .get_webview_window(COMPANION_LABEL)
            .ok_or("[fb] companion window missing")?;
        let _ = companion.set_position(LogicalPosition::new(x, y));
        Ok(())
    }

    /// Frontmost window probe result（自滤本进程）。
    struct FrontmostInfo {
        app_name: Option<String>,
        window_title: Option<String>,
        /// 窗口中心点，CG 全局坐标（top-left origin）——kCGWindowBounds 与
        /// CGDisplayBounds 同空间，多显示器下用它定位"用户正看的那块屏"。
        window_center: Option<(f64, f64)>,
    }

    /// Frontmost window identity (app name + title + center), self-filtered.
    /// Zero permission. Shared by capture_context and the 📷 shutter.
    fn frontmost_window_info() -> FrontmostInfo {
        match active_win_pos_rs::get_active_window() {
            // Clicking the ball can make OUR panel the "active window" in the
            // CGWindow sense even though the app never activates — the user
            // saw "正在看 MyAgents — MyAgents Ball" in the title row. Filter
            // out our own process and fall back to NSWorkspace's frontmost
            // application (which nonactivating panels never become).
            Ok(win) if win.process_id != std::process::id() as u64 => FrontmostInfo {
                app_name: (!win.app_name.is_empty()).then_some(win.app_name),
                window_title: (!win.title.is_empty()).then_some(win.title),
                window_center: Some((
                    win.position.x + win.position.width / 2.0,
                    win.position.y + win.position.height / 2.0,
                )),
            },
            Ok(_) => FrontmostInfo {
                app_name: frontmost_app_name(),
                window_title: None,
                window_center: None,
            },
            Err(_) => {
                ulog_warn!("[fb] get_active_window failed (no frontmost window?)");
                FrontmostInfo {
                    app_name: frontmost_app_name(),
                    window_title: None,
                    window_center: None,
                }
            }
        }
    }

    /// 包含给定 CG 坐标点的显示器边界（CG 空间）。纯 CoreGraphics、线程安全
    /// ——screenshot 跑在 spawn_blocking，碰不得 NSScreen/MainThreadMarker。
    fn display_bounds_containing(point: (f64, f64)) -> Option<(f64, f64, f64, f64)> {
        use core_graphics::display::CGDisplay;
        let ids = CGDisplay::active_displays().ok()?;
        for id in ids {
            let b = CGDisplay::new(id).bounds();
            let (x, y, w, h) = (b.origin.x, b.origin.y, b.size.width, b.size.height);
            if point.0 >= x && point.0 < x + w && point.1 >= y && point.1 < y + h {
                return Some((x, y, w, h));
            }
        }
        None
    }

    /// Eager context capture (PRD §5.1). MUST run before the companion becomes
    /// key — the probes read the *user's* frontmost app. Selection capture may
    /// fall back to a clipboard round-trip inside get-selected-text, which is
    /// acceptable here because this is only ever called on explicit summon.
    pub fn capture_context() -> FbContext {
        let mut ctx = FbContext::default();
        let info = frontmost_window_info();
        ctx.app_name = info.app_name;
        ctx.window_title = info.window_title;

        // Don't even try selection capture without Accessibility permission —
        // get-selected-text would fall through to the Cmd+C clipboard hack and
        // surprise the user before they ever granted anything.
        if ax_trusted(false) {
            match get_selected_text::get_selected_text() {
                Ok(text) => {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        // Cap defensively — a 5MB selection should not ride
                        // along into a chat message unasked.
                        let capped: String = trimmed.chars().take(2000).collect();
                        ctx.selection = Some(capped);
                    }
                }
                Err(e) => {
                    ulog_warn!("[fb] get_selected_text failed: {e:?}");
                }
            }
        }

        ctx
    }

    /// Frontmost application name via NSWorkspace — unlike the CGWindow-based
    /// active-win probe this can never return our own nonactivating panels.
    fn frontmost_app_name() -> Option<String> {
        let ws = tauri_nspanel::objc2_app_kit::NSWorkspace::sharedWorkspace();
        let app = ws.frontmostApplication()?;
        let name = app.localizedName()?;
        let name = name.to_string();
        if name.is_empty() || name == "MyAgents" {
            None
        } else {
            Some(name)
        }
    }

    /// Accessibility (AX) permission probe. `prompt = true` shows the system
    /// authorization dialog once.
    pub fn ax_trusted(prompt: bool) -> bool {
        if prompt {
            macos_accessibility_client::accessibility::application_is_trusted_with_prompt()
        } else {
            macos_accessibility_client::accessibility::application_is_trusted()
        }
    }

    /// Shutter-style screenshot (PRD D7: only ever user-initiated). Captures
    /// the full screen via /usr/sbin/screencapture, then downsamples to a
    /// ≤1600px JPEG via /usr/bin/sips so the base64 payload stays in the
    /// hundreds-of-KB range — the raw Retina PNG would otherwise ride the
    /// invoke IPC *and* the /chat/send JSON body at 5–30MB (the ">256KB into
    /// IPC JSON" red line, flagged by both review passes).
    /// First call triggers the macOS Screen Recording permission prompt.
    pub fn screenshot() -> Result<super::FbScreenshot, String> {
        use base64::Engine;
        // 快门时刻的前台窗口（nonactivating panel 不改变 frontmost，读到的
        // 就是用户正看的窗口）——引用条拿它当标签，中心点定位它所在的屏。
        let info = frontmost_window_info();
        let id = uuid::Uuid::new_v4();
        let tmp = std::env::temp_dir().join(format!("myagents-fb-shot-{id}.png"));
        let mut cmd = crate::process_cmd::new("/usr/sbin/screencapture");
        cmd.arg("-x"); // no shutter sound
                       // 多显示器：截"前台窗口所在的那块屏"，与引用条标签同源同屏。
                       // screencapture 单输出文件默认只截主显示器——副屏聚焦 iTerm 时标签
                       // 写着 iTerm、图却是主屏浏览器（0613 用户实测 bug）。-R 用 CG 全局
                       // 坐标矩形圈定该屏；值与 flag 连写，防负坐标（主屏左侧的副屏 x<0）
                       // 被 getopt 当成另一个 flag。探不到前台窗口时不加 -R，回退主屏。
        if let Some((x, y, w, h)) = info.window_center.and_then(display_bounds_containing) {
            cmd.arg(format!("-R{x},{y},{w},{h}"));
        }
        let status = cmd
            .arg(&tmp)
            .status()
            .map_err(|e| format!("[fb] screencapture spawn: {e}"))?;
        if !status.success() {
            let _ = std::fs::remove_file(&tmp);
            return Err("[fb] screencapture failed (screen recording permission?)".to_string());
        }

        // Downsample + transcode in place. Best-effort: if sips fails we fall
        // back to the original PNG rather than losing the shot.
        let jpg = std::env::temp_dir().join(format!("myagents-fb-shot-{id}.jpg"));
        let sips_ok = crate::process_cmd::new("/usr/bin/sips")
            .args([
                "-Z",
                "1600",
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                "72",
            ])
            .arg(&tmp)
            .arg("--out")
            .arg(&jpg)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        let (path, mime) = if sips_ok {
            (&jpg, "image/jpeg")
        } else {
            ulog_warn!("[fb] sips downsample failed — falling back to raw png");
            (&tmp, "image/png")
        };
        let bytes = std::fs::read(path).map_err(|e| format!("[fb] read screenshot: {e}"));
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&jpg);
        let bytes = bytes?;
        if bytes.is_empty() {
            return Err("[fb] empty screenshot".to_string());
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(super::FbScreenshot {
            data_url: format!("data:{mime};base64,{b64}"),
            app_name: info.app_name,
            window_title: info.window_title,
        })
    }

    fn emit_force_hidden(app: &AppHandle, reason: &str) {
        let _ = app.emit_to(
            COMPANION_LABEL,
            "fb:force-hidden",
            serde_json::json!({ "reason": reason }),
        );
        let _ = app.emit_to(
            BALL_LABEL,
            "fb:companion-mode",
            serde_json::json!({ "mode": "hidden" }),
        );
    }

    pub fn dismiss_from_shield(app: &AppHandle) {
        ulog_info!("[fb] shield dismiss begin");
        emit_force_hidden(app, "shield-click");
        hide_companion(app);
    }

    /// Cross-window event relay: ball ⇄ companion talk through Rust because
    /// they live in separate webviews.
    pub fn relay(app: &AppHandle, target: &str, event: &str, payload: serde_json::Value) {
        let label = match target {
            "ball" => BALL_LABEL,
            _ => COMPANION_LABEL,
        };
        if let Err(e) = app.emit_to(label, event, payload) {
            ulog_error!("[fb] relay {event} → {label} failed: {e}");
        }
    }

    #[cfg(test)]
    mod tests {
        use super::snap_decision;

        // work area: 主屏 (0,28) 1440×872。
        const AX: f64 = 0.0;
        const AY: f64 = 28.0;
        const AW: f64 = 1440.0;
        const AH: f64 = 872.0;

        #[test]
        fn dock_by_center_relative_to_work_area_midline() {
            // 球心在左半 → left；右半 → right（按 work area 中线，不是屏幕中线）。
            assert_eq!(snap_decision(100.0, 400.0, AX, AY, AW, AH).0, "left");
            assert_eq!(snap_decision(1300.0, 400.0, AX, AY, AW, AH).0, "right");
            // 正好中线（720）算 right（`<` 判据）。
            assert_eq!(snap_decision(720.0, 400.0, AX, AY, AW, AH).0, "right");
        }

        #[test]
        fn y_ratio_clamped_into_visible_band() {
            // 顶到边外/底到边外都夹进 [0.02, 0.92]，球不会被吸到 Dock 下/菜单栏上。
            assert_eq!(snap_decision(100.0, AY - 500.0, AX, AY, AW, AH).1, 0.02);
            assert_eq!(
                snap_decision(100.0, AY + AH + 500.0, AX, AY, AW, AH).1,
                0.92
            );
            // 居中：(ay + 0.4*ah - ay)/ah = 0.4。
            let y = AY + 0.4 * AH;
            assert!((snap_decision(100.0, y, AX, AY, AW, AH).1 - 0.4).abs() < 1e-9);
        }

        #[test]
        fn second_screen_to_the_right_uses_its_own_work_area_origin() {
            // 副屏在主屏右侧：work area 原点 x=1440。球心落副屏左半 → left（相对副屏）。
            let (ax, aw) = (1440.0, 1920.0);
            assert_eq!(snap_decision(1600.0, 400.0, ax, AY, aw, AH).0, "left");
            assert_eq!(snap_decision(3200.0, 400.0, ax, AY, aw, AH).0, "right");
        }
    }
}

// ════════════════════════════════════════════════════════════════════════
// Windows implementation
// ════════════════════════════════════════════════════════════════════════
#[cfg(target_os = "windows")]
mod imp {
    use super::{FbCapabilities, FbContext, FbPlacement, FbScreenshot};
    use crate::{ulog_error, ulog_info, ulog_warn};
    use base64::Engine;
    use serde::Serialize;
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::{
        AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, WebviewUrl,
        WebviewWindow, WebviewWindowBuilder,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, GetCursorPos, GetForegroundWindow, GetWindowLongPtrW,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible,
        SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWLP_WNDPROC,
        GWL_EXSTYLE, HWND_TOPMOST, MA_NOACTIVATE, SWP_FRAMECHANGED, SWP_HIDEWINDOW, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, WM_MOUSEACTIVATE,
        WNDPROC, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };

    pub const BALL_LABEL: &str = "fb-ball";
    pub const COMPANION_LABEL: &str = "fb-companion";

    const BALL_WIN: f64 = 92.0;
    const EDGE_MARGIN: f64 = 6.0;
    const COMPANION_W: f64 = 440.0;
    const COMPANION_H: f64 = 660.0;
    const COMPANION_GAP: f64 = 10.0;

    static HOVER_POLLER_GENERATION: AtomicU64 = AtomicU64::new(0);
    static FOREGROUND_POLLER_GENERATION: AtomicU64 = AtomicU64::new(0);
    static FLOATING_ACTIVE: AtomicBool = AtomicBool::new(false);
    static COMPANION_PINNED: AtomicBool = AtomicBool::new(false);
    static COMPANION_PINNED_AT_MS: AtomicU64 = AtomicU64::new(0);
    static BALL_HWND: AtomicUsize = AtomicUsize::new(0);
    static COMPANION_HWND: AtomicUsize = AtomicUsize::new(0);
    static LAST_FOREGROUND_HWND: AtomicUsize = AtomicUsize::new(0);

    #[derive(Debug, Clone, Copy)]
    struct NativeDragSession {
        grab_x: f64,
        grab_y: f64,
        last_x: f64,
        last_y: f64,
    }

    static BALL_DRAG: Mutex<Option<NativeDragSession>> = Mutex::new(None);
    static COMPANION_DRAG: Mutex<Option<NativeDragSession>> = Mutex::new(None);
    static LAST_CONTEXT: Mutex<Option<FbContext>> = Mutex::new(None);

    fn original_procs() -> &'static Mutex<HashMap<usize, isize>> {
        static PROCS: OnceLock<Mutex<HashMap<usize, isize>>> = OnceLock::new();
        PROCS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    unsafe extern "system" fn fb_window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_MOUSEACTIVATE {
            let hwnd_key = hwnd as usize;
            let companion = COMPANION_HWND.load(Ordering::SeqCst);
            let companion_can_activate =
                hwnd_key == companion && COMPANION_PINNED.load(Ordering::SeqCst);
            if !companion_can_activate {
                return MA_NOACTIVATE as LRESULT;
            }
        }

        let original = original_procs()
            .lock()
            .ok()
            .and_then(|m| m.get(&(hwnd as usize)).copied())
            .unwrap_or(0);
        if original != 0 {
            let proc: WNDPROC = unsafe { std::mem::transmute(original) };
            unsafe { CallWindowProcW(proc, hwnd, msg, wparam, lparam) }
        } else {
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
    }

    fn hwnd_for(win: &WebviewWindow) -> Result<HWND, String> {
        let hwnd = win.hwnd().map_err(|e| format!("[fb] hwnd: {e}"))?;
        Ok(hwnd.0 as HWND)
    }

    fn hwnd_is_ours(hwnd: HWND) -> bool {
        let raw = hwnd as usize;
        raw != 0
            && (raw == BALL_HWND.load(Ordering::SeqCst)
                || raw == COMPANION_HWND.load(Ordering::SeqCst))
    }

    fn install_noactivate_proc(hwnd: HWND) -> Result<(), String> {
        let key = hwnd as usize;
        let mut map = original_procs()
            .lock()
            .map_err(|_| "[fb] wndproc map poisoned".to_string())?;
        if map.contains_key(&key) {
            return Ok(());
        }
        unsafe {
            let original = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
            if original == 0 {
                return Err("[fb] GetWindowLongPtrW(GWLP_WNDPROC) returned 0".to_string());
            }
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, fb_window_proc as usize as isize);
            map.insert(key, original);
        }
        Ok(())
    }

    fn restore_window_proc(hwnd: HWND, label: &str) -> Result<(), String> {
        if hwnd.is_null() {
            return Ok(());
        }
        let original = original_procs()
            .lock()
            .map_err(|_| format!("stage=wndproc-map label={label} error=poisoned"))?
            .remove(&(hwnd as usize));
        let Some(original) = original else {
            return Ok(());
        };
        if unsafe { IsWindow(hwnd) } == 0 {
            return Ok(());
        }
        let replaced = unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, original) };
        if replaced == 0 {
            // Keep the original pointer available while the custom proc is
            // still installed. A failed destroy followed by compensation can
            // then retry restoration without recording our own proc as the
            // "original" and recursing through CallWindowProcW.
            original_procs()
                .lock()
                .map_err(|_| format!("stage=wndproc-map label={label} error=poisoned"))?
                .insert(hwnd as usize, original);
            return Err(format!("stage=wndproc-restore label={label}"));
        }
        Ok(())
    }

    fn apply_tool_window_styles(win: &WebviewWindow, no_activate: bool) -> Result<(), String> {
        let hwnd = hwnd_for(win)?;
        unsafe {
            let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            ex |= WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_LAYERED;
            if no_activate {
                ex |= WS_EX_NOACTIVATE;
            } else {
                ex &= !WS_EX_NOACTIVATE;
            }
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex as isize);
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOOWNERZORDER,
            );
        }
        install_noactivate_proc(hwnd)?;
        Ok(())
    }

    fn show_no_activate(win: &WebviewWindow) -> Result<(), String> {
        let hwnd = hwnd_for(win)?;
        unsafe {
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER,
            );
        }
        Ok(())
    }

    fn hide_window_strict(win: &WebviewWindow) {
        let hwnd = match hwnd_for(win) {
            Ok(hwnd) => Some(hwnd),
            Err(e) => {
                ulog_warn!("[fb] hide hwnd lookup failed: {e}");
                None
            }
        };
        if let Err(e) = win.hide() {
            ulog_warn!("[fb] tauri hide failed: {e}");
        }
        if let Some(hwnd) = hwnd {
            unsafe {
                ShowWindow(hwnd, SW_HIDE);
                SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_HIDEWINDOW | SWP_NOOWNERZORDER,
                );
            }
        }
    }

    fn clear_drag_sessions() {
        if let Ok(mut guard) = BALL_DRAG.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = COMPANION_DRAG.lock() {
            *guard = None;
        }
    }

    fn placement_path() -> Option<PathBuf> {
        crate::app_dirs::myagents_data_dir().map(|d| d.join("floating_ball.json"))
    }

    fn load_placement() -> FbPlacement {
        placement_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save_placement(p: &FbPlacement) {
        if let Some(path) = placement_path() {
            if let Ok(json) = serde_json::to_string(p) {
                let _ = std::fs::write(path, json);
            }
        }
    }

    fn monitor_work_area(m: &tauri::Monitor) -> (f64, f64, f64, f64) {
        let area = m.work_area();
        (
            area.position.x as f64,
            area.position.y as f64,
            area.size.width as f64,
            area.size.height as f64,
        )
    }

    fn monitor_for_point(app: &AppHandle, cx: f64, cy: f64) -> Option<tauri::Monitor> {
        let monitors = app.available_monitors().ok()?;
        let mut nearest: Option<(f64, tauri::Monitor)> = None;
        for m in monitors {
            let area = m.work_area();
            let ax = area.position.x as f64;
            let ay = area.position.y as f64;
            let aw = area.size.width as f64;
            let ah = area.size.height as f64;
            if cx >= ax && cx < ax + aw && cy >= ay && cy < ay + ah {
                return Some(m);
            }
            let dx = (ax - cx).max(cx - (ax + aw)).max(0.0);
            let dy = (ay - cy).max(cy - (ay + ah)).max(0.0);
            let d2 = dx * dx + dy * dy;
            if nearest.as_ref().map(|(best, _)| d2 < *best).unwrap_or(true) {
                nearest = Some((d2, m));
            }
        }
        nearest.map(|(_, m)| m)
    }

    fn work_area_for_window(app: &AppHandle, win: &WebviewWindow) -> Option<(f64, f64, f64, f64)> {
        let pos = win.outer_position().ok()?;
        let size = win.outer_size().ok()?;
        let cx = pos.x as f64 + size.width as f64 / 2.0;
        let cy = pos.y as f64 + size.height as f64 / 2.0;
        let monitor =
            monitor_for_point(app, cx, cy).or_else(|| app.primary_monitor().ok().flatten())?;
        Some(monitor_work_area(&monitor))
    }

    fn ball_xy_for_placement(
        app: &AppHandle,
        p: &FbPlacement,
        ball_extent: Option<f64>,
    ) -> (f64, f64) {
        let monitor = p
            .monitor
            .as_deref()
            .and_then(|name| {
                app.available_monitors()
                    .ok()?
                    .into_iter()
                    .find(|m| m.name().map(|n| n.as_str()) == Some(name))
            })
            .or_else(|| app.primary_monitor().ok().flatten());
        let extent = ball_extent.unwrap_or_else(|| {
            BALL_WIN * monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0)
        });
        let (ax, ay, aw, ah) = monitor
            .as_ref()
            .map(monitor_work_area)
            .unwrap_or((0.0, 0.0, 1440.0, 900.0));
        let x = if p.dock == "left" {
            ax + EDGE_MARGIN
        } else {
            ax + aw - extent - EDGE_MARGIN
        };
        let y = (ay + p.y_ratio * ah).clamp(ay, ay + ah - extent);
        (x, y)
    }

    fn ensure_windows(app: &AppHandle) -> Result<(), String> {
        if app.get_webview_window(BALL_LABEL).is_none() {
            let win = WebviewWindowBuilder::new(app, BALL_LABEL, WebviewUrl::default())
                .scroll_bar_style(crate::webview_policy::scroll_bar_style())
                .title("MyAgents Ball")
                .inner_size(BALL_WIN, BALL_WIN)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .focused(false)
                .focusable(false)
                .always_on_top(true)
                .visible(false)
                .skip_taskbar(true)
                .build()
                .map_err(|e| format!("[fb] create windows ball window: {e}"))?;
            let hwnd = hwnd_for(&win)?;
            BALL_HWND.store(hwnd as usize, Ordering::SeqCst);
            apply_tool_window_styles(&win, true)?;
            let placement = load_placement();
            let ball_extent = win.outer_size().ok().map(|s| s.width.max(s.height) as f64);
            let (x, y) = ball_xy_for_placement(app, &placement, ball_extent);
            let _ = win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
        }

        if app.get_webview_window(COMPANION_LABEL).is_none() {
            let win = WebviewWindowBuilder::new(app, COMPANION_LABEL, WebviewUrl::default())
                .scroll_bar_style(crate::webview_policy::scroll_bar_style())
                .title("MyAgents Companion")
                .inner_size(COMPANION_W, COMPANION_H)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .focused(false)
                .focusable(true)
                .always_on_top(true)
                .visible(false)
                .skip_taskbar(true)
                .build()
                .map_err(|e| format!("[fb] create windows companion window: {e}"))?;
            let hwnd = hwnd_for(&win)?;
            COMPANION_HWND.store(hwnd as usize, Ordering::SeqCst);
            apply_tool_window_styles(&win, true)?;
            position_companion_near_ball(app, &win);
        }
        // A partial destroy can leave a valid Tauri window after its cached
        // HWND/WndProc state was already retired. Re-enable always rebuilds
        // those native records from the current window objects.
        let ball = app
            .get_webview_window(BALL_LABEL)
            .ok_or("[fb] ball window missing after ensure")?;
        let ball_hwnd = hwnd_for(&ball)?;
        BALL_HWND.store(ball_hwnd as usize, Ordering::SeqCst);
        apply_tool_window_styles(&ball, true)?;
        let companion = app
            .get_webview_window(COMPANION_LABEL)
            .ok_or("[fb] companion window missing after ensure")?;
        let companion_hwnd = hwnd_for(&companion)?;
        COMPANION_HWND.store(companion_hwnd as usize, Ordering::SeqCst);
        apply_tool_window_styles(&companion, true)?;
        Ok(())
    }

    pub fn enable(app: &AppHandle) -> Result<(), String> {
        FLOATING_ACTIVE.store(false, Ordering::SeqCst);
        ensure_windows(app)?;
        let ball = app
            .get_webview_window(BALL_LABEL)
            .ok_or("[fb] ball window missing after ensure")?;
        apply_tool_window_styles(&ball, true)?;
        show_no_activate(&ball)?;
        FLOATING_ACTIVE.store(true, Ordering::SeqCst);
        let _ = app.emit_to(
            COMPANION_LABEL,
            "fb:lifecycle",
            serde_json::json!({ "active": true }),
        );
        start_hover_poller(app);
        start_foreground_poller(app);
        ulog_info!("[fb] floating ball enabled on Windows");
        Ok(())
    }

    fn destroy_surface(
        app: &AppHandle,
        label: &str,
        cached_hwnd: &AtomicUsize,
    ) -> Result<(), String> {
        let mut errors = Vec::new();
        let hwnd = cached_hwnd.swap(0, Ordering::SeqCst) as HWND;
        if let Err(error) = restore_window_proc(hwnd, label) {
            errors.push(error);
        }
        if let Some(window) = app.get_webview_window(label) {
            hide_window_strict(&window);
            if let Err(error) = window.destroy() {
                errors.push(format!("stage=window-destroy label={label} error={error}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub fn disable(app: &AppHandle) -> Result<(), String> {
        FLOATING_ACTIVE.store(false, Ordering::SeqCst);
        COMPANION_PINNED.store(false, Ordering::SeqCst);
        COMPANION_PINNED_AT_MS.store(0, Ordering::SeqCst);
        LAST_FOREGROUND_HWND.store(0, Ordering::SeqCst);
        clear_drag_sessions();
        stop_hover_poller();
        stop_foreground_poller();
        let mut errors = Vec::new();
        for label in super::WINDOWS_SURFACE_LABELS {
            let cached_hwnd = if *label == COMPANION_LABEL {
                &COMPANION_HWND
            } else {
                &BALL_HWND
            };
            if let Err(error) = destroy_surface(app, label, cached_hwnd) {
                errors.push(error);
            }
        }
        LAST_FOREGROUND_HWND.store(0, Ordering::SeqCst);
        if errors.is_empty() {
            ulog_info!("[fb] floating ball disabled and surfaces destroyed on Windows");
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub fn capabilities(app: &AppHandle) -> FbCapabilities {
        let active = app
            .get_webview_window(BALL_LABEL)
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false);
        FbCapabilities {
            supported: true,
            active,
        }
    }

    fn mouse_location() -> Option<(f64, f64)> {
        unsafe {
            let mut p = POINT { x: 0, y: 0 };
            if GetCursorPos(&mut p) == 0 {
                None
            } else {
                Some((p.x as f64, p.y as f64))
            }
        }
    }

    fn mouse_in_window(win: &WebviewWindow, mouse: (f64, f64)) -> bool {
        let Ok(pos) = win.outer_position() else {
            return false;
        };
        let Ok(size) = win.outer_size() else {
            return false;
        };
        let (mx, my) = mouse;
        mx >= pos.x as f64
            && mx <= pos.x as f64 + size.width as f64
            && my >= pos.y as f64
            && my <= pos.y as f64 + size.height as f64
    }

    fn start_hover_poller(app: &AppHandle) {
        let generation = HOVER_POLLER_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut ball_inside = false;
            let mut comp_inside = false;
            loop {
                if !super::lifecycle_generation_is_current(
                    HOVER_POLLER_GENERATION.load(Ordering::SeqCst),
                    generation,
                ) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                if !super::lifecycle_generation_is_current(
                    HOVER_POLLER_GENERATION.load(Ordering::SeqCst),
                    generation,
                ) {
                    break;
                }
                let _lifecycle_guard = super::lock_native_lifecycle();
                if !super::lifecycle_generation_is_current(
                    HOVER_POLLER_GENERATION.load(Ordering::SeqCst),
                    generation,
                ) {
                    break;
                }
                let mouse = mouse_location();
                let ball = app
                    .get_webview_window(BALL_LABEL)
                    .filter(|w| w.is_visible().unwrap_or(false));
                let comp = app
                    .get_webview_window(COMPANION_LABEL)
                    .filter(|w| w.is_visible().unwrap_or(false));
                let ball_in = match (&mouse, &ball) {
                    (Some(m), Some(w)) => Some(mouse_in_window(w, *m)),
                    _ => ball.map(|_| false),
                };
                let comp_in = match (&mouse, &comp) {
                    (Some(m), Some(w)) => Some(mouse_in_window(w, *m)),
                    _ => comp.map(|_| false),
                };
                if let Some(inside) = ball_in {
                    if inside != ball_inside {
                        ball_inside = inside;
                        let _ = app.emit_to(
                            BALL_LABEL,
                            "fb:native-hover",
                            serde_json::json!({ "inside": inside }),
                        );
                    }
                }
                if let Some(inside) = comp_in {
                    if inside != comp_inside {
                        comp_inside = inside;
                        let _ = app.emit_to(
                            COMPANION_LABEL,
                            "fb:native-hover",
                            serde_json::json!({ "inside": inside }),
                        );
                    }
                }
            }
            ulog_info!("[fb] windows hover poller stopped");
        });
        ulog_info!("[fb] windows hover poller started");
    }

    fn stop_hover_poller() {
        HOVER_POLLER_GENERATION.fetch_add(1, Ordering::SeqCst);
    }

    fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn start_foreground_poller(app: &AppHandle) {
        let generation = FOREGROUND_POLLER_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                if !super::lifecycle_generation_is_current(
                    FOREGROUND_POLLER_GENERATION.load(Ordering::SeqCst),
                    generation,
                ) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                if !super::lifecycle_generation_is_current(
                    FOREGROUND_POLLER_GENERATION.load(Ordering::SeqCst),
                    generation,
                ) {
                    break;
                }
                let _lifecycle_guard = super::lock_native_lifecycle();
                if FOREGROUND_POLLER_GENERATION.load(Ordering::SeqCst) != generation {
                    break;
                }
                if !COMPANION_PINNED.load(Ordering::SeqCst) {
                    continue;
                }
                let pinned_at = COMPANION_PINNED_AT_MS.load(Ordering::SeqCst);
                if now_millis().saturating_sub(pinned_at) < 350 {
                    continue;
                }
                let foreground = unsafe { GetForegroundWindow() };
                if foreground.is_null() || hwnd_is_ours(foreground) {
                    continue;
                }

                ulog_info!("[fb] windows companion hiding after foreground moved outside");
                hide_companion(&app);
                let _ = app.emit_to(
                    BALL_LABEL,
                    "fb:companion-mode",
                    serde_json::json!({ "mode": "hidden" }),
                );
                let _ = app.emit_to(
                    COMPANION_LABEL,
                    "fb:force-hidden",
                    serde_json::json!({ "reason": "foreground-lost" }),
                );
            }
        });
        ulog_info!("[fb] windows foreground poller started");
    }

    fn stop_foreground_poller() {
        FOREGROUND_POLLER_GENERATION.fetch_add(1, Ordering::SeqCst);
    }

    fn window_origin(win: &WebviewWindow) -> Result<(f64, f64), String> {
        let pos = win
            .outer_position()
            .map_err(|e| format!("[fb] read window position: {e}"))?;
        Ok((pos.x as f64, pos.y as f64))
    }

    fn start_native_drag(
        app: &AppHandle,
        label: &str,
        slot: &Mutex<Option<NativeDragSession>>,
    ) -> Result<(), String> {
        let win = app
            .get_webview_window(label)
            .ok_or_else(|| format!("[fb] {label} window missing"))?;
        let (mx, my) = mouse_location().ok_or("[fb] mouse location unavailable")?;
        let (wx, wy) = window_origin(&win)?;
        let mut guard = slot
            .lock()
            .map_err(|_| "[fb] native drag lock poisoned".to_string())?;
        *guard = Some(NativeDragSession {
            grab_x: mx - wx,
            grab_y: my - wy,
            last_x: wx,
            last_y: wy,
        });
        Ok(())
    }

    fn move_native_drag_to_mouse(
        app: &AppHandle,
        label: &str,
        slot: &Mutex<Option<NativeDragSession>>,
    ) -> Result<Option<(f64, f64)>, String> {
        let win = app
            .get_webview_window(label)
            .ok_or_else(|| format!("[fb] {label} window missing"))?;
        let Some((mx, my)) = mouse_location() else {
            return Ok(None);
        };
        let mut guard = slot
            .lock()
            .map_err(|_| "[fb] native drag lock poisoned".to_string())?;
        let Some(session) = guard.as_mut() else {
            return Ok(None);
        };
        let x = mx - session.grab_x;
        let y = my - session.grab_y;
        session.last_x = x;
        session.last_y = y;
        let _ = win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
        Ok(Some((x, y)))
    }

    fn end_native_drag(
        slot: &Mutex<Option<NativeDragSession>>,
    ) -> Result<Option<NativeDragSession>, String> {
        let mut guard = slot
            .lock()
            .map_err(|_| "[fb] native drag lock poisoned".to_string())?;
        Ok(guard.take())
    }

    pub fn start_ball_drag(app: &AppHandle) -> Result<(), String> {
        start_native_drag(app, BALL_LABEL, &BALL_DRAG)
    }

    pub fn move_ball_drag(app: &AppHandle) -> Result<(), String> {
        let _ = move_native_drag_to_mouse(app, BALL_LABEL, &BALL_DRAG)?;
        Ok(())
    }

    pub fn end_ball_drag(app: &AppHandle) -> Result<SnapResult, String> {
        let session = end_native_drag(&BALL_DRAG)?.ok_or("[fb] ball native drag is not active")?;
        let (x, y) = if let Some((mx, my)) = mouse_location() {
            (mx - session.grab_x, my - session.grab_y)
        } else {
            (session.last_x, session.last_y)
        };
        snap_ball(app, x, y)
    }

    pub fn cancel_ball_drag() -> Result<(), String> {
        let _ = end_native_drag(&BALL_DRAG)?;
        Ok(())
    }

    pub fn start_companion_drag(app: &AppHandle) -> Result<(), String> {
        start_native_drag(app, COMPANION_LABEL, &COMPANION_DRAG)
    }

    pub fn move_companion_drag(app: &AppHandle) -> Result<(), String> {
        let _ = move_native_drag_to_mouse(app, COMPANION_LABEL, &COMPANION_DRAG)?;
        Ok(())
    }

    pub fn end_companion_drag() -> Result<(), String> {
        let _ = end_native_drag(&COMPANION_DRAG)?;
        Ok(())
    }

    fn position_companion_near_ball(app: &AppHandle, companion: &WebviewWindow) {
        let Some(ball) = app.get_webview_window(BALL_LABEL) else {
            return;
        };
        let Ok(bpos) = ball.outer_position() else {
            return;
        };
        let Ok(bsize) = ball.outer_size() else {
            return;
        };
        let Ok(csize) = companion.outer_size() else {
            return;
        };
        let (ax, ay, aw, ah) =
            work_area_for_window(app, &ball).unwrap_or((0.0, 0.0, 1440.0, 900.0));
        let scale = ball.scale_factor().unwrap_or(1.0);
        let gap = COMPANION_GAP * scale;
        let margin = 8.0 * scale;
        let ball_w = bsize.width as f64;
        let ball_h = bsize.height as f64;
        let comp_w = csize.width as f64;
        let comp_h = csize.height as f64;
        let dock_right = bpos.x as f64 + ball_w / 2.0 > ax + aw / 2.0;
        let mut x = if dock_right {
            bpos.x as f64 - gap - comp_w
        } else {
            bpos.x as f64 + ball_w + gap
        };
        x = x.clamp(ax + margin, ax + aw - comp_w - margin);
        let mut y = bpos.y as f64 + ball_h / 2.0 - comp_h * 0.25;
        y = y.clamp(ay + margin, (ay + ah - comp_h - margin).max(ay + margin));
        let _ = companion.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }

    pub fn show_companion(app: &AppHandle, mode: &str) -> Result<(), String> {
        if !FLOATING_ACTIVE.load(Ordering::SeqCst) {
            return Err("[fb] floating ball is disabled".to_string());
        }
        ensure_windows(app)?;
        let companion = app
            .get_webview_window(COMPANION_LABEL)
            .ok_or("[fb] companion window missing")?;
        position_companion_near_ball(app, &companion);
        if mode == "pin" {
            remember_foreground_context();
            apply_tool_window_styles(&companion, false)?;
            COMPANION_PINNED.store(true, Ordering::SeqCst);
            COMPANION_PINNED_AT_MS.store(now_millis(), Ordering::SeqCst);
            let _ = companion.show();
            unsafe {
                let hwnd = hwnd_for(&companion)?;
                SetForegroundWindow(hwnd);
            }
            let _ = companion.set_focus();
        } else {
            COMPANION_PINNED.store(false, Ordering::SeqCst);
            COMPANION_PINNED_AT_MS.store(0, Ordering::SeqCst);
            apply_tool_window_styles(&companion, true)?;
            show_no_activate(&companion)?;
        }
        Ok(())
    }

    pub fn pin_companion(app: &AppHandle) -> Result<(), String> {
        if !FLOATING_ACTIVE.load(Ordering::SeqCst) {
            return Err("[fb] floating ball is disabled".to_string());
        }
        ensure_windows(app)?;
        let companion = app
            .get_webview_window(COMPANION_LABEL)
            .ok_or("[fb] companion window missing")?;
        remember_foreground_context();
        apply_tool_window_styles(&companion, false)?;
        COMPANION_PINNED.store(true, Ordering::SeqCst);
        COMPANION_PINNED_AT_MS.store(now_millis(), Ordering::SeqCst);
        let _ = companion.show();
        unsafe {
            let hwnd = hwnd_for(&companion)?;
            SetForegroundWindow(hwnd);
        }
        let _ = companion.set_focus();
        Ok(())
    }

    pub fn hide_companion(app: &AppHandle) {
        COMPANION_PINNED.store(false, Ordering::SeqCst);
        COMPANION_PINNED_AT_MS.store(0, Ordering::SeqCst);
        let should_restore_focus = unsafe { hwnd_is_ours(GetForegroundWindow()) };
        if let Some(companion) = app.get_webview_window(COMPANION_LABEL) {
            let _ = apply_tool_window_styles(&companion, true);
            hide_window_strict(&companion);
        }
        let prev = LAST_FOREGROUND_HWND.swap(0, Ordering::SeqCst) as HWND;
        if should_restore_focus && !prev.is_null() && !hwnd_is_ours(prev) {
            unsafe {
                if IsWindow(prev) != 0 && IsWindowVisible(prev) != 0 {
                    SetForegroundWindow(prev);
                }
            }
        }
    }

    pub fn dismiss_from_shield(app: &AppHandle) {
        hide_companion(app);
        let _ = app.emit_to(
            BALL_LABEL,
            "fb:companion-mode",
            serde_json::json!({ "mode": "hidden" }),
        );
        let _ = app.emit_to(
            COMPANION_LABEL,
            "fb:force-hidden",
            serde_json::json!({ "reason": "shield-click" }),
        );
    }

    pub fn move_ball_to(app: &AppHandle, x: f64, y: f64) -> Result<(), String> {
        let ball = app
            .get_webview_window(BALL_LABEL)
            .ok_or("[fb] ball window missing")?;
        let _ = ball.set_position(LogicalPosition::new(x, y));
        Ok(())
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SnapResult {
        pub dock: String,
    }

    fn snap_decision(
        cx: f64,
        ball_y: f64,
        ax: f64,
        ay: f64,
        aw: f64,
        ah: f64,
    ) -> (&'static str, f64) {
        let dock = if cx < ax + aw / 2.0 { "left" } else { "right" };
        let y_ratio = ((ball_y - ay) / ah).clamp(0.02, 0.92);
        (dock, y_ratio)
    }

    pub fn snap_ball(app: &AppHandle, ball_x: f64, ball_y: f64) -> Result<SnapResult, String> {
        let ball = app
            .get_webview_window(BALL_LABEL)
            .ok_or("[fb] ball window missing")?;
        let size = ball
            .outer_size()
            .map_err(|e| format!("[fb] ball size: {e}"))?;
        let (cx, cy) = (
            ball_x + size.width as f64 / 2.0,
            ball_y + size.height as f64 / 2.0,
        );
        let monitor =
            monitor_for_point(app, cx, cy).or_else(|| app.primary_monitor().ok().flatten());
        let (ax, ay, aw, ah) = monitor
            .as_ref()
            .map(monitor_work_area)
            .unwrap_or((0.0, 0.0, 1440.0, 900.0));
        let (dock, y_ratio) = snap_decision(cx, ball_y, ax, ay, aw, ah);
        let placement = FbPlacement {
            dock: dock.to_string(),
            y_ratio,
            monitor: monitor.as_ref().and_then(|m| m.name().cloned()),
        };
        save_placement(&placement);
        let ball_extent = Some(size.width.max(size.height) as f64);
        let (x, y) = ball_xy_for_placement(app, &placement, ball_extent);
        let _ = ball.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
        Ok(SnapResult {
            dock: dock.to_string(),
        })
    }

    pub fn set_companion_size(app: &AppHandle, width: f64, height: f64) -> Result<(), String> {
        let companion = app
            .get_webview_window(COMPANION_LABEL)
            .ok_or("[fb] companion window missing")?;
        let _ = companion.set_size(LogicalSize::new(width.max(360.0), height.max(320.0)));
        Ok(())
    }

    pub fn move_companion_to(app: &AppHandle, x: f64, y: f64) -> Result<(), String> {
        let companion = app
            .get_webview_window(COMPANION_LABEL)
            .ok_or("[fb] companion window missing")?;
        let _ = companion.set_position(LogicalPosition::new(x, y));
        Ok(())
    }

    fn title_for_hwnd(hwnd: HWND) -> Option<String> {
        if hwnd.is_null() {
            return None;
        }
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return None;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let read = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if read <= 0 {
                return None;
            }
            let title = String::from_utf16_lossy(&buf[..read as usize]);
            let trimmed = title.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
    }

    fn process_name_for_hwnd(hwnd: HWND) -> Option<String> {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 || pid == std::process::id() {
                return None;
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 32768];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut size);
            let _ = CloseHandle(process);
            if ok == 0 || size == 0 {
                return None;
            }
            let os = OsString::from_wide(&buf[..size as usize]);
            let name = PathBuf::from(os)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string());
            name.filter(|s| !s.is_empty() && s != "MyAgents")
        }
    }

    fn capture_hwnd_context(hwnd: HWND) -> FbContext {
        if hwnd.is_null() || hwnd_is_ours(hwnd) {
            return FbContext::default();
        }
        FbContext {
            app_name: process_name_for_hwnd(hwnd),
            window_title: title_for_hwnd(hwnd),
            selection: None,
        }
    }

    fn current_foreground_context() -> FbContext {
        unsafe {
            let hwnd = GetForegroundWindow();
            capture_hwnd_context(hwnd)
        }
    }

    fn remember_foreground_context() {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() || hwnd_is_ours(hwnd) {
                return;
            }
            LAST_FOREGROUND_HWND.store(hwnd as usize, Ordering::SeqCst);
            let ctx = capture_hwnd_context(hwnd);
            if let Ok(mut guard) = LAST_CONTEXT.lock() {
                *guard = Some(ctx);
            }
        }
    }

    pub fn capture_context() -> FbContext {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd_is_ours(hwnd) {
                return LAST_CONTEXT
                    .lock()
                    .ok()
                    .and_then(|g| g.clone())
                    .unwrap_or_default();
            }
            let ctx = capture_hwnd_context(hwnd);
            if let Ok(mut guard) = LAST_CONTEXT.lock() {
                *guard = Some(ctx.clone());
            }
            ctx
        }
    }

    pub fn ax_trusted(_prompt: bool) -> bool {
        true
    }

    fn ps_single_quote(s: &str) -> String {
        s.replace('\'', "''")
    }

    fn encode_powershell(script: &str) -> String {
        let mut utf16le = Vec::with_capacity(script.len() * 2);
        for c in script.encode_utf16() {
            utf16le.extend_from_slice(&c.to_le_bytes());
        }
        base64::engine::general_purpose::STANDARD.encode(utf16le)
    }

    fn powershell_path() -> PathBuf {
        if let Some(path) = crate::system_binary::find("powershell.exe")
            .or_else(|| crate::system_binary::find("powershell"))
        {
            return path;
        }
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        system_root
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe")
    }

    fn truncate_process_output(bytes: &[u8]) -> String {
        const MAX_CHARS: usize = 1200;
        let text = String::from_utf8_lossy(bytes).trim().to_string();
        if text.chars().count() <= MAX_CHARS {
            return text;
        }
        let mut truncated = text.chars().take(MAX_CHARS).collect::<String>();
        truncated.push_str("...");
        truncated
    }

    fn run_powershell(script: &str) -> Result<(), String> {
        let encoded = encode_powershell(script);
        let shell = powershell_path();
        let output = match crate::process_cmd::new(shell.as_os_str())
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                &encoded,
            ])
            .output()
        {
            Ok(output) => output,
            Err(e) => {
                ulog_warn!(
                    "[fb] powershell spawn failed shell={} error={e}",
                    shell.display()
                );
                return Err(format!("[fb] powershell spawn: {e}"));
            }
        };
        if output.status.success() {
            Ok(())
        } else {
            let stdout = truncate_process_output(&output.stdout);
            let stderr = truncate_process_output(&output.stderr);
            ulog_warn!(
                "[fb] powershell command failed status={} stdout={} stderr={}",
                output.status,
                stdout,
                stderr
            );
            let detail = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                output.status.to_string()
            };
            Err(format!("[fb] powershell command failed: {detail}"))
        }
    }

    fn capture_screen_jpeg(path: &Path, max_dim: u32, quality: u32) -> Result<(), String> {
        let path_str = path
            .to_str()
            .ok_or("[fb] screenshot temp path is not utf-8")?;
        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$path = '{path}'
$maxDim = [double]{max_dim}
$quality = [int64]{quality}
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {{
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $scale = [Math]::Min(1.0, $maxDim / [Math]::Max($bounds.Width, $bounds.Height))
  $width = [Math]::Max(1, [int][Math]::Round($bounds.Width * $scale))
  $height = [Math]::Max(1, [int][Math]::Round($bounds.Height * $scale))
  $resized = New-Object System.Drawing.Bitmap($width, $height)
  $resizeGraphics = [System.Drawing.Graphics]::FromImage($resized)
  try {{
    $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $resizeGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $resizeGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $resizeGraphics.DrawImage($bitmap, 0, 0, $width, $height)
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {{ $_.MimeType -eq 'image/jpeg' }} | Select-Object -First 1
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $quality)
    $resized.Save($path, $codec, $params)
  }} finally {{
    $resizeGraphics.Dispose()
    $resized.Dispose()
  }}
}} finally {{
  $graphics.Dispose()
  $bitmap.Dispose()
}}
"#,
            path = ps_single_quote(path_str),
            max_dim = max_dim,
            quality = quality,
        );
        run_powershell(&script).map_err(|e| format!("{e}: screenshot capture"))
    }

    pub fn screenshot() -> Result<FbScreenshot, String> {
        let ctx = LAST_CONTEXT
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(current_foreground_context);
        let id = uuid::Uuid::new_v4();
        const SCREENSHOT_BUDGET_BYTES: usize = 192 * 1024;
        const ATTEMPTS: &[(u32, u32)] = &[
            (1600, 72),
            (1280, 62),
            (1024, 54),
            (800, 46),
            (640, 40),
            (480, 34),
        ];
        let mut selected: Option<Vec<u8>> = None;
        let mut last_size = 0usize;
        for (idx, (max_dim, quality)) in ATTEMPTS.iter().copied().enumerate() {
            let jpg =
                std::env::temp_dir().join(format!("myagents-fb-shot-{id}-{max_dim}-{quality}.jpg"));
            ulog_info!(
                "[fb] screenshot capture attempt={} max_dim={} quality={} path={}",
                idx + 1,
                max_dim,
                quality,
                jpg.display()
            );
            if let Err(e) = capture_screen_jpeg(&jpg, max_dim, quality) {
                ulog_warn!(
                    "[fb] screenshot capture failed attempt={} max_dim={} quality={} error={e}",
                    idx + 1,
                    max_dim,
                    quality
                );
                let _ = std::fs::remove_file(&jpg);
                return Err(e);
            }
            let bytes = match std::fs::read(&jpg) {
                Ok(bytes) => bytes,
                Err(e) => {
                    ulog_warn!(
                        "[fb] screenshot read failed attempt={} path={} error={e}",
                        idx + 1,
                        jpg.display()
                    );
                    let _ = std::fs::remove_file(&jpg);
                    return Err(format!("[fb] read screenshot: {e}"));
                }
            };
            let _ = std::fs::remove_file(&jpg);
            if bytes.is_empty() {
                ulog_warn!(
                    "[fb] screenshot capture returned empty file attempt={} max_dim={} quality={}",
                    idx + 1,
                    max_dim,
                    quality
                );
                return Err("[fb] empty screenshot".to_string());
            }
            last_size = bytes.len();
            ulog_info!(
                "[fb] screenshot capture produced attempt={} max_dim={} quality={} bytes={}",
                idx + 1,
                max_dim,
                quality,
                last_size
            );
            if last_size <= SCREENSHOT_BUDGET_BYTES || idx + 1 == ATTEMPTS.len() {
                selected = Some(bytes);
                break;
            }
        }
        let bytes = selected.ok_or_else(|| {
            ulog_warn!("[fb] screenshot compression failed without selected bytes");
            "[fb] screenshot compression failed".to_string()
        })?;
        if bytes.len() > SCREENSHOT_BUDGET_BYTES {
            ulog_warn!(
                "[fb] compressed Windows screenshot still above IPC budget: {last_size} bytes"
            );
            return Err(format!(
                "[fb] screenshot too large after compression: {last_size} bytes"
            ));
        }
        if bytes.is_empty() {
            ulog_warn!("[fb] screenshot selected bytes unexpectedly empty");
            return Err("[fb] empty screenshot".to_string());
        }
        ulog_info!("[fb] screenshot capture succeeded bytes={}", bytes.len());
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(FbScreenshot {
            data_url: format!("data:image/jpeg;base64,{b64}"),
            app_name: ctx.app_name,
            window_title: ctx.window_title,
        })
    }

    pub fn relay(app: &AppHandle, target: &str, event: &str, payload: serde_json::Value) {
        let label = match target {
            "ball" => BALL_LABEL,
            _ => COMPANION_LABEL,
        };
        if let Err(e) = app.emit_to(label, event, payload) {
            ulog_error!("[fb] relay {event} -> {label} failed: {e}");
        }
    }
}

// ════════════════════════════════════════════════════════════════════════
// Tauri commands (cross-platform surface; stubs on unsupported desktop OSes)
// ════════════════════════════════════════════════════════════════════════

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod commands {
    use super::imp;
    use super::{FbCapabilities, FbContext, FbScreenshot};
    use tauri::{AppHandle, State};

    #[cfg(target_os = "macos")]
    fn run_native_window_op<T, F>(
        app: AppHandle,
        join_label: &'static str,
        f: F,
    ) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
    {
        let _lifecycle_guard = super::lock_native_lifecycle();
        let (tx, rx) = std::sync::mpsc::channel();
        app.clone()
            .run_on_main_thread(move || {
                let _ = tx.send(f(&app));
            })
            .map_err(|e| format!("[fb] main thread dispatch: {e}"))?;
        rx.recv()
            .map_err(|e| format!("[fb] {join_label} join: {e}"))?
    }

    #[cfg(target_os = "windows")]
    fn run_native_window_op<T, F>(
        app: AppHandle,
        _join_label: &'static str,
        f: F,
    ) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
    {
        let _lifecycle_guard = super::lock_native_lifecycle();
        f(&app)
    }

    #[tauri::command]
    pub async fn cmd_fb_enable(
        app: AppHandle,
        sidecars: State<'_, crate::sidecar::ManagedSidecarManager>,
    ) -> Result<(), String> {
        crate::ulog_info!("[fb] cmd_fb_enable requested");
        super::set_companion_owner_admitted(true);
        let native_result = run_native_window_op(app.clone(), "enable", imp::enable);
        if let Err(native_error) = native_result {
            super::set_companion_owner_admitted(false);
            let cleanup_result = run_native_window_op(app, "failed enable cleanup", imp::disable);
            let owner_result = crate::sidecar::release_session_owner_everywhere(
                sidecars.inner(),
                &super::floating_ball_companion_owner(),
            )
            .await;
            let error = format!(
                "stage=enable error={native_error}; cleanup={}; ownerRelease={}",
                cleanup_result.err().unwrap_or_else(|| "ok".to_string()),
                owner_result.err().unwrap_or_else(|| "ok".to_string())
            );
            crate::ulog_error!("[fb] {error}");
            return Err(error);
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn cmd_fb_disable(
        app: AppHandle,
        sidecars: State<'_, crate::sidecar::ManagedSidecarManager>,
    ) -> Result<(), String> {
        crate::ulog_info!("[fb] cmd_fb_disable requested");
        super::set_companion_owner_admitted(false);
        let owner_result = crate::sidecar::release_session_owner_everywhere(
            sidecars.inner(),
            &super::floating_ball_companion_owner(),
        )
        .await;
        let native_result = run_native_window_op(app.clone(), "disable", imp::disable);
        if owner_result.is_ok() && native_result.is_ok() {
            return Ok(());
        }

        // Durable config is still enabled until this command succeeds. Restore
        // effective state inside the same toggle transaction and report every
        // failed phase so Renderer can keep the switch on.
        super::set_companion_owner_admitted(true);
        let restore_result = run_native_window_op(app, "disable compensation", imp::enable);
        let error = format!(
            "stage=disable ownerRelease={} native={} compensation={}",
            owner_result.err().unwrap_or_else(|| "ok".to_string()),
            native_result.err().unwrap_or_else(|| "ok".to_string()),
            restore_result.err().unwrap_or_else(|| "ok".to_string())
        );
        crate::ulog_error!("[fb] {error}");
        Err(error)
    }

    #[tauri::command]
    pub async fn cmd_fb_capabilities(app: AppHandle) -> Result<FbCapabilities, String> {
        Ok(imp::capabilities(&app))
    }

    #[tauri::command]
    pub async fn cmd_fb_show_companion(app: AppHandle, mode: String) -> Result<(), String> {
        crate::ulog_info!("[fb] cmd_fb_show_companion requested mode={}", mode);
        run_native_window_op(app, "show companion", move |app| {
            imp::show_companion(app, &mode)
        })
    }

    /// NOTE: on macOS, channel-join waits until `make_key_window` has really
    /// run on the main thread. On Windows, WebView2 windows are not created via
    /// `run_on_main_thread`, so the same command surface calls the native op
    /// directly.
    #[tauri::command]
    pub async fn cmd_fb_pin_companion(app: AppHandle) -> Result<(), String> {
        crate::ulog_info!("[fb] cmd_fb_pin_companion requested");
        run_native_window_op(app, "pin", imp::pin_companion)
    }

    #[tauri::command]
    pub async fn cmd_fb_hide_companion(app: AppHandle) -> Result<(), String> {
        crate::ulog_info!("[fb] cmd_fb_hide_companion requested");
        run_native_window_op(app, "hide companion", |app| {
            imp::hide_companion(app);
            Ok(())
        })
    }

    #[tauri::command]
    pub async fn cmd_fb_shield_dismiss(app: AppHandle) -> Result<(), String> {
        crate::ulog_info!("[fb] cmd_fb_shield_dismiss requested");
        run_native_window_op(app, "shield dismiss", |app| {
            imp::dismiss_from_shield(app);
            Ok(())
        })
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_ball_start(app: AppHandle) -> Result<(), String> {
        run_native_window_op(app, "ball drag start", imp::start_ball_drag)
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_ball_move(app: AppHandle) -> Result<(), String> {
        run_native_window_op(app, "ball drag move", |app| {
            if let Err(e) = imp::move_ball_drag(app) {
                crate::ulog_warn!("[fb] ball drag move failed: {e}");
            }
            Ok(())
        })
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_ball_end(app: AppHandle) -> Result<imp::SnapResult, String> {
        run_native_window_op(app, "ball drag end", imp::end_ball_drag)
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_ball_cancel(app: AppHandle) -> Result<(), String> {
        run_native_window_op(app, "ball drag cancel", |_app| imp::cancel_ball_drag())
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_companion_start(app: AppHandle) -> Result<(), String> {
        run_native_window_op(app, "companion drag start", imp::start_companion_drag)
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_companion_move(app: AppHandle) -> Result<(), String> {
        run_native_window_op(app, "companion drag move", |app| {
            if let Err(e) = imp::move_companion_drag(app) {
                crate::ulog_warn!("[fb] companion drag move failed: {e}");
            }
            Ok(())
        })
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_companion_end(app: AppHandle) -> Result<(), String> {
        run_native_window_op(app, "companion drag end", |_app| imp::end_companion_drag())
    }

    /// Legacy absolute-position command. Runtime drag uses `cmd_fb_drag_ball_*`
    /// so native mouse/window coordinates stay in Rust.
    #[tauri::command]
    pub async fn cmd_fb_move_ball_to(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
        imp::move_ball_to(&app, x, y)
    }

    /// Legacy snap command kept for compatibility. Runtime ball drag ends via
    /// `cmd_fb_drag_ball_end`, which computes the final point from the native
    /// drag session before calling `snap_ball`.
    #[tauri::command]
    pub async fn cmd_fb_snap_ball(
        app: AppHandle,
        x: f64,
        y: f64,
    ) -> Result<imp::SnapResult, String> {
        run_native_window_op(app, "snap", move |app| imp::snap_ball(app, x, y))
    }

    #[tauri::command]
    pub async fn cmd_fb_move_companion_to(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
        imp::move_companion_to(&app, x, y)
    }

    #[tauri::command]
    pub async fn cmd_fb_set_companion_size(
        app: AppHandle,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        imp::set_companion_size(&app, width, height)
    }

    /// Eager context capture — blocking AX work off the async runtime.
    #[tauri::command]
    pub async fn cmd_fb_capture_context() -> Result<FbContext, String> {
        tauri::async_runtime::spawn_blocking(imp::capture_context)
            .await
            .map_err(|e| format!("[fb] capture join: {e}"))
    }

    #[tauri::command]
    pub async fn cmd_fb_ax_status(prompt: bool) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || imp::ax_trusted(prompt))
            .await
            .map_err(|e| format!("[fb] ax join: {e}"))
    }

    #[tauri::command]
    pub async fn cmd_fb_screenshot() -> Result<FbScreenshot, String> {
        let result = tauri::async_runtime::spawn_blocking(imp::screenshot)
            .await
            .map_err(|e| format!("[fb] screenshot join: {e}"))?;
        if let Err(e) = &result {
            crate::ulog_warn!("[fb] screenshot command failed: {e}");
        }
        result
    }

    /// Generic ball ⇄ companion event relay.
    #[tauri::command]
    pub async fn cmd_fb_relay(
        app: AppHandle,
        target: String,
        event: String,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        imp::relay(&app, &target, &event, payload);
        Ok(())
    }

    /// Summon the main window and open the companion's session in a new Tab.
    #[tauri::command]
    pub async fn cmd_fb_open_main_with_session(
        app: AppHandle,
        session_id: String,
        workspace_path: String,
        preview_path: Option<String>,
        preview_line: Option<u32>,
    ) -> Result<(), String> {
        use tauri::Emitter;
        #[cfg(target_os = "macos")]
        run_native_window_op(app.clone(), "suppress pin restore", |_app| {
            imp::suppress_pin_foreground_restore();
            Ok(())
        })?;
        crate::ulog_info!(
            "[fb] cmd_fb_open_main_with_session requested session_id={} workspace_path={} preview_path={:?} preview_line={:?}",
            session_id,
            workspace_path,
            preview_path,
            preview_line
        );
        crate::tray::show_main_window(&app);
        let preview = preview_path.map(|path| {
            serde_json::json!({
                "path": path,
                "initialLineNumber": preview_line,
            })
        });
        app.emit_to(
            "main",
            "fb:open-session",
            serde_json::json!({
                "sessionId": session_id,
                "workspacePath": workspace_path,
                "preview": preview,
            }),
        )
        .map_err(|e| format!("[fb] emit open-session: {e}"))
    }

    /// Summon the main app and navigate to Settings → Desktop Pet.
    #[tauri::command]
    pub async fn cmd_fb_open_desktop_pet_settings(app: AppHandle) -> Result<(), String> {
        use tauri::Emitter;
        #[cfg(target_os = "macos")]
        run_native_window_op(app.clone(), "suppress pin restore", |_app| {
            imp::suppress_pin_foreground_restore();
            Ok(())
        })?;
        crate::ulog_info!("[fb] cmd_fb_open_desktop_pet_settings requested");
        crate::tray::show_main_window(&app);
        app.emit_to(
            "main",
            "fb:open-desktop-pet-settings",
            serde_json::json!({}),
        )
        .map_err(|e| format!("[fb] emit open-desktop-pet-settings: {e}"))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod commands {
    use super::{FbCapabilities, FbContext, FbScreenshot};
    use tauri::AppHandle;

    const UNSUPPORTED: &str = "[fb] floating ball is unsupported on this OS";

    #[tauri::command]
    pub async fn cmd_fb_enable(_app: AppHandle) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_disable(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn cmd_fb_capabilities(_app: AppHandle) -> Result<FbCapabilities, String> {
        Ok(FbCapabilities {
            supported: false,
            active: false,
        })
    }

    #[tauri::command]
    pub async fn cmd_fb_show_companion(_app: AppHandle, _mode: String) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_pin_companion(_app: AppHandle) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_hide_companion(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn cmd_fb_shield_dismiss(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_ball_start(_app: AppHandle) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_ball_move(_app: AppHandle) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_ball_end(_app: AppHandle) -> Result<SnapResult, String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_ball_cancel(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_companion_start(_app: AppHandle) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_companion_move(_app: AppHandle) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_drag_companion_end(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn cmd_fb_move_ball_to(_app: AppHandle, _x: f64, _y: f64) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[derive(serde::Serialize)]
    pub struct SnapResult {
        pub dock: String,
    }

    #[tauri::command]
    pub async fn cmd_fb_snap_ball(_app: AppHandle, _x: f64, _y: f64) -> Result<SnapResult, String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_move_companion_to(_app: AppHandle, _x: f64, _y: f64) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_set_companion_size(
        _app: AppHandle,
        _width: f64,
        _height: f64,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_capture_context() -> Result<FbContext, String> {
        Ok(FbContext::default())
    }

    #[tauri::command]
    pub async fn cmd_fb_ax_status(_prompt: bool) -> Result<bool, String> {
        Ok(false)
    }

    #[tauri::command]
    pub async fn cmd_fb_screenshot() -> Result<FbScreenshot, String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_relay(
        _app: AppHandle,
        _target: String,
        _event: String,
        _payload: serde_json::Value,
    ) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn cmd_fb_open_main_with_session(
        _app: AppHandle,
        _session_id: String,
        _workspace_path: String,
        _preview_path: Option<String>,
        _preview_line: Option<u32>,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    #[tauri::command]
    pub async fn cmd_fb_open_desktop_pet_settings(app: AppHandle) -> Result<(), String> {
        use tauri::Emitter;
        crate::tray::show_main_window(&app);
        app.emit_to(
            "main",
            "fb:open-desktop-pet-settings",
            serde_json::json!({}),
        )
        .map_err(|e| format!("[fb] emit open-desktop-pet-settings: {e}"))
    }
}

pub use commands::*;

/// Startup hook: if the hidden developer gate + ball are both enabled in config,
/// bring the ball up without waiting for the frontend.
pub fn setup_on_startup(app: &tauri::AppHandle) {
    let cfg = load_fb_config();
    if !(cfg.dev_gate && cfg.enabled) || crate::travel_mate::should_suppress_pet_on_startup() {
        return;
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    set_companion_owner_admitted(true);
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            if let Err(e) = self::platform_enable(&app) {
                crate::ulog_warn!("[fb] startup enable failed: {e}");
            }
        });
    }
    #[cfg(target_os = "windows")]
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = self::platform_enable(&app) {
                crate::ulog_warn!("[fb] startup enable failed: {e}");
            }
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        crate::ulog_info!("[fb] enabled in config but unsupported on this OS — skipping");
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn platform_enable(app: &tauri::AppHandle) -> Result<(), String> {
    let _lifecycle_guard = lock_native_lifecycle();
    // A user disable can overtake the detached startup task. Admission is
    // closed synchronously at command entry, so the late task must not revive
    // surfaces from the still-not-yet-persisted startup config snapshot.
    let cfg = load_fb_config();
    if !startup_enable_is_authorized(
        COMPANION_OWNER_ADMITTED.load(Ordering::SeqCst),
        cfg.dev_gate,
        cfg.enabled,
    ) {
        // Do not write admission from a rejected startup snapshot: a newer
        // explicit enable may already own `true` while waiting for this lock.
        // Startup is allowed to consume its own old intent, never to overwrite
        // a later command decision.
        crate::ulog_info!("[fb] startup enable cancelled by newer lifecycle decision");
        return Ok(());
    }
    if let Err(error) = imp::enable(app) {
        set_companion_owner_admitted(false);
        let cleanup = imp::disable(app).err().unwrap_or_else(|| "ok".to_string());
        return Err(format!("{error}; cleanup={cleanup}"));
    }
    Ok(())
}
