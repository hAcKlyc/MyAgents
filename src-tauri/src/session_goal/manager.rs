use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use uuid::Uuid;

use super::store::{self, SessionGoalStoreState};
use super::{
    GoalContinuationRequest, GoalDeliveryOutboxItem, GoalMutationError, GoalStatus,
    GoalTerminalActor, GoalTerminalOutcome, GoalTurnAuthority, GoalTurnFinalization,
    GoalTurnFinalizationRequest, GoalTurnKind, SessionGoal, SessionGoalConfig,
};
use crate::sidecar::{release_session_sidecar, ManagedSidecarManager, SidecarOwner};
use crate::{ulog_info, ulog_warn};

#[cfg(test)]
type StopGoalTurnHook = Arc<
    dyn Fn(
            &SessionGoal,
            Option<&str>,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync,
>;

#[cfg(test)]
type ReleaseGoalOwnerHook = Arc<
    dyn Fn(
            &SessionGoal,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, String>> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct SessionGoalManager {
    pub(super) state: Arc<RwLock<SessionGoalStoreState>>,
    pub(super) storage_path: PathBuf,
    pub(super) continuation_handles:
        Arc<RwLock<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    pub(super) deadline_handles: Arc<RwLock<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    pub(super) delivery_replayers: Arc<RwLock<HashSet<String>>>,
    pub(super) app_handle: Arc<RwLock<Option<AppHandle>>>,
    #[cfg(test)]
    stop_goal_turn_hook: Arc<RwLock<Option<StopGoalTurnHook>>>,
    #[cfg(test)]
    release_goal_owner_hook: Arc<RwLock<Option<ReleaseGoalOwnerHook>>>,
}

impl SessionGoalManager {
    pub fn new() -> Self {
        let storage_path = crate::app_dirs::myagents_data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("session_goals.json");
        let state = store::load(&storage_path);
        Self {
            state: Arc::new(RwLock::new(state)),
            storage_path,
            continuation_handles: Arc::new(RwLock::new(HashMap::new())),
            deadline_handles: Arc::new(RwLock::new(HashMap::new())),
            delivery_replayers: Arc::new(RwLock::new(HashSet::new())),
            app_handle: Arc::new(RwLock::new(None)),
            #[cfg(test)]
            stop_goal_turn_hook: Arc::new(RwLock::new(None)),
            #[cfg(test)]
            release_goal_owner_hook: Arc::new(RwLock::new(None)),
        }
    }

    #[cfg(test)]
    pub fn with_storage_path(storage_path: PathBuf) -> Self {
        Self {
            state: Arc::new(RwLock::new(store::load(&storage_path))),
            storage_path,
            continuation_handles: Arc::new(RwLock::new(HashMap::new())),
            deadline_handles: Arc::new(RwLock::new(HashMap::new())),
            delivery_replayers: Arc::new(RwLock::new(HashSet::new())),
            app_handle: Arc::new(RwLock::new(None)),
            stop_goal_turn_hook: Arc::new(RwLock::new(None)),
            release_goal_owner_hook: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn set_app_handle(&self, app_handle: AppHandle) {
        *self.app_handle.write().await = Some(app_handle);
    }

    pub async fn create_goal(
        &self,
        config: SessionGoalConfig,
    ) -> Result<SessionGoal, GoalMutationError> {
        self.create_goal_with_status(config, GoalStatus::Active)
            .await
    }

    pub async fn create_goal_waiting_for_turn(
        &self,
        config: SessionGoalConfig,
    ) -> Result<SessionGoal, GoalMutationError> {
        self.create_goal_with_status(config, GoalStatus::Paused)
            .await
    }

    async fn create_goal_with_status(
        &self,
        config: SessionGoalConfig,
        initial_status: GoalStatus,
    ) -> Result<SessionGoal, GoalMutationError> {
        let workspace_path = config.workspace_path.trim();
        let session_id = config.session_id.trim();
        let objective = config.objective.trim();
        if workspace_path.is_empty() {
            return Err(GoalMutationError::goal("workspacePath is required"));
        }
        if session_id.is_empty() {
            return Err(GoalMutationError::goal("sessionId is required"));
        }
        if session_id.starts_with("pending-") {
            return Err(GoalMutationError::goal(
                "Goal requires a materialized Session identity",
            ));
        }
        if objective.is_empty() {
            return Err(GoalMutationError::goal("objective is required"));
        }
        if config.end_conditions.max_executions == Some(0) {
            return Err(GoalMutationError::goal(
                "endConditions.maxExecutions must be at least 1",
            ));
        }

        let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[session_id]).await;
        let mut state = self.state.write().await;
        let current = state
            .ready_mut()
            .map_err(GoalMutationError::store_corrupt)?;
        if current
            .get(session_id)
            .is_some_and(SessionGoal::protects_session_identity)
        {
            return Err(GoalMutationError::turn_conflict(
                "Current Session already has an unfinished Goal",
            ));
        }

        let now = Utc::now();
        let goal = SessionGoal {
            id: format!("goal_{}", Uuid::new_v4().simple()),
            workspace_path: workspace_path.to_string(),
            session_id: session_id.to_string(),
            objective: objective.to_string(),
            status: initial_status,
            end_conditions: config.end_conditions,
            notify_enabled: config.notify_enabled,
            permission_mode: config.permission_mode,
            turn_count: 0,
            created_at: now,
            updated_at: now,
            total_duration_ms: 0,
            total_tokens: 0,
            last_executed_at: None,
            terminal_reason: None,
            revision: 1,
            control_revision: 1,
            current_turn: None,
            delivery_outbox: Vec::new(),
            consecutive_failures: 0,
        };
        let mut next = current.clone();
        next.insert(session_id.to_string(), goal.clone());
        store::persist(&self.storage_path, &next).await?;
        *current = next;
        drop(state);

        self.emit_changed(&goal).await;
        if goal.end_conditions.deadline.is_some() {
            self.ensure_deadline(&goal.id).await;
        }
        Ok(goal)
    }

    /// Create a Goal from a headless/CLI surface that has no accompanying
    /// user message to claim the first turn.
    pub async fn create_goal_and_run(
        &self,
        config: SessionGoalConfig,
    ) -> Result<SessionGoal, GoalMutationError> {
        let goal = self.create_goal(config).await?;
        self.ensure_continuation(&goal.id, 0).await;
        Ok(goal)
    }

    pub async fn get(&self, goal_id: &str) -> Result<Option<SessionGoal>, GoalMutationError> {
        let state = self.state.read().await;
        Ok(state
            .ready()
            .map_err(GoalMutationError::store_corrupt)?
            .values()
            .find(|goal| goal.id == goal_id)
            .cloned())
    }

    pub async fn get_for_session(
        &self,
        session_id: &str,
        workspace_path: Option<&str>,
        include_terminal: bool,
    ) -> Result<Option<SessionGoal>, GoalMutationError> {
        let state = self.state.read().await;
        let goal = state
            .ready()
            .map_err(GoalMutationError::store_corrupt)?
            .get(session_id);
        let normalized_workspace =
            workspace_path.map(crate::workspace_path::normalize_workspace_path_identity);
        Ok(goal
            .filter(|goal| include_terminal || !goal.is_terminal())
            .filter(|goal| {
                normalized_workspace.as_ref().is_none_or(|workspace| {
                    crate::workspace_path::normalize_workspace_path_identity(&goal.workspace_path)
                        == *workspace
                })
            })
            .cloned())
    }

    pub async fn has_session_identity_protection(
        &self,
        session_id: &str,
    ) -> Result<bool, GoalMutationError> {
        let state = self.state.read().await;
        Ok(state
            .ready()
            .map_err(GoalMutationError::store_corrupt)?
            .get(session_id)
            .is_some_and(SessionGoal::protects_session_identity))
    }

    pub async fn lifecycle_snapshot(&self) -> Result<(usize, Vec<String>), GoalMutationError> {
        let state = self.state.read().await;
        let goals = state.ready().map_err(GoalMutationError::store_corrupt)?;
        let running_count = goals
            .values()
            .filter(|goal| goal.status == GoalStatus::Active)
            .count();
        let mut protected = goals
            .values()
            .filter(|goal| goal.protects_session_identity())
            .map(|goal| goal.session_id.clone())
            .collect::<Vec<_>>();
        protected.sort();
        protected.dedup();
        Ok((running_count, protected))
    }

    async fn commit<R, F>(
        &self,
        goal_id: &str,
        mutate: F,
    ) -> Result<(SessionGoal, R, bool), GoalMutationError>
    where
        F: FnOnce(&mut SessionGoal) -> Result<R, GoalMutationError>,
    {
        let mut state = self.state.write().await;
        let current = state
            .ready_mut()
            .map_err(GoalMutationError::store_corrupt)?;
        let session_id = current
            .iter()
            .find_map(|(session_id, goal)| (goal.id == goal_id).then(|| session_id.clone()))
            .ok_or_else(|| GoalMutationError::goal_changed("Goal identity changed"))?;
        let mut next = current.clone();
        let goal = next
            .get_mut(&session_id)
            .expect("Session Goal key resolved above");
        let before = goal.clone();
        let result = mutate(goal)?;
        let updated = goal.clone();
        if updated == before {
            return Ok((updated, result, false));
        }
        store::persist(&self.storage_path, &next).await?;
        *current = next;
        Ok((updated, result, true))
    }

    async fn pause_goal(&self, goal_id: &str) -> Result<SessionGoal, GoalMutationError> {
        let now = Utc::now();
        let (updated, _, changed) = self
            .commit(goal_id, move |goal| {
                if goal.is_terminal() {
                    return Err(GoalMutationError::terminal("Goal is already terminal"));
                }
                if goal.status == GoalStatus::Paused {
                    return Ok(());
                }
                goal.status = GoalStatus::Paused;
                goal.updated_at = now;
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(())
            })
            .await?;
        self.cancel_continuation(goal_id).await;
        if changed {
            self.emit_changed(&updated).await;
        }
        Ok(updated)
    }

    pub async fn pause_goal_and_stop(
        &self,
        goal_id: &str,
    ) -> Result<SessionGoal, GoalMutationError> {
        let current = self
            .get(goal_id)
            .await?
            .ok_or_else(|| GoalMutationError::goal_changed("Goal identity changed"))?;
        let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[&current.session_id]).await;
        let goal = self.pause_goal(goal_id).await?;
        let Some(queue_id) = goal.current_turn.as_ref().map(|turn| turn.queue_id.clone()) else {
            self.stop_goal_turn(&goal, None).await.map_err(|error| {
                GoalMutationError::goal(format!(
                    "Goal paused, but pending runtime work was not stopped: {error}"
                ))
            })?;
            let _ = self.release_goal_owner(&goal).await;
            return Ok(goal);
        };
        self.stop_goal_turn(&goal, Some(&queue_id))
            .await
            .map_err(|error| {
                GoalMutationError::goal(format!(
                    "Goal paused, but exact runtime stop was not confirmed: {error}"
                ))
            })?;
        self.abort_turn_with_lifecycle(goal_id, &queue_id).await
    }

    pub async fn pause_turn_from_sidecar(
        &self,
        goal_id: &str,
        queue_id: &str,
        session_id: &str,
        sidecar_generation: u64,
        sidecars: &ManagedSidecarManager,
    ) -> Result<SessionGoal, GoalMutationError> {
        let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[session_id]).await;
        if !sidecar_generation_is_current(sidecars, session_id, sidecar_generation)? {
            return Err(GoalMutationError::stale_turn(
                "Pause belongs to a previous Sidecar generation",
            ));
        }
        let queue_id = queue_id.to_string();
        let now = Utc::now();
        let (updated, terminal_noop, changed) = self
            .commit(goal_id, move |goal| {
                if goal.session_id != session_id {
                    return Err(GoalMutationError::goal_changed("Goal Session changed"));
                }
                if goal.is_terminal() {
                    return Ok(true);
                }
                if goal.status == GoalStatus::Paused {
                    return Ok(false);
                }
                let owns_turn =
                    goal.current_turn
                        .as_ref()
                        .map_or(goal.status == GoalStatus::Active, |turn| {
                            turn.queue_id == queue_id
                                && turn.sidecar_generation == sidecar_generation
                        });
                if !owns_turn {
                    return Err(GoalMutationError::stale_turn(
                        "Pause does not own the current Goal turn",
                    ));
                }
                goal.status = GoalStatus::Paused;
                goal.updated_at = now;
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(false)
            })
            .await?;
        if terminal_noop {
            return Ok(updated);
        }
        self.cancel_continuation(goal_id).await;
        if changed {
            self.emit_changed(&updated).await;
        }
        Ok(updated)
    }

    pub async fn resume_goal(&self, goal_id: &str) -> Result<SessionGoal, GoalMutationError> {
        let current = self
            .get(goal_id)
            .await?
            .ok_or_else(|| GoalMutationError::goal_changed("Goal identity changed"))?;
        if current.is_terminal() {
            return Err(GoalMutationError::terminal("Goal is already terminal"));
        }
        if current.current_turn.is_some() {
            return Err(GoalMutationError::turn_conflict(
                "Goal turn stop is not confirmed; retry Stop before resuming",
            ));
        }
        if current.status == GoalStatus::Active {
            self.ensure_continuation(goal_id, 0).await;
            return Ok(current);
        }
        let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[&current.session_id]).await;
        self.stop_goal_turn(&current, None).await.map_err(|error| {
            GoalMutationError::goal(format!(
                "Pending Goal work was not stopped; retry Resume: {error}"
            ))
        })?;
        let _ = self.release_goal_owner(&current).await;

        let expected_control_revision = current.control_revision;
        let now = Utc::now();
        let (updated, _, changed) = self
            .commit(goal_id, move |goal| {
                if goal.is_terminal() {
                    return Err(GoalMutationError::terminal("Goal is already terminal"));
                }
                if goal.control_revision != expected_control_revision
                    || goal.status != GoalStatus::Paused
                    || goal.current_turn.is_some()
                {
                    return Err(GoalMutationError::stale_revision(
                        "Goal changed while pending work was being stopped",
                    ));
                }
                goal.status = GoalStatus::Active;
                goal.terminal_reason = None;
                goal.updated_at = now;
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(())
            })
            .await?;
        if changed {
            self.emit_changed(&updated).await;
        }
        self.ensure_continuation(goal_id, 0).await;
        Ok(updated)
    }

    pub async fn update_objective_cas(
        &self,
        goal_id: &str,
        objective: String,
        expected_revision: Option<u64>,
    ) -> Result<SessionGoal, GoalMutationError> {
        let objective = objective.trim().to_string();
        if objective.is_empty() {
            return Err(GoalMutationError::goal("Goal objective cannot be empty"));
        }
        let current = self
            .get(goal_id)
            .await?
            .ok_or_else(|| GoalMutationError::goal_changed("Goal identity changed"))?;
        let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[&current.session_id]).await;
        let now = Utc::now();
        let (mut updated, _, changed) = self
            .commit(goal_id, move |goal| {
                if goal.is_terminal() {
                    return Err(GoalMutationError::terminal("Goal is already terminal"));
                }
                if expected_revision.is_some_and(|revision| revision != goal.revision) {
                    return Err(GoalMutationError::stale_revision(format!(
                        "expected {}, current {}",
                        expected_revision.unwrap_or_default(),
                        goal.revision
                    )));
                }
                if goal.objective == objective {
                    return Ok(());
                }
                goal.objective = objective.clone();
                goal.updated_at = now;
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(())
            })
            .await?;
        // The lifecycle lock may have queued behind a Node claim. Use the
        // commit snapshot, not the pre-lock read, as the exact authority to
        // stop and abort.
        let previous_queue_id = updated
            .current_turn
            .as_ref()
            .map(|turn| turn.queue_id.clone());
        if changed {
            self.cancel_continuation(goal_id).await;
            self.emit_changed(&updated).await;
            if updated.status == GoalStatus::Active {
                let stop_result = if let Some(queue_id) = previous_queue_id.as_deref() {
                    self.stop_goal_turn(&updated, Some(queue_id)).await
                } else {
                    self.stop_goal_turn(&updated, None).await
                };
                match stop_result {
                    Ok(()) => {
                        if let Some(queue_id) = previous_queue_id.as_deref() {
                            updated = self.abort_turn_with_lifecycle(goal_id, queue_id).await?;
                        } else {
                            self.ensure_continuation(goal_id, 0).await;
                        }
                    }
                    Err(error) => {
                        updated = self.pause_goal(goal_id).await?;
                        ulog_warn!(
                            "[Goal] objective updated for {}, but previous turn stop was not confirmed; Goal paused: {}",
                            goal_id,
                            error
                        );
                    }
                }
            }
        }
        Ok(updated)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn claim_turn_from_sidecar(
        &self,
        goal_id: &str,
        queue_id: &str,
        kind: GoalTurnKind,
        expected_control_revision: u64,
        session_id: &str,
        sidecar_generation: u64,
        sidecars: &ManagedSidecarManager,
    ) -> Result<(SessionGoal, GoalTurnAuthority), GoalMutationError> {
        let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[session_id]).await;
        if !sidecar_generation_is_current(sidecars, session_id, sidecar_generation)? {
            return Err(GoalMutationError::stale_turn(
                "Turn belongs to a previous Sidecar generation",
            ));
        }
        let queue_id = queue_id.to_string();
        let now = Utc::now();
        let (updated, authority, changed) = self
            .commit(goal_id, move |goal| {
                if goal.session_id != session_id {
                    return Err(GoalMutationError::goal_changed("Goal Session changed"));
                }
                if goal.is_terminal() {
                    return Err(GoalMutationError::terminal("Goal is terminal"));
                }
                if goal.control_revision != expected_control_revision {
                    return Err(GoalMutationError::stale_revision(format!(
                        "expected control revision {}, current {}",
                        expected_control_revision, goal.control_revision
                    )));
                }
                if let Some(current) = goal.current_turn.as_ref() {
                    if current.queue_id == queue_id
                        && current.sidecar_generation == sidecar_generation
                    {
                        return Ok(Some(current.clone()));
                    }
                    return Err(GoalMutationError::turn_conflict(
                        "Another Goal turn currently owns this Session",
                    ));
                }
                if let Some(reason) = end_condition_reason(goal, now) {
                    goal.current_turn = Some(GoalTurnAuthority {
                        queue_id: queue_id.clone(),
                        kind,
                        turn_number: goal.turn_count.saturating_add(1),
                        sidecar_generation,
                        created_at: now,
                    });
                    goal.status = GoalStatus::Canceled;
                    goal.terminal_reason = Some(reason.to_string());
                    goal.updated_at = now;
                    goal.bump_revision();
                    goal.bump_control_revision();
                    return Ok(None);
                }
                if goal.status == GoalStatus::Paused && kind != GoalTurnKind::UserQuery {
                    return Err(GoalMutationError::turn_conflict("Goal is paused"));
                }
                if goal.status == GoalStatus::Paused {
                    goal.status = GoalStatus::Active;
                    goal.terminal_reason = None;
                }
                let authority = GoalTurnAuthority {
                    queue_id: queue_id.clone(),
                    kind,
                    turn_number: goal.turn_count.saturating_add(1),
                    sidecar_generation,
                    created_at: now,
                };
                goal.current_turn = Some(authority.clone());
                goal.updated_at = now;
                goal.bump_revision();
                Ok(Some(authority))
            })
            .await?;

        let Some(authority) = authority else {
            self.cancel_continuation(goal_id).await;
            self.cancel_deadline(goal_id).await;
            if changed {
                self.emit_changed(&updated).await;
            }
            self.send_terminal_notification(&updated).await;
            return Err(GoalMutationError::terminal(
                updated
                    .terminal_reason
                    .as_deref()
                    .unwrap_or("Goal end condition reached"),
            ));
        };

        let attached = {
            let mut sidecars = sidecars.lock().map_err(|error| {
                GoalMutationError::goal(format!("Sidecar lock poisoned: {error}"))
            })?;
            sidecars.generation_for(session_id) == Some(sidecar_generation)
                && sidecars.add_session_owner(session_id, SidecarOwner::Goal(goal_id.to_string()))
        };
        if !attached {
            let _ = self
                .abort_turn_with_lifecycle(goal_id, &authority.queue_id)
                .await;
            return Err(GoalMutationError::stale_turn(
                "Goal lost its Sidecar before owner attachment",
            ));
        }
        self.cancel_continuation(goal_id).await;
        if changed {
            self.emit_changed(&updated).await;
        }
        Ok((updated, authority))
    }

    pub async fn abort_turn(
        &self,
        goal_id: &str,
        queue_id: &str,
    ) -> Result<SessionGoal, GoalMutationError> {
        let current = self
            .get(goal_id)
            .await?
            .ok_or_else(|| GoalMutationError::goal_changed("Goal identity changed"))?;
        let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[&current.session_id]).await;
        self.abort_turn_with_lifecycle(goal_id, queue_id).await
    }

    async fn abort_turn_with_lifecycle(
        &self,
        goal_id: &str,
        queue_id: &str,
    ) -> Result<SessionGoal, GoalMutationError> {
        let current = self
            .get(goal_id)
            .await?
            .ok_or_else(|| GoalMutationError::goal_changed("Goal identity changed"))?;
        let current_queue_id = current
            .current_turn
            .as_ref()
            .map(|turn| turn.queue_id.as_str());
        if current_queue_id.is_some_and(|current_queue_id| current_queue_id != queue_id) {
            return Ok(current);
        }
        if current.status != GoalStatus::Active {
            self.release_goal_owner(&current)
                .await
                .map_err(GoalMutationError::goal)?;
        }
        if current_queue_id.is_none() {
            if current.status == GoalStatus::Active {
                super::scheduler::request_continuation(goal_id.to_string(), 0);
            }
            return Ok(current);
        }
        let queue_id = queue_id.to_string();
        let now = Utc::now();
        let (updated, _, changed) = self
            .commit(goal_id, move |goal| {
                if goal
                    .current_turn
                    .as_ref()
                    .is_none_or(|turn| turn.queue_id != queue_id)
                {
                    return Ok(());
                }
                goal.current_turn = None;
                goal.updated_at = now;
                goal.bump_revision();
                Ok(())
            })
            .await?;
        if changed {
            self.emit_changed(&updated).await;
        }
        // Aborting a queue id is also the recovery acknowledgement for an
        // admission that failed before claim. An active Goal must never be
        // left without either a current turn or a continuation worker.
        if updated.status == GoalStatus::Active {
            super::scheduler::request_continuation(goal_id.to_string(), 0);
        }
        Ok(updated)
    }

    pub async fn prepare_continuation(
        &self,
        goal_id: &str,
    ) -> Result<GoalContinuationRequest, GoalMutationError> {
        let goal = self
            .get(goal_id)
            .await?
            .ok_or_else(|| GoalMutationError::goal_changed("Goal identity changed"))?;
        if goal.status != GoalStatus::Active {
            return Err(if goal.is_terminal() {
                GoalMutationError::terminal("Goal is terminal")
            } else {
                GoalMutationError::turn_conflict("Goal is paused")
            });
        }
        if goal.current_turn.is_some() {
            return Err(GoalMutationError::turn_conflict(
                "A Goal turn already owns this Session",
            ));
        }
        if !goal.delivery_outbox.is_empty() {
            return Err(GoalMutationError::turn_conflict(
                "Goal channel delivery must drain before continuation",
            ));
        }
        Ok(GoalContinuationRequest {
            queue_id: Uuid::new_v4().to_string(),
            turn_number: goal.turn_count.saturating_add(1),
            expected_control_revision: goal.control_revision,
            goal,
        })
    }

    pub async fn record_dispatch_failure(
        &self,
        goal_id: &str,
        expected_control_revision: u64,
        code: Option<String>,
        error: Option<String>,
    ) -> Result<SessionGoal, GoalMutationError> {
        let current = self
            .get(goal_id)
            .await?
            .ok_or_else(|| GoalMutationError::goal_changed("Goal identity changed"))?;
        // Keep a concurrent explicit resume/claim from reacquiring the Goal
        // owner before a newly paused dispatch releases that same owner.
        let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[&current.session_id]).await;
        let now = Utc::now();
        let (updated, became_terminal, changed) = self
            .commit(goal_id, move |goal| {
                if goal.is_terminal()
                    || goal.status != GoalStatus::Active
                    || goal.control_revision != expected_control_revision
                    || goal.current_turn.is_some()
                {
                    return Ok(false);
                }
                if let Some(reason) = recovery_pause_reason(code.as_deref(), error.as_deref()) {
                    goal.status = GoalStatus::Paused;
                    goal.terminal_reason = Some(reason);
                    goal.bump_control_revision();
                    goal.updated_at = now;
                    goal.bump_revision();
                    return Ok(false);
                }
                goal.consecutive_failures = goal.consecutive_failures.saturating_add(1);
                let became_terminal = goal.consecutive_failures >= 10;
                if became_terminal {
                    goal.status = GoalStatus::Blocked;
                    goal.terminal_reason = Some(format!(
                        "Goal stopped after 10 consecutive execution failures{}",
                        error
                            .as_deref()
                            .map(|message| format!(": {message}"))
                            .unwrap_or_default()
                    ));
                    goal.bump_control_revision();
                }
                goal.updated_at = now;
                goal.bump_revision();
                Ok(became_terminal)
            })
            .await?;
        if changed {
            self.emit_changed(&updated).await;
        }
        if changed && updated.status == GoalStatus::Paused && updated.current_turn.is_none() {
            self.cancel_continuation(goal_id).await;
            let _ = self.release_goal_owner(&updated).await;
        }
        if became_terminal {
            self.cancel_deadline(goal_id).await;
            let _ = self.release_goal_owner(&updated).await;
            self.send_terminal_notification(&updated).await;
        }
        Ok(updated)
    }

    pub async fn finalize_turn_from_sidecar(
        &self,
        goal_id: &str,
        queue_id: &str,
        request: GoalTurnFinalizationRequest,
        sidecar_generation: u64,
        sidecars: &ManagedSidecarManager,
    ) -> Result<GoalTurnFinalization, GoalMutationError> {
        let queue_id = queue_id.to_string();
        let now = Utc::now();
        let (
            updated,
            (applied, delivery_enqueued, became_terminal, cleared_stale_authority),
            changed,
        ) = self
            .commit(goal_id, move |goal| {
                let Some(authority) = goal
                    .current_turn
                    .as_ref()
                    .filter(|turn| turn.queue_id == queue_id)
                    .cloned()
                else {
                    return Ok((false, false, false, false));
                };
                if authority.sidecar_generation != sidecar_generation
                    || !sidecar_generation_is_current(
                        sidecars,
                        &goal.session_id,
                        authority.sidecar_generation,
                    )?
                {
                    goal.current_turn = None;
                    goal.updated_at = now;
                    goal.bump_revision();
                    return Ok((false, false, false, true));
                }
                // A user/system control action has already won. The runtime
                // terminal callback is now only an acknowledgement that the
                // exact queue item ended; it must not count the stopped turn
                // or emit delivery side effects against the newer control epoch.
                if matches!(goal.status, GoalStatus::Paused | GoalStatus::Canceled) {
                    goal.current_turn = None;
                    goal.updated_at = now;
                    goal.bump_revision();
                    return Ok((false, false, false, false));
                }
                goal.current_turn = None;
                goal.turn_count = goal.turn_count.max(authority.turn_number);
                goal.last_executed_at = Some(now);
                goal.total_duration_ms = goal.total_duration_ms.saturating_add(request.duration_ms);
                goal.total_tokens = goal.total_tokens.saturating_add(request.consumed_tokens);
                let recovery_reason = (!request.success && goal.status == GoalStatus::Active)
                    .then(|| {
                        recovery_pause_reason(request.code.as_deref(), request.error.as_deref())
                    })
                    .flatten();
                goal.consecutive_failures = if recovery_reason.is_some() {
                    goal.consecutive_failures
                } else if request.success {
                    0
                } else {
                    goal.consecutive_failures.saturating_add(1)
                };
                let mut delivery_enqueued = false;
                if request.success && request.channel_delivery_expected {
                    if let Some(text) = request
                        .output_text
                        .as_deref()
                        .filter(|text| !text.trim().is_empty())
                    {
                        let delivery_id = format!("goal_delivery_{queue_id}");
                        if !goal
                            .delivery_outbox
                            .iter()
                            .any(|item| item.id == delivery_id)
                        {
                            goal.delivery_outbox.push(GoalDeliveryOutboxItem {
                                id: delivery_id,
                                text: truncate_delivery_text(text),
                                created_at: now,
                            });
                            delivery_enqueued = true;
                        }
                    }
                }
                if let Some(reason) = recovery_reason {
                    goal.status = GoalStatus::Paused;
                    goal.terminal_reason = Some(reason);
                    goal.bump_control_revision();
                }
                let became_terminal = !request.success
                    && goal.status == GoalStatus::Active
                    && goal.consecutive_failures >= 10;
                if became_terminal {
                    goal.status = GoalStatus::Blocked;
                    goal.terminal_reason = Some(format!(
                        "Goal stopped after 10 consecutive execution failures{}",
                        request
                            .error
                            .as_deref()
                            .map(|message| format!(": {message}"))
                            .unwrap_or_default()
                    ));
                    goal.bump_control_revision();
                }
                goal.updated_at = now;
                goal.bump_revision();
                Ok((true, delivery_enqueued, became_terminal, false))
            })
            .await?;
        if changed {
            self.emit_changed(&updated).await;
        }
        if cleared_stale_authority && updated.status == GoalStatus::Active {
            super::scheduler::request_continuation(goal_id.to_string(), 0);
        } else if delivery_enqueued {
            self.ensure_delivery_replay(goal_id).await;
        } else if applied && updated.status == GoalStatus::Active {
            let delay = if request.success {
                0
            } else {
                failure_backoff(updated.consecutive_failures)
            };
            super::scheduler::request_continuation(goal_id.to_string(), delay);
        }
        if (updated.is_terminal() || updated.status == GoalStatus::Paused)
            && updated.current_turn.is_none()
        {
            let _ = self.release_goal_owner(&updated).await;
        }
        if became_terminal {
            self.cancel_deadline(goal_id).await;
            self.send_terminal_notification(&updated).await;
        }
        Ok(GoalTurnFinalization {
            goal: updated,
            applied,
            delivery_enqueued,
        })
    }

    pub async fn cancel_goal_and_stop(
        &self,
        goal_id: &str,
        reason: Option<String>,
    ) -> Result<SessionGoal, GoalMutationError> {
        self.transition_goal_and_stop(
            goal_id,
            reason,
            GoalTerminalActor::User,
            GoalStopSettlement::SingleAttempt,
        )
        .await
    }

    pub(super) async fn stop_goal_for_end_condition(
        &self,
        goal_id: &str,
        reason: String,
        source: GoalEndConditionStopSource,
    ) -> Result<SessionGoal, GoalMutationError> {
        let result = self
            .transition_goal_and_stop(
                goal_id,
                Some(reason),
                GoalTerminalActor::System,
                GoalStopSettlement::RetryUntilConfirmed,
            )
            .await;
        if result.is_ok() && source == GoalEndConditionStopSource::BoundaryCheck {
            self.cancel_deadline(goal_id).await;
        }
        result
    }

    async fn transition_goal_and_stop(
        &self,
        goal_id: &str,
        reason: Option<String>,
        actor: GoalTerminalActor,
        settlement: GoalStopSettlement,
    ) -> Result<SessionGoal, GoalMutationError> {
        let current = self
            .get(goal_id)
            .await?
            .ok_or_else(|| GoalMutationError::goal_changed("Goal identity changed"))?;
        let outcome = {
            // Serialize the durable terminal transition, then release the
            // lifecycle lock before asking the Sidecar to stop. `/goal/stop`
            // can synchronously settle the dispatch guard through
            // `/api/goal/turn/abort`, which must acquire this same lock.
            let _lifecycle =
                crate::sidecar::acquire_session_lifecycle(&[&current.session_id]).await;
            self.transition_terminal(goal_id, GoalStatus::Canceled, reason, actor)
                .await?
        };
        let (mut goal, should_stop) = match outcome {
            GoalTerminalOutcome::Applied(goal) => (goal, true),
            GoalTerminalOutcome::AlreadyTerminal(goal) => {
                let retry_canceled_cleanup = goal.status == GoalStatus::Canceled;
                (goal, retry_canceled_cleanup)
            }
        };
        if !should_stop {
            return Ok(goal);
        }
        loop {
            let stop_result = if let Some(queue_id) =
                goal.current_turn.as_ref().map(|turn| turn.queue_id.clone())
            {
                match self.stop_goal_turn(&goal, Some(&queue_id)).await {
                    Ok(()) => self.abort_turn(goal_id, &queue_id).await,
                    Err(error) => Err(GoalMutationError::goal(format!(
                        "Goal canceled, but exact runtime stop was not confirmed: {error}"
                    ))),
                }
            } else {
                match self.stop_goal_turn(&goal, None).await {
                    Ok(()) => {
                        let _lifecycle =
                            crate::sidecar::acquire_session_lifecycle(&[&goal.session_id]).await;
                        self.release_goal_owner(&goal)
                            .await
                            .map(|_| goal.clone())
                            .map_err(|error| {
                                GoalMutationError::goal(format!(
                                    "Goal canceled, but its Sidecar owner was not released: {error}"
                                ))
                            })
                    }
                    Err(error) => Err(GoalMutationError::goal(format!(
                        "Goal canceled, but pending runtime work was not stopped: {error}"
                    ))),
                }
            };
            match stop_result {
                Ok(stopped) => return Ok(stopped),
                Err(error) if settlement == GoalStopSettlement::RetryUntilConfirmed => {
                    ulog_warn!(
                        "[Goal] End-condition cleanup is not confirmed for {}: {}; retrying",
                        goal_id,
                        error
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    goal = self
                        .get(goal_id)
                        .await?
                        .ok_or_else(|| GoalMutationError::goal_changed("Goal identity changed"))?;
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub(super) async fn transition_terminal(
        &self,
        goal_id: &str,
        status: GoalStatus,
        reason: Option<String>,
        actor: GoalTerminalActor,
    ) -> Result<GoalTerminalOutcome, GoalMutationError> {
        if actor == GoalTerminalActor::Model {
            return Err(GoalMutationError::stale_turn(
                "Model terminal update requires current turn authority",
            ));
        }
        self.transition_terminal_inner(goal_id, status, reason, actor, None)
            .await
    }

    pub async fn transition_terminal_authorized_from_sidecar(
        &self,
        goal_id: &str,
        status: GoalStatus,
        reason: Option<String>,
        queue_id: &str,
        session_id: &str,
        sidecar_generation: u64,
        sidecars: &ManagedSidecarManager,
    ) -> Result<GoalTerminalOutcome, GoalMutationError> {
        self.transition_terminal_inner(
            goal_id,
            status,
            reason,
            GoalTerminalActor::Model,
            Some((queue_id, session_id, sidecar_generation, sidecars)),
        )
        .await
    }

    async fn transition_terminal_inner(
        &self,
        goal_id: &str,
        status: GoalStatus,
        reason: Option<String>,
        actor: GoalTerminalActor,
        authority: Option<(&str, &str, u64, &ManagedSidecarManager)>,
    ) -> Result<GoalTerminalOutcome, GoalMutationError> {
        if !status.is_terminal() {
            return Err(GoalMutationError::goal("Goal terminal status is invalid"));
        }
        if actor == GoalTerminalActor::Model
            && !matches!(status, GoalStatus::Complete | GoalStatus::Blocked)
        {
            return Err(GoalMutationError::goal(
                "Model may only mark a Goal complete or blocked",
            ));
        }
        if actor == GoalTerminalActor::User && status != GoalStatus::Canceled {
            return Err(GoalMutationError::goal(
                "User Goal control may only cancel the Goal",
            ));
        }

        let reason_for_mutation = reason.clone();
        let now = Utc::now();
        let (updated, already_terminal, changed) = self
            .commit(goal_id, move |goal| {
                if goal.is_terminal() {
                    return Ok(true);
                }
                if actor == GoalTerminalActor::Model {
                    let Some((queue_id, session_id, generation, sidecars)) = authority else {
                        return Err(GoalMutationError::stale_turn(
                            "Goal turn authority is missing",
                        ));
                    };
                    if !sidecar_generation_is_current(sidecars, session_id, generation)? {
                        return Err(GoalMutationError::stale_turn(
                            "Model terminal update belongs to a previous Sidecar",
                        ));
                    }
                    let authority_matches = goal.current_turn.as_ref().is_some_and(|turn| {
                        turn.queue_id == queue_id
                            && turn.sidecar_generation == generation
                            && goal.session_id == session_id
                    });
                    if !authority_matches {
                        return Err(GoalMutationError::stale_turn(
                            "Goal turn authority is no longer current",
                        ));
                    }
                    if !goal.end_conditions.ai_can_exit {
                        return Err(GoalMutationError::goal(
                            "This Goal does not allow AI to end it",
                        ));
                    }
                }
                goal.status = status.clone();
                goal.terminal_reason = reason_for_mutation.clone();
                goal.updated_at = now;
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(false)
            })
            .await?;
        if already_terminal {
            return Ok(GoalTerminalOutcome::AlreadyTerminal(updated));
        }
        self.cancel_continuation(goal_id).await;
        if actor != GoalTerminalActor::System {
            self.cancel_deadline(goal_id).await;
        }
        if changed {
            self.emit_changed(&updated).await;
        }
        self.send_terminal_notification(&updated).await;
        Ok(GoalTerminalOutcome::Applied(updated))
    }

    async fn stop_goal_turn(
        &self,
        goal: &SessionGoal,
        queue_id: Option<&str>,
    ) -> Result<(), String> {
        #[cfg(test)]
        if let Some(hook) = self.stop_goal_turn_hook.read().await.clone() {
            return hook(goal, queue_id).await;
        }
        let app_handle = self
            .app_handle
            .read()
            .await
            .clone()
            .ok_or_else(|| "App handle is unavailable".to_string())?;
        let sidecars = app_handle
            .try_state::<ManagedSidecarManager>()
            .ok_or_else(|| "Sidecar manager is unavailable".to_string())?;
        let Some(port) =
            crate::sidecar::get_session_sidecar_port(sidecars.inner(), &goal.session_id)?
        else {
            return Ok(());
        };
        let client = crate::local_http::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|error| format!("create Goal stop client: {error}"))?;
        let response = client
            .post(format!("http://127.0.0.1:{port}/goal/stop"))
            .json(&serde_json::json!({
                "goalId": goal.id,
                "queueId": queue_id,
            }))
            .send()
            .await
            .map_err(|error| format!("request /goal/stop: {error}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("read /goal/stop response: {error}"))?;
        validate_stop_confirmation(status, &body)
    }

    pub(super) async fn confirm_current_turn_stopped(
        &self,
        goal_id: &str,
        queue_id: &str,
    ) -> Result<(), String> {
        let Some(goal) = self.get(goal_id).await.map_err(|error| error.to_string())? else {
            return Ok(());
        };
        validate_goal_stop_identity(&goal, queue_id)?;
        self.stop_goal_turn(&goal, Some(queue_id)).await
    }

    async fn send_terminal_notification(&self, goal: &SessionGoal) {
        if !goal.notify_enabled || !goal.is_terminal() {
            return;
        }
        let Some(app_handle) = self.app_handle.read().await.clone() else {
            return;
        };
        let title = match goal.status {
            GoalStatus::Complete => "目标已完成",
            GoalStatus::Blocked => "目标受阻",
            GoalStatus::Canceled => "目标已停止",
            _ => return,
        };
        let reason = goal
            .terminal_reason
            .as_deref()
            .unwrap_or("Goal has stopped.");
        let body = format!("{} · {}", goal.objective.trim(), reason);
        let session_id = goal.session_id.clone();
        let navigation = crate::notification::NotificationNavigation::for_session(
            None,
            session_id.clone(),
            goal.workspace_path.clone(),
        );
        let badge_increment = crate::notification_badge::NotificationBadgeIncrement {
            id: format!("goal:{}:{}:{}", goal.id, goal.turn_count, session_id),
            source: "goal".to_string(),
            created_at: Utc::now().timestamp_millis(),
            target: crate::notification_badge::NotificationBadgeTarget::Session {
                session_id,
                workspace_path: goal.workspace_path.clone(),
            },
        };
        crate::notification::show_with_navigation_target_and_badge(
            &app_handle,
            title,
            &body,
            navigation,
            Some(badge_increment),
        );
    }

    async fn flush_delivery_outbox_once(&self, goal_id: &str) -> Result<bool, String> {
        let goal = self.get(goal_id).await.map_err(|error| error.to_string())?;
        let Some(goal) = goal else {
            return Ok(true);
        };
        let Some(item) = goal.delivery_outbox.first().cloned() else {
            return Ok(true);
        };
        let delivery = if let Some(handle) = self.app_handle.read().await.clone() {
            let agents = handle.try_state::<crate::im::ManagedAgents>();
            let im_bots = handle.try_state::<crate::im::ManagedImBots>();
            crate::im::session_delivery::push_assistant_text_for_session(
                agents.as_deref(),
                im_bots.as_deref(),
                &goal.session_id,
                &item.text,
            )
            .await
        } else {
            Err("App handle is unavailable for Goal channel delivery".to_string())
        };
        if delivery != Ok(true) {
            return Ok(false);
        }
        let item_id = item.id;
        let now = Utc::now();
        let (updated, _, _) = self
            .commit(goal_id, move |goal| {
                goal.delivery_outbox.retain(|pending| pending.id != item_id);
                goal.updated_at = now;
                goal.bump_revision();
                Ok(())
            })
            .await
            .map_err(|error| error.to_string())?;
        self.emit_changed(&updated).await;
        Ok(updated.delivery_outbox.is_empty())
    }

    pub(super) async fn replay_delivery_outbox_until_empty(&self, goal_id: &str) {
        loop {
            match self.flush_delivery_outbox_once(goal_id).await {
                Ok(true) => return,
                Ok(false) => {}
                Err(error) => {
                    ulog_warn!("[Goal] Delivery replay failed for {}: {}", goal_id, error);
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    }

    pub async fn ensure_delivery_replay(&self, goal_id: &str) {
        let goal_id = goal_id.to_string();
        if !self
            .delivery_replayers
            .write()
            .await
            .insert(goal_id.clone())
        {
            return;
        }
        tauri::async_runtime::spawn(async move {
            let manager = get_session_goal_manager();
            manager.replay_delivery_outbox_until_empty(&goal_id).await;
            manager.delivery_replayers.write().await.remove(&goal_id);
            if manager
                .get(&goal_id)
                .await
                .ok()
                .flatten()
                .is_some_and(|goal| goal.status == GoalStatus::Active)
            {
                super::scheduler::request_continuation(goal_id.clone(), 0);
            }
        });
    }

    pub async fn startup_snapshot(&self) -> Result<Vec<SessionGoal>, GoalMutationError> {
        let state = self.state.read().await;
        Ok(state
            .ready()
            .map_err(GoalMutationError::store_corrupt)?
            .values()
            .cloned()
            .collect())
    }

    pub async fn revoke_turn_authorities_for_sidecar(
        &self,
        session_id: &str,
        sidecar_generation: u64,
    ) -> Result<usize, GoalMutationError> {
        let goal = self.get_for_session(session_id, None, true).await?;
        let Some(goal) = goal else {
            return Ok(0);
        };
        if goal
            .current_turn
            .as_ref()
            .is_none_or(|turn| turn.sidecar_generation != sidecar_generation)
        {
            return Ok(0);
        }
        self.abort_turn(&goal.id, &goal.current_turn.expect("checked").queue_id)
            .await?;
        Ok(1)
    }

    pub async fn reconcile_turn_authorities_with_live_sidecars(
        &self,
        sidecars: &ManagedSidecarManager,
    ) -> Result<usize, GoalMutationError> {
        let live = sidecars
            .lock()
            .map_err(|error| GoalMutationError::goal(format!("Sidecar lock poisoned: {error}")))?
            .live_sidecar_set();
        let goals = self.startup_snapshot().await?;
        let stale = goals
            .into_iter()
            .filter_map(|goal| {
                let turn = goal.current_turn?;
                (!live.contains(&(goal.session_id.clone(), turn.sidecar_generation)))
                    .then_some((goal.id, turn.queue_id))
            })
            .collect::<Vec<_>>();
        for (goal_id, queue_id) in &stale {
            self.abort_turn(goal_id, queue_id).await?;
        }
        Ok(stale.len())
    }

    pub(super) async fn emit_changed(&self, goal: &SessionGoal) {
        let Some(app_handle) = self.app_handle.read().await.clone() else {
            return;
        };
        let _ = app_handle.emit(
            "goal:changed",
            serde_json::json!({
                "goalId": goal.id,
                "sessionId": goal.session_id,
                "workspacePath": goal.workspace_path,
                "goalRevision": goal.revision,
                "goal": goal.view(),
            }),
        );
    }

    pub(super) async fn release_goal_owner(&self, goal: &SessionGoal) -> Result<bool, String> {
        #[cfg(test)]
        if let Some(hook) = self.release_goal_owner_hook.read().await.clone() {
            return hook(goal).await;
        }
        let Some(app_handle) = self.app_handle.read().await.clone() else {
            return Err(
                "Goal owner release is unavailable before AppHandle initialization".to_string(),
            );
        };
        let Some(sidecars) = app_handle.try_state::<ManagedSidecarManager>() else {
            return Err("Sidecar manager is unavailable".to_string());
        };
        let stopped = release_session_sidecar(
            sidecars.inner(),
            &goal.session_id,
            &SidecarOwner::Goal(goal.id.clone()),
        )
        .await?;
        ulog_info!(
            "[Goal] Released owner {} from Session {} (sidecar_stopped={})",
            goal.id,
            goal.session_id,
            stopped
        );
        Ok(stopped)
    }

    pub(super) async fn cancel_continuation(&self, goal_id: &str) {
        if let Some(handle) = self.continuation_handles.write().await.remove(goal_id) {
            handle.abort();
        }
    }

    pub(super) async fn cancel_deadline(&self, goal_id: &str) {
        if let Some(handle) = self.deadline_handles.write().await.remove(goal_id) {
            handle.abort();
        }
    }
}

pub(super) fn end_condition_reason(goal: &SessionGoal, now: DateTime<Utc>) -> Option<&'static str> {
    if goal
        .end_conditions
        .deadline
        .is_some_and(|deadline| deadline <= now)
    {
        return Some("Goal deadline reached");
    }
    if goal
        .end_conditions
        .max_executions
        .is_some_and(|max| goal.turn_count >= max)
    {
        return Some("Goal maximum executions reached");
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum GoalEndConditionStopSource {
    BoundaryCheck,
    DeadlineWatchdog,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GoalStopSettlement {
    SingleAttempt,
    RetryUntilConfirmed,
}

fn sidecar_generation_is_current(
    sidecars: &ManagedSidecarManager,
    session_id: &str,
    expected_generation: u64,
) -> Result<bool, GoalMutationError> {
    let current = sidecars
        .lock()
        .map_err(|error| GoalMutationError::goal(format!("Sidecar lock poisoned: {error}")))?
        .generation_for(session_id);
    Ok(current == Some(expected_generation))
}

fn truncate_delivery_text(text: &str) -> String {
    const MAX_BYTES: usize = 64 * 1024;
    if text.len() <= MAX_BYTES {
        return text.to_string();
    }
    let mut end = MAX_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

// Runtime owns context repair and its bounded attempts. These structured outcomes
// mean a new unchanged Goal turn cannot make progress; preserve the Goal for an
// explicit user resume instead of converting a runtime fault into a Goal terminal.
fn recovery_pause_reason(code: Option<&str>, error: Option<&str>) -> Option<String> {
    let code = code.filter(|code| {
        matches!(
            *code,
            "context_recovery_required"
                | "compaction_failed"
                | "provider_invalid_request"
                | "automatic_replay_blocked"
        )
    })?;
    Some(match error.filter(|error| !error.trim().is_empty()) {
        Some(error) => format!("Goal paused for recovery ({code}): {error}"),
        None => format!("Goal paused for recovery ({code})"),
    })
}

pub(super) fn failure_backoff(failures: u32) -> u64 {
    match failures {
        0 | 1 => 3,
        2 => 10,
        3 => 30,
        4 => 60,
        5 => 120,
        _ => 300,
    }
}

fn validate_stop_confirmation(status: reqwest::StatusCode, body: &str) -> Result<(), String> {
    if !status.is_success() {
        return Err(format!("/goal/stop returned HTTP {status}: {body}"));
    }
    let payload: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| format!("parse /goal/stop response: {error}"))?;
    if payload.get("success").and_then(serde_json::Value::as_bool) == Some(true)
        || payload
            .get("alreadyStopped")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    {
        return Ok(());
    }
    Err(payload
        .get("error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("SessionEngine did not confirm the Goal-scoped stop")
        .to_string())
}

fn validate_goal_stop_identity(goal: &SessionGoal, queue_id: &str) -> Result<(), String> {
    if goal
        .current_turn
        .as_ref()
        .is_some_and(|current| current.queue_id != queue_id)
    {
        return Err("Goal turn identity changed before stop confirmation".to_string());
    }
    Ok(())
}

impl Default for SessionGoalManager {
    fn default() -> Self {
        Self::new()
    }
}

static SESSION_GOAL_MANAGER: std::sync::OnceLock<SessionGoalManager> = std::sync::OnceLock::new();

pub fn get_session_goal_manager() -> &'static SessionGoalManager {
    SESSION_GOAL_MANAGER.get_or_init(SessionGoalManager::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::types::{SessionSidecar, SidecarState};
    use crate::sidecar::SidecarManager;
    use std::process::Stdio;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Barrier, Mutex,
    };
    use std::time::Instant;

    fn config(session_id: &str, objective: &str) -> SessionGoalConfig {
        SessionGoalConfig {
            workspace_path: "/tmp/workspace".to_string(),
            session_id: session_id.to_string(),
            objective: objective.to_string(),
            end_conditions: Default::default(),
            notify_enabled: false,
            permission_mode: String::new(),
        }
    }

    fn live_test_sidecar(session_id: &str, goal_id: &str) -> (ManagedSidecarManager, u64) {
        live_test_sidecar_at_port(session_id, goal_id, 31_418)
    }

    fn live_test_sidecar_at_port(
        session_id: &str,
        goal_id: &str,
        port: u16,
    ) -> (ManagedSidecarManager, u64) {
        #[cfg(windows)]
        let mut command = {
            let mut command = crate::process_cmd::new("cmd");
            command.args(["/C", "exit", "0"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = crate::process_cmd::new("true");

        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut process =
            crate::process_cmd::spawn_tree(&mut command).expect("spawn test sidecar placeholder");
        process.wait().expect("reap test sidecar placeholder");
        let mut manager = SidecarManager::new();
        manager.insert_sidecar(
            session_id,
            SessionSidecar {
                process,
                port,
                session_id: session_id.to_string(),
                management_id: session_id.to_string(),
                workspace_path: PathBuf::from("/tmp/workspace"),
                state: SidecarState::Healthy,
                owners: HashSet::from([SidecarOwner::Goal(goal_id.to_string())]),
                completion_claims: HashSet::new(),
                dispatch_gate: crate::sidecar::types::DispatchGate::new(),
                created_at: Instant::now(),
                runtime: None,
                runtime_source: None,
            },
        );
        let generation = manager
            .generation_for(session_id)
            .expect("test sidecar generation");
        (Arc::new(Mutex::new(manager)), generation)
    }

    fn successful_finalization(
        duration_ms: u64,
        consumed_tokens: u64,
    ) -> GoalTurnFinalizationRequest {
        GoalTurnFinalizationRequest {
            success: true,
            code: None,
            error: None,
            output_text: Some("done".to_string()),
            duration_ms,
            consumed_tokens,
            channel_delivery_expected: false,
        }
    }

    fn recovery_failure(code: &str) -> GoalTurnFinalizationRequest {
        GoalTurnFinalizationRequest {
            success: false,
            code: Some(code.to_string()),
            error: Some("Runtime context needs repair".to_string()),
            output_text: None,
            duration_ms: 123,
            consumed_tokens: 456,
            channel_delivery_expected: false,
        }
    }

    #[tokio::test]
    async fn recovery_failure_pauses_same_goal_durably_and_resumes_without_losing_progress() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("goals.json");
        let manager = SessionGoalManager::with_storage_path(path.clone());
        let goal = manager
            .create_goal(config("session-1", "keep shipping"))
            .await
            .unwrap();
        let (sidecars, generation) = live_test_sidecar("session-1", &goal.id);
        manager
            .claim_turn_from_sidecar(
                &goal.id,
                "recovery-queue",
                GoalTurnKind::Continuation,
                goal.control_revision,
                "session-1",
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        let settled = manager
            .finalize_turn_from_sidecar(
                &goal.id,
                "recovery-queue",
                recovery_failure("context_recovery_required"),
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        assert!(settled.applied);
        assert_eq!(settled.goal.id, goal.id);
        assert_eq!(settled.goal.objective, goal.objective);
        assert_eq!(settled.goal.status, GoalStatus::Paused);
        assert!(!settled.goal.is_terminal());
        assert_eq!(settled.goal.turn_count, 1);
        assert_eq!(settled.goal.total_tokens, 456);
        assert_eq!(settled.goal.total_duration_ms, 123);
        assert_eq!(settled.goal.consecutive_failures, 0);
        assert!(settled.goal.control_revision > goal.control_revision);
        assert!(settled
            .goal
            .terminal_reason
            .as_deref()
            .unwrap()
            .contains("context_recovery_required"));
        assert!(manager.continuation_handles.read().await.is_empty());
        assert_eq!(
            manager
                .prepare_continuation(&goal.id)
                .await
                .unwrap_err()
                .code(),
            "turn_conflict"
        );
        let duplicate = manager
            .finalize_turn_from_sidecar(
                &goal.id,
                "recovery-queue",
                recovery_failure("context_recovery_required"),
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        assert!(!duplicate.applied);
        assert_eq!(duplicate.goal, settled.goal);

        let reloaded = SessionGoalManager::with_storage_path(path);
        let stored = reloaded.get(&goal.id).await.unwrap().unwrap();
        assert_eq!(stored, settled.goal);
        *reloaded.stop_goal_turn_hook.write().await =
            Some(Arc::new(|_, _| Box::pin(async { Ok(()) })));
        *reloaded.release_goal_owner_hook.write().await =
            Some(Arc::new(|_| Box::pin(async { Ok(true) })));
        // Suppress the production scheduler in this isolated owner test.
        let continuation = tauri::async_runtime::spawn(std::future::pending::<()>());
        reloaded
            .continuation_handles
            .write()
            .await
            .insert(goal.id.clone(), continuation);
        let resumed = reloaded.resume_goal(&goal.id).await.unwrap();
        reloaded.cancel_continuation(&goal.id).await;
        assert_eq!(resumed.id, goal.id);
        assert_eq!(resumed.objective, goal.objective);
        assert_eq!(resumed.status, GoalStatus::Active);
        assert_eq!(resumed.turn_count, 1);
        assert_eq!(resumed.total_tokens, 456);
        assert!(resumed.terminal_reason.is_none());
        assert!(resumed.control_revision > stored.control_revision);
    }

    #[tokio::test]
    async fn structured_dispatch_failures_pause_without_generic_retry_or_text_parsing() {
        for code in [
            "context_recovery_required",
            "compaction_failed",
            "provider_invalid_request",
            "automatic_replay_blocked",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
            let goal = manager
                .create_goal(config("session-1", "work"))
                .await
                .unwrap();
            let paused = manager
                .record_dispatch_failure(
                    &goal.id,
                    goal.control_revision,
                    Some(code.to_string()),
                    Some("failed".to_string()),
                )
                .await
                .unwrap();
            assert_eq!(paused.id, goal.id);
            assert_eq!(paused.status, GoalStatus::Paused);
            assert_eq!(paused.turn_count, 0);
            assert_eq!(paused.consecutive_failures, 0);
            assert!(manager.continuation_handles.read().await.is_empty());
            assert_eq!(
                manager
                    .record_dispatch_failure(
                        &goal.id,
                        goal.control_revision,
                        Some(code.to_string()),
                        None,
                    )
                    .await
                    .unwrap(),
                paused
            );
        }
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        for attempt in 1..=10 {
            let failure = manager
                .record_dispatch_failure(
                    &goal.id,
                    goal.control_revision,
                    None,
                    Some("context_recovery_required".to_string()),
                )
                .await
                .unwrap();
            assert_eq!(failure.consecutive_failures, attempt);
            assert_eq!(
                failure.status,
                if attempt == 10 {
                    GoalStatus::Blocked
                } else {
                    GoalStatus::Active
                }
            );
        }
    }

    #[tokio::test]
    async fn recovery_terminal_cannot_override_newer_control_or_stale_generation() {
        for (status, stale_generation) in [
            (GoalStatus::Paused, false),
            (GoalStatus::Canceled, false),
            (GoalStatus::Complete, true),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
            let goal = manager
                .create_goal(config("session-1", "work"))
                .await
                .unwrap();
            let (sidecars, generation) = live_test_sidecar("session-1", &goal.id);
            manager
                .claim_turn_from_sidecar(
                    &goal.id,
                    "old-queue",
                    GoalTurnKind::Continuation,
                    goal.control_revision,
                    "session-1",
                    generation,
                    &sidecars,
                )
                .await
                .unwrap();
            manager
                .commit(&goal.id, |goal| {
                    goal.status = status.clone();
                    goal.terminal_reason = Some("newer control reason".to_string());
                    goal.bump_control_revision();
                    goal.bump_revision();
                    Ok(())
                })
                .await
                .unwrap();
            let callback_generation = if stale_generation {
                generation + 1
            } else {
                generation
            };
            let settled = manager
                .finalize_turn_from_sidecar(
                    &goal.id,
                    "old-queue",
                    recovery_failure("compaction_failed"),
                    callback_generation,
                    &sidecars,
                )
                .await
                .unwrap();
            assert!(!settled.applied);
            assert_eq!(settled.goal.status, status);
            assert_eq!(
                settled.goal.terminal_reason.as_deref(),
                Some("newer control reason")
            );
            assert_eq!(settled.goal.turn_count, 0);
            assert_eq!(settled.goal.total_tokens, 0);
            assert!(settled.goal.current_turn.is_none());
        }
    }

    #[tokio::test]
    async fn current_goal_replaces_terminal_history_for_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let first = manager
            .create_goal(config("session-1", "first"))
            .await
            .unwrap();
        manager
            .transition_terminal(
                &first.id,
                GoalStatus::Canceled,
                None,
                GoalTerminalActor::User,
            )
            .await
            .unwrap();
        let second = manager
            .create_goal(config("session-1", "second"))
            .await
            .unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(
            manager
                .get_for_session("session-1", None, true)
                .await
                .unwrap()
                .unwrap()
                .id,
            second.id
        );
        assert!(manager.get(&first.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn terminal_goal_with_unsettled_turn_cannot_be_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let first = manager
            .create_goal(config("session-1", "first"))
            .await
            .unwrap();
        manager
            .commit(&first.id, |goal| {
                goal.status = GoalStatus::Complete;
                goal.current_turn = Some(GoalTurnAuthority {
                    queue_id: "queue-1".to_string(),
                    kind: GoalTurnKind::UserQuery,
                    turn_number: 1,
                    sidecar_generation: 1,
                    created_at: Utc::now(),
                });
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(())
            })
            .await
            .unwrap();

        let error = manager
            .create_goal(config("session-1", "second"))
            .await
            .expect_err("the old turn must settle before its Goal is replaced");
        assert_eq!(error.code(), "turn_conflict");
    }

    #[tokio::test]
    async fn terminal_turn_metrics_are_accumulated_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        let (sidecars, generation) = live_test_sidecar("session-1", &goal.id);
        manager
            .commit(&goal.id, |goal| {
                goal.status = GoalStatus::Complete;
                goal.current_turn = Some(GoalTurnAuthority {
                    queue_id: "queue-1".to_string(),
                    kind: GoalTurnKind::UserQuery,
                    turn_number: 1,
                    sidecar_generation: generation,
                    created_at: Utc::now(),
                });
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(())
            })
            .await
            .unwrap();

        let first = manager
            .finalize_turn_from_sidecar(
                &goal.id,
                "queue-1",
                successful_finalization(12_345, 678),
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        assert!(first.applied);
        assert_eq!(first.goal.status, GoalStatus::Complete);
        assert!(first.goal.current_turn.is_none());
        assert_eq!(first.goal.total_duration_ms, 12_345);
        assert_eq!(first.goal.total_tokens, 678);

        let retry = manager
            .finalize_turn_from_sidecar(
                &goal.id,
                "queue-1",
                successful_finalization(12_345, 678),
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        assert!(!retry.applied);
        assert_eq!(retry.goal.total_duration_ms, 12_345);
        assert_eq!(retry.goal.total_tokens, 678);
    }

    #[tokio::test]
    async fn consecutive_claims_finalize_as_distinct_durable_turns() {
        let dir = tempfile::tempdir().unwrap();
        let storage_path = dir.path().join("goals.json");
        let manager = SessionGoalManager::with_storage_path(storage_path.clone());
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        let (sidecars, generation) = live_test_sidecar("session-1", &goal.id);

        let (first_claim, first_authority) = manager
            .claim_turn_from_sidecar(
                &goal.id,
                "queue-1",
                GoalTurnKind::UserQuery,
                goal.control_revision,
                "session-1",
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        assert_eq!(first_claim.view().turn_count, 0);
        assert_eq!(first_claim.view().execution_number, Some(1));
        assert_eq!(first_authority.turn_number, 1);

        let first_settled = manager
            .finalize_turn_from_sidecar(
                &goal.id,
                "queue-1",
                successful_finalization(100, 10),
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        assert!(first_settled.applied);
        assert_eq!(first_settled.goal.id, goal.id);
        assert_eq!(first_settled.goal.objective, goal.objective);
        assert_eq!(first_settled.goal.view().turn_count, 1);
        assert_eq!(first_settled.goal.view().execution_number, None);

        let (second_claim, second_authority) = manager
            .claim_turn_from_sidecar(
                &goal.id,
                "queue-2",
                GoalTurnKind::Continuation,
                first_settled.goal.control_revision,
                "session-1",
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        assert_eq!(second_claim.view().turn_count, 1);
        assert_eq!(second_claim.view().execution_number, Some(2));
        assert_eq!(second_authority.turn_number, 2);

        let second_settled = manager
            .finalize_turn_from_sidecar(
                &goal.id,
                "queue-2",
                successful_finalization(200, 20),
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        assert!(second_settled.applied);
        assert_eq!(second_settled.goal.id, goal.id);
        assert_eq!(second_settled.goal.objective, goal.objective);
        assert_eq!(second_settled.goal.turn_count, 2);
        assert!(second_settled.goal.current_turn.is_none());
        assert_eq!(second_settled.goal.total_duration_ms, 300);
        assert_eq!(second_settled.goal.total_tokens, 30);

        let reloaded = SessionGoalManager::with_storage_path(storage_path);
        let persisted = reloaded
            .get_for_session("session-1", Some("/tmp/workspace"), true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted.id, goal.id);
        assert_eq!(persisted.objective, goal.objective);
        assert_eq!(persisted.turn_count, 2);
        assert!(persisted.current_turn.is_none());
    }

    #[tokio::test]
    async fn create_goal_rejects_zero_max_executions() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let mut invalid = config("session-1", "work");
        invalid.end_conditions.max_executions = Some(0);

        let error = manager.create_goal(invalid).await.unwrap_err();

        assert_eq!(error.code(), "goal_error");
        assert!(error
            .to_string()
            .contains("endConditions.maxExecutions must be at least 1"));
    }

    #[tokio::test]
    async fn max_executions_cannot_be_bypassed_by_a_competing_claim() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let mut limited = config("session-1", "work");
        limited.end_conditions.max_executions = Some(1);
        let goal = manager.create_goal(limited).await.unwrap();
        let (sidecars, generation) = live_test_sidecar("session-1", &goal.id);

        manager
            .claim_turn_from_sidecar(
                &goal.id,
                "queue-1",
                GoalTurnKind::UserQuery,
                goal.control_revision,
                "session-1",
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        let settled = manager
            .finalize_turn_from_sidecar(
                &goal.id,
                "queue-1",
                successful_finalization(100, 10),
                generation,
                &sidecars,
            )
            .await
            .unwrap()
            .goal;

        let error = manager
            .claim_turn_from_sidecar(
                &goal.id,
                "queue-2",
                GoalTurnKind::UserQuery,
                settled.control_revision,
                "session-1",
                generation,
                &sidecars,
            )
            .await
            .expect_err("the second turn must lose to the durable max-executions boundary");

        assert_eq!(error.code(), "terminal");
        let stopped = manager.get(&goal.id).await.unwrap().unwrap();
        assert_eq!(stopped.status, GoalStatus::Canceled);
        assert_eq!(stopped.turn_count, 1);
        assert_eq!(
            stopped
                .current_turn
                .as_ref()
                .map(|turn| turn.queue_id.as_str()),
            Some("queue-2")
        );
        assert_eq!(
            stopped.terminal_reason.as_deref(),
            Some("Goal maximum executions reached")
        );
        assert!(stopped.protects_session_identity());

        let release_error = manager
            .abort_turn(&goal.id, "queue-2")
            .await
            .expect_err("missing AppHandle must not be treated as confirmed owner release");
        assert!(release_error
            .to_string()
            .contains("AppHandle initialization"));
        let still_protected = manager.get(&goal.id).await.unwrap().unwrap();
        assert_eq!(
            still_protected
                .current_turn
                .as_ref()
                .map(|turn| turn.queue_id.as_str()),
            Some("queue-2")
        );
        assert!(sidecars
            .lock()
            .unwrap()
            .session_has_persistent_owners("session-1"));

        let sidecars_for_release = sidecars.clone();
        *manager.release_goal_owner_hook.write().await = Some(Arc::new(move |goal| {
            let sidecars = sidecars_for_release.clone();
            let session_id = goal.session_id.clone();
            let owner = SidecarOwner::Goal(goal.id.clone());
            Box::pin(async move { release_session_sidecar(&sidecars, &session_id, &owner).await })
        }));
        let settled = manager.abort_turn(&goal.id, "queue-2").await.unwrap();
        assert!(settled.current_turn.is_none());
        assert!(!sidecars
            .lock()
            .unwrap()
            .session_has_persistent_owners("session-1"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn abort_settlement_serializes_before_a_new_turn_reclaims_the_goal_owner() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        let (sidecars, generation) = live_test_sidecar("session-1", &goal.id);
        sidecars.lock().unwrap().add_session_owner(
            "session-1",
            SidecarOwner::Tab("tab-keeps-sidecar-live".to_string()),
        );
        manager
            .commit(&goal.id, |goal| {
                goal.status = GoalStatus::Paused;
                goal.current_turn = Some(GoalTurnAuthority {
                    queue_id: "queue-1".to_string(),
                    kind: GoalTurnKind::UserQuery,
                    turn_number: 1,
                    sidecar_generation: generation,
                    created_at: Utc::now(),
                });
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(())
            })
            .await
            .unwrap();
        *manager.stop_goal_turn_hook.write().await =
            Some(Arc::new(|_, _| Box::pin(async { Ok(()) })));

        let first_release_entered = Arc::new(Barrier::new(2));
        let allow_first_release = Arc::new(Barrier::new(2));
        let release_calls = Arc::new(AtomicUsize::new(0));
        let sidecars_for_release = sidecars.clone();
        let entered_for_hook = Arc::clone(&first_release_entered);
        let allow_for_hook = Arc::clone(&allow_first_release);
        let calls_for_hook = Arc::clone(&release_calls);
        *manager.release_goal_owner_hook.write().await = Some(Arc::new(move |goal| {
            if calls_for_hook.fetch_add(1, Ordering::SeqCst) == 0 {
                entered_for_hook.wait();
                allow_for_hook.wait();
            }
            let sidecars = sidecars_for_release.clone();
            let session_id = goal.session_id.clone();
            let owner = SidecarOwner::Goal(goal.id.clone());
            Box::pin(async move { release_session_sidecar(&sidecars, &session_id, &owner).await })
        }));

        let manager_for_first_abort = manager.clone();
        let goal_id_for_first_abort = goal.id.clone();
        let first_abort = tauri::async_runtime::spawn(async move {
            manager_for_first_abort
                .abort_turn(&goal_id_for_first_abort, "queue-1")
                .await
        });
        first_release_entered.wait();

        let manager_for_reclaim = manager.clone();
        let goal_id_for_reclaim = goal.id.clone();
        let sidecars_for_reclaim = sidecars.clone();
        let reclaim_crossed_settlement = Arc::new(AtomicBool::new(false));
        let reclaim_crossed_settlement_for_task = Arc::clone(&reclaim_crossed_settlement);
        let reclaim = tauri::async_runtime::spawn(async move {
            manager_for_reclaim
                .abort_turn(&goal_id_for_reclaim, "queue-1")
                .await?;
            reclaim_crossed_settlement_for_task.store(true, Ordering::SeqCst);
            let resumed = manager_for_reclaim
                .resume_goal(&goal_id_for_reclaim)
                .await?;
            manager_for_reclaim
                .claim_turn_from_sidecar(
                    &goal_id_for_reclaim,
                    "queue-2",
                    GoalTurnKind::UserQuery,
                    resumed.control_revision,
                    "session-1",
                    generation,
                    &sidecars_for_reclaim,
                )
                .await?;
            Ok::<(), GoalMutationError>(())
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            !reclaim_crossed_settlement.load(Ordering::SeqCst),
            "new turn must wait for the prior abort settlement lifecycle"
        );

        allow_first_release.wait();
        first_abort.await.unwrap().unwrap();
        reclaim.await.unwrap().unwrap();

        let reclaimed = manager.get(&goal.id).await.unwrap().unwrap();
        assert_eq!(
            reclaimed
                .current_turn
                .as_ref()
                .map(|turn| turn.queue_id.as_str()),
            Some("queue-2")
        );
        assert!(sidecars
            .lock()
            .unwrap()
            .session_has_persistent_owners("session-1"));
        assert!(release_calls.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn end_condition_stop_allows_sidecar_abort_settlement_to_reenter_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        let (sidecars, generation) = live_test_sidecar("session-1", &goal.id);
        let sidecars_for_release = sidecars.clone();
        *manager.release_goal_owner_hook.write().await = Some(Arc::new(move |goal| {
            let sidecars = sidecars_for_release.clone();
            let session_id = goal.session_id.clone();
            let owner = SidecarOwner::Goal(goal.id.clone());
            Box::pin(async move { release_session_sidecar(&sidecars, &session_id, &owner).await })
        }));

        manager
            .claim_turn_from_sidecar(
                &goal.id,
                "queue-end-condition",
                GoalTurnKind::UserQuery,
                goal.control_revision,
                "session-1",
                generation,
                &sidecars,
            )
            .await
            .unwrap();

        let manager_for_stop = manager.clone();
        let goal_id_for_stop = goal.id.clone();
        *manager.stop_goal_turn_hook.write().await = Some(Arc::new(move |_goal, queue_id| {
            let manager = manager_for_stop.clone();
            let goal_id = goal_id_for_stop.clone();
            let queue_id = queue_id
                .expect("claimed turn must stop exactly")
                .to_string();
            Box::pin(async move {
                manager
                    .abort_turn(&goal_id, &queue_id)
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
        }));

        let stopped = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            manager.stop_goal_for_end_condition(
                &goal.id,
                "Goal maximum executions reached".to_string(),
                GoalEndConditionStopSource::BoundaryCheck,
            ),
        )
        .await
        .expect("Sidecar abort settlement must not deadlock the Session lifecycle")
        .unwrap();

        assert_eq!(stopped.status, GoalStatus::Canceled);
        assert!(stopped.current_turn.is_none());
        assert!(!sidecars
            .lock()
            .unwrap()
            .session_has_persistent_owners("session-1"));
    }

    #[tokio::test]
    async fn deadline_watchdog_terminalizes_an_in_flight_turn() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        let (sidecars, generation) = live_test_sidecar("session-1", &goal.id);
        let stopped_queues = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
        let stopped_queues_for_hook = Arc::clone(&stopped_queues);
        *manager.stop_goal_turn_hook.write().await = Some(Arc::new(move |_goal, queue_id| {
            let queue_id = queue_id.map(str::to_string);
            let stopped_queues = Arc::clone(&stopped_queues_for_hook);
            Box::pin(async move {
                stopped_queues.lock().unwrap().push(queue_id);
                Ok(())
            })
        }));
        let sidecars_for_release = sidecars.clone();
        *manager.release_goal_owner_hook.write().await = Some(Arc::new(move |goal| {
            let sidecars = sidecars_for_release.clone();
            let session_id = goal.session_id.clone();
            let owner = SidecarOwner::Goal(goal.id.clone());
            Box::pin(async move { release_session_sidecar(&sidecars, &session_id, &owner).await })
        }));

        manager
            .claim_turn_from_sidecar(
                &goal.id,
                "queue-deadline",
                GoalTurnKind::UserQuery,
                goal.control_revision,
                "session-1",
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        manager
            .commit(&goal.id, |goal| {
                goal.end_conditions.deadline =
                    Some(Utc::now() + chrono::Duration::milliseconds(50));
                goal.bump_revision();
                Ok(())
            })
            .await
            .unwrap();
        manager.ensure_deadline(&goal.id).await;

        let stopped = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let current = manager.get(&goal.id).await.unwrap().unwrap();
                if current.status == GoalStatus::Canceled && current.current_turn.is_none() {
                    break current;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("deadline watchdog should durably terminalize the Goal");

        assert_eq!(
            stopped.terminal_reason.as_deref(),
            Some("Goal deadline reached")
        );
        assert!(stopped.current_turn.is_none());
        assert_eq!(
            stopped_queues.lock().unwrap().as_slice(),
            &[Some("queue-deadline".to_string())]
        );
        assert!(!sidecars
            .lock()
            .unwrap()
            .session_has_persistent_owners("session-1"));
    }

    #[tokio::test]
    async fn stale_sidecar_finalize_clears_authority_without_counting_metrics() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        let (sidecars, generation) = live_test_sidecar("session-1", &goal.id);
        manager
            .commit(&goal.id, |goal| {
                goal.status = GoalStatus::Complete;
                goal.current_turn = Some(GoalTurnAuthority {
                    queue_id: "queue-stale".to_string(),
                    kind: GoalTurnKind::Continuation,
                    turn_number: 1,
                    sidecar_generation: generation,
                    created_at: Utc::now(),
                });
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(())
            })
            .await
            .unwrap();

        let stale = manager
            .finalize_turn_from_sidecar(
                &goal.id,
                "queue-stale",
                successful_finalization(9_999, 999),
                generation.saturating_add(1),
                &sidecars,
            )
            .await
            .unwrap();

        assert!(!stale.applied);
        assert!(stale.goal.current_turn.is_none());
        assert_eq!(stale.goal.total_duration_ms, 0);
        assert_eq!(stale.goal.total_tokens, 0);
    }

    #[tokio::test]
    async fn stale_control_epoch_cannot_claim_after_pause() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        let paused = manager.pause_goal(&goal.id).await.unwrap();
        assert!(paused.control_revision > goal.control_revision);
    }

    #[tokio::test]
    async fn pause_keeps_exact_turn_authority_until_stop_settlement() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        *manager.release_goal_owner_hook.write().await =
            Some(Arc::new(|_| Box::pin(async { Ok(false) })));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        manager
            .commit(&goal.id, |goal| {
                goal.current_turn = Some(GoalTurnAuthority {
                    queue_id: "queue-1".to_string(),
                    kind: GoalTurnKind::UserQuery,
                    turn_number: 1,
                    sidecar_generation: 1,
                    created_at: Utc::now(),
                });
                goal.bump_revision();
                Ok(())
            })
            .await
            .unwrap();

        let paused = manager.pause_goal(&goal.id).await.unwrap();
        assert_eq!(paused.status, GoalStatus::Paused);
        assert_eq!(
            paused
                .current_turn
                .as_ref()
                .map(|turn| turn.queue_id.as_str()),
            Some("queue-1")
        );
        assert_eq!(
            manager
                .resume_goal(&goal.id)
                .await
                .expect_err("unsettled turn must block resume")
                .code(),
            "turn_conflict"
        );

        let settled = manager.abort_turn(&goal.id, "queue-1").await.unwrap();
        assert!(settled.current_turn.is_none());
    }

    #[tokio::test]
    async fn sidecar_stop_can_pause_a_preclaim_promotion() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        let (sidecars, generation) = live_test_sidecar("session-1", &goal.id);

        let paused = manager
            .pause_turn_from_sidecar(
                &goal.id,
                "preclaim-queue",
                "session-1",
                generation,
                &sidecars,
            )
            .await
            .unwrap();

        assert_eq!(paused.status, GoalStatus::Paused);
        assert!(paused.current_turn.is_none());
        assert!(paused.control_revision > goal.control_revision);
    }

    #[tokio::test]
    async fn preclaim_termination_uses_the_exact_queue_stop_identity() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();

        assert!(goal.current_turn.is_none());
        assert!(validate_goal_stop_identity(&goal, "preclaim-queue").is_ok());

        let mut conflicting = goal;
        conflicting.current_turn = Some(GoalTurnAuthority {
            queue_id: "newer-queue".to_string(),
            kind: GoalTurnKind::Continuation,
            turn_number: 1,
            sidecar_generation: 1,
            created_at: Utc::now(),
        });
        assert!(validate_goal_stop_identity(&conflicting, "preclaim-queue").is_err());
    }

    #[tokio::test]
    async fn user_cancel_keeps_exact_turn_authority_until_stop_settlement() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        *manager.release_goal_owner_hook.write().await =
            Some(Arc::new(|_| Box::pin(async { Ok(false) })));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        manager
            .commit(&goal.id, |goal| {
                goal.current_turn = Some(GoalTurnAuthority {
                    queue_id: "queue-1".to_string(),
                    kind: GoalTurnKind::UserQuery,
                    turn_number: 1,
                    sidecar_generation: 1,
                    created_at: Utc::now(),
                });
                goal.bump_revision();
                Ok(())
            })
            .await
            .unwrap();

        let canceled = manager
            .transition_terminal(
                &goal.id,
                GoalStatus::Canceled,
                Some("user stop".to_string()),
                GoalTerminalActor::User,
            )
            .await
            .unwrap()
            .goal()
            .clone();
        assert_eq!(canceled.status, GoalStatus::Canceled);
        assert_eq!(
            canceled
                .current_turn
                .as_ref()
                .map(|turn| turn.queue_id.as_str()),
            Some("queue-1")
        );

        let settled = manager.abort_turn(&goal.id, "queue-1").await.unwrap();
        assert!(settled.current_turn.is_none());
    }

    #[tokio::test]
    async fn paused_turn_terminal_callback_only_settles_authority() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        let (sidecars, generation) = live_test_sidecar("session-1", &goal.id);
        manager
            .commit(&goal.id, |goal| {
                goal.status = GoalStatus::Paused;
                goal.current_turn = Some(GoalTurnAuthority {
                    queue_id: "queue-1".to_string(),
                    kind: GoalTurnKind::UserQuery,
                    turn_number: 1,
                    sidecar_generation: generation,
                    created_at: Utc::now(),
                });
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(())
            })
            .await
            .unwrap();

        let settled = manager
            .finalize_turn_from_sidecar(
                &goal.id,
                "queue-1",
                GoalTurnFinalizationRequest {
                    success: false,
                    code: None,
                    error: Some("Execution stopped".to_string()),
                    output_text: None,
                    duration_ms: 123,
                    consumed_tokens: 456,
                    channel_delivery_expected: false,
                },
                generation,
                &sidecars,
            )
            .await
            .unwrap();
        assert!(!settled.applied);
        assert!(settled.goal.current_turn.is_none());
        assert_eq!(settled.goal.turn_count, 0);
        assert_eq!(settled.goal.total_duration_ms, 0);
        assert_eq!(settled.goal.total_tokens, 0);
    }

    #[tokio::test]
    async fn desktop_goal_waits_paused_for_its_first_user_turn() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));

        let goal = manager
            .create_goal_waiting_for_turn(config("session-1", "work"))
            .await
            .unwrap();

        assert_eq!(goal.status, GoalStatus::Paused);
        assert_eq!(goal.turn_count, 0);
        assert!(goal.current_turn.is_none());
    }

    #[tokio::test]
    async fn late_user_cancel_does_not_stop_a_completed_winning_turn() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "work"))
            .await
            .unwrap();
        manager
            .commit(&goal.id, |goal| {
                goal.status = GoalStatus::Complete;
                goal.current_turn = Some(GoalTurnAuthority {
                    queue_id: "queue-1".to_string(),
                    kind: GoalTurnKind::UserQuery,
                    turn_number: 1,
                    sidecar_generation: 1,
                    created_at: Utc::now(),
                });
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(())
            })
            .await
            .unwrap();

        let winner = manager
            .cancel_goal_and_stop(&goal.id, Some("late cancel".to_string()))
            .await
            .unwrap();

        assert_eq!(winner.status, GoalStatus::Complete);
        assert_eq!(winner.current_turn.unwrap().queue_id, "queue-1");
    }

    #[tokio::test]
    async fn objective_update_pauses_when_previous_turn_stop_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionGoalManager::with_storage_path(dir.path().join("goals.json"));
        let goal = manager
            .create_goal(config("session-1", "old objective"))
            .await
            .unwrap();
        let (claimed, _, _) = manager
            .commit(&goal.id, |goal| {
                goal.current_turn = Some(GoalTurnAuthority {
                    queue_id: "queue-1".to_string(),
                    kind: GoalTurnKind::UserQuery,
                    turn_number: 1,
                    sidecar_generation: 1,
                    created_at: Utc::now(),
                });
                goal.bump_revision();
                Ok(())
            })
            .await
            .unwrap();

        let updated = manager
            .update_objective_cas(
                &goal.id,
                "new objective".to_string(),
                Some(claimed.revision),
            )
            .await
            .unwrap();

        assert_eq!(updated.objective, "new objective");
        assert_eq!(updated.status, GoalStatus::Paused);
        assert_eq!(
            updated
                .current_turn
                .as_ref()
                .map(|turn| turn.queue_id.as_str()),
            Some("queue-1")
        );
    }

    #[test]
    fn failure_backoff_is_bounded() {
        assert_eq!(failure_backoff(1), 3);
        assert_eq!(failure_backoff(2), 10);
        assert_eq!(failure_backoff(5), 120);
        assert_eq!(failure_backoff(10), 300);
    }
}
