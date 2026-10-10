/** SDK run IDs order executions of one task lexically; older emitters omit them. */
export function compareBackgroundTaskRuns(incoming?: string, current?: string): number {
  if (incoming === current) return 0;
  if (incoming === undefined) return -1;
  if (current === undefined) return 1;
  return incoming < current ? -1 : 1;
}
