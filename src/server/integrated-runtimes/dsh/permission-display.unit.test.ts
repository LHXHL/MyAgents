import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PermissionReview } from '../../../shared/types/runtime';
import { DshAttachmentRegistry } from './attachments';
import { dshPermissionReview } from './permission-display';
import { fetchRef, releaseLargeValueRef } from '../../utils/large-value-store';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const scope = { tool: 'WebSearch', permissionClass: 'network.search', target: 'provider:fixture-search', lifetimeMs: 60_000, owner: 'session_tree' } as const;

describe('DSH permission review projection', () => {
  it('preserves complete normalized search conditions, Agent and actual rule facts', async () => {
    const review: PermissionReview = {
      operation: { kind: 'web_search', query: 'example '.repeat(300), provider: 'fixture-search', allowedDomains: ['example.com'] },
      actor: { agentId: 'child-review', origin: 'foreground_child' }, scope,
    };
    expect(await dshPermissionReview({ review }, new DshAttachmentRegistry('/unused'), 'session-review')).toEqual({ review });
    expect(await dshPermissionReview({}, new DshAttachmentRegistry('/unused'), 'session-review')).toEqual({});
  });

  it('resolves Runtime attachment bytes through the existing registry and spills full details for the renderer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-permission-review-')); roots.push(root);
    vi.stubEnv('MYAGENTS_REFS_DIR', join(root, 'refs'));
    const attachments = new DshAttachmentRegistry(root); await attachments.initialize();
    const operation = { kind: 'command' as const, dialect: 'pwsh' as const, command: `Write-Output '${'完整'.repeat(40_000)}'`, cwd: '/workspace/child' };
    const review: PermissionReview = { operation, actor: { agentId: 'child-review', origin: 'background_child' }, scope: { ...scope, tool: 'pwsh', target: '/workspace/child', permissionClass: 'process.execute' } };
    const bytes = Buffer.from(JSON.stringify(review));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const stagingPath = join(root, 'review.json'); await writeFile(stagingPath, bytes);
    await attachments.put({ stagingPath, mimeType: 'application/json', sizeBytes: bytes.length, sha256 });
    const reviewRef = { attachmentId: `sha256:${sha256}`, mimeType: 'application/json' as const, sizeBytes: bytes.length, sha256 };
    const projected = await dshPermissionReview({ reviewRef }, attachments, 'session-review');
    expect(projected.review).toBeUndefined(); expect(projected.reviewRef).toBeDefined();
    const stored = await fetchRef(projected.reviewRef!.id);
    expect(JSON.parse(Buffer.from(stored!.data).toString())).toEqual({ ...review, operation });
    expect(projected.reviewRef?.preview).toBe('');
    await releaseLargeValueRef(projected.reviewRef!.id);
    expect(await fetchRef(projected.reviewRef!.id)).toBeNull();
    attachments.close();
  });
});
