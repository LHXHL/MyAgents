//! One fact table shared with settings and Bridge; desired config stays intact.
use super::types::{GroupActivation, ImPlatform};
use serde_json::Value;
use std::sync::LazyLock;

static FACTS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../src/shared/imPlatformCapabilities.json"
    ))
    .expect("bundled IM capability table")
});

pub(super) fn effective_group_activation(
    platform: &ImPlatform,
    requested: Option<&str>,
) -> GroupActivation {
    match FACTS[platform.to_string()]["groups"].as_str() {
        Some("mention" | "none") => GroupActivation::Mention,
        _ if requested == Some("always") => GroupActivation::Always,
        _ => GroupActivation::Mention,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn historical_always_config_cannot_exceed_platform_capability() {
        for (platform, fact) in FACTS.as_object().unwrap() {
            let platform: ImPlatform =
                serde_json::from_value(Value::String(platform.clone())).unwrap();
            let effective = effective_group_activation(&platform, Some("always"));
            assert_eq!(
                matches!(effective, GroupActivation::Always),
                fact["groups"] == "all"
            );
            assert!(matches!(
                effective_group_activation(&platform, None),
                GroupActivation::Mention
            ));
        }
        assert!(matches!(
            effective_group_activation(&ImPlatform::OpenClaw("custom".into()), Some("always")),
            GroupActivation::Always
        ));
    }
}
