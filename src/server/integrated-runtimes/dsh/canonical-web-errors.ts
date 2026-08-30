export type DshCanonicalWebErrorCode =
  | 'network_policy_denied'
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
