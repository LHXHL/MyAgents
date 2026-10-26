import { getSessionEngine } from '../session-engine';
import { imRequestRegistry } from '../utils/im-request-registry';
import { imEventBus } from '../utils/im-event-bus';
import { buildImCancelledPayload } from '../utils/im-terminal-payload';

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** A retained outcome or active request already owns this input ID. */
export function existingImRequestResponse(requestId: string, sessionId: string | null): Response | null {
  return imRequestRegistry.outcome(requestId).state === 'unknown' ? null
    : jsonResponse({ success: true, requestId, accepted: true, sessionId });
}

/** Request status and cancellation share the original registry and Runtime owner. */
export async function handleImRequestLifecycle(request: Request): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  // Read producer outcomes independently of the lossy delta ring. Unknown
  // is explicit (expired/not admitted), never interpreted as completion.
  if (pathname === '/api/im/requests' && request.method === 'POST') {
    const body = await request.json() as { requestIds?: unknown; settleUnknown?: unknown };
    if (!Array.isArray(body.requestIds) || body.requestIds.length > 200
      || !body.requestIds.every(id => typeof id === 'string' && id.length <= 200)) {
      return jsonResponse({ error: 'Invalid requestIds' }, 400);
    }
    const settleUnknown = Array.isArray(body.settleUnknown) ? new Set(body.settleUnknown) : new Set();
    for (const id of body.requestIds) {
      if (settleUnknown.has(id) && imRequestRegistry.outcome(id).state === 'unknown') {
        imEventBus.emit(id, 'error', { finalPayloads: [{
          text: '请求执行状态已无法核对，请检查会话历史后重新发送。', isError: true,
        }] });
      }
    }
    const outcomes = Object.fromEntries(body.requestIds.map(id => [id, imRequestRegistry.outcome(id)]));
    return jsonResponse({ outcomes });
  }

  // POST /api/im/cancel — Pattern D: abort an in-flight IM request.
  // Body: { requestId, reason? }. Drives THREE cancellation paths:
  //   1. Registry AbortController.abort(reason) — stops route-owned Bridge
  //      discovery/admission waits before a runtime queue owner exists.
  //   2. cancelImRequest / cancelExternalImRequest — actual SDK-level cancel
  //      via interruptCurrentResponse (builtin) or stopExternalSession (external).
  //      This is what stops the SDK turn from burning tokens.
  //   3. imEventBus.emit('cancelled', ...) — Rust ReplyRouter sees this and
  //      closes the reply slot (UI feedback).
  if (pathname === '/api/im/cancel' && request.method === 'POST') {
    try {
      const body = (await request.json()) as {
        requestId: string;
        reason?: string;
      };
      if (!body.requestId) {
        return jsonResponse(
          { success: false, error: 'Missing requestId' },
          400,
        );
      }
      const reason = body.reason ?? 'user';
      const cancellationClaim = imRequestRegistry.claimCancellation(
        body.requestId,
        reason,
      );
      if (!cancellationClaim) {
        // Stop can precede a delayed enqueue body. Seal that same ID in
        // the existing receipts so it cannot start after its consumer left.
        // A real terminal already retained by the producer stays intact.
        if (imRequestRegistry.outcome(body.requestId).state === 'unknown') {
          imEventBus.emit(body.requestId, 'cancelled', buildImCancelledPayload());
        }
        return jsonResponse({ success: true, requestId: body.requestId });
      }

      // The registry AbortController is the atomic cancellation claim.
      // Concurrent retries observe the first caller's claim and must not
      // re-enter the runtime or steal its eventual terminal event.
      if (cancellationClaim.outcome === 'already-claimed') {
        return jsonResponse({
          success: true,
          requestId: body.requestId,
          mode:
            cancellationClaim.owner === 'admission-route'
              ? 'admission'
              : 'running',
          alreadyCancelling: true,
        });
      }

      // Step 1: the successful claim already aborted the registry signal,
      // covering route-owned discovery/admission waits.
      const admissionRouteOwned =
        cancellationClaim.owner === 'admission-route';

      // Step 2: actual SDK / queue cancel.
      const cancelResult = await getSessionEngine().cancelImRequest(
        body.requestId,
        reason,
      );

      // (v0.2.11 cross-bugfix #142 review-fix-3 medium #2)
      // Runtime `unknown` is safe only while this route still owns
      // admission: its abort signal guarantees the request cannot return
      // accepted or dispatch late. After ownership transfers to runtime,
      // unknown can be a promote-then-cancel race, so reporting success
      // would be dishonest while the SDK may continue processing.
      if (cancelResult.mode === 'unknown' && !admissionRouteOwned) {
        return jsonResponse(
          {
            success: false,
            requestId: body.requestId,
            mode: cancelResult.mode,
            error:
              'Request not in a cancellable state — message may already be in flight',
          },
          409,
        );
      }

      // Step 3: the route owns terminal delivery only before runtime
      // admission or for an item removed from a runtime queue. A running
      // turn keeps terminal ownership even if its result/finalizer has not
      // unregistered the registry entry by the time Step 2 returns.
      const routeOwnsTerminal =
        admissionRouteOwned || cancelResult.mode === 'queued';
      if (routeOwnsTerminal && imRequestRegistry.get(body.requestId)) {
        imEventBus.emit(
          body.requestId,
          'cancelled',
          buildImCancelledPayload(),
        );
        imRequestRegistry.unregister(body.requestId);
      }

      return jsonResponse({
        success: true,
        requestId: body.requestId,
        mode:
          cancelResult.mode === 'unknown' ? 'admission' : cancelResult.mode,
      });
    } catch (error) {
      console.error('[im/cancel] Error:', error);
      return jsonResponse(
        {
          success: false,
          error: error instanceof Error ? error.message : 'IM cancel error',
        },
        500,
      );
    }
  }

  return null;
}
