use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, CONTENT_DISPOSITION};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Response as IpcResponse, AppHandle};
use zip::ZipArchive;

use crate::device_identity::{current_device_identity, DeviceIdentity};
use crate::sidecar::ManagedSidecarManager;
use crate::workspace_files::path_safety::{
    atomic_write_file, resolve_inside_workspace, validate_workspace_root,
};
use crate::{ulog_info, ulog_warn};

const SPACE_ENABLED_ENV: Option<&str> = option_env!("MYAGENTS_SPACE_ENABLED");
const SPACE_BASE_URL_ENV: Option<&str> = option_env!("MYAGENTS_SPACE_BASE_URL");
const SPACE_PUBLIC_CLIENT_ID_ENV: Option<&str> = option_env!("MYAGENTS_SPACE_PUBLIC_CLIENT_ID");
const SPACE_LEGACY_CLIENT_ID_ENV: Option<&str> = option_env!("MYAGENTS_SPACE_CLIENT_ID");
const SPACE_PUBLIC_CLIENT_ID_HEADER: &str = "X-MyAgents-Space-Client-Id";
const SESSION_FILE: &str = "session.json";
const LOCAL_AGENTS_FILE: &str = "registered_agents.json";
const DELIVERY_LOG_FILE: &str = "delivery_log.json";
const SPACE_CONNECTOR_INTERVAL_SECS: u64 = 60;
pub(crate) const MAX_SKILL_ZIP_BYTES: usize = 50 * 1024 * 1024;
const MAX_SKILL_ZIP_ENTRIES: usize = 512;
const MAX_SKILL_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
const MAX_ATTACHMENT_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_UPLOAD_COUNT: usize = 5;
static SPACE_CONNECTOR_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSession {
    pub base_url: String,
    pub session_token: String,
    pub expires_at: Option<String>,
    pub user: Value,
    pub space: Value,
    pub membership: Value,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSessionPublic {
    pub base_url: String,
    pub expires_at: Option<String>,
    pub user: Value,
    pub space: Value,
    pub membership: Value,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceBuildCapability {
    pub available: bool,
    pub base_url: Option<String>,
    pub public_client_id: Option<String>,
    pub reason: Option<String>,
}

impl From<SpaceSession> for SpaceSessionPublic {
    fn from(session: SpaceSession) -> Self {
        Self {
            base_url: session.base_url,
            expires_at: session.expires_at,
            user: session.user,
            space: session.space,
            membership: session.membership,
            updated_at: session.updated_at,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpaceIssueSubscriptionRunMode {
    SingleSession,
    NewSession,
}

impl Default for SpaceIssueSubscriptionRunMode {
    fn default() -> Self {
        Self::SingleSession
    }
}

fn default_issue_subscription_run_mode() -> SpaceIssueSubscriptionRunMode {
    SpaceIssueSubscriptionRunMode::SingleSession
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRegisteredAgent {
    pub id: String,
    #[serde(default)]
    pub base_url: String,
    pub space_id: String,
    #[serde(default)]
    pub owner_user_id: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub device_platform: Option<String>,
    #[serde(default)]
    pub device_os_version: Option<String>,
    #[serde(default)]
    pub device_app_version: Option<String>,
    #[serde(default)]
    pub device_last_seen_at: Option<String>,
    #[serde(default)]
    pub local_workspace_id: Option<String>,
    #[serde(default)]
    pub local_agent_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub display_name: String,
    pub workspace_path: String,
    pub workspace_label: Option<String>,
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub goal_path_label: Option<String>,
    #[serde(default = "default_agent_state_filter")]
    pub state_filter: Vec<String>,
    #[serde(default)]
    pub goal_md: Option<String>,
    #[serde(default)]
    pub delivery_session_id: Option<String>,
    #[serde(default = "default_issue_subscription_run_mode")]
    pub issue_subscription_run_mode: SpaceIssueSubscriptionRunMode,
    #[serde(default)]
    pub issue_session_ids: BTreeMap<String, String>,
    pub token: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUserDeviceSummary {
    pub device_id: String,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub os_version: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRegisteredAgentPublic {
    pub id: String,
    pub base_url: String,
    pub space_id: String,
    pub owner_user_id: Option<String>,
    pub device_id: Option<String>,
    pub client_id: Option<String>,
    pub device_name: Option<String>,
    pub device: Option<SpaceUserDeviceSummary>,
    pub is_local: Option<bool>,
    pub local_workspace_id: Option<String>,
    pub local_agent_id: Option<String>,
    pub workspace_id: Option<String>,
    pub display_name: String,
    pub workspace_path: String,
    pub workspace_label: Option<String>,
    pub goal_id: Option<String>,
    pub goal_path_label: Option<String>,
    pub state_filter: Vec<String>,
    pub goal_md: Option<String>,
    pub delivery_session_id: Option<String>,
    pub issue_subscription_run_mode: SpaceIssueSubscriptionRunMode,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<LocalRegisteredAgent> for LocalRegisteredAgentPublic {
    fn from(agent: LocalRegisteredAgent) -> Self {
        let device = agent_device_summary(&agent);
        Self {
            id: agent.id,
            base_url: agent.base_url,
            space_id: agent.space_id,
            owner_user_id: agent.owner_user_id,
            device_id: agent.device_id,
            client_id: agent.client_id,
            device_name: agent
                .device_name
                .or_else(|| device.as_ref().and_then(|item| item.device_name.clone())),
            device,
            is_local: None,
            local_workspace_id: agent.local_workspace_id,
            local_agent_id: agent.local_agent_id,
            workspace_id: agent.workspace_id,
            display_name: agent.display_name,
            workspace_path: agent.workspace_path,
            workspace_label: agent.workspace_label,
            goal_id: agent.goal_id,
            goal_path_label: agent.goal_path_label,
            state_filter: agent.state_filter,
            goal_md: agent.goal_md,
            delivery_session_id: agent.delivery_session_id,
            issue_subscription_run_mode: agent.issue_subscription_run_mode,
            status: agent.status,
            created_at: agent.created_at,
            updated_at: agent.updated_at,
        }
    }
}

fn value_issue_subscription_run_mode(
    value: &Value,
    key: &str,
) -> Option<SpaceIssueSubscriptionRunMode> {
    value
        .get(key)
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

fn first_subscription_from_data(data: &Value) -> Option<&Value> {
    data.get("subscription").or_else(|| {
        data.get("subscriptions")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
    })
}

fn apply_subscription_to_local_agent(
    agent: &mut LocalRegisteredAgent,
    subscription: Option<&Value>,
) {
    let Some(subscription) = subscription else {
        return;
    };
    if let Some(goal_id) = optional_value_string(subscription, "goalId") {
        agent.goal_id = Some(goal_id);
    }
    if let Some(goal_path_label) = optional_value_string(subscription, "goalPathLabel") {
        agent.goal_path_label = Some(goal_path_label);
    }
    if let Some(state_filter) =
        value_string_array(subscription, "stateFilter").filter(|items| !items.is_empty())
    {
        agent.state_filter = state_filter;
    }
}

fn agent_device_summary(agent: &LocalRegisteredAgent) -> Option<SpaceUserDeviceSummary> {
    let device_id = agent.device_id.as_deref()?.trim();
    if device_id.is_empty() {
        return None;
    }
    Some(SpaceUserDeviceSummary {
        device_id: device_id.to_string(),
        device_name: agent.device_name.clone(),
        platform: agent.device_platform.clone(),
        os_version: agent.device_os_version.clone(),
        app_version: agent.device_app_version.clone(),
        status: None,
        last_seen_at: agent.device_last_seen_at.clone(),
    })
}

fn device_summary_from_cloud(
    registered: &Value,
    fallback: Option<&LocalRegisteredAgent>,
    local_identity: Option<&DeviceIdentity>,
) -> Option<SpaceUserDeviceSummary> {
    let device_value = registered.get("device").filter(|value| value.is_object());
    let device_id = optional_value_string(registered, "deviceId")
        .or_else(|| device_value.and_then(|value| optional_value_string(value, "deviceId")))
        .or_else(|| fallback.and_then(|agent| agent.device_id.clone()))
        .or_else(|| local_identity.map(|identity| identity.device_id.clone()))?;
    let device_name = optional_value_string(registered, "deviceName")
        .or_else(|| device_value.and_then(|value| optional_value_string(value, "deviceName")))
        .or_else(|| fallback.and_then(|agent| agent.device_name.clone()))
        .or_else(|| local_identity.and_then(|identity| identity.device_name.clone()));
    Some(SpaceUserDeviceSummary {
        device_id,
        device_name,
        platform: device_value
            .and_then(|value| optional_value_string(value, "platform"))
            .or_else(|| fallback.and_then(|agent| agent.device_platform.clone()))
            .or_else(|| local_identity.map(|identity| identity.platform.clone())),
        os_version: device_value
            .and_then(|value| optional_value_string(value, "osVersion"))
            .or_else(|| fallback.and_then(|agent| agent.device_os_version.clone()))
            .or_else(|| local_identity.and_then(|identity| identity.os_version.clone())),
        app_version: device_value
            .and_then(|value| optional_value_string(value, "appVersion"))
            .or_else(|| fallback.and_then(|agent| agent.device_app_version.clone()))
            .or_else(|| local_identity.map(|identity| identity.app_version.clone())),
        status: device_value.and_then(|value| optional_value_string(value, "status")),
        last_seen_at: device_value
            .and_then(|value| optional_value_string(value, "lastSeenAt"))
            .or_else(|| fallback.and_then(|agent| agent.device_last_seen_at.clone())),
    })
}

fn local_registered_agent_public_from_cloud(
    session: &SpaceSession,
    registered: &Value,
    subscription: Option<&Value>,
    fallback: Option<&LocalRegisteredAgent>,
) -> Result<LocalRegisteredAgentPublic, String> {
    let device = device_summary_from_cloud(registered, fallback, None);
    let state_filter = subscription
        .and_then(|value| value_string_array(value, "stateFilter"))
        .filter(|items| !items.is_empty())
        .or_else(|| fallback.map(|agent| agent.state_filter.clone()))
        .unwrap_or_else(default_agent_state_filter);
    Ok(LocalRegisteredAgentPublic {
        id: required_value_string(registered, "id")?,
        base_url: session.base_url.clone(),
        space_id: required_value_string(registered, "spaceId")
            .or_else(|_| required_value_string(&session.space, "id"))?,
        owner_user_id: optional_value_string(registered, "ownerUserId")
            .or_else(|| fallback.and_then(|agent| agent.owner_user_id.clone()))
            .or_else(|| session_user_id(session)),
        device_id: device.as_ref().map(|device| device.device_id.clone()),
        client_id: optional_value_string(registered, "clientId")
            .or_else(|| fallback.and_then(|agent| agent.client_id.clone())),
        device_name: optional_value_string(registered, "deviceName")
            .or_else(|| device.as_ref().and_then(|item| item.device_name.clone())),
        device,
        is_local: None,
        local_workspace_id: optional_value_string(registered, "localWorkspaceId")
            .or_else(|| fallback.and_then(|agent| agent.local_workspace_id.clone())),
        local_agent_id: optional_value_string(registered, "localAgentId")
            .or_else(|| fallback.and_then(|agent| agent.local_agent_id.clone())),
        workspace_id: optional_value_string(registered, "localWorkspaceId")
            .or_else(|| fallback.and_then(|agent| agent.workspace_id.clone())),
        display_name: required_value_string(registered, "displayName")?,
        workspace_path: optional_value_string(registered, "workspacePath")
            .or_else(|| fallback.map(|agent| agent.workspace_path.clone()))
            .unwrap_or_default(),
        workspace_label: registered
            .get("workspaceLabel")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| fallback.and_then(|agent| agent.workspace_label.clone())),
        goal_id: subscription
            .and_then(|value| optional_value_string(value, "goalId"))
            .or_else(|| fallback.and_then(|agent| agent.goal_id.clone())),
        goal_path_label: subscription
            .and_then(|value| optional_value_string(value, "goalPathLabel"))
            .or_else(|| fallback.and_then(|agent| agent.goal_path_label.clone())),
        state_filter,
        goal_md: optional_value_string(registered, "goalMd")
            .or_else(|| fallback.and_then(|agent| agent.goal_md.clone())),
        delivery_session_id: fallback.and_then(|agent| agent.delivery_session_id.clone()),
        issue_subscription_run_mode: value_issue_subscription_run_mode(
            registered,
            "issueSubscriptionRunMode",
        )
        .or_else(|| fallback.map(|agent| agent.issue_subscription_run_mode))
        .unwrap_or_default(),
        status: required_value_string(registered, "status")?,
        created_at: required_value_string(registered, "createdAt")
            .or_else(|_| Ok::<String, String>(chrono::Utc::now().to_rfc3339()))?,
        updated_at: required_value_string(registered, "updatedAt")
            .or_else(|_| Ok::<String, String>(chrono::Utc::now().to_rfc3339()))?,
    })
}

fn default_agent_state_filter() -> Vec<String> {
    vec!["todo".to_string()]
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRegisteredAgentsFile {
    items: Vec<LocalRegisteredAgent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceAuthPollInput {
    pub login_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceApiRequestInput {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRegisterAgentInput {
    pub display_name: String,
    pub workspace_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub workspace_label: Option<String>,
    pub goal_id: String,
    #[serde(default)]
    pub state_filter: Option<Vec<String>>,
    #[serde(default)]
    pub goal_md: Option<String>,
    #[serde(default)]
    pub issue_subscription_run_mode: Option<SpaceIssueSubscriptionRunMode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUpdateRegisteredAgentInput {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub workspace_label: Option<String>,
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub state_filter: Option<Vec<String>>,
    #[serde(default)]
    pub goal_md: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub issue_subscription_run_mode: Option<SpaceIssueSubscriptionRunMode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRegisteredAgentIdInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacePollDispatchesInput {
    pub registered_agent_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceMarkDispatchDeliveredInput {
    pub registered_agent_id: String,
    pub dispatch_id: String,
    pub local_task_id: Option<String>,
    pub local_run_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacePollDeliveriesInput {
    pub registered_agent_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceMarkDeliveryDeliveredInput {
    pub registered_agent_id: String,
    pub delivery_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceInstallSkillInput {
    pub skill_id: String,
    pub skill_name: String,
    pub target: SpaceSkillInstallTarget,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUploadSkillInput {
    pub file_path: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub skill_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUploadIssueAttachmentsInput {
    pub issue_id: String,
    pub file_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpaceSkillInstallTarget {
    Global,
    Project,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceInstallSkillResult {
    pub installed_name: String,
    pub installed_path: String,
    pub target: String,
    pub renamed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceDownloadAttachmentInput {
    pub attachment_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub registered_agent_id: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceDownloadAttachmentResult {
    pub name: String,
    pub relative_path: String,
    pub full_path: String,
    pub size_bytes: usize,
}

#[derive(Debug, Deserialize)]
struct CloudEnvelope<T> {
    success: bool,
    data: Option<T>,
    error: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default, rename = "requestId")]
    request_id: Option<String>,
    #[serde(default, rename = "recoveryHint")]
    recovery_hint: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceDeliveryLogFile {
    items: Vec<SpaceDeliveryLogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpaceDeliveryLogEntry {
    delivery_id: String,
    #[serde(default)]
    base_url: String,
    registered_agent_id: String,
    issue_id: String,
    session_id: String,
    message_id: String,
    #[serde(default)]
    delivered_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueGetInput {
    pub issue_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub comments_cursor: Option<String>,
    #[serde(default)]
    pub comments_limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueListInput {
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub include_subtree: Option<bool>,
    #[serde(default)]
    pub human_only: Option<bool>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueCommentInput {
    pub issue_id: String,
    pub body: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueStatusInput {
    pub issue_id: String,
    #[serde(alias = "status")]
    pub state: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueClaimInput {
    pub issue_id: String,
    #[serde(default)]
    pub delivery_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueDeliveryIgnoreInput {
    #[serde(default)]
    pub issue_id: Option<String>,
    pub delivery_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliIssueActionInput {
    pub issue_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliClaimLocalTaskInput {
    pub claim_id: String,
    pub local_task_id: String,
    pub local_session_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCliAttachmentDownloadInput {
    pub attachment_id: String,
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceProcessDeliveryResult {
    pub processed: usize,
    pub delivered: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn cmd_space_get_capability() -> Result<SpaceBuildCapability, String> {
    Ok(space_build_capability())
}

#[tauri::command]
pub async fn cmd_space_get_session() -> Result<Option<SpaceSessionPublic>, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(Some(crate::space_cloud_mock::session().into()));
    }
    ensure_space_available()?;
    let Some(session) = read_current_session()? else {
        return Ok(None);
    };
    let identity = current_device_identity()?;
    try_upsert_space_user_device(&session, &identity).await;
    Ok(Some(session.into()))
}

#[tauri::command]
pub async fn cmd_space_auth_start() -> Result<Value, String> {
    let capability = ensure_space_available()?;
    let base_url = capability_base_url(&capability)?;
    let client = http_client()?;
    let response = with_public_client_id_header(
        client.post(api_url(&base_url, "/api/auth/desktop/start")?),
        &capability,
    )
    .send()
    .await
    .map_err(|e| format!("Space auth start failed: {}", e))?;
    let data = parse_cloud_data::<Value>(response).await?;
    if let Some(url) = data.get("authorizationUrl").and_then(Value::as_str) {
        crate::browser::spawn_external_open(url);
    }
    Ok(data)
}

#[tauri::command]
pub async fn cmd_space_auth_poll(input: SpaceAuthPollInput) -> Result<Value, String> {
    let capability = ensure_space_available()?;
    let base_url = capability_base_url(&capability)?;
    let client = http_client()?;
    let path = format!(
        "/api/auth/desktop/poll?token={}",
        url_component(&input.login_token)
    );
    let response =
        with_public_client_id_header(client.get(api_url(&base_url, &path)?), &capability)
            .send()
            .await
            .map_err(|e| format!("Space auth poll failed: {}", e))?;
    let mut data = parse_cloud_data::<Value>(response).await?;
    if data.get("status").and_then(Value::as_str) == Some("done") {
        let token = data
            .get("sessionToken")
            .and_then(Value::as_str)
            .ok_or_else(|| "Space auth completed without session token".to_string())?
            .to_string();
        let session = SpaceSession {
            base_url,
            session_token: token,
            expires_at: data
                .get("expiresAt")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            user: data.get("user").cloned().unwrap_or(Value::Null),
            space: data.get("space").cloned().unwrap_or(Value::Null),
            membership: data.get("membership").cloned().unwrap_or(Value::Null),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        write_private_json(&session_path()?, &session)?;
        let identity = current_device_identity()?;
        try_upsert_space_user_device(&session, &identity).await;
        if let Some(map) = data.as_object_mut() {
            map.remove("sessionToken");
        }
    }
    Ok(data)
}

#[tauri::command]
pub async fn cmd_space_auth_ack(input: SpaceAuthPollInput) -> Result<(), String> {
    let capability = ensure_space_available()?;
    let base_url = capability_base_url(&capability)?;
    let response = with_public_client_id_header(
        http_client()?
            .post(api_url(&base_url, "/api/auth/desktop/ack")?)
            .json(&serde_json::json!({ "token": input.login_token })),
        &capability,
    )
    .send()
    .await
    .map_err(|e| format!("Space auth ack failed: {}", e))?;
    let _ = parse_cloud_data::<Value>(response).await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_space_logout() -> Result<(), String> {
    if crate::space_cloud_mock::is_enabled() {
        crate::space_cloud_mock::reset();
        return Ok(());
    }
    let capability = space_build_capability();
    let session_to_revoke = capability
        .available
        .then(|| capability_base_url(&capability).ok())
        .flatten()
        .and_then(|configured_base_url| {
            read_session()
                .ok()
                .flatten()
                .filter(|session| space_base_urls_equal(&session.base_url, &configured_base_url))
        });

    if let Some(session) = session_to_revoke {
        let client = http_client()?;
        let _ = with_public_client_id_header(
            client
                .post(api_url(&session.base_url, "/api/logout")?)
                .header(AUTHORIZATION, format!("Bearer {}", session.session_token)),
            &capability,
        )
        .send()
        .await;
    }
    let path = session_path()?;
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to remove Space session: {}", e)),
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_space_api_request(input: SpaceApiRequestInput) -> Result<Value, String> {
    let method = reqwest::Method::from_bytes(input.method.to_uppercase().as_bytes())
        .map_err(|_| "Invalid HTTP method".to_string())?;
    if !matches!(
        method,
        reqwest::Method::GET
            | reqwest::Method::POST
            | reqwest::Method::PATCH
            | reqwest::Method::DELETE
    ) {
        return Err("Unsupported Space API method".to_string());
    }
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::api_request(input);
    }
    ensure_space_available()?;
    let session = require_session()?;
    let client = http_client()?;
    let mut req = with_public_client_id_header(
        client
            .request(method, api_url(&session.base_url, &input.path)?)
            .header(AUTHORIZATION, format!("Bearer {}", session.session_token)),
        &space_build_capability(),
    );
    if let Some(body) = input.body {
        req = req.json(&body);
    }
    let response = req
        .send()
        .await
        .map_err(|e| format!("Space API request failed: {}", e))?;
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid Space API response: {}", e))
}

#[tauri::command]
pub async fn cmd_space_register_agent(
    input: SpaceRegisterAgentInput,
) -> Result<LocalRegisteredAgentPublic, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::register_agent(input);
    }
    ensure_space_available()?;
    let workspace_root = validate_workspace_root(&input.workspace_path)?;
    let workspace_path = workspace_root.to_string_lossy().to_string();
    let session = require_session()?;
    let capability = ensure_space_available()?;
    let identity = current_device_identity()?;
    try_upsert_space_user_device(&session, &identity).await;
    let display_name = input.display_name.trim();
    if display_name.is_empty() {
        return Err("displayName is required".to_string());
    }
    let goal_id = input.goal_id.trim();
    if goal_id.is_empty() {
        return Err("goalId is required".to_string());
    }
    let state_filter = normalize_agent_state_filter(input.state_filter);
    let goal_md = input.goal_md.clone();
    let issue_subscription_run_mode = input.issue_subscription_run_mode.unwrap_or_default();
    let client_id = capability
        .public_client_id
        .clone()
        .unwrap_or_else(|| "myagents-desktop".to_string());
    let local_agent_id = stable_local_agent_id(&input.workspace_id);
    let body = serde_json::json!({
        "clientId": client_id,
        "deviceId": identity.device_id,
        "deviceName": identity.device_name,
        "platform": identity.platform,
        "osVersion": identity.os_version,
        "appVersion": identity.app_version,
        "localWorkspaceId": input.workspace_id,
        "localAgentId": local_agent_id,
        "displayName": display_name,
        "workspacePath": workspace_path,
        "workspaceLabel": input.workspace_label,
        "goalId": goal_id,
        "stateFilter": state_filter,
        "goalMd": goal_md,
        "issueSubscriptionRunMode": issue_subscription_run_mode,
    });
    let path = format!(
        "/api/spaces/{}/registered-agents",
        session_space_segment(&session)
    );
    let response = authorized_json_request(
        &session.base_url,
        &path,
        &session.session_token,
        reqwest::Method::POST,
        Some(body),
    )
    .await?;
    let data = response
        .get("data")
        .cloned()
        .ok_or_else(|| "Space API response missing data".to_string())?;
    let registered = data
        .get("registeredAgent")
        .cloned()
        .ok_or_else(|| "Space API response missing registeredAgent".to_string())?;
    let subscription = data.get("subscription").cloned().unwrap_or(Value::Null);
    let device = device_summary_from_cloud(&registered, None, Some(&identity));
    let token = data
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Space API response missing Registered Agent token".to_string())?
        .to_string();
    let agent = LocalRegisteredAgent {
        id: required_value_string(&registered, "id")?,
        base_url: session.base_url.clone(),
        space_id: required_value_string(&registered, "spaceId")?,
        owner_user_id: optional_value_string(&registered, "ownerUserId")
            .or_else(|| session_user_id(&session)),
        device_id: device
            .as_ref()
            .map(|item| item.device_id.clone())
            .or(Some(identity.device_id.clone())),
        client_id: optional_value_string(&registered, "clientId").or(Some(client_id)),
        device_name: device
            .as_ref()
            .and_then(|item| item.device_name.clone())
            .or_else(|| identity.device_name.clone()),
        device_platform: device
            .as_ref()
            .and_then(|item| item.platform.clone())
            .or(Some(identity.platform.clone())),
        device_os_version: device
            .as_ref()
            .and_then(|item| item.os_version.clone())
            .or_else(|| identity.os_version.clone()),
        device_app_version: device
            .as_ref()
            .and_then(|item| item.app_version.clone())
            .or(Some(identity.app_version.clone())),
        device_last_seen_at: device.as_ref().and_then(|item| item.last_seen_at.clone()),
        local_workspace_id: optional_value_string(&registered, "localWorkspaceId")
            .or(Some(input.workspace_id.clone())),
        local_agent_id: optional_value_string(&registered, "localAgentId").or(Some(local_agent_id)),
        workspace_id: Some(input.workspace_id),
        display_name: required_value_string(&registered, "displayName")?,
        workspace_path,
        workspace_label: registered
            .get("workspaceLabel")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        goal_id: optional_value_string(&subscription, "goalId").or(Some(goal_id.to_string())),
        goal_path_label: optional_value_string(&subscription, "goalPathLabel"),
        state_filter: value_string_array(&subscription, "stateFilter")
            .filter(|items| !items.is_empty())
            .unwrap_or_else(default_agent_state_filter),
        goal_md: input.goal_md,
        delivery_session_id: Some(uuid::Uuid::new_v4().to_string()),
        issue_subscription_run_mode,
        issue_session_ids: BTreeMap::new(),
        token,
        status: required_value_string(&registered, "status")?,
        created_at: required_value_string(&registered, "createdAt")?,
        updated_at: required_value_string(&registered, "updatedAt")?,
    };
    upsert_local_agent(agent.clone())?;
    Ok(agent.into())
}

#[tauri::command]
pub async fn cmd_space_update_registered_agent(
    input: SpaceUpdateRegisteredAgentInput,
) -> Result<LocalRegisteredAgentPublic, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::update_agent(input);
    }
    ensure_space_available()?;
    let session = require_session()?;
    let identity = current_device_identity()?;
    try_upsert_space_user_device(&session, &identity).await;
    let mut agent = read_current_local_agents()?
        .into_iter()
        .find(|agent| agent.id == input.id);
    let can_update_local_binding = agent
        .as_ref()
        .map(|agent| local_agent_matches_current_identity(agent, &session, &identity.device_id))
        .unwrap_or(false);
    let mut body = serde_json::Map::new();
    if can_update_local_binding {
        body.insert(
            "deviceId".to_string(),
            Value::String(identity.device_id.clone()),
        );
        if let Some(device_name) = identity.device_name.clone() {
            body.insert("deviceName".to_string(), Value::String(device_name));
        }
        body.insert(
            "platform".to_string(),
            Value::String(identity.platform.clone()),
        );
        if let Some(os_version) = identity.os_version.clone() {
            body.insert("osVersion".to_string(), Value::String(os_version));
        }
        body.insert(
            "appVersion".to_string(),
            Value::String(identity.app_version.clone()),
        );
    }

    if let Some(display_name) = input.display_name {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err("displayName is required".to_string());
        }
        body.insert(
            "displayName".to_string(),
            Value::String(display_name.to_string()),
        );
        if let Some(agent) = agent.as_mut() {
            agent.display_name = display_name.to_string();
        }
    }
    if let Some(workspace_id) = input.workspace_id {
        if !can_update_local_binding {
            return Err(
                "workspace binding can only be changed from the registered device".to_string(),
            );
        }
        let workspace_id = workspace_id.trim();
        if workspace_id.is_empty() {
            return Err("workspaceId is required".to_string());
        }
        let local_agent_id = stable_local_agent_id(workspace_id);
        body.insert(
            "localWorkspaceId".to_string(),
            Value::String(workspace_id.to_string()),
        );
        body.insert(
            "localAgentId".to_string(),
            Value::String(local_agent_id.clone()),
        );
        if let Some(agent) = agent.as_mut() {
            agent.local_workspace_id = Some(workspace_id.to_string());
            agent.workspace_id = Some(workspace_id.to_string());
            agent.local_agent_id = Some(local_agent_id);
        }
    }
    if let Some(workspace_path) = input.workspace_path {
        if !can_update_local_binding {
            return Err(
                "workspace binding can only be changed from the registered device".to_string(),
            );
        }
        let workspace_root = validate_workspace_root(&workspace_path)?;
        let workspace_path = workspace_root.to_string_lossy().to_string();
        body.insert(
            "workspacePath".to_string(),
            Value::String(workspace_path.clone()),
        );
        if let Some(agent) = agent.as_mut() {
            agent.workspace_path = workspace_path;
        }
    }
    if let Some(workspace_label) = input.workspace_label {
        if !can_update_local_binding {
            return Err(
                "workspace binding can only be changed from the registered device".to_string(),
            );
        }
        let workspace_label = workspace_label.trim();
        if workspace_label.is_empty() {
            body.insert("workspaceLabel".to_string(), Value::Null);
            if let Some(agent) = agent.as_mut() {
                agent.workspace_label = None;
            }
        } else {
            body.insert(
                "workspaceLabel".to_string(),
                Value::String(workspace_label.to_string()),
            );
            if let Some(agent) = agent.as_mut() {
                agent.workspace_label = Some(workspace_label.to_string());
            }
        }
    }
    if let Some(goal_id) = input.goal_id {
        let goal_id = goal_id.trim();
        if goal_id.is_empty() {
            return Err("goalId is required".to_string());
        }
        if agent.as_ref().and_then(|agent| agent.goal_id.as_deref()) != Some(goal_id) {
            if let Some(agent) = agent.as_mut() {
                agent.goal_path_label = None;
            }
        }
        if let Some(agent) = agent.as_mut() {
            agent.goal_id = Some(goal_id.to_string());
            agent.goal_path_label = None;
        }
        body.insert("goalId".to_string(), Value::String(goal_id.to_string()));
    }
    if let Some(state_filter) = input.state_filter {
        let state_filter = normalize_agent_state_filter(Some(state_filter));
        body.insert(
            "stateFilter".to_string(),
            Value::Array(state_filter.iter().cloned().map(Value::String).collect()),
        );
        if let Some(agent) = agent.as_mut() {
            agent.state_filter = state_filter;
        }
    }
    if let Some(goal_md) = input.goal_md {
        let goal_md = goal_md.trim();
        if goal_md.is_empty() {
            return Err("goalMd is required".to_string());
        }
        body.insert("goalMd".to_string(), Value::String(goal_md.to_string()));
        if let Some(agent) = agent.as_mut() {
            agent.goal_md = Some(goal_md.to_string());
        }
    }
    if let Some(status) = input.status {
        let status = status.trim();
        if !matches!(status, "active" | "disabled") {
            return Err("Registered Agent status must be active or disabled".to_string());
        }
        body.insert("status".to_string(), Value::String(status.to_string()));
        if let Some(agent) = agent.as_mut() {
            agent.status = status.to_string();
        }
    }
    if let Some(issue_subscription_run_mode) = input.issue_subscription_run_mode {
        body.insert(
            "issueSubscriptionRunMode".to_string(),
            serde_json::to_value(issue_subscription_run_mode)
                .map_err(|e| format!("Invalid issueSubscriptionRunMode: {}", e))?,
        );
        if let Some(agent) = agent.as_mut() {
            agent.issue_subscription_run_mode = issue_subscription_run_mode;
            agent.updated_at = chrono::Utc::now().to_rfc3339();
        }
    }

    if body.is_empty() {
        let Some(agent) = agent else {
            return Err("No Registered Agent changes provided".to_string());
        };
        upsert_local_agent(agent.clone())?;
        return Ok(agent.into());
    }

    let data = authorized_json_data_request(
        &session.base_url,
        &format!("/api/registered-agents/{}", url_component(&input.id)),
        &session.session_token,
        reqwest::Method::PATCH,
        Some(Value::Object(body)),
    )
    .await?;
    if let Some(registered) = data.get("registeredAgent") {
        if let Some(agent) = agent.as_mut() {
            agent.display_name = required_value_string(registered, "displayName")?;
            agent.owner_user_id = optional_value_string(registered, "ownerUserId")
                .or_else(|| agent.owner_user_id.clone())
                .or_else(|| session_user_id(&session));
            if let Some(device) =
                device_summary_from_cloud(registered, Some(agent), Some(&identity))
            {
                agent.device_id = Some(device.device_id);
                agent.device_name = device.device_name;
                agent.device_platform = device.platform;
                agent.device_os_version = device.os_version;
                agent.device_app_version = device.app_version;
                agent.device_last_seen_at = device.last_seen_at;
            }
            agent.workspace_label = registered
                .get("workspaceLabel")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            agent.client_id =
                optional_value_string(registered, "clientId").or_else(|| agent.client_id.clone());
            agent.local_workspace_id = optional_value_string(registered, "localWorkspaceId")
                .or_else(|| agent.local_workspace_id.clone());
            agent.local_agent_id = optional_value_string(registered, "localAgentId")
                .or_else(|| agent.local_agent_id.clone());
            agent.workspace_id = agent
                .local_workspace_id
                .clone()
                .or_else(|| agent.workspace_id.clone());
            if let Some(workspace_path) = optional_value_string(registered, "workspacePath") {
                agent.workspace_path = workspace_path;
            }
            if let Some(issue_subscription_run_mode) =
                value_issue_subscription_run_mode(registered, "issueSubscriptionRunMode")
            {
                agent.issue_subscription_run_mode = issue_subscription_run_mode;
            }
            agent.status = required_value_string(registered, "status")?;
            agent.updated_at = required_value_string(registered, "updatedAt")?;
        }
    } else if let Some(agent) = agent.as_mut() {
        agent.updated_at = chrono::Utc::now().to_rfc3339();
    }
    let subscription = first_subscription_from_data(&data);
    if let Some(agent) = agent.as_mut() {
        apply_subscription_to_local_agent(agent, subscription);
        upsert_local_agent(agent.clone())?;
        return Ok(agent.clone().into());
    }
    let registered = data
        .get("registeredAgent")
        .ok_or_else(|| "Space API response missing registeredAgent".to_string())?;
    local_registered_agent_public_from_cloud(&session, registered, subscription, None)
}

#[tauri::command]
pub async fn cmd_space_revoke_registered_agent(
    input: SpaceRegisteredAgentIdInput,
) -> Result<LocalRegisteredAgentPublic, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::revoke_agent(&input.id);
    }
    ensure_space_available()?;
    let session = require_session()?;
    let mut agent = read_current_local_agents()?
        .into_iter()
        .find(|agent| agent.id == input.id);
    let data = authorized_json_data_request(
        &session.base_url,
        &format!("/api/registered-agents/{}/revoke", url_component(&input.id)),
        &session.session_token,
        reqwest::Method::POST,
        None,
    )
    .await?;
    if let Some(agent) = agent.as_mut() {
        if let Some(registered) = data.get("registeredAgent") {
            agent.status = required_value_string(registered, "status")?;
            agent.updated_at = required_value_string(registered, "updatedAt")?;
        } else {
            agent.status = "revoked".to_string();
            agent.updated_at = chrono::Utc::now().to_rfc3339();
        }
        upsert_local_agent(agent.clone())?;
        return Ok(agent.clone().into());
    }
    let registered = data
        .get("registeredAgent")
        .ok_or_else(|| "Space API response missing registeredAgent".to_string())?;
    local_registered_agent_public_from_cloud(
        &session,
        registered,
        first_subscription_from_data(&data),
        None,
    )
}

#[tauri::command]
pub async fn cmd_space_list_local_agents() -> Result<Vec<LocalRegisteredAgentPublic>, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(crate::space_cloud_mock::list_local_agents());
    }
    ensure_space_available()?;
    Ok(read_current_local_agents()?
        .into_iter()
        .map(Into::into)
        .collect())
}

#[tauri::command]
pub async fn cmd_space_poll_dispatches(input: SpacePollDispatchesInput) -> Result<Value, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::poll_dispatches(&input.registered_agent_id);
    }
    let agent = require_local_agent(&input.registered_agent_id)?;
    let session = space_base_url()?;
    authorized_json_request(
        &session,
        "/api/registered-agents/me/dispatches?status=pending",
        &agent.token,
        reqwest::Method::GET,
        None,
    )
    .await
}

#[tauri::command]
pub async fn cmd_space_mark_dispatch_delivered(
    input: SpaceMarkDispatchDeliveredInput,
) -> Result<Value, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::mark_dispatch_delivered(
            &input.dispatch_id,
            Some(&input.registered_agent_id),
            input.local_task_id,
            input.local_run_id,
        );
    }
    let agent = require_local_agent(&input.registered_agent_id)?;
    let session = space_base_url()?;
    authorized_json_request(
        &session,
        &format!(
            "/api/dispatches/{}/delivered",
            url_component(&input.dispatch_id)
        ),
        &agent.token,
        reqwest::Method::POST,
        Some(serde_json::json!({
            "localTaskId": input.local_task_id,
            "localRunId": input.local_run_id,
        })),
    )
    .await
}

#[tauri::command]
pub async fn cmd_space_poll_deliveries(input: SpacePollDeliveriesInput) -> Result<Value, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::poll_deliveries(&input.registered_agent_id);
    }
    let agent = require_local_agent(&input.registered_agent_id)?;
    let session = space_base_url()?;
    authorized_json_request(
        &session,
        "/api/registered-agents/me/deliveries?status=pending&limit=20",
        &agent.token,
        reqwest::Method::GET,
        None,
    )
    .await
}

#[tauri::command]
pub async fn cmd_space_mark_delivery_delivered(
    input: SpaceMarkDeliveryDeliveredInput,
) -> Result<Value, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::mark_delivery_delivered(
            &input.delivery_id,
            Some(&input.registered_agent_id),
            input.session_id,
        );
    }
    let agent = require_local_agent(&input.registered_agent_id)?;
    let session = space_base_url()?;
    authorized_json_request(
        &session,
        &format!(
            "/api/deliveries/{}/delivered",
            url_component(&input.delivery_id)
        ),
        &agent.token,
        reqwest::Method::POST,
        Some(serde_json::json!({
            "sessionId": input.session_id,
        })),
    )
    .await
}

#[tauri::command]
pub async fn cmd_space_process_deliveries_once(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
) -> Result<SpaceProcessDeliveryResult, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(crate::space_cloud_mock::process_deliveries_once());
    }
    let manager = state.inner().clone();
    process_pending_deliveries(&app_handle, &manager).await
}

#[tauri::command]
pub async fn cmd_space_process_dispatches_once(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
) -> Result<SpaceProcessDeliveryResult, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(crate::space_cloud_mock::process_deliveries_once());
    }
    let manager = state.inner().clone();
    process_pending_deliveries(&app_handle, &manager).await
}

#[tauri::command]
pub async fn cmd_space_install_skill(
    input: SpaceInstallSkillInput,
) -> Result<SpaceInstallSkillResult, String> {
    let session = require_session()?;
    let bytes = authorized_bytes_request(
        &session.base_url,
        &format!("/api/skills/{}/package.zip", url_component(&input.skill_id)),
        &session.session_token,
    )
    .await?;
    if bytes.len() > MAX_SKILL_ZIP_BYTES {
        return Err(format!(
            "Skill package exceeds {} bytes",
            MAX_SKILL_ZIP_BYTES
        ));
    }
    let install_root = match input.target {
        SpaceSkillInstallTarget::Global => {
            let root = space_data_dir()?
                .parent()
                .ok_or_else(|| "Invalid data dir".to_string())?
                .join("skills");
            fs::create_dir_all(&root).map_err(|e| format!("Failed to create skills dir: {}", e))?;
            root
        }
        SpaceSkillInstallTarget::Project => {
            let workspace = input
                .workspace_path
                .as_deref()
                .ok_or_else(|| "workspacePath is required for project install".to_string())?;
            let workspace_root = validate_workspace_root(workspace)?;
            let root = resolve_inside_workspace(&workspace_root, ".claude/skills")?;
            fs::create_dir_all(&root)
                .map_err(|e| format!("Failed to create project skills dir: {}", e))?;
            root
        }
    };
    let base_name = safe_local_name(&input.skill_name);
    let (target_dir, installed_name, renamed) = choose_available_dir(&install_root, &base_name)?;
    let staging_dir = install_root.join(format!(
        ".{}.myagents-installing-{}",
        installed_name,
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create skill staging dir: {}", e))?;
    if let Err(error) = extract_skill_zip(&bytes, &staging_dir) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }
    if let Err(error) = fs::rename(&staging_dir, &target_dir) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(format!("Failed to commit skill install: {}", error));
    }
    let target = match input.target {
        SpaceSkillInstallTarget::Global => "global",
        SpaceSkillInstallTarget::Project => "project",
    }
    .to_string();
    Ok(SpaceInstallSkillResult {
        installed_name,
        installed_path: target_dir.to_string_lossy().to_string(),
        target,
        renamed,
    })
}

#[tauri::command]
pub async fn cmd_space_upload_skill(input: SpaceUploadSkillInput) -> Result<Value, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::upload_skill(input);
    }
    let session = require_session()?;
    let file_path = PathBuf::from(input.file_path.trim());
    if !file_path.is_absolute() {
        return Err("Skill zip path must be absolute".to_string());
    }
    if file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| !ext.eq_ignore_ascii_case("zip"))
        .unwrap_or(true)
    {
        return Err("Skill upload requires a .zip file".to_string());
    }
    let metadata = fs::symlink_metadata(&file_path)
        .map_err(|e| format!("Failed to inspect skill zip: {}", e))?;
    if metadata.file_type().is_symlink() {
        return Err("Skill zip path must not be a symlink".to_string());
    }
    if !metadata.is_file() {
        return Err("Skill zip path must be a file".to_string());
    }
    if metadata.len() > MAX_SKILL_ZIP_BYTES as u64 {
        return Err(format!("Skill zip exceeds {} bytes", MAX_SKILL_ZIP_BYTES));
    }
    let bytes = fs::read(&file_path).map_err(|e| format!("Failed to read skill zip: {}", e))?;
    let filename = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(safe_local_filename)
        .unwrap_or_else(|| "skill.zip".to_string());
    let file_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str("application/zip")
        .map_err(|e| format!("Failed to build skill upload part: {}", e))?;
    let mut form = reqwest::multipart::Form::new().part("file", file_part);
    if let Some(name) = input.name.as_deref().filter(|s| !s.trim().is_empty()) {
        form = form.text("name", name.trim().to_string());
    }
    if let Some(description) = input
        .description
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        form = form.text("description", description.trim().to_string());
    }
    let path = if let Some(skill_id) = input.skill_id.as_deref().filter(|s| !s.trim().is_empty()) {
        format!("/api/skills/{}/revisions", url_component(skill_id.trim()))
    } else {
        format!("/api/spaces/{}/skills", session_space_segment(&session))
    };
    authorized_multipart_data_request(&session.base_url, &path, &session.session_token, form).await
}

#[tauri::command]
pub async fn cmd_space_upload_issue_attachments(
    input: SpaceUploadIssueAttachmentsInput,
) -> Result<Value, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::upload_issue_attachments(input);
    }
    let session = require_session()?;
    let issue_id = input.issue_id.trim();
    if issue_id.is_empty() {
        return Err("issueId is required".to_string());
    }
    if input.file_paths.is_empty() {
        return Err("No attachment selected".to_string());
    }
    if input.file_paths.len() > MAX_ATTACHMENT_UPLOAD_COUNT {
        return Err(format!(
            "At most {} attachments can be uploaded at once",
            MAX_ATTACHMENT_UPLOAD_COUNT
        ));
    }
    let mut form = reqwest::multipart::Form::new();
    for path in input.file_paths {
        let file_path = PathBuf::from(path.trim());
        if !file_path.is_absolute() {
            return Err("Attachment path must be absolute".to_string());
        }
        let metadata = fs::symlink_metadata(&file_path)
            .map_err(|e| format!("Failed to inspect attachment: {}", e))?;
        if metadata.file_type().is_symlink() {
            return Err("Attachment path must not be a symlink".to_string());
        }
        if !metadata.is_file() {
            return Err("Attachment path must be a file".to_string());
        }
        if metadata.len() > MAX_ATTACHMENT_UPLOAD_BYTES {
            return Err(format!(
                "Attachment exceeds {} bytes: {}",
                MAX_ATTACHMENT_UPLOAD_BYTES,
                file_path.display()
            ));
        }
        let bytes =
            fs::read(&file_path).map_err(|e| format!("Failed to read attachment: {}", e))?;
        let filename = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(safe_local_filename)
            .unwrap_or_else(|| "attachment".to_string());
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(filename)
            .mime_str("application/octet-stream")
            .map_err(|e| format!("Failed to build attachment upload part: {}", e))?;
        form = form.part("file", part);
    }
    authorized_multipart_data_request(
        &session.base_url,
        &format!("/api/issues/{}/attachments", url_component(issue_id)),
        &session.session_token,
        form,
    )
    .await
}

#[tauri::command]
pub async fn cmd_space_download_attachment(
    input: SpaceDownloadAttachmentInput,
) -> Result<SpaceDownloadAttachmentResult, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::download_attachment(
            &input.workspace_path,
            &input.attachment_id,
            input.issue_id.as_deref(),
            input.file_name.as_deref(),
            input.output.as_deref(),
        );
    }
    let (base_url, token) = if let Some(agent_id) = input.registered_agent_id.as_deref() {
        let agent = require_local_agent(agent_id)?;
        let base = space_base_url()?;
        (base, agent.token)
    } else {
        let session = require_session()?;
        (session.base_url, session.session_token)
    };
    download_attachment_with_token(
        &base_url,
        &token,
        &input.workspace_path,
        &input.attachment_id,
        input.issue_id.as_deref(),
        input.file_name.as_deref(),
        input.output.as_deref(),
    )
    .await
}

async fn download_attachment_with_token(
    base_url: &str,
    token: &str,
    workspace_path: &str,
    attachment_id: &str,
    issue_id: Option<&str>,
    file_name: Option<&str>,
    output: Option<&str>,
) -> Result<SpaceDownloadAttachmentResult, String> {
    let workspace_root = validate_workspace_root(workspace_path)?;
    let response = authorized_raw_request(
        base_url,
        &format!("/api/attachments/{}/download", url_component(attachment_id)),
        token,
    )
    .await?;
    let headers = response.headers().clone();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Attachment download failed: {}", e))?;
    if bytes.len() > MAX_ATTACHMENT_DOWNLOAD_BYTES {
        return Err(format!(
            "Attachment exceeds {} bytes",
            MAX_ATTACHMENT_DOWNLOAD_BYTES
        ));
    }
    let name = file_name
        .map(safe_local_filename)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            filename_from_content_disposition(
                headers
                    .get(CONTENT_DISPOSITION)
                    .and_then(|v| v.to_str().ok()),
            )
        })
        .unwrap_or_else(|| format!("attachment-{}", attachment_id));
    let relative = if let Some(output) = output.filter(|s| !s.trim().is_empty()) {
        output.trim().to_string()
    } else {
        let issue_part = issue_id
            .map(safe_local_name)
            .unwrap_or_else(|| "unknown-issue".to_string());
        format!(
            "myagents_files/space/issues/{}/attachments/{}/{}",
            issue_part,
            safe_local_name(attachment_id),
            name
        )
    };
    let target = resolve_inside_workspace(&workspace_root, &relative)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create attachment dir: {}", e))?;
    }
    atomic_write_file(&target, &bytes)?;
    Ok(SpaceDownloadAttachmentResult {
        name,
        relative_path: relative,
        full_path: target.to_string_lossy().to_string(),
        size_bytes: bytes.len(),
    })
}

#[tauri::command]
pub async fn cmd_space_download_skill_zip(
    input: SpaceInstallSkillInput,
) -> Result<IpcResponse, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(IpcResponse::new(
            crate::space_cloud_mock::skill_package_bytes(&input.skill_id)?,
        ));
    }
    let session = require_session()?;
    let bytes = authorized_bytes_request(
        &session.base_url,
        &format!("/api/skills/{}/package.zip", url_component(&input.skill_id)),
        &session.session_token,
    )
    .await?;
    Ok(IpcResponse::new(bytes))
}

pub fn start_space_connector(app_handle: AppHandle, manager: ManagedSidecarManager) {
    if !space_build_capability().available {
        return;
    }
    if SPACE_CONNECTOR_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            if !team_space_runtime_enabled() {
                tokio::time::sleep(Duration::from_secs(60)).await;
                continue;
            }
            match process_pending_deliveries(&app_handle, &manager).await {
                Ok(result) => {
                    if result.processed > 0 || !result.errors.is_empty() {
                        ulog_info!(
                            "[space] connector tick processed={} delivered={} errors={}",
                            result.processed,
                            result.delivered,
                            result.errors.len()
                        );
                    }
                }
                Err(error) => ulog_warn!("[space] connector tick failed: {}", error),
            }
            tokio::time::sleep(Duration::from_secs(SPACE_CONNECTOR_INTERVAL_SECS)).await;
        }
    });
}

pub async fn space_cli_issue_get(input: SpaceCliIssueGetInput) -> Result<Value, String> {
    let agent =
        resolve_local_agent_for_cli(input.agent_id.as_deref(), input.workspace_path.as_deref())?;
    let base_url = space_base_url()?;
    let mut path = format!(
        "/api/issues/{}?commentsLimit={}",
        url_component(input.issue_id.trim()),
        input.comments_limit.unwrap_or(5).clamp(1, 20)
    );
    if let Some(cursor) = input
        .comments_cursor
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        path.push_str("&commentsCursor=");
        path.push_str(&url_component(cursor.trim()));
    }
    authorized_json_data_request(&base_url, &path, &agent.token, reqwest::Method::GET, None).await
}

pub async fn space_cli_issue_list(input: SpaceCliIssueListInput) -> Result<Value, String> {
    let agent =
        resolve_local_agent_for_cli(input.agent_id.as_deref(), input.workspace_path.as_deref())?;
    let base_url = space_base_url()?;
    let mut params: Vec<(String, String)> = Vec::new();
    if let Some(goal_id) = input.goal_id.as_deref().filter(|s| !s.trim().is_empty()) {
        params.push(("goalId".to_string(), goal_id.trim().to_string()));
    }
    if let Some(state) = input.state.as_deref().filter(|s| !s.trim().is_empty()) {
        params.push(("state".to_string(), state.trim().to_string()));
    }
    if let Some(include_subtree) = input.include_subtree {
        params.push(("includeSubtree".to_string(), include_subtree.to_string()));
    }
    if let Some(human_only) = input.human_only {
        params.push(("humanOnly".to_string(), human_only.to_string()));
    }
    if let Some(query) = input.query.as_deref().filter(|s| !s.trim().is_empty()) {
        params.push(("q".to_string(), query.trim().to_string()));
    }
    if let Some(cursor) = input.cursor.as_deref().filter(|s| !s.trim().is_empty()) {
        params.push(("cursor".to_string(), cursor.trim().to_string()));
    }
    params.push((
        "limit".to_string(),
        input.limit.unwrap_or(30).clamp(1, 100).to_string(),
    ));
    let query = params
        .into_iter()
        .map(|(key, value)| format!("{}={}", key, url_component(&value)))
        .collect::<Vec<_>>()
        .join("&");
    authorized_json_data_request(
        &base_url,
        &format!("/api/spaces/official/issues?{}", query),
        &agent.token,
        reqwest::Method::GET,
        None,
    )
    .await
}

pub async fn space_cli_issue_comment(input: SpaceCliIssueCommentInput) -> Result<Value, String> {
    let agent =
        resolve_local_agent_for_cli(input.agent_id.as_deref(), input.workspace_path.as_deref())?;
    let base_url = space_base_url()?;
    authorized_json_data_request(
        &base_url,
        &format!(
            "/api/issues/{}/comments",
            url_component(input.issue_id.trim())
        ),
        &agent.token,
        reqwest::Method::POST,
        Some(serde_json::json!({ "body": input.body })),
    )
    .await
}

pub async fn space_cli_issue_status(input: SpaceCliIssueStatusInput) -> Result<Value, String> {
    let agent =
        resolve_local_agent_for_cli(input.agent_id.as_deref(), input.workspace_path.as_deref())?;
    let base_url = space_base_url()?;
    authorized_json_data_request(
        &base_url,
        &format!(
            "/api/issues/{}/status",
            url_component(input.issue_id.trim())
        ),
        &agent.token,
        reqwest::Method::POST,
        Some(serde_json::json!({ "state": input.state })),
    )
    .await
}

pub async fn space_cli_issue_claim(input: SpaceCliIssueClaimInput) -> Result<Value, String> {
    let agent =
        resolve_local_agent_for_cli(input.agent_id.as_deref(), input.workspace_path.as_deref())?;
    let base_url = space_base_url()?;
    authorized_json_data_request(
        &base_url,
        &format!("/api/issues/{}/claim", url_component(input.issue_id.trim())),
        &agent.token,
        reqwest::Method::POST,
        Some(serde_json::json!({ "deliveryId": input.delivery_id })),
    )
    .await
}

pub async fn space_cli_issue_delivery_ignore(
    input: SpaceCliIssueDeliveryIgnoreInput,
) -> Result<Value, String> {
    let agent =
        resolve_local_agent_for_cli(input.agent_id.as_deref(), input.workspace_path.as_deref())?;
    let base_url = space_base_url()?;
    let path = if let Some(issue_id) = input.issue_id.as_deref().filter(|s| !s.trim().is_empty()) {
        format!(
            "/api/issues/{}/deliveries/{}/ignore",
            url_component(issue_id.trim()),
            url_component(input.delivery_id.trim())
        )
    } else {
        format!(
            "/api/deliveries/{}/ignored",
            url_component(input.delivery_id.trim())
        )
    };
    authorized_json_data_request(&base_url, &path, &agent.token, reqwest::Method::POST, None).await
}

pub async fn space_cli_issue_close(input: SpaceCliIssueActionInput) -> Result<Value, String> {
    space_cli_issue_action(input, "close").await
}

pub async fn space_cli_issue_complete(input: SpaceCliIssueActionInput) -> Result<Value, String> {
    space_cli_issue_action(input, "complete").await
}

pub async fn space_cli_issue_cancel_claim(
    input: SpaceCliIssueActionInput,
) -> Result<Value, String> {
    space_cli_issue_action(input, "cancel-claim").await
}

async fn space_cli_issue_action(
    input: SpaceCliIssueActionInput,
    action: &str,
) -> Result<Value, String> {
    let agent =
        resolve_local_agent_for_cli(input.agent_id.as_deref(), input.workspace_path.as_deref())?;
    let base_url = space_base_url()?;
    authorized_json_data_request(
        &base_url,
        &format!(
            "/api/issues/{}/{}",
            url_component(input.issue_id.trim()),
            action
        ),
        &agent.token,
        reqwest::Method::POST,
        None,
    )
    .await
}

pub async fn space_cli_claim_local_task(
    input: SpaceCliClaimLocalTaskInput,
) -> Result<Value, String> {
    let agent =
        resolve_local_agent_for_cli(input.agent_id.as_deref(), input.workspace_path.as_deref())?;
    let base_url = space_base_url()?;
    authorized_json_data_request(
        &base_url,
        &format!(
            "/api/claims/{}/local-task",
            url_component(input.claim_id.trim())
        ),
        &agent.token,
        reqwest::Method::POST,
        Some(serde_json::json!({
            "localTaskId": input.local_task_id,
            "localSessionId": input.local_session_id,
        })),
    )
    .await
}

pub async fn space_cli_attachment_download(
    input: SpaceCliAttachmentDownloadInput,
) -> Result<Value, String> {
    let agent =
        resolve_local_agent_for_cli(input.agent_id.as_deref(), input.workspace_path.as_deref())?;
    let base_url = space_base_url()?;
    let result = download_attachment_with_token(
        &base_url,
        &agent.token,
        &agent.workspace_path,
        input.attachment_id.trim(),
        input.issue_id.as_deref(),
        None,
        input.output.as_deref(),
    )
    .await?;
    serde_json::to_value(result)
        .map_err(|e| format!("Failed to serialize attachment result: {}", e))
}

pub async fn process_pending_deliveries(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
) -> Result<SpaceProcessDeliveryResult, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(crate::space_cloud_mock::process_deliveries_once());
    }
    ensure_space_available()?;
    if !team_space_runtime_enabled() {
        return Ok(SpaceProcessDeliveryResult {
            processed: 0,
            delivered: 0,
            errors: Vec::new(),
        });
    }
    let agents = read_current_runnable_local_agents()?
        .into_iter()
        .map(ensure_agent_delivery_session)
        .collect::<Result<Vec<_>, _>>()?;
    if agents.is_empty() {
        return Ok(SpaceProcessDeliveryResult {
            processed: 0,
            delivered: 0,
            errors: Vec::new(),
        });
    }
    let base_url = space_base_url()?;
    let mut processed = 0usize;
    let mut delivered = 0usize;
    let mut errors = Vec::new();
    for mut agent in agents {
        match process_agent_deliveries(app_handle, manager, &base_url, &mut agent).await {
            Ok((p, d)) => {
                processed += p;
                delivered += d;
            }
            Err(error) => {
                ulog_warn!(
                    "[space] delivery processing failed for agent {}: {}",
                    agent.id,
                    error
                );
                errors.push(format!("{}: {}", agent.display_name, error));
            }
        }
    }
    Ok(SpaceProcessDeliveryResult {
        processed,
        delivered,
        errors,
    })
}

#[derive(Debug, Clone)]
struct PendingSpaceDelivery {
    delivery_id: String,
    delivery_kind: String,
    claim_id: Option<String>,
    target_session_id: Option<String>,
    issue_id: String,
    issue_title: String,
    issue_state: String,
    goal_id: Option<String>,
    goal_path: Option<String>,
    update_summary: Option<String>,
    notification_version: i64,
}

impl PendingSpaceDelivery {
    fn is_claim_followup(&self) -> bool {
        self.delivery_kind == "claim_followup" || self.claim_id.is_some()
    }

    fn target_session(&self) -> Option<&str> {
        self.target_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }
}

async fn process_agent_deliveries(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    base_url: &str,
    agent: &mut LocalRegisteredAgent,
) -> Result<(usize, usize), String> {
    let data = authorized_json_data_request(
        base_url,
        "/api/registered-agents/me/deliveries?status=pending&limit=20",
        &agent.token,
        reqwest::Method::GET,
        None,
    )
    .await?;
    let items = data
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut processed = 0usize;
    let mut delivered = 0usize;
    let mut targeted_pending = Vec::new();
    let mut subscription_pending = Vec::new();
    for item in items {
        let delivery = item.get("delivery").cloned().unwrap_or(Value::Null);
        let issue_meta = item.get("issueMeta").cloned().unwrap_or(Value::Null);
        let goal_meta = item.get("goalMeta").cloned().unwrap_or(Value::Null);
        let delivery_id = required_value_string(&delivery, "id")?;
        let issue_id = optional_value_string(&delivery, "issueId")
            .or_else(|| optional_value_string(&issue_meta, "id"))
            .ok_or_else(|| "Space delivery response missing issueId".to_string())?;

        if let Some(existing) = find_delivery_log(base_url, &delivery_id)? {
            mark_delivery_delivered(base_url, agent, &delivery_id, &existing.session_id).await?;
            update_delivery_log_delivered(base_url, &delivery_id)?;
            processed += 1;
            delivered += 1;
            continue;
        }

        let pending_delivery = PendingSpaceDelivery {
            delivery_id,
            delivery_kind: optional_value_string(&delivery, "deliveryKind")
                .or_else(|| optional_value_string(&delivery, "delivery_kind"))
                .unwrap_or_else(|| "subscription".to_string()),
            claim_id: optional_value_string(&delivery, "claimId")
                .or_else(|| optional_value_string(&delivery, "claim_id")),
            target_session_id: optional_value_string(&delivery, "targetSessionId")
                .or_else(|| optional_value_string(&delivery, "target_session_id")),
            issue_id,
            issue_title: optional_value_string(&issue_meta, "title")
                .unwrap_or_else(|| "Untitled Space Issue".to_string()),
            issue_state: optional_value_string(&issue_meta, "state")
                .or_else(|| optional_value_string(&issue_meta, "status"))
                .unwrap_or_else(|| "todo".to_string()),
            goal_id: optional_value_string(&goal_meta, "id"),
            goal_path: optional_value_string(&goal_meta, "path")
                .or_else(|| optional_value_string(&goal_meta, "goalPathLabel"))
                .or_else(|| agent.goal_path_label.clone()),
            update_summary: optional_value_string(&delivery, "updateSummary"),
            notification_version: delivery
                .get("notificationVersion")
                .and_then(Value::as_i64)
                .unwrap_or(1),
        };
        if pending_delivery.is_claim_followup() && pending_delivery.target_session().is_none() {
            return Err(format!(
                "Space claim follow-up delivery {} is missing targetSessionId",
                pending_delivery.delivery_id
            ));
        }
        if pending_delivery.target_session().is_some() {
            targeted_pending.push(pending_delivery);
        } else {
            subscription_pending.push(pending_delivery);
        }
    }

    if targeted_pending.is_empty() && subscription_pending.is_empty() {
        return Ok((processed, delivered));
    }

    for delivery_item in targeted_pending {
        let session_id = delivery_item
            .target_session()
            .ok_or_else(|| {
                format!(
                    "Space delivery {} is missing targetSessionId",
                    delivery_item.delivery_id
                )
            })?
            .to_string();
        let message_id = deliver_space_deliveries(
            app_handle,
            manager,
            agent,
            &session_id,
            std::slice::from_ref(&delivery_item),
        )
        .await?;
        record_delivered_space_delivery(base_url, agent, &delivery_item, &session_id, &message_id)
            .await?;
        processed += 1;
        delivered += 1;
    }

    if subscription_pending.is_empty() {
        return Ok((processed, delivered));
    }

    match agent.issue_subscription_run_mode {
        SpaceIssueSubscriptionRunMode::SingleSession => {
            let session_id = agent
                .delivery_session_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!("Registered Agent {} is missing deliverySessionId", agent.id)
                })?
                .to_string();
            let message_id = deliver_space_deliveries(
                app_handle,
                manager,
                agent,
                &session_id,
                &subscription_pending,
            )
            .await?;
            for delivery_item in &subscription_pending {
                record_delivered_space_delivery(
                    base_url,
                    agent,
                    delivery_item,
                    &session_id,
                    &message_id,
                )
                .await?;
                processed += 1;
                delivered += 1;
            }
        }
        SpaceIssueSubscriptionRunMode::NewSession => {
            for delivery_item in subscription_pending {
                let session_id = ensure_agent_issue_session(agent, &delivery_item.issue_id)?;
                let message_id = deliver_space_deliveries(
                    app_handle,
                    manager,
                    agent,
                    &session_id,
                    std::slice::from_ref(&delivery_item),
                )
                .await?;
                record_delivered_space_delivery(
                    base_url,
                    agent,
                    &delivery_item,
                    &session_id,
                    &message_id,
                )
                .await?;
                processed += 1;
                delivered += 1;
            }
        }
    }
    Ok((processed, delivered))
}

async fn deliver_space_deliveries(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    agent: &LocalRegisteredAgent,
    session_id: &str,
    deliveries: &[PendingSpaceDelivery],
) -> Result<String, String> {
    let message_id = uuid::Uuid::new_v4().to_string();
    let prompt = if deliveries.len() == 1 {
        let delivery = &deliveries[0];
        if delivery.is_claim_followup() {
            build_claim_followup_prompt(agent, delivery)
        } else {
            build_delivery_prompt(
                agent,
                &delivery.delivery_id,
                &delivery.issue_id,
                &delivery.issue_title,
                &delivery.issue_state,
                delivery.goal_path.as_deref(),
                delivery.update_summary.as_deref(),
                delivery.notification_version,
            )
        }
    } else {
        build_delivery_batch_prompt(agent, deliveries)
    };
    let first = deliveries
        .first()
        .ok_or_else(|| "Space delivery batch is empty".to_string())?;
    let created_at = chrono::Utc::now().to_rfc3339();
    let message = crate::inbox::PendingInboxMessage {
        message_id: message_id.clone(),
        from_session_id: "myagents-space".to_string(),
        from_label: "MyAgents Space".to_string(),
        to_session_id: session_id.to_string(),
        text: prompt.clone(),
        reply_back: false,
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
        kind: crate::inbox::InboxMessageKind::Event,
        in_reply_to: None,
        session_event: Some(serde_json::json!({
            "version": 1,
            "type": "space.issue_delivery",
            "eventId": message_id,
            "sourceSessionId": "myagents-space",
            "sourceLabel": "MyAgents Space",
            "targetSessionId": session_id,
            "createdAt": created_at,
            "deliveryId": first.delivery_id,
            "deliveryKind": first.delivery_kind,
            "claimId": first.claim_id,
            "issueId": first.issue_id,
            "issueTitle": first.issue_title,
            "issueState": first.issue_state,
            "goalId": first.goal_id,
            "goalPathLabel": first.goal_path,
            "notificationVersion": first.notification_version,
            "updateSummary": first.update_summary,
            "deliveryCount": deliveries.len(),
            "payload": prompt,
        })),
    };
    let outcome = crate::inbox::deliver::deliver_with_resume(
        app_handle,
        manager,
        message,
        Some(PathBuf::from(&agent.workspace_path)),
    )
    .await;
    if !matches!(
        outcome,
        crate::inbox::deliver::DeliverOutcome::Delivered { .. }
    ) {
        let delivery_ids = deliveries
            .iter()
            .map(|delivery| delivery.delivery_id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "Delivery batch [{}] could not be injected into session {}: {:?}",
            delivery_ids, session_id, outcome
        ));
    }
    Ok(message_id)
}

async fn record_delivered_space_delivery(
    base_url: &str,
    agent: &LocalRegisteredAgent,
    delivery: &PendingSpaceDelivery,
    session_id: &str,
    message_id: &str,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    upsert_delivery_log(SpaceDeliveryLogEntry {
        delivery_id: delivery.delivery_id.clone(),
        base_url: base_url.to_string(),
        registered_agent_id: agent.id.clone(),
        issue_id: delivery.issue_id.clone(),
        session_id: session_id.to_string(),
        message_id: message_id.to_string(),
        delivered_at: None,
        created_at: now.clone(),
        updated_at: now,
    })?;
    mark_delivery_delivered(base_url, agent, &delivery.delivery_id, session_id).await?;
    update_delivery_log_delivered(base_url, &delivery.delivery_id)
}

fn ensure_agent_delivery_session(
    mut agent: LocalRegisteredAgent,
) -> Result<LocalRegisteredAgent, String> {
    if agent
        .delivery_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return Ok(agent);
    }
    agent.delivery_session_id = Some(uuid::Uuid::new_v4().to_string());
    agent.updated_at = chrono::Utc::now().to_rfc3339();
    upsert_local_agent(agent.clone())?;
    Ok(agent)
}

fn ensure_agent_issue_session(
    agent: &mut LocalRegisteredAgent,
    issue_id: &str,
) -> Result<String, String> {
    if let Some(session_id) = agent
        .issue_session_ids
        .get(issue_id)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(session_id.to_string());
    }
    let session_id = uuid::Uuid::new_v4().to_string();
    agent
        .issue_session_ids
        .insert(issue_id.to_string(), session_id.clone());
    agent.updated_at = chrono::Utc::now().to_rfc3339();
    upsert_local_agent(agent.clone())?;
    Ok(session_id)
}

async fn mark_delivery_delivered(
    base_url: &str,
    agent: &LocalRegisteredAgent,
    delivery_id: &str,
    session_id: &str,
) -> Result<(), String> {
    authorized_json_data_request(
        base_url,
        &format!("/api/deliveries/{}/delivered", url_component(delivery_id)),
        &agent.token,
        reqwest::Method::POST,
        Some(serde_json::json!({
            "sessionId": session_id,
        })),
    )
    .await
    .map(|_| ())
}

fn build_claim_followup_prompt(
    agent: &LocalRegisteredAgent,
    delivery: &PendingSpaceDelivery,
) -> String {
    let mut lines = vec![
        "MyAgents Space delivered a follow-up comment for an Issue handled by this Registered Agent session.".to_string(),
        String::new(),
        "Issue".to_string(),
        format!("- Delivery ID: {}", delivery.delivery_id),
        format!("- Issue ID: {}", delivery.issue_id),
        format!("- Title: {}", delivery.issue_title),
        format!("- State: {}", delivery.issue_state),
        format!("- Notification version: {}", delivery.notification_version),
    ];
    if let Some(claim_id) = delivery
        .claim_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("- Claim ID: {}", claim_id));
    }
    if let Some(goal_path) = delivery
        .goal_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("- Goal: {}", goal_path));
    }
    if let Some(update_summary) = delivery
        .update_summary
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("- Update: {}", update_summary));
    }
    lines.extend([
        String::new(),
        "Required handling model".to_string(),
        "- This Issue is already claimed by this Registered Agent. Do not run the claim command again.".to_string(),
        "- Continue in this same local session so the Issue context stays connected.".to_string(),
        format!(
            "- Read the current Issue context with `myagents space issue view {} --comments --json`.",
            shell_quote(&delivery.issue_id)
        ),
        format!(
            "- If the update needs a reply, post it with `myagents space issue comment {} --body-file reply.md`.",
            shell_quote(&delivery.issue_id)
        ),
        format!(
            "- If no action is required, run `myagents space issue delivery ignore {}`.",
            shell_quote(&delivery.delivery_id)
        ),
        format!(
            "- If additional work changes the final outcome, use `myagents space issue complete {} --workspacePath {} --taskId <taskId> --body-file result.md --message {}` when done.",
            shell_quote(&delivery.issue_id),
            shell_quote(&agent.workspace_path),
            shell_quote("completed Space issue")
        ),
    ]);
    if let Some(workspace_label) = agent
        .workspace_label
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("- Local workspace: {}", workspace_label));
    }
    lines.join("\n")
}

fn build_delivery_prompt(
    agent: &LocalRegisteredAgent,
    delivery_id: &str,
    issue_id: &str,
    issue_title: &str,
    issue_state: &str,
    goal_path: Option<&str>,
    update_summary: Option<&str>,
    notification_version: i64,
) -> String {
    let mut lines = vec![
        "MyAgents Space delivered an Issue notification to this Registered Agent session."
            .to_string(),
        String::new(),
        "Issue".to_string(),
        format!("- Delivery ID: {}", delivery_id),
        format!("- Issue ID: {}", issue_id),
        format!("- Title: {}", issue_title),
        format!("- State: {}", issue_state),
        format!("- Notification version: {}", notification_version),
    ];
    if let Some(goal_path) = goal_path.filter(|value| !value.trim().is_empty()) {
        lines.push(format!("- Goal: {}", goal_path));
    }
    if let Some(update_summary) = update_summary.filter(|value| !value.trim().is_empty()) {
        lines.push(format!("- Update: {}", update_summary));
    }
    let workspace_id = agent
        .local_workspace_id
        .as_deref()
        .or(agent.workspace_id.as_deref());
    let atomic_claim_command = workspace_id.map(|workspace_id| {
        format!(
            "myagents space issue claim {} --deliveryId {} --create-attached --workspaceId {} --workspacePath {} --sourceSpaceId {} --name {} --taskMdContent-file task.md",
            shell_quote(issue_id),
            shell_quote(delivery_id),
            shell_quote(workspace_id),
            shell_quote(&agent.workspace_path),
            shell_quote(&agent.space_id),
            shell_quote(&format!("Space Issue {}", issue_id)),
        )
    });
    let finish_command = format!(
        "myagents space issue complete {} --workspacePath {} --taskId <taskId> --body-file result.md --message {}",
        shell_quote(issue_id),
        shell_quote(&agent.workspace_path),
        shell_quote("completed Space issue")
    );
    lines.extend([
        String::new(),
        "Required handling model".to_string(),
        "- This is a notification, not an assigned task. Inspect the issue before deciding whether to act.".to_string(),
        format!(
            "- Read full context with `myagents space issue view {} --comments --json`.",
            issue_id
        ),
        format!(
            "- If this agent should not take it, run `myagents space issue delivery ignore {}`.",
            delivery_id
        ),
    ]);
    if let Some(command) = atomic_claim_command {
        lines.push("- To work on it, write a real task plan to `task.md`, then run the atomic claim + attached-task command from this same AI session:".to_string());
        lines.push(format!("  `{}`", command));
        lines.push("- That command claims the Issue, creates the attached Task, writes claim.localTaskId/localSessionId, and cancels the claim if local Task creation fails.".to_string());
    } else {
        lines.push("- This Registered Agent is missing a local workspace id; do not claim until it is re-registered from the Space Agents UI.".to_string());
    }
    lines.push("- Keep discussion and progress updates on the Space issue via `myagents space issue comment`.".to_string());
    lines.push(format!(
        "- When done, prefer the finish command `{}` to post the result comment, set the cloud Issue to done, keep the claim handler recorded, and mark the local Task done.",
        finish_command
    ));
    if let Some(workspace_label) = agent
        .workspace_label
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("- Local workspace: {}", workspace_label));
    }
    lines.join("\n")
}

fn build_delivery_batch_prompt(
    agent: &LocalRegisteredAgent,
    deliveries: &[PendingSpaceDelivery],
) -> String {
    let mut lines = vec![
        format!(
            "MyAgents Space delivered {} Issue notifications to this Registered Agent session.",
            deliveries.len()
        ),
        String::new(),
        "Process each issue independently. Inspect before claiming, and ignore anything this agent should not take."
            .to_string(),
    ];
    let workspace_id = agent
        .local_workspace_id
        .as_deref()
        .or(agent.workspace_id.as_deref());

    for (index, delivery) in deliveries.iter().enumerate() {
        lines.extend([
            String::new(),
            format!("Issue {}", index + 1),
            format!("- Delivery ID: {}", delivery.delivery_id),
            format!("- Issue ID: {}", delivery.issue_id),
            format!("- Title: {}", delivery.issue_title),
            format!("- State: {}", delivery.issue_state),
            format!("- Notification version: {}", delivery.notification_version),
        ]);
        if let Some(goal_path) = delivery
            .goal_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            lines.push(format!("- Goal: {}", goal_path));
        }
        if let Some(update_summary) = delivery
            .update_summary
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            lines.push(format!("- Update: {}", update_summary));
        }
        lines.push(format!(
            "- Read full context: `myagents space issue view {} --comments --json`",
            shell_quote(&delivery.issue_id)
        ));
        lines.push(format!(
            "- Ignore: `myagents space issue delivery ignore {}`",
            shell_quote(&delivery.delivery_id)
        ));
        if let Some(workspace_id) = workspace_id {
            lines.push(format!(
                "- Claim with attached Task after writing the issue-specific plan to `task.md`: `myagents space issue claim {} --deliveryId {} --create-attached --workspaceId {} --workspacePath {} --sourceSpaceId {} --name {} --taskMdContent-file task.md`",
                shell_quote(&delivery.issue_id),
                shell_quote(&delivery.delivery_id),
                shell_quote(workspace_id),
                shell_quote(&agent.workspace_path),
                shell_quote(&agent.space_id),
                shell_quote(&format!("Space Issue {}", delivery.issue_id)),
            ));
        } else {
            lines.push("- Cannot claim until this Registered Agent is re-registered with a local workspace id.".to_string());
        }
        lines.push(format!(
            "- Complete after work: `myagents space issue complete {} --workspacePath {} --taskId <taskId> --body-file result.md --message {}`",
            shell_quote(&delivery.issue_id),
            shell_quote(&agent.workspace_path),
            shell_quote("completed Space issue")
        ));
    }

    lines.extend([
        String::new(),
        "Required handling model".to_string(),
        "- This is one continuous conversation turn for multiple notifications.".to_string(),
        "- Do not assume every issue should be claimed; decide issue by issue.".to_string(),
        "- If claiming multiple issues, prepare and claim them one at a time so each attached Task gets the right task.md.".to_string(),
        "- Keep discussion and progress updates on each Space issue via `myagents space issue comment`.".to_string(),
    ]);
    if let Some(workspace_label) = agent
        .workspace_label
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        lines.push(format!("- Local workspace: {}", workspace_label));
    }
    lines.join("\n")
}

fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':' | '='))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn http_client() -> Result<reqwest::Client, String> {
    // Space talks to configured external HTTPS origins. `local_http` is
    // localhost-only; this client must honor the app's proxy settings.
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5));
    crate::proxy_config::build_client_with_proxy(builder)
        .map_err(|e| format!("Failed to build Space HTTP client: {}", e))
}

fn space_enabled_flag() -> bool {
    SPACE_ENABLED_ENV
        .map(str::trim)
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn configured_public_client_id() -> Option<String> {
    [SPACE_PUBLIC_CLIENT_ID_ENV, SPACE_LEGACY_CLIENT_ID_ENV]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn validate_configured_space_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("MYAGENTS_SPACE_BASE_URL is empty".to_string());
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|e| format!("Invalid MYAGENTS_SPACE_BASE_URL: {}", e))?;
    if url.scheme() != "https" {
        return Err("MYAGENTS_SPACE_BASE_URL must use https".to_string());
    }
    if url.host_str().is_none() {
        return Err("MYAGENTS_SPACE_BASE_URL must include a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("MYAGENTS_SPACE_BASE_URL must not include credentials".to_string());
    }
    let mut normalized = url;
    if normalized.path() != "/" {
        return Err("MYAGENTS_SPACE_BASE_URL must not include a path".to_string());
    }
    normalized.set_query(None);
    normalized.set_fragment(None);
    Ok(normalized.to_string().trim_end_matches('/').to_string())
}

pub fn space_build_capability() -> SpaceBuildCapability {
    if crate::space_cloud_mock::is_enabled() {
        return SpaceBuildCapability {
            available: true,
            base_url: Some(crate::space_cloud_mock::MOCK_BASE_URL.to_string()),
            public_client_id: Some("mock-public-client".to_string()),
            reason: None,
        };
    }
    if !space_enabled_flag() {
        return SpaceBuildCapability {
            available: false,
            base_url: None,
            public_client_id: configured_public_client_id(),
            reason: Some("Team Space is not enabled in this build".to_string()),
        };
    }
    let base_url = match SPACE_BASE_URL_ENV {
        Some(value) => match validate_configured_space_base_url(value) {
            Ok(url) => url,
            Err(error) => {
                return SpaceBuildCapability {
                    available: false,
                    base_url: None,
                    public_client_id: configured_public_client_id(),
                    reason: Some(error),
                };
            }
        },
        None => {
            return SpaceBuildCapability {
                available: false,
                base_url: None,
                public_client_id: configured_public_client_id(),
                reason: Some(
                    "MYAGENTS_SPACE_BASE_URL is required when MYAGENTS_SPACE_ENABLED=true"
                        .to_string(),
                ),
            };
        }
    };
    SpaceBuildCapability {
        available: true,
        base_url: Some(base_url),
        public_client_id: configured_public_client_id(),
        reason: None,
    }
}

fn ensure_space_available() -> Result<SpaceBuildCapability, String> {
    let capability = space_build_capability();
    if capability.available {
        Ok(capability)
    } else {
        Err(capability
            .reason
            .unwrap_or_else(|| "Team Space is not available in this build".to_string()))
    }
}

fn capability_base_url(capability: &SpaceBuildCapability) -> Result<String, String> {
    capability
        .base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "Team Space build capability is missing baseUrl".to_string())
}

fn with_public_client_id_header(
    request: reqwest::RequestBuilder,
    capability: &SpaceBuildCapability,
) -> reqwest::RequestBuilder {
    match capability.public_client_id.as_deref() {
        Some(client_id) if !client_id.trim().is_empty() => {
            request.header(SPACE_PUBLIC_CLIENT_ID_HEADER, client_id.trim())
        }
        _ => request,
    }
}

fn api_url(base_url: &str, path: &str) -> Result<String, String> {
    if !path.starts_with("/api/") && path != "/health" && path != "/" {
        return Err("Space API path must start with /api/".to_string());
    }
    let base =
        reqwest::Url::parse(base_url).map_err(|e| format!("Invalid Space base URL: {}", e))?;
    if base.scheme() != "https" {
        return Err("Space base URL must use https".to_string());
    }
    base.join(path.trim_start_matches('/'))
        .map(|u| u.to_string())
        .map_err(|e| format!("Invalid Space API path: {}", e))
}

fn session_space_segment(session: &SpaceSession) -> String {
    session
        .space
        .get("slug")
        .and_then(Value::as_str)
        .or_else(|| session.space.get("id").and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .map(url_component)
        .unwrap_or_else(|| "official".to_string())
}

async fn parse_cloud_data<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    let envelope = response
        .json::<CloudEnvelope<T>>()
        .await
        .map_err(|e| format!("Invalid Space API response: {}", e))?;
    if !status.is_success() || !envelope.success {
        let mut message = envelope
            .error
            .unwrap_or_else(|| format!("Space API request failed with {}", status));
        if let Some(code) = envelope
            .code
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            message = format!("{} ({})", message, code);
        }
        if let Some(request_id) = envelope
            .request_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            message = format!("{} [{}]", message, request_id);
        }
        if let Some(hint) = envelope.recovery_hint {
            if let Some(text) = hint.get("message").and_then(Value::as_str) {
                message = format!("{} · {}", message, text);
            }
        }
        return Err(message);
    }
    envelope
        .data
        .ok_or_else(|| "Space API response missing data".to_string())
}

async fn authorized_json_request(
    base_url: &str,
    path: &str,
    token: &str,
    method: reqwest::Method,
    body: Option<Value>,
) -> Result<Value, String> {
    if crate::space_cloud_mock::is_enabled() {
        let data = crate::space_cloud_mock::api_data_request(method.as_str(), path, body)?;
        return Ok(serde_json::json!({ "success": true, "data": data }));
    }
    let capability = ensure_space_available()?;
    let client = http_client()?;
    let mut req = with_public_client_id_header(
        client
            .request(method, api_url(base_url, path)?)
            .header(AUTHORIZATION, format!("Bearer {}", token)),
        &capability,
    );
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req
        .send()
        .await
        .map_err(|e| format!("Space API request failed: {}", e))?;
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid Space API response: {}", e))
}

async fn upsert_space_user_device(
    session: &SpaceSession,
    identity: &DeviceIdentity,
) -> Result<(), String> {
    let body = serde_json::json!({
        "deviceId": identity.device_id,
        "deviceName": identity.device_name,
        "platform": identity.platform,
        "osVersion": identity.os_version,
        "appVersion": identity.app_version,
    });
    authorized_json_data_request(
        &session.base_url,
        "/api/devices/upsert",
        &session.session_token,
        reqwest::Method::POST,
        Some(body),
    )
    .await
    .map(|_| ())
}

async fn try_upsert_space_user_device(session: &SpaceSession, identity: &DeviceIdentity) {
    if let Err(error) = upsert_space_user_device(session, identity).await {
        ulog_warn!(
            "[space] failed to upsert user device {}: {}",
            identity.device_id,
            error
        );
    }
}

async fn authorized_json_data_request(
    base_url: &str,
    path: &str,
    token: &str,
    method: reqwest::Method,
    body: Option<Value>,
) -> Result<Value, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::api_data_request_with_token(
            method.as_str(),
            path,
            Some(token),
            body,
        );
    }
    let capability = ensure_space_available()?;
    let client = http_client()?;
    let mut req = with_public_client_id_header(
        client
            .request(method, api_url(base_url, path)?)
            .header(AUTHORIZATION, format!("Bearer {}", token)),
        &capability,
    );
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req
        .send()
        .await
        .map_err(|e| format!("Space API request failed: {}", e))?;
    parse_cloud_data::<Value>(response).await
}

async fn authorized_multipart_data_request(
    base_url: &str,
    path: &str,
    token: &str,
    form: reqwest::multipart::Form,
) -> Result<Value, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Err(
            "Mock Space does not accept raw multipart requests; use typed mock upload commands"
                .to_string(),
        );
    }
    let capability = ensure_space_available()?;
    let response = with_public_client_id_header(
        http_client()?
            .post(api_url(base_url, path)?)
            .header(AUTHORIZATION, format!("Bearer {}", token))
            .multipart(form),
        &capability,
    )
    .send()
    .await
    .map_err(|e| format!("Space upload failed: {}", e))?;
    parse_cloud_data::<Value>(response).await
}

async fn authorized_raw_request(
    base_url: &str,
    path: &str,
    token: &str,
) -> Result<reqwest::Response, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Err("Mock Space raw HTTP response is not available through this path".to_string());
    }
    let capability = ensure_space_available()?;
    let response = with_public_client_id_header(
        http_client()?
            .get(api_url(base_url, path)?)
            .header(AUTHORIZATION, format!("Bearer {}", token)),
        &capability,
    )
    .send()
    .await
    .map_err(|e| format!("Space API request failed: {}", e))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Space download failed with {}: {}", status, text));
    }
    Ok(response)
}

async fn authorized_bytes_request(
    base_url: &str,
    path: &str,
    token: &str,
) -> Result<Vec<u8>, String> {
    if crate::space_cloud_mock::is_enabled() {
        if let Some(skill_id) = path
            .strip_prefix("/api/skills/")
            .and_then(|rest| rest.strip_suffix("/package.zip"))
        {
            return crate::space_cloud_mock::skill_package_bytes(skill_id);
        }
        return Err(format!("Mock Space bytes route not implemented: {}", path));
    }
    let response = authorized_raw_request(base_url, path, token).await?;
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("Space download failed: {}", e))
}

fn space_data_dir() -> Result<PathBuf, String> {
    let dir = crate::app_dirs::myagents_data_dir()
        .ok_or_else(|| "Home dir not found".to_string())?
        .join("space");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create Space data dir: {}", e))?;
    Ok(dir)
}

pub fn registered_agents_path() -> Result<PathBuf, String> {
    Ok(space_data_dir()?.join(LOCAL_AGENTS_FILE))
}

fn delivery_log_path() -> Result<PathBuf, String> {
    Ok(space_data_dir()?.join(DELIVERY_LOG_FILE))
}

fn session_path() -> Result<PathBuf, String> {
    Ok(space_data_dir()?.join(SESSION_FILE))
}

fn read_session() -> Result<Option<SpaceSession>, String> {
    let path = session_path()?;
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|e| format!("Invalid Space session file: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read Space session file: {}", e)),
    }
}

fn require_session() -> Result<SpaceSession, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(crate::space_cloud_mock::session());
    }
    let configured_base_url = space_base_url()?;
    let session = read_session()?.ok_or_else(|| "Not logged in to MyAgents Space".to_string())?;
    if !space_base_urls_equal(&session.base_url, &configured_base_url) {
        return Err(
            "Space session belongs to a different Space service. Please log in again.".to_string(),
        );
    }
    Ok(session)
}

fn read_local_agents() -> Result<LocalRegisteredAgentsFile, String> {
    let path = registered_agents_path()?;
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("Invalid local Space agents file: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(LocalRegisteredAgentsFile::default())
        }
        Err(e) => Err(format!("Failed to read local Space agents file: {}", e)),
    }
}

fn read_current_session() -> Result<Option<SpaceSession>, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(Some(crate::space_cloud_mock::session()));
    }
    let configured_base_url = space_base_url()?;
    Ok(read_session()?
        .filter(|session| space_base_urls_equal(&session.base_url, &configured_base_url)))
}

fn read_current_local_agents() -> Result<Vec<LocalRegisteredAgent>, String> {
    if crate::space_cloud_mock::is_enabled() {
        return Ok(crate::space_cloud_mock::list_local_agents()
            .into_iter()
            .map(|agent| LocalRegisteredAgent {
                id: agent.id.clone(),
                base_url: agent.base_url.clone(),
                space_id: agent.space_id.clone(),
                owner_user_id: agent.owner_user_id.clone(),
                device_id: agent.device_id.clone(),
                client_id: agent.client_id.clone(),
                device_name: agent.device_name.clone(),
                device_platform: agent
                    .device
                    .as_ref()
                    .and_then(|device| device.platform.clone()),
                device_os_version: agent
                    .device
                    .as_ref()
                    .and_then(|device| device.os_version.clone()),
                device_app_version: agent
                    .device
                    .as_ref()
                    .and_then(|device| device.app_version.clone()),
                device_last_seen_at: agent
                    .device
                    .as_ref()
                    .and_then(|device| device.last_seen_at.clone()),
                local_workspace_id: agent.local_workspace_id.clone(),
                local_agent_id: agent.local_agent_id.clone(),
                workspace_id: agent.workspace_id.clone(),
                display_name: agent.display_name.clone(),
                workspace_path: agent.workspace_path.clone(),
                workspace_label: agent.workspace_label.clone(),
                goal_id: agent.goal_id.clone(),
                goal_path_label: agent.goal_path_label.clone(),
                state_filter: agent.state_filter.clone(),
                goal_md: agent.goal_md.clone(),
                delivery_session_id: agent.delivery_session_id.clone(),
                issue_subscription_run_mode: agent.issue_subscription_run_mode.clone(),
                issue_session_ids: BTreeMap::new(),
                token: format!("mock-token-{}", agent.id),
                status: agent.status.clone(),
                created_at: agent.created_at.clone(),
                updated_at: agent.updated_at.clone(),
            })
            .collect());
    }
    let configured_base_url = space_base_url()?;
    Ok(read_local_agents()?
        .items
        .into_iter()
        .filter(|agent| space_base_urls_equal(&agent.base_url, &configured_base_url))
        .collect())
}

fn upsert_local_agent(agent: LocalRegisteredAgent) -> Result<(), String> {
    let path = registered_agents_path()?;
    let lock_path = path.clone();
    with_json_file_lock(&lock_path, move || {
        let mut file = read_local_agents_unlocked(&path)?;
        file.items.retain(|existing| {
            existing.id != agent.id || !space_base_urls_equal(&existing.base_url, &agent.base_url)
        });
        file.items.push(agent);
        write_private_json_unlocked(&path, &file)
    })
}

fn require_local_agent(id: &str) -> Result<LocalRegisteredAgent, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::require_local_agent(id);
    }
    ensure_space_available()?;
    read_current_runnable_local_agents()?
        .into_iter()
        .find(|agent| agent.id == id)
        .ok_or_else(|| format!("Registered Agent not found locally: {}", id))
}

fn resolve_local_agent_for_cli(
    agent_id: Option<&str>,
    workspace_path: Option<&str>,
) -> Result<LocalRegisteredAgent, String> {
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::resolve_local_agent_for_cli(agent_id, workspace_path);
    }
    ensure_space_available()?;
    let agents = read_current_runnable_local_agents()?;
    if agents.is_empty() {
        return Err("No local Registered Agent token found. Register this workspace from the MyAgents Space page first.".to_string());
    }
    if let Some(id) = agent_id.filter(|s| !s.trim().is_empty()) {
        return agents
            .into_iter()
            .find(|agent| agent.id == id)
            .ok_or_else(|| format!("Registered Agent not found locally: {}", id));
    }
    let workspace = workspace_path
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "workspacePath is required when --agent-id is not provided".to_string())?;
    let workspace_root = validate_workspace_root(workspace)?;
    let mut matches = agents
        .into_iter()
        .filter(|agent| {
            validate_workspace_root(&agent.workspace_path)
                .map(|candidate| candidate == workspace_root)
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        return Ok(matches.remove(0));
    }
    if matches.len() > 1 {
        return Err(format!(
            "Multiple Registered Agents match this workspace. Pass --agent-id. Candidates: {}",
            matches
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    Err(format!(
        "No Registered Agent token matches workspace: {}",
        workspace
    ))
}

fn read_current_runnable_local_agents() -> Result<Vec<LocalRegisteredAgent>, String> {
    let Some(session) = read_current_session()? else {
        return Ok(Vec::new());
    };
    let local_device_id = crate::device_identity::get_or_create_device_id()?;
    Ok(read_current_local_agents()?
        .into_iter()
        .filter(|agent| agent.status == "active")
        .filter(|agent| local_agent_matches_current_identity(agent, &session, &local_device_id))
        .collect())
}

fn local_agent_matches_current_identity(
    agent: &LocalRegisteredAgent,
    session: &SpaceSession,
    local_device_id: &str,
) -> bool {
    let Some(current_user_id) = session_user_id(session) else {
        return false;
    };
    agent
        .owner_user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        == Some(current_user_id.as_str())
        && agent
            .device_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            == Some(local_device_id)
}

fn session_user_id(session: &SpaceSession) -> Option<String> {
    optional_value_string(&session.user, "id")
}

fn read_local_agents_unlocked(path: &Path) -> Result<LocalRegisteredAgentsFile, String> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("Invalid local Space agents file: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(LocalRegisteredAgentsFile::default())
        }
        Err(e) => Err(format!("Failed to read local Space agents file: {}", e)),
    }
}

fn read_delivery_log() -> Result<SpaceDeliveryLogFile, String> {
    let path = delivery_log_path()?;
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("Invalid Space delivery log file: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SpaceDeliveryLogFile::default()),
        Err(e) => Err(format!("Failed to read Space delivery log file: {}", e)),
    }
}

fn find_delivery_log(
    base_url: &str,
    delivery_id: &str,
) -> Result<Option<SpaceDeliveryLogEntry>, String> {
    Ok(read_delivery_log()?.items.into_iter().find(|entry| {
        entry.delivery_id == delivery_id && space_base_urls_equal(&entry.base_url, base_url)
    }))
}

fn upsert_delivery_log(entry: SpaceDeliveryLogEntry) -> Result<(), String> {
    let path = delivery_log_path()?;
    let lock_path = path.clone();
    with_json_file_lock(&lock_path, move || {
        let mut file = read_delivery_log_unlocked(&path)?;
        file.items.retain(|existing| {
            existing.delivery_id != entry.delivery_id
                || !space_base_urls_equal(&existing.base_url, &entry.base_url)
        });
        file.items.push(entry);
        write_private_json_unlocked(&path, &file)
    })
}

fn update_delivery_log_delivered(base_url: &str, delivery_id: &str) -> Result<(), String> {
    let path = delivery_log_path()?;
    let base_url = base_url.to_string();
    let delivery_id = delivery_id.to_string();
    let lock_path = path.clone();
    with_json_file_lock(&lock_path, move || {
        let mut file = read_delivery_log_unlocked(&path)?;
        if let Some(entry) = file.items.iter_mut().find(|entry| {
            entry.delivery_id == delivery_id && space_base_urls_equal(&entry.base_url, &base_url)
        }) {
            entry.delivered_at = Some(chrono::Utc::now().to_rfc3339());
            entry.updated_at = chrono::Utc::now().to_rfc3339();
        }
        write_private_json_unlocked(&path, &file)
    })
}

fn read_delivery_log_unlocked(path: &Path) -> Result<SpaceDeliveryLogFile, String> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("Invalid Space delivery log file: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SpaceDeliveryLogFile::default()),
        Err(e) => Err(format!("Failed to read Space delivery log file: {}", e)),
    }
}

fn with_json_file_lock<F>(path: &Path, mutator: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    let lock = path.with_extension("lock");
    crate::utils::file_lock::with_file_lock_blocking(
        &lock,
        crate::utils::file_lock::FileLockOptions::default(),
        move || {
            mutator()
                .map_err(|e| crate::utils::file_lock::FileLockError::Io(std::io::Error::other(e)))
        },
    )
    .map_err(String::from)
}

fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let path = path.to_path_buf();
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| format!("Failed to serialize JSON: {}", e))?;
    with_json_file_lock(&path.clone(), move || {
        write_private_bytes_unlocked(&path, &bytes)
    })
}

fn write_private_json_unlocked<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| format!("Failed to serialize JSON: {}", e))?;
    write_private_bytes_unlocked(path, &bytes)
}

fn write_private_bytes_unlocked(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("Failed to write temp file: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to chmod temp file: {}", e))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("Failed to commit file: {}", e))?;
    Ok(())
}

fn space_base_url() -> Result<String, String> {
    capability_base_url(&ensure_space_available()?)
}

fn space_base_urls_equal(a: &str, b: &str) -> bool {
    a.trim().trim_end_matches('/') == b.trim().trim_end_matches('/')
}

fn team_space_runtime_enabled() -> bool {
    let Some(dir) = crate::app_dirs::myagents_data_dir() else {
        return false;
    };
    let Ok(content) = fs::read_to_string(dir.join("config.json")) else {
        return false;
    };
    let Ok(config) = serde_json::from_str::<Value>(crate::utils::bom::strip_bom(&content)) else {
        return false;
    };
    config
        .get("teamSpaceEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn required_value_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| format!("Space API response missing {}", key))
}

fn optional_value_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn value_string_array(value: &Value, key: &str) -> Option<Vec<String>> {
    let array = value.get(key)?.as_array()?;
    Some(
        array
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect(),
    )
}

fn normalize_agent_state_filter(input: Option<Vec<String>>) -> Vec<String> {
    let mut out = Vec::new();
    for state in input.unwrap_or_else(default_agent_state_filter) {
        let state = state.trim();
        if state.is_empty() || out.iter().any(|existing| existing == state) {
            continue;
        }
        out.push(state.to_string());
    }
    if out.is_empty() {
        default_agent_state_filter()
    } else {
        out
    }
}

fn stable_local_agent_id(workspace_id: &str) -> String {
    format!("local-agent-{}", safe_local_name(workspace_id))
}

fn safe_local_name(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch.to_ascii_lowercase());
        } else if ch.is_whitespace() {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(['-', '.', '_']).to_string();
    if trimmed.is_empty() {
        "item".to_string()
    } else {
        trimmed
    }
}

fn safe_local_filename(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch == '/'
            || ch == '\\'
            || ch == '\0'
            || matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|')
        {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    out.trim().trim_matches('.').to_string()
}

fn choose_available_dir(root: &Path, base_name: &str) -> Result<(PathBuf, String, bool), String> {
    for i in 0..1000 {
        let name = if i == 0 {
            base_name.to_string()
        } else {
            format!("{}-{}", base_name, i + 1)
        };
        let candidate = root.join(&name);
        match fs::symlink_metadata(&candidate) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok((candidate, name, i != 0))
            }
            Err(e) => return Err(format!("Failed to inspect install target: {}", e)),
        }
    }
    Err("Could not find an available install directory".to_string())
}

fn extract_skill_zip(bytes: &[u8], target_dir: &Path) -> Result<(), String> {
    let root_prefix = find_skill_root_prefix(bytes)?;
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Invalid skill zip: {}", e))?;
    if archive.len() > MAX_SKILL_ZIP_ENTRIES {
        return Err(format!(
            "Skill zip has too many entries (max {})",
            MAX_SKILL_ZIP_ENTRIES
        ));
    }
    let mut seen = HashSet::new();
    let mut total_size = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Invalid zip entry: {}", e))?;
        if entry.is_dir() {
            continue;
        }
        if entry.size() > MAX_SKILL_FILE_BYTES {
            return Err(format!(
                "Skill zip entry exceeds {} bytes: {}",
                MAX_SKILL_FILE_BYTES,
                entry.name()
            ));
        }
        total_size = total_size
            .checked_add(entry.size())
            .ok_or_else(|| "Skill zip total size overflow".to_string())?;
        if total_size > MAX_SKILL_TOTAL_BYTES {
            return Err(format!(
                "Skill zip expands beyond {} bytes",
                MAX_SKILL_TOTAL_BYTES
            ));
        }
        let entry_name = entry.name().replace('\\', "/");
        if !entry_name.starts_with(&root_prefix) {
            continue;
        }
        let relative = &entry_name[root_prefix.len()..];
        if relative.is_empty() {
            continue;
        }
        let safe = safe_zip_relative_path(relative)?;
        if !seen.insert(safe.clone()) {
            return Err(format!("Duplicate skill zip entry: {}", safe.display()));
        }
        let target = target_dir.join(&safe);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create skill subdir: {}", e))?;
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut data)
            .map_err(|e| format!("Failed to read skill zip entry: {}", e))?;
        atomic_write_file(&target, &data)?;
    }
    if !target_dir.join("SKILL.md").is_file() {
        return Err("Skill zip did not extract a SKILL.md".to_string());
    }
    Ok(())
}

fn find_skill_root_prefix(bytes: &[u8]) -> Result<String, String> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Invalid skill zip: {}", e))?;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Invalid zip entry: {}", e))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        if name == "SKILL.md" {
            return Ok(String::new());
        }
        if let Some(prefix) = name.strip_suffix("SKILL.md") {
            return Ok(prefix.to_string());
        }
    }
    Err("Skill zip must contain SKILL.md".to_string())
}

fn safe_zip_relative_path(relative: &str) -> Result<PathBuf, String> {
    if Path::new(relative).is_absolute() {
        return Err("Zip entry uses absolute path".to_string());
    }
    let mut out = PathBuf::new();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err("Zip entry escapes install directory".to_string());
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("Zip entry path is empty".to_string());
    }
    Ok(out)
}

fn filename_from_content_disposition(value: Option<&str>) -> Option<String> {
    let raw = value?;
    for part in raw.split(';') {
        let trimmed = part.trim();
        if let Some(name) = trimmed.strip_prefix("filename=") {
            return Some(safe_local_filename(name.trim_matches('"')));
        }
    }
    None
}

fn url_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_delivery_batch_prompt_groups_multiple_issues_for_single_session_mode() {
        let agent = LocalRegisteredAgent {
            id: "rag_test".to_string(),
            base_url: "https://space.myagents.test".to_string(),
            space_id: "space_test".to_string(),
            owner_user_id: Some("usr_test".to_string()),
            device_id: Some("device_test".to_string()),
            client_id: None,
            device_name: Some("Test Device".to_string()),
            device_platform: Some("test-platform".to_string()),
            device_os_version: Some("test-os".to_string()),
            device_app_version: Some("0.0.0-test".to_string()),
            device_last_seen_at: Some("2026-06-24T00:00:00.000Z".to_string()),
            local_workspace_id: Some("workspace_test".to_string()),
            local_agent_id: None,
            workspace_id: Some("workspace_test".to_string()),
            display_name: "Batch Agent".to_string(),
            workspace_path: "/tmp/myagents-batch".to_string(),
            workspace_label: Some("Batch Workspace".to_string()),
            goal_id: Some("goal_test".to_string()),
            goal_path_label: Some("Root / Batch".to_string()),
            state_filter: vec!["todo".to_string()],
            goal_md: None,
            delivery_session_id: Some("session_shared".to_string()),
            issue_subscription_run_mode: SpaceIssueSubscriptionRunMode::SingleSession,
            issue_session_ids: BTreeMap::new(),
            token: "token".to_string(),
            status: "active".to_string(),
            created_at: "2026-06-24T00:00:00.000Z".to_string(),
            updated_at: "2026-06-24T00:00:00.000Z".to_string(),
        };
        let prompt = build_delivery_batch_prompt(
            &agent,
            &[
                PendingSpaceDelivery {
                    delivery_id: "delivery_1".to_string(),
                    delivery_kind: "subscription".to_string(),
                    claim_id: None,
                    target_session_id: None,
                    issue_id: "issue_1".to_string(),
                    issue_title: "First".to_string(),
                    issue_state: "todo".to_string(),
                    goal_id: Some("goal_test".to_string()),
                    goal_path: Some("Root / Batch".to_string()),
                    update_summary: None,
                    notification_version: 1,
                },
                PendingSpaceDelivery {
                    delivery_id: "delivery_2".to_string(),
                    delivery_kind: "subscription".to_string(),
                    claim_id: None,
                    target_session_id: None,
                    issue_id: "issue_2".to_string(),
                    issue_title: "Second".to_string(),
                    issue_state: "todo".to_string(),
                    goal_id: Some("goal_test".to_string()),
                    goal_path: Some("Root / Batch".to_string()),
                    update_summary: Some("State changed to todo".to_string()),
                    notification_version: 2,
                },
            ],
        );

        assert!(prompt.contains("delivered 2 Issue notifications"));
        assert!(prompt.contains("Issue 1"));
        assert!(prompt.contains("Delivery ID: delivery_1"));
        assert!(prompt.contains("Issue 2"));
        assert!(prompt.contains("Delivery ID: delivery_2"));
        assert!(prompt.contains("one continuous conversation turn"));
    }

    #[test]
    fn build_claim_followup_prompt_keeps_existing_handler_context() {
        let agent = LocalRegisteredAgent {
            id: "rag_test".to_string(),
            base_url: "https://space.myagents.test".to_string(),
            space_id: "space_test".to_string(),
            owner_user_id: Some("usr_test".to_string()),
            device_id: Some("device_test".to_string()),
            client_id: None,
            device_name: Some("Test Device".to_string()),
            device_platform: Some("test-platform".to_string()),
            device_os_version: Some("test-os".to_string()),
            device_app_version: Some("0.0.0-test".to_string()),
            device_last_seen_at: Some("2026-06-24T00:00:00.000Z".to_string()),
            local_workspace_id: Some("workspace_test".to_string()),
            local_agent_id: None,
            workspace_id: Some("workspace_test".to_string()),
            display_name: "Followup Agent".to_string(),
            workspace_path: "/tmp/myagents-followup".to_string(),
            workspace_label: Some("Followup Workspace".to_string()),
            goal_id: Some("goal_test".to_string()),
            goal_path_label: Some("Root / Followup".to_string()),
            state_filter: vec!["todo".to_string()],
            goal_md: None,
            delivery_session_id: Some("session_shared".to_string()),
            issue_subscription_run_mode: SpaceIssueSubscriptionRunMode::SingleSession,
            issue_session_ids: BTreeMap::new(),
            token: "token".to_string(),
            status: "active".to_string(),
            created_at: "2026-06-24T00:00:00.000Z".to_string(),
            updated_at: "2026-06-24T00:00:00.000Z".to_string(),
        };
        let prompt = build_claim_followup_prompt(
            &agent,
            &PendingSpaceDelivery {
                delivery_id: "delivery_followup".to_string(),
                delivery_kind: "claim_followup".to_string(),
                claim_id: Some("claim_1".to_string()),
                target_session_id: Some("session_claim".to_string()),
                issue_id: "issue_1".to_string(),
                issue_title: "Follow-up question".to_string(),
                issue_state: "done".to_string(),
                goal_id: Some("goal_test".to_string()),
                goal_path: Some("Root / Followup".to_string()),
                update_summary: Some("New human comment".to_string()),
                notification_version: 4,
            },
        );

        assert!(prompt.contains("follow-up comment"));
        assert!(prompt.contains("already claimed"));
        assert!(prompt.contains("Do not run the claim command again"));
        assert!(prompt.contains("myagents space issue comment issue_1"));
        assert!(!prompt.contains("--create-attached"));
    }

    #[tokio::test]
    async fn mock_space_delivery_routes_poll_mark_and_process() {
        let _mock = crate::space_cloud_mock::enable_for_test();

        let pending = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
            registered_agent_id: "rag_mock_frontend".to_string(),
        })
        .await
        .expect("mock deliveries should poll");
        let items = pending
            .pointer("/data/items")
            .and_then(Value::as_array)
            .expect("delivery items");
        assert!(!items.is_empty());
        let delivery_id = items[0]
            .pointer("/delivery/id")
            .and_then(Value::as_str)
            .expect("delivery id")
            .to_string();

        let marked = cmd_space_mark_delivery_delivered(SpaceMarkDeliveryDeliveredInput {
            registered_agent_id: "rag_mock_frontend".to_string(),
            delivery_id,
            session_id: Some("session-space-delivery".to_string()),
        })
        .await
        .expect("mock delivery should mark delivered");
        assert_eq!(
            marked.pointer("/data/delivered").and_then(Value::as_bool),
            Some(true)
        );

        let empty = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
            registered_agent_id: "rag_mock_frontend".to_string(),
        })
        .await
        .expect("mock deliveries should poll after mark");
        assert_eq!(
            empty
                .pointer("/data/items")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );

        crate::space_cloud_mock::reset();
        let processed = crate::space_cloud_mock::process_deliveries_once();
        assert!(processed.processed >= 1);
        assert_eq!(processed.delivered, processed.processed);
    }

    #[tokio::test]
    async fn mock_space_claim_followup_targets_claim_local_session() {
        let _mock = crate::space_cloud_mock::enable_for_test();

        let pending = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
            registered_agent_id: "rag_mock_frontend".to_string(),
        })
        .await
        .expect("mock deliveries should poll");
        let first = pending
            .pointer("/data/items/0")
            .expect("first delivery should exist");
        let issue_id = first
            .pointer("/delivery/issueId")
            .and_then(Value::as_str)
            .expect("issue id")
            .to_string();
        let delivery_id = first
            .pointer("/delivery/id")
            .and_then(Value::as_str)
            .expect("delivery id")
            .to_string();

        let claim = space_cli_issue_claim(SpaceCliIssueClaimInput {
            issue_id: issue_id.clone(),
            delivery_id: Some(delivery_id),
            agent_id: Some("rag_mock_frontend".to_string()),
            workspace_path: None,
        })
        .await
        .expect("claim should succeed");
        let claim_id = claim
            .pointer("/claim/id")
            .and_then(Value::as_str)
            .expect("claim id")
            .to_string();
        assert_eq!(
            claim.pointer("/claim/actorType").and_then(Value::as_str),
            Some("registered_agent")
        );

        let linked = space_cli_claim_local_task(SpaceCliClaimLocalTaskInput {
            claim_id: claim_id.clone(),
            local_task_id: "task_claim".to_string(),
            local_session_id: "session_claim".to_string(),
            agent_id: Some("rag_mock_frontend".to_string()),
            workspace_path: None,
        })
        .await
        .expect("local task binding should succeed");
        assert_eq!(
            linked.get("localSessionId").and_then(Value::as_str),
            Some("session_claim")
        );

        space_cli_issue_complete(SpaceCliIssueActionInput {
            issue_id: issue_id.clone(),
            agent_id: Some("rag_mock_frontend".to_string()),
            workspace_path: None,
        })
        .await
        .expect("complete should keep handler");
        let detail = space_cli_issue_get(SpaceCliIssueGetInput {
            issue_id: issue_id.clone(),
            agent_id: Some("rag_mock_frontend".to_string()),
            workspace_path: None,
            comments_cursor: None,
            comments_limit: Some(5),
        })
        .await
        .expect("detail should load");
        assert_eq!(
            detail.pointer("/issue/state").and_then(Value::as_str),
            Some("done")
        );
        assert_eq!(
            detail
                .pointer("/claim/localSessionId")
                .and_then(Value::as_str),
            Some("session_claim")
        );

        cmd_space_api_request(SpaceApiRequestInput {
            method: "POST".to_string(),
            path: format!("/api/issues/{}/comments", issue_id),
            body: Some(serde_json::json!({ "body": "human follow-up question" })),
        })
        .await
        .expect("human comment should succeed");

        let deliveries = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
            registered_agent_id: "rag_mock_frontend".to_string(),
        })
        .await
        .expect("deliveries should poll after comment");
        let followup = deliveries
            .pointer("/data/items")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find(|item| {
                    item.pointer("/delivery/deliveryKind")
                        .and_then(Value::as_str)
                        == Some("claim_followup")
                })
            })
            .expect("claim follow-up delivery should exist");
        assert_eq!(
            followup
                .pointer("/delivery/targetSessionId")
                .and_then(Value::as_str),
            Some("session_claim")
        );
        assert_eq!(
            followup
                .pointer("/delivery/claimId")
                .and_then(Value::as_str),
            Some(claim_id.as_str())
        );
        let followup_delivery_id = followup
            .pointer("/delivery/id")
            .and_then(Value::as_str)
            .expect("follow-up delivery id")
            .to_string();

        let followup_count_before = deliveries
            .pointer("/data/items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| {
                        item.pointer("/delivery/deliveryKind")
                            .and_then(Value::as_str)
                            == Some("claim_followup")
                    })
                    .count()
            })
            .unwrap_or(0);
        space_cli_issue_comment(SpaceCliIssueCommentInput {
            issue_id: issue_id.clone(),
            body: "agent self update".to_string(),
            agent_id: Some("rag_mock_frontend".to_string()),
            workspace_path: None,
        })
        .await
        .expect("agent self comment should succeed");
        let after_self_comment = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
            registered_agent_id: "rag_mock_frontend".to_string(),
        })
        .await
        .expect("deliveries should poll after self comment");
        let followup_count_after = after_self_comment
            .pointer("/data/items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| {
                        item.pointer("/delivery/deliveryKind")
                            .and_then(Value::as_str)
                            == Some("claim_followup")
                    })
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(followup_count_after, followup_count_before);

        let processed = crate::space_cloud_mock::process_deliveries_once();
        assert!(processed.processed >= 1);
        let delivered_followup = crate::space_cloud_mock::delivery_by_id(&followup_delivery_id)
            .expect("processed follow-up delivery");
        assert_eq!(
            delivered_followup
                .pointer("/delivery/status")
                .and_then(Value::as_str),
            Some("delivered")
        );
        assert_eq!(
            delivered_followup
                .pointer("/delivery/deliveredToSessionId")
                .and_then(Value::as_str),
            Some("session_claim")
        );
    }

    #[tokio::test]
    async fn mock_space_issue_comment_routes_are_mutable_and_method_guarded() {
        let _mock = crate::space_cloud_mock::enable_for_test();
        let official = cmd_space_api_request(SpaceApiRequestInput {
            method: "GET".to_string(),
            path: "/api/spaces/official".to_string(),
            body: None,
        })
        .await
        .expect("official metadata should load");
        assert_eq!(
            official.pointer("/data/space/name").and_then(Value::as_str),
            Some("MyAgents社区")
        );
        assert!(official
            .pointer("/data/tags")
            .and_then(Value::as_array)
            .map(|items| items.len() >= 7)
            .unwrap_or(false));

        let issue_list = cmd_space_api_request(SpaceApiRequestInput {
            method: "GET".to_string(),
            path: "/api/spaces/official/issues?limit=30".to_string(),
            body: None,
        })
        .await
        .expect("issue list should load");
        assert!(issue_list
            .pointer("/data/items")
            .and_then(Value::as_array)
            .map(|items| items.len() >= 18)
            .unwrap_or(false));

        let skill_list = cmd_space_api_request(SpaceApiRequestInput {
            method: "GET".to_string(),
            path: "/api/spaces/official/skills".to_string(),
            body: None,
        })
        .await
        .expect("skill list should load");
        assert!(skill_list
            .pointer("/data/items")
            .and_then(Value::as_array)
            .map(|items| items.len() >= 10)
            .unwrap_or(false));
        assert!(cmd_space_list_local_agents().await.expect("agents").len() >= 5);

        let created_tag = cmd_space_api_request(SpaceApiRequestInput {
            method: "POST".to_string(),
            path: "/api/spaces/official/tags".to_string(),
            body: Some(serde_json::json!({ "name": "qa-contract" })),
        })
        .await
        .expect("custom tag should create");
        let custom_tag_id = created_tag
            .pointer("/data/tag/id")
            .and_then(Value::as_str)
            .expect("custom tag id")
            .to_string();

        let created_issue = cmd_space_api_request(SpaceApiRequestInput {
            method: "POST".to_string(),
            path: "/api/spaces/official/issues".to_string(),
            body: Some(serde_json::json!({
                "title": "Tag id contract",
                "body": "Created with a tag id, not a tag name.",
                "tags": [custom_tag_id]
            })),
        })
        .await
        .expect("issue should create with tag id");
        let created_issue_id = created_issue
            .pointer("/data/issue/id")
            .and_then(Value::as_str)
            .expect("created issue id")
            .to_string();
        assert_eq!(
            created_issue
                .pointer("/data/issue/tags/0/name")
                .and_then(Value::as_str),
            Some("qa-contract")
        );

        let filtered_by_tag_id = cmd_space_api_request(SpaceApiRequestInput {
            method: "GET".to_string(),
            path: format!(
                "/api/spaces/official/issues?tag={}",
                url_component(&custom_tag_id)
            ),
            body: None,
        })
        .await
        .expect("issue list should filter by tag id");
        assert!(filtered_by_tag_id
            .pointer("/data/items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .any(|item| item.get("id").and_then(Value::as_str) == Some(&created_issue_id))
            })
            .unwrap_or(false));

        let result = cmd_space_api_request(SpaceApiRequestInput {
            method: "POST".to_string(),
            path: "/api/issues/iss_mock_001/comments".to_string(),
            body: Some(serde_json::json!({ "body": "补一条来自测试的评论" })),
        })
        .await
        .expect("comment should succeed");

        assert_eq!(result.get("success").and_then(Value::as_bool), Some(true));
        assert_eq!(
            result.pointer("/data/comment/body").and_then(Value::as_str),
            Some("补一条来自测试的评论")
        );

        let detail = cmd_space_api_request(SpaceApiRequestInput {
            method: "GET".to_string(),
            path: "/api/issues/iss_mock_001?commentsLimit=5".to_string(),
            body: None,
        })
        .await
        .expect("issue detail should load");

        let comments = detail
            .pointer("/data/comments/items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(comments.len(), 1);
        assert_eq!(
            comments[0].get("body").and_then(Value::as_str),
            Some("补一条来自测试的评论")
        );

        let data = space_cli_issue_comment(SpaceCliIssueCommentInput {
            issue_id: "iss_mock_002".to_string(),
            body: "Agent 已读取并开始处理。".to_string(),
            agent_id: Some("rag_mock_frontend".to_string()),
            workspace_path: None,
        })
        .await
        .expect("cli comment should succeed");

        assert_eq!(
            data.pointer("/comment/body").and_then(Value::as_str),
            Some("Agent 已读取并开始处理。")
        );

        let status = cmd_space_api_request(SpaceApiRequestInput {
            method: "POST".to_string(),
            path: "/api/issues/iss_mock_002/status".to_string(),
            body: Some(serde_json::json!({ "status": "resolved" })),
        })
        .await
        .expect("status should update");
        assert_eq!(
            status.pointer("/data/status").and_then(Value::as_str),
            Some("resolved")
        );

        let dispatch = cmd_space_api_request(SpaceApiRequestInput {
            method: "POST".to_string(),
            path: "/api/issues/iss_mock_002/dispatch".to_string(),
            body: Some(serde_json::json!({ "registeredAgentId": "rag_mock_frontend" })),
        })
        .await
        .expect("dispatch should succeed");
        assert_eq!(
            dispatch
                .pointer("/data/dispatch/deliveryStatus")
                .and_then(Value::as_str),
            Some("pending")
        );
        let upload_dir = tempfile::tempdir().expect("upload tempdir");
        let upload_source = upload_dir.path().join("trace.log");
        fs::write(&upload_source, "mock trace").expect("write upload source");
        let uploaded = cmd_space_upload_issue_attachments(SpaceUploadIssueAttachmentsInput {
            issue_id: "iss_mock_002".to_string(),
            file_paths: vec![upload_source.to_string_lossy().to_string()],
        })
        .await
        .expect("attachment upload should succeed");
        let uploaded_id = uploaded
            .pointer("/attachments/0/id")
            .and_then(Value::as_str)
            .expect("uploaded attachment id")
            .to_string();
        let workspace = crate::workspace_files::test_support::make_test_workspace("space_mock");
        let downloaded = cmd_space_download_attachment(SpaceDownloadAttachmentInput {
            attachment_id: uploaded_id,
            workspace_path: workspace.to_string_lossy().to_string(),
            issue_id: Some("iss_mock_002".to_string()),
            file_name: None,
            registered_agent_id: None,
            output: Some("downloaded/trace.log".to_string()),
        })
        .await
        .expect("attachment download should succeed");
        assert!(workspace.join(&downloaded.relative_path).is_file());

        let skill_detail = cmd_space_api_request(SpaceApiRequestInput {
            method: "GET".to_string(),
            path: "/api/skills/skl_mock_prd_writer".to_string(),
            body: None,
        })
        .await
        .expect("skill detail should load");
        assert_eq!(
            skill_detail
                .pointer("/data/skill/name")
                .and_then(Value::as_str),
            Some("PRD Writer")
        );
        let skill_file = cmd_space_api_request(SpaceApiRequestInput {
            method: "GET".to_string(),
            path: "/api/skills/skl_mock_prd_writer/file-content?path=SKILL.md".to_string(),
            body: None,
        })
        .await
        .expect("skill file should load");
        assert!(skill_file
            .pointer("/data/text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("prd-writer"));
        let package = crate::space_cloud_mock::skill_package_bytes("skl_mock_prd_writer")
            .expect("mock package bytes");
        assert!(package.len() > 100);

        let registered = cmd_space_register_agent(SpaceRegisterAgentInput {
            display_name: "Mock Acceptance Agent".to_string(),
            workspace_id: "project_acceptance".to_string(),
            workspace_path: workspace.to_string_lossy().to_string(),
            workspace_label: Some("Acceptance Workspace".to_string()),
            goal_id: "goal_mock_ui".to_string(),
            state_filter: Some(vec!["todo".to_string()]),
            goal_md: Some("Validate Space Phase 2 mock flows.".to_string()),
            issue_subscription_run_mode: None,
        })
        .await
        .expect("agent registration should succeed");
        assert_eq!(registered.display_name, "Mock Acceptance Agent");
        assert_eq!(
            registered.issue_subscription_run_mode,
            SpaceIssueSubscriptionRunMode::SingleSession
        );

        let updated_agent = cmd_space_update_registered_agent(SpaceUpdateRegisteredAgentInput {
            id: registered.id.clone(),
            display_name: Some("Mock Acceptance Agent 2".to_string()),
            workspace_id: None,
            workspace_path: None,
            workspace_label: None,
            goal_id: None,
            state_filter: None,
            goal_md: None,
            status: Some("disabled".to_string()),
            issue_subscription_run_mode: Some(SpaceIssueSubscriptionRunMode::NewSession),
        })
        .await
        .expect("agent update should succeed");
        assert_eq!(updated_agent.display_name, "Mock Acceptance Agent 2");
        assert_eq!(updated_agent.status, "disabled");
        assert_eq!(
            updated_agent.issue_subscription_run_mode,
            SpaceIssueSubscriptionRunMode::NewSession
        );

        let revoked_agent =
            cmd_space_revoke_registered_agent(SpaceRegisteredAgentIdInput { id: registered.id })
                .await
                .expect("agent revoke should succeed");
        assert_eq!(revoked_agent.status, "revoked");

        let deleted_skill = cmd_space_api_request(SpaceApiRequestInput {
            method: "DELETE".to_string(),
            path: "/api/skills/skl_mock_issue_triage".to_string(),
            body: None,
        })
        .await
        .expect("skill delete should succeed");
        assert_eq!(
            deleted_skill
                .pointer("/data/deleted")
                .and_then(Value::as_bool),
            Some(true)
        );

        let error = cmd_space_api_request(SpaceApiRequestInput {
            method: "TRACE".to_string(),
            path: "/api/issues/iss_mock_001/comments".to_string(),
            body: Some(serde_json::json!({ "body": "nope" })),
        })
        .await
        .expect_err("TRACE must be rejected");

        assert_eq!(error, "Unsupported Space API method");
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn session_space_segment_prefers_slug_for_official_route_compatibility() {
        let session = SpaceSession {
            base_url: "https://space.myagents.test".to_string(),
            session_token: "session_test".to_string(),
            expires_at: None,
            user: Value::Null,
            space: serde_json::json!({
                "id": "space_fb63fde836254c9c90146c4f5bb142bd",
                "slug": "official",
            }),
            membership: Value::Null,
            updated_at: "2026-06-24T00:00:00.000Z".to_string(),
        };

        assert_eq!(session_space_segment(&session), "official");
    }

    #[test]
    fn public_client_id_header_is_applied_to_space_requests() {
        let capability = SpaceBuildCapability {
            available: true,
            base_url: Some("https://space.myagents.test".to_string()),
            public_client_id: Some("client_test_123".to_string()),
            reason: None,
        };
        // The request is never sent; this only constructs a request for an
        // external Space URL so the header helper can be asserted.
        #[allow(clippy::disallowed_methods)]
        let client = reqwest::Client::builder().build().expect("client");
        let request = with_public_client_id_header(
            client.get("https://space.myagents.test/api/issues/iss_1"),
            &capability,
        )
        .build()
        .expect("request");

        assert_eq!(
            request
                .headers()
                .get(SPACE_PUBLIC_CLIENT_ID_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("client_test_123")
        );
    }
}
