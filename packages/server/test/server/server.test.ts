import type { CallToolResult, JSONRPCMessage, JSONRPCRequest, Tool } from '@modelcontextprotocol/core-internal';
import {
    InitializeResultSchema,
    InMemoryTransport,
    isJSONRPCResultResponse,
    LATEST_PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core-internal';
import { Server } from '../../src/server/server';

/** An older protocol version the server supports out of the box. */
const OLDER_SUPPORTED_VERSION = '2025-03-26';

/** A protocol version the server does not support. */
const UNSUPPORTED_VERSION = '1999-01-01';

/**
 * Connects the server to a fresh linked in-memory transport pair and drives the
 * initialize handshake from the client side, requesting `requestedVersion`.
 * Returns the protocol version the server responded with.
 */
async function initializeServer(server: Server, requestedVersion: string): Promise<string> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const responsePromise = new Promise<JSONRPCMessage>(resolve => {
        clientTransport.onmessage = msg => resolve(msg);
    });
    await clientTransport.start();

    const initializeRequest: JSONRPCRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: requestedVersion,
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' }
        }
    };
    await clientTransport.send(initializeRequest);

    const response = await responsePromise;
    if (!isJSONRPCResultResponse(response)) {
        throw new Error(`Expected a result response to initialize, got: ${JSON.stringify(response)}`);
    }
    return InitializeResultSchema.parse(response.result).protocolVersion;
}

describe('Server', () => {
    describe('_oninitialize', () => {
        it('should propagate negotiated protocol version to transport', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            const setProtocolVersion = vi.fn();
            (serverTransport as { setProtocolVersion?: (version: string) => void }).setProtocolVersion = setProtocolVersion;

            await server.connect(serverTransport);

            // Collect response from the server
            const responsePromise = new Promise<JSONRPCMessage>(resolve => {
                clientTransport.onmessage = msg => resolve(msg);
            });
            await clientTransport.start();

            // Send initialize request directly
            await clientTransport.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' }
                }
            } as JSONRPCMessage);

            await responsePromise;

            expect(setProtocolVersion).toHaveBeenCalledWith(LATEST_PROTOCOL_VERSION);

            await server.close();
        });
    });

    describe('getNegotiatedProtocolVersion', () => {
        it('returns undefined before initialization', () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            expect(server.getNegotiatedProtocolVersion()).toBeUndefined();
        });

        it('returns the requested version after initialize when the server supports it', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            const respondedVersion = await initializeServer(server, LATEST_PROTOCOL_VERSION);

            expect(respondedVersion).toBe(LATEST_PROTOCOL_VERSION);
            expect(server.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);

            await server.close();
        });

        it('returns the older version when the client requests an older supported version', async () => {
            expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(OLDER_SUPPORTED_VERSION);
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            const respondedVersion = await initializeServer(server, OLDER_SUPPORTED_VERSION);

            expect(respondedVersion).toBe(OLDER_SUPPORTED_VERSION);
            expect(server.getNegotiatedProtocolVersion()).toBe(OLDER_SUPPORTED_VERSION);

            await server.close();
        });

        it('returns the fallback version when the client requests an unsupported version', async () => {
            expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain(UNSUPPORTED_VERSION);
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            const respondedVersion = await initializeServer(server, UNSUPPORTED_VERSION);

            // The server falls back to its latest supported version and the getter reflects
            // the version it actually responded with, not the one the client asked for.
            expect(respondedVersion).toBe(LATEST_PROTOCOL_VERSION);
            expect(server.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);

            await server.close();
        });

        it('counter-offers only released versions when a draft revision is requested', async () => {
            // ORDERING PIN — counter-offer leak guard. The initialize accept
            // check and counter-offer are now ERA-AWARE: they consult only the
            // legacy (pre-2026-07-28) subset of `supportedProtocolVersions`,
            // because a 2026-07-28-or-later revision is never negotiated via
            // the legacy initialize handshake (it is only selected through
            // server/discover). This pin holds even after a future
            // LATEST/SUPPORTED constant bump adds a modern revision: the
            // counter-offer can never name it. The dual-era list arms live in
            // discover.test.ts ("era-aware counter-offer ordering").
            const DRAFT_REVISION = '2026-07-28';
            expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain(DRAFT_REVISION);
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            const respondedVersion = await initializeServer(server, DRAFT_REVISION);

            expect(respondedVersion).toBe(LATEST_PROTOCOL_VERSION);
            expect(respondedVersion).not.toBe(DRAFT_REVISION);
            expect(server.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);

            await server.close();
        });
    });

    describe('tools/call handler-result validation (content default)', () => {
        // Pin for the v1-parity authoring affordance: content-less handler
        // results normalize to content: [] before era validation, on every
        // leg; other result families are not normalized.
        async function callToolOnServer(result: CallToolResult): Promise<JSONRPCMessage> {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });
            server.setRequestHandler('tools/call', () => result);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            const received: JSONRPCMessage[] = [];
            clientTransport.onmessage = message => void received.push(message);
            await server.connect(serverTransport);
            await clientTransport.start();

            await clientTransport.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' }
                }
            });
            await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } });
            await new Promise(resolve => setTimeout(resolve, 10));
            await server.close();

            const response = received.find(message => (message as { id?: unknown }).id === 2);
            if (!response) {
                throw new Error('no tools/call response received');
            }
            return response;
        }

        it('defaults a structured-only handler result (no content) to content: [] on the wire (v1 parity)', async () => {
            // Runtime defaults structured-only results (v1 parity); the wire
            // stays spec-valid with content: [].
            const response = await callToolOnServer({ structuredContent: { ok: true } } as unknown as CallToolResult);

            const result = (response as { result?: { content?: unknown; structuredContent?: unknown } }).result;
            expect(result).toBeDefined();
            expect(result!.content).toEqual([]);
            expect(result!.structuredContent).toEqual({ ok: true });
        });

        it('does not normalize an array handler result — rejected loudly', async () => {
            const response = await callToolOnServer([{ type: 'text', text: 'hi' }] as unknown as CallToolResult);
            const error = (response as { error?: { code: number } }).error;
            expect(error).toBeDefined();
            expect(error!.code).toBe(-32602);
        });

        it('does not normalize a foreign-family body with an explicit content: undefined', async () => {
            const response = await callToolOnServer({
                task: { taskId: 't-1', status: 'working' },
                content: undefined
            } as unknown as CallToolResult);
            const error = (response as { error?: { code: number } }).error;
            expect(error).toBeDefined();
            expect(error!.code).toBe(-32602);
        });

        it('does not normalize a body carrying another result family — rejected loudly', async () => {
            const response = await callToolOnServer({
                inputRequests: { r1: { method: 'elicitation/create' } }
            } as unknown as CallToolResult);

            const error = (response as { error?: { code: number; message: string } }).error;
            expect(error).toBeDefined();
            expect(error!.code).toBe(-32602);
        });

        it('passes an authored-content result through to the wire', async () => {
            const response = await callToolOnServer({
                content: [{ type: 'text', text: 'hi' }],
                structuredContent: { ok: true }
            });

            if (!isJSONRPCResultResponse(response)) {
                throw new Error(`Expected a result response, got: ${JSON.stringify(response)}`);
            }
            const result = response.result as { content: unknown; structuredContent: unknown };
            expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
            expect(result.structuredContent).toEqual({ ok: true });
        });
    });

    describe('low-level tools/call input validation', () => {
        async function callTool(
            server: Server,
            args: Record<string, unknown>,
            inputSchema: Tool['inputSchema'] = {
                type: 'object',
                properties: { code: { type: 'string' } },
                required: ['code']
            },
            requestList = true
        ): Promise<{ response: JSONRPCMessage; receivedArgs: Record<string, unknown> | undefined }> {
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            const waiters = new Map<string | number, (message: JSONRPCMessage) => void>();
            const receivedArgs: { value: Record<string, unknown> | undefined } = { value: undefined };

            clientTransport.onmessage = message => {
                if (!('id' in message) || message.id === undefined || message.id === null) {
                    return;
                }
                waiters.get(message.id)?.(message);
                waiters.delete(message.id);
            };

            server.setRequestHandler('tools/list', () => ({
                tools: [
                    {
                        name: 'scan_code_imports',
                        inputSchema
                    }
                ]
            }));
            server.setRequestHandler('tools/call', request => {
                receivedArgs.value = request.params.arguments;
                return { content: [{ type: 'text', text: 'CLEAN' }] };
            });

            await server.connect(serverTransport);
            await clientTransport.start();

            const request = (message: JSONRPCRequest): Promise<JSONRPCMessage> =>
                new Promise(resolve => {
                    waiters.set(message.id, resolve);
                    void clientTransport.send(message);
                });

            await request({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' }
                }
            });
            await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            if (requestList) {
                await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
            }
            const response = await request({
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'scan_code_imports', arguments: args }
            });

            await server.close();
            return { response, receivedArgs: receivedArgs.value };
        }

        it('returns a tool error and does not dispatch invalid arguments', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });

            const { response, receivedArgs } = await callTool(server, { code: 12345 });

            if (!isJSONRPCResultResponse(response)) {
                throw new Error(`Expected a result response, got: ${JSON.stringify(response)}`);
            }

            expect(receivedArgs).toBeUndefined();
            expect(response.result).toMatchObject({
                isError: true,
                content: [{ type: 'text', text: expect.stringContaining('Invalid arguments for tool scan_code_imports') }]
            });
        });

        it('dispatches arguments that satisfy the declared schema', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });

            const { response, receivedArgs } = await callTool(server, { code: 'import pathlib' });

            if (!isJSONRPCResultResponse(response)) {
                throw new Error(`Expected a result response, got: ${JSON.stringify(response)}`);
            }

            expect(receivedArgs).toEqual({ code: 'import pathlib' });
            expect(response.result).toEqual({ content: [{ type: 'text', text: 'CLEAN' }] });
        });

        it('does not reuse tool schemas after the connection closes', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });

            const firstCall = await callTool(server, { code: 12345 });
            expect(firstCall.receivedArgs).toBeUndefined();

            const secondCall = await callTool(
                server,
                { code: 12345 },
                {
                    type: 'object',
                    properties: { code: { type: 'number' } },
                    required: ['code']
                },
                false
            );

            expect(secondCall.receivedArgs).toEqual({ code: 12345 });
            expect(secondCall.response).toMatchObject({ result: { content: [{ type: 'text', text: 'CLEAN' }] } });
        });

        it('preserves low-level dispatch when no tool list has been requested', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });
            let called = false;
            server.setRequestHandler('tools/call', () => {
                called = true;
                return { content: [{ type: 'text', text: 'CLEAN' }] };
            });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            const responsePromise = new Promise<JSONRPCMessage>(resolve => {
                clientTransport.onmessage = resolve;
            });
            await server.connect(serverTransport);
            await clientTransport.start();
            await clientTransport.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' }
                }
            });
            await responsePromise;

            const callResponsePromise = new Promise<JSONRPCMessage>(resolve => {
                clientTransport.onmessage = resolve;
            });
            await clientTransport.send({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'scan_code_imports', arguments: { code: 12345 } }
            });
            const response = await callResponsePromise;

            await server.close();
            expect(called).toBe(true);
            expect(response).toMatchObject({ result: { content: [{ type: 'text', text: 'CLEAN' }] } });
        });

        it('uses the configured JSON Schema validator for low-level tool calls', async () => {
            const validator = {
                getValidator: vi.fn(() => (value: unknown) => ({
                    valid: false as const,
                    data: undefined,
                    errorMessage: `Rejected ${JSON.stringify(value)}`
                }))
            };
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} }, jsonSchemaValidator: validator });

            const { response, receivedArgs } = await callTool(server, { code: 'import pathlib' });

            expect(receivedArgs).toBeUndefined();
            expect(validator.getValidator).toHaveBeenCalledTimes(1);
            expect(response).toMatchObject({
                result: {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: 'Input validation error: Invalid arguments for tool scan_code_imports: Rejected {"code":"import pathlib"}'
                        }
                    ]
                }
            });
        });
    });
});
