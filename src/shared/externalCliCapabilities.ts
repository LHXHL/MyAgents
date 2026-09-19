/**
 * Public, token-authenticated CLI surface for local programs.
 *
 * This is deliberately narrower than the installed CLI command registry. The
 * Node Host uses canonical route identities for admission, while the CLI and
 * Settings UI consume the same declaration for help and documentation.
 */
export const EXTERNAL_CLI_PUBLIC_CAPABILITIES = [
  { command: 'status', route: 'status' },
  { command: 'version', route: 'version' },
  { command: 'agent create', route: 'agent/create' },
  { command: 'agent list', route: 'agent/list' },
  { command: 'agent show', route: 'agent/show' },
  { command: 'runtime list', route: 'runtime/list' },
  { command: 'runtime describe', route: 'runtime/describe' },
  { command: 'session list', route: 'session/list' },
  { command: 'session start', route: 'session/start' },
  { command: 'session send', route: 'session/send' },
  { command: 'session get', route: 'session/get' },
  { command: 'task list', route: 'task/list' },
  { command: 'task get', route: 'task/get' },
  { command: 'task comments', route: 'task/comments' },
  { command: 'task create-direct', route: 'task/create-direct' },
  { command: 'task update', route: 'task/update' },
  { command: 'task update-status', route: 'task/update-status' },
  { command: 'task run', route: 'task/run' },
  { command: 'task rerun', route: 'task/rerun' },
  { command: 'task run-now', route: 'task/run-now' },
  { command: 'task start', route: 'cron/start' },
  { command: 'task stop', route: 'cron/stop' },
  { command: 'task runs', route: 'cron/runs' },
  { command: 'task trigger validate', route: 'task/trigger/validate' },
  { command: 'task trigger test', route: 'task/trigger/test' },
  { command: 'task check-now', route: 'task/check-now' },
  { command: 'task reset-checkpoint', route: 'task/reset-checkpoint' },
  { command: 'task append-session', route: 'task/append-session' },
  { command: 'task archive', route: 'task/archive' },
  { command: 'task delete', route: 'task/delete' },
  { command: 'task readme', route: 'readme/task' },
  { command: 'record list', route: 'record/list' },
  { command: 'record create', route: 'record/create' },
] as const;

export type ExternalCliPublicRoute =
  typeof EXTERNAL_CLI_PUBLIC_CAPABILITIES[number]['route'];

export const EXTERNAL_CLI_PUBLIC_ROUTES: readonly ExternalCliPublicRoute[] =
  EXTERNAL_CLI_PUBLIC_CAPABILITIES.map(({ route }) => route);

const EXTERNAL_CLI_PUBLIC_ROUTE_SET = new Set<string>(EXTERNAL_CLI_PUBLIC_ROUTES);

export function isExternalCliPublicRoute(route: string): route is ExternalCliPublicRoute {
  return EXTERNAL_CLI_PUBLIC_ROUTE_SET.has(route);
}

export const EXTERNAL_CLI_PUBLIC_COMMANDS =
  EXTERNAL_CLI_PUBLIC_CAPABILITIES.map(({ command }) => command);

export const EXTERNAL_CLI_TOKEN_ENV = 'MYAGENTS_API_TOKEN';
export const INTERNAL_CLI_TOKEN_ENV = 'MYAGENTS_INTERNAL_CLI_TOKEN';
export const INTERNAL_CLI_TOKEN_HEADER = 'x-myagents-internal-cli-token';
