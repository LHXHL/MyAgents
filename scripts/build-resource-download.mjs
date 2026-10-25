// Build-time HTTP only. Resource owners still decide versions, hashes and cache publication.
export const BUILD_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
export const BUILD_DOWNLOAD_ATTEMPTS = 5;

function transient(error) {
  if (typeof error.retryable === 'boolean') return error.retryable;
  return error.name === 'TimeoutError'
    || (error instanceof TypeError && error.message === 'fetch failed'
      && !/redirect/i.test(error.cause?.message ?? ''))
    || /^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(error.code ?? error.cause?.code ?? '');
}

export async function downloadBuildResource(url, {
  maxBytes, timeoutMs = BUILD_DOWNLOAD_TIMEOUT_MS, attempts = BUILD_DOWNLOAD_ATTEMPTS, fetchImpl,
  redirect = 'error', headers,
  log = console.log, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0
    || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error('Build download requires a positive byte limit, timeout and attempt count');
  }
  // Prerequisite checks and cache hits run before npm install. Load the existing
  // transport dependency only when downloading. Use the standard build-tool
  // proxy environment explicitly; Node and npm Undici have separate globals.
  // Fetch and dispatcher must come from the same installed Undici version;
  // Node's built-in fetch may use an older, incompatible dispatcher protocol.
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import('undici');
  const download = fetchImpl ?? undiciFetch;
  const transport = new EnvHttpProxyAgent({ connectTimeout: timeoutMs });
  const dispatcher = transport.compose(dispatch => (options, handler) => dispatch({
    ...options, headersTimeout: timeoutMs, bodyTimeout: timeoutMs,
  }, handler));
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      log(`[download] ${url} attempt ${attempt}/${attempts}, timeout ${timeoutMs / 1000}s`);
      try {
        const response = await download(url, { headers, redirect, dispatcher, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw Object.assign(new Error(`HTTP ${response.status}`), {
            retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
          });
        }
        if (!response.body) throw new Error('Missing response body');
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > maxBytes) throw new Error(`Response size exceeds ${maxBytes} bytes`);
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      } catch (error) {
        const retryable = transient(error);
        if (!retryable || attempt === attempts) {
          throw Object.assign(new Error(`Download failed: ${url} (attempt ${attempt}/${attempts}, timeout ${timeoutMs / 1000}s): ${error.message}`, { cause: error }), { retryable });
        }
        const delay = attempt * 1000;
        log(`[download] ${error.message}; retry in ${delay / 1000}s`);
        await sleep(delay);
      }
    }
  } finally {
    await transport.close();
  }
}
