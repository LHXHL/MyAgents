//! Shared platform text transport and evidence-based receipt classification.
use super::adapter::ImStreamAdapter;
use super::channel_messaging::ChannelTarget;

// Adapter APIs still expose String errors. Only their explicit API rejection
// prefixes prove non-acceptance; transport, parse and opaque plugin failures
// remain unknown. Do not infer safety to retry from a generic exception.
pub(crate) fn failure_status(error: &str) -> &'static str {
    if error.starts_with("Feishu API error code ")
        || error.starts_with("API error ")
        || error.starts_with("DingTalk API HTTP 4")
        || error.starts_with("Token request ")
        || error.starts_with("Image upload error ")
        || error.starts_with("File upload error ")
    {
        "failed"
    } else {
        "unknown"
    }
}

#[derive(Default)]
pub(crate) struct SendProgress {
    pub ids: Vec<String>,
    pub accepted: usize,
}

pub(crate) async fn send_text(
    adapter: &super::AnyAdapter,
    target: &ChannelTarget,
    transport: &str,
    text: &str,
    timeout: Option<std::time::Duration>,
) -> Result<SendProgress, (SendProgress, String)> {
    send_chunks(
        text,
        adapter.max_message_length(),
        timeout,
        |chunk| async move {
            match adapter {
                super::AnyAdapter::Feishu(feishu) => {
                    feishu
                        .send_channel_content(target, Some(&chunk), None)
                        .await
                }
                super::AnyAdapter::Dingtalk(dingtalk) => {
                    dingtalk.send_text_message(transport, &chunk).await
                }
                _ => adapter.send_message_returning_id(transport, &chunk).await,
            }
        },
    )
    .await
}

async fn send_chunks<F, Fut>(
    text: &str,
    max_length: usize,
    timeout: Option<std::time::Duration>,
    mut send: F,
) -> Result<SendProgress, (SendProgress, String)>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<Option<String>, String>>,
{
    let mut progress = SendProgress::default();
    let deadline = timeout.map(|duration| tokio::time::Instant::now() + duration);
    for chunk in super::adapter::split_message(text, max_length) {
        let result = if let Some(deadline) = deadline {
            tokio::time::timeout_at(deadline, send(chunk))
                .await
                .unwrap_or_else(|_| {
                    Err("Platform request timed out; it may have accepted the message".into())
                })
        } else {
            send(chunk).await
        };
        match result {
            Ok(id) => {
                progress.accepted += 1;
                progress.ids.extend(id);
            }
            Err(error) => return Err((progress, error)),
        }
    }
    Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn deadline_retains_accepted_chunks_when_the_next_chunk_hangs() {
        let mut parts = 0;
        let result = send_chunks(
            "abcdefghij",
            4,
            Some(std::time::Duration::from_millis(10)),
            |_| {
                parts += 1;
                let first = parts == 1;
                async move {
                    if first {
                        Ok(Some("accepted-first".into()))
                    } else {
                        std::future::pending().await
                    }
                }
            },
        )
        .await
        .err()
        .unwrap();
        assert_eq!(result.0.accepted, 1);
        assert_eq!(result.0.ids, vec!["accepted-first"]);
        assert_eq!(failure_status(&result.1), "unknown");
    }
    #[tokio::test]
    async fn chunk_receipts_distinguish_rejection_ambiguity_and_partial_acceptance() {
        let success = send_chunks("abcdefghij", 4, None, |_| async {
            Ok(Some("message-id".into()))
        })
        .await
        .unwrap_or_else(|_| panic!("send should succeed"));
        assert!(success.accepted > 1);
        assert_eq!(success.ids.len(), success.accepted);
        for (error, state) in [
            ("Feishu API error code 403", "failed"),
            ("request timed out", "unknown"),
            ("plugin returned malformed response", "unknown"),
        ] {
            let failure = send_chunks("hello", 100, None, |_| async { Err(error.into()) })
                .await
                .err()
                .unwrap();
            assert_eq!(failure.0.accepted, 0);
            assert_eq!(failure_status(&failure.1), state);
        }
        let mut parts = 0;
        let partial = send_chunks("abcdefghij", 4, None, |_| {
            parts += 1;
            let first = parts == 1;
            async move {
                if first {
                    Ok(Some("accepted".into()))
                } else {
                    Err("request timed out".into())
                }
            }
        })
        .await
        .err()
        .unwrap();
        assert_eq!(partial.0.accepted, 1);
        assert_eq!(partial.0.ids, vec!["accepted"]);
    }
}
