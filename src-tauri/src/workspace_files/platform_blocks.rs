//! Platform-specific skill block list.
//!
//! Mirrors `src/server/utils/platform.ts::PLATFORM_BLOCKED_SKILLS` for the
//! no-Sidecar Launcher picker. Runtime admission remains Node-owned.

/// Returns `true` if the skill folder name is blocked on the current
/// platform. Today this only blocks `agent-browser` on Windows (upstream
/// Playwright bug); structure leaves room for more entries.
pub fn is_skill_blocked_on_platform(folder: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        if folder == "agent-browser" {
            return true;
        }
    }
    let _ = folder;
    false
}
