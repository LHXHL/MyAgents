import { describe, expect, it } from 'vitest';

import {
  clearGoalTurnAuthority,
  getGoalTurnAuthority,
  setGoalTurnAuthority,
} from './goal-turn-authority';

describe('Goal turn authority stack', () => {
  it('restores scheduler authority after a realtime user admission is cleared', () => {
    setGoalTurnAuthority({ sessionId: 'session-stack', goalId: 'goal-1', leaseId: 'lease-1' });
    setGoalTurnAuthority({ sessionId: 'session-stack', goalId: 'goal-1', admissionId: 'admission-1' });

    expect(getGoalTurnAuthority('session-stack')).toMatchObject({ admissionId: 'admission-1' });

    clearGoalTurnAuthority('session-stack', 'admission-1');
    expect(getGoalTurnAuthority('session-stack')).toMatchObject({ leaseId: 'lease-1' });

    clearGoalTurnAuthority('session-stack', 'lease-1');
    expect(getGoalTurnAuthority('session-stack')).toBeNull();
  });
});
