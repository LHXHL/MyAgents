import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { isCliProductSessionId } from '../../../shared/cli-session-scope';

/** The Host owns these two roots for exactly one Product Session. */
export function dshSessionOwnedPaths(dataRoot: string, productSessionId: string) {
  if (!isAbsolute(dataRoot) || !isCliProductSessionId(productSessionId)) {
    throw new Error('DSH owned roots require an absolute data root and canonical Product Session id');
  }
  const identity = createHash('sha256')
    .update('myagents-dsh-product-session-v1').update('\0').update(productSessionId).update('\0').digest('hex');
  return Object.freeze({
    runtimeHome: join(dataRoot, 'dsh-runtime', identity),
    attachmentRoot: join(dataRoot, 'dsh-attachments', identity),
  });
}
