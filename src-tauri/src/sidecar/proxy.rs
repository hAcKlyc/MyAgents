use super::*;

// ============= Proxy Hot-Reload =============

/// Build the proxy payload from disk config for broadcasting to Sidecars.
fn build_proxy_payload() -> serde_json::Value {
    proxy_payload_from_settings(proxy_config::read_raw_proxy_settings())
}

fn proxy_propagation_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn proxy_payload_from_settings(settings: Option<proxy_config::ProxySettings>) -> serde_json::Value {
    match settings {
        Some(s) => {
            let scope = proxy_config::normalized_proxy_scope(&s);
            let enabled = s.enabled && proxy_config::get_proxy_url(&s).is_ok();
            serde_json::json!({
                "enabled": enabled,
                "protocol": s.protocol.unwrap_or_else(|| "http".into()),
                "host": s.host.unwrap_or_else(|| "127.0.0.1".into()),
                "port": s.port.unwrap_or(7890),
                "scope": scope,
            })
        }
        None => serde_json::json!({
            "enabled": false,
            "scope": { "mode": "all" },
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_payload_materializes_legacy_general_scope() {
        let payload = proxy_payload_from_settings(Some(proxy_config::ProxySettings {
            enabled: true,
            protocol: Some("http".into()),
            host: Some("127.0.0.1".into()),
            port: Some(7897),
            scope: Some(proxy_config::ProxyScopeSettings::Custom {
                general_requests: None,
                provider_ids: vec!["anthropic-sub".into()],
                runtime_ids: None,
            }),
        }));

        assert_eq!(payload["scope"]["generalRequests"], true);
        assert_eq!(payload["scope"]["providerIds"][0], "anthropic-sub");
    }

    #[test]
    fn proxy_payload_preserves_runtime_only_selection() {
        let settings = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "scope": { "mode": "custom", "generalRequests": false, "runtimeIds": ["codex"] }
        }))
        .unwrap();
        let payload = proxy_payload_from_settings(Some(settings));
        assert_eq!(payload["scope"]["runtimeIds"], serde_json::json!(["codex"]));
        assert_eq!(payload["scope"]["generalRequests"], false);
        assert_eq!(payload["scope"]["providerIds"], serde_json::json!([]));
    }

    #[test]
    fn proxy_payload_preserves_explicit_zero_scope() {
        let payload = proxy_payload_from_settings(Some(proxy_config::ProxySettings {
            enabled: true,
            protocol: Some("socks5".into()),
            host: Some("127.0.0.1".into()),
            port: Some(1080),
            scope: Some(proxy_config::ProxyScopeSettings::Custom {
                general_requests: Some(false),
                provider_ids: vec![],
                runtime_ids: None,
            }),
        }));

        assert_eq!(payload["scope"]["mode"], "custom");
        assert_eq!(payload["scope"]["generalRequests"], false);
        assert_eq!(payload["scope"]["providerIds"], serde_json::json!([]));
    }
}

/// POST proxy config to a single Sidecar.
async fn post_proxy(client: &reqwest::Client, port: u16, payload: &serde_json::Value) -> bool {
    let url = format!("http://127.0.0.1:{}/api/proxy/set", port);
    match client.post(&url).json(payload).send().await {
        Ok(r) if r.status().is_success() => {
            ulog_info!("[proxy-propagate] Updated sidecar on port {}", port);
            true
        }
        Ok(r) => {
            ulog_warn!("[proxy-propagate] Port {} returned {}", port, r.status());
            false
        }
        Err(e) => {
            ulog_warn!("[proxy-propagate] Port {} unreachable: {}", port, e);
            false
        }
    }
}

/// Propagate proxy settings from disk config to all running Sidecars.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_propagate_proxy(
    app_handle: tauri::AppHandle,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    imState: tauri::State<'_, crate::im::ManagedImBots>,
    agentState: tauri::State<'_, crate::im::ManagedAgents>,
    restartGeneralOwners: bool,
) -> Result<serde_json::Value, String> {
    // Settings effects are fire-and-forget and may overlap (A→B→A). Serialize
    // at the disk authority, then read only after acquiring the lock: a slow
    // older broadcast can therefore never commit after a newer config.
    let _propagation_guard = proxy_propagation_lock().lock().await;
    let payload = build_proxy_payload();
    crate::cliproxy::reconcile_proxy();

    let client = crate::local_http::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut ok = 0u32;
    let mut fail = 0u32;

    // 1. Tab + Global Sidecars
    let ports = sidecarManager
        .lock()
        .map_err(|e| e.to_string())?
        .get_all_active_ports();
    for port in &ports {
        if post_proxy(&client, *port, &payload).await {
            ok += 1;
        } else {
            fail += 1;
        }
    }

    // 2. IM Bot Sidecars — collect ports under lock, then release before network I/O
    let im_ports: Vec<u16> = {
        let im_guard = imState.lock().await;
        let mut collected = Vec::new();
        for (_bot_id, instance) in im_guard.iter() {
            let router = instance.router.lock().await;
            for port in router.active_sidecar_ports() {
                if !ports.contains(&port) {
                    collected.push(port);
                }
            }
        }
        collected.sort();
        collected.dedup();
        collected
    }; // Both im_guard and router locks released here

    for port in &im_ports {
        if post_proxy(&client, *port, &payload).await {
            ok += 1;
        } else {
            fail += 1;
        }
    }

    let scheduled_general_owners = if restartGeneralOwners {
        crate::im::restart_channels_for_general_proxy_change(
            &app_handle,
            &agentState,
            &imState,
            &sidecarManager,
        )
        .await
    } else {
        0
    };

    ulog_info!("[proxy-propagate] Done: {} updated, {} failed", ok, fail);
    Ok(serde_json::json!({
        "updated": ok,
        "failed": fail,
        "scheduledGeneralOwners": scheduled_general_owners,
    }))
}
