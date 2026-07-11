#[cfg(test)]
use super::*;

// ===== Sidecar stderr classification =====
//
// Node.js writes to stderr from a few intentional informational paths
// (startup beacon, log-retention sweep audit, sdk-shim warnings). The
// pre-existing default of "stderr ⇒ ERROR" surfaced these as red lines in
// the unified log and broke `grep ERROR` for monitoring. Recognise the
// known prefixes and downgrade.
//
// NOTE on adding new entries: only demote messages that are unconditionally
// non-actionable. If a prefix EVER signals a real problem, leave it on
// ERROR — false negatives in this table are far worse than the noise.

#[derive(Clone, Copy)]
pub(crate) enum SidecarStderrLevel {
    Info,
    Warn,
    Error,
}

pub(crate) fn classify_sidecar_stderr(line: &str) -> SidecarStderrLevel {
    // Anchor the prefix match. `contains()` would silently demote any
    // genuine ERROR line that happens to embed one of these brackets in a
    // user-content echo (e.g., `Failed to validate '[log-retention]' user
    // input`). Sidecar / bridge stderr lines from the producers below
    // start with the prefix unconditionally — leading whitespace is the
    // only natural variation, so trim before matching. Cross-review of
    // dev/0.2.9 flagged the substring-match risk.
    let head = line.trim_start();
    // INFO: pure progress / audit output that just happens to land on
    // stderr because the sidecar logger writes there before unified
    // logging is wired up.
    //   - `[startup]` startupBeacon, fired before stdout drain is hooked.
    //   - `[log-retention]` daily / on-demand sweep audit (deleted N old
    //     files, etc.) — see `src/server/log-retention.ts::safeStderr`.
    if head.starts_with("[startup]") || head.starts_with("[log-retention]") {
        return SidecarStderrLevel::Info;
    }
    // WARN: real warnings the sidecar emits via `console.warn`. The
    // `[sdk-shim]` "not implemented in Bridge mode" lines warn that an
    // openclaw plugin reached for an SDK method the bridge doesn't
    // implement. They are expected (the shim is intentionally partial)
    // but worth keeping visible at WARN level for plugin developers.
    if head.starts_with("[sdk-shim]") {
        return SidecarStderrLevel::Warn;
    }
    SidecarStderrLevel::Error
}

#[cfg(test)]
mod session_activation_tab_uniqueness_tests {
    use super::*;

    /// Helper: shape an activate_session call with sensible defaults.
    fn activate(mgr: &mut SidecarManager, session_id: &str, tab_id: Option<&str>, port: u16) {
        mgr.activate_session(
            session_id.to_string(),
            tab_id.map(String::from),
            None,
            port,
            "/tmp/workspace".to_string(),
            false,
        );
    }

    /// Helper: collect (session_id, tab_id) pairs for assertion clarity.
    fn snapshot(mgr: &SidecarManager) -> Vec<(String, Option<String>)> {
        let mut v: Vec<(String, Option<String>)> = mgr
            .session_activations
            .iter()
            .map(|(sid, a)| (sid.clone(), a.tab_id.clone()))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn activate_session_clears_stale_tab_id_from_other_activations() {
        let mut mgr = SidecarManager::new();
        // First activation: session_X owned by tab T_A.
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        // New activation: same tab T_A claims session_Y. Without the
        // uniqueness fix, both session_X and session_Y would carry
        // tab_id=Some("T_A") simultaneously, and the priority-2
        // `find(|a| a.tab_id == Some("T_A"))` lookup in
        // get_tab_server_url would return either entry depending on
        // HashMap iteration order — issue #169's stop-routes-to-wrong-
        // session bug.
        activate(&mut mgr, "session_Y", Some("T_A"), 31419);

        let snap = snapshot(&mgr);
        // session_X's tab_id MUST be cleared. session_Y MUST own T_A.
        assert_eq!(
            snap,
            vec![
                ("session_X".to_string(), None),
                ("session_Y".to_string(), Some("T_A".to_string())),
            ]
        );
    }

    #[test]
    fn update_session_tab_clears_stale_tab_id_from_other_activations() {
        let mut mgr = SidecarManager::new();
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        activate(&mut mgr, "session_Y", None, 31419);

        // Tab T_A switches to session_Y via update_session_tab. The fix
        // must transfer the tab binding, not duplicate it.
        mgr.update_session_tab("session_Y", Some("T_A".to_string()));

        let snap = snapshot(&mgr);
        assert_eq!(
            snap,
            vec![
                ("session_X".to_string(), None),
                ("session_Y".to_string(), Some("T_A".to_string())),
            ]
        );
    }

    #[test]
    fn update_session_tab_to_none_does_not_touch_other_activations() {
        let mut mgr = SidecarManager::new();
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        activate(&mut mgr, "session_Y", Some("T_B"), 31419);

        // Clearing T_A from session_X shouldn't affect session_Y's
        // unrelated tab_id.
        mgr.update_session_tab("session_X", None);

        let snap = snapshot(&mgr);
        assert_eq!(
            snap,
            vec![
                ("session_X".to_string(), None),
                ("session_Y".to_string(), Some("T_B".to_string())),
            ]
        );
    }

    #[test]
    fn activate_session_self_keeps_its_own_tab_id() {
        let mut mgr = SidecarManager::new();
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        // Re-activate the same session with the same tab_id — this
        // should NOT clear its own tab_id during the uniqueness sweep
        // (the sweep skips the keeper session_id).
        activate(&mut mgr, "session_X", Some("T_A"), 31418);

        let snap = snapshot(&mgr);
        assert_eq!(
            snap,
            vec![("session_X".to_string(), Some("T_A".to_string()))]
        );
    }

    #[test]
    fn multiple_unrelated_tabs_coexist() {
        let mut mgr = SidecarManager::new();
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        activate(&mut mgr, "session_Y", Some("T_B"), 31419);
        activate(&mut mgr, "session_Z", Some("T_C"), 31420);

        // Three tabs each on their own session — no interference.
        let snap = snapshot(&mgr);
        assert_eq!(
            snap,
            vec![
                ("session_X".to_string(), Some("T_A".to_string())),
                ("session_Y".to_string(), Some("T_B".to_string())),
                ("session_Z".to_string(), Some("T_C".to_string())),
            ]
        );
    }

    #[test]
    fn clearing_tab_id_preserves_task_id_and_port() {
        // When session_X loses its tab binding because tab T_A claims
        // session_Y, session_X's other fields (task_id, port, workspace,
        // is_cron_task) MUST stay intact — another persistent owner that
        // keeps the sidecar alive still depends on them.
        let mut mgr = SidecarManager::new();
        mgr.activate_session(
            "session_X".to_string(),
            Some("T_A".to_string()),
            Some("task-123".to_string()),
            31418,
            "/tmp/workspace_x".to_string(),
            true,
        );
        // Tab T_A switches to session_Y → session_X's tab_id must clear,
        // but task_id="task-123" / port=31418 / workspace must persist.
        mgr.activate_session(
            "session_Y".to_string(),
            Some("T_A".to_string()),
            None,
            31419,
            "/tmp/workspace_y".to_string(),
            false,
        );

        let session_x = mgr
            .session_activations
            .get("session_X")
            .expect("session_X stays");
        assert_eq!(session_x.tab_id, None);
        assert_eq!(session_x.task_id.as_deref(), Some("task-123"));
        assert_eq!(session_x.port, 31418);
        assert_eq!(session_x.workspace_path, "/tmp/workspace_x");
        assert!(session_x.is_cron_task);
    }

    #[test]
    fn get_tab_server_url_returns_unique_port_after_tab_switch() {
        // Integration-style check: the priority-2 fallback in
        // get_tab_server_url iterates session_activations.values() to
        // find by tab_id. After enforcing uniqueness, there can only
        // be one match — so the port returned is deterministic
        // regardless of HashMap iteration order.
        let mut mgr = SidecarManager::new();
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        activate(&mut mgr, "session_Y", Some("T_A"), 31419); // T_A switches to session_Y

        // Find by tab_id == T_A: must be session_Y (port 31419), not session_X.
        let matches: Vec<(String, u16)> = mgr
            .session_activations
            .values()
            .filter(|a| a.tab_id.as_deref() == Some("T_A"))
            .map(|a| (a.session_id.clone(), a.port))
            .collect();
        assert_eq!(
            matches.len(),
            1,
            "tab_id uniqueness violated: {:?}",
            matches
        );
        assert_eq!(matches[0], ("session_Y".to_string(), 31419));
    }
}

#[cfg(test)]
mod stderr_classifier_tests {
    use super::*;

    #[test]
    fn anchored_prefixes_demote_only_when_at_line_start() {
        assert!(matches!(
            classify_sidecar_stderr("[startup] init"),
            SidecarStderrLevel::Info
        ));
        assert!(matches!(
            classify_sidecar_stderr("[log-retention] sweep done"),
            SidecarStderrLevel::Info
        ));
        assert!(matches!(
            classify_sidecar_stderr("[sdk-shim] foo() not implemented"),
            SidecarStderrLevel::Warn
        ));
        // Leading whitespace OK.
        assert!(matches!(
            classify_sidecar_stderr("  [startup] foo"),
            SidecarStderrLevel::Info
        ));
        // Embedded prefix in a real error MUST stay ERROR.
        assert!(matches!(
            classify_sidecar_stderr("Error: failed to parse '[log-retention]' user input"),
            SidecarStderrLevel::Error
        ));
        assert!(matches!(
            classify_sidecar_stderr("uncaught: missing [sdk-shim] field in payload"),
            SidecarStderrLevel::Error
        ));
        // Default = ERROR.
        assert!(matches!(
            classify_sidecar_stderr("ReferenceError: x is not defined"),
            SidecarStderrLevel::Error
        ));
    }
}
