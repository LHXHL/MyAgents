//! Rebuildable processing of TaskStore intents, independent from business ticks.
use super::{notification::*, *};
use crate::im::{
    channel_handoff::channel_owner,
    task_notification, ManagedAgents, ManagedImBots,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

pub fn after_commit(task: &Task, event: Option<&NotificationDelivery>) {
    let Some(event) = event else {
        return;
    };
    let Some(handle) = crate::logger::get_app_handle() else {
        return;
    };
    if event.policy.desktop {
        let navigation = event
            .execution_session_id
            .as_ref()
            .and_then(|id| {
                crate::notification::NotificationNavigation::for_session(
                    None,
                    id.clone(),
                    task.workspace_path.clone(),
                )
            })
            .or_else(|| {
                Some(crate::notification::NotificationNavigation::for_task(
                    task.id.clone(),
                ))
            });
        crate::notification::show_with_navigation_target_and_badge(
            &handle,
            &event.title,
            &event.result.chars().take(180).collect::<String>(),
            navigation,
            Some(crate::notification_badge::NotificationBadgeIncrement {
                id: format!("task-notification:{}", event.id),
                source: "task-center".into(),
                created_at: event.created_at,
                target: crate::notification_badge::NotificationBadgeTarget::TaskCenter {
                    task_id: Some(task.id.clone()),
                },
            }),
        );
    }
}

pub fn start(app: tauri::AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tick.tick().await;
            let Some(store) = get_task_store() else {
                continue;
            };
            // No FIFO dependency on unresolved earlier deliveries.
            let tasks = store
                .list(TaskListFilter {
                    include_managed: Some(true),
                    ..Default::default()
                })
                .await;
            for task in tasks {
                if task.deleted {
                    continue;
                }
                for record in &task.notification_deliveries {
                    if matches!(
                        record.state,
                        DeliveryState::Preparing | DeliveryState::Sending
                    ) && now_ms() - record.updated_at > 360_000
                    {
                        let _ = finish(store, &task, record, DeliveryState::Unknown, Some("Session admission was not confirmed; inspect the destination before resending".into())).await;
                        continue;
                    }
                    if matches!(
                        record.state,
                        DeliveryState::Waiting | DeliveryState::Prepared
                    ) && record.attempt_id.is_some()
                        && now_ms() - record.updated_at > 30_000
                    {
                        let _ = finish(
                            store,
                            &task,
                            record,
                            DeliveryState::Waiting,
                            Some(
                                "Notification processing interrupted before admission; will retry"
                                    .into(),
                            ),
                        )
                        .await;
                        continue;
                    }
                    if !matches!(
                        record.state,
                        DeliveryState::Waiting | DeliveryState::Prepared
                    ) || record.attempt_id.is_some()
                        || record.retry_at.is_some_and(|at| at > now_ms())
                    {
                        continue;
                    }
                    if let Err(error) = process(&app, store, &task, record).await {
                        crate::ulog_warn!(
                            "[task-notification] task={} delivery={} {}",
                            task.id,
                            record.id,
                            error
                        );
                    }
                }
            }
        }
    });
}

async fn finish(
    store: &TaskStore,
    task: &Task,
    d: &NotificationDelivery,
    state: DeliveryState,
    error: Option<String>,
) -> Result<(), String> {
    store
        .mutate_notification(&task.id, &d.id, d.attempt_id.as_deref(), |current| {
            if current.state != d.state
                && !(d.state == DeliveryState::Waiting && current.state == DeliveryState::Preparing)
            {
                return Err("Notification already advanced".into());
            }
            current.state = if state == DeliveryState::Waiting && current.prepared_text.is_some() {
                DeliveryState::Prepared
            } else {
                state
            };
            current.error = error;
            current.attempt_id = None;
            current.retry_at = (state == DeliveryState::Waiting).then(|| now_ms() + 30_000);
            Ok(())
        })
        .await
        .map(|_| ())
}

async fn process(
    app: &tauri::AppHandle,
    store: &TaskStore,
    task: &Task,
    record: &NotificationDelivery,
) -> Result<(), String> {
    let mut d = store
        .mutate_notification(&task.id, &record.id, None, |d| {
            if d.attempt_id.is_some()
                || !matches!(d.state, DeliveryState::Waiting | DeliveryState::Prepared)
            {
                return Err("Notification already claimed".into());
            }
            d.state = DeliveryState::Waiting;
            d.prepared_text = None;
            d.attempt_id = Some(Uuid::new_v4().to_string());
            Ok(())
        })
        .await?;
    let agents = app.try_state::<ManagedAgents>();
    let bots = app.try_state::<ManagedImBots>();
    if d.target.is_none() {
        let target = match task_notification::resolve_target(
            d.policy.im.as_ref().unwrap_or(&NotificationTarget::Off),
            agents.as_deref(),
            bots.as_deref(),
        )
        .await
        {
            Ok(Some(target)) => target,
            Ok(None) => {
                return finish(
                    store,
                    task,
                    &d,
                    DeliveryState::Waiting,
                    Some("Waiting for a private conversation in the selected scope".into()),
                )
                .await
            }
            Err(error) => {
                let state = if error.contains("offline") {
                    DeliveryState::Waiting
                } else {
                    DeliveryState::Failed
                };
                return finish(store, task, &d, state, Some(error)).await;
            }
        };
        let channel = match task_notification::channel(&target.channel_id) {
            Ok(channel) => channel,
            Err(error) => return finish(store, task, &d, DeliveryState::Failed, Some(error)).await,
        };
        let expected_owner = match d.policy.im.as_ref() {
            Some(NotificationTarget::RecentPrivate {
                target: RecentPrivate::Agent { agent_id },
            }) => Some(agent_id.clone()),
            _ => d.policy.channel_owner.clone(),
        };
        if channel.agent_id != expected_owner {
            return finish(
                store,
                task,
                &d,
                DeliveryState::Failed,
                Some("Channel ownership changed".into()),
            )
            .await;
        }
        d = store
            .mutate_notification(&task.id, &d.id, d.attempt_id.as_deref(), |d| {
                d.target = Some(target);
                d.agent_id = channel.agent_id;
                Ok(())
            })
            .await?;
    }
    let address = d.target.as_ref().ok_or("Missing target")?;
    let channel = match task_notification::channel(&address.channel_id) {
        Ok(channel) => channel,
        Err(error) => return finish(store, task, &d, DeliveryState::Failed, Some(error)).await,
    };
    if channel.agent_id != d.agent_id {
        return finish(
            store,
            task,
            &d,
            DeliveryState::Failed,
            Some("Channel ownership changed".into()),
        )
        .await;
    }
    let owner = match channel_owner(agents.as_deref(), bots.as_deref(), &address.channel_id).await {
        Ok(owner) => owner,
        Err(error) => return finish(store, task, &d, DeliveryState::Waiting, Some(error)).await,
    };
    let manager = app.state::<crate::sidecar::ManagedSidecarManager>();
    match owner
        .deliver_notification(app, manager.inner(), store, &task.id, &d)
        .await
    {
        Ok(crate::inbox::deliver::DeliverOutcome::Delivered { .. }) => Ok(()),
        Ok(crate::inbox::deliver::DeliverOutcome::Unconfirmed { reason }) => {
            finish(store, task, &d, DeliveryState::Unknown, Some(reason)).await
        }
        Ok(outcome) => {
            finish(
                store,
                task,
                &d,
                DeliveryState::Failed,
                Some(format!("Notification admission failed: {outcome:?}")),
            )
            .await
        }
        Err(error) => finish(store, task, &d, DeliveryState::Waiting, Some(error)).await,
    }
}
