import type { JSONRPCMessage, JSONRPCRequest, ServerContext } from '@modelcontextprotocol/core';
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

    describe('ctx-scoped request association', () => {
        const ELICIT_PARAMS = {
            message: 'Need input',
            requestedSchema: { type: 'object' as const, properties: { ok: { type: 'boolean' as const } } }
        };

        const SAMPLING_PARAMS = {
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'hi' } }],
            maxTokens: 5
        };

        /**
         * Connects a Server (with a tools/call handler) to an in-memory transport pair, runs the
         * initialize handshake declaring elicitation + sampling client capabilities, and records
         * every transport-level send so tests can assert on the options passed to transport.send().
         *
         * The fake client auto-responds to elicitation/create and sampling/createMessage requests
         * so handlers can run to completion.
         */
        async function setup(onToolCall: (ctx: ServerContext) => Promise<void>) {
            const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: { tools: {} } });

            server.setRequestHandler('tools/call', async (_request, ctx) => {
                await onToolCall(ctx);
                return { content: [{ type: 'text' as const, text: 'done' }] };
            });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            // Records every [message, options] pair the server passes to transport.send()
            const sendSpy = vi.spyOn(serverTransport, 'send');

            const clientMessages: JSONRPCMessage[] = [];
            clientTransport.onmessage = message => {
                clientMessages.push(message);
                if ('method' in message && 'id' in message) {
                    const request = message as JSONRPCRequest;
                    if (request.method === 'elicitation/create') {
                        void clientTransport.send({ jsonrpc: '2.0', id: request.id, result: { action: 'decline' } });
                    } else if (request.method === 'sampling/createMessage') {
                        void clientTransport.send({
                            jsonrpc: '2.0',
                            id: request.id,
                            result: { role: 'assistant', content: { type: 'text', text: 'ok' }, model: 'test-model' }
                        });
                    }
                }
            };

            await server.connect(serverTransport);
            await clientTransport.start();

            // Initialize handshake declaring elicitation + sampling client capabilities
            await clientTransport.send({
                jsonrpc: '2.0',
                id: 'init-1',
                method: 'initialize',
                params: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: { elicitation: { form: {} }, sampling: {} },
                    clientInfo: { name: 'test-client', version: '1.0.0' }
                }
            } as JSONRPCMessage);
            await vi.waitFor(() => expect(clientMessages.some(m => 'id' in m && m.id === 'init-1')).toBe(true));
            await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);

            /** Sends a tools/call request and waits for its response to come back to the client. */
            async function callTool(id: string): Promise<void> {
                await clientTransport.send({
                    jsonrpc: '2.0',
                    id,
                    method: 'tools/call',
                    params: { name: 'test-tool', arguments: {} }
                } as JSONRPCMessage);
                await vi.waitFor(() =>
                    expect(clientMessages.some(m => 'id' in m && m.id === id && ('result' in m || 'error' in m))).toBe(true)
                );
            }

            /** Returns the transport.send() options for the first sent request with the given method. */
            function sentOptionsFor(method: string) {
                const call = sendSpy.mock.calls.find(([message]) => 'method' in message && message.method === method);
                expect(call).toBeDefined();
                return call![1];
            }

            return { server, clientMessages, callTool, sentOptionsFor };
        }

        it('handler-supplied relatedRequestId cannot override the association', async () => {
            const { server, callTool, sentOptionsFor } = await setup(async ctx => {
                await ctx.mcpReq.elicitInput(ELICIT_PARAMS, { relatedRequestId: 'attempted-override' });
                await ctx.mcpReq.requestSampling(SAMPLING_PARAMS, { relatedRequestId: 'attempted-override' });
            });

            await callTool('tools-call-3');

            expect(sentOptionsFor('elicitation/create')?.relatedRequestId).toBe('tools-call-3');
            expect(sentOptionsFor('sampling/createMessage')?.relatedRequestId).toBe('tools-call-3');

            await server.close();
        });
    });
});
