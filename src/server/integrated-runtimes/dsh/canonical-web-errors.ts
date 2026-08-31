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

export class DshCanonicalWebError extends Error {
  constructor(
    readonly code: DshCanonicalWebErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DshCanonicalWebError';
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

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = Reflect.get(error, 'code');
  return typeof value === 'string' ? value : undefined;
}

export function dshCanonicalWebTransportError(error: unknown): DshCanonicalWebError {
  if (error instanceof DshCanonicalWebError) return error;
  const code = errorCode(error);
  if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'EAI_AGAIN') {
    return new DshCanonicalWebError('web_dns_failed', 'Web destination DNS lookup failed', { cause: error });
  }
  if (code === 'ETIMEDOUT') {
    return new DshCanonicalWebError('web_request_timeout', 'Web request timed out', { cause: error });
  }
  return new DshCanonicalWebError('web_connect_failed', 'Web connection failed', { cause: error });
}
