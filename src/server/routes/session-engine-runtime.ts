import {
  getPermissionResponseEngine,
  getSessionEngine,
  getSessionEngineKind,
  getSessionRuntimeType,
  type SessionEngine,
} from '../session-engine';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export type SessionEngineRuntimeRouteDeps = {
  workspacePath: string;
  resolvePrewarmSessionId(requestedSessionId: string | undefined): string;
};

type RuntimeConfigSource = Exclude<
  NonNullable<Parameters<SessionEngine['updateRuntimeConfig']>[1]>['source'],
  undefined
>;

const RUNTIME_CONFIG_SOURCES = new Set<RuntimeConfigSource>([
  'runtime-config',
  'message-snapshot',
  'desktop',
  'im-sync',
  'cron-sync',
  'adopt-sync',
]);

function parseRuntimeConfigSource(value: unknown): RuntimeConfigSource {
  return typeof value === 'string' && RUNTIME_CONFIG_SOURCES.has(value as RuntimeConfigSource)
    ? value as RuntimeConfigSource
    : 'runtime-config';
}

export async function handleSessionEngineRuntimeRoute(
  pathname: string,
  request: Request,
  deps: SessionEngineRuntimeRouteDeps,
): Promise<Response | null> {
  if (pathname === '/api/runtime/config' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as {
      runtime?: string;
      runtimeConfig?: {
        model?: string | null;
        permissionMode?: string | null;
        reasoningEffort?: string | null;
      } | null;
      source?: unknown;
    };
    const activeRuntime = getSessionRuntimeType();
    if (getSessionEngineKind() === 'builtin') {
      return jsonResponse({ success: false, error: 'Runtime config endpoint is only for external runtimes' }, 400);
    }
    if (body.runtime && body.runtime !== activeRuntime) {
      return jsonResponse({ success: false, error: `Runtime mismatch: sidecar=${activeRuntime}, payload=${body.runtime}` }, 400);
    }

    const runtimeConfig = body.runtimeConfig ?? {};
    const source = parseRuntimeConfigSource(body.source);
    const result = await getSessionEngine().updateRuntimeConfig({
      ...('model' in runtimeConfig ? { model: runtimeConfig.model ?? '' } : {}),
      ...('permissionMode' in runtimeConfig ? { permissionMode: runtimeConfig.permissionMode ?? '' } : {}),
      ...('reasoningEffort' in runtimeConfig ? { reasoningEffort: runtimeConfig.reasoningEffort ?? '' } : {}),
    }, { source });

    return jsonResponse(result, result.success ? 200 : 500);
  }

  if (pathname === '/api/runtime/prewarm' && request.method === 'POST') {
    if (getSessionEngineKind() === 'builtin') {
      return jsonResponse({ success: false, error: 'Pre-warm is only for external runtimes' }, 400);
    }
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      model?: string;
      permissionMode?: string;
    };
    const sessionId = deps.resolvePrewarmSessionId(body.sessionId);
    if (!sessionId) {
      return jsonResponse({ success: false, error: 'No sessionId available' }, 400);
    }
    try {
      const result = await getSessionEngine().prewarm({
        sessionId,
        workspacePath: deps.workspacePath,
        model: body.model,
        permissionMode: body.permissionMode,
      });
      return jsonResponse({ success: true, ...result });
    } catch (error) {
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
        500,
      );
    }
  }

  if (pathname === '/api/runtime/permission-response' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const requestId = body.requestId as string;
    const decision: 'deny' | 'allow_once' | 'always_allow' = (body.decision as string) === 'deny' ? 'deny'
      : (body.decision as string) === 'always_allow' ? 'always_allow'
      : (body.decision as string) === 'allow_once' ? 'allow_once'
      : (body.approved === true) ? 'allow_once' : 'deny';
    const reason = body.reason as string | undefined;
    if (!requestId) return jsonResponse({ error: 'Missing requestId' }, 400);
    try {
      const success = await getPermissionResponseEngine().respondPermission(requestId, decision, reason);
      return jsonResponse({ success });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  }

  return null;
}
