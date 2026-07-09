/**
 * Connection lifecycle acceptance suite.
 *
 * Pins the behaviors any refactor of Protocol's connection-scoped state must
 * preserve (g1-g4, r1, r2), and documents today's remaining teardown gap as
 * an expected-failing test (r3 — flipped to a plain test by the fix). r2:
 * the failed-start unwind restores the transport's own callbacks, so a late
 * event from a failed transport cannot torpedo a later connection.
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
    /** When true, close() resolves without firing onclose (see r1). */
    closeWithoutOnclose = false;

    constructor(id: string) {
        this.id = id;
    }

    async start(): Promise<void> {}

    async close(): Promise<void> {
        if (!this.closeWithoutOnclose) {
            this.onclose?.();
        }
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this.sentMessages.push(message);
    }
}

function createProtocol(options?: ConstructorParameters<typeof Protocol>[0]): Protocol<BaseContext> {
    return new (class extends Protocol<BaseContext> {
        protected assertCapabilityForMethod(): void {}
        protected assertNotificationCapability(): void {}
        protected assertRequestHandlerCapability(): void {}
        protected buildContext(ctx: BaseContext): BaseContext {
            return ctx;
        }
    })(options);
}

const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));

/** Holds a request handler open and captures its context. */
function installBlockingHandler(protocol: Protocol<BaseContext>): {
    entered: Promise<void>;
    release: () => void;
    ctx: () => BaseContext;
} {
    let ctxRef: BaseContext | undefined;
    let enteredResolve!: () => void;
    const entered = new Promise<void>(resolve => {
        enteredResolve = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    protocol.setRequestHandler('ping', async (_request, ctx) => {
        ctxRef = ctx;
        enteredResolve();
        await gate;
        return {};
    });
    return { entered, release, ctx: () => ctxRef! };
}

describe('g1: aborted-handler send gates fire before era resolution', () => {
    test('an aborted ctx.mcpReq.send with a spec method rejects ConnectionClosed — never a synchronous era throw', async () => {
        const protocol = createProtocol();
        const transportA = new MockTransport('A');
        const { entered, ctx } = installBlockingHandler(protocol);

        await protocol.connect(transportA);
        transportA.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });
        await entered;

        await protocol.close();
        expect(ctx().mcpReq.signal.aborted).toBe(true);

        // 'subscriptions/listen' is a spec method the (default) legacy era
        // does not define: were era resolution consulted before the abort
        // gate, this call would THROW MethodNotSupportedByProtocolVersion
        // synchronously. The gate must win: an async ConnectionClosed
        // rejection, evaluated against nothing.
        let syncThrow: unknown;
        let pending: Promise<unknown> | undefined;
        try {
            pending = ctx().mcpReq.send({ method: 'subscriptions/listen' });
        } catch (error) {
            syncThrow = error;
        }
        expect(syncThrow).toBeUndefined();
        await expect(pending).rejects.toSatisfy(
            (error: unknown) => error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed
        );

        // Same ordering on the in-era spec-method path (no result schema):
        // the gate short-circuits before the codec's result-validator lookup.
        await expect(ctx().mcpReq.send({ method: 'ping' })).rejects.toSatisfy(
            (error: unknown) => error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed
        );

        // Explicit-schema path rejects identically, and notify() resolves as
        // a no-op.
        await expect(ctx().mcpReq.send({ method: 'custom/probe' }, z.object({}))).rejects.toSatisfy(
            (error: unknown) => error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed
        );
        await expect(
            ctx().mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 1, progress: 1 } })
        ).resolves.toBeUndefined();
    });
});

describe('g2: send-failure cleanup', () => {
    test('a transport.send rejection cleans up the progress handler and the request timeout', async () => {
        const protocol = createProtocol();
        const transport = new MockTransport('A');
        transport.send = async () => {
            throw new Error('wire is down');
        };
        await protocol.connect(transport);

        const errors: Error[] = [];
        protocol.onerror = error => errors.push(error);

        let progressCalls = 0;
        await expect(
            protocol.request({ method: 'custom/slow' }, z.object({}), {
                timeout: 20,
                onprogress: () => {
                    progressCalls++;
                }
            })
        ).rejects.toThrow('wire is down');

        // The progress handler was removed: a progress notification for the
        // dead request's token surfaces as an unknown-token onerror instead
        // of invoking the stale callback.
        transport.onmessage?.({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: 0, progress: 1 }
        });
        await flushMicrotasks();
        expect(progressCalls).toBe(0);
        expect(errors.some(e => e.message.includes('unknown token'))).toBe(true);

        // The timeout was cleaned up: past the deadline nothing fires (no
        // cancellation attempt, no late onerror beyond the one above).
        const errorCountAfterProgress = errors.length;
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(errors.length).toBe(errorCountAfterProgress);
    });
});

describe('g3: replies route to the transport that delivered the request', () => {
    test('a handler whose connection was replaced mid-flight answers on the captured transport, never the new one', async () => {
        const protocol = createProtocol();
        const transportA = new MockTransport('A');
        const transportB = new MockTransport('B');

        // Two in-flight requests sharing one JSON-RPC id: the second SET on
        // `_requestHandlerAbortControllers` replaces the first entry, so
        // close() aborts only the second handler. The first handler survives
        // un-aborted across close()+connect(B) — its response must still go
        // to the transport that delivered it (captured at dispatch), not to
        // the live transport read at completion time.
        let firstEnteredResolve!: () => void;
        const firstEntered = new Promise<void>(resolve => {
            firstEnteredResolve = resolve;
        });
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        let handlerCalls = 0;
        protocol.setRequestHandler('ping', async () => {
            handlerCalls++;
            if (handlerCalls === 1) {
                firstEnteredResolve();
                await firstGate;
                return {};
            }
            await new Promise<never>(() => {}); // second stays parked
            return {};
        });

        await protocol.connect(transportA);
        transportA.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 7 });
        await firstEntered;
        transportA.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 7 });
        await flushMicrotasks();

        await protocol.close();
        await protocol.connect(transportB);

        releaseFirst();
        await flushMicrotasks();

        // The surviving handler's response went to A (which delivered the
        // request) — transport B never sees a message it has no request for.
        expect(transportB.sentMessages).toHaveLength(0);
        expect(transportA.sentMessages).toHaveLength(1);
        expect(transportA.sentMessages[0]).toMatchObject({ jsonrpc: '2.0', id: 7, result: {} });
    });
});

describe('g4: teardown ordering', () => {
    test('user onclose fires before in-flight handler aborts; pending responses settle ConnectionClosed', async () => {
        const protocol = createProtocol();
        const transport = new MockTransport('A');
        const { entered, ctx } = installBlockingHandler(protocol);

        await protocol.connect(transport);

        const events: string[] = [];
        protocol.onclose = () => events.push('onclose');

        // A pending outbound request that teardown must settle.
        const pending = protocol.request({ method: 'custom/pending' }, z.object({}), { timeout: 60_000 }).catch((error: unknown) => error);
        await flushMicrotasks();

        transport.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });
        await entered;
        ctx().mcpReq.signal.addEventListener('abort', () => events.push('abort'));

        await protocol.close();
        const settled = await pending;

        // The pending response settled with the typed ConnectionClosed...
        expect(settled).toSatisfy((error: unknown) => error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed);
        // ...the in-flight handler's abort reason carries the same typed
        // error (the response-handlers-then-abort-controllers ordering inside
        // teardown shares one error instance; both run after user onclose)...
        expect(ctx().mcpReq.signal.reason).toSatisfy(
            (error: unknown) => error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed
        );
        // ...and the user onclose callback ran strictly before the abort
        // signal fired (both are synchronous within teardown).
        expect(events).toEqual(['onclose', 'abort']);
    });
});

describe('r1: close() on a transport that never fires onclose (pin)', () => {
    // close() runs the teardown itself when the transport's onclose callback
    // has not (it used to rely on the onclose round-trip alone, wedging the
    // instance on the AlreadyConnected guard). Pinned here so the teardown
    // consolidation must preserve it.
    test('after await close(), the instance accepts a new connect() even when the transport never fired onclose', async () => {
        const protocol = createProtocol();
        const transportA = new MockTransport('A');
        transportA.closeWithoutOnclose = true;
        const transportB = new MockTransport('B');

        await protocol.connect(transportA);
        await protocol.close();

        await protocol.connect(transportB);
        expect(protocol.transport).toBe(transportB);
    });
});

describe('r2: late events from a failed transport cannot torpedo a later connection (pin)', () => {
    test('transport A start() rejects; a late A.onclose leaves connection B fully live', async () => {
        const protocol = createProtocol();
        const failing = new MockTransport('failing');
        failing.start = async () => {
            throw new Error('spawn failed');
        };
        await expect(protocol.connect(failing)).rejects.toThrow('spawn failed');

        const transportB = new MockTransport('B');
        await protocol.connect(transportB);
        let sawClose = false;
        protocol.onclose = () => {
            sawClose = true;
        };

        const pending = protocol.request({ method: 'custom/probe' }, z.object({ ok: z.boolean() }));
        await flushMicrotasks();
        expect(transportB.sentMessages).toHaveLength(1);
        const requestId = (transportB.sentMessages[0] as { id: number }).id;

        // The late event from the failed transport (e.g. a child process
        // 'close' arriving after a failed spawn already rejected start()).
        failing.onclose?.();

        // B's connection is unaffected: no teardown ran, and the in-flight
        // request on B still completes normally.
        expect(sawClose).toBe(false);
        expect(protocol.transport).toBe(transportB);
        transportB.onmessage?.({ jsonrpc: '2.0', id: requestId, result: { ok: true } });
        await expect(pending).resolves.toEqual({ ok: true });
    });
});

describe('r3: debounced notifications are connection-scoped', () => {
    // DEFECT (today): the debounce microtask checks transport PRESENCE
    // (`if (!this._transport) return`), not identity. A debounced
    // notification scheduled on connection A, with close()+connect(B) both
    // landing inside the microtask window, is delivered on B — a connection
    // it was never sent on.
    test.fails(
        'a notification debounced on connection A must not be sent on a connection B established inside the microtask window',
        async () => {
            const protocol = createProtocol({ debouncedNotificationMethods: ['test/debounced'] });
            const transportA = new MockTransport('A');
            const transportB = new MockTransport('B');

            await protocol.connect(transportA);

            // Schedules the send as a microtask on connection A...
            void protocol.notification({ method: 'test/debounced' });
            // ...and replaces the connection before that microtask runs.
            // MockTransport.close() fires onclose synchronously, so close() has
            // already torn A down when connect(B) installs the new transport;
            // both happen before the debounce microtask fires.
            const closing = protocol.close();
            const connecting = protocol.connect(transportB);
            await Promise.all([closing, connecting]);
            await flushMicrotasks();

            expect(transportA.sentMessages).toHaveLength(0);
            expect(transportB.sentMessages).toHaveLength(0);
        }
    );
});
