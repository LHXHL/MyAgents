// Bridge HTTP handler: receives Anthropic requests, translates to OpenAI, forwards, translates back

// MUST import `fetch` from undici (not use global fetch). Node 24's built-in
// fetch is undici 7.21.0, but our `package.json` pins `undici@^8`. Passing an
// undici-8 ProxyAgent dispatcher into undici-7's global fetch crashes with
// `UND_ERR_INVALID_ARG: invalid onRequestStart method` (internal API drift
// between majors). Importing fetch from the same package guarantees the
// dispatcher and fetch share the same internal contract.
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import type { BridgeConfig, UpstreamConfig } from './types/bridge';
import type { AnthropicRequest } from './types/anthropic';
import type { OpenAIRequest, OpenAIResponse, OpenAIStreamChunk } from './types/openai';
import type { ResponsesRequest, ResponsesResponse, ResponsesStreamEvent } from './types/openai-responses';
import { translateRequest } from './translate/request';
import { translateResponse } from './translate/response';
import { translateRequestToResponses } from './translate/request-responses';
import { translateResponsesResponse, ResponsesApiError } from './translate/response-responses';
import { createToolImageSaver, type ToolImageSaver } from './translate/multimodal';
import { StreamTranslator } from './translate/stream';
import { ResponsesStreamTranslator } from './translate/stream-responses';
import { translateError } from './translate/errors';
import { SSEParser } from './utils/sse-parser';
import { formatSSE } from './utils/sse-writer';
import { buildPromptCacheKey, hashForLog } from './prompt-cache';
import {
  getProxyForProviderUrl,
  getProxyForUrl as resolveGlobalProxyForUrl,
} from '../proxy-state';

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const THOUGHT_SIG_CACHE_MAX = 500; // Max cached thought_signatures to prevent unbounded growth

/**
 * Sentinel forwarded through the Chat Completions parse→translate pipeline when
 * the upstream emits the OpenAI stream terminator `data: [DONE]`.
 *
 * The translate stage finalizes the StreamTranslator on this signal — the
 * PROTOCOL-correct boundary — instead of waiting for transport EOF
 * (TransformStream `flush()`). With `stream_options.include_usage=true`, the
 * `usage` payload arrives in a trailing chunk AFTER `finish_reason`, so the
 * terminal `message_delta`/`message_stop` must be deferred until usage is in
 * hand. Keying that solely on transport EOF is fragile: a provider that sends
 * `[DONE]` but lingers before closing the body would have its terminal events
 * delayed to the idle timeout → abort → `flush()` never runs → usage + stop
 * lost. Finalizing on `[DONE]` fixes that; `flush()` remains a fallback for
 * streams that close without a `[DONE]`. See issue #277.
 */
const STREAM_DONE = Symbol('openai-stream-done');
type ChatPipelineItem = OpenAIStreamChunk | typeof STREAM_DONE;

// Gemini-documented dummy value to skip thought_signature validation
// when the real signature is unavailable (e.g., cross-model history, injected tool calls).
// See: https://ai.google.dev/gemini-api/docs/thought-signatures
const THOUGHT_SIG_SKIP_VALIDATOR = 'skip_thought_signature_validator';

/**
 * Last upstream-connectivity failure observed by the bridge.
 *
 * Purpose is purely diagnostic: when `verifyViaSdk`'s outer 30s timeout fires,
 * it inspects this ref to surface the real connect-layer error (TLS rejection,
 * socket closed, DNS failure, proxy-intercepted TLS, …) instead of the generic
 * "验证超时，请检查网络连接" message. These errors live only in the bridge's
 * fetch-catch path — the SDK sees our 502 and retries until the outer timeout
 * fires, so the real reason never reaches verify through the normal code path.
 *
 * Scoped by wall-clock: readers filter by `timestamp >= theirStartTime` so
 * stale errors from unrelated sessions don't leak into new verify attempts.
 * Last-writer-wins across concurrent sessions is an acceptable trade-off —
 * this is a failure-mode diagnostic, not a correctness surface.
 */
let lastBridgeError: { message: string; timestamp: number; upstreamUrl: string } | undefined;

export function getLastBridgeError(): { message: string; timestamp: number; upstreamUrl: string } | undefined {
  return lastBridgeError;
}

/** Detect global proxy URL from environment (respects no_proxy for the target URL). */
export function getProxyForUrl(url: string): string | undefined {
  return resolveGlobalProxyForUrl(url);
}

/**
 * Per-proxy-URL dispatcher cache.
 *
 * Node.js `fetch()` is undici under the hood, and undici routes upstream HTTP
 * traffic via the `dispatcher` field — NOT a `proxy` string (that's Bun-only).
 * Each `ProxyAgent` carries its own connection pool, so we keep one per URL
 * and reuse it across requests rather than creating one per fetch.
 *
 * Note: SOCKS5 is handled upstream by `setProxyConfig()` (agent-session.ts) —
 * it spins up a local HTTP-to-SOCKS5 bridge and sets `HTTP_PROXY` to the
 * bridge's HTTP URL, so by the time we resolve provider-owned proxy here the
 * URL is always plain http://.
 */
const proxyDispatchers = new Map<string, Dispatcher>();

function getDispatcherForProxy(proxyUrl: string): Dispatcher {
  let agent = proxyDispatchers.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyDispatchers.set(proxyUrl, agent);
  }
  return agent;
}

function resolveResponsesPromptCacheKey(
  upstream: UpstreamConfig,
  fallbackModel: string,
): string | undefined {
  const affinity = upstream.cacheAffinity;
  if (!affinity || affinity.promptCacheKeyMode !== 'session') return undefined;
  if (affinity.promptCacheKeyDisabled) return undefined;
  return buildPromptCacheKey({
    appNamespace: 'myagents',
    providerId: upstream.providerId,
    model: upstream.model ?? fallbackModel,
    sessionId: affinity.sessionId,
    upstreamFormat: 'responses',
  });
}

function isUnsupportedPromptCacheKeyError(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const structured = extractUpstreamErrorFields(body);
  const descriptor = [
    structured?.message,
    structured?.code,
    structured?.type,
  ].filter(Boolean).join(' ');

  if (structured?.param === 'prompt_cache_key') {
    return isUnsupportedPromptCacheKeyDescriptor(descriptor);
  }

  return isUnsupportedPromptCacheKeyDescriptor(body)
    && /\bprompt_cache_key\b/i.test(body);
}

function isUnsupportedPromptCacheKeyDescriptor(value: string): boolean {
  return /\b(?:unknown|unsupported|unrecognized|unexpected)\b.*\b(?:parameter|field|argument|property)?\b.*\bprompt_cache_key\b/i.test(value)
    || /\bprompt_cache_key\b.*\b(?:unknown|unsupported|unrecognized|unexpected|not supported)\b/i.test(value)
    || /\b(?:additional|extra)\b.*\b(?:parameter|field|argument|property)\b.*\bprompt_cache_key\b/i.test(value);
}

function extractUpstreamErrorFields(body: string): { message?: string; param?: string; code?: string; type?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const root = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : parsed;
  if (!isRecord(root)) return undefined;
  return {
    message: typeof root.message === 'string' ? root.message : undefined,
    param: typeof root.param === 'string'
      ? root.param
      : typeof root.parameter === 'string'
        ? root.parameter
        : undefined,
    code: typeof root.code === 'string' ? root.code : undefined,
    type: typeof root.type === 'string' ? root.type : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringifyWithoutPromptCacheKey(req: OpenAIRequest | ResponsesRequest): string {
  if (!('prompt_cache_key' in req)) return JSON.stringify(req);
  const rest = { ...req };
  delete (rest as { prompt_cache_key?: string }).prompt_cache_key;
  return JSON.stringify(rest);
}

const PROMPT_CACHE_KEY_VALUE_RE = /myagents:responses:[a-f0-9]{32}/g;
const PROMPT_CACHE_KEY_VALUE_TEST_RE = /myagents:responses:[a-f0-9]{32}/;
const ERROR_REQUEST_ECHO_KEYS = new Set([
  'content',
  'input',
  'instructions',
  'messages',
  'prompt',
  'system',
]);
const ERROR_SECRET_KEY_RE = /(?:api[_-]?key|authorization|bearer|secret|token)/i;

function sanitizeUpstreamErrorBody(body: string): string {
  const redactedBody = redactPromptCacheKeyValues(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(redactedBody);
  } catch {
    if (looksLikeEchoedRequestText(redactedBody)) {
      return '[redacted upstream error body containing echoed request]';
    }
    return redactedBody;
  }

  const redactingRequestEcho = containsPromptCacheKeyReference(parsed);
  return JSON.stringify(sanitizeErrorValue(parsed, redactingRequestEcho));
}

function redactPromptCacheKeyValues(value: string): string {
  return value.replace(PROMPT_CACHE_KEY_VALUE_RE, '[redacted-prompt-cache-key]');
}

function containsPromptCacheKeyReference(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\bprompt_cache_key\b/.test(value) || PROMPT_CACHE_KEY_VALUE_TEST_RE.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsPromptCacheKeyReference);
  }
  if (isRecord(value)) {
    return Object.entries(value).some(([key, nested]) => (
      key === 'prompt_cache_key' || containsPromptCacheKeyReference(nested)
    ));
  }
  return false;
}

function sanitizeErrorValue(value: unknown, redactingRequestEcho: boolean): unknown {
  if (typeof value === 'string') {
    const redacted = redactPromptCacheKeyValues(value);
    if (redactingRequestEcho && looksLikeEchoedRequestText(redacted)) {
      return '[redacted upstream error text containing echoed request]';
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeErrorValue(item, redactingRequestEcho));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'prompt_cache_key') {
        out[key] = '[redacted-prompt-cache-key]';
      } else if (ERROR_SECRET_KEY_RE.test(normalizedKey)) {
        out[key] = '[redacted-secret]';
      } else if (redactingRequestEcho && ERROR_REQUEST_ECHO_KEYS.has(normalizedKey)) {
        out[key] = `[redacted-${normalizedKey}]`;
      } else {
        out[key] = sanitizeErrorValue(nested, redactingRequestEcho);
      }
    }
    return out;
  }
  return value;
}

function looksLikeEchoedRequestText(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes('prompt_cache_key')
    && (
      lower.includes('"input"')
      || lower.includes('"messages"')
      || lower.includes('"instructions"')
      || lower.includes('"content"')
    );
}

export interface BridgeHandler {
  /** Handle an incoming Anthropic-format request */
  (request: Request): Promise<Response>;
  /** Seed the thought_signature cache (e.g., from persisted session history) */
  seedThoughtSignatures(entries: Array<{ id: string; thought_signature: string }>): void;
}

/** Create a bridge handler that translates Anthropic → OpenAI → Anthropic */
export function createBridgeHandler(config: BridgeConfig): BridgeHandler {
  const log = config.logger === null ? () => {} : (config.logger ?? console.log);
  const timeout = config.upstreamTimeout ?? DEFAULT_TIMEOUT;
  const translateReasoning = config.translateReasoning ?? true;
  const imageSaver: ToolImageSaver | undefined = config.workspacePath
    ? createToolImageSaver(config.workspacePath)
    : undefined;

  // Cache tool_call_id → thought_signature across requests.
  // Gemini thinking models require round-tripping thought_signature on every request
  // that includes tool calls in history. The Claude Agent SDK strips non-standard fields,
  // so we must cache them here and re-inject on outgoing requests.
  // Capped at THOUGHT_SIG_CACHE_MAX to prevent unbounded growth in long-lived sessions.
  const thoughtSignatureCache = new Map<string, string>();

  const handler = async (request: Request): Promise<Response> => {
    // 1. Extract API key from request headers
    const apiKey = request.headers.get('x-api-key') || request.headers.get('authorization')?.replace('Bearer ', '') || '';

    // 2. Parse Anthropic request body
    let anthropicReq: AnthropicRequest;
    try {
      anthropicReq = await request.json() as AnthropicRequest;
    } catch {
      return jsonError(400, 'invalid_request_error', 'Invalid JSON in request body');
    }

    // 3. Get upstream config
    let upstream: UpstreamConfig;
    try {
      upstream = await config.getUpstreamConfig(request);
    } catch (err) {
      // PRD #124: distinguish "client routing error" (unknown token) from
      // "configuration error". The former MUST be 400 so SDK clients see
      // a clean rejection — wrapping a stale subprocess's late requests
      // as 500 misleads upstream layers into retrying or surfacing as
      // generic agent-error. We surface the unknown-token category here
      // because it's the only error shape `getUpstreamConfig` throws by
      // contract; anything else is genuinely a 500.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('Unknown bridge token') || msg.includes('missing token')) {
        log(`[bridge] reject: ${msg}`);
        return jsonError(400, 'invalid_request_error', msg);
      }
      log(`[bridge] Failed to get upstream config: ${err}`);
      return jsonError(500, 'api_error', 'Bridge configuration error');
    }

    const effectiveApiKey = upstream.apiKey || apiKey;
    const baseUrl = upstream.baseUrl.replace(/\/+$/, ''); // trim trailing slashes
    const isResponses = upstream.upstreamFormat === 'responses';

    // 4. Translate request (choose format based on upstream config)
    // PRD #124: per-request model mapping (carried on UpstreamConfig, set by
    // the route closure from the bridge token's registry entry) takes
    // priority over the handler-wide BridgeConfig.modelMapping. This is what
    // lets concurrent SDK subprocesses with different sub-agent rules
    // coexist without cross-pollination.
    const effectiveModelMapping = upstream.modelMapping ?? config.modelMapping;
    const responsesPromptCacheKey = isResponses
      ? resolveResponsesPromptCacheKey(upstream, anthropicReq.model)
      : undefined;
    const translatedReq = isResponses
      ? translateRequestToResponses(anthropicReq, {
          modelOverride: upstream.model,
          modelMapping: effectiveModelMapping,
          imageSaver,
          reasoningEffort: upstream.reasoningEffort,
          promptCacheKey: responsesPromptCacheKey,
        })
      : translateRequest(anthropicReq, { modelMapping: effectiveModelMapping, modelOverride: upstream.model, imageSaver, reasoningEffort: upstream.reasoningEffort });

    // 4a. Normalize thought_signatures on tool_calls (Gemini thinking models).
    // Gemini requires thought_signature on tool_calls in conversation history.
    // In OpenAI-compat format, Gemini expects it at extra_content.google.thought_signature.
    // The Claude Agent SDK strips non-standard fields, so we re-inject from cache.
    // We normalize ALL tool_calls to have BOTH locations (direct + extra_content):
    //   - Sig exists at one location → copy to the other (normalization)
    //   - No sig at either → inject from cache or Google-documented dummy fallback
    if (!isResponses) {
      const chatReq = translatedReq as OpenAIRequest;
      let injectedCached = 0;
      let injectedDummy = 0;
      let normalized = 0;
      for (const msg of chatReq.messages) {
        if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const existingSig = tc.thought_signature
              || tc.extra_content?.google?.thought_signature;
            if (existingSig) {
              // Normalize: ensure both locations have the sig
              if (!tc.thought_signature || !tc.extra_content?.google?.thought_signature) {
                tc.thought_signature = existingSig;
                tc.extra_content = { ...tc.extra_content, google: { ...tc.extra_content?.google, thought_signature: existingSig } };
                normalized++;
              }
            } else {
              // No sig anywhere — inject from cache or dummy
              const cached = thoughtSignatureCache.get(tc.id);
              const sig = cached || THOUGHT_SIG_SKIP_VALIDATOR;
              tc.thought_signature = sig;
              tc.extra_content = { ...tc.extra_content, google: { ...tc.extra_content?.google, thought_signature: sig } };
              if (cached) injectedCached++;
              else injectedDummy++;
            }
          }
        }
      }
      if (injectedCached > 0 || injectedDummy > 0 || normalized > 0) {
        log(`[bridge] thought_signatures: ${injectedCached} cached, ${injectedDummy} dummy, ${normalized} normalized`);
      }
    }

    // 4b. Inject token limit if configured.
    // Request translators intentionally omit token limits (SDK sends Claude-scale values
    // that are meaningless for other providers). Only inject when the user explicitly
    // configured a cap via maxOutputTokens in provider settings.
    const maxOutputTokensCap = upstream.maxOutputTokens ?? config.maxOutputTokens;
    if (maxOutputTokensCap) {
      if (isResponses) {
        // Responses API always uses max_output_tokens
        (translatedReq as { max_output_tokens?: number }).max_output_tokens = maxOutputTokensCap;
        log(`[bridge] Injecting max_output_tokens=${maxOutputTokensCap}`);
      } else {
        // Chat Completions: use user-configured param name (default max_tokens for widest compatibility)
        const paramName = upstream.maxOutputTokensParamName ?? 'max_tokens';
        const chatReq = translatedReq as OpenAIRequest & { [key: string]: unknown };
        chatReq[paramName] = maxOutputTokensCap;
        log(`[bridge] Injecting ${paramName}=${maxOutputTokensCap}`);
      }
    }

    const logModel = (translatedReq as { model: string }).model;
    log(`[bridge] ${anthropicReq.model} → ${logModel} stream=${!!anthropicReq.stream} tools=${anthropicReq.tools?.length ?? 0} format=${isResponses ? 'responses' : 'chat_completions'}`);

    // 5. Forward to upstream
    const upstreamUrl = isResponses
      ? `${baseUrl}/responses`
      : `${baseUrl}/chat/completions`;

    type UpstreamAttempt = {
      upstreamResp: Response;
      controller: AbortController;
      headersTimer: ReturnType<typeof setTimeout>;
      onDownstreamAbort: () => void;
    };
    type UpstreamAttemptResult =
      | { ok: true; attempt: UpstreamAttempt }
      | { ok: false; response: Response };

    const cleanupAttempt = (attempt: UpstreamAttempt): void => {
      clearTimeout(attempt.headersTimer);
      if (request.signal) {
        request.signal.removeEventListener('abort', attempt.onDownstreamAbort);
      }
    };

    const fetchUpstreamAttempt = async (requestBody: string): Promise<UpstreamAttemptResult> => {
      // Pattern 1: the AbortController's lifetime spans the entire stream, not
      // just headers arrival. On retry, each attempt owns its own controller and
      // downstream-abort listener so cleanup stays exact.
      const controller = new AbortController();
      const headersTimer = setTimeout(
        () => controller.abort(new Error(`Upstream headers timeout after ${timeout}ms`)),
        timeout,
      );

      const onDownstreamAbort = (): void => {
        try {
          controller.abort(new Error('Downstream request aborted'));
        } catch { /* ignore */ }
      };
      if (request.signal) {
        if (request.signal.aborted) {
          onDownstreamAbort();
        } else {
          request.signal.addEventListener('abort', onDownstreamAbort, { once: true });
        }
      }

      try {
        // Detect proxy for this provider owner. The bridge token resolved the
        // providerId; URL/baseUrl alone is not an owner boundary.
        const proxyUrl = getProxyForProviderUrl(upstream.providerId, upstreamUrl);
        const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${effectiveApiKey}`,
          },
          body: requestBody,
          signal: controller.signal,
        };
        if (proxyUrl) {
          fetchInit.dispatcher = getDispatcherForProxy(proxyUrl);
        }
        // Cast to global Response — undici.Response is structurally identical at
        // runtime; the type drift is only in @types/node vs undici/types Headers
        // iterators. Downstream handlers (handleStreamResponse etc.) treat the
        // body as a ReadableStream<Uint8Array>, which works for both shapes.
        const upstreamResp = await fetch(upstreamUrl, fetchInit as Parameters<typeof fetch>[1]) as unknown as Response;
        return { ok: true, attempt: { upstreamResp, controller, headersTimer, onDownstreamAbort } };
      } catch (err) {
        clearTimeout(headersTimer);
        if (request.signal) {
          request.signal.removeEventListener('abort', onDownstreamAbort);
        }
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        // undici surfaces the real reason on `err.cause` (TypeError: fetch failed
        // is the wrapper). Inline the cause so logs aren't useless.
        const causeRaw = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
        const causeMsg = causeRaw instanceof Error ? causeRaw.message : (causeRaw ? String(causeRaw) : '');
        const baseMsg = err instanceof Error ? err.message : String(err);
        const errMsg = causeMsg ? `${baseMsg} (cause: ${causeMsg})` : baseMsg;
        log(`[bridge] Upstream ${isTimeout ? 'timeout' : 'error'}: ${errMsg}`);
        // Record for verify-timeout diagnostics (see getLastBridgeError docstring).
        // Only the connect-layer catch path — HTTP error responses (!upstreamResp.ok)
        // are already surfaced through the SDK's assistant.error path to verify.
        lastBridgeError = { message: errMsg, timestamp: Date.now(), upstreamUrl };
        return {
          ok: false,
          response: jsonError(
            isTimeout ? 408 : 502,
            'api_error',
            isTimeout ? 'Upstream request timed out' : `Upstream connection error: ${errMsg}`,
          ),
        };
      }
    };

    let attemptResult = await fetchUpstreamAttempt(JSON.stringify(translatedReq));
    if (!attemptResult.ok) return attemptResult.response;
    let { upstreamResp, controller, headersTimer, onDownstreamAbort } = attemptResult.attempt;

    // 6. Handle upstream errors
    if (!upstreamResp.ok) {
      let errBody = await upstreamResp.text();
      cleanupAttempt({ upstreamResp, controller, headersTimer, onDownstreamAbort });

      const canRetryWithoutPromptCacheKey =
        isResponses
        && Boolean((translatedReq as { prompt_cache_key?: string }).prompt_cache_key)
        && Boolean(upstream.cacheAffinity?.disablePromptCacheKey)
        && isUnsupportedPromptCacheKeyError(upstreamResp.status, errBody);

      if (canRetryWithoutPromptCacheKey) {
        upstream.cacheAffinity?.disablePromptCacheKey?.();
        log(`[bridge] responses prompt_cache_key unsupported for provider=${upstream.providerId} endpoint=${hashForLog(upstreamUrl)}; disabled for this bridge`);

        attemptResult = await fetchUpstreamAttempt(stringifyWithoutPromptCacheKey(translatedReq));
        if (!attemptResult.ok) return attemptResult.response;
        ({ upstreamResp, controller, headersTimer, onDownstreamAbort } = attemptResult.attempt);
        if (!upstreamResp.ok) {
          errBody = await upstreamResp.text();
          cleanupAttempt({ upstreamResp, controller, headersTimer, onDownstreamAbort });
        }
      }

      if (!upstreamResp.ok) {
        const safeErrBody = sanitizeUpstreamErrorBody(errBody);
        log(`[bridge] Upstream error ${upstreamResp.status}: ${safeErrBody.slice(0, 300)}`);
        const { status, body } = translateError(upstreamResp.status, safeErrBody);
        if (status !== upstreamResp.status) {
          log(`[bridge] Remapped ${upstreamResp.status} → ${status} (${body.error.type})`);
        }
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Headers arrived → cancel the headers timeout (we now switch to per-read
    // idle timeout inside the stream handler). The controller stays live for
    // the stream's lifetime so cancel() can reach it.
    clearTimeout(headersTimer);

    // 7. Detect Content-Type to handle unexpected SSE on non-stream requests
    const contentType = upstreamResp.headers.get('content-type') ?? '';
    const isSSEResponse = contentType.includes('text/event-stream');

    // 8. Translate response
    if (anthropicReq.stream || isSSEResponse) {
      // Stream response (or non-stream request that got SSE back — auto-fallback)
      if (isSSEResponse && !anthropicReq.stream) {
        log('[bridge] Non-stream request received SSE response — auto-falling back to stream processing');
      }
      // Hand off lifecycle ownership to the stream handler — it owns:
      //  - controller (so stream.cancel() can abort upstream fetch)
      //  - request.signal listener cleanup
      //  - idle timeout enforcement (60s)
      return isResponses
        ? handleResponsesStreamResponse(upstreamResp, anthropicReq.model, log, controller, request.signal, onDownstreamAbort)
        : handleStreamResponse(upstreamResp, anthropicReq.model, translateReasoning, log, thoughtSignatureCache, controller, request.signal, onDownstreamAbort);
    } else {
      // Non-stream branch: response body is read with a single await; the
      // request.signal listener can be detached now (controller lives only
      // through the body read, which translateXxxResponse owns).
      if (request.signal) {
        request.signal.removeEventListener('abort', onDownstreamAbort);
      }
      return isResponses
        ? handleResponsesNonStreamResponse(upstreamResp, anthropicReq.model, log)
        : handleNonStreamResponse(upstreamResp, anthropicReq.model, translateReasoning, log, thoughtSignatureCache);
    }
  };

  // Expose cache seeding for session resume (thought_signatures from persisted history)
  // Uses cacheThoughtSignatures() to enforce THOUGHT_SIG_CACHE_MAX consistently.
  handler.seedThoughtSignatures = (entries: Array<{ id: string; thought_signature: string }>) => {
    cacheThoughtSignatures(entries, thoughtSignatureCache, THOUGHT_SIG_CACHE_MAX);
    if (entries.length > 0) {
      log(`[bridge] Seeded ${entries.length} thought_signature(s) from session history`);
    }
  };

  // Safe: function object with an attached method property matches BridgeHandler's callable + method shape
  return handler as BridgeHandler;
}

async function handleNonStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  translateReasoning: boolean,
  log: (msg: string) => void,
  thoughtSignatureCache?: Map<string, string>,
): Promise<Response> {
  // Use text() + manual JSON.parse to tolerate non-standard Content-Type
  let openaiResp: OpenAIResponse;
  try {
    const text = await upstreamResp.text();
    openaiResp = JSON.parse(text) as OpenAIResponse;
  } catch {
    log('[bridge] Failed to parse upstream JSON response');
    return jsonError(502, 'api_error', 'Invalid upstream response');
  }

  // Cache thought_signatures from tool calls (Gemini thinking models)
  if (thoughtSignatureCache) {
    cacheThoughtSignatures(openaiResp.choices?.[0]?.message?.tool_calls, thoughtSignatureCache);
  }

  const anthropicResp = translateResponse(openaiResp, requestModel, translateReasoning);
  return new Response(JSON.stringify(anthropicResp), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Pattern 1: idle timeout for upstream SSE. If no bytes arrive for this many
 * milliseconds, the upstream fetch is aborted with reason='timeout'.
 * Bridge-level safety net — providers occasionally drop the TCP socket
 * silently mid-stream (no FIN), and without an idle bound we'd block on
 * `reader.read()` forever.
 */
const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

// Exported for the streaming-usage integration test (issue #277): drives the
// real parse→translate pipeline from a synthetic upstream Response so the
// `[DONE]`-driven finalization can be asserted without mocking the network.
export function handleStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  translateReasoning: boolean,
  log: (msg: string) => void,
  thoughtSignatureCache: Map<string, string> | undefined,
  upstreamController: AbortController,
  downstreamSignal: AbortSignal | undefined,
  onDownstreamAbort: () => void,
): Response {
  // Pattern 2 §2.3.3 — TransformStream pipeline replaces the manual
  // ReadableStream { start } loop. The pipeline is:
  //
  //   upstream body  ── pipeThrough ──> sseParseTransform ──> translateTransform ──> response.body
  //
  // Backpressure: when the downstream (Hono response → Rust proxy → renderer)
  // is slow, `pipeThrough` automatically applies pull pressure on the upstream
  // reader through the chain. We don't need to manually check desiredSize —
  // the readable side of each TransformStream stops calling transform() once
  // its internal queue fills up, which in turn stops the upstream reader.
  //
  // Cancellation: downstream cancel propagates via the readable's cancel(),
  // which we wire to abort the upstream fetch (Pattern 1's protocol).
  const translator = new StreamTranslator(requestModel, translateReasoning);
  const sseParser = new SSEParser();
  if (!upstreamResp.body) {
    // Detach the downstream-abort listener the main handler wired to
    // request.signal before handing us lifecycle ownership. Every other exit
    // path (done/error/cancel) calls detachDownstream(); this rare empty-body
    // return must too, or the listener leaks for the request's lifetime.
    if (downstreamSignal) {
      try { downstreamSignal.removeEventListener('abort', onDownstreamAbort); } catch { /* ignore */ }
    }
    return new Response('', { status: 200, headers: streamHeaders() });
  }

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log(`[bridge] Upstream idle ${UPSTREAM_IDLE_TIMEOUT_MS}ms — aborting (reason=timeout)`);
      try { upstreamController.abort(new Error('Upstream idle timeout')); } catch { /* ignore */ }
    }, UPSTREAM_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  const cleanupIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const detachDownstream = (): void => {
    if (downstreamSignal) {
      try { downstreamSignal.removeEventListener('abort', onDownstreamAbort); } catch { /* ignore */ }
    }
  };

  // Stage 1: bytes → SSE events (parse via SSEParser).
  const decoder = new TextDecoder();
  const sseParseTransform = new TransformStream<Uint8Array, ChatPipelineItem>({
    start() {
      armIdleTimer();
    },
    transform(chunk, controller) {
      armIdleTimer();
      const text = decoder.decode(chunk, { stream: true });
      const sseEvents = sseParser.feed(text);
      for (const sseEvent of sseEvents) {
        if (sseEvent.data === '[DONE]') {
          // Protocol terminator — forward as the finalize signal (see STREAM_DONE).
          controller.enqueue(STREAM_DONE);
          continue;
        }
        try {
          controller.enqueue(JSON.parse(sseEvent.data) as OpenAIStreamChunk);
        } catch {
          // Skip malformed chunks
        }
      }
    },
    flush() {
      cleanupIdleTimer();
    },
  });

  // Stage 2: OpenAI chunks → Anthropic events.
  const encoder = new TextEncoder();
  const translateTransform = new TransformStream<ChatPipelineItem, Uint8Array>({
    transform(chunk, controller) {
      // Protocol terminator: finalize now (emits terminal message_delta/message_stop
      // with the fully-accumulated usage), THEN end the downstream response.
      // flush() below is the fallback for streams that close without a [DONE];
      // finalize() is idempotent, so no double-emit.
      //
      // We must close downstream here, not wait for transport EOF: the Anthropic
      // SDK's SSE reader loops until the HTTP body ends (it does NOT stop on
      // message_stop — see @anthropic-ai/sdk core/streaming.js), so a provider
      // that sends [DONE] then lingers would otherwise hang the SDK until the
      // 60s idle-timeout abort. terminate() closes the readable (the enqueued
      // finalize bytes drain first, the SDK then sees a clean EOF) and unwinds
      // the pipeline; we also clear the idle timer and abort the upstream fetch
      // to release a lingering provider socket. See issue #277.
      if (chunk === STREAM_DONE) {
        for (const event of translator.finalize()) {
          controller.enqueue(encoder.encode(formatSSE(event)));
        }
        cleanupIdleTimer();
        controller.terminate();
        try { upstreamController.abort(new Error('Upstream [DONE]')); } catch { /* ignore */ }
        return;
      }
      // Cache thought_signatures from streaming tool call chunks (Gemini thinking models).
      if (thoughtSignatureCache) {
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              const sig = tc.thought_signature
                || tc.extra_content?.google?.thought_signature;
              if (sig) {
                thoughtSignatureCache.set(tc.id, sig);
                log(`[bridge] Cached thought_signature for ${tc.id} (len=${sig.length})`);
              }
            }
          }
          // Evict oldest if over cap
          if (thoughtSignatureCache.size > THOUGHT_SIG_CACHE_MAX) {
            const excess = thoughtSignatureCache.size - THOUGHT_SIG_CACHE_MAX;
            const iter = thoughtSignatureCache.keys();
            for (let i = 0; i < excess; i++) {
              thoughtSignatureCache.delete(iter.next().value!);
            }
          }
        }
      }
      const anthropicEvents = translator.feed(chunk);
      for (const event of anthropicEvents) {
        controller.enqueue(encoder.encode(formatSSE(event)));
      }
    },
    flush(controller) {
      // Emit closing events for incomplete streams (no-op if already finished).
      const finalEvents = translator.finalize();
      for (const event of finalEvents) {
        controller.enqueue(encoder.encode(formatSSE(event)));
      }
      detachDownstream();
    },
  });

  // Compose the pipeline. piped through cancels propagate up through
  // pipeThrough; failures in either transform are caught when the consumer
  // reads the response body, which Hono surfaces as a 500.
  const upstreamReadable = upstreamResp.body;
  const finalReadable = upstreamReadable
    .pipeThrough(sseParseTransform)
    .pipeThrough(translateTransform);

  // Wrap once more to catch downstream cancellation and route it back to the
  // upstream AbortController. pipeThrough() forwards cancel() through each
  // stage, but our Pattern 1 contract demands we ALSO abort the upstream
  // fetch, which neither TransformStream knows about.
  //
  // Backpressure: drive the read loop from `pull()` rather than recursing
  // unconditionally after each enqueue. Web Streams calls `pull` once per
  // "queue has room"; if we recurse after enqueue we drain the upstream as
  // fast as it produces and the pipeline's natural backpressure is silently
  // broken (the queue grows unbounded).
  const reader = finalReadable.getReader();
  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          try { controller.close(); } catch { /* ignore */ }
          cleanupIdleTimer();
          // Fix #8: detach the downstream-abort listener on the done path
          // too. Without this, request.signal kept a strong ref to
          // onDownstreamAbort until GC, leaking listeners across streamed
          // sessions. Also covers the "upstream errored before any chunk"
          // case — pull sees done:true immediately and the listener would
          // otherwise survive until process exit.
          detachDownstream();
          return;
        }
        controller.enqueue(value);
        // Don't recurse — Web Streams will call pull() again when desiredSize > 0.
      } catch (err) {
        log(`[bridge] Stream error: ${err}`);
        try { controller.error(err); } catch { /* ignore */ }
        cleanupIdleTimer();
        detachDownstream();
      }
    },
    cancel(reason): void {
      const reasonStr = reason instanceof Error ? reason.message : String(reason ?? 'unknown');
      log(`[bridge] Downstream cancelled stream: ${reasonStr.slice(0, 200)}`);
      cleanupIdleTimer();
      detachDownstream();
      try { upstreamController.abort(new Error('Downstream cancel')); } catch { /* ignore */ }
      try {
        // Cancel the composed pipe — this propagates to the SSE parse
        // transform's source (the upstream body reader) automatically.
        finalReadable.cancel(reason).catch((e) => {
          // Fix #8: surface (debug) the "stream is locked" path that the
          // legacy code silently swallowed — we still don't want it as a
          // warning (cancel after pipeThrough often hits this), but
          // observable for diagnostics.
          console.debug(`[bridge] cancel() on finalReadable failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      } catch { /* ignore */ }
    },
  });

  return new Response(guarded, {
    status: 200,
    headers: streamHeaders(),
  });
}

function streamHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  };
}

// ==================== Responses API handlers ====================

async function handleResponsesNonStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  log: (msg: string) => void,
): Promise<Response> {
  let responsesResp: ResponsesResponse;
  try {
    const text = await upstreamResp.text();
    responsesResp = JSON.parse(text) as ResponsesResponse;
  } catch {
    log('[bridge] Failed to parse upstream Responses JSON');
    return jsonError(502, 'api_error', 'Invalid upstream response');
  }

  try {
    const anthropicResp = translateResponsesResponse(responsesResp, requestModel);
    return new Response(JSON.stringify(anthropicResp), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof ResponsesApiError) {
      log(`[bridge] Responses API failed: [${err.code}] ${err.message}`);
      return jsonError(502, err.code, err.message);
    }
    throw err;
  }
}

// Exported for the streaming-usage integration test (issue #277) — see
// handleStreamResponse above.
export function handleResponsesStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  log: (msg: string) => void,
  upstreamController: AbortController,
  downstreamSignal: AbortSignal | undefined,
  onDownstreamAbort: () => void,
): Response {
  // Pattern 2 §2.3.3 — TransformStream pipeline (mirror of handleStreamResponse).
  const translator = new ResponsesStreamTranslator(requestModel);
  const sseParser = new SSEParser();
  if (!upstreamResp.body) {
    // See handleStreamResponse: detach the request.signal listener so the rare
    // empty-body return doesn't leak it.
    if (downstreamSignal) {
      try { downstreamSignal.removeEventListener('abort', onDownstreamAbort); } catch { /* ignore */ }
    }
    return new Response('', { status: 200, headers: streamHeaders() });
  }

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log(`[bridge] Upstream Responses idle ${UPSTREAM_IDLE_TIMEOUT_MS}ms — aborting (reason=timeout)`);
      try { upstreamController.abort(new Error('Upstream idle timeout')); } catch { /* ignore */ }
    }, UPSTREAM_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  const cleanupIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const detachDownstream = (): void => {
    if (downstreamSignal) {
      try { downstreamSignal.removeEventListener('abort', onDownstreamAbort); } catch { /* ignore */ }
    }
  };

  const decoder = new TextDecoder();
  const sseParseTransform = new TransformStream<Uint8Array, ResponsesStreamEvent>({
    start() { armIdleTimer(); },
    transform(chunk, controller) {
      armIdleTimer();
      const text = decoder.decode(chunk, { stream: true });
      const sseEvents = sseParser.feed(text);
      for (const sseEvent of sseEvents) {
        // Intentional asymmetry vs the Chat path: the Responses translator
        // finalizes inline on `response.completed`/`response.failed` (its real
        // protocol terminators), so `[DONE]` — which isn't part of the OpenAI
        // Responses streaming spec — is simply dropped here. The idle-timeout
        // covers a (non-spec) provider that sends only `[DONE]`. See issue #277.
        if (sseEvent.data === '[DONE]') continue;
        try {
          controller.enqueue(JSON.parse(sseEvent.data) as ResponsesStreamEvent);
        } catch {
          /* skip malformed */
        }
      }
    },
    flush() { cleanupIdleTimer(); },
  });

  const encoder = new TextEncoder();
  const translateTransform = new TransformStream<ResponsesStreamEvent, Uint8Array>({
    transform(event, controller) {
      const anthropicEvents = translator.feed(event);
      for (const ae of anthropicEvents) {
        controller.enqueue(encoder.encode(formatSSE(ae)));
      }
      // The Responses translator finalizes inline on `response.completed` /
      // `response.failed` (emits message_stop). That is the protocol terminator,
      // so end the downstream response NOW rather than waiting for transport EOF
      // — same liveness fix as the Chat path: the SDK reads until EOF, so a
      // provider that lingers after the terminal event would otherwise hang it
      // until the idle-timeout abort. See issue #277.
      if (anthropicEvents.some((ae) => ae.type === 'message_stop')) {
        cleanupIdleTimer();
        controller.terminate();
        try { upstreamController.abort(new Error('Upstream response complete')); } catch { /* ignore */ }
      }
    },
    flush(controller) {
      const finalEvents = translator.finalize();
      for (const event of finalEvents) {
        controller.enqueue(encoder.encode(formatSSE(event)));
      }
      detachDownstream();
    },
  });

  const finalReadable = upstreamResp.body
    .pipeThrough(sseParseTransform)
    .pipeThrough(translateTransform);

  // Backpressure: pull-driven, see notes in handleStreamResponse.
  const reader = finalReadable.getReader();
  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          try { controller.close(); } catch { /* ignore */ }
          cleanupIdleTimer();
          // Fix #8: detach downstream listener on done too — covers both
          // normal completion and "upstream errored before any chunk" path
          // (immediate done:true without a flush).
          detachDownstream();
          return;
        }
        controller.enqueue(value);
        // Don't recurse — Web Streams will call pull() again when desiredSize > 0.
      } catch (err) {
        log(`[bridge] Responses stream error: ${err}`);
        try { controller.error(err); } catch { /* ignore */ }
        cleanupIdleTimer();
        detachDownstream();
      }
    },
    cancel(reason): void {
      const reasonStr = reason instanceof Error ? reason.message : String(reason ?? 'unknown');
      log(`[bridge] Downstream cancelled Responses stream: ${reasonStr.slice(0, 200)}`);
      cleanupIdleTimer();
      detachDownstream();
      try { upstreamController.abort(new Error('Downstream cancel')); } catch { /* ignore */ }
      try {
        finalReadable.cancel(reason).catch((e) => {
          console.debug(`[bridge] cancel() on Responses finalReadable failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      } catch { /* ignore */ }
    },
  });

  return new Response(guarded, {
    status: 200,
    headers: streamHeaders(),
  });
}

function jsonError(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Extract and cache thought_signatures from tool calls (non-stream response).
 * Checks both direct thought_signature and extra_content.google.thought_signature (Gemini OpenAI-compat). */
function cacheThoughtSignatures(
  toolCalls: { id: string; thought_signature?: string; extra_content?: { google?: { thought_signature?: string } } }[] | undefined,
  cache: Map<string, string>,
  maxSize = THOUGHT_SIG_CACHE_MAX,
): void {
  if (!toolCalls) return;
  for (const tc of toolCalls) {
    const sig = tc.thought_signature || tc.extra_content?.google?.thought_signature;
    if (tc.id && sig) {
      cache.set(tc.id, sig);
    }
  }
  // Evict oldest entries if cache exceeds max size
  if (cache.size > maxSize) {
    const excess = cache.size - maxSize;
    const iter = cache.keys();
    for (let i = 0; i < excess; i++) {
      cache.delete(iter.next().value!);
    }
  }
}
