import { describe, expect, it } from 'vitest';
import { META_KEYS, parseClientMeta, isStatelessVersion, STATEFUL_PROTOCOL_VERSIONS } from '../../src/shared/protocolMode.js';

describe('isStatelessVersion', () => {
    it('classifies every known stateful version as legacy', () => {
        for (const v of STATEFUL_PROTOCOL_VERSIONS) {
            expect(isStatelessVersion(v)).toBe(false);
        }
    });

    it('classifies undefined as legacy', () => {
        expect(isStatelessVersion(undefined)).toBe(false);
    });

    it('classifies 2026-06-30 as stateless', () => {
        expect(isStatelessVersion('2026-06-30')).toBe(true);
    });

    it('classifies unknown future versions as stateless', () => {
        expect(isStatelessVersion('2027-01-01')).toBe(true);
        expect(isStatelessVersion('draft')).toBe(true);
    });
});

describe('parseClientMeta', () => {
    it('returns empty for undefined params', () => {
        expect(parseClientMeta(undefined)).toEqual({});
    });

    it('returns empty when _meta is absent', () => {
        expect(parseClientMeta({})).toEqual({});
    });

    it('extracts the four whitelisted keys', () => {
        const result = parseClientMeta({
            _meta: {
                [META_KEYS.protocolVersion]: '2026-06-30',
                [META_KEYS.clientCapabilities]: { sampling: {} },
                [META_KEYS.clientInfo]: { name: 'c', version: '1' },
                [META_KEYS.logLevel]: 'info'
            }
        });
        expect(result).toEqual({
            protocolVersion: '2026-06-30',
            clientCapabilities: { sampling: {} },
            clientInfo: { name: 'c', version: '1' },
            logLevel: 'info'
        });
    });

    it('ignores keys outside the whitelist', () => {
        const result = parseClientMeta({
            _meta: {
                [META_KEYS.protocolVersion]: '2026-06-30',
                'custom/key': 'ignored',
                traceparent: 'also ignored'
            }
        });
        expect(result).toEqual({ protocolVersion: '2026-06-30' });
    });

    it('skips values with the wrong top-level type', () => {
        const result = parseClientMeta({
            _meta: {
                [META_KEYS.protocolVersion]: 123,
                [META_KEYS.clientCapabilities]: 'not-an-object',
                [META_KEYS.logLevel]: { not: 'a-string' }
            }
        });
        expect(result).toEqual({});
    });
});
