import { describe, expect, it } from 'vitest';

import { selectCodexImageGenerationAttachmentSource } from './codex';

const SAVED_PATH = '/home/test/.myagents/codex/generated_images/thread/call.png';
const BASE64_RESULT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

describe('selectCodexImageGenerationAttachmentSource', () => {
  it('uses event bytes for managed Codex instead of referencing its credential-bearing home', () => {
    expect(selectCodexImageGenerationAttachmentSource('managed-provider', {
      savedPath: SAVED_PATH,
      result: BASE64_RESULT,
    })).toEqual({ kind: 'base64', data: BASE64_RESULT });
  });

  it('does not expose a managed Codex savedPath when event bytes are absent', () => {
    expect(selectCodexImageGenerationAttachmentSource('managed-provider', {
      savedPath: SAVED_PATH,
    })).toBeUndefined();
  });

  it('keeps the zero-copy savedPath preference for system Codex', () => {
    expect(selectCodexImageGenerationAttachmentSource('system-cli', {
      savedPath: '/home/test/.codex/generated_images/thread/call.png',
      result: BASE64_RESULT,
    })).toEqual({
      kind: 'externalPath',
      sourcePath: '/home/test/.codex/generated_images/thread/call.png',
    });
  });

  it('falls back to event bytes for system Codex when savedPath is absent', () => {
    expect(selectCodexImageGenerationAttachmentSource('system-cli', {
      result: BASE64_RESULT,
    })).toEqual({ kind: 'base64', data: BASE64_RESULT });
  });

  it('ignores empty and malformed sources', () => {
    expect(selectCodexImageGenerationAttachmentSource('managed-provider', {
      savedPath: '',
      result: 42,
    })).toBeUndefined();
  });
});
