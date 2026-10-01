import { broadcast } from '../sse';
import { managementApi } from './management-api-client';

/** A durable commit invalidates both Sidecar subscribers and App-owned consumers.
 * Only routing metadata belongs in the event; consumers reread disk authorities.
 * A delivery error cannot undo an already committed write. Callers can surface
 * the returned result; startup/reconnect still reconstructs the current catalog. */
export async function broadcastAppConfigChanged(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  broadcast('config:changed', payload);
  const result = await managementApi('/api/app/config-changed', 'POST', {}, { timeoutMs: 2_000 });
  if (result.ok !== true) console.warn('[config-events] App invalidation not delivered code=%s', String(result.code ?? 'notification_failed'));
  return result;
}
