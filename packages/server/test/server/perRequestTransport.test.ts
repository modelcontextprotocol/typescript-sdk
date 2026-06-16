/**
 * The per-request HTTP server transport: single-exchange contract, the
 * classification handoff into protocol dispatch, HTTP status mapping for
 * pre-handler rejections, auth-info pass-through, and the close/teardown
 * chain.
 */
import type { CallToolResult, JSONRPCNotification, JSONRPCRequest, MessageClassification, ServerContext } from '@modelcontextprotocol/core';
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

const MODERN_REVISION = '2026-07-28';
const MODERN: MessageClassification = { era: 'modern', revision: MODERN_REVISION };
const LEGACY: MessageClassification = { era: 'legacy' };

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'per-request-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

// `meta: null` builds an envelope-less request; the default is the full envelope.
const toolsCall = (id = 1, meta: Record<string, unknown> | null = ENVELOPE): JSONRPCRequest =>
    ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'echo', arguments: {}, ...(meta !== null && { _meta: meta }) }
    }) as JSONRPCRequest;

const envelopedRequest = (method: string, id = 1): JSONRPCRequest =>
    ({ jsonrpc: '2.0', id, method, params: { _meta: ENVELOPE } }) as JSONRPCRequest;

interface ServerSetup {
    server: Server;
    lastCtx: () => ServerContext | undefined;
}

function modernServer(options: { toolsCallHandler?: (ctx: ServerContext) => Promise<CallToolResult> } = {}): ServerSetup {
    const server = new Server({ name: 'per-request-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    let captured: ServerContext | undefined;
    const defaultHandler = async (): Promise<CallToolResult> => ({ content: [{ type: 'text', text: 'served' }] });
    server.setRequestHandler('tools/call', async (_request, ctx) => {
        captured = ctx;
        return (options.toolsCallHandler ?? defaultHandler)(ctx);
    });
    setNegotiatedProtocolVersion(server, MODERN_REVISION);
    return { server, lastCtx: () => captured };
}

async function connectedTransport(
    server: Server,
    options?: ConstructorParameters<typeof PerRequestHTTPServerTransport>[0]
): Promise<PerRequestHTTPServerTransport> {
    const transport = new PerRequestHTTPServerTransport(options ?? { classification: MODERN });
    await server.connect(transport);
    return transport;
}

const errorOf = (body: unknown) => (body as { error?: { code: number; message: string; data?: unknown } }).error;

describe('single-exchange contract', () => {
    it('throws when a message is handled before a server is connected', async () => {
        const transport = new PerRequestHTTPServerTransport({ classification: MODERN });
        await expect(transport.handleMessage(toolsCall())).rejects.toThrow(/not connected/);
    });

    it('serves exactly one exchange — a second handleMessage throws', async () => {
        const { server } = modernServer();
        const transport = await connectedTransport(server);
        const first = await transport.handleMessage(toolsCall());
        expect(first.status).toBe(200);
        await expect(transport.handleMessage(toolsCall(2))).rejects.toThrow(/exactly one exchange/);
    });

    it('cannot be started twice', async () => {
        const transport = new PerRequestHTTPServerTransport({ classification: MODERN });
        await transport.start();
        await expect(transport.start()).rejects.toThrow(/already started/);
    });

    it('answers notification POST bodies with 202 and no body', async () => {
        const { server } = modernServer();
        let delivered: string | undefined;
        server.fallbackNotificationHandler = async notification => {
            delivered = notification.method;
        };
        const transport = await connectedTransport(server);
        const response = await transport.handleMessage({ jsonrpc: '2.0', method: 'demo/heartbeat' } as JSONRPCNotification);
        expect(response.status).toBe(202);
        expect(await response.text()).toBe('');
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(delivered).toBe('demo/heartbeat');
        await transport.close();
        await server.close();
    });
});

describe('classification handoff into dispatch', () => {
    it('serves a modern-classified request on a modern-marked instance', async () => {
        const { server } = modernServer();
        const transport = await connectedTransport(server);
        const response = await transport.handleMessage(toolsCall());
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
        expect(body.result.content[0]?.text).toBe('served');
    });

    it('answers legacy-classified traffic on a modern-marked instance with the protocol-version error and HTTP 400', async () => {
        const { server } = modernServer();
        const transport = await connectedTransport(server, { classification: LEGACY });
        server.onerror = () => {
            // The mismatch is also surfaced out of band; irrelevant here.
        };
        const response = await transport.handleMessage(toolsCall(1, null));
        expect(response.status).toBe(400);
        const error = errorOf(await response.json());
        expect(error?.code).toBe(-32_004);
        expect(error?.data).toMatchObject({ requested: expect.any(String), supported: expect.any(Array) });
    });

    it('answers modern-classified traffic on an unmarked (legacy) instance with the protocol-version error', async () => {
        const server = new Server({ name: 'unmarked', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.setRequestHandler('tools/call', async () => ({ content: [] }));
        server.onerror = () => {
            // The mismatch is also surfaced out of band; irrelevant here.
        };
        const transport = await connectedTransport(server, { classification: MODERN });
        const response = await transport.handleMessage(toolsCall());
        expect(response.status).toBe(400);
        expect(errorOf(await response.json())?.code).toBe(-32_004);
    });
});

describe('HTTP status mapping', () => {
    it('maps method-not-found for an era-removed method to HTTP 404', async () => {
        const { server } = modernServer();
        const transport = await connectedTransport(server);
        // `ping` exists on the 2025 era but has no entry on the 2026 registry.
        const response = await transport.handleMessage(envelopedRequest('ping'));
        expect(response.status).toBe(404);
        expect(errorOf(await response.json())).toMatchObject({ code: -32_601, message: 'Method not found' });
    });

    it('maps method-not-found for an unknown method with no handler to HTTP 404', async () => {
        const { server } = modernServer();
        const transport = await connectedTransport(server);
        const response = await transport.handleMessage(envelopedRequest('definitely/unknown'));
        expect(response.status).toBe(404);
        expect(errorOf(await response.json())?.code).toBe(-32_601);
    });

    it('keeps handler-produced errors in-band on HTTP 200, whatever their code', async () => {
        const { server } = modernServer({
            toolsCallHandler: async () => {
                throw new ProtocolError(-32_002, 'resource missing');
            }
        });
        const transport = await connectedTransport(server);
        const response = await transport.handleMessage(toolsCall());
        expect(response.status).toBe(200);
        expect(errorOf(await response.json())).toMatchObject({ code: -32_002, message: 'resource missing' });
    });

    it('keeps a handler-thrown method-not-found error in-band on HTTP 200 (the status table is origin-keyed)', async () => {
        // A handler relaying a downstream -32601 (a proxy/relay tool is the
        // realistic case) is a handler-produced error: it must not be
        // re-mapped to HTTP 404 just because the ladder table maps that code
        // for ladder-originated rejections.
        const { server } = modernServer({
            toolsCallHandler: async () => {
                throw new ProtocolError(-32_601, 'Method not found');
            }
        });
        const transport = await connectedTransport(server);
        const response = await transport.handleMessage(toolsCall());
        expect(response.status).toBe(200);
        expect(errorOf(await response.json())).toMatchObject({ code: -32_601, message: 'Method not found' });
    });

    it('keeps a handler-thrown unsupported-protocol-version error in-band on HTTP 200', async () => {
        const { server } = modernServer({
            toolsCallHandler: async () => {
                throw new ProtocolError(-32_004, 'Unsupported protocol version: 2099-01-01');
            }
        });
        const transport = await connectedTransport(server);
        const response = await transport.handleMessage(toolsCall());
        expect(response.status).toBe(200);
        expect(errorOf(await response.json())?.code).toBe(-32_004);
    });

    it('keeps handler-produced invalid-params errors in-band on HTTP 200 (never status-mapped)', async () => {
        const { server } = modernServer({
            toolsCallHandler: async () => {
                throw new ProtocolError(-32_602, 'bad arguments');
            }
        });
        const transport = await connectedTransport(server);
        const response = await transport.handleMessage(toolsCall());
        expect(response.status).toBe(200);
        expect(errorOf(await response.json())?.code).toBe(-32_602);
    });

    it('keeps the dispatch-level envelope check in-band: only the edge classifier maps invalid params to 400', async () => {
        const { server } = modernServer();
        const transport = await connectedTransport(server);
        // Modern-classified request without the _meta envelope: the dispatch
        // layer rejects it with invalid params; the transport does not turn
        // that into an HTTP-level failure.
        const response = await transport.handleMessage(toolsCall(1, null));
        expect(response.status).toBe(200);
        expect(errorOf(await response.json())?.code).toBe(-32_602);
    });
});

describe('auth info is strictly pass-through', () => {
    it('never derives authInfo from the inbound request headers', async () => {
        const { server, lastCtx } = modernServer();
        const transport = await connectedTransport(server);
        const request = new Request('http://localhost/mcp', {
            method: 'POST',
            headers: { authorization: 'Bearer super-secret-token', 'content-type': 'application/json' }
        });
        const response = await transport.handleMessage(toolsCall(), { request });
        expect(response.status).toBe(200);
        const ctx = lastCtx();
        expect(ctx?.http?.req).toBe(request);
        // The Authorization header is visible on the raw request, but it is
        // never promoted to validated auth info by the transport.
        expect(ctx?.http?.req?.headers.get('authorization')).toBe('Bearer super-secret-token');
        expect(ctx?.http?.authInfo).toBeUndefined();
    });

    it('surfaces caller-provided authInfo unchanged', async () => {
        const { server, lastCtx } = modernServer();
        const transport = await connectedTransport(server);
        const authInfo = { token: 'validated-token', clientId: 'client-1', scopes: ['mcp'] };
        const response = await transport.handleMessage(toolsCall(), { authInfo });
        expect(response.status).toBe(200);
        expect(lastCtx()?.http?.authInfo).toEqual(authInfo);
    });
});

describe('teardown and the close chain', () => {
    it('close is idempotent and fires onclose exactly once', async () => {
        const { server } = modernServer();
        const transport = await connectedTransport(server);
        let closes = 0;
        const previous = transport.onclose;
        transport.onclose = () => {
            closes += 1;
            previous?.();
        };
        await transport.close();
        await transport.close();
        expect(closes).toBe(1);
    });

    it('server.close() and transport.close() do not re-enter each other', async () => {
        const first = modernServer();
        const firstTransport = await connectedTransport(first.server);
        await first.server.close();
        await firstTransport.close();

        const second = modernServer();
        const secondTransport = await connectedTransport(second.server);
        await secondTransport.close();
        await second.server.close();
    });

    it('closing mid-request rejects the pending response and aborts the handler', async () => {
        let observedSignal: AbortSignal | undefined;
        const { server } = modernServer({
            toolsCallHandler: ctx => {
                observedSignal = ctx.mcpReq.signal;
                return new Promise<never>(() => {
                    // never resolves; the exchange is torn down externally
                });
            }
        });
        const transport = await connectedTransport(server);
        const pending = transport.handleMessage(toolsCall());
        const expectation = expect(pending).rejects.toThrow(/Connection closed/);
        await new Promise(resolve => setTimeout(resolve, 5));
        await transport.close();
        await expectation;
        expect(observedSignal?.aborted).toBe(true);
    });

    it('an aborted request signal cancels the exchange', async () => {
        let observedSignal: AbortSignal | undefined;
        const { server } = modernServer({
            toolsCallHandler: ctx => {
                observedSignal = ctx.mcpReq.signal;
                return new Promise<never>(() => {
                    // parked until the client goes away
                });
            }
        });
        const transport = await connectedTransport(server);
        const abortController = new AbortController();
        const request = new Request('http://localhost/mcp', { method: 'POST', signal: abortController.signal });
        const pending = transport.handleMessage(toolsCall(), { request });
        const expectation = expect(pending).rejects.toThrow(/Connection closed/);
        await new Promise(resolve => setTimeout(resolve, 5));
        abortController.abort();
        await expectation;
        expect(observedSignal?.aborted).toBe(true);
    });

    it('drops writes after close without raising', async () => {
        const { server } = modernServer();
        const transport = await connectedTransport(server);
        await transport.close();
        await expect(transport.send({ jsonrpc: '2.0', id: 1, result: {} }, { relatedRequestId: 1 })).resolves.toBeUndefined();
    });

    it('drops messages unrelated to the in-flight request', async () => {
        const { server } = modernServer({
            toolsCallHandler: async () => ({ content: [{ type: 'text', text: 'done' }] })
        });
        const transport = await connectedTransport(server);
        const pending = transport.handleMessage(toolsCall());
        // A session-wide notification with no related request has nowhere to
        // go on a per-request exchange.
        await transport.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        const response = await pending;
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
    });
});

describe('custom-method requests', () => {
    it('serves custom (extension) methods registered with explicit schemas', async () => {
        const { server } = modernServer();
        server.setRequestHandler('app/echo', { params: z.looseObject({ value: z.string() }) }, async params => ({
            echoed: params.value
        }));
        const transport = await connectedTransport(server);
        const response = await transport.handleMessage({
            jsonrpc: '2.0',
            id: 4,
            method: 'app/echo',
            params: { value: 'hello', _meta: ENVELOPE }
        } as JSONRPCRequest);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result: { echoed: string } };
        expect(body.result.echoed).toBe('hello');
    });
});
