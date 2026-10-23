// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/plugin-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/plugin-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export const PLUGIN_HOOK_NAMES = undefined;
export const isPluginHookName = undefined;
export const PROMPT_INJECTION_HOOK_NAMES = undefined;
export const isPromptInjectionHookName = undefined;
export const PluginApprovalResolutions = undefined;
export const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS = undefined;
