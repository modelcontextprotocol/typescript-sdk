/**
 * Integration tests for VersionProbingHTTPClientTransport.
 *
 * These tests spin up lightweight HTTP mock servers (node:http) that emulate
 * the MCP server-side behaviour -- both the modern (2026-06) routing path and
 * the legacy (2025-11) streamable-HTTP path -- and verify that the client-side
 * probing, fallback, and tool-call flows work end-to-end over real HTTP.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { JSONRPCMessage, JSONRPCRequest, JSONRPCResponse } from '@modelcontextprotocol/core';

import { Client } from '../../src/client/client.js';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp.js';
import { VersionProbingHTTPClientTransport } from '../../src/client/versionProbingHttp.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const SERVER_NAME = 'test-server';
const SERVER_VERSION = '1.0.0';
const TOOL_NAME = 'greet';

const SERVER_CAPABILITIES = {
    tools: {},
    resources: {},
    prompts: {}
};

/**
 * The greet tool handler -- shared by both modern and legacy mock servers so
 * that the "content equivalence" test can rely on identical output.
 */
function greetToolResult(name: string) {
    return {
        content: [{ type: 'text' as const, text: `Hello, ${name}!` }]
    };
}

// ---------------------------------------------------------------------------
// Mock server helpers
// ---------------------------------------------------------------------------

/** Reads the full body of a Node IncomingMessage and JSON-parses it. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

/** Sends a JSON-RPC response object as HTTP 200 application/json. */
function sendJson(res: ServerResponse, body: unknown, status = 200, extraHeaders?: Record<string, string>): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
        ...extraHeaders
    });
    res.end(payload);
}

/** Sends a JSON-RPC error response. */
function sendJsonRpcError(res: ServerResponse, id: unknown, code: number, message: string, httpStatus = 200): void {
    sendJson(res, { jsonrpc: '2.0', id, error: { code, message } }, httpStatus);
}

/** Listen on a random port and return the base URL. */
function listenOnRandomPort(server: Server): Promise<URL> {
    return new Promise<URL>(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}/mcp`));
        });
    });
}

// ---------------------------------------------------------------------------
// Mock "routing" server (modern + legacy)
// ---------------------------------------------------------------------------

/**
 * Creates a mock HTTP server that supports both modern (2026-06, via
 * `Mcp-Method` header) and legacy (2025-11, via initialize handshake) paths.
 *
 * The modern path responds to `server/discover`, `tools/call`, and `tools/list`
 * using the `Mcp-Method` header to route. The legacy path performs a stateful
 * initialize handshake and tracks sessions via `Mcp-Session-Id`.
 */
function createRoutingServer(): Server {
    const sessions = new Map<string, { protocolVersion: string }>();

    return createServer(async (req, res) => {
        try {
            const mcpMethod = req.headers['mcp-method'] as string | undefined;

            if (mcpMethod) {
                // ---- Modern path ----
                if (req.method !== 'POST') {
                    res.writeHead(405, { Allow: 'POST' });
                    res.end();
                    return;
                }

                const body = (await readJsonBody(req)) as JSONRPCRequest;

                if (mcpMethod === 'server/discover') {
                    sendJson(res, {
                        jsonrpc: '2.0',
                        id: body.id,
                        result: {
                            supportedVersions: ['2026-06-30'],
                            capabilities: SERVER_CAPABILITIES,
                            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
                        }
                    } satisfies JSONRPCResponse);
                    return;
                }

                if (mcpMethod === 'tools/list') {
                    sendJson(res, {
                        jsonrpc: '2.0',
                        id: body.id,
                        result: {
                            result_type: 'complete',
                            tools: [
                                {
                                    name: TOOL_NAME,
                                    description: 'Greet someone',
                                    inputSchema: {
                                        type: 'object',
                                        properties: { name: { type: 'string' } },
                                        required: ['name']
                                    }
                                }
                            ]
                        }
                    } satisfies JSONRPCResponse);
                    return;
                }

                if (mcpMethod === 'tools/call') {
                    const args = body.params?.arguments as { name: string };
                    sendJson(res, {
                        jsonrpc: '2.0',
                        id: body.id,
                        result: {
                            result_type: 'complete',
                            ...greetToolResult(args.name)
                        }
                    } satisfies JSONRPCResponse);
                    return;
                }

                sendJsonRpcError(res, body.id, -32_601, `Method not found: ${mcpMethod}`);
                return;
            }

            // ---- Legacy path ----
            if (req.method === 'GET') {
                // SSE stream endpoint -- return 405 (optional per spec)
                const sessionId = req.headers['mcp-session-id'] as string | undefined;
                if (!sessionId || !sessions.has(sessionId)) {
                    res.writeHead(405);
                    res.end();
                    return;
                }
                // Keep alive SSE (just open and hold)
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });
                // Don't end -- let the client close
                req.on('close', () => res.end());
                return;
            }

            if (req.method === 'DELETE') {
                const sessionId = req.headers['mcp-session-id'] as string | undefined;
                if (sessionId) sessions.delete(sessionId);
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.method !== 'POST') {
                res.writeHead(405, { Allow: 'POST, GET, DELETE' });
                res.end();
                return;
            }

            const body = (await readJsonBody(req)) as JSONRPCMessage;
            const sessionId = req.headers['mcp-session-id'] as string | undefined;

            // Check if this is a notification (no id)
            if (!('id' in body) || body.id === undefined) {
                // Notification -- accept silently
                res.writeHead(202);
                res.end();
                return;
            }

            const rpcReq = body as JSONRPCRequest;

            if (rpcReq.method === 'initialize') {
                const newSessionId = randomUUID();
                const params = rpcReq.params as { protocolVersion: string };
                sessions.set(newSessionId, { protocolVersion: params.protocolVersion });

                sendJson(
                    res,
                    {
                        jsonrpc: '2.0',
                        id: rpcReq.id,
                        result: {
                            protocolVersion: '2025-11-25',
                            capabilities: SERVER_CAPABILITIES,
                            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
                        }
                    } satisfies JSONRPCResponse,
                    200,
                    { 'mcp-session-id': newSessionId }
                );
                return;
            }

            // All other requests require a session
            if (!sessionId || !sessions.has(sessionId)) {
                sendJsonRpcError(res, rpcReq.id, -32_000, 'Missing or invalid session', 400);
                return;
            }

            if (rpcReq.method === 'tools/list') {
                sendJson(res, {
                    jsonrpc: '2.0',
                    id: rpcReq.id,
                    result: {
                        tools: [
                            {
                                name: TOOL_NAME,
                                description: 'Greet someone',
                                inputSchema: {
                                    type: 'object',
                                    properties: { name: { type: 'string' } },
                                    required: ['name']
                                }
                            }
                        ]
                    }
                } satisfies JSONRPCResponse);
                return;
            }

            if (rpcReq.method === 'tools/call') {
                const args = rpcReq.params?.arguments as { name: string };
                sendJson(res, {
                    jsonrpc: '2.0',
                    id: rpcReq.id,
                    result: greetToolResult(args.name)
                } satisfies JSONRPCResponse);
                return;
            }

            if (rpcReq.method === 'ping') {
                sendJson(res, {
                    jsonrpc: '2.0',
                    id: rpcReq.id,
                    result: {}
                } satisfies JSONRPCResponse);
                return;
            }

            sendJsonRpcError(res, rpcReq.id, -32_601, `Method not found: ${rpcReq.method}`);
        } catch (error) {
            console.error('Mock routing server error:', error);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end();
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Mock "legacy-only" server (no server/discover support)
// ---------------------------------------------------------------------------

/**
 * Creates a mock HTTP server that ONLY supports the legacy (2025-11) path.
 * A `server/discover` probe (identified by the `Mcp-Method` header) will
 * receive a 404, causing the client to fall back to legacy mode.
 */
function createLegacyOnlyServer(): Server {
    const sessions = new Map<string, { protocolVersion: string }>();

    return createServer(async (req, res) => {
        try {
            // If the request has an Mcp-Method header, it's a modern probe --
            // this legacy-only server doesn't support it.
            const mcpMethod = req.headers['mcp-method'] as string | undefined;
            if (mcpMethod) {
                res.writeHead(404);
                res.end();
                return;
            }

            if (req.method === 'GET') {
                // SSE stream endpoint -- return 405 (optional per spec)
                res.writeHead(405);
                res.end();
                return;
            }

            if (req.method === 'DELETE') {
                const sessionId = req.headers['mcp-session-id'] as string | undefined;
                if (sessionId) sessions.delete(sessionId);
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.method !== 'POST') {
                res.writeHead(405, { Allow: 'POST, GET, DELETE' });
                res.end();
                return;
            }

            const body = (await readJsonBody(req)) as JSONRPCMessage;
            const sessionId = req.headers['mcp-session-id'] as string | undefined;

            // Notification
            if (!('id' in body) || body.id === undefined) {
                res.writeHead(202);
                res.end();
                return;
            }

            const rpcReq = body as JSONRPCRequest;

            if (rpcReq.method === 'initialize') {
                const newSessionId = randomUUID();
                const params = rpcReq.params as { protocolVersion: string };
                sessions.set(newSessionId, { protocolVersion: params.protocolVersion });

                const payload = JSON.stringify({
                    jsonrpc: '2.0',
                    id: rpcReq.id,
                    result: {
                        protocolVersion: '2025-11-25',
                        capabilities: SERVER_CAPABILITIES,
                        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
                    }
                } satisfies JSONRPCResponse);

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    'mcp-session-id': newSessionId
                });
                res.end(payload);
                return;
            }

            if (!sessionId || !sessions.has(sessionId)) {
                sendJsonRpcError(res, rpcReq.id, -32_000, 'Missing or invalid session', 400);
                return;
            }

            if (rpcReq.method === 'tools/list') {
                sendJson(res, {
                    jsonrpc: '2.0',
                    id: rpcReq.id,
                    result: {
                        tools: [
                            {
                                name: TOOL_NAME,
                                description: 'Greet someone',
                                inputSchema: {
                                    type: 'object',
                                    properties: { name: { type: 'string' } },
                                    required: ['name']
                                }
                            }
                        ]
                    }
                } satisfies JSONRPCResponse);
                return;
            }

            if (rpcReq.method === 'tools/call') {
                const args = rpcReq.params?.arguments as { name: string };
                sendJson(res, {
                    jsonrpc: '2.0',
                    id: rpcReq.id,
                    result: greetToolResult(args.name)
                } satisfies JSONRPCResponse);
                return;
            }

            if (rpcReq.method === 'ping') {
                sendJson(res, {
                    jsonrpc: '2.0',
                    id: rpcReq.id,
                    result: {}
                } satisfies JSONRPCResponse);
                return;
            }

            sendJsonRpcError(res, rpcReq.id, -32_601, `Method not found: ${rpcReq.method}`);
        } catch (error) {
            console.error('Mock legacy server error:', error);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end();
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Helper to close a server gracefully
// ---------------------------------------------------------------------------

function closeServer(server: Server): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
    });
}

// ===========================================================================
// Tests
// ===========================================================================

describe('VersionProbingHTTPClientTransport', () => {
    // -----------------------------------------------------------------------
    // 1. Modern client + routing server
    // -----------------------------------------------------------------------
    describe('modern client + routing server', () => {
        let server: Server;
        let baseUrl: URL;

        beforeAll(async () => {
            server = createRoutingServer();
            baseUrl = await listenOnRandomPort(server);
        });

        afterAll(async () => {
            await closeServer(server);
        });

        it('probes server/discover and enters modern mode', async () => {
            const transport = new VersionProbingHTTPClientTransport(baseUrl);
            try {
                await transport.start();

                expect(transport.mode).toBe('modern');
                expect(transport.getDiscoverResult()).toBeDefined();
                expect(transport.getDiscoverResult()!.supportedVersions).toContain('2026-06-30');
                expect(transport.getDiscoverResult()!.serverInfo.name).toBe(SERVER_NAME);
            } finally {
                await transport.close();
            }
        });

        it('callTool works via Client in modern mode', async () => {
            const transport = new VersionProbingHTTPClientTransport(baseUrl);
            const client = new Client({ name: 'test-client', version: '1.0.0' });
            try {
                await transport.start();
                expect(transport.mode).toBe('modern');

                await client.connect(transport);

                const result = await client.callTool({ name: TOOL_NAME, arguments: { name: 'World' } });
                expect(result.content).toEqual([{ type: 'text', text: 'Hello, World!' }]);
            } finally {
                await client.close();
            }
        });

        it('listTools works via Client in modern mode', async () => {
            const transport = new VersionProbingHTTPClientTransport(baseUrl);
            const client = new Client({ name: 'test-client', version: '1.0.0' });
            try {
                await transport.start();
                await client.connect(transport);

                const result = await client.listTools();
                expect(result.tools).toHaveLength(1);
                expect(result.tools[0]!.name).toBe(TOOL_NAME);
            } finally {
                await client.close();
            }
        });

        it('getServerCapabilities returns capabilities from discover', async () => {
            const transport = new VersionProbingHTTPClientTransport(baseUrl);
            const client = new Client({ name: 'test-client', version: '1.0.0' });
            try {
                await transport.start();
                await client.connect(transport);

                const caps = client.getServerCapabilities();
                expect(caps).toBeDefined();
                expect(caps!.tools).toBeDefined();
                expect(caps!.resources).toBeDefined();
                expect(caps!.prompts).toBeDefined();
            } finally {
                await client.close();
            }
        });
    });

    // -----------------------------------------------------------------------
    // 2. Modern client + legacy-only server
    // -----------------------------------------------------------------------
    describe('modern client + legacy-only server', () => {
        let server: Server;
        let baseUrl: URL;

        beforeAll(async () => {
            server = createLegacyOnlyServer();
            baseUrl = await listenOnRandomPort(server);
        });

        afterAll(async () => {
            await closeServer(server);
        });

        it('probe fails gracefully and falls back to legacy mode', async () => {
            const transport = new VersionProbingHTTPClientTransport(baseUrl);
            try {
                await transport.start();

                expect(transport.mode).toBe('legacy');
                expect(transport.getDiscoverResult()).toBeUndefined();
            } finally {
                await transport.close();
            }
        });

        it('callTool works via Client in legacy fallback mode', async () => {
            const transport = new VersionProbingHTTPClientTransport(baseUrl);
            const client = new Client({ name: 'test-client', version: '1.0.0' });
            try {
                await transport.start();
                expect(transport.mode).toBe('legacy');

                // connect() performs the initialize handshake in legacy mode
                await client.connect(transport);

                const result = await client.callTool({ name: TOOL_NAME, arguments: { name: 'World' } });
                expect(result.content).toEqual([{ type: 'text', text: 'Hello, World!' }]);
            } finally {
                await client.close();
            }
        });

        it('listTools works via Client in legacy fallback mode', async () => {
            const transport = new VersionProbingHTTPClientTransport(baseUrl);
            const client = new Client({ name: 'test-client', version: '1.0.0' });
            try {
                await transport.start();
                await client.connect(transport);

                const result = await client.listTools();
                expect(result.tools).toHaveLength(1);
                expect(result.tools[0]!.name).toBe(TOOL_NAME);
            } finally {
                await client.close();
            }
        });
    });

    // -----------------------------------------------------------------------
    // 3. Legacy client + routing server
    // -----------------------------------------------------------------------
    describe('legacy client + routing server', () => {
        let server: Server;
        let baseUrl: URL;

        beforeAll(async () => {
            server = createRoutingServer();
            baseUrl = await listenOnRandomPort(server);
        });

        afterAll(async () => {
            await closeServer(server);
        });

        it('callTool works via plain StreamableHTTPClientTransport (no probe)', async () => {
            const transport = new StreamableHTTPClientTransport(baseUrl);
            const client = new Client({ name: 'legacy-client', version: '1.0.0' });
            try {
                // Plain StreamableHTTPClientTransport does not probe -- it goes
                // straight to the initialize handshake which the routing server
                // routes to the legacy path (no Mcp-Method header).
                await client.connect(transport);

                const result = await client.callTool({ name: TOOL_NAME, arguments: { name: 'World' } });
                expect(result.content).toEqual([{ type: 'text', text: 'Hello, World!' }]);
            } finally {
                await client.close();
            }
        });

        it('listTools works via plain StreamableHTTPClientTransport', async () => {
            const transport = new StreamableHTTPClientTransport(baseUrl);
            const client = new Client({ name: 'legacy-client', version: '1.0.0' });
            try {
                await client.connect(transport);

                const result = await client.listTools();
                expect(result.tools).toHaveLength(1);
                expect(result.tools[0]!.name).toBe(TOOL_NAME);
            } finally {
                await client.close();
            }
        });
    });

    // -----------------------------------------------------------------------
    // 4. Content equivalence across all 3 combinations
    // -----------------------------------------------------------------------
    describe('content equivalence', () => {
        let routingServer: Server;
        let legacyServer: Server;
        let routingUrl: URL;
        let legacyUrl: URL;

        beforeAll(async () => {
            routingServer = createRoutingServer();
            legacyServer = createLegacyOnlyServer();
            [routingUrl, legacyUrl] = await Promise.all([listenOnRandomPort(routingServer), listenOnRandomPort(legacyServer)]);
        });

        afterAll(async () => {
            await Promise.all([closeServer(routingServer), closeServer(legacyServer)]);
        });

        it('same tool call returns identical content across all 3 combinations', async () => {
            const toolArgs = { name: TOOL_NAME, arguments: { name: 'Alice' } };

            // -- Combination 1: Modern client + routing server --
            const modernTransport = new VersionProbingHTTPClientTransport(routingUrl);
            const modernClient = new Client({ name: 'modern-client', version: '1.0.0' });
            await modernTransport.start();
            expect(modernTransport.mode).toBe('modern');
            await modernClient.connect(modernTransport);
            const modernResult = await modernClient.callTool(toolArgs);

            // -- Combination 2: Modern client + legacy server (fallback) --
            const fallbackTransport = new VersionProbingHTTPClientTransport(legacyUrl);
            const fallbackClient = new Client({ name: 'fallback-client', version: '1.0.0' });
            await fallbackTransport.start();
            expect(fallbackTransport.mode).toBe('legacy');
            await fallbackClient.connect(fallbackTransport);
            const fallbackResult = await fallbackClient.callTool(toolArgs);

            // -- Combination 3: Legacy client + routing server --
            const legacyTransport = new StreamableHTTPClientTransport(routingUrl);
            const legacyClient = new Client({ name: 'legacy-client', version: '1.0.0' });
            await legacyClient.connect(legacyTransport);
            const legacyResult = await legacyClient.callTool(toolArgs);

            // All three should return identical content
            const expectedContent = [{ type: 'text', text: 'Hello, Alice!' }];
            expect(modernResult.content).toEqual(expectedContent);
            expect(fallbackResult.content).toEqual(expectedContent);
            expect(legacyResult.content).toEqual(expectedContent);

            // Cross-check: they match each other
            expect(modernResult.content).toEqual(fallbackResult.content);
            expect(modernResult.content).toEqual(legacyResult.content);

            // Cleanup
            await Promise.all([modernClient.close(), fallbackClient.close(), legacyClient.close()]);
        });
    });
});
