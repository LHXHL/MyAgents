import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  spaceAuthAck,
  spaceAuthPoll,
  spaceAuthStart,
  spaceErrorMessage,
} from "@/api/spaceCloud";
import { useToast } from "@/components/Toast";
import { trackSpaceAuth } from "@/pages/space/spaceMetrics";
const AUTH_POLL_DELAY_MS = 3000;
const AUTH_POLL_TIMEOUT_MS = 10 * 60 * 1000;

/** The official account login flow is shared by Team and Agent Network.
 * Consumers decide what to load after login; this hook never boots Space data. */
export function useMyAgentsLogin(
  isActive: boolean,
  onAuthenticated: () => Promise<void>,
) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const [authBusy, setAuthBusy] = useState(false);
  const [authFlow, setAuthFlow] = useState<{
    token: string;
    expiresAt: number;
  } | null>(null);
  const authPollWarningShownRef = useRef(false);
  const authPollWakeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!authFlow) return;
    let cancelled = false;

    const wakeAuthPoll = () => {
      authPollWakeRef.current?.();
    };

    const wakeAuthPollWhenVisible = () => {
      if (document.visibilityState === "visible") {
        wakeAuthPoll();
      }
    };

    const waitForNextPoll = (ms: number): Promise<void> => {
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        let timer: number | null = null;
        const finish = () => {
          if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
          }
          if (authPollWakeRef.current === finish) {
            authPollWakeRef.current = null;
          }
          resolve();
        };
        timer = window.setTimeout(finish, ms);
        authPollWakeRef.current = finish;
      });
    };

    const stopAuth = () => {
      authPollWarningShownRef.current = false;
      authPollWakeRef.current = null;
      setAuthFlow(null);
      setAuthBusy(false);
    };

    const poll = async () => {
      while (!cancelled && Date.now() < authFlow.expiresAt) {
        const startedAt = Date.now();
        try {
          const result = await spaceAuthPoll(authFlow.token);
          if (cancelled) return;
          if (result.status === "done") {
            stopAuth();
            toast.success(t("space.toasts.loginSuccess"));
            await onAuthenticated();
            trackSpaceAuth("success", true);
            void spaceAuthAck(authFlow.token).catch((error) => {
              console.warn(
                "[Space] auth ack failed:",
                spaceErrorMessage(error),
              );
            });
            return;
          }
          if (result.status === "failed") {
            stopAuth();
            toast.error(String(result.error ?? t("space.toasts.loginFailed")));
            trackSpaceAuth("failure", false, result.error ?? "failed");
            void spaceAuthAck(authFlow.token).catch((error) => {
              console.warn(
                "[Space] auth ack failed:",
                spaceErrorMessage(error),
              );
            });
            return;
          }
        } catch (_error) {
          if (cancelled) return;
          if (
            !authPollWarningShownRef.current &&
            Date.now() < authFlow.expiresAt
          ) {
            authPollWarningShownRef.current = true;
            toast.warning(t("space.toasts.loginSlow"));
          }
        }
        const elapsed = Date.now() - startedAt;
        await waitForNextPoll(Math.max(0, AUTH_POLL_DELAY_MS - elapsed));
      }

      if (!cancelled) {
        stopAuth();
        toast.error(t("space.toasts.loginTimeout"));
        trackSpaceAuth("failure", false, "timeout");
      }
    };

    window.addEventListener("focus", wakeAuthPoll);
    document.addEventListener("visibilitychange", wakeAuthPollWhenVisible);
    void poll();
    return () => {
      cancelled = true;
      wakeAuthPoll();
      window.removeEventListener("focus", wakeAuthPoll);
      document.removeEventListener("visibilitychange", wakeAuthPollWhenVisible);
    };
  }, [authFlow, onAuthenticated, t, toast]);

  useEffect(() => {
    if (authFlow && isActive) {
      authPollWakeRef.current?.();
    }
  }, [authFlow, isActive]);

  const startLogin = useCallback(async () => {
    setAuthBusy(true);
    trackSpaceAuth("start", true);
    try {
      const result = await spaceAuthStart();
      const serverExpiresInMs =
        Number.isFinite(result.expiresInSeconds) && result.expiresInSeconds > 0
          ? result.expiresInSeconds * 1000
          : AUTH_POLL_TIMEOUT_MS;
      authPollWarningShownRef.current = false;
      setAuthFlow({
        token: result.loginToken,
        expiresAt:
          Date.now() + Math.min(serverExpiresInMs, AUTH_POLL_TIMEOUT_MS),
      });
      toast.info(t("space.toasts.browserLoginOpened"));
    } catch (error) {
      setAuthBusy(false);
      trackSpaceAuth("failure", false, error);
      toast.error(spaceErrorMessage(error));
    }
  }, [t, toast]);

  return { authBusy, authFlow, startLogin };
}
