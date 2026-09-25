---
type: prd
status: approved-for-implementation
created: 2026-09-26
updated: 2026-09-26
scope: MyAgents-dsh immutable Release delivery and MyAgents build-time DSH source selection
---

# PRD: MyAgents-dsh Release delivery and MyAgents build sources

## 1. Problem and outcome

MyAgents and MyAgents-dsh are separate repositories. Today a developer builds a DSH Batch 3 handoff outside either repository, edits MyAgents' DSH lock and compatibility mirror, runs `ingest:dsh-runtime`, and then builds the App. MyAgents build entry points verify an already staged runtime but do not obtain it. This makes a clean release checkout unable to build the pinned DSH distribution without a prior manual transfer. It also makes same-machine DSH/Host iteration unnecessarily alter the committed release lock.

The outcome is one build-time preparation path with two explicit sources. Release App builds obtain the exact pinned immutable MyAgents-dsh GitHub Release asset. Dev builds default to that same pinned release and may explicitly select one local, already built handoff. Both paths produce one effective identity shared by TypeScript, Rust, resource verification and the packaged App. App startup never chooses or downloads a DSH version.

This PRD covers production of the releasable handoff archive in MyAgents-dsh and consumption in MyAgents. It does not publish a Release or promote an unverified platform claim by itself.

## 2. Ownership and identities

| Fact | Owner |
| --- | --- |
| DSH source, official Runtime bytes, compatibility contracts, platform evidence and handoff digest | MyAgents-dsh official artifact builders |
| Release tag, fixed asset name, archive SHA-256 and published provenance | MyAgents-dsh release workflow |
| MyAgents release choice, source commit and per-target archive/handoff digest | committed MyAgents `dsh-lock.json` |
| Selected source and effective identity of one Dev build | MyAgents build preparation, derived from the selected verified handoff |
| Running Session's frozen Runtime binding | existing MyAgents Session owner |

The GitHub URL is derived from repository, tag and fixed asset name. The version/tag is chosen before DSH release construction; archive and handoff digests are known only after construction. MyAgents updates its committed lock after a release exists. An optional latest index may propose an upgrade but never selects bytes during a build.

## 3. Source selection contract

| Entry | Default | Allowed override | Required result |
| --- | --- | --- | --- |
| macOS/Windows/Linux Release build, direct production Tauri build | pinned GitHub Release | none | exact committed DSH lock |
| macOS/Windows/Linux packaged Dev build | pinned GitHub Release | `local` with absolute handoff directory | exact verified selected handoff |

Dev entry points expose `--dsh-source release|local`; `release` is the default. `local` requires `--dsh-handoff /absolute/path` and never discovers a sibling checkout or floating latest. The local input is the official handoff directory, not raw DSH source or a selected Runtime subtree. A changed DSH checkout must first create a new handoff through its official builders; this build selection does not mutate the DSH repository or silently rebuild it.

The normal release source uses the committed lock's tag, source commit and target-specific asset name, archive SHA-256, size and handoff SHA-256. A cache hit is accepted only after exact archive and extracted-handoff verification. A missing/corrupt cache is reacquired from that fixed URL. Download failure cannot fall back to a stale staged directory or the sibling source checkout. The existing shared build download policy owns timeout, retry, proxy and staging mechanics. The four targets are macOS arm64, macOS x64 (Intel), Windows x64 and Linux x64. Each needs its own native Runtime artifact and therefore its own handoff/Runtime digest; macOS arm64 bytes cannot be used in an Intel App.

The local source verifies its outer handoff with its computed exact digest, confirms the nested Runtime/compatibility/Node/protocol facts and rejects unsupported Host contract changes. It then derives an **ephemeral Dev build identity** from the handoff, including the lock and compatibility manifest used by every Host language layer. This identity is staged with the App and not written over the committed release lock. The local path itself is never stored in the App. The build report names its source, DSH commit, outer digest and Runtime digest.

All sources use the existing handoff verifier, compatibility checks and atomic resource staging. Selection changes only where verified bytes come from. A local handoff that changes the generated protocol/client or Host-owned contract beyond current Host support requires a normal integration code update; source selection cannot paper over it.

## 4. Release producer

MyAgents-dsh keeps PR and main CI as validation. For a version tag `vX.Y.Z`, the accepted release path uses the pinned artifact toolchain, official patched DSH artifact, Runtime artifact and Batch 3 handoff, and the relevant gates. Native/platform claims are attached only for the exact resulting bytes and target; a platform still pending native acceptance is not publishable. Build failure publishes no release. The current source has no GitHub Release and its native claims are pending, so a tag-triggered build/publisher cannot be activated yet without bypassing the existing assurance gates.

The official packager creates one target-specific archive per supported target with a fixed versioned asset name, calculates its SHA-256, verifies an extracted copy against the outer handoff digest, and writes a small target manifest. Accepted assets are uploaded to a GitHub Release only after release review. A future CI workflow can run the same packager when the full exact-source and native campaign gates are automated. An Actions workflow artifact is only an intermediate transfer, not MyAgents' long-term download address. The manifest lists tag, source commit, asset name, archive digest, handoff digest, Runtime digest, contract digest and platform claim. No `latest` pointer is required for MyAgents builds.

Current DSH release-assurance gaps and missing native campaigns remain release gates; this PRD does not relabel pending evidence as verified. The publishing workflow is not considered active until its exact source inputs and full required gates run successfully on GitHub.

## 5. Build preparation and packaging

One MyAgents `prepare:dsh-runtime` helper owns source resolution, cache, verification, effective identity and staging. Platform shell/PowerShell wrappers only pass source/target and call this helper. Setup and direct build routes use the same helper rather than relying on a previous entry point. Release mode always uses the committed lock. Dev mode chooses the source explicitly.

The effective lock must be the same for Renderer/Sidecar TypeScript, Rust compile-time detection, the resource verifier and the bundle. For Release, it is derived from the selected handoff after matching that target's committed handoff digest and shared source commit; the top-level handoff identity in the source lock records the last ingested development artifact and is not incorrectly applied to other target assets. The generated compatibility manifest is target-specific because it binds the Runtime digest, while unchanged Host contracts are still compared with the accepted projection. The implementation must avoid a second product/runtime state owner: it is a build output derived from the selected artifact, not a user setting or persisted Session choice. A failed prepare preserves the previous verified cache; it cannot leave a partial handoff staged as ready. Build start reports `RELEASE` or `LOCAL` and the exact digests. Packaged validation checks the app's effective lock against the packaged handoff.

## 6. Acceptance

1. A clean MyAgents checkout with no staged DSH resource and a populated exact cache can build the pinned Release App offline; without cache it downloads the fixed GitHub asset and builds after verification.
2. An unavailable asset, wrong archive SHA, changed handoff, wrong platform/Node/protocol or incompatible contract aborts before Tauri packaging. No local fallback occurs in Release mode.
3. A Dev build with no DSH flags packages the same bytes as the committed release lock. A Dev build with an explicit local handoff packages that handoff and reports its distinct effective identity without modifying the release lock.
4. Local mode works without a sibling DSH checkout; when a source checkout is explicitly supplied for freshness, it is checked against the local handoff rather than the committed release.
5. TypeScript, Rust and the final App expose the same DSH handoff/Runtime/compatibility identity. Existing Sessions retain their frozen binding; runtime source paths are absent from user data.
6. Tests cover release URL derivation, cache hit/corruption, failed download, local handoff selection, identity parity, direct build entry points and rejection of a local contract mismatch. At least one real macOS Dev package is verified from each available source. Intel macOS requires an x64 native Runtime and package smoke; Windows/Linux native claims are reported only if those platforms run.

## 7. Rollout

Implement and test the MyAgents-dsh archive packager and MyAgents prepare helper without publishing a release. Keep the currently staged handoff usable for explicit local Dev builds during migration. Once an accepted GitHub Release asset exists, update MyAgents' committed release lock with its exact tag/asset/archive digest, then run clean-checkout Release and Dev package acceptance. A tag-triggered publisher follows after its exact-source/native gates are automated. No desktop build may implicitly follow `latest`.
