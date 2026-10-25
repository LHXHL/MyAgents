# Native macOS quit request projection

Published Tao **0.35.3**, with its included license. Archive SHA-256:
`d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9`.
`UPSTREAM_FILES.json` records every original packaged file. Local differences are the quit projection (`src/event.rs` and the macOS app delegate),
macOS API maintenance described below (`src/platform/macos.rs` and files under
`src/platform_impl/macos/`), and target gating for `src/window.rs::hit_test`.
The upstream hashes remain unchanged for provenance.
Pair with [tauri-runtime-wry 2.11.4](../tauri-runtime-wry/MYAGENTS_PATCH.md).
Cargo selects both local crates; the shared Cargo registry is never patched.

## Root cause and owner

AppKit's `terminate:` (application Quit / Cmd+Q / Dock Quit) called only
`applicationWillTerminate`, producing `LoopDestroyed`. Tauri's cancellable
`ExitRequested` owner never received a request, so confirmation, durable capture
finalization and managed process cleanup were skipped. This is also described in
[Tauri #12978](https://github.com/tauri-apps/tauri/issues/12978) and
[Tauri #13778](https://github.com/tauri-apps/tauri/issues/13778).

The existing App delegate now handles `applicationShouldTerminate:`. It queues
`Event::ExitRequested` through Tao's existing native event queue and returns
`NSTerminateCancel`, returning control to the normal event loop. The paired
runtime maps that request to Tauri's existing cancellable event. Acceptance exits
through the ordinary event-loop control flow; asynchronous application
confirmation can prevent the request and later call `AppHandle::exit` as before.
Queueing avoids re-entering a locked event callback when native termination is
requested from within one. No delegate replacement, swizzle, timer, new app
state, cleanup fallback or process scan is introduced.

[Apple's termination contract](https://developer.apple.com/documentation/appkit/nsapplication/terminate(_:))
permits returning control with `NSTerminateCancel`. This patch does not add an
OS logout/shutdown coordination protocol (`NSTerminateLater`/reply), and cannot
intercept force quit, crashes or forced OS termination. Other platforms do not
emit the new Tao event; their existing exit requests are unchanged.

## Verification and removal

`npm run test:native:quit` runs isolated native applications, with no user
configuration or model credentials. Original dependencies fail native request
and cancel/reissue cases while explicit exit/restart-code controls pass. The
patched pair must also pass callback reentrancy and last-window destruction,
plus `npm run test:native:tauri-events` and final product computer-use acceptance.
The fixture checks restart-code projection without actually relaunching itself.

Retire both patches together when an upstream version provides the same native
request semantics and passes these regressions. Keep MyAgents' single existing
ExitRequested cleanup owner; do not compensate for a missing request in final Exit.


## macOS API maintenance

The vendored build also uses the current objc2 interfaces: `NSEventType::KeyUp`,
the existing zoom button (the obsolete fullscreen button always returns nil),
and safe sheet/modifier/application calls without redundant `unsafe` blocks.
Unused internal fields, badge wrappers and imports are removed; per-window icons
reuse the existing `NoIcon` validator. Resize hit testing is compiled only for
its Windows/Linux/BSD callers.

File hover and drop share AppKit's `NSURL` pasteboard reader. Registration uses
the reader's supported types, retaining AppKit's legacy file-list conversion.
Only file URLs with a usable filesystem representation become paths; empty,
non-file and unresolved file-reference URLs are rejected. The fallible conversion
handles files removed while a drag is in flight. Filesystem
representation preserves spaces, percent signs and Unicode without treating encoded
URLs as filenames.
`file_drop_tests` in the macOS window delegate cover multiple modern file URLs,
legacy file lists, empty/non-file pasteboards and deleted file references, using private pasteboards.
Run on macOS with `cargo test --manifest-path vendor/tao/Cargo.toml --locked --lib
file_drop_tests --target-dir src-tauri/target`; the existing native quit regression
continues to cover the paired quit patch. Retire these maintenance edits when
upstream provides equivalent behavior and passes these checks.
