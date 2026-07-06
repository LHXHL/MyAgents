import { describe, expect, it } from 'vitest';

import {
  isBlockedSkillPackageHost,
  isSkillPackageUrlLexicallySafe,
} from './tarball-fetcher';

const check = (url: string) => isSkillPackageUrlLexicallySafe(new URL(url));

describe('skill tarball SSRF guard', () => {
  it('requires https package URLs', () => {
    expect(check('https://example.com/skill.zip').ok).toBe(true);
    expect(check('http://example.com/skill.zip').ok).toBe(false);
    expect(check('file:///etc/passwd').ok).toBe(false);
  });

  it('rejects loopback, private, and link-local literal hosts', () => {
    expect(check('https://localhost/skill.zip').ok).toBe(false);
    expect(check('https://127.0.0.1/skill.zip').ok).toBe(false);
    expect(check('https://10.0.0.5/skill.zip').ok).toBe(false);
    expect(check('https://172.16.0.1/skill.zip').ok).toBe(false);
    expect(check('https://192.168.1.1/skill.zip').ok).toBe(false);
    expect(check('https://169.254.169.254/latest/meta-data').ok).toBe(false);
    expect(check('https://[::1]/skill.zip').ok).toBe(false);
    expect(check('https://[fd12::1]/skill.zip').ok).toBe(false);
    expect(check('https://[fe80::1]/skill.zip').ok).toBe(false);
  });

  it('uses the same private-host predicate for DNS lookup results', () => {
    expect(isBlockedSkillPackageHost('127.5.5.5')).toBe(true);
    expect(isBlockedSkillPackageHost('172.31.255.255')).toBe(true);
    expect(isBlockedSkillPackageHost('172.32.0.1')).toBe(false);
    expect(isBlockedSkillPackageHost('8.8.8.8')).toBe(false);
    expect(isBlockedSkillPackageHost('fd12::1')).toBe(true);
  });
});
