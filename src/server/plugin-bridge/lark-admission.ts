import { AsyncLocalStorage } from 'node:async_hooks';

type PluginAdmissionScope = {
  token: symbol;
  admitted: boolean;
  resolveAdmission: () => void;
};

export type PluginAdmissionExecution<T = unknown> = {
  admission: Promise<void>;
  completion: Promise<T>;
};

type PluginAdmissionGlobals = typeof globalThis & {
  __myagentsRunLarkAdmissionScopedTask?: <T>(task: () => Promise<T>) => PluginAdmissionExecution<T>;
  __myagentsCurrentLarkAdmissionToken?: () => symbol | undefined;
  __myagentsAwaitPluginAdmission?: (task: () => Promise<unknown>, onError: () => void) => Promise<void>;
};

const admissionStorage = new AsyncLocalStorage<PluginAdmissionScope>();

function runPluginAdmissionScopedTask<T>(task: () => Promise<T>): PluginAdmissionExecution<T> {
  let resolveAdmissionPromise!: () => void;
  const admission = new Promise<void>((resolve) => {
    resolveAdmissionPromise = resolve;
  });
  const scope: PluginAdmissionScope = {
    token: Symbol('plugin-chat-task'),
    admitted: false,
    resolveAdmission() {
      if (scope.admitted) return;
      scope.admitted = true;
      resolveAdmissionPromise();
    },
  };
  const completion = admissionStorage.run(scope, () => Promise.resolve().then(task));

  // Commands, filtered events, and setup failures may finish without reaching
  // Bridge → Rust ingress. Their completion is also their admission boundary,
  // so the next same-chat task must never remain parked behind them.
  void completion.then(scope.resolveAdmission, scope.resolveAdmission);
  return { admission, completion };
}

/** Install the two structural hooks used by the load-time plugin queue patches. */
export function installPluginAdmissionRuntimeGlobals(): void {
  const globals = globalThis as PluginAdmissionGlobals;
  globals.__myagentsRunLarkAdmissionScopedTask = runPluginAdmissionScopedTask;
  globals.__myagentsCurrentLarkAdmissionToken = () => admissionStorage.getStore()?.token;
  globals.__myagentsAwaitPluginAdmission = async (task, onError) => {
    const execution = runPluginAdmissionScopedTask(task);
    // Observe detached delivery failures without making input admission wait
    // for renderer cleanup. Each task retains its own ALS scope and callbacks.
    void execution.completion.catch(onError);
    await execution.admission;
  };
}

/** Release only the inbound-ordering lease; the plugin task stays alive until delivery completes. */
export function markCurrentPluginInboundAccepted(): boolean {
  const scope = admissionStorage.getStore();
  if (!scope) return false;
  scope.resolveAdmission();
  return true;
}

// Backward-compatible names for the existing Lark compatibility surface.
export const installLarkAdmissionRuntimeGlobals = installPluginAdmissionRuntimeGlobals;
export const markCurrentLarkInboundAccepted = markCurrentPluginInboundAccepted;
