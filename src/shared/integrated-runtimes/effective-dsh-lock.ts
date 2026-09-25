import releaseLock from "./dsh-lock.json";

// The build driver replaces this constant with the verified handoff identity.
// Source-mode tests and unprepared development continue to use the committed lock.
declare const __MYAGENTS_DSH_BUILD_LOCK__: typeof releaseLock | undefined;

const effectiveDshLock = typeof __MYAGENTS_DSH_BUILD_LOCK__ === "undefined"
  ? releaseLock
  : __MYAGENTS_DSH_BUILD_LOCK__;

export default effectiveDshLock;
