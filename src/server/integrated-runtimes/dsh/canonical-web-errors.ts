export type DshCanonicalWebErrorCode =
  | 'network_policy_denied'
  | 'web_dns_failed'
  | 'web_connect_failed'
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
): DshCanonicalWebError {
  if (error instanceof DshCanonicalWebError) return error;
  const systemErrorClass = errorClass(error);
  const metadata = {
    systemErrorClass,
    phase: route === 'proxy' ? 'proxy_connect' as const : 'connect' as const,
    cause: error,
  };
  const code = systemErrorClass;
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
      route === 'proxy' ? 'Web proxy connection timed out' : 'Web request timed out',
      metadata,
    );
  }
  if (code && /(?:CERT|TLS|SSL)/u.test(code)) {
    return new DshCanonicalWebError('web_connect_failed', 'Web TLS connection failed', {
      ...metadata,
      phase: 'tls',
    });
  }
  return new DshCanonicalWebError(
    'web_connect_failed',
    route === 'proxy' ? 'Web request through the configured proxy failed' : 'Web connection failed',
    metadata,
  );
}
