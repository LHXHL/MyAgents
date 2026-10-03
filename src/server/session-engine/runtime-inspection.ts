import type { RuntimeType } from '../../shared/types/runtime';
import { getExternalRuntime } from '../runtimes/factory';
import { getSessionEngine } from './selector';

/** Ask the Session owner first; an installation-only probe never starts a Session. */
export async function inspectRuntime(runtime: RuntimeType) {
  const active = await getSessionEngine().inspectRuntime?.(runtime);
  if (active) return active;
  if (runtime === 'builtin') return null;
  return await getExternalRuntime(runtime).inspectRuntime?.() ?? null;
}
