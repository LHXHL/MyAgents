import { BROWSER_BLANK_URL } from './browserConstants';

/** A fresh value represents an explicit navigation, including reopening the same URL. */
export interface BrowserNavigationRequest { readonly url: string }

/** Address-bar input only. Native code remains the authority for local-file access. */
export function resolveBrowserAddress(input: string): string | null {
  const address = input.trim();
  if (!address) return null;
  if (address === 'about:blank') return BROWSER_BLANK_URL;
  if (/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(address)) return address;
  const hostWithPort = /^(?:[^\s/:?#]+|\[[^\]]+\]):\d+(?:[/?#]|$)/.test(address);
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(address) && !hostWithPort;
  if (explicitScheme && !/^(?:https?|file):\/\//i.test(address)) return null;
  if (!explicitScheme && /\s/.test(address)) return null;
  try {
    const url = new URL(explicitScheme ? address : `https://${address}`);
    if (url.protocol === 'file:') return url.href;
    if (!url.hostname || url.username || url.password) return null;
    const localHost = url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
      || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith('[');
    if (!explicitScheme && !localHost && !url.hostname.includes('.') && !hostWithPort) return null;
    if (!explicitScheme && localHost) return new URL(`http://${address}`).href;
    return url.href;
  } catch {
    return null;
  }
}
