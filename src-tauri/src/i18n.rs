use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_warn};

static UI_LANGUAGE_MIRROR_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SupportedLocale {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}

impl SupportedLocale {
    pub fn as_str(self) -> &'static str {
        match self {
            SupportedLocale::ZhCn => "zh-CN",
            SupportedLocale::EnUs => "en-US",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiLanguage {
    System,
    ZhCn,
    EnUs,
}

impl UiLanguage {
    pub fn as_str(self) -> &'static str {
        match self {
            UiLanguage::System => "system",
            UiLanguage::ZhCn => "zh-CN",
            UiLanguage::EnUs => "en-US",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLanguageChangedPayload {
    pub ui_language: String,
    pub locale: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialI18nConfig {
    ui_language: Option<String>,
}

pub fn normalize_ui_language(value: &str) -> UiLanguage {
    match value {
        "zh-CN" => UiLanguage::ZhCn,
        "en-US" => UiLanguage::EnUs,
        "system" => UiLanguage::System,
        _ => UiLanguage::System,
    }
}

fn resolve_supported_locale(locale: Option<&str>) -> SupportedLocale {
    let Some(value) = locale else {
        return SupportedLocale::EnUs;
    };
    let normalized = value.trim().replace('_', "-").to_lowercase();
    if normalized == "zh" || normalized.starts_with("zh-") {
        SupportedLocale::ZhCn
    } else {
        SupportedLocale::EnUs
    }
}

fn system_locale() -> Option<String> {
    sys_locale::get_locale().or_else(|| {
        std::env::var("LC_ALL")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("LC_MESSAGES").ok().filter(|s| !s.is_empty()))
            .or_else(|| std::env::var("LANG").ok().filter(|s| !s.is_empty()))
    })
}

fn lock_language_mirrors() -> MutexGuard<'static, ()> {
    UI_LANGUAGE_MIRROR_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

pub fn effective_locale(ui_language: UiLanguage) -> SupportedLocale {
    match ui_language {
        UiLanguage::ZhCn => SupportedLocale::ZhCn,
        UiLanguage::EnUs => SupportedLocale::EnUs,
        UiLanguage::System => resolve_supported_locale(system_locale().as_deref()),
    }
}

fn read_ui_language_from(config_path: &std::path::Path) -> UiLanguage {
    let content = match std::fs::read_to_string(config_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return UiLanguage::System,
        Err(_) => return UiLanguage::ZhCn,
    };
    let cfg: PartialI18nConfig = match serde_json::from_str(strip_bom(&content)) {
        Ok(c) => c,
        Err(_) => return UiLanguage::ZhCn,
    };
    match cfg.ui_language {
        Some(value) => normalize_ui_language(&value),
        None => UiLanguage::ZhCn,
    }
}

pub fn current_ui_language() -> UiLanguage {
    if let Some(dir) = crate::app_dirs::myagents_data_dir() {
        let value = read_ui_language_from(&dir.join("config.json"));
        ulog_debug!("[i18n] disk: uiLanguage={}", value.as_str());
        return value;
    }
    UiLanguage::System
}

pub fn current_locale() -> SupportedLocale {
    effective_locale(current_ui_language())
}

fn persist_to_disk(value: UiLanguage) -> Result<(), String> {
    let dir = crate::app_dirs::myagents_data_dir()
        .ok_or_else(|| "[i18n] cannot resolve data dir".to_string())?;
    let config_path = dir.join("config.json");
    crate::config_io::with_config_lock(&config_path, false, |cfg| {
        if !cfg.is_object() {
            *cfg = serde_json::json!({});
        }
        let obj = cfg
            .as_object_mut()
            .expect("just normalized to object above");
        obj.insert(
            "uiLanguage".to_string(),
            serde_json::Value::String(value.as_str().to_string()),
        );
        Ok(())
    })
    .map(|_| ())
}

pub fn t<'a>(key: &'a str, locale: SupportedLocale) -> &'a str {
    if crate::app_dirs::IS_MOXBOT {
        match (locale, key) {
            (SupportedLocale::ZhCn, "tray.open") => return "打开 MoXBots",
            (SupportedLocale::EnUs, "tray.open") => return "Open MoXBots",
            (SupportedLocale::ZhCn, "notification.sessionCompleteTitle") => {
                return "MoXBots - 任务完成"
            }
            (SupportedLocale::EnUs, "notification.sessionCompleteTitle") => {
                return "MoXBots - Task complete"
            }
            (SupportedLocale::ZhCn, "notification.sessionStoppedTitle") => {
                return "MoXBots - 任务已停止"
            }
            (SupportedLocale::EnUs, "notification.sessionStoppedTitle") => {
                return "MoXBots - Task stopped"
            }
            (SupportedLocale::ZhCn, "notification.sessionErrorTitle") => {
                return "MoXBots - 任务失败"
            }
            (SupportedLocale::EnUs, "notification.sessionErrorTitle") => {
                return "MoXBots - Task failed"
            }
            (SupportedLocale::ZhCn, "notification.centerAnnouncementTitle") => {
                return "MoXBots 公告"
            }
            (SupportedLocale::EnUs, "notification.centerAnnouncementTitle") => {
                return "MoXBots announcement"
            }
            _ => {}
        }
    }
    match (locale, key) {
        (SupportedLocale::ZhCn, "tray.open") => "打开 MyAgents",
        (SupportedLocale::ZhCn, "tray.recording") => "正在录音…",
        (SupportedLocale::ZhCn, "tray.settings") => "设置",
        (SupportedLocale::ZhCn, "tray.forceWakeLock") => "阻止电脑睡眠",
        (SupportedLocale::ZhCn, "tray.exit") => "退出",
        (SupportedLocale::ZhCn, "notification.sessionCompleteTitle") => "MyAgents - 任务完成",
        (SupportedLocale::ZhCn, "notification.sessionCompleteBody") => "请您查看结果",
        (SupportedLocale::ZhCn, "notification.sessionStoppedTitle") => "MyAgents - 任务已停止",
        (SupportedLocale::ZhCn, "notification.sessionStoppedBody") => "请您查看当前结果",
        (SupportedLocale::ZhCn, "notification.sessionErrorTitle") => "MyAgents - 任务失败",
        (SupportedLocale::ZhCn, "notification.sessionErrorBody") => "请您查看错误详情",
        (SupportedLocale::ZhCn, "notification.centerAnnouncementTitle") => "MyAgents 公告",
        (SupportedLocale::ZhCn, "notification.centerCommentTitle") => "Issue 有新评论",
        (SupportedLocale::EnUs, "tray.open") => "Open MyAgents",
        (SupportedLocale::EnUs, "tray.recording") => "Recording…",
        (SupportedLocale::EnUs, "tray.settings") => "Settings",
        (SupportedLocale::EnUs, "tray.forceWakeLock") => "Prevent computer sleep",
        (SupportedLocale::EnUs, "tray.exit") => "Quit",
        (SupportedLocale::EnUs, "notification.sessionCompleteTitle") => "MyAgents - Task complete",
        (SupportedLocale::EnUs, "notification.sessionCompleteBody") => "Please review the result",
        (SupportedLocale::EnUs, "notification.sessionStoppedTitle") => "MyAgents - Task stopped",
        (SupportedLocale::EnUs, "notification.sessionStoppedBody") => {
            "Please review the current result"
        }
        (SupportedLocale::EnUs, "notification.sessionErrorTitle") => "MyAgents - Task failed",
        (SupportedLocale::EnUs, "notification.sessionErrorBody") => {
            "Please review the error details"
        }
        (SupportedLocale::EnUs, "notification.centerAnnouncementTitle") => "MyAgents announcement",
        (SupportedLocale::EnUs, "notification.centerCommentTitle") => "New Issue comment",
        _ => key,
    }
}

pub fn ui_language_payload(value: UiLanguage) -> UiLanguageChangedPayload {
    let locale = effective_locale(value);
    UiLanguageChangedPayload {
        ui_language: value.as_str().to_string(),
        locale: locale.as_str().to_string(),
    }
}

pub fn apply_ui_language(
    app: &AppHandle,
    value: UiLanguage,
) -> Result<UiLanguageChangedPayload, String> {
    let _guard = lock_language_mirrors();
    persist_to_disk(value)?;
    let locale = effective_locale(value);
    let payload = ui_language_payload(value);
    crate::tray::apply_tray_locale(app, locale);
    if let Err(e) = app.emit("ui-language-changed", &payload) {
        ulog_warn!("[i18n] emit failed: {e}");
    }
    Ok(payload)
}

pub fn sync_ui_language_from_config(app: &AppHandle) -> UiLanguageChangedPayload {
    let _guard = lock_language_mirrors();
    let value = current_ui_language();
    let locale = effective_locale(value);
    let payload = ui_language_payload(value);
    crate::tray::apply_tray_locale(app, locale);
    if let Err(e) = app.emit("ui-language-changed", &payload) {
        ulog_warn!("[i18n] emit failed: {e}");
    }
    payload
}

#[tauri::command]
pub async fn cmd_get_ui_language_state() -> Result<UiLanguageChangedPayload, String> {
    tauri::async_runtime::spawn_blocking(move || ui_language_payload(current_ui_language()))
        .await
        .map_err(|e| format!("[i18n] state task join: {e}"))
}

#[tauri::command]
pub async fn cmd_sync_ui_language_from_config(
    app: AppHandle,
) -> Result<UiLanguageChangedPayload, String> {
    tauri::async_runtime::spawn_blocking(move || sync_ui_language_from_config(&app))
        .await
        .map_err(|e| format!("[i18n] sync task join: {e}"))
}

#[tauri::command]
pub async fn cmd_set_ui_language(
    app: AppHandle,
    value: String,
) -> Result<UiLanguageChangedPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ui_language = normalize_ui_language(&value);
        apply_ui_language(&app, ui_language)
    })
    .await
    .map_err(|e| format!("[i18n] task join: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_ui_language_values() {
        assert_eq!(normalize_ui_language("zh-CN"), UiLanguage::ZhCn);
        assert_eq!(normalize_ui_language("en-US"), UiLanguage::EnUs);
        assert_eq!(normalize_ui_language("system"), UiLanguage::System);
        assert_eq!(normalize_ui_language("fr-FR"), UiLanguage::System);
    }

    #[test]
    fn resolves_effective_locale_from_system_locale() {
        assert_eq!(
            resolve_supported_locale(Some("zh_CN.UTF-8")),
            SupportedLocale::ZhCn
        );
        assert_eq!(
            resolve_supported_locale(Some("en_GB.UTF-8")),
            SupportedLocale::EnUs
        );
        assert_eq!(resolve_supported_locale(None), SupportedLocale::EnUs);
    }

    #[test]
    fn translates_native_session_completion_notifications() {
        assert_eq!(
            t("notification.sessionCompleteTitle", SupportedLocale::ZhCn),
            if crate::app_dirs::IS_MOXBOT {
                "MoXBots - 任务完成"
            } else {
                "MyAgents - 任务完成"
            }
        );
        assert_eq!(
            t("notification.sessionErrorBody", SupportedLocale::EnUs),
            "Please review the error details"
        );
    }
}
