use std::borrow::Cow;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

struct Assets(Vec<u8>);
impl<R: tauri::Runtime> tauri::Assets<R> for Assets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        Some(Cow::Borrowed(&self.0))
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::once((
            Cow::Borrowed("index.html"),
            Cow::Borrowed(self.0.as_slice()),
        )))
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

#[tauri::command]
fn report(value: serde_json::Value) {
    println!("{value}");
}

#[tauri::command]
fn done(app: tauri::AppHandle, value: serde_json::Value) {
    let success = value["success"].as_bool().unwrap_or(false);
    std::fs::write(std::env::args().nth(2).unwrap(), value.to_string()).unwrap();
    report(value);
    app.exit(if success { 0 } else { 1 });
}

fn main() {
    let js = std::fs::read_to_string(std::env::args().nth(1).unwrap()).unwrap();
    let html = format!("<!doctype html><meta charset=\"utf-8\"><title>Tauri event regression</title><p>Isolated native listener regression</p><script>{js}</script>");
    let mut context = tauri::test::mock_context(Assets(html.into_bytes()));
    context.config_mut().identifier = "io.myagents.tauri-event-regression".into();
    // Test-only authority for the real built-in event plugin, with no product setup.
    let mut permissions = serde_json::Map::new();
    let names = ["listen", "unlisten", "emit", "emit_to"];
    for name in names {
        let id = format!("allow-{}", name.replace('_', "-"));
        permissions.insert(id.clone(), serde_json::json!({"identifier":id,"description":"Isolated event regression","commands":{"allow":[name],"deny":[]}}));
    }
    let acl = serde_json::from_value(serde_json::json!({"core:event":{
        "permissions":permissions,"permission_sets":{},"default_permission":{
            "identifier":"default","description":"Isolated event regression","permissions":["allow-listen","allow-unlisten","allow-emit","allow-emit-to"]
        }
    }})).unwrap();
    *context.runtime_authority_mut() = tauri::ipc::RuntimeAuthority::new(acl, Default::default());
    context.runtime_authority_mut().add_capability(r#"{"identifier":"event-regression","windows":["main"],"permissions":["core:event:default"]}"#).unwrap();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![report, done])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Isolated Tauri event regression")
            .incognito(true)
            .inner_size(440., 140.)
            .build()?;
            Ok(())
        })
        .run(context)
        .unwrap();
}
