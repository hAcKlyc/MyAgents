use std::time::Duration;

use tauri::Manager;

use super::manager::{end_condition_reason, failure_backoff, GoalEndConditionStopSource};
use super::{
    execution, get_session_goal_manager, GoalStatus, GoalTurnFinalizationRequest,
    SessionGoalManager,
};
use crate::{ulog_error, ulog_info, ulog_warn};

pub(super) fn request_continuation(goal_id: String, delay_secs: u64) {
    tauri::async_runtime::spawn(async move {
        get_session_goal_manager()
            .ensure_continuation(&goal_id, delay_secs)
            .await;
    });
}

impl SessionGoalManager {
    pub(super) async fn ensure_continuation(&self, goal_id: &str, delay_secs: u64) {
        let mut handles = self.continuation_handles.write().await;
        if handles
            .get(goal_id)
            .is_some_and(|handle| !handle.inner().is_finished())
        {
            return;
        }
        if let Some(previous) = handles.remove(goal_id) {
            if !previous.inner().is_finished() {
                previous.abort();
            }
        }

        let goal_id_owned = goal_id.to_string();
        let handle = tauri::async_runtime::spawn(async move {
            if delay_secs > 0 {
                tokio::time::sleep(Duration::from_secs(delay_secs)).await;
            }
            let manager = get_session_goal_manager();
            manager
                .continuation_handles
                .write()
                .await
                .remove(&goal_id_owned);
            if let Some(delay) = run_once(&goal_id_owned).await {
                request_continuation(goal_id_owned, delay);
            }
        });
        handles.insert(goal_id.to_string(), handle);
    }

    pub(super) async fn ensure_deadline(&self, goal_id: &str) {
        let deadline = match self.get(goal_id).await {
            Ok(Some(goal)) if !goal.is_terminal() => goal.end_conditions.deadline,
            _ => None,
        };
        let mut handles = self.deadline_handles.write().await;
        if let Some(previous) = handles.remove(goal_id) {
            previous.abort();
        }
        let Some(deadline) = deadline else {
            return;
        };

        let goal_id_owned = goal_id.to_string();
        let manager = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            sleep_until_wallclock(deadline).await;
            loop {
                match manager
                    .stop_goal_for_end_condition(
                        &goal_id_owned,
                        "Goal deadline reached".to_string(),
                        GoalEndConditionStopSource::DeadlineWatchdog,
                    )
                    .await
                {
                    Ok(_) => break,
                    Err(error) if error.code() == "goal_changed" => {
                        ulog_warn!(
                            "[Goal] Deadline cleanup owner {} no longer exists; stopping watchdog",
                            goal_id_owned
                        );
                        break;
                    }
                    Err(error) => {
                        ulog_error!(
                            "[Goal] Deadline terminal commit failed for {}: {}; retrying",
                            goal_id_owned,
                            error
                        );
                        tokio::time::sleep(Duration::from_secs(3)).await;
                    }
                }
            }
            manager
                .deadline_handles
                .write()
                .await
                .remove(&goal_id_owned);
        });
        handles.insert(goal_id.to_string(), handle);
        drop(handles);

        let deadline_is_still_current = self
            .get(goal_id)
            .await
            .ok()
            .flatten()
            .is_some_and(|goal| goal.end_conditions.deadline == Some(deadline));
        if !deadline_is_still_current {
            self.cancel_deadline(goal_id).await;
        }
    }
}

async fn sleep_until_wallclock(deadline: chrono::DateTime<chrono::Utc>) {
    loop {
        let now = chrono::Utc::now();
        if now >= deadline {
            return;
        }
        let millis = (deadline - now).num_milliseconds().clamp(1, 30_000) as u64;
        tokio::time::sleep(Duration::from_millis(millis)).await;
    }
}

async fn run_once(goal_id: &str) -> Option<u64> {
    let manager = get_session_goal_manager();
    let goal = match manager.get(goal_id).await {
        Ok(Some(goal)) => goal,
        Ok(None) => return None,
        Err(error) => {
            ulog_error!("[Goal] Cannot read {} for continuation: {}", goal_id, error);
            return None;
        }
    };
    if goal.status != GoalStatus::Active {
        return None;
    }
    if !goal.delivery_outbox.is_empty() {
        manager.ensure_delivery_replay(goal_id).await;
        return None;
    }
    if let Some(reason) = end_condition_reason(&goal, chrono::Utc::now()) {
        if let Err(error) = manager
            .stop_goal_for_end_condition(
                goal_id,
                reason.to_string(),
                GoalEndConditionStopSource::BoundaryCheck,
            )
            .await
        {
            ulog_error!(
                "[Goal] End-condition commit failed for {}: {}",
                goal_id,
                error
            );
            return Some(3);
        }
        return None;
    }

    let request = match manager.prepare_continuation(goal_id).await {
        Ok(request) => request,
        Err(error)
            if matches!(
                error.code(),
                "turn_conflict" | "stale_revision" | "terminal"
            ) =>
        {
            ulog_info!("[Goal] Continuation {} deferred: {}", goal_id, error);
            return None;
        }
        Err(error) => {
            ulog_error!(
                "[Goal] Continuation {} preparation failed: {}",
                goal_id,
                error
            );
            return Some(3);
        }
    };
    let expected_control_revision = request.expected_control_revision;
    let queue_id = request.queue_id.clone();
    let turn_number = request.turn_number;
    let Some(app_handle) = manager.app_handle.read().await.clone() else {
        let updated = manager
            .record_dispatch_failure(
                goal_id,
                expected_control_revision,
                None,
                Some("App handle unavailable".to_string()),
            )
            .await
            .ok();
        return updated.and_then(next_failure_delay);
    };

    let response = execution::execute(&app_handle, &request).await;
    // No runtime turn was admitted. Waiting is neither an execution failure
    // nor model progress; keep end conditions in this scheduler's next probe.
    if response.as_ref().is_ok_and(continuation_work_pending) {
        return Some(5);
    }
    if response
        .as_ref()
        .is_ok_and(|response| response.termination_unconfirmed)
    {
        if let Err(error) = manager
            .confirm_current_turn_stopped(goal_id, &queue_id)
            .await
        {
            ulog_error!(
                "[Goal] Turn {} termination is unconfirmed; preserving exact authority: {}",
                queue_id,
                error
            );
            return None;
        }
    }
    let latest = manager.get(goal_id).await.ok().flatten();
    if latest.as_ref().is_some_and(|goal| {
        goal.turn_count >= turn_number
            || goal.is_terminal()
            || goal.control_revision != expected_control_revision
    }) {
        return None;
    }

    let (code, error) = failure_details(response);

    if latest
        .as_ref()
        .and_then(|goal| goal.current_turn.as_ref())
        .is_some_and(|turn| turn.queue_id == queue_id)
    {
        let sidecar_generation = latest
            .as_ref()
            .and_then(|goal| goal.current_turn.as_ref())
            .map(|turn| turn.sidecar_generation)
            .expect("current Goal turn was checked above");
        let sidecars = app_handle.state::<crate::sidecar::ManagedSidecarManager>();
        match manager
            .finalize_turn_from_sidecar(
                goal_id,
                &queue_id,
                GoalTurnFinalizationRequest {
                    success: false,
                    code: code.clone(),
                    error: error.clone(),
                    output_text: None,
                    duration_ms: 0,
                    consumed_tokens: 0,
                    channel_delivery_expected: false,
                },
                sidecar_generation,
                sidecars.inner(),
            )
            .await
        {
            Ok(_) => return None,
            Err(finalize_error) => {
                ulog_error!(
                    "[Goal] Failed to finalize dispatched turn {}: {}",
                    queue_id,
                    finalize_error
                );
                return Some(3);
            }
        }
    }

    let updated = match manager
        .record_dispatch_failure(goal_id, expected_control_revision, code, error.clone())
        .await
    {
        Ok(goal) => goal,
        Err(record_error) => {
            ulog_error!(
                "[Goal] Failed to record dispatch failure for {}: {}",
                goal_id,
                record_error
            );
            return Some(3);
        }
    };
    if updated.status != GoalStatus::Active {
        return None;
    }
    let delay = failure_backoff(updated.consecutive_failures);
    ulog_warn!(
        "[Goal] Continuation {} failure #{}; retrying in {}s: {}",
        goal_id,
        updated.consecutive_failures,
        delay,
        error.as_deref().unwrap_or("unknown failure")
    );
    Some(delay)
}

fn next_failure_delay(goal: super::SessionGoal) -> Option<u64> {
    (goal.status == GoalStatus::Active).then(|| failure_backoff(goal.consecutive_failures))
}

// Preserve structured runtime classification through the scheduler fallback as
// well as the normal Node terminal settlement. Never infer it from error text.
fn failure_details(
    response: Result<crate::sidecar::GoalExecuteResponse, String>,
) -> (Option<String>, Option<String>) {
    match response {
        Ok(response) if response.success => (
            None,
            Some("Goal turn returned before durable finalization".to_string()),
        ),
        Ok(response) => (
            response.code,
            response.error.or(Some("Goal turn failed".to_string())),
        ),
        Err(error) => (None, Some(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scheduler_fallback_preserves_recovery_code_and_suppresses_retry() {
        let response =
            serde_json::from_value::<crate::sidecar::GoalExecuteResponse>(serde_json::json!({
                "success": false,
                "code": "context_recovery_required",
                "error": "Context repair exhausted",
            }))
            .unwrap();
        let (code, error) = failure_details(Ok(response));
        assert_eq!(code.as_deref(), Some("context_recovery_required"));
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(super::super::SessionGoalConfig {
                workspace_path: "/tmp/workspace".to_string(),
                session_id: "session-1".to_string(),
                objective: "finish the same objective".to_string(),
                end_conditions: Default::default(),
                notify_enabled: false,
                permission_mode: String::new(),
            })
            .await
            .unwrap();
        assert_eq!(next_failure_delay(goal.clone()), Some(3));
        let paused = manager
            .record_dispatch_failure(&goal.id, goal.control_revision, code, error)
            .await
            .unwrap();
        assert_eq!(paused.id, goal.id);
        assert_eq!(paused.status, GoalStatus::Paused);
        assert_eq!(next_failure_delay(paused), None);
    }
}

fn continuation_work_pending(response: &crate::sidecar::GoalExecuteResponse) -> bool {
    !response.success
        && !response.turn_dispatched
        && !response.termination_unconfirmed
        && response.code.as_deref() == Some("goal_work_pending")
}

#[cfg(test)]
mod continuation_wait_tests {
    use super::*;

    #[test]
    fn only_confirmed_undispatched_work_waits_bypass_failure_accounting() {
        let mut response: crate::sidecar::GoalExecuteResponse = serde_json::from_value(
            serde_json::json!({ "success": false, "code": "goal_work_pending", "sessionId": "session-1" }),
        ).unwrap();
        assert!(continuation_work_pending(&response));
        response.turn_dispatched = true;
        assert!(!continuation_work_pending(&response));
        response.turn_dispatched = false;
        response.termination_unconfirmed = true;
        assert!(!continuation_work_pending(&response));
        response.termination_unconfirmed = false;
        response.code = Some("configuration_failed".to_string());
        assert!(!continuation_work_pending(&response));
        // Old Sidecars did not have a deferral result; their failures retain
        // the existing bounded retry/blocked policy.
        response.code = None;
        assert!(!continuation_work_pending(&response));
    }
}
