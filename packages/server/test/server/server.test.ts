import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core';
import type { ClientCapabilities, Implementation, ServerContext } from '@modelcontextprotocol/core';
import {
    DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    DRAFT_PROTOCOL_VERSION_2026,
    InitializeResultSchema,
    InMemoryTransport,
    isJSONRPCResultResponse,
    LATEST_PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';
import { Server } from '../../src/server/server.js';

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
    });

    // The validation itself lives in the shared Protocol constructor (covered in depth by the core
    // package's protocol.test.ts); these are smoke tests that ServerOptions passes both keys through.
    describe('draft protocol version opt-in (allowDraftVersions)', () => {
        it('throws at construction when a draft version is listed without allowDraftVersions', () => {
            const construct = () =>
                new Server(
                    { name: 'test', version: '1.0.0' },
                    { capabilities: {}, supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION_2026] }
                );

            expect(construct).toThrow(DRAFT_PROTOCOL_VERSION_2026);
            expect(construct).toThrow('allowDraftVersions');
        });

        it('constructs when a draft version is listed and allowDraftVersions is true', () => {
            const server = new Server(
                { name: 'test', version: '1.0.0' },
                {
                    capabilities: {},
                    supportedProtocolVersions: [LATEST_PROTOCOL_VERSION, DRAFT_PROTOCOL_VERSION_2026],
                    allowDraftVersions: true
                }
            );

            expect(server).toBeInstanceOf(Server);
        });
    });

    describe('ctx.client / ctx.mcpReq.protocolVersion on the handler context', () => {
        /**
         * Connects the server, registers a ping handler that captures its ServerContext, drives the
         * initialize handshake (with the given client capabilities/info), then sends a ping so the
         * handler runs. Returns the captured context.
         */
        async function captureContextAfterInitialize(
            server: Server,
            requestedVersion: string,
            clientCapabilities: ClientCapabilities,
            clientInfo: Implementation
        ): Promise<ServerContext> {
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await server.connect(serverTransport);

            let captured: ServerContext | undefined;
            server.setRequestHandler('ping', async (_request, ctx) => {
                captured = ctx;
                return {};
            });

            await clientTransport.start();

            const initResponse = new Promise<void>(resolve => {
                clientTransport.onmessage = () => resolve();
            });
            await clientTransport.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: requestedVersion, capabilities: clientCapabilities, clientInfo }
            } as JSONRPCMessage);
            await initResponse;

            const pingResponse = new Promise<void>(resolve => {
                clientTransport.onmessage = () => resolve();
            });
            await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} } as JSONRPCMessage);
            await pingResponse;

            if (!captured) {
                throw new Error('ping handler did not run');
            }
            return captured;
        }

        it('pre-initialize: ping before the handshake gets {} capabilities, undefined info, and the default version', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await server.connect(serverTransport);

            let captured: ServerContext | undefined;
            server.setRequestHandler('ping', async (_request, ctx) => {
                captured = ctx;
                return {};
            });

            await clientTransport.start();
            const pingResponse = new Promise<void>(resolve => {
                clientTransport.onmessage = () => resolve();
            });
            // No initialize handshake first - only ping is legal pre-initialize.
            await clientTransport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} } as JSONRPCMessage);
            await pingResponse;

            expect(captured?.client.capabilities).toEqual({});
            expect(captured?.client.info).toBeUndefined();
            expect(captured?.mcpReq.protocolVersion).toBe(DEFAULT_NEGOTIATED_PROTOCOL_VERSION);

            await server.close();
        });
    });
});
