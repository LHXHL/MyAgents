//! Pure projections of the native protocols into the shared inbound contract.
//! Unknown facts stay absent; activation flags are supplied by existing routing.
use super::types::ImSourceMetadata;
use serde_json::{json, Value};

pub(super) fn nonempty(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

pub(super) fn feishu_display_name(user: &Value) -> Option<String> {
    ["nickname", "en_name", "name"]
        .into_iter()
        .find_map(|key| nonempty(&user[key]))
}

fn id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(String::from)
        .or_else(|| value.as_i64().map(|id| id.to_string()))
}
pub(super) fn telegram_display_name(user: &Value) -> Option<String> {
    let name = [user["first_name"].as_str(), user["last_name"].as_str()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}
fn actor(user: &Value, id_type: &str) -> Value {
    json!({"id":id(&user["id"]),"idType":id_type,"name":telegram_display_name(user),
        "username":user["username"].as_str(),"kind":match user["is_bot"].as_bool(){Some(true)=>"bot",Some(false)=>"human",None=>"unknown"}})
}
fn context(reply: Value, mentions: Value) -> Value {
    json!({"reply":reply,"history":[],"mentions":mentions,"attachments":[],"parts":[],"platformContext":[]})
}

pub(super) fn telegram(
    message: &Value,
    self_id: Option<String>,
    self_username: Option<String>,
    mentions_self: bool,
    reply_to_self: bool,
) -> ImSourceMetadata {
    let reply = message.get("reply_to_message").map(|reply| json!({
        "messageId":id(&reply["message_id"]),"sender":reply.get("from").map(|user|actor(user,"user_id")),
        "sentAt":reply["date"].as_i64().and_then(|time|chrono::DateTime::from_timestamp(time,0)),
        "text":reply["text"].as_str().or(reply["caption"].as_str())
    })).unwrap_or(Value::Null);
    let mentions: Vec<_> = message["entities"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(message["caption_entities"].as_array().into_iter().flatten())
        .filter_map(|entry| entry.get("user").map(|user| actor(user, "user_id")))
        .collect();
    ImSourceMetadata {
        platform_message_id: id(&message["message_id"]),
        sent_at: message["date"]
            .as_i64()
            .and_then(|time| chrono::DateTime::from_timestamp(time, 0)),
        sender_id_type: Some("user_id".into()),
        sender_username: message["from"]["username"].as_str().map(String::from),
        sender_is_bot: message["from"]["is_bot"].as_bool(),
        self_id,
        self_id_type: Some("user_id".into()),
        self_username,
        mentions_self: Some(mentions_self),
        reply_to_self: Some(reply_to_self),
        thread_id: id(&message["message_thread_id"]),
        context_data: Some(context(
            reply,
            if mentions.is_empty() {
                Value::Null
            } else {
                json!(mentions)
            },
        )),
        ..Default::default()
    }
}

pub(super) fn feishu(
    message: &Value,
    sender: &Value,
    self_id: Option<String>,
    mentions_self: bool,
) -> ImSourceMetadata {
    let mentions = message["mentions"].as_array().map(|items|items.iter().map(|item|json!({
        "id":item["id"]["open_id"].as_str(),"idType":"open_id","name":item["name"].as_str(),"username":null,
        "kind":if self_id.as_deref().is_some_and(|id|Some(id)==item["id"]["open_id"].as_str()){"bot"}else{"unknown"}
    })).collect::<Vec<_>>());
    let reply = message["parent_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(|id| json!({"messageId":id,"sender":null,"sentAt":null,"text":null}))
        .unwrap_or(Value::Null);
    ImSourceMetadata {
        platform_message_id: message["message_id"].as_str().map(String::from),
        sent_at: message["create_time"]
            .as_str()
            .and_then(|time| time.parse::<i64>().ok())
            .and_then(chrono::DateTime::from_timestamp_millis),
        sender_id_type: Some("open_id".into()),
        sender_is_bot: sender["sender_type"].as_str().map(|kind| kind != "user"),
        self_id,
        self_id_type: Some("open_id".into()),
        mentions_self: Some(mentions_self),
        // Feishu does not include the quoted message's sender in this event.
        reply_to_self: None,
        thread_id: message["thread_id"].as_str().map(String::from),
        context_data: Some(context(reply, json!(mentions))),
        ..Default::default()
    }
}

pub(super) fn dingtalk(data: &Value) -> ImSourceMetadata {
    ImSourceMetadata {
        platform_message_id: data["msgId"].as_str().map(String::from),
        sent_at: data["createAt"]
            .as_i64()
            .and_then(chrono::DateTime::from_timestamp_millis),
        sender_id_type: Some("staff_id".into()),
        mentions_self: data["isInAtList"].as_bool().or_else(|| {
            data["isInAtList"].as_str().and_then(|s| match s {
                "true" => Some(true),
                "false" => Some(false),
                _ => None,
            })
        }),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_protocol_fixtures_preserve_provenance() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../src/shared/__fixtures__/channel-context/native-inputs.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let metadata = match fixture["platform"].as_str().unwrap() {
                "telegram" => telegram(
                    &fixture["message"],
                    Some("bot".into()),
                    Some("test_bot".into()),
                    true,
                    true,
                ),
                "feishu" => feishu(
                    &fixture["message"],
                    &fixture["sender"],
                    Some("bot".into()),
                    true,
                ),
                "dingtalk" => dingtalk(&fixture["message"]),
                _ => unreachable!(),
            };
            let actual = serde_json::to_value(metadata).unwrap();
            for (key, value) in fixture["expected"].as_object().unwrap() {
                assert_eq!(&actual[key], value, "{} {key}", fixture["platform"]);
            }
        }
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    #[test]
    fn display_name_preserves_full_name_without_promoting_username() {
        assert_eq!(
            feishu_display_name(&json!({"nickname":" ","en_name":"","name":"李奕晨"})),
            Some("李奕晨".into())
        );
        assert_eq!(
            feishu_display_name(&json!({"nickname":"","name":" "})),
            None
        );
        assert_eq!(nonempty(&json!(" Team ")), Some("Team".into()));
        assert_eq!(
            telegram_display_name(
                &json!({"username":"handle", "first_name":"Ada", "last_name":"Lovelace"})
            ),
            Some("Ada Lovelace".into())
        );
        assert_eq!(telegram_display_name(&json!({"username":"handle"})), None);
    }
}
