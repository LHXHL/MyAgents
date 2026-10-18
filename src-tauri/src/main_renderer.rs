//! The native main window outlives its WebContent process. Attach before any
//! Chat mounts so a replacement gets fresh transport and the exact old owners.
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::sidecar::ManagedSidecarManager;
use crate::sse_proxy::SseProxyState;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabOwnerBinding {
    session_id: String,
    tab_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RendererAttachment {
    replacement: bool,
    previous_tab_owners: Vec<TabOwnerBinding>,
}

#[derive(Default)]
pub struct MainRendererState {
    attachment: Mutex<Option<(String, RendererAttachment)>>,
}

impl MainRendererState {
    async fn attach(
        &self,
        renderer_id: String,
        manager: &ManagedSidecarManager,
        sse: &SseProxyState,
    ) -> Result<RendererAttachment, String> {
        let mut current = self.attachment.lock().await;
        if let Some((id, receipt)) = current.as_ref() {
            if id == &renderer_id {
                return Ok(receipt.clone());
            }
        }
        let replacement = current.is_some();
        let previous_tab_owners = if replacement {
            manager
                .lock()
                .map_err(|error| error.to_string())?
                .tab_owner_bindings()
                .into_iter()
                .map(|(session_id, tab_id)| TabOwnerBinding { session_id, tab_id })
                .collect()
        } else {
            Vec::new()
        };
        if replacement {
            sse.stop_tab_subscriptions().await;
        }
        let receipt = RendererAttachment {
            replacement,
            previous_tab_owners,
        };
        *current = Some((renderer_id, receipt.clone()));
        Ok(receipt)
    }
}

#[tauri::command]
pub async fn cmd_attach_main_renderer(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, MainRendererState>,
    manager: tauri::State<'_, ManagedSidecarManager>,
    sse: tauri::State<'_, Arc<SseProxyState>>,
    renderer_id: String,
) -> Result<RendererAttachment, String> {
    if window.label() != "main" || renderer_id.is_empty() {
        return Err("Renderer attachment requires the main window and an instance id".into());
    }
    state
        .attach(renderer_id, manager.inner(), sse.inner())
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::{create_sidecar_manager, SidecarOwner};

    #[tokio::test]
    async fn replacement_keeps_exact_tab_owners_and_repeat_attach_is_idempotent() {
        let state = MainRendererState::default();
        let manager = create_sidecar_manager();
        let sse = SseProxyState::default();
        let cold = state.attach("first".into(), &manager, &sse).await.unwrap();
        assert!(!cold.replacement);
        {
            let mut manager = manager.lock().unwrap();
            manager.insert_test_ready_frontend_sidecar(
                "session-a",
                32001,
                SidecarOwner::Tab("tab-a".into()),
            );
            manager.add_session_owner("session-a", SidecarOwner::Companion("companion".into()));
            manager.insert_test_ready_frontend_sidecar(
                "session-b",
                32002,
                SidecarOwner::Tab("tab-b".into()),
            );
        }
        let recovered = state.attach("second".into(), &manager, &sse).await.unwrap();
        assert!(recovered.replacement);
        assert_eq!(
            recovered.previous_tab_owners,
            vec![
                TabOwnerBinding {
                    session_id: "session-a".into(),
                    tab_id: "tab-a".into()
                },
                TabOwnerBinding {
                    session_id: "session-b".into(),
                    tab_id: "tab-b".into()
                },
            ]
        );
        // Native attachment only retires transport, never drops Session owners.
        assert_eq!(manager.lock().unwrap().tab_owner_bindings().len(), 2);
        assert_eq!(
            state.attach("second".into(), &manager, &sse).await.unwrap(),
            recovered
        );
        assert!(
            !MainRendererState::default()
                .attach("third".into(), &manager, &sse)
                .await
                .unwrap()
                .replacement
        );
    }
}
