const SILENT_HTTP_LOG_PATHS = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/health/functional',
  '/api/unified-log',
  '/api/session-state',
  '/agent/dir',
  '/sessions',
  '/api/commands',
  '/api/agents/enabled',
  '/api/git/branch',
]);

/** Successful poll/config reads have no per-request diagnostic value. */
export function shouldLogHttpRequest(pathname: string): boolean {
  return !SILENT_HTTP_LOG_PATHS.has(pathname);
}
