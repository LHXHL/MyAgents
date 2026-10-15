# Tauri event lifetime patch

This is the published `tauri` **2.11.2** crate, licensed under the included MIT / Apache-2.0 licenses. Upstream archive SHA-256: `437404997acf375d85f1177afa7e11bb971f274ed6a7b83a2a3e339015f4cc28`. `UPSTREAM_FILES.json` records the original packaged files; Cargo's local cache marker and checksum file are omitted. The only modified upstream file is `src/event/mod.rs`.

The Rust patch is paired with `scripts/patch-tauri-events.mjs` for **@tauri-apps/api 2.11.1**, in both ESM and CJS distributions. The application selects this crate through `[patch.crates-io]` and exact version constraints. Do not patch the user's shared Cargo registry.

## Cause and owner

The API allocated an event callback but discarded its handle. Cleanup then depended on a descriptor installed by a separately queued native eval. An early unlisten could throw before native cleanup, or skip callback release entirely. Even ordinary successful unlisten retained the descriptor and its event table.

The repair keeps ownership in Tauri:

- The API retains its allocated callback ID and releases it on rejection or cancellation, independently of descriptor installation.
- The queued native install uses the existing callback Map as liveness authority. If cancellation already released the callback, it cannot install stale metadata. There is no new tombstone, timer, retry, or parallel listener registry.
- Generated cleanup handles a missing descriptor, deletes present descriptors, and removes the empty event table. This also covers `once`, which must release its callback before invoking user code.
- Native recipient removal continues through the existing event plugin unlisten command. Public API, target semantics, and business call sites remain unchanged.

No WebView eval / invoke-response ordering is assumed. Both dependency halves must ship together in a fresh native build/WebView; this is not a hot migration of an already running old framework.

## Regression and removal criteria

```sh
node --test scripts/patch-tauri-events.test.mjs scripts/tauri-event-lifecycle.test.mjs
npm run test:native:tauri-events
```

Deterministic tests execute these actual Rust-generated JS templates with the installed ESM/CJS API and controlled delayed installation. The opt-in native test runs a standalone Tauri application, including real event targets and MyAgents' abort helper, with no product setup or real accounts. It preserves its temporary artifact directory and never replaces the product executable.

Retire this vendored crate and JS patch together only after an upstream release passes callback, descriptor, registration-rejection, once/reentrancy, distinct-name, delayed-cancellation, and native burst regressions. [Upstream PR #15800](https://github.com/tauri-apps/tauri/pull/15800) adds a missing-entry guard but does not by itself release the skipped callback or retained metadata.

This repair does **not** establish the cause of MyAgents #667's overnight OOM. Native recipient cleanup on source-WebView destruction is a separate context-owner issue ([upstream #15604](https://github.com/tauri-apps/tauri/pull/15604)); native-only Rust listeners, IPC Channels, and composite-helper partial-registration rollback are outside this per-registration repair. No persistent data migration is required.
