import type { JSONRPCMessage, JSONRPCRequest, ServerContext, StatelessHandlers, Transport } from '@modelcontextprotocol/core';
import {
    DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    DRAFT_PROTOCOL_VERSION,
    InitializeResultSchema,
    InMemoryTransport,
    isJSONRPCResultResponse,
    LATEST_PROTOCOL_VERSION,
    NotImplementedYetError,
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

    describe('initialize negotiates stateful protocol versions only', () => {
        it('treats a requested stateless version as unsupported and responds with its first stateful version', async () => {
            const server = new Server(
                { name: 'test', version: '1.0.0' },
                {
                    capabilities: {},
                    supportedProtocolVersions: [LATEST_PROTOCOL_VERSION, DRAFT_PROTOCOL_VERSION]
                }
            );

            const respondedVersion = await initializeServer(server, DRAFT_PROTOCOL_VERSION);

            expect(respondedVersion).toBe(LATEST_PROTOCOL_VERSION);
            expect(server.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);

            await server.close();
        });

        it('falls back to its first stateful supported version regardless of list order', async () => {
            const server = new Server(
                { name: 'test', version: '1.0.0' },
                {
                    capabilities: {},
                    supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION]
                }
            );

            const respondedVersion = await initializeServer(server, UNSUPPORTED_VERSION);

            expect(respondedVersion).toBe(LATEST_PROTOCOL_VERSION);
            expect(server.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);

            await server.close();
        });
    });

    describe('ctx.client / ctx.mcpReq.protocolVersion on the handler context', () => {
        // The post-initialize values (declared capabilities/info, negotiated version) are
        // observable over the wire and covered by the handler-context e2e scenarios; only the
        // pre-initialize state is pinned here.
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

    describe('connect() installs the stateless dispatch seam', () => {
        /** Minimal transport double offering the `setStatelessHandlers` seam. */
        function transportDouble(): {
            transport: Transport;
            calls: string[];
            handlers: () => StatelessHandlers | undefined;
        } {
            const calls: string[] = [];
            let installed: StatelessHandlers | undefined;
            const transport: Transport = {
                start: async () => {
                    calls.push('start');
                },
                send: async () => {},
                close: async () => {},
                setStatelessHandlers: handlers => {
                    calls.push('setStatelessHandlers');
                    installed = handlers;
                }
            };
            return { transport, calls, handlers: () => installed };
        }

        it('installs the dispatch handler before starting the transport', async () => {
            const { transport, calls, handlers } = transportDouble();
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });

            await server.connect(transport);

            expect(calls).toEqual(['setStatelessHandlers', 'start']);
            expect(handlers()).toBeDefined();

            await server.close();
        });
    });

    describe('list_changed emission under per-request revisions', () => {
        // TODO(subscriptions PR): these notifications gain their per-request-era
        // carrier (subscriptions/listen); the guard and this block go away then.
        it('rejects list_changed emission on a server configured for per-request revisions only', async () => {
            const server = new Server(
                { name: 'test', version: '1.0.0' },
                { capabilities: { tools: {}, prompts: {}, resources: {} }, supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION] }
            );

            await expect(server.sendToolListChanged()).rejects.toThrow(NotImplementedYetError);
            await expect(server.sendPromptListChanged()).rejects.toThrow(NotImplementedYetError);
            await expect(server.sendResourceListChanged()).rejects.toThrow(NotImplementedYetError);
        });

        it('keeps list_changed emission for servers listing an initialize-era version', async () => {
            // Default supported list (initialize-era versions present): the guard never
            // fires — the emission proceeds to the existing not-connected failure mode.
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });

            await expect(server.sendToolListChanged()).rejects.toThrow(/[Nn]ot connected/);
        });
    });
});
