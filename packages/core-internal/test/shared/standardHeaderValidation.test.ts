/**
 * SEP-2243 standard-header server-side validation
 * (`validateStandardRequestHeaders`).
 *
 * Evaluated by the HTTP entry on a modern-classified request immediately
 * after `classifyInboundRequest` returns a modern route: rejects `400` /
 * `-32020` (`HeaderMismatch`) when the required `MCP-Protocol-Version` header
 * is absent, when the required `Mcp-Method` header is
 * absent, when the required `Mcp-Name` header is absent on a `tools/call` /
 * `prompts/get` / `resources/read` request or (per SEP-2663's Streamable
 * HTTP binding) a `tasks/get` / `tasks/update` / `tasks/cancel` request,
 * when the `Mcp-Name` header carries an invalid Base64 sentinel, and when
 * its (decoded) value disagrees with the body's `params.name` /
 * `params.uri` / `params.taskId`. Never enforced on
 * notifications or on methods without an `Mcp-Name` source.
 *
 * The classifier itself is left unchanged by these rungs (it stays a
 * body-primary router that passes a modern request through when no headers
 * are supplied) — this function is the presence/`Mcp-Name` half of the
 * standard-header rung the entry layers on top, so the existing
 * `inboundClassification` and cell-sheet tests stay byte-untouched.
 */
import { describe, expect, test } from 'vitest';

import type { InboundHttpRequest, InboundLadderRejection, InboundModernRoute } from '../../src/shared/inboundClassification';
import {
    classifyInboundRequest,
    MCP_NAME_HEADER_SOURCE,
    mcpNameSource,
    validateStandardRequestHeaders
} from '../../src/shared/inboundClassification';
import { encodeMcpParamValue } from '../../src/shared/mcpParamHeaders';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '../../src/types/constants';

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

describe('SEP-2243 standard-header validation (MCP-Protocol-Version presence)', () => {
    test('a modern request without an MCP-Protocol-Version header is rejected (version-header-missing)', () => {
        const request: InboundHttpRequest = {
            httpMethod: 'POST',
            mcpMethodHeader: 'tools/list',
            body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } }
        };
        const outcome = classifyInboundRequest(request);
        // Body-primary classification is deliberately untouched: a proxy that
        // strips the header must not change the era, so the request still
        // routes modern and the rejection belongs to this rung — not to the
        // classifier.
        expect(outcome.kind).toBe('modern');
        expectRejection(validateStandardRequestHeaders(request, outcome as InboundModernRoute), 'version-header-missing');
    });

    test('the missing-version cell outranks the missing-method cell (spec header order)', () => {
        const request: InboundHttpRequest = {
            httpMethod: 'POST',
            body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } }
        };
        const outcome = classifyInboundRequest(request);
        expect(outcome.kind).toBe('modern');
        expectRejection(validateStandardRequestHeaders(request, outcome as InboundModernRoute), 'version-header-missing');
    });

    test('a present and matching MCP-Protocol-Version header passes', () => {
        const { request, route } = modernPost('tools/list', {}, { mcpMethod: 'tools/list' });
        expect(validateStandardRequestHeaders(request, route)).toBeUndefined();
    });

    test('the header/body version mismatch cell stays inside classifyInboundRequest (this rung never sees it)', () => {
        // The protocol-version check is split across two rungs: *absence* is
        // this rung's cell, *disagreement* stays on the classifier's edge
        // `era-classification` rung. Pinned so the split stays observable —
        // the same guard the Mcp-Method pair carries below.
        const outcome = classifyInboundRequest({
            httpMethod: 'POST',
            protocolVersionHeader: '2025-11-25',
            mcpMethodHeader: 'tools/list',
            body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } }
        });
        expect(outcome.kind).toBe('reject');
        expect((outcome as InboundLadderRejection).cell).toBe('header-body-version-mismatch');
        expect((outcome as InboundLadderRejection).rung).toBe('era-classification');
        expect((outcome as InboundLadderRejection).code).toBe(-32_020);
    });
});

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

    test('notifications are never enforced — including the MCP-Protocol-Version presence cell', () => {
        // Deliberate, not an oversight. The Streamable HTTP "Sending Messages"
        // note states that "header requirements for notification POSTs are not
        // defined by this revision" (the revision defines no client-to-server
        // notifications over Streamable HTTP at all), so the "Every POST
        // request MUST include an MCP-Protocol-Version header" rule does not
        // reach a posted notification and this rung stays request-only.
        // The request below carries NO standard headers whatsoever.
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

    test('raw HTTP OWS is stripped from standard MCP header values', () => {
        const { request } = modernPost(
            'tools/call',
            { name: 'echo', arguments: {} },
            { mcpMethod: '\t tools/call  ', mcpName: '  echo \t' }
        );
        request.protocolVersionHeader = `  ${MODERN}\t`;
        const classified = classifyInboundRequest(request);
        expect(classified.kind).toBe('modern');
        if (classified.kind !== 'modern') {
            throw new Error(`expected a modern route, got ${classified.kind}`);
        }
        expect(validateStandardRequestHeaders(request, classified)).toBeUndefined();
    });

    test('long OWS runs are stripped without changing an encoded name', () => {
        const ows = '\t '.repeat(50_000);
        const name = ' echo ';
        const { request } = modernPost(
            'tools/call',
            { name, arguments: {} },
            {
                mcpMethod: `${ows}tools/call${ows}`,
                mcpName: `${ows}${encodeMcpParamValue(name)}${ows}`
            }
        );
        request.protocolVersionHeader = `${ows}${MODERN}${ows}`;

        const classified = classifyInboundRequest(request);
        expect(classified.kind).toBe('modern');
        if (classified.kind !== 'modern') {
            throw new Error(`expected a modern route, got ${classified.kind}`);
        }
        expect(validateStandardRequestHeaders(request, classified)).toBeUndefined();
    });

    test('whitespace outside RFC 9110 OWS is not stripped', () => {
        const { request } = modernPost('tools/call', { name: 'echo', arguments: {} }, { mcpMethod: 'tools/call', mcpName: 'echo' });
        request.mcpMethodHeader = '\u00a0tools/call';
        const classified = classifyInboundRequest(request);
        expect(classified.kind).toBe('reject');
        expect((classified as InboundLadderRejection).cell).toBe('method-header-mismatch');
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

    test('the Mcp-Name source map covers exactly the spec table (SEP-2243 core + SEP-2663 tasks)', () => {
        expect(MCP_NAME_HEADER_SOURCE).toEqual({
            'tools/call': 'name',
            'prompts/get': 'name',
            'resources/read': 'uri',
            'tasks/get': 'taskId',
            'tasks/update': 'taskId',
            'tasks/cancel': 'taskId'
        });
    });

    test('a tasks/get without an Mcp-Name header is rejected and names params.taskId (SEP-2663)', () => {
        const { request, route } = modernPost('tasks/get', { taskId: 'task-123' }, { mcpMethod: 'tasks/get' });
        const result = validateStandardRequestHeaders(request, route);
        expectRejection(result, 'name-header-missing');
        expect(result?.message).toContain('params.taskId');
    });

    test('a matching Mcp-Name on tasks/get, tasks/update, and tasks/cancel compares against params.taskId', () => {
        for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
            const { request, route } = modernPost(method, { taskId: 'task-123' }, { mcpMethod: method, mcpName: 'task-123' });
            expect(validateStandardRequestHeaders(request, route)).toBeUndefined();
        }
    });

    test('an Mcp-Name header disagreeing with params.taskId is rejected (name-header-mismatch)', () => {
        const { request, route } = modernPost(
            'tasks/update',
            { taskId: 'task-123', inputResponses: {} },
            { mcpMethod: 'tasks/update', mcpName: 'some-other-task' }
        );
        const result = validateStandardRequestHeaders(request, route);
        expectRejection(result, 'name-header-mismatch');
        expect(result?.message).toContain('"some-other-task"');
    });

    test('a tasks/list stays off-table: no Mcp-Name required', () => {
        const { request, route } = modernPost('tasks/list', {}, { mcpMethod: 'tasks/list' });
        expect(validateStandardRequestHeaders(request, route)).toBeUndefined();
    });

    test('an Mcp-Name header on a tasks/get whose params.taskId is not a string passes this rung (the body is answered further down)', () => {
        // Nothing to cross-check against: the header is present and the body
        // carries no string source value, so the mismatch branch must not fire.
        const { request, route } = modernPost('tasks/get', { taskId: 42 }, { mcpMethod: 'tasks/get', mcpName: 'task-123' });
        expect(validateStandardRequestHeaders(request, route)).toBeUndefined();
    });

    test('mcpNameSource resolves the shared table for both sides', () => {
        expect(mcpNameSource('tools/call', { name: 'echo' })).toEqual({ field: 'name', value: 'echo' });
        expect(mcpNameSource('resources/read', { uri: 'file:///x' })).toEqual({ field: 'uri', value: 'file:///x' });
        expect(mcpNameSource('tasks/update', { taskId: 'task-123', inputResponses: {} })).toEqual({ field: 'taskId', value: 'task-123' });
        // On-table, but no string value to mirror.
        expect(mcpNameSource('tasks/get', { taskId: 42 })).toEqual({ field: 'taskId', value: undefined });
        expect(mcpNameSource('tasks/get', undefined)).toEqual({ field: 'taskId', value: undefined });
        expect(mcpNameSource('tasks/get', ['task-123'])).toEqual({ field: 'taskId', value: undefined });
        // Off-table, including Object.prototype collisions.
        expect(mcpNameSource('tasks/list', { taskId: 'task-123' })).toBeUndefined();
        expect(mcpNameSource('constructor', { name: 'x' })).toBeUndefined();
        expect(mcpNameSource('__proto__', { name: 'x' })).toBeUndefined();
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
