/**
 * SEP-2243 standard-header server-side validation
 * (`validateStandardRequestHeaders`).
 *
 * Evaluated by the HTTP entry on a modern-classified request immediately
 * after `classifyInboundRequest` returns a modern route: rejects `400` /
 * `-32020` (`HeaderMismatch`) when the required `Mcp-Method` header is
 * absent, when the required `Mcp-Name` header is absent on a `tools/call` /
 * `prompts/get` / `resources/read` request, when the `Mcp-Name` header
 * carries an invalid Base64 sentinel, and when its (decoded) value disagrees
 * with the body's `params.name` / `params.uri`. Never enforced on
 * notifications or on methods without an `Mcp-Name` source.
 *
 * The classifier itself is left unchanged by these rungs (it stays a
 * body-primary router that passes a modern request through when no headers
 * are supplied) — this function is the presence/`Mcp-Name` half of the
 * standard-header rung the entry layers on top, so the existing
 * `inboundClassification` and cell-sheet tests stay byte-untouched.
 */
import { describe, expect, test } from 'vitest';

import type { InboundHttpRequest, InboundLadderRejection, InboundModernRoute } from '../../src/shared/inboundClassification.js';
import { classifyInboundRequest, MCP_NAME_HEADER_SOURCE, validateStandardRequestHeaders } from '../../src/shared/inboundClassification.js';
import { encodeMcpParamValue } from '../../src/shared/mcpParamHeaders.js';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '../../src/types/constants.js';

const MODERN = '2026-07-28';
const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'std-header-test', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

function modernPost(
    method: string,
    params: Record<string, unknown>,
    headers: { mcpMethod?: string; mcpName?: string } = {}
): { request: InboundHttpRequest; route: InboundModernRoute } {
    const request: InboundHttpRequest = {
        httpMethod: 'POST',
        protocolVersionHeader: MODERN,
        ...(headers.mcpMethod !== undefined && { mcpMethodHeader: headers.mcpMethod }),
        ...(headers.mcpName !== undefined && { mcpNameHeader: headers.mcpName }),
        body: { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE } }
    };
    const outcome = classifyInboundRequest(request);
    if (outcome.kind !== 'modern') {
        throw new Error(`expected a modern route, got ${outcome.kind}`);
    }
    return { request, route: outcome };
}

function expectRejection(result: InboundLadderRejection | undefined, cell: string): void {
    expect(result).toBeDefined();
    expect(result?.kind).toBe('reject');
    expect(result?.cell).toBe(cell);
    expect(result?.rung).toBe('standard-header-validation');
    expect(result?.httpStatus).toBe(400);
    expect(result?.code).toBe(-32_020);
    expect(result?.settled).toBe(true);
}

describe('SEP-2243 standard-header validation (Mcp-Method presence)', () => {
    test('a modern request without an Mcp-Method header is rejected (method-header-missing)', () => {
        const { request, route } = modernPost('tools/list', {});
        expectRejection(validateStandardRequestHeaders(request, route), 'method-header-missing');
    });

    test('a present Mcp-Method header passes for a method with no Mcp-Name source', () => {
        const { request, route } = modernPost('tools/list', {}, { mcpMethod: 'tools/list' });
        expect(validateStandardRequestHeaders(request, route)).toBeUndefined();
    });

    test('the Mcp-Method mismatch cell stays inside classifyInboundRequest (precedence over presence)', () => {
        // The mismatch is answered by the classifier itself; this function
        // never sees a route for that input. Asserted here so the
        // standard-header rung's two halves stay observably ordered.
        const inbound: InboundHttpRequest = {
            httpMethod: 'POST',
            protocolVersionHeader: MODERN,
            mcpMethodHeader: 'prompts/list',
            body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } }
        };
        const outcome = classifyInboundRequest(inbound);
        expect(outcome.kind).toBe('reject');
        expect((outcome as InboundLadderRejection).cell).toBe('method-header-mismatch');
    });

    test('notifications are never enforced', () => {
        const route: InboundModernRoute = {
            kind: 'modern',
            messageKind: 'notification',
            message: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
            classification: { era: 'modern', revision: MODERN }
        };
        expect(validateStandardRequestHeaders({ httpMethod: 'POST' }, route)).toBeUndefined();
    });
});

describe('SEP-2243 standard-header validation (Mcp-Name presence and cross-check)', () => {
    test('a tools/call without an Mcp-Name header is rejected (name-header-missing)', () => {
        const { request, route } = modernPost('tools/call', { name: 'echo', arguments: {} }, { mcpMethod: 'tools/call' });
        expectRejection(validateStandardRequestHeaders(request, route), 'name-header-missing');
    });

    test('a resources/read without an Mcp-Name header is rejected and names params.uri', () => {
        const { request, route } = modernPost('resources/read', { uri: 'file:///a' }, { mcpMethod: 'resources/read' });
        const result = validateStandardRequestHeaders(request, route);
        expectRejection(result, 'name-header-missing');
        expect(result?.message).toContain('params.uri');
    });

    test('a tools/call whose body has no params.name passes the Mcp-Name presence rung', () => {
        // The missing `params.name` is a request-params failure further down
        // the ladder; this rung only answers what it can observe.
        const { request, route } = modernPost('tools/call', { arguments: {} }, { mcpMethod: 'tools/call' });
        expect(validateStandardRequestHeaders(request, route)).toBeUndefined();
    });

    test('an Mcp-Name header disagreeing with params.name is rejected (name-header-mismatch)', () => {
        const { request, route } = modernPost(
            'tools/call',
            { name: 'echo', arguments: {} },
            { mcpMethod: 'tools/call', mcpName: 'wrong_tool_name' }
        );
        const result = validateStandardRequestHeaders(request, route);
        expectRejection(result, 'name-header-mismatch');
        expect((result?.data as { mismatch?: { header?: string } })?.mismatch?.header).toBe('wrong_tool_name');
    });

    test('a Base64-sentinel Mcp-Name decodes before comparison (matching)', () => {
        const { request, route } = modernPost(
            'tools/call',
            { name: 'Hello, 世界', arguments: {} },
            { mcpMethod: 'tools/call', mcpName: encodeMcpParamValue('Hello, 世界') }
        );
        expect(validateStandardRequestHeaders(request, route)).toBeUndefined();
    });

    test('a Base64-sentinel Mcp-Name decodes before comparison (mismatch names the decoded value)', () => {
        const { request, route } = modernPost(
            'tools/call',
            { name: 'echo', arguments: {} },
            { mcpMethod: 'tools/call', mcpName: encodeMcpParamValue('not-echo') }
        );
        const result = validateStandardRequestHeaders(request, route);
        expectRejection(result, 'name-header-mismatch');
        expect(result?.message).toContain('"not-echo"');
    });

    test('an invalid Base64 sentinel in Mcp-Name is rejected (name-header-invalid-encoding)', () => {
        const { request, route } = modernPost(
            'tools/call',
            { name: 'echo', arguments: {} },
            { mcpMethod: 'tools/call', mcpName: '=?base64?SGVs!!!bG8=?=' }
        );
        expectRejection(validateStandardRequestHeaders(request, route), 'name-header-invalid-encoding');
    });

    test('a matching Mcp-Name on a prompts/get passes', () => {
        const { request, route } = modernPost('prompts/get', { name: 'greeting' }, { mcpMethod: 'prompts/get', mcpName: 'greeting' });
        expect(validateStandardRequestHeaders(request, route)).toBeUndefined();
    });

    test('a matching Mcp-Name on a resources/read compares against params.uri', () => {
        const uri = 'file:///projects/app/config.json';
        const { request, route } = modernPost('resources/read', { uri }, { mcpMethod: 'resources/read', mcpName: uri });
        expect(validateStandardRequestHeaders(request, route)).toBeUndefined();
    });

    test('the Mcp-Name source map covers exactly the spec table', () => {
        expect(MCP_NAME_HEADER_SOURCE).toEqual({ 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' });
    });

    test('a method colliding with Object.prototype members is treated as off-table (passes through to dispatch)', () => {
        // `constructor` would return Object.prototype.constructor on a bare
        // lookup; the Object.hasOwn guard keeps the early-return firing.
        const { request, route } = modernPost('constructor', {}, { mcpMethod: 'constructor', mcpName: '=?base64?!!?=' });
        expect(validateStandardRequestHeaders(request, route)).toBeUndefined();
    });
});

describe('classifyInboundRequest is unchanged by the standard-header presence rung', () => {
    test('a body-only modern request (no headers passed) still routes modern', () => {
        const outcome = classifyInboundRequest({
            httpMethod: 'POST',
            body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {}, _meta: ENVELOPE } }
        });
        expect(outcome.kind).toBe('modern');
    });
});
