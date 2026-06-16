/**
 * Era-parity error shapes: the same malformed input produces the same
 * JSON-RPC error shape on the 2025-era (session-oriented streamable HTTP
 * transport) and on the modern per-request path — modulo an explicitly
 * enumerated table of era-mandated differences. Anything outside that table
 * is a parity regression.
 */
import type { CallToolResult, JSONRPCRequest, MessageClassification } from '@modelcontextprotocol/core';
import {
    classifyInboundRequest,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
    setNegotiatedProtocolVersion
} from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { PerRequestHTTPServerTransport } from '../../src/server/perRequestTransport.js';
import { Server } from '../../src/server/server.js';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp.js';

const MODERN_REVISION = '2026-07-28';
const MODERN: MessageClassification = { era: 'modern', revision: MODERN_REVISION };

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'parity-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

/**
 * Era-mandated differences between the two serving paths for the inputs
 * exercised below. Everything else must be identical.
 *
 * - HTTP status: pre-handler rejections are status-mapped on the modern
 *   per-request path (e.g. method-not-found answers HTTP 404), while the
 *   2025-era transport always carries dispatch errors in-band on HTTP 200.
 *   Asserted literally on both legs by the unknown-method test below.
 * - The modern era requires the per-request `_meta` envelope on every
 *   request; the inputs below carry it on the modern leg only, where it is
 *   wire-level bookkeeping that never reaches handlers.
 * - The malformed-body divergences enumerated in {@link KNOWN_EDGE_DIVERGENCES},
 *   asserted literally on both legs by the divergence-table test below.
 */

/**
 * Known, deliberate divergences between what the deployed 2025-era streamable
 * HTTP transport answers for a malformed POST body and what the modern edge
 * (the inbound classifier) answers for the same body.
 *
 * These are hand-written literals — NOT derived from the observed behavior of
 * either leg — so a behavior change on EITHER side fails the assertions below
 * and forces this enumeration (and the matching cell-sheet rationales in the
 * core package) to be revisited.
 */
const KNOWN_EDGE_DIVERGENCES: ReadonlyArray<{
    divergence: string;
    /** The parsed POST body both legs receive. */
    body: unknown;
    /** What the deployed 2025-era transport answers today. */
    legacy: { httpStatus: number; code?: number };
    /** What the modern edge (the inbound classifier) answers. */
    modernEdge: { httpStatus: number; code: number };
    rationale: string;
}> = [
    {
        divergence: 'parsed-but-not-json-rpc-single-object',
        body: { hello: 'world' },
        legacy: { httpStatus: 400, code: -32_700 },
        modernEdge: { httpStatus: 400, code: -32_600 },
        rationale:
            'The deployed transport answers a parse error (-32700) for a parsed body that is not a JSON-RPC message; the modern ' +
            'edge answers the JSON-RPC-correct invalid request (-32600).'
    },
    {
        divergence: 'empty-batch',
        body: [],
        legacy: { httpStatus: 202 },
        modernEdge: { httpStatus: 400, code: -32_600 },
        rationale:
            'The deployed transport accepts an empty batch as containing only notifications (202, no body); the modern edge ' +
            'rejects it as an invalid request.'
    }
];

interface LegError {
    status: number;
    error: { code: number; message: string; data?: unknown };
}

function buildServer(): Server {
    const server = new Server({ name: 'parity', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/call', async (): Promise<CallToolResult> => ({ content: [{ type: 'text', text: 'ok' }] }));
    server.setRequestHandler('app/fail', { params: z.looseObject({}) }, async () => {
        throw new ProtocolError(-32_002, 'resource missing');
    });
    return server;
}

/**
 * Posts an arbitrary (possibly malformed) body to the deployed 2025-era
 * transport and returns the raw HTTP outcome — unlike {@link legacyLeg}, it
 * does not assume the response carries a JSON error body (a 202 has none).
 */
async function legacyRawLeg(body: unknown): Promise<{ status: number; error?: LegError['error'] }> {
    const server = buildServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const response = await transport.handleRequest(
        new Request('http://localhost/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify(body)
        })
    );
    const text = await response.text();
    await server.close();
    return {
        status: response.status,
        ...(text.length > 0 && { error: (JSON.parse(text) as { error: LegError['error'] }).error })
    };
}

async function legacyLeg(body: Record<string, unknown>): Promise<LegError> {
    const server = buildServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const response = await transport.handleRequest(
        new Request('http://localhost/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify(body)
        })
    );
    const parsed = (await response.json()) as { error: LegError['error'] };
    await server.close();
    return { status: response.status, error: parsed.error };
}

async function modernLeg(body: Record<string, unknown>): Promise<LegError> {
    const server = buildServer();
    setNegotiatedProtocolVersion(server, MODERN_REVISION);
    const transport = new PerRequestHTTPServerTransport({ classification: MODERN });
    await server.connect(transport);
    const enveloped = {
        ...body,
        params: { ...(body['params'] as Record<string, unknown> | undefined), _meta: ENVELOPE }
    };
    const response = await transport.handleMessage(enveloped as unknown as JSONRPCRequest);
    const parsed = (await response.json()) as { error: LegError['error'] };
    await server.close();
    return { status: response.status, error: parsed.error };
}

describe('era-parity error shapes', () => {
    it.each(KNOWN_EDGE_DIVERGENCES)(
        'known divergence "$divergence": both legs answer exactly what the table enumerates',
        async ({ body, legacy, modernEdge }) => {
            // Legacy leg: the deployed 2025-era transport, exercised over HTTP.
            const legacyActual = await legacyRawLeg(body);
            expect(legacyActual.status).toBe(legacy.httpStatus);
            if (legacy.code !== undefined) {
                expect(legacyActual.error?.code).toBe(legacy.code);
            } else {
                expect(legacyActual.error).toBeUndefined();
            }

            // Modern leg: the per-request path answers these bodies at the
            // edge (the inbound classifier) — they never reach a transport.
            const modernActual = classifyInboundRequest({ httpMethod: 'POST', body });
            expect(modernActual.kind).toBe('reject');
            if (modernActual.kind !== 'reject') return;
            expect(modernActual.httpStatus).toBe(modernEdge.httpStatus);
            expect(modernActual.code).toBe(modernEdge.code);
        }
    );

    it('an unknown method produces the same JSON-RPC error on both legs (status mapping is the enumerated difference)', async () => {
        const input = { jsonrpc: '2.0', id: 11, method: 'definitely/unknown', params: {} };
        const legacy = await legacyLeg(input);
        const modern = await modernLeg(input);

        expect(legacy.error.code).toBe(-32_601);
        expect(modern.error.code).toBe(legacy.error.code);
        expect(modern.error.message).toBe(legacy.error.message);
        expect(modern.error.data).toEqual(legacy.error.data);

        // Enumerated difference: http-status-mapping.
        expect(legacy.status).toBe(200);
        expect(modern.status).toBe(404);
    });

    it('a handler-thrown protocol error produces the same in-band JSON-RPC error on both legs', async () => {
        const input = { jsonrpc: '2.0', id: 12, method: 'app/fail', params: {} };
        const legacy = await legacyLeg(input);
        const modern = await modernLeg(input);

        expect(legacy.status).toBe(200);
        expect(modern.status).toBe(200);
        expect(legacy.error).toMatchObject({ code: -32_002, message: 'resource missing' });
        expect(modern.error).toEqual(legacy.error);
    });

    it('a handler-level invalid-params rejection produces the same in-band error code on both legs', async () => {
        const failingParams = new Server({ name: 'parity-params', version: '1.0.0' }, { capabilities: {} });
        // Same registration on both legs: a custom method with a params schema
        // the input does not satisfy.
        const register = (server: Server) =>
            server.setRequestHandler('app/strict', { params: z.object({ value: z.string() }) }, async params => ({ ok: params.value }));
        register(failingParams);

        const legacyTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await failingParams.connect(legacyTransport);
        const legacyResponse = await legacyTransport.handleRequest(
            new Request('http://localhost/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'app/strict', params: { value: 7 } })
            })
        );
        const legacyBody = (await legacyResponse.json()) as { error: { code: number } };
        await failingParams.close();

        const modernServer = new Server({ name: 'parity-params', version: '1.0.0' }, { capabilities: {} });
        register(modernServer);
        setNegotiatedProtocolVersion(modernServer, MODERN_REVISION);
        const modernTransport = new PerRequestHTTPServerTransport({ classification: MODERN });
        await modernServer.connect(modernTransport);
        const modernResponse = await modernTransport.handleMessage({
            jsonrpc: '2.0',
            id: 13,
            method: 'app/strict',
            params: { value: 7, _meta: ENVELOPE }
        } as JSONRPCRequest);
        const modernBody = (await modernResponse.json()) as { error: { code: number } };
        await modernServer.close();

        expect(legacyBody.error.code).toBe(-32_602);
        expect(modernBody.error.code).toBe(legacyBody.error.code);
        // Handler-level invalid params stays in-band on both legs.
        expect(legacyResponse.status).toBe(200);
        expect(modernResponse.status).toBe(200);
    });
});
