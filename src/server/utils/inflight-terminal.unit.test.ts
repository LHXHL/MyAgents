import { describe, it, expect } from 'vitest';
import {
  decideInFlightActionOnResult,
  decideInFlightCancelSettlement,
  terminalEventMatchesInFlight,
} from './inflight-terminal';

describe('decideInFlightActionOnResult (issue #289 — force-send must surface, not drop)', () => {
  it('FORCE-send (the bug): interrupting + forced + has meta → surface (show the bubble)', () => {
    // This is the regression for #289: force was dropping the in-flight item even though
    // the SDK processes it. It MUST surface now.
    expect(decideInFlightActionOnResult({ isInterrupting: true, forced: true, hasMeta: true })).toBe('surface');
  });

  it('plain STOP drops only when the receipt explicitly omits the in-flight uuid', () => {
    expect(decideInFlightActionOnResult({
      isInterrupting: true,
      forced: false,
      hasMeta: true,
      survivedInterrupt: false,
    })).toBe('drop');
  });

  it('plain STOP preserves the queue when an older CLI returns no receipt', () => {
    expect(decideInFlightActionOnResult({
      isInterrupting: true,
      forced: false,
      hasMeta: true,
      survivedInterrupt: null,
    })).toBe('await-replay');
  });

  it('plain STOP preserves an in-flight item that the interrupt receipt says will still run', () => {
    expect(decideInFlightActionOnResult({
      isInterrupting: true,
      forced: false,
      hasMeta: true,
      survivedInterrupt: true,
    })).toBe('await-replay');
  });

  it('natural completion: not interrupting + has meta → await replay (no false queue:started)', () => {
    expect(decideInFlightActionOnResult({ isInterrupting: false, forced: false, hasMeta: true })).toBe('await-replay');
  });

  it('force but no meta (cannot build a bubble) → noop (defensive)', () => {
    expect(decideInFlightActionOnResult({ isInterrupting: true, forced: true, hasMeta: false })).toBe('noop');
  });

  it('natural completion but no meta → await replay', () => {
    expect(decideInFlightActionOnResult({ isInterrupting: false, forced: false, hasMeta: false })).toBe('await-replay');
  });

  it('forced wins over the stop drop even if both flags are set (force is the explicit intent)', () => {
    // forced=true must NOT be dropped by the `isInterrupting && !forced` stop rule.
    expect(decideInFlightActionOnResult({ isInterrupting: true, forced: true, hasMeta: true })).not.toBe('drop');
  });
});

describe('decideInFlightCancelSettlement', () => {
  it('SDK cancelled=true is the only path that clears local in-flight state and removes the queue pill', () => {
    expect(decideInFlightCancelSettlement('cancelled')).toEqual({
      cancelled: true,
      removePendingRequest: true,
      clearSlot: true,
      broadcastCancelled: true,
      promoteNext: true,
    });
  });

  it.each(['not-cancelled', 'unavailable', 'error'] as const)(
    'SDK %s keeps the in-flight item waiting for replay or assistant-start confirmation',
    (result) => {
      expect(decideInFlightCancelSettlement(result)).toEqual({
        cancelled: false,
        removePendingRequest: false,
        clearSlot: false,
        broadcastCancelled: false,
        promoteNext: false,
      });
    },
  );
});

describe('terminalEventMatchesInFlight', () => {
  it('does not apply an interrupt terminal event to a newly promoted in-flight item', () => {
    expect(terminalEventMatchesInFlight({
      currentQueueId: 'queue-b',
      isInterrupting: true,
      interruptTargetQueueId: 'queue-a',
    })).toBe(false);
  });

  it('applies an interrupt terminal event to the item that was in-flight when interrupt started', () => {
    expect(terminalEventMatchesInFlight({
      currentQueueId: 'queue-a',
      isInterrupting: true,
      interruptTargetQueueId: 'queue-a',
    })).toBe(true);
  });

  it('applies non-interrupt terminal events to the current in-flight item', () => {
    expect(terminalEventMatchesInFlight({
      currentQueueId: 'queue-a',
      isInterrupting: false,
      interruptTargetQueueId: null,
    })).toBe(true);
  });
});
