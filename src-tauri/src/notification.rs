// OS notification with reliable click-to-foreground + navigation deep-link.
//
// Architectural rationale (structural guarantees over process conventions):
//
// `tauri-plugin-notification` on desktop is fire-and-forget — its JS shim
// replaces `window.Notification` with a pure invoke proxy that returns no
// handle, and its desktop backend (`notify-rust`) doesn't surface any click
// callback. Relying on `window.onFocusChanged` to detect "user clicked toast"
// works on macOS by accident (OS auto-activates the app) but silently fails
// on Windows — toast clicks go through WinRT's in-process Activated event,
// not a fresh process spawn, so single-instance and focus-changed handlers
// never fire.
//
// This module owns the OS notification surface end-to-end with three
// platform-exclusive paths. Every path receives an exact per-toast click:
//
//   ┌──────────────┬─────────────────────────────────────────────────────┐
//   │ Windows      │ `tauri-winrt-notification::Toast::on_activated`     │
//   │              │ closure captures the navigation target directly. No │
//   │              │ global queue, no focus-edge consumption. The click  │
//   │              │ handler is in-process and deterministic.            │
//   ├──────────────┼─────────────────────────────────────────────────────┤
//   │ macOS        │ UserNotifications request identifier → navigation   │
//   │              │ registry, consumed by its native response delegate. │
//   ├──────────────┼─────────────────────────────────────────────────────┤
//   │ Linux        │ notify-rust DBus action callback closure-captures   │
//   │              │ the navigation target for that exact handle.        │
//   └──────────────┴─────────────────────────────────────────────────────┘
//
// What this REPLACES:
//   - `pendingNavigation` Map + 2-second time window in
//     `notificationService.ts` (fragile; could miss clicks past the window).
//   - `wasHidden` closure flag in `useTrayEvents.ts` (broke when user wasn't
//     minimized to tray — alt-tab away then click toast).
//   - `notification:show` Tauri event hop (Rust → JS → plugin-notification);
//     Rust now owns each platform's native callback path directly.
//
// Why mutually exclusive paths matter (review-time finding): an earlier
// draft populated a focus-consumed global latch alongside Windows' native
// callback. That caused a double-emit bug when one activation reached both.
// There is no focus-consumed navigation state anymore, making the bug
// structurally unrepresentable.

#[cfg(target_os = "macos")]
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::sync::{LazyLock, Mutex};
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::notification_badge::NotificationBadgeIncrement;
#[cfg(target_os = "windows")]
use crate::ulog_error;
use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_info, ulog_warn};

/// Delivered macOS banners can remain in Notification Center for days. Bound
/// ignored/dismissed routes by both age and count while retaining long-lived
/// click behavior for banners the user opens later.
#[cfg(target_os = "macos")]
const MAC_ROUTE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
#[cfg(target_os = "macos")]
const MAX_MAC_ROUTES: usize = 512;

#[cfg(target_os = "macos")]
struct MacNotificationRoute {
    navigation: NotificationNavigation,
    created_at: Instant,
}

#[cfg(target_os = "macos")]
static MAC_NOTIFICATION_ROUTES: LazyLock<Mutex<HashMap<String, MacNotificationRoute>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Modern macOS UserNotifications integration. The request identifier is the
/// correlation key; the system returns that exact identifier to the single
/// process-lifetime delegate when a banner is clicked or dismissed.
#[cfg(target_os = "macos")]
mod macos_notifications {
    use core::ffi::c_void;

    use objc2::ffi::{objc_setAssociatedObject, OBJC_ASSOCIATION_RETAIN_NONATOMIC};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, ProtocolObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2_foundation::{MainThreadMarker, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent,
        UNNotificationDefaultActionIdentifier, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    use super::*;

    static DELEGATE_ASSOCIATION_KEY: u8 = 0;

    #[derive(Debug)]
    struct MacNotificationDelegateIvars {
        app: AppHandle,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements. Apple invokes
        // UserNotifications delegate callbacks on the main queue.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "MyAgentsUserNotificationCenterDelegate"]
        #[ivars = MacNotificationDelegateIvars]
        struct MacNotificationDelegate;

        // SAFETY: NSObjectProtocol has no additional requirements.
        unsafe impl NSObjectProtocol for MacNotificationDelegate {}

        // SAFETY: The selector and argument types exactly match Apple's
        // UNUserNotificationCenterDelegate response callback.
        unsafe impl UNUserNotificationCenterDelegate for MacNotificationDelegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive_response(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let identifier = response.notification().request().identifier().to_string();
                let navigation = take_route(&identifier);
                let action = response.actionIdentifier();
                // SAFETY: This framework constant is present on every macOS
                // version supported by Tauri 2.
                let default_action = unsafe { UNNotificationDefaultActionIdentifier };
                if &*action == default_action {
                    handle_toast_click(&self.ivars().app, navigation);
                }
                completion_handler.call(());
            }
        }
    );

    impl MacNotificationDelegate {
        fn new(mtm: MainThreadMarker, app: AppHandle) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(MacNotificationDelegateIvars { app });
            // SAFETY: NSObject's init signature is correct for this subclass.
            unsafe { msg_send![super(this), init] }
        }
    }

    pub(super) fn install(app: &AppHandle) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or_else(|| {
            "notification delegate must be installed on the main thread".to_owned()
        })?;
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate = MacNotificationDelegate::new(mtm, app.clone());
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));

        // `delegate` is a weak property. Tie its strong lifetime to the
        // singleton center with an associated object.
        unsafe {
            objc_setAssociatedObject(
                Retained::as_ptr(&center).cast_mut().cast::<AnyObject>(),
                (&DELEGATE_ASSOCIATION_KEY as *const u8).cast::<c_void>(),
                Retained::as_ptr(&delegate).cast_mut().cast::<AnyObject>(),
                OBJC_ASSOCIATION_RETAIN_NONATOMIC,
            );
        }
        if read_notification_prefs().os_notifications {
            request_authorization(&center);
        }
        Ok(())
    }

    pub(super) fn request_permission() {
        request_authorization(&UNUserNotificationCenter::currentNotificationCenter());
    }

    fn request_authorization(center: &UNUserNotificationCenter) {
        let completion = block2::RcBlock::new(|granted: Bool, error: *mut NSError| {
            if !error.is_null() {
                ulog_warn!("[Notification] macOS authorization request failed");
            } else {
                ulog_info!(
                    "[Notification] macOS authorization granted={}",
                    granted.as_bool()
                );
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &completion,
        );
    }

    pub(super) fn show(
        title: &str,
        body: &str,
        navigation: Option<NotificationNavigation>,
        silent: bool,
    ) -> Result<(), String> {
        let identifier = format!("myagents:{}", uuid::Uuid::new_v4());
        if let Some(navigation) = navigation {
            register_route(identifier.clone(), navigation);
        }

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        if !silent {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&identifier),
            &content,
            None,
        );
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, None);
        Ok(())
    }

    fn register_route(identifier: String, navigation: NotificationNavigation) {
        let mut routes = MAC_NOTIFICATION_ROUTES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        routes.retain(|_, route| route.created_at.elapsed() <= MAC_ROUTE_TTL);
        if routes.len() >= MAX_MAC_ROUTES {
            if let Some(oldest) = routes
                .iter()
                .min_by_key(|(_, route)| route.created_at)
                .map(|(identifier, _)| identifier.clone())
            {
                routes.remove(&oldest);
            }
        }
        routes.insert(
            identifier,
            MacNotificationRoute {
                navigation,
                created_at: Instant::now(),
            },
        );
    }

    fn take_route(identifier: &str) -> Option<NotificationNavigation> {
        MAC_NOTIFICATION_ROUTES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(identifier)
            .map(|route| route.navigation)
    }

    #[cfg(test)]
    pub(super) fn test_registry_round_trip() {
        let first = NotificationNavigation::from_tab_id(Some("first".to_owned())).unwrap();
        let second = NotificationNavigation::from_tab_id(Some("second".to_owned())).unwrap();
        register_route("request-first".to_owned(), first.clone());
        register_route("request-second".to_owned(), second.clone());
        assert_eq!(take_route("request-second"), Some(second));
        assert_eq!(take_route("request-first"), Some(first));
        assert_eq!(take_route("request-first"), None);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationNavigation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_notification_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_target: Option<crate::space_cloud::notifications::NotificationTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_is_announcement: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_origin_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_origin_account_key: Option<String>,
}

impl NotificationNavigation {
    pub fn new(
        tab_id: Option<String>,
        session_id: Option<String>,
        workspace_path: Option<String>,
    ) -> Option<Self> {
        let navigation = Self {
            task_id: None,
            tab_id: clean_optional_string(tab_id),
            session_id: clean_optional_string(session_id),
            workspace_path: clean_optional_string(workspace_path),
            cloud_notification_id: None,
            cloud_target: None,
            cloud_is_announcement: None,
            cloud_origin_key: None,
            cloud_origin_account_key: None,
        };
        if navigation.tab_id.is_none()
            && (navigation.session_id.is_none() || navigation.workspace_path.is_none())
        {
            None
        } else {
            Some(navigation)
        }
    }

    pub fn from_tab_id(tab_id: Option<String>) -> Option<Self> {
        Self::new(tab_id, None, None)
    }

    pub fn for_session(
        tab_id: Option<String>,
        session_id: String,
        workspace_path: String,
    ) -> Option<Self> {
        Self::new(tab_id, Some(session_id), Some(workspace_path))
    }

    pub fn for_task(task_id: String) -> Self {
        Self { task_id: Some(task_id), tab_id: None, session_id: None, workspace_path: None,
            cloud_notification_id: None, cloud_target: None, cloud_is_announcement: None,
            cloud_origin_key: None, cloud_origin_account_key: None }
    }

    pub fn for_cloud(
        notification_id: String,
        target: crate::space_cloud::notifications::NotificationTarget,
        is_announcement: bool,
        origin_key: Option<String>,
        origin_account_key: Option<String>,
    ) -> Option<Self> {
        let notification_id = clean_optional_string(Some(notification_id))?;
        Some(Self {
            task_id: None,
            tab_id: None,
            session_id: None,
            workspace_path: None,
            cloud_notification_id: Some(notification_id),
            cloud_target: Some(target),
            cloud_is_announcement: Some(is_announcement),
            cloud_origin_key: clean_optional_string(origin_key),
            cloud_origin_account_key: clean_optional_string(origin_account_key),
        })
    }

    fn describe(&self) -> String {
        format!(
            "tab_id={:?} session_id={:?} workspace_path={:?} cloud_notification_id={:?}",
            self.tab_id, self.session_id, self.workspace_path, self.cloud_notification_id
        )
    }
}

fn clean_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationClickPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_notification_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_target: Option<crate::space_cloud::notifications::NotificationTarget>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompletionTurnOwner {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompletionOrigin {
    pub kind: String,
    pub surface: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionCompletionStatus {
    Complete,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompletionTerminal {
    pub session_id: String,
    pub workspace_path: String,
    pub turn_id: String,
    #[serde(default)]
    pub turn_owner: Option<SessionCompletionTurnOwner>,
    pub origin: SessionCompletionOrigin,
    pub status: SessionCompletionStatus,
}

fn is_generic_session_completion_eligible(terminal: &SessionCompletionTerminal) -> bool {
    if matches!(
        terminal
            .turn_owner
            .as_ref()
            .map(|owner| owner.kind.as_str()),
        Some("task" | "goal")
    ) {
        return false;
    }
    !matches!(
        (
            terminal.origin.kind.as_str(),
            terminal.origin.surface.as_str()
        ),
        ("agent-channel", _)
            | ("automation", _)
            | (
                _,
                "channel_message" | "channel_heartbeat" | "memory_update" | "cron" | "task_run"
            )
    )
}

fn should_show_session_completion<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_window("main")
        .map(|window| {
            !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false)
        })
        .unwrap_or(true)
}

pub fn completion_terminal_from_sse_data(data: &str) -> Option<SessionCompletionTerminal> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let payload = value.get("payload").unwrap_or(&value);
    serde_json::from_value(payload.get("completionTerminal")?.clone()).ok()
}

pub(crate) fn submit_session_completion<R: Runtime>(
    app: &AppHandle<R>,
    terminal: SessionCompletionTerminal,
    _claim: crate::sidecar::SessionCompletionClaim,
) {
    if !is_generic_session_completion_eligible(&terminal) {
        ulog_debug!(
            "[Notification] Generic session completion suppressed by owner/origin: session={} turn={} owner={:?} origin={:?}",
            terminal.session_id,
            terminal.turn_id,
            terminal.turn_owner,
            terminal.origin,
        );
        return;
    }
    if !should_show_session_completion(app) {
        ulog_debug!(
            "[Notification] Session completion toast suppressed while main window is focused: session={} turn={}",
            terminal.session_id,
            terminal.turn_id,
        );
        return;
    }

    let locale = crate::i18n::current_locale();
    let (title_key, body_key) = match terminal.status {
        SessionCompletionStatus::Complete => (
            "notification.sessionCompleteTitle",
            "notification.sessionCompleteBody",
        ),
        SessionCompletionStatus::Stopped => (
            "notification.sessionStoppedTitle",
            "notification.sessionStoppedBody",
        ),
        SessionCompletionStatus::Error => (
            "notification.sessionErrorTitle",
            "notification.sessionErrorBody",
        ),
    };
    let navigation = NotificationNavigation::for_session(
        None,
        terminal.session_id.clone(),
        terminal.workspace_path.clone(),
    );
    show_with_navigation_target_and_badge(
        app,
        crate::i18n::t(title_key, locale),
        crate::i18n::t(body_key, locale),
        navigation,
        Some(NotificationBadgeIncrement {
            id: format!(
                "session-completion:{}:{}",
                terminal.session_id, terminal.turn_id
            ),
            source: "session-completion".to_string(),
            created_at: chrono::Utc::now().timestamp_millis(),
            target: crate::notification_badge::NotificationBadgeTarget::Session {
                session_id: terminal.session_id,
                workspace_path: terminal.workspace_path,
            },
        }),
    );
}

/// Send an OS notification.
///
/// `tab_id` (when supplied) is the legacy fast-path deep-link target consumed
/// when the user clicks the notification. Use `show_with_navigation_target`
/// when the target may need to open a session that has no live Tab yet.
///
/// Sound is gated by the `notificationSound` user preference, read disk-first
/// from `~/.myagents/config.json` (defaults to enabled if missing). The
/// preference flows through to the platform-specific sound API:
///   - Windows: `Toast::sound(None)` for silent, `Sound::Default` for default.
///   - macOS: `NSUserNotificationDefaultSoundName` (default mac chime).
///   - Linux: `message-new-instant` (XDG sound theme; widely supported).
///
/// Best-effort: any OS-level failure is logged but never propagated to the
/// caller — a silent notification is strictly better than failing the cron
/// task / chat turn that triggered it.
pub fn show_with_navigation<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    tab_id: Option<String>,
) {
    show_with_navigation_target(
        app,
        title,
        body,
        NotificationNavigation::from_tab_id(tab_id),
    );
}

/// Send an OS notification with an optional navigation target.
///
/// Prefer this for background surfaces (cron / task execution) where the target
/// may not have a live Tab yet. A tab-only target can only switch an existing
/// tab; a session target lets the renderer open the corresponding chat session
/// through its cron-aware session-open planner.
pub fn show_with_navigation_target<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
) {
    show_with_navigation_target_inner(app, title, body, navigation, None);
}

pub fn show_cloud_notification<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    notification_id: String,
    target: crate::space_cloud::notifications::NotificationTarget,
    is_announcement: bool,
    origin_key: Option<String>,
    origin_account_key: Option<String>,
) {
    show_with_navigation_target(
        app,
        title,
        body,
        NotificationNavigation::for_cloud(
            notification_id,
            target,
            is_announcement,
            origin_key,
            origin_account_key,
        ),
    );
}

pub fn show_with_navigation_target_and_badge<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    badge_increment: Option<NotificationBadgeIncrement>,
) {
    show_with_navigation_target_inner(app, title, body, navigation, badge_increment);
}

fn show_with_navigation_target_inner<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    badge_increment: Option<NotificationBadgeIncrement>,
) {
    let prefs = read_notification_prefs();
    if !prefs.os_notifications {
        ulog_debug!(
            "[Notification] Suppressed by user preference (osNotifications=false): title='{}'",
            title
        );
        return;
    }
    let silent = !prefs.notification_sound;
    ulog_info!(
        "[Notification] Showing toast title='{}' navigation={:?} silent={}",
        title,
        navigation.as_ref().map(NotificationNavigation::describe),
        silent
    );

    if prefs.notification_badge {
        if let Some(increment) = badge_increment {
            crate::notification_badge::emit_badge_increment(app, increment);
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Pure closure-capture path — no global state, no consumer command.
        if let Err(e) = show_windows_toast(app, title, body, navigation, silent) {
            ulog_error!(
                "[Notification] WinRT toast rendering failed entirely: {}. \
                 Notification will not be displayed; click activation \
                 unavailable. Likely cause: AUMID mismatch or missing \
                 Start Menu shortcut.",
                e
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Err(error) = macos_notifications::show(title, body, navigation, silent) {
            ulog_warn!("[Notification] UserNotifications show failed: {}", error);
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Err(error) = show_linux_toast(app, title, body, navigation, silent) {
            ulog_warn!("[Notification] freedesktop toast failed: {}", error);
        }
    }
}

/// Linux receives DBus actions on the exact returned notification handle. A
/// dedicated waiter thread is required because desktop daemons deliver that
/// action asynchronously and notify-rust's convenience API blocks while it
/// listens. Each thread closure owns one navigation target, so stacked toasts
/// cannot cross-route.
#[cfg(target_os = "linux")]
fn show_linux_toast<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    silent: bool,
) -> notify_rust::error::Result<()> {
    use notify_rust::{Notification, Timeout};

    let mut notification = Notification::new();
    notification
        .appname("MyAgents")
        .summary(title)
        .body(body)
        .timeout(Timeout::Milliseconds(10_000))
        .action("default", "Open");
    if !silent {
        notification.sound_name("message-new-instant");
    }
    let handle = notification.show()?;
    let app = app.clone();
    std::thread::spawn(move || {
        handle.wait_for_action(move |action| {
            if action == "default" {
                handle_toast_click(&app, navigation);
            }
        });
    });
    Ok(())
}

/// User notification preferences read from `~/.myagents/config.json`.
///
/// Both fields default to `true` (fail-open) when the config file is missing
/// or unparseable — silently disabling notifications because we couldn't read
/// a JSON file would look like a regression. Read overhead is negligible:
/// notifications are low-frequency events, and the file is small.
struct NotificationPrefs {
    /// Master switch: when false, no OS notification is rendered at all
    /// (covers all 6 trigger sites — cron / task / message complete /
    /// permission request / ask-user-question / plan-mode review).
    os_notifications: bool,
    /// Sound flag: when true, the platform default chime plays alongside
    /// the toast.
    notification_sound: bool,
    /// Badge flag: when true, native app icon badges mirror unseen notification
    /// work. Defaults off while the feature is still being validated.
    notification_badge: bool,
}

fn read_notification_prefs() -> NotificationPrefs {
    #[derive(Debug, serde::Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct PartialAppConfig {
        os_notifications: Option<bool>,
        /// Pre-0.2.14 master toggle. Read as a fallback so users who
        /// deliberately set `cronNotifications: false` keep notifications
        /// suppressed BEFORE the renderer's migrateOsNotificationsField
        /// runs and rewrites the field on disk. Otherwise: launch app,
        /// notification fires before they open Settings, surprise.
        cron_notifications: Option<bool>,
        notification_sound: Option<bool>,
        notification_badge: Option<bool>,
    }

    // Use the project-canonical data-dir helper rather than `dirs::home_dir()`
    // so future dev/prod isolation in `app_dirs.rs` reaches us automatically.
    let parsed: Option<PartialAppConfig> = crate::app_dirs::myagents_data_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join("config.json")).ok())
        .and_then(|content| serde_json::from_str(strip_bom(&content)).ok());

    NotificationPrefs {
        os_notifications: parsed
            .as_ref()
            .and_then(|c| c.os_notifications.or(c.cron_notifications))
            .unwrap_or(true),
        notification_sound: parsed
            .as_ref()
            .and_then(|c| c.notification_sound)
            .unwrap_or(true),
        notification_badge: parsed.and_then(|c| c.notification_badge).unwrap_or(false),
    }
}

/// Direct WinRT toast with `on_activated` click handler. Compiled only on
/// Windows.
///
/// Two-tier rendering: try the bundle identifier (matches NSIS Start-Menu
/// shortcut AUMID); on failure (portable EXE, custom install, missing
/// shortcut) retry with PowerShell's well-known AUMID. The retry preserves
/// `on_activated`, so click activation still works — the only visible
/// difference is the toast attribution ("PowerShell" instead of "MyAgents").
/// This beats falling back to plugin-notification, which would render a toast
/// with *no* click handler at all.
#[cfg(target_os = "windows")]
fn show_windows_toast<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    silent: bool,
) -> tauri_winrt_notification::Result<()> {
    use tauri_winrt_notification::Toast;

    let primary_app_id = resolve_windows_app_id(app);
    let primary_is_powershell = primary_app_id == Toast::POWERSHELL_APP_ID;

    match build_and_show_toast(
        app,
        &primary_app_id,
        title,
        body,
        navigation.clone(),
        silent,
    ) {
        Ok(()) => Ok(()),
        Err(e) if primary_is_powershell => Err(e),
        Err(e) => {
            ulog_warn!(
                "[Notification] WinRT toast with AUMID '{}' failed: {}; \
                 retrying with PowerShell AUMID (click handler preserved).",
                primary_app_id,
                e
            );
            build_and_show_toast(
                app,
                Toast::POWERSHELL_APP_ID,
                title,
                body,
                navigation,
                silent,
            )
        }
    }
}

#[cfg(target_os = "windows")]
fn build_and_show_toast<R: Runtime>(
    app: &AppHandle<R>,
    app_id: &str,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    silent: bool,
) -> tauri_winrt_notification::Result<()> {
    use tauri_winrt_notification::{Duration as ToastDuration, Sound, Toast};

    let app_handle = app.clone();
    // `Sound::Default` produces an empty `<audio>` element — WinRT then plays
    // the toast template's default chime. `None` injects `<audio silent="true"/>`,
    // suppressing sound entirely.
    let sound = if silent { None } else { Some(Sound::Default) };
    Toast::new(app_id)
        .title(title)
        .text1(body)
        .duration(ToastDuration::Short)
        .sound(sound)
        .on_activated(move |_action| {
            // _action is non-empty only when an action button is clicked;
            // we don't render buttons, so any activation is the toast body.
            // navigation is closure-captured per-toast — no global queue lookup.
            handle_toast_click(&app_handle, navigation.clone());
            Ok(())
        })
        .show()
}

/// Resolve the primary AUMID for our toast.
///
/// In production: `app.config().identifier` matches the AUMID NSIS sets on
/// the Start Menu shortcut via `SetLnkAppUserModelId` — required for WinRT
/// to render a toast attributed to MyAgents.
///
/// In dev (`cargo run`, `tauri dev`): `tauri::is_dev()` is true and we use
/// PowerShell's AUMID — toast still shows but attributed to PowerShell.
///
/// Uses `tauri::is_dev()` (compile-time const) rather than path-suffix
/// heuristics that break under non-standard `CARGO_TARGET_DIR` or monorepo
/// layouts. The `tauri-plugin-notification` desktop backend uses path
/// suffix matching for the same purpose — `is_dev` is the cleaner equivalent
/// (#review-finding-3, CC).
#[cfg(target_os = "windows")]
fn resolve_windows_app_id<R: Runtime>(app: &AppHandle<R>) -> String {
    use tauri_winrt_notification::Toast;

    if tauri::is_dev() {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

/// Platform callback convergence point. Windows and Linux closure-capture the
/// target; macOS resolves it from the exact UserNotifications request ID.
fn handle_toast_click<R: Runtime>(app: &AppHandle<R>, navigation: Option<NotificationNavigation>) {
    ulog_info!(
        "[Notification] Toast clicked; navigation={:?}",
        navigation.as_ref().map(NotificationNavigation::describe)
    );
    crate::tray::show_main_window(app);
    emit_click(app, navigation);
}

#[cfg(target_os = "macos")]
pub fn install_macos_notification_delegate(app: &AppHandle) -> Result<(), String> {
    macos_notifications::install(app)
}

#[tauri::command]
pub fn cmd_request_notification_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    macos_notifications::request_permission();
    Ok(())
}

fn emit_click<R: Runtime>(app: &AppHandle<R>, navigation: Option<NotificationNavigation>) {
    let Some(navigation) = navigation else {
        return;
    };
    if let (Some(notification_id), Some(target)) = (
        navigation.cloud_notification_id.clone(),
        navigation.cloud_target.clone(),
    ) {
        crate::space_cloud::notifications::activate_from_toast(
            app.clone(),
            notification_id,
            target,
            navigation.cloud_is_announcement.unwrap_or(false),
            navigation.cloud_origin_key.clone(),
            navigation.cloud_origin_account_key.clone(),
        );
        return;
    }
    if let Err(e) = app.emit(
        "notification:click",
        NotificationClickPayload {
            task_id: navigation.task_id,
            tab_id: navigation.tab_id,
            session_id: navigation.session_id,
            workspace_path: navigation.workspace_path,
            cloud_notification_id: navigation.cloud_notification_id,
            cloud_target: navigation.cloud_target,
        },
    ) {
        ulog_warn!("[Notification] Failed to emit notification:click: {}", e);
    }
}

// ============ Tauri Commands ============

/// Front-end entry point. Replaces direct calls to
/// `@tauri-apps/plugin-notification`'s `sendNotification` so that:
///   1. all OS notifications go through one Rust function
///   2. the click handler is always wired (no caller can "forget")
///   3. the deep-link tab routing is structural rather than a JS-side
///      time-window race
#[tauri::command]
pub fn cmd_show_notification<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: Option<String>,
    tab_id: Option<String>,
    session_id: Option<String>,
    workspace_path: Option<String>,
) {
    let body = body.unwrap_or_default();
    ulog_info!(
        "[Notification] cmd_show_notification title='{}' tab_id={:?} session_id={:?} workspace_path={:?}",
        title,
        tab_id,
        session_id,
        workspace_path
    );
    show_with_navigation_target_inner(
        &app,
        &title,
        &body,
        NotificationNavigation::new(tab_id, session_id, workspace_path),
        None,
    );
}

// ============ Tests ============

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn mac_registry_correlates_stacked_toasts_by_exact_identifier() {
        macos_notifications::test_registry_round_trip();
    }
}

#[cfg(test)]
mod notification_navigation_tests {
    use super::*;

    #[test]
    fn cloud_navigation_captures_origin_and_account_identity() {
        let navigation = NotificationNavigation::for_cloud(
            "notification-1".to_string(),
            crate::space_cloud::notifications::NotificationTarget::ExternalUrl {
                url: "https://example.com/notice".to_string(),
            },
            true,
            Some("origin-a".to_string()),
            Some("account-a".to_string()),
        )
        .expect("cloud navigation");

        assert_eq!(navigation.cloud_origin_key.as_deref(), Some("origin-a"));
        assert_eq!(
            navigation.cloud_origin_account_key.as_deref(),
            Some("account-a")
        );
    }
}

#[cfg(test)]
mod session_completion_tests {
    use super::*;

    fn terminal(
        session_id: &str,
        turn_id: &str,
        owner: Option<&str>,
        origin_kind: &str,
        origin_surface: &str,
    ) -> SessionCompletionTerminal {
        SessionCompletionTerminal {
            session_id: session_id.to_string(),
            workspace_path: "/tmp/workspace".to_string(),
            turn_id: turn_id.to_string(),
            turn_owner: owner.map(|kind| SessionCompletionTurnOwner {
                kind: kind.to_string(),
                id: "owner-1".to_string(),
            }),
            origin: SessionCompletionOrigin {
                kind: origin_kind.to_string(),
                surface: origin_surface.to_string(),
            },
            status: SessionCompletionStatus::Complete,
        }
    }

    #[test]
    fn generic_completion_policy_uses_owner_and_origin() {
        assert!(is_generic_session_completion_eligible(&terminal(
            "desktop",
            "turn-1",
            None,
            "desktop",
            "launcher_input",
        )));
        assert!(is_generic_session_completion_eligible(&terminal(
            "space",
            "turn-1",
            None,
            "registered-agent",
            "space_issue_delivery",
        )));
        assert!(is_generic_session_completion_eligible(&terminal(
            "inbox",
            "turn-1",
            None,
            "session-inbox",
            "session_send",
        )));
        assert!(!is_generic_session_completion_eligible(&terminal(
            "task-relay", "relay-attempt", None, "automation", "task_notification",
        )));
        assert!(!is_generic_session_completion_eligible(&terminal(
            "task",
            "turn-1",
            Some("task"),
            "automation",
            "task_run",
        )));
        assert!(!is_generic_session_completion_eligible(&terminal(
            "goal",
            "turn-1",
            Some("goal"),
            "desktop",
            "assistant",
        )));
        assert!(!is_generic_session_completion_eligible(&terminal(
            "channel",
            "turn-1",
            None,
            "agent-channel",
            "channel_message",
        )));
        assert!(!is_generic_session_completion_eligible(&terminal(
            "memory",
            "turn-1",
            None,
            "automation",
            "memory_update",
        )));
    }

    #[test]
    fn extracts_terminal_from_plain_and_live_payloads() {
        let raw = serde_json::json!({
            "completionTerminal": {
                "sessionId": "session-1",
                "workspacePath": "/tmp/workspace",
                "turnId": "turn-1",
                "origin": { "kind": "desktop", "surface": "launcher_input" },
                "status": "complete"
            }
        });
        assert_eq!(
            completion_terminal_from_sse_data(&raw.to_string()).map(|value| value.turn_id),
            Some("turn-1".to_string()),
        );

        let live = serde_json::json!({
            "sessionId": "session-1",
            "liveRevision": 3,
            "payload": raw,
        });
        assert_eq!(
            completion_terminal_from_sse_data(&live.to_string()).map(|value| value.turn_id),
            Some("turn-1".to_string()),
        );
    }
}
