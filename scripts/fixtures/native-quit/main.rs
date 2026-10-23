use std::{
    borrow::Cow,
    sync::{Arc, Mutex},
};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::Manager;

struct Assets;
impl<R: tauri::Runtime> tauri::Assets<R> for Assets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        Some(Cow::Borrowed(
            b"<!doctype html><title>Native quit regression</title>Isolated native quit regression",
        ))
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

// Run the real AppKit selector outside the Tao event callback. Native menus,
// Dock Quit and ordinary application termination use this same selector.
fn native_quit() {
    dispatch2::DispatchQueue::main().exec_async(|| {
        let mtm = objc2::MainThreadMarker::new().unwrap();
        objc2_app_kit::NSApplication::sharedApplication(mtm).terminate(None);
    });
}

fn main() {
    let mode = std::env::args().nth(1).unwrap();
    let result = std::env::args().nth(2).unwrap();
    let mut context = tauri::test::mock_context(Assets);
    context.config_mut().identifier = "io.myagents.native-quit-regression".into();
    let requests = Arc::new(Mutex::new(Vec::<Option<i32>>::new()));
    tauri::Builder::default()
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("Isolated native quit regression").incognito(true)
                .inner_size(440., 140.).build()?;
            Ok(())
        })
        .build(context).unwrap()
        .run(move |app, event| match event {
            tauri::RunEvent::Ready => match mode.as_str() {
                "explicit" => app.exit(0),
                // Exercise the existing restart code without relaunching a test app.
                "restart" => app.exit(tauri::RESTART_EXIT_CODE),
                "last-window" => app.get_webview_window("main").unwrap().destroy().unwrap(),
                "native-reentrant" => {
                    let mtm = objc2::MainThreadMarker::new().unwrap();
                    objc2_app_kit::NSApplication::sharedApplication(mtm).terminate(None);
                }
                _ => native_quit(),
            },
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                let mut seen = requests.lock().unwrap();
                seen.push(code);
                if mode == "cancel-confirm" {
                    match seen.len() {
                        1 => { api.prevent_exit(); native_quit(); }
                        2 => { api.prevent_exit(); app.exit(0); }
                        _ => {}
                    }
                }
            }
            tauri::RunEvent::Exit => {
                let seen = requests.lock().unwrap();
                let expected = match mode.as_str() {
                    "cancel-confirm" => vec![None, None, Some(0)],
                    "explicit" => vec![Some(0)],
                    "restart" => vec![Some(tauri::RESTART_EXIT_CODE)],
                    _ => vec![None],
                };
                let evidence = serde_json::json!({"mode":mode,"requests":*seen,"expected":expected,"success":*seen == expected});
                std::fs::write(&result, evidence.to_string()).unwrap();
            }
            _ => {}
        });
}
