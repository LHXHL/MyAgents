import { cancellableFetch } from './cancellation';
import { readLoopbackJson } from './loopback-response';

export const ADMIN_LOOPBACK_TIMEOUT_MS = 10_000;

const MGMT_PORT = process.env.MYAGENTS_MANAGEMENT_PORT;
const SIDECAR_GENERATION = process.env.MYAGENTS_SIDECAR_GENERATION;

export async function managementApi(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!MGMT_PORT) {
    return {
      ok: false,
      error: 'Management API not available (app may still be starting)',
      recoveryHint: {
        recoveryCommand: 'myagents status',
        message: 'Check whether the app backend is fully up; if not, retry in a few seconds.',
      },
    };
  }
  const url = `http://127.0.0.1:${MGMT_PORT}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(SIDECAR_GENERATION
        ? { 'X-MyAgents-Sidecar-Generation': SIDECAR_GENERATION }
        : {}),
    },
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }
  try {
    const resp = await cancellableFetch(url, options, { timeoutMs: ADMIN_LOOPBACK_TIMEOUT_MS });
    return await readLoopbackJson(resp, 'Management API');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: method === 'POST' ? 'transport_outcome_unknown' : 'management_unavailable',
      error: `Management API unreachable: ${msg}`,
      recoveryHint: {
        recoveryCommand: 'myagents status',
        message: 'Check backend health; restart the app if the problem persists.',
      },
    };
  }
}
