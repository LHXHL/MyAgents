use super::*;
use crate::task::notification::{ConversationRef, CreationContext, DeliveryState};
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SourceContext {
    sidecar_id: String,
    queue_id: String,
    task_id: Option<String>,
    conversation: Option<ConversationRef>,
}

pub(super) async fn creation_context(
    headers: &HeaderMap,
    context: Option<SourceContext>,
) -> Result<CreationContext, String> {
    let Some(context) = context else {
        return Ok(CreationContext::default());
    };
    if context.queue_id.is_empty() {
        return Err("Notification source has no active turn".into());
    }
    let source = channel_messaging::caller(headers, &context.sidecar_id)?;
    let scope = im::channel_messaging::resolve_scope(
        get_agents(),
        get_im_bots(),
        &source.product_session_id,
        &source.workspace_path,
    )
    .await?;
    let allowed_channels: Vec<_> = scope.channels.iter().map(|c| c.id.clone()).collect();
    if context
        .conversation
        .as_ref()
        .is_some_and(|c| !allowed_channels.contains(&c.channel_id))
    {
        return Err("Notification source is outside the Session's Agent".into());
    }
    let parent_policy = match context.task_id {
        Some(task_id) => Some(
            crate::task_scheduler::get_task_scheduler()
                .notification_policy_for_execution(
                    &task_id,
                    &context.queue_id,
                    &source.product_session_id,
                )
                .await?,
        ),
        None => None,
    };
    Ok(CreationContext {
        conversation: context.conversation,
        parent_policy,
        allowed_channels: Some(allowed_channels),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Receipt {
    sidecar_id: String,
    task_id: String,
    delivery_id: String,
    attempt_id: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    outcome: Option<String>,
}

async fn checked_record(
    headers: &HeaderMap,
    request: &Receipt,
) -> Result<crate::task::notification::NotificationDelivery, String> {
    let source = channel_messaging::caller(headers, &request.sidecar_id)?;
    let task = task::get_task_store()
        .ok_or("Task store unavailable")?
        .get(&request.task_id)
        .await
        .ok_or("Task not found")?;
    if task.deleted {
        return Err("Task was deleted".into());
    }
    task.notification_deliveries
        .into_iter()
        .find(|d| {
            d.id == request.delivery_id
                && d.attempt_id.as_deref() == Some(&request.attempt_id)
                && d.target_session_id.as_deref() == Some(&source.product_session_id)
                && d.state == DeliveryState::Preparing
        })
        .ok_or_else(|| "Notification attempt is no longer current".into())
}

pub(super) async fn authorize(headers: HeaderMap, Json(request): Json<Receipt>) -> Json<Value> {
    let result = async {
        let d = checked_record(&headers, &request).await?;
        let address = d.target.ok_or("Notification target missing")?;
        let channel = im::task_notification::channel(&address.channel_id)?;
        if channel.agent_id != d.agent_id { return Err("Notification Channel ownership changed".into()); }
        if channel.mode == im::types::ChannelDeliveryMode::ToolOnly { return Ok(json!({"ok":true,"accepted":false,"code":"suppressed","error":"Channel uses tool_only"})); }
        let owner = match im::channel_handoff::channel_owner(get_agents(), get_im_bots(), &address.channel_id).await {
            Ok(owner) => owner,
            Err(error) => return Ok(json!({"ok":true,"accepted":false,"code":"offline","error":error})),
        };
        if owner.notification_peer(&address.session_key).await.is_none_or(|p| Some(p.session_id) != d.target_session_id) {
            return Ok(json!({"ok":true,"accepted":false,"code":"binding_changed","error":"Notification binding changed before dispatch"}));
        }
        Ok::<_, String>(json!({"ok":true,"accepted":true}))
    }.await;
    Json(result.unwrap_or_else(|error| json!({"ok":false,"accepted":false,"error":error})))
}

pub(super) async fn terminal(headers: HeaderMap, Json(request): Json<Receipt>) -> Json<Value> {
    let result = async {
        let source = channel_messaging::caller(&headers, &request.sidecar_id)?;
        let store = task::get_task_store().ok_or("Task store unavailable")?;
        store
            .settle_notification_preparation(
                &request.task_id,
                &request.delivery_id,
                &request.attempt_id,
                &source.product_session_id,
                task::notification::PreparationReceipt {
                    outcome: request.outcome.as_deref(),
                    text: request.text.as_deref(),
                    error: request.error.as_deref(),
                },
            )
            .await?;
        Ok::<_, String>(json!({"ok":true}))
    }
    .await;
    Json(result.unwrap_or_else(|error| json!({"ok":false,"error":error})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Operation {
    task_id: String,
    delivery_id: String,
    action: String,
}
pub(super) async fn operate(Json(request): Json<Operation>) -> Json<Value> {
    let result = async {
        crate::task_application::TaskApplication::from_globals()
            .map_err(|e| e.to_string())?
            .operate_notification(&request.task_id, &request.delivery_id, &request.action)
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    Json(match result {
        Ok(delivery) => json!({"ok":true,"delivery":delivery}),
        Err(error) => json!({"ok":false,"error":error}),
    })
}

/// Validate only an explicit changed target at the authenticated management
/// boundary. GUI/global callers retain the existing all-workspaces scope.
pub(super) async fn validate_update(
    headers: &HeaderMap,
    context: Option<SourceContext>,
    input: &mut task::TaskUpdateInput,
) -> Result<(), String> {
    let context = creation_context(headers, context).await?;
    task::notification::resolve_update_current(input, &context)?;
    let Some(store) = task::get_task_store() else {
        return Err("Task store unavailable".into());
    };
    if input.notification.is_none()
        && input
            .notification_patch
            .as_ref()
            .is_none_or(|patch| patch.is_empty())
    {
        return Ok(());
    }
    let current = store.get(&input.id).await.ok_or("Task not found")?;
    let candidate = if let Some(config) = input.notification.clone() {
        task::notification::normalize_replacement(config, current.notification.as_ref())?
    } else {
        input
            .notification_patch
            .clone()
            .unwrap()
            .apply(current.notification.clone())?
    };
    if candidate.im
        != current
            .notification
            .as_ref()
            .and_then(|config| config.im.clone())
    {
        im::task_notification::validate_target(
            candidate.im.as_ref().unwrap_or(&Default::default()),
            context.allowed_channels.as_deref(),
            get_agents(),
            get_im_bots(),
        )
        .await?;
    }
    Ok(())
}
