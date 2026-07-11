type GoalTurnAuthorityBase = {
  sessionId: string;
  goalId: string;
};

export type GoalTurnAuthority = GoalTurnAuthorityBase & (
  | { leaseId: string; admissionId?: never }
  | { admissionId: string; leaseId?: never }
);

const activeAuthorities = new Map<string, GoalTurnAuthority[]>();

type PendingGoalDispatch = {
  canceled: boolean;
};

const pendingDispatches = new Map<string, Map<string, PendingGoalDispatch>>();

export type GoalDispatchGuardToken = {
  isCanceled(): boolean;
  settle(): void;
};

export function beginGoalDispatchGuard(sessionId: string, authorityId: string): GoalDispatchGuardToken {
  const pending: PendingGoalDispatch = { canceled: false };
  const sessionPending = pendingDispatches.get(sessionId) ?? new Map<string, PendingGoalDispatch>();
  sessionPending.set(authorityId, pending);
  pendingDispatches.set(sessionId, sessionPending);
  return {
    isCanceled: () => pending.canceled,
    settle: () => {
      const current = pendingDispatches.get(sessionId);
      current?.delete(authorityId);
      if (current?.size === 0) pendingDispatches.delete(sessionId);
    },
  };
}

/** Cancel guards currently waiting on Rust admission responses in this Sidecar. */
export function cancelPendingGoalDispatches(): void {
  for (const sessionPending of pendingDispatches.values()) {
    for (const pending of sessionPending.values()) pending.canceled = true;
  }
}

export function getGoalTurnAuthority(sessionId: string): GoalTurnAuthority | null {
  return activeAuthorities.get(sessionId)?.at(-1) ?? null;
}

export function setGoalTurnAuthority(authority: GoalTurnAuthority): void {
  const authorityId = authority.leaseId ?? authority.admissionId;
  const existing = activeAuthorities.get(authority.sessionId) ?? [];
  const next = existing.filter(
    item => item.leaseId !== authorityId && item.admissionId !== authorityId,
  );
  next.push(authority);
  activeAuthorities.set(authority.sessionId, next);
}

export function clearGoalTurnAuthority(sessionId: string, authorityId: string): void {
  const current = activeAuthorities.get(sessionId) ?? [];
  const next = current.filter(item => item.leaseId !== authorityId && item.admissionId !== authorityId);
  if (next.length === 0) {
    activeAuthorities.delete(sessionId);
  } else {
    activeAuthorities.set(sessionId, next);
  }
}
