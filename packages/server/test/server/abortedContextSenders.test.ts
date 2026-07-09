/**
 * After an in-flight request handler is aborted, the ServerContext
 * per-request senders (`ctx.mcpReq.elicitInput`, `ctx.mcpReq.requestSampling`)
 * reject with `ConnectionClosed` instead of reaching a transport — the same
 * gate `ctx.mcpReq.notify` / `ctx.mcpReq.send` apply. The transport reference
 * is read live at send time, so without the gate an aborted handler could
 * write to a transport connected after the close.
 *
 * The abort has two triggers, each pinned below: close() tearing the
 * connection down, and the peer cancelling one request via
 * `notifications/cancelled` while the connection stays open.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Server } from '../../src/server/server';

/** Connects, runs the initialize handshake, and issues the held-open `tools/call` (id 1, name 'hold'). */
async function connectAndHoldToolCall(server: Server, serverTx: InMemoryTransport, peerTx: InMemoryTransport): Promise<void> {
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
}

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

        await connectAndHoldToolCall(server, serverTx, peerTx);
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

    it('gates all ctx senders after notifications/cancelled while the connection stays open, and still serves fresh requests', async () => {
        const server = new Server({ name: 'abort-gate-test', version: '1.0.0' }, { capabilities: { tools: {}, logging: {} } });
        const [peerTx, serverTx] = InMemoryTransport.createLinkedPair();

        const peerMessages: JSONRPCMessage[] = [];
        peerTx.onmessage = message => {
            peerMessages.push(message as JSONRPCMessage);
        };

        let notifyCall!: () => Promise<void>;
        let sendCall!: () => Promise<unknown>;
        let elicitCall!: () => Promise<unknown>;
        let samplingCall!: () => Promise<unknown>;
        let aborted!: Promise<void>;
        let handlerEntered!: () => void;
        const entered = new Promise<void>(resolve => {
            handlerEntered = resolve;
        });
        server.setRequestHandler('tools/call', async (request, ctx) => {
            if (request.params?.name !== 'hold') {
                return { content: [] };
            }
            notifyCall = () => ctx.mcpReq.notify({ method: 'notifications/message', params: { level: 'info', data: 'late' } });
            sendCall = () => ctx.mcpReq.send({ method: 'ping' });
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
            aborted = new Promise<void>(resolve => {
                ctx.mcpReq.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            handlerEntered();
            // Held open across the cancellation; never resolves.
            await new Promise<never>(() => {});
            return { content: [] };
        });

        await connectAndHoldToolCall(server, serverTx, peerTx);
        await entered;

        // The peer cancels just that request; the connection stays open.
        await peerTx.send({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: 1, reason: 'peer changed its mind' }
        });
        await aborted;

        const wireCountAfterCancel = peerMessages.length;

        // Notifications no-op without reaching the wire.
        await expect(notifyCall()).resolves.toBeUndefined();

        // Requests reject with the gate's exact error, without reaching the wire.
        for (const call of [sendCall, elicitCall, samplingCall]) {
            const rejection = await call().then(
                () => undefined,
                (error: unknown) => error
            );
            expect(rejection).toBeInstanceOf(SdkError);
            expect((rejection as SdkError).code).toBe(SdkErrorCode.ConnectionClosed);
            expect((rejection as SdkError).message).toBe('Request was cancelled');
        }
        expect(peerMessages).toHaveLength(wireCountAfterCancel);

        // The live connection still serves a fresh request end to end.
        // (peerMessages has no assertions past this point, so the collector
        // can be replaced outright.)
        const freshResponse = new Promise<JSONRPCMessage>(resolve => {
            peerTx.onmessage = message => {
                const received = message as JSONRPCMessage;
                if ('id' in received && received.id === 2) {
                    resolve(received);
                }
            };
        });
        await peerTx.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quick', arguments: {} } });
        expect(await freshResponse).toMatchObject({ id: 2, result: { content: [] } });

        await server.close();
    });
});
