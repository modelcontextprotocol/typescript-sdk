/**
 * Era-parity error shapes: the same malformed input produces the same
 * JSON-RPC error shape on the 2025-era (session-oriented streamable HTTP
 * transport) and on the modern per-request path — modulo an explicitly
 * enumerated table of era-mandated differences. Anything outside that table
 * is a parity regression.
 */
import type { CallToolResult, JSONRPCRequest, MessageClassification } from '@modelcontextprotocol/core';
import {
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
 * - The modern era requires the per-request `_meta` envelope on every
 *   request; the inputs below carry it on the modern leg only, where it is
 *   wire-level bookkeeping that never reaches handlers.
 */
const ERA_MANDATED_DIFFERENCES = ['http-status-mapping', 'per-request-envelope'] as const;

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
    it('enumerates the era-mandated differences it tolerates', () => {
        expect(ERA_MANDATED_DIFFERENCES).toEqual(['http-status-mapping', 'per-request-envelope']);
    });

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
