import { describe, expect, test } from 'vitest';

import { mcpNameForMethod, validateMcpHeaders } from '../../src/shared/httpHeaders.js';
import type { JSONRPCRequest } from '../../src/types/index.js';

function req(headers: Record<string, string>): Request {
    return new Request('http://x/mcp', { method: 'POST', headers });
}
function body(method: string, params?: Record<string, unknown>): JSONRPCRequest {
    return { jsonrpc: '2.0', id: 1, method, params };
}

describe('mcpNameForMethod (SEP-2243)', () => {
    test('returns name for tools/call and prompts/get', () => {
        expect(mcpNameForMethod('tools/call', { name: 'get_weather' })).toBe('get_weather');
        expect(mcpNameForMethod('prompts/get', { name: 'summarize' })).toBe('summarize');
    });
    test('returns uri for resources/read', () => {
        expect(mcpNameForMethod('resources/read', { uri: 'file:///a' })).toBe('file:///a');
    });
    test('undefined for other methods', () => {
        expect(mcpNameForMethod('tools/list', {})).toBeUndefined();
        expect(mcpNameForMethod('initialize', {})).toBeUndefined();
    });
});

describe('validateMcpHeaders (SEP-2243)', () => {
    test('absent headers always pass', () => {
        expect(validateMcpHeaders(req({}), body('tools/call', { name: 'x' }))).toBeUndefined();
    });
    test('matching headers pass', () => {
        expect(validateMcpHeaders(req({ 'mcp-method': 'tools/call', 'mcp-name': 'x' }), body('tools/call', { name: 'x' }))).toBeUndefined();
    });
    test('mismatched mcp-method fails', () => {
        expect(validateMcpHeaders(req({ 'mcp-method': 'tools/list' }), body('tools/call', { name: 'x' }))).toMatch(/Mcp-Method header/);
    });
    test('mismatched mcp-name fails', () => {
        expect(validateMcpHeaders(req({ 'mcp-method': 'tools/call', 'mcp-name': 'wrong' }), body('tools/call', { name: 'x' }))).toMatch(
            /Mcp-Name header/
        );
    });
    test('batch bodies are not validated', () => {
        expect(validateMcpHeaders(req({ 'mcp-method': 'anything' }), [body('tools/call'), body('ping')])).toBeUndefined();
    });
});
