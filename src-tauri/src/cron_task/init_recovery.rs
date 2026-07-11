use super::*;

/// Startup convergence order: migrate the read-only legacy store first, then
/// rebuild the only live timer set from TaskStore.
pub async fn initialize_cron_manager(handle: AppHandle) {
    if let Err(error) = crate::legacy_upgrade::migrate_legacy_crons_on_startup().await {
        ulog_error!("[legacy-cron] startup migration failed: {}", error);
    }

    crate::task_scheduler::get_task_scheduler()
        .initialize(handle.clone())
        .await;
    if let Err(error) =
        crate::memory_auto_update::reconcile_memory_auto_update_tasks_from_disk().await
    {
        ulog_warn!(
            "[memory-auto-update] startup disk-first reconcile failed: {}",
            error
        );
    }
    let _ = handle.emit("cron:manager-ready", serde_json::json!({}));
    ulog_info!("[task-scheduler] startup recovery complete");
}
