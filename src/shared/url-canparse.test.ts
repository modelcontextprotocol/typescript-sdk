import { describe, it, expect } from '@jest/globals';

describe('URL.canParse compatibility', () => {
  it('should use URL.canParse which requires Node.js 18.17.0+', () => {
    // This test will fail on Node.js < 18.17.0
    expect(typeof URL.canParse).toBe('function');
    
    // Test that it works correctly
    expect(URL.canParse('https://example.com')).toBe(true);
    expect(URL.canParse('not-a-url')).toBe(false);
  });

  it('demonstrates the actual usage in our codebase', () => {
    // This mimics how we use URL.canParse in auth.ts
    const validateRedirectUri = (uri: string) => {
      return URL.canParse(uri);
    };

    expect(validateRedirectUri('https://example.com/callback')).toBe(true);
    expect(validateRedirectUri('invalid://[not-valid')).toBe(false);
  });
});