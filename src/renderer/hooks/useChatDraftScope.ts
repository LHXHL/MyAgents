import { useLayoutEffect, useRef, type RefObject } from "react";
import type { SimpleChatInputHandle } from "@/components/chat-input/types";
import { isPendingSessionId } from "../../shared/constants";

/** Composer annotations belong to its conversation, while visible text may be
 * kept as a draft. A pending→real birth keeps the original conversation. */
export function useChatDraftScope(
  sessionId: string | null,
  discussionId: string | undefined,
  input: RefObject<Pick<SimpleChatInputHandle, "clearQueryContext"> | null>,
) {
  const previous = useRef({ sessionId, discussionId });
  useLayoutEffect(() => {
    const old = previous.current;
    const discussionChanged = old.discussionId !== discussionId;
    const sameBirth =
      old.sessionId && isPendingSessionId(old.sessionId) && !discussionChanged;
    if (discussionChanged || (old.sessionId !== sessionId && !sameBirth))
      input.current?.clearQueryContext();
    previous.current = { sessionId, discussionId };
  }, [sessionId, discussionId, input]);
}
