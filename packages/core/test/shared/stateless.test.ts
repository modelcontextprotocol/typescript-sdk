import { describe, expect, it } from 'vitest';
import {
    InputRequiredError,
    isInputRequiredError,
    isStatelessProtocolVersion,
    isStatelessRequest,
    META_KEYS,
    parseClientMeta,
    STATEFUL_PROTOCOL_VERSIONS
} from '../../src/shared/stateless.js';

describe('isStatelessProtocolVersion', () => {
    it('returns false for every stateful version', () => {
        for (const v of STATEFUL_PROTOCOL_VERSIONS) {
            expect(isStatelessProtocolVersion(v)).toBe(false);
        }
    });

    it('returns true for unknown/future versions', () => {
        expect(isStatelessProtocolVersion('2026-06-01')).toBe(true);
        expect(isStatelessProtocolVersion('draft')).toBe(true);
    });

    it('returns false for empty string', () => {
        expect(isStatelessProtocolVersion('')).toBe(false);
    });
});

describe('parseClientMeta', () => {
    it('extracts namespaced _meta keys and params-level inputResponses/requestState', () => {
        const out = parseClientMeta({
            _meta: {
                [META_KEYS.protocolVersion]: '2026-06-01',
                [META_KEYS.clientCapabilities]: { sampling: {} },
                [META_KEYS.clientInfo]: { name: 'c', version: '1' },
                [META_KEYS.logLevel]: 'debug',
                unrelated: 1
            },
            inputResponses: { a: { result: {} } },
            requestState: 'opaque'
        });
        expect(out.protocolVersion).toBe('2026-06-01');
        expect(out.clientCapabilities).toEqual({ sampling: {} });
        expect(out.clientInfo).toEqual({ name: 'c', version: '1' });
        expect(out.logLevel).toBe('debug');
        expect(out.inputResponses).toEqual({ a: { result: {} } });
        expect(out.requestState).toBe('opaque');
    });

    it('returns empty for missing/invalid params', () => {
        expect(parseClientMeta(undefined)).toEqual({});
        expect(parseClientMeta({})).toEqual({});
        expect(parseClientMeta({ _meta: undefined })).toEqual({});
    });

    it('ignores keys with wrong types', () => {
        const out = parseClientMeta({
            _meta: {
                [META_KEYS.protocolVersion]: 123,
                [META_KEYS.clientCapabilities]: 'nope',
                [META_KEYS.logLevel]: {}
            } as Record<string, unknown>,
            requestState: 5
        });
        expect(out).toEqual({});
    });
});

describe('isStatelessRequest', () => {
    it('detects requests with stateless protocolVersion in _meta', () => {
        expect(
            isStatelessRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: { _meta: { [META_KEYS.protocolVersion]: '2026-06-01' } }
            })
        ).toBe(true);
    });

    it('rejects stateful versions and notifications', () => {
        expect(
            isStatelessRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: { _meta: { [META_KEYS.protocolVersion]: '2025-06-18' } }
            })
        ).toBe(false);
        expect(isStatelessRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(false);
        expect(isStatelessRequest(null)).toBe(false);
    });
});

describe('InputRequiredError', () => {
    it('reports required capabilities by method', () => {
        const e = new InputRequiredError({
            a: { method: 'sampling/createMessage', params: {} as never },
            b: { method: 'elicitation/create', params: {} as never },
            c: { method: 'roots/list', params: {} }
        });
        expect(new Set(e.requiredCapabilities())).toEqual(new Set(['sampling', 'elicitation', 'roots']));
    });

    it('isInputRequiredError matches by instanceof only', () => {
        const e = new InputRequiredError({});
        expect(isInputRequiredError(e)).toBe(true);
        // Structural look-alikes are not matched (avoids false positives on
        // objects lacking the prototype method).
        const lookAlike = Object.assign(new Error('x'), { name: 'InputRequiredError', inputRequests: {} });
        expect(isInputRequiredError(lookAlike)).toBe(false);
        expect(isInputRequiredError(new Error('x'))).toBe(false);
    });
});
