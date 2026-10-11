import { renderHook } from "@testing-library/react";
import { createRef } from "react";
import { expect, it, vi } from "vitest";
import type { SimpleChatInputHandle } from "@/components/chat-input/types";
import { useChatDraftScope } from "./useChatDraftScope";
it("preserves pending birth but drops the restored contract on explicit reset and history switch", () => {
  const clearQueryContext = vi.fn();
  const input = createRef<Pick<SimpleChatInputHandle, "clearQueryContext">>();
  input.current = { clearQueryContext };
  const { rerender } = renderHook(
    ({ sessionId, discussionId }) =>
      useChatDraftScope(sessionId, discussionId, input),
    {
      initialProps: {
        sessionId: "pending-tab",
        discussionId: "discussion" as string | undefined,
      },
    },
  );
  rerender({ sessionId: "born-session", discussionId: "discussion" });
  expect(clearQueryContext).not.toHaveBeenCalled();
  rerender({ sessionId: "history-session", discussionId: undefined });
  expect(clearQueryContext).toHaveBeenCalledTimes(1);
  rerender({ sessionId: "pending-reset", discussionId: "new-discussion" });
  clearQueryContext.mockClear();
  rerender({ sessionId: "reset-session", discussionId: undefined });
  expect(clearQueryContext).toHaveBeenCalledTimes(1);
});
