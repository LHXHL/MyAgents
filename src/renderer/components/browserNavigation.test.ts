import { describe, expect, it } from 'vitest';
import { resolveBrowserAddress } from './browserNavigation';
import { BROWSER_BLANK_URL } from './browserConstants';

describe('browser address policy', () => {
  it.each([
    [' example.com/path?q=1 ', 'https://example.com/path?q=1'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['localhost:443', 'http://localhost:443/'],
    ['127.0.0.1:443/path', 'http://127.0.0.1:443/path'],
    ['[::1]:443', 'http://[::1]:443/'],
    ['app.localhost:8080/path', 'http://app.localhost:8080/path'],
    ['127.0.0.1:3000', 'http://127.0.0.1:3000/'],
    ['[::1]:3000', 'http://[::1]:3000/'],
    ['https://localhost:3000', 'https://localhost:3000/'],
    ['example.com:8080', 'https://example.com:8080/'],
    ['/tmp/preview file.html', '/tmp/preview file.html'],
    ['C:\\work\\preview.html', 'C:\\work\\preview.html'],
    ['file:///tmp/preview%20file.html', 'file:///tmp/preview%20file.html'],
    ['about:blank', BROWSER_BLANK_URL],
  ])('resolves %s', (input, expected) => expect(resolveBrowserAddress(input)).toBe(expected));
  it.each(['', '   ', 'search some words', 'javascript:alert(1)', 'data:text/html,hello',
    'ftp://example.com', 'https://', 'https://user:secret@example.com', 'localhost:99999'])('rejects %s', input => {
    expect(resolveBrowserAddress(input)).toBeNull();
  });
});
