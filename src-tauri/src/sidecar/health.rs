use super::*;

/// Wait for the new process to listen, then for its deferred initialization.
/// Only after this returns may the manager publish a dispatchable instance.
pub(super) fn wait_for_startup(
    port: u16,
    alive_check: Option<Box<dyn Fn() -> bool>>,
) -> Result<(), String> {
    wait_for_health(port, alive_check)?;
    wait_for_readiness(port, 30)
}

/// Wait for a new sidecar to listen using a TCP-level check.
/// Listening does not mean HTTP routes are ready: callers must also wait for
/// deferred initialization before publishing the instance as healthy.
///
/// `alive_check`: optional closure that returns `true` if the sidecar process is still alive.
/// Checked every 20 iterations (~10s) to detect early crashes (e.g., AVX2 0xC0000005 on Windows
/// VMs where Windows Defender delays the crash by 20-30s, bypassing the 50ms early exit check).
pub(super) fn wait_for_health(
    port: u16,
    alive_check: Option<Box<dyn Fn() -> bool>>,
) -> Result<(), String> {
    // Exponential backoff: 50, 100, 200, 400, 500, 500, 500, ... (cap).
    // See HEALTH_CHECK_DELAY_* constants for rationale.
    let delay_for = |attempt: u32| -> Duration {
        let ms = HEALTH_CHECK_DELAY_START_MS
            .saturating_mul(1u64 << attempt.saturating_sub(1).min(10))
            .min(HEALTH_CHECK_DELAY_CAP_MS);
        Duration::from_millis(ms)
    };

    for attempt in 1..=HEALTH_CHECK_MAX_ATTEMPTS {
        // Alive check: every 20 attempts in the slow-poll regime is ~10s. But
        // the early fast regime compresses 20 attempts to ~1.6s, still safe.
        // Catches crashes that happen after our initial try_wait (e.g. Windows
        // Defender holds node.exe for 20-30s then lets a crash happen).
        if attempt % 20 == 0 {
            if let Some(ref check) = alive_check {
                if !check() {
                    return Err(format!(
                        "Sidecar process exited during health check on port {} (detected at attempt {})",
                        port, attempt
                    ));
                }
            }
        }

        match std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            Duration::from_millis(HEALTH_CHECK_TIMEOUT_MS),
        ) {
            Ok(_) => {
                ulog_info!(
                    "[sidecar] TCP health check passed after {} attempts on port {}",
                    attempt,
                    port
                );
                return Ok(());
            }
            Err(_) => {
                if attempt < HEALTH_CHECK_MAX_ATTEMPTS {
                    thread::sleep(delay_for(attempt));
                }
            }
        }
    }

    Err(format!(
        "Sidecar failed TCP health check after {} attempts on port {}",
        HEALTH_CHECK_MAX_ATTEMPTS, port
    ))
}

/// Pattern 4: wait for /health/ready (deferred init complete) after /health/live
/// passes. Returns Ok if the sidecar reports ready within `timeout_secs`,
/// Err with the structured failure phase + error if it reports `failed`, or
/// Err with a timeout message otherwise.
///
/// Tolerates older sidecar builds (no /health/ready) by treating a 404 as
/// "ready" (best-effort backward compat — older sidecars used the bare /health
/// as both signals).
pub(super) fn wait_for_readiness(port: u16, timeout_secs: u64) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/health/ready", port);
    let client = match crate::local_http::blocking_builder()
        .timeout(Duration::from_millis(2000))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Err(format!("readiness client build failed: {}", e)),
    };

    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    let mut last_phase: Option<String> = None;
    while std::time::Instant::now() < deadline {
        match client.get(&url).send() {
            Ok(resp) => {
                let status = resp.status();
                if status == reqwest::StatusCode::NOT_FOUND {
                    // Older sidecar; treat as ready.
                    return Ok(());
                }
                if status.is_success() {
                    return Ok(());
                }
                // 503 — try to surface phase / error from the structured body.
                let body = resp.text().unwrap_or_default();
                if body.contains("\"state\":\"failed\"") {
                    return Err(format!("sidecar deferred init failed: {}", body));
                }
                // Track the most recent phase for the timeout error message.
                if let Some(start) = body.find("\"phase\":\"") {
                    let rest = &body[start + 9..];
                    if let Some(end) = rest.find('"') {
                        last_phase = Some(rest[..end].to_string());
                    }
                }
            }
            Err(_) => {
                // Sidecar not yet listening, or transient error — try again.
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let phase_part = last_phase
        .map(|p| format!(" (last phase: {})", p))
        .unwrap_or_default();
    Err(format!(
        "sidecar /health/ready timed out after {}s{}",
        timeout_secs, phase_part
    ))
}

/// Quick HTTP health check for existing sidecar (non-blocking style with short timeout)
/// Returns true if the sidecar HTTP server is responsive
pub(super) fn check_sidecar_http_health(port: u16) -> bool {
    let health_url = format!("http://127.0.0.1:{}/health", port);

    // Short timeout for quick check - sidecar should respond immediately if healthy
    let client = match crate::local_http::blocking_builder()
        .timeout(Duration::from_millis(HTTP_HEALTH_CHECK_TIMEOUT_MS))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    match client.get(&health_url).send() {
        Ok(response) => response.status().is_success(),
        Err(e) => {
            ulog_warn!("[sidecar] HTTP health check failed on port {}: {}", port, e);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;

    fn accept(listener: &TcpListener) -> TcpStream {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    return stream;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "startup did not connect"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("test accept: {error}"),
            }
        }
    }

    // Real loopback HTTP, with initialization controlled by the test. No Node
    // process, real user directory or external service is needed.
    fn startup_response(final_status: &str, final_body: &str) -> Result<(), String> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (result_tx, result_rx) = mpsc::channel();
        let startup = thread::spawn(move || {
            result_tx.send(wait_for_startup(port, None)).unwrap();
        });
        // The first connection is TCP liveness only.
        let mut tcp = accept(&listener);
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        assert_eq!(tcp.read(&mut [0; 1]).unwrap(), 0);
        drop(tcp);

        for (status, body) in [
            (
                "503 Service Unavailable",
                r#"{"state":"phase","phase":"cleanup"}"#,
            ),
            (final_status, final_body),
        ] {
            let mut stream = accept(&listener);
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 1024];
            let n = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..n]).starts_with("GET /health/ready "));
            // An open port and an in-progress init must not finish startup.
            assert!(matches!(
                result_rx.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
        let result = result_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        startup.join().unwrap();
        result
    }

    #[test]
    fn startup_waits_for_deferred_init_after_tcp_listens() {
        assert!(startup_response("200 OK", r#"{"state":"ready"}"#).is_ok());
    }

    #[test]
    fn startup_surfaces_deferred_init_failure() {
        let error = startup_response(
            "503 Service Unavailable",
            r#"{"state":"failed","phase":"cleanup","error":"test init failure"}"#,
        )
        .unwrap_err();
        assert!(error.contains("test init failure"), "{error}");
        assert!(error.contains("cleanup"), "{error}");
    }
}
