//! The native main window outlives its WebContent process. Attach before any
//! Chat mounts so a replacement gets fresh transport and the exact old owners.
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::browser::BrowserManager;
use crate::sidecar::ManagedSidecarManager;
use crate::sse_proxy::SseProxyState;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabOwnerBinding {
    session_id: String,
    tab_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RendererAttachment {
    replacement: bool,
    previous_tab_owners: Vec<TabOwnerBinding>,
}

#[derive(Default)]
pub struct MainRendererState {
    attachment: Mutex<Option<(String, RendererAttachment)>>,
}

impl MainRendererState {
    async fn attach<R: tauri::Runtime>(
        &self,
        renderer_id: String,
        manager: &ManagedSidecarManager,
        sse: &SseProxyState,
        browsers: &BrowserManager,
        app: &tauri::AppHandle<R>,
    ) -> Result<RendererAttachment, String> {
        let mut current = self.attachment.lock().await;
        if let Some((id, receipt)) = current.as_ref() {
            if id == &renderer_id {
                return Ok(receipt.clone());
            }
        }
        let replacement = current.is_some();
        let previous_tab_owners = if replacement {
            manager
                .lock()
                .map_err(|error| error.to_string())?
                .tab_owner_bindings()
                .into_iter()
                .map(|(session_id, tab_id)| TabOwnerBinding { session_id, tab_id })
                .collect()
        } else {
            Vec::new()
        };
        if replacement {
            sse.stop_tab_subscriptions().await;
            browsers.retire_renderer_resources(app).await?;
        }
        let receipt = RendererAttachment {
            replacement,
            previous_tab_owners,
        };
        *current = Some((renderer_id, receipt.clone()));
        Ok(receipt)
    }
}

#[tauri::command]
pub async fn cmd_attach_main_renderer<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, MainRendererState>,
    manager: tauri::State<'_, ManagedSidecarManager>,
    sse: tauri::State<'_, Arc<SseProxyState>>,
    browsers: tauri::State<'_, Arc<BrowserManager>>,
    renderer_id: String,
) -> Result<RendererAttachment, String> {
    // BrowserPanel adds native children to this Window. WebviewWindow command
    // extraction rejects that topology before entering the command body.
    if webview.label() != "main" || webview.window().label() != "main" || renderer_id.is_empty() {
        return Err("Renderer attachment requires the main window and an instance id".into());
    }
    state
        .attach(
            renderer_id,
            manager.inner(),
            sse.inner(),
            browsers.inner(),
            &app,
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::{create_sidecar_manager, SidecarOwner};
    use tauri::Manager;

    #[test]
    fn main_renderer_can_attach_after_browser_child_is_added() {
        let app = tauri::test::mock_builder()
            .manage(MainRendererState::default())
            .manage(create_sidecar_manager())
            .manage(Arc::new(SseProxyState::default()))
            .manage(BrowserManager::new())
            .invoke_handler(tauri::generate_handler![cmd_attach_main_renderer])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .scroll_bar_style(crate::webview_policy::scroll_bar_style())
            .build()
            .unwrap();
        let attach = |webview: &tauri::Webview<tauri::test::MockRuntime>, renderer_id: &str| {
            tauri::test::get_ipc_response(
                &Arc::new(webview.clone()),
                tauri::webview::InvokeRequest {
                    cmd: "cmd_attach_main_renderer".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                        "rendererId": renderer_id,
                    })),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_string(),
                },
            )
            .map(|body| body.deserialize::<serde_json::Value>().unwrap())
        };
        assert_eq!(attach(main.as_ref(), "cold").unwrap()["replacement"], false);
        let browser = app
            .get_window("main")
            .unwrap()
            .add_child(
                tauri::webview::WebviewBuilder::new("browser-test", Default::default())
                    .scroll_bar_style(crate::webview_policy::scroll_bar_style()),
                tauri::LogicalPosition::new(0., 0.),
                tauri::LogicalSize::new(200., 200.),
            )
            .unwrap();
        assert!(app.get_webview_window("main").is_none());
        tauri::async_runtime::block_on(
            app.state::<Arc<BrowserManager>>().insert_test_live_browser(
                "tab",
                "generation",
                "browser-test",
            ),
        );
        assert!(attach(&browser, "child").is_err());
        assert_eq!(
            attach(main.as_ref(), "replacement").unwrap()["replacement"],
            true
        );
        assert!(app.get_webview("browser-test").is_none());
        assert!(app.get_webview("main").is_some());
        assert_eq!(
            attach(main.as_ref(), "replacement").unwrap()["replacement"],
            true
        );
    }

    #[tokio::test]
    async fn replacement_keeps_exact_tab_owners_and_repeat_attach_is_idempotent() {
        let state = MainRendererState::default();
        let manager = create_sidecar_manager();
        let sse = SseProxyState::default();
        let browsers = BrowserManager::new();
        let app = tauri::test::mock_app();
        let cold = state
            .attach("first".into(), &manager, &sse, &browsers, app.handle())
            .await
            .unwrap();
        assert!(!cold.replacement);
        {
            let mut manager = manager.lock().unwrap();
            manager.insert_test_ready_frontend_sidecar(
                "session-a",
                32001,
                SidecarOwner::Tab("tab-a".into()),
            );
            manager.add_session_owner("session-a", SidecarOwner::Companion("companion".into()));
            manager.insert_test_ready_frontend_sidecar(
                "session-b",
                32002,
                SidecarOwner::Tab("tab-b".into()),
            );
        }
        let recovered = state
            .attach("second".into(), &manager, &sse, &browsers, app.handle())
            .await
            .unwrap();
        assert!(recovered.replacement);
        assert_eq!(
            recovered.previous_tab_owners,
            vec![
                TabOwnerBinding {
                    session_id: "session-a".into(),
                    tab_id: "tab-a".into()
                },
                TabOwnerBinding {
                    session_id: "session-b".into(),
                    tab_id: "tab-b".into()
                },
            ]
        );
        // Native attachment only retires transport, never drops Session owners.
        assert_eq!(manager.lock().unwrap().tab_owner_bindings().len(), 2);
        assert_eq!(
            state
                .attach("second".into(), &manager, &sse, &browsers, app.handle())
                .await
                .unwrap(),
            recovered
        );
        assert!(
            !MainRendererState::default()
                .attach("third".into(), &manager, &sse, &browsers, app.handle())
                .await
                .unwrap()
                .replacement
        );
    }
}
