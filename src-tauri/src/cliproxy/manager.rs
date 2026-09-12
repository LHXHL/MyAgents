use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::{watch, Mutex, Notify};
use uuid::Uuid;

use super::callback::{validate_authorization_url, Receiver};
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
#[derive(Clone)]
struct Verification {
    id: String,
    account_generation: String,
    model: String,
    component_identity: String,
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
    verification: Option<Verification>,
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
                verification: None,
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
        let _operation = self.account_operation.lock().await;
        if self.state.lock().await.ready {
            return Ok(());
        }
        self.initialize(had_prior_instance).await
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
                candidate.phase = "awaiting-verification".to_owned();
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
        let live = {
            let state = self.state.lock().await;
            state
                .active
                .iter()
                .chain(state.candidate.iter())
                .any(|i| i.alive())
        };
        // App upgrades may carry a newer baseline even while the update host
        // is offline. Prepare it before choosing an older on-disk executable.
        if !live {
            if let Ok(approval) = self.components.bundled_approval() {
                let bundled = Installed {
                    approval,
                    source: "bundled".to_owned(),
                };
                let current = snapshot
                    .pending
                    .as_ref()
                    .or(snapshot.current.as_ref())
                    .map(Installed::component)
                    .transpose()?;
                if let Ok(component) = self.components.allowed(&bundled).await {
                    let newer = super::manifest::should_prepare_update(
                        current.as_ref(),
                        &component,
                        super::manifest::platform().ok_or_else(Error::contract)?,
                        false,
                    )?;
                    let compatible = snapshot
                        .current
                        .as_ref()
                        .map(Installed::component)
                        .transpose()?
                        .as_ref()
                        .is_none_or(|current| component.credential_compatible(current));
                    if newer
                        && compatible
                        && (manual || !self.components.failed_attempt(&bundled).await?)
                    {
                        if self
                            .components
                            .install(&bundled, manual, self.shutdown.subscribe())
                            .await
                            .is_ok()
                        {
                            return Ok(bundled);
                        }
                    }
                }
            }
        }
        // A live writer stays on its component until activate_pending owns the
        // drain. Without a writer, prefer the prepared compatible update.
        let candidates = if live {
            [snapshot.current.clone(), None, snapshot.previous.clone()]
        } else {
            [
                snapshot.pending.clone(),
                snapshot.current.clone(),
                snapshot.previous.clone(),
            ]
        };
        for candidate in candidates.into_iter().flatten() {
            if self.components.allowed(&candidate).await.is_err()
                || (!manual
                    && self
                        .components
                        .failed_attempt(&candidate)
                        .await
                        .unwrap_or(true))
            {
                continue;
            }
            if let Some(current) = &snapshot.current {
                let has_accounts = {
                    let state = self.state.lock().await;
                    state.accounts.active.is_some() || state.accounts.candidate.is_some()
                };
                if has_accounts
                    && !candidate
                        .component()?
                        .credential_compatible(&current.component()?)
                {
                    continue;
                }
            }
            if self.components.executable(&candidate).is_ok() {
                return Ok(candidate);
            }
        }
        let approval = self.components.bundled_approval()?;
        self.components
            .ingest_controls(&approval, "bundled")
            .await?;
        let installed = Installed {
            approval,
            source: "bundled".to_owned(),
        };
        self.components.allowed(&installed).await?;
        if let Some(current) = &snapshot.current {
            let has_accounts = {
                let state = self.state.lock().await;
                state.accounts.active.is_some() || state.accounts.candidate.is_some()
            };
            if has_accounts
                && !installed
                    .component()?
                    .credential_compatible(&current.component()?)
            {
                return Err(Error::new(
                    "credential_incompatible",
                    "本机组件尚未通过账号凭据兼容验证",
                ));
            }
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
        let bundled = self
            .components
            .bundled_approval()
            .ok()
            .map(|approval| Installed {
                approval,
                source: "bundled".to_owned(),
            });
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
                            &self.components.app_version,
                            &self.components.sdk_version,
                        )
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
        let current_identity = components.current.as_ref().and_then(|i| {
            i.identity(&self.components.app_version, &self.components.sdk_version)
                .ok()
        });
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
            } else if a.verified_model.is_some() { "verified" } else { "stored" }, "verifiedModel": a.verified_model, "verifiedAt": a.verified_at })
        };
        let candidate = state.accounts.candidate.as_ref().map(|a| {
            json!({ "attemptId": a.attempt_id, "generation": a.generation,
            "phase": a.phase, "email": state.emails.get(&a.generation), "error": state.error })
        });
        let model_verification: BTreeMap<_, _> = state
            .accounts
            .candidate
            .as_ref()
            .or(state.accounts.active.as_ref())
            .map(|a| {
                a.model_checks
                    .iter()
                    .filter(|(_, check)| {
                        Some(&check.component_identity) == current_identity.as_ref()
                    })
                    .map(|(model, check)| {
                        (
                            model.clone(),
                            json!({"status":check.status,"checkedAt":check.checked_at}),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
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
            "models": models, "modelVerification": model_verification, "error": state.error
            , "verification": state.verification.as_ref().map(|v| json!({ "accountGeneration": v.account_generation, "model": v.model, "phase": "running" }))
        })
    }

    pub async fn connect(self: &Arc<Self>) -> Result<Value> {
        {
            let state = self.state.lock().await;
            Self::check_state(&state)?;
            if state.accounts.candidate.is_some() {
                drop(state);
                return Ok(self.status().await);
            }
        }
        let guard = Arc::clone(&self.account_operation)
            .try_lock_owned()
            .map_err(|_| Error::new("operation_pending", "账号操作正在进行"))?;
        let (cancel, cancelled) = watch::channel(false);
        let account = AccountRef::candidate();
        {
            let mut state = self.state.lock().await;
            Self::check_state(&state)?;
            if !state.accounts.cleanup.is_empty() || state.accounts.candidate.is_some() {
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
            if let Err(error) = manager.login(&account, cancelled.clone()).await {
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
                                "awaiting-verification" | "verifying" | "waiting-to-commit"
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
                manager.set_error(error).await;
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
        let deadline = Instant::now() + Duration::from_secs(5 * 60);
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
        let auth_url = instance.client.auth_url().await?;
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
        // A lost response must not replay a code. Poll only this known state.
        let _ = instance
            .client
            .callback(
                &auth_url.state,
                callback.code.as_deref(),
                callback.error.as_deref(),
            )
            .await;
        let mut cancelled = cancelled;
        loop {
            if *cancelled.borrow() {
                return Err(Error::cancelled());
            }
            if Instant::now() >= deadline {
                return Err(Error::new("login_timeout", "无法确认授权结果，请重新连接"));
            }
            let result = tokio::select! {
                _ = cancelled.changed() => return Err(Error::cancelled()),
                result = instance.client.auth_status(&auth_url.state) => result,
            };
            match result.as_deref() {
                Ok("ok") => break,
                Ok("error") => {
                    return Err(Error::new("authorization_failed", "授权未完成，请重新连接"))
                }
                _ => tokio::time::sleep(Duration::from_millis(700)).await,
            }
        }
        let summary = instance
            .client
            .account()
            .await?
            .ok_or_else(|| Error::new("authorization_failed", "授权结果未保存，请重新连接"))?;
        {
            let mut state = self.state.lock().await;
            Self::check_state(&state)?;
            let candidate = state
                .accounts
                .candidate
                .as_mut()
                .filter(|a| a.generation == account.generation)
                .ok_or_else(Error::cancelled)?;
            if *cancelled.borrow() {
                return Err(Error::cancelled());
            }
            candidate.phase = "awaiting-verification".to_owned();
            self.store.write_accounts(&state.accounts)?;
            if let Some(email) = summary.email {
                state.emails.insert(account.generation.clone(), email);
            }
        }
        self.refresh_for(account, &instance, &installed).await?;
        self.emit();
        let models = self
            .state
            .lock()
            .await
            .models
            .get(&account.generation)
            .cloned()
            .unwrap_or_default();
        let model = models
            .first()
            .and_then(|m| m["model"].as_str())
            .ok_or_else(|| Error::new("no_compatible_model", "此账号暂时没有通过兼容验证的模型"))?
            .to_owned();
        self.verify_locked(account, &installed, &instance, &model, cancelled)
            .await
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
        let component = self.components.allowed(installed).await?;
        let summary = instance
            .client
            .account()
            .await?
            .ok_or_else(|| Error::new("account_not_saved", "账号授权未保存，请重新连接"))?;
        if summary.disabled {
            return Err(Error::new("reauth_required", "账号当前不可用，请检查连接"));
        }
        let (registered, routed, definitions) = tokio::try_join!(
            instance.client.registered_models(&summary.name),
            instance.client.routed_models(),
            instance.client.definitions()
        )?;
        let models = super::models::project(&registered, &routed, &definitions, &component)?;
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

    pub async fn verify(self: &Arc<Self>, generation: &str, model: &str) -> Result<Value> {
        let guard = Arc::clone(&self.account_operation)
            .try_lock_owned()
            .map_err(|_| Error::new("operation_pending", "账号操作正在进行"))?;
        let account = {
            let state = self.state.lock().await;
            Self::check_state(&state)?;
            state
                .accounts
                .candidate
                .iter()
                .chain(state.accounts.active.iter())
                .find(|a| a.generation == generation)
                .cloned()
                .ok_or_else(Error::cancelled)?
        };
        let (cancel, cancelled) = watch::channel(false);
        self.state.lock().await.cancel = Some(cancel);
        let manager = Arc::clone(self);
        let model = model.to_owned();
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            let result = async {
                let start = manager.active_start.lock().await;
                let installed = manager.selected(true).await?;
                let existing = {
                    let state = manager.state.lock().await;
                    state
                        .candidate
                        .iter()
                        .chain(state.active.iter())
                        .find(|i| i.account_generation == account.generation && i.alive())
                        .cloned()
                };
                let instance = if let Some(instance) = existing {
                    instance
                } else {
                    let instance = manager
                        .start_for(&account, &installed, cancelled.clone(), true)
                        .await?;
                    let candidate = manager
                        .state
                        .lock()
                        .await
                        .accounts
                        .candidate
                        .as_ref()
                        .is_some_and(|a| a.generation == account.generation);
                    if candidate {
                        manager
                            .install_candidate_instance(&account, Arc::clone(&instance), &cancelled)
                            .await?;
                    } else {
                        manager.state.lock().await.active = Some(Arc::clone(&instance));
                    }
                    if let Err(error) = manager.components.activate(&installed).await {
                        instance.stop().await?;
                        return Err(error);
                    }
                    instance
                };
                manager.refresh_for(&account, &instance, &installed).await?;
                drop(start);
                manager
                    .verify_locked(&account, &installed, &instance, &model, cancelled)
                    .await
            }
            .await;
            if let Err(error) = result {
                if let Err(cleanup_error) = manager.record_account_failure(&account, &error).await {
                    manager.set_error(cleanup_error).await;
                } else {
                    manager.set_error(error).await;
                }
            }
            manager.finish_account_operation().await;
            manager.emit();
        });
        Ok(self.status().await)
    }

    async fn verify_locked(
        &self,
        account: &AccountRef,
        installed: &Installed,
        instance: &Arc<Instance>,
        model: &str,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<()> {
        let component = self.components.allowed(installed).await?;
        if !component.supports_model(model) {
            return Err(Error::new("model_unapproved", "此模型尚未通过兼容验证"));
        }
        let verification = Verification {
            id: Uuid::new_v4().to_string(),
            account_generation: account.generation.clone(),
            model: model.to_owned(),
            component_identity: installed
                .identity(&self.components.app_version, &self.components.sdk_version)?,
        };
        {
            let mut state = self.state.lock().await;
            Self::check_state(&state)?;
            state.verification = Some(verification.clone());
            if let Some(candidate) = &mut state.accounts.candidate {
                if candidate.generation == account.generation {
                    candidate.phase = "verifying".to_owned();
                }
            }
            state.error = None;
        }
        self.emit();
        let result = tokio::select! {
            _ = cancelled.changed() => Err(Error::cancelled()),
            result = async {
                let dispatch = crate::sse_proxy::acquire_global_dispatch_with_wait(&self.sidecars).await
                    .map_err(|_| Error::new("verification_runtime", "验证运行时暂时不可用"))?;
                let url = dispatch.url_for_path("/api/cliproxy/verify").map_err(|_| Error::contract())?;
                let response = crate::local_http::json_client(Duration::from_secs(120)).post(url)
                    .json(&json!({ "model": model, "accountGeneration": account.generation, "operationId": verification.id }))
                    .send().await.map_err(|_| Error::new("verification_network", "模型验证未完成，请检查网络后重试"))?;
                super::client::bounded_json(response).await
            } => result,
        };
        let success = result.as_ref().is_ok_and(|v| v["success"] == true);
        {
            let mut state = self.state.lock().await;
            if !state
                .verification
                .as_ref()
                .is_some_and(|v| v.id == verification.id)
                || *cancelled.borrow()
            {
                return Err(Error::cancelled());
            }
            state.verification = None;
            if let Some(candidate) = &mut state.accounts.candidate {
                if candidate.generation == account.generation {
                    candidate.phase = "awaiting-verification".to_owned();
                }
            }
        }
        if !success {
            if !*cancelled.borrow() {
                let mut state = self.state.lock().await;
                let mut next = state.accounts.clone();
                if !next.disconnecting {
                    if let Some(account) = next
                        .active
                        .iter_mut()
                        .chain(next.candidate.iter_mut())
                        .find(|a| {
                            a.generation == account.generation && !next.cleanup.contains(&a.id)
                        })
                    {
                        account.model_checks.insert(
                            model.to_owned(),
                            super::store::ModelCheck {
                                status: super::types::TerminalOutcome::Failed,
                                checked_at: chrono::Utc::now().to_rfc3339(),
                                component_identity: verification.component_identity.clone(),
                            },
                        );
                        let saved = self.store.write_accounts(&next);
                        if saved.is_ok() || saved.as_ref().is_err_and(|e| e.code == "storage_sync")
                        {
                            state.accounts = next;
                        }
                        saved?;
                    }
                }
            }
            return Err(result.err().unwrap_or_else(|| {
                Error::new(
                    "verification_failed",
                    "已授权，但模型工具验证未通过；可以重试或选择其他兼容模型",
                )
            }));
        }
        // Native HTTP success and SDK idle are insufficient; this is the
        // verification endpoint's full tool-round-trip terminal result.
        self.components.allowed(installed).await?;
        {
            let mut state = self.state.lock().await;
            Self::check_state(&state)?;
            let accounts = &mut state.accounts;
            let account = accounts
                .candidate
                .iter_mut()
                .chain(accounts.active.iter_mut())
                .find(|a| a.generation == account.generation)
                .ok_or_else(Error::cancelled)?;
            account.verified_model = Some(model.to_owned());
            account.verified_at = Some(chrono::Utc::now().to_rfc3339());
            account.verification_identity = Some(verification.component_identity.clone());
            account.model_checks.insert(
                model.to_owned(),
                super::store::ModelCheck {
                    status: super::types::TerminalOutcome::Succeeded,
                    checked_at: chrono::Utc::now().to_rfc3339(),
                    component_identity: verification.component_identity,
                },
            );
            self.store.write_accounts(&state.accounts)?;
        }
        let is_candidate = self
            .state
            .lock()
            .await
            .accounts
            .candidate
            .as_ref()
            .is_some_and(|a| a.generation == account.generation);
        if is_candidate {
            self.commit(account, installed, instance, cancelled).await?;
        }
        self.project_config().await?;
        self.emit();
        Ok(())
    }

    async fn record_account_failure(&self, account: &AccountRef, error: &Error) -> Result<()> {
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
        state.verification = None;
        if let Some(candidate) = &mut state.accounts.candidate {
            if matches!(candidate.phase.as_str(), "verifying" | "waiting-to-commit") {
                candidate.phase = "awaiting-verification".to_owned();
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
            state.verification = None;
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
            state.verification = None;
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

    pub async fn refresh(&self, generation: &str) -> Result<Vec<Value>> {
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
            let account = state
                .accounts
                .active
                .clone()
                .filter(|a| a.verified_model.is_some())
                .ok_or_else(|| {
                    Error::new("account_unavailable", "请先连接并验证 Antigravity 账号")
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
                        self.refresh_for(&account, &active, &installed).await?;
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
        if let Err(error) = self.refresh_for(&account, &instance, &installed).await {
            // Local process probes already succeeded. Missing authorization or
            // model discovery is an account error, not a failed executable.
            instance.stop().await?;
            return Err(error);
        }
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
        if Uuid::parse_str(&request.operation_id).is_err()
            || request.model.is_empty()
            || request.model.len() > 256
            || request.model.chars().any(char::is_control)
        {
            return Err(Error::contract());
        }
        let key = format!(
            "{}:{sidecar_generation}:{}",
            request.sidecar_id, request.operation_id
        );
        self.reconcile_dead_leases().await;
        let identity = serde_json::to_string(&(
            &request.model,
            &request.purpose,
            &request.expected_account_generation,
            &request.verification_operation_id,
        ))
        .map_err(|_| Error::contract())?;
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
        let (instance, installed) = if request.purpose == "verification" {
            let state = self.state.lock().await;
            Self::check_state(&state)?;
            let verify = state
                .verification
                .as_ref()
                .filter(|v| {
                    Some(&v.id) == request.verification_operation_id.as_ref()
                        && Some(&v.account_generation)
                            == request.expected_account_generation.as_ref()
                        && v.model == request.model
                })
                .ok_or_else(|| Error::new("verification_expired", "此模型验证已失效"))?;
            let instance = state
                .candidate
                .iter()
                .chain(state.active.iter())
                .find(|i| i.account_generation == verify.account_generation && i.alive())
                .cloned()
                .ok_or_else(Error::cancelled)?;
            drop(state);
            (instance, self.selected(false).await?)
        } else if request.purpose == "execution" {
            self.ensure_active().await?
        } else {
            return Err(Error::contract());
        };
        let component = self.components.allowed(&installed).await?;
        if !component.supports_model(&request.model) {
            return Err(Error::new("model_unapproved", "此模型尚未通过兼容验证"));
        }
        if installed.identity(&self.components.app_version, &self.components.sdk_version)?
            != instance.component_identity
        {
            return Err(Error::cancelled());
        }
        if !instance
            .client
            .routed_models()
            .await?
            .iter()
            .any(|model| model == &request.model)
        {
            self.state
                .lock()
                .await
                .model_identities
                .remove(&instance.account_generation);
            return Err(Error::new(
                "model_unavailable",
                "此模型当前不能由该账号路由",
            ));
        }
        let mut state = self.state.lock().await;
        Self::check_state(&state)?;
        if state.draining && request.purpose == "execution" {
            return Err(Error::new("draining", "正在等待当前任务结束后切换"));
        }
        if !state
            .models
            .get(&instance.account_generation)
            .is_some_and(|models| models.iter().any(|m| m["model"] == request.model))
        {
            return Err(Error::new(
                "model_unavailable",
                "此模型当前不能由该账号路由",
            ));
        }
        if request.purpose == "verification"
            && !state
                .verification
                .as_ref()
                .is_some_and(|v| Some(&v.id) == request.verification_operation_id.as_ref())
        {
            return Err(Error::cancelled());
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
                let approved = component
                    .compatibility
                    .models
                    .iter()
                    .find(|m| m.id == request.model)
                    .ok_or_else(Error::contract)?;
                let model = state
                    .models
                    .get(&instance.account_generation)
                    .and_then(|models| models.iter().find(|m| m["model"] == request.model))
                    .ok_or_else(Error::contract)?;
                super::types::ModelPolicy {
                    id: request.model.clone(),
                    thinking: approved.thinking,
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
        let (instance, model) = {
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
            (instance, lease.model.clone())
        };
        if !instance.client.routed_models().await?.contains(&model) {
            self.state
                .lock()
                .await
                .model_identities
                .remove(&instance.account_generation);
            return Err(Error::new(
                "model_unavailable",
                "此模型当前不能由该账号路由",
            ));
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
        if !installed.component()?.supports_model(&lease.model) {
            return Err(Error::new("model_unapproved", "此模型已不在当前兼容清单中"));
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
            let mut state = self.state.lock().await;
            if let Some(cancel) = &state.cancel {
                let _ = cancel.send(true);
            }
            state.verification = None;
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
        let installed = Installed {
            approval: approved,
            source: "updated".to_owned(),
        };
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
                && !next_component.credential_compatible(&current.component()?)
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
                    candidate.phase = "awaiting-verification".to_owned();
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
                    && next_component.credential_compatible(&old.component()?)
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
            let mut state = self.state.lock().await;
            if let Some(cancel) = &state.cancel {
                let _ = cancel.send(true);
            }
            state.verification = None;
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
        let _ = self.shutdown.send(true);
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
        let verified_model = active.and_then(|a| a.verified_model.clone());
        let verified_at = active.and_then(|a| a.verified_at.clone());
        let path = &self.config_path;
        if !path.exists() {
            return Ok(());
        }
        crate::config_io::with_config_lock(&path, false, |config| {
            let id = "antigravity-sub";
            if let Some(at) = &verified_at {
                config["providerVerifyStatus"][id] = json!({ "status": "valid", "verifiedAt": at });
                if config["providerPrimaryModels"][id]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .is_none()
                {
                    config["providerPrimaryModels"][id] = json!(verified_model);
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

#[cfg(all(test, unix))]
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
            let component = approval.verify().unwrap().component;
            let components = ComponentStore::new(
                directory.path(),
                directory.path().join("bundled"),
                component
                    .compatibility
                    .app_versions
                    .iter()
                    .next()
                    .unwrap()
                    .clone(),
                component.compatibility.sdk_version,
            )
            .unwrap();
            components
                .ingest_controls(&approval, "cached")
                .await
                .unwrap();
            let installed = Installed {
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
    async fn policy_stop_reaches_writer_before_waiting_for_normal_drain_fence() {
        let _serial = LIFECYCLE.lock().await;
        let mut fixture = Fixture::new().await;
        let instance = fixture.process("active");
        fixture.manager.state.lock().await.active = Some(Arc::clone(&instance));
        let fence = fixture.manager.active_start.lock().await;
        let manager = Arc::clone(&fixture.manager);
        let stop = tokio::spawn(async move { manager.stop_for_policy().await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while instance.alive() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!stop.is_finished());
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
                            thinking: false,
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
