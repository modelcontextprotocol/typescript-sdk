/**
 * Protocol.connect() single-transport invariant + post-close handler
 * teardown (restores v1 behavior, in effect since sdk@1.26.0).
 *
 * connect() on an already-connected Protocol instance throws instead of
 * silently overwriting `this._transport` (the silent overwrite routed
 * in-flight handler output to whichever transport connected last). After
 * close() the instance can connect again — sequential reuse stays supported.
 *
 * The companion guards cover the window AFTER close() aborts an in-flight
 * handler: its `ctx.mcpReq.notify` / `ctx.mcpReq.send` must not write to a
 * replacement transport connected afterwards (notify no-ops; send rejects
 * with ConnectionClosed). The abort itself is covered by
 * 'should abort in-flight request handlers when the connection is closed'
 * in protocol.test.ts.
 */
import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors';
import type { BaseContext } from '../../src/shared/protocol';
import { Protocol } from '../../src/shared/protocol';
import type { Transport } from '../../src/shared/transport';
import type { JSONRPCMessage } from '../../src/types/index';

class MockTransport implements Transport {
    id: string;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;
    sentMessages: JSONRPCMessage[] = [];

    constructor(id: string) {
        this.id = id;
    }

    async start(): Promise<void> {}

    async close(): Promise<void> {
        this.onclose?.();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this.sentMessages.push(message);
    }
}

function createProtocol(): Protocol<BaseContext> {
    return new (class extends Protocol<BaseContext> {
        protected assertCapabilityForMethod(): void {}
        protected assertNotificationCapability(): void {}
        protected assertRequestHandlerCapability(): void {}
        protected buildContext(ctx: BaseContext): BaseContext {
            return ctx;
        }
    })();
}

describe('Protocol.connect() reuse guard', () => {
    test('a transport that failed to start cannot disturb a later connection', async () => {
        const protocol = createProtocol();
        const failing = new MockTransport('failing');
        const userOnClose = (): void => {};
        failing.onclose = userOnClose;
        failing.start = async (): Promise<void> => {
            throw new Error('boot failure');
        };

        await expect(protocol.connect(failing)).rejects.toThrow('boot failure');
        expect(protocol.transport).toBeUndefined();
        // The unwind restored the transport's own callbacks.
        expect(failing.onclose).toBe(userOnClose);

        // A later connection is undisturbed by events from the failed
        // transport (e.g. a child process 'close' arriving after a failed
        // spawn already rejected start()).
        const transportB = new MockTransport('B');
        await protocol.connect(transportB);
        let sawClose = false;
        protocol.onclose = () => {
            sawClose = true;
        };

        failing.onclose?.();

        expect(protocol.transport).toBe(transportB);
        expect(sawClose).toBe(false);
    });

    test('connect() while already connected throws', async () => {
        const protocol = createProtocol();
        const transportA = new MockTransport('A');
        const transportB = new MockTransport('B');

        await protocol.connect(transportA);

        const rejection = await protocol.connect(transportB).then(
            () => undefined,
            (error: unknown) => error
        );
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.AlreadyConnected);
        expect((rejection as SdkError).message).toBe(
            'Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.'
        );

        // The original connection is untouched by the rejected connect.
        expect(protocol.transport).toBe(transportA);
    });

    test('close() then connect() succeeds (sequential reuse)', async () => {
        const protocol = createProtocol();
        const transportA = new MockTransport('A');
        const transportB = new MockTransport('B');

        protocol.setRequestHandler('ping', async () => ({}));

        await protocol.connect(transportA);
        await protocol.close();
        expect(protocol.transport).toBeUndefined();

        await protocol.connect(transportB);
        expect(protocol.transport).toBe(transportB);

        // The new connection serves requests normally.
        transportB.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(transportB.sentMessages).toHaveLength(1);
        expect(transportB.sentMessages[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });
    });

    test('transport-initiated close also frees the instance for a new connect()', async () => {
        const protocol = createProtocol();
        const transportA = new MockTransport('A');
        const transportB = new MockTransport('B');

        await protocol.connect(transportA);
        await transportA.close();

        await protocol.connect(transportB);
        expect(protocol.transport).toBe(transportB);
    });

    test('a failed transport start() leaves the instance reconnectable', async () => {
        // A transport whose start() rejects was never connected — connect()
        // unwinds, so a retry does not hit the reuse guard.
        const protocol = createProtocol();
        const failing: Transport = {
            async start() {
                throw new Error('spawn failed');
            },
            async close() {},
            async send() {}
        };

        await expect(protocol.connect(failing)).rejects.toThrow('spawn failed');
        expect(protocol.transport).toBeUndefined();

        const transportB = new MockTransport('B');
        await protocol.connect(transportB);
        expect(protocol.transport).toBe(transportB);
    });
});

describe('aborted-handler sends after close()', () => {
    test('an aborted handler cannot write to a replacement transport: notify no-ops, send rejects with ConnectionClosed', async () => {
        const protocol = createProtocol();
        const transportA = new MockTransport('A');
        const transportB = new MockTransport('B');

        let ctxRef: BaseContext | undefined;
        let handlerEnteredResolve!: () => void;
        const handlerEntered = new Promise<void>(resolve => {
            handlerEnteredResolve = resolve;
        });
        let releaseHandler!: () => void;
        const handlerGate = new Promise<void>(resolve => {
            releaseHandler = resolve;
        });

        protocol.setRequestHandler('ping', async (_request, ctx) => {
            ctxRef = ctx;
            handlerEnteredResolve();
            await handlerGate;
            return {};
        });

        await protocol.connect(transportA);
        transportA.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });
        await handlerEntered;

        // close() aborts the in-flight handler and clears the transport...
        await protocol.close();
        expect(ctxRef!.mcpReq.signal.aborted).toBe(true);

        // ...then the instance is reconnected to a REPLACEMENT transport.
        await protocol.connect(transportB);

        // The aborted handler's related notification is a no-op (v1 shape):
        // nothing reaches the newly connected transport.
        await expect(
            ctxRef!.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken: 1, progress: 1 }
            })
        ).resolves.toBeUndefined();
        expect(transportB.sentMessages).toHaveLength(0);

        // The aborted handler's related request rejects with ConnectionClosed
        // (v1 shape) instead of going out on the newly connected transport.
        await expect(ctxRef!.mcpReq.send({ method: 'custom/probe' }, z.object({}))).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed
        );
        expect(transportB.sentMessages).toHaveLength(0);

        // Releasing the handler must not deliver its (stale) result anywhere:
        // the result path is keyed to the captured transport and the aborted
        // signal drops it.
        releaseHandler();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(transportA.sentMessages).toHaveLength(0);
        expect(transportB.sentMessages).toHaveLength(0);
    });
});
