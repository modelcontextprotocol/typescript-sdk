import { resourceUrlFromServerUrl, checkResourceAllowed } from './auth-utils.js';

describe('auth-utils', () => {
  describe('resourceUrlFromServerUrl', () => {
    it('should remove fragments', () => {
      expect(resourceUrlFromServerUrl('https://example.com/path#fragment')).toBe('https://example.com/path');
      expect(resourceUrlFromServerUrl('https://example.com#fragment')).toBe('https://example.com');
      expect(resourceUrlFromServerUrl('https://example.com/path?query=1#fragment')).toBe('https://example.com/path?query=1');
    });

    it('should preserve URLs without trailing slash (avoiding URL.href auto-addition)', () => {
      expect(resourceUrlFromServerUrl('https://example.com')).toBe('https://example.com');
      expect(resourceUrlFromServerUrl('https://example.com/api')).toBe('https://example.com/api');
      expect(resourceUrlFromServerUrl('https://example.com/api/v1')).toBe('https://example.com/api/v1');
      
      // Verify that URLs with fragments but no trailing slash also preserve this behavior
      expect(resourceUrlFromServerUrl('https://example.com/api#fragment')).toBe('https://example.com/api');
      expect(resourceUrlFromServerUrl('https://example.com/api/v1#fragment')).toBe('https://example.com/api/v1');
    });

    it('should preserve URLs with trailing slash exactly as-is', () => {
      // URLs that already have trailing slash should keep it
      expect(resourceUrlFromServerUrl('https://example.com/')).toBe('https://example.com/');
      expect(resourceUrlFromServerUrl('https://example.com/api/')).toBe('https://example.com/api/');
      expect(resourceUrlFromServerUrl('https://example.com/api/v1/')).toBe('https://example.com/api/v1/');
      
      // With fragments
      expect(resourceUrlFromServerUrl('https://example.com/api/#fragment')).toBe('https://example.com/api/');
      expect(resourceUrlFromServerUrl('https://example.com/api/v1/#fragment')).toBe('https://example.com/api/v1/');
    });

    it('should return URL unchanged if no fragment', () => {
      expect(resourceUrlFromServerUrl('https://example.com')).toBe('https://example.com');
      expect(resourceUrlFromServerUrl('https://example.com/path')).toBe('https://example.com/path');
      expect(resourceUrlFromServerUrl('https://example.com/path?query=1')).toBe('https://example.com/path?query=1');
    });

    it('should keep everything else unchanged', () => {
      // Case sensitivity preserved - URLs are NOT normalized, kept as-is
      expect(resourceUrlFromServerUrl('https://EXAMPLE.COM/PATH')).toBe('https://EXAMPLE.COM/PATH');
      // Ports preserved
      expect(resourceUrlFromServerUrl('https://example.com:443/path')).toBe('https://example.com:443/path');
      expect(resourceUrlFromServerUrl('https://example.com:8080/path')).toBe('https://example.com:8080/path');
      // Query parameters preserved
      expect(resourceUrlFromServerUrl('https://example.com?foo=bar&baz=qux')).toBe('https://example.com?foo=bar&baz=qux');
      // Trailing slashes preserved
      expect(resourceUrlFromServerUrl('https://example.com/')).toBe('https://example.com/');
      expect(resourceUrlFromServerUrl('https://example.com/path/')).toBe('https://example.com/path/');
    });

    it('should demonstrate the difference from URL.href behavior', () => {
      // Demonstrate that using URL.href would incorrectly add trailing slashes
      const testUrls = [
        'https://example.com',
        'https://example.com/api',
        'https://example.com/api/v1'
      ];

      testUrls.forEach(url => {
        const urlObj = new URL(url);
        // URL.href would add a trailing slash for domain-only URLs
        if (url === 'https://example.com') {
          expect(urlObj.href).toBe('https://example.com/'); // URL.href adds trailing slash
          expect(resourceUrlFromServerUrl(url)).toBe('https://example.com'); // Our implementation preserves original
        } else {
          expect(urlObj.href).toBe(url); // URL.href keeps path URLs as-is
          expect(resourceUrlFromServerUrl(url)).toBe(url); // Our implementation also preserves original
        }
      });
    });

    it('should handle edge cases correctly', () => {
      // Domain with port but no path
      expect(resourceUrlFromServerUrl('https://example.com:8080')).toBe('https://example.com:8080');
      
      // Domain with query parameters but no path
      expect(resourceUrlFromServerUrl('https://example.com?param=value')).toBe('https://example.com?param=value');
      
      // Complex URL with all components
      expect(resourceUrlFromServerUrl('https://user:pass@example.com:8080/path?query=value#fragment'))
        .toBe('https://user:pass@example.com:8080/path?query=value');
      
      // IPv6 address
      expect(resourceUrlFromServerUrl('https://[::1]:8080/path#fragment'))
        .toBe('https://[::1]:8080/path');
      
      // Empty fragment (just #)
      expect(resourceUrlFromServerUrl('https://example.com/path#'))
        .toBe('https://example.com/path');
      
      // Fragment with query-like content
      expect(resourceUrlFromServerUrl('https://example.com/path#section?param=1'))
        .toBe('https://example.com/path');
      
      // Schema with uppercase (should preserve case)
      expect(resourceUrlFromServerUrl('HTTPS://EXAMPLE.COM/PATH#fragment'))
        .toBe('HTTPS://EXAMPLE.COM/PATH');
    });
  });

  describe('resourceMatches', () => {
    it('should match identical URLs', () => {
      expect(checkResourceAllowed({ requestedResource: 'https://example.com/path', configuredResource: 'https://example.com/path' })).toBe(true);
      expect(checkResourceAllowed({ requestedResource: 'https://example.com/', configuredResource: 'https://example.com/' })).toBe(true);
    });

    it('should not match URLs with different paths', () => {
      expect(checkResourceAllowed({ requestedResource: 'https://example.com/path1', configuredResource: 'https://example.com/path2' })).toBe(false);
      expect(checkResourceAllowed({ requestedResource: 'https://example.com/', configuredResource: 'https://example.com/path' })).toBe(false);
    });

    it('should not match URLs with different domains', () => {
      expect(checkResourceAllowed({ requestedResource: 'https://example.com/path', configuredResource: 'https://example.org/path' })).toBe(false);
    });

    it('should not match URLs with different ports', () => {
      expect(checkResourceAllowed({ requestedResource: 'https://example.com:8080/path', configuredResource: 'https://example.com/path' })).toBe(false);
    });

    it('should not match URLs where one path is a sub-path of another', () => {
      expect(checkResourceAllowed({ requestedResource: 'https://example.com/mcpxxxx', configuredResource: 'https://example.com/mcp' })).toBe(false);
      expect(checkResourceAllowed({ requestedResource: 'https://example.com/folder', configuredResource: 'https://example.com/folder/subfolder' })).toBe(false);
      expect(checkResourceAllowed({ requestedResource: 'https://example.com/api/v1', configuredResource: 'https://example.com/api' })).toBe(true);
    });

    it('should handle trailing slashes vs no trailing slashes', () => {
      expect(checkResourceAllowed({ requestedResource: 'https://example.com/mcp/', configuredResource: 'https://example.com/mcp' })).toBe(true);
      expect(checkResourceAllowed({ requestedResource: 'https://example.com/folder', configuredResource: 'https://example.com/folder/' })).toBe(false);
    });
  });
});
