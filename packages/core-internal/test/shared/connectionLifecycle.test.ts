/**
 * Connection lifecycle acceptance suite.
 *
 * Pins the behaviors any refactor of Protocol's connection-scoped state must
 * preserve (g1-g5, r1, r2; r3 documented a teardown gap as an expected-failing
 * test until the consolidation flipped it). r2: the failed-start unwind
 * restores the transport's own callbacks, so a late event from a failed
 * transport cannot torpedo a later connection. u1 unit-tests the structural
 * mechanisms directly (disposed-connection send rejection, idempotent
 * dispose, the request funnel's early disposed reject).
 */
import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors';
import type { BaseContext } from '../../src/shared/protocol';
import { Protocol, setNegotiatedProtocolVersion } from '../../src/shared/protocol';
import type { Transport } from '../../src/shared/transport';
import type { JSONRPCMessage } from '../../src/types/index';
import { codecForVersion } from '../../src/wire/codec';

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

/**
 * Holds a request handler open and captures its context. `body` runs after
 * release and produces the handler's outcome (default: resolve with `{}`;
 * throw inside it to make the handler reject).
 */
function installBlockingHandler(
    protocol: Protocol<BaseContext>,
    body: () => Record<string, unknown> = () => ({})
): {
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
        return body();
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

describe('g5: request cancellation on a live connection (pin)', () => {
    // `notifications/cancelled` aborts the handler while the connection stays
    // OPEN: `disposed` is false, but the cancelled request's per-request
    // senders must behave exactly as they do after teardown — notify no-ops,
    // send rejects ConnectionClosed, and nothing reaches the wire — while the
    // connection itself keeps serving fresh requests.
    test('after notifications/cancelled, the ctx senders are inert and the same connection serves a fresh request', async () => {
        const protocol = createProtocol();
        const transport = new MockTransport('A');
        const { entered, release, ctx } = installBlockingHandler(protocol);

        await protocol.connect(transport);
        transport.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });
        await entered;

        transport.onmessage?.({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: 1, reason: 'client cancelled' }
        });
        await flushMicrotasks();

        // The request is cancelled but the connection is fully live.
        expect(ctx().mcpReq.signal.aborted).toBe(true);
        expect(protocol.transport).toBe(transport);

        // notify resolves as a no-op; send rejects ConnectionClosed on both
        // the spec-method and the explicit-schema path.
        await expect(
            ctx().mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 1, progress: 1 } })
        ).resolves.toBeUndefined();
        await expect(ctx().mcpReq.send({ method: 'ping' })).rejects.toSatisfy(
            (error: unknown) => error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed
        );
        await expect(ctx().mcpReq.send({ method: 'custom/probe' }, z.object({}))).rejects.toSatisfy(
            (error: unknown) => error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed
        );

        // NOTHING reached the wire: no notification, no request, and — once
        // the cancelled handler completes — no response for the cancelled
        // request either.
        release();
        await flushMicrotasks();
        expect(transport.sentMessages).toHaveLength(0);

        // The SAME live connection serves a fresh request normally.
        transport.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 2 });
        await flushMicrotasks();
        expect(transport.sentMessages).toHaveLength(1);
        expect(transport.sentMessages[0]).toMatchObject({ jsonrpc: '2.0', id: 2, result: {} });
    });

    test('a notifications/cancelled without a requestId is ignored', async () => {
        const protocol = createProtocol();
        const transport = new MockTransport('A');
        const { entered, release, ctx } = installBlockingHandler(protocol);

        await protocol.connect(transport);
        transport.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });
        await entered;

        transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { reason: 'no id' } });
        await flushMicrotasks();
        expect(ctx().mcpReq.signal.aborted).toBe(false);

        release();
        await flushMicrotasks();
        expect(transport.sentMessages).toHaveLength(1);
        expect(transport.sentMessages[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });
    });

    test('a cancelled handler that rejects produces no error response on the wire', async () => {
        const protocol = createProtocol();
        const transport = new MockTransport('A');
        const { entered, release } = installBlockingHandler(protocol, () => {
            throw new Error('handler failed after cancellation');
        });

        await protocol.connect(transport);
        transport.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });
        await entered;
        transport.onmessage?.({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: 1, reason: 'client cancelled' }
        });
        await flushMicrotasks();

        release();
        await flushMicrotasks();
        expect(transport.sentMessages).toHaveLength(0);
    });
});

describe('ctx sender contract on a live request', () => {
    test('ctx.mcpReq.send without a schema on a non-spec method throws TypeError (the gate lets live requests through)', async () => {
        const protocol = createProtocol();
        const transport = new MockTransport('A');
        const { entered, release, ctx } = installBlockingHandler(protocol);

        await protocol.connect(transport);
        transport.onmessage?.({ jsonrpc: '2.0', method: 'ping', id: 1 });
        await entered;

        // The overloads make this call unrepresentable at the type level (a
        // non-spec method requires an explicit schema); the cast reaches the
        // runtime guard behind them.
        const sendUnchecked = ctx().mcpReq.send as (r: { method: string }) => Promise<unknown>;
        expect(() => sendUnchecked({ method: 'custom/no-schema' })).toThrow(TypeError);

        release();
        await flushMicrotasks();
    });
});

describe('close() without a connection', () => {
    test('close() before any connect() resolves as a no-op', async () => {
        const protocol = createProtocol();
        await expect(protocol.close()).resolves.toBeUndefined();
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
    // close() disposes the connection directly after transport.close()
    // settles, so a transport that resolves close() without firing onclose
    // cannot wedge the instance (it used to: `_transport` stayed set forever
    // and every subsequent connect() threw AlreadyConnected).
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
    // The debounce microtask captures the connection it was scheduled on and
    // aborts when that connection is disposed (it used to check transport
    // PRESENCE, not identity, so a close()+connect(B) inside the microtask
    // window delivered A's notification on B).
    test('a notification debounced on connection A must not be sent on a connection B established inside the microtask window', async () => {
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
    });
});

describe('u1: Connection structural mechanisms (unit)', () => {
    // The private Connection owner is deliberately not exported; these tests
    // reach it through the instance, following the established internal-access
    // pattern (see protocol.test.ts's testRequest helper).
    type ConnectionInternals = {
        disposed: boolean;
        send(message: JSONRPCMessage): Promise<void>;
        dispose(): { responseHandlers: Map<number, unknown>; requestHandlerAbortControllers: Map<unknown, unknown> } | undefined;
    };
    const internalConnection = (protocol: Protocol<BaseContext>): ConnectionInternals =>
        (protocol as unknown as { _connection: ConnectionInternals })._connection;

    test('send on a disposed connection rejects ConnectionClosed and never reaches the transport', async () => {
        const protocol = createProtocol();
        const transport = new MockTransport('A');
        await protocol.connect(transport);
        const connection = internalConnection(protocol);

        await protocol.close();
        expect(connection.disposed).toBe(true);

        await expect(
            connection.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } })
        ).rejects.toSatisfy((error: unknown) => error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed);
        expect(transport.sentMessages).toHaveLength(0);
    });

    test('dispose() is idempotent: the first call returns the settlement material, the second returns undefined', async () => {
        const protocol = createProtocol();
        const transport = new MockTransport('A');
        await protocol.connect(transport);
        const connection = internalConnection(protocol);

        const first = connection.dispose();
        expect(first).toBeDefined();
        expect(first!.responseHandlers).toBeInstanceOf(Map);
        expect(first!.requestHandlerAbortControllers).toBeInstanceOf(Map);

        expect(connection.dispose()).toBeUndefined();
        expect(connection.disposed).toBe(true);
    });

    test('the request funnel early-rejects on a disposed connection before any transport interaction', async () => {
        const protocol = createProtocol();
        const transport = new MockTransport('A');
        await protocol.connect(transport);
        const connection = internalConnection(protocol);
        await protocol.close();

        const pending = (
            protocol as unknown as {
                _requestWithSchemaViaCodec(
                    codec: unknown,
                    request: { method: string },
                    resultSchema: unknown,
                    options: undefined,
                    connection: ConnectionInternals
                ): Promise<unknown>;
            }
        )._requestWithSchemaViaCodec(codecForVersion(undefined), { method: 'custom/probe' }, z.object({}), undefined, connection);

        await expect(pending).rejects.toSatisfy(
            (error: unknown) => error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed
        );
        expect(transport.sentMessages).toHaveLength(0);
    });
});

describe('negotiated-version seed lifecycle', () => {
    test('a post-close read does not resurrect a stale seed over a connection-negotiated value', async () => {
        const protocol = createProtocol();
        const readNegotiated = () => (protocol as unknown as { _negotiatedProtocolVersion: string | undefined })._negotiatedProtocolVersion;

        // An era bound before connect() lands on the pending seed...
        setNegotiatedProtocolVersion(protocol, '2025-03-26');
        expect(readNegotiated()).toBe('2025-03-26');

        // ...and seeds the new connection, which then completes its OWN
        // negotiation at a different version.
        const transport = new MockTransport('A');
        await protocol.connect(transport);
        expect(readNegotiated()).toBe('2025-03-26');
        setNegotiatedProtocolVersion(protocol, '2025-06-18');
        expect(readNegotiated()).toBe('2025-06-18');

        // After close there is no connection: the read must NOT fall back to
        // the pre-connect seed the connection's own negotiation superseded.
        await protocol.close();
        expect(readNegotiated()).toBeUndefined();
    });
});
