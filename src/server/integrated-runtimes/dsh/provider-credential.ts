import type { DshHostModelBinding } from './collaboration-compiler';
import { resolveManagedOAuthCredential } from '../../utils/management-api-client';

/** Resolve one exact DSH model request without copying managed secrets into configuration. */
export async function resolveDshProviderApiKey(
  binding: DshHostModelBinding,
  signal: AbortSignal,
): Promise<string> {
  if (binding.managedOauth) {
    if (binding.profile.provider !== 'xai-sub' || binding.apiKey) {
      throw new Error('DSH managed OAuth binding has an invalid owner');
    }
    const credential = await resolveManagedOAuthCredential('xai-sub', { reason: 'request' }, signal);
    if (!credential?.accessToken) throw new Error('DSH managed OAuth credential is unavailable');
    return credential.accessToken;
  }
  if (!binding.apiKey) throw new Error('DSH Provider credential is unavailable');
  return binding.apiKey;
}
