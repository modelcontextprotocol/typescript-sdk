import { describe, expect, it } from 'vitest';

import { isAnyMcpSpecifier, isV2Specifier } from '../src/utils/importUtils';

describe('migrated legacy server specifiers', () => {
    it.each(['@modelcontextprotocol/server-legacy', '@modelcontextprotocol/server-legacy/auth'])(
        'recognizes %s as a v2 MCP package',
        specifier => {
            expect(isV2Specifier(specifier)).toBe(true);
            expect(isAnyMcpSpecifier(specifier)).toBe(true);
        }
    );
});
