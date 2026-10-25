use super::*;
use crate::im::channel_messaging::{
    media_types, resolve_scope, target_types, transport_target, ChannelTarget,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChannelContextRequest {
    sidecar_id: String,
}

pub(super) fn caller(
    headers: &HeaderMap,
    sidecar: &str,
) -> Result<crate::sidecar::SessionProcessSource, String> {
    let generation = request_sidecar_generation(headers)
        .map_err(|_| "A valid Sidecar generation is required.")?;
    get_sidecar_state()
        .ok_or("Session owner unavailable.")?
        .lock()
        .map_err(|_| "Session owner unavailable.")?
        .resolve_session_process_source(sidecar, generation)
        .ok_or_else(|| "A live Session process is required.".into())
}

pub(super) async fn channel_context_handler(
    headers: HeaderMap,
    Json(request): Json<ChannelContextRequest>,
) -> Json<Value> {
    let result = async {
        let source = caller(&headers, &request.sidecar_id)?;
        let scope = resolve_scope(
            get_agents(),
            get_im_bots(),
            &source.product_session_id,
            &source.workspace_path,
        )
        .await?;
        Ok::<_, String>(scope.projection())
    }
    .await;
    Json(result.unwrap_or_else(|error| serde_json::json!({"ok":false,"error":error})))
}

use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetInput {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    id: String,
    id_type: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AttachmentInput {
    path: String,
    caption: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessageInput {
    context: Option<String>,
    text: Option<String>,
    attachments: Option<Vec<AttachmentInput>>,
    target: Option<TargetInput>,
    channel_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SendRequest {
    sidecar_id: String,
    request: MessageInput,
}

fn valid_identity(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 1024
}

fn resolve_target(
    input: Option<TargetInput>,
    binding: Option<ChannelTarget>,
    channel_id: Option<String>,
    platform: &im::types::ImPlatform,
    selected_id: &str,
) -> Result<ChannelTarget, String> {
    if binding.as_ref().is_some_and(|bound| {
        channel_id
            .as_deref()
            .is_some_and(|id| id != bound.channel_id)
    }) {
        return Err("channelId conflicts with this Session's binding.".into());
    }
    let Some(input) = input else {
        return binding.ok_or_else(|| "No default binding. Provide channelId and target.".into());
    };
    if !valid_identity(&input.id) {
        return Err("Target ID must contain 1–1024 UTF-8 bytes.".into());
    }
    let types = target_types(platform);
    let supported = types
        .as_array()
        .and_then(|types| types.iter().find(|entry| entry["type"] == input.kind))
        .ok_or_else(|| {
            target_format_error("Unsupported or missing target.type for this channel.")
        })?;
    let ids = supported["idTypes"]
        .as_array()
        .ok_or("Channel does not declare target ID types.")?;
    let id_type = input
        .id_type
        .or_else(|| (ids.len() == 1).then(|| ids[0].as_str().unwrap_or_default().to_string()))
        .ok_or_else(|| target_format_error("Specify target.idType from channel capabilities."))?;
    if !ids.iter().any(|value| value.as_str() == Some(&id_type)) {
        return Err(target_format_error(
            "Unsupported target.idType for this channel.",
        ));
    }
    Ok(ChannelTarget {
        channel_id: selected_id.into(),
        target_type: input.kind,
        id: input.id,
        id_type,
    })
}

fn handoff_input_error(input: &MessageInput, missing_id: bool, missing_channel: bool) -> Value {
    let mut fields = Vec::new();
    if missing_id {
        fields.push("target.id");
    }
    if input.text.as_ref().is_none_or(|s| s.trim().is_empty()) {
        fields.push("text");
    }
    if input.context.as_ref().is_none_or(|s| s.trim().is_empty()) {
        fields.push("context");
    }
    if missing_channel {
        fields.push("channelId");
    }
    handoff_missing_fields(fields)
}
fn handoff_missing_error(id: bool, text: bool, context: bool) -> Value {
    let fields: Vec<_> = [(id, "target.id"), (text, "text"), (context, "context")]
        .into_iter()
        .filter_map(|(missing, name)| missing.then_some(name))
        .collect();
    handoff_missing_fields(fields)
}
fn handoff_missing_fields(fields: Vec<&str>) -> Value {
    json!({"status":"failed","connection":null,"target":null,"items":[],"code":"CHANNEL_HANDOFF_INPUT_INCOMPLETE","missingFields":fields,
        "error":format!("无法提交跨会话消息：缺少 {}。\n发送给其他私聊、群聊或频道时，需要 target.id、text、context：\n目标 Session 会先接收发送内容和事情背景，再替你告知该会话用户并承接后续对话。\n请补齐目标 ID、待告知内容和事情上下文；本次未投递、未发送。\n完整用法与示例：myagents im send-message --help（向其他会话发送）。", fields.join("、"))})
}

fn validate_direct_content(
    text: Option<&str>,
    attachments: &[AttachmentInput],
) -> Result<(), String> {
    if text.is_none_or(|text| text.trim().is_empty()) && attachments.is_empty() {
        return Err("Provide non-empty text or an attachment for the current conversation. See myagents im send-message --help.".into());
    }
    Ok(())
}
fn target_format_error(detail: &str) -> String {
    format!("{detail} 发送到其他会话需要 target.id、text、context，目标 Session 接收背景后转达并承接后续对话；本次未投递、未发送。完整用法：myagents im send-message --help（向其他会话发送）。")
}

struct PreparedAttachment {
    data: Vec<u8>,
    name: String,
    image: bool,
    caption: Option<String>,
}

async fn prepare_attachments(
    inputs: Vec<AttachmentInput>,
    workspace: &std::path::Path,
) -> Result<Vec<PreparedAttachment>, String> {
    if inputs.len() > 32 {
        return Err("At most 32 attachments are allowed.".into());
    }
    let mut roots = vec![workspace.to_path_buf(), std::env::temp_dir()];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".myagents/tmp"));
    }
    let roots: Vec<_> = roots
        .into_iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect();
    let mut output = Vec::new();
    for input in inputs {
        let path = std::path::Path::new(&input.path);
        if !path.is_absolute() {
            return Err("Attachment paths must be absolute.".into());
        }
        let path = tokio::fs::canonicalize(path)
            .await
            .map_err(|error| error.to_string())?;
        if !roots.iter().any(|root| path.starts_with(root)) {
            return Err("Attachment is outside the current workspace and temporary roots.".into());
        }
        let media = MediaType::from_extension(
            path.extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default(),
        );
        if media == MediaType::NonMedia {
            return Err("Unsupported attachment file type.".into());
        }
        let image = media == MediaType::Image;
        let limit = if image {
            10 * 1024 * 1024
        } else {
            50 * 1024 * 1024
        };
        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() > limit {
            return Err(format!(
                "Attachment must be a regular file no larger than {} MiB.",
                limit / 1024 / 1024
            ));
        }
        let data = tokio::fs::read(&path)
            .await
            .map_err(|error| error.to_string())?;
        if data.len() as u64 > limit {
            return Err("Attachment grew beyond the size limit.".into());
        }
        output.push(PreparedAttachment {
            data,
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("file")
                .into(),
            image,
            caption: input.caption,
        });
    }
    Ok(output)
}

fn validate_media_capability(
    platform: &im::types::ImPlatform,
    attachments: &[PreparedAttachment],
) -> Result<(), String> {
    for attachment in attachments {
        let kind = if attachment.image { "image" } else { "file" };
        if !media_types(platform).contains(&kind) {
            return Err(format!(
                "This channel does not support sending {kind} attachments. No content was sent."
            ));
        }
    }
    Ok(())
}

use crate::im::channel_send::{failure_status, send_text, SendProgress};

pub(super) async fn send_channel_message_handler(
    headers: HeaderMap,
    Json(request): Json<SendRequest>,
) -> Json<Value> {
    let result = execute(&headers, request).await.unwrap_or_else(
        |error| json!({"status":"failed","connection":null,"target":null,"items":[],"error":error}),
    );
    Json(json!({"ok":true,"result":result}))
}

async fn execute(headers: &HeaderMap, request: SendRequest) -> Result<Value, String> {
    let source = caller(headers, &request.sidecar_id)?;
    let scope = resolve_scope(
        get_agents(),
        get_im_bots(),
        &source.product_session_id,
        &source.workspace_path,
    )
    .await?;
    let input = request.request;
    let explicit = input.target.is_some();
    let intent = explicit || input.context.is_some();
    let missing_id = input.target.as_ref().is_none_or(|t| t.id.trim().is_empty());
    let missing_channel = scope.binding.is_none()
        && input
            .channel_id
            .as_ref()
            .is_none_or(|id| id.trim().is_empty());
    if (intent && missing_id) || missing_channel {
        return Ok(handoff_input_error(&input, missing_id, missing_channel));
    }
    let text = input.text.clone().filter(|text| !text.trim().is_empty());
    if !intent && text.is_none() && input.attachments.as_ref().is_none_or(Vec::is_empty) {
        return Err("Provide text or an attachment.".into());
    }
    let id = scope
        .binding
        .as_ref()
        .map(|target| target.channel_id.clone())
        .or(input.channel_id.clone())
        .ok_or("No default binding. Provide channelId and target.")?;
    let channel = scope
        .channels
        .iter()
        .find(|channel| channel.id == id)
        .ok_or("Channel does not belong to this Session's Agent.")?;
    let context = input.context.clone();
    let bound = scope.binding.clone();
    let target = resolve_target(
        input.target,
        scope.binding,
        input.channel_id,
        &channel.platform,
        &id,
    )?;
    let owner = im::channel_handoff::channel_owner(get_agents(), get_im_bots(), &id).await?;
    let resolved = if explicit {
        Some(owner.resolve(channel, &target).await?)
    } else {
        None
    };
    let cross = bound
        .as_ref()
        .is_none_or(|bound| resolved.as_ref().map(|r| &r.target).unwrap_or(&target) != bound);
    if cross && (text.is_none() || context.as_ref().is_none_or(|s| s.trim().is_empty())) {
        return Ok(handoff_missing_error(
            false,
            text.is_none(),
            context.as_ref().is_none_or(|s| s.trim().is_empty()),
        ));
    }
    if !cross {
        validate_direct_content(
            text.as_deref(),
            input.attachments.as_deref().unwrap_or_default(),
        )?;
    }
    let adapter = &owner.adapter;
    let transport = transport_target(&channel.platform, &target);
    // Read and validate every item before the first side effect.
    let attachments = prepare_attachments(
        input.attachments.unwrap_or_default(),
        &source.workspace_path,
    )
    .await?;
    validate_media_capability(&channel.platform, &attachments)?;
    if cross {
        let source_world = owner
            .source_world(channel, &source.product_session_id)
            .await?;
        if bound.is_some() && source_world.is_none() {
            return Err("Source binding changed before handoff".into());
        }
        let app = crate::logger::get_app_handle().ok_or("App owner unavailable")?;
        let manager = get_sidecar_state().ok_or("Session owner unavailable")?;
        let attachments = attachments
            .into_iter()
            .map(|a| im::channel_handoff::HandoffAttachment {
                mime_type: im::ext_to_mime(&a.name).to_string(),
                bytes: a.data,
                name: a.name,
                image: a.image,
                caption: a.caption,
            })
            .collect();
        return owner
            .deliver(
                app,
                manager,
                channel,
                im::channel_handoff::HandoffRequest {
                    conversation: resolved.ok_or("Explicit target required")?,
                    source_session: source.product_session_id,
                    source_world,
                    text: text.ok_or("text required")?,
                    context: context.ok_or("context required")?,
                    attachments,
                },
            )
            .await;
    }
    let total = usize::from(text.is_some()) + attachments.len();
    let mut items = Vec::new();
    let mut stopped = false;
    let mut accepted = 0;
    if let Some(text) = text {
        match send_text(adapter, &target, &transport, &text, None).await {
            Ok(progress) => {
                accepted += progress.accepted;
                items.push(
                    json!({"kind":"text","index":0,"status":"sent","messageIds":progress.ids}),
                );
            }
            Err((progress, error)) => {
                accepted += progress.accepted;
                items.push(json!({"kind":"text","index":0,"status":failure_status(&error),"messageIds":progress.ids,"error":error}));
                stopped = true;
            }
        }
    }
    for (index, attachment) in attachments.into_iter().enumerate() {
        if stopped {
            items.push(json!({"kind":"attachment","index":index,"status":"not_attempted"}));
            continue;
        }
        let mut progress = SendProgress::default();
        let result = match adapter.as_ref() {
            im::AnyAdapter::Feishu(feishu) => {
                // Captions are accepted text chunks on Feishu. Preserve their
                // receipts even when the subsequent attachment fails.
                let caption_result = if let Some(caption) = attachment.caption.as_deref() {
                    match send_text(adapter, &target, &transport, caption, None).await {
                        Ok(sent) => {
                            progress = sent;
                            Ok(())
                        }
                        Err((sent, error)) => {
                            progress = sent;
                            Err(error)
                        }
                    }
                } else {
                    Ok(())
                };
                match caption_result {
                    Ok(()) => {
                        feishu
                            .send_channel_content(
                                &target,
                                None,
                                Some((attachment.data, &attachment.name, attachment.image)),
                            )
                            .await
                    }
                    Err(error) => Err(error),
                }
            }
            _ if attachment.image => {
                adapter
                    .send_photo(
                        &transport,
                        attachment.data,
                        &attachment.name,
                        attachment.caption.as_deref(),
                    )
                    .await
            }
            _ => {
                adapter
                    .send_file(
                        &transport,
                        attachment.data,
                        &attachment.name,
                        im::ext_to_mime(&attachment.name),
                        attachment.caption.as_deref(),
                    )
                    .await
            }
        };
        accepted += progress.accepted;
        match result {
            Ok(id) => {
                accepted += 1;
                progress.ids.extend(id);
                items.push(json!({"kind":"attachment","index":index,"status":"sent","messageIds":progress.ids}));
            }
            Err(error) => {
                items.push(json!({"kind":"attachment","index":index,"status":failure_status(&error),"messageIds":progress.ids,"error":error}));
                stopped = true;
            }
        }
    }
    let sent = items.iter().filter(|item| item["status"] == "sent").count();
    let status = if sent == total {
        "sent"
    } else if accepted > 0 {
        "partial"
    } else if items.iter().any(|item| item["status"] == "unknown") {
        "unknown"
    } else {
        "failed"
    };
    Ok(
        json!({"status":status,"connection":{"channelId":id,"platform":channel.platform.to_string()},"target":target,"items":items}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_self_requires_content_and_unbound_missing_fields_explain_handoff() {
        assert!(validate_direct_content(None, &[]).is_err());
        assert!(validate_direct_content(Some("  "), &[]).is_err());
        assert!(validate_direct_content(Some("hi"), &[]).is_ok());
        assert!(validate_direct_content(
            None,
            &[AttachmentInput {
                path: "/tmp/a.txt".into(),
                caption: None
            }]
        )
        .is_ok());
        let input = serde_json::from_value(json!({"target":{}})).unwrap();
        assert_eq!(
            handoff_input_error(&input, true, true)["missingFields"],
            json!(["target.id", "text", "context", "channelId"])
        );
        for (kind, id_type, platform) in [
            ("", None, im::types::ImPlatform::Telegram),
            (
                "chat",
                None,
                im::types::ImPlatform::OpenClaw("qqbot".into()),
            ),
            (
                "user",
                Some("invalid".into()),
                im::types::ImPlatform::Telegram,
            ),
        ] {
            let error = resolve_target(
                Some(TargetInput {
                    kind: kind.into(),
                    id: "123".into(),
                    id_type,
                }),
                None,
                Some("bot".into()),
                &platform,
                "bot",
            )
            .unwrap_err();
            assert!(error.contains("myagents im send-message --help"), "{error}");
            assert!(error.contains("目标 Session"), "{error}");
        }
    }

    #[test]
    fn handoff_missing_fields_are_aggregated_without_defaulting_to_direct() {
        for (input, missing) in [
            (
                json!({"target":{}}),
                json!(["target.id", "text", "context"]),
            ),
            (
                json!({"context":"background"}),
                json!(["target.id", "text"]),
            ),
            (
                json!({"target":{"type":"user","id":"  "},"text":"hello"}),
                json!(["target.id", "context"]),
            ),
        ] {
            let input: MessageInput = serde_json::from_value(input).unwrap();
            let result = handoff_input_error(&input, true, false);
            assert_eq!(result["code"], "CHANNEL_HANDOFF_INPUT_INCOMPLETE");
            assert_eq!(result["missingFields"], missing);
            assert!(result["error"]
                .as_str()
                .unwrap()
                .contains("myagents im send-message --help"));
        }
    }

    #[tokio::test]
    async fn explicit_dingtalk_text_attempts_transport_instead_of_reporting_stream_noop_success() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tauri::async_runtime::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 2048];
            let count = stream.read(&mut bytes).await.unwrap();
            assert!(String::from_utf8_lossy(&bytes[..count])
                .starts_with("CONNECT api.dingtalk.com:443"));
            stream
                .write_all(
                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let config: im::types::ImConfig = serde_json::from_value(json!({"platform":"dingtalk", "botToken":"", "allowedUsers":[], "permissionMode":"auto", "enabled":true, "dingtalkUseAiCard":false})).unwrap();
        let mut adapter = im::dingtalk::DingtalkAdapter::new(
            &config,
            tokio::sync::mpsc::channel(1).0,
            Arc::new(tokio::sync::RwLock::new(vec![])),
            tokio::sync::mpsc::channel(1).0,
            None,
            tokio::sync::mpsc::channel(1).0,
        );
        // All network is intercepted by the isolated loopback proxy, without credentials.
        adapter.set_test_http_client(
            crate::local_http::builder()
                .proxy(reqwest::Proxy::all(format!("http://{addr}")).unwrap())
                .build()
                .unwrap(),
        );
        let target = ChannelTarget {
            channel_id: "ding".into(),
            target_type: "user".into(),
            id: "staff".into(),
            id_type: "staff_id".into(),
        };
        let result = send_text(
            &im::AnyAdapter::Dingtalk(Arc::new(adapter)),
            &target,
            "staff",
            "hello",
            None,
        )
        .await;
        assert!(
            result.is_err(),
            "a stream no-op must not be reported as successful explicit sending"
        );
        let (progress, _) = result.err().unwrap();
        assert_eq!(progress.accepted, 0);
        tokio::time::timeout(std::time::Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn dingtalk_binary_requests_fail_preflight_including_text_and_attachment_batches() {
        for image in [true, false] {
            let attachments = vec![PreparedAttachment {
                data: vec![1],
                name: "media".into(),
                image,
                caption: None,
            }];
            assert!(
                validate_media_capability(&im::types::ImPlatform::Dingtalk, &attachments)
                    .unwrap_err()
                    .contains("No content was sent")
            );
            assert!(
                validate_media_capability(&im::types::ImPlatform::Telegram, &attachments).is_ok()
            );
        }
        assert!(validate_media_capability(&im::types::ImPlatform::Dingtalk, &[]).is_ok());
    }

    #[test]
    fn bound_user_target_infers_id_type_without_channel_or_session_input() {
        for (platform, expected) in [
            (im::types::ImPlatform::OpenClaw("wecom".into()), "userid"),
            (im::types::ImPlatform::OpenClaw("feishu".into()), "open_id"),
            (im::types::ImPlatform::OpenClaw("qqbot".into()), "openid"),
        ] {
            let bound = ChannelTarget {
                channel_id: "bot".into(),
                target_type: "chat".into(),
                id: "group".into(),
                id_type: "chatid".into(),
            };
            let target = resolve_target(
                Some(TargetInput {
                    kind: "user".into(),
                    id: "recipient".into(),
                    id_type: None,
                }),
                Some(bound),
                None,
                &platform,
                "bot",
            )
            .unwrap();
            assert_eq!(target.id_type, expected);
            assert_eq!(target.channel_id, "bot");
        }
    }

    #[test]
    fn explicit_user_uses_open_id_and_binding_cannot_switch_connections() {
        let bound = ChannelTarget {
            channel_id: "feishu-1".into(),
            target_type: "chat".into(),
            id: "chat-1".into(),
            id_type: "chat_id".into(),
        };
        let request = || {
            Some(TargetInput {
                kind: "user".into(),
                id: "ou_1".into(),
                id_type: None,
            })
        };
        let result = resolve_target(
            request(),
            Some(bound.clone()),
            None,
            &im::types::ImPlatform::Feishu,
            "feishu-1",
        )
        .unwrap();
        assert_eq!(result.id_type, "open_id");
        assert!(resolve_target(
            request(),
            Some(bound),
            Some("another".into()),
            &im::types::ImPlatform::Feishu,
            "feishu-1"
        )
        .is_err());
    }
}
