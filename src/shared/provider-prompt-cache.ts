/** Target transport capabilities, independent of conversation affinity.
 * OpenAI-compatible does not imply support for OpenAI caching extensions.
 * Only the official endpoint and documented model families are trusted here.
 * https://developers.openai.com/api/docs/guides/prompt-caching
 */
export function resolveProviderPromptCacheCapabilities(baseUrl: string, model: string): {
  key: boolean;
  breakpoints: boolean;
} {
  let officialEndpoint = false;
  try {
    const url = new URL(baseUrl);
    officialEndpoint = url.origin === 'https://api.openai.com'
      && url.pathname.replace(/\/+$/, '') === '/v1'
      && !url.search && !url.hash && !url.username && !url.password;
  } catch { /* An invalid/unknown endpoint has no confirmed optimization support. */ }
  return {
    key: officialEndpoint,
    // No numeric >= rule: new or proxy model IDs need their own evidence.
    breakpoints: officialEndpoint
      && /^(?:gpt-5\.6(?:-pro)?|gpt-6(?:\.1)?-(?:sol|astra|luna))(?:-\d{4}-\d{2}-\d{2})?$/.test(model),
  };
}
