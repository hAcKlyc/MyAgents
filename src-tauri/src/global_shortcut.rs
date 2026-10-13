// Global shortcut: summon-or-toggle MyAgents from anywhere on the OS.
//
// Behaviour:
//   window visible + focused  →  hide to tray (Raycast-style toggle)
//   otherwise                 →  show + unminimize + focus
//
// Deliberately does NOT auto-create a Launcher tab or move keyboard focus —
// the user found that surprising in dogfooding (PRD revision 2026-05-15).
// The shortcut is now purely a window visibility toggle; whichever tab was
// active before stays active.
//
// Pit-of-success: we DO NOT reimplement show + unminimize + set_focus here.
// `tray::show_main_window` is the single canonical "raise window" entry point
// (lib.rs:185, tray.rs:111). Tray click / single-instance / toast click / global
// shortcut all funnel through it. If you find yourself duplicating those three
// calls, you forgot why.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::{ulog_error, ulog_info, ulog_warn};

/// Canonical default; M = MyAgents, three-platform-safe.
pub const DEFAULT_ACCELERATOR: &str = "CmdOrCtrl+Shift+M";

/// AppConfig.globalSummonShortcut shape — mirror of TS type in shared/config-types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSummonConfig {
    pub enabled: bool,
    pub accelerator: String,
}

impl Default for GlobalSummonConfig {
    fn default() -> Self {
        Self {
            enabled: !crate::app_dirs::IS_MOXBOT,
            accelerator: DEFAULT_ACCELERATOR.to_string(),
        }
    }
}

/// Track the currently-registered accelerator so toggling enabled/changing key
/// knows what to unregister. Wrapped in a Mutex because Tauri commands run on
/// arbitrary worker threads.
static CURRENT_ACCELERATOR: Mutex<Option<String>> = Mutex::new(None);

fn config_path() -> Option<PathBuf> {
    crate::app_dirs::myagents_data_dir().map(|d| d.join("config.json"))
}

/// Read GlobalSummonConfig from config.json. Missing or malformed → defaults.
pub fn load_config() -> GlobalSummonConfig {
    let Some(path) = config_path() else {
        return GlobalSummonConfig::default();
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return GlobalSummonConfig::default();
    };
    let Ok(cfg) = serde_json::from_str::<serde_json::Value>(crate::utils::bom::strip_bom(&content))
    else {
        return GlobalSummonConfig::default();
    };
    cfg.get("globalSummonShortcut")
        .and_then(|v| serde_json::from_value::<GlobalSummonConfig>(v.clone()).ok())
        .unwrap_or_default()
}

/// Persist GlobalSummonConfig back to config.json under the standard config lock.
fn save_config(cfg: &GlobalSummonConfig) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "[global-shortcut] no data dir".to_string())?;
    let cfg = cfg.clone();
    crate::config_io::with_config_lock(&path, false, move |json| {
        if !json.is_object() {
            *json = serde_json::json!({});
        }
        let value = serde_json::to_value(&cfg)
            .map_err(|e| format!("[global-shortcut] serialize: {}", e))?;
        json.as_object_mut()
            .ok_or_else(|| "[global-shortcut] config root not an object".to_string())?
            .insert("globalSummonShortcut".to_string(), value);
        Ok(())
    })
    .map(|_| ())
}

/// Parse a Tauri accelerator string ("CmdOrCtrl+Shift+M") into a `Shortcut`.
///
/// Tauri's `Shortcut::from_str` is platform-agnostic-ish but the version we
/// ship doesn't accept all the spellings users might type. We normalize a few
/// common aliases up-front, then defer to the plugin's parser.
fn parse_accelerator(input: &str) -> Result<Shortcut, String> {
    let normalized = input.trim();
    if normalized.is_empty() {
        return Err("[global-shortcut] empty accelerator".to_string());
    }

    let mut modifiers = Modifiers::empty();
    let mut key_code: Option<Code> = None;

    for part in normalized.split('+').map(str::trim) {
        if part.is_empty() {
            return Err(format!(
                "[global-shortcut] malformed accelerator: '{}'",
                normalized
            ));
        }
        let lower = part.to_ascii_lowercase();
        match lower.as_str() {
            "cmdorctrl" | "commandorcontrol" => {
                #[cfg(target_os = "macos")]
                modifiers.insert(Modifiers::SUPER);
                #[cfg(not(target_os = "macos"))]
                modifiers.insert(Modifiers::CONTROL);
            }
            "cmd" | "command" | "super" | "meta" | "win" => modifiers.insert(Modifiers::SUPER),
            "ctrl" | "control" => modifiers.insert(Modifiers::CONTROL),
            "alt" | "option" | "opt" => modifiers.insert(Modifiers::ALT),
            "shift" => modifiers.insert(Modifiers::SHIFT),
            _ => {
                if key_code.is_some() {
                    return Err(format!(
                        "[global-shortcut] multiple main keys in '{}'",
                        normalized
                    ));
                }
                key_code = Some(parse_code(&lower)?);
            }
        }
    }

    let code = key_code
        .ok_or_else(|| format!("[global-shortcut] missing main key in '{}'", normalized))?;

    Ok(Shortcut::new(Some(modifiers), code))
}

fn parse_code(s: &str) -> Result<Code, String> {
    // letters
    if s.len() == 1 {
        let c = s.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            let upper = c.to_ascii_uppercase();
            return match upper {
                'A' => Ok(Code::KeyA),
                'B' => Ok(Code::KeyB),
                'C' => Ok(Code::KeyC),
                'D' => Ok(Code::KeyD),
                'E' => Ok(Code::KeyE),
                'F' => Ok(Code::KeyF),
                'G' => Ok(Code::KeyG),
                'H' => Ok(Code::KeyH),
                'I' => Ok(Code::KeyI),
                'J' => Ok(Code::KeyJ),
                'K' => Ok(Code::KeyK),
                'L' => Ok(Code::KeyL),
                'M' => Ok(Code::KeyM),
                'N' => Ok(Code::KeyN),
                'O' => Ok(Code::KeyO),
                'P' => Ok(Code::KeyP),
                'Q' => Ok(Code::KeyQ),
                'R' => Ok(Code::KeyR),
                'S' => Ok(Code::KeyS),
                'T' => Ok(Code::KeyT),
                'U' => Ok(Code::KeyU),
                'V' => Ok(Code::KeyV),
                'W' => Ok(Code::KeyW),
                'X' => Ok(Code::KeyX),
                'Y' => Ok(Code::KeyY),
                'Z' => Ok(Code::KeyZ),
                _ => Err(format!("[global-shortcut] unsupported key '{}'", s)),
            };
        }
        if c.is_ascii_digit() {
            return match c {
                '0' => Ok(Code::Digit0),
                '1' => Ok(Code::Digit1),
                '2' => Ok(Code::Digit2),
                '3' => Ok(Code::Digit3),
                '4' => Ok(Code::Digit4),
                '5' => Ok(Code::Digit5),
                '6' => Ok(Code::Digit6),
                '7' => Ok(Code::Digit7),
                '8' => Ok(Code::Digit8),
                '9' => Ok(Code::Digit9),
                _ => unreachable!(),
            };
        }
    }
    match s {
        "space" => Ok(Code::Space),
        "enter" | "return" => Ok(Code::Enter),
        "tab" => Ok(Code::Tab),
        "esc" | "escape" => Ok(Code::Escape),
        "backspace" => Ok(Code::Backspace),
        "delete" | "del" => Ok(Code::Delete),
        "left" | "arrowleft" => Ok(Code::ArrowLeft),
        "right" | "arrowright" => Ok(Code::ArrowRight),
        "up" | "arrowup" => Ok(Code::ArrowUp),
        "down" | "arrowdown" => Ok(Code::ArrowDown),
        "comma" => Ok(Code::Comma),
        "period" | "." => Ok(Code::Period),
        "slash" | "/" => Ok(Code::Slash),
        "backslash" | "\\" => Ok(Code::Backslash),
        "semicolon" | ";" => Ok(Code::Semicolon),
        "quote" | "'" => Ok(Code::Quote),
        "bracketleft" | "[" => Ok(Code::BracketLeft),
        "bracketright" | "]" => Ok(Code::BracketRight),
        "minus" | "-" => Ok(Code::Minus),
        "equal" | "=" => Ok(Code::Equal),
        "f1" => Ok(Code::F1),
        "f2" => Ok(Code::F2),
        "f3" => Ok(Code::F3),
        "f4" => Ok(Code::F4),
        "f5" => Ok(Code::F5),
        "f6" => Ok(Code::F6),
        "f7" => Ok(Code::F7),
        "f8" => Ok(Code::F8),
        "f9" => Ok(Code::F9),
        "f10" => Ok(Code::F10),
        "f11" => Ok(Code::F11),
        "f12" => Ok(Code::F12),
        _ => Err(format!("[global-shortcut] unsupported key '{}'", s)),
    }
}

/// Handler fired on shortcut Pressed event — toggle or summon.
fn on_summon_pressed<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        ulog_warn!("[global-shortcut] no main window, ignoring");
        return;
    };

    // Determine current state; failures are non-fatal (default to summon).
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);

    if visible && focused {
        ulog_info!("[global-shortcut] hide (already visible+focused)");
        if let Err(e) = crate::tray::hide_main_window(app) {
            ulog_error!("[global-shortcut] hide failed: {}", e);
        }
        return;
    }

    ulog_info!(
        "[global-shortcut] summon (visible={}, focused={})",
        visible,
        focused
    );
    crate::tray::show_main_window(app);
}

/// Register `accelerator` and remember it for later unregister.
///
/// Returns Err with a user-friendly message if the OS refuses (already taken,
/// platform doesn't support the combo, etc.).
pub fn register<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<(), String> {
    let shortcut = parse_accelerator(accelerator)?;
    let gs = app.global_shortcut();

    // Capture the previous accelerator BEFORE touching the OS — if the new
    // registration fails, we leave it untouched. Previously we
    // unregistered-old THEN register-new; a failure mid-sequence orphaned
    // the user (old gone, new not installed) and the renderer's optimistic
    // settings UI reverted state but the OS state was "no shortcut".
    let prev: Option<String> = CURRENT_ACCELERATOR.lock().ok().and_then(|m| m.clone());

    // Same chord re-register is a no-op at the OS level: unregister then
    // re-register so the duplicate-registration error doesn't propagate.
    if prev.as_deref() == Some(accelerator) {
        if let Ok(prev_shortcut) = parse_accelerator(accelerator) {
            let _ = gs.unregister(prev_shortcut);
        }
        gs.register(shortcut)
            .map_err(|e| format!("注册失败: {}", e))?;
        // CURRENT_ACCELERATOR already points to this accel; no state change.
        ulog_info!("[global-shortcut] re-registered '{}'", accelerator);
        return Ok(());
    }

    // Different chord: install the new one first. Only on success do we
    // tear down the previous registration — that way a failed register
    // leaves the OS state unchanged and the renderer's "previous accel
    // still works" assumption holds.
    gs.register(shortcut)
        .map_err(|e| format!("注册失败: {}", e))?;

    if let Some(prev_str) = prev.as_deref() {
        if let Ok(prev_shortcut) = parse_accelerator(prev_str) {
            let _ = gs.unregister(prev_shortcut);
        }
    }

    if let Ok(mut guard) = CURRENT_ACCELERATOR.lock() {
        *guard = Some(accelerator.to_string());
    }
    ulog_info!("[global-shortcut] registered '{}'", accelerator);
    Ok(())
}

/// Unregister the currently-active shortcut, if any.
pub fn unregister<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let prev = CURRENT_ACCELERATOR.lock().ok().and_then(|m| m.clone());
    if let Some(accel) = prev {
        if let Ok(shortcut) = parse_accelerator(&accel) {
            app.global_shortcut()
                .unregister(shortcut)
                .map_err(|e| format!("注销失败: {}", e))?;
        }
        if let Ok(mut guard) = CURRENT_ACCELERATOR.lock() {
            *guard = None;
        }
        ulog_info!("[global-shortcut] unregistered '{}'", accel);
    }
    Ok(())
}

/// Build the plugin with the press handler wired up. Call this when adding
/// the plugin to the Tauri builder (lib.rs). Registering the actual
/// accelerator happens later in `setup_on_startup` once config is readable.
pub fn build_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, _shortcut, event| {
            // Only act on the press edge; release fires too and would
            // double-toggle.
            if event.state() == ShortcutState::Pressed {
                let app_for_handler = app.clone();
                // Tauri docs: window state queries are safest off the GS
                // worker thread. Bounce through main thread.
                let _ = app.run_on_main_thread(move || {
                    on_summon_pressed(&app_for_handler);
                });
            }
        })
        .build()
}

/// Read config and register the configured shortcut on startup.
/// Failure → log + leave summon disabled (frontend will surface via the
/// settings panel; we don't want a one-time conflict to abort app boot).
pub fn setup_on_startup<R: Runtime>(app: &AppHandle<R>) {
    let cfg = load_config();
    if !cfg.enabled {
        ulog_info!("[global-shortcut] disabled in config, skipping registration");
        return;
    }
    if let Err(e) = register(app, &cfg.accelerator) {
        ulog_warn!(
            "[global-shortcut] startup registration of '{}' failed: {} — leaving inactive",
            cfg.accelerator,
            e
        );
    }
}

/// Command: read current config from disk.
#[tauri::command]
pub async fn cmd_get_global_summon_shortcut() -> Result<GlobalSummonConfig, String> {
    Ok(load_config())
}

/// Command: persist new config + re-register/unregister.
///
/// Atomicity: we register/unregister FIRST. Only persist if the OS accepted
/// the change. This is the "fail loud, keep last working value" contract from
/// PRD 0.2.16 §3.3 — frontend stays on its old config on Err, no rollback
/// dance needed there.
#[tauri::command]
pub async fn cmd_set_global_summon_shortcut<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
    accelerator: String,
) -> Result<(), String> {
    // Validate even when disabling, so users can't poison config.json with
    // garbage that future enable-toggle would choke on.
    let _ = parse_accelerator(&accelerator)?;

    if enabled {
        register(&app, &accelerator)?;
    } else {
        unregister(&app)?;
    }

    save_config(&GlobalSummonConfig {
        enabled,
        accelerator,
    })?;
    Ok(())
}

#[cfg(test)]
mod profile_tests {
    use super::*;

    #[test]
    fn profile_default_does_not_claim_myagents_shortcut_from_moxbot() {
        let config = GlobalSummonConfig::default();
        assert_eq!(config.enabled, !crate::app_dirs::IS_MOXBOT);
        assert_eq!(config.accelerator, DEFAULT_ACCELERATOR);
    }
}
