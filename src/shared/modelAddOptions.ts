/** The model-add CLI surface. Admission and both help surfaces consume this
 * declaration; the Admin provider owner validates the resulting domain values. */
export const MODEL_ADD_OPTIONS = {
  id: ['id', 'Provider ID (required)'],
  name: ['name', 'Display name (required)'],
  baseUrl: ['base-url', 'API endpoint URL (required)'],
  models: ['models', 'Model IDs (repeatable, at least one)'],
  modelNames: ['model-names', 'Display names for models (repeatable)'],
  modelSeries: ['model-series', 'Model family label (default: provider ID)'],
  primaryModel: ['primary-model', 'Default model (default: first in --models)'],
  authType: ['auth-type', 'auth_token | api_key | both | auth_token_clear_api_key (default: auth_token)'],
  protocol: ['protocol', 'anthropic | openai (default: anthropic)'],
  upstreamFormat: ['upstream-format', 'chat_completions | responses (openai only)'],
  maxOutputTokens: ['max-output-tokens', 'Positive integer output limit (openai only)'],
  aliases: ['aliases', 'SDK alias mapping: sonnet=model,opus=model,haiku=model'],
  vendor: ['vendor', 'Vendor name'],
  websiteUrl: ['website-url', 'Provider website'],
  timeout: ['timeout', 'Positive integer request timeout in milliseconds'],
  disableNonessential: ['disable-nonessential', 'Disable nonessential SDK traffic (boolean flag)'],
} as const;

export const MODEL_ADD_OPTIONS_HELP = Object.values(MODEL_ADD_OPTIONS)
  .map(([flag, description]) => `  ${`--${flag}`.padEnd(24)}${description}`)
  .join('\n');
