import { validateToolName, validateAndWarnToolName, issueToolNameWarning } from '../../src/shared/toolNameValidation.js';
import { vi, MockInstance } from 'vitest';

// Spy on console.warn to capture output
let warnSpy: MockInstance;

beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('validateToolName', () => {
    describe('valid tool names', () => {
        test.each`
            description                    | toolName
            ${'simple alphanumeric names'} | ${'getUser'}
            ${'names with underscores'}    | ${'get_user_profile'}
            ${'names with dashes'}         | ${'user-profile-update'}
            ${'names with dots'}           | ${'admin.tools.list'}
            ${'mixed character names'}     | ${'DATA_EXPORT_v2.1'}
            ${'single character names'}    | ${'a'}
            ${'128 character names'}       | ${'a'.repeat(128)}
        `('should accept $description', ({ toolName }) => {
            const result = validateToolName(toolName);
            expect(result.isValid).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });
    });

    describe('invalid tool names', () => {
        test.each`
            description                            | toolName                  | expectedWarning
            ${'empty names'}                       | ${''}                     | ${'Tool name cannot be empty'}
            ${'names longer than 128 characters'}  | ${'a'.repeat(129)}        | ${'Tool name exceeds maximum length of 128 characters (current: 129)'}
            ${'names with spaces'}                 | ${'get user profile'}     | ${'Tool name contains invalid characters: " "'}
            ${'names with commas'}                 | ${'get,user,profile'}     | ${'Tool name contains invalid characters: ","'}
            ${'names with forward slashes'}        | ${'user/profile/update'}  | ${'Tool name contains invalid characters: "/"'}
            ${'names with other special chars'}    | ${'user@domain.com'}      | ${'Tool name contains invalid characters: "@"'}
            ${'names with multiple invalid chars'} | ${'user name@domain,com'} | ${'Tool name contains invalid characters: " ", "@", ","'}
            ${'names with unicode characters'}     | ${'user-ñame'}            | ${'Tool name contains invalid characters: "ñ"'}
        `('should reject $description', ({ toolName, expectedWarning }) => {
            const result = validateToolName(toolName);
            expect(result.isValid).toBe(false);
            expect(result.warnings).toContain(expectedWarning);
        });
    });

    describe('warnings for potentially problematic patterns', () => {
        test.each`
            description                               | toolName              | expectedWarning                                                                            | shouldBeValid
            ${'names with spaces'}                    | ${'get user profile'} | ${'Tool name contains spaces, which may cause parsing issues'}                             | ${false}
            ${'names with commas'}                    | ${'get,user,profile'} | ${'Tool name contains commas, which may cause parsing issues'}                             | ${false}
            ${'names starting with dash'}             | ${'-get-user'}        | ${'Tool name starts or ends with a dash, which may cause parsing issues in some contexts'} | ${true}
            ${'names ending with dash'}               | ${'get-user-'}        | ${'Tool name starts or ends with a dash, which may cause parsing issues in some contexts'} | ${true}
            ${'names starting with dot'}              | ${'.get.user'}        | ${'Tool name starts or ends with a dot, which may cause parsing issues in some contexts'}  | ${true}
            ${'names ending with dot'}                | ${'get.user.'}        | ${'Tool name starts or ends with a dot, which may cause parsing issues in some contexts'}  | ${true}
            ${'names with leading and trailing dots'} | ${'.get.user.'}       | ${'Tool name starts or ends with a dot, which may cause parsing issues in some contexts'}  | ${true}
        `('should warn about $description', ({ toolName, expectedWarning, shouldBeValid }) => {
            const result = validateToolName(toolName);
            expect(result.isValid).toBe(shouldBeValid);
            expect(result.warnings).toContain(expectedWarning);
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
    test.each`
        description                       | toolName              | expectedResult | shouldWarn
        ${'valid names with warnings'}    | ${'-get-user-'}       | ${true}        | ${true}
        ${'completely valid names'}       | ${'get-user-profile'} | ${true}        | ${false}
        ${'invalid names with spaces'}    | ${'get user profile'} | ${false}       | ${true}
        ${'empty names'}                  | ${''}                 | ${false}       | ${true}
        ${'names exceeding length limit'} | ${'a'.repeat(129)}    | ${false}       | ${true}
    `('should handle $description', ({ toolName, expectedResult, shouldWarn }) => {
        const result = validateAndWarnToolName(toolName);
        expect(result).toBe(expectedResult);

        if (shouldWarn) {
            expect(warnSpy).toHaveBeenCalled();
        } else {
            expect(warnSpy).not.toHaveBeenCalled();
        }
    });

    test('should include space warning for invalid names with spaces', () => {
        validateAndWarnToolName('get user profile');
        const warningCalls = warnSpy.mock.calls.map(call => call.join(' '));
        expect(warningCalls.some(call => call.includes('Tool name contains spaces'))).toBe(true);
    });
});

describe('edge cases and robustness', () => {
    test.each`
        description                               | toolName          | shouldBeValid | expectedWarning
        ${'names with only dots'}                 | ${'...'}          | ${true}       | ${'Tool name starts or ends with a dot, which may cause parsing issues in some contexts'}
        ${'names with only dashes'}               | ${'---'}          | ${true}       | ${'Tool name starts or ends with a dash, which may cause parsing issues in some contexts'}
        ${'names with only forward slashes'}      | ${'///'}          | ${false}      | ${'Tool name contains invalid characters: "/"'}
        ${'names with mixed valid/invalid chars'} | ${'user@name123'} | ${false}      | ${'Tool name contains invalid characters: "@"'}
    `('should handle $description', ({ toolName, shouldBeValid, expectedWarning }) => {
        const result = validateToolName(toolName);
        expect(result.isValid).toBe(shouldBeValid);
        expect(result.warnings).toContain(expectedWarning);
    });
});
