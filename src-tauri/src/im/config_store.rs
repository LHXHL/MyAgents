use super::*;

// ===== Auto-start on app launch =====

/// Config shape from ~/.myagents/config.json (only what we need)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    /// Legacy single-bot config (for migration)
    im_bot_config: Option<PartialBotEntry>,
    /// Multi-bot configs (v0.1.19+)
    im_bot_configs: Option<Vec<PartialBotEntry>>,
    /// Agent configs (v0.1.41)
    #[serde(default)]
    agents: Vec<AgentConfigRust>,
    /// API keys keyed by provider ID (for migrating providerEnvJson)
    #[serde(default)]
    provider_api_keys: std::collections::HashMap<String, String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialBotEntry {
    id: Option<String>,
    #[serde(flatten)]
    config: ImConfig,
}

fn has_non_empty(value: Option<&String>) -> bool {
    value.map(|s| !s.is_empty()).unwrap_or(false)
}

fn im_config_has_start_credentials(config: &ImConfig) -> bool {
    match &config.platform {
        ImPlatform::Telegram => !config.bot_token.is_empty(),
        ImPlatform::Feishu => {
            has_non_empty(config.feishu_app_id.as_ref())
                && has_non_empty(config.feishu_app_secret.as_ref())
        }
        ImPlatform::Dingtalk => {
            has_non_empty(config.dingtalk_client_id.as_ref())
                && has_non_empty(config.dingtalk_client_secret.as_ref())
        }
        ImPlatform::OpenClaw(_) => has_non_empty(config.openclaw_plugin_id.as_ref()),
    }
}

pub(super) fn missing_configured_channel_status(
    persisted_status: &types::ImStatus,
) -> types::ImStatus {
    if matches!(persisted_status, types::ImStatus::Error) {
        return types::ImStatus::Error;
    }
    types::ImStatus::Connecting
}

fn agent_channel_has_start_credentials(
    agent_cfg: &types::AgentConfigRust,
    channel_cfg: &types::ChannelConfigRust,
) -> bool {
    let im_config = channel_cfg.to_im_config(agent_cfg);
    im_config_has_start_credentials(&im_config)
}

pub(super) fn should_report_missing_configured_channel(
    agent_cfg: &types::AgentConfigRust,
    channel_cfg: &types::ChannelConfigRust,
) -> bool {
    agent_cfg.enabled
        && channel_cfg.enabled
        && agent_channel_has_start_credentials(agent_cfg, channel_cfg)
}

fn find_missing_startable_agent_channels(
    agent_configs: &[types::AgentConfigRust],
    running_channel_keys: &std::collections::HashSet<(String, String)>,
    recovering_channels: &[(String, String)],
) -> Vec<(String, String)> {
    let mut missing = Vec::new();
    for agent_cfg in agent_configs {
        if !agent_cfg.enabled {
            continue;
        }
        for channel_cfg in &agent_cfg.channels {
            if !channel_cfg.enabled {
                continue;
            }
            let key = (agent_cfg.id.clone(), channel_cfg.id.clone());
            if running_channel_keys.contains(&key)
                || recovering_channels
                    .iter()
                    .any(|(aid, cid)| aid == &agent_cfg.id && cid == &channel_cfg.id)
            {
                continue;
            }
            let im_config = channel_cfg.to_im_config(agent_cfg);
            if im_config_has_start_credentials(&im_config) {
                missing.push(key);
            }
        }
    }
    missing
}

#[cfg(test)]
mod agent_monitor_tests {
    use super::*;

    /// Issue #301: a legacy/hand-edited config can persist `providerEnvJson` /
    /// `mcpServersJson` as a raw JSON object instead of a stringified blob, which
    /// fails the strict `AgentConfigRust` parse with
    /// `invalid type: map, expected a string`. The Value-level normalizer heals it
    /// before deserialization. Shared fixture with the TS twin test:
    /// `src/shared/__fixtures__/dirtyConfig301.json`.
    #[test]
    fn normalize_coerces_object_stringified_json_fields() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/shared/__fixtures__/dirtyConfig301.json"
        ));
        let mut value: serde_json::Value = serde_json::from_str(fixture).unwrap();

        // Before: the strict parse of the dirty agent fails (the #301 symptom).
        assert!(
            serde_json::from_value::<types::AgentConfigRust>(value["agents"][0].clone()).is_err(),
            "fixture's dirty agent should fail a strict parse before normalization"
        );

        assert!(normalize_stringified_json_value(&mut value));

        // After: the object fields are strings that round-trip to the original JSON.
        let dirty = &value["agents"][0];
        assert!(dirty["providerEnvJson"].is_string());
        assert!(dirty["mcpServersJson"].is_string());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(dirty["providerEnvJson"].as_str().unwrap())
                .unwrap(),
            serde_json::json!({
                "baseUrl": "https://api.example.com",
                "apiKey": "sk-agent-test",
                "authType": "auth_token"
            })
        );
        assert!(dirty["channels"][0]["overrides"]["providerEnvJson"].is_string());

        // And the strict parse now succeeds.
        assert!(
            serde_json::from_value::<types::AgentConfigRust>(value["agents"][0].clone()).is_ok(),
            "strict parse should succeed after normalization"
        );

        // Idempotent on a clean config, and already-stringified values are untouched.
        assert!(!normalize_stringified_json_value(&mut value));
        assert_eq!(
            value["agents"][1]["providerEnvJson"].as_str().unwrap(),
            "{\"baseUrl\":\"https://clean.example.com\",\"apiKey\":\"sk-clean\"}"
        );
    }

    /// Non-string scalar values are dropped, matching the TS twin
    /// `coerceJsonStringField` (which `delete`s number/bool). Keeps the two
    /// normalizers in sync per the "MUST stay in sync" contract.
    #[test]
    fn normalize_drops_non_string_scalar_fields() {
        let mut value = serde_json::json!({
            "agents": [{
                "id": "a", "name": "A", "enabled": true, "workspacePath": "/w",
                "providerEnvJson": 42,
                "mcpServersJson": true
            }]
        });
        assert!(normalize_stringified_json_value(&mut value));
        let agent = &value["agents"][0];
        assert!(agent.get("providerEnvJson").is_none());
        assert!(agent.get("mcpServersJson").is_none());
        // String / absent are untouched → second pass is a no-op.
        assert!(!normalize_stringified_json_value(&mut value));
    }

    /// Issue #398: the Agent settings UI can leave a selected remote HTTP/SSE
    /// MCP definition only in `agents[].mcpServersJson`. Agent channel cold-start
    /// self-resolve reads the global registry, so the Rust reader must heal the
    /// same split as the renderer load boundary before auto-start.
    #[test]
    fn promote_agent_mcp_json_to_global_recovers_selected_custom_definition() {
        let mut value = serde_json::json!({
            "agents": [{
                "id": "a",
                "name": "A",
                "enabled": true,
                "workspacePath": "/w",
                "mcpEnabledServers": ["remote-http"],
                "mcpServersJson": serde_json::json!([{
                    "id": "remote-http",
                    "name": "Remote HTTP",
                    "type": "http",
                    "url": "https://mcp.example.com/mcp",
                    "headers": { "Authorization": "Bearer token" },
                    "isBuiltin": false
                }]).to_string()
            }],
            "mcpServers": [],
            "mcpEnabledServers": []
        });

        assert!(promote_agent_mcp_json_to_global_value(&mut value));
        assert_eq!(value["mcpServers"][0]["id"], "remote-http");
        assert_eq!(value["mcpServers"][0]["isBuiltin"], false);
        assert_eq!(
            value["mcpEnabledServers"],
            serde_json::json!(["remote-http"])
        );
        assert!(!promote_agent_mcp_json_to_global_value(&mut value));
    }

    #[test]
    fn promote_agent_mcp_json_to_global_does_not_reenable_known_disabled_server() {
        let remote = serde_json::json!({
            "id": "remote-sse",
            "name": "Remote SSE",
            "type": "sse",
            "url": "https://mcp.example.com/sse",
            "isBuiltin": false
        });
        let mut value = serde_json::json!({
            "agents": [{
                "id": "a",
                "name": "A",
                "enabled": true,
                "workspacePath": "/w",
                "mcpEnabledServers": ["remote-sse"],
                "mcpServersJson": serde_json::json!([remote.clone()]).to_string()
            }],
            "mcpServers": [remote],
            "mcpEnabledServers": []
        });

        assert!(!promote_agent_mcp_json_to_global_value(&mut value));
        assert_eq!(value["mcpEnabledServers"], serde_json::json!([]));
    }

    #[test]
    fn promote_agent_mcp_json_to_global_skips_malformed_or_non_remote_definitions() {
        let mut value = serde_json::json!({
            "agents": [{
                "id": "a",
                "name": "A",
                "enabled": true,
                "workspacePath": "/w",
                "mcpEnabledServers": ["remote-without-url", "agent-stdio"],
                "mcpServersJson": serde_json::json!([
                    {
                        "id": "remote-without-url",
                        "name": "Remote Missing URL",
                        "type": "http",
                        "isBuiltin": false
                    },
                    {
                        "id": "agent-stdio",
                        "name": "Agent Stdio",
                        "type": "stdio",
                        "command": "node",
                        "isBuiltin": false
                    }
                ]).to_string()
            }],
            "mcpServers": [],
            "mcpEnabledServers": []
        });

        assert!(!promote_agent_mcp_json_to_global_value(&mut value));
        assert_eq!(value["mcpServers"], serde_json::json!([]));
        assert_eq!(value["mcpEnabledServers"], serde_json::json!([]));
    }

    /// Issue #316: missing providerEnvJson was rebuilt only on the typed clone
    /// returned by `read_agent_configs_from_disk`, so status polling re-read the
    /// still-missing disk config every 5s and logged the migration repeatedly.
    /// The raw Value migration is what can be persisted once under config lock.
    #[test]
    fn agent_provider_env_value_migration_is_idempotent() {
        let keys = std::collections::HashMap::from([
            ("siliconflow".to_string(), "sk-sf-test".to_string()),
            ("zenmux".to_string(), "sk-zen-test".to_string()),
        ]);
        let mut value = serde_json::json!({
            "providerApiKeys": {
                "siliconflow": "sk-sf-test",
                "zenmux": "sk-zen-test"
            },
            "agents": [{
                "id": "agent-1",
                "name": "Agent",
                "enabled": true,
                "workspacePath": "/tmp/project",
                "providerId": "siliconflow",
                "channels": [{
                    "id": "ch-1",
                    "type": "telegram",
                    "enabled": true,
                    "botToken": "bot-token",
                    "overrides": {
                        "providerId": "zenmux"
                    }
                }]
            }]
        });

        assert!(migrate_agent_provider_env_value(&mut value, &keys, false));
        assert!(value["agents"][0]["providerEnvJson"].is_string());
        assert!(value["agents"][0]["channels"][0]["overrides"]["providerEnvJson"].is_string());

        let agents = salvage_agents_from_value(&value, &keys).expect("agent should parse");
        assert!(agents[0].provider_env_json.is_some());
        assert!(agents[0].channels[0]
            .overrides
            .as_ref()
            .and_then(|ov| ov.provider_env_json.as_ref())
            .is_some());

        assert!(!migrate_agent_provider_env_value(&mut value, &keys, false));
    }

    fn temp_config_path(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "myagents-im-{}-{}-{}",
            name,
            std::process::id(),
            unique
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("config.json")
    }

    #[test]
    fn agent_provider_env_read_heal_persists_once_for_usable_main_config() {
        let path = temp_config_path("provider-env-heal-ok");
        let dir = path.parent().unwrap().to_path_buf();
        std::fs::write(
            &path,
            serde_json::json!({
                "providerApiKeys": {
                    "siliconflow": "sk-sf-test"
                },
                "agents": [{
                    "id": "agent-1",
                    "name": "Agent",
                    "enabled": true,
                    "workspacePath": "/tmp/project",
                    "providerId": "siliconflow",
                    "channels": []
                }]
            })
            .to_string(),
        )
        .unwrap();

        persist_agent_config_read_heal(&path, "test");
        let healed = std::fs::read_to_string(&path).unwrap();
        let healed_value: serde_json::Value = serde_json::from_str(&healed).unwrap();
        assert!(healed_value["agents"][0]["providerEnvJson"].is_string());
        let backup_after_first = std::fs::read_to_string(path.with_file_name("config.json.bak"))
            .expect("first heal should keep a backup of the pre-heal config");

        persist_agent_config_read_heal(&path, "test");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), healed);
        assert_eq!(
            std::fs::read_to_string(path.with_file_name("config.json.bak")).unwrap(),
            backup_after_first,
            "second idempotent heal must not rewrite config or rotate backup"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn agent_provider_env_read_heal_skips_unusable_main_config() {
        let path = temp_config_path("provider-env-heal-bad-main");
        let dir = path.parent().unwrap().to_path_buf();
        let bad_main = serde_json::json!({
            "providerApiKeys": {
                "siliconflow": "sk-sf-test"
            },
            "agents": [{
                "providerId": "siliconflow"
            }]
        })
        .to_string();
        let backup = "{\"agents\":[{\"id\":\"fallback\"}]}";
        std::fs::write(&path, &bad_main).unwrap();
        std::fs::write(path.with_file_name("config.json.bak"), backup).unwrap();

        persist_agent_config_read_heal(&path, "test");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), bad_main);
        assert_eq!(
            std::fs::read_to_string(path.with_file_name("config.json.bak")).unwrap(),
            backup,
            "read-time heal must not clobber fallback backup when main agents[] is unusable"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn agent_mcp_read_heal_persists_promoted_global_registry_once() {
        let path = temp_config_path("mcp-heal-ok");
        let dir = path.parent().unwrap().to_path_buf();
        let remote = serde_json::json!({
            "id": "remote-http",
            "name": "Remote HTTP",
            "type": "http",
            "url": "https://mcp.example.com/mcp",
            "isBuiltin": false
        });
        std::fs::write(
            &path,
            serde_json::json!({
                "agents": [{
                    "id": "agent-1",
                    "name": "Agent",
                    "enabled": true,
                    "workspacePath": "/tmp/project",
                    "mcpEnabledServers": ["remote-http"],
                    "mcpServersJson": serde_json::json!([remote]).to_string(),
                    "channels": []
                }],
                "mcpServers": [],
                "mcpEnabledServers": []
            })
            .to_string(),
        )
        .unwrap();

        persist_agent_config_read_heal(&path, "test");
        let healed = std::fs::read_to_string(&path).unwrap();
        let healed_value: serde_json::Value = serde_json::from_str(&healed).unwrap();
        assert_eq!(healed_value["mcpServers"][0]["id"], "remote-http");
        assert_eq!(
            healed_value["mcpEnabledServers"],
            serde_json::json!(["remote-http"])
        );
        let backup_after_first = std::fs::read_to_string(path.with_file_name("config.json.bak"))
            .expect("first heal should keep a backup of the pre-heal config");

        persist_agent_config_read_heal(&path, "test");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), healed);
        assert_eq!(
            std::fs::read_to_string(path.with_file_name("config.json.bak")).unwrap(),
            backup_after_first,
            "second idempotent heal must not rewrite config or rotate backup"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// `salvage_agents_from_value` signals recovery (`None`) only when the
    /// `agents` value is present-but-unusable, and salvages valid entries from a
    /// mixed array.
    #[test]
    fn salvage_agents_signals_recovery_correctly() {
        let keys = std::collections::HashMap::new();
        let valid = serde_json::json!({
            "id": "a", "name": "A", "enabled": true, "workspacePath": "/w"
        });
        let malformed = serde_json::json!({ "id": "b" }); // missing required fields

        // Absent / empty array → Some([]) (legitimately no agents; do NOT recover).
        assert_eq!(
            salvage_agents_from_value(&serde_json::json!({}), &keys).map(|v| v.len()),
            Some(0)
        );
        assert_eq!(
            salvage_agents_from_value(&serde_json::json!({ "agents": [] }), &keys).map(|v| v.len()),
            Some(0)
        );

        // Mixed array → salvage the valid one.
        let mixed = serde_json::json!({ "agents": [valid.clone(), malformed.clone()] });
        assert_eq!(
            salvage_agents_from_value(&mixed, &keys).map(|v| v.len()),
            Some(1)
        );

        // Every entry malformed → None (recover).
        let all_bad = serde_json::json!({ "agents": [malformed.clone(), malformed.clone()] });
        assert!(salvage_agents_from_value(&all_bad, &keys).is_none());

        // `agents` present but not an array → None (recover).
        let non_array = serde_json::json!({ "agents": { "oops": true } });
        assert!(salvage_agents_from_value(&non_array, &keys).is_none());
    }

    fn agent_config_with_weixin_channel(enabled: bool) -> Vec<types::AgentConfigRust> {
        serde_json::from_value(json!([{
            "id": "agent-1",
            "name": "Agent",
            "enabled": true,
            "workspacePath": "/tmp/project",
            "channels": [{
                "id": "weixin",
                "type": "openclaw:weixin",
                "enabled": enabled,
                "openclawPluginId": "openclaw-weixin"
            }]
        }]))
        .unwrap()
    }

    #[test]
    fn monitor_reconcile_finds_enabled_channel_missing_from_runtime_state() {
        let agents = agent_config_with_weixin_channel(true);
        let running = std::collections::HashSet::new();

        let missing = find_missing_startable_agent_channels(&agents, &running, &[]);

        assert_eq!(missing, vec![("agent-1".to_string(), "weixin".to_string())]);
    }

    #[test]
    fn monitor_reconcile_skips_running_or_disabled_channels() {
        let agents = agent_config_with_weixin_channel(true);
        let running =
            std::collections::HashSet::from([("agent-1".to_string(), "weixin".to_string())]);

        assert!(find_missing_startable_agent_channels(&agents, &running, &[]).is_empty());

        let disabled_agents = agent_config_with_weixin_channel(false);
        assert!(find_missing_startable_agent_channels(
            &disabled_agents,
            &std::collections::HashSet::new(),
            &[],
        )
        .is_empty());
    }

    #[test]
    fn missing_configured_channel_reports_connecting_when_enabled_and_startable() {
        let status = missing_configured_channel_status(&types::ImStatus::Stopped);

        assert_eq!(status, types::ImStatus::Connecting);
    }

    #[test]
    fn missing_configured_channel_preserves_error_for_enabled_startable_channel() {
        assert_eq!(
            missing_configured_channel_status(&types::ImStatus::Error),
            types::ImStatus::Error
        );
    }

    #[test]
    fn missing_configured_channel_is_only_reported_when_startable() {
        let mut agents = agent_config_with_weixin_channel(true);
        let agent = agents.remove(0);
        let mut channel = agent.channels[0].clone();

        assert!(should_report_missing_configured_channel(&agent, &channel));

        channel.enabled = false;
        assert!(!should_report_missing_configured_channel(&agent, &channel));

        let mut missing_plugin = agent.channels[0].clone();
        missing_plugin.openclaw_plugin_id = None;
        assert!(!should_report_missing_configured_channel(
            &agent,
            &missing_plugin
        ));
    }

    #[test]
    fn configured_channel_status_from_state_reports_startable_missing_channel() {
        let mut agents = agent_config_with_weixin_channel(true);
        let agent = agents.remove(0);
        let channel = agent.channels[0].clone();

        let status = super::commands::configured_channel_status_from_state(
            &agent,
            &channel,
            types::ImHealthState::default(),
        )
        .expect("startable missing channel should be reported");

        assert_eq!(status.channel_id, "weixin");
        assert_eq!(status.status, types::ImStatus::Connecting);
        assert!(status.error_message.is_none());
    }

    #[test]
    fn configured_channel_status_from_state_skips_disabled_or_uncredentialed_channel() {
        let mut agents = agent_config_with_weixin_channel(true);
        let agent = agents.remove(0);
        let mut channel = agent.channels[0].clone();

        channel.enabled = false;
        assert!(super::commands::configured_channel_status_from_state(
            &agent,
            &channel,
            types::ImHealthState::default()
        )
        .is_none());

        let mut missing_plugin = agent.channels[0].clone();
        missing_plugin.openclaw_plugin_id = None;
        assert!(super::commands::configured_channel_status_from_state(
            &agent,
            &missing_plugin,
            types::ImHealthState::default()
        )
        .is_none());
    }

    #[test]
    fn configured_channel_status_from_state_preserves_startable_error() {
        let mut agents = agent_config_with_weixin_channel(true);
        let agent = agents.remove(0);
        let channel = agent.channels[0].clone();
        let mut health_state = types::ImHealthState::default();
        health_state.status = types::ImStatus::Error;
        health_state.error_message = Some("bridge failed".to_string());

        let status =
            super::commands::configured_channel_status_from_state(&agent, &channel, health_state)
                .expect("startable missing channel error should be reported");

        assert_eq!(status.status, types::ImStatus::Error);
        assert_eq!(status.error_message.as_deref(), Some("bridge failed"));
    }
}

/// Auto-start all enabled IM Bots.
/// Called from Tauri `setup` with a short delay to let the app initialize.
pub fn schedule_auto_start<R: Runtime>(app_handle: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        // Give the app time to fully initialize (Sidecar manager, etc.)
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let configs = read_im_configs_from_disk();
        if configs.is_empty() {
            return;
        }

        use tauri::Manager;
        let im_state = app_handle.state::<ManagedImBots>();
        let sidecar_manager = app_handle.state::<ManagedSidecarManager>();

        for (bot_id, config) in configs {
            let has_credentials = im_config_has_start_credentials(&config);
            if config.enabled && has_credentials {
                ulog_info!("[im] Auto-starting bot: {}", bot_id);
                match start_im_bot(
                    &app_handle,
                    &im_state,
                    &sidecar_manager,
                    bot_id.clone(),
                    config,
                )
                .await
                {
                    Ok(_) => ulog_info!("[im] Auto-start succeeded for bot {}", bot_id),
                    Err(e) => ulog_warn!("[im] Auto-start failed for bot {}: {}", bot_id, e),
                }
            }
        }
    });
}

/// Read IM bot configs from ~/.myagents/config.json
/// Returns (bot_id, config) pairs for all enabled bots.
///
/// Recovery chain (mirrors frontend safeLoadJson):
///   1. config.json — current version
///   2. config.json.bak — previous known-good version
///   3. config.json.tmp — in-progress write
pub(super) fn read_im_configs_from_disk() -> Vec<(String, ImConfig)> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let config_dir = home.join(".myagents");
    let main_path = config_dir.join("config.json");

    // Try main → .bak → .tmp (same order as frontend safeLoadJson)
    let candidates = [
        main_path.clone(),
        config_dir.join("config.json.bak"),
        config_dir.join("config.json.tmp"),
    ];

    for (i, path) in candidates.iter().enumerate() {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let label = ["main", "bak", "tmp"][i];
        // Repair stringified-JSON fields persisted as raw objects (issue #301)
        // before the strict parse — PartialAppConfig also deserializes
        // `agents: Vec<AgentConfigRust>`, so an object `providerEnvJson` on any
        // agent would otherwise fail this whole parse too.
        let app_config: PartialAppConfig =
            match serde_json::from_str::<serde_json::Value>(strip_bom(&content))
                .map_err(|e| e.to_string())
                .and_then(|mut value| {
                    normalize_stringified_json_value(&mut value);
                    serde_json::from_value::<PartialAppConfig>(value).map_err(|e| e.to_string())
                }) {
                Ok(c) => c,
                Err(e) => {
                    ulog_warn!("[im] Config {} file corrupted, trying next: {}", label, e);
                    continue;
                }
            };

        if i > 0 {
            ulog_warn!("[im] Recovered config from {} file", label);
        }

        return parse_bot_entries(app_config);
    }

    Vec::new()
}

/// Extract (bot_id, config) pairs from parsed config.
/// Migrates missing `provider_env_json` from `provider_api_keys` + preset baseUrl map.
/// Skips bots whose IDs also appear as agent channel IDs (to prevent double auto-start).
fn parse_bot_entries(app_config: PartialAppConfig) -> Vec<(String, ImConfig)> {
    // Build set of channel IDs owned by agents — these will be started by schedule_agent_auto_start
    let agent_channel_ids: std::collections::HashSet<String> = app_config
        .agents
        .iter()
        .flat_map(|a| a.channels.iter().map(|ch| ch.id.clone()))
        .collect();

    let api_keys = app_config.provider_api_keys;
    let mut entries: Vec<(String, ImConfig)> = if let Some(bots) = app_config.im_bot_configs {
        bots.into_iter()
            .filter_map(|entry| {
                let id = entry.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                if agent_channel_ids.contains(&id) {
                    ulog_debug!("[im] Skipping legacy bot {} (owned by agent)", id);
                    None
                } else {
                    Some((id, entry.config))
                }
            })
            .collect()
    } else if let Some(entry) = app_config.im_bot_config {
        let id = entry.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if agent_channel_ids.contains(&id) {
            Vec::new()
        } else {
            vec![(id, entry.config)]
        }
    } else {
        Vec::new()
    };

    // Migration: rebuild providerEnvJson for bots that have providerId but no providerEnvJson
    for (_id, config) in &mut entries {
        migrate_provider_env(config, &api_keys);
    }

    entries
}

/// Backward-compat migration: if a bot has `provider_id` set but `provider_env_json` is missing,
/// reconstruct it from `providerApiKeys` + preset provider baseUrl map.
/// This handles existing configs created before providerEnvJson persistence was added.
fn migrate_provider_env(
    config: &mut ImConfig,
    api_keys: &std::collections::HashMap<String, String>,
) {
    if config.provider_env_json.is_some() {
        return; // Already set
    }
    let provider_id = match &config.provider_id {
        Some(id) if !id.is_empty() && !id.contains("sub") => id.clone(),
        _ => return, // Subscription or no provider
    };
    let api_key = match api_keys.get(&provider_id) {
        Some(key) if !key.is_empty() => key,
        _ => return, // No API key available
    };
    let meta = match preset_provider_meta(&provider_id) {
        Some(m) => m,
        None => {
            ulog_warn!(
                "[im] Cannot migrate providerEnvJson for unknown provider '{}' — manual restart required",
                provider_id
            );
            return;
        }
    };
    let mut env = serde_json::json!({
        "baseUrl": meta.base_url,
        "apiKey": api_key,
        "authType": meta.auth_type,
    });
    if let Some(proto) = meta.api_protocol {
        env["apiProtocol"] = serde_json::json!(proto);
    }
    config.provider_env_json = Some(env.to_string());
    ulog_info!(
        "[im] Migrated providerEnvJson for provider '{}' from providerApiKeys",
        provider_id
    );
}

fn provider_env_json_for_provider(
    provider_id: &str,
    api_keys: &std::collections::HashMap<String, String>,
) -> Option<String> {
    if provider_id.is_empty() || provider_id.contains("sub") {
        return None;
    }
    let api_key = api_keys.get(provider_id).filter(|k| !k.is_empty())?;
    let meta = preset_provider_meta(provider_id)?;
    let mut env = serde_json::json!({
        "baseUrl": meta.base_url,
        "apiKey": api_key,
        "authType": meta.auth_type,
    });
    if let Some(proto) = meta.api_protocol {
        env["apiProtocol"] = serde_json::json!(proto);
    }
    Some(env.to_string())
}

/// Backward-compat migration for Agent configs: rebuild missing `provider_env_json`
/// on both the agent level and each channel's overrides.
/// Uses the same preset baseUrl map as `migrate_provider_env`.
fn migrate_agent_provider_env(
    agent: &mut AgentConfigRust,
    api_keys: &std::collections::HashMap<String, String>,
) {
    // 1. Migrate agent-level providerEnvJson
    if agent.provider_env_json.is_none() {
        if let Some(ref pid) = agent.provider_id {
            if let Some(env) = provider_env_json_for_provider(pid, api_keys) {
                agent.provider_env_json = Some(env);
                ulog_info!(
                    "[agent] Migrated agent-level providerEnvJson for provider '{}'",
                    pid
                );
            }
        }
    }

    // 2. Migrate each channel's overrides.providerEnvJson
    for ch in &mut agent.channels {
        if let Some(ref mut ov) = ch.overrides {
            if ov.provider_env_json.is_none() {
                if let Some(ref pid) = ov.provider_id {
                    if let Some(env) = provider_env_json_for_provider(pid, api_keys) {
                        ov.provider_env_json = Some(env);
                        ulog_info!(
                            "[agent] Migrated channel override providerEnvJson for provider '{}'",
                            pid
                        );
                    }
                }
            }
        }
    }
}

fn provider_env_json_missing(
    obj: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> bool {
    !matches!(obj.get(field), Some(serde_json::Value::String(s)) if !s.is_empty())
}

fn migrate_provider_env_json_field(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    provider_field: &str,
    env_field: &str,
    api_keys: &std::collections::HashMap<String, String>,
    emit_logs: bool,
    log_prefix: &str,
) -> bool {
    if !provider_env_json_missing(obj, env_field) {
        return false;
    }
    let Some(provider_id) = obj
        .get(provider_field)
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return false;
    };
    let Some(env) = provider_env_json_for_provider(&provider_id, api_keys) else {
        return false;
    };

    obj.insert(env_field.to_string(), serde_json::Value::String(env));
    if emit_logs {
        ulog_info!(
            "[agent] Migrated {} providerEnvJson for provider '{}'",
            log_prefix,
            provider_id
        );
    }
    true
}

/// Rebuild missing Agent `providerEnvJson` fields at the raw JSON layer.
///
/// The typed fallback in `migrate_agent_provider_env()` keeps old callers safe,
/// but doing the migration on `serde_json::Value` lets `read_agent_configs_from_disk`
/// persist the healed config once. Without this, status polling re-read the same
/// missing fields every 5s and logged the migration thousands of times.
fn migrate_agent_provider_env_value(
    value: &mut serde_json::Value,
    api_keys: &std::collections::HashMap<String, String>,
    emit_logs: bool,
) -> bool {
    let mut changed = false;
    if let Some(agents) = value.get_mut("agents").and_then(|v| v.as_array_mut()) {
        for agent in agents.iter_mut() {
            let Some(obj) = agent.as_object_mut() else {
                continue;
            };
            changed |= migrate_provider_env_json_field(
                obj,
                "providerId",
                "providerEnvJson",
                api_keys,
                emit_logs,
                "agent-level",
            );

            if let Some(channels) = obj.get_mut("channels").and_then(|v| v.as_array_mut()) {
                for ch in channels.iter_mut() {
                    if let Some(ov) = ch.get_mut("overrides").and_then(|v| v.as_object_mut()) {
                        changed |= migrate_provider_env_json_field(
                            ov,
                            "providerId",
                            "providerEnvJson",
                            api_keys,
                            emit_logs,
                            "channel override",
                        );
                    }
                }
            }
        }
    }
    changed
}

/// Preset provider metadata for migration: (baseUrl, authType, apiProtocol).
/// Must match PRESET_PROVIDERS in src/renderer/config/types.ts.
struct PresetProviderMeta {
    base_url: &'static str,
    auth_type: &'static str,
    api_protocol: Option<&'static str>, // None = anthropic (default), Some("openai") = OpenAI bridge
}

fn preset_provider_meta(provider_id: &str) -> Option<PresetProviderMeta> {
    match provider_id {
        "anthropic-api" => Some(PresetProviderMeta {
            base_url: "https://api.anthropic.com",
            auth_type: "both",
            api_protocol: None,
        }),
        "deepseek" => Some(PresetProviderMeta {
            base_url: "https://api.deepseek.com/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "moonshot" => Some(PresetProviderMeta {
            base_url: "https://api.moonshot.cn/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "zhipu" => Some(PresetProviderMeta {
            base_url: "https://open.bigmodel.cn/api/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "minimax" => Some(PresetProviderMeta {
            base_url: "https://api.minimaxi.com/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "google-gemini" => Some(PresetProviderMeta {
            base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
            auth_type: "api_key",
            api_protocol: Some("openai"),
        }),
        "volcengine" => Some(PresetProviderMeta {
            base_url: "https://ark.cn-beijing.volces.com/api/coding",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "volcengine-api" => Some(PresetProviderMeta {
            base_url: "https://ark.cn-beijing.volces.com/api/compatible",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "siliconflow" => Some(PresetProviderMeta {
            base_url: "https://api.siliconflow.cn/",
            auth_type: "api_key",
            api_protocol: None,
        }),
        "zenmux" => Some(PresetProviderMeta {
            base_url: "https://zenmux.ai/api/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "aliyun-bailian-coding" => Some(PresetProviderMeta {
            base_url: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "openrouter" => Some(PresetProviderMeta {
            base_url: "https://openrouter.ai/api",
            auth_type: "auth_token_clear_api_key",
            api_protocol: None,
        }),
        _ => None,
    }
}

// ===== Agent Config Disk Read/Write (v0.1.41) =====

/// Coerce "stringified JSON" config fields (`providerEnvJson`, `mcpServersJson`)
/// that were persisted as raw JSON objects/arrays back into strings, at the
/// `serde_json::Value` level, BEFORE strict typed deserialization.
///
/// `AgentConfigRust` declares these as `Option<String>` (they hold a *serialized*
/// JSON blob). A legacy write path or a hand-edit can leave one as an object,
/// which makes a strict parse fail with `invalid type: map, expected a string`
/// (issue #301) — that single bad field would otherwise blank the WHOLE config
/// parse and stop ALL agent channels from auto-starting. Stringifying the object
/// is lossless: it is exactly what the string is meant to contain.
///
/// MUST stay in sync with the TypeScript twin `normalizeStringifiedJsonFields`
/// (`src/renderer/config/services/configNormalize.ts`). Shared regression
/// fixture: `src/shared/__fixtures__/dirtyConfig301.json`.
fn normalize_stringified_json_value(value: &mut serde_json::Value) -> bool {
    // Object/array → stringify (the field's intended serialized form);
    // other non-string scalars (number/bool) → drop (not a valid blob, and
    // feeding a bogus string to a downstream parse just moves the failure).
    // String / null / absent → leave untouched. Mirrors the TS twin's
    // `coerceJsonStringField` exactly.
    fn coerce(obj: &mut serde_json::Map<String, serde_json::Value>, field: &str) -> bool {
        // Compute the action while the immutable borrow from `get` is live, then
        // mutate after it ends (the bool result holds no borrow).
        if matches!(
            obj.get(field),
            Some(serde_json::Value::Object(_)) | Some(serde_json::Value::Array(_))
        ) {
            let stringified = obj.get(field).unwrap().to_string();
            obj.insert(field.to_string(), serde_json::Value::String(stringified));
            true
        } else if matches!(
            obj.get(field),
            Some(serde_json::Value::Number(_)) | Some(serde_json::Value::Bool(_))
        ) {
            obj.remove(field);
            true
        } else {
            false
        }
    }

    let mut changed = false;
    if let Some(agents) = value.get_mut("agents").and_then(|v| v.as_array_mut()) {
        for agent in agents.iter_mut() {
            let Some(obj) = agent.as_object_mut() else {
                continue;
            };
            changed |= coerce(obj, "providerEnvJson");
            changed |= coerce(obj, "mcpServersJson");
            if let Some(channels) = obj.get_mut("channels").and_then(|v| v.as_array_mut()) {
                for ch in channels.iter_mut() {
                    if let Some(ov) = ch.get_mut("overrides").and_then(|v| v.as_object_mut()) {
                        changed |= coerce(ov, "providerEnvJson");
                    }
                }
            }
        }
    }
    changed
}

/// Promote selected custom MCP definitions stranded in `agents[].mcpServersJson`
/// into the global `mcpServers` registry.
///
/// Agent channel self-resolve treats the global registry + global enabled list
/// as the authoritative MCP catalogue. The Agent's `mcpEnabledServers` is only
/// a per-Agent subset. A legacy renderer path could persist the subset and a
/// stringified per-Agent runtime payload without adding the remote HTTP/SSE
/// definition to the global layer, so cold-start saw `mcp=none` even though the
/// Agent row looked enabled (issue #398).
///
/// Mirrors the TypeScript twin `promoteAgentMcpJsonToGlobal`. We only enable IDs
/// recovered into the global catalogue in this pass; if a known global server is
/// disabled globally, this load-boundary heal must not silently re-enable it.
fn promote_agent_mcp_json_to_global_value(value: &mut serde_json::Value) -> bool {
    let Some(agents) = value.get("agents").and_then(|v| v.as_array()) else {
        return false;
    };

    let mut known_ids: std::collections::HashSet<String> = value
        .get("mcpServers")
        .and_then(|v| v.as_array())
        .map(|servers| {
            servers
                .iter()
                .filter_map(|server| {
                    server
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    let mut global_enabled: std::collections::HashSet<String> = value
        .get("mcpEnabledServers")
        .and_then(|v| v.as_array())
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let mut recovered_servers = Vec::new();
    let mut recovered_enabled_ids = Vec::new();

    for agent in agents {
        let Some(agent_obj) = agent.as_object() else {
            continue;
        };
        let Some(agent_enabled) = agent_obj
            .get("mcpEnabledServers")
            .and_then(|v| v.as_array())
        else {
            continue;
        };
        let selected_ids: std::collections::HashSet<String> = agent_enabled
            .iter()
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect();
        if selected_ids.is_empty() {
            continue;
        }

        let Some(raw_servers) = agent_obj.get("mcpServersJson").and_then(|v| v.as_str()) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw_servers) else {
            continue;
        };
        let Some(servers) = parsed.as_array() else {
            continue;
        };

        for server in servers {
            let Some(server_obj) = server.as_object() else {
                continue;
            };
            let Some(id) = server_obj.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(server_type) = server_obj.get("type").and_then(|v| v.as_str()) else {
                continue;
            };
            let has_required_shape = server_obj.get("name").and_then(|v| v.as_str()).is_some()
                && matches!(server_type, "http" | "sse")
                && server_obj
                    .get("url")
                    .and_then(|v| v.as_str())
                    .is_some_and(|url| !url.is_empty());
            if !has_required_shape
                || !selected_ids.contains(id)
                || known_ids.contains(id)
                || server_obj
                    .get("isBuiltin")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            {
                continue;
            }

            let id = id.to_string();
            let mut normalized = server.clone();
            if let Some(obj) = normalized.as_object_mut() {
                obj.insert("isBuiltin".to_string(), serde_json::Value::Bool(false));
            }
            recovered_servers.push(normalized);
            known_ids.insert(id.clone());
            if global_enabled.insert(id.clone()) {
                recovered_enabled_ids.push(id);
            }
        }
    }

    if recovered_servers.is_empty() {
        return false;
    }

    let Some(root) = value.as_object_mut() else {
        return false;
    };
    let servers_value = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    if !servers_value.is_array() {
        *servers_value = serde_json::Value::Array(Vec::new());
    }
    if let Some(servers) = servers_value.as_array_mut() {
        servers.extend(recovered_servers);
    }

    let enabled_value = root
        .entry("mcpEnabledServers".to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    if !enabled_value.is_array() {
        *enabled_value = serde_json::Value::Array(Vec::new());
    }
    if let Some(enabled) = enabled_value.as_array_mut() {
        for id in recovered_enabled_ids {
            enabled.push(serde_json::Value::String(id));
        }
    }

    true
}

/// Parse `agents[]` from an already-normalized config Value into typed
/// `AgentConfigRust`, salvaging individually-valid entries so one malformed
/// agent can't blank the whole fleet's auto-start (the failure class that made
/// #301 severe).
///
/// Returns:
///   - `Some(vec)` — the agents to use. `vec` is empty when `agents` is absent
///     or an empty array (legitimately "no agents"; the caller should NOT fall
///     through to a recovery candidate — that matches legacy behaviour).
///   - `None` — `agents` is present but unusable (not an array, or every entry
///     failed a strict parse). The caller should try the next recovery candidate
///     (.bak/.tmp) rather than accept an empty fleet.
fn salvage_agents_from_value(
    value: &serde_json::Value,
    api_keys: &std::collections::HashMap<String, String>,
) -> Option<Vec<AgentConfigRust>> {
    match value.get("agents") {
        // Absent → no agents configured; nothing to recover.
        None => Some(Vec::new()),
        Some(serde_json::Value::Array(arr)) => {
            if arr.is_empty() {
                return Some(Vec::new());
            }
            let mut agents: Vec<AgentConfigRust> = Vec::with_capacity(arr.len());
            for (ai, a) in arr.iter().enumerate() {
                match serde_json::from_value::<AgentConfigRust>(a.clone()) {
                    Ok(mut agent) => {
                        // Rebuild providerEnvJson for agents/channels that have a
                        // providerId but no providerEnvJson (same as
                        // parse_bot_entries does for legacy bots).
                        migrate_agent_provider_env(&mut agent, api_keys);
                        agents.push(agent);
                    }
                    Err(e) => {
                        ulog_warn!("[agent] Skipping malformed agent[{}]: {}", ai, e);
                    }
                }
            }
            // Every entry failed → treat this candidate as unusable so the caller
            // can fall through to a recovery file.
            if agents.is_empty() {
                None
            } else {
                Some(agents)
            }
        }
        // `agents` present but not an array → corrupt shape → recover.
        Some(_) => None,
    }
}

fn persist_agent_config_read_heal(config_path: &Path, reason: &str) {
    let mut changed_under_lock = false;
    let result = with_config_lock(config_path, true, |config| {
        let mut healed = config.clone();
        let normalized = normalize_stringified_json_value(&mut healed);
        let api_keys: std::collections::HashMap<String, String> = config
            .get("providerApiKeys")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let migrated_provider_env = migrate_agent_provider_env_value(&mut healed, &api_keys, false);
        let promoted_mcp = promote_agent_mcp_json_to_global_value(&mut healed);
        if !(normalized || migrated_provider_env || promoted_mcp) {
            return Ok(());
        }

        if salvage_agents_from_value(&healed, &api_keys).is_none() {
            ulog_warn!(
                "[agent] Skipped config read-time heal because main agents[] is unusable: {}",
                reason
            );
            return Ok(());
        }

        *config = healed;
        changed_under_lock = true;
        Ok(())
    });

    match result {
        Ok(_) if changed_under_lock => {
            ulog_info!("[agent] Persisted config read-time heal: {}", reason);
        }
        Ok(_) => {}
        Err(e) => {
            ulog_warn!(
                "[agent] Failed to persist config read-time heal ({}): {}",
                reason,
                e
            );
        }
    }
}

/// Read Agent configs from disk. Falls back to reading imBotConfigs and converting.
pub(super) fn read_agent_configs_from_disk() -> Vec<AgentConfigRust> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let config_dir = home.join(".myagents");
    let main_path = config_dir.join("config.json");

    let candidates = [
        main_path.clone(),
        config_dir.join("config.json.bak"),
        config_dir.join("config.json.tmp"),
    ];

    for (i, path) in candidates.iter().enumerate() {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let label = ["main", "bak", "tmp"][i];
        // Parse loosely first so we can repair stringified-JSON fields persisted
        // as raw objects (issue #301) BEFORE the strict typed parse below.
        let mut value: serde_json::Value = match serde_json::from_str(strip_bom(&content)) {
            Ok(v) => v,
            Err(e) => {
                ulog_warn!(
                    "[agent] Config {} file corrupted (invalid JSON), trying next: {}",
                    label,
                    e
                );
                continue;
            }
        };
        let normalized = normalize_stringified_json_value(&mut value);

        let api_keys: std::collections::HashMap<String, String> = value
            .get("providerApiKeys")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let migrated_provider_env = migrate_agent_provider_env_value(&mut value, &api_keys, true);
        let promoted_mcp = promote_agent_mcp_json_to_global_value(&mut value);

        match salvage_agents_from_value(&value, &api_keys) {
            Some(agents) => {
                if i == 0 && (normalized || migrated_provider_env || promoted_mcp) {
                    let mut reasons = Vec::new();
                    if normalized {
                        reasons.push("stringified JSON normalization");
                    }
                    if migrated_provider_env {
                        reasons.push("providerEnvJson migration");
                    }
                    if promoted_mcp {
                        reasons.push("Agent MCP global registry promotion");
                    }
                    let reason = reasons.join(" + ");
                    persist_agent_config_read_heal(&main_path, &reason);
                }
                if i > 0 {
                    ulog_warn!("[agent] Recovered config from {} file", label);
                }
                return agents;
            }
            None => {
                // `agents` is present but unusable (not an array, or every entry
                // failed a strict parse). Fall through to the next recovery
                // candidate (.bak/.tmp), mirroring the pre-#301 behaviour.
                ulog_warn!(
                    "[agent] {} config has no usable agents, trying next candidate",
                    label
                );
                continue;
            }
        }
    }

    Vec::new()
}

/// Persist a partial patch to a single agent's entry in `~/.myagents/config.json`.
#[allow(dead_code)] // Kept for potential future use; disk persistence now done by TypeScript service
pub(super) fn persist_agent_config_patch(
    agent_id: &str,
    patch: &AgentConfigPatch,
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("[agent] Home dir not found")?;
    let config_path = home.join(".myagents").join("config.json");

    with_config_lock(&config_path, true, |config| {
        let agents = config
            .get_mut("agents")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| "[agent] No agents[] in config.json".to_string())?;
        let agent = agents
            .iter_mut()
            .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(agent_id))
            .ok_or_else(|| format!("[agent] Agent {} not found in config.json", agent_id))?;

        // Apply patch fields
        macro_rules! apply_field {
            ($field:ident, $key:expr) => {
                if let Some(ref val) = patch.$field {
                    agent[$key] = serde_json::json!(val);
                }
            };
        }
        apply_field!(name, "name");
        apply_field!(icon, "icon");
        apply_field!(enabled, "enabled");
        apply_field!(provider_id, "providerId");
        apply_field!(model, "model");
        apply_field!(provider_env_json, "providerEnvJson");
        apply_field!(permission_mode, "permissionMode");
        apply_field!(mcp_enabled_servers, "mcpEnabledServers");
        apply_field!(runtime, "runtime");
        apply_field!(setup_completed, "setupCompleted");

        if let Some(ref runtime_config) = patch.runtime_config {
            match runtime_config {
                Some(value) => agent["runtimeConfig"] = value.clone(),
                None => {
                    if let Some(obj) = agent.as_object_mut() {
                        obj.remove("runtimeConfig");
                    }
                }
            }
        }

        if let Some(ref channels) = patch.channels {
            agent["channels"] = serde_json::to_value(channels)
                .map_err(|e| format!("[agent] Failed to serialize channels: {}", e))?;
        }

        if let Some(ref hb_json) = patch.heartbeat_config_json {
            if !hb_json.is_empty() && hb_json != "null" {
                if let Ok(hb) = serde_json::from_str::<serde_json::Value>(hb_json) {
                    agent["heartbeat"] = hb;
                }
            }
        }
        Ok(())
    })?;

    ulog_info!("[agent] Persisted config patch for agent {}", agent_id);
    Ok(())
}

/// Resolve which channel to use for proactive messages (heartbeat/cron).
/// Fallback chain:
/// 1. lastActiveChannel if that channel is enabled + connected (Online status)
/// 2. Any other channel with active sessions and Online status
/// 3. First enabled channel with Online status (no history needed)
/// 4. None — no available channel
pub(super) fn resolve_target_channel(
    agent: &AgentInstance,
    agent_statuses: &HashMap<String, ChannelStatus>,
) -> Option<String> {
    // Helper: check if a channel is online
    let is_online = |ch_id: &str| -> bool {
        agent_statuses
            .get(ch_id)
            .map_or(false, |s| s.status == ImStatus::Online)
    };

    // 1. Try lastActiveChannel
    if let Ok(guard) = agent.last_active_channel.try_read() {
        if let Some(ref lac) = *guard {
            if is_online(&lac.channel_id) {
                return Some(lac.channel_id.clone());
            }
        }
    }

    // 2. Find any channel with active sessions and Online status
    for (ch_id, status) in agent_statuses {
        if status.status == ImStatus::Online && !status.active_sessions.is_empty() {
            return Some(ch_id.clone());
        }
    }

    // 3. First enabled channel with Online status (even without sessions)
    for (ch_id, status) in agent_statuses {
        if status.status == ImStatus::Online {
            return Some(ch_id.clone());
        }
    }

    // 4. No available channel
    None
}

/// Build channel statuses from a running AgentInstance (async helper for heartbeat).
/// Build channel statuses using clone-then-collect pattern (caller should NOT hold ManagedAgents lock).
/// Auto-start all enabled Agent channels.
/// Called from schedule_auto_start after the legacy IM bot startup.
pub fn schedule_agent_auto_start<R: Runtime>(app_handle: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        // Give the app time to fully initialize
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;

        let agents = read_agent_configs_from_disk();
        if agents.is_empty() {
            return;
        }

        use tauri::Manager;
        let agent_state = app_handle.state::<ManagedAgents>();
        let sidecar_manager = app_handle.state::<ManagedSidecarManager>();

        for agent_config in agents {
            if !agent_config.enabled {
                continue;
            }

            // Shared last_active_channel Arc for this agent (all channels share it)
            let shared_lac: Arc<RwLock<Option<LastActiveChannel>>> =
                Arc::new(RwLock::new(agent_config.last_active_channel.clone()));

            let mut started_channel_ids: Vec<String> = Vec::new();

            for channel in &agent_config.channels {
                if !channel.enabled {
                    continue;
                }
                let mut im_config = channel.to_im_config(&agent_config);
                // Suppress per-channel heartbeat interval — agent-level heartbeat controls timing.
                im_config.heartbeat_config = Some(types::HeartbeatConfig {
                    enabled: false,
                    ..types::HeartbeatConfig::default()
                });

                let has_credentials = im_config_has_start_credentials(&im_config);
                if has_credentials {
                    let agent_channel_permission_mode = im_config.permission_mode.clone();
                    let bot_id = channel.id.clone();
                    // Dedup: skip if channel already running (and healthy) in agent state.
                    // If channel exists but is Error/Stopped, remove it to allow restart.
                    {
                        let mut agents_guard = agent_state.lock().await;
                        if let Some(agent) = agents_guard.get_mut(&agent_config.id) {
                            if agent.channels.contains_key(&bot_id) {
                                let is_dead = {
                                    let ch = agent.channels.get(&bot_id).unwrap();
                                    let health_state = ch.bot_instance.health.get_state().await;
                                    matches!(
                                        health_state.status,
                                        types::ImStatus::Error | types::ImStatus::Stopped
                                    )
                                };
                                if is_dead {
                                    ulog_info!("[agent] Channel {} in agent {} is dead, removing for auto-restart", bot_id, agent_config.id);
                                    agent.channels.remove(&bot_id);
                                } else {
                                    ulog_info!("[agent] Channel {} already running in agent {}, skipping auto-start", bot_id, agent_config.id);
                                    continue;
                                }
                            }
                        }
                    }
                    ulog_info!(
                        "[agent] Auto-starting channel {} of agent {}",
                        bot_id,
                        agent_config.id
                    );
                    // Create bot instance directly (no transit through ManagedImBots)
                    match create_bot_instance(
                        &app_handle,
                        &sidecar_manager,
                        bot_id.clone(),
                        im_config,
                        Some(agent_config.id.clone()),
                    )
                    .await
                    {
                        Ok((bot_instance, _bot_status)) => {
                            ulog_info!("[agent] Auto-start succeeded for channel {}", bot_id);
                            // Register channel directly in agent state
                            let mut agents_guard = agent_state.lock().await;
                            let agent_instance = agents_guard
                                .entry(agent_config.id.clone())
                                .or_insert_with(|| AgentInstance {
                                    agent_id: agent_config.id.clone(),
                                    config: agent_config.clone(),
                                    channels: HashMap::new(),
                                    last_active_channel: Arc::clone(&shared_lac),
                                    heartbeat_handle: None,
                                    heartbeat_wake_tx: None,
                                    heartbeat_config: None,
                                    current_model: Arc::new(RwLock::new(
                                        agent_config.model.clone(),
                                    )),
                                    current_provider_env: Arc::new(RwLock::new(
                                        agent_config
                                            .provider_env_json
                                            .as_ref()
                                            .and_then(|s| serde_json::from_str(s).ok()),
                                    )),
                                    permission_mode: Arc::new(RwLock::new(
                                        agent_channel_permission_mode.clone(),
                                    )),
                                    mcp_servers_json: Arc::new(RwLock::new(
                                        agent_config.mcp_servers_json.clone(),
                                    )),
                                    runtime: Arc::new(RwLock::new(normalize_runtime_type(
                                        agent_config.runtime.as_deref(),
                                    ))),
                                    runtime_config: Arc::new(RwLock::new(
                                        agent_config.runtime_config.clone(),
                                    )),
                                    memory_update_config: None,
                                    memory_update_running: None,
                                });
                            // Set agent_link so the processing loop can update lastActiveChannel
                            let link = AgentChannelLink {
                                channel_id: channel.id.clone(),
                                agent_id: agent_config.id.clone(),
                                last_active_channel: Arc::clone(&shared_lac),
                                runtime_config: Arc::clone(&agent_instance.runtime_config),
                            };
                            *bot_instance.agent_link.write().await = Some(link);

                            agent_instance.channels.insert(
                                channel.id.clone(),
                                ChannelInstance {
                                    channel_id: channel.id.clone(),
                                    bot_instance,
                                },
                            );
                            started_channel_ids.push(channel.id.clone());
                            drop(agents_guard);
                        }
                        Err(e) => {
                            ulog_warn!("[agent] Auto-start failed for channel {}: {}", bot_id, e)
                        }
                    }
                }
            }

            // Start agent-level heartbeat if configured and at least one channel started
            if !started_channel_ids.is_empty() {
                let hb_config = agent_config.heartbeat.clone().unwrap_or_default();
                let agent_id = agent_config.id.clone();
                let agent_label = agent_config.name.clone();
                let agent_state_for_hb = Arc::clone(&*agent_state);
                let (wake_tx, mut wake_rx) = mpsc::channel::<types::WakeReason>(64);
                let hb_config_arc = Arc::new(RwLock::new(hb_config));
                let hb_config_for_loop = Arc::clone(&hb_config_arc);
                // Memory auto-update arcs (v0.1.43)
                let mau_config_arc = Arc::new(RwLock::new(agent_config.memory_auto_update.clone()));
                let mau_running_arc = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let mau_config_for_loop = Arc::clone(&mau_config_arc);
                let mau_running_for_loop = Arc::clone(&mau_running_arc);
                let mau_workspace = agent_config.workspace_path.clone();
                let mau_agent_id = agent_config.id.clone();
                let mau_sidecar_mgr = Arc::clone(&*sidecar_manager);
                let mau_app_handle = app_handle.clone();
                // Clone agent-level AI config Arcs from AgentInstance
                let (mau_model, mau_provider_env, mau_mcp_json) = {
                    let agents_guard = agent_state.lock().await;
                    if let Some(inst) = agents_guard.get(&agent_config.id) {
                        (
                            Arc::clone(&inst.current_model),
                            Arc::clone(&inst.current_provider_env),
                            Arc::clone(&inst.mcp_servers_json),
                        )
                    } else {
                        // Agent instance not found (shouldn't happen), use defaults
                        (
                            Arc::new(RwLock::new(agent_config.model.clone())),
                            Arc::new(RwLock::new(None)),
                            Arc::new(RwLock::new(agent_config.mcp_servers_json.clone())),
                        )
                    }
                };

                let hb_handle = tauri::async_runtime::spawn(async move {
                    use heartbeat::is_in_active_hours;

                    let initial_interval = {
                        let cfg = hb_config_for_loop.read().await;
                        Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60)
                    };
                    let mut interval = tokio::time::interval(initial_interval);
                    interval.tick().await; // skip first immediate tick

                    ulog_info!(
                        "[agent-heartbeat] Runner started for agent {} (interval={}min)",
                        agent_label,
                        initial_interval.as_secs() / 60
                    );

                    loop {
                        // Check if interval needs updating
                        {
                            let cfg = hb_config_for_loop.read().await;
                            let desired =
                                Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60);
                            if desired != interval.period() {
                                ulog_info!(
                                    "[agent-heartbeat] Interval changed to {}min",
                                    desired.as_secs() / 60
                                );
                                interval = tokio::time::interval(desired);
                                interval.tick().await;
                            }
                        }

                        let reason = tokio::select! {
                            _ = interval.tick() => types::WakeReason::Interval,
                            Some(reason) = wake_rx.recv() => {
                                // Coalesce: drain additional signals within 250ms
                                let mut reasons = vec![reason];
                                tokio::time::sleep(Duration::from_millis(250)).await;
                                while let Ok(r) = wake_rx.try_recv() {
                                    reasons.push(r);
                                }
                                reasons.into_iter()
                                    .max_by_key(|r| if r.is_high_priority() { 1 } else { 0 })
                                    .unwrap_or(types::WakeReason::Interval)
                            }
                        };

                        let is_high_priority = reason.is_high_priority();

                        // Memory auto-update check (v0.1.43) — runs independently of heartbeat enabled
                        // Placed BEFORE heartbeat gate so memory update works even when heartbeat is off
                        {
                            let hb_tz = {
                                let cfg = hb_config_for_loop.read().await;
                                cfg.active_hours.as_ref().map(|ah| ah.timezone.clone())
                            };
                            memory_update::check_and_spawn(
                                &mau_agent_id,
                                &mau_workspace,
                                &mau_config_for_loop,
                                &mau_running_for_loop,
                                &mau_sidecar_mgr,
                                &mau_app_handle,
                                &mau_model,
                                &mau_provider_env,
                                &mau_mcp_json,
                                hb_tz.as_deref(),
                            )
                            .await;
                        }

                        // Gate: heartbeat enabled check
                        let config = hb_config_for_loop.read().await.clone();
                        if !config.enabled {
                            ulog_debug!("[agent-heartbeat] Skipped: disabled");
                            continue;
                        }

                        // Gate: active hours (high-priority wakes skip)
                        if !is_high_priority {
                            if let Some(ref active_hours) = config.active_hours {
                                if !is_in_active_hours(active_hours) {
                                    ulog_debug!("[agent-heartbeat] Skipped: outside active hours");
                                    continue;
                                }
                            }
                        }

                        // Clone refs from agent state, then drop the lock before async work
                        let channel_snapshot = {
                            let agents_guard = agent_state_for_hb.lock().await;
                            let agent = match agents_guard.get(&agent_id) {
                                Some(a) => a,
                                None => {
                                    ulog_debug!(
                                        "[agent-heartbeat] Agent {} not found, stopping",
                                        agent_id
                                    );
                                    break;
                                }
                            };
                            // Clone channel refs for status collection + wake_tx for delegation
                            let refs: Vec<_> = agent
                                .channels
                                .iter()
                                .map(|(ch_id, ch_inst)| {
                                    (
                                        ch_id.clone(),
                                        Arc::clone(&ch_inst.bot_instance.health),
                                        Arc::clone(&ch_inst.bot_instance.router),
                                        ch_inst.bot_instance.heartbeat_wake_tx.clone(),
                                        ch_inst.bot_instance.started_at,
                                        ch_inst.bot_instance.config.platform.clone(),
                                        ch_inst.bot_instance.config.name.clone(),
                                        ch_inst.bot_instance.bind_code.clone(),
                                    )
                                })
                                .collect();
                            let lac = Arc::clone(&agent.last_active_channel);
                            (refs, lac)
                        }; // agents_guard dropped here

                        // Build channel statuses without holding the Mutex
                        let (ch_refs, _lac) = channel_snapshot;
                        let mut statuses_map = HashMap::new();
                        let mut wake_txs: HashMap<String, mpsc::Sender<types::WakeReason>> =
                            HashMap::new();
                        for (
                            ch_id,
                            health,
                            router,
                            wake_tx,
                            started_at,
                            platform,
                            name,
                            bind_code,
                        ) in &ch_refs
                        {
                            let health_state = health.get_state().await;
                            let active_sessions = router.lock().await.active_sessions();
                            statuses_map.insert(
                                ch_id.clone(),
                                ChannelStatus {
                                    channel_id: ch_id.clone(),
                                    channel_type: platform.clone(),
                                    name: name.clone(),
                                    status: health_state.status,
                                    bot_username: health_state.bot_username,
                                    uptime_seconds: started_at.elapsed().as_secs(),
                                    last_message_at: health_state.last_message_at,
                                    active_sessions,
                                    error_message: health_state.error_message,
                                    restart_count: health_state.restart_count,
                                    buffered_messages: health_state.buffered_messages,
                                    bind_url: None,
                                    bind_code: Some(bind_code.clone()),
                                },
                            );
                            if let Some(tx) = wake_tx {
                                wake_txs.insert(ch_id.clone(), tx.clone());
                            }
                        }

                        // Re-acquire lock briefly to resolve target channel
                        let target_ch_id = {
                            let agents_guard = agent_state_for_hb.lock().await;
                            match agents_guard.get(&agent_id) {
                                Some(agent) => resolve_target_channel(agent, &statuses_map),
                                None => None,
                            }
                        };
                        let target_ch_id = match target_ch_id {
                            Some(id) => id,
                            None => {
                                ulog_debug!(
                                    "[agent-heartbeat] No available channel for agent {}",
                                    agent_id
                                );
                                continue;
                            }
                        };

                        // Delegate to the target channel's per-bot heartbeat wake_tx (no lock held)
                        let delegated_reason = if reason.is_high_priority() {
                            reason
                        } else {
                            types::WakeReason::Manual
                        };
                        if let Some(wake_tx) = wake_txs.get(&target_ch_id) {
                            let _ = wake_tx.send(delegated_reason).await;
                            ulog_debug!(
                                "[agent-heartbeat] Routed heartbeat to channel {} for agent {}",
                                target_ch_id,
                                agent_id
                            );
                        } else {
                            ulog_debug!(
                                "[agent-heartbeat] Channel {} has no heartbeat runner, skipping",
                                target_ch_id
                            );
                        }

                        // Reset interval after wake
                        if is_high_priority {
                            interval.reset();
                        }
                    }

                    ulog_info!("[agent-heartbeat] Runner stopped for agent {}", agent_label);
                });

                // Store heartbeat handles on the agent instance
                let mut agents_guard = agent_state.lock().await;
                if let Some(agent_instance) = agents_guard.get_mut(&agent_config.id) {
                    agent_instance.heartbeat_handle = Some(hb_handle);
                    agent_instance.heartbeat_wake_tx = Some(wake_tx);
                    agent_instance.heartbeat_config = Some(hb_config_arc);
                    agent_instance.memory_update_config = Some(mau_config_arc);
                    agent_instance.memory_update_running = Some(mau_running_arc);
                    ulog_info!(
                        "[agent] Agent-level heartbeat started for {}",
                        agent_config.id
                    );
                }
                drop(agents_guard);
            }
        }
    });
}

async fn ensure_agent_level_runners_started<R: Runtime>(
    app_handle: AppHandle<R>,
    agent_state: ManagedAgents,
    sidecar_manager: ManagedSidecarManager,
    agent_config: AgentConfigRust,
) {
    let should_start = {
        let agents_guard = agent_state.lock().await;
        agents_guard
            .get(&agent_config.id)
            .map(|agent| agent.heartbeat_handle.is_none() && !agent.channels.is_empty())
            .unwrap_or(false)
    };
    if !should_start {
        return;
    }

    let hb_config = agent_config.heartbeat.clone().unwrap_or_default();
    let agent_id = agent_config.id.clone();
    let agent_label = agent_config.name.clone();
    let agent_state_for_hb = Arc::clone(&agent_state);
    let (wake_tx, mut wake_rx) = mpsc::channel::<types::WakeReason>(64);
    let hb_config_arc = Arc::new(RwLock::new(hb_config));
    let hb_config_for_loop = Arc::clone(&hb_config_arc);

    let mau_config_arc = Arc::new(RwLock::new(agent_config.memory_auto_update.clone()));
    let mau_running_arc = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mau_config_for_loop = Arc::clone(&mau_config_arc);
    let mau_running_for_loop = Arc::clone(&mau_running_arc);
    let mau_workspace = agent_config.workspace_path.clone();
    let mau_agent_id = agent_config.id.clone();
    let mau_sidecar_mgr = Arc::clone(&sidecar_manager);
    let mau_app_handle = app_handle.clone();
    let (mau_model, mau_provider_env, mau_mcp_json) = {
        let agents_guard = agent_state.lock().await;
        if let Some(inst) = agents_guard.get(&agent_config.id) {
            (
                Arc::clone(&inst.current_model),
                Arc::clone(&inst.current_provider_env),
                Arc::clone(&inst.mcp_servers_json),
            )
        } else {
            (
                Arc::new(RwLock::new(agent_config.model.clone())),
                Arc::new(RwLock::new(None)),
                Arc::new(RwLock::new(agent_config.mcp_servers_json.clone())),
            )
        }
    };

    let hb_handle = tauri::async_runtime::spawn(async move {
        use heartbeat::is_in_active_hours;

        let initial_interval = {
            let cfg = hb_config_for_loop.read().await;
            Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60)
        };
        let mut interval = tokio::time::interval(initial_interval);
        interval.tick().await;

        ulog_info!(
            "[agent-heartbeat] Runner started for agent {} (interval={}min)",
            agent_label,
            initial_interval.as_secs() / 60
        );

        loop {
            {
                let cfg = hb_config_for_loop.read().await;
                let desired = Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60);
                if desired != interval.period() {
                    ulog_info!(
                        "[agent-heartbeat] Interval changed to {}min",
                        desired.as_secs() / 60
                    );
                    interval = tokio::time::interval(desired);
                    interval.tick().await;
                }
            }

            let reason = tokio::select! {
                _ = interval.tick() => types::WakeReason::Interval,
                Some(reason) = wake_rx.recv() => {
                    let mut reasons = vec![reason];
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    while let Ok(r) = wake_rx.try_recv() {
                        reasons.push(r);
                    }
                    reasons.into_iter()
                        .max_by_key(|r| if r.is_high_priority() { 1 } else { 0 })
                        .unwrap_or(types::WakeReason::Interval)
                }
            };

            let is_high_priority = reason.is_high_priority();

            {
                let hb_tz = {
                    let cfg = hb_config_for_loop.read().await;
                    cfg.active_hours.as_ref().map(|ah| ah.timezone.clone())
                };
                memory_update::check_and_spawn(
                    &mau_agent_id,
                    &mau_workspace,
                    &mau_config_for_loop,
                    &mau_running_for_loop,
                    &mau_sidecar_mgr,
                    &mau_app_handle,
                    &mau_model,
                    &mau_provider_env,
                    &mau_mcp_json,
                    hb_tz.as_deref(),
                )
                .await;
            }

            let config = hb_config_for_loop.read().await.clone();
            if !config.enabled {
                ulog_debug!("[agent-heartbeat] Skipped: disabled");
                continue;
            }

            if !is_high_priority {
                if let Some(ref active_hours) = config.active_hours {
                    if !is_in_active_hours(active_hours) {
                        ulog_debug!("[agent-heartbeat] Skipped: outside active hours");
                        continue;
                    }
                }
            }

            let channel_snapshot = {
                let agents_guard = agent_state_for_hb.lock().await;
                let agent = match agents_guard.get(&agent_id) {
                    Some(a) => a,
                    None => {
                        ulog_debug!("[agent-heartbeat] Agent {} not found, stopping", agent_id);
                        break;
                    }
                };
                let refs: Vec<_> = agent
                    .channels
                    .iter()
                    .map(|(ch_id, ch_inst)| {
                        (
                            ch_id.clone(),
                            Arc::clone(&ch_inst.bot_instance.health),
                            Arc::clone(&ch_inst.bot_instance.router),
                            ch_inst.bot_instance.heartbeat_wake_tx.clone(),
                            ch_inst.bot_instance.started_at,
                            ch_inst.bot_instance.config.platform.clone(),
                            ch_inst.bot_instance.config.name.clone(),
                            ch_inst.bot_instance.bind_code.clone(),
                        )
                    })
                    .collect();
                refs
            };

            let mut statuses_map = HashMap::new();
            let mut wake_txs: HashMap<String, mpsc::Sender<types::WakeReason>> = HashMap::new();
            for (ch_id, health, router, wake_tx, started_at, platform, name, bind_code) in
                &channel_snapshot
            {
                let health_state = health.get_state().await;
                let active_sessions = router.lock().await.active_sessions();
                statuses_map.insert(
                    ch_id.clone(),
                    ChannelStatus {
                        channel_id: ch_id.clone(),
                        channel_type: platform.clone(),
                        name: name.clone(),
                        status: health_state.status,
                        bot_username: health_state.bot_username,
                        uptime_seconds: started_at.elapsed().as_secs(),
                        last_message_at: health_state.last_message_at,
                        active_sessions,
                        error_message: health_state.error_message,
                        restart_count: health_state.restart_count,
                        buffered_messages: health_state.buffered_messages,
                        bind_url: None,
                        bind_code: Some(bind_code.clone()),
                    },
                );
                if let Some(tx) = wake_tx {
                    wake_txs.insert(ch_id.clone(), tx.clone());
                }
            }

            let target_ch_id = {
                let agents_guard = agent_state_for_hb.lock().await;
                match agents_guard.get(&agent_id) {
                    Some(agent) => resolve_target_channel(agent, &statuses_map),
                    None => None,
                }
            };
            let target_ch_id = match target_ch_id {
                Some(id) => id,
                None => {
                    ulog_debug!(
                        "[agent-heartbeat] No available channel for agent {}",
                        agent_id
                    );
                    continue;
                }
            };

            let delegated_reason = if reason.is_high_priority() {
                reason
            } else {
                types::WakeReason::Manual
            };
            if let Some(wake_tx) = wake_txs.get(&target_ch_id) {
                let _ = wake_tx.send(delegated_reason).await;
                ulog_debug!(
                    "[agent-heartbeat] Routed heartbeat to channel {} for agent {}",
                    target_ch_id,
                    agent_id
                );
            } else {
                ulog_debug!(
                    "[agent-heartbeat] Channel {} has no heartbeat runner, skipping",
                    target_ch_id
                );
            }

            if is_high_priority {
                interval.reset();
            }
        }

        ulog_info!("[agent-heartbeat] Runner stopped for agent {}", agent_label);
    });

    let mut agents_guard = agent_state.lock().await;
    if let Some(agent_instance) = agents_guard.get_mut(&agent_config.id) {
        if agent_instance.heartbeat_handle.is_none() && !agent_instance.channels.is_empty() {
            agent_instance.heartbeat_handle = Some(hb_handle);
            agent_instance.heartbeat_wake_tx = Some(wake_tx);
            agent_instance.heartbeat_config = Some(hb_config_arc);
            agent_instance.memory_update_config = Some(mau_config_arc);
            agent_instance.memory_update_running = Some(mau_running_arc);
            ulog_info!(
                "[agent] Agent-level heartbeat started for {}",
                agent_config.id
            );
        } else {
            hb_handle.abort();
        }
    } else {
        hb_handle.abort();
    }
}

/// Monitor agent channels and auto-restart dead ones (Error/Stopped).
/// Periodically scans all agent channels, restarts dead ones using the same
/// dedup + create_bot_instance pattern as schedule_agent_auto_start.
pub async fn monitor_agent_channels(
    app_handle: AppHandle,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    const CHECK_INTERVAL_SECS: u64 = 30;
    const MAX_CONSECUTIVE_FAILURES: u32 = 5;
    const BACKOFF_BASE_SECS: u64 = 30;
    const MAX_BACKOFF_SECS: u64 = 300;

    // Initial delay: let auto-start finish first
    tokio::time::sleep(Duration::from_secs(15)).await;
    ulog_info!("[agent-monitor] Agent channel health monitor started");

    // Track per (agent_id, channel_id): consecutive failures + next retry timestamp.
    // Keyed by the full pair — runtime identity is (agent_id, channel_id) everywhere
    // else in this loop (dead_channels, running_channel_keys, find_missing_*), so the
    // bookkeeping maps must match: a channel_id reused across two agents (imported /
    // manually-edited config) would otherwise cross-contaminate backoff/orphan state.
    // Keys persist across cycles even if the channel is removed from agent_state during
    // a failed restart — this prevents orphaned channels from being lost to monitoring.
    let mut failure_counts: HashMap<(String, String), u32> = HashMap::new();
    let mut next_retry: HashMap<(String, String), tokio::time::Instant> = HashMap::new();
    // Orphaned channels: (agent_id, channel_id) for channels removed from agent_state
    // during a failed restart. Merged into dead_channels on each cycle so they get retried.
    let mut orphaned: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();

    loop {
        tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        if shutdown.load(Relaxed) {
            break;
        }

        use tauri::Manager;
        let agent_state = app_handle.state::<ManagedAgents>();
        let sidecar_manager = app_handle.state::<ManagedSidecarManager>();

        // Phase 1: Find dead channels — snapshot health refs under lock, check outside.
        // Also keep the running key set so the monitor can reconcile enabled
        // channels that never made it into ManagedAgents during startup.
        let channel_health_refs: Vec<(String, String, Arc<crate::im::health::HealthManager>)> = {
            let agents_guard = agent_state.lock().await;
            let mut refs = Vec::new();
            for (agent_id, agent) in agents_guard.iter() {
                for (channel_id, channel) in agent.channels.iter() {
                    refs.push((
                        agent_id.clone(),
                        channel_id.clone(),
                        Arc::clone(&channel.bot_instance.health),
                    ));
                }
            }
            refs
            // lock dropped here
        };
        let running_channel_keys: std::collections::HashSet<(String, String)> = channel_health_refs
            .iter()
            .map(|(agent_id, channel_id, _)| (agent_id.clone(), channel_id.clone()))
            .collect();

        let mut dead_channels: Vec<(String, String)> = Vec::new();
        for (agent_id, channel_id, health) in &channel_health_refs {
            let state = health.get_state().await;
            if matches!(
                state.status,
                types::ImStatus::Error | types::ImStatus::Stopped
            ) {
                dead_channels.push((agent_id.clone(), channel_id.clone()));
            }
        }

        // Phase 2: Read configs from disk for restart and missing-channel reconcile.
        let agent_configs = read_agent_configs_from_disk();
        dead_channels.extend(find_missing_startable_agent_channels(
            &agent_configs,
            &running_channel_keys,
            &dead_channels,
        ));

        // Merge orphaned channels (failed restart last cycle, no longer in agent_state)
        for (agent_id, channel_id) in &orphaned {
            if !dead_channels
                .iter()
                .any(|(aid, cid)| aid == agent_id && cid == channel_id)
            {
                dead_channels.push((agent_id.clone(), channel_id.clone()));
            }
        }

        if dead_channels.is_empty() {
            failure_counts.clear();
            next_retry.clear();
            continue;
        }

        if agent_configs.is_empty() {
            continue;
        }

        let now = tokio::time::Instant::now();

        for (agent_id, channel_id) in &dead_channels {
            if shutdown.load(Relaxed) {
                break;
            }

            let key = (agent_id.clone(), channel_id.clone());
            let count = failure_counts.entry(key.clone()).or_insert(0);
            if *count >= MAX_CONSECUTIVE_FAILURES {
                continue;
            }

            // Skip if backoff hasn't elapsed yet (non-blocking)
            if let Some(&retry_at) = next_retry.get(&key) {
                if now < retry_at {
                    continue;
                }
            }

            // Find matching config from disk
            let agent_cfg = match agent_configs.iter().find(|a| a.id == *agent_id) {
                Some(c) => c,
                None => continue,
            };
            if !agent_cfg.enabled {
                continue;
            }
            let channel_cfg = match agent_cfg.channels.iter().find(|c| c.id == *channel_id) {
                Some(c) => c,
                None => continue,
            };
            if !channel_cfg.enabled {
                continue;
            }

            let mut im_config = channel_cfg.to_im_config(agent_cfg);
            im_config.heartbeat_config = Some(types::HeartbeatConfig {
                enabled: false,
                ..types::HeartbeatConfig::default()
            });
            if !im_config_has_start_credentials(&im_config) {
                continue;
            }
            let agent_channel_permission_mode = im_config.permission_mode.clone();

            // Remove dead channel — shut down old instance properly first
            let old_instance: Option<ImBotInstance> = {
                let mut agents_guard = agent_state.lock().await;
                if let Some(agent) = agents_guard.get_mut(agent_id) {
                    agent.channels.remove(channel_id).map(|ch| ch.bot_instance)
                } else {
                    None
                }
            };
            let was_missing = old_instance.is_none();
            if let Some(instance) = old_instance {
                let _ = shutdown_bot_instance(instance, &sidecar_manager, channel_id).await;
            }

            if was_missing {
                ulog_info!(
                    "[agent-monitor] Auto-starting missing channel {} of agent {}",
                    channel_id,
                    agent_id
                );
            } else {
                ulog_info!(
                    "[agent-monitor] Auto-restarting channel {} of agent {}",
                    channel_id,
                    agent_id
                );
            }

            match create_bot_instance(
                &app_handle,
                &sidecar_manager,
                channel_id.clone(),
                im_config,
                Some(agent_id.clone()),
            )
            .await
            {
                Ok((bot_instance, _status)) => {
                    failure_counts.remove(&key);
                    next_retry.remove(&key);
                    orphaned.remove(&key);

                    // Re-insert into agent state. If startup missed this channel
                    // completely, create the AgentInstance from disk config so
                    // future monitor cycles can see it.
                    let mut agents_guard = agent_state.lock().await;
                    let agent =
                        agents_guard
                            .entry(agent_id.clone())
                            .or_insert_with(|| AgentInstance {
                                agent_id: agent_id.clone(),
                                config: agent_cfg.clone(),
                                channels: HashMap::new(),
                                last_active_channel: Arc::new(RwLock::new(
                                    agent_cfg.last_active_channel.clone(),
                                )),
                                heartbeat_handle: None,
                                heartbeat_wake_tx: None,
                                heartbeat_config: None,
                                current_model: Arc::new(RwLock::new(agent_cfg.model.clone())),
                                current_provider_env: Arc::new(RwLock::new(
                                    agent_cfg
                                        .provider_env_json
                                        .as_ref()
                                        .and_then(|s| serde_json::from_str(s).ok()),
                                )),
                                permission_mode: Arc::new(RwLock::new(
                                    agent_channel_permission_mode.clone(),
                                )),
                                mcp_servers_json: Arc::new(RwLock::new(
                                    agent_cfg.mcp_servers_json.clone(),
                                )),
                                runtime: Arc::new(RwLock::new(normalize_runtime_type(
                                    agent_cfg.runtime.as_deref(),
                                ))),
                                runtime_config: Arc::new(RwLock::new(
                                    agent_cfg.runtime_config.clone(),
                                )),
                                memory_update_config: None,
                                memory_update_running: None,
                            });
                    let link = AgentChannelLink {
                        channel_id: channel_id.clone(),
                        agent_id: agent_id.clone(),
                        last_active_channel: Arc::clone(&agent.last_active_channel),
                        runtime_config: Arc::clone(&agent.runtime_config),
                    };
                    *bot_instance.agent_link.write().await = Some(link);

                    agent.channels.insert(
                        channel_id.clone(),
                        ChannelInstance {
                            channel_id: channel_id.clone(),
                            bot_instance,
                        },
                    );
                    drop(agents_guard);

                    ensure_agent_level_runners_started(
                        app_handle.clone(),
                        Arc::clone(&*agent_state),
                        Arc::clone(&*sidecar_manager),
                        agent_cfg.clone(),
                    )
                    .await;

                    ulog_info!(
                        "[agent-monitor] Channel {} is running after monitor recovery",
                        channel_id
                    );
                    let _ = app_handle.emit(
                        "agent:status-changed",
                        serde_json::json!({
                            "agentId": agent_id,
                            "event": "channel_auto_restarted",
                            "channelId": channel_id,
                        }),
                    );
                }
                Err(e) => {
                    *count += 1;
                    // Track as orphaned so next cycle retries even though
                    // the channel was removed from agent_state
                    orphaned.insert(key.clone());
                    // Schedule next retry with exponential backoff
                    let backoff = std::cmp::min(
                        BACKOFF_BASE_SECS.saturating_mul(2u64.saturating_pow(*count - 1)),
                        MAX_BACKOFF_SECS,
                    );
                    next_retry.insert(key.clone(), now + Duration::from_secs(backoff));
                    ulog_error!(
                        "[agent-monitor] Failed to restart channel {} (attempt {}, next retry in {}s): {}",
                        channel_id,
                        count,
                        backoff,
                        e
                    );
                }
            }
        }

        // Clean up: remove entries for channels that recovered or were manually stopped
        // Keep entries that are in orphaned (awaiting retry) or in dead_channels
        let tracked: std::collections::HashSet<(String, String)> = dead_channels
            .iter()
            .cloned()
            .chain(orphaned.iter().cloned())
            .collect();
        failure_counts.retain(|k, _| tracked.contains(k));
        next_retry.retain(|k, _| tracked.contains(k));
    }
}
