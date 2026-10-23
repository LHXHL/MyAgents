// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./plugin-runtime.auto.js";
// === END AUTO-AUGMENT ===

// Handwritten interactive dispatch; remaining unsupported OpenClaw APIs retain their stubs.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/plugin-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/plugin-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function getPluginRuntimeGatewayRequestScope() { _w('getPluginRuntimeGatewayRequestScope'); return undefined; }
export async function executePluginCommand() { _w('executePluginCommand'); return undefined; }
export function matchPluginCommand() { _w('matchPluginCommand'); return undefined; }
export function listPluginCommands() { _w('listPluginCommands'); return []; }
export const __testing = undefined;
export function clearPluginCommands() { _w('clearPluginCommands'); return undefined; }
export function clearPluginCommandsForPlugin() { _w('clearPluginCommandsForPlugin'); return undefined; }
export function getPluginCommandSpecs() { _w('getPluginCommandSpecs'); return undefined; }
export function listProviderPluginCommandSpecs() { _w('listProviderPluginCommandSpecs'); return []; }
export function registerPluginCommand() { _w('registerPluginCommand'); return undefined; }
export function validateCommandName() { _w('validateCommandName'); return undefined; }
export function validatePluginCommandDefinition() { _w('validatePluginCommandDefinition'); return undefined; }
export async function runGlobalGatewayStopSafely() { _w('runGlobalGatewayStopSafely'); return undefined; }
export function initializeGlobalHookRunner() { _w('initializeGlobalHookRunner'); return undefined; }
export function getGlobalHookRunner() { _w('getGlobalHookRunner'); return undefined; }
export function getGlobalPluginRegistry() { _w('getGlobalPluginRegistry'); return undefined; }
export function hasGlobalHooks() { _w('hasGlobalHooks'); return false; }
export function resetGlobalHookRunner() { _w('resetGlobalHookRunner'); return undefined; }
export function normalizePluginHttpPath() { _w('normalizePluginHttpPath'); return ""; }
export function registerPluginHttpRoute() { _w('registerPluginHttpRoute'); return undefined; }
export function createInteractiveConversationBindingHelpers() { _w('createInteractiveConversationBindingHelpers'); return undefined; }
// Rust owns pending-request acceptance and deduplication. This registry only
// routes the platform's standard namespace callback to the registered transport.
const interactiveHandlers = new Map();
export async function dispatchPluginInteractiveHandler(params) {
  const data = params.data.trim();
  const separator = data.indexOf(':');
  const namespace = separator < 0 ? data : data.slice(0, separator);
  const registration = interactiveHandlers.get(`${params.channel.trim().toLowerCase()}:${namespace}`);
  if (!registration) return { matched: false, handled: false, duplicate: false };
  await params.onMatched?.();
  const result = await params.invoke({ registration, namespace, payload: separator < 0 ? '' : data.slice(separator + 1) });
  return { matched: true, handled: result?.handled ?? true, duplicate: false };
}
export function clearPluginInteractiveHandlers() { interactiveHandlers.clear(); }
export function clearPluginInteractiveHandlersForPlugin(pluginId) {
  for (const [key, registration] of interactiveHandlers) if (registration.pluginId === pluginId) interactiveHandlers.delete(key);
}
export function registerPluginInteractiveHandler(pluginId, registration) {
  const namespace = registration.namespace.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(namespace)) return { ok: false, error: 'Invalid interactive namespace' };
  const key = `${registration.channel.trim().toLowerCase()}:${namespace}`;
  if (interactiveHandlers.has(key)) return { ok: false, error: 'Interactive namespace already registered' };
  interactiveHandlers.set(key, { ...registration, namespace, pluginId });
  return { ok: true };
}
export async function defaultLoadOverrideModule() { _w('defaultLoadOverrideModule'); return undefined; }
export async function startLazyPluginServiceModule() { _w('startLazyPluginServiceModule'); return undefined; }
export function stripPromptMutationFieldsFromLegacyHookResult() { _w('stripPromptMutationFieldsFromLegacyHookResult'); return ""; }
