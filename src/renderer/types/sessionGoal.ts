export type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'canceled';

export interface GoalEndConditions {
  deadline?: string;
  maxExecutions?: number;
  aiCanExit: boolean;
}

export interface SessionGoalConfig {
  workspacePath: string;
  sessionId: string;
  objective: string;
  endConditions: GoalEndConditions;
  notifyEnabled: boolean;
  permissionMode?: string;
}

export interface SessionGoal {
  id: string;
  workspacePath: string;
  sessionId: string;
  objective: string;
  status: GoalStatus;
  endConditions: GoalEndConditions;
  notifyEnabled: boolean;
  permissionMode: string;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  lastExecutedAt?: string;
  terminalReason?: string;
  revision: number;
  controlRevision: number;
  isExecuting: boolean;
  executionNumber?: number;
}

export interface GoalChangedPayload {
  goalId: string;
  sessionId: string;
  workspacePath: string;
  goalRevision: number;
  goal: SessionGoal;
}

export function isTerminalGoalStatus(status: GoalStatus | undefined): boolean {
  return status === 'complete' || status === 'blocked' || status === 'canceled';
}
