---
type: technical-rfc
status: implementation-in-progress
version: 0.30
updated: 2026-09-02
implementation_repository: "MyAgents"
product_prd: MyAgents-dsh/specs/prd/prd_0.3_myagents_integration.md
runtime_rfc: MyAgents-dsh/specs/prd/tech_rfc_0.3_myagents_dsh_integration.md
implementation_baseline:
  version: 0.4.11
  commit: c7dc5d79b2752a713e53ec9eee4f1db2324fa7fd
audit_baseline:
  version: 0.4.12
  original_commit: c39d7387a6122f9ebed5f4ec94583aebd1da93f6
  revalidated_commit: 61a81af384a2333dd8f4fc5f14436ab6e360c820
runtime_handoff:
  status: protocol-2.3.0-workspace-skills-stdio-mcp-ingested
  reviewed_repository_head: 1a776194c33fcafeff5de46bca36e354b80b20d5
  source_commit: 1a776194c33fcafeff5de46bca36e354b80b20d5
  protocol: 2.3.0
  manifest_sha256: 999a80f5d9cc33f858cf3c11a8031a431ad8303221ddf0a3ec74452cb265dba7
  runtime_manifest_sha256: 4b3bc9de9a00b58c5284eb21563fb0e8fc64dbf1b6b98f458056d8da78b8959e
  compatibility_sha256: dbedcc9ef0632833d82c7707ae4267f10d275ee00e922bbd20e1c1625f1216f3
  protocol_schema_sha256: 82bf9509a8213fea2bca9771f3be8587e56e18461457634baa2fe88db55e063c
  generated_client_sha256: f300f2567a87727c40fd84c318bcf1730075ab556933dcfd1bab10f4c7db288a
---

# Batch 3 Technical RFC — MyAgents integration of MyAgents-dsh

> This is the canonical MyAgents Host integration RFC and implementation ledger. Product scope remains owned by the paired PRD, and exact Runtime behavior remains owned by generated contracts and the immutable handoff.

## 1. Decision summary

MyAgents will add DSH as a first-party **Integrated Runtime**, not as an External CLI and not as a Managed Provider Runtime.

The implementation reuses the existing product architecture:

```text
Desktop / IM / Task / Cron / Goal / Heartbeat / Inbox
                         |
                         v
              SessionEngine facade
                         |
                         v
              ExecutionResolver
        _________|___________
       |         |           |
 Claude SDK   DSH adapter   existing external/managed adapters
                 |
          RuntimeProcessHost
        generated protocol client
                 |
          DSH runtime-server
```

There is no new conversation product, no DSH-specific Renderer, no global Runtime daemon, and no reuse of a native Session across different runtimes.

MyAgents continues to own:

- Product Session identity, transcript and UI projection;
- Agent defaults, distribution policy and runtime resolution;
- Sidecar ownership and process lifecycle;
- Provider configuration and credentials;
- permission/AskUser/plan interaction UI;
- Host tools, Hooks, attachment storage and product automation;
- Task, Goal, Cron, Heartbeat, Inbox, IM and notification semantics.

MyAgents-dsh continues to own:

- the DSH AgentLoop and durable native conversation;
- its single `ctx.tools` execution pipeline;
- native Runtime Session, Turn, work and mutation truth;
- the generated bidirectional protocol contract;
- provider-profile execution and exact compatibility manifest;
- the verified Runtime artifact.

## 2. Audited current state

This RFC was originally audited against MyAgents `0.4.12` at commit `c39d7387a6122f9ebed5f4ec94583aebd1da93f6` and was revalidated against committed HEAD `61a81af384a2333dd8f4fc5f14436ab6e360c820` after the formal DSH `2.0.0` handoff was produced. Since the previous audit at `d6ba358f…`, committed changes touching `Launcher.tsx` and `specs/ARCHITECTURE.md` are limited to the Record/AI-discussion flow; they do not alter `src/server/session-engine/`, Runtime identity types, Provider execution policy, or the Rust Runtime identity owner. The architectural findings therefore remain valid.

The live MyAgents worktree also contains unrelated uncommitted Record/AI-discussion and UI work. It was inspected for boundary overlap and does not implement DSH integration. It is not design authority for Batch 3 and must be preserved during implementation; an implementation branch or worktree must not absorb, overwrite, or reinterpret it.

### 2.1 Reusable product owners

| Existing owner                                       | Current fact                                                                                                                                 | Batch 3 decision                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/server/session-engine/`                         | One facade already covers Desktop, IM, background, Inbox, scheduled/injected turns, queue, stop, config, interactions and history operations | Keep as the only product entry seam                              |
| Session Sidecar                                      | Architecture guarantees at most one Sidecar per Product Session; multiple owners share it                                                    | Sidecar hosts one DSH Runtime process for a DSH-bound Session    |
| `SessionStore`                                       | Owns transcript and Session metadata                                                                                                         | Remains Product transcript authority                             |
| `src/server/runtimes/types.ts`                       | `UnifiedEvent` already represents text, thinking, tools, permission, usage, plan and terminal events                                         | Extend only where DSH semantics cannot be represented losslessly |
| Chat Renderer                                        | Already provides the complete AI conversation, tool blocks, inline interactions, queue/stop and mutations                                    | Reuse; no DSH debug cards                                        |
| `providerSwitchSessionBirth.ts` and Chat transitions | Existing incompatible Provider/Runtime flow confirms, preserves old Session and opens a new Tab                                              | Reuse for DSH, `anthropic-sub` and managed-provider boundaries   |
| Rust Sidecar manager                                 | Owns generation, process tree, owner tokens and replacement                                                                                  | Remains the process owner; does not parse DSH RPC                |
| IM runtime rotation                                  | Existing Agent config change freezes old binding, creates a fresh Session and notifies the user                                              | Generalize identity input, preserve behavior                     |

### 2.2 Current binary assumptions that must change

The current model is too narrow:

- `RuntimeType` is `builtin | claude-code | codex | gemini`;
- `RuntimeSource` is `system-cli | managed-provider`;
- `SessionEngineKind` is `builtin | external`;
- `getSessionEngine()` selects only Builtin or External;
- the Labs gate collapses the Agent's effective Runtime to historical `builtin`;
- provider execution has a Codex-specific runtime-backed variant;
- Rust runtime identity normalizes nearly every non-builtin source toward `system-cli`.

Simply adding `dsh` to `RuntimeType` would classify it through External Runtime assumptions, permit illegal runtime/source combinations, and make future Pi integration repeat the same migration. Batch 3 therefore introduces an explicit product identity model instead of growing two independent string unions.

### 2.3 Existing change behavior is already correct

The audited product behavior matches the accepted PRD and must be retained:

- Agent Settings and Launcher update the Agent template only; future Sessions use the new selection.
- In a live Chat, an incompatible Runtime or Provider change uses the existing confirmation and new-Tab birth flow.
- The old Session retains its frozen identity and transcript.
- An explicit External Runtime wins over a dormant `codex-sub` Agent field.
- IM/Agent Channel effective-identity drift freezes the old Session and rotates to a new binding; admission and Heartbeat checks are recovery fences.

Batch 3 generalizes the compatibility inputs to these flows. It does not redesign them.

### 2.4 Exact-handoff revalidation and required amendments

The formal repository-external handoff validates successfully without a sibling source checkout and freezes:

- handoff manifest `ae72806cae7b7b47ceba96ae38d16f95071c92b44bfe9fc96bb114670f4053c1`;
- Runtime manifest `8fccea44a04d29e6a2e2f134d4b1f9fd2192680c30316e119a398f7ae34f98c9`, built from clean MyAgents-dsh source commit `37515ea28312dccddb854e773adb174672fc254b`;
- compatibility manifest `7a172f0335b2df90f3c5bf8f89fae154ed4d1d13a83b07bf40497e438f189062`;
- formal protocol `2.0.0`, schema `1841590ed3c4d9f793c72a1cfda3a93808b71595c239c8fa7c38b0bfae80fd44`, and generated Host client `fce73629088852077b09cb0b3b43b7d470b4f3a5fb936f828102aafaf8b0fe7e`;
- DSH artifact `ea7918fa55540f7fe40c0849b9994ff4f197d599e40fbb69c72d8b842e6f1fe2` at upstream commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`;
- macOS arm64, Linux x64 and Windows x64 all labeled `implementation-complete_pending-native-validation` for these bytes.

Formal `2.0.0` is wire-identical to draft.3 and contains 40 Host requests, seven reverse requests and four notifications, including `plan/apply`, `permission/rules/list`, `permission/rules/add`, and `permission/rules/revoke`. H0 must ingest and verify this complete immutable handoff; all draft handoffs remain historical evidence and are a hard compatibility failure for the first implementation lock. No pending-native-validation platform claim may be surfaced as verified product support.

The accepted Runtime was built from clean MyAgents-dsh commit `37515ea28312dccddb854e773adb174672fc254b`, which is also the reviewed artifact source HEAD. It preserves the prepare-token recovery and link-free packaging corrections from the earlier candidates. Its intentional semantic change is confined to the Product Task contract: Task metadata is a bounded flat scalar record with no nested object, array or recursive schema reference, identical across all three Provider families. Runtime `8fccea44…` has no symbolic links in either its manifest or filesystem inventory and keeps Node `24.14.0` / npm `11.15.0` build provenance. MyAgents therefore copies and verifies the immutable link-free tree directly and contains no post-copy link-repair or Provider-specific schema rewrite authority. The integration identity is the content-addressed handoff above, never the mutable checkout path. Its public verifier succeeds against the trusted outer digest and reports the same Runtime and compatibility manifests.

The implementation branch is deliberately based on the fetched MyAgents `main` at `c7dc5d79b2752a713e53ec9eee4f1db2324fa7fd` (`0.4.11`). The later MyAgents commits recorded by the original RFC audit were not present in the fetched origin on 2026-08-30, so integration decisions are rechecked against this actual baseline and no unavailable commit is treated as executable authority.

The Node integration blocker found by version 0.1 is now resolved at the artifact source: the accepted Runtime requires exact Node `24.14.0`, which matches MyAgents' bundled Runtime Node. MyAgents must still cross-check every Node version authority, including `scripts/download_nodejs.sh`, `setup_windows.ps1`, and the fallback in `build_windows.ps1`, plus resource/version assertions and executable architecture examples. A user-installed Node or a semver assumption must fail readiness before process spawn. A later Node upgrade requires a newly accepted Runtime artifact and native evidence rather than a Host-side bypass.

npm has a different boundary. The installed DSH Runtime never invokes npm; its recorded npm version is build provenance, not a Host compatibility requirement. MyAgents now declares exact development package manager `npm@11.15.0` and independently pins product-owned bundled npm `11.15.0` beside its bundled Node. Resource setup uses the exact versioned tarball and records/verifies its own metadata; it no longer resolves `npm/latest`. The development npm, bundled npm and DSH build provenance remain distinct authorities with explicit roles even while their current values are aligned; none is copied from another authority.

The revalidation also sharpens two existing rules:

1. MyAgents ingests the immutable handoff through a deterministic build-time verifier and committed lock; it never imports from a sibling MyAgents-dsh checkout or edits files inside the Runtime directory.
2. `apiFamilies` proves transport-family support, not arbitrary Provider/model support. MyAgents owns an exact allowlisted Provider/model cell table. The native `deepseek-official` route is frozen by that table against the included candidate profile identity and Runtime validator; the three pi-ai families are read from the compatibility manifest. No other cell becomes visible without joint evidence.

## 3. Target product identity model

### 3.1 Agent preference

Agent configuration stores user intent, not the final engine process:

```ts
type AgentRuntimePreference =
  | { family: "integrated"; id: "claude-agent-sdk" | "dsh" }
  | { family: "external"; id: "claude-code" | "codex" | "gemini" };
```

The type may reserve an internal future identifier for Pi in schema evolution, but Batch 3 must not show or accept Pi as a selectable value.

### 3.2 Provider execution constraint

Provider execution is generalized from the current Codex-only special case:

```ts
type ProviderExecutionConstraint =
  | { kind: "portable"; apiFamily: ApiFamily }
  | {
      kind: "requires-integrated-runtime";
      runtimeId: "claude-agent-sdk";
      providerId: "anthropic-sub" | "xai-sub";
    }
  | {
      kind: "requires-managed-runtime";
      runtimeId: "managed-codex";
      providerId: "codex-sub";
    };
```

An ordinary Anthropic API-key Provider is portable when the selected Integrated Runtime supports `anthropic-messages`. It is not the same thing as `anthropic-sub`.

### 3.3 Effective Session binding

Every new Product Session freezes a legal discriminated binding:

```ts
type EffectiveRuntimeBinding =
  | {
      family: "integrated";
      id: "claude-agent-sdk";
      implementationVersion: string;
    }
  | {
      family: "integrated";
      id: "dsh";
      implementationVersion: string;
      protocolVersion: string;
      protocolSchemaSha256: string;
      runtimeArtifactSha256: string;
      compatibilityManifestSha256: string;
      sessionFormat: string;
      platformTarget: string;
    }
  | {
      family: "managed-provider";
      id: "managed-codex";
      providerId: "codex-sub";
      implementationVersion: string;
    }
  | {
      family: "external";
      id: "claude-code" | "codex" | "gemini";
      implementationVersion?: string;
    };
```

Provider route/model, effective configuration revisions and native `runtimeSessionId` remain Session metadata associated with this binding. No free-form combination of runtime and source is accepted at a new write boundary.

### 3.4 Legacy projection

During migration MyAgents reads existing flat `runtime` / `runtimeSource` fields into the new discriminated value and may continue writing a legacy projection for old consumers. The new `runtimeBinding` is authoritative when present.

Legacy mapping:

| Legacy values                                              | New binding                      |
| ---------------------------------------------------------- | -------------------------------- |
| `builtin` with no managed Provider                         | integrated / Claude Agent SDK    |
| `builtin` + `codex-sub`                                    | managed-provider / managed Codex |
| `codex + managed-provider`                                 | managed-provider / managed Codex |
| `claude-code`, `codex` or `gemini` + missing/system source | matching external binding        |

Unknown or illegal combinations are quarantined as read-only compatibility errors. They do not silently become Claude SDK.

## 4. Distribution policy and selection

### 4.1 Policy

Introduce a validated distribution policy:

```ts
interface AgentRuntimeDistributionPolicy {
  schemaVersion: 1;
  allowedIntegratedRuntimes: Array<"claude-agent-sdk" | "dsh">;
  allowedExternalRuntimes: Array<"claude-code" | "codex" | "gemini">;
  defaultIntegratedRuntime: "claude-agent-sdk" | "dsh";
  selectorAvailability: "always" | "labs" | "hidden";
}
```

The general development/release baseline is:

- allowed Integrated Runtimes: Claude Agent SDK and DSH;
- default Integrated Runtime: Claude Agent SDK;
- DSH exposed only through the controlled rollout/Labs policy;
- Pi absent.

A DSH-only edition sets DSH as the sole allowed/default Integrated Runtime and hides the selector. Invalid policy fails during build or application startup.

### 4.2 Labs semantics

`multiAgentRuntime` becomes a selection-availability gate, not a runtime kill switch:

- when unavailable, normal UI does not let the user change Runtime;
- new ordinary-provider Sessions use the Default Integrated Runtime;
- saved Agent preferences remain stored;
- existing frozen Sessions remain executable if their exact Runtime is allowed and available;
- a distribution that excludes the frozen Runtime leaves transcript readable and blocks execution explicitly.

### 4.3 Central resolution algorithm

For an existing Session, return its frozen binding after policy/artifact validation.

For a new Session:

1. load and validate distribution policy;
2. resolve the Agent preference, using the Default Integrated Runtime when selection is unavailable;
3. resolve Provider/model execution intent;
4. if an explicit allowed External Runtime is selected, choose it and treat Integrated/managed Provider template fields as dormant;
5. otherwise apply a Runtime-constrained Provider:
   - `anthropic-sub` -> Claude Agent SDK;
   - `xai-sub` -> Claude Agent SDK and the existing Host-managed OAuth bridge;
   - `codex-sub` -> managed Codex;
6. otherwise choose the resolved Integrated Runtime;
7. validate Runtime readiness and exact Provider/model compatibility;
8. atomically persist the binding before first turn admission.

The resolver returns either one complete binding plus configuration plan or one structured failure. No caller retries with a different Runtime.

## 5. SessionEngine architecture

### 5.1 One product facade

Keep `SessionEngine` as the product-facing contract. Replace the binary selector with a registry keyed by `EffectiveRuntimeBinding`:

```text
SessionEngine
  |- ClaudeSdkSessionEngineAdapter
  |- DshSessionEngineAdapter
  |- ManagedCodexSessionEngineAdapter / existing external core
  '- ExternalCliSessionEngineAdapter / existing runtimes
```

Physical code reuse does not define product taxonomy. Managed Codex may continue sharing external-session machinery while remaining a Managed Provider Runtime in the resolver and UI.

### 5.2 Capability extensions

The common facade keeps currently universal product operations. Runtime-specific rich operations are exposed through negotiated, narrow capabilities instead of fake success:

```ts
interface NativeRuntimeCapabilities {
  configuration?: RuntimeConfigurationCapability;
  extensions?: RuntimeExtensionCapability;
  durableTurnTruth?: RuntimeTurnTruthCapability;
  mutations?: RuntimeMutationCapability;
  nativeHistory?: RuntimeHistoryCapability;
}
```

If a control is unsupported, the resolver/UI disables it before use or SessionEngine returns a structured `unsupported_capability`. It must not return `success + skipped` for a visible action.

### 5.3 Product entry points

The following must continue to call only SessionEngine and the central resolver:

- Desktop Chat and Launcher;
- Agent Settings and workspace defaults;
- IM/Agent Channel and Heartbeat;
- Task/Cron and Goal;
- Inbox and registered Agent;
- injected/system turns and background completion;
- title/utility operations where their current owner applies.

Implementation must re-run `rg` over direct Builtin/External calls before promotion; newly discovered bypasses are blockers.

## 6. DSH RuntimeProcessHost

### 6.1 Process topology

For a DSH-bound Product Session:

- Rust creates/owns the existing Session Sidecar and its process-tree control handle;
- Rust injects verified DSH artifact paths and a session-scoped Runtime home;
- the Sidecar and DSH child use MyAgents' one bundled Node, which must exactly match the Runtime lock (`24.14.0` for this candidate);
- the Node Sidecar creates one `RuntimeProcessHost`;
- `RuntimeProcessHost` starts one DSH runtime-server with bundled Node;
- communication is bidirectional JSON-RPC over stdin/stdout;
- stderr enters the existing redacted unified logger;
- the Renderer communicates only through existing Rust proxy and Sidecar APIs.

Rust does not parse DSH frames. DSH does not open TCP/HTTP. A Product Session does not share one DSH root process with another Product Session.

### 6.2 Handshake and admission

Process readiness requires:

1. handoff, artifact inventory, lock, platform evidence and exact Node validation;
2. process spawn with explicit generation;
3. protocol `initialize`;
4. exact protocol/schema/profile/session-format verification;
5. Runtime capability verification;
6. registration of all reverse Host handlers;
7. `initialized` notification;
8. `session/create` or exact `session/resume`;
9. atomic persistence of the native binding.

No user turn is admitted before all applicable steps succeed.

H3 implements the protocol-ready portion of this admission in `src/server/integrated-runtimes/dsh/`. `installation.ts` resolves only canonical paths below the Tauri resource root, verifies exact Node `24.14.0`, invokes the outer handoff's public `verify.mjs` with the committed digest, and runs the Runtime entrypoint's public `--self-check` before the RPC process is spawned. The two reports rebind the complete outer/nested inventories, compatibility, source, patched DSH, protocol method/notification sets, profile and native target to `dsh-lock.json`; accepted reports are deduplicated only within the current Sidecar process. `generated-client.ts` then resolves `@myagents-dsh/protocol` and `@myagents-dsh/protocol/generated/host-client` through the verified artifact's public package exports. It does not import a package-private `src/*` path or repair the copied generated TypeScript file. Generated protocol/schema/capability constants and the complete 40/7/4 surface must match the committed contracts before construction.

`process-host.ts` owns the `idle -> starting -> protocol-ready -> stopping -> stopped` lifecycle, with `failed` as a terminal admission result. Its exact order is Node check, outer handoff verification, artifact self-check, public protocol load, process spawn, `initialize`, identity/capability validation, negotiated-limit application, atomic registration of all seven reverse methods and two Runtime notification handlers, `initialized`, and quiescent `runtime/status`. Startup cancellation cannot race through to a late spawn. Shutdown first requests `runtime/shutdown`, flushes the peer, waits for exit and only then uses bounded termination. The Runtime entrypoint supplies and reports `artifact-process-generation`; MyAgents fences every reverse call and Runtime event against that returned value plus the Product Session identity, while the enclosing Sidecar generation remains an additional H5 lifecycle fence.

The child environment is constructed from an allowlist and never spreads `process.env`. `PATH` puts the verified bundled Node directory first and then uses the deduplicated path discovered from the user's terminal, so Bash can reach `myagents`, Homebrew/Cargo and ordinary developer commands. The same explicit environment authority admits ordinary `HOME`/user/shell, locale, temp and platform values. Provider/MCP/API-key, proxy, `NODE_OPTIONS`, `NODE_PATH` and unrelated variables remain absent; credentials continue to cross only reverse ports. Stderr is discarded unless the caller supplies both a redactor and sink. The exact candidate currently requires a platform bash on the sealed startup path, while ripgrep is resolved from its artifact-pinned package. Runtime home, workspace and attachment paths passed to native admission must be canonical real paths; macOS `/var` aliases, symlinks and permission drift fail closed.

The explicit `MYAGENTS_DSH_NATIVE_SMOKE=1` integration gate starts the staged artifact with the bundled Node, completes the formal handshake/status sequence without a Session or network credential, and performs graceful shutdown. H3 passed this gate on the artifact-bound `darwin-arm64` implementation; that is development evidence, not the H6 packaged/native support claim.

### 6.3 Generation fencing and shutdown

Every pending request, reverse call, event and terminal is scoped by Product Session, Sidecar generation, Runtime generation and operation identity.

On shutdown:

1. stop new admission;
2. cancel or drain reverse requests according to protocol;
3. reconcile admitted turns and mutations;
4. call `runtime/shutdown`;
5. wait for quiescence;
6. use existing process-tree termination only after grace expiry.

Crash recovery is bounded. Process exit is not a turn terminal; `turn/get` and durable Session truth decide the outcome.

## 7. Generated protocol and artifact consumption

MyAgents consumes only a pinned DSH handoff containing:

- Runtime artifact and complete file inventory;
- artifact, source and lock digests;
- protocol version and schema digest;
- generated Host client and wire types;
- Runtime/profile/session-format identity;
- capability and canonical tool fixtures;
- Provider/API-family compatibility manifest;
- supported-platform claims and evidence;
- license and notice inventory.

The following block is the exact formal `2.0.0` seed for the first implementation lock:

```text
sourceCommit                 37515ea28312dccddb854e773adb174672fc254b
protocolVersion              2.0.0
handoffManifestSha256        ae72806cae7b7b47ceba96ae38d16f95071c92b44bfe9fc96bb114670f4053c1
runtimeManifestSha256        8fccea44a04d29e6a2e2f134d4b1f9fd2192680c30316e119a398f7ae34f98c9
compatibilitySha256          7a172f0335b2df90f3c5bf8f89fae154ed4d1d13a83b07bf40497e438f189062
protocolSchemaSha256         1841590ed3c4d9f793c72a1cfda3a93808b71595c239c8fa7c38b0bfae80fd44
generatedClientSha256        fce73629088852077b09cb0b3b43b7d470b4f3a5fb936f828102aafaf8b0fe7e
dshArtifactManifestSha256    ea7918fa55540f7fe40c0849b9994ff4f197d599e40fbb69c72d8b842e6f1fe2
requiredNodeVersion          24.14.0
```

An ingestion script accepts one explicit external `--handoff <absolute-directory>` input, first executes that directory's public `verify.mjs` entrypoint with the expected handoff digest, validates the compatibility/platform facts, copies the complete Runtime directory byte-for-byte into build resources, and copies the generated client/contracts through a generated-diff gate. MyAgents code may wrap the generated client but may not hand-edit it or import verifier/package-private `src/*` paths. The accepted Runtime inventory is link-free, so ordinary Tauri/installer resource copying preserves its exact identity without a Host-side normalization hook. `build.rs` clears only Cargo's generated resource staging directory before re-emitting the authoritative source inventory, preventing incremental builds from retaining files from an older immutable handoff; it never edits the source handoff or accepted package output. Installed application startup verifies the committed lock again before marking DSH ready.

The first implementation lock must be populated from these exact handoff values after running the package's public `verify.mjs` against the trusted outer digest. Its generated client contains 40 Host methods and all four permission/Plan control-plane methods; any draft or independently reconstructed client is a hard compatibility failure.

For local Batch 3 development, that input may be a content-addressed artifact cache produced by the pinned MyAgents-dsh build. Release CI must obtain the same immutable bytes from its approved distribution asset/channel before resource staging; application startup does not fetch a floating Runtime from the network. The exact asset transport may vary by distribution policy without changing Host architecture, but every channel terminates in the same digest verifier before admission.

Create a committed MyAgents lock file, for example `src/shared/integrated-runtimes/dsh-lock.json`. Release builds reject:

- floating versions or sibling source checkout;
- missing/extra artifact files;
- hash, protocol, profile or platform drift;
- an unaccepted native-platform claim;
- development path overrides.

Development override is allowed only through an explicit developer setting and must be visibly marked `unverified-dev-runtime` in diagnostics.

## 8. Provider, credentials and configuration

### 8.1 Execution profile compiler

MyAgents compiles the selected ordinary Provider/model into the DSH `ModelExecutionProfile`:

- stable profile revision;
- Provider route and API family;
- exact model ID;
- approved base URL;
- opaque `credentialRef`;
- context window and max output;
- reasoning/effort;
- typed compatibility options;
- pricing where MyAgents has authoritative data.

The compiler consumes the exact DSH compatibility manifest and binds the included Batch 1 candidate profile identity. The delivered `batch-1-candidate-profile-v1.json` is a composition/profile manifest, not a model-route payload; the MyAgents-owned cell contract therefore freezes the native `deepseek-official` model profile against that candidate identity and the Runtime's exact validator. It does not infer compatibility merely from an OpenAI-shaped URL, a pi-ai catalog entry, or a Provider name.

The selected MyAgents-dsh design reuses the official DSH `dsh-llm-pi-ai` adapter for ordinary Anthropic Messages, OpenAI Chat Completions and OpenAI Responses routes, while retaining the native DSH DeepSeek adapter for `deepseek-official`. This does not weaken Host authority: MyAgents still compiles the frozen profile and owns credentials; the Runtime's thin control layer translates that profile into the official adapter's public settings seam and activates the Host credential port for each model request. MyAgents treats only Provider/model cells in its handoff-bound cell contract as portable.

For an ordinary API Provider, the Product Provider record is the protocol source of truth. Anthropic configuration compiles to `anthropic-messages`; OpenAI plus `chat_completions` compiles to `openai-completions`; OpenAI plus `responses` compiles to `openai-responses`. The exact allowlisted cell must agree with that derived family and with endpoint, authentication kind, model capacity and modalities. The DSH path sends that declared family directly through pi-ai and never routes it through `openai-bridge`. The legacy OpenAI-to-Anthropic Bridge remains an implementation detail of the Claude Agent SDK execution path only.

The exact cell table also carries candidate limitations: pi-ai routes do not support Host stop-sequence projection; reasoning content is available but provider reasoning-token counts are not; the bundled pi-ai catalog is advisory; AWS, Vertex, Azure and subscription/OAuth routes are not advertised. The same-release public `dsh-authorization` package is present only because `dsh-llm-pi-ai` requires it as a public peer. MyAgents must not mount its login/OAuth service or expose it as a capability.

H2 implements this boundary in `src/shared/integrated-runtimes/dsh-provider-cells-v1.json` and `src/server/integrated-runtimes/dsh/profile-compiler.ts`. The first compiler-allowlisted matrix is intentionally narrow:

| Product Provider | Models                                                     | DSH route/family                                  |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| `deepseek`       | `deepseek-v4-flash`                                        | native `deepseek-official` / `openai-completions` |
| `anthropic-api`  | `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5` | pi-ai / `anthropic-messages`                      |
| `zhipu`          | `glm-5.3`, `glm-5-turbo`                                   | pi-ai / `anthropic-messages`                      |
| `zhipu-ai`       | `glm-5.3`, `glm-5-turbo`                                   | pi-ai / `openai-completions`                      |

There is no advertised `openai-responses` product cell yet: the current built-in Responses route is `xai-sub`, whose Host-managed OAuth shape is explicitly unadvertised by the DSH compatibility contract. Other presets, custom Providers, catalog-only models, altered endpoint/auth/capacity/modalities, and Bridge-only overrides return a structured incompatibility before Runtime admission. Pi-ai cells currently accept provider-default reasoning only; the native DeepSeek cell admits the Runtime-proved off/high/max choices. A profile revision hashes the cell contract, Runtime profile digest, cell identity and complete secret-free profile. Credentials use stable POSIX-identifier references such as `MYAGENTS_PROVIDER_ANTHROPIC_API_API_KEY`; secret material is never an input to the compiler.

This table is a compiler/contract allowlist, not a release claim. H3–H6 process, packaged, cross-runtime and native-platform gates still control readiness and selector exposure.

### 8.2 Subscription providers

- `anthropic-sub` requires the Claude Agent SDK path.
- `codex-sub` requires managed Codex.
- `xai-sub` remains on Claude Agent SDK plus the MyAgents Host-managed OAuth bridge; the DSH artifact does not advertise subscription/OAuth admission.
- Settings/Launcher only save the template.
- A live incompatible Session uses the existing confirm/new-Tab flow.
- Explicit External Runtime selection continues to win over dormant subscription fields.

No DSH request is attempted for either unsupported subscription route.

### 8.3 Secret ownership

Provider and MCP secrets remain in MyAgents authorities. DSH receives only opaque references in configuration. Runtime material requests use `host/credential/resolve` and receive request- or connection-scoped values.

Secret material is never:

- persisted in Session metadata or Runtime declarative snapshots;
- written to logs, diagnostics, fixtures or support bundles;
- inherited through broad process environment;
- returned to the Renderer.

`RuntimeProcessHost` therefore constructs an explicit child environment allowlist and removes Provider/MCP/API-key variables even if the current Sidecar inherited them for another Runtime. Credential material crosses only `host/credential/resolve` and is discarded when that request/connection scope settles.

## 9. Host reverse ports

`RuntimeProcessHost` registers these generated handlers before readiness:

| Port                       | MyAgents implementation                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `host/credential/resolve`  | Provider/MCP credential owner with revision and authority checks |
| `host/interaction/request` | Existing permission, AskUser and plan interaction store/UI       |
| `host/tool/execute`        | Runtime-neutral Host tool dispatcher                             |
| `host/hook/execute`        | Existing Hook policy and lifecycle                               |
| `host/attachment/put`      | Product attachment store publication                             |
| `host/attachment/acquire`  | Scoped read-only attachment lease                                |
| `host/attachment/release`  | Exact lease settlement                                           |

The current managed-Codex Host dispatcher is useful implementation evidence, but it must be extracted into a runtime-neutral domain module before DSH consumes it. DSH calls still pass through DSH's one model-visible tool pipeline; the Host port is an executor boundary, not a second tool runtime.

For non-DeepSeek model routes, MyAgents also supplies the approved Host-backed executor for the canonical `WebSearch`/`WebFetch` definitions when the DSH compatibility manifest requires it. DSH performs catalog registration, schema validation, visibility, permission, Hook, origin and terminal handling; MyAgents executes the governed web capability through `host/tool/execute`. A Session is not advertised with the complete 20-tool profile unless this backend is ready and has passed the joint contract campaign.

Reverse calls are bounded, cancellable and generation-fenced. Host disconnect or timeout returns one protocol-defined failure and cannot leave a turn appearing idle.

H3 provides the runtime-neutral handler contract and exact registration/fencing layer. Each request must carry the active Product Session and Runtime generation plus a protocol-bounded deadline; stale authority is rejected before a product callback, peer cancellation is propagated as an `AbortSignal`, and a deadline settles as one retryable protocol failure. H4/H4P connect these callbacks to the existing credential, interaction, tool, Hook and attachment domain owners; an unwired callback can never make a Runtime selectable.

H4 now connects credential resolution, permission/question/Plan interaction settlement, the runtime-neutral Product Host-tool dispatcher, canonical Host Web and content-addressed attachment leases to those fenced reverse ports. Provider and remote-MCP credential material is resolved only inside `host/credential/resolve`; it is neither copied into declarative profiles/snapshots nor persisted in Product metadata. Admitted Product Host tools execute through `host/tool/execute`, and image/audio results become content-addressed DSH attachment references. The Host Hook boundary currently returns the explicit continue result.

`src/server/integrated-runtimes/dsh/canonical-web.ts` is the sole MyAgents executor for DSH canonical `WebFetch` and `WebSearch`. It accepts only the exact `myagents-host-canonical-web-v1` component generation, component identity, current Runtime Session and operation-frozen config revision; the outer reverse-port fence has already checked Product Session, Runtime generation and deadline. MyAgents advertises that adapter during initialize only because this executor is present. DSH still owns tool catalog/schema, visibility, permission, Hook, origin and terminal semantics.

The Host executor uses a composition-owned HTTP client with per-hop destination policy, bounded concurrency/queue/deadline, cancellation and compressed/decompressed byte limits. Direct requests use public-address DNS validation and connection pinning, reject IPv4-in-IPv6 aliases, revalidate redirects and try remaining validated addresses after a connect failure. When the user explicitly selects a MyAgents general/Provider proxy, lexical host and literal-IP policy still runs while remote DNS belongs to that proxy; this matches ordinary CLI proxy behavior and works on machines where direct DNS is intentionally unavailable. `WebFetch` converts bounded HTML to Markdown, extracts bounded PDF/text content, and makes one isolated tool-free utility call against the operation-frozen non-DeepSeek Provider. `WebSearch` uses Anthropic's server-side web-search tool, including bounded `pause_turn` continuation, or Zhipu's native Web Search API; it never falls back to HTML scraping. Provider credentials remain in Host memory and enter only the outbound request header. Failures return a stable code plus one bounded actionable message; upstream response bytes and secret-bearing diagnostics are not exposed. Zhipu `1113`/HTTP 429 is reported as missing search resource package or balance rather than a generic invalid Provider result.

Credential-free tests cover DNS pinning, redirect-to-private rejection, IPv4-in-IPv6 rejection, decompression and cancellation; exact reverse authority; Anthropic/Zhipu search projection; tool-free utility metering; HTML/PDF conversion; and an isolated production-style PDF bundle. The explicit native smoke additionally creates an Anthropic API Runtime Session against the staged artifact and proves `WebFetch`/`WebSearch` are present in the effective catalog when the versioned Host capability is advertised. This closes the canonical Host Web implementation blocker; complete 20-tool product readiness still depends on the H6 joint campaign gates.

### 9.1 Permission and Plan ownership

MyAgents keeps its product vocabulary and translates it at the DSH adapter boundary:

| MyAgents product choice | DSH base permission mode | DSH Plan state                 |
| ----------------------- | ------------------------ | ------------------------------ |
| `auto`                  | `acceptEdits`            | normal                         |
| `plan`                  | `acceptEdits`            | enter/retain with `plan/apply` |
| `fullAgency`            | `bypassPermissions`      | normal                         |

Plan is not encoded as a DSH permission string. At Session birth, `plan` compiles the deterministic `acceptEdits` base and enters Plan before the first turn. When the user changes to or from `plan`, the SessionEngine adapter applies the corresponding base configuration plus `plan/apply` with current revision facts, waits for Runtime acknowledgement, and only then updates effective UI state. Stale revisions and mismatched Plan artifacts fail closed; desired/effective drift remains visible and retryable.

Inline permission requests continue through `host/interaction/request`. One-shot allow/deny settles only that request. `always_allow` creates an exact durable Runtime rule. The adapter also exposes the generated `permission/rules/list`, `permission/rules/add`, and `permission/rules/revoke` operations so settings, diagnostics, or later policy UI can inspect and revoke authoritative Runtime state without scraping transcript events. Batch 3 need not add `default` or `dontAsk` to the ordinary desktop selector, but it must preserve them as valid protocol values and must not coerce them silently.

`plan_approval` stays a distinct interaction kind. The DSH adapter presents it through the existing ExitPlanMode review card, and the response is routed through `SessionEngine.respondPlanApproval` using pending-request ownership. The HTTP route does not call the external-session implementation directly, and a rejection with feedback remains an answered Plan review rather than an interaction cancellation.

Visibility and permission remain independent: hiding a tool is configuration; allowing it is execution policy. `fullAgency` removes interactive permission prompts but is not an OS sandbox and does not contain arbitrary Bash subprocess effects. Its UI copy must say this explicitly. Hard policy, origin/workspace/revision constraints and Hooks remain enforceable even in `fullAgency`.

H4P applies the exact birth mapping before the first turn: Session creation uses the composition-supported `default`/`host-interaction-v1` admission pair, then `config/apply` establishes `acceptEdits` or `bypassPermissions`, and `plan/apply` establishes normal or Plan state. A stale Plan revision is reconciled by reading the current mode and retrying only the desired exact transition. Live product permission/model/reasoning changes use the same configuration owner.

`AgentRuntime` and `SessionEngine` now carry the generated rule list/add/revoke capability without creating a Host policy store. The Session-scoped control route accepts only protocol-bounded identifiers and exact targets, forwards expected revisions, and fails closed for a non-DSH binding. DSH mutations are allowed only at a quiescent root boundary and are accepted after Runtime returns its awaited effect receipt; `permission/rules/list` may provide additional read-back evidence. Inline `always_allow` is single-flight for the exact Runtime interaction tuple and returns the post-effect revision. Because Runtime may synchronously emit its resolved event before the response call returns, the Host re-checks pending ownership after await and emits expiry at most once.

The composer exposes an **Allowed actions** dialog only for an active Integrated DSH Session. It reads exact rules from DSH and revokes against the displayed revision; new rules continue to originate from the existing inline **Always allow** action, where DSH derives the exact tool/class/target tuple. Exact targets are shown only in this explicit inspector. Generic Runtime diagnostics and support output carry only desired Product mode, desired/effective Runtime modes, policy revision, rule count and applied/drift state. `fullAgency` copy explicitly states that it is not an OS sandbox and that hard Host/Product checks remain. Parser, route, renderer, stateful fake-Runtime and staged native add/list/revoke evidence close H4P; H5/H6 still gate selection and release.

## 10. Events, transcript and conversation UI

### 10.1 Serialized event inbox

DSH `runtime/event` notifications enter one serialized inbox. The durable identity is:

```text
(productSessionId, runtimeSessionId, stable item/operation identity)
```

`(runtimeGeneration, sequence)` orders one generation but is not sufficient for cross-generation product-effect deduplication.

### 10.2 Projection

Project canonical DSH events into existing MyAgents domains:

| DSH event                             | MyAgents projection                          |
| ------------------------------------- | -------------------------------------------- |
| `assistant_delta`                     | assistant streaming text                     |
| `thinking_delta`                      | reasoning block                              |
| `tool start/update/end`               | one existing tool block lifecycle            |
| `interaction` + reverse request       | inline permission/question/plan block        |
| `queued_message`                      | existing queue item                          |
| `usage/context`                       | usage and context UI                         |
| `plan/task_graph/work/component`      | existing Agent status/background projections |
| `checkpoint/compaction/retry/warning` | existing status/error surfaces               |
| `turn_terminal`                       | the only authoritative turn terminal         |

If an event cannot be represented without losing user-visible semantics, extend `UnifiedEvent` and all exhaustive consumers. Do not serialize raw DSH protocol cards into the chat.

H4 implements this projection in `src/server/integrated-runtimes/dsh/event-projector.ts`. One serialized inbox fences Product Session, Runtime generation and Runtime Session, accepts only exact duplicate replay, rejects conflicting replay or a sequence gap, and projects assistant/thinking/tool/usage/context/queue/plan/work/compaction/warning/terminal events into existing `UnifiedEvent` shapes. Runtime terminal produces the Product terminal, but idle publication remains downstream of Product transcript persistence so a fast status transition cannot discard the final projected chunks.

The protocol `2.4.0` source consumer additionally treats the ready baseline and later live suffix as one ordered stream. Dedicated `context_update`, whole TaskGraph snapshots, and monotonic ProductWork lifecycle feed the existing context/Todo/Agent-status domains; Plan state remains separate from TaskGraph. Tool completion joins ordered text blocks and resolves supported DSH image references through an exact attachment lease into the existing Host attachment store. These source changes do not change the accepted handoff facts in the frontmatter: MyAgents remains locked to `2.3.0` until the official immutable `2.4.0` handoff is generated, verified, and ingested.

H4 also reconciles the ordinary terminal/persistence crash window before a resumed Runtime becomes usable. `session/read` first verifies the complete native cursor chain and event digests; independent `turn/get` results must then match every durable admission and terminal exactly. A succeeded terminal's `assistantEventId` must resolve to the claimed final native `assistant/message`, from which text, reasoning, settled tool calls/results and terminal usage are deterministically projected. `SessionStore` inserts a missing assistant beside its exact Product user row under the transcript/index locks and commits a versioned `dshProjectionCursor`; exact replay is a no-op, while conflicting anchors, an unowned assistant, malformed history or divergent terminal truth fail closed. Non-success terminals never manufacture assistant rows.

An admitted operation that remains non-terminal after `session/resume` is now taken over without starting a competing root turn. Reconciliation permits exactly one such operation, cross-checks its admission through `turn/get`, and requires its exact Product user owner to exist without a conflicting assistant. The DSH process seeds the recovered `clientOperationId`/`clientUserMessageId`, buffers startup events and reverse interactions until that correlation is installed, then replays them in order. The Product Session restores the active root anchor and queues a concurrently submitted new message behind the recovered turn; terminal persistence completes before that queue drains. Failed or intentionally stopped turns with model-visible output persist one assistant projection marked `completionState:'partial'` plus the truthful terminal status before later queued work can enter admission; they are never published as successful completions.

The pre-native-admission crash window is closed by the Product-owned `pendingDshRootOperation` journal. Product first persists the exact Runtime Session, `clientOperationId`, Product user ID, ordered attachment-byte digests and an immutable input fingerprint, then appends the Product user, and only then sends `turn/start`. Startup reconciliation compares that journal with the complete native operation set: a journal with no Product user and no native admission is discarded, a matching native active turn is taken over, a matching terminal is reconciled before clearing, and a Product user with no native admission is replayed with the same operation ID and byte-verified images. Any identity, fingerprint, Product owner, image or native-operation mismatch fails closed; later Product work remains queued until the recovered operation reaches Product terminal persistence.

### 10.3 Dual authorities without dual transcript

DSH native history is the durable model-conversation authority for DSH resume. MyAgents `SessionStore` is the Product transcript authority for product UI, search and cross-feature linkage.

This is a projection relationship, not two competing model transcripts:

- MyAgents never reconstructs DSH native state from rendered transcript;
- DSH never becomes the Product transcript store;
- restore uses `session/resume` and `session/read` to reconcile native truth with idempotent Product projection;
- success is not published upward until Runtime terminal truth and required Product persistence have both settled.

### 10.4 Runtime-owned automatic and explicit compaction

The accepted Runtime composition installs the official DSH `TokenMeter`, official `ToolResultPruner`, and official `BasicCompactionEngine` in that order, with `auto: true`; the locked DSH patch series strengthens capacity safety without moving ownership into MyAgents. DSH remains the only owner of pressure measurement, range selection, summary generation, durable surface replacement, overflow retry and compaction recovery.

Automatic pressure is model-aware at each admitted request. The Runtime resolves the exact routed model profile, derives the current pressure threshold and verbatim-tail target from that model's context window, and handles provider-confirmed overflow through the same durable compaction authority. MyAgents supplies the admitted Provider/model capacity facts once through the exact execution profile; it must not maintain a second compaction threshold table, generate summaries, rewrite native history, or infer compaction success from reduced Product transcript length.

MyAgents projects canonical compaction events and context metrics into its existing status/context surfaces. A user-initiated compact action calls `session/compact` only through the DSH SessionEngine capability at an idle/quiescent boundary and correlates its `clientOperationId` with durable Runtime settlement. Automatic and explicit compaction share the same DSH engine; the Host does not create a second memory subsystem or transcript. Repeated-compaction, restart continuity, provider-overflow and explicit-operation recovery are joint acceptance requirements for the exact staged artifact.

## 11. Queue, steering and stop

- Use the existing SessionEngine queue owner for Product admission.
- Active DSH turns use protocol `turn/steer` only when current product policy selects steering.
- Follow-ups use `turn/followUp` with stable message IDs.
- Queue cancellation uses `turn/message/cancel`.
- Stop uses the exact admitted `clientOperationId` with `turn/interrupt`; no global “current operation” guess is allowed.
- The returned queue settlement and later terminal event are reconciled before the UI becomes idle.
- Force-send records the selected queue identity before interrupting, classifies the expected abort as a stopped control transfer, persists any partial projection, then drains that selected item exactly once.
- Queue drain waits terminal persistence and exact DSH operation settlement; a failed barrier cancels affected work explicitly instead of admitting against an uncertain native prefix.

For realtime response mode, the current Host generation may call `turn/steer` only after its own
`turn/start` acknowledgement and only while the active root identity exactly matches the
`pendingDshRootOperation` journal. That journal is durable admission proof for a normally active
root, not by itself a reason to downgrade realtime input to a turn-boundary queue. A root taken
over after resume, or replayed from a pre-native-admission journal, remains explicitly ineligible
for realtime steering until its exact terminal settles; DSH mutation journals continue to block
all message admission.

The current historical fallback that tries an External stop and then Builtin interrupt must not apply to a DSH-bound Session.

H4 reuses the existing Product admission queue and transcript owners through an explicitly `integrated` SessionEngine adapter; this is physical code reuse, not External Runtime classification. An active DSH turn uses exact `turn/steer`, stop uses the admitted operation identity with `turn/interrupt`, and explicit compaction uses `session/compact`. Pre-admission follow-up cancellation remains Product-owned. Ordinary succeeded-terminal loss between DSH durability and Product assistant persistence is reconciled through matching `turn/get` and verified `session/read` truth. A Runtime-durable non-terminal operation is taken over under the same exact identity, while newly submitted Product work waits for its terminal boundary. If Product durability wins before native admission, the immutable `pendingDshRootOperation` is replayed with its original Product user and `clientOperationId`; terminal publication clears it only after the required Product persistence settles. Live Product extension changes now use the same terminal boundary owner rather than scheduling a compatibility-Runtime restart. Exact permission rules use the same facade and remain DSH-owned.

The reliability closure also binds every retryable `chat:agent-error` to its exact Product user message when one exists. Pre-admission dispatch failures carry their original user identity; if that projection has already been retracted, Renderer disables retry instead of guessing the latest visible user. Renderer waits for the authoritative Server mutation before truncating the visible branch and resending.

## 12. Configuration and extension updates

MyAgents maintains desired and effective revisions for:

- Provider/model and reasoning;
- permission mode and interaction scenario;
- structured system context;
- execution environment;
- MCP, Skills, agents, commands, Hooks and Host tools.

Apply according to negotiated DSH modes:

- next-turn changes wait for or apply at a stable turn boundary;
- restart-when-idle changes schedule a bounded Runtime replacement;
- unsupported changes are rejected before updating effective UI;
- failed apply leaves desired/effective drift visible and recoverable.

Protocol `2.3.0` retains the generic system-context configuration introduced by `2.2.0` instead of requiring a Runtime-owned MyAgents
shape. The Host sends named ordered `sections` and `contexts`, each scoped `global` or `root`.
`system-prompt.ts` owns the recommended MyAgents profile: stable product identity and capability
routing are global, scenario/session behavior is root-only, and the optional Claude companion
Workspace supplement is a literal global context. `external-session.ts` freezes that snapshot from
the actual admission scenario; `integrated-runtimes/dsh/runtime.ts` sends the same snapshot on
create/resume/config apply and fingerprints its canonical JSON for revision identity. Product
business changes therefore stay in MyAgents rather than requiring a Runtime release.

Primary Workspace authority remains inside DSH. For each root or nested directory it selects the
first non-empty `CLAUDE.md`, `AGENTS.override.md`, `AGENTS.md` and owns durable change/removal,
resume and compaction behavior. MyAgents' bounded collector supplies only
`.claude/CLAUDE.md` plus deterministically sorted `.claude/rules/**/*.md`; it does not duplicate
the root primary files. New structured input requires the legacy `systemPrompt` string to be empty,
while direct legacy callers without a snapshot retain the old migration path.

Declarative extension snapshots contain only validated descriptors and references. Arbitrary Plugin JavaScript is never sent into DSH; trusted runtime plugins remain build-time DSH composition.

H4 now compiles the existing Product capability winners into one deterministic DSH extension snapshot before Session admission. It re-reads and digest-verifies admitted Skill documents, projects Skills/commands/agents, admits HTTP/SSE and local stdio MCP descriptors, and exposes Product in-process MCP/IM tools through DSH `host_tool` components backed by the runtime-neutral dispatcher in `src/server/runtimes/product-extensions/`. Project Skills may additionally bind their exact package directory through `skillSourcePolicy`; DSH exposes that base only on Skill invocation, while package resources remain on-demand ordinary tool inputs. Header/env material remains only in generation-scoped Host bindings and crosses the MCP credential reverse port for an exact component/digest/revision request. The compiler uses the intersection of protocol `2.3.0` and the exact accepted Runtime compiler constraints; unsupported schema/name inputs degrade only their component and are published through DSH-owned Runtime diagnostics and Logs.

Session Sidecar HTTP readiness may precede the first Product Session workspace binding. Mount-time Agent/MCP projection received in that interval is acknowledged as `pending_next_start` with `awaiting_product_session_owner`, not failed: the durable Agent/Project/Session sources are compiled by the same owner during Session birth. Once the owner is bound, live changes continue through normal immutable generation replacement. This staging rule does not suppress real compiler, admission or Runtime failures; those still produce component diagnostics and unified-log evidence.

The accepted component contract applies uniformly to Skill, command, agent, MCP and Host-tool inputs. A missing compiler, descriptor/prepare failure, catalog collision or locally reversible install failure omits only the affected component while the requested snapshot revision becomes effective. MyAgents consumes the exact per-component receipt, admits receipt-backed Skill and Host-tool omissions during catalog read-back, publishes the issue through Runtime diagnostics and emits one bounded unified-log warning per non-ready component. Generation-wide failure is reserved for integrity failures where cleanup or rollback cannot restore a coherent snapshot; those remain fail-closed.

For stdio MCP, the exact extension generation now carries only normalized non-secret argv/cwd under
an opaque launch-profile reference. Effective env is bound to the existing
`host/credential/resolve` path with an opaque keyed revision and is passed to the Runtime only for
connection preparation. Runtime launches through its DSH subprocess Provider and publishes
discovered definitions only through `ctx.tools`; the Host does not proxy MCP calls.
`extension/replace`, returned effective revision/digest, Skill read-back and Host-tool catalog
presence are verified before Session binding.

Live MCP/Skill/agent/command/Plugin/Host-tool changes compile a fresh immutable plane, attach a fresh Host dispatcher, register it by the protocol identity `componentGenerationId = revision:digest`, and call `extension/replace` without restarting the Sidecar or DSH process. `queued` remains desired/effective drift and is retried from both the successful and failed Product turn-finalization paths before queue drain; the DSH adapter also reconciles before admitting a later root turn. `applied` is accepted only after `extension/catalog` proves the exact revision, digest, Skill read-back and Host-tool catalog, then publishes the new Runtime tool catalog and diagnostics. `failed` releases only the rejected candidate and leaves the old effective plane usable.

Reverse MCP credential and Host-tool calls select their Host plane by the exact generation carried in request authority; a stale or unknown generation fails before credential material or a Product dispatcher is reached. A once-effective old plane remains registered until the DSH process generation closes because protocol `2.3.0` permits background work to drain the previous component generation but exposes no Host retirement acknowledgement. Candidate generations that DSH explicitly rejects or replaces are released immediately. This bounded process-generation ownership prevents both cross-generation dispatch and premature cleanup. Live capability changes no longer set the compatibility Runtime restart latch. These semantics complete the live-extension implementation slice; H5 subsequently admits DSH only through development Labs/readiness policy, while H6 still gates promotion.

## 13. Mutations and native history

Fork, rewind and delete/purge use the DSH prepare/commit/status protocols plus existing Product owners.

General transaction rule:

1. MyAgents records Product intent and stable mutation ID;
2. DSH prepares and returns its durable receipt/postconditions;
3. MyAgents stages Product transcript/metadata/workspace changes;
4. DSH and Product commits are coordinated in the method-specific order;
5. crash recovery queries mutation status and resumes or rolls back;
6. UI reports complete only after both authorities satisfy postconditions.

Rewind's file rollback claim remains limited to governed root-origin Write/Edit. The UI and documentation must not imply shell, child or external modifications are rolled back.

Retry is admission-aware for DSH. Every persisted Product user records `runtimeOperationAnchor={runtime:'dsh',clientOperationId,runtimeSessionId}` before `turn/start`. `/chat/external-retry` verifies that anchor and queries native `turn/get`: a proven never-admitted tail may be removed Product-side only, while an admitted operation must complete the coordinated DSH rewind before Product truncation. Protocol `2.3.0` retains the opaque `genesisBoundary` introduced by `2.1.0`, so the first admitted turn uses the same transaction rather than a Product-only empty-history guess.

No operation ever resumes DSH native history using Claude SDK, Pi, managed Codex or an External CLI.

H4 now implements the Product half as a bounded `pendingDshMutation` journal in authoritative Session metadata and the Runtime half through `src/server/integrated-runtimes/dsh/mutations.ts`. `session/read` is assembled only after its cursor chain, durable head, contiguous sequence, event SHA-256 values, chunk boundaries, transcript postcondition and unique stable boundary all verify. The method-specific settlement is:

- fork: persist Product intent, prepare DSH, fsync the token and stable boundary, stage an invisible Product target, commit DSH, then atomically publish the target and retire the source journal;
- rewind: persist the target Product prefix and DSH turn anchor, prepare and commit DSH native generation plus governed root-origin Write/Edit rollback, then replace Product JSONL and retire the journal;
- delete: persist Product intent, prepare and tombstone DSH, hide the Product projection, purge native state, then remove Product JSONL and metadata through the existing Rust-owned deletion lifecycle fence.

If fork Product staging fails, the Host persists an abort decision before asking DSH to abort; recovery never guesses between publish and rollback. A token lost after Runtime prepare is recovered only by exact replay of the same mutation ID and immutable fingerprint. Any remaining journal keeps the Session busy, blocks queue drain and triggers a clean Runtime resume/recovery before later admission. Fork targets remain history-invisible until both commit identities match; tombstoned deletes remain invisible until purge and Product removal finish. Fault-injected Product tests cover hidden fork publication, exact prepare replay, durable abort choice, rewind recovery between JSONL replacement and index publication, and delete tombstone/purge recovery.

## 14. Desktop and settings UX

### 14.1 Runtime selector

Reuse the current selector placement, grouped as:

- Integrated: MyAgents (Claude Agent SDK), MyAgents (DSH);
- External CLI: Claude Code, Codex, Gemini.

Managed Codex is not listed. Pi is not listed until integrated.

Each item uses the readiness result from the resolver/artifact verifier: ready, setup required, update required, unavailable, incompatible or experimental.

H5 keeps this taxonomy intact in the shared `RuntimeSelector`: DSH appears in the Integrated group, while Claude Code, Codex and Gemini remain External CLI. The Rust detection owner resolves the installed application resource directory, reads the committed DSH lock and verifies the supported target, sealed outer handoff digest, nested Runtime manifest digest, compatibility digest, required entrypoints and platform claim before returning an installed result. The accepted Batch 3 artifact is intentionally labelled `experimental` / `unverified-dev-runtime`; missing, malformed, digest-mismatched or platform-invalid resources are unavailable and cannot admit a Chat or Launcher send. Session admission then runs the public outer verifier and Runtime self-check, which rebind the complete nested inventories before spawn. The Renderer does not infer readiness from a directory or executable alone.

Developer Settings also exposes `config.defaultIntegratedRuntime`, with options derived only from the build policy's allowed Integrated Runtimes. The override is used for new ordinary-provider Session birth when the selector is unavailable; an absent, malformed or no-longer-allowed value falls back to the build default. Changing it never rewrites an existing frozen Session. A one-runtime distribution keeps the control disabled at its sole admitted value.

### 14.2 Change behavior

- Settings/Launcher: save Agent template; toast that a new Tab uses it.
- Live compatible model change: preserve existing policy.
- Live incompatible Provider/Runtime change: existing confirm dialog, preserve current Session, create a new Session and open its Tab.
- Cancel: no template/session mutation.
- Failed new birth: keep old Tab intact and show actionable error.

The Provider picker is a Product execution catalog rather than a raw DSH-cell list. Under DSH, ordinary API Providers/models remain filtered by the exact handoff-bound DSH cell contract, while Managed Codex remains visible as the runtime-backed `codex-sub` choice. Selecting it always crosses the existing history boundary into a Managed Codex Session and never treats Codex as DSH-compatible. The Agent's authoritative Integrated Runtime preference remains unchanged, so leaving Managed Codex for an ordinary compatible Provider returns to the previously selected DSH or Claude Agent SDK Runtime. Claude-owned subscription Providers remain bound to their declared Integrated owner.

Agent, Channel, Settings and Launcher changes atomically persist the authoritative `AgentRuntimePreference` with their legacy `runtime`/`runtimeConfig` compatibility projection. The preference wins whenever both exist; malformed authoritative preference fails closed instead of falling back to a possibly stale legacy Runtime. Product configuration remains Product configuration for DSH: Provider/model, exact permission mode, reasoning effort, MCP, Plugins and related capabilities are not moved into the External CLI configuration object. Provider/model choices are filtered by the handoff-bound DSH cell contract, and an incompatible or incomplete pair is rejected before Session birth.

### 14.3 Conversation

DSH uses existing MessageList, composer, queue, stop, inline tool/permission/question/plan cards, attachment pipeline, history actions and status panel. Every visible control must call a real SessionEngine capability. Permission/AskUser cards settle through the reverse request exactly once; switching the product to Plan uses `plan/apply`, not a decorative local state; any exact always-allow rule shown by product UI is read from Runtime and is revocable through the generated rule API.

## 15. IM, Agent Channel and automation

### 15.1 IM/Agent Channel

Generalize the current full runtime identity comparison to `EffectiveRuntimeBinding` compatibility:

- compatible live config continues through the same Session;
- incompatible identity change freezes the old Session;
- a new UUID/binding is created;
- the existing user notification is sent;
- old owner is released only through current lifecycle authority;
- message-time and Heartbeat checks remain fallback repair.

H5 applies the same resolution order in the Rust IM owner: frozen binding when present; otherwise root selector/distribution gate plus allowlisted Default Integrated Runtime, authoritative Channel/Agent preference, Provider execution constraint, readiness and then legacy compatibility projection. Explicit External CLI preference wins over a dormant subscription field while the selector is available; managed-Codex projection occurs only when the selected Integrated Runtime remains builtin. DSH is always projected as `runtime='dsh'` plus `source='integrated'`, and its message snapshot retains the Product Provider route, model, environment, permission and extension configuration. An invalid authoritative preference disables the Channel instead of silently starting another Runtime. Runtime-change, message-time and Heartbeat paths compare this complete canonical identity.

### 15.2 Tasks, Cron, Goal and injected work

Birth snapshots freeze the exact effective binding selected by the central resolver. Runtime changes do not rewrite already-running operations.

All queues, cancellation, terminal reporting and owner release continue through SessionEngine. A DSH adapter cannot require the Renderer to be mounted.

Task/Cron birth resolves the same authoritative preference and freezes the resulting binding; an already materialized DSH Task remains executable when Labs is later hidden, while a new inherited Task follows the current gate. The Task editor and admin API enforce the exact DSH Provider/model cells and canonical `integrated` source. Goal and injected work stay bound to their existing `SessionEngine`; Inbox reads the target Sidecar's live Runtime identity at materialization, so its new Product Session freezes DSH/integrated rather than reconstructing identity from Renderer state.

## 16. Persistence and migration

Implementation introduces versioned schema migration for:

- distribution policy/default;
- root Developer Default Integrated Runtime override;
- Agent runtime preference;
- Session effective binding;
- Provider execution constraint/identity;
- DSH native runtime metadata and projection cursor;
- pending DSH operations and mutations.

Migration requirements:

- idempotent and restart-safe;
- preserves old fields until all supported readers migrate;
- never changes an existing Session's runtime semantics;
- unknown binding becomes an explicit compatibility state;
- legacy `builtin` remains Claude Agent SDK unless an existing managed-Codex projection proves otherwise;
- backup/export/import retains frozen binding facts.

## 17. Packaging, update and platform policy

The MyAgents build stages the exact DSH Runtime directory; it does not bundle it as one guessed esbuild file. Tauri resources include its full verified inventory and notices. Resource staging is content-addressed by the committed handoff/Runtime digests and rejects symlinks, missing files, extra files and post-copy mutation.

Supported claims:

- macOS arm64, Windows x64 and Linux x64 are all `implementation-complete_pending-native-validation` in the supplied formal `2.0.0` handoff;
- MyAgents may mark a platform path verified only after an updated exact handoff carries passing native Runtime evidence and MyAgents' own packaged smoke passes against that nested manifest;
- the UI must not turn “implementation complete” into “verified”.

Updates are atomic and side-by-side by artifact identity. Existing Sessions may require their compatible artifact to remain available. Garbage collection cannot remove an artifact referenced by a retained executable Session.

## 18. Security and observability

Structured logs include:

- Product Session and Sidecar/Runtime generation;
- resolver decision codes;
- artifact/protocol/profile identities;
- request method, operation/item/interaction identity and duration;
- queue/stop/config/mutation state;
- process exit and reconciliation result.

Logs exclude:

- credentials and authorization material;
- prompt, assistant, thinking and tool payload text;
- raw attachment bytes and user file contents;
- private system prompts and arbitrary Provider error bodies.

The support surface exposes redacted readiness and lifecycle facts plus recovery actions. A DSH failure must be diagnosable without opening the Runtime's durable conversation files.

## 19. Proposed code ownership map

Suggested paths; exact names may change without changing owners:

```text
src/shared/integrated-runtimes/
  identity.ts
  distribution-policy.ts
  resolver.ts
  provider-constraints.ts
  dsh-compatibility.ts
  dsh-provider-cells.ts
  dsh-provider-cells-v1.json
  dsh-lock.json

scripts/integrated-runtimes/
  ingest-dsh-handoff.mjs
  verify-dsh-resources.mjs

src/server/integrated-runtimes/dsh/
  adapter.ts
  child-environment.ts
  generated-client.ts
  host-ports.ts
  initialize.ts
  installation.ts
  process-host.ts
  protocol-types.ts
  event-projector.ts
  profile-compiler.ts
  extension-compiler.ts
  lifecycle.ts
  mutations.ts

src/server/runtimes/product-extensions/
  contracts.ts
  host-dispatcher.ts

src/server/session-engine/
  selector.ts
  types.ts

src-tauri/src/sidecar/
  runtime_identity.rs
  session_lifecycle.rs
  types.rs
```

Likely shared refactors:

- generalize `src/shared/providerExecution.ts` from Codex-only execution intent;
- replace binary `shouldUseExternalRuntime` decisions at product seams;
- extract the Host tool dispatcher from managed-Codex-specific placement;
- extend `UnifiedEvent` only for proven projection gaps;
- preserve current Chat/Launcher/Agent Settings transition components;
- update build-resource staging and Tauri resource manifests;
- verify the single bundled Node against the exact Runtime requirement and pin MyAgents' bundled npm distribution independently before DSH process work begins.

## 20. Verification and release gates

### 20.1 Deterministic tests

- distribution policy and resolver matrix;
- all legal/illegal legacy identity conversions;
- explicit External versus dormant subscription precedence;
- `anthropic-sub` and `codex-sub` required-runtime behavior;
- Settings/Launcher versus active Chat transition behavior;
- frozen Session behavior with selector hidden and with distribution exclusion;
- DSH handshake/artifact/schema/capability mismatch;
- exact handoff ingestion, generated-diff, complete-inventory, bundled-Node mismatch rejection, and deterministic bundled-npm resource validation;
- native DeepSeek plus every explicitly allowlisted pi-ai Provider/model cell, including rejection of catalog-only and OAuth/cloud cells;
- generated RPC client, reverse ports and cancellation;
- event ordering, reconnect replay and cross-generation dedupe;
- queue/follow-up/steer/stop races;
- configuration desired/effective transitions;
- live extension idle apply, active-turn queue/promotion, generation-fenced reverse routing, failed-candidate rollback and process-generation cleanup;
- all four DSH base permission modes, accepted `auto/plan/fullAgency` mappings, Plan enter/exit/retry/stale revision, exact rule add/list/revoke/restart, interaction settlement and timeout;
- `fullAgency` still obeys hard policy, origin/workspace/revision constraints and Host Hook deny;
- automatic model-aware compaction, explicit `session/compact`, repeated-compaction/restart continuity, provider-overflow recovery, and rejection of any Host-owned summary or pressure policy;
- transcript terminal/persistence failure reconciliation;
- fork/rewind/delete crash points;
- IM rotation and Heartbeat fallback;
- artifact staging/path/symlink/tamper rejection;
- credential canaries and log redaction.

Default tests use fake model and Host adapters, temporary homes/workspaces and no real network or credentials.

### 20.2 Product integration campaigns

Against the exact staged DSH artifact:

- J1–J18 from the accepted PRD;
- Desktop, IM, Task/Cron, Goal, Inbox and injected entry points;
- ordinary Provider routes for every advertised API-family cell;
- permission and AskUser inline, Host Plan transitions, exact always-allow rule creation/revocation, and no inert permission controls;
- tools, MCP, Skills, Host tools, Hooks, attachment/image;
- restart/resume, operation uncertainty and mutation recovery;
- packaged macOS arm64 smoke and native Windows/Linux campaigns before verified claims;
- bounded soak with process/memory/file-descriptor checks.

### 20.3 Repository gates

At promotion:

```bash
npm run typecheck
npm run lint
npm test
npm run build:web
npm run build:server
npm run build:bridge
npm run build:cli
npm run verify:dsh-runtime
```

Also run Rust tests, DSH/MyAgents cross-contract conformance, generated-diff checks and the applicable platform's production build script plus native packaged smoke required by the release candidate. The exact script surface is owned by `package.json`; this repository does not define a generic `npm run build` command.

## 21. Implementation sequence

1. Preserve the current dirty worktree, verify every single-bundled-Node version authority at `24.14.0`, pin the separately owned bundled-npm resource, and land explicit-path exact handoff ingestion/resource verification.
2. Land identity, distribution policy, resolver and legal/illegal legacy fixtures.
3. Generalize Provider execution constraints and preserve existing transition behavior.
4. Land the exact Provider/model cell compiler plus the formal `2.0.0` generated protocol client.
5. Build `RuntimeProcessHost`, reverse ports, sanitized child environment and handshake.
6. Build the DSH SessionEngine adapter, serialized event inbox, projection and transcript reconciliation.
7. Connect queue/steer/follow-up/stop, configuration, interactions, Host Plan, exact permission-rule management, extensions and Host canonical web.
8. Connect mutation and recovery protocols.
9. Migrate every non-Desktop entry point through the same resolver/adapter.
10. Expose grouped selector/readiness and existing new-Tab behavior.
11. Run deterministic, packaged and cross-repository J1–J18 acceptance; only then promote beyond the development-only Labs/readiness path.

Each step updates an implementation ledger in this document or a linked dev plan. Partial code does not make DSH selectable.

### 21.1 Implementation ledger

| ID        | Action                                                                                 | Status        |
| --------- | -------------------------------------------------------------------------------------- | ------------- |
| MA-B3-RFC | Current-code and exact-handoff technical review                                        | `complete`    |
| MA-B3-H0  | Node/npm resource authority, formal `2.0.0` handoff ingest, lock and resource verifier | `complete`    |
| MA-B3-H1  | Runtime identity, policy, resolver and persistence migration                           | `complete`    |
| MA-B3-H2  | Provider constraints and exact DSH profile compiler                                    | `complete`    |
| MA-B3-H3  | RuntimeProcessHost, 40-method formal `2.0.0` generated client and seven reverse ports  | `complete`    |
| MA-B3-H4  | SessionEngine adapter, projection, queue/config/extensions/interaction/mutation/recovery | `complete`    |
| MA-B3-H4P | `auto/plan/fullAgency` translation, Host Plan and exact permission-rule adapter        | `complete`    |
| MA-B3-H5  | Desktop/IM/Task/Goal/Inbox UI and entrypoint integration                               | `complete`    |
| MA-B3-H6  | Packaged cross-repository J1–J18 acceptance                                            | `in_progress` |
| B3-XR-REL | Force/partial/retry/genesis/permission reliability implementation and refreshed handoff | `complete`; signed/package acceptance pending |
| B3-XR-DOG | Bash env, Grep concurrency/file path, TaskStop terminal and canonical Web dogfood closure | `in_progress`; handoff ingested, package acceptance pending |
| B3-XR-SCTX | Generic DSH system context, project-instruction precedence and literal Host/child bodies | `in_progress`; implementation, credentialed quality/cache and refreshed local unsigned macOS package acceptance complete; signed/cross-platform acceptance pending |
| B3-XR-SKILL-MCP | Ordered workspace Skill packages and local stdio MCP through DSH-native owners | `complete`; exact `2.3.0` handoff, Host gates and refreshed local unsigned macOS package/native acceptance pass |

### 21.2 Current implementation evidence

H5 and its direct ownership audit are closed on the `dev/intergration_myagents-dsh` worktree at `f2aa6334c540453063cf8af31150e9f72742e934`, with deterministic/package evidence at `f4ba61515ac2e7b5da52d0a333c73257385ec5a4` and follow-up authority fixes through `b9bc80374442fd5904153f1c75da7156460f87b6`. `ab046c1593e8ab0c34eb17e07f1f10d77f34969c` makes the distribution policy authoritative in Renderer, Rust Session birth and IM; `b9bc80374442fd5904153f1c75da7156460f87b6` adds the allowlisted Developer default across those owners and fixes DSH legacy projection to exact `dsh/integrated`. The current worktree consumes workspace-Skills/stdio-MCP handoff `999a80f5d9cc33f858cf3c11a8031a431ad8303221ddf0a3ec74452cb265dba7`, Runtime `4b3bc9de9a00b58c5284eb21563fb0e8fc64dbf1b6b98f458056d8da78b8959e`, compatibility `dbedcc9ef0632833d82c7707ae4267f10d275ee00e922bbd20e1c1625f1216f3`, protocol `2.3.0`, and exact Node/npm `24.14.0` / `11.15.0` across development, build provenance and bundled resources. The official ingestion command verifies the external handoff, atomically replaces the complete resource directory, and verifies the staged copy against the committed lock.

The 2026-08-30 Provider portability refresh adds exact `zhipu` Coding Plan cells for `glm-5.3` and `glm-5-turbo` as direct `anthropic-messages`, while retaining `zhipu-ai` as direct `openai-completions`. Provider `apiProtocol/upstreamFormat` remains the source of truth, and the DSH path uses no Claude SDK Bridge. The refreshed Runtime also removes recursive Task metadata from all model-visible tool schemas. Its pre-artifact report is `e03caaf4865c275e123897a055a3ac27a4b73871363d07c3c760ac64d28d2853`; the outer handoff and an independent transfer copy both verify. A user-authorized local Zhipu Coding Plan credential then passed the official `approved-route` `coding-workspace` campaign against exact Runtime `8fccea44a04d29e6a2e2f134d4b1f9fd2192680c30316e119a398f7ae34f98c9`; sealed evidence `dbcbf4e8486e9824a74628de76a4054586fc6ce1118dc2ff1a5934155996ab62` proves exact artifact/generated-client identity, one successful terminal, the scenario postcondition and zero retained Runtime resources. The credential remained request-scoped and is not part of repository or evidence bytes. H6 stays `in_progress` because signed distribution, Windows/Linux native validation and the remaining J1–J18 product campaign are not promoted by this focused Runtime campaign.

The subsequent Host Skill compatibility refresh consumes handoff `1d7aa2a843eb32e0bfd8b635ce6e192bbb1b670eb7f6fd42ed753cfea2491c27` and Runtime `fb68cf4d13f87ccc62601baf4cb6001a61cf9f81f3674d61b981aee376e946f0` from source `10ed2ac8b79c13b0d6c11d9b324803b178dcb70a`. Model-visible Skill descriptions are normalized and truncated to 1,024 code points; one structurally valid Skill's prepare/install failure degrades and omits only that Skill. The protocol and generated Host client remain unchanged. The official ingestion command and staged-resource verifier pass against exact bundled Node/npm `24.14.0` / `11.15.0`.

The component-isolation refresh consumes handoff `09f020404c91f1d40d92841cd8342a0bdbe984fdf01428a508842a0ece751fc3`, Runtime `ae11ba1e41503b8d3518d4a1153f05bafc061fa9c6df54c777d9ce995390869c` and compatibility `8ba0c0e96f9943af75fca0f8559064bbc247ddf4ce831793299ecf0aa3cf2c4c` from source `947d02e38f5a386413930bfb5470af90b2ec205d`. It generalizes single-component isolation to every declarative component kind, records non-ready receipts in unified logs, omits the Product command `UPDATE_MEMORY` because its uppercase identity is outside the exact DSH command grammar, and separates the Session-binding baseline revision from the final Product configuration revision. An agent-error terminal now also settles Renderer streaming state so a failed admission cannot leave the Chat loading indefinitely. The official handoff verifier, ingestion command and staged-resource verifier all pass with exact bundled Node/npm `24.14.0` / `11.15.0`.

The runtime-backed Provider and owner-staging follow-up keeps Managed Codex visible beside exact DSH Provider cells without admitting it through DSH, preserves the Agent's base Integrated Runtime across Managed Codex entry/exit, and acknowledges pre-owner Agent/MCP hydration as `pending_next_start` instead of a false 500. Actual compiler/component failures remain observable. Exact Node `24.14.0` / npm `11.15.0` typecheck, lint, all four Web/Server/Bridge/CLI builds and the complete test suite pass; integration reports 477 passed with two opt-in native tests skipped by default.

The interaction-reliability refresh records force-transfer intent before interrupt, persists failed/stopped partial output before queue drain, settles the exact DSH Product operation before later admission, and makes banner retry native-admission-aware. First-turn rewind consumes protocol `2.1.0` genesis truth. Permission settlement is single-flight per exact Runtime tuple and the Host expires a synchronously resolved interaction once. Structural transcript retraction is a critical SSE event. Exact Node `24.14.0` / npm `11.15.0` typecheck, lint, focused stateful tests, the complete 479-test integration project (two opt-in native tests skipped), and Web/Server/Bridge/CLI builds pass. The official `2.1.0` handoff ingestion and staged-resource verifier pass against handoff `5ee7a6f07557b03a2e1353533fb5b3744148d20894d6f01699d8a0c61255e705`; an explicit native `RuntimeProcessHost` smoke then handshakes with and shuts down that exact staged Runtime. Signed-package and Windows/Linux native acceptance remain open H6 gates.

The restart-safe permission refresh consumes handoff `ae03ee3086571513b6c50c385b4783808fbfc2737a0814822a7c2f08091a6f6b`, Runtime `bb6678a258c9769ed8179461beeafc7e792e1f291913765c014941a18b3e3851`, and compatibility `8ba59b37c7e04397e7c75daaef6ba1267169a8d39597c045a20b41b8164fea0a` from source `4b3f2bdad1fd4860fca212c49b3ac3f527a51a30`. Existing Sessions now bind `session/resume` with the Product's effective permission/config revision before persisted-state validation, while fresh Sessions retain the default bootstrap followed by `config/apply`. Recovery without a Product mutation journal preserves the Runtime's non-mutation reason instead of inventing a journal mismatch. The exact staged Runtime native smoke now creates a Session, applies `acceptEdits`, stops the Runtime process, resumes the same native Session from durable storage, and verifies the restored effective permission mode.

The subsequent Session-surface audit treats `integrated` as a first-class non-builtin SessionEngine kind across IM, Heartbeat and Memory, and preserves `RuntimeSource:'integrated'` through Task validation, Cron transport and Sidecar birth. Inbox delivery now requires a parseable positive target acknowledgement. Native DSH/Codex fork targets use a caller-owned Product Session ID so a lost HTTP response can be reconciled without creating an unreachable branch; DSH rewind and retry use the same restore-and-classify rule already required for Codex. These are Host integration semantics and do not add a second DSH conversation owner.

The DSH first-response follow-up moves integrated DSH into the same shared persistent-Runtime prewarm policy as Codex and Gemini, so process startup, native Session resume and extension activation begin when the Chat surface becomes ready rather than after the first query. DSH may emit reasoning as delta-only protocol events; the Host now synthesizes the Product thinking lifecycle before projection, closes it at every content boundary, and coalesces only same-index reasoning chunks through the existing bounded SSE window. Turn telemetry records the first thinking-or-text delta as the actual first model output and also records separate first-thinking and first-text timings. This is a Host projection/performance change; it does not alter DSH conversation authority or the native protocol contract.

The runtime-capability closure consumes source `ec2ab38b465995a6844bb71f78780fccea471041`, Runtime `2c08c37173e5f84e7296fae5ea41ae9054aff247b1656400a25c9b08db8dc270`, compatibility `c579ea3ab37616fa2497453a6015651268f8929217fe3fa3b86f257f0264254e`, and handoff `441d46bb88cc66d410d2f989e597fb66bf3afa47bb55b7a2afd8a2517c0739bd`. The shared Product Agent compiler now targets the selected kernel explicitly: Managed Codex retains its precise unsupported diagnostics, while Integrated DSH preserves per-role `tools`, `disallowedTools`, and `maxTurns` in the declarative snapshot. DSH executes root, foreground-child, and background-child tools through the common Product permission/Hook/Task/Plan plane; Explore follows the Claude Code-style read-oriented prompt with Bash available, general inherits the eligible parent catalog, and custom roles may only narrow the parent surface. Canonical Web DNS/transport behavior is compatible with bundled Node `24.14.0`, and historical DSH reasoning is projected at its durable content boundary instead of being accumulated into a synthetic trailing Think block. The source-bound pre-artifact report is `a7ef44373af894fd099d1621c6b60cfc256d6f2afd6082461560ce1daddab53b`; all three platform claims remain `implementation-complete_pending-native-validation` for these exact bytes.

The 2026-09-01 dogfood follow-up keeps that ownership model and corrects four local integration behaviors. DSH Bash now receives the terminal-resolved PATH and ordinary home/user/shell values through the exact execution-environment allowlist; Grep accepts files and directories and uses stable identity rather than mutable directory timestamps; TaskStop-induced Bash termination maps to `aborted`; and canonical Web uses MyAgents proxy selection, pins direct DNS transport, lets an explicit Product proxy own remote DNS, and preserves actionable Host error messages. Exact Node/npm `24.14.0` / `11.15.0` repository gates pass in both repositories. Clean DSH source `699236c7c051319ce2b2f1422b9bba9ef25455e1` produces pre-artifact report `ba4d0319535077fe13e90e94a5eba00801a75e61a742155e1d2fd70127604f51`, Runtime `ff413f4710688ca452fa15ef8d160b9615d6deb765976068951e5f35baddba88`, compatibility `a726f113ed862c103995343f8b69ec32be9333db461513455d5a9232af2df9d3`, and immutable handoff `8d7ed25e825f373fe37e653d1238d53bde37ef722e9fa43a14650351f979e36b`. The public verifier, official MyAgents ingestion, staged-resource verifier and exact native process restart/resume smoke all pass. Packaged acceptance remains before this row is complete.

The system-context refresh consumes clean MyAgents-dsh source `1e1ba52c387f9cb2e9d79c5a053031e536090912`, nine-patch DSH artifact `61b44cecaad8409fec0494527eae5d56480ef7a450af681c69f71a2a3c4616af`, Runtime `3265c9827f4bb326df72bc64a48ce1796a200a094b54c93cbbdc61997d9da02a`, compatibility `8f490dfb25bc06a950d71b0441d0377d63659d1c0fb6e56528ff91b13d70e5ef`, and handoff `a759b370ef859ffc91aa1791cb3c2788e65c51d987aab2ca2e75a8ef4a2b3fef`. The source-bound pre-artifact report `d73d4bdb1ff23b6d54e8405177849b57164c0d19f85a46dc9c66f0e5f768c1cd`, installed composition, public handoff verifier, official ingestion and staged-resource verifier pass. MyAgents implementation commit `755c38c2d194a87f46e7f7a4ef27d1a0679caef9` passes exact Node/npm `24.14.0` / `11.15.0` typecheck, lint, the complete JavaScript/TypeScript test suite, all Web/Server/Bridge/CLI production builds, Rust formatting and the Rust library suite (`1,183` passed, one external-archive test ignored).

From that clean implementation commit, `tauri build --bundles app` compiles the release executable and assembles `MyAgents.app` plus the updater archive, then stops only at the expected absent `TAURI_SIGNING_PRIVATE_KEY` boundary. The unsigned executable is 85,313,792 bytes with SHA-256 `de7161eed68f77e6a0b388102093517aa530bd5ce306b588326ee3ef7909e59c`; the updater archive is 301,913,052 bytes with SHA-256 `523ce6153b4a0a1862461c7a7f6df1bd0e330dbe9132e4548140263b79d7151d`. The final App and an independently extracted updater copy both pass the public handoff verifier, contain zero DSH resource symlinks, and pass native Runtime start/configuration/process-restart/resume smoke. A 12-generation packaged lifecycle soak releases all unique Runtime PIDs, keeps descriptors at `14 -> 14`, and records 36,765,696 bytes of Host RSS growth within the existing bound. This completes local unsigned macOS package acceptance for `B3-XR-SCTX`; it is not a signed release claim.

The credentialed macOS Runtime report `1eec0c786eae9163e63c8ad2ab72effb684b5f6a517c8f26cc00e79d7b9d3983` remains sealed as `unavailable` because `DEEPSEEK_API_KEY` is absent; all three platform claims therefore remain `implementation-complete_pending-native-validation`. MyAgents now owns stable product/session contribution names and the bounded Claude companion supplement, while DSH owns primary `CLAUDE.md` / `AGENTS.override.md` / `AGENTS.md` discovery, literal registration, Skill context and child inheritance. Credentialed Agent-quality/cache measurement remains the only system-context-specific evidence gate before deciding whether the optional structured cache-boundary seam is justified.

That unavailable report is superseded for system-context quality by the user-authorized credentialed campaign against exact source `b4eb9da93be3aec667719e0736bbd7db525b0100` and Runtime `43a5a1c383a3ff2e9be1cef5ea2ac88c0d9f79c8b3dda410f24a06aeca08840c`. Its native report `df40e6718c1e361dfd7736f264f0bc76ffa77fa5386488a4a57cfac3cf2c2727` and independently verified dynamic manifest `beead7f3ce7d70f47fd238065da3c8667de6c63972caaac628ab1b97f150ea23` pass all eight scenarios. The preceding failed diagnostic campaign showed the model guessing inaccessible paths and every Bash/Glob/Grep call failing environment authority; Runtime now projects the exact initialized Workspace root at dynamic order `90`, while the test Host declares the exact `PATH`/`TMPDIR` it passes. No root or permission was widened. Across the passing campaign all 75 model calls report automatic cache reads, including 4,096–5,760 tokens on every scenario's first call, and no Provider cache-write field. This is sufficient evidence for the existing stable-section/dynamic-context order; the optional Provider-specific structured cache-boundary seam is not justified. The accepted Host handoff retains all platform claims as `implementation-complete_pending-native-validation` until MyAgents' own package and release gates authorize promotion.

MyAgents commit `6a30eaac2eddef746457d909383023cf682afc72` binds that exact handoff and passes typecheck, lint, the complete JavaScript/TypeScript suite, all Web/Server/Bridge/CLI production builds, Rust formatting and the Rust library suite (`1,183` passed, one external-archive test ignored). The release-profile Tauri build produced `MyAgents.app` and its updater archive, then stopped only at the expected absent signing private key. The unsigned executable is 85,313,792 bytes with SHA-256 `6833aabf40b9c459f82677c092f0defec42d391fcec975405488db5673d89432`; the updater archive is 301,913,006 bytes with SHA-256 `827624d9a37b9eb3e551a434a0e9f1a2f0c78a4e01bc69022e9eb0cdab60c7b8`. The final App and an independently extracted updater copy both verify handoff `e6932d5c1beb050a06210fcc21965b937fab8243c645c5394b9901f6fc018cdd`, Runtime `43a5a1c383a3ff2e9be1cef5ea2ac88c0d9f79c8b3dda410f24a06aeca08840c`, exact Node/npm `24.14.0` / `11.15.0`, zero DSH symlinks and native start/configuration/process-restart/resume. A 12-generation App-resource soak releases all unique Runtime PIDs, keeps descriptors at `14 -> 14`, and records 36,388,864 bytes of Host RSS growth within the existing bound. This completes refreshed local unsigned package acceptance without making a signed or cross-platform release claim.

The subsequent workspace-Skills/stdio-MCP implementation is bound to Runtime source `1a776194c33fcafeff5de46bca36e354b80b20d5` and immutable handoff `999a80f5d9cc33f858cf3c11a8031a431ad8303221ddf0a3ec74452cb265dba7`. Host implementation commit `80df5aa4517a03da5e0b87bb79ae80c6575a4e71` passes ingestion, resource verification, typecheck, lint, the complete JavaScript/TypeScript suite, Web/Server/Bridge/CLI production builds, Rust formatting and the Rust library suite on exact Node/npm `24.14.0` / `11.15.0`.

From that commit, `tauri build --bundles app` compiles and assembles the release `MyAgents.app` plus updater archive, then stops only at the expected absent `TAURI_SIGNING_PRIVATE_KEY` boundary. The unsigned executable is 85,313,792 bytes with SHA-256 `3b7772f69e82affd6dbe8aa4f8223039aa1150852c928e5519f541e688d86840`; the updater archive is 301,905,227 bytes with SHA-256 `ae9d7333f8aa71a120648adfc1f07317bd2ca82e04b2ae6d7ea52b1d473a0835`. The final App and an independently extracted updater copy both pass the public handoff verifier, contain zero DSH resource symlinks, and pass native Runtime start/configuration/process-restart/resume smoke. A 12-generation packaged lifecycle soak releases all 12 unique Runtime PIDs, keeps descriptors at `14 -> 14`, and records 36,782,080 bytes of Host RSS growth within the existing bound. This completes the focused workstream's applicable local unsigned macOS packaged/native acceptance. It does not create a signed release or promote any handoff platform claim beyond `implementation-complete_pending-native-validation`.

The unified-toolchain refresh is committed at `0c779d113f2244446d46ffde37998a61098b1680`. Exact Node `24.14.0` / npm `11.15.0` typecheck, lint, complete JavaScript/TypeScript tests, Web/Server/Bridge/CLI builds, Rust formatting and the Rust library suite pass; integration reports 476 passed with two opt-in native tests skipped by default, while Rust reports 1,181 passed and one external-archive test ignored. `tauri build --bundles app` compiles the release executable and assembles `MyAgents.app` plus the updater archive, then stops at the expected missing `TAURI_SIGNING_PRIVATE_KEY` boundary. The unsigned app executable is 85,311,344 bytes with SHA-256 `2fc054c6df68f0d4650429fc951bd604a834c94ce8998cb182e9415e27dc58c2`; the unsigned updater archive is 166,587,375 bytes with SHA-256 `bda6afcefd2b3a3c92f4c41ce5ca400c428b26b9dd156786c175dc7266a5e640`. The packaged public verifier accepts the exact handoff/Runtime/compatibility identities, packaged Node/npm report `24.14.0` / `11.15.0`, and the DSH resource inventory contains zero symbolic links. Packaged native smoke passes in 4.320 seconds; the 12-generation soak passes in 5.031 seconds with all unique Runtime PIDs released, descriptors stable at 14, and Host RSS growth of 770,048 bytes. This is local unsigned macOS evidence and does not promote any handoff platform claim.

The release-profile Tauri build produced `MyAgents.app`, `MyAgents_0.4.11_aarch64.dmg`, and the updater `.app.tar.gz`. It completed the Web/Server/Bridge/CLI and Rust release build but intentionally did not cross the signing gate because no `TAURI_SIGNING_PRIVATE_KEY` was available. The updater archive SHA-256 is `d421daf3a84cc84d809a8a3fd3250b8677ebdd0313fa5bc829565d9edb9c227c`; the unsigned DMG SHA-256 is `88247838e9458e1d7696b7e4d37fa066de42df2ca1a174cf227532ed81aca88e`. Both the final App resources and an independently extracted updater copy verify the outer handoff digest, contain exact Node `24.14.0`, and contain zero DSH symbolic links. The explicit native `RuntimeProcessHost` smoke starts, configures, and shuts down the Runtime from each of those two packaged resource roots; it no longer proves only the source staging directory.

`npm run typecheck`, `npm run lint` and the complete `npm test` succeed at `57d25ab51481e483a2a709eb403c075937a1b92b`; its integration project reports 476 passed and two opt-in native tests skipped by default. All Web/Server/Bridge/CLI builds exercised by the Tauri build, direct Rust formatting, and the Rust library suite (1,181 passed, one ignored) succeeded at `b9bc80374442fd5904153f1c75da7156460f87b6`; the only later production-tree change is the documentation-only `698a0fe5dbe2c12b2f5cdadcb1b6e6e05728cf3b`, while `57d25ab51481e483a2a709eb403c075937a1b92b` adds only the opt-in native soak below. The stateful fake-Runtime integration directly proves DSH thinking, text, tool, usage, terminal, live SSE and Product persistence projection. This remains exact local development/package evidence: an unsigned package is not a release artifact, and none of it promotes a handoff platform claim beyond `implementation-complete_pending-native-validation` or substitutes for Provider/native-platform acceptance.

J16 now has current-source local macOS evidence. From clean `b9bc80374442fd5904153f1c75da7156460f87b6`, the build policy was temporarily set to allowed Integrated `[dsh]`, no External Runtime, default `dsh`, selector `hidden`; the release build embedded that exact policy into both Server JavaScript and the Rust executable, then produced `MyAgents.app` and the updater archive. The build stopped only at the expected updater-signing gate because `TAURI_SIGNING_PRIVATE_KEY` was absent. The packaged resource verifier accepted the exact handoff/Runtime/compatibility digests and Node/npm versions above, the app contained zero symlinks, and the packaged `RuntimeProcessHost` native smoke passed 1/1 in 4.249 seconds. Exact local output facts are Server bundle `2d6fa72134badbc674d2b4aca1cf6681fac2757deae2adbc22cdcb076a117e36` (12,312,263 bytes), app executable `66b3e5124dcd6cebee14fc9cd2371ccd9eb685ed25bea3d9dfec362414cd5454` (85,311,344 bytes), and updater archive `ed1be2aa0e7791440d19e2f9c2bc9772d064c86e48e3d6de6d326490178b643e` (166,594,155 bytes). The source policy was restored after the campaign; these hashes describe the immutable local build outputs, not the standard-profile checkout or a signed release.

The explicit `MYAGENTS_DSH_NATIVE_SOAK=1` H6 gate at `57d25ab51481e483a2a709eb403c075937a1b92b` reuses the same public `RuntimeProcessHost` and exact packaged resource root; it does not add a test Runtime or protocol path. A 12-generation macOS run passed in 7.34 seconds: all 12 unique Runtime PIDs exited after bounded shutdown, Host open descriptors remained 14 before and after, and Host RSS grew by 737,280 bytes. The gate accepts 1–50 requested iterations, rejects malformed bounds, and fails on a retained child PID, more than eight retained descriptors, or more than 192 MiB Host RSS growth. This closes the locally executable process/descriptor/memory soak layer, not the live Provider or cross-platform product journeys.

The post-H5 direct-call audit also fences DSH stop and interaction responses from historical Builtin fallback, resolves IM snapshot authority through the discriminated Runtime binding, keeps Heartbeat and memory paths on the Integrated Runtime identity, and reads IM history through SessionEngine. The boundary test now rejects reintroduction of direct Builtin Session identity, transcript, or scenario calls in the monolithic route owner.

### 21.3 H6 acceptance audit

The table separates the credential-free deterministic layer from the still-required exact-package campaign. A deterministic pass does not mark the corresponding J journey complete until its right-hand gate is accepted.

| Journey | Credential-free evidence now present | Remaining exact-package gate |
| ------- | ------------------------------------ | ---------------------------- |
| J1 | Distribution policy, allowlisted Developer default, central resolver, frozen binding and selector-off UI policy tests | Packaged selector-off/frozen-Session walkthrough |
| J2 | DSH preference persistence, readiness admission and selector tests | Packaged selector choice plus next-Session birth |
| J3 | Runtime incompatibility, frozen binding and new-Session ownership logic | DSH-to-Claude confirmation/new-Tab UI walkthrough |
| J4 | Managed-Codex Provider constraint and preserved Integrated preference tests | Packaged managed-provider switch |
| J5 | Central resolver returns from managed Provider to saved Integrated preference | Packaged return journey |
| J6 | Explicit External preference precedence and established External adapter suite | Packaged External CLI transition |
| J7 | `anthropic-sub` required-runtime resolver and builtin Session-birth projection | Active DSH confirmation/new-Tab walkthrough |
| J8 | DSH durable event projection plus stateful Product SSE/transcript test for thinking, text, tools, usage and terminal truth | Approved live Provider turn in the packaged App |
| J9 | Permission/Plan mapping, interaction fencing, exact rule list/add/revoke, stale-revision and native packaged control-plane smoke | Live permission, AskUser and Plan settlement through the packaged UI |
| J10 | Queue/follow-up/steer races and DSH recovered-operation serialization | Live active-turn queue/steer campaign |
| J11 | Exact operation stop/cancel tests and DSH-to-Builtin fallback fence | Live packaged stop reconciliation |
| J12 | Process loss, durable active-turn takeover and terminal reconciliation tests | Injected packaged sidecar crash during a live turn |
| J13 | Binding migration, resume, replay and recovered-root tests | Packaged App restart with a real DSH Session |
| J14 | Readiness, digest, inventory, platform and missing-artifact fail-closed tests | Packaged removal/tamper walkthrough with readable transcript |
| J15 | Fork/rewind/delete transaction journals and injected crash recovery tests | Exact-Runtime mutation campaign through product UI |
| J16 | Valid DSH-only hidden-selector policy, fail-closed Provider projection tests, current-source unsigned macOS build/resource verification and native smoke | Signed macOS acceptance plus native Windows/Linux builds and smoke |
| J17 | Rust/Node identity, IM snapshot, rotation and all-entrypoint resolver tests | Packaged Desktop plus real Bot/Channel rotation campaign |
| J18 | Sealed child environment, credential canaries, stderr redaction and bounded diagnostics tests | Packaged support-bundle review with live credential canaries |

The current machine has a user-authorized local Zhipu Coding Plan credential and has passed the focused exact-Runtime `approved-route` campaign recorded above. That credential is development-only evidence, not an approved release credential or a signed-package acceptance result. The machine still has no usable Tauri signing private key and no native Windows x64 or Linux x64 host/evidence. Fresh-context Tester-Agent review, signed-package acceptance, the native Windows/Linux campaigns, the remaining live Product/Provider journeys, and explicit rollout acceptance remain open H6 gates.

## 22. PRD traceability

| PRD requirement                     | This RFC                         |
| ----------------------------------- | -------------------------------- |
| P0-01 taxonomy                      | Sections 3, 5                    |
| P0-02 policy/default                | Section 4                        |
| P0-03 preference/binding            | Sections 3, 16                   |
| P0-04 central resolution            | Sections 4.3, 5.3                |
| P0-05 DSH adapter                   | Sections 5–6                     |
| P0-06 Host ports                    | Section 9                        |
| P0-07 product UI                    | Sections 10, 14                  |
| P0-08 compatibility/readiness       | Sections 7–8, 17                 |
| P0-09 lifecycle/recovery            | Sections 6, 11                   |
| P0-10 mutations/history             | Sections 13, 16                  |
| P0-11 security/provenance           | Sections 7, 8.3, 17–18           |
| P0-12 observability                 | Section 18                       |
| P0-13 permission/Plan control plane | Sections 9.1, 12, 14.3 and 20    |
| P1-01 future Pi                     | Sections 3.1, 5.1; no Batch 3 UI |

## 23. Definition of done

The MyAgents side is complete only when:

- DSH is resolved as an Integrated Runtime through one central policy;
- old Session and Agent data migrate without semantic reclassification;
- all product entry points execute through the DSH SessionEngine adapter;
- standard conversation UI exposes only real, working capabilities;
- Provider subscriptions follow the confirmed required-runtime/new-Session behavior;
- exact DSH artifact/protocol/compatibility facts are verified before admission;
- the application uses the Runtime's accepted exact Node version and contains no second bundled Node or unverified version bypass;
- MyAgents' bundled npm resource is independently pinned and verified; it is never inferred from DSH build provenance or a floating registry tag;
- lifecycle, queue/stop, interactions, configuration, projection and mutations pass fault-injected tests;
- `auto/plan/fullAgency` are mapped to real Runtime behavior; Plan and exact rules use generated formal `2.0.0` methods; the UI makes no OS-sandbox claim;
- automatic and explicit compaction remain DSH-owned, while MyAgents exposes real status/control projection without a second memory or summary engine;
- J1–J18 pass against pinned MyAgents and DSH commits;
- release/platform claims match native evidence;
- DSH remains controlled rollout and Claude Agent SDK remains the general default for this development release.

## 24. References

- MyAgents-dsh `specs/prd/prd_0.3_myagents_integration.md`
- MyAgents-dsh `specs/prd/tech_rfc_0.3_myagents_dsh_integration.md`
- MyAgents-dsh `specs/tech_docs/permissions-and-interactions.md`
- MyAgents-dsh `specs/tech_docs/compaction-architecture.md`
- MyAgents-dsh `specs/tech_docs/runtime-protocol.md`
- MyAgents-dsh `specs/tech_docs/artifact-verification-and-handoff.md`
- [MyAgents architecture](../ARCHITECTURE.md)
- [MyAgents Multi-Agent Runtime](./multi_agent_runtime.md)
