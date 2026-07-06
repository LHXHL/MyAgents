import { describe, expect, it } from 'vitest';

import { resolveSkillUrl, SkillUrlError } from './url-resolver';

describe('resolveSkillUrl', () => {
  it('accepts https raw package URLs', () => {
    const resolved = resolveSkillUrl('https://example.com/skill.zip');

    expect(resolved.kind).toBe('raw-zip');
    expect(resolved.rawZipUrl).toBe('https://example.com/skill.zip');
  });

  it('rejects http raw package URLs', () => {
    expect(() => resolveSkillUrl('http://example.com/skill.zip')).toThrow(SkillUrlError);
  });
});
