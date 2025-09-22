import { validateToolName, validateAndWarnToolName, issueToolNameWarning } from './toolNameValidation.js';

// Spy on console.warn to capture output
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('validateToolName', () => {
  describe('valid tool names', () => {
    test('should accept simple alphanumeric names', () => {
      const result = validateToolName('getUser');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('should accept names with underscores', () => {
      const result = validateToolName('get_user_profile');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('should accept names with dashes', () => {
      const result = validateToolName('user-profile-update');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('should accept names with dots', () => {
      const result = validateToolName('admin.tools.list');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('should accept names with forward slashes', () => {
      const result = validateToolName('user/profile/update');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('should accept mixed character names', () => {
      const result = validateToolName('DATA_EXPORT_v2.1');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('should accept single character names', () => {
      const result = validateToolName('a');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('should accept 128 character names', () => {
      const name = 'a'.repeat(128);
      const result = validateToolName(name);
      expect(result.isValid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('invalid tool names', () => {
    test('should reject empty names', () => {
      const result = validateToolName('');
      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Tool name cannot be empty');
    });

    test('should reject names longer than 128 characters', () => {
      const name = 'a'.repeat(129);
      const result = validateToolName(name);
      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Tool name exceeds maximum length of 128 characters (current: 129)');
    });

    test('should reject names with spaces', () => {
      const result = validateToolName('get user profile');
      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Tool name contains invalid characters: " "');
    });

    test('should reject names with commas', () => {
      const result = validateToolName('get,user,profile');
      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Tool name contains invalid characters: ","');
    });

    test('should reject names with other special characters', () => {
      const result = validateToolName('user@domain.com');
      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Tool name contains invalid characters: "@"');
    });

    test('should reject names with multiple invalid characters', () => {
      const result = validateToolName('user name@domain,com');
      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Tool name contains invalid characters: " ", "@", ","');
    });

    test('should reject names with unicode characters', () => {
      const result = validateToolName('user-ñame');
      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Tool name contains invalid characters: "ñ"');
    });
  });

  describe('warnings for potentially problematic patterns', () => {
    test('should warn about names with spaces', () => {
      const result = validateToolName('get user profile');
      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Tool name contains spaces, which may cause parsing issues');
    });

    test('should warn about names with commas', () => {
      const result = validateToolName('get,user,profile');
      expect(result.isValid).toBe(false);
      expect(result.warnings).toContain('Tool name contains commas, which may cause parsing issues');
    });

    test('should warn about names starting with dash', () => {
      const result = validateToolName('-get-user');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain('Tool name starts or ends with a dash, which may cause parsing issues in some contexts');
    });

    test('should warn about names ending with dash', () => {
      const result = validateToolName('get-user-');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain('Tool name starts or ends with a dash, which may cause parsing issues in some contexts');
    });

    test('should warn about names starting with dot', () => {
      const result = validateToolName('.get.user');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain('Tool name starts or ends with a dot, which may cause parsing issues in some contexts');
    });

    test('should warn about names ending with dot', () => {
      const result = validateToolName('get.user.');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain('Tool name starts or ends with a dot, which may cause parsing issues in some contexts');
    });

    test('should warn about names with both leading and trailing dots', () => {
      const result = validateToolName('.get.user.');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain('Tool name starts or ends with a dot, which may cause parsing issues in some contexts');
    });
  });
});

describe('issueToolNameWarning', () => {
  test('should output warnings to console.warn', () => {
    const warnings = ['Warning 1', 'Warning 2'];
    issueToolNameWarning('test-tool', warnings);
    
    expect(warnSpy).toHaveBeenCalledTimes(6); // Header + 2 warnings + 3 guidance lines
    const calls = warnSpy.mock.calls.map(call => call.join(' '));
    expect(calls[0]).toContain('Tool name validation warning for "test-tool"');
    expect(calls[1]).toContain('- Warning 1');
    expect(calls[2]).toContain('- Warning 2');
    expect(calls[3]).toContain('Tool registration will proceed, but this may cause compatibility issues.');
    expect(calls[4]).toContain('Consider updating the tool name');
    expect(calls[5]).toContain('See SEP: Specify Format for Tool Names');
  });

  test('should handle empty warnings array', () => {
    issueToolNameWarning('test-tool', []);
    expect(warnSpy).toHaveBeenCalledTimes(0);
  });
});

describe('validateAndWarnToolName', () => {
  test('should return true and issue warnings for valid names with warnings', () => {
    const result = validateAndWarnToolName('-get-user-');
    expect(result).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  test('should return true and not issue warnings for completely valid names', () => {
    const result = validateAndWarnToolName('get-user-profile');
    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('should return false and issue warnings for invalid names', () => {
    const result = validateAndWarnToolName('get user profile');
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalled(); // Now issues warnings instead of errors
    const warningCalls = warnSpy.mock.calls.map(call => call.join(' '));
    expect(warningCalls.some(call => call.includes('Tool name contains spaces'))).toBe(true);
  });

  test('should return false for empty names', () => {
    const result = validateAndWarnToolName('');
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalled(); // Now issues warnings instead of errors
  });

  test('should return false for names exceeding length limit', () => {
    const longName = 'a'.repeat(129);
    const result = validateAndWarnToolName(longName);
    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalled(); // Now issues warnings instead of errors
  });
});

describe('edge cases and robustness', () => {
  test('should warn about names with only dots', () => {
    const result = validateToolName('...');
    expect(result.isValid).toBe(true);
    expect(result.warnings).toContain('Tool name starts or ends with a dot, which may cause parsing issues in some contexts');
  });

  test('should handle names with only dashes', () => {
    const result = validateToolName('---');
    expect(result.isValid).toBe(true);
    expect(result.warnings).toContain('Tool name starts or ends with a dash, which may cause parsing issues in some contexts');
  });

  test('should warn about names with only forward slashes', () => {
    const result = validateToolName('///');
    expect(result.isValid).toBe(true);
    expect(result.warnings).toContain('Tool name starts or ends with a slash, which may cause parsing issues in some contexts');
  });

  test('should handle names with mixed valid and invalid characters', () => {
    const result = validateToolName('user@name123');
    expect(result.isValid).toBe(false);
    expect(result.warnings).toContain('Tool name contains invalid characters: "@"');
  });
});