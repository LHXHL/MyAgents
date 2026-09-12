use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use super::manifest::Component;
use super::types::{Error, Result};

/// Config rows retain edits/removals. Execution capabilities are bound from
/// native metadata separately, so preserved preferences cannot grant access.
pub(super) fn merge_configured(
    existing: &[Value],
    catalog: &[Value],
    removed: &[Value],
) -> Vec<Value> {
    let mut merged = existing.to_vec();
    for model in catalog {
        let id = &model["model"];
        if !removed.contains(id) && !merged.iter().any(|row| &row["model"] == id) {
            merged.push(model.clone());
        }
    }
    merged
}

/// Normalized ModelEntity output is consumed by UI and execution alike. Static
/// catalog presence never proves the current account's entitlement.
pub(super) fn project(
    registered: &[Value],
    routed: &[String],
    definitions: &[Value],
    component: &Component,
) -> Result<Vec<Value>> {
    let ids = |items: &[Value]| -> Result<BTreeSet<String>> {
        items
            .iter()
            .map(|item| {
                item.get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(Error::contract)
            })
            .collect()
    };
    let registered = ids(registered)?;
    let routed: BTreeSet<_> = routed.iter().map(String::as_str).collect();
    let definitions: BTreeMap<_, _> = definitions
        .iter()
        .filter_map(|item| Some((item.get("id")?.as_str()?, item)))
        .collect();
    let mut models = Vec::new();
    for approved in &component.compatibility.models {
        if !approved.tools
            || !registered.contains(&approved.id)
            || !routed.contains(approved.id.as_str())
        {
            continue;
        }
        let Some(definition) = definitions.get(approved.id.as_str()) else {
            continue;
        };
        let mut model = json!({ "model": approved.id,
            "modelName": definition.get("display_name").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(&approved.id),
            "modelSeries": approved.id, "source": "discovered", "supportedProtocols": ["anthropic:messages"] });
        if let Some(context) = definition
            .get("context_length")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
        {
            if let Some(tested) = approved.max_tested_context {
                model["contextLength"] = json!(context.min(tested));
            }
        }
        if let Some(output) = definition
            .get("max_completion_tokens")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
        {
            model["maxOutputTokens"] = json!(output);
        }
        for (native, field, allowed) in [
            (
                "supportedInputModalities",
                "inputModalities",
                &approved.input_modalities,
            ),
            (
                "supportedOutputModalities",
                "outputModalities",
                &approved.output_modalities,
            ),
        ] {
            if let Some(values) = definition.get(native).and_then(Value::as_array) {
                model[field] = json!(values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_ascii_lowercase)
                    .filter(|value| allowed.contains(value))
                    .collect::<Vec<_>>());
            }
        }
        models.push(model);
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cliproxy::manifest::{tests::component, ApprovedModel};
    #[test]
    fn catalog_merge_preserves_configured_overrides_and_temporarily_absent_models() {
        let saved = vec![
            json!({"model":"a", "modelName":"My name", "contextLength":1234, "source":"discovered"}),
            json!({"model":"temporarily-absent", "modelName":"Keep me", "source":"discovered"}),
        ];
        let catalog = vec![
            json!({"model":"a", "modelName":"Native name", "contextLength":9999}),
            json!({"model":"new"}),
        ];
        let merged = merge_configured(&saved, &catalog, &[]);
        assert_eq!(merged[0], saved[0]);
        assert_eq!(merged[1], saved[1]);
        assert_eq!(merged[2]["model"], "new");
        assert_eq!(merge_configured(&saved, &catalog, &[json!("new")]), saved);
    }
    #[test]
    fn account_route_definition_and_tested_capabilities_all_constrain_the_projection() {
        let mut component = component("7.2.158");
        component.compatibility.models =
            ["approved", "not-routed", "not-registered", "no-definition"]
                .into_iter()
                .map(|id| ApprovedModel {
                    id: id.to_owned(),
                    tools: true,
                    thinking: false,
                    input_modalities: BTreeSet::from(["text".to_owned()]),
                    output_modalities: BTreeSet::from(["text".to_owned()]),
                    max_tested_context: Some(32_000),
                })
                .collect();
        let registered =
            ["approved", "not-routed", "no-definition", "untested"].map(|id| json!({"id": id}));
        let routed = ["approved", "not-registered", "no-definition", "untested"].map(str::to_owned);
        let definitions = ["approved", "not-routed", "not-registered", "untested"].map(|id| json!({"id": id,
            "context_length": 200_000, "max_completion_tokens": 8_000, "supportedInputModalities": ["text", "image"],
            "supportedOutputModalities": ["text"]}));
        let result = project(&registered, &routed, &definitions, &component).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["model"], "approved");
        assert_eq!(result[0]["contextLength"], 32_000);
        assert_eq!(result[0]["inputModalities"], json!(["text"]));
        assert_eq!(
            result[0]["supportedProtocols"],
            json!(["anthropic:messages"])
        );
        component.compatibility.models[0].max_tested_context = None;
        assert!(
            project(&registered, &routed, &definitions, &component).unwrap()[0]
                .get("contextLength")
                .is_none()
        );
        assert!(project(
            &[json!({"name": "missing-id"})],
            &routed,
            &definitions,
            &component
        )
        .is_err());
    }
}
