# Native macOS quit mapping

Published **tauri-runtime-wry 2.11.4**, licensed under the included licenses.
Archive SHA-256: `4e6fac707727b7a2f48e4ded90976324267371073edbb415ffb73bb0458d203f`.
`UPSTREAM_FILES.json` records the original packaged files. Only `src/lib.rs`
differs. This is paired with [Tao 0.35.3](../tao/MYAGENTS_PATCH.md).

Map Tao's native `ExitRequested` to the existing Tauri runtime event with code
`None`. Native quit, last-window destruction, and explicit request-exit share
the existing send/prevent/control-flow decision, extracted into one function.
Explicit and restart exit codes are retained. No Product API, process cleanup,
store or fallback is added. See the paired patch for causes, test commands,
platform limits and joint removal criteria.
