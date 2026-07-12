use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
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

pub struct SessionGoalManager {
    pub(super) state: Arc<RwLock<SessionGoalStoreState>>,
    pub(super) storage_path: PathBuf,
    pub(super) continuation_handles:
        Arc<RwLock<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    pub(super) delivery_replayers: Arc<RwLock<HashSet<String>>>,
    pub(super) app_handle: Arc<RwLock<Option<AppHandle>>>,
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
            delivery_replayers: Arc::new(RwLock::new(HashSet::new())),
            app_handle: Arc::new(RwLock::new(None)),
        }
    }

    #[cfg(test)]
    pub fn with_storage_path(storage_path: PathBuf) -> Self {
        Self {
            state: Arc::new(RwLock::new(store::load(&storage_path))),
            storage_path,
            continuation_handles: Arc::new(RwLock::new(HashMap::new())),
            delivery_replayers: Arc::new(RwLock::new(HashSet::new())),
            app_handle: Arc::new(RwLock::new(None)),
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
                if goal.status == GoalStatus::Paused && goal.current_turn.is_none() {
                    return Ok(());
                }
                goal.status = GoalStatus::Paused;
                goal.current_turn = None;
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
        match self.stop_goal_turn(&goal, None).await {
            Ok(()) => {
                if let Err(error) = self.release_goal_owner(&goal).await {
                    ulog_warn!(
                        "[Goal] paused Goal {} but owner release failed: {}",
                        goal.id,
                        error
                    );
                }
            }
            Err(error) => {
                ulog_warn!(
                    "[Goal] paused Goal {} but runtime stop was not confirmed: {}",
                    goal.id,
                    error
                );
            }
        }
        Ok(goal)
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
                if goal.status == GoalStatus::Paused && goal.current_turn.is_none() {
                    return Ok(false);
                }
                let owns_turn = goal.current_turn.as_ref().is_some_and(|turn| {
                    turn.queue_id == queue_id && turn.sidecar_generation == sidecar_generation
                });
                if !owns_turn {
                    return Err(GoalMutationError::stale_turn(
                        "Pause does not own the current Goal turn",
                    ));
                }
                goal.status = GoalStatus::Paused;
                goal.current_turn = None;
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
        self.release_goal_owner(&updated).await.map_err(|error| {
            GoalMutationError::goal(format!(
                "Goal paused, but its owner was not released: {error}"
            ))
        })?;
        Ok(updated)
    }

    pub async fn resume_goal(&self, goal_id: &str) -> Result<SessionGoal, GoalMutationError> {
        let now = Utc::now();
        let (updated, _, changed) = self
            .commit(goal_id, move |goal| {
                if goal.is_terminal() {
                    return Err(GoalMutationError::terminal("Goal is already terminal"));
                }
                if goal.status == GoalStatus::Active {
                    return Ok(());
                }
                goal.status = GoalStatus::Active;
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
        let previous_queue_id = current
            .current_turn
            .as_ref()
            .map(|turn| turn.queue_id.clone());
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
                goal.current_turn = None;
                goal.updated_at = now;
                goal.bump_revision();
                goal.bump_control_revision();
                Ok(())
            })
            .await?;
        if changed {
            self.cancel_continuation(goal_id).await;
            self.emit_changed(&updated).await;
            if updated.status == GoalStatus::Active {
                let stop_result = if let Some(queue_id) = previous_queue_id.as_deref() {
                    self.stop_goal_turn(&updated, Some(queue_id)).await
                } else {
                    Ok(())
                };
                match stop_result {
                    Ok(()) => self.ensure_continuation(goal_id, 0).await,
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
                        return Ok(current.clone());
                    }
                    return Err(GoalMutationError::turn_conflict(
                        "Another Goal turn currently owns this Session",
                    ));
                }
                if goal.status == GoalStatus::Paused && kind != GoalTurnKind::UserQuery {
                    return Err(GoalMutationError::turn_conflict("Goal is paused"));
                }
                if goal.status == GoalStatus::Paused {
                    goal.status = GoalStatus::Active;
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
                Ok(authority)
            })
            .await?;

        let attached = {
            let mut sidecars = sidecars.lock().map_err(|error| {
                GoalMutationError::goal(format!("Sidecar lock poisoned: {error}"))
            })?;
            sidecars.generation_for(session_id) == Some(sidecar_generation)
                && sidecars.add_session_owner(session_id, SidecarOwner::Goal(goal_id.to_string()))
        };
        if !attached {
            let _ = self.abort_turn(goal_id, &authority.queue_id).await;
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
            self.ensure_continuation(goal_id, 0).await;
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
        error: Option<String>,
    ) -> Result<SessionGoal, GoalMutationError> {
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
        if became_terminal {
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
                goal.current_turn = None;
                goal.turn_count = goal.turn_count.max(authority.turn_number);
                goal.last_executed_at = Some(now);
                goal.total_duration_ms = goal.total_duration_ms.saturating_add(request.duration_ms);
                goal.total_tokens = goal.total_tokens.saturating_add(request.consumed_tokens);
                goal.consecutive_failures = if request.success {
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
                let became_terminal =
                    !request.success && goal.consecutive_failures >= 10 && !goal.is_terminal();
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
        let current = self
            .get(goal_id)
            .await?
            .ok_or_else(|| GoalMutationError::goal_changed("Goal identity changed"))?;
        let _lifecycle = crate::sidecar::acquire_session_lifecycle(&[&current.session_id]).await;
        let outcome = self
            .transition_terminal(
                goal_id,
                GoalStatus::Canceled,
                reason,
                GoalTerminalActor::User,
            )
            .await?;
        let (goal, should_stop) = match outcome {
            GoalTerminalOutcome::Applied(goal) => (goal, true),
            GoalTerminalOutcome::AlreadyTerminal(goal) => {
                let retry_canceled_cleanup = goal.status == GoalStatus::Canceled;
                (goal, retry_canceled_cleanup)
            }
        };
        if !should_stop {
            return Ok(goal);
        }
        match self.stop_goal_turn(&goal, None).await {
            Ok(()) => {
                if let Err(error) = self.release_goal_owner(&goal).await {
                    ulog_warn!(
                        "[Goal] canceled Goal {} but owner release failed: {}",
                        goal.id,
                        error
                    );
                }
            }
            Err(error) => {
                ulog_warn!(
                    "[Goal] canceled Goal {} but runtime stop was not confirmed: {}",
                    goal.id,
                    error
                );
            }
        }
        Ok(goal)
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
                } else {
                    goal.current_turn = None;
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
        if changed {
            self.emit_changed(&updated).await;
        }
        if actor != GoalTerminalActor::Model {
            let _ = self.release_goal_owner(&updated).await;
        }
        self.send_terminal_notification(&updated).await;
        Ok(GoalTerminalOutcome::Applied(updated))
    }

    async fn stop_goal_turn(
        &self,
        goal: &SessionGoal,
        queue_id: Option<&str>,
    ) -> Result<(), String> {
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
        let Some(app_handle) = self.app_handle.read().await.clone() else {
            return Ok(false);
        };
        let Some(sidecars) = app_handle.try_state::<ManagedSidecarManager>() else {
            return Err("Sidecar manager is unavailable".to_string());
        };
        let stopped = release_session_sidecar(
            sidecars.inner(),
            &goal.session_id,
            &SidecarOwner::Goal(goal.id.clone()),
        )?;
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
    use std::sync::Mutex;
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
        #[cfg(windows)]
        let mut command = {
            let mut command = crate::process_cmd::new("cmd");
            command.args(["/C", "exit", "0"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = crate::process_cmd::new("true");

        let mut process = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test sidecar placeholder");
        process.wait().expect("reap test sidecar placeholder");
        let mut manager = SidecarManager::new();
        manager.insert_sidecar(
            session_id,
            SessionSidecar {
                process,
                port: 31_418,
                session_id: session_id.to_string(),
                workspace_path: PathBuf::from("/tmp/workspace"),
                state: SidecarState::Healthy,
                owners: HashSet::from([SidecarOwner::Goal(goal_id.to_string())]),
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
            error: None,
            output_text: Some("done".to_string()),
            duration_ms,
            consumed_tokens,
            channel_delivery_expected: false,
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
        assert!(updated.current_turn.is_none());
    }

    #[test]
    fn failure_backoff_is_bounded() {
        assert_eq!(failure_backoff(1), 3);
        assert_eq!(failure_backoff(2), 10);
        assert_eq!(failure_backoff(5), 120);
        assert_eq!(failure_backoff(10), 300);
    }
}
