import { resourceUrlFromServerUrl } from './auth-utils.js';

describe('auth-utils', () => {
  describe('resourceUrlFromServerUrl', () => {
    it('should remove fragments', () => {
      expect(resourceUrlFromServerUrl(new URL('https://example.com/path#fragment')).href).toBe('https://example.com/path');
      expect(resourceUrlFromServerUrl(new URL('https://example.com#fragment')).href).toBe('https://example.com/');
      expect(resourceUrlFromServerUrl(new URL('https://example.com/path?query=1#fragment')).href).toBe('https://example.com/path?query=1');
    });

    it('should return URL unchanged if no fragment', () => {
      expect(resourceUrlFromServerUrl(new URL('https://example.com')).href).toBe('https://example.com/');
      expect(resourceUrlFromServerUrl(new URL('https://example.com/path')).href).toBe('https://example.com/path');
      expect(resourceUrlFromServerUrl(new URL('https://example.com/path?query=1')).href).toBe('https://example.com/path?query=1');
    });

    it('should keep everything else unchanged', () => {
      // Case sensitivity preserved
      expect(resourceUrlFromServerUrl(new URL('https://EXAMPLE.COM/PATH')).href).toBe('https://example.com/PATH');
      // Ports preserved
      expect(resourceUrlFromServerUrl(new URL('https://example.com:443/path')).href).toBe('https://example.com/path');
      expect(resourceUrlFromServerUrl(new URL('https://example.com:8080/path')).href).toBe('https://example.com:8080/path');
      // Query parameters preserved
      expect(resourceUrlFromServerUrl(new URL('https://example.com?foo=bar&baz=qux')).href).toBe('https://example.com/?foo=bar&baz=qux');
      // Trailing slashes preserved
      expect(resourceUrlFromServerUrl(new URL('https://example.com/')).href).toBe('https://example.com/');
      expect(resourceUrlFromServerUrl(new URL('https://example.com/path/')).href).toBe('https://example.com/path/');
    });
  });
});