//! Position the macOS NSWindow standard buttons (red/yellow/green traffic
//! lights) for the Overlay title-bar style.
//!
//! ## Why this exists
//!
//! Tauri 2.11.x has a quirk in `WebviewWindowBuilder::traffic_light_position`:
//! it only writes the value into `webview_builder.webview_attributes`, which
//! is consumed at runtime via `wry::WryWebViewParent::drawRect` override
//! (`wry-0.55.1/src/wkwebview/class/wry_web_view_parent.rs:41-46`). The
//! parallel call on the underlying TAO `WindowBuilder` — which
//! `tauri.conf.json`'s `trafficLightPosition` does as a second step in
//! `tauri-runtime-wry-2.11.4/src/lib.rs:873-877` — is missing.
//!
//! Builder-only positioning therefore cannot reliably establish the initial
//! NSWindow chrome position in our programmatically-created Overlay window.
//! Conversely, a Tauri `WindowEvent::Resized` listener runs after AppKit's
//! native layout/draw frame and can only correct a live zoom after the visible
//! drift has already happened.
//!
//! ## What this does
//!
//! Traffic-light positioning therefore has two lifecycle owners with distinct
//! jobs:
//! - `WebviewWindowBuilder::traffic_light_position` stores the inset on Wry's
//!   parent view, whose native `drawRect:` keeps it attached during every live
//!   resize / zoom frame.
//! - [`apply_inset`] runs once after `WebviewWindowBuilder::build()` to bridge
//!   the missing initial TAO/window-level application.
//!
//! This module mirrors wry's and tao's internal `inset_traffic_lights`
//! algorithm for that one post-build bridge.
//!
//! ## References
//!
//! - `wry-0.55.1/src/wkwebview/class/wry_web_view_parent.rs::inset_traffic_lights`
//! - `tao-0.35.3/src/platform_impl/macos/view.rs::inset_traffic_lights`
//!   (identical algorithm; both reposition NSStandardWindowButtons + resize
//!   the title bar container view)
//! - Tauri upstream issue (Tauri 2.11.x): the builder method should mirror
//!   the config path by also setting on the underlying TAO `WindowBuilder`.
//!
//! ## TODO: remove when upstream fixes
//!
//! This module exists purely to work around the Tauri 2.11.x builder bug.
//! When Tauri's `WebviewWindowBuilder::traffic_light_position` is fixed to
//! also call through to the TAO window builder (matching the config path),
//! delete this module + the post-build `apply_inset` call; keep the builder
//! call as the single initial + draw-lifecycle owner. Track at: tauri-apps/
//! tauri WebviewWindowBuilder traffic light position parity issue.

#![cfg(target_os = "macos")]

use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
use tauri::{Runtime, WebviewWindow};

/// Apply the traffic-light inset to the given window's NSWindow chrome once.
/// Continuous resize / zoom persistence belongs to Wry's native `drawRect:`
/// path, configured by the builder in `lib.rs`.
///
/// `x` is the close button's distance from the window's left edge (logical
/// pixels). `y` is added to the close button's height to form the title-bar
/// container height — increasing `y` pushes buttons further down inside the
/// container. The current main-window values are `x=10, y=20`: the horizontal
/// inset centers the native cluster in the 72px global rail, while the vertical
/// inset preserves the established titlebar alignment.
///
/// Returns `Err` if `ns_window()` fails or returns null. Returns `Ok` if
/// the call ran — the inner [`inset_traffic_lights`] silently no-ops when
/// the standard window buttons aren't yet present (e.g. fired before
/// window chrome is constructed). Callers treat any error as non-fatal —
/// the window just keeps macOS default button positions.
pub fn apply_inset<R: Runtime>(window: &WebviewWindow<R>, x: f64, y: f64) -> Result<(), String> {
    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())?;
    if ns_window_ptr.is_null() {
        return Err("ns_window() returned null".to_string());
    }

    // SAFETY: `apply_inset` is only called from Tauri `setup`, which runs on
    // the main thread. The NSWindow
    // pointer returned by Tauri's `ns_window()` is valid for the lifetime
    // of the `WebviewWindow` (which the caller holds), and the `&NSWindow`
    // borrow we construct here is only used synchronously inside this
    // function — it doesn't escape and so cannot outlive `window`.
    let ns_window: &NSWindow = unsafe { &*(ns_window_ptr as *const NSWindow) };

    unsafe { inset_traffic_lights(ns_window, x, y) };
    Ok(())
}

/// Mirror of `wry::WryWebViewParent::inset_traffic_lights` and
/// `tao::view::inset_traffic_lights` — both are byte-for-byte identical.
/// Repositions the three NSStandardWindowButtons (close/min/zoom) and
/// resizes the enclosing title-bar container view so the button cluster
/// sits at logical `(x, y)` from the window's top-left.
unsafe fn inset_traffic_lights(window: &NSWindow, x: f64, y: f64) {
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };
    let zoom = window.standardWindowButton(NSWindowButton::ZoomButton);

    // Walk up two levels: NSStandardWindowButton → NSTitlebarView → NSTitlebarContainerView.
    // Same path wry/tao use; if AppKit ever changes this hierarchy these
    // unwraps would surface as a panic on first window display.
    let Some(parent) = close.superview() else {
        return;
    };
    let Some(title_bar_container_view) = parent.superview() else {
        return;
    };

    let close_rect = NSView::frame(&close);
    let title_bar_frame_height = close_rect.size.height + y;
    let mut title_bar_rect = NSView::frame(&title_bar_container_view);
    title_bar_rect.size.height = title_bar_frame_height;
    title_bar_rect.origin.y = window.frame().size.height - title_bar_frame_height;
    title_bar_container_view.setFrame(title_bar_rect);

    let space_between = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;

    let mut buttons = vec![close, miniaturize];
    if let Some(z) = zoom {
        buttons.push(z);
    }

    for (i, btn) in buttons.into_iter().enumerate() {
        let mut rect = NSView::frame(&btn);
        rect.origin.x = x + (i as f64 * space_between);
        btn.setFrameOrigin(rect.origin);
    }
}
