//! Backoff belongs to the connector, never to a business request or mutation.
use std::time::{Duration, Instant};

#[derive(Debug)]
pub(super) enum RetryWake {
    Elapsed,
    Boundary,
    Power(Result<bool, super::NetworkError>),
}
pub(super) async fn wait<B, P>(delay: Duration, boundary: B, power: P) -> RetryWake
where
    B: std::future::Future,
    P: std::future::Future<Output = Result<bool, super::NetworkError>>,
{
    tokio::select! { biased;
        _ = boundary => RetryWake::Boundary,
        signal = power => RetryWake::Power(signal),
        _ = tokio::time::sleep(delay) => RetryWake::Elapsed,
    }
}

pub(crate) fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    if ![429, 503].contains(&response.status().as_u16()) {
        return None;
    }
    parse_retry_after(
        response.headers().get("retry-after")?.to_str().ok()?,
        chrono::Utc::now().timestamp(),
    )
}
fn parse_retry_after(value: &str, now: i64) -> Option<Duration> {
    let seconds = value.trim().parse::<u64>().ok().or_else(|| {
        let timestamp = chrono::DateTime::parse_from_rfc2822(value.trim())
            .ok()?
            .timestamp();
        Some(timestamp.saturating_sub(now).max(0) as u64)
    })?;
    Some(Duration::from_secs(seconds.min(3600)))
}

#[derive(Default)]
pub(super) struct ReconnectBackoff {
    failures: u32,
    first_failure: Option<Instant>,
    diagnostic_code: Option<&'static str>,
}
impl ReconnectBackoff {
    pub(super) fn reset(&mut self) {
        self.failures = 0;
        self.first_failure = None;
    }
    pub(super) fn recovered(&mut self) {
        if let Some(started) = self.first_failure {
            crate::ulog_info!(
                "[agent-network] reconnect recovered failures={} streakMs={}",
                self.failures,
                started.elapsed().as_millis()
            );
        }
        self.reset();
    }
    pub(super) fn next(&mut self, jitter: u16, retry_after: Option<Duration>) -> Duration {
        let base = (5_u64 * 2_u64.pow(self.failures.min(4))).min(60);
        let delay = if self.failures == 0 {
            Duration::from_secs(5)
        } else {
            Duration::from_millis(
                base * 1000 + u64::from(jitter) * base * 200 / u64::from(u16::MAX),
            )
        };
        self.failures = self.failures.saturating_add(1);
        let delay = delay.max(retry_after.unwrap_or_default());
        let started = self.first_failure.get_or_insert_with(Instant::now);
        crate::ulog_warn!(
            "[agent-network] reconnect aggregate failures={} streakMs={} nextDelayMs={} code={}",
            self.failures,
            started.elapsed().as_millis(),
            delay.as_millis(),
            self.diagnostic_code.take().unwrap_or("UNSPECIFIED")
        );
        delay
    }

    /// The caller supplies a closed, normalized diagnostic category.
    #[allow(dead_code)] // Desktop supplies a code; the shared headless caller still uses next.
    pub(super) fn next_with_code(
        &mut self,
        jitter: u16,
        retry_after: Option<Duration>,
        code: &'static str,
    ) -> Duration {
        self.diagnostic_code = Some(code);
        self.next(jitter, retry_after)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn account_and_power_interrupt_a_long_retry_wait() {
        use futures_util::poll;
        for power in [false, true] {
            let (account_tx, mut account) = tokio::sync::watch::channel(0);
            let (power_tx, mut power_rx) = tokio::sync::watch::channel(false);
            let mut pending = Box::pin(wait(Duration::from_secs(3600), account.changed(), async {
                power_rx.changed().await.unwrap();
                Ok(true)
            }));
            assert!(poll!(pending.as_mut()).is_pending());
            if power {
                power_tx.send(true).unwrap();
            } else {
                account_tx.send(1).unwrap();
            }
            let wake = tokio::time::timeout(Duration::from_secs(1), pending)
                .await
                .unwrap();
            if power {
                assert!(matches!(wake, RetryWake::Power(Ok(true))));
            } else {
                assert!(matches!(wake, RetryWake::Boundary));
            }
            let mut backoff = ReconnectBackoff::default();
            backoff.next(0, None);
            backoff.next(0, None);
            backoff.reset();
            assert_eq!(backoff.next(0, None), Duration::from_secs(5));
        }
    }
    #[test]
    fn first_recovery_unchanged_then_bounded_jitter_and_reset() {
        let mut backoff = ReconnectBackoff::default();
        assert_eq!(backoff.next(u16::MAX, None), Duration::from_secs(5));
        assert_eq!(backoff.next(0, None), Duration::from_secs(10));
        assert_eq!(backoff.next(u16::MAX, None), Duration::from_secs(24));
        for _ in 0..100 {
            assert!(backoff.next(u16::MAX, None) <= Duration::from_secs(72));
        }
        backoff.reset();
        assert_eq!(backoff.next(0, None), Duration::from_secs(5));
    }
    #[test]
    fn server_delay_is_a_floor_and_does_not_change_default() {
        let mut backoff = ReconnectBackoff::default();
        assert_eq!(
            backoff.next(0, Some(Duration::from_secs(60))),
            Duration::from_secs(60)
        );
        assert_eq!(
            backoff.next(0, Some(Duration::from_secs(1))),
            Duration::from_secs(10)
        );
    }
    #[test]
    fn retry_after_accepts_seconds_and_dates_with_a_bounded_wait() {
        assert_eq!(parse_retry_after("60", 0), Some(Duration::from_secs(60)));
        assert_eq!(
            parse_retry_after("Fri, 01 Jan 2021 00:01:00 GMT", 1609459200),
            Some(Duration::from_secs(60))
        );
        assert_eq!(
            parse_retry_after("999999", 0),
            Some(Duration::from_secs(3600))
        );
        assert_eq!(parse_retry_after("-1", 0), None);
        assert_eq!(parse_retry_after("garbage", 0), None);
    }
}
