/**
 * After close() aborts an in-flight request handler, the ServerContext
 * per-request senders (`ctx.mcpReq.elicitInput`, `ctx.mcpReq.requestSampling`)
 * reject with `ConnectionClosed` instead of reaching a transport — the same
 * gate `ctx.mcpReq.notify` / `ctx.mcpReq.send` apply. The transport reference
 * is read live at send time, so without the gate an aborted handler could
 * write to a transport connected after the close.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Server } from '../../src/server/server';

describe('aborted-handler context senders', () => {
    it('elicitInput and requestSampling reject with ConnectionClosed after close(), and never reach a later connection', async () => {
        const server = new Server({ name: 'abort-gate-test', version: '1.0.0' }, { capabilities: { tools: {} } });
        const [peerTx, serverTx] = InMemoryTransport.createLinkedPair();

        let elicitCall!: () => Promise<unknown>;
        let samplingCall!: () => Promise<unknown>;
        let handlerEntered!: () => void;
        const entered = new Promise<void>(resolve => {
            handlerEntered = resolve;
        });
        server.setRequestHandler('tools/call', async (_request, ctx) => {
            elicitCall = () =>
                ctx.mcpReq.elicitInput({
                    message: 'pick one',
                    requestedSchema: { type: 'object', properties: {} }
                });
            samplingCall = () =>
                ctx.mcpReq.requestSampling({
                    messages: [],
                    maxTokens: 1
                });
            handlerEntered();
            // Held open until close() aborts it.
            await new Promise<never>(() => {});
            return { content: [] };
        });

        await server.connect(serverTx);
        await peerTx.start();
        await peerTx.send({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
                protocolVersion: '2025-11-25',
                capabilities: { elicitation: {}, sampling: {} },
                clientInfo: { name: 'peer', version: '0' }
            }
        });
        await peerTx.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await peerTx.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hold', arguments: {} } });
        await entered;

        await server.close();

        // A later connection on the same instance must not receive the
        // aborted handler's sends.
        const [latePeerTx, lateServerTx] = InMemoryTransport.createLinkedPair();
        const latePeerMessages: JSONRPCMessage[] = [];
        latePeerTx.onmessage = message => {
            latePeerMessages.push(message as JSONRPCMessage);
        };
        await server.connect(lateServerTx);

        for (const call of [elicitCall, samplingCall]) {
            const rejection = await call().then(
                () => undefined,
                (error: unknown) => error
            );
            expect(rejection).toBeInstanceOf(SdkError);
            expect((rejection as SdkError).code).toBe(SdkErrorCode.ConnectionClosed);
        }
        expect(latePeerMessages).toHaveLength(0);

        await server.close();
    });
});
