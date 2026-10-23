use super::types::{AskUserQuestionPayload, ImSourceType};
use serde_json::{json, Value};

pub(crate) fn format_question_content(
    payload: &AskUserQuestionPayload,
    source_type: &ImSourceType,
) -> String {
    let mut lines = vec!["请回答下面的问题。".to_string()];
    if payload.questions.iter().any(|q| q.is_secret) {
        let scope = if matches!(source_type, ImSourceType::Group) {
            "群聊"
        } else {
            "IM"
        };
        lines.push(format!(
            "其中包含敏感输入，{} 不支持安全收集。请取消后在桌面端继续。",
            scope
        ));
        return lines.join("\n");
    }
    for (idx, q) in payload.questions.iter().enumerate() {
        lines.push(format!(
            "\n**{}. {}**\n{}{}",
            idx + 1,
            q.header,
            q.question,
            if q.required { "" } else { "\n（可跳过）" },
        ));
        if q.options.is_empty() {
            lines.push("请直接回复文本。".to_string());
        } else {
            let option_lines = q
                .options
                .iter()
                .enumerate()
                .map(|(opt_idx, opt)| {
                    if opt.description.is_empty() {
                        format!("{}. {}", opt_idx + 1, opt.label)
                    } else {
                        format!("{}. {} — {}", opt_idx + 1, opt.label, opt.description)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            lines.push(option_lines);
            if q.multi_select {
                lines.push("多选请回复编号或选项名，用逗号分隔。".to_string());
            } else {
                lines.push("请回复编号、选项名，或直接填写自己的答案。".to_string());
            }
        }
    }
    if payload.questions.len() > 1 {
        lines.push("\n多题请按顺序逐行回复；可选题留空表示跳过。".to_string());
    }
    lines.push("回复「取消」可取消本次提问。".to_string());
    lines.join("\n")
}

pub(crate) fn status_text(status: &str) -> &'static str {
    match status {
        "submitted" => "本次提问已提交",
        "cancelled" => "本次提问已取消",
        "expired" => "本次提问已失效",
        _ => "本次提问已处理",
    }
}

pub(crate) fn feishu_card(
    payload: &AskUserQuestionPayload,
    source_type: &ImSourceType,
    action_prefix: &str,
) -> Value {
    let mut elements = vec![json!({
        "tag": "div",
        "text": {
            "tag": "lark_md",
            "content": format_question_content(payload, source_type),
        }
    })];

    if payload.questions.len() == 1
        && !payload.questions[0].multi_select
        && !payload.questions[0].options.is_empty()
        && !payload.questions[0].is_secret
    {
        let q = &payload.questions[0];
        let key = q.id.clone().unwrap_or_else(|| "0".to_string());
        let mut actions = q
            .options
            .iter()
            .map(|opt| {
                let mut answers = serde_json::Map::new();
                answers.insert(key.clone(), Value::String(opt.label.clone()));
                json!({
                    "tag": "button",
                    "text": { "tag": "plain_text", "content": opt.label },
                    "type": "primary",
                    "value": {
                        "kind": "ask_user_question",
                        "rid": payload.request_id,
                        "action": format!("{}answer", action_prefix),
                        "answers": Value::Object(answers),
                    }
                })
            })
            .collect::<Vec<_>>();
        actions.push(json!({
            "tag": "button",
            "text": { "tag": "plain_text", "content": "取消" },
            "type": "default",
            "value": {
                "kind": "ask_user_question",
                "rid": payload.request_id,
                "action": format!("{}cancel", action_prefix),
            }
        }));
        for action in actions {
            elements.push(json!({ "tag": "action", "actions": [action] }));
        }
    }

    let card = json!({
        "config": { "wide_screen_mode": true, "update_multi": true },
        "header": {
            "title": { "tag": "plain_text", "content": "请选择或填写" },
            "template": "blue"
        },
        "elements": elements,
    });

    card
}

/// A failed delivery cannot leave a Runtime waiting for an invisible question.
pub(crate) async fn cancel_question(sidecar_port: u16, request_id: &str) -> bool {
    let result = crate::local_http::json_client(std::time::Duration::from_secs(30))
        .post(format!(
            "http://127.0.0.1:{}/api/ask-user-question/respond",
            sidecar_port
        ))
        .json(&json!({"requestId":request_id, "answers":null}))
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => response
            .json::<Value>()
            .await
            .is_ok_and(|body| body["success"] == true),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn card_and_text_preserve_questions_options_and_runtime_answer_keys() {
        let payload: AskUserQuestionPayload = serde_json::from_value(json!({
            "requestId":"request", "questions":[{"id":"format", "header":"格式", "question":"使用哪种格式？",
                "options":[{"label":"中文", "description":"保留中文"}, {"label":"English"}]}]
        })).unwrap();
        let text = format_question_content(&payload, &ImSourceType::Private);
        assert!(text.contains("使用哪种格式？"));
        assert!(text.contains("1. 中文 — 保留中文"));
        assert!(text.contains("2. English"));
        let card = feishu_card(&payload, &ImSourceType::Private, "myagents_question:");
        let value = &card["elements"][1]["actions"][0]["value"];
        assert_eq!(value["rid"], "request");
        assert_eq!(value["answers"], json!({"format":"中文"}));
        assert_eq!(value["action"], "myagents_question:answer");
        assert_eq!(
            card["elements"][3]["actions"][0]["value"]["action"],
            "myagents_question:cancel"
        );
    }
}
