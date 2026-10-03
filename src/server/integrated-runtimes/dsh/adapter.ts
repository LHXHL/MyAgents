import { createExternalSessionEngine } from '../../session-engine/external-adapter';
import type { SessionEngine } from '../../session-engine/types';

/**
 * DSH keeps the Product SessionEngine taxonomy explicit while reusing the
 * established product transcript, queue, interaction, and delivery owners.
 * Native model conversation and execution remain owned by DshRuntime.
 */
export function createDshSessionEngine(): SessionEngine {
  return {
    ...createExternalSessionEngine(),
    kind: 'integrated',
  };
}
