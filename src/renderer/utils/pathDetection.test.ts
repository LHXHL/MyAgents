import { describe, expect, it } from 'vitest';

import { shortenPathForDisplay } from '@/utils/pathDetection';

describe('shortenPathForDisplay', () => {
  it('shortens macOS and Windows user profile paths', () => {
    expect(shortenPathForDisplay('/Users/zhihu/Documents/project/MyAgents')).toBe('~/Documents/project/MyAgents');
    expect(shortenPathForDisplay('C:\\Users\\zhihu\\Documents\\project\\MyAgents')).toBe('~/Documents/project/MyAgents');
    expect(shortenPathForDisplay('D:/Users/zhihu/work/MyAgents')).toBe('~/work/MyAgents');
  });

  it('keeps non-user paths unchanged', () => {
    expect(shortenPathForDisplay('/opt/MyAgents')).toBe('/opt/MyAgents');
  });
});
