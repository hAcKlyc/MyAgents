use super::*;

// ============= Session-Centric Sidecar Architecture =============
// Sidecar is a service process for Sessions, shared by their live owners.

#[derive(Default)]
struct DispatchGateState {
    accepting: bool,
    in_flight: usize,
}

/// Per-process admission fence for renderer control requests.
///
/// Admission happens while `SidecarManager` still owns endpoint selection;
/// the returned lease then crosses the network await without retaining the
/// manager mutex. Process replacement closes the gate and waits for the exact
/// generation's admitted requests to finish before terminating it.
pub(crate) struct DispatchGate {
    state: Mutex<DispatchGateState>,
    drained: Condvar,
}

impl DispatchGate {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(DispatchGateState {
                accepting: true,
                in_flight: 0,
            }),
            drained: Condvar::new(),
        })
    }

    pub(crate) fn try_acquire(gate: &Arc<Self>) -> Option<DispatchLease> {
        let mut state = gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.accepting {
            return None;
        }
        state.in_flight += 1;
        Some(DispatchLease { gate: gate.clone() })
    }

    pub(crate) fn is_accepting(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .accepting
    }

    /// Stop admitting requests without waiting for already-admitted work.
    ///
    /// This is the only operation that may run while `SidecarManager` is
    /// locked. The returned drain is waited only after the manager lock has
    /// been released.
    pub(crate) fn close(gate: &Arc<Self>) -> DispatchDrain {
        let mut state = gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.accepting = false;
        DispatchDrain { gate: gate.clone() }
    }

    fn wait_until_in_flight_at_most(&self, maximum: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while state.in_flight > maximum {
            state = self
                .drained
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    pub(crate) fn close_and_wait(gate: &Arc<Self>) {
        Self::close(gate).wait();
    }
}

/// A transient handoff proving that request admission was closed while the
/// process generation was still manager-owned.
pub(crate) struct DispatchDrain {
    gate: Arc<DispatchGate>,
}

impl DispatchDrain {
    pub(crate) fn wait(&self) {
        self.gate.wait_until_in_flight_at_most(0);
    }

    pub(crate) fn matches(&self, gate: &Arc<DispatchGate>) -> bool {
        Arc::ptr_eq(&self.gate, gate)
    }
}

/// Exact Global/legacy instance replacement handoff.
///
/// The private lease keeps the closed old generation manager-authoritative
/// while the replacement process is prepared outside `SidecarManager`. A
/// concurrent stop waits that same gate, so it cannot expose an authority gap
/// or race a second process into the singleton slot.
#[must_use = "finish or abandon the exact replacement before dropping its lease"]
pub(crate) struct DispatchReplacement {
    gate: Arc<DispatchGate>,
    _lease: DispatchLease,
}

impl DispatchReplacement {
    pub(crate) fn begin(gate: &Arc<DispatchGate>) -> Option<Self> {
        let lease = DispatchGate::try_acquire(gate)?;
        DispatchGate::close(gate);
        Some(Self {
            gate: gate.clone(),
            _lease: lease,
        })
    }

    /// Wait for ordinary requests while retaining this replacement's own
    /// lifecycle lease.
    pub(crate) fn wait_for_requests(&self) {
        self.gate.wait_until_in_flight_at_most(1);
    }

    pub(crate) fn matches(&self, gate: &Arc<DispatchGate>) -> bool {
        Arc::ptr_eq(&self.gate, gate)
    }
}

/// Exact process gates closed by one Session lifecycle transition.
///
/// The manager keeps the corresponding entries authoritative while these
/// drains are waited outside its mutex. Pointer identity prevents a stale
/// completion from removing a newer generation.
#[must_use = "wait for the closed generation outside SidecarManager, then finalize it"]
pub(crate) struct SessionGenerationDrain {
    pub(super) session_id: String,
    pub(super) active: Option<DispatchDrain>,
    pub(super) recovering: Option<DispatchDrain>,
}

/// Process objects detached from manager authority. Dropping this value waits
/// their already-closed gates and terminates the exact process trees; callers
/// must therefore carry it outside the manager mutex first.
#[must_use = "drop detached Sidecars only after releasing SidecarManager"]
pub(crate) struct SidecarRetirement {
    pub(crate) sessions: Vec<SessionSidecar>,
    pub(crate) globals: Vec<SidecarInstance>,
}

impl SidecarRetirement {
    pub(crate) fn finish(self) {
        let Self { sessions, globals } = self;
        drop(sessions);
        drop(globals);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GlobalShutdownTarget {
    pub(crate) port: u16,
    pub(crate) generation: u64,
}

/// First half of application shutdown. Request admission is closed and its
/// drains are retained, while exact process generations remain in the manager
/// so shutdown-only callbacks can still checkpoint and settle owned resources.
#[must_use = "drain admitted requests before checkpointing and detaching Sidecars"]
pub(crate) struct SidecarShutdownPreparation {
    pub(crate) drains: Vec<DispatchDrain>,
    pub(crate) globals: Vec<GlobalShutdownTarget>,
}

impl SidecarShutdownPreparation {
    pub(crate) fn wait(&self) {
        for drain in &self.drains {
            drain.wait();
        }
    }
}

impl SessionGenerationDrain {
    pub(crate) fn wait(&self) {
        if let Some(drain) = &self.active {
            drain.wait();
        }
        if let Some(drain) = &self.recovering {
            drain.wait();
        }
    }
}

pub(crate) struct DispatchLease {
    gate: Arc<DispatchGate>,
}

impl Drop for DispatchLease {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        debug_assert!(state.in_flight > 0);
        state.in_flight = state.in_flight.saturating_sub(1);
        // Ordinary drains wait for zero; replacement drains retain one private
        // lifecycle lease and wait for all other requests to leave. Wake both
        // predicates on every decrement.
        self.gate.drained.notify_all();
    }
}

/// Owner of a Sidecar.
/// When all owners release, the Sidecar is stopped.
#[derive(Debug, Clone, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub enum SidecarOwner {
    /// Tab ID that owns part of this Sidecar
    Tab(String),
    /// Floating companion surface. It is frontend-config-authoritative like a
    /// Tab, but the main App cannot release it during Tab lifecycle changes.
    Companion(String),
    /// Task Center task.
    Task(String),
    /// Session-owned Goal. The Goal persists independently from any Tab or Task.
    Goal(String),
    /// Background completion owner - keeps Sidecar alive while AI finishes responding
    /// String is the session ID for identification
    BackgroundCompletion(String),
    /// Agent owner - keeps Sidecar alive for IM/Agent message processing
    /// String is the session_key (e.g. "agent:{agentId}:{channel}:{type}:{id}")
    Agent(String),
}

/// Explicit three-state lifecycle for a SessionSidecar.
///
/// Replaces the previous `healthy: bool` which conflated Starting (process alive,
/// not yet healthy) with Dead (process exited), causing race conditions where
/// health monitors would kill Starting sidecars.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarState {
    /// Process spawned, `wait_for_health` in progress — do not kill.
    Starting,
    /// TCP health check passed (`wait_for_health`), ready to serve requests.
    Healthy,
    /// Process exited or health check permanently failed.
    Dead,
}

/// Session-centric Sidecar instance
/// Each Session has at most one Sidecar, shared by multiple owners.
pub(super) enum ExistingSidecarReuse {
    Healthy {
        port: u16,
        generation: u64,
        runtime: String,
        runtime_source: Option<String>,
    },
    /// `owner_added` = whether THIS ensure call newly inserted its owner when it
    /// joined the still-starting Sidecar. Only true means a readiness-timeout
    /// detach may safely remove that owner (see `add_owner`).
    Starting {
        port: u16,
        generation: u64,
        runtime: String,
        runtime_source: Option<String>,
        owner_added: bool,
    },
    /// Admission was closed by a concurrent last-owner release or
    /// replacement. Wait for that exact generation outside the manager lock,
    /// then retry the normal ensure path.
    Draining(DispatchDrain),
}

pub(super) fn normalize_runtime_name(runtime: Option<&str>) -> &str {
    match runtime {
        Some(runtime) if !runtime.is_empty() => runtime,
        _ => "builtin",
    }
}

pub(super) fn normalize_runtime_source_name(
    runtime: &str,
    runtime_source: Option<&str>,
) -> &'static str {
    let runtime = normalize_runtime_name(Some(runtime));
    if runtime == "builtin" {
        return "builtin";
    }
    if runtime == "dsh" {
        return "integrated";
    }
    match runtime_source {
        Some("managed-provider") => "managed-provider",
        _ => "system-cli",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SidecarRemovalEventPolicy {
    pub(super) emit_stop: bool,
    pub(super) emit_terminal: bool,
}

pub(super) fn sidecar_removal_event_policy(
    owners: &HashSet<SidecarOwner>,
) -> SidecarRemovalEventPolicy {
    SidecarRemovalEventPolicy {
        emit_stop: true,
        emit_terminal: owners.is_empty(),
    }
}

#[cfg(test)]
fn resolve_runtime_for_owner(
    runtime_override: Option<String>,
    owner: &SidecarOwner,
    session_runtime: Option<String>,
    agent_runtime: Option<String>,
) -> Option<String> {
    let _ = owner;
    runtime_override.or(session_runtime).or(agent_runtime)
}

#[cfg(test)]
pub(super) mod lifecycle_contract_tests {
    use super::*;
    use crate::sidecar::manager::GlobalMonitorSnapshot;
    use std::collections::HashSet;

    fn owners(values: Vec<SidecarOwner>) -> HashSet<SidecarOwner> {
        values.into_iter().collect()
    }

    pub(in crate::sidecar) fn test_global_instance(port: u16, generation: u64, healthy: bool) -> SidecarInstance {
        SidecarInstance {
            process: Some(spawn_test_child()),
            generation,
            port,
            agent_dir: None,
            healthy,
            is_global: true,
            session_delete_authority: None,
            dispatch_gate: DispatchGate::new(),
            created_at: std::time::Instant::now(),
        }
    }

    #[test]
    fn dispatch_gate_drains_admitted_request_before_closing_generation() {
        let gate = DispatchGate::new();
        let lease = DispatchGate::try_acquire(&gate).expect("first request is admitted");
        let closing_gate = gate.clone();
        let (closed_tx, closed_rx) = std::sync::mpsc::channel();

        std::thread::spawn(move || {
            DispatchGate::close_and_wait(&closing_gate);
            closed_tx.send(()).expect("report closed gate");
        });

        assert!(closed_rx.recv_timeout(Duration::from_millis(25)).is_err());
        drop(lease);
        closed_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("closing waits only for the admitted request");
        assert!(DispatchGate::try_acquire(&gate).is_none());
    }

    fn assert_dispatch_blocks_generation_close<T>(dispatch: T, gate: Arc<DispatchGate>) {
        let (closed_tx, closed_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            DispatchGate::close_and_wait(&gate);
            closed_tx.send(()).expect("report closed generation");
        });
        assert!(closed_rx.recv_timeout(Duration::from_millis(25)).is_err());
        drop(dispatch);
        closed_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("generation closes after its request completes");
    }

    #[test]
    fn session_and_global_dispatches_hold_their_selected_generation() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let session_gate = manager
            .sidecars
            .get("session-a")
            .expect("Session Sidecar")
            .dispatch_gate
            .clone();
        let session_dispatch = manager
            .acquire_frontend_session_dispatch("session-a", &SidecarOwner::Tab("tab-a".to_string()))
            .expect("Session dispatch");
        assert_dispatch_blocks_generation_close(session_dispatch, session_gate);

        let global_generation = manager.next_instance_generation();
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            test_global_instance(31419, global_generation, true),
        );
        let global_gate = manager
            .instances
            .get(GLOBAL_SIDECAR_ID)
            .expect("Global Sidecar")
            .dispatch_gate
            .clone();
        let global_dispatch = manager.acquire_global_dispatch().expect("Global dispatch");
        assert_dispatch_blocks_generation_close(global_dispatch, global_gate);
    }

    #[test]
    fn shutdown_fence_keeps_global_generation_authoritative_until_detach() {
        let mut manager = SidecarManager::new();
        let generation = manager.next_instance_generation();
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            test_global_instance(31419, generation, true),
        );

        let preparation = manager.prepare_stop_all();
        preparation.wait();
        assert!(manager.is_live_process(GLOBAL_SIDECAR_ID, generation));
        assert!(manager.acquire_global_dispatch().is_err());

        let retirement = manager.stop_all();
        assert!(!manager.is_live_process(GLOBAL_SIDECAR_ID, generation));
        retirement.finish();
    }

    #[test]
    fn last_owner_release_waits_without_holding_sidecar_manager() {
        let manager = Arc::new(Mutex::new(SidecarManager::new()));
        {
            let mut guard = manager.lock().expect("manager lock");
            insert_test_sidecar(&mut guard, "session-a", SidecarState::Healthy);
            insert_test_sidecar(&mut guard, "session-b", SidecarState::Healthy);
        }
        let dispatch = manager
            .lock()
            .expect("manager lock")
            .acquire_frontend_session_dispatch("session-a", &SidecarOwner::Tab("tab-a".to_string()))
            .expect("admitted request");

        let release_manager = manager.clone();
        let (released_tx, released_rx) = std::sync::mpsc::channel();
        let release_thread = std::thread::spawn(move || {
            let result = crate::sidecar::release_session_sidecar_from_blocking_thread(
                &release_manager,
                "session-a",
                &SidecarOwner::Tab("tab-a".to_string()),
            );
            released_tx.send(result).expect("report release result");
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        loop {
            let mut guard = manager.lock().expect("manager remains available");
            let admission_closed = guard
                .sidecars
                .get("session-a")
                .is_some_and(|sidecar| !sidecar.dispatch_gate.is_accepting());
            if admission_closed {
                assert_eq!(guard.get_session_port("session-b"), Some(31418));
                assert!(!guard
                    .add_session_owner("session-a", SidecarOwner::Task("late-owner".to_string()),));
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "release did not close admission"
            );
            drop(guard);
            std::thread::yield_now();
        }
        assert!(released_rx.recv_timeout(Duration::from_millis(25)).is_err());

        drop(dispatch);
        assert_eq!(
            released_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("release completes after request body is consumed"),
            Ok(true)
        );
        release_thread.join().expect("release thread");
        assert!(!manager
            .lock()
            .expect("manager lock")
            .sidecars
            .contains_key("session-a"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn async_last_owner_release_keeps_blocking_browser_retirement_off_tokio() {
        let manager = Arc::new(Mutex::new(SidecarManager::new()));
        {
            let mut guard = manager.lock().expect("manager lock");
            insert_test_sidecar(&mut guard, "session-async", SidecarState::Healthy);
            let generation = guard.next_instance_generation();
            guard.insert_instance(
                GLOBAL_SIDECAR_ID.to_string(),
                test_global_instance(9, generation, true),
            );
        }

        let stopped = tokio::time::timeout(
            Duration::from_secs(2),
            crate::sidecar::release_session_sidecar(
                &manager,
                "session-async",
                &SidecarOwner::Tab("tab-a".to_string()),
            ),
        )
        .await
        .expect("blocking retirement runs on a blocking worker")
        .expect("owner release succeeds even when Browser Host is unavailable");

        assert!(stopped);
        assert!(!manager
            .lock()
            .expect("manager lock")
            .sidecars
            .contains_key("session-async"));
    }

    #[test]
    fn global_standing_intent_survives_candidate_failure_until_explicit_stop() {
        let mut manager = SidecarManager::new();
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::Stopped
        ));

        manager.request_global_sidecar_running("test-start");
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::DesiredMissing
        ));

        let failed_generation = manager.next_instance_generation();
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            test_global_instance(31419, failed_generation, false),
        );
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::Present {
                port: 31419,
                process_alive: true,
                ..
            }
        ));

        manager.remove_instance(GLOBAL_SIDECAR_ID);
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::DesiredMissing
        ));

        let ready_generation = manager.next_instance_generation();
        assert!(ready_generation > failed_generation);
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            test_global_instance(31420, ready_generation, true),
        );
        assert!(manager.acquire_global_dispatch().is_ok());
        assert!(manager.global_sidecar_is_desired());

        manager.request_global_sidecar_stopped("test-explicit-stop");
        manager.remove_instance(GLOBAL_SIDECAR_ID);
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::Stopped
        ));

        manager.request_global_sidecar_running("test-stop-all");
        manager.stop_all().finish();
        assert!(matches!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::Stopped
        ));
    }

    #[test]
    fn global_birth_reservation_is_canonical_and_not_monitor_dead_work() {
        let mut manager = SidecarManager::new();
        manager.request_global_sidecar_running("test-birth");
        let generation = manager.next_instance_generation();
        let gate = DispatchGate::new();
        let birth_lease = DispatchGate::try_acquire(&gate).expect("birth lease");
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            SidecarInstance {
                process: None,
                generation,
                port: 31419,
                agent_dir: None,
                healthy: false,
                is_global: true,
                session_delete_authority: None,
                dispatch_gate: gate,
                created_at: std::time::Instant::now(),
            },
        );

        assert_eq!(
            manager.global_monitor_snapshot(),
            GlobalMonitorSnapshot::BirthPending {
                port: 31419,
                generation,
            }
        );
        assert!(manager.acquire_global_dispatch().is_err());

        let drain = manager
            .prepare_instance_retirement(GLOBAL_SIDECAR_ID)
            .expect("stop observes the canonical birth reservation");
        drop(birth_lease);
        drain.wait();
        let retired = manager
            .finish_instance_retirement(GLOBAL_SIDECAR_ID, &drain)
            .expect("stop removes the exact birth reservation");
        drop(retired);
    }

    #[test]
    fn stale_global_health_result_cannot_mark_reused_port_generation_unhealthy() {
        let mut manager = SidecarManager::new();
        let current_generation = manager.next_instance_generation();
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            test_global_instance(31419, current_generation, true),
        );

        assert!(!manager.instance_identity_is_current(
            GLOBAL_SIDECAR_ID,
            31419,
            current_generation.saturating_sub(1),
        ));
        assert!(manager.instance_identity_is_current(GLOBAL_SIDECAR_ID, 31419, current_generation,));
        assert!(!manager.mark_instance_unhealthy_if_current(
            GLOBAL_SIDECAR_ID,
            31419,
            current_generation.saturating_sub(1),
        ));
        assert!(manager
            .get_instance(GLOBAL_SIDECAR_ID)
            .is_some_and(|instance| instance.healthy));
        assert!(manager.mark_instance_unhealthy_if_current(
            GLOBAL_SIDECAR_ID,
            31419,
            current_generation,
        ));
        assert!(manager
            .get_instance(GLOBAL_SIDECAR_ID)
            .is_some_and(|instance| !instance.healthy));
    }

    #[test]
    fn global_retirement_retains_authority_and_finishes_only_the_exact_gate() {
        let mut manager = SidecarManager::new();
        manager.request_global_sidecar_running("test-start");
        let first_generation = manager.next_instance_generation();
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            test_global_instance(31419, first_generation, true),
        );

        let admitted = manager.acquire_global_dispatch().expect("Global dispatch");
        let drain = manager
            .prepare_instance_retirement(GLOBAL_SIDECAR_ID)
            .expect("retirement drain");

        assert!(manager.instances.contains_key(GLOBAL_SIDECAR_ID));
        assert_eq!(
            manager
                .get_instance(GLOBAL_SIDECAR_ID)
                .map(|instance| instance.generation),
            Some(first_generation)
        );
        assert!(manager.acquire_global_dispatch().is_err());

        drop(admitted);
        drain.wait();
        let retired = manager
            .finish_instance_retirement(GLOBAL_SIDECAR_ID, &drain)
            .expect("exact old generation retires");
        assert!(!manager.instances.contains_key(GLOBAL_SIDECAR_ID));

        let replacement_generation = manager.next_instance_generation();
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            test_global_instance(31420, replacement_generation, true),
        );

        assert!(manager
            .finish_instance_retirement(GLOBAL_SIDECAR_ID, &drain)
            .is_none());
        assert_eq!(
            manager
                .get_instance(GLOBAL_SIDECAR_ID)
                .map(|item| item.port),
            Some(31420)
        );
        drop(retired);
    }

    #[test]
    fn global_replacement_lease_orders_request_drain_and_concurrent_stop() {
        let mut manager = SidecarManager::new();
        manager.request_global_sidecar_running("test-start");
        let first_generation = manager.next_instance_generation();
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            test_global_instance(31419, first_generation, true),
        );

        let request = manager.acquire_global_dispatch().expect("Global dispatch");
        let replacement = manager
            .prepare_instance_replacement(GLOBAL_SIDECAR_ID)
            .expect("replacement owns the accepting old generation");
        let (replacement_tx, replacement_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            replacement.wait_for_requests();
            replacement_tx
                .send(replacement)
                .expect("return replacement handoff");
        });

        assert!(replacement_rx
            .recv_timeout(Duration::from_millis(25))
            .is_err());
        assert!(manager.instances.contains_key(GLOBAL_SIDECAR_ID));
        drop(request);
        let replacement = replacement_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("replacement proceeds after the ordinary request leaves");

        // A stop that begins during process creation waits the replacement's
        // private lease on the same exact old gate.
        let stop_drain = manager
            .prepare_instance_retirement(GLOBAL_SIDECAR_ID)
            .expect("concurrent stop drain");
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            stop_drain.wait();
            stop_tx.send(stop_drain).expect("return stop drain");
        });
        assert!(stop_rx.recv_timeout(Duration::from_millis(25)).is_err());

        let replacement_generation = manager.next_instance_generation();
        let retired = match manager.finish_instance_replacement(
            GLOBAL_SIDECAR_ID,
            &replacement,
            test_global_instance(31420, replacement_generation, false),
        ) {
            Ok(retired) => retired,
            Err(_) => panic!("replacement publishes atomically"),
        };
        drop(replacement);
        drop(retired);

        let stop_drain = stop_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("stop wakes when replacement publication settles");
        assert!(manager
            .finish_instance_retirement(GLOBAL_SIDECAR_ID, &stop_drain)
            .is_none());
        assert_eq!(
            manager
                .get_instance(GLOBAL_SIDECAR_ID)
                .map(|instance| instance.port),
            Some(31420)
        );
    }

    #[test]
    fn desktop_style_owner_prefers_builtin_session_metadata_over_agent_runtime() {
        assert_eq!(
            resolve_runtime_for_owner(
                None,
                &SidecarOwner::Tab("tab-a".to_string()),
                Some("builtin".to_string()),
                Some("codex".to_string()),
            ),
            Some("builtin".to_string())
        );
    }

    #[test]
    fn im_agent_owner_preserves_session_runtime() {
        assert_eq!(
            resolve_runtime_for_owner(
                None,
                &SidecarOwner::Agent("agent:a:openclaw:feishu:private:user".to_string()),
                Some("builtin".to_string()),
                Some("codex".to_string()),
            ),
            Some("builtin".to_string())
        );
    }

    #[test]
    fn maintenance_agent_owner_prefers_session_metadata_over_agent_runtime() {
        assert_eq!(
            resolve_runtime_for_owner(
                None,
                &SidecarOwner::Agent("memory_update:a:s1".to_string()),
                Some("builtin".to_string()),
                Some("codex".to_string()),
            ),
            Some("builtin".to_string())
        );
    }

    #[test]
    fn session_runtime_identity_parser_preserves_builtin_metadata() {
        let content = serde_json::json!([
            { "id": "missing-runtime" },
            { "id": "builtin-runtime", "runtime": "builtin" },
            { "id": "codex-runtime", "runtime": "codex" },
            { "id": "managed-codex-runtime", "runtime": "codex", "runtimeSource": "managed-provider" },
            { "id": "malformed-managed-runtime", "runtime": "builtin", "runtimeSource": "managed-provider" }
        ])
        .to_string();

        assert_eq!(
            resolve_session_runtime_identity_from_json("missing-runtime", &content),
            Some("builtin".to_string())
        );
        assert_eq!(
            resolve_session_runtime_identity_from_json("builtin-runtime", &content),
            Some("builtin".to_string())
        );
        assert_eq!(
            resolve_session_runtime_identity_from_json("codex-runtime", &content),
            Some("codex".to_string())
        );
        assert_eq!(
            resolve_session_runtime_identity_full_from_json("codex-runtime", &content),
            Some(RuntimeIdentity {
                runtime: "codex".to_string(),
                runtime_source: Some("system-cli".to_string()),
                runtime_binding_json: None,
                compatibility_error: None,
            })
        );
        assert_eq!(
            resolve_session_runtime_identity_full_from_json("managed-codex-runtime", &content),
            Some(RuntimeIdentity {
                runtime: "codex".to_string(),
                runtime_source: Some("managed-provider".to_string()),
                runtime_binding_json: None,
                compatibility_error: None,
            })
        );
        assert_eq!(
            resolve_session_runtime_identity_full_from_json("malformed-managed-runtime", &content),
            Some(RuntimeIdentity {
                runtime: "incompatible".to_string(),
                runtime_source: None,
                runtime_binding_json: None,
                compatibility_error: Some(
                    "legacy builtin/managed-provider Session has no managed Codex proof"
                        .to_string(),
                ),
            })
        );
        assert_eq!(
            resolve_session_runtime_identity_from_json("unknown", &content),
            None
        );
    }

    #[test]
    fn terminal_removal_requires_no_remaining_owners() {
        assert_eq!(
            sidecar_removal_event_policy(&HashSet::new()),
            SidecarRemovalEventPolicy {
                emit_stop: true,
                emit_terminal: true
            }
        );
        assert_eq!(
            sidecar_removal_event_policy(&owners(vec![SidecarOwner::Tab("tab-a".to_string())])),
            SidecarRemovalEventPolicy {
                emit_stop: true,
                emit_terminal: false
            }
        );
        assert_eq!(
            sidecar_removal_event_policy(&owners(vec![SidecarOwner::Agent("agent-a".to_string())])),
            SidecarRemovalEventPolicy {
                emit_stop: true,
                emit_terminal: false
            }
        );
    }

    #[test]
    fn sidecar_generation_is_monotonic_and_not_reused_after_clear() {
        let mut manager = SidecarManager::new();

        let first = manager.next_generation("session-a");
        let second = manager.next_generation("session-a");
        assert!(second > first);

        manager.clear_generation("session-a");
        assert_eq!(manager.current_generation("session-a"), 0);

        let third = manager.next_generation("session-a");
        assert!(third > second);
    }

    #[test]
    fn management_process_identity_covers_global_and_session_sidecars() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "pending-a", SidecarState::Healthy);
        let session_generation = manager.current_generation("pending-a");
        assert!(manager.is_live_process("pending-a", session_generation));

        assert!(manager.upgrade_session_id_for_tab("pending-a", "session-a", "tab-a"));
        assert!(
            manager.is_live_process("pending-a", session_generation),
            "a logical Session key upgrade must not invalidate the immutable identity injected into the live process"
        );
        assert!(
            !manager.is_live_process("session-a", session_generation),
            "the mutable Session key is not a substitute for the process's injected management identity"
        );

        let global_generation = manager.next_instance_generation();
        manager.insert_instance(
            GLOBAL_SIDECAR_ID.to_string(),
            test_global_instance(31419, global_generation, true),
        );
        assert!(manager.is_live_process(GLOBAL_SIDECAR_ID, global_generation));
        assert!(!manager.is_live_process(GLOBAL_SIDECAR_ID, global_generation + 1));

        manager.remove_instance(GLOBAL_SIDECAR_ID);
        assert!(!manager.is_live_process(GLOBAL_SIDECAR_ID, global_generation));
    }

    #[test]
    fn tab_scoped_identity_upgrade_accepts_only_the_exact_tab_owner() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-real", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("session-real")
            .expect("session sidecar")
            .add_owner(SidecarOwner::Task("task-1".to_string()));

        assert!(!manager.upgrade_session_id_for_tab("pending-a", "session-real", "tab-b",));
        assert!(!manager.session_id_upgrade_is_already_applied_for_tab(
            "pending-a",
            "session-real",
            "tab-a",
        ));
        assert!(!manager.upgrade_session_id_for_tab("pending-a", "session-real", "tab-a",));

        let release =
            manager.remove_session_owner("session-real", &SidecarOwner::Task("task-1".to_string()));
        assert!(release.removed);
        assert!(!release.stopped);
        assert!(manager.session_id_upgrade_is_already_applied_for_tab(
            "pending-a",
            "session-real",
            "tab-a",
        ));
        assert!(manager.upgrade_session_id_for_tab("pending-a", "session-real", "tab-a",));
    }

    #[test]
    fn tab_scoped_identity_upgrade_rejects_a_recovering_source() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "pending-recovery", SidecarState::Dead);
        manager.begin_session_sidecar_replacement("pending-recovery");

        assert!(!manager.upgrade_session_id_for_tab("pending-recovery", "session-real", "tab-a",));
        assert!(manager.recovering_sidecars.contains_key("pending-recovery"));
        assert!(!manager.recovering_sidecars.contains_key("session-real"));
    }

    #[test]
    fn tab_activation_reconcile_preserves_task_identity_atomically() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-task", SidecarState::Healthy);
        let sidecar = manager
            .get_session_sidecar_mut("session-task")
            .expect("session sidecar");
        sidecar.add_owner(SidecarOwner::Task("task-1".to_string()));
        sidecar.add_owner(SidecarOwner::BackgroundCompletion(
            "session-task".to_string(),
        ));
        sidecar.port = 32001;
        sidecar.workspace_path = PathBuf::from("/tmp/revived");
        assert!(manager.reconcile_session_tab_activation("session-task", "tab-a",));

        let sidecar = manager
            .get_session_sidecar_mut("session-task")
            .expect("session sidecar");
        assert_eq!(sidecar.port, 32001);
        assert_eq!(sidecar.workspace_path, PathBuf::from("/tmp/revived"));
        assert!(sidecar
            .owners
            .contains(&SidecarOwner::Tab("tab-a".to_string())));
        assert!(sidecar
            .owners
            .contains(&SidecarOwner::Task("task-1".to_string())));
        assert!(
            !sidecar.owners.contains(&SidecarOwner::BackgroundCompletion(
                "session-task".to_string(),
            ))
        );
    }

    fn spawn_test_child() -> ChildTree {
        #[cfg(windows)]
        let mut cmd = {
            let mut cmd = crate::process_cmd::new("powershell");
            cmd.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"]);
            cmd
        };

        #[cfg(not(windows))]
        let mut cmd = {
            let mut cmd = crate::process_cmd::new("sleep");
            cmd.arg("60");
            cmd
        };

        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::process_cmd::spawn_tree(&mut cmd).expect("spawn test child tree")
    }

    fn insert_test_sidecar(manager: &mut SidecarManager, session_id: &str, state: SidecarState) {
        manager.insert_sidecar(
            session_id,
            SessionSidecar {
                process: spawn_test_child(),
                port: 31418,
                session_id: session_id.to_string(),
                management_id: session_id.to_string(),
                workspace_path: PathBuf::from("/tmp/workspace"),
                state,
                owners: owners(vec![SidecarOwner::Tab("tab-a".to_string())]),
                completion_claims: HashSet::new(),
                dispatch_gate: DispatchGate::new(),
                created_at: std::time::Instant::now(),
                runtime: None,
                runtime_source: None,
            },
        );
    }

    #[test]
    fn session_port_is_not_exposed_until_sidecar_is_healthy() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Starting);

        assert_eq!(manager.get_session_port("session-a"), None);

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .state = SidecarState::Healthy;

        assert_eq!(manager.get_session_port("session-a"), Some(31418));
    }

    #[test]
    fn sse_owner_resolver_uses_exact_hint_and_requires_owner_match() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        insert_test_sidecar(&mut manager, "session-b", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("session-a")
            .owners = owners(vec![SidecarOwner::Tab("tab-other".to_string())]);

        let owner = SidecarOwner::Tab("tab-a".to_string());
        let error = manager
            .resolve_session_sidecar_for_frontend_owner("session-a", &owner)
            .expect_err("an exact hint with the wrong owner must fail closed");

        assert!(error.contains("not owned"));
        assert_eq!(
            manager
                .resolve_session_sidecar_for_frontend_owner("session-b", &owner)
                .map(|binding| binding.base_url()),
            Ok("http://127.0.0.1:31418".to_string())
        );
    }

    #[test]
    fn sse_owner_resolver_follows_pending_to_real_key_upgrade() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "pending-tab-a", SidecarState::Healthy);
        let owner = SidecarOwner::Tab("tab-a".to_string());

        assert!(manager.upgrade_session_id_for_tab("pending-tab-a", "session-real", "tab-a"));
        assert_eq!(
            manager
                .resolve_session_sidecar_for_frontend_owner("pending-tab-a", &owner)
                .map(|binding| binding.base_url()),
            Ok("http://127.0.0.1:31418".to_string())
        );
    }

    #[test]
    fn sse_owner_resolver_rejects_ambiguous_companion_handover() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-old", SidecarState::Healthy);
        insert_test_sidecar(&mut manager, "session-new", SidecarState::Healthy);
        let owner = SidecarOwner::Companion("floating-ball".to_string());
        for session_id in ["session-old", "session-new"] {
            manager
                .get_session_sidecar_mut(session_id)
                .expect("session sidecar")
                .owners = owners(vec![owner.clone()]);
        }

        assert_eq!(
            manager
                .resolve_session_sidecar_for_frontend_owner("session-new", &owner)
                .map(|binding| binding.base_url()),
            Ok("http://127.0.0.1:31418".to_string())
        );
        let error = manager
            .resolve_session_sidecar_for_frontend_owner("missing-hint", &owner)
            .expect_err("owner-only fallback must reject multiple matches");
        assert!(error.contains("ambiguously matches"));
        assert!(error.contains("session-new"));
        assert!(error.contains("session-old"));
    }

    #[test]
    fn session_has_frontend_owner_tracks_tab_and_companion_presence() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);

        assert!(manager.session_has_frontend_owner("session-a"));

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners = owners(vec![SidecarOwner::Companion("floating-ball".to_string())]);

        assert!(manager.session_has_frontend_owner("session-a"));
        assert!(manager.session_has_persistent_owners("session-a"));

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners = owners(vec![SidecarOwner::Agent("agent-a".to_string())]);

        assert!(!manager.session_has_frontend_owner("session-a"));
        assert!(!manager.session_has_frontend_owner("missing-session"));
    }

    #[test]
    fn healthy_inbox_attachment_adds_agent_owner_before_returning_port() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);

        assert_eq!(
            manager.attach_owner_to_healthy_session(
                "session-a",
                SidecarOwner::Agent("inbox-deliver-a".to_string()),
            ),
            Some(31418)
        );
        assert!(manager.session_has_persistent_owners("session-a"));

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .state = SidecarState::Dead;
        assert_eq!(
            manager.attach_owner_to_healthy_session(
                "session-a",
                SidecarOwner::Agent("inbox-deliver-b".to_string()),
            ),
            None
        );
    }

    #[test]
    fn stale_tab_release_does_not_clear_a_current_tab_owner() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);

        let release = manager.release_tab_session("session-a", "stale-tab", false);
        assert!(!release.removed);
        assert!(
            manager.session_has_exact_owner("session-a", &SidecarOwner::Tab("tab-a".to_string()),)
        );
        assert!(manager.session_has_frontend_owner("session-a"));
    }

    #[test]
    fn stale_release_does_not_disturb_persistent_owners() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners = owners(vec![SidecarOwner::Goal("goal-a".to_string())]);

        let release = manager.release_tab_session("session-a", "closed-tab", false);
        assert!(!release.removed);
        assert!(manager.session_has_persistent_owners("session-a"));
    }

    #[test]
    fn replacement_commit_preserves_all_owners_and_process_coordinates() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("dead sidecar")
            .owners
            .insert(SidecarOwner::Goal("goal-a".to_string()));

        manager.begin_session_sidecar_replacement("session-a");
        assert!(!manager.sidecars.contains_key("session-a"));
        assert!(manager.recovering_sidecars.contains_key("session-a"));

        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let replacement = manager
            .get_session_sidecar_mut("session-a")
            .expect("replacement sidecar");
        replacement.port = 32002;
        replacement.workspace_path = PathBuf::from("/tmp/new-workspace");
        replacement.owners = owners(vec![SidecarOwner::Task("task-a".to_string())]);
        let replacement_generation = manager.current_generation("session-a");

        let commit = manager
            .commit_ready_session_sidecar("session-a")
            .expect("replacement commit");
        assert_eq!(commit.generation, replacement_generation);
        assert_eq!(commit.port, 32002);
        let replacement = manager
            .get_session_sidecar_mut("session-a")
            .expect("committed replacement");
        assert!(replacement
            .owners
            .contains(&SidecarOwner::Tab("tab-a".to_string())));
        assert!(replacement
            .owners
            .contains(&SidecarOwner::Goal("goal-a".to_string())));
        assert!(replacement
            .owners
            .contains(&SidecarOwner::Task("task-a".to_string())));
        assert!(!manager.recovering_sidecars.contains_key("session-a"));
    }

    #[test]
    fn recovery_epoch_survives_generation_reserve_and_readiness_failures() {
        let mut manager = SidecarManager::new();
        let mut terminal_events = manager.subscribe_terminal_events();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);
        let dead_generation = manager.current_generation("session-a");
        manager.begin_session_sidecar_replacement("session-a");
        let epoch = manager
            .recovering_sidecars
            .get("session-a")
            .expect("recovery")
            .epoch;
        assert!(manager
            .record_session_recovery_failure(
                "session-a",
                Some(epoch.saturating_add(1)),
                std::time::Instant::now(),
            )
            .is_none());
        assert_eq!(
            manager
                .recovering_sidecars
                .get("session-a")
                .expect("same recovery")
                .failed_attempts,
            0
        );

        // Candidate generation was reserved but spawn failed before insertion.
        let reserved_generation = manager.next_generation("session-a");
        manager.clear_generation("session-a");
        let now = std::time::Instant::now();
        let reserve_failure = manager
            .record_session_recovery_failure("session-a", Some(epoch), now)
            .expect("reserve failure");
        assert_eq!(reserve_failure.epoch, epoch);
        assert_eq!(reserve_failure.dead_generation, dead_generation);
        assert_eq!(
            reserve_failure.candidate_generation,
            Some(reserved_generation)
        );

        // A later candidate reached active/Starting but failed readiness.
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Starting);
        let readiness_generation = manager.current_generation("session-a");
        manager.remove_sidecar("session-a");
        let readiness_failure = manager
            .record_session_recovery_failure(
                "session-a",
                Some(epoch),
                now + reserve_failure.retry_after,
            )
            .expect("readiness failure");
        assert_eq!(readiness_failure.epoch, epoch);
        assert_eq!(readiness_failure.dead_generation, dead_generation);
        assert_eq!(
            readiness_failure.candidate_generation,
            Some(readiness_generation)
        );
        assert!(manager.recovering_sidecars.contains_key("session-a"));
        assert!(matches!(
            terminal_events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn recovery_fast_retries_transition_to_bounded_slow_retries() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);
        manager.begin_session_sidecar_replacement("session-a");
        let epoch = manager
            .recovering_sidecars
            .get("session-a")
            .expect("recovery")
            .epoch;
        let mut now = std::time::Instant::now();
        let expected_delays = [15, 15, 15, 15, 60, 120, 240, 300, 300];

        for (index, expected_secs) in expected_delays.into_iter().enumerate() {
            let failure = manager
                .record_session_recovery_failure("session-a", Some(epoch), now)
                .expect("scheduled retry");
            assert_eq!(failure.failed_attempts, index as u32 + 1);
            assert_eq!(failure.retry_after, Duration::from_secs(expected_secs));
            assert!(manager.due_session_recoveries(now).is_empty());
            now += failure.retry_after;
            assert_eq!(
                manager.due_session_recoveries(now),
                vec!["session-a".to_string()]
            );
        }
    }

    #[test]
    fn ready_independent_candidate_settles_recovery_epoch_and_retains_mixed_owners() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("dead sidecar")
            .owners
            .extend([
                SidecarOwner::Task("task-a".to_string()),
                SidecarOwner::Goal("goal-a".to_string()),
            ]);
        manager.begin_session_sidecar_replacement("session-a");

        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let generation = manager.current_generation("session-a");
        let commit = manager
            .commit_ready_session_sidecar("session-a")
            .expect("independent candidate wins");
        assert_eq!(commit.generation, generation);
        assert_eq!(commit.port, 31418);
        assert!(!manager.has_session_recovery("session-a"));
        let owners = &manager
            .get_session_sidecar("session-a")
            .expect("committed sidecar")
            .owners;
        assert!(owners.contains(&SidecarOwner::Tab("tab-a".to_string())));
        assert!(owners.contains(&SidecarOwner::Task("task-a".to_string())));
        assert!(owners.contains(&SidecarOwner::Goal("goal-a".to_string())));
    }

    #[test]
    fn background_completion_keeps_identity_active_after_tab_release() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners
            .insert(SidecarOwner::BackgroundCompletion("session-a".to_string()));
        let release = manager.release_tab_session("session-a", "tab-a", false);
        assert!(release.removed);
        assert!(!release.stopped);
        assert!(manager.session_has_persistent_owners("session-a"));
        assert!(
            !manager.session_has_exact_owner("session-a", &SidecarOwner::Tab("tab-a".to_string()),)
        );
    }

    #[test]
    fn deletion_protection_snapshot_excludes_plain_tabs_and_includes_recovering_owners() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "tab-only", SidecarState::Healthy);
        insert_test_sidecar(&mut manager, "agent-owned", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("agent-owned")
            .expect("agent sidecar")
            .owners = owners(vec![SidecarOwner::Agent("agent-a".to_string())]);

        insert_test_sidecar(&mut manager, "companion-owned", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("companion-owned")
            .expect("companion sidecar")
            .owners = owners(vec![SidecarOwner::Companion("floating-ball".to_string())]);

        insert_test_sidecar(&mut manager, "recovering", SidecarState::Dead);
        manager
            .get_session_sidecar_mut("recovering")
            .expect("recovering sidecar")
            .owners = owners(vec![SidecarOwner::BackgroundCompletion(
            "recovering".to_string(),
        )]);
        manager.begin_session_sidecar_replacement("recovering");

        assert_eq!(
            manager.persistent_owner_session_ids(),
            vec![
                "agent-owned".to_string(),
                "companion-owned".to_string(),
                "recovering".to_string(),
            ]
        );
    }

    #[test]
    fn last_generic_owner_release_clears_session_identity() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners = owners(vec![SidecarOwner::Goal("goal-a".to_string())]);
        let release =
            manager.remove_session_owner("session-a", &SidecarOwner::Goal("goal-a".to_string()));
        assert!(release.removed && release.stopped);
        let drain = release.drain.expect("last owner closes the generation");
        drain.wait();
        let retired = manager.finish_unowned_session_retirement(&drain);
        drop(retired);
        assert!(!manager.sidecars.contains_key("session-a"));
        assert_eq!(manager.current_generation("session-a"), 0);
    }

    #[test]
    fn prepared_inbox_owner_is_not_its_own_unpublished_session_authority() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "unpublished", SidecarState::Healthy);
        let prepared = SidecarOwner::Agent("inbox-deliver-prepared".into());
        manager.get_session_sidecar_mut("unpublished").unwrap().owners.insert(prepared.clone());
        assert!(manager.session_has_owners_other_than("unpublished", Some(&prepared)));
        manager.get_session_sidecar_mut("unpublished").unwrap().owners.retain(|owner| owner == &prepared);
        assert!(!manager.session_has_owners_other_than("unpublished", Some(&prepared)));
        assert!(manager.session_has_owners("unpublished"));
    }

    #[test]
    fn dead_sidecar_with_owners_still_protects_session_identity() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);

        assert!(!manager.has_session_sidecar("session-a"));
        assert!(manager.session_has_owners("session-a"));
    }

    #[test]
    fn owner_release_during_restart_updates_recovery_authority() {
        let mut manager = SidecarManager::new();
        let mut terminal_events = manager.subscribe_terminal_events();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Dead);
        manager
            .get_session_sidecar_mut("session-a")
            .expect("dead sidecar")
            .owners
            .insert(SidecarOwner::Goal("goal-a".to_string()));
        manager.begin_session_sidecar_replacement("session-a");
        let recovery_epoch = manager
            .recovering_sidecars
            .get("session-a")
            .expect("recovery")
            .epoch;

        // The monitor's replacement initially owns only the owner chosen to
        // start it; the retained dead object still carries every owner.
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Starting);
        let release =
            manager.remove_session_owner("session-a", &SidecarOwner::Tab("tab-a".to_string()));
        assert!(release.removed);
        assert!(!release.stopped);
        assert!(!manager.recovery_attempt_is_authorized(
            "session-a",
            recovery_epoch,
            &SidecarOwner::Tab("tab-a".to_string())
        ));
        assert!(manager.recovery_attempt_is_authorized(
            "session-a",
            recovery_epoch,
            &SidecarOwner::Goal("goal-a".to_string())
        ));
        assert!(manager.sidecars.contains_key("session-a"));
        assert!(manager.session_has_persistent_owners("session-a"));

        // The selected candidate owner left, so the failed candidate now has
        // an empty local owner set. Retained Goal authority still makes this a
        // recoverable failure, not an ownerless terminal.
        manager.remove_sidecar("session-a");
        assert!(matches!(
            terminal_events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        let release =
            manager.remove_session_owner("session-a", &SidecarOwner::Goal("goal-a".to_string()));
        assert!(release.removed && release.stopped);
        let drain = release
            .drain
            .expect("last recovery owner closes the generation");
        drain.wait();
        let retired = manager.finish_unowned_session_retirement(&drain);
        drop(retired);
        assert!(!manager.sidecars.contains_key("session-a"));
        assert!(!manager.recovering_sidecars.contains_key("session-a"));
    }

    #[test]
    fn every_sidecar_owner_variant_blocks_session_deletion() {
        let owner_variants = vec![
            SidecarOwner::Tab("tab-a".to_string()),
            SidecarOwner::Companion("floating-ball".to_string()),
            SidecarOwner::Task("task-a".to_string()),
            SidecarOwner::Goal("goal-a".to_string()),
            SidecarOwner::BackgroundCompletion("session-a".to_string()),
            SidecarOwner::Agent("agent-a".to_string()),
        ];

        for owner in owner_variants {
            let mut manager = SidecarManager::new();
            insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
            manager
                .get_session_sidecar_mut("session-a")
                .expect("session sidecar")
                .owners = owners(vec![owner]);

            assert!(manager.session_has_owners("session-a"));
        }
    }

    #[test]
    fn deletion_releases_only_the_exact_tabs_authorized_by_app() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let allowed = HashSet::from(["tab-a".to_string()]);

        assert!(!manager.session_has_unreleasable_owners("session-a", &allowed));

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners
            .insert(SidecarOwner::Tab("tab-b".to_string()));
        assert!(manager.session_has_unreleasable_owners("session-a", &allowed));

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .owners = owners(vec![
            SidecarOwner::Tab("tab-a".to_string()),
            SidecarOwner::Agent("agent-a".to_string()),
        ]);
        assert!(manager.session_has_unreleasable_owners("session-a", &allowed));
    }

    #[test]
    fn generation_for_requires_current_sidecar_entry() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let generation = manager
            .generation_for("session-a")
            .expect("current generation");

        manager.remove_sidecar("session-a");

        assert_eq!(manager.current_generation("session-a"), generation);
        assert_eq!(manager.generation_for("session-a"), None);
    }
}

pub struct SessionSidecar {
    /// The child process plus exact descendant-containment authority.
    pub(crate) process: ChildTree,
    /// Port this instance is running on
    pub port: u16,
    /// Session ID this Sidecar serves
    pub session_id: String,
    /// Immutable manager identity injected into `MYAGENTS_SIDECAR_ID` when
    /// this process was spawned. Unlike `session_id`, this does not change
    /// when pending/reset/handover flows rekey the logical Session.
    pub management_id: String,
    /// Workspace path for this session
    /// Reserved for future use (e.g., workspace-aware operations)
    #[allow(dead_code)]
    pub workspace_path: PathBuf,
    /// Lifecycle state: Starting → Healthy → Dead
    pub state: SidecarState,
    /// Set of owners currently using this Sidecar
    pub owners: HashSet<SidecarOwner>,
    /// Completion identities already consumed by notification delivery for
    /// this exact Sidecar generation. The manager is the only writer; keeping
    /// the set on the generation entry makes teardown reclaim it naturally.
    pub(crate) completion_claims: HashSet<(String, String)>,
    /// Admission fence for control requests bound to this process generation.
    pub(crate) dispatch_gate: Arc<DispatchGate>,
    /// Creation timestamp
    /// Reserved for future use (e.g., TTL-based cleanup)
    #[allow(dead_code)]
    pub created_at: std::time::Instant,
    /// MYAGENTS_RUNTIME env var value this Sidecar was spawned with.
    /// Used for drift detection on Agent-owner reuse: when the agent's
    /// runtime config changes (e.g. codex → claude-code), subsequent IM messages
    /// for the same peer session must not reuse a Sidecar that's still
    /// running the old runtime. None = builtin (no env var injected).
    pub runtime: Option<String>,
    /// MYAGENTS_RUNTIME_SOURCE env var value this Sidecar was spawned with.
    /// Missing external runtime source is treated as system-cli.
    pub runtime_source: Option<String>,
}

/// Proof that one completion identity was claimed from the authoritative
/// Sidecar generation. The private field prevents notification callers from
/// bypassing the manager's generation fence.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SessionCompletionClaim {
    _private: (),
}

impl SessionCompletionClaim {
    pub(super) fn new() -> Self {
        Self { _private: () }
    }
}

impl SessionSidecar {
    /// Is this sidecar healthy and ready to accept requests?
    pub fn is_reusable(&self) -> bool {
        matches!(self.state, SidecarState::Healthy) && self.dispatch_gate.is_accepting()
    }

    /// Is this sidecar both marked healthy and still alive?
    pub fn is_ready_for_requests(&mut self) -> bool {
        !self.is_dead() && self.is_reusable()
    }

    /// Is this sidecar still starting up? (process alive, `wait_for_health` in progress)
    pub fn is_starting(&self) -> bool {
        matches!(self.state, SidecarState::Starting)
    }

    /// Is this sidecar dead?
    /// Also auto-detects process exit and transitions Starting/Healthy → Dead.
    pub fn is_dead(&mut self) -> bool {
        if self.state == SidecarState::Dead {
            return true;
        }
        // Check if the process actually exited while we thought it was alive
        match self.process.try_wait() {
            Ok(Some(_)) => {
                self.state = SidecarState::Dead;
                true
            }
            Ok(None) => false, // Still running
            Err(_) => {
                self.state = SidecarState::Dead;
                true
            }
        }
    }

    /// Check if this Sidecar has any owners
    /// Reserved for future use (e.g., lifecycle management)
    #[allow(dead_code)]
    pub fn has_owners(&self) -> bool {
        !self.owners.is_empty()
    }

    /// Add an owner to this Sidecar.
    /// Returns true if the owner was newly inserted, false if it already owned
    /// this Sidecar (symmetric with `remove_owner`). The Starting-join path uses
    /// this to decide whether a later readiness-timeout detach is safe: only the
    /// call that actually added a *new* owner may remove it on timeout. A
    /// same-owner concurrent ensure (e.g. two `ensure_session_sidecar(.., Tab(t))`
    /// for one tab) gets `false` here, so it must NOT remove the shared owner —
    /// doing so would empty the owner set and kill a Sidecar another caller is
    /// still starting.
    pub fn add_owner(&mut self, owner: SidecarOwner) -> bool {
        self.owners.insert(owner)
    }

    /// Remove an owner from this Sidecar.
    /// Returns `(removed, last_owner_removed)` so stale cleanup is a true no-op.
    pub fn remove_owner(&mut self, owner: &SidecarOwner) -> (bool, bool) {
        let removed = self.owners.remove(owner);
        (removed, removed && self.owners.is_empty())
    }
}

/// Ensure Sidecar process is killed when SessionSidecar is dropped
impl Drop for SessionSidecar {
    fn drop(&mut self) {
        DispatchGate::close_and_wait(&self.dispatch_gate);
        ulog_info!(
            "[sidecar] Drop: killing SessionSidecar for session {} on port {} (state: {:?})",
            self.session_id,
            self.port,
            self.state
        );
        let _ = self.process.terminate();
    }
}

/// Single Sidecar instance (legacy - used only for Global Sidecar).
/// Still uses `healthy: bool` since the Global Sidecar is a singleton
/// without the multi-owner race conditions that motivated `SidecarState`.
pub struct SidecarInstance {
    /// The child process plus exact descendant-containment authority. `None`
    /// exists only while the canonical manager entry reserves an admitted
    /// process birth whose spawn is running outside the manager mutex.
    pub(crate) process: Option<ChildTree>,
    /// Process-lifetime identity. Ports are bounded and may be reused; this
    /// monotonic generation is the exact identity for stale-result rejection.
    pub(crate) generation: u64,
    /// Port this instance is running on
    pub port: u16,
    /// Agent directory (None for global sidecar)
    pub agent_dir: Option<PathBuf>,
    /// Whether the sidecar passed initial health check
    pub healthy: bool,
    /// Whether this is a global sidecar (uses temp directory)
    pub is_global: bool,
    /// Per-process capability proving a Session DELETE request came from the
    /// Rust lifecycle owner after it fenced every live/durable owner.
    pub session_delete_authority: Option<String>,
    /// Admission fence for control requests bound to this process generation.
    pub(crate) dispatch_gate: Arc<DispatchGate>,
    /// When this instance was created — used by health monitor to apply startup grace period.
    /// During the grace window the monitor skips health checks, preventing false "unhealthy"
    /// verdicts while the sidecar is still initialising (TCP check, Bun startup, Plugin Bridge…).
    pub created_at: std::time::Instant,
}

impl SidecarInstance {
    pub(crate) fn is_birth_pending(&self) -> bool {
        self.process.is_none()
    }

    /// Check process liveness independently from HTTP readiness. A Global
    /// candidate is alive while it is starting even though `healthy` is false.
    pub(crate) fn is_process_alive(&mut self) -> bool {
        let Some(process) = self.process.as_mut() else {
            // The birth lease on this entry's gate keeps it manager-owned until
            // the creator either installs the process or abandons the slot.
            return true;
        };
        match process.try_wait() {
            Ok(Some(_)) => {
                self.healthy = false;
                false
            }
            Ok(None) => true,
            Err(_) => {
                self.healthy = false;
                false
            }
        }
    }

    /// Check if the sidecar is both ready for requests and still alive.
    pub fn is_running(&mut self) -> bool {
        self.healthy && self.is_process_alive()
    }
}

/// Ensure Node.js process is killed when SidecarInstance is dropped
impl Drop for SidecarInstance {
    fn drop(&mut self) {
        DispatchGate::close_and_wait(&self.dispatch_gate);
        ulog_info!("[sidecar] Drop: killing process on port {}", self.port);
        if let Some(process) = self.process.as_mut() {
            let _ = process.terminate();
        }

        // Clean up temp directory for global sidecar
        if self.is_global {
            if let Some(ref dir) = self.agent_dir {
                ulog_info!("[sidecar] Cleaning up temp directory: {:?}", dir);
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

/// Sidecar info for external queries
/// Reserved for future use (e.g., admin UI, debugging endpoints)
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarInfo {
    pub port: u16,
    pub workspace_path: String,
    pub is_healthy: bool,
}
