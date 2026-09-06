export type DshCanonicalWebErrorCode =
  | 'network_policy_denied'
  | 'web_dns_failed'
  | 'web_connect_failed'
  | 'web_request_failed'
  | 'web_request_timeout'
  | 'unsafe_destination'
  | 'unsupported_content'
  | 'utility_model_failed'
  | 'web_search_unavailable'
  | 'domain_policy_invalid'
  | 'provider_search_failed';

export type DshCanonicalWebFailurePhase =
  | 'dns'
  | 'connect'
  | 'proxy_connect'
  | 'tls'
  | 'request'
  | 'request_construction'
  | 'response_headers'
  | 'response_body'
  | 'provider_response'
  | 'deadline';

type DshCanonicalWebErrorOptions = ErrorOptions & Readonly<{
  phase?: DshCanonicalWebFailurePhase;
  systemErrorClass?: string;
}>;

export class DshCanonicalWebError extends Error {
  readonly phase: DshCanonicalWebFailurePhase | undefined;
  readonly systemErrorClass: string | undefined;

  constructor(
    readonly code: DshCanonicalWebErrorCode,
    message: string,
    options?: DshCanonicalWebErrorOptions,
  ) {
    super(message, options);
    this.name = 'DshCanonicalWebError';
    this.phase = options?.phase;
    this.systemErrorClass = options?.systemErrorClass;
  }
}

export function dshCanonicalWebError(
  error: unknown,
  fallbackCode: DshCanonicalWebErrorCode,
  fallbackMessage: string,
): DshCanonicalWebError {
  return error instanceof DshCanonicalWebError
    ? error
    : new DshCanonicalWebError(fallbackCode, fallbackMessage, { cause: error });
}

function errorClass(error: unknown): string | undefined {
  let candidate = error;
  let fallbackName: string | undefined;
  for (let depth = 0; depth < 4 && candidate && typeof candidate === 'object'; depth += 1) {
    const code = Reflect.get(candidate, 'code');
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) return code;
    const name = Reflect.get(candidate, 'name');
    if (!fallbackName
      && typeof name === 'string'
      && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) {
      fallbackName = name;
    }
    candidate = Reflect.get(candidate, 'cause');
  }
  return fallbackName;
}

export function dshCanonicalWebTransportError(
  error: unknown,
  route: 'direct' | 'proxy' = 'direct',
  phase?: DshCanonicalWebFailurePhase,
): DshCanonicalWebError {
  if (error instanceof DshCanonicalWebError) return error;
  const systemErrorClass = errorClass(error);
  const metadata = {
    systemErrorClass,
    phase: phase ?? (route === 'proxy' ? 'proxy_connect' as const : 'connect' as const),
    cause: error,
  };
  const code = systemErrorClass;
  if (code === 'TypeError' || code === 'UND_ERR_INVALID_ARG' || code === 'UND_ERR_INVALID_RETURN_VALUE') {
    return new DshCanonicalWebError('web_request_failed', 'Web transport could not construct the request', {
      ...metadata,
      phase: phase ?? 'request_construction',
    });
  }
  if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'EAI_AGAIN') {
    return new DshCanonicalWebError('web_dns_failed', 'Web destination DNS lookup failed', {
      ...metadata,
      phase: 'dns',
    });
  }
  if (code === 'ETIMEDOUT'
    || code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'UND_ERR_HEADERS_TIMEOUT'
    || code === 'UND_ERR_BODY_TIMEOUT') {
    return new DshCanonicalWebError(
      'web_request_timeout',
      code === 'UND_ERR_BODY_TIMEOUT' ? 'Web response body timed out'
        : code === 'UND_ERR_HEADERS_TIMEOUT' ? 'Web response headers timed out'
        : route === 'proxy' ? 'Web proxy connection timed out' : 'Web request timed out',
      {
        ...metadata,
        phase: code === 'UND_ERR_BODY_TIMEOUT' ? 'response_body'
          : code === 'UND_ERR_HEADERS_TIMEOUT' ? 'response_headers' : metadata.phase,
      },
    );
  }
  if (code && /(?:CERT|TLS|SSL)/u.test(code)) {
    return new DshCanonicalWebError('web_connect_failed', 'Web TLS connection failed', {
      ...metadata,
      phase: 'tls',
    });
  }
  if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNREFUSED') {
    const connection = route === 'proxy' ? 'Web connection through the configured proxy' : 'Web connection';
    const failure = code === 'ECONNREFUSED' ? 'was refused' : 'closed before the response completed';
    return new DshCanonicalWebError(
      phase === 'response_body' ? 'web_request_failed' : 'web_connect_failed',
      `${connection} ${failure} (${code}). Check the destination${route === 'proxy' ? ' and proxy' : ''} availability, then retry.`,
      metadata,
    );
  }
  if (phase === 'response_body') {
    return new DshCanonicalWebError('web_request_failed', 'Web response body could not be read', metadata);
  }
  const message = route === 'proxy' ? 'Web request through the configured proxy failed' : 'Web connection failed';
  return new DshCanonicalWebError('web_connect_failed', code ? `${message} (${code})` : message, metadata);
}
