import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { BackgroundFailureFeedback } from "@/utils/backgroundFailureFeedback";

export type BackgroundRequestResult<T> =
  | { success: true; value: T }
  | { success: false; error?: unknown };

interface RequestScope {
  active: boolean;
  identity: { key: string; enabled: boolean };
  feedback: BackgroundFailureFeedback;
  requests: Map<string, number>;
}

/** Only automatic callers opt in. Manual actions retain their existing error
 * feedback. A discarded scope cannot notify, reset a streak, or launch work. */
export function useBackgroundRequestFeedback(
  scopeKey: string,
  enabled: boolean,
  onError: (error: unknown) => void,
) {
  const onErrorRef = useRef(onError);
  useLayoutEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  const identity = useMemo(
    () => ({ key: scopeKey, enabled }),
    [scopeKey, enabled],
  );
  const scopeRef = useRef<RequestScope | null>(null);
  useLayoutEffect(() => {
    const previous = scopeRef.current;
    const scope: RequestScope = {
      identity,
      active: identity.enabled,
      feedback:
        previous?.identity.key === identity.key
          ? previous.feedback
          : new BackgroundFailureFeedback(),
      requests: new Map(),
    };
    scopeRef.current = scope;
    return () => {
      scope.active = false;
    };
  }, [identity]);

  return useCallback(
    <T>(
      requestKey: string,
      request: () => Promise<T>,
    ): Promise<BackgroundRequestResult<T>> => {
      const scope = scopeRef.current;
      if (!scope?.active || scope.identity !== identity) {
        return Promise.resolve({ success: false });
      }
      const sequence = (scope.requests.get(requestKey) ?? 0) + 1;
      scope.requests.set(requestKey, sequence);
      // The API owner keeps its own force/coalescing semantics. For presentation,
      // only the latest caller for this resource can count a joined completion.
      const isCurrent = () =>
        scope.active &&
        scopeRef.current === scope &&
        scope.requests.get(requestKey) === sequence;
      return (async (): Promise<BackgroundRequestResult<T>> => {
        try {
          const value = await request();
          if (!isCurrent()) return { success: false };
          scope.feedback.succeeded(requestKey);
          return { success: true, value };
        } catch (error) {
          if (!isCurrent()) return { success: false };
          if (scope.feedback.failed(requestKey, Date.now()))
            onErrorRef.current(error);
          return { success: false, error };
        }
      })();
    },
    [identity],
  );
}
