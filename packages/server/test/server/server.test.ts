import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core';
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
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' }
                }
            } as JSONRPCMessage);

            await responsePromise;

            expect(setProtocolVersion).toHaveBeenCalledWith('2025-11-25');

            await server.close();
        });

        it('only negotiates stateful-model versions via initialize', async () => {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await server.connect(serverTransport);
            const responsePromise = new Promise<JSONRPCMessage>(resolve => {
                clientTransport.onmessage = msg => resolve(msg);
            });
            await clientTransport.start();
            await clientTransport.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: 'c', version: '1' }
                }
            } as JSONRPCMessage);
            const resp = (await responsePromise) as unknown as { result: { protocolVersion: string } };
            // LATEST_PROTOCOL_VERSION is stateless-model; initialize should
            // negotiate the newest stateful version instead.
            expect(resp.result.protocolVersion).toBe('2025-11-25');
            await server.close();
        });
    });

    describe('server/discover', () => {
        it('[R-2575-5] returns supportedVersions, capabilities, serverInfo', async () => {
            const server = new Server(
                { name: 'test', version: '1.0.0' },
                { capabilities: { tools: { listChanged: true } }, instructions: 'hello' }
            );
            const res = await server.handleStatelessRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: { _meta: { 'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION } }
            });
            expect(res).toMatchObject({
                result: {
                    supportedVersions: expect.arrayContaining([LATEST_PROTOCOL_VERSION, '2025-11-25']),
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: 'test', version: '1.0.0' },
                    instructions: 'hello'
                }
            });
        });

        it('[R-2575-5] is registered on every Server (no opt-in needed)', async () => {
            const server = new Server({ name: 'min', version: '0.0.0' });
            const res = await server.handleStatelessRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: { _meta: { 'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION } }
            });
            expect('result' in res ? res.result : undefined).toMatchObject({
                supportedVersions: expect.any(Array),
                serverInfo: { name: 'min', version: '0.0.0' }
            });
        });
    });

    describe('client capability gates via isStateless()', () => {
        it('[R-2575-20] stateless: handler reaching elicitInput without _meta.clientCapabilities → -32003', async () => {
            const server = new Server({ name: 't', version: '1' }, { capabilities: { tools: {} } });
            server.setRequestHandler('tools/call', async (_req, ctx) => {
                await ctx.mcpReq.elicitInput({ mode: 'form', message: 'x', requestedSchema: { type: 'object', properties: {} } });
                return { content: [] };
            });
            const res = await server.handleStatelessRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'x',
                    _meta: {
                        'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION,
                        'io.modelcontextprotocol/clientCapabilities': {}
                    }
                }
            });
            expect(res).toMatchObject({
                error: {
                    code: ProtocolErrorCode.MissingRequiredClientCapability,
                    data: { requiredCapabilities: ['elicitation.form'] }
                }
            });
        });

        it('stateless: _meta.clientCapabilities with elicitation.form passes the gate (then fails on send, no transport)', async () => {
            const server = new Server({ name: 't', version: '1' }, { capabilities: { tools: {} } });
            let gateError: unknown;
            server.setRequestHandler('tools/call', async (_req, ctx) => {
                try {
                    await ctx.mcpReq.elicitInput({ mode: 'form', message: 'x', requestedSchema: { type: 'object', properties: {} } });
                } catch (e) {
                    gateError = e;
                }
                return { content: [] };
            });
            await server.handleStatelessRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'x',
                    _meta: {
                        'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION,
                        'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: true } }
                    }
                }
            });
            // Gate passed (not -32003); failure is the no-transport SdkError
            expect(gateError).not.toBeInstanceOf(ProtocolError);
            expect(gateError).toBeDefined();
        });

        it('legacy: gate reads from initialize-negotiated capabilities, not _meta', async () => {
            const server = new Server({ name: 't', version: '1' }, { capabilities: {} });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await server.connect(serverTransport);
            await clientTransport.start();

            clientTransport.onmessage = () => {};
            await clientTransport.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: { sampling: {} },
                    clientInfo: { name: 'c', version: '1' }
                }
            } as JSONRPCMessage);
            await new Promise(r => setTimeout(r, 0));
            expect(server.getClientCapabilities()).toEqual({ sampling: {} });

            // Gate via assertCapabilityForMethod path: createMessage with no ctx
            // should pass sampling gate (legacy reads this._clientCapabilities)
            // but fail on actual request since client won't respond. We assert
            // the gate doesn't throw -32003.
            const p = server.createMessage({ messages: [], maxTokens: 1 }).catch(e => e);
            await new Promise(r => setTimeout(r, 0));
            const err = await Promise.race([p, new Promise(r => setTimeout(() => r('timeout'), 50))]);
            // Either 'timeout' (waiting for response) or some error, but NOT -32003
            if (err instanceof ProtocolError) {
                expect(err.code).not.toBe(ProtocolErrorCode.MissingRequiredClientCapability);
            }
            await server.close();
        });
    });

    describe('log gating via isStateless()', () => {
        async function logViaHandler(meta: Record<string, unknown>) {
            const server = new Server({ name: 't', version: '1' }, { capabilities: { tools: {}, logging: {} } });
            server.setRequestHandler('tools/call', async (_req, ctx) => {
                await ctx.mcpReq.log('info', 'hello');
                return { content: [] };
            });
            const seen: string[] = [];
            await server.handleStatelessRequest(
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'x', _meta: { 'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION, ...meta } }
                },
                { onNotification: n => void seen.push(n.method) }
            );
            return seen;
        }

        it('[R-2575-6] suppresses notifications/message when no _meta.logLevel', async () => {
            const seen = await logViaHandler({});
            expect(seen).not.toContain('notifications/message');
        });

        it('emits when _meta.logLevel allows it', async () => {
            const seen = await logViaHandler({ 'io.modelcontextprotocol/logLevel': 'info' });
            expect(seen).toContain('notifications/message');
        });

        it('filters below requested level', async () => {
            const seen = await logViaHandler({ 'io.modelcontextprotocol/logLevel': 'error' });
            expect(seen).not.toContain('notifications/message');
        });
    });
});
