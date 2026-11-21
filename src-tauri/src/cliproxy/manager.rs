// Required context: specs/tech_docs/managed_cliproxy.md; policy selection precedes lifecycle activation.
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::{watch, Mutex, Notify};
use uuid::Uuid;

use super::callback::{validate_authorization_url, Receiver};
use super::client::{AuthStatus, CallbackOutcome, Client};
use super::component::{ComponentStore, Installed};
use super::process::Instance;
use super::store::{AccountRef, Accounts, Store};
use super::types::{Binding, BindingRequest, Error, LeaseRequest, Result};

#[derive(Clone)]
struct Lease {
    sidecar_id: String,
    sidecar_generation: u64,
    operation_id: String,
    model: String,
    binding: Binding,
}
#[derive(Default)]
struct Runtime {
    accounts: Accounts,
    active: Option<Arc<Instance>>,
    candidate: Option<Arc<Instance>>,
    leases: HashMap<String, Lease>,
    operations: super::operations::Operations,
    models: BTreeMap<String, Vec<Value>>,
    model_identities: BTreeMap<String, String>,
    account_errors: BTreeMap<String, Error>,
    emails: BTreeMap<String, String>,
    cancel: Option<watch::Sender<bool>>,
    draining: bool,
    shutting_down: bool,
    ready: bool,
    error: Option<Error>,
    crash_restarts: Vec<Instant>,
}

pub(super) struct CliProxyManager<R: tauri::Runtime = tauri::Wry> {
    app: tauri::AppHandle<R>,
    config_path: std::path::PathBuf,
    sidecars: crate::sidecar::ManagedSidecarManager,
    store: Store,
    pub components: ComponentStore,
    state: Mutex<Runtime>,
    account_operation: Arc<Mutex<()>>,
    active_start: Mutex<()>,
    update_check: Mutex<()>,
    changed: Notify,
    shutdown: watch::Sender<bool>,
}

// A successful oneshot send is not proof that the HTTP awaiter consumed it.
// Keep the grant owned while buffered; dropping either side releases exactly
// this lease until acquire hands it to the existing binding/release protocol.
struct UnclaimedBinding<R: tauri::Runtime> {
    manager: Arc<CliProxyManager<R>>,
    request: LeaseRequest,
    sidecar_generation: u64,
    binding: Option<Binding>,
}
impl<R: tauri::Runtime> UnclaimedBinding<R> {
    fn claim(mut self) -> Binding {
        self.binding
            .take()
            .expect("binding can only be claimed once")
    }
}
impl<R: tauri::Runtime> Drop for UnclaimedBinding<R> {
    fn drop(&mut self) {
        if let Some(binding) = self.binding.take() {
            let manager = Arc::clone(&self.manager);
            let request = LeaseRequest {
                sidecar_id: self.request.sidecar_id.clone(),
                operation_id: self.request.operation_id.clone(),
                lease_id: Some(binding.lease_id),
                terminal: None,
            };
            let generation = self.sidecar_generation;
            tauri::async_runtime::spawn(async move {
                let _ = manager.release(&request, generation).await;
            });
        }
    }
}

impl<R: tauri::Runtime> CliProxyManager<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Result<Arc<Self>> {
        let data = crate::app_dirs::myagents_data_dir().ok_or_else(Error::storage)?;
        let store = Store {
            root: data.join("providers/cliproxy"),
        };
        let accounts = store.read_accounts()?;
        let bundled = if cfg!(debug_assertions) {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/cliproxy")
        } else {
            app.path()
                .resource_dir()
                .map_err(|_| Error::storage())?
                .join("cliproxy")
        };
        let components = ComponentStore::new(
            &data,
            bundled,
            env!("CARGO_PKG_VERSION").to_owned(),
            env!("MYAGENTS_CLAUDE_SDK_VERSION").to_owned(),
        )?;
        let sidecars = app
            .state::<crate::sidecar::ManagedSidecarManager>()
            .inner()
            .clone();
        let (shutdown, _) = watch::channel(false);
        Ok(Arc::new(Self {
            app,
            config_path: data.join("config.json"),
            sidecars,
            store,
            components,
            state: Mutex::new(Runtime {
                accounts,
                active: None,
                candidate: None,
                leases: HashMap::new(),
                models: BTreeMap::new(),
                operations: super::operations::Operations::default(),
                model_identities: BTreeMap::new(),
                account_errors: BTreeMap::new(),
                emails: BTreeMap::new(),
                cancel: None,
                draining: false,
                shutting_down: false,
                ready: false,
                error: None,
                crash_restarts: Vec::new(),
            }),
            account_operation: Arc::new(Mutex::new(())),
            active_start: Mutex::new(()),
            update_check: Mutex::new(()),
            changed: Notify::new(),
            shutdown,
        }))
    }

    pub async fn initialize_serialized(self: &Arc<Self>, had_prior_instance: bool) -> Result<()> {
        if *self.shutdown.borrow() {
            return Err(Error::cancelled());
        }
        if self.state.lock().await.ready {
            return Ok(());
        }
        let _operation = self.account_operation.lock().await;
        if *self.shutdown.borrow() {
            return Err(Error::cancelled());
        }
        if self.state.lock().await.ready {
            return Ok(());
        }
        self.initialize(had_prior_instance).await
    }

    pub async fn prewarm(self: &Arc<Self>) -> Result<()> {
        let has_account = {
            let state = self.state.lock().await;
            state.accounts.active.is_some() && !state.accounts.disconnecting && !state.shutting_down
        };
        if has_account && self.components.controls().await?.allows(cfg!(debug_assertions)) {
            self.ensure_active().await?;
            crate::ulog_info!("[cliproxy] retained account process ready");
        }
        Ok(())
    }

    async fn initialize(self: &Arc<Self>, _had_prior_instance: bool) -> Result<()> {
        let roots = vec![
            self.components.root.clone(),
            self.store.account_root().join("run"),
        ];
        // Called only after App acquired its existing single-instance/data lock.
        {
            let report = tauri::async_runtime::spawn_blocking(move || {
                crate::process_cleanup::kill_stale_processes_with_roots(&[], &roots)
            })
            .await
            .map_err(|_| Error::new("stale_writer", "无法确认上次组件已退出"))?;
            if report.residual > 0 {
                return Err(Error::new("stale_writer", "上次组件尚未退出，暂时无法使用"));
            }
        }
        let run = self.store.account_root().join("run");
        if run.exists() {
            std::fs::remove_dir_all(run).map_err(|_| Error::storage())?;
        }
        self.cleanup().await?;
        if let Err(error) = self.components.collect_garbage().await {
            crate::ulog_warn!("[cliproxy] component cleanup deferred code={}", error.code);
        }
        if let Ok(approval) = self.components.bundled_approval() {
            self.components
                .ingest_controls(&approval, "bundled")
                .await?;
        }
        // Prepare a trusted local choice before starting the online updater.
        // First login can then use immutable local files while a newer package
        // downloads, without waiting for the download's installation lock.
        if self
            .components
            .controls()
            .await
            .is_ok_and(|c| c.allows(cfg!(debug_assertions)))
        {
            if let Err(error) = self.selected(false).await {
                self.state.lock().await.error = Some(error);
            }
        }
        {
            let mut state = self.state.lock().await;
            if let Some(candidate) = &mut state.accounts.candidate {
                // No OAuth state or inferred successful commit survives App exit.
                candidate.phase = "stored".to_owned();
                candidate.verified_model = None;
                candidate.verified_at = None;
                candidate.verification_identity = None;
            }
            self.store.write_accounts(&state.accounts)?;
            state.ready = true;
        }
        self.project_config().await?;
        Ok(())
    }

    fn emit(&self) {
        let _ = self.app.emit("cliproxy:changed", json!({}));
    }
    pub async fn set_error(&self, error: Error) {
        crate::ulog_warn!("[cliproxy] operation failed code={}", error.code);
        self.state.lock().await.error = Some(error);
        self.emit();
    }
    fn check_state(state: &Runtime) -> Result<()> {
        if crate::sidecar::is_update_shutdown_in_progress() {
            return Err(Error::new("app_updating", "应用正在准备更新，请稍候"));
        }
        if !state.ready {
            return Err(Error::new("initializing", "模型组件正在准备"));
        }
        if state.shutting_down || state.accounts.disconnecting {
            return Err(Error::new("cleanup_pending", "组件正在停止或清理，请稍候"));
        }
        Ok(())
    }

    async fn selected(&self, manual: bool) -> Result<Installed> {
        let snapshot = self.components.state.lock().await.clone();
        let (live, has_accounts) = {
            let state = self.state.lock().await;
            (
                state.active.iter().chain(state.candidate.iter()).any(|i| i.alive()),
                state.accounts.active.is_some() || state.accounts.candidate.is_some(),
            )
        };
        let current = snapshot.current.as_ref().map(Installed::component).transpose()?;
        let accepts_accounts = |component: &super::manifest::Component| {
            !has_accounts || current.as_ref().is_none_or(|old| component.accepts_accounts_from(old))
        };
        // A live writer stays on its component until activate_pending drains it.
        let pending = snapshot.pending.as_ref().filter(|_| !live);
        for candidate in pending.into_iter().chain(&snapshot.current).chain(&snapshot.previous) {
            let Ok(component) = self.components.allowed(candidate).await else { continue };
            if !accepts_accounts(&component)
                || (!manual && self.components.failed_attempt(candidate).await.unwrap_or(true))
                || self.components.executable(candidate).is_err()
            {
                continue;
            }
            if live {
                return Ok(candidate.clone());
            }
            let Ok(bundled) = self.components.bundled_installed() else { return Ok(candidate.clone()) };
            let Ok(next) = self.components.allowed(&bundled).await else { return Ok(candidate.clone()) };
            let platform = super::manifest::platform().ok_or_else(Error::contract)?;
            if super::manifest::should_prepare_update(Some(&component), &next, platform, false)?
                && accepts_accounts(&next)
                && (manual || !self.components.failed_attempt(&bundled).await?)
                && self.components.install(&bundled, manual, self.shutdown.subscribe()).await.is_ok()
            {
                return Ok(bundled);
            }
            return Ok(candidate.clone());
        }
        let installed = self.components.bundled_installed()?;
        self.components.ingest_controls(&installed.approval, "bundled").await?;
        if !accepts_accounts(&self.components.allowed(&installed).await?) {
            return Err(Error::new("credential_incompatible", "旧组件无法复用当前账号凭据"));
        }
        self.components
            .install(&installed, manual, self.shutdown.subscribe())
            .await?;
        Ok(installed)
    }

    pub async fn status(&self) -> Value {
        let controls = self.components.controls().await;
        let components = self.components.state.lock().await.clone();
        let version = |item: &Option<Installed>| {
            item.as_ref()
                .and_then(|i| i.component().ok())
                .map(|c| c.version)
        };
        let bundled = self.components.bundled_installed().ok();
        let bundled_version = bundled
            .as_ref()
            .and_then(|i| i.component().ok())
            .map(|c| c.version);
        let availability = components
            .current
            .iter()
            .chain(components.pending.iter())
            .chain(components.previous.iter())
            .chain(bundled.iter())
            .find_map(|item| {
                item.component().ok().and_then(|component| {
                    let artifact = component
                        .artifact(
                            super::manifest::platform()?,
                            &self.components.app_version)
                        .ok()?;
                    controls
                        .as_ref()
                        .ok()
                        .filter(|c| !c.revoked(&component.version, &artifact.sha256))
                        .map(|_| ())
                })
            });
        let policy_error = controls.as_ref().err().cloned().or_else(|| {
            availability
                .is_none()
                .then(|| Error::new("incompatible", "没有适用于当前应用的批准组件，请检查更新"))
        });
        let validity = match policy_error.as_ref().map(|e| e.code.as_str()) {
            None => "valid",
            Some("manifest_missing" | "bundled_missing") => "missing",
            Some("incompatible") => "incompatible",
            Some(_) => "invalid",
        };
        let state = self.state.lock().await;
        let instance_state = |instance: &Option<Arc<Instance>>| match instance {
            Some(instance) if instance.alive() => {
                if instance.ready() {
                    "running"
                } else {
                    "starting"
                }
            }
            Some(_) => "failed",
            None => "stopped",
        };
        let account = |a: &AccountRef| {
            json!({ "generation": a.generation, "email": state.emails.get(&a.generation),
            "status": if state.account_errors.get(&a.generation).is_some_and(|e| matches!(e.code.as_str(), "reauth_required" | "account_not_saved")) {
                "reauth-required"
            } else { "connected" },
                "error": state.account_errors.get(&a.generation) })
        };
        let candidate = state.accounts.candidate.as_ref().map(|a| {
            json!({ "attemptId": a.attempt_id, "generation": a.generation,
            "phase": a.phase, "email": state.emails.get(&a.generation), "error": state.account_errors.get(&a.generation) })
        });
        let models = state
            .accounts
            .candidate
            .as_ref()
            .or(state.accounts.active.as_ref())
            .and_then(|a| state.models.get(&a.generation))
            .cloned()
            .unwrap_or_default();
        let update = self
            .components
            .update
            .lock()
            .ok()
            .map(|u| json!(&*u))
            .unwrap_or_else(|| json!({"phase":"failed"}));
        json!({
            "policy": { "mode": controls.as_ref().map(|c| c.provider_mode.clone()).unwrap_or(super::manifest::Mode::Disabled),
                "usable": availability.is_some() && controls.as_ref().is_ok_and(|c| c.allows(cfg!(debug_assertions))) && state.ready && !state.accounts.disconnecting && !state.shutting_down && !crate::sidecar::is_update_shutdown_in_progress(),
                "revision": controls.as_ref().map(|c| c.policy_revision).unwrap_or(0), "error": policy_error, "validity": validity, "source": if components.control_source.is_empty() { "cached" } else { &components.control_source } },
            "component": { "version": version(&components.current), "previousVersion": version(&components.previous), "bundledVersion": bundled_version, "phase": if components.current.is_some() || components.pending.is_some() { "installed" } else if update["phase"] == "installing" { "installing" } else if state.error.is_some() { "failed" } else { "missing" }, "source": components.current.as_ref().or(components.pending.as_ref()).map(|i| &i.source) },
            "update": update, "active": state.accounts.active.as_ref().map(account), "candidate": candidate,
            "instances": { "active": if state.draining { "draining" } else { instance_state(&state.active) }, "candidate": instance_state(&state.candidate), "activeGeneration": state.active.as_ref().map(|i| &i.generation), "candidateGeneration": state.candidate.as_ref().map(|i| &i.generation) },
            "cleanup": if state.accounts.cleanup.is_empty() && !state.accounts.disconnecting { Value::Null } else { json!({
                "scope": if state.accounts.disconnecting { "all" } else if state.accounts.candidate.as_ref().is_some_and(|a| state.accounts.cleanup.contains(&a.id)) { "candidate" } else { "retired" },
                "failed": state.error.is_some() }) },
            "modelsStale": state.accounts.candidate.as_ref().or(state.accounts.active.as_ref()).is_some_and(|a| !state.model_identities.contains_key(&a.generation)),
            "models": models, "error": state.error
        })
    }

    pub async fn connect(self: &Arc<Self>) -> Result<Value> {
        self.initialize_serialized(false).await?;
        let guard = Arc::clone(&self.account_operation)
            .try_lock_owned()
            .map_err(|_| Error::new("operation_pending", "账号操作正在进行"))?;
        let (cancel, cancelled) = watch::channel(false);
        let existing = self.state.lock().await.accounts.candidate.clone();
        let resuming = existing.is_some();
        let account = existing.unwrap_or_else(AccountRef::candidate);
        {
            let mut state = self.state.lock().await;
            Self::check_state(&state)?;
            if !state.accounts.cleanup.is_empty() {
                return Err(Error::new("cleanup_pending", "请先完成已有账号操作"));
            }
            let mut next = state.accounts.clone();
            next.candidate = Some(account.clone());
            self.store.write_accounts(&next)?;
            state.accounts = next;
            state.cancel = Some(cancel);
            state.error = None;
        }
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            let result = if resuming {
                manager.resume_login(&account, cancelled.clone()).await
            } else {
                manager.login(&account, cancelled.clone()).await
            };
            if let Err(error) = result {
                crate::ulog_warn!(
                    "[cliproxy] login failed attempt={} code={}",
                    account.attempt_id,
                    error.code
                );
                // OAuth outcome is unknown until native account load succeeds.
                // Stop the sole writer before any candidate directory deletion.
                let authorized = manager
                    .state
                    .lock()
                    .await
                    .accounts
                    .candidate
                    .as_ref()
                    .is_some_and(|a| {
                        a.generation == account.generation
                            && matches!(
                                a.phase.as_str(),
                                "authorized" | "stored" | "waiting-to-commit"
                            )
                    });
                if !authorized {
                    let mut state = manager.state.lock().await;
                    if state
                        .accounts
                        .candidate
                        .as_ref()
                        .is_some_and(|a| a.generation == account.generation)
                    {
                        let mut next = state.accounts.clone();
                        next.begin_cancel_candidate();
                        let saved = manager.store.write_accounts(&next);
                        state.accounts = next;
                        if saved.is_err() {
                            state.error = Some(Error::storage());
                        }
                    }
                    drop(state);
                    let _ = manager.cleanup().await;
                }
                if authorized {
                    if let Err(cleanup_error) =
                        manager.record_account_failure(&account, &error).await
                    {
                        manager.set_error(cleanup_error).await;
                    }
                } else if error.code != "cancelled" {
                    manager.set_error(error).await;
                }
            }
            manager.finish_account_operation().await;
            manager.emit();
        });
        self.emit();
        Ok(self.status().await)
    }

    async fn login(
        self: &Arc<Self>,
        account: &AccountRef,
        cancelled: watch::Receiver<bool>,
    ) -> Result<()> {
        let started = Instant::now();
        let deadline = started + Duration::from_secs(5 * 60);
        log_oauth_step("starting", &account.attempt_id, started, None, "started");
        let receiver = Receiver::bind().await?;
        let start = self.active_start.lock().await;
        let installed = self.selected(true).await?;
        let instance = self
            .start_for(account, &installed, cancelled.clone(), true)
            .await?;
        self.install_candidate_instance(account, Arc::clone(&instance), &cancelled)
            .await?;
        self.components.activate(&installed).await?;
        drop(start);
        let reply = instance.client.auth_url().await;
        log_oauth_step(
            "auth_url",
            &account.attempt_id,
            started,
            reply.http_status,
            reply
                .outcome
                .as_ref()
                .err()
                .map_or("created", |e| e.code.as_str()),
        );
        let auth_url = reply.outcome?;
        validate_authorization_url(&auth_url.url, &auth_url.state)?;
        if *cancelled.borrow() {
            return Err(Error::cancelled());
        }
        crate::browser::open_external(&auth_url.url)
            .map_err(|_| Error::new("browser_open", "无法打开系统浏览器，请重试"))?;
        let callback = match tokio::time::timeout(
            deadline.saturating_duration_since(Instant::now()),
            receiver.receive(&auth_url.state, cancelled.clone()),
        )
        .await
        .unwrap_or_else(|_| Err(Error::new("login_timeout", "浏览器授权已超时，请重新连接")))
        {
            Ok(callback) => callback,
            Err(error) => {
                let _ = instance.client.cancel_oauth(&auth_url.state).await;
                return Err(error);
            }
        };
        log_oauth_step(
            "browser_callback",
            &account.attempt_id,
            started,
            None,
            "received",
        );
        finish_oauth(
            &instance.client,
            &auth_url.state,
            callback,
            started,
            deadline,
            cancelled.clone(),
            &account.attempt_id,
        )
        .await?;
        self.complete_authorization(account, &installed, &instance, cancelled)
            .await
    }

    async fn resume_login(
        &self,
        account: &AccountRef,
        cancelled: watch::Receiver<bool>,
    ) -> Result<()> {
        let start = self.active_start.lock().await;
        let installed = self.selected(true).await?;
        let existing = self
            .state
            .lock()
            .await
            .candidate
            .clone()
            .filter(|i| i.account_generation == account.generation && i.alive());
        let instance = match existing {
            Some(instance) => instance,
            None => {
                self.start_for(account, &installed, cancelled.clone(), true)
                    .await?
            }
        };
        drop(start);
        self.complete_authorization(account, &installed, &instance, cancelled)
            .await
    }

    async fn complete_authorization(
        &self,
        account: &AccountRef,
        installed: &Installed,
        instance: &Arc<Instance>,
        cancelled: watch::Receiver<bool>,
    ) -> Result<()> {
        let summary = instance
            .client
            .account()
            .await?
            .ok_or_else(|| Error::new("account_not_saved", "账号授权未保存，请重新连接"))?;
        crate::ulog_info!(
            "[cliproxy] oauth phase=account_summary attempt={} outcome=confirmed",
            account.attempt_id
        );
        self.record_authorization(account, summary, &cancelled)
            .await?;
        self.commit(account, installed, instance, cancelled).await?;
        self.project_config().await?;
        self.emit();
        crate::ulog_info!(
            "[cliproxy] oauth phase=account_commit attempt={} outcome=connected",
            account.attempt_id
        );
        crate::ulog_info!("[cliproxy] account connected; refreshing native model catalog");
        // Model discovery is independent of the durable login commit.
        let formal = self
            .state
            .lock()
            .await
            .active
            .clone()
            .ok_or_else(Error::cancelled)?;
        let result = self.refresh_for(account, &formal, installed).await;
        self.project_config().await?;
        self.emit();
        result.map(|_| ())
    }

    async fn record_authorization(
        &self,
        account: &AccountRef,
        summary: super::client::Account,
        cancelled: &watch::Receiver<bool>,
    ) -> Result<()> {
        if summary.disabled {
            return Err(Error::new("reauth_required", "账号当前不可用，请重新连接"));
        }
        {
            let mut state = self.state.lock().await;
            Self::check_state(&state)?;
            if *cancelled.borrow() || state.accounts.cleanup.contains(&account.id) {
                return Err(Error::cancelled());
            }
            let candidate = state
                .accounts
                .candidate
                .as_mut()
                .filter(|a| a.generation == account.generation)
                .ok_or_else(Error::cancelled)?;
            candidate.phase = "authorized".to_owned();
            candidate
                .authorized_at
                .get_or_insert_with(|| chrono::Utc::now().to_rfc3339());
            self.store.write_accounts(&state.accounts)?;
            state.account_errors.remove(&account.generation);
            if let Some(email) = summary.email {
                state.emails.insert(account.generation.clone(), email);
            }
        }
        Ok(())
    }

    async fn start_for(
        &self,
        account: &AccountRef,
        installed: &Installed,
        cancelled: watch::Receiver<bool>,
        manual: bool,
    ) -> Result<Arc<Instance>> {
        self.components.allowed(installed).await?;
        let auth_dir = self.store.auth_dir(&account.id)?;
        {
            let mut state = self.state.lock().await;
            Self::check_state(&state)?;
            if state.accounts.cleanup.contains(&account.id)
                || !state
                    .accounts
                    .active
                    .iter()
                    .chain(state.accounts.candidate.iter())
                    .any(|a| a.generation == account.generation)
            {
                return Err(Error::cancelled());
            }
            let first_authorization =
                state.accounts.candidate.as_ref().is_some_and(|a| {
                    a.generation == account.generation && a.phase == "authorizing"
                });
            if !first_authorization && !auth_dir.is_dir() {
                let error = Error::new("account_not_saved", "账号凭据目录已丢失，请重新连接");
                state
                    .account_errors
                    .insert(account.generation.clone(), error.clone());
                return Err(error);
            }
        }
        self.store.create_account(&account.id)?;
        let executable = self.components.executable(installed)?;
        {
            let state = self.state.lock().await;
            if state
                .active
                .iter()
                .chain(state.candidate.iter())
                .any(|i| i.account_generation == account.generation && i.alive())
            {
                return Err(Error::new(
                    "process_stop",
                    "此账号的旧组件尚未退出，请重试清理",
                ));
            }
        }
        if *cancelled.borrow() {
            return Err(Error::cancelled());
        }
        self.components.begin_attempt(installed, manual).await?;
        let instance = Instance::spawn(
            &executable,
            &auth_dir,
            &self.store.account_root().join("run"),
            &account.generation,
            &installed.identity(&self.components.app_version, &self.components.sdk_version)?,
        )?;
        {
            let mut state = self.state.lock().await;
            if state
                .accounts
                .candidate
                .as_ref()
                .is_some_and(|a| a.generation == account.generation)
            {
                state.candidate = Some(Arc::clone(&instance));
            } else {
                state.active = Some(Arc::clone(&instance));
            }
        }
        if let Err(error) = instance.wait_ready(cancelled).await {
            instance.stop().await?;
            if error.code == "cancelled" {
                self.components.clear_attempt(installed).await?;
            }
            let mut state = self.state.lock().await;
            if state
                .active
                .as_ref()
                .is_some_and(|i| i.generation == instance.generation)
            {
                state.active = None;
            }
            if state
                .candidate
                .as_ref()
                .is_some_and(|i| i.generation == instance.generation)
            {
                state.candidate = None;
            }
            return Err(error);
        }
        self.components.clear_attempt(installed).await?;
        Ok(instance)
    }

    async fn install_candidate_instance(
        &self,
        account: &AccountRef,
        instance: Arc<Instance>,
        cancelled: &watch::Receiver<bool>,
    ) -> Result<()> {
        let mut state = self.state.lock().await;
        if *cancelled.borrow()
            || state.shutting_down
            || state.accounts.disconnecting
            || state.accounts.cleanup.contains(&account.id)
            || !state
                .accounts
                .candidate
                .as_ref()
                .is_some_and(|a| a.generation == account.generation)
        {
            drop(state);
            instance.stop().await?;
            return Err(Error::cancelled());
        }
        state.candidate = Some(instance);
        Ok(())
    }

    async fn refresh_for(
        &self,
        account: &AccountRef,
        instance: &Instance,
        installed: &Installed,
    ) -> Result<Vec<Value>> {
        // Preserve the last successful list for display, but a failed refresh
        // must not continue advertising that list as current admission proof.
        self.state
            .lock()
            .await
            .model_identities
            .remove(&account.generation);
        let result = self.refresh_for_inner(account, instance, installed).await;
        let mut state = self.state.lock().await;
        if state
            .accounts
            .active
            .iter()
            .chain(state.accounts.candidate.iter())
            .any(|a| a.generation == account.generation)
        {
            match &result {
                Ok(_) => {
                    state.account_errors.remove(&account.generation);
                }
                Err(error) => {
                    state
                        .account_errors
                        .insert(account.generation.clone(), error.clone());
                }
            }
        }
        result
    }

    async fn refresh_for_inner(
        &self,
        account: &AccountRef,
        instance: &Instance,
        installed: &Installed,
    ) -> Result<Vec<Value>> {
        self.components.allowed(installed).await?;
        let summary = instance
            .client
            .account()
            .await?
            .ok_or_else(|| Error::new("account_not_saved", "账号授权未保存，请重新连接"))?;
        if summary.disabled {
            return Err(Error::new("reauth_required", "账号当前不可用，请检查连接"));
        }
        let (registered, routed, definitions) = tokio::join!(
            instance.client.registered_models(&summary.name),
            instance.client.routed_models(),
            instance.client.definitions()
        );
        // Native views can refresh independently. Metadata is enrichment, not admission.
        let (registered, routed) = match (registered, routed) {
            (Err(error), Err(_)) => return Err(error),
            (registered, routed) => (registered.unwrap_or_default(), routed.unwrap_or_default()),
        };
        let definitions = definitions.unwrap_or_default();
        crate::ulog_info!(
            "[cliproxy] native model catalog registered={} routed={} definitions={}",
            registered.len(),
            routed.len(),
            definitions.len()
        );
        let models = super::models::project(&registered, &routed, &definitions)?;
        let mut state = self.state.lock().await;
        if !state
            .accounts
            .active
            .iter()
            .chain(state.accounts.candidate.iter())
            .any(|a| a.generation == account.generation)
            || state.accounts.cleanup.contains(&account.id)
            || state.accounts.disconnecting
        {
            return Err(Error::cancelled());
        }
        state
            .models
            .insert(account.generation.clone(), models.clone());
        state.model_identities.insert(
            account.generation.clone(),
            instance.component_identity.clone(),
        );
        if let Some(email) = summary.email {
            state.emails.insert(account.generation.clone(), email);
        }
        Ok(models)
    }

    async fn record_account_failure(&self, account: &AccountRef, error: &Error) -> Result<()> {
        if error.code == "cancelled" {
            return Ok(());
        }
        crate::ulog_warn!("[cliproxy] account operation failed code={}", error.code);
        let cleanup = {
            let mut state = self.state.lock().await;
            if !state
                .accounts
                .active
                .iter()
                .chain(state.accounts.candidate.iter())
                .any(|a| a.generation == account.generation)
            {
                return Ok(());
            }
            state
                .account_errors
                .insert(account.generation.clone(), error.clone());
            let incomplete = error.code == "account_not_saved"
                && state.accounts.candidate.as_ref().is_some_and(|a| {
                    a.generation == account.generation && a.phase != "authorizing"
                });
            if incomplete {
                // Cleanup removes this generation and its scoped error. Keep
                // the failed connection result at the operation owner, without
                // marking the still-valid active account as failed.
                state.error = Some(error.clone());
                let mut next = state.accounts.clone();
                next.begin_cancel_candidate();
                let saved = self.store.write_accounts(&next);
                state.accounts = next;
                saved?;
            }
            incomplete
        };
        if cleanup {
            self.cleanup().await?;
        }
        self.project_config().await?;
        self.emit();
        Ok(())
    }

    async fn finish_account_operation(&self) {
        let mut state = self.state.lock().await;
        state.cancel = None;
        if let Some(candidate) = &mut state.accounts.candidate {
            if candidate.phase == "waiting-to-commit" {
                candidate.phase = "stored".to_owned();
                if let Err(error) = self.store.write_accounts(&state.accounts) {
                    state.error = Some(error);
                }
            }
        }
    }

    async fn commit(
        &self,
        account: &AccountRef,
        installed: &Installed,
        candidate: &Arc<Instance>,
        cancelled: watch::Receiver<bool>,
    ) -> Result<()> {
        let _start = self.active_start.lock().await;
        {
            let mut state = self.state.lock().await;
            state.draining = true;
            if let Some(next) = &mut state.accounts.candidate {
                next.phase = "waiting-to-commit".to_owned();
            }
        }
        self.emit();
        let result = async {
            self.drain(false, &cancelled).await?;
            let active = self.state.lock().await.active.clone();
            if let Some(active) = active {
                active.stop().await?;
            }
            candidate.stop().await?;
            self.state.lock().await.candidate = None;
            if *cancelled.borrow() {
                return Err(Error::cancelled());
            }
            let formal = self
                .start_for(account, installed, cancelled.clone(), false)
                .await?;
            self.state.lock().await.candidate = Some(Arc::clone(&formal));
            let commit = async {
                self.components.allowed(installed).await?;
                // Component activation is an independently recoverable local
                // fact. Do it before the single account commit point.
                self.components.activate(installed).await?;
                let mut state = self.state.lock().await;
                Self::check_state(&state)?;
                if *cancelled.borrow() {
                    return Err(Error::cancelled());
                }
                let mut next = state.accounts.clone();
                next.commit_candidate(&account.generation)?;
                let saved = self.store.write_accounts(&next);
                if saved
                    .as_ref()
                    .is_err_and(|error| error.code != "storage_sync")
                {
                    return saved;
                }
                state.accounts = next;
                state.active = Some(Arc::clone(&formal));
                state.candidate = None;
                state.draining = false;
                saved
            }
            .await;
            if commit.is_err() {
                formal.stop().await?;
            }
            commit?;
            self.cleanup().await
        }
        .await;
        if result.is_err() {
            // Only a pre-commit failure may restore the previous account.
            // Once the account pointer moved, never silently fall back.
            let old = {
                let state = self.state.lock().await;
                state
                    .accounts
                    .active
                    .as_ref()
                    .filter(|a| a.generation != account.generation && !state.accounts.disconnecting)
                    .cloned()
            };
            if let Some(old) = old {
                let needs_start = {
                    let state = self.state.lock().await;
                    !state.active.as_ref().is_some_and(|i| i.alive())
                };
                if needs_start {
                    if let Ok(instance) = self
                        .start_for(&old, installed, self.shutdown.subscribe(), false)
                        .await
                    {
                        self.state.lock().await.active = Some(instance);
                    }
                }
            }
        }
        self.state.lock().await.draining = false;
        self.changed.notify_waiters();
        result
    }

    pub async fn cancel(&self, attempt: &str) -> Result<Value> {
        let generation = {
            let mut state = self.state.lock().await;
            if state
                .accounts
                .active
                .as_ref()
                .is_some_and(|a| a.attempt_id == attempt)
            {
                drop(state);
                return Ok(self.status().await);
            }
            if !state
                .accounts
                .candidate
                .as_ref()
                .is_some_and(|a| a.attempt_id == attempt)
            {
                return Err(Error::cancelled());
            }
            let generation = state
                .accounts
                .candidate
                .as_ref()
                .ok_or_else(Error::cancelled)?
                .generation
                .clone();
            if let Some(cancel) = &state.cancel {
                let _ = cancel.send(true);
            }
            let mut next = state.accounts.clone();
            next.begin_cancel_candidate();
            if let Err(error) = self.store.write_accounts(&next) {
                state.accounts = next;
                return Err(error);
            }
            state.accounts = next;
            generation
        };
        self.changed.notify_waiters();
        let leases: Vec<_> = self
            .state
            .lock()
            .await
            .leases
            .values()
            .filter(|lease| lease.binding.account_generation == generation)
            .cloned()
            .collect();
        for lease in leases {
            let _ = self.notify_consumer(&lease, "stop").await;
        }
        let _guard = self.account_operation.lock().await;
        self.cleanup().await?;
        self.project_config().await?;
        self.emit();
        Ok(self.status().await)
    }

    pub async fn disconnect(&self) -> Result<Value> {
        {
            let mut state = self.state.lock().await;
            if let Some(cancel) = &state.cancel {
                let _ = cancel.send(true);
            }
            let mut next = state.accounts.clone();
            next.begin_disconnect();
            let saved = self.store.write_accounts(&next);
            state.accounts = next;
            saved?;
        }
        self.changed.notify_waiters();
        self.stop_consumers().await;
        let _guard = self.account_operation.lock().await;
        let _start = self.active_start.lock().await;
        self.cleanup().await?;
        self.project_config().await?;
        self.emit();
        Ok(self.status().await)
    }

    pub async fn retry_cleanup(self: &Arc<Self>) -> Result<Value> {
        let operation = self.account_operation.lock().await;
        let start = self.active_start.lock().await;
        {
            let state = self.state.lock().await;
            // Also retries a deletion intent whose first disk write failed.
            // It must never broaden candidate/retired cleanup to the active account.
            self.store.write_accounts(&state.accounts)?;
        }
        self.cleanup().await?;
        let initializing = !self.state.lock().await.ready;
        if initializing {
            // No execution was admitted before ready. Re-run startup recovery
            // under the same operation lock after its failed cleanup is fixed.
            self.initialize(false).await?;
        }
        self.state.lock().await.error = None;
        self.project_config().await?;
        drop(start);
        drop(operation);
        self.emit();
        Ok(self.status().await)
    }

    async fn cleanup(&self) -> Result<()> {
        let (ids, instances) = {
            let state = self.state.lock().await;
            let ids = state.accounts.cleanup.clone();
            let targets: Vec<_> = state
                .active
                .iter()
                .chain(state.candidate.iter())
                .filter(|instance| {
                    state
                        .accounts
                        .active
                        .iter()
                        .chain(state.accounts.candidate.iter())
                        .any(|a| a.generation == instance.account_generation && ids.contains(&a.id))
                })
                .cloned()
                .collect();
            (ids, targets)
        };
        for instance in instances {
            instance.stop().await?;
        }
        for id in &ids {
            self.store.remove_account(id)?;
        }
        let mut state = self.state.lock().await;
        let mut next = state.accounts.clone();
        if next.active.as_ref().is_some_and(|a| ids.contains(&a.id)) {
            next.active = None;
            state.active = None;
        }
        if next.candidate.as_ref().is_some_and(|a| ids.contains(&a.id)) {
            next.candidate = None;
            state.candidate = None;
        }
        next.cleanup.retain(|id| !ids.contains(id));
        if next.cleanup.is_empty() {
            next.disconnecting = false;
        }
        self.store.write_accounts(&next)?;
        state.accounts = next;
        let generations: Vec<_> = state
            .accounts
            .active
            .iter()
            .chain(state.accounts.candidate.iter())
            .map(|a| a.generation.clone())
            .collect();
        state.models.retain(|g, _| generations.contains(g));
        state.emails.retain(|g, _| generations.contains(g));
        state
            .model_identities
            .retain(|g, _| generations.contains(g));
        state.account_errors.retain(|g, _| generations.contains(g));
        Ok(())
    }

    pub async fn refresh(self: &Arc<Self>, generation: &str) -> Result<Vec<Value>> {
        self.initialize_serialized(false).await?;
        let _guard = self
            .account_operation
            .try_lock()
            .map_err(|_| Error::new("operation_pending", "账号操作正在进行"))?;
        let _start = self.active_start.lock().await;
        let (account, instance) = {
            let state = self.state.lock().await;
            Self::check_state(&state)?;
            let account = state
                .accounts
                .candidate
                .iter()
                .chain(state.accounts.active.iter())
                .find(|a| a.generation == generation)
                .cloned()
                .ok_or_else(Error::cancelled)?;
            let instance = state
                .candidate
                .iter()
                .chain(state.active.iter())
                .find(|i| i.account_generation == generation && i.alive())
                .cloned();
            (account, instance)
        };
        let result = async {
            let installed = self.selected(false).await?;
            let instance = match instance {
                Some(instance) => instance,
                None => {
                    let instance = self
                        .start_for(&account, &installed, self.shutdown.subscribe(), false)
                        .await?;
                    let mut state = self.state.lock().await;
                    if state
                        .accounts
                        .candidate
                        .as_ref()
                        .is_some_and(|a| a.generation == generation)
                    {
                        state.candidate = Some(Arc::clone(&instance));
                    } else {
                        state.active = Some(Arc::clone(&instance));
                    }
                    drop(state);
                    if let Err(error) = self.components.activate(&installed).await {
                        instance.stop().await?;
                        return Err(error);
                    }
                    instance
                }
            };
            self.refresh_for(&account, &instance, &installed).await
        }
        .await;
        if let Err(error) = &result {
            self.record_account_failure(&account, error).await?;
        }
        self.project_config().await?;
        self.emit();
        result
    }

    async fn ensure_active(self: &Arc<Self>) -> Result<(Arc<Instance>, Installed)> {
        let _start = self.active_start.lock().await;
        let installed = self.selected(false).await?;
        let identity =
            installed.identity(&self.components.app_version, &self.components.sdk_version)?;
        let (account, old) = {
            let state = self.state.lock().await;
            Self::check_state(&state)?;
            if state.draining {
                return Err(Error::new("draining", "正在切换模型组件，请稍候"));
            }
            let account =
                state.accounts.active.clone().ok_or_else(|| {
                    Error::new("account_unavailable", "请先登录 Antigravity 账号")
                })?;
            if let Some(active) = &state.active {
                if active.alive() && active.component_identity == identity {
                    if active.proxy_environment != super::process::proxy_environment() {
                        self.schedule_proxy_reconcile();
                        return Err(Error::new("draining", "网络设置已变更，正在切换模型连接"));
                    }
                    let active = Arc::clone(active);
                    let fresh = state.model_identities.get(&account.generation) == Some(&identity);
                    drop(state);
                    if !fresh {
                        let _ = self.refresh_for(&account, &active, &installed).await;
                        self.project_config().await?;
                    }
                    return Ok((active, installed));
                }
            }
            (account, state.active.clone())
        };
        if let Some(old) = old {
            let mut state = self.state.lock().await;
            if old.alive() {
                return Err(Error::new("draining", "组件正在等待安全切换"));
            }
            state
                .leases
                .retain(|_, lease| lease.binding.instance_generation != old.generation);
            if old.born_at.elapsed() >= Duration::from_secs(600) {
                state.crash_restarts.clear();
            }
            state
                .crash_restarts
                .retain(|at| at.elapsed() < Duration::from_secs(600));
            if state.crash_restarts.len() >= 2 {
                return Err(Error::new(
                    "retry_required",
                    "组件连续退出，请检查连接后手动重试",
                ));
            }
            state.crash_restarts.push(Instant::now());
            drop(state);
            old.stop().await?;
        }
        let instance = self
            .start_for(&account, &installed, self.shutdown.subscribe(), false)
            .await?;
        let _ = self.refresh_for(&account, &instance, &installed).await;
        let mut state = self.state.lock().await;
        if Self::check_state(&state).is_err()
            || state.draining
            || !state
                .accounts
                .active
                .as_ref()
                .is_some_and(|a| a.generation == account.generation)
        {
            drop(state);
            instance.stop().await?;
            return Err(Error::cancelled());
        }
        state.active = Some(Arc::clone(&instance));
        drop(state);
        self.activate_started(&installed, &instance).await?;
        Ok((instance, installed))
    }

    async fn activate_started(&self, installed: &Installed, instance: &Instance) -> Result<()> {
        if let Err(error) = self.components.activate(installed).await {
            // Pre-rename failure leaves current unchanged: retire this writer
            // before the next selection can return the retained component.
            // Post-rename failure has published the new pointer; retain it.
            if error.code != "storage_sync" {
                instance.stop().await?;
                let mut state = self.state.lock().await;
                if state
                    .active
                    .as_ref()
                    .is_some_and(|i| i.generation == instance.generation)
                {
                    state.active = None;
                }
            }
            return Err(error);
        }
        Ok(())
    }

    pub async fn acquire(
        self: &Arc<Self>,
        request: BindingRequest,
        sidecar_generation: u64,
    ) -> Result<Binding> {
        // Component birth belongs to the App, not the HTTP awaiter. A model
        // switch or caller timeout must not drop start_for between publishing
        // its child and completing readiness/attempt/pointer settlement.
        let manager = Arc::clone(self);
        let (reply, received) = tokio::sync::oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let abandoned = LeaseRequest {
                sidecar_id: request.sidecar_id.clone(),
                operation_id: request.operation_id.clone(),
                lease_id: None,
                terminal: None,
            };
            let result = manager.acquire_owned(request, sidecar_generation).await;
            let result = result.map(|binding| UnclaimedBinding {
                manager,
                request: abandoned,
                sidecar_generation,
                binding: Some(binding),
            });
            // Failed send or unread buffered value both drop the grant owner.
            let _ = reply.send(result);
        });
        received
            .await
            .map_err(|_| Error::cancelled())?
            .map(UnclaimedBinding::claim)
    }

    async fn acquire_owned(
        self: &Arc<Self>,
        request: BindingRequest,
        sidecar_generation: u64,
    ) -> Result<Binding> {
        if Uuid::parse_str(&request.operation_id).is_err()
            || request.model.is_empty()
            || request.model.len() > 256
            || request.model.chars().any(char::is_control)
        {
            return Err(Error::contract());
        }
        // Only managed-provider bindings join initialization. This runs in
        // the App-owned acquire task, so a cancelled HTTP waiter cannot abort
        // startup cleanup or leave a half-initialized component behind.
        self.initialize_serialized(false).await?;
        let key = format!(
            "{}:{sidecar_generation}:{}",
            request.sidecar_id, request.operation_id
        );
        self.reconcile_dead_leases().await;
        let identity = request.model.clone();
        loop {
            // Register notification before observing the slot; a concurrent
            // completion cannot be lost between unlock and await.
            let notified = self.changed.notified();
            let mut state = self.state.lock().await;
            if state
                .operations
                .begin(&key, &request.sidecar_id, sidecar_generation, &identity)?
            {
                break;
            }
            if let Some(lease) = state.leases.get(&key) {
                return Ok(lease.binding.clone());
            }
            if state.operations.phase(&key) != Some(super::operations::Phase::Preparing) {
                return Err(Error::cancelled());
            }
            drop(state);
            notified.await;
        }
        let result = self
            .acquire_prepared(&request, sidecar_generation, &key)
            .await;
        if result.is_err() {
            self.state.lock().await.operations.release(
                &key,
                &request.sidecar_id,
                sidecar_generation,
            );
        }
        self.changed.notify_waiters();
        result
    }

    async fn acquire_prepared(
        self: &Arc<Self>,
        request: &BindingRequest,
        sidecar_generation: u64,
        key: &str,
    ) -> Result<Binding> {
        let (instance, installed) = self.ensure_active().await?;
        self.components.allowed(&installed).await?;
        if installed.identity(&self.components.app_version, &self.components.sdk_version)?
            != instance.component_identity
        {
            return Err(Error::cancelled());
        }
        let mut state = self.state.lock().await;
        Self::check_state(&state)?;
        if state.draining {
            return Err(Error::new("draining", "正在等待当前任务结束后切换"));
        }
        if let Some(lease) = state.leases.get(key) {
            if lease.model != request.model
                || lease.binding.instance_generation != instance.generation
            {
                return Err(Error::contract());
            }
            return Ok(lease.binding.clone());
        }
        let binding = Binding {
            provider_id: "antigravity-sub".to_owned(),
            base_url: instance.client.base_url().to_owned(),
            api_key: instance.client.model_key().to_owned(),
            instance_generation: instance.generation.clone(),
            account_generation: instance.account_generation.clone(),
            lease_id: Uuid::new_v4().to_string(),
            model_policy: {
                let model = state
                    .models
                    .get(&instance.account_generation)
                    .and_then(|models| models.iter().find(|m| m["model"] == request.model))
                    .cloned()
                    .unwrap_or(Value::Null);
                super::types::ModelPolicy {
                    id: request.model.clone(),
                    thinking: model["thinking"].as_bool(),
                    context_length: model["contextLength"].as_u64(),
                    max_output_tokens: model["maxOutputTokens"].as_u64(),
                }
            },
        };
        state.operations.acquire(key)?;
        state.leases.insert(
            key.to_owned(),
            Lease {
                sidecar_id: request.sidecar_id.clone(),
                sidecar_generation,
                operation_id: request.operation_id.clone(),
                model: request.model.clone(),
                binding: binding.clone(),
            },
        );
        Ok(binding)
    }

    pub async fn check_lease(
        self: &Arc<Self>,
        request: &LeaseRequest,
        sidecar_generation: u64,
    ) -> Result<()> {
        if let Some(terminal) = request.terminal {
            return self
                .record_terminal(request, sidecar_generation, terminal)
                .await;
        }
        let key = format!(
            "{}:{sidecar_generation}:{}",
            request.sidecar_id, request.operation_id
        );
        let installed = self.selected(false).await?;
        self.components.allowed(&installed).await?;
        {
            let state = self.state.lock().await;
            let lease = state
                .leases
                .get(&key)
                .filter(|lease| Some(&lease.binding.lease_id) == request.lease_id.as_ref())
                .ok_or_else(Error::cancelled)?;
            let instance = state
                .active
                .iter()
                .chain(state.candidate.iter())
                .find(|instance| instance.generation == lease.binding.instance_generation)
                .cloned()
                .ok_or_else(Error::cancelled)?;
            if instance.proxy_environment != super::process::proxy_environment() {
                self.schedule_proxy_reconcile();
                return Err(Error::new("draining", "网络设置已变更，正在切换模型连接"));
            }
        }
        let state = self.state.lock().await;
        Self::check_state(&state)?;
        if state.draining {
            return Err(Error::new("draining", "组件正在等待当前任务结束后切换"));
        }
        let lease = state
            .leases
            .get(&key)
            .filter(|lease| Some(&lease.binding.lease_id) == request.lease_id.as_ref())
            .ok_or_else(Error::cancelled)?;
        if !state
            .active
            .iter()
            .chain(state.candidate.iter())
            .any(|instance| {
                instance.generation == lease.binding.instance_generation && instance.alive()
            })
        {
            return Err(Error::new(
                "binding_expired",
                "组件连接已变更，请重新准备请求",
            ));
        }
        Ok(())
    }

    async fn record_terminal(
        &self,
        request: &LeaseRequest,
        sidecar_generation: u64,
        terminal: super::types::TerminalOutcome,
    ) -> Result<()> {
        let key = format!(
            "{}:{sidecar_generation}:{}",
            request.sidecar_id, request.operation_id
        );
        let mut state = self.state.lock().await;
        let lease = state
            .leases
            .get(&key)
            .filter(|lease| request.lease_id.as_ref() == Some(&lease.binding.lease_id))
            .cloned()
            .ok_or_else(Error::cancelled)?;
        let identity = state
            .active
            .iter()
            .chain(state.candidate.iter())
            .find(|i| i.generation == lease.binding.instance_generation)
            .map(|i| i.component_identity.clone())
            .ok_or_else(Error::cancelled)?;
        let mut next = state.accounts.clone();
        if next.disconnecting {
            return Err(Error::cancelled());
        }
        let account = next
            .active
            .iter_mut()
            .chain(next.candidate.iter_mut())
            .find(|a| {
                a.generation == lease.binding.account_generation && !next.cleanup.contains(&a.id)
            })
            .ok_or_else(Error::cancelled)?;
        account.model_checks.insert(
            lease.model,
            super::store::ModelCheck {
                status: terminal,
                checked_at: chrono::Utc::now().to_rfc3339(),
                component_identity: identity,
            },
        );
        let saved = self.store.write_accounts(&next);
        if saved.is_ok() || saved.as_ref().is_err_and(|e| e.code == "storage_sync") {
            state.accounts = next;
        }
        drop(state);
        self.emit();
        saved
    }

    pub async fn release(&self, request: &LeaseRequest, sidecar_generation: u64) -> Result<()> {
        if Uuid::parse_str(&request.operation_id).is_err() {
            return Err(Error::contract());
        }
        let key = format!(
            "{}:{sidecar_generation}:{}",
            request.sidecar_id, request.operation_id
        );
        let mut state = self.state.lock().await;
        if let Some(lease) = state.leases.get(&key) {
            if request
                .lease_id
                .as_ref()
                .is_some_and(|id| id != &lease.binding.lease_id)
            {
                return Err(Error::contract());
            }
            state.leases.remove(&key);
        }
        state
            .operations
            .release(&key, &request.sidecar_id, sidecar_generation);
        self.changed.notify_waiters();
        Ok(())
    }

    pub async fn reconcile_dead_leases(&self) {
        let mut state = self.state.lock().await;
        if let Ok(sidecars) = self.sidecars.lock() {
            state.leases.retain(|_, lease| {
                sidecars.is_live_process(&lease.sidecar_id, lease.sidecar_generation)
            });
            state
                .operations
                .reconcile(|id, generation| sidecars.is_live_process(id, generation));
        }
        self.changed.notify_waiters();
    }

    async fn notify_consumer(&self, lease: &Lease, action: &str) -> Result<()> {
        let dispatch = self
            .sidecars
            .lock()
            .map_err(|_| Error::contract())?
            .acquire_process_dispatch(&lease.sidecar_id, lease.sidecar_generation)
            .map_err(|_| Error::new("consumer_unavailable", "执行进程已不可达"))?;
        let url = dispatch
            .url_for_path("/api/cliproxy/control")
            .map_err(|_| Error::contract())?;
        let response = crate::local_http::json_client(Duration::from_secs(5)).post(url).json(&json!({
            "action": action, "operationId": lease.operation_id, "leaseId": lease.binding.lease_id,
            "instanceGeneration": lease.binding.instance_generation
        })).send().await.map_err(|_| Error::new("consumer_unavailable", "执行进程已不可达"))?;
        if !response.status().is_success() {
            return Err(Error::new("consumer_unavailable", "执行进程未确认资源释放"));
        }
        let result = super::client::bounded_json(response).await?;
        if result["success"] != true {
            return Err(Error::contract());
        }
        if result["settled"] == true {
            self.release(
                &LeaseRequest {
                    sidecar_id: lease.sidecar_id.clone(),
                    operation_id: lease.operation_id.clone(),
                    lease_id: Some(lease.binding.lease_id.clone()),
                    terminal: None,
                },
                lease.sidecar_generation,
            )
            .await?;
        }
        Ok(())
    }

    async fn drain(&self, immediate: bool, cancelled: &watch::Receiver<bool>) -> Result<()> {
        loop {
            if *cancelled.borrow() {
                return Err(Error::cancelled());
            }
            self.reconcile_dead_leases().await;
            let leases: Vec<_> = self.state.lock().await.leases.values().cloned().collect();
            if leases.is_empty() {
                return Ok(());
            }
            for lease in &leases {
                if *cancelled.borrow() {
                    return Err(Error::cancelled());
                }
                let _ = self
                    .notify_consumer(lease, if immediate { "stop" } else { "drain" })
                    .await;
            }
            if immediate {
                return Ok(());
            }
            // Only an in-progress drain reconciles its existing owners. No
            // independent heartbeat or lease expiry may kill admitted work.
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(5)) => {},
                _ = self.changed.notified() => {},
            }
        }
    }

    async fn stop_consumers(&self) {
        let leases: Vec<_> = self.state.lock().await.leases.values().cloned().collect();
        for lease in &leases {
            let _ = self.notify_consumer(lease, "stop").await;
        }
        let instances: Vec<_> = {
            let state = self.state.lock().await;
            state
                .active
                .iter()
                .chain(state.candidate.iter())
                .cloned()
                .collect()
        };
        for instance in instances {
            if instance.stop().await.is_ok() {
                let mut state = self.state.lock().await;
                if state
                    .active
                    .as_ref()
                    .is_some_and(|i| i.generation == instance.generation)
                {
                    state.active = None;
                }
                if state
                    .candidate
                    .as_ref()
                    .is_some_and(|i| i.generation == instance.generation)
                {
                    state.candidate = None;
                }
            }
        }
        self.state.lock().await.leases.clear();
        self.changed.notify_waiters();
    }

    pub async fn check_updates(self: &Arc<Self>, manual: bool) -> Result<()> {
        if crate::sidecar::is_update_shutdown_in_progress() {
            return Err(Error::new("app_updating", "应用正在准备更新，请稍候"));
        }
        if !self.state.lock().await.ready {
            if !manual {
                return Err(Error::new("initializing", "模型组件正在准备"));
            }
            let _operation = self.account_operation.lock().await;
            if !self.state.lock().await.ready {
                self.initialize(false).await?;
            }
        }
        let Ok(_check) = self.update_check.try_lock() else {
            return Ok(());
        };
        if *self.shutdown.borrow() {
            return Err(Error::cancelled());
        }
        let result = self.check_updates_inner(manual).await;
        if let Err(error) = &result {
            self.components
                .set_update("failed", None, Some(error.clone()));
        }
        self.emit();
        result
    }

    async fn stop_for_policy(&self) -> Result<()> {
        {
            let state = self.state.lock().await;
            if let Some(cancel) = &state.cancel {
                let _ = cancel.send(true);
            }
        }
        // Immediate stop precedes the normal drain's birth fence. Repeat after
        // acquiring it to catch a process that passed admission before policy.
        self.stop_consumers().await;
        let _start = self.active_start.lock().await;
        self.stop_consumers().await;
        self.project_config().await
    }

    async fn check_updates_inner(self: &Arc<Self>, manual: bool) -> Result<()> {
        self.components.set_update("checking", None, None);
        self.emit();
        let mut shutdown = self.shutdown.subscribe();
        let fetched = tokio::select! { _ = shutdown.changed() => Err(Error::cancelled()), result = self.components.fetch_manifest() => result };
        let approved = match fetched {
            Ok(approved) => approved,
            Err(error) => {
                self.components
                    .set_update("failed", None, Some(error.clone()));
                self.emit();
                return Err(error);
            }
        };
        if let Err(error) = self.components.ingest_controls(&approved, "remote").await {
            if self.components.controls().await.is_ok() {
                return Err(error);
            }
            self.stop_for_policy().await?;
            return Err(error);
        }
        // Even incompatible artifacts must not hide applicable controls.
        let controls = self.components.controls().await?;
        let current = self.components.state.lock().await.current.clone();
        let current_revoked = match &current {
            Some(current) => {
                let component = current.component()?;
                component
                    .artifacts
                    .get(super::manifest::platform().ok_or_else(Error::contract)?)
                    .is_some_and(|artifact| controls.revoked(&component.version, &artifact.sha256))
            }
            None => false,
        };
        if !controls.allows(cfg!(debug_assertions)) || current_revoked {
            self.stop_for_policy().await?;
        }
        if let Ok(mut update) = self.components.update.lock() {
            update.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
        }
        if !controls.allows(cfg!(debug_assertions)) {
            self.emit();
            return Ok(());
        }
        let Some(installed) = Installed::select(approved, "updated", &self.components.app_version)? else {
            self.components.set_update("idle", None, None);
            self.project_config().await?;
            return Ok(());
        };
        let component = self.components.allowed(&installed).await?;
        let current_component = current.as_ref().map(Installed::component).transpose()?;
        let should_prepare = super::manifest::should_prepare_update(
            current_component.as_ref(),
            &component,
            super::manifest::platform().ok_or_else(Error::contract)?,
            current_revoked,
        )?;
        if !should_prepare {
            self.components.set_update("idle", None, None);
            self.project_config().await?;
            self.emit();
            return Ok(());
        }
        self.components
            .install(&installed, manual, self.shutdown.subscribe())
            .await?;
        self.emit();
        if *self.shutdown.borrow() {
            return Err(Error::cancelled());
        }
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            if let Err(error) = manager.activate_pending(manual, false).await {
                manager.components.set_update("failed", None, Some(error));
                manager.emit();
            }
        });
        Ok(())
    }

    pub fn schedule_proxy_reconcile(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            if let Err(error) = manager.activate_pending(false, true).await {
                manager.set_error(error).await;
            }
        });
    }

    async fn activate_pending(&self, manual: bool, refresh_proxy: bool) -> Result<()> {
        let _operation = self.account_operation.lock().await;
        let _start = self.active_start.lock().await;
        let pending = {
            let components = self.components.state.lock().await;
            // A network change replaces the current process only. A waiting
            // component with different credential requirements must not veto it.
            if refresh_proxy {
                components.current.clone()
            } else {
                components.pending.clone()
            }
        };
        let Some(pending) = pending else {
            return Ok(());
        };
        let (active, candidate, running) = {
            let state = self.state.lock().await;
            if refresh_proxy {
                let desired = super::process::proxy_environment();
                if !state
                    .active
                    .iter()
                    .chain(state.candidate.iter())
                    .any(|i| i.alive() && i.proxy_environment != desired)
                {
                    return Ok(());
                }
            }
            if state.shutting_down
                || crate::sidecar::is_update_shutdown_in_progress()
                || !state.accounts.cleanup.is_empty()
                || state.accounts.disconnecting
            {
                return Ok(());
            }
            (
                state.accounts.active.clone(),
                state.accounts.candidate.clone(),
                state.active.is_some() || state.candidate.is_some(),
            )
        };
        if !running {
            return Ok(());
        }
        let current = self.components.state.lock().await.current.clone();
        let next_component = self.components.allowed(&pending).await?;
        if let Some(current) = &current {
            if (active.is_some() || candidate.is_some())
                && !next_component.accepts_accounts_from(&current.component()?)
            {
                return Err(Error::new(
                    "credential_incompatible",
                    "此组件升级尚未通过账号凭据兼容验证",
                ));
            }
        }
        self.state.lock().await.draining = true;
        self.components.set_update(
            "waiting-to-switch",
            Some(next_component.version.clone()),
            None,
        );
        self.emit();
        let result = async {
            self.drain(false, &self.shutdown.subscribe()).await?;
            let instances: Vec<_> = {
                let state = self.state.lock().await;
                state
                    .active
                    .iter()
                    .chain(state.candidate.iter())
                    .cloned()
                    .collect()
            };
            for instance in instances {
                instance.stop().await?;
            }
            {
                let mut state = self.state.lock().await;
                state.active = None;
                state.candidate = None;
            }
            for account in active.iter().chain(candidate.iter()) {
                let instance = self
                    .start_for(account, &pending, self.shutdown.subscribe(), manual)
                    .await?;
                let mut state = self.state.lock().await;
                if active
                    .as_ref()
                    .is_some_and(|a| a.generation == instance.account_generation)
                {
                    state.active = Some(instance);
                } else {
                    state.candidate = Some(instance);
                }
            }
            {
                let mut state = self.state.lock().await;
                let mut next = state.accounts.clone();
                if let Some(candidate) = &mut next.candidate {
                    candidate.verified_model = None;
                    candidate.verified_at = None;
                    candidate.verification_identity = None;
                    candidate.phase = "stored".to_owned();
                }
                // Invalidate candidate proof before committing the component.
                // Nothing fallible follows the durable component switch.
                self.store.write_accounts(&next)?;
                state.accounts = next;
            }
            self.components.activate(&pending).await?;
            let mut state = self.state.lock().await;
            state.models.clear();
            state.model_identities.clear();
            Ok(())
        }
        .await;
        if result.is_err() {
            let published = self
                .components
                .state
                .lock()
                .await
                .current
                .as_ref()
                .and_then(|current| {
                    current
                        .identity(&self.components.app_version, &self.components.sdk_version)
                        .ok()
                })
                == Some(
                    pending.identity(&self.components.app_version, &self.components.sdk_version)?,
                );
            if published {
                // A directory-flush error after the component pointer rename
                // is a post-commit failure. Keep the new account writers.
                let mut state = self.state.lock().await;
                state.models.clear();
                state.model_identities.clear();
                state.draining = false;
                drop(state);
                self.changed.notify_waiters();
                self.emit();
                return result;
            }
            // Confirm all attempted writers exited before restoring any old
            // executable against those same credential directories.
            let attempted: Vec<_> = {
                let state = self.state.lock().await;
                state
                    .active
                    .iter()
                    .chain(state.candidate.iter())
                    .cloned()
                    .collect()
            };
            for instance in attempted {
                instance.stop().await?;
            }
            {
                let mut state = self.state.lock().await;
                state.active = None;
                state.candidate = None;
            }
            if let Some(old) = &current {
                if self.components.allowed(old).await.is_ok()
                    && old.component()?.accepts_accounts_from(&next_component)
                {
                    for account in active.iter().chain(candidate.iter()) {
                        if let Ok(instance) = self
                            .start_for(account, old, self.shutdown.subscribe(), false)
                            .await
                        {
                            let mut state = self.state.lock().await;
                            if active
                                .as_ref()
                                .is_some_and(|a| a.generation == account.generation)
                            {
                                state.active = Some(instance);
                            } else {
                                state.candidate = Some(instance);
                            }
                        }
                    }
                }
            }
        }
        self.state.lock().await.draining = false;
        self.changed.notify_waiters();
        self.emit();
        result
    }

    pub async fn wait_for_next_update(&self, duration: Duration) -> bool {
        let mut shutdown = self.shutdown.subscribe();
        if *shutdown.borrow() {
            return false;
        }
        tokio::select! { _ = shutdown.changed() => false, _ = tokio::time::sleep(duration) => true }
    }

    pub async fn quiesce_for_update(&self) -> Result<()> {
        // The caller owns the existing reversible app update gate. Its Drop
        // reopens admission if installer/shutdown fails; no terminal shutdown
        // watch or second lifecycle flag is introduced here.
        if !crate::sidecar::is_update_shutdown_in_progress() {
            return Err(Error::contract());
        }
        {
            let state = self.state.lock().await;
            if let Some(cancel) = &state.cancel {
                let _ = cancel.send(true);
            }
        }
        self.stop_consumers().await;
        let _update = self.update_check.lock().await;
        let _operation = self.account_operation.lock().await;
        let _start = self.active_start.lock().await;
        self.stop_consumers().await;
        let state = self.state.lock().await;
        if state.active.is_some() || state.candidate.is_some() {
            return Err(Error::new("stop_pending", "模型组件尚未确认退出，请重试"));
        }
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<()> {
        {
            let mut state = self.state.lock().await;
            state.shutting_down = true;
            if let Some(cancel) = &state.cancel {
                let _ = cancel.send(true);
            }
        }
        // Shutdown is durable in memory even before startup creates its first
        // subscriber; send() alone discards the value when nobody is listening.
        self.shutdown.send_replace(true);
        self.changed.notify_waiters();
        let _update = self.update_check.lock().await;
        self.stop_consumers().await;
        let _operation = self.account_operation.lock().await;
        let _start = self.active_start.lock().await;
        let instances: Vec<_> = {
            let state = self.state.lock().await;
            state
                .active
                .iter()
                .chain(state.candidate.iter())
                .cloned()
                .collect()
        };
        for instance in instances {
            instance.stop().await?;
        }
        Ok(())
    }

    async fn project_config(&self) -> Result<()> {
        let controls = self.components.controls().await;
        let current = self.components.state.lock().await.current.clone();
        let policy_allows = controls.is_ok_and(|c| c.allows(cfg!(debug_assertions)))
            && match current {
                Some(current) => self.components.allowed(&current).await.is_ok(),
                None => false,
            };
        // Account lock -> config lock is the sole projection order. No caller
        // may publish a captured React/config snapshot as account authority.
        let state = self.state.lock().await;
        let active = state.accounts.active.as_ref().filter(|a| {
            policy_allows
                && !state.accounts.disconnecting
                && !state.accounts.cleanup.contains(&a.id)
                && !state.account_errors.get(&a.generation).is_some_and(|e| {
                    matches!(e.code.as_str(), "reauth_required" | "account_not_saved")
                })
        });
        let models = active
            .and_then(|a| state.models.get(&a.generation))
            .cloned();
        let connected_at = active.map(|a| {
            a.authorized_at
                .clone()
                .or_else(|| a.verified_at.clone())
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
        });
        let path = &self.config_path;
        if !path.exists() {
            return Ok(());
        }
        crate::config_io::with_config_lock(&path, false, |config| {
            let id = "antigravity-sub";
            if let Some(at) = &connected_at {
                config["providerVerifyStatus"][id] = json!({ "status": "valid", "verifiedAt": at });
                if config["providerPrimaryModels"][id]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .is_none()
                {
                    if let Some(model) = models.as_ref().and_then(|models| models.first()) {
                        config["providerPrimaryModels"][id] = model["model"].clone();
                    }
                }
            } else if let Some(statuses) = config["providerVerifyStatus"].as_object_mut() {
                statuses.remove(id);
            }
            if let Some(models) = &models {
                // Config rows may have user edits even with source=discovered.
                // Native capabilities are bound separately at execution time.
                let existing = config["presetCustomModels"][id]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let removed = config["presetRemovedModels"][id]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let merged = super::models::merge_configured(&existing, models, &removed);
                config["presetCustomModels"][id] = json!(merged);
            }
            Ok(())
        })
        .map_err(|_| Error::storage())?;
        drop(state);
        let _ = self.app.emit("agent:config-changed", json!({}));
        Ok(())
    }
}

// Only locally generated attempt identities and finite client error codes reach
// this logger. Never log native state, callback fields, URLs or response bodies.
fn log_oauth_step(phase: &str, attempt: &str, started: Instant, http: Option<u16>, code: &str) {
    crate::ulog_info!(
        "[cliproxy] oauth phase={} attempt={} http_status={} elapsed_ms={} outcome={}",
        phase,
        attempt,
        http.map_or_else(|| "none".to_owned(), |s| s.to_string()),
        started.elapsed().as_millis(),
        code
    );
}

/// The login owner submits once, then resolves only the exact native state.
/// Kept outside the app shell so loss/cancellation/deadline paths use real local
/// HTTP in deterministic tests without a browser or an account.
pub(super) async fn finish_oauth(
    client: &Client,
    state: &str,
    callback: super::callback::Callback,
    started: Instant,
    deadline: Instant,
    mut cancelled: watch::Receiver<bool>,
    attempt: &str,
) -> Result<()> {
    let work = async {
        let reply = client
            .callback(state, callback.code.as_deref(), callback.error.as_deref())
            .await;
        let code = match &reply.outcome {
            Ok(CallbackOutcome::Accepted) => "accepted",
            Ok(CallbackOutcome::Unconfirmed(error)) | Err(error) => &error.code,
        };
        log_oauth_step("callback_submit", attempt, started, reply.http_status, code);
        reply.outcome?;
        let mut last_poll = None;
        loop {
            let reply = client.auth_status(state).await;
            let code = match &reply.outcome {
                Ok(AuthStatus::Waiting) => "waiting",
                Ok(AuthStatus::Complete) => "complete",
                Err(error) => &error.code,
            };
            let current = (reply.http_status, code.to_owned());
            if last_poll.as_ref() != Some(&current) {
                log_oauth_step("auth_status", attempt, started, reply.http_status, code);
                last_poll = Some(current);
            }
            match reply.outcome {
                Ok(AuthStatus::Complete) => return Ok(()),
                Ok(AuthStatus::Waiting) => {}
                Err(error)
                    if matches!(
                        error.code.as_str(),
                        "transport_outcome_unknown" | "oauth_status_unavailable"
                    ) => {}
                Err(error) => return Err(error),
            }
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
    };
    if *cancelled.borrow() {
        return Err(Error::cancelled());
    }
    if Instant::now() >= deadline {
        return Err(Error::new("login_timeout", "组件授权已超时，请重新连接"));
    }
    let result = tokio::select! {
        biased;
        _ = cancelled.changed() => Err(Error::cancelled()),
        result = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), work) =>
            result.unwrap_or_else(|_| Err(Error::new("login_timeout", "无法在时限内确认组件授权结果，请重新连接"))),
    };
    log_oauth_step(
        "authorization",
        attempt,
        started,
        None,
        result
            .as_ref()
            .err()
            .map_or("complete", |e| e.code.as_str()),
    );
    result
}

// These fixtures exercise approved native components and Unix process fences.
// Linux is Unix but is not a supported CLIProxy platform. CI runs them on macOS.
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::super::manifest::SignedManifest;
    use super::*;
    use tempfile::TempDir;
    static LIFECYCLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct Fixture {
        manager: Arc<CliProxyManager<tauri::test::MockRuntime>>,
        _app: tauri::App<tauri::test::MockRuntime>,
        directory: TempDir,
        processes: Vec<Arc<Instance>>,
        installed: Installed,
    }
    #[tokio::test]
    async fn confirmed_native_login_is_usable_without_any_model_request_or_catalog() {
        let _serial = LIFECYCLE.lock().await;
        let fixture = Fixture::new().await;
        let mut account = AccountRef::candidate();
        // Old persisted candidates use an ambiguous verification phase. Native
        // confirmation, not that phase or a model result, restores the account.
        account.phase = "awaiting-verification".to_owned();
        fixture.manager.state.lock().await.accounts.candidate = Some(account.clone());
        let (_cancel, cancelled) = watch::channel(false);
        fixture
            .manager
            .record_authorization(
                &account,
                super::super::client::Account {
                    name: "synthetic-native-record".to_owned(),
                    kind: "antigravity".to_owned(),
                    email: None,
                    disabled: false,
                },
                &cancelled,
            )
            .await
            .unwrap();
        let saved = fixture.manager.store.read_accounts().unwrap();
        assert!(saved.candidate.as_ref().unwrap().authorized_at.is_some());
        assert!(saved.candidate.as_ref().unwrap().verified_model.is_none());
        {
            let mut state = fixture.manager.state.lock().await;
            state
                .accounts
                .commit_candidate(&account.generation)
                .unwrap();
            state.account_errors.insert(
                account.generation.clone(),
                Error::new("catalog_unavailable", "Catalog unavailable"),
            );
        }
        fixture.manager.components.state.lock().await.current = Some(fixture.installed.clone());
        std::fs::write(&fixture.manager.config_path, "{}").unwrap();
        fixture.manager.project_config().await.unwrap();
        let status = fixture.manager.status().await;
        assert_eq!(status["active"]["status"], "connected");
        assert!(status["candidate"].is_null());
        assert_eq!(status["models"], json!([]));
        let config: Value =
            serde_json::from_slice(&std::fs::read(&fixture.manager.config_path).unwrap()).unwrap();
        assert_eq!(
            config["providerVerifyStatus"]["antigravity-sub"]["status"],
            "valid"
        );
        assert!(config["providerPrimaryModels"]["antigravity-sub"].is_null());
    }

    #[tokio::test]
    async fn late_or_disabled_native_authorization_cannot_promote_a_candidate() {
        let _serial = LIFECYCLE.lock().await;
        let fixture = Fixture::new().await;
        let account = AccountRef::candidate();
        fixture.manager.state.lock().await.accounts.candidate = Some(account.clone());
        let (_cancel, cancelled) = watch::channel(false);
        let summary = |disabled| super::super::client::Account {
            name: "synthetic-native-record".to_owned(),
            kind: "antigravity".to_owned(),
            email: None,
            disabled,
        };
        assert!(fixture
            .manager
            .record_authorization(&account, summary(true), &cancelled)
            .await
            .is_err());
        assert!(fixture
            .manager
            .state
            .lock()
            .await
            .accounts
            .candidate
            .as_ref()
            .unwrap()
            .authorized_at
            .is_none());
        fixture
            .manager
            .state
            .lock()
            .await
            .accounts
            .begin_cancel_candidate();
        assert!(fixture
            .manager
            .record_authorization(&account, summary(false), &cancelled)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn account_errors_stay_with_their_generation_in_the_status_projection() {
        let fixture = Fixture::new().await;
        let active = AccountRef::candidate();
        let candidate = AccountRef::candidate();
        {
            let mut state = fixture.manager.state.lock().await;
            state.accounts.active = Some(active.clone());
            state.accounts.candidate = Some(candidate.clone());
            state.error = Some(Error::new("component_failure", "Component failure"));
            state.account_errors.insert(
                active.generation.clone(),
                Error::new("active_failure", "Active failure"),
            );
        }
        let status = fixture.manager.status().await;
        assert_eq!(status["active"]["error"]["code"], "active_failure");
        assert!(status["candidate"]["error"].is_null());
        fixture
            .manager
            .record_account_failure(
                &candidate,
                &Error::new("catalog_unavailable", "Catalog unavailable"),
            )
            .await
            .unwrap();
        let status = fixture.manager.status().await;
        assert_eq!(status["candidate"]["error"]["code"], "catalog_unavailable");
        assert_eq!(status["error"]["code"], "component_failure");
    }
    #[tokio::test]
    async fn failed_candidate_cleanup_keeps_the_failure_without_marking_the_active_account() {
        for has_active in [false, true] {
            let fixture = Fixture::new().await;
            let active = has_active.then(AccountRef::candidate);
            let mut candidate = AccountRef::candidate();
            candidate.phase = "stored".to_owned();
            {
                let mut state = fixture.manager.state.lock().await;
                state.accounts.active = active.clone();
                state.accounts.candidate = Some(candidate.clone());
            }
            fixture
                .manager
                .record_account_failure(
                    &candidate,
                    &Error::new("account_not_saved", "Candidate authorization was not saved"),
                )
                .await
                .unwrap();
            let status = fixture.manager.status().await;
            assert!(status["candidate"].is_null());
            assert!(status["cleanup"].is_null());
            assert_eq!(status["error"]["code"], "account_not_saved");
            assert!(status["active"]["error"].is_null());
            if let Some(active) = active {
                assert_eq!(status["active"]["generation"], active.generation);
            } else {
                assert!(status["active"].is_null());
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for instance in &self.processes {
                instance.test_cleanup();
            }
        }
    }
    impl Fixture {
        async fn new() -> Self {
            let app = tauri::test::mock_app();
            let directory = tempfile::tempdir().unwrap();
            let approval = SignedManifest {
                json: include_str!("fixtures/internal-manifest.json").to_owned(),
                signature: include_str!("fixtures/internal-manifest.json.sig").to_owned(),
            };
            let component = approval.verify().unwrap().releases[0].clone();
            let components = ComponentStore::new(
                directory.path(),
                directory.path().join("bundled"),
                component.compatibility.min_app_version.clone(),
                "0.3.261".to_owned(),
            )
            .unwrap();
            components
                .ingest_controls(&approval, "cached")
                .await
                .unwrap();
            let installed = Installed {
                min_app_version: "0.4.17".to_owned(),
                approval,
                source: "updated".to_owned(),
            };
            let (shutdown, _) = watch::channel(false);
            let manager = Arc::new(CliProxyManager {
                app: app.handle().clone(),
                config_path: directory.path().join("config.json"),
                sidecars: Arc::new(std::sync::Mutex::new(
                    crate::sidecar::manager::SidecarManager::new(),
                )),
                store: Store {
                    root: directory.path().join("providers/cliproxy"),
                },
                components,
                state: Mutex::new(Runtime {
                    ready: true,
                    ..Default::default()
                }),
                account_operation: Arc::new(Mutex::new(())),
                active_start: Mutex::new(()),
                update_check: Mutex::new(()),
                changed: Notify::new(),
                shutdown,
            });
            Self {
                manager,
                _app: app,
                directory,
                processes: Vec::new(),
                installed,
            }
        }
        fn process(&mut self, generation: &str) -> Arc<Instance> {
            let identity = self
                .installed
                .identity(
                    &self.manager.components.app_version,
                    &self.manager.components.sdk_version,
                )
                .unwrap();
            let instance = Instance::test_process(self.directory.path(), generation, &identity);
            self.processes.push(Arc::clone(&instance));
            instance
        }
    }

    #[tokio::test]
    async fn successful_grant_is_owned_until_received_even_after_send() {
        let _serial = LIFECYCLE.lock().await;
        for delivery in ["closed-before-send", "dropped-after-send", "claimed"] {
            let mut fixture = Fixture::new().await;
            let instance = fixture.process("account");
            let operation_id = Uuid::new_v4().to_string();
            let key = format!("sidecar:7:{operation_id}");
            let request = LeaseRequest {
                sidecar_id: "sidecar".to_owned(),
                operation_id: operation_id.clone(),
                lease_id: None,
                terminal: None,
            };
            let binding = Binding {
                provider_id: "antigravity-sub".to_owned(),
                base_url: "http://127.0.0.1:1".to_owned(),
                api_key: "synthetic".to_owned(),
                instance_generation: instance.generation.clone(),
                account_generation: "account".to_owned(),
                lease_id: Uuid::new_v4().to_string(),
                model_policy: super::super::types::ModelPolicy {
                    id: "model-b".to_owned(),
                    thinking: None,
                    context_length: None,
                    max_output_tokens: None,
                },
            };
            {
                let mut state = fixture.manager.state.lock().await;
                state
                    .operations
                    .begin(&key, "sidecar", 7, "model-b")
                    .unwrap();
                state.operations.acquire(&key).unwrap();
                state.leases.insert(
                    key.clone(),
                    Lease {
                        sidecar_id: "sidecar".to_owned(),
                        sidecar_generation: 7,
                        operation_id,
                        model: "model-b".to_owned(),
                        binding: binding.clone(),
                    },
                );
                state.active = Some(Arc::clone(&instance));
            }
            let grant = UnclaimedBinding {
                manager: Arc::clone(&fixture.manager),
                request,
                sidecar_generation: 7,
                binding: Some(binding),
            };
            let (send, receive) = tokio::sync::oneshot::channel();
            if delivery == "closed-before-send" {
                drop(receive);
                assert!(send.send(grant).is_err());
            } else {
                assert!(send.send(grant).is_ok());
                if delivery == "dropped-after-send" {
                    // This is the handoff race: send succeeded, but no caller
                    // consumed the binding before its HTTP future was dropped.
                    drop(receive);
                } else {
                    let claimed = receive.await.unwrap().claim();
                    assert_eq!(fixture.manager.state.lock().await.leases.len(), 1);
                    fixture
                        .manager
                        .release(
                            &LeaseRequest {
                                sidecar_id: "sidecar".to_owned(),
                                operation_id: key.split(':').next_back().unwrap().to_owned(),
                                lease_id: Some(claimed.lease_id),
                                terminal: None,
                            },
                            7,
                        )
                        .await
                        .unwrap();
                }
            }
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if fixture.manager.state.lock().await.operations.phase(&key)
                        == Some(super::super::operations::Phase::Released)
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(fixture.manager.state.lock().await.leases.is_empty());
            assert!(
                instance.alive(),
                "request settlement must preserve shared CLIProxy"
            );
        }
    }

    #[tokio::test]
    async fn cold_binding_waits_for_initialization_before_selecting_a_component() {
        use std::future::{poll_fn, Future};
        use std::task::Poll;

        let _serial = LIFECYCLE.lock().await;
        let fixture = Fixture::new().await;
        fixture.manager.state.lock().await.ready = false;
        let initialization = fixture.manager.account_operation.lock().await;
        let mut request = Box::pin(fixture.manager.acquire_owned(BindingRequest {
            sidecar_id: "sidecar".to_owned(),
            operation_id: Uuid::new_v4().to_string(),
            model: "model-a".to_owned(),
        }, 7));
        assert!(poll_fn(|cx| Poll::Ready(request.as_mut().poll(cx).is_pending())).await,
            "binding must join startup instead of reporting an unready component");
        fixture.manager.state.lock().await.ready = true;
        drop(initialization);
        // No executable is installed in this fixture. Selection may fail only
        // after initialization, with its actual resource error.
        assert_eq!(request.await.err().unwrap().code, "bundled_missing");
    }

    #[tokio::test]
    async fn an_existing_account_selects_the_bundled_upgrade_offline() {
        let fixture = Fixture::new().await;
        let manager = &fixture.manager;
        let bundle = &manager.components.bundled;
        let resources = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/cliproxy");
        std::fs::create_dir_all(bundle).unwrap();
        for name in ["manifest-v1.json", "manifest-v1.json.sig", "artifact.zip"] {
            std::fs::copy(resources.join(name), bundle.join(name)).unwrap();
        }
        let account = AccountRef::candidate();
        let auth = manager.store.create_account(&account.id).unwrap();
        let marker = auth.join("upgrade-test-marker");
        std::fs::write(&marker, b"existing account").unwrap();
        manager.state.lock().await.accounts.active = Some(account);
        manager.components.state.lock().await.current = Some(fixture.installed.clone());

        // The second lookup goes through the persisted pending candidate.
        for _ in 0..2 {
            let selected = manager.selected(false).await.unwrap();
            assert!(selected.component().unwrap().matches_bundled_source());
            assert!(manager.components.executable(&selected).is_ok());
        }
        assert_eq!(std::fs::read(&marker).unwrap(), b"existing account");
    }

    #[tokio::test]
    async fn prewarm_without_a_retained_account_does_not_start_a_process() {
        let fixture = Fixture::new().await;
        fixture.manager.prewarm().await.unwrap();
        assert!(fixture.manager.state.lock().await.active.is_none());
        assert!(!fixture.manager.components.root.exists());
    }

    #[tokio::test]
    async fn initialization_cannot_restart_after_shutdown() {
        let fixture = Fixture::new().await;
        fixture.manager.state.lock().await.ready = false;
        fixture.manager.shutdown().await.unwrap();
        assert_eq!(fixture.manager.initialize_serialized(false).await.err().unwrap().code, "cancelled");
        assert!(!fixture.manager.state.lock().await.ready);
    }

    #[tokio::test]
    async fn cancelled_binding_transport_still_settles_the_owned_startup() {
        use std::future::{poll_fn, Future};
        use std::task::Poll;

        let _serial = LIFECYCLE.lock().await;
        let fixture = Fixture::new().await;
        let operation_id = Uuid::new_v4().to_string();
        let key = format!("sidecar:7:{operation_id}");
        let fence = fixture.manager.active_start.lock().await;
        let mut request = Box::pin(fixture.manager.acquire(
            BindingRequest {
                sidecar_id: "sidecar".to_owned(),
                operation_id: operation_id.clone(),
                model: "model-a".to_owned(),
            },
            7,
        ));
        assert!(poll_fn(|cx| Poll::Ready(request.as_mut().poll(cx).is_pending())).await);
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if fixture.manager.state.lock().await.operations.phase(&key)
                    == Some(super::super::operations::Phase::Preparing)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // HTTP disconnect/model switch cancels the awaiter, not App-owned startup.
        drop(request);
        drop(fence);
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if fixture.manager.state.lock().await.operations.phase(&key)
                    == Some(super::super::operations::Phase::Released)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled transport stranded component preparation");
        // This fixture has no executable; failure still has to finish the
        // operation after the transport disappears, rather than leave Preparing.
        assert!(fixture.manager.state.lock().await.leases.is_empty());
    }

    #[tokio::test]
    async fn retained_login_waits_for_the_process_birth_fence() {
        use std::future::{poll_fn, Future};
        use std::task::Poll;

        let _serial = LIFECYCLE.lock().await;
        let fixture = Fixture::new().await;
        let account = AccountRef::candidate();
        let (_cancel, cancelled) = watch::channel(false);
        let fence = fixture.manager.active_start.lock().await;
        let mut resume = Box::pin(fixture.manager.resume_login(&account, cancelled));
        // Policy stop joins this same fence after cancelling births. Even
        // component selection must wait, before any writer can be created.
        let waiting = poll_fn(|cx| Poll::Ready(resume.as_mut().poll(cx).is_pending())).await;
        assert!(waiting, "retained login bypassed the process birth fence");
        drop(fence);
        // This isolated fixture has no installed executable; after admission
        // it must terminate without starting a writer or contacting a provider.
        assert!(resume.await.is_err());
        assert!(fixture.manager.state.lock().await.candidate.is_none());
    }

    #[tokio::test]
    async fn policy_stop_reaches_writer_before_waiting_for_normal_drain_fence() {
        let _serial = LIFECYCLE.lock().await;
        let mut fixture = Fixture::new().await;
        let instance = fixture.process("active");
        fixture.manager.state.lock().await.active = Some(Arc::clone(&instance));
        let fence = fixture.manager.active_start.lock().await;
        let manager = Arc::clone(&fixture.manager);
        let stop = tauri::async_runtime::spawn(async move { manager.stop_for_policy().await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while instance.alive() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!stop.inner().is_finished());
        drop(fence);
        stop.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn failed_lazy_pointer_publication_retires_writer_without_committing_component() {
        let _serial = LIFECYCLE.lock().await;
        let mut fixture = Fixture::new().await;
        let instance = fixture.process("active");
        fixture.manager.state.lock().await.active = Some(Arc::clone(&instance));
        std::fs::remove_file(&fixture.manager.components.state_path).unwrap();
        std::fs::create_dir(&fixture.manager.components.state_path).unwrap();
        assert!(fixture
            .manager
            .activate_started(&fixture.installed, &instance)
            .await
            .is_err());
        assert!(!instance.alive());
        assert!(fixture.manager.state.lock().await.active.is_none());
        assert!(fixture
            .manager
            .components
            .state
            .lock()
            .await
            .current
            .is_none());
        std::fs::remove_dir(&fixture.manager.components.state_path).unwrap();
        let retried = fixture.process("active");
        fixture.manager.state.lock().await.active = Some(Arc::clone(&retried));
        fixture
            .manager
            .activate_started(&fixture.installed, &retried)
            .await
            .unwrap();
        assert!(retried.alive());
        assert!(fixture
            .manager
            .components
            .state
            .lock()
            .await
            .current
            .is_some());
    }

    #[tokio::test]
    async fn cleanup_retry_completes_pre_admission_initialization() {
        let _serial = LIFECYCLE.lock().await;
        let fixture = Fixture::new().await;
        let account = AccountRef::candidate();
        {
            let mut state = fixture.manager.state.lock().await;
            state.ready = false;
            state.accounts.candidate = Some(account);
            state.accounts.begin_cancel_candidate();
        }
        fixture
            .manager
            .store
            .create_account(
                &fixture
                    .manager
                    .state
                    .lock()
                    .await
                    .accounts
                    .candidate
                    .as_ref()
                    .unwrap()
                    .id,
            )
            .unwrap();
        fixture.manager.retry_cleanup().await.unwrap();
        let state = fixture.manager.state.lock().await;
        assert!(state.ready);
        assert!(state.accounts.candidate.is_none());
        assert!(state.accounts.cleanup.is_empty());
        assert!(CliProxyManager::<tauri::test::MockRuntime>::check_state(&state).is_ok());
    }

    #[tokio::test]
    async fn failed_app_update_reopens_existing_admission_without_terminal_shutdown() {
        let _serial = LIFECYCLE.lock().await;
        let mut fixture = Fixture::new().await;
        let instance = fixture.process("active");
        fixture.manager.state.lock().await.active = Some(Arc::clone(&instance));
        let gate = crate::sidecar::begin_update_shutdown().unwrap();
        fixture.manager.quiesce_for_update().await.unwrap();
        assert!(!instance.alive());
        assert!(CliProxyManager::<tauri::test::MockRuntime>::check_state(
            &*fixture.manager.state.lock().await
        )
        .is_err());
        drop(gate); // installer returned failure: caller's existing guard drops
        assert!(CliProxyManager::<tauri::test::MockRuntime>::check_state(
            &*fixture.manager.state.lock().await
        )
        .is_ok());
        assert!(!*fixture.manager.shutdown.borrow());
        assert!(!fixture.manager.state.lock().await.shutting_down);
    }

    #[tokio::test]
    async fn proxy_replacement_does_not_consult_a_waiting_component_approval() {
        let _serial = LIFECYCLE.lock().await;
        let mut fixture = Fixture::new().await;
        let account = AccountRef::candidate();
        let instance = fixture.process(&account.generation);
        {
            let mut state = fixture.manager.state.lock().await;
            state.active = Some(Arc::clone(&instance));
            state.accounts.active = Some(account.clone());
        }
        fixture.manager.store.create_account(&account.id).unwrap();
        {
            let mut components = fixture.manager.components.state.lock().await;
            components.current = Some(fixture.installed.clone());
            // Any pending compatibility/signature failure is irrelevant to a
            // network-only replacement of the already approved current build.
            components.pending = Some(Installed {
                min_app_version: "0.4.17".to_owned(),
                approval: SignedManifest {
                    json: "{}".to_owned(),
                    signature: "invalid".to_owned(),
                },
                source: "updated".to_owned(),
            });
        }
        // This primitive fixture intentionally has no installed executable:
        // observe that reconciliation reaches current's local preparation after
        // draining, rather than rejecting the unrelated pending approval.
        let result = fixture.manager.activate_pending(false, true).await;
        assert!(result.is_err());
        assert!(!instance.alive());
        assert!(fixture
            .manager
            .components
            .state
            .lock()
            .await
            .pending
            .is_some());
        assert!(!fixture.manager.state.lock().await.draining);
    }

    #[tokio::test]
    async fn model_terminals_update_only_the_exact_retained_account_and_lease() {
        let _serial = LIFECYCLE.lock().await;
        let mut fixture = Fixture::new().await;
        let account = AccountRef::candidate();
        let instance = fixture.process(&account.generation);
        let request = LeaseRequest {
            sidecar_id: "sidecar".to_owned(),
            operation_id: Uuid::new_v4().to_string(),
            lease_id: Some(Uuid::new_v4().to_string()),
            terminal: None,
        };
        let key = format!("sidecar:7:{}", request.operation_id);
        {
            let mut state = fixture.manager.state.lock().await;
            state.active = Some(Arc::clone(&instance));
            state.accounts.active = Some(account.clone());
            state.leases.insert(
                key,
                Lease {
                    sidecar_id: request.sidecar_id.clone(),
                    sidecar_generation: 7,
                    operation_id: request.operation_id.clone(),
                    model: "model-b".to_owned(),
                    binding: Binding {
                        provider_id: "antigravity-sub".to_owned(),
                        base_url: "http://127.0.0.1:1".to_owned(),
                        api_key: "synthetic".to_owned(),
                        instance_generation: instance.generation.clone(),
                        account_generation: account.generation,
                        lease_id: request.lease_id.clone().unwrap(),
                        model_policy: super::super::types::ModelPolicy {
                            id: "model-b".to_owned(),
                            thinking: Some(false),
                            context_length: None,
                            max_output_tokens: None,
                        },
                    },
                },
            );
        }
        use super::super::types::TerminalOutcome;
        fixture
            .manager
            .record_terminal(&request, 7, TerminalOutcome::Succeeded)
            .await
            .unwrap();
        assert!(
            fixture
                .manager
                .state
                .lock()
                .await
                .accounts
                .active
                .as_ref()
                .unwrap()
                .model_checks["model-b"]
                .status
                == TerminalOutcome::Succeeded
        );
        assert!(fixture
            .manager
            .record_terminal(&request, 8, TerminalOutcome::Failed)
            .await
            .is_err());
        fixture
            .manager
            .record_terminal(&request, 7, TerminalOutcome::Failed)
            .await
            .unwrap();
        assert!(
            fixture
                .manager
                .state
                .lock()
                .await
                .accounts
                .active
                .as_ref()
                .unwrap()
                .model_checks["model-b"]
                .status
                == TerminalOutcome::Failed
        );
        fixture.manager.state.lock().await.accounts.active = Some(AccountRef::candidate());
        assert!(fixture
            .manager
            .record_terminal(&request, 7, TerminalOutcome::Succeeded)
            .await
            .is_err());
        assert!(fixture
            .manager
            .state
            .lock()
            .await
            .accounts
            .active
            .as_ref()
            .unwrap()
            .model_checks
            .is_empty());
    }
}
