import type { PermissionReview } from '../../../shared/types/runtime';
import type { LargeValueRef } from '../../../shared/types/large-value';
import { maybeSpill } from '../../utils/large-value-store';
import type { MethodParams } from './protocol-types';
import type { DshAttachmentRegistry } from './attachments';

/** The verified Runtime owns review facts; the Host only resolves the existing data-plane reference. */
export async function dshPermissionReview(
  details: Pick<MethodParams<'host/interaction/request'>, 'review' | 'reviewRef'>,
  attachments: DshAttachmentRegistry,
  sessionId: string,
): Promise<{ review?: PermissionReview; reviewRef?: LargeValueRef }> {
  const complete = details.reviewRef === undefined ? details.review : await attachments.readJson(details.reviewRef) as PermissionReview;
  if (complete === undefined) return {};
  const payload = await maybeSpill(JSON.stringify(complete), {
    mimetype: 'application/json', inlineMaxBytes: 65_536, previewBytes: 0, sessionId,
    // A pending human interaction owns this reference until settlement or Session cleanup.
    ttlMs: Number.MAX_SAFE_INTEGER - Date.now(),
  });
  return 'inline' in payload ? { review: complete } : { reviewRef: payload };
}
