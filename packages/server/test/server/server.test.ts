import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { Server } from '../../src/server/server.js';

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

    describe('server/discover (SEP-2575)', () => {
        it('returns capabilities/serverInfo/instructions without writing handshake state', async () => {
            const server = new Server({ name: 'disc', version: '2.0.0' }, { capabilities: { tools: {} }, instructions: 'hello' });

            const out: JSONRPCMessage[] = [];
            for await (const o of server.dispatch({ jsonrpc: '2.0', id: 1, method: 'server/discover' })) {
                out.push(o.message);
            }
            const last = out.at(-1) as { result?: unknown; error?: unknown };
            expect(last.error).toBeUndefined();
            expect(last.result).toMatchObject({
                serverInfo: { name: 'disc', version: '2.0.0' },
                capabilities: { tools: {} },
                instructions: 'hello'
            });
            expect((last.result as Record<string, unknown>).protocolVersion).toBeUndefined();
            expect(server.getClientCapabilities()).toBeUndefined();
        });
    });

    describe('per-request clientCapabilities (SEP-2575)', () => {
        it('ctx.mcpReq.elicitInput respects _meta.clientCapabilities over singleton', async () => {
            const server = new Server({ name: 't', version: '1' }, { capabilities: { tools: {} } });
            // No initialize: singleton _clientCapabilities is undefined.
            let elicitErr: unknown;
            server.setRequestHandler('tools/call', async (_req, ctx) => {
                try {
                    await ctx.mcpReq.elicitInput({ message: 'm', requestedSchema: { type: 'object', properties: {} } });
                } catch (e) {
                    elicitErr = e;
                }
                return { content: [] };
            });

            // First call: no _meta caps -> elicitInput should reject (no caps anywhere).
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _o of server.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }));
            expect(elicitErr).toBeDefined();
            elicitErr = undefined;

            // Second call: _meta carries elicitation.form -> capability check passes
            // (the actual send will reject NotConnected since there's no env.send, but
            // that proves we got past the cap check).
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _o of server.dispatch({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'x', _meta: { 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } } } }
            }));
            expect(String(elicitErr)).not.toMatch(/CapabilityNotSupported|does not support/i);
        });
    });
});
