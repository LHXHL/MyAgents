use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::space_cloud::{
    LocalRegisteredAgent, LocalRegisteredAgentPublic, SpaceApiRequestInput,
    SpaceDownloadAttachmentResult, SpaceProcessDeliveryResult, SpaceRegisterAgentInput,
    SpaceSession, SpaceUpdateRegisteredAgentInput, SpaceUploadIssueAttachmentsInput,
    SpaceUploadSkillInput, MAX_ATTACHMENT_UPLOAD_BYTES, MAX_ATTACHMENT_UPLOAD_COUNT,
    MAX_SKILL_ZIP_BYTES,
};
use crate::workspace_files::path_safety::{
    atomic_write_file, resolve_inside_workspace, validate_workspace_root,
};

pub const MOCK_BASE_URL: &str = "https://space.mock.myagents.local";
const MOCK_SPACE_ID: &str = "space_mock_official";
const MOCK_ROOT_GOAL_ID: &str = "goal_mock_root";

#[derive(Clone)]
struct MockSkillRecord {
    skill: Value,
    files: Vec<Value>,
    file_content: HashMap<String, Value>,
}

#[derive(Clone)]
struct MockState {
    tags: Vec<Value>,
    goals: Vec<Value>,
    issues: Vec<Value>,
    comments: HashMap<String, Vec<Value>>,
    attachments: HashMap<String, Vec<Value>>,
    skills: Vec<MockSkillRecord>,
    agents: Vec<LocalRegisteredAgent>,
    dispatches: Vec<Value>,
    deliveries: Vec<Value>,
    events: Vec<Value>,
    seq: u64,
}

static MOCK_STATE: OnceLock<Mutex<MockState>> = OnceLock::new();
#[cfg(test)]
static MOCK_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(test)]
pub(crate) struct MockSpaceTestGuard {
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for MockSpaceTestGuard {
    fn drop(&mut self) {
        std::env::remove_var("MYAGENTS_SPACE_MOCK_DATA");
    }
}

#[cfg(test)]
pub(crate) fn enable_for_test() -> MockSpaceTestGuard {
    let guard = MOCK_TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("mock test lock poisoned");
    std::env::set_var("MYAGENTS_SPACE_MOCK_DATA", "true");
    reset();
    MockSpaceTestGuard { _guard: guard }
}

pub fn is_enabled() -> bool {
    if !cfg!(any(debug_assertions, test)) {
        return false;
    }
    std::env::var("MYAGENTS_SPACE_MOCK_DATA")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub fn session() -> SpaceSession {
    SpaceSession {
        base_url: MOCK_BASE_URL.to_string(),
        session_token: "mock-session-token".to_string(),
        expires_at: None,
        user: json!({
            "id": "usr_mock_owner",
            "email": "myagents.io@gmail.com",
            "name": "Ethan"
        }),
        space: mock_space(),
        membership: json!({
            "id": "mship_mock_owner",
            "role": std::env::var("MYAGENTS_SPACE_MOCK_ROLE").unwrap_or_else(|_| "owner".to_string())
        }),
        updated_at: "2026-06-24T09:00:00.000Z".to_string(),
    }
}

pub fn reset() {
    let mut state = state().lock().expect("mock state poisoned");
    *state = initial_state();
}

pub fn api_request(input: SpaceApiRequestInput) -> Result<Value, String> {
    let method = input.method.trim().to_ascii_uppercase();
    let url = parse_mock_url(&input.path)?;
    let data = handle_api_data_request(
        &method,
        url.path(),
        url.query_pairs().into_owned().collect(),
        input.body,
    )?;
    Ok(ok_envelope(data))
}

pub fn api_data_request(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let url = parse_mock_url(path)?;
    handle_api_data_request(
        &method.to_ascii_uppercase(),
        url.path(),
        url.query_pairs().into_owned().collect(),
        body,
    )
}

pub fn list_local_agents() -> Vec<LocalRegisteredAgentPublic> {
    state()
        .lock()
        .expect("mock state poisoned")
        .agents
        .clone()
        .into_iter()
        .map(Into::into)
        .collect()
}

pub fn register_agent(
    input: SpaceRegisterAgentInput,
) -> Result<LocalRegisteredAgentPublic, String> {
    let workspace_root = validate_workspace_root(&input.workspace_path)?;
    let display_name = input.display_name.trim();
    if display_name.is_empty() {
        return Err("displayName is required".to_string());
    }
    let goal_id = input.goal_id.trim();
    if goal_id.is_empty() {
        return Err("goalId is required".to_string());
    }
    let mut state = state().lock().expect("mock state poisoned");
    let goal_path_label = goal_label(&state, goal_id);
    let id = state.next_id("rag");
    let local_agent_id = format!("local-agent-{}", safe_local_name(&input.workspace_id));
    let agent = LocalRegisteredAgent {
        id: id.clone(),
        base_url: MOCK_BASE_URL.to_string(),
        space_id: MOCK_SPACE_ID.to_string(),
        client_id: Some("mock-public-client".to_string()),
        local_workspace_id: Some(input.workspace_id.clone()),
        local_agent_id: Some(local_agent_id),
        workspace_id: Some(input.workspace_id),
        display_name: display_name.to_string(),
        workspace_path: workspace_root.to_string_lossy().to_string(),
        workspace_label: input.workspace_label.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }),
        goal_id: Some(goal_id.to_string()),
        goal_path_label,
        state_filter: input
            .state_filter
            .unwrap_or_else(|| vec!["todo".to_string()]),
        goal_md: input.goal_md,
        delivery_session_id: Some(uuid::Uuid::new_v4().to_string()),
        token: format!("mock-token-{}", id),
        status: "active".to_string(),
        created_at: "2026-06-24T09:34:00.000Z".to_string(),
        updated_at: "2026-06-24T09:34:00.000Z".to_string(),
    };
    state.agents.insert(0, agent.clone());
    Ok(agent.into())
}

pub fn update_agent(
    input: SpaceUpdateRegisteredAgentInput,
) -> Result<LocalRegisteredAgentPublic, String> {
    let mut state = state().lock().expect("mock state poisoned");
    let agent = state
        .agents
        .iter_mut()
        .find(|agent| agent.id == input.id)
        .ok_or_else(|| format!("Registered Agent not found locally: {}", input.id))?;
    if let Some(display_name) = input.display_name {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err("displayName is required".to_string());
        }
        agent.display_name = display_name.to_string();
    }
    if let Some(workspace_label) = input.workspace_label {
        let workspace_label = workspace_label.trim();
        agent.workspace_label = if workspace_label.is_empty() {
            None
        } else {
            Some(workspace_label.to_string())
        };
    }
    if let Some(goal_md) = input.goal_md {
        let goal_md = goal_md.trim();
        if goal_md.is_empty() {
            return Err("goalMd is required".to_string());
        }
        agent.goal_md = Some(goal_md.to_string());
    }
    if let Some(status) = input.status {
        let status = status.trim();
        if !matches!(status, "active" | "disabled") {
            return Err("Registered Agent status must be active or disabled".to_string());
        }
        agent.status = status.to_string();
    }
    agent.updated_at = "2026-06-24T09:50:00.000Z".to_string();
    Ok(agent.clone().into())
}

pub fn revoke_agent(id: &str) -> Result<LocalRegisteredAgentPublic, String> {
    let mut state = state().lock().expect("mock state poisoned");
    let agent = state
        .agents
        .iter_mut()
        .find(|agent| agent.id == id)
        .ok_or_else(|| format!("Registered Agent not found locally: {}", id))?;
    agent.status = "revoked".to_string();
    agent.updated_at = "2026-06-24T09:51:00.000Z".to_string();
    Ok(agent.clone().into())
}

pub fn require_local_agent(id: &str) -> Result<LocalRegisteredAgent, String> {
    state()
        .lock()
        .expect("mock state poisoned")
        .agents
        .iter()
        .find(|agent| agent.id == id)
        .cloned()
        .ok_or_else(|| format!("Registered Agent not found locally: {}", id))
}

pub fn resolve_local_agent_for_cli(
    agent_id: Option<&str>,
    workspace_path: Option<&str>,
) -> Result<LocalRegisteredAgent, String> {
    let agents = state()
        .lock()
        .expect("mock state poisoned")
        .agents
        .iter()
        .filter(|agent| agent.status == "active" || agent.status == "online")
        .cloned()
        .collect::<Vec<_>>();
    if agents.is_empty() {
        return Err("No mock Registered Agent token found.".to_string());
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
    agents
        .into_iter()
        .find(|agent| {
            normalize_path_for_match(&agent.workspace_path) == normalize_path_for_match(workspace)
        })
        .ok_or_else(|| format!("No Registered Agent token matches workspace: {}", workspace))
}

pub fn poll_dispatches(registered_agent_id: &str) -> Result<Value, String> {
    let state = state().lock().expect("mock state poisoned");
    let items = state
        .dispatches
        .iter()
        .filter(|item| {
            item.pointer("/dispatch/registeredAgentId")
                .and_then(Value::as_str)
                == Some(registered_agent_id)
                && item
                    .pointer("/dispatch/deliveryStatus")
                    .and_then(Value::as_str)
                    == Some("pending")
        })
        .cloned()
        .collect::<Vec<_>>();
    Ok(ok_envelope(json!({ "items": items })))
}

pub fn mark_dispatch_delivered(
    dispatch_id: &str,
    registered_agent_id: Option<&str>,
    local_task_id: Option<String>,
    local_run_id: Option<String>,
) -> Result<Value, String> {
    let mut state = state().lock().expect("mock state poisoned");
    for item in &mut state.dispatches {
        if item.pointer("/dispatch/id").and_then(Value::as_str) == Some(dispatch_id) {
            if let Some(agent_id) = registered_agent_id {
                let dispatch_agent_id = item
                    .pointer("/dispatch/registeredAgentId")
                    .and_then(Value::as_str);
                if dispatch_agent_id != Some(agent_id) {
                    return Ok(err_envelope(format!(
                        "Dispatch {} does not belong to Registered Agent {}",
                        dispatch_id, agent_id
                    )));
                }
            }
            if let Some(dispatch) = item.get_mut("dispatch").and_then(Value::as_object_mut) {
                dispatch.insert("deliveryStatus".to_string(), json!("delivered"));
                dispatch.insert("updatedAt".to_string(), json!("2026-06-24T09:45:00.000Z"));
                dispatch.insert("localTaskId".to_string(), json!(local_task_id));
                dispatch.insert("localRunId".to_string(), json!(local_run_id));
            }
            return Ok(ok_envelope(
                json!({ "delivered": true, "deliveredAt": "2026-06-24T09:45:00.000Z" }),
            ));
        }
    }
    Ok(err_envelope(format!("Dispatch not found: {}", dispatch_id)))
}

pub fn poll_deliveries(registered_agent_id: &str) -> Result<Value, String> {
    let state = state().lock().expect("mock state poisoned");
    let items = state
        .deliveries
        .iter()
        .filter(|item| {
            item.pointer("/delivery/registeredAgentId")
                .and_then(Value::as_str)
                == Some(registered_agent_id)
                && item.pointer("/delivery/status").and_then(Value::as_str) == Some("pending")
        })
        .cloned()
        .collect::<Vec<_>>();
    Ok(ok_envelope(json!({ "items": items })))
}

pub fn mark_delivery_delivered(
    delivery_id: &str,
    registered_agent_id: Option<&str>,
    session_id: Option<String>,
) -> Result<Value, String> {
    let mut state = state().lock().expect("mock state poisoned");
    for item in &mut state.deliveries {
        if item.pointer("/delivery/id").and_then(Value::as_str) == Some(delivery_id) {
            if let Some(agent_id) = registered_agent_id {
                let delivery_agent_id = item
                    .pointer("/delivery/registeredAgentId")
                    .and_then(Value::as_str);
                if delivery_agent_id != Some(agent_id) {
                    return Ok(err_envelope(format!(
                        "Delivery {} does not belong to Registered Agent {}",
                        delivery_id, agent_id
                    )));
                }
            }
            if let Some(delivery) = item.get_mut("delivery").and_then(Value::as_object_mut) {
                delivery.insert("status".to_string(), json!("delivered"));
                delivery.insert("deliveredAt".to_string(), json!("2026-06-24T09:45:00.000Z"));
                delivery.insert("deliveredToSessionId".to_string(), json!(session_id));
                delivery.insert("updatedAt".to_string(), json!("2026-06-24T09:45:00.000Z"));
            }
            return Ok(ok_envelope(json!({
                "delivered": true,
                "deliveredAt": "2026-06-24T09:45:00.000Z"
            })));
        }
    }
    Ok(err_envelope(format!("Delivery not found: {}", delivery_id)))
}

pub fn process_deliveries_once() -> SpaceProcessDeliveryResult {
    let mut state = state().lock().expect("mock state poisoned");
    let mut processed = 0usize;
    for item in &mut state.deliveries {
        if item.pointer("/delivery/status").and_then(Value::as_str) == Some("pending") {
            if let Some(delivery) = item.get_mut("delivery").and_then(Value::as_object_mut) {
                delivery.insert("status".to_string(), json!("delivered"));
                delivery.insert("deliveredAt".to_string(), json!("2026-06-24T09:46:00.000Z"));
                delivery.insert(
                    "deliveredToSessionId".to_string(),
                    json!("mock-delivery-session"),
                );
                delivery.insert("updatedAt".to_string(), json!("2026-06-24T09:46:00.000Z"));
            }
            processed += 1;
        }
    }
    SpaceProcessDeliveryResult {
        processed,
        delivered: processed,
        errors: Vec::new(),
    }
}

pub fn upload_issue_attachments(input: SpaceUploadIssueAttachmentsInput) -> Result<Value, String> {
    if input.issue_id.trim().is_empty() {
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
    let file_paths = input
        .file_paths
        .iter()
        .map(|path| {
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
            Ok((file_path, metadata.len()))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut state = state().lock().expect("mock state poisoned");
    let issue_id = input.issue_id.trim().to_string();
    if find_issue_index(&state.issues, &issue_id).is_none() {
        return Err(format!("Issue not found: {}", input.issue_id));
    }
    let mut new_attachments = Vec::new();
    for (file_path, size) in file_paths {
        let name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(safe_local_filename)
            .unwrap_or_else(|| "attachment.txt".to_string());
        let attachment = json!({
            "id": state.next_id("att"),
            "name": name,
            "sizeBytes": size,
            "mimeType": mime_for_name(&name),
            "createdAt": "2026-06-24T09:36:00.000Z"
        });
        new_attachments.push(attachment);
    }
    state
        .attachments
        .entry(issue_id.clone())
        .or_default()
        .extend(new_attachments.clone());
    refresh_issue_counts(&mut state, &issue_id);
    Ok(json!({ "attachments": new_attachments }))
}

pub fn upload_skill(input: SpaceUploadSkillInput) -> Result<Value, String> {
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
    let mut state = state().lock().expect("mock state poisoned");
    let name = input
        .name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            file_path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("uploaded-skill")
                .replace('-', " ")
        });
    let id = input.skill_id.unwrap_or_else(|| state.next_id("skl"));
    let skill = json!({
        "id": id,
        "name": title_case(&name),
        "slug": safe_local_name(&name),
        "description": input.description.unwrap_or_else(|| "Uploaded mock Skill package for UI verification.".to_string()),
        "latestRevision": 1,
        "createdAt": "2026-06-24T09:37:00.000Z",
        "updatedAt": "2026-06-24T09:37:00.000Z"
    });
    let record = skill_record(
        skill.clone(),
        "Uploaded mock Skill package for UI verification.",
        "Use this mock package to verify upload and install flows without hitting the cloud.",
    );
    state
        .skills
        .retain(|existing| existing.skill.get("id") != skill.get("id"));
    state.skills.insert(0, record);
    Ok(json!({ "skill": skill }))
}

pub fn download_attachment(
    workspace_path: &str,
    attachment_id: &str,
    issue_id: Option<&str>,
    file_name: Option<&str>,
    output: Option<&str>,
) -> Result<SpaceDownloadAttachmentResult, String> {
    let workspace_root = validate_workspace_root(workspace_path)?;
    let state = state().lock().expect("mock state poisoned");
    let found = state
        .attachments
        .values()
        .flat_map(|items| items.iter())
        .find(|attachment| attachment.get("id").and_then(Value::as_str) == Some(attachment_id))
        .cloned()
        .ok_or_else(|| format!("Attachment not found: {}", attachment_id))?;
    let name = file_name
        .map(safe_local_filename)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            found
                .get("name")
                .and_then(Value::as_str)
                .map(safe_local_filename)
        })
        .unwrap_or_else(|| format!("attachment-{}.txt", attachment_id));
    let relative = output
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            format!(
                "myagents_files/space/issues/{}/attachments/{}/{}",
                issue_id.unwrap_or("mock-issue"),
                attachment_id,
                name
            )
        });
    let target = resolve_inside_workspace(&workspace_root, &relative)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create attachment dir: {}", e))?;
    }
    let bytes = format!(
        "Mock attachment {}\nGenerated by MyAgents Space mock data.\n",
        attachment_id
    )
    .into_bytes();
    atomic_write_file(&target, &bytes)?;
    Ok(SpaceDownloadAttachmentResult {
        name,
        relative_path: relative,
        full_path: target.to_string_lossy().to_string(),
        size_bytes: bytes.len(),
    })
}

pub fn skill_package_bytes(skill_id: &str) -> Result<Vec<u8>, String> {
    let state = state().lock().expect("mock state poisoned");
    let record = state
        .skills
        .iter()
        .find(|record| record.skill.get("id").and_then(Value::as_str) == Some(skill_id))
        .ok_or_else(|| format!("Skill not found: {}", skill_id))?;
    let mut bytes = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut bytes);
        let options = zip::write::SimpleFileOptions::default();
        for file in &record.files {
            if file.get("isDir").and_then(Value::as_bool).unwrap_or(false) {
                continue;
            }
            let path = file
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("SKILL.md");
            let content = record
                .file_content
                .get(path)
                .and_then(|value| value.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("Mock Skill file");
            zip.start_file(path, options)
                .map_err(|e| format!("Failed to write mock skill zip: {}", e))?;
            zip.write_all(content.as_bytes())
                .map_err(|e| format!("Failed to write mock skill zip: {}", e))?;
        }
        zip.finish()
            .map_err(|e| format!("Failed to finish mock skill zip: {}", e))?;
    }
    Ok(bytes.into_inner())
}

fn handle_api_data_request(
    method: &str,
    path: &str,
    query: HashMap<String, String>,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut state = state().lock().expect("mock state poisoned");
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    match (method, segments.as_slice()) {
        ("GET", ["api", "spaces", "official"]) => Ok(json!({
            "space": mock_space(),
            "membership": session().membership,
            "goals": state.goals,
            "tags": state.tags
        })),
        ("GET", ["api", "spaces", "official", "goals"]) => Ok(json!({
            "items": state.goals
        })),
        ("POST", ["api", "spaces", "official", "tags"]) => create_tag(&mut state, body),
        ("GET", ["api", "spaces", "official", "issues"]) => Ok(list_issues(&state, &query)),
        ("POST", ["api", "spaces", "official", "issues"]) => create_issue(&mut state, body),
        ("GET", ["api", "issues", issue_id]) => issue_detail(&state, issue_id, &query),
        ("POST", ["api", "issues", issue_id, "comments"]) => {
            comment_issue(&mut state, issue_id, body)
        }
        ("POST", ["api", "issues", issue_id, "status"]) => {
            set_issue_status(&mut state, issue_id, body)
        }
        ("POST", ["api", "issues", issue_id, "claim"]) => claim_issue(&mut state, issue_id, body),
        ("POST", ["api", "issues", issue_id, "complete"]) => {
            set_issue_status_value(&mut state, issue_id, "done")
        }
        ("POST", ["api", "issues", issue_id, "cancel-claim"]) => {
            set_issue_status_value(&mut state, issue_id, "todo")
        }
        ("POST", ["api", "issues", issue_id, "close"]) => {
            set_issue_status_value(&mut state, issue_id, "closed")
        }
        ("POST", ["api", "issues", _issue_id, "deliveries", _delivery_id, "ignore"]) => {
            Ok(json!({ "ignored": true, "handledAt": "2026-06-24T09:48:00.000Z" }))
        }
        ("POST", ["api", "issues", issue_id, "close-own"]) => {
            set_issue_status_value(&mut state, issue_id, "closed")
        }
        ("POST", ["api", "issues", issue_id, "dispatch"]) => {
            dispatch_issue(&mut state, issue_id, body)
        }
        ("GET", ["api", "spaces", "official", "skills"]) => Ok(json!({
            "items": state.skills.iter().map(|record| record.skill.clone()).collect::<Vec<_>>()
        })),
        ("GET", ["api", "spaces", "official", "events"]) | ("GET", ["api", "events"]) => {
            Ok(list_events(&state, &query))
        }
        ("GET", ["api", "skills", skill_id]) => skill_detail(&state, skill_id),
        ("GET", ["api", "skills", skill_id, "file-content"]) => skill_file(
            &state,
            skill_id,
            query.get("path").map(String::as_str).unwrap_or(""),
        ),
        ("DELETE", ["api", "skills", skill_id]) => delete_skill(&mut state, skill_id),
        ("GET", ["api", "registered-agents", "me", "dispatches"]) => {
            let items = state.dispatches.clone();
            Ok(json!({ "items": items }))
        }
        ("GET", ["api", "registered-agents", "me", "deliveries"]) => {
            let items = state
                .deliveries
                .iter()
                .filter(|item| {
                    item.pointer("/delivery/status").and_then(Value::as_str) == Some("pending")
                })
                .cloned()
                .collect::<Vec<_>>();
            Ok(json!({ "items": items }))
        }
        ("GET", ["api", "spaces", "official", "registered-agents"]) => {
            let items = state
                .agents
                .iter()
                .map(|agent| {
                    json!({
                        "id": agent.id,
                        "spaceId": agent.space_id,
                        "ownerUserId": "usr_mock_owner",
                        "clientId": agent.client_id.clone(),
                        "localWorkspaceId": agent.local_workspace_id.clone(),
                        "localAgentId": agent.local_agent_id.clone(),
                        "displayName": agent.display_name,
                        "workspaceLabel": agent.workspace_label.clone(),
                        "status": agent.status,
                        "createdAt": agent.created_at,
                        "updatedAt": agent.updated_at,
                        "subscriptions": agent.goal_id.as_ref().map(|goal_id| vec![json!({
                            "id": format!("sub_{}", agent.id),
                            "spaceId": agent.space_id,
                            "actorType": "registered_agent",
                            "actorId": agent.id,
                            "goalId": goal_id,
                            "includeSubtree": true,
                            "stateFilter": agent.state_filter.clone(),
                            "goalPathLabel": agent.goal_path_label.clone(),
                            "createdAt": agent.created_at
                        })]).unwrap_or_default()
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "items": items }))
        }
        ("PATCH", ["api", "registered-agents", agent_id]) => {
            update_agent_api(&mut state, agent_id, body)
        }
        ("POST", ["api", "registered-agents", agent_id, "revoke"]) => {
            let agent = state
                .agents
                .iter_mut()
                .find(|agent| agent.id == *agent_id)
                .ok_or_else(|| format!("Registered Agent not found locally: {}", agent_id))?;
            agent.status = "revoked".to_string();
            agent.updated_at = "2026-06-24T09:51:00.000Z".to_string();
            Ok(json!({ "revoked": true }))
        }
        ("POST", ["api", "dispatches", dispatch_id, "delivered"]) => {
            drop(state);
            let data = mark_dispatch_delivered(dispatch_id, None, None, None)?;
            Ok(data.get("data").cloned().unwrap_or(Value::Null))
        }
        ("POST", ["api", "deliveries", delivery_id, "delivered"]) => {
            let session_id = body
                .as_ref()
                .and_then(|value| value.get("sessionId"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            drop(state);
            let data = mark_delivery_delivered(delivery_id, None, session_id)?;
            Ok(data.get("data").cloned().unwrap_or(Value::Null))
        }
        ("POST", ["api", "deliveries", _delivery_id, "ignored"]) => {
            Ok(json!({ "ignored": true, "handledAt": "2026-06-24T09:48:00.000Z" }))
        }
        ("POST", ["api", "claims", _claim_id, "local-task"]) => {
            Ok(json!({ "updated": true, "updatedAt": "2026-06-24T09:49:00.000Z" }))
        }
        _ => Err(format!(
            "Mock Space API route not implemented: {} {}",
            method, path
        )),
    }
}

fn state() -> &'static Mutex<MockState> {
    MOCK_STATE.get_or_init(|| Mutex::new(initial_state()))
}

fn initial_state() -> MockState {
    let tags = vec![
        tag("bug", "Bug reports and regressions"),
        tag("feature", "Feature requests"),
        tag("ux", "Interaction and visual polish"),
        tag("docs", "Docs and PRD work"),
        tag("runtime", "Runtime and provider behavior"),
        tag("windows", "Windows platform validation"),
        tag("needs-agent", "Ready for a registered agent"),
    ];
    let goals = vec![
        goal(
            MOCK_ROOT_GOAL_ID,
            None,
            "MyAgents社区",
            "Root Goal for mock Space.",
        ),
        goal(
            "goal_mock_runtime",
            Some(MOCK_ROOT_GOAL_ID),
            "Runtime Delivery",
            "Runtime and provider regressions.",
        ),
        goal(
            "goal_mock_ui",
            Some(MOCK_ROOT_GOAL_ID),
            "UI Quality",
            "Interaction and visual polish.",
        ),
        goal(
            "goal_mock_docs",
            Some(MOCK_ROOT_GOAL_ID),
            "Docs Alignment",
            "Architecture and PRD documentation.",
        ),
    ];

    let issue_specs = vec![
        ("iss_mock_001", "评论发送失败时不要丢失输入内容", "open", vec!["bug", "ux"], "发送评论失败后输入框被错误清空会让处理记录丢失，需要保留草稿并给出清晰错误。"),
        ("iss_mock_002", "Space tab 切回来不应该整页重新加载", "triaged", vec!["ux"], "团队空间的数据应该稳定常驻，切 tab 只做静默 revalidate。"),
        ("iss_mock_003", "Codex Runtime 下图片附件需要统一渲染", "in_progress", vec!["runtime", "bug"], "不同 runtime 的工具附件应该进入同一附件管线，避免 UI 分支遗漏。"),
        ("iss_mock_004", "Windows WebView2 下 Skill 文件预览滚动条样式偏硬", "open", vec!["windows", "ux"], "Windows 上默认滚动条太重，需要检查 token 和 scrollbar 样式。"),
        ("iss_mock_005", "补齐 Cloud Space 架构文档中的 mock mode 说明", "resolved", vec!["docs"], "mock mode 属于 dev/test 能力，需要写清楚边界和不进入 release notes。"),
        ("iss_mock_006", "把 Issue 管理按钮改成只读概览", "closed", vec!["ux"], "没有管理动作时按钮不应该叫管理，避免用户误判。"),
        ("iss_mock_007", "插件 Bridge 失败日志需要带 request id", "declined", vec!["runtime"], "该问题和 Space 无直接关系，已转到 runtime backlog。"),
        ("iss_mock_008", "重复创建 issue 时 tag 默认保持当前选择", "duplicate", vec!["feature", "ux"], "与连续创建体验重复，合并到创建弹窗优化。"),
        ("iss_mock_009", "历史会话恢复时 Issue 口令要能被 Agent 读取", "archived", vec!["docs", "needs-agent"], "旧版 CLI 命令已保留兼容，归档记录。"),
        ("iss_mock_010", "Skill 上传成功后应该直接进入详情", "open", vec!["feature"], "上传成功后刷新列表并选择新 Skill，方便安装验证。"),
        ("iss_mock_011", "附件下载到 workspace 时目录名需要稳定", "triaged", vec!["bug"], "下载路径应包含 issue id 和 attachment id，便于 Agent 引用。"),
        ("iss_mock_012", "Registered Agent 离线时指派菜单要禁用", "open", vec!["needs-agent", "ux"], "下拉菜单可以显示 offline agent，但不能点击派发。"),
        ("iss_mock_013", "长标题在 Issue 列表里不能挤掉状态 badge 和 tag", "open", vec!["ux"], "这是一个特意很长很长的标题，用来验证列表行在窄屏和中等宽度下的截断、换行和 badge 布局是否稳定。"),
        ("iss_mock_014", "中文正文和英文 CLI 命令混排的阅读节奏", "in_progress", vec!["docs", "ux"], "详情页正文里会同时出现中文说明、`myagents issue iss_mock_014` 命令和较长段落，需要稳定行高。"),
        ("iss_mock_015", "权限不足时状态切换应为静态 badge", "resolved", vec!["bug"], "member 只能关闭自己创建的 issue，不能看到会失败的状态菜单。"),
        ("iss_mock_016", "Agent 执行完成后应回写处理记录", "open", vec!["needs-agent"], "派发后 Agent 需要通过 CLI comment/status 回写进展。"),
        ("iss_mock_017", "官方 Skill 列表空态不应该是大虚线卡片", "triaged", vec!["ux"], "列表空态也应该在底纸上，而不是浮起容器。"),
        ("iss_mock_018", "Space API 5xx 错误要展示人能看懂的摘要", "open", vec!["bug"], "toast 不应显示完整 URL 和 reqwest 原文，debug 信息进日志。"),
    ];

    let mut issues = Vec::new();
    let mut comments = HashMap::new();
    let mut attachments = HashMap::new();
    for (idx, (id, title, status, tag_names, body)) in issue_specs.into_iter().enumerate() {
        let created = format!(
            "2026-06-{:02}T{:02}:30:00.000Z",
            12 + (idx % 10),
            8 + (idx % 9)
        );
        let updated = format!(
            "2026-06-{:02}T{:02}:15:00.000Z",
            18 + (idx % 6),
            10 + (idx % 8)
        );
        let issue_tags = tags_for(&tags, &tag_names);
        let issue_comments = seeded_comments(id, idx);
        let issue_attachments = seeded_attachments(id, idx);
        issues.push(json!({
            "id": id,
            "spaceId": MOCK_SPACE_ID,
            "goalId": seeded_goal_id(idx),
            "parentIssueId": null,
            "title": title,
            "body": body,
            "state": legacy_status_to_state(status),
            "humanOnly": idx % 11 == 0,
            "status": status,
            "creator": { "id": if idx % 3 == 0 { "usr_ethan" } else { "usr_lin" }, "name": if idx % 3 == 0 { "Ethan" } else { "Lin Qiao" } },
            "author": { "id": if idx % 3 == 0 { "usr_ethan" } else { "usr_lin" }, "name": if idx % 3 == 0 { "Ethan" } else { "Lin Qiao" } },
            "notificationVersion": 1,
            "goalPathLabel": seeded_goal_label(idx),
            "tags": issue_tags,
            "commentCount": issue_comments.len(),
            "attachmentCount": issue_attachments.len(),
            "createdAt": created,
            "updatedAt": updated
        }));
        comments.insert(id.to_string(), issue_comments);
        attachments.insert(id.to_string(), issue_attachments);
    }
    let status_options = [
        "open",
        "triaged",
        "in_progress",
        "resolved",
        "closed",
        "declined",
        "duplicate",
        "archived",
    ];
    let generated_tag_sets: [&[&str]; 8] = [
        &["bug"],
        &["feature", "ux"],
        &["runtime"],
        &["docs"],
        &["windows", "bug"],
        &["needs-agent"],
        &["ux", "docs"],
        &["runtime", "needs-agent"],
    ];
    let generated_titles = [
        "Agent 派发后的处理记录需要更清晰",
        "Skill 安装到项目后应该展示目标路径",
        "Issue 筛选输入连续变更时不能阻塞",
        "附件下载失败时应保留右侧上下文",
        "Space 审计记录需要支持长资源 id 截断",
        "Registered Agent 列表要能扫读 pending 数量",
        "评论区空态和首条评论间距需要稳定",
        "多 tag issue 在窄屏下不能挤压标题",
    ];
    while issues.len() < 500 {
        let idx = issues.len();
        let offset = idx - 18;
        let id = format!("iss_mock_bulk_{:03}", offset + 1);
        let status = status_options[offset % status_options.len()];
        let title = format!(
            "{} #{}",
            generated_titles[offset % generated_titles.len()],
            offset + 1
        );
        let body = format!(
            "这是 mock mode 生成的真实感 Issue，用于验证 500 条列表、筛选、搜索、状态和 tag 的稳定性。\n\n场景编号：{}。\n命令示例：myagents issue {}",
            offset + 1,
            id
        );
        let created = format!(
            "2026-05-{:02}T{:02}:{:02}:00.000Z",
            1 + (offset % 28),
            8 + (offset % 10),
            (offset * 3) % 60
        );
        let updated = format!(
            "2026-06-{:02}T{:02}:{:02}:00.000Z",
            1 + (offset % 24),
            9 + (offset % 9),
            (offset * 7) % 60
        );
        let tag_names = generated_tag_sets[offset % generated_tag_sets.len()].to_vec();
        let issue_tags = tags_for(&tags, &tag_names);
        let issue_comments = if offset % 9 == 0 {
            vec![json!({
                "id": format!("cmt_{}_seed", id),
                "author": { "id": "usr_lin", "type": "user" },
                "body": "补充：这个 mock issue 用来验证长列表下评论计数和详情刷新。",
                "createdAt": updated.clone()
            })]
        } else {
            Vec::new()
        };
        let issue_attachments = if offset % 13 == 0 {
            vec![attachment(
                &id,
                &format!("diagnostic-{:03}.log", offset + 1),
                8_192 + offset as u64,
                "text/plain",
            )]
        } else {
            Vec::new()
        };
        issues.push(json!({
            "id": id,
            "spaceId": MOCK_SPACE_ID,
            "goalId": seeded_goal_id(idx),
            "parentIssueId": null,
            "title": title,
            "body": body,
            "state": legacy_status_to_state(status),
            "humanOnly": offset % 17 == 0,
            "status": status,
            "creator": {
                "id": if offset % 2 == 0 { "usr_ethan" } else { "usr_lin" },
                "name": if offset % 2 == 0 { "Ethan" } else { "Lin Qiao" }
            },
            "author": {
                "id": if offset % 2 == 0 { "usr_ethan" } else { "usr_lin" },
                "name": if offset % 2 == 0 { "Ethan" } else { "Lin Qiao" }
            },
            "notificationVersion": 1,
            "goalPathLabel": seeded_goal_label(idx),
            "tags": issue_tags,
            "commentCount": issue_comments.len(),
            "attachmentCount": issue_attachments.len(),
            "createdAt": created,
            "updatedAt": updated
        }));
        comments.insert(id.clone(), issue_comments);
        attachments.insert(id, issue_attachments);
    }

    let mut skills = vec![
        skill_record(
            skill(
                "skl_mock_issue_triage",
                "Issue Triage Operator",
                "issue-triage",
                "Read Space issues, classify them, and prepare an action digest.",
                7,
            ),
            "Automates Space issue triage for maintainers.",
            "Use for scheduled issue review and digest generation.",
        ),
        skill_record(
            skill(
                "skl_mock_prd_writer",
                "PRD Writer",
                "prd-writer",
                "Turns converged product discussions into implementation-ready PRDs.",
                4,
            ),
            "Preserves user intent and technical ground truth.",
            "Use when a discussion needs to become a durable spec.",
        ),
        skill_record(
            skill(
                "skl_mock_frontend_taste",
                "Frontend Taste Review",
                "frontend-taste-review",
                "Reviews React UI for MyAgents design-system consistency.",
                3,
            ),
            "Checks spacing, token use, and fake controls.",
            "Use before shipping user-facing UI changes.",
        ),
        skill_record(
            skill(
                "skl_mock_release_helper",
                "Release Helper",
                "release-helper",
                "Prepares changelog, tags, and release notes for accepted builds.",
                5,
            ),
            "Coordinates release handoff.",
            "Use after acceptance.",
        ),
        skill_record(
            skill(
                "skl_mock_pdf_toolkit",
                "PDF Toolkit",
                "pdf-toolkit",
                "Extracts, renders, and validates PDF artifacts.",
                2,
            ),
            "PDF processing helper.",
            "Use for PDF workflows.",
        ),
        skill_record(
            skill(
                "skl_mock_xlsx_toolkit",
                "Spreadsheet Toolkit",
                "spreadsheet-toolkit",
                "Analyzes workbook data and creates polished spreadsheets.",
                6,
            ),
            "Spreadsheet workflow helper.",
            "Use for XLSX/CSV work.",
        ),
        skill_record(
            skill(
                "skl_mock_docx_editor",
                "Document Editor",
                "document-editor",
                "Edits professional DOCX documents with render verification.",
                2,
            ),
            "Document editing helper.",
            "Use for DOCX tasks.",
        ),
        skill_record(
            skill(
                "skl_mock_browser_automation",
                "Browser Automation",
                "browser-automation",
                "Drives local browser checks and screenshots.",
                8,
            ),
            "Browser QA helper.",
            "Use for UI smoke tests.",
        ),
        skill_record(
            skill(
                "skl_mock_runtime_probe",
                "Runtime Probe",
                "runtime-probe",
                "Investigates Codex, Claude Code, and Gemini runtime behavior.",
                3,
            ),
            "Runtime debugging helper.",
            "Use for runtime regressions.",
        ),
        skill_record(
            skill(
                "skl_mock_windows_sweep",
                "Windows Compatibility Sweep",
                "windows-compatibility-sweep",
                "Checks Windows paths, WebView, and process behavior.",
                4,
            ),
            "Windows validation helper.",
            "Use before Windows release checks.",
        ),
    ];

    while skills.len() < 50 {
        let idx = skills.len();
        let id = format!("skl_mock_generated_{:02}", idx + 1);
        let name = format!("Generated Space Skill {:02}", idx + 1);
        let slug = format!("generated-space-skill-{:02}", idx + 1);
        skills.push(skill_record(
            skill(
                &id,
                &name,
                &slug,
                "Generated mock skill for testing dense Skill lists, file preview, install actions, and revision metadata.",
                1 + (idx % 9) as u32,
            ),
            "Generated skill overview used by mock mode to validate dense lists and detail previews.",
            "This generated skill exists only in mock mode and exercises realistic metadata.",
        ));
    }

    let mut agents = vec![
        agent(
            "rag_mock_frontend",
            "Frontend Polisher",
            "active",
            "/Users/ethan/Projects/MyAgents",
            "MyAgents",
            "Handle UI polish, screenshots, and design-system regressions.",
        ),
        agent(
            "rag_mock_release",
            "Release Steward",
            "online",
            "/Users/ethan/Projects/MyAgents",
            "MyAgents Release",
            "Prepare release tasks and verify changelog completeness.",
        ),
        agent(
            "rag_mock_windows",
            "Windows QA Runner",
            "offline",
            "C:/Users/Ethan/Projects/MyAgents",
            "Windows VM",
            "Run Windows smoke checks when the VM is online.",
        ),
        agent(
            "rag_mock_docs",
            "Docs Curator",
            "active",
            "/Users/ethan/Docs/MyAgents",
            "Docs Workspace",
            "Keep PRDs, architecture docs, and guides aligned.",
        ),
        agent(
            "rag_mock_runtime",
            "Runtime Sentinel",
            "error",
            "/Users/ethan/RuntimeLab",
            "Runtime Lab",
            "Investigate multi-runtime failures and provider quirks.",
        ),
    ];
    let generated_agent_statuses = ["active", "disabled", "offline", "error", "active"];
    while agents.len() < 50 {
        let idx = agents.len();
        let status = generated_agent_statuses[idx % generated_agent_statuses.len()];
        let workspace_label = format!("Workspace {}", idx + 1);
        agents.push(agent(
            &format!("rag_mock_generated_{:02}", idx + 1),
            &format!("Generated Agent {:02}", idx + 1),
            status,
            &format!("/Users/ethan/MockWorkspaces/workspace-{:02}", idx + 1),
            &workspace_label,
            "Pick up assigned mock issues, read context first, and report next actions.",
        ));
    }

    let dispatches = vec![dispatch_item(
        "dsp_mock_001",
        &agents[0],
        &issues[2],
        "pending",
    )];
    let deliveries = vec![delivery_item(
        "del_mock_001",
        &agents[0],
        &issues[0],
        "pending",
    )];
    let events = vec![
        mock_event(
            "evt_mock_001",
            "issue.created",
            "issue",
            "iss_mock_001",
            "2026-06-24T09:30:00.000Z",
        ),
        mock_event(
            "evt_mock_002",
            "comment.created",
            "issue",
            "iss_mock_002",
            "2026-06-24T09:35:00.000Z",
        ),
        mock_event(
            "evt_mock_003",
            "skill.updated",
            "skill",
            "skl_mock_prd_writer",
            "2026-06-24T09:40:00.000Z",
        ),
        mock_event(
            "evt_mock_004",
            "dispatch.created",
            "dispatch",
            "dsp_mock_001",
            "2026-06-24T09:45:00.000Z",
        ),
    ];

    MockState {
        tags,
        goals,
        issues,
        comments,
        attachments,
        skills,
        agents,
        dispatches,
        deliveries,
        events,
        seq: 100,
    }
}

impl MockState {
    fn next_id(&mut self, prefix: &str) -> String {
        self.seq += 1;
        format!("{}_mock_{:03}", prefix, self.seq)
    }
}

fn list_issues(state: &MockState, query: &HashMap<String, String>) -> Value {
    let q = query
        .get("q")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let tag = query
        .get("tag")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let status = query
        .get("state")
        .or_else(|| query.get("status"))
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let goal_id = query
        .get("goalId")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let human_only = query
        .get("humanOnly")
        .map(|value| value.trim().to_ascii_lowercase());
    let cursor = query
        .get("cursor")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(30)
        .clamp(1, 100);
    let mut items = state
        .issues
        .iter()
        .filter(|issue| {
            let title = issue
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let body = issue
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let issue_status = issue
                .get("state")
                .or_else(|| issue.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let issue_goal_id = issue.get("goalId").and_then(Value::as_str).unwrap_or("");
            let issue_human_only = issue
                .get("humanOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let tags = issue
                .get("tags")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let matches_q = q
                .as_ref()
                .map(|q| title.contains(q) || body.contains(q))
                .unwrap_or(true);
            let matches_tag = tag
                .as_ref()
                .map(|tag| {
                    tags.iter().any(|item| {
                        let id_matches = item
                            .get("id")
                            .and_then(Value::as_str)
                            .map(|id| id.eq_ignore_ascii_case(tag))
                            .unwrap_or(false);
                        let name_matches = item
                            .get("name")
                            .and_then(Value::as_str)
                            .map(|name| name.eq_ignore_ascii_case(tag))
                            .unwrap_or(false);
                        id_matches || name_matches
                    })
                })
                .unwrap_or(true);
            let matches_status = status
                .as_ref()
                .map(|status| {
                    status == "all" || status.split(',').any(|item| item.trim() == issue_status)
                })
                .unwrap_or(true);
            let matches_goal = goal_id
                .as_ref()
                .map(|goal_id| {
                    if goal_id == "inbox" || goal_id == "null" {
                        issue_goal_id.is_empty()
                    } else {
                        issue_goal_id == goal_id
                    }
                })
                .unwrap_or(true);
            let matches_human_only = human_only
                .as_ref()
                .map(|value| match value.as_str() {
                    "true" => issue_human_only,
                    "false" => !issue_human_only,
                    _ => true,
                })
                .unwrap_or(true);
            matches_q && matches_tag && matches_status && matches_goal && matches_human_only
        })
        .cloned()
        .collect::<Vec<_>>();
    items.sort_by(|a, b| {
        b.get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(a.get("updatedAt").and_then(Value::as_str).unwrap_or(""))
    });
    let total = items.len();
    let page = items
        .into_iter()
        .skip(cursor)
        .take(limit)
        .collect::<Vec<_>>();
    let next = cursor + page.len();
    json!({
        "items": page,
        "hasMore": next < total,
        "nextCursor": if next < total { Some(next.to_string()) } else { None }
    })
}

fn create_issue(state: &mut MockState, body: Option<Value>) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if title.is_empty() {
        return Err("Issue title is required".to_string());
    }
    let body_text = body
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let tag_identities = body
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let goal_id = body
        .get("goalId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(MOCK_ROOT_GOAL_ID);
    let goal_path_label = goal_label(state, goal_id);
    let id = state.next_id("iss");
    let issue = json!({
        "id": id,
        "spaceId": MOCK_SPACE_ID,
        "goalId": goal_id,
        "parentIssueId": body.get("parentIssueId").and_then(Value::as_str),
        "title": title,
        "body": body_text,
        "state": "open",
        "humanOnly": body.get("humanOnly").and_then(Value::as_bool).unwrap_or(false),
        "status": "open",
        "creator": { "id": "usr_mock_owner", "name": "Ethan" },
        "author": { "id": "usr_mock_owner", "name": "Ethan" },
        "notificationVersion": 1,
        "goalPathLabel": goal_path_label,
        "tags": tags_for(&state.tags, &tag_identities),
        "commentCount": 0,
        "attachmentCount": 0,
        "createdAt": "2026-06-24T09:38:00.000Z",
        "updatedAt": "2026-06-24T09:38:00.000Z"
    });
    state.comments.insert(id.clone(), Vec::new());
    state.attachments.insert(id, Vec::new());
    state.issues.insert(0, issue.clone());
    Ok(json!({ "issue": issue }))
}

fn list_events(state: &MockState, query: &HashMap<String, String>) -> Value {
    let cursor = query.get("cursor").map(String::as_str);
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(50)
        .min(100);
    let filtered = state
        .events
        .iter()
        .filter(|event| event_after_cursor(event, cursor))
        .take(limit + 1)
        .cloned()
        .collect::<Vec<_>>();
    let items = filtered.iter().take(limit).cloned().collect::<Vec<_>>();
    let next_cursor = items
        .last()
        .and_then(encode_event_cursor)
        .map(Value::String)
        .unwrap_or(Value::Null);
    json!({
        "items": items,
        "hasMore": filtered.len() > limit,
        "nextCursor": next_cursor
    })
}

fn event_after_cursor(event: &Value, cursor: Option<&str>) -> bool {
    let Some(cursor) = cursor.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let (cursor_created_at, cursor_id) = cursor
        .rsplit_once('|')
        .filter(|(created_at, event_id)| !created_at.is_empty() && !event_id.is_empty())
        .map(|(created_at, event_id)| (created_at, Some(event_id)))
        .unwrap_or((cursor, None));
    let Some(created_at) = event.get("createdAt").and_then(Value::as_str) else {
        return false;
    };
    if created_at > cursor_created_at {
        return true;
    }
    if created_at < cursor_created_at {
        return false;
    }
    match cursor_id {
        Some(cursor_id) => event
            .get("id")
            .and_then(Value::as_str)
            .map(|event_id| event_id > cursor_id)
            .unwrap_or(false),
        None => false,
    }
}

fn encode_event_cursor(event: &Value) -> Option<String> {
    Some(format!(
        "{}|{}",
        event.get("createdAt")?.as_str()?,
        event.get("id")?.as_str()?
    ))
}

fn create_tag(state: &mut MockState, body: Option<Value>) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return Err("Tag name is required".to_string());
    }
    let tag = json!({
        "id": state.next_id("tag"),
        "spaceId": MOCK_SPACE_ID,
        "name": name,
        "color": body.get("color").cloned().unwrap_or(Value::Null),
        "description": body.get("description").cloned().unwrap_or(Value::Null),
        "createdAt": "2026-06-24T09:37:00.000Z",
        "updatedAt": "2026-06-24T09:37:00.000Z"
    });
    state.tags.push(tag.clone());
    state.tags.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(json!({ "tag": tag }))
}

fn issue_detail(
    state: &MockState,
    issue_id: &str,
    query: &HashMap<String, String>,
) -> Result<Value, String> {
    let issue = state
        .issues
        .iter()
        .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
        .cloned()
        .ok_or_else(|| format!("Issue not found: {}", issue_id))?;
    let limit = query
        .get("commentsLimit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(5)
        .clamp(1, 20);
    let cursor = query
        .get("commentsCursor")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let all_comments = state.comments.get(issue_id).cloned().unwrap_or_default();
    let goal_reference = issue
        .get("goalId")
        .and_then(Value::as_str)
        .and_then(|goal_id| {
            state.goals.iter().find_map(|goal| {
                if goal.get("id").and_then(Value::as_str) != Some(goal_id) {
                    return None;
                }
                Some(json!({
                    "goalId": goal_id,
                    "goalPath": goal.get("path").cloned().unwrap_or(Value::Null),
                    "goalPathLabel": goal.get("goalPathLabel").cloned().unwrap_or(Value::Null),
                    "goalTitle": goal.get("title").cloned().unwrap_or(Value::Null),
                    "goalContext": goal.get("context").cloned().unwrap_or(Value::Null),
                }))
            })
        });
    let page = all_comments
        .iter()
        .skip(cursor)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    let next = cursor + page.len();
    Ok(json!({
        "issue": issue,
        "goalReference": goal_reference,
        "comments": {
            "items": page,
            "hasMore": next < all_comments.len(),
            "nextCursor": if next < all_comments.len() { Some(next.to_string()) } else { None },
            "limit": limit
        },
        "attachments": state.attachments.get(issue_id).cloned().unwrap_or_default(),
        "claim": null
    }))
}

fn comment_issue(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    if find_issue_index(&state.issues, issue_id).is_none() {
        return Err(format!("Issue not found: {}", issue_id));
    }
    let text = body
        .as_ref()
        .and_then(|value| value.get("body"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if text.is_empty() {
        return Err("Comment body is required".to_string());
    }
    let comment = json!({
        "id": state.next_id("cmt"),
        "author": { "id": "usr_mock_owner", "type": "user" },
        "body": text,
        "createdAt": "2026-06-24T09:39:00.000Z"
    });
    state
        .comments
        .entry(issue_id.to_string())
        .or_default()
        .push(comment.clone());
    refresh_issue_counts(state, issue_id);
    Ok(json!({ "comment": comment }))
}

fn set_issue_status(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let status = body
        .as_ref()
        .and_then(|value| value.get("state").or_else(|| value.get("status")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "state is required".to_string())?;
    set_issue_status_value(state, issue_id, status)
}

fn set_issue_status_value(
    state: &mut MockState,
    issue_id: &str,
    status: &str,
) -> Result<Value, String> {
    let Some(index) = find_issue_index(&state.issues, issue_id) else {
        return Err(format!("Issue not found: {}", issue_id));
    };
    if let Some(issue) = state.issues[index].as_object_mut() {
        issue.insert("status".to_string(), json!(status));
        issue.insert("state".to_string(), json!(status));
        issue.insert("updatedAt".to_string(), json!("2026-06-24T09:40:00.000Z"));
    }
    Ok(json!({ "state": status, "status": status, "updatedAt": "2026-06-24T09:40:00.000Z" }))
}

fn claim_issue(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let _ = body;
    let claim_id = state.next_id("claim");
    let _ = set_issue_status_value(state, issue_id, "doing")?;
    Ok(json!({
        "claim": {
            "id": claim_id,
            "issueId": issue_id,
            "status": "active",
            "localTaskId": null,
            "localSessionId": null,
            "claimedAt": "2026-06-24T09:47:00.000Z",
            "updatedAt": "2026-06-24T09:47:00.000Z"
        }
    }))
}

fn dispatch_issue(
    state: &mut MockState,
    issue_id: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let registered_agent_id = body
        .as_ref()
        .and_then(|value| value.get("registeredAgentId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "registeredAgentId is required".to_string())?;
    let agent = state
        .agents
        .iter()
        .find(|agent| agent.id == registered_agent_id)
        .cloned()
        .ok_or_else(|| format!("Registered Agent not found: {}", registered_agent_id))?;
    let issue = state
        .issues
        .iter()
        .find(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
        .cloned()
        .ok_or_else(|| format!("Issue not found: {}", issue_id))?;
    let dispatch_id = state.next_id("dsp");
    let dispatch = dispatch_item(&dispatch_id, &agent, &issue, "pending");
    state.dispatches.insert(0, dispatch.clone());
    let _ = set_issue_status_value(state, issue_id, "in_progress")?;
    let system_comment = json!({
        "id": state.next_id("cmt"),
        "author": { "id": "system", "type": "system" },
        "body": format!("已指派给 Registered Agent：{}", agent.display_name),
        "createdAt": "2026-06-24T09:41:00.000Z"
    });
    state
        .comments
        .entry(issue_id.to_string())
        .or_default()
        .push(system_comment);
    refresh_issue_counts(state, issue_id);
    Ok(json!({
        "dispatch": dispatch.get("dispatch").cloned().unwrap_or(Value::Null)
    }))
}

fn skill_detail(state: &MockState, skill_id: &str) -> Result<Value, String> {
    let record = state
        .skills
        .iter()
        .find(|record| record.skill.get("id").and_then(Value::as_str) == Some(skill_id))
        .ok_or_else(|| format!("Skill not found: {}", skill_id))?;
    Ok(json!({
        "skill": record.skill,
        "revision": { "revision": record.skill.get("latestRevision").cloned().unwrap_or(json!(1)) },
        "files": record.files
    }))
}

fn skill_file(state: &MockState, skill_id: &str, path: &str) -> Result<Value, String> {
    let record = state
        .skills
        .iter()
        .find(|record| record.skill.get("id").and_then(Value::as_str) == Some(skill_id))
        .ok_or_else(|| format!("Skill not found: {}", skill_id))?;
    record
        .file_content
        .get(path)
        .cloned()
        .ok_or_else(|| format!("Skill file not found: {}", path))
}

fn delete_skill(state: &mut MockState, skill_id: &str) -> Result<Value, String> {
    let before = state.skills.len();
    state
        .skills
        .retain(|record| record.skill.get("id").and_then(Value::as_str) != Some(skill_id));
    if state.skills.len() == before {
        return Err(format!("Skill not found: {}", skill_id));
    }
    Ok(json!({ "deleted": true }))
}

fn update_agent_api(
    state: &mut MockState,
    agent_id: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let body = body.unwrap_or(Value::Null);
    let agent = state
        .agents
        .iter_mut()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| format!("Registered Agent not found locally: {}", agent_id))?;
    if let Some(display_name) = body.get("displayName").and_then(Value::as_str) {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err("displayName is required".to_string());
        }
        agent.display_name = display_name.to_string();
    }
    if body.get("workspaceLabel").is_some() {
        agent.workspace_label = body
            .get("workspaceLabel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
    }
    if let Some(goal_md) = body.get("goalMd").and_then(Value::as_str) {
        let goal_md = goal_md.trim();
        if goal_md.is_empty() {
            return Err("goalMd is required".to_string());
        }
        agent.goal_md = Some(goal_md.to_string());
    }
    if let Some(status) = body.get("status").and_then(Value::as_str) {
        if !matches!(status, "active" | "disabled" | "revoked") {
            return Err("Registered Agent status is invalid".to_string());
        }
        agent.status = status.to_string();
    }
    agent.updated_at = "2026-06-24T09:50:00.000Z".to_string();
    Ok(json!({ "updated": true }))
}

fn refresh_issue_counts(state: &mut MockState, issue_id: &str) {
    let comment_count = state.comments.get(issue_id).map(Vec::len).unwrap_or(0);
    let attachment_count = state.attachments.get(issue_id).map(Vec::len).unwrap_or(0);
    if let Some(index) = find_issue_index(&state.issues, issue_id) {
        if let Some(issue) = state.issues[index].as_object_mut() {
            issue.insert("commentCount".to_string(), json!(comment_count));
            issue.insert("attachmentCount".to_string(), json!(attachment_count));
            issue.insert("updatedAt".to_string(), json!("2026-06-24T09:42:00.000Z"));
        }
    }
}

fn find_issue_index(issues: &[Value], issue_id: &str) -> Option<usize> {
    issues
        .iter()
        .position(|issue| issue.get("id").and_then(Value::as_str) == Some(issue_id))
}

fn tag(name: &str, description: &str) -> Value {
    json!({
        "id": format!("tag_{}", name.replace('-', "_")),
        "name": name,
        "color": null,
        "description": description
    })
}

fn goal(id: &str, parent_goal_id: Option<&str>, title: &str, context: &str) -> Value {
    let path = match parent_goal_id {
        Some(parent) => format!("/{}/{}/", parent, id),
        None => format!("/{}/", id),
    };
    json!({
        "id": id,
        "spaceId": MOCK_SPACE_ID,
        "parentGoalId": parent_goal_id,
        "path": path,
        "depth": if parent_goal_id.is_some() { 1 } else { 0 },
        "title": title,
        "context": context,
        "archivedAt": null,
        "createdAt": "2026-06-20T08:00:00.000Z",
        "updatedAt": "2026-06-24T08:00:00.000Z",
        "goalPathLabel": if parent_goal_id.is_some() { format!("MyAgents社区 / {}", title) } else { title.to_string() }
    })
}

fn seeded_goal_id(index: usize) -> &'static str {
    match index % 4 {
        1 => "goal_mock_runtime",
        2 => "goal_mock_ui",
        3 => "goal_mock_docs",
        _ => MOCK_ROOT_GOAL_ID,
    }
}

fn seeded_goal_label(index: usize) -> &'static str {
    match seeded_goal_id(index) {
        "goal_mock_runtime" => "MyAgents社区 / Runtime Delivery",
        "goal_mock_ui" => "MyAgents社区 / UI Quality",
        "goal_mock_docs" => "MyAgents社区 / Docs Alignment",
        _ => "MyAgents社区",
    }
}

fn legacy_status_to_state(status: &str) -> &'static str {
    match status {
        "triaged" => "todo",
        "in_progress" => "doing",
        "resolved" => "done",
        "declined" | "duplicate" | "archived" | "closed" => "closed",
        _ => "open",
    }
}

fn goal_label(state: &MockState, goal_id: &str) -> Option<String> {
    state
        .goals
        .iter()
        .find(|goal| goal.get("id").and_then(Value::as_str) == Some(goal_id))
        .and_then(|goal| goal.get("goalPathLabel").and_then(Value::as_str))
        .map(ToString::to_string)
}

fn tags_for(tags: &[Value], identities: &[&str]) -> Vec<Value> {
    identities
        .iter()
        .filter_map(|identity| {
            tags.iter()
                .find(|tag| {
                    let id_matches = tag
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|value| value == *identity)
                        .unwrap_or(false);
                    let name_matches = tag
                        .get("name")
                        .and_then(Value::as_str)
                        .map(|value| value == *identity)
                        .unwrap_or(false);
                    id_matches || name_matches
                })
                .cloned()
        })
        .collect()
}

fn seeded_comments(issue_id: &str, idx: usize) -> Vec<Value> {
    if idx % 5 == 0 {
        return Vec::new();
    }
    let mut comments = vec![
        json!({
            "id": format!("cmt_{}_001", issue_id),
            "author": { "id": "usr_maya", "type": "user" },
            "body": "我复现了一次，先记录环境和当前判断，后面再让 Agent 接手验证。",
            "createdAt": "2026-06-23T10:08:00.000Z"
        }),
        json!({
            "id": format!("cmt_{}_002", issue_id),
            "author": { "id": "rag_mock_frontend", "type": "registered_agent" },
            "body": "已读取 issue 上下文。建议先确认预期交互，再做最小复现和回归测试。",
            "createdAt": "2026-06-23T11:18:00.000Z"
        }),
    ];
    if idx % 3 == 0 {
        comments.push(json!({
            "id": format!("cmt_{}_003", issue_id),
            "author": { "id": "system", "type": "system" },
            "body": "系统记录：状态已更新，等待下一轮处理。",
            "createdAt": "2026-06-23T12:30:00.000Z"
        }));
    }
    comments
}

fn seeded_attachments(issue_id: &str, idx: usize) -> Vec<Value> {
    match idx % 6 {
        1 => vec![attachment(
            issue_id,
            "screenshot-space-list.png",
            184_320,
            "image/png",
        )],
        2 => vec![
            attachment(issue_id, "runtime-trace.log", 41_984, "text/plain"),
            attachment(issue_id, "agent-output.md", 12_288, "text/markdown"),
        ],
        3 => vec![attachment(
            issue_id,
            "windows-webview-report.zip",
            3_467_264,
            "application/zip",
        )],
        _ => Vec::new(),
    }
}

fn attachment(issue_id: &str, name: &str, size: u64, mime: &str) -> Value {
    json!({
        "id": format!("att_{}_{}", issue_id, safe_local_name(name)),
        "name": name,
        "sizeBytes": size,
        "mimeType": mime,
        "createdAt": "2026-06-23T09:50:00.000Z"
    })
}

fn skill(id: &str, name: &str, slug: &str, description: &str, revision: u32) -> Value {
    json!({
        "id": id,
        "name": name,
        "slug": slug,
        "description": description,
        "latestRevision": revision,
        "createdAt": "2026-06-10T08:00:00.000Z",
        "updatedAt": format!("2026-06-{:02}T12:00:00.000Z", 12 + (revision % 10))
    })
}

fn skill_record(skill: Value, overview: &str, readme: &str) -> MockSkillRecord {
    let id = skill
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("skl_mock");
    let slug = skill
        .get("slug")
        .and_then(Value::as_str)
        .unwrap_or("mock-skill");
    let files = vec![
        file(id, "SKILL.md", "SKILL.md", "", false, 1200, "text/markdown"),
        file(
            id,
            "README.md",
            "README.md",
            "",
            false,
            860,
            "text/markdown",
        ),
        file(id, "scripts", "scripts", "", true, 0, "inode/directory"),
        file(
            id,
            "scripts/verify.ts",
            "verify.ts",
            "scripts",
            false,
            1340,
            "text/typescript",
        ),
        file(id, "assets", "assets", "", true, 0, "inode/directory"),
        file(
            id,
            "assets/sample-output.png",
            "sample-output.png",
            "assets",
            false,
            48200,
            "image/png",
        ),
    ];
    let mut file_content = HashMap::new();
    file_content.insert(
        "SKILL.md".to_string(),
        json!({
            "text": format!("---\nname: {}\ndescription: {}\n---\n\n# {}\n\n{}\n", slug, overview, skill.get("name").and_then(Value::as_str).unwrap_or("Mock Skill"), overview),
            "binary": false,
            "mimeType": "text/markdown",
            "sizeBytes": 1200
        }),
    );
    file_content.insert(
        "README.md".to_string(),
        json!({
            "text": format!("# {}\n\n{}\n", skill.get("name").and_then(Value::as_str).unwrap_or("Mock Skill"), readme),
            "binary": false,
            "mimeType": "text/markdown",
            "sizeBytes": 860
        }),
    );
    file_content.insert(
        "scripts/verify.ts".to_string(),
        json!({
            "text": "export function verify() {\n  return 'mock skill verification passed';\n}\n",
            "binary": false,
            "mimeType": "text/typescript",
            "sizeBytes": 1340
        }),
    );
    file_content.insert(
        "assets/sample-output.png".to_string(),
        json!({
            "binary": true,
            "mimeType": "image/png",
            "sizeBytes": 48200
        }),
    );
    MockSkillRecord {
        skill,
        files,
        file_content,
    }
}

fn file(
    skill_id: &str,
    id_suffix: &str,
    name: &str,
    parent: &str,
    is_dir: bool,
    size: u64,
    mime: &str,
) -> Value {
    json!({
        "id": format!("file_{}_{}", skill_id, safe_local_name(id_suffix)),
        "path": id_suffix,
        "name": name,
        "parentPath": parent,
        "isDir": is_dir,
        "sizeBytes": size,
        "mimeType": mime,
        "createdAt": "2026-06-10T08:00:00.000Z"
    })
}

fn agent(
    id: &str,
    display_name: &str,
    status: &str,
    workspace_path: &str,
    workspace_label: &str,
    goal_md: &str,
) -> LocalRegisteredAgent {
    let goal_id = match id {
        "rag_mock_runtime" => "goal_mock_runtime",
        "rag_mock_docs" => "goal_mock_docs",
        _ => "goal_mock_ui",
    };
    LocalRegisteredAgent {
        id: id.to_string(),
        base_url: MOCK_BASE_URL.to_string(),
        space_id: MOCK_SPACE_ID.to_string(),
        client_id: Some("mock-public-client".to_string()),
        local_workspace_id: Some(format!("project_{}", safe_local_name(workspace_label))),
        local_agent_id: Some(format!(
            "local-agent-project_{}",
            safe_local_name(workspace_label)
        )),
        workspace_id: Some(format!("project_{}", safe_local_name(workspace_label))),
        display_name: display_name.to_string(),
        workspace_path: workspace_path.to_string(),
        workspace_label: Some(workspace_label.to_string()),
        goal_id: Some(goal_id.to_string()),
        goal_path_label: Some(
            match goal_id {
                "goal_mock_runtime" => "MyAgents社区 / Runtime Delivery",
                "goal_mock_docs" => "MyAgents社区 / Docs Alignment",
                _ => "MyAgents社区 / UI Quality",
            }
            .to_string(),
        ),
        state_filter: vec!["todo".to_string()],
        goal_md: Some(goal_md.to_string()),
        delivery_session_id: Some(uuid::Uuid::new_v4().to_string()),
        token: format!("mock-token-{}", id),
        status: status.to_string(),
        created_at: "2026-06-14T08:00:00.000Z".to_string(),
        updated_at: "2026-06-24T08:45:00.000Z".to_string(),
    }
}

fn dispatch_item(id: &str, agent: &LocalRegisteredAgent, issue: &Value, status: &str) -> Value {
    let issue_id = issue
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("iss_mock_001");
    let title = issue
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Mock Issue");
    let issue_status = issue
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("open");
    let updated_at = issue
        .get("updatedAt")
        .and_then(Value::as_str)
        .unwrap_or("2026-06-24T08:00:00.000Z");
    json!({
        "dispatch": {
            "id": id,
            "spaceId": MOCK_SPACE_ID,
            "issueId": issue_id,
            "registeredAgentId": agent.id,
            "deliveryStatus": status,
            "goalSnapshotMd": format!("请读取 Space Issue {}，理解上下文后与用户讨论下一步。", issue_id),
            "createdAt": "2026-06-24T08:50:00.000Z",
            "updatedAt": "2026-06-24T08:50:00.000Z"
        },
        "registeredAgent": {
            "id": agent.id,
            "displayName": agent.display_name,
            "goalMd": agent.goal_md.clone().unwrap_or_default()
        },
        "issueMeta": {
            "id": issue_id,
            "title": title,
            "status": issue_status,
            "updatedAt": updated_at
        }
    })
}

fn delivery_item(id: &str, agent: &LocalRegisteredAgent, issue: &Value, status: &str) -> Value {
    let issue_id = issue
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("iss_mock_001");
    let title = issue
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Mock Issue");
    let issue_state = issue
        .get("state")
        .and_then(Value::as_str)
        .or_else(|| issue.get("status").and_then(Value::as_str))
        .unwrap_or("todo");
    let updated_at = issue
        .get("updatedAt")
        .and_then(Value::as_str)
        .unwrap_or("2026-06-24T08:00:00.000Z");
    let goal_id = issue
        .get("goalId")
        .and_then(Value::as_str)
        .or(agent.goal_id.as_deref())
        .unwrap_or(MOCK_ROOT_GOAL_ID);
    json!({
        "delivery": {
            "id": id,
            "spaceId": MOCK_SPACE_ID,
            "issueId": issue_id,
            "registeredAgentId": agent.id,
            "subscriptionId": format!("sub_{}", agent.id),
            "notificationVersion": issue.get("notificationVersion").and_then(Value::as_i64).unwrap_or(1),
            "updateSummary": "Issue matched this Registered Agent goal subscription",
            "status": status,
            "createdAt": "2026-06-24T08:55:00.000Z",
            "updatedAt": "2026-06-24T08:55:00.000Z",
            "deliveredToSessionId": null,
            "deliveredAt": null
        },
        "issueMeta": {
            "id": issue_id,
            "title": title,
            "state": issue_state,
            "updatedAt": updated_at
        },
        "goalMeta": {
            "id": goal_id,
            "path": agent.goal_path_label.clone().unwrap_or_else(|| "MyAgents社区".to_string()),
            "title": agent.goal_path_label.clone().unwrap_or_else(|| "MyAgents社区".to_string())
        }
    })
}

fn mock_event(
    id: &str,
    event_type: &str,
    resource_type: &str,
    resource_id: &str,
    created_at: &str,
) -> Value {
    json!({
        "id": id,
        "type": event_type,
        "resourceType": resource_type,
        "resourceId": resource_id,
        "actorType": "user",
        "actorId": "usr_mock_owner",
        "targetRegisteredAgentId": null,
        "payload": null,
        "createdAt": created_at
    })
}

fn mock_space() -> Value {
    json!({
        "id": MOCK_SPACE_ID,
        "slug": "official",
        "name": "MyAgents社区",
        "joinPolicy": "open",
        "rootGoalId": MOCK_ROOT_GOAL_ID
    })
}

fn ok_envelope(data: Value) -> Value {
    json!({ "success": true, "data": data, "requestId": "req_mock_success" })
}

fn err_envelope(error: String) -> Value {
    json!({
        "success": false,
        "error": error,
        "code": "MOCK_SPACE_ERROR",
        "requestId": "req_mock_error"
    })
}

fn parse_mock_url(path: &str) -> Result<reqwest::Url, String> {
    if !path.starts_with("/api/") && path != "/health" && path != "/" {
        return Err("Space API path must start with /api/".to_string());
    }
    reqwest::Url::parse(&format!("{}{}", MOCK_BASE_URL, path))
        .map_err(|e| format!("Invalid mock Space API path: {}", e))
}

fn normalize_path_for_match(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn mime_for_name(name: &str) -> &'static str {
    if name.ends_with(".png") {
        "image/png"
    } else if name.ends_with(".zip") {
        "application/zip"
    } else if name.ends_with(".md") {
        "text/markdown"
    } else {
        "text/plain"
    }
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

fn title_case(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_mock_state_has_commercial_fixture_volume() {
        let state = initial_state();

        assert!(state.issues.len() >= 500);
        assert!(state.skills.len() >= 50);
        assert!(state.agents.len() >= 50);
        assert!(state.issues.iter().any(|issue| issue
            .get("attachmentCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0));
        assert!(state.issues.iter().any(|issue| issue
            .get("commentCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0));
    }

    #[test]
    fn event_cursor_advances_by_id_within_same_timestamp() {
        let event = mock_event(
            "evt_same_002",
            "issue.commented",
            "issue",
            "iss_same",
            "2026-06-24T10:00:00.000Z",
        );

        assert!(event_after_cursor(
            &event,
            Some("2026-06-24T10:00:00.000Z|evt_same_001")
        ));
        assert!(!event_after_cursor(
            &event,
            Some("2026-06-24T10:00:00.000Z|evt_same_002")
        ));
        assert!(!event_after_cursor(
            &event,
            Some("2026-06-24T10:00:00.000Z")
        ));
    }
}
