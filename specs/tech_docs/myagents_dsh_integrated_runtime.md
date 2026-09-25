---
type: module-technical-document
status: implemented-native-validation-partial
version: 0.34
updated: 2026-09-12
implementation_repository: "MyAgents"
product_prd: MyAgents-dsh/specs/prd/prd_0.3_myagents_integration.md
runtime_rfc: MyAgents-dsh/specs/prd/tech_rfc_0.3_myagents_dsh_integration.md
main_baseline:
  version: 0.4.15
  commit: 7544161c
runtime_authority: src/shared/integrated-runtimes/dsh-lock.json
---

# MyAgents-dsh Integrated Runtime — implementation and delivery ledger

> Current owners and data flow follow `specs/ARCHITECTURE.md` and the implementation. The accepted Runtime identity, toolchain and platform claims are read from `src/shared/integrated-runtimes/dsh-lock.json`, generated contracts and the verified immutable handoff. Product scope remains owned by the paired PRD. Earlier design audits and delivery receipts below are historical evidence; their version numbers and worktree observations do not describe the current checkout.

> **Proposal, not current architecture.** This RFC is ready for implementation; current Runtime ownership and supported adapters are documented in [Multi-Agent Runtime](multi_agent_runtime.md).

## 1. Decision summary

MyAgents implements DSH as a first-party **Integrated Runtime**. Provider configuration remains Host-owned and session operations use the existing SessionEngine facade.

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

## 2. Historical design audit (MyAgents 0.4.12)

This RFC was originally audited against MyAgents `0.4.12` at commit `c39d7387a6122f9ebed5f4ec94583aebd1da93f6` and was revalidated against committed HEAD `61a81af384a2333dd8f4fc5f14436ab6e360c820` after the formal DSH `2.0.0` handoff was produced. Since the previous audit at `d6ba358f…`, committed changes touching `Launcher.tsx` and `specs/ARCHITECTURE.md` are limited to the Record/AI-discussion flow; they do not alter `src/server/session-engine/`, Runtime identity types, Provider execution policy, or the Rust Runtime identity owner. The architectural findings therefore remain valid.

At the original audit, the MyAgents worktree contained unrelated uncommitted Record/AI-discussion and UI work. It was inspected for boundary overlap and preserved separately during the initial integration. This is a historical worktree observation.

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
2. `apiFamilies` is the Runtime transport-compatibility boundary. MyAgents owns Provider/model availability in its Product registry and compiles each selected ordinary API route into one supported family. The native `deepseek-official` route is selected only for the official Product endpoint; individual evidence never becomes an admission table.

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

H3 implements the protocol-ready portion of this admission in `src/server/integrated-runtimes/dsh/`. `installation.ts` resolves only canonical paths below the Tauri resource root, invokes the outer handoff's public `verify.mjs` with the committed digest. Its combined report validates the executing Node/platform and reuses the nested Runtime verification to rebind the complete outer/nested inventories, compatibility, source, patched DSH, protocol method/notification sets, profile and native target to `dsh-lock.json`; accepted reports are deduplicated only within the current Sidecar process. `generated-client.ts` then resolves `@myagents-dsh/protocol` and `@myagents-dsh/protocol/generated/host-client` through the verified artifact's public package exports. It does not import a package-private `src/*` path or repair the copied generated TypeScript file. Generated protocol/schema/capability constants and the complete 40/7/4 surface must match the committed contracts before construction.

`process-host.ts` owns the `idle -> starting -> protocol-ready -> stopping -> stopped` lifecycle, with `failed` as a terminal admission result. Its exact order is combined outer handoff/Runtime verification, public protocol load, process spawn, `initialize`, identity/capability validation, negotiated-limit application, atomic registration of all seven reverse methods and two Runtime notification handlers, `initialized`, and quiescent `runtime/status`. Startup cancellation cannot race through to a late spawn. Shutdown first requests `runtime/shutdown`, flushes the peer, waits for exit and only then uses bounded termination. The Runtime entrypoint supplies and reports `artifact-process-generation`; MyAgents fences every reverse call and Runtime event against that returned value plus the Product Session identity, while the enclosing Sidecar generation remains an additional H5 lifecycle fence.

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

Protocol 5 ingestion preflights the complete generated contract inventory before replacing any file. Acceptance removes only the obsolete protocol 4 evidence projection; a missing source contract preserves the prior projection. The pinned contract inventory is part of the Host compatibility policy and is changed with the protocol upgrade.

An ingestion script accepts one explicit external `--handoff <absolute-directory>` input, first executes that directory's public `verify.mjs` entrypoint with the expected handoff digest, validates the compatibility/platform facts, copies the complete Runtime directory byte-for-byte into build resources, and copies the generated client/contracts through a generated-diff gate. MyAgents code may wrap the generated client but may not hand-edit it or import verifier/package-private `src/*` paths. The accepted Runtime inventory is link-free. In the ingestion owner's temporary copy, directories and executable files use `0755`, other files use `0644`; links and special files are rejected. This makes resources readable by installed-app users and writable by the builder for macOS `xattr` cleanup before signing. The source handoff stays untouched, and the full public verifier runs again before atomic admission, including the Runtime's executable-mode checks. Ordinary Tauri/installer copying then preserves the verified identity without a post-bundle repair hook. `build.rs` clears only Cargo's generated resource staging directory before re-emitting the authoritative source inventory, preventing incremental builds from retaining files from an older immutable handoff; it never edits the source handoff or accepted package output. Installed application startup verifies the committed lock again before marking DSH ready.

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

The compiler consumes the exact DSH compatibility manifest and binds the included Batch 1 candidate profile identity. The delivered `batch-1-candidate-profile-v1.json` is a composition/profile manifest, not a model-route payload. MyAgents compiles current Product endpoint, protocol, model and capacity facts directly; it does not infer protocol compatibility from a URL, pi-ai catalog entry or Provider name.

The selected MyAgents-dsh design reuses the official DSH `dsh-llm-pi-ai` adapter for ordinary Anthropic Messages, OpenAI Chat Completions and OpenAI Responses routes, while retaining the native DSH DeepSeek adapter for `deepseek-official`. This does not weaken Host authority: MyAgents compiles the frozen profile and owns credentials; the Runtime's thin control layer translates that profile into the official adapter's public settings seam and activates the Host credential port for each model request. Every enabled ordinary API Provider is portable when its declared family is installed.

For an ordinary API Provider, the Product Provider record is the protocol source of truth. Anthropic configuration compiles to `anthropic-messages`; OpenAI plus `chat_completions` compiles to `openai-completions`; OpenAI plus `responses` compiles to `openai-responses`. The DSH path sends that declared family directly through pi-ai and never routes it through `openai-bridge`. The legacy OpenAI-to-Anthropic Bridge remains an implementation detail of the Claude Agent SDK execution path only.

The compatibility manifest carries family limitations: pi-ai routes do not support Host stop-sequence projection; reasoning content is available but provider reasoning-token counts are not; the bundled pi-ai catalog is advisory; AWS, Vertex, Azure and subscription/OAuth routes are not advertised. The same-release public `dsh-authorization` package is present only because `dsh-llm-pi-ai` requires it as a public peer. MyAgents does not mount its login/OAuth service or expose it as a capability.

H2 implements this boundary in `provider-constraints.ts` and `profile-compiler.ts`. Every current model of an eligible ordinary API Provider uses the same compiler, including presets, custom endpoints and discovered/manual model IDs. Unknown optional capacity metadata uses the Product default; supported text/image modalities are projected independently; native DeepSeek accepts both V4 Pro and V4 Flash. A profile revision hashes the Runtime profile digest and complete secret-free profile. Credentials use stable POSIX-identifier references such as `MYAGENTS_PROVIDER_ANTHROPIC_API_API_KEY`; secret material is never an input to the compiler. H3–H6 process, packaged, cross-runtime and native-platform gates still control readiness and release claims.

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

For admitted model routes, including native DeepSeek, MyAgents supplies an optional Host-backed executor for canonical `WebSearch`/`WebFetch`. DSH performs catalog registration, schema validation, visibility, permission, Hook, origin and terminal handling; MyAgents executes the governed web capability through `host/tool/execute`. Missing Web support affects that tool only and never blocks base model admission.

Reverse calls are bounded, cancellable and generation-fenced. Host disconnect or timeout returns one protocol-defined failure and cannot leave a turn appearing idle.

H3 provides the runtime-neutral handler contract and exact registration/fencing layer. Each request must carry the active Product Session and Runtime generation plus a protocol-bounded deadline; stale authority is rejected before a product callback, peer cancellation is propagated as an `AbortSignal`, and a deadline settles as one retryable protocol failure. H4/H4P connect these callbacks to the existing credential, interaction, tool, Hook and attachment domain owners; an unwired callback can never make a Runtime selectable.

H4 now connects credential resolution, permission/question/Plan interaction settlement, the runtime-neutral Product Host-tool dispatcher, canonical Host Web and content-addressed attachment leases to those fenced reverse ports. Provider and remote-MCP credential material is resolved only inside `host/credential/resolve`; it is neither copied into declarative profiles/snapshots nor persisted in Product metadata. Admitted Product Host tools execute through `host/tool/execute`, and image/audio results become content-addressed DSH attachment references. The Host Hook boundary currently returns the explicit continue result.

`src/server/integrated-runtimes/dsh/canonical-web.ts` is the sole MyAgents executor for DSH canonical `WebFetch` and `WebSearch`. It accepts only the exact `myagents-host-canonical-web-v1` component generation, component identity, current Runtime Session and operation-frozen config revision; the outer reverse-port fence has already checked Product Session, Runtime generation and deadline. MyAgents advertises that adapter during initialize only because this executor is present. DSH still owns tool catalog/schema, visibility, permission, Hook, origin and terminal semantics.

Search response normalization accepts standard server-search blocks and generic `tool_result` correlated to an observed server/MCP call, independent of the server's tool name. A bounded JSON5 data parser handles common envelopes, single-quoted strings and concatenated containers without evaluating expressions. Duplicate source URLs merge; unknown portions retain bounded service text with `unverified_search_results` and, when applicable, `unverified_domain_filter`. Empty searches remain valid, while explicit service errors remain failures. The canonical result bounds include JSON escaping and duplicated citation URLs; trimming sets `truncated`. The Renderer displays retained text alongside sources, including legacy SDK service text, without extracting citations from prose. These output additions are bound to the Runtime's new protocol `2.6.0` source candidate; the installed handoff remains authoritative until replacement ingestion and client acceptance.

The Host executor uses a composition-owned HTTP client with per-hop destination policy, bounded concurrency/queue/deadline, cancellation and compressed/decompressed byte limits. Direct requests use public-address DNS validation and connection pinning, reject IPv4-in-IPv6 aliases, revalidate redirects and try remaining validated addresses after a connect failure. When the user explicitly selects a MyAgents general/Provider proxy, lexical host and literal-IP policy still runs while remote DNS belongs to that proxy; this matches ordinary CLI proxy behavior and works on machines where direct DNS is intentionally unavailable. Each dispatch copies immutable input headers into a request-owned mutable object before passing them to ProxyAgent, which may fill in `host`. One proxy dispatcher generation is reused per normalized proxy configuration, retired after active requests drain when configuration changes, and closed by the Session/Runtime lifecycle owner; there is no implicit direct fallback. `WebFetch` converts bounded HTML to Markdown, extracts bounded PDF/text content, and makes one isolated tool-free utility call against the operation-frozen Provider, including native DeepSeek. `WebSearch` is selected by API family: every admitted `anthropic-messages` route uses the same Claude Code-compatible nested Messages request with `web_search_20250305`, including bounded `pause_turn` continuation. Zhipu's standalone Search API is an explicit optional non-Anthropic backend; Provider branding never redirects an Anthropic route to another product. The exact native `deepseek-official` binding also delegates WebSearch through this Host owner, targeting the fixed official `/anthropic/v1/messages` endpoint and the same server-search schema; the root model remains native. Search never falls back to HTML scraping. Provider credentials remain in Host memory and enter only the outbound request header. Failures return a stable code plus one bounded actionable message and safe phase/system-error classification; upstream response bytes and secret-bearing diagnostics are not exposed. Zhipu `1113`/HTTP 429 is reported as missing search resource package or balance rather than a generic invalid Provider result.

The self-test corrections additionally distinguish successful empty search results from missing structured results and HTTP 200 server-tool errors. Native DeepSeek Host direct/proxy dispatch and real ProxyAgent frozen-header GET/POST reuse pass in source and a production-format ESM bundle; this does not replace actual Sidecar/provider acceptance.

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

Once an AskUserQuestion, permission or Plan interaction is registered, desktop human think time has no Host wall-clock timeout. The exact pending interaction suspends the external inactivity watchdog by re-baselining it until settlement; registration/response transport and post-approval execution remain separately bounded. The Renderer keeps the card and its draft until the response route returns an authoritative success, preserves both on rejection for retry, and renders one static waiting status instead of advancing the reasoning timer. Root loading/Stop ownership remains with the root Session stream rather than any card or child lifecycle.

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

The protocol `2.5.0` source consumer additionally treats the ready baseline and later live suffix as one ordered stream. Dedicated `context_update`, whole TaskGraph snapshots, and monotonic ProductWork lifecycle feed the existing context/Todo/Agent-status domains; Plan state remains separate from TaskGraph. Tool completion joins ordered text blocks and resolves supported DSH image references through an exact attachment lease into the existing Host attachment store. A distinct `provider_tool` event becomes a persisted `server_tool_use` block with Provider route/block metadata and Provider-owned labeling; it never becomes canonical `tool_use`, requests local approval, or drives root Composer/Floating Session loading. A missing result is finalized only at the owning root terminal without inventing success or result content, so live projection and historical reopen share the same persisted block representation. These source changes do not change the accepted handoff facts in the frontmatter: MyAgents remains locked to `2.3.0` until the official immutable `2.5.0` handoff is generated, verified, and ingested.

H4 also reconciles the ordinary terminal/persistence crash window before a resumed Runtime becomes usable. `session/read` first verifies the complete native cursor chain and event digests; independent `turn/get` results must then match every durable admission and terminal outcome exactly. Optional `usage` is excluded from outcome equality. A succeeded terminal's `assistantEventId` must resolve to the claimed final native `assistant/message`, from which text, reasoning and settled tool calls/results are deterministically projected. Terminal usage is projected only when available; its absence cannot reject a successful reply. `SessionStore` inserts a missing assistant beside its exact Product user row under the transcript/index locks and commits a versioned `dshProjectionCursor`; exact replay is a no-op, while conflicting anchors, an unowned assistant, malformed conversation ownership or divergent terminal outcome fail closed. Non-success terminals never manufacture assistant rows.

Host display telemetry uses non-throwing projection in `dsh/telemetry.ts`. Missing or unusable root/child token counts, cost, context pressure and tool timing metadata omit the affected display fields while preserving content and completion. Unknown usage is not replaced with zero; an incomplete or overflowing sum is not published as a complete Session total. WebSearch/WebFetch Provider usage and server-search counters follow the same rule: a valid answer or search result survives missing metering. Response content, tool/result correlation, network policy, permissions, operation limits and terminal outcome keep their existing owners; this change does not add retries or bypass core admission checks.

An admitted operation that remains non-terminal after `session/resume` is now taken over without starting a competing root turn. Reconciliation permits exactly one such operation, cross-checks its admission through `turn/get`, and requires its exact Product user owner to exist without a conflicting assistant. The DSH process seeds the recovered `clientOperationId`/`clientUserMessageId`, buffers startup events and reverse interactions until that correlation is installed, then replays them in order. The Product Session restores the active root anchor and queues a concurrently submitted new message behind the recovered turn; terminal persistence completes before that queue drains. Failed or intentionally stopped turns with model-visible output persist one assistant projection marked `completionState:'partial'` plus the truthful terminal status before later queued work can enter admission; they are never published as successful completions.

The pre-native-admission crash window is closed by the Product-owned `pendingDshRootOperation` journal. Product first persists the exact Runtime Session, `clientOperationId`, Product user ID, ordered attachment-byte digests and an immutable input fingerprint, then appends the Product user, and only then sends `turn/start`. Startup reconciliation compares that journal with the complete native operation set: a journal with no Product user and no native admission is discarded, a matching native active turn is taken over, a matching terminal is reconciled before clearing, and a Product user with no native admission is replayed with the same operation ID and byte-verified images. Any identity, fingerprint, Product owner, image or native-operation mismatch fails closed; later Product work remains queued until the recovered operation reaches Product terminal persistence.

The SELF source correction moves shared Skill/Command/Agent declaration types and discovery to `runtimes/product-extensions/contracts.ts` and `compiler.ts`. Managed Codex retains its own Skill admission wrapper; DSH receives complete admitted-source metadata and hashes before applying its component policy. `allowed-tools` remains authored guidance and does not grant permissions. DSH honors model/user invocation flags and isolates unsupported execution-context metadata per Skill. A changed source degrades its component instead of aborting unrelated extension compilation. Nonconforming command names retain their spelling with a specific rename instruction. CLI Skill `on` is explicitly labeled as an installation setting; unified Session admission/generation presentation remains open in SELF.

### 10.3 Dual authorities without dual transcript

The self-test correction consumer supports protocol 2.6 source activation/handle fields. Backend and Renderer merge lifecycle by activation identity and ordinal: a completed epoch can be followed by a new running epoch on the same child, while late older events cannot regress it. Closing a handle preserves delivered output and the original Agent tool result. Completed/open cards display “已完成，可继续”; DSH lifecycle suppresses legacy SDK output-file polling and synthetic root-terminal child cancellation. `history-content.ts` reconstructs child state from verified ProductWork history, while ordinary turn recovery preserves Provider calls/results as `server_tool_use` and joins canonical text result blocks exactly as the live path does. Historical reads omit envelope timestamps, so rebuilt child durations remain unspecified until a live snapshot supplies timing. The new source behavior requires a new immutable Runtime/handoff; closed-context restoration and richer queued/waiting phases remain tracked in SELF.

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

H5 keeps this taxonomy intact in the shared `RuntimeSelector`: DSH appears in the Integrated group, while Claude Code, Codex and Gemini remain External CLI. The Rust detection owner resolves the installed application resource directory, reads the committed DSH lock and verifies the supported target, sealed outer handoff digest, nested Runtime manifest digest, compatibility digest, required entrypoints and platform claim before returning an installed result. The accepted Batch 3 artifact is intentionally labelled `experimental` / `unverified-dev-runtime`; missing, malformed, digest-mismatched or platform-invalid resources are unavailable and cannot admit a Chat or Launcher send. Session admission then runs the public outer verifier with its combined Runtime self-check report, which binds the complete nested inventory before spawn. The Renderer does not infer readiness from a directory or executable alone.

Developer Settings also exposes `config.defaultIntegratedRuntime`, with options derived only from the build policy's allowed Integrated Runtimes. The override is used for new ordinary-provider Session birth when the selector is unavailable; an absent, malformed or no-longer-allowed value falls back to the build default. Changing it never rewrites an existing frozen Session. A one-runtime distribution keeps the control disabled at its sole admitted value.

### 14.2 Change behavior

- Settings/Launcher: save Agent template; toast that a new Tab uses it.
- Live compatible model change: preserve existing policy.
- Live incompatible Provider/Runtime change: existing confirm dialog, preserve current Session, create a new Session and open its Tab.
- Cancel: no template/session mutation.
- Failed new birth: keep old Tab intact and show actionable error.

The Provider picker is the Product execution catalog. Under DSH it retains every enabled ordinary API Provider and all current models whose declared family is installed, while Managed Codex remains visible as the runtime-backed `codex-sub` choice. Selecting it always crosses the existing history boundary into a Managed Codex Session and never treats Codex as DSH-compatible. The Agent's authoritative Integrated Runtime preference remains unchanged, so leaving Managed Codex for an ordinary compatible Provider returns to the previously selected DSH or Claude Agent SDK Runtime. Claude-owned subscription Providers remain bound to their declared Integrated owner.

Agent, Channel, Settings and Launcher changes atomically persist the authoritative `AgentRuntimePreference` with their legacy `runtime`/`runtimeConfig` compatibility projection. The preference wins whenever both exist; malformed authoritative preference fails closed instead of falling back to a possibly stale legacy Runtime. Product configuration remains Product configuration for DSH: Provider/model, exact permission mode, reasoning effort, MCP, Plugins and related capabilities are not moved into the External CLI configuration object. Unsupported execution owners, missing Product model membership or unsupported API families are rejected before Session birth.

### 14.3 Conversation

DSH uses existing MessageList, composer, queue, stop, inline tool/permission/question/plan cards, attachment pipeline, history actions and status panel. Every visible control must call a real SessionEngine capability. Permission/AskUser cards settle through the reverse request exactly once and clear only after successful acknowledgement; submission failure retains the exact local draft for retry. A registered interaction replaces the cycling reasoning footer with a static waiting status while the owning root operation stays active. Switching the product to Plan uses `plan/apply`, not a decorative local state; any exact always-allow rule shown by product UI is read from Runtime and is revocable through the generated rule API.

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

Task/Cron birth resolves the same authoritative preference and freezes the resulting binding; an already materialized DSH Task remains executable when Labs is later hidden, while a new inherited Task follows the current gate. The Task editor and admin API enforce Product Provider/model membership, supported API family and canonical `integrated` source. Goal and injected work stay bound to their existing `SessionEngine`; Inbox reads the target Sidecar's live Runtime identity at materialization, so its new Product Session freezes DSH/integrated rather than reconstructing identity from Renderer state.

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
- native DeepSeek V4 Pro/Flash plus representative preset and custom routes for all three API families, with subscription/OAuth owners rejected;
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
4. Land the API-family Provider profile compiler plus the formal generated protocol client.
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
| B3-XR-IWC | Exact collaborator identifiers and durable human-interaction waiting | `in_progress`; Runtime source gates, Host interaction-focused gates and refreshed handoff ingestion complete; concurrent Provider work/full Host gates and packaged manual acceptance pending |
| B3-XR-DOG | Bash env, Grep concurrency/file path, TaskStop terminal and canonical Web dogfood closure | `in_progress`; handoff ingested, package acceptance pending |
| B3-XR-SCTX | Generic DSH system context, project-instruction precedence and literal Host/child bodies | `in_progress`; implementation, credentialed quality/cache and refreshed local unsigned macOS package acceptance complete; signed/cross-platform acceptance pending |
| B3-XR-SKILL-MCP | Ordered workspace Skill packages and local stdio MCP through DSH-native owners | `complete`; exact `2.3.0` handoff, Host gates and refreshed local unsigned macOS package/native acceptance pass |
| B3-XR-PORT | API-family Provider admission without Provider/model cells | `complete`; source, deterministic gates and exact `2.5.0` handoff ingestion pass; packaged representative routes remain in H6 |
| B3-XR-BIRTH | Fresh DSH native Session birth at first Product turn | `implementation_complete`; focused Host gates pass, full Host/package acceptance remains in H6 |
| B3-XR-PERM-DISPLAY | Full Bash command, working directory and existing Always Allow scope | `complete`; source/Host gates, packed permission projection, exact handoff ingestion and native restart/resume smoke pass; packaged manual acceptance remains in H6 |

### 21.2 Current implementation evidence

DSH Bash approval receives optional ephemeral `schema.display` from the Runtime with the actual command, sealed working directory and optional description. The DSH adapter projects it as `PermissionOperationDisplay` alongside the unchanged authorization summary; live and replayed `permission:request` carry it without the legacy 500-character truncation. The shared card uses these details only when supplied and explains that Always Allow covers other Bash commands in this workspace for the current Session while its rule is valid. Claude SDK, Claude Code, Codex and Gemini continue using their existing summary rendering. Permission decisions and durable matching are unchanged; display content is not added to diagnostic logs.

The permission-display closure consumes clean DSH source `23bb0dc2824a74ba92c54bdc16fc0b7ad8aaa9cf`, Runtime `5f2e9e66689d876a13e9e90db7a82007e89b3f3754f2dcfdd63e19616121ded1`, compatibility `eb9ffb1f6123762401a4c855e6c3ac51ea468ef32977d0c0e2e1de5509f101f2`, and immutable official handoff `a46db0a8888e150981ccd031138e416757126beb6d6db978cba3af3526189515`. Protocol `2.5.0` and its generated client remain unchanged. DSH typecheck/lint/build and all 649 tests pass; the packed composition checks actual Bash permission details before publication. Host typecheck/lint, complete deterministic unit/DOM/integration suites, classification/build-script gates, four production builds, staged-resource/freshness verification, and the two-scenario native start/restart-resume smoke pass. Regression coverage includes long commands, unchanged legacy card rendering, exact decision identity, live/replayed display, and display-free durable permission rules. Three-platform claims remain `implementation-complete_pending-native-validation`; this does not claim packaged manual or full cross-platform native acceptance.

The B3-XR-IWC Host source keeps permission and AskUserQuestion pending state until the response route acknowledges success, makes Ask submission retryable without clearing selected/custom answers, and projects a static interaction-waiting footer. Existing exact external-interaction ownership continues to suspend/re-baseline the inactivity watchdog; no second timer or interaction store was added. An authoritative DSH `expired` response now settles the adapter's local pending interaction and emits the existing resolved event so a stale permission, Ask or Plan card is removed; rejected or transport-failed responses remain pending and retryable. DSH source `c7a246c80919cceda110d8ae3bc9f983a220b728` passed the complete 69-file / 647-test repository gates and source-bound pre-artifact gate `fc9bc6b2469113264f80f3bf14d42ad5acfb5335889865e50d92b0e003391467`. The official ingestion and staged-resource verifier accept handoff `f3c51af1dce29008df7575d38b32e1ac6aac5e0e329997a79a84df7e5063f1c4`, Runtime `e9b45901ea4a3a7c207ddd3bbe5200a56170812276fe73869fdf9711b9c7a681`, compatibility `e67a22cea0fab421616a0eb7f493710c56285cd02b444c705ae8310dd741f27e`, and protocol `2.5.0`; packaged manual acceptance remains pending.

H5 and its direct ownership audit are closed on the `dev/intergration_myagents-dsh` worktree at `f2aa6334c540453063cf8af31150e9f72742e934`, with deterministic/package evidence at `f4ba61515ac2e7b5da52d0a333c73257385ec5a4` and follow-up authority fixes through `b9bc80374442fd5904153f1c75da7156460f87b6`. `ab046c1593e8ab0c34eb17e07f1f10d77f34969c` makes the distribution policy authoritative in Renderer, Rust Session birth and IM; `b9bc80374442fd5904153f1c75da7156460f87b6` adds the allowlisted Developer default across those owners and fixes DSH legacy projection to exact `dsh/integrated`. The current worktree consumes workspace-Skills/stdio-MCP handoff `999a80f5d9cc33f858cf3c11a8031a431ad8303221ddf0a3ec74452cb265dba7`, Runtime `4b3bc9de9a00b58c5284eb21563fb0e8fc64dbf1b6b98f458056d8da78b8959e`, compatibility `dbedcc9ef0632833d82c7707ae4267f10d275ee00e922bbd20e1c1625f1216f3`, protocol `2.3.0`, and exact Node/npm `24.14.0` / `11.15.0` across development, build provenance and bundled resources. The official ingestion command verifies the external handoff, atomically replaces the complete resource directory, and verifies the staged copy against the committed lock.

Ordinary API Providers enter DSH by their declared Anthropic Messages, OpenAI Chat Completions or OpenAI Responses family. The Product Provider/model registry owns endpoint, authentication, capacity, modality and model identity; no Provider/model cell, Runtime model catalog or model-name whitelist participates in selection or admission. Subscription/OAuth Providers retain their existing non-DSH owners. The generated handoff and committed Host lock are the exact staged-resource identity authorities; protocol `2.5.0` remains current. Packaged representative routes, signed distribution and Windows/Linux native validation remain H6 acceptance work.

The subsequent Host Skill compatibility refresh consumes handoff `1d7aa2a843eb32e0bfd8b635ce6e192bbb1b670eb7f6fd42ed753cfea2491c27` and Runtime `fb68cf4d13f87ccc62601baf4cb6001a61cf9f81f3674d61b981aee376e946f0` from source `10ed2ac8b79c13b0d6c11d9b324803b178dcb70a`. Model-visible Skill descriptions are normalized and truncated to 1,024 code points; one structurally valid Skill's prepare/install failure degrades and omits only that Skill. The protocol and generated Host client remain unchanged. The official ingestion command and staged-resource verifier pass against exact bundled Node/npm `24.14.0` / `11.15.0`.

The component-isolation refresh consumes handoff `09f020404c91f1d40d92841cd8342a0bdbe984fdf01428a508842a0ece751fc3`, Runtime `ae11ba1e41503b8d3518d4a1153f05bafc061fa9c6df54c777d9ce995390869c` and compatibility `8ba0c0e96f9943af75fca0f8559064bbc247ddf4ce831793299ecf0aa3cf2c4c` from source `947d02e38f5a386413930bfb5470af90b2ec205d`. It generalizes single-component isolation to every declarative component kind, records non-ready receipts in unified logs, omits the Product command `UPDATE_MEMORY` because its uppercase identity is outside the exact DSH command grammar, and separates the Session-binding baseline revision from the final Product configuration revision. An agent-error terminal now also settles Renderer streaming state so a failed admission cannot leave the Chat loading indefinitely. The official handoff verifier, ingestion command and staged-resource verifier all pass with exact bundled Node/npm `24.14.0` / `11.15.0`.

The runtime-backed Provider and owner-staging behavior keeps Managed Codex visible beside ordinary DSH API Providers without admitting it through DSH, preserves the Agent's base Integrated Runtime across Managed Codex entry/exit, and acknowledges pre-owner Agent/MCP hydration as `pending_next_start` instead of a false 500. Actual compiler/component failures remain observable.

The interaction-reliability refresh records force-transfer intent before interrupt, persists failed/stopped partial output before queue drain, settles the exact DSH Product operation before later admission, and makes banner retry native-admission-aware. First-turn rewind consumes protocol `2.1.0` genesis truth. Permission settlement is single-flight per exact Runtime tuple and the Host expires a synchronously resolved interaction once. Structural transcript retraction is a critical SSE event. Exact Node `24.14.0` / npm `11.15.0` typecheck, lint, focused stateful tests, the complete 479-test integration project (two opt-in native tests skipped), and Web/Server/Bridge/CLI builds pass. The official `2.1.0` handoff ingestion and staged-resource verifier pass against handoff `5ee7a6f07557b03a2e1353533fb5b3744148d20894d6f01699d8a0c61255e705`; an explicit native `RuntimeProcessHost` smoke then handshakes with and shuts down that exact staged Runtime. Signed-package and Windows/Linux native acceptance remain open H6 gates.

The restart-safe permission refresh consumes handoff `ae03ee3086571513b6c50c385b4783808fbfc2737a0814822a7c2f08091a6f6b`, Runtime `bb6678a258c9769ed8179461beeafc7e792e1f291913765c014941a18b3e3851`, and compatibility `8ba59b37c7e04397e7c75daaef6ba1267169a8d39597c045a20b41b8164fea0a` from source `4b3f2bdad1fd4860fca212c49b3ac3f527a51a30`. Existing Sessions now bind `session/resume` with the Product's effective permission/config revision before persisted-state validation, while fresh Sessions retain the default bootstrap followed by `config/apply`. Recovery without a Product mutation journal preserves the Runtime's non-mutation reason instead of inventing a journal mismatch. The exact staged Runtime native smoke now creates a Session, applies `acceptEdits`, stops the Runtime process, resumes the same native Session from durable storage, and verifies the restored effective permission mode.

The subsequent Session-surface audit treats `integrated` as a first-class non-builtin SessionEngine kind across IM, Heartbeat and Memory, and preserves `RuntimeSource:'integrated'` through Task validation, Cron transport and Sidecar birth. Inbox delivery now requires a parseable positive target acknowledgement. Native DSH/Codex fork targets use a caller-owned Product Session ID so a lost HTTP response can be reconciled without creating an unreachable branch; DSH rewind and retry use the same restore-and-classify rule already required for Codex. These are Host integration semantics and do not add a second DSH conversation owner.

The DSH first-response path shares the persistent-Runtime prewarm entry with Codex and Gemini only for an existing native Session resume. A new or config-materialized Product Session with no `runtimeSessionId` remains a draft: model, permission and reasoning choices may update Product configuration, but prewarm does not call DSH `session/create`. The first admitted Product turn creates the native DSH Session under the already-stable Product identity and persists that native id for later resume. Pending Product identity materialization also never copies a provisional DSH native id across Product ids, because DSH persistence is scoped by that Product identity. A historical zero-message DSH draft with no pending root operation clears its pre-turn native binding during restore; any Session with Product history or pending work remains untouched and must resume exact durable truth. Existing DSH Sessions still prewarm their exact native resume and extension activation when the Chat surface becomes ready. The regression path covers prewarm before and after config materialization, legacy zero-message cleanup, one native birth at first send, native-id persistence, and exact existing-Session resume. Exact Node/npm `24.14.0` / `11.15.0` typecheck, lint/dependency checks, 29 build-script tests, the complete 634-file / 5,553-test deterministic suite, all four production builds, staged DSH resource verification, and the two-scenario native Runtime start/restart-resume smoke pass. DSH may emit reasoning as delta-only protocol events; the Host synthesizes the Product thinking lifecycle before projection, closes it at every content boundary, and coalesces only same-index reasoning chunks through the existing bounded SSE window. Turn telemetry records the first thinking-or-text delta as the actual first model output and also records separate first-thinking and first-text timings. These are Host lifecycle/projection rules; they do not alter DSH conversation authority or the native protocol contract.

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


Self-test Provider status correction: a structured result remains separate from canonical tool execution.
Runtime projects explicit error flags, typed/array errors and structured HTTP failure statuses;
Host rows distinguish running, result returned, failed and unconfirmed. A completed root turn with
only a Provider call stops the row animation and leaves its outcome unconfirmed in live and reopened
history. Provider completion does not claim search accuracy or canonical tool success.

## DSH 0.1.2 collaboration implementation candidate

`dshCollaboration` in AppConfig owns desired depth/capacity, collaboration delivery timing and model selection. `collaboration-compiler.ts` compiles exact ordinary Provider/model references into non-secret Runtime profiles and separate ephemeral Host bindings; current application of those bindings remains owned by DshRuntime configuration admission. `DshCollaborationSettings` uses the shared Settings write owner and CustomSelect. Its only entry is the existing hidden developer section under Settings → About, unlocked through the About logo; it is absent from General settings. The existing user input realtime/turn setting is independent.

The Agent tree entry is currently withheld from Chat: the composer has no tree button or callback, and Chat does not mount the dialog. The retained `DshAgentTreeDialog` component uses the Tab SessionEngine route `/api/session/agent-work`; the integrated adapter reads native `work/list` pages and calls the dedicated message/stop/resume ports. Runtime holds actual tree, handle revision, activation, model and usage authority. The dialog presents task titles, compact lifecycle states, roles/models and available controls. Provider identity, activation counts, bounded output previews, usage/context metrics and internal IDs are available in collapsed details; unknown metrics remain explicit there. The header contains only the title and node count, with no aggregate usage, explanation or effective-configuration block. Closed nodes expose resume without a disabled follow-up button. Direct child lifecycle metadata reaches the original root tool card; deeper nodes with repeated native tool IDs remain in the tree. History uses v1/v2 activation identities and durable phase/reopen facts without inventing event timestamps. A higher handle revision can reopen a completed identity, and stale close snapshots cannot undo it.

An autonomous Root reply is projected with `RuntimeTurnAnchor.origin:collaboration` and its exact native clientOperationId, without a Product user message. SessionStore remains the single Product transcript writer and validates native turn/get against durable operation facts during cold recovery. The ordered per-process Product event sink waits for previous terminal persistence before entering a new collaboration turn; root loading and Stop belong to this actual root operation. Collaboration delivery receipts cannot acknowledge an unrelated pending user. Host realtime input uses identified `turn/followUp`, preserving the Product message ID.

The protocol 2.7.0 handoff has been ingested through the official builder/ingester. The committed integration lock owns all exact source and artifact identities; the original source checkpoints remain historical evidence. Real-provider and user desktop acceptance remain separate from deterministic and native process checks.

Identified realtime inputs now use the same SessionStore metadata owner for a bounded `pendingDshInputs` journal (32 intents, 8 MiB combined). Each intent freezes the Product user row, attachment digests, target operation and native input fingerprint before RPC dispatch. Product history is published only after native consumption. A lost reply retains the intent; cancel persists its intent and waits for the exact native input receipt. Recovered input is sent only with the original operation, body and identity. A verified terminal head with no native admission retires that pre-dispatch intent without assigning it to another turn. Rewind/fork/delete admission cannot bypass pending input intents.

Cold projection accepts multiple distinct claimed messages within the same native turn and verifies exact consumed-user associations. It can restore a user from its Product journal after native consumption, or reconcile a user already appended before a crash, then retire the intent idempotently. Collaboration inputs remain excluded from Product user ownership. The Product event queue is bounded by count and bytes, and closes its process on overflow so durable native truth can be reconciled. The 31-test input/store checkpoint covers these source-level crash and identity rules; process startup/terminal races and actual generated-client integration still require the new immutable handoff campaign.


### Current Session component availability and startup replay

The existing Session configuration snapshot carries native component receipts for ready, disabled, rejected and pending declarations. Invocation flags come from the admitted declaration; execution permission remains independent. Compiler exclusions are rejected, missing receipts stay unknown, and a queued declaration never claims the old effective generation. The workspace Skills panel reads only its Tab API, displays enablement, admission, invocation and effective/requested generations, and refreshes while open. Global installation lists do not claim a Session admission. The Session-scoped `skill list` Admin/CLI projection reports the same receipts in JSON and text.

During cold startup the Runtime adapter buffers Product events with native turn identities. After durable reconciliation it discards only events for turns already settled in that snapshot; a new collaboration operation admitted after the snapshot retains its admission, output and terminal. Root admission carries the identity from the admission payload even when an envelope lacks it. The event sink remains serialized through Product transcript persistence.

本轮自动化验收：Host 全量 4033 unit、1117 DOM、499 integration 通过（默认池跳过的 3 个 native process tests 已显式运行通过）；构建脚本、typecheck、lint、Web/Server/Bridge/CLI 构建与 Rust CLI 14 项通过。native lifecycle soak 12 次，文件描述符 14→14。最新完整制品以集成锁为准；真实 Provider、外部 Tester 与用户桌面验收未替代为自动化通过。


Final integration source checkpoint (2026-09-06): Runtime source `af2604a10887ac404874c00bfa6b8cc3c107cb49`, Runtime manifest `ef003339095e457d49ddf5a758c1800ea1e52e64ce6c2e5c2dacfd9d201dc57d`, handoff `da5634a06e4370106d5fd70aa5eae90100dfdce91d9b9a7769273993f676f649`. Runtime typecheck/lint/build and 70 files / 736 tests pass, as does source-bound pre-artifact gate `9c60729f419dfcfb736fc87d263085a1e7ca6cc2b1361b2dfc167678eb439f97`. The exact Runtime passes all eight real DeepSeek standard scenarios, its macOS native campaign, and an independent Tester child-task run. macOS is now `verified`; Windows/Linux remain `implementation-complete_pending-native-validation` with evidence bound to these bytes.

The Host ingestion policy and Rust readiness probe accept both explicit supported claim states after binding the exact outer/nested/compatibility identities. The official verifier remains responsible for native evidence on a verified claim; changing a label or file cannot bypass the committed digest. The earlier three-child failure was adjudicated as incomplete Inbox receipt-batch projection and fixed in Runtime, together with retirement before Cordis service disposal. Historical failed runs and the earlier packed-terminal timeout remain in the external release record. User desktop joint acceptance remains separate from these automatic gates.

Final Host validation: official ingestion/resource/freshness checks, typecheck and lint pass;
4033 unit, 1117 DOM and 499 integration tests pass (existing opt-in skips retained).
The exact staged Runtime passes native start/restart and the 12-generation lifecycle soak
(file descriptors 14 to 14), plus 11 Rust DSH tests. Web, Sidecar, Bridge and CLI bundles rebuild
successfully with the final lock. The handoff policy regression validates the complete staged
facts against that lock, including the verified macOS claim.

### 2026-09-06 Official DSH Shell adoption (UPG-W10)

The Runtime now owns Shell execution through official `tool-bash`/`tool-pwsh`, executors, shell environment and Jobs components. Host initialize uses protocol 3.0.0 `shellRef: runtime-shell` and a platform-matching `shellDialect`; custom Windows PowerShell supervisor/prelude references are removed. Windows uses PowerShell directly and does not require Git Bash for DSH commands. macOS/Linux use Bash. The release remains pinned to DSH 0.1.2-rc.1.

The shared terminal presenter recognizes `bash`/`pwsh` while retaining historic `Bash`/`PowerShell` rendering. It uses official rendered output plus Runtime-derived exit/cwd/state metadata and highlights PowerShell syntax. Official `job_output`/`job_list`/`job_kill` use the existing generic tool projection. A foreground timeout ends the command; background execution must be explicit. Permission review preserves full command/cwd for both official Shell tools. Legacy Agent tool-name selectors `Bash` compile to the Shell family (`bash`, `pwsh`), then the Runtime's effective platform catalog narrows visibility; disallowed selectors are translated symmetrically. Durable permission grants are not broadened or renamed.

Implementation and integration are complete. The final immutable handoff is verified and ingested; earlier receipts above remain historical. Windows/Linux claims remain pending native validation.

Final Shell delivery: Runtime source `62b67740ec5c089101a38a5f95e8ab1c8193de80`, Runtime manifest `c56038b8e3a3bcc99f271ec18ee4bb12e3f2fb2989daa63937f33aaa2bde0b33`, handoff `0a1323fbea128972eaa53a14f3513ae3083606eeb12393b74ee2c2e71b92f4ef`. The 72-package DSH artifact is `58ff076944e029d835e34bbdf433609422ac88d381bdede3e7b216b28975e6f8`; source version and ten core patches are unchanged. Protocol 3.0.0 has 44 Host methods, seven reverse methods and four notifications. The implementation catalog contains 24 definitions; each platform exposes its selected Shell and 22 other tools.

The final Runtime passes source-bound pre-artifact report `98971cf42ce92c91d3a6c7ad71498ddcb66c987b62b21a7e7648ae119eb53495`, 723 Runtime tests and packed/process gates. A fresh external Tester ran all eight real-model standard scenarios once: all passed, with zero active resources, attachment leases, credential scopes and unexpected Host fatal errors. Native macOS report `cb0f71b0ec5b86451e6fc3a33fa549f1500aa570f547a75999a5f56610b0e976` verifies these exact bytes; Windows/Linux evidence is newly bound to the same Runtime and retains the pending label.

Host full validation passes: 4035 unit, 1118 DOM and 499 integration tests, typecheck and lint. The final staged bytes additionally pass DSH unit and handoff-policy checks, actual handshake/configured restart and 12-generation lifecycle soak (descriptors 14→14, RSS growth 0), and 11 Rust DSH tests. Web/Sidecar/Bridge/CLI bundles are rebuilt with the final lock. Official resource verification and the exact source freshness check pass. The remaining acceptance is the user's desktop journey and Windows/Linux campaigns on their native machines.

### 2026-09-06 macOS signing resource-permission fix

The first user Debug App build exposed a packaging gap: three outer platform-evidence files retained their source `0400` modes through ingestion and Tauri copying. Tauri CLI 2.11.4's pre-sign `xattr -crs` returned `Permission denied`, surfaced only as `failed to run xattr`. The ingestion owner now prepares permissions in its temporary copy before complete re-verification and atomic replacement, as specified in §7. The accepted source handoff, Runtime, contracts and all pinned digests are unchanged.

Validation passes: eight handoff-policy tests (including a real macOS reproduction and fix, source byte/mode preservation and link rejection), targeted ESLint and exact Runtime source freshness. The same `tauri:build -- --debug --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'` command used by `build_dev.sh` completes Web/Sidecar/Bridge/CLI builds, Rust compilation and Developer ID App signing. `codesign --verify --deep --strict` accepts the generated App, whose packaged DSH handoff and bundled Node/npm pass the public resource verifier. Two native tests run from that App's actual `Contents/Resources`: handshake/shutdown and configured Session recovery after process restart. The optional soak was not repeated for this packaging-only change. This is a signed local Debug App with notarization disabled, matching the development script's policy; it does not add Windows/Linux or distribution acceptance.

### 2026-09-06 Runtime/Host boundary correction (UPG-W11)

The Host derives environment keys from its actual child environment, including current CLI port and Session routing. Runtime 3.1 admits those values during initialize. Fixed execution facts come from generated Runtime capabilities; the Host sends choices and identities. Public method tables, request/result types and model/extension profiles are imported from the handoff's standalone generated contract.

Auto selects Runtime `acceptEdits`, which permits both WebSearch and WebFetch by default. The Host does not change persisted tool-policy configuration to express that default; existing Session restore identities remain valid. Explicit Hooks/network restrictions remain effective. Permission registration carries typed complete operation details, actual call/rootCall and executing Agent attribution, and Runtime-owned rule scope/lifetime. Large reviews use the existing Runtime attachment and Sidecar `/refs` paths; refs live until settlement/cancellation. The Renderer loads full detail before enabling approval and allows same-request retries after load/response failures. Unknown review variants render full generic detail. Existing interaction IDs and Runtime receipts remain the only settlement authority.

Installation verification performs one nested inventory scan per existing Sidecar identity, then retains the actual process initialize/status handshake. No additional verification cache or interaction state machine is introduced. This section describes current source; the integration lock and official immutable release receipt identify accepted bytes.

UPG-W11 R1–R11 now have accepted local macOS implementation and delivery evidence. Exact Runtime source is `4ef3192947d7cb3b0a13f42973ce0a32ee58c84b`; its complete pre-artifact gate is `1bb7b48849f5c3755881e550f08250ae8632a61b71c7a36e2326214f5efb21bb`, Runtime manifest `f371219c971a7e9ab20c8afc266c1269f16df0b388f1992fb6167881fb05756f`, and immutable handoff `e89ff88d5946545369f9ce46ce807c58ce5f7d2f78c4f877b6ea58400b2ce5fc`. The official builder and Host ingestion both pass; the committed integration lock and generated contracts bind protocol `3.1.0`. The fixed upstream commit, 11 seams and 10 patches are unchanged; the rebuilt DSH manifest is `246236a8afd45f51367df69d43422d739ba4fed2208503179613066ff3adebd4`, with two independent builds byte-identical.

Fresh-context external Tester execution passes all eight native model scenarios, with every final active resource/attachment lease/credential scope counter at zero. Main accepts native report `08b641d60b3d663fe8265cff00c17290598f5a9254a7d00c7d339c0e33994c43` and dynamic manifest `ba795468c1fe7b04168cbe8e3fcb200e0eefeeefa7177ee4a4168277e11f14e0` for these exact Runtime bytes. Runtime gates include 732 tests; Host gates include typecheck, lint, 32 build-script checks, 4,033 unit, 1,122 DOM and 500 integration tests, four production bundles, and 11 focused Rust tests.

The signed Debug `MyAgents.app` passes `codesign --verify --deep --strict` and its bundled Node `24.14.0` verifies the same handoff. All five tests against the App's actual resources pass: ordinary and 70 KB Shell reviews execute only after approval with the production CLI port/Session environment, exact Runtime handshake, configuration-preserving cold resume, and a 12-generation lifecycle soak. Every Runtime PID exits; descriptors remain `14 → 14`, with Host RSS growth of 344,064 bytes. The Renderer also rejects stale details when changing requests and supports full-detail load and response retries. Same-machine alternating verification measurements after building show warmed combined verification at 677–692 ms versus 1,291–1,292 ms for the prior outer-plus-self-check sequence; this is diagnostic evidence, not a timing guarantee.

This is the post-source-freeze delivery subledger linked by the Runtime PRD. The [trusted external receipt](../../../MyAgents-dsh-release-work/upg-20260905/boundary-8-release-receipt.json) binds Host source, App hashes and gate logs without changing the sealed Runtime source. The Debug App is locally signed, not notarized; desktop product acceptance remains with the user. Windows/Linux retain `implementation-complete_pending-native-validation` until native evidence for these bytes exists.

### 2026-09-07 Inline approval progression (UPG-W12)

The desktop follow-up exposed a missing combination in UPG-W11 acceptance: two successful Always Allow responses were followed by nine `approval/decided: unavailable` records that never reached the Host UI. The permission service had correctly advanced the durable policy revision, but the Runtime Host bridge still required equality with the operation's original birth revision. The bridge now carries the permission owner's validated card revision while retaining its operation/Session checks. An unavailable answerer/Host failure is reported as an interaction error rather than a user denial; actual denial remains a denied tool call.

The exact old staged artifact reproduces the failure after the first grant in a synthetic Auto Session. Native coverage now runs Bash Always Allow, TaskCreate Always Allow, TaskUpdate, Skill, a foreground child Agent, AskUserQuestion, EnterPlanMode, writing the actual managed plan, and ExitPlanMode in one operation. Both ordinary and 70 KB command reviews must finish through the real Runtime reverse port. This complements the Runtime packed TaskCreate-to-TaskUpdate regression and existing independent authority, denial, cancellation and recovery tests. No Host policy broadening or new rule store is introduced.

Host WebFetch reports its HTTP status, and proxy connection errors retain the classified system code without exposing raw transport messages. Runtime Edit reports the complete Read needed before retrying. Shell remains an official DSH local-user process; governed file roots are not an OS sandbox. A Session explicitly put into Plan by an Agent stays in Plan until an actual exit or Host mode change; updating this implementation does not rewrite that user's stored state.

UPG-W12 W12-1–W12-5 have accepted local macOS implementation and delivery evidence. Runtime source is `7ca39fdeb41d56aa57003dd85d01a2c36b6d596a`, complete pre-artifact report `a8679d2e9e329328a598563898ed636732b5b8eaa4576440007c56eeeee299b3`, Runtime manifest `56a21f4aba9adde53de44fec0a7f8ecaf7b3de2dd42847537c079c0206b8dc26`, and officially generated/ingested handoff `ef9c62174e58fa48df24976837ce924137b5db62a57f804bc27c28b9a72c0bae`. The committed lock and compatibility manifest bind those bytes; protocol 3.1.0, DSH source and patch inventory remain unchanged.

The fresh-context external Tester passes all eight native model scenarios; Main accepts native report `ce1ff5d91e389438acb0d3b22c2590ccf46ad6069826587659b086ccaa2f0861` and dynamic manifest `185b2e5e687b1e09de38fe6655da01e9ad6d959e2e07391f1bdceb7d8ba84e52`. Each case exits its Runtime and removes owned resources with zero active resources, credential scopes, attachment leases and unexpected Host fatal errors. Runtime typecheck, lint, 733 tests and build pass. Host typecheck/lint, 32 build-script checks, 4,034 unit, 1,122 DOM and 500 integration tests pass; the new handoff also passes resource freshness verification.

All five native Host tests pass against both staged resources and the signed Debug App. Each approval variant completes nine root tool calls, seven permission cards (including two Always Allow grants), two question/plan cards, and eleven model requests including the foreground child. The plan returns to normal mode. The App additionally passes deep/strict signature verification and its bundled Node verifies the accepted handoff. Its twelve-generation soak exits every Runtime PID, retains descriptors at 14 → 14, and records Host RSS growth of 507,904 bytes. Production Web, Sidecar, Bridge and CLI bundles were rebuilt through the official Tauri build.

The [trusted external receipt](../../../MyAgents-dsh-release-work/upg-20260905/boundary-10-release-receipt.json) binds these gates, the old-artifact negative reproduction, final Host source and App hashes. This subsection is the Runtime PRD's delegated post-source-freeze acceptance record. The Debug App is locally signed, not notarized; final desktop acceptance remains with the user. Fully quit the old App and start this new build before retesting. If continuing the reported Session, change its persisted Plan mode back to Action through the Host UI. Windows/Linux remain `implementation-complete_pending-native-validation`; no native claim is inherited from older bytes.

### 2026-09-07 Action permissions and Session review (UPG-W13)

The user-approved Action policy is implemented by Runtime `acceptEdits`, preserving the Host's stored mode and configuration identity. File and Web tools, Skill, task management, Agent/SendMessage/TaskStop and job management run without redundant permission cards. AskUserQuestion still presents the question and ExitPlanMode still requests approval of the written plan. Official Bash/PowerShell and dynamic Host/MCP tools require approval unless an exact active grant applies. Visibility, Plan restrictions, workspace/role limits and Hooks retain their own execution checks.

Product-managed children use the official DSH approval `ask` entry point before publication, replacing delegation's `never` default. The child-scoped prompt assembly waterfall replaces the stock delegation context with the actual Host approval capability. The existing permission owner validates the operation's durable revision progression before matching the latest Session-tree exact grants, so an approved target is immediately reusable by a child in the same operation. Pending responses and one-time grants remain call-specific.

The incident review correlates all twelve successful root Always Allow clicks with durable grants and actual results. Three child Shell attempts were rejected by stock DSH policy before reaching Host UI; the first plan exit was authorized but failed because no plan had been written. The new Runtime provides concrete plan-writing recovery guidance and states that official Shell runs with local user permissions, without an OS sandbox. A separately confirmed same-file parallel Edit preimage conflict and CLI Runtime identity display are reviewed follow-ups, not claimed fixed by this permission delivery. User reports, transcripts and workspace files stay outside the repository.

The native Host regression covers both ordinary and 70 KB reviews: root Bash Always Allow; automatic Skill, TaskCreate/Update and Agent; child Bash reusing the same target; child Bash at a different target requiring an actual Host approval; then the real question and plan confirmation. All eleven root/child tool results must succeed with exactly two permission cards, two question/plan cards and thirteen model requests, and the child model context must describe the real approval behavior. The old artifact fails at the obsolete TaskCreate permission card. Staged and signed-App verification and the exact delivery identity are recorded below when accepted.

The accepted Runtime source is `4a3313e707e8b9d9f5565949d312170099ba9ac8`, Runtime manifest `05811b244a5dab46c67f04bd03883b9486914da36a38d9194b7e15b4efe1899c`, pre-artifact report `821290e94b40319d6c9918b7d21bdde8351918cf14d55acd6c379ac40daf71b4`, and official handoff `7d8ad718f4646878560cec105ad92a95d2f3c431e69e78b09df22366c3bfe464`. Final source-bound typecheck, lint, 738 tests and build pass. Protocol 3.1.0 and the pinned official DSH source/patch inventory are unchanged.

Main accepts the fresh external Tester's eight-scenario rerun, native report `8e9ae1ba93e4773a6ecc775c5166d27b54f43a2c78d10d32296a3e2fda151815` and dynamic campaign `a0a30efd30851f2d3c6569c538c5b1195bf98f479276bcf039b5e799f0b667b6`, with zero active resources, credential scopes, attachment leases and unexpected Host fatal errors. The first unchanged campaign is retained: seven scenarios passed; the child scenario's root operation succeeded, but a background child completion admitted collaboration during diagnostic history pagination, invalidating the cursor. The test driver reported that read as failed and removed its owned resources. That diagnostic snapshot recovery is an explicitly reviewed follow-up; the Runtime's consistent-snapshot check is not weakened. The complete same-byte rerun passed without changing scenarios or production source. macOS evidence binds the accepted rerun; Windows/Linux remain pending native validation.

UPG-W13 W13-1–W13-4 have accepted local macOS implementation and delivery evidence. Official ingestion and source freshness, Host typecheck/lint and 32 build-script checks pass. All five native Host tests pass against both staging and the signed Debug App: nine root tool results are verified from Product events, and the two child Shell results are verified from the actual child model requests. This keeps child conversation ownership separate from root projection. The App passes deep/strict signature verification and its bundled Node verifies the exact accepted handoff. Its twelve-generation soak exits every Runtime PID, retains descriptors at 14 → 14, and records RSS growth of 360,448 bytes. Web, Sidecar, Bridge and CLI bundles were rebuilt through the official Tauri build.

The [trusted external receipt](../../../MyAgents-dsh-release-work/upg-20260905/boundary-13-release-receipt.json) binds these gates, the reviewed failed campaign, final Host source and App bytes. This is the Runtime PRD's delegated post-source-freeze acceptance record. The local signed Debug App is not notarized; desktop acceptance remains with the user. Fully quit the old App and start this build before retesting. No user Session, report, configuration or workspace was modified. Reviewed parallel Edit, Runtime identity presentation and diagnostic pagination improvements are not included in the permission-fix completion claim.

### 2026-09-07 self-test convergence (UPG-W14)

User-selected items 1/2/3/6/7/8 only. Runtime normalizes file aliases through the existing Provider,
rechecks the original input after authorization, preserves retained-output misses versus errors,
and recomputes independent Edits under the file lock with actual checkpoint preimages/version CAS.
Host history recovery discards the complete assembler on explicitly retryable cursor_stale or
session_read_unstable, with three attempts and 1,024 pages per attempt; malformed data and other
errors propagate. The dynamic driver uses the public protocol snapshot reader with the same policy.

Host status and Agent list share the same visible/active registry projection. Task cards and CLI help
explain stable root/Agent owner IDs; names do not replace IDs. Known socket/refused failures retain
route, phase and system code with actionable text, without asserting a DNS cause. ls distinguishes
entry and byte truncation. Runtime/model/depth state queries remain outside this workstream.

Runtime and staged Host acceptance is complete. The official builder/ingester bind Runtime source
`1046856d1fdf6a5762067ef91e9eab55d4a90c07`, Runtime manifest
`645296b4efbdf9edab9784443a4c1511e4a7f4c6ab0b9df9d1862edafd3ede91`, handoff
`b864f8d8fb386ee8ad9ddd68b5dec091cc84f902948d4cc87fdbd84567bde3ef` and compatibility
`0413843e1fe76df07e2fc2e7f50254546e9b08697ec0862c27c931c2c9ab0d2d`. Protocol remains 3.1.0;
DSH revision and patches are unchanged. Pre-artifact report
`7c8afdf427f5b12379cd16496f86386bce6e804fb14ccafffbb1b2ac14b78256` passed all ten phases.
Fresh external native testing passed all eight scenarios; report
`3b8a65c5f8f9a3bb91a9fd24268483466694a38f85d7389c4e7f401016678321` and dynamic campaign
`446946afd32ee1b050f7f6b6459635e84366e551f9adcb9735eb49fec9868825` bind these exact bytes.

Source gates passed: Runtime 757 tests, typecheck/lint/build; Host 4,047 unit + 1,124 DOM + 500
integration tests (8 explicit skips), 32 build-script tests, typecheck/lint. New staged Runtime
passed all five real-process tests, including Action/shared child Shell grants, cold resume and a
12-generation soak (14→14 descriptors, RSS growth 425,984 bytes). Freshness verifies the frozen HEAD.
The first ingestion command used the Host shell's Node 24.15.0 and was correctly rejected before
copying; its premature staged check saw the old resources. Both logs are retained separately. The
accepted ingestion and process tests use the required Node 24.14.0; no verifier rule was changed.

The signed App build and final packaged-process acceptance are owned by the immutable external
[W14 delivery receipt](/Users/ethan/Projects/MyAgents-dsh-release-work/upg-20260905/boundary-14-release-receipt.json),
created only after their checks pass, so recording those results does not invalidate this source
freeze. macOS is verified; Windows/Linux remain implementation-complete_pending-native-validation.
User desktop acceptance remains the final product acceptance step.


### 2026-09-07 main 0.4.15 and Node/npm convergence (UPG-W15)

The integration branch includes main `7544161c` (MyAgents `0.4.15`) and the final W14 Host commit `21b0a890`. Main remains authoritative for core product behavior and the compact architecture/documentation structure. DSH owner details stay in the Runtime module and this historical delivery ledger. No product owner or process type was added by this merge.

Semantic resolutions retain main's Codex generation/FIFO and acknowledged-input rules alongside DSH's native admission journal; preserve stable message-list context and interaction state; reuse main's per-model TokenDance protocol selection for DSH root and child profiles; and align the Claude SDK implementation identity to installed `0.3.261`. Bundled Node/npm now come from main's single official distribution manifest, including the actual npm package metadata, instead of the older independently replaced npm/marker convention.

MyAgents-dsh source `67c899a6164d3030c366028bd6e62f741c4dfaa6` pins exact Node `24.20.0` / npm `11.19.0`. The official DSH source and patch series are unchanged. The rebuilt patched DSH manifest is `5ba6a2f5dcf8437c176c0c806c918c526d5a2c8da895501bc3dfcd9c6c669081`; Runtime manifest `08b0b651eb74d42a10d945e5fab5016df1b583d021c6b6bd1c4743bf583c966b`; official handoff `ac0a1c9b42af493abad33b20413fde36ba775d333eb56ba339c386c32e6b0ae3`; and compatibility manifest `4fde0f48e9ae2195e41532a3798ff4d830a7325ef85f59a7b9ce7d0880509557`. The generated wire schema remains protocol `3.1.0`. The accepted lock and contracts were updated from these verified bytes.

Runtime typecheck, lint, build and all 757 tests pass. The macOS native campaign passed all eight configured scenarios and sealed report `76ecab384ca54d36b940094f706ed99411f819d8c770332d84c5370be823fad5`, with dynamic campaign `5b5661e88c21c3bd54dd8a341bb7115654e6df836a2a59ae271e7d4ff37ba35c`. Host resource verification and source freshness pass; the four staged Runtime process smoke tests pass, including both shared child Shell approval variants and process restart/resume. Windows/Linux retain pending native-validation claims bound to the new artifact.

The [local merge and verification receipt](../../../MyAgents-dsh-release-work/upg-20260905/main-0415-node2420-receipt.json) records the final Host commit and source/build gates. This receipt covers source integration and staged development resources. Earlier signed App receipts describe their own immutable builds and do not validate this new merge.

### 2026-09-08 Official Read/Write/Edit and local filesystem (UPG-W16)

User scope is Read/Write/Edit and local file services. Runtime source `40f7174d0b1fef02f4472f1290dfa97aa6f87e5e` invokes the official DSH text/image reader and Write/Edit executors inside the existing product tool call. The local filesystem extends official `LocalFileSystem`, delegating text streaming, literal edits/CRLF handling and native atomic publication. The fixed upstream source remains `a66e470204`; patch 0011 exposes definition factories, the exact stored-edit preview, a publication policy callback and parent-creation configuration. No second ToolRuntime, filesystem owner or document process is introduced.

Product permission checks, durable complete-read receipts, checkpoint file/directory journals, target revalidation after review and before publication, and Host attachment request scopes remain authoritative. Image Read uses the actual calling root/child model's modality and returns normalized image content through the existing attachment reverse ports. A text-only calling model receives an explicit error. PDF Read directs the model to the existing `myagents-anydoc` document-conversion flow, whose native-text extraction is independent of model vision. Notebook files use ordinary UTF-8 JSON Read/Edit.

The publishing tool and consuming model request require separate attachment scopes. Client-process acceptance exposed that model streams previously had credential scope only. HostModelAuthority now supplies the existing HostAttachmentStore with current Provider/Session/execution-environment authority for iterator creation, iteration and cleanup. The Host regression verifies image bytes in the actual next Anthropic request, alongside CRLF edits, a read window from a file exceeding 8 MiB, Shell grants and child approvals. The Host registry must also make `readOnlyPath` true on disk: new content-addressed objects are read-only, copied Runtime publications are sealed, and validated objects from earlier Host versions are sealed before their first lease. Already read-only objects are not chmod-ed again, preserving file identity while another consumer holds a lease. The Runtime retains its read-only validation.

Two independent patched DSH builds have identical bytes across all 78 files (74 packages): manifest `5348318d9157a7eedd29813265a5ae2e1ddc20651bae4652390388693113f13b`, version `0.1.2-rc.1.myagents.a66e47020478.db06dc323417`. The packed composition and installed Runtime verification pass: Runtime manifest `b4288b7722a0d1e4e88284d87ab5675aad9a080bf4b65acfefa52484fb4a8186` (17,458 files). The clean-HEAD pre-artifact gate passes at this source: report `7ce7b11f03d2a2d75ac30009cd41c2edeff6456d9b502da2a206ba144bd69f61`, 71 files / 764 tests, typecheck, lint, build, upstream source checks, fault matrix and three lifecycle soaks. The fresh external Tester campaign passes all eight macOS scenarios at this exact source and Runtime: native report `da21506ff95ecc69906c2ff1f714b245e7b260e00a5d62e2a7e140bfb2b42d09`, dynamic campaign `aba859066b6a61352a65e798c401f21ea79cf7b837951e056cb50e9f9c54cf29`. The official builder seals handoff `b522e3409b80c473f5916f75041a62c7dcee4205240cffbbfed9685b7e61946a`, and Host ingestion accepts its complete resources and generated contracts. Windows/Linux retain pending native-validation claims bound to these new bytes.

Host acceptance passes resource verification and clean Runtime source freshness, 25 unit files / 152 tests, 37 handoff-policy tests, and all five staged process tests, including both actual image-request journeys and the 12-generation lifecycle soak. Focused attachment tests cover Runtime/Host/user image publication, old writable objects, and corruption rejection. Typecheck, lint, test classification and Sidecar build pass; dependency-cruiser retains 13 existing warnings and zero errors. This delivery updates source, generated contracts, staged Runtime resources and the Sidecar bundle; it does not replace an already installed App.


### 2026-09-09 Round 6 reliability (UPG-W17)

Authorized scope is items 1–6 and 8–11. Item 7 (codex-sub status) and item 12 (Record deletion CLI) are excluded.

| Item | Result and authority |
| --- | --- |
| 1 | MCP status separates global configuration, the workspace selection from SessionEngine, and the current effective MCP snapshot. Stale/missing observations remain unknown. |
| 2 | App metadata comes from the Rust launcher. Sidecar version and source identity are captured at build/startup. DSH diagnostics distinguish the Sidecar lock's expected artifact, a verified installation, and the current process handshake/artifact. |
| 3 | `diagnose runtime dsh` uses the SessionEngine facade and runtime adapter to inspect resources, process, effective model/permissions/extensions and sealed general-proxy policy. It does not create a Session or expose credential values. |
| 4 | Empty/whitespace search snippets fall back to actual Provider content, then matching citation excerpts where present; no summary is fabricated. |
| 5 | `config list [prefix]` discovers normalized configuration keys, types and descriptions without values. Sensitive maps remain opaque; absent optional keys are explicitly not advertised. |
| 6 | DSH model discovery points to the selected Provider catalog and no longer suggests a missing runtime merely because its static model list is empty. |
| 8 | All three Session recovery suggestions include the required `--agent <agentId>`. |
| 9 | `skill list` hides normal admission/generation/success-code details. `--verbose` expands them; abnormal admission, unavailability and generation drift remain visible. JSON remains complete. |
| 10 | Official scoped SystemPrompt exposes each child's frozen model/native Provider route, role, parent, depth and present remaining delegation depth. Cold materialization reuses the exact birth authority. |
| 11 | The first successful foreground result is delivered through the Agent result once. Durable epochs, failure details, background and subsequent activation reports remain intact; legacy persisted report intents are still recovered. |

System skill projection advances to version 58. Runtime source freeze is `56e39d679eaf5bbbd68f34a6cc6e545784d88deb`; its clean-source pre-artifact report is `b954ed98363753765daf13f38bc53c443e098f0962daebfcace93d22ec739247`. The unchanged 11-patch, 74-package DSH dependency artifact is rebuilt with current dependency provenance: `56a4c392a88cfbc5b2fd6d492ebfbe12e76def536defe04c3d576502399a0e6c`. Runtime manifest `be4f0336be9a559058ccfde27baa6307cd792bfcf93f12900dcf2b4fb7f5c7d6` contains 17,458 files and passes packed composition/process verification. Runtime source gates pass 71 files / 766 tests, typecheck, lint and build.

The fresh external Tester passes all eight official macOS scenarios against these exact bytes: native report `7291038ccf01f9a000e323d95ffdd00642d24573fa4d12e7ff5b26ed976dcf33`, dynamic campaign `4ce0e1f493d5c981720b2d0696c0c62ba0d21f1de8f1f401d96061430fd96f7f`. The official builder seals handoff `f27c4e4eafc5d066eb710078155898e003bc8d9723d1b1e2d751f56843767b71`; Host ingestion accepts the complete resources, lock and generated contracts. macOS is verified; Windows/Linux remain implementation-complete_pending-native-validation, with evidence bound to the new artifact.

Host acceptance passes 36 unit files / 561 tests, all five staged process tests and 40 build-script/contract tests. Actual Provider-request assertions verify child identity and the absence of a duplicate first foreground completion, alongside file/image journeys and shared Shell approvals. The 12-generation lifecycle soak retains 14 file descriptors and grows RSS by 638,976 bytes. Resource verification, clean Runtime source freshness, typecheck, lint, test classification and Sidecar/CLI builds pass. Dependency-cruiser retains 13 existing warnings and zero errors. The targeted Rust checks pass 23 tests with one existing ignored test; this machine's test invocation supplies the installed Xcode Swift runtime library path. Changed Rust files pass the pinned formatter.

This delivery updates source, generated contracts, staged Runtime resources and Sidecar/CLI bundles. The installed App and its already-running processes require a rebuild/restart to consume the changes; these checks do not claim a new signed App build.

### Command approval presentation

`PermissionPrompt` renders command reviews as a compact card within the existing Chat message width. Purpose remains inline with its label; the full working directory and command come from the authoritative review. `PermissionCommandDetails` reuses the shared expandable container, theme syntax colors and clipboard helper: overflow receives a translucent gradient and expand/collapse control, while copying retains the complete command. Large commands bypass syntax parsing, not content loading. Referenced reviews must finish loading before approval becomes available; existing request IDs, retry and Session routing remain authoritative.

Command cards use “始终允许” / “Always allow” and omit the standalone lifetime explanation. Rules belong to the root Session and its children, match tool / permission class / target, and survive same-Session recovery until revoked or cleared by an actual permission configuration transition. They do not apply to independent Sessions. UPG-W18 removes the former product-layer 24-hour limit; Runtime protocol 4.0.0 represents the Session lifetime with null rule expiry and review duration. The Host parser and Allowed actions dialog preserve that authority without formatting null as a date. Validated legacy grants gain this lifetime during Runtime recovery; revoked grants stay revoked.

### 2026-09-09 Session lifetime for Always allow (UPG-W18)

Runtime source `2daf037c39f957b0ebee027333ea69fdcfc350a2` removes the permission TTL configuration and time-based grant filtering. New durable grants use null expiry and the v3 rule hash domain. Recovery first verifies legacy v1/v2 rule hashes and their original expiry policy, then projects surviving grants with Session lifetime without rewriting events. The former TTL slot is retained only in the frozen configuration identity and legacy validation; it no longer controls execution. This preserves existing Session, operation and revocation provenance across the upgrade.

The clean-source pre-artifact gate passes 71 files / 768 tests, typecheck, lint, build, fault matrix and three lifecycle soaks: report `86c98781b92f5805f6a570076201489892af2da9c92d84162fc4e89d0d5c73e0`. Runtime manifest `6bdd75fbf989889c55aed36593013d529c56e932521f034551e7044d34898a0a` passes packed composition and the fresh external Tester's eight-scenario macOS campaign: native report `4e462627186027cf8633d63a6acaa8701789fe148c8b9f731adb89a879188b6d`. Official handoff `abd05c3b784da5c842e35db15c17c4bb14719d8c3955e1530176bd517dd64154` supplies the complete protocol 4.0.0 contracts and staged Runtime. Windows/Linux retain artifact-bound pending native-validation claims.

Host validation passes 30 unit/DOM files / 187 tests, all five staged process tests including the 12-generation soak, 39 handoff/build tests, typecheck, lint, resource verification and clean Runtime source freshness. A separate real-process upgrade fixture creates an already-expired grant and a revoked grant with the previous protocol 3.1 Runtime, then resumes the same isolated persisted Session with protocol 4.0: rule identity/revision survive, the active grant has null expiry, the revoked grant stays absent, and explicit revoke still succeeds. The [local integration receipt](../../../MyAgents-dsh-release-work/upg-20260905/session-grants-integration-receipt.json) records final Host source and build results. This delivery updates source and staged development resources; an already installed App still requires rebuilding to consume the new protocol and Runtime.


## DSH 0.1.5-rc.2 upgrade implementation (2026-09-12)

UPG15 consumes protocol 5.0.0 and native V3 Session history through the official handoff.
The committed lock and generated contracts bind the exact staged Runtime; post-freeze receipts below own acceptance.
`event-projector.ts` tracks only the active assistant stream id, Product turn and last visible frame
position. It rejects overlap, foreign stream/turn deltas and invalid end boundaries. Native non-text
chunks can leave gaps in visible positions. Start/end metadata never synthesizes final content or
turn success; `dsh-turn-reconciliation.ts` continues to derive final Product history from exact
durable assistant/message and operation terminal anchors. Raw abandoned/attempt streams are not
converted into completed assistant messages.

The profile compiler adds `in-history` system-prompt updates only when the configured selection is
`deepseek-flash` on the verified official DeepSeek route, matching the fixed rc.2 catalog. Existing
v4 model selections and gateway routes do not inherit that capability. The compiler does not add or
select models, and preserves declared input modalities. Projector/compiler/reconciliation fixtures
pass 35 deterministic tests; the final staged process journey also passes.


The existing credential reverse handler also sends `getProviderRequestProxyPolicy(providerId)` as
bounded optional `providerNetwork` material. It selects the same app overlay/inherited baseline as
other Host Provider requests; it is not persisted in profile or Session snapshots. Runtime uses
its existing model-request scope to isolate concurrent proxy pools. General Runtime/MCP policy and
Shell environment remain captured at launch; a later Provider request resolves current settings.
The Host proxy-state matrix passes 24 unit cases. Packed HTTPS evidence starts real loopback TLS
and CONNECT fixtures, resolves current Provider policy twice, and verifies the two selected proxies
and actual target receipts. The general proxy receives neither model request. The temporary test CA
is restricted to this explicitly enabled smoke; production child environment policy is unchanged.


UPG15 adds the one-time offline `reset:dsh-dev` maintenance entry. `owned-paths.ts` shares exact
Product Session root derivation with Runtime birth. The planner verifies selected pre-5 DSH
bindings and path containment, rejects links/mounts and retained Task/Goal references, and keeps
shared/ambiguous attachments. It never turns external savedPath values into deletion targets.
SessionStore owns the final binding check and the existing file-lock → index-lock deletion order;
the callback removes only prevalidated DSH roots before transcript/index deletion. Default CLI
execution only prints a content-free plan; apply requires its unchanged digest and stopped app/
Sidecar/Runtime processes. Nine reset tests plus twenty existing mutation tests pass with real
SessionStore over synthetic homes. The actual offline reset removed 23 old DSH Sessions and retains
15 other Sessions. Their full metadata, configuration and 11 existing transcript digests match the
pre-reset values; repeat planning is empty and repeat apply leaves the index unchanged.
The first preservation check detected two legacy sibling bindings materialized by the shared read
normalizer. A digest-proven correction removed exactly those additions under the existing locks.
The reset now uses the same strict parser without read-time normalization or corruption recovery;
its regression preserves raw legacy sibling metadata, including Provider fields.

The pre-ingestion Host source regression passed 4,228 unit, 1,301 DOM and 541 integration tests, with eight
explicit skips, plus 146 build-script tests (five platform skips). The initial concurrent build
run hit the unrelated media-worker identity fixture's one-second startup deadline; the unchanged
fixture passes both independently and in the subsequent complete run. Attachment reference scans
are skipped when no candidate attachment roots exist. These are source gates before ingestion,
not acceptance of the historical staged Runtime for protocol 5.0.0.


### UPG15 post-freeze acceptance ledger

This section is the Runtime PRD §8 delegated post-freeze ledger. Runtime source remains clean at
`cf6821ddd55bd9ee5fe0216c0dbeb285c5808d4a`; writing acceptance receipts here does not relabel newer
Runtime source with older evidence. Earlier candidate receipts remain historical.

- Official DSH changes from `0.1.2-rc.1` / `a66e4702047846cdaa10c66c9d3df3951f5ea70d`
  to fixed `0.1.5-rc.2` / `fb2c4b9e698e30edb738bca4cf0618587db7d203`, tree
  `bd7dd6d90010a35d3d6ff9f12c1f6207d5b6fe38`; pi-ai is pinned to `0.85.1`.
- The patch series changes from 11 to 9 patches. Series digest is
  `13b108f38d68b914a7cb553192f3eb58d7630de1f75b6f293bd3bb82f2ae823e`.
  Two independent builds match all 81 files and the complete 77-package consumer closure;
  accepted DSH manifest is `9a81103ee911d4a9cdc5dcf60bd0de5621d20b8a309f30bb6bb692166be5f4a2`.
- Complete clean-source pre-artifact report is
  `031f1a9e985a1b2cf4a830ce115e037837bd55e372f6320d4680cd6bf64cca6c`:
  exact source/seams, real network/ownership processes, fault matrix, three soaks,
  typecheck/lint, 844 tests and build pass.
- Packed Runtime manifest is `e02bbf94b5d5ce707b48bdd4de2a4cc387603dc53ae0f1959327e09309ff9543`
  with 17,905 files; protocol is 5.0.0. The official final handoff is
  `6a903f59d439655c3777449dd717ab618a11419807c512e795314f18089aa8e6`, compatibility
  `a3b9c107042118752fba7e739408640195df8daf53bd847b03325267cc9a8104`.
  Official ingestion, complete contracts and source freshness verify these identities.
- macOS native report `fb0f6388a06c19b1060a77eb90c37ad42dd9c8d4dec5549652fba077406704dc`
  and dynamic manifest `18cb07b9ee6c867a2cc209238aac2101c6175e64fd5777561360c6893957cdbc`
  bind all eight fixed real-DeepSeek scenarios. Every final resource category, credential scope
  and attachment lease is zero. Windows/Linux evidence binds these bytes but remains
  `implementation-complete_pending-native-validation`.
- Final performance report `f88f1cd3f64eeaa9f3e650fac15e47ad976c99c456f69b52494957397a28ed02`
  passes all five original frozen ceilings with nine samples each. Long-history read median is
  566.30 ms versus baseline 2,402.50 ms; this is a synthetic same-machine workload, not a
  provider latency or desktop responsiveness guarantee. Scope excludes image decoding/upload
  and full ProductWork orchestration.

The fresh external Tester's [observations](../../../MyAgents-dsh-release-work/upg15-20260912/w07-tester-observations-4.md)
are accepted as fixed-CLI observations, not desktop or free-exploration acceptance. Operation success
is not tool success: protected/degraded paths correctly refuse calls; the plan case retries Read
before a successful Edit; the child case has a rejected task completion update and later successful
metadata/dependency updates, which do not prove that rejected completion succeeded. The real-model
web case did not successfully invoke Skill/WebFetch/WebSearch. Its passing preservation/cleanup
checks cannot serve as Web tool acceptance. Web/Skill execution is instead covered by the actual
packed deterministic catalog, controlled Host reverse-port and HTTP/HTTPS transport fixtures.

| Acceptance | Reviewed evidence and scope |
| --- | --- |
| U15-A01 | All 12 seam dispositions below; source/public-consumer checks, two identical patched builds, pi-ai conformance |
| U15-A02 | Native V3 creation/cold reopen; 29 reset/mutation tests; actual 23-Session reset with preservation hashes and repeat no-op |
| U15-A03 | SessionHandle and ownership unit tests plus real macOS process lock/close/crash/append campaign; unknown required event refusal |
| U15-A04 | Operation/ProductWork fault fixtures and packed cold continuation; durable receipts and uncertain-side-effect fencing retain their separate meanings |
| U15-A05 | Actual SQLite checkpoint/mutation and snapshot-reader tests; packed fork/rewind/delete and response-loss recovery; real campaign additionally proves prepare/abort |
| U15-A06 | Real LlmRuntime/AgentLoop wire capture, supported/omitted/invalid capability and literal/scoped prompt tests; only configured supported routes opt in |
| U15-A07 | Adapter SSE, native projector and Host projector/reconciliation/DOM tests; actual packed stream end before terminal, including closing |
| U15-A08 | TokenMeter/compaction tests and packed context/usage checks; real native campaign records six successful automatic summary compactions |
| U15-A09 | Real ProductWork/subagent composition and packed role/depth/tree/continuation tests; native case observes two child work epochs |
| U15-A10 | Permission/Hooks tests plus both ordinary and 70 KB Host review journeys, same-target child grant and different-target approval |
| U15-A11 | Complete packed catalog, next-request image bytes, file/checkpoint and official Shell/Jobs tests; other native platforms remain pending |
| U15-A12 | Four Runtime launch-policy matrices, concurrent Provider/general requests, NO_PROXY/loopback, cancellation/disposal, safe HTTP/MCP, actual Host Shell and HTTPS CONNECT receipts |
| U15-A13 | Final exact-source performance report with unchanged frozen configuration and no failed ceilings |
| U15-A14 | Final staged Runtime handshake, configured cold recovery and 12-generation soak (descriptors 14→14, RSS growth 0); packaged App receipt below |
| U15-A15 | Exact source/artifact/native/handoff/Host chain; full gate receipts; dependency review and explicit distribution limitations below |

These rows supersede the frozen Runtime coverage file's planning statuses for this exact source and
handoff only. They do not increase the measured scope of a fixture or promote unexecuted native routes.

| Seam | Final local-development disposition | Reason and continuing removal condition |
| --- | --- | --- |
| 001 | rebase | Public Inbox cannot wake the same durable pending identity without reordering; retain until equivalent public wake semantics exist |
| 002 | reduce | Retire upstream-adopted dependency edits; retain authoritative pre-commit tool-input waterfall until history, approval and execution can share governed input publicly |
| 003 | retire | Public SessionPersistence/SessionHandle Provider admits known Product events and rejects unknown required events; actual V3 cold restoration proves the replacement |
| 004 | keep public composition | Product SQLite/SessionHandle and mutation companion share the same writer lock; no core patch is needed |
| 005 | rebase | Keep synchronous pre-publication guards until stock public registration can reject before Session/Agent visibility |
| 006 | rebase | Keep Product-owned continuable settlement, strict final durability and cold ancestor residency until equivalent public lifecycle ownership exists |
| 007 | retire | Official DeepSeek adapter now preserves established call identity across empty deltas; source and Provider conformance tests prove the replacement |
| 008 | rebase | Keep exact request estimation/capacity fitting/structured repair until equivalent public compaction semantics exist |
| 009 | rebase | Keep literal contributions and durable child persona mode; no legacy descriptor 3/4 compatibility is retained |
| 010 | rebase | Keep first instruction-candidate selection and canonical file-touch configuration until stock public selection matches |
| 011 | rebase | Keep non-executable Provider content and matching-route raw replay until official pi-ai bridge preserves both |
| 012 | rebase | Keep official file-tool factories, stored-edit preparation and publication hook until stock public exports provide them |

Each retained patch remains an upstream contribution/removal follow-up; no PR was sent upstream.
The frozen registry/ADRs retain the pre-campaign candidate status and exact rationale. This delegated
ledger records the later Product-level adjudication without changing the artifact's source identity.

The [dependency audit](../../../MyAgents-dsh-release-work/upg15-20260912/w07-dependency-license-audit-4.json)
records 318 actual installed package roots, 98 changed/added entries and the seven newly installed
names, excluding nested documentation manifests. All declared third-party license families are
already in the baseline obligation table; newly adopted fast-sha256 retains its Unlicense text.
The existing official notices builder still exports the source baseline rather than the complete
installed Runtime notice set. Some upstream packages lack package-local license text. This known
notice-completeness gap is recorded explicitly; this development acceptance is not a self-contained
redistribution compliance claim. Windows/Linux native validation, desktop user experience acceptance
and distribution signing/notarization are likewise separate from the completed local implementation.

The Host identity-rejection fixture now uses the batch client's ordinary deadline: its one-second
startup override intermittently masked the expected wrong-identity error during concurrent build-script
tests. The exact rejection assertion remains; dedicated timeout and process-termination tests remain.
No production timeout changed. The new OpenSSL smoke has a file-specific classification exception
because it only creates a temporary CA and uses loopback endpoints under explicit native opt-in.


| Workstream | Local implementation and adjudication status |
| --- | --- |
| U15-W01–W03 | complete; frozen baseline, 12 seam reviews, reproducible DSH packages and V3 Provider ownership |
| U15-W04–W05 | complete on macOS; native stream/context/capability, compaction, collaboration, permission/file/Shell/network proofs |
| U15-W06 | complete; official protocol 5 ingestion, staged Host journeys and actual development reset |
| U15-W07 | local macOS gates and immutable handoff accepted; Windows/Linux and distribution limitations remain explicitly pending |
| U15-W08 | implementation review and local stage adjudication complete; main merge is not performed |

The [post-freeze coverage adjudication](../../../MyAgents-dsh-release-work/upg15-20260912/w07-coverage-adjudication-4.json)
and [development reset receipt](../../../MyAgents-dsh-release-work/upg15-20260912/w07-development-reset-receipt.json)
record exact evidence hashes. Final Host source, App bytes, all gate log hashes and source cleanliness
are bound by the [local development receipt](../../../MyAgents-dsh-release-work/upg15-20260912/w07-local-development-receipt.json).
This receipt is the integration transfer record for the outer handoff digest; do not substitute a
self-computed digest from an untrusted copy.


Final Host source gates pass after the reset preservation correction: typecheck, lint,
147 build-script tests (five platform skips), 4,228 unit tests (three opt-in skips),
1,301 DOM tests and 542 integration tests (six opt-in native skips). All six native tests were
also explicitly executed successfully against the new staged Runtime, including HTTPS policy
changes and 12 process generations. The default suite remains credential-free. Lint retains
13 pre-existing dependency-cruiser warnings and zero errors. The final App build and its separate
resource/signature/native checks are identified by the external receipt above.


### Plan Shell development delivery (2026-09-12)

U15-D08/W09 retains the selected Bash/PowerShell tool in Plan under prompt-guided read-only research and the existing Shell permission owner. Write/Edit remain limited to the managed plan file, and submission still requires approval. This follow-up supersedes the preceding Runtime identity for the new development package; the earlier UPG15 receipts remain historical.

Runtime source `7261f7bbd29c1a2883bfe0b21178ce8bae1545f1` passes the complete clean-source pre-artifact gate (`1bcdc0c55149304de29b54917c04304baa116de3d58affee9a850b49d2bc1074`), including typecheck/lint/build, 848 tests, source/seam validation, native network/ownership tests, fault cases and three soaks. The new packed Runtime is `50ab714fa197c87e67b2ac50a2d064cc2b893e68793ad1742764403b3603a243` with 17,905 files. Official handoff `2b5d71758a719e9caea13efff181877ccb2ad630668d0e47d9d3f71b01e0c969` supplies protocol 5.0.0 with schema `69a37de60ad8d05dc62649f1c3b177cbdfe8792fc73760d5849f000c1ec0acbe` and the regenerated tool/profile contracts. The pinned DSH package bytes are unchanged.

Official ingestion, complete resource verification and clean Runtime source freshness pass. Host typecheck/lint and 178 DSH tests pass; the six normally skipped native cases also pass explicitly against staged resources, including the new Plan Shell result/prompt assertions and 12 process generations. The handoff-policy suite passes.

This is a local development handoff for user end-to-end testing. Its platform claims bind the new Runtime and implementation gate; the complete credentialed native model campaign has not been rerun, so all three claims remain `implementation-complete_pending-native-validation`. The local deterministic process tests do not substitute for that campaign.

The requested Debug App is rebuilt at the existing `src-tauri/target/debug/bundle/macos/MyAgents.app` path after stopping the old App processes. Exact Host source, signing/resource verification and tests from the App's own resources are recorded after this Host source freeze in the [development receipt](../../../MyAgents-dsh-release-work/plan-shell-20260912/plan-shell-development-receipt.json). No source or historical artifact is relabeled by that receipt.

### UPG15 optional telemetry recovery follow-up (2026-09-12)

The user-reported `DSH terminal usage must be an object` occurs during startup reconciliation, before model admission. Protocol 5 already permits successful terminals without usage when Provider metering is incomplete; Host recovery still required it. This is a Host interpretation bug, not a historical Session migration requirement. Recovery now accepts the existing durable completion without resetting user data. The same audit removes metering-only failures from live terminal/child projection, child history, context display, tool metadata and Host WebSearch/WebFetch utility responses. Runtime canonical WebFetch/WebSearch contracts also make usage optional, and Web/Agent output normalization omits unusable metering so the next layer does not reject the recovered result. Identity, permission and durable outcome checks remain authoritative.

Regression coverage includes successful replies without usage, unusable optional metrics, usage-only lookup differences, missing totals in either order, counter overflow, repeated startup without duplicate messages, child completion and all three Host utility API adapters. Packed native tool journeys now read the real Runtime history and recover its successful usage-less terminal through the same Host projection. Source/build acceptance and the replacement App receipt are tracked in [the follow-up evidence directory](../../../MyAgents-dsh-release-work/terminal-usage-20260912/).

Runtime source `5cccbe09e95833089660a03b2eacde6d7020310a` passes its clean-source pre-artifact campaign (`e8bd93f4d705785f9e4d2dbb9f3fc16a5dea88bb7559ea240a55783c49e2e5c0`), including typecheck/lint/build, 851 tests, native network/Session ownership, fault cases and three soaks. New packed Runtime `2559c3f0c4edaaea00bfd3cbff820128b1687fe6295319cbbbaa3abf37431563` verifies all 17,905 files and actual usage-less Web execution. Official handoff `b4e676db05b8f76813cd1682e745e8d5006df9bc60fa9b9a1fdd06e199636604` is ingested with protocol 5.0.0/schema `3e32206dce9054978ec19119d00927b04ba7f980c2133e5264c39757668dc074` and profile `26bbb4136f7be3f829ae5fae4032700e2a64e5c2b099762317a3edc4b1c6633d`. The upstream DSH version and patched package bytes are unchanged. All three platform claims remain `implementation-complete_pending-native-validation`, bound to this new Runtime and implementation evidence.

Final Host typecheck/lint, related deterministic/native tests and the replacement Debug App are verified against this handoff. Exact Host source, counts, App resource/signature checks and build evidence are recorded after this source freeze in the [follow-up receipt](../../../MyAgents-dsh-release-work/terminal-usage-20260912/development-receipt.json). The App continues to use the original local bundle path; existing Session data is preserved.

### R5 foreground Shell output delivery (2026-09-12)

U15-D10/W11 fixes the Product spill-read registration after the official Shell command has already completed. The old staged Runtime reproduces the reported failure at 64,001 bytes while 64,000 bytes succeeds. System temporary directory aliases such as `/var` and `/private/var` refer to the same file; they are unrelated to child Agent output under Runtime home. Runtime now resolves the parent directory and registers the canonical file for the producing Agent's governed Read. Existing no-follow, single-link, file-version and cancellation checks remain effective.

Optional capture failure removes only the unavailable spill path from the official successful value. The upstream renderer retains bounded text, truncation and exit/signal/timeout facts, and the Host continues to derive the terminal card from generated metadata. A content-free `[dsh:shell-output]` stderr warning uses the existing Runtime redactor and product log event route. Host does not add a Shell executor, alter tool permission or retry completed commands.

The expanded exact-Runtime native journey executes 64,000 / 64,001 / 81,000 / 1,053,000-byte foreground commands with stderr and nonzero exits, checks full file contents and canonical paths, then performs model-visible Read of a spill outside the workspace. The same journey retains shared child permission, Plan Shell, plan submission and usage-less history recovery. Unit fault cases cover missing files, final symlinks, hardlinks and cancellation during capture. Final clean-source Runtime/handoff, Host tests, same-path Debug App and resource verification are recorded in the [development receipt](../../../MyAgents-dsh-release-work/shell-output-r5-20260912/development-receipt.json); existing user Sessions are preserved.

Accepted Runtime source `0a37da4191005ed6bc81bc18d37ef9c060996927` passes clean-source pre-artifact report `4f19e842042a516fd11efde7aeb406b98f7a97e9b8034ab5838c90cba9209b36`, including 857 tests, typecheck/lint/build, native network/Session ownership, fault cases and three soaks. Packed Runtime `57511a51b09c808eae1242fd222ded74b9b88cf97d48c3f89a568ad64fe6ff69` verifies 17,905 files, the real foreground stdout/stderr output and all 27 governed permission decisions. Official handoff `731e64636d12a3f7619a3bb5281b736fbd0a25a7a3bfde2ae09aa6f2f5e09942` is ingested with compatibility `548b36d63b7509a9f802c98e84d8fcc87ce26af451fa5cfd3b9326a5a868510f`. Protocol/schema, tool/profile and upstream DSH package bytes are unchanged. All three platform claims use fresh implementation evidence and remain `implementation-complete_pending-native-validation`.

The Host's 30 selected unit/integration files pass all 239 tests against this staged Runtime, including six native cases and the 12-generation lifecycle soak; typecheck/lint and development freshness pass. The replacement Debug App, its own resource-native test results, signature and exact Host source are signed off after this Host source freeze in the linked receipt. No main merge, public release or development Session reset is part of this delivery.

### Agent tree presentation follow-up (2026-09-12)

The user-requested settings entry now lives only in About's existing hidden developer section. The tree removes the aggregate/description/configuration blocks and emphasizes task titles, compact states and available actions. Technical identity, usage/context and result previews are collapsed by default. Closed nodes present the resume action without an unusable follow-up control. Seven affected DOM tests, TypeScript and targeted ESLint pass; the source diff has no whitespace errors. Local desktop packaging and visual evidence are recorded separately in `../MyAgents-dsh-release-work/agent-tree-ui-20260912/`; this Host presentation change consumes the existing verified R5 Runtime handoff.

### Agent tree entry withheld (2026-09-12)

At the user’s request, Chat no longer exposes or mounts the Agent tree. The composer button, callback prop and Chat open state/import are removed. The dialog implementation and native controls remain available for future product activation, with collaboration configuration still in About’s hidden developer section. TypeScript, targeted ESLint and all 44 existing composer interaction tests pass; replacement App evidence is recorded in `../MyAgents-dsh-release-work/agent-tree-hidden-20260912/` after the source freeze.

### R7 interaction and result delivery follow-up (2026-09-12)

The AskUserQuestion envelope now keeps selected labels and custom text separate from the desktop form through the DSH question port. Existing string callers are interpreted using the actual options; other Runtime adapters retain their legacy text projection at that boundary. Invalid input does not consume the native interaction, cancellation acknowledges its completed effect, and the form preserves answers and shows a retryable error when the Host cannot confirm settlement. Companion awaits the same response promise. No new question/option count restriction is introduced.

The related Runtime work is [U15-D11/W12](../../../MyAgents-dsh/specs/prd/prd_0.3_myagents_dsh_0_1_5_upgrade.md#8-实施工作包与内部台账): stream broad search results, project final child answers separately from narration, preserve conclusions in bounded output, and render structured cancellation reasons readably. CLI leaf help now covers status/version/reload and -h; failed help exits nonzero, and a duplicate Session title/preview is printed once. Widget instructions require visible assistant text; reasoning is never promoted into the body. Plan/Explore retain the user-selected governed Shell behavior. The Agent tree remains hidden.

Accepted Runtime source `b5117ed7da513199ccfb34c62a07826c7b08dfc7` passes clean-source pre-artifact report `14aac095a1c0fbc0d657e00c3ce49f9338372af762e09b2782c76f9110462ce4`, including 863 tests, typecheck/lint/build, native network/Session ownership, fault cases and three soaks. Packed Runtime `55ac058296091312bc8dcac8b01400ff1d680e753bc5d788192d0903b397b2ed` verifies 17,905 files and the expanded broad-search composition journey. Official handoff `d277191cfaea10ceaac19b4977b5130ba611dbfe4d98c668684a1ff2218d583f` is ingested with compatibility `d498e1bd91879a3ed331b2700b3827a230c1c4bb77b7b006367d516e1f596ac0`. Protocol/schema, tool/profile and upstream DSH package bytes are unchanged. Fresh evidence binds all three platform claims to this source; they remain `implementation-complete_pending-native-validation`.

Host full tests pass 6,106 Vitest cases (plus build-script/classification checks), with typecheck/lint and staged resource/freshness verification. Six packed native cases pass, including the 12-generation lifecycle soak and an invalid question response followed by a corrected three-question/four-option answer with multi-select and comma-containing custom text. The same-path Debug App, its own resource-native checks, signature and exact final Host source are recorded after this source freeze in the [development receipt](../../../MyAgents-dsh-release-work/r7-reliability-20260912/development-receipt.json). Existing user Sessions are preserved; live Provider/UI acceptance remains a separate user regression.

### MyAgents 0.4.18 integration (2026-09-17)

The integration branch follows MyAgents 0.4.18 from `b33dfc9bef4591f5bbe196b9d8d1db47bf382c89`, merged over Host `75f35ab4b3de643c445e7a9850909cffce2c85de`. The user explicitly selected the 0.4.18 V2 product transcript architecture. New DSH Sessions and fork targets use the ordinary canonical projection and background writer; existing legacy Sessions keep their format. Native Runtime execution remains the authority for terminal outcomes, usage and transactional mutations. The detailed ownership and crash-recovery contract is in [Product Session history V2](session_transcript_v2.md#dsh-原生执行与产品历史).

The Host records exact admitted inputs independently of body IO and retires them only after the matching content commit. A physically blocked body writer cannot block subsequent root/input admission or receipt settlement. Cold recovery preserves displayed segments and block identities, completes late tool results, and reconstructs only explicitly journaled unpublished births; missing or damaged published history is never overwritten. Fork, rewind generation recovery and writer retirement on deletion reuse SessionStore's existing owners. Pending execution prevents metadata entrypoints from rebinding the native Session.

Main's managed CLIProxy, asynchronous questions, dynamic reasoning effort, DeepSeek Flash preset and transcript UI are retained alongside DSH controls. Antigravity remains a builtin-SDK-only provider in both Node and Rust policy. The Agent tree stays hidden. The R7 Runtime handoff above is unchanged: source `b5117ed7da513199ccfb34c62a07826c7b08dfc7`, DSH `0.1.5-rc.2.myagents.fb2c4b9e698e.13b108f38d68`, protocol 5, bundled Node 24.20.0/npm 11.19.0.

Validation: the complete default test campaign passed 7,058 code tests and 214 build-script tests, with the expected opt-in cases skipped. Four subsequent recovery/authority/blocked-IO regressions also pass; the affected 157-test transcript/mutation/reset selection and final DSH V2 selection pass. TypeScript, lint/dependency boundaries, web/server/bridge/CLI bundles, staged Runtime resources and source freshness pass. The packed Runtime passes five native smoke cases and the 12-generation lifecycle soak (all processes released; file descriptors 14 to 14). Rust transcript parity and runtime-identity selections pass 20 tests; the existing benchmark stays opt-in. On this macOS host the Rust test executable requires Xcode's Swift library directory in `DYLD_LIBRARY_PATH`; no product code workaround was added. These checks use synthetic storage and local test servers. Signed desktop packaging, live Provider/UI acceptance and other-platform native validation are not claimed by this merge. No user Session reset or Runtime repository change is included.


### DSH 0.1.5-rc.3 maintenance refresh (2026-09-23)

The integration now consumes official DSH `0.1.5-rc.3` at `a4c74a91e06b00fe0b0937bde982170c526cc842` (tree `bf4fd1ddccc211107ffb8b7074c83afac2bd7ea1`). Upstream changes only vendor dependency publication constraints; public runtime behavior, Session format and all nine patch bytes are unchanged. The complete [source/seam review](../../../MyAgents-dsh/specs/dsh/upstream-refresh-2026-09-23.md) records all twelve dispositions. Existing user Sessions are preserved; the historical rc.2 development reset is not rerun or retargeted.

Accepted Runtime source is `54ddd97c6f7c89c73733e6950b2e47edf12457ff`. Two independent 77-package builds are byte-identical across 81 delivery files; patched package manifest is `1b8993435731e12bab50095d8692a3aacad6dfaf71fadcca9133fa4b4051b165`. Runtime manifest `b2cabc54dd6e46dfb2e6804079a65c3f9fa9c0fbb26f8a333f47256c1bb1a96a` verifies 17,908 files. The official builder produced handoff `5eb3443c8143af8bef8f7671281247cad0abd75aefe6a54c51c03a70a22a2ec1` with compatibility `c711088abb0877f3497807622af4c8eaa9de94950d4724a6306fbb0703b1f42f`, and the Host ingested its complete generated contract inventory and resources. Protocol remains 5.0.0 with 44 Host / 7 reverse / 4 notification operations; its new schema digest `e9f32098b73b657976c1c91170662bda41bf09097c8aad9174175cd48c7c1fa4` reflects the exact DSH engine version literal. Profile digest is `93013b9c9642d38a3641c428641d855e272a73cc77917bf1bb7d22052ca72d41`.

Clean-source pre-artifact report `36d082d9a55d457736677c660cc98d5ba10b760e1c90e8a7848f1bf2ac6b75ba` passes Runtime typecheck/lint/build, 863 tests, 530 fault cases, three 211-test soaks, native network and Session ownership. Patched upstream source passes 1,070 tests (one skipped), and the unchanged pi-ai seam passes 46. Packed composition covers persistence, fork/rewind/delete, compaction, tool/permission/interaction, child-work lifecycle and transport faults. Fresh platform evidence binds all three targets to this source; claims remain `implementation-complete_pending-native-validation` because the full credentialed platform campaign was not run.

Host resource/freshness checks and the Rust bundled-resource detection test pass. The default test groups cover 4,690 unit, 1,695 DOM and 677 integration cases, plus 214 build-script checks. This was not a clean single-pass `npm test`: short build-script deadlines under simultaneous compilation passed on an unloaded rerun; the PermissionPrompt copied-state and transcript metadata-publication tests passed in isolated 11-test and 19-test reruns respectively. A Node 24.20 integration worker closed its IPC channel; the Host's supported Node 24.14 run completed, with the transcript retry noted above. These observations remain test-stability follow-ups, not evidence of new DSH behavior. The six staged native cases pass, including exact handshake, Provider policy, permissions, cold resume and a 12-generation soak (all Runtime PIDs released, descriptors 14 to 14).

Final Host typecheck/lint, same-path local Debug App build, signature and App-resource-native checks are recorded after the Host source freeze in the [development receipt](../../../MyAgents-dsh-release-work/rc3-upgrade-20260923/development-receipt.json). This maintenance refresh does not complete Batch 3/H6, signed release, real-Provider/GUI acceptance, or Windows/Linux native acceptance.


### MyAgents 0.4.21 integration (2026-09-23)

The integration branch merges MyAgents main `61334079` (0.4.21) over the DSH rc.3 Host `06ffb7ff`. The official DSH rc.3 handoff, bundled Runtime identity and existing user Session format remain unchanged. Main's Claude Agent SDK 0.3.276, managed Codex 0.155.1, external CLI authorization, Session history repairs, Task activity projection and interaction receipts are retained alongside DSH's native admission and mutation journals.

Conversation retry now uses the SessionEngine rewind-and-replay owner. DSH checks the native admission record before deciding between a product-only retry of an unadmitted input and a journaled native rewind. Fork attempts carry a stable target Session ID, so a lost response can recover the same committed fork. Cold V2 activation retries transient read errors; an explicitly journaled DSH birth can still recover a missing file, while an ordinary missing published history stays invalid. DSH fork and rewind preparation wait for the real writer result rather than a fixed save deadline.

Chat waits for reset acknowledgment before replacing its visible Session, reloads Task history through the restore owner, and retains published Sessions if opening a new tab fails. Task scheduling no longer sets conversation loading before execution begins. External CLI tests cover both authorized public commands and the existing internal Session scope. The upgrade does not reset user Sessions or change the DSH Runtime repository.

Validation: TypeScript, lint/dependency boundaries, source classification, staged DSH resources, web/server/bridge/CLI bundles and 214 build-script tests pass. The complete default Vitest groups pass 4,799 unit, 1,781 DOM and 717 integration tests, with their expected opt-in cases skipped. The Rust App library passes 1,458 tests (seven ignored). On this macOS host the Rust test executable was run directly with Xcode's Swift library directory in `DYLD_LIBRARY_PATH`; `cargo test` compiled successfully but the cargo-launched executable did not inherit the needed dynamic library path. Earlier integration runs made alongside other builds hit timing-sensitive timer and writer assertions; both passed in isolation, and the final unloaded integration run passed. No live Provider or packaged desktop acceptance is claimed here.

### DSH 0.1.7-rc.2 development upgrade (2026-09-25)

The integration branch retains the MyAgents 0.4.21 product baseline and accepts official DSH `dsh-v0.1.7-rc.2` at `477b4f420553e8a52c2fbccc464d7561b239c443` (tree `e3e63253d1d35ad07f785273235c40813cb6c8bd`). The Runtime source is `fe8fcef54ed2431aec160db10cc7ca7c32adcef1`. Ten ordered DSH patches produce version `0.1.7-rc.2.myagents.477b4f420553.8d5f1cfa482e`; two independent 89-package builds have identical bytes and manifest `45030ac4e032def4c2988e745538a93428d7f7e2f9b46a0274571df5a79f8524`. The source gate passes 1,105 upstream tests and the Runtime suite passes 864 tests. The installed 18,669-file Runtime artifact is `6effeb0ce79d2c2934f16cdc448d0440fe1002edbf1776ef198231541a173f59`; handoff `aa03e4b8c0e396a7d0ae186fcee5746a70f84e5fdd0fb26f72dada5180076131` is ingested and verified from the bundled Node/npm resources.

The native contract is protocol 6.0.0 with 44 Host methods, 7 reverse methods and 4 notifications. New Sessions use `dsh-session-events-v2` over DSH V4. The Host routes `deepseek-official` through the Messages API, reads the new tool-role result format, and projects a pruned tool result only once. Its development reset now selects old DSH protocol generations 2–5 while preserving generation 6. Product ownership, permission and mutation boundaries remain on the existing Host and Runtime paths. The accepted profile digest is `097917ba2cd55e0713963889521e5d35e38847875a390e4b9ce0e30b3033cc97`.

Host typecheck, lint, web/server/bridge/CLI asset builds, 237 focused DSH and reconciliation tests, 38 handoff-policy tests, staged resource/freshness verification and five explicit native process tests pass; one native case is platform skipped. The native cases cover exact handoff, local HTTPS Provider routing, tools and approvals, pruned results, cold resume and shutdown. The separate 12-generation lifecycle soak also passes, releasing every Runtime process and returning file descriptors from 14 to 14. The three platform claims remain `implementation-complete_pending-native-validation`; credentialed real-Provider, Windows/Linux native, signed App and packaged GUI acceptance remain pending. Runtime's full default lint currently reports inherited `snapshotEvents()` deprecation diagnostics from the official rc.2 types; focused changed-file lint passes apart from that rule, and no rule suppression was added.

The one-time reset identified four old DSH development Sessions but did not apply: `/Applications/MyAgents.app` and its Sidecar were running, so the reset's stopped-process guard rejected it. The old data remains isolated from the new protocol; after the App exits, rerun the reset plan and apply its fresh digest through `npm run reset:dsh-dev -- --apply <digest>`. The reset must never use the stale digest from this ledger or delete unrelated user state.

### Official DSH capability increment (2026-09-25)

The integration branch now accepts Runtime source `f62d861b6eeb63ef18e6d5925b17e468388524d9`. The patched rc.2 build contains 100 packages, manifest `21ed548a7f657f7b8fcb3cecda8c590c2988dbe47ab413f41a55e88299b23784`. Runtime manifest `25945565b3fd99ef69bcb848e3d561f040b866e5acbadeb10b2b8bd48a883f02` and handoff `5474d33e4c0cec9b3dbee9c9ce2cd147195f2689ec18f70cefa35149d6079c06` bind the new source and platform evidence; protocol and Session format remain 6.0.0 and `dsh-session-events-v2`.

The official `session-checkpoint-policy`, `time-context`, `repeat-tool-reminder`, `session-stats` and `session-turn-outline` plugins are mounted in the accepted product profile. Six sandbox/spill packages are present in the patched build for dependency completeness but are not enabled. The Host still owns Session lifecycle, execution environment, checkpoint storage and permission decisions; package presence alone does not imply an active capability.

The DSH Shell uses the App's internal `myagents` CLI. The App creates the internal capability for its lifecycle and supplies it to the Session Sidecar and DSH generation automatically. The DSH process policy admits only the exact `MYAGENTS_INTERNAL_CLI_TOKEN` key alongside route identifiers; arbitrary credential variables and the external `MYAGENTS_API_TOKEN` remain rejected. This preserves the internal full-capability CLI path without user token setup. The native tool test reads child runtime context from both string and block message content, as produced by the newly mounted time-context plugin.

The exact staged handoff passes resource and source-freshness verification, 38 handoff policy tests, Host typecheck, changed-file lint, focused environment/process-host unit tests and five native process smoke cases. The native Shell test invokes the real bundled `myagents` CLI and observes its internal capability and Product Session ID at a synthetic Sidecar, without any external token. `build_dev.sh --build-only` produces a signed macOS Debug `MyAgents.app`; its bundled Node re-verifies all 18,783 Runtime files, the App signature verifies, and the five native process cases pass again against resources inside the App. A separate 12-generation packaged Runtime soak releases every process and returns open descriptors from 14 to 14. This is local development evidence; Linux/Windows native validation, real Provider and interactive GUI acceptance remain pending.

### Issue #610 follow-up (2026-09-25)

The new Dev Agent verified the earlier internal CLI fix and reported independent Runtime/Host defects.
The Host's DeepSeek WebSearch binding now follows the same Anthropic Messages profile and base URL
used by DSH execution. The Admin dispatcher forwards the already implemented `task start`, `stop`
and `runs` handlers. `runtime list/describe dsh` reports the pinned DSH release instead of the
internal Runtime manifest's `0.0.0`; Gemini model-discovery failure leaves installation and
permission description available. Rust task-comment errors use the existing structured error
envelope, and inline Record tags preserve internal hyphens. CLI status labels the global default
Provider and the observed current-Session MCP state by scope.

The paired DSH source corrects same-batch new-file Write checkpoint serialization, `ls` handling
of outside-root symbolic links, file/search diagnostics and background child tool/model feedback.
The user excluded Plan Mode Shell policy from this follow-up. The official filesystem tool's `0600`
new-file mode is retained as its privacy policy; shell files still follow the caller's umask.
The image decoder's common malformed-image response remains owned by the pinned upstream package;
this change does not claim to distinguish corrupt image data from an otherwise policy-rejected
image. DSH source `4e4617041231cd54e12d4eb160646b7e8cf8356b` produces Runtime manifest
`2ce91016ddc5a0a195884adea1a8c47b70f917028706c463f400da853e2f458b` and official
handoff `2630d08d920b4188ce0a8c09e56e65dac227988cbc32492d86dd9c8c1320c965`.
Host ingestion verifies those exact bytes, generated contracts and freshness against the clean
DSH source. Three platform claims remain pending native validation in the handoff; the Host's
local native process smoke passes separately. `build_dev.sh --build-only` produces a signed macOS
Debug App. The App signature, bundled Node/runtime verifier and five native process smoke cases
pass against the packaged resources. DSH's source gate passes 870 tests, typecheck and build;
its full lint still reports inherited `snapshotEvents()` deprecation diagnostics. Host focused
tests pass 188 cases, handoff policy 38 cases, plus typecheck/lint/build. Interactive Agent
acceptance and real DeepSeek search remain unverified in this local build.
