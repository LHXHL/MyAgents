// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./channel-reply-pipeline.auto.js";
// === END AUTO-AUGMENT ===

// Handwritten Bridge-mode implementation for createChannelReplyPipeline.
//
// In Bridge mode, compat-runtime forwards the inbound message to Rust.
// Buffered calls with `dispatcherOptions.deliver` use that plugin renderer
// through the request-scoped reply dispatcher; calls without a renderer use
// the admission-only path. This shim supplies no additional replyPipeline
// dispatcher options, so callers only need the destructure to succeed.
//
// Yuanbao destructures `const { onModelSelected, ...replyPipeline } = ...`
// at dispatch-reply.js and threads `onModelSelected` into replyOptions. We
// supply a no-op so the call to it (if any) is harmless. `replyPipeline`
// becomes {}.
export function createChannelReplyPipeline() {
  return {
    onModelSelected: () => {},
  };
}
