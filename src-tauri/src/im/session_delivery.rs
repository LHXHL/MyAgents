use std::sync::Arc;

use super::{adapter, types::ImSourceType, AnyAdapter, ManagedAgents, ManagedImBots};

#[derive(Clone)]
pub(crate) struct SessionChannelTarget {
    pub adapter: Arc<AnyAdapter>,
    pub chat_id: String,
    pub channel_id: String,
    pub source_type: ImSourceType,
}

type ChannelSnapshot = (
    String,
    Arc<AnyAdapter>,
    Arc<tokio::sync::Mutex<super::router::SessionRouter>>,
);

async fn find_in_snapshots(
    snapshots: Vec<ChannelSnapshot>,
    session_id: &str,
) -> Option<SessionChannelTarget> {
    for (channel_id, adapter, router) in snapshots {
        let router = router.lock().await;
        let peer = router
            .peer_sessions_iter()
            .find(|peer| peer.session_id == session_id)
            .map(|peer| (peer.source_id.clone(), peer.source_type.clone()));
        drop(router);
        if let Some((chat_id, source_type)) = peer {
            return Some(SessionChannelTarget {
                adapter,
                chat_id,
                channel_id,
                source_type,
            });
        }
    }
    None
}

/// Resolve the live IM channel bound to a session without holding an outer
/// ManagedAgents/ManagedImBots lock across router awaits.
pub(crate) async fn find_channel_for_session(
    agents: Option<&ManagedAgents>,
    im_bots: Option<&ManagedImBots>,
    session_id: &str,
) -> Option<SessionChannelTarget> {
    if let Some(agents) = agents {
        let snapshots = {
            let agents = agents.lock().await;
            agents
                .values()
                .flat_map(|agent| {
                    agent.channels.iter().map(|(channel_id, channel)| {
                        (
                            channel_id.clone(),
                            Arc::clone(&channel.bot_instance.adapter),
                            Arc::clone(&channel.bot_instance.router),
                        )
                    })
                })
                .collect::<Vec<_>>()
        };
        if let Some(target) = find_in_snapshots(snapshots, session_id).await {
            return Some(target);
        }
    }

    if let Some(im_bots) = im_bots {
        let snapshots = {
            let bots = im_bots.lock().await;
            bots.iter()
                .map(|(bot_id, bot)| {
                    (
                        bot_id.clone(),
                        Arc::clone(&bot.adapter),
                        Arc::clone(&bot.router),
                    )
                })
                .collect::<Vec<_>>()
        };
        return find_in_snapshots(snapshots, session_id).await;
    }

    None
}

/// Push one completed assistant response through the original session's IM
/// channel. Returns false for desktop-only sessions.
pub(crate) async fn push_assistant_text_for_session(
    agents: Option<&ManagedAgents>,
    im_bots: Option<&ManagedImBots>,
    session_id: &str,
    text: &str,
) -> Result<bool, String> {
    if text.trim().is_empty() {
        return Ok(false);
    }
    let Some(target) = find_channel_for_session(agents, im_bots, session_id).await else {
        return Ok(false);
    };
    push_assistant_text(&target, text).await?;
    Ok(true)
}

pub(crate) async fn push_assistant_text(
    target: &SessionChannelTarget,
    text: &str,
) -> Result<(), String> {
    if should_suppress_silent_reply(&target.source_type, text) {
        return Ok(());
    }
    adapter::push_text_preferring_stream(target.adapter.as_ref(), &target.chat_id, text)
        .await
        .map_err(|error| {
            format!(
                "failed to push assistant response to channel {}: {}",
                target.channel_id, error
            )
        })
}

fn should_suppress_silent_reply(source_type: &ImSourceType, text: &str) -> bool {
    matches!(source_type, ImSourceType::Group) && matches!(text.trim(), "<NO_REPLY>" | "NO_REPLY")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_silent_reply_is_not_delivered() {
        assert!(should_suppress_silent_reply(
            &ImSourceType::Group,
            " <NO_REPLY> "
        ));
        assert!(!should_suppress_silent_reply(
            &ImSourceType::Private,
            "<NO_REPLY>"
        ));
        assert!(!should_suppress_silent_reply(
            &ImSourceType::Group,
            "Progress update"
        ));
    }
}
