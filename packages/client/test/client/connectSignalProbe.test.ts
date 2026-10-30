/**
 * `connect(transport, { signal })` during the `server/discover` probe: an abort
 * rejects promptly in auto and pin mode, in place and on the stdio sibling, the
 * same way the legacy `initialize` path does. Cases follow the reproduction in
 * https://github.com/modelcontextprotocol/typescript-sdk/issues/3133.
 */
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/core-internal';
import { isJSONRPCRequest, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Client } from '../../src/client/client';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';
import { negotiateEra } from '../../src/client/versionNegotiation';

const MODERN = '2026-07-28';
/** The code an abort maps to, as in `Protocol.request` (see #3046). */
const ABORT_CODE = SdkErrorCode.RequestTimeout;
/** Long enough that only the signal can settle `connect()` within PROMPT_MS. */
const PROBE_TIMEOUT_MS = 30_000;
const PROMPT_MS = 1000;
const ABORT_AFTER_MS = 50;

type Settled = { state: 'connected' } | { state: 'rejected'; error: unknown } | { state: 'pending' };

/** How `connect()` settled within PROMPT_MS. */
async function settleWithin(connect: Promise<void>): Promise<Settled> {
    connect.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<Settled>(resolve => {
        timer = setTimeout(() => resolve({ state: 'pending' }), PROMPT_MS);
    });
    try {
        return await Promise.race([
            connect.then(
                (): Settled => ({ state: 'connected' }),
                (error: unknown): Settled => ({ state: 'rejected', error })
            ),
            pending
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function expectAbortRejection(settled: Settled, message: RegExp): void {
    expect(settled.state).toBe('rejected');
    const error = (settled as { error: unknown }).error;
    expect(error).toBeInstanceOf(SdkError);
    expect((error as SdkError).code).toBe(ABORT_CODE);
    expect((error as SdkError).message).toMatch(message);
}

const discoverResult = {
    supportedVersions: [MODERN],
    capabilities: {},
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'modern-server', version: '1.0.0' } }
};

type Script = (message: JSONRPCMessage, transport: FakeHttpTransport) => void;

/** A server that never answers. */
const silent: Script = () => {};

/** A 2026 server: answers server/discover. */
const modern: Script = (message, t) => {
    if (isJSONRPCRequest(message) && message.method === 'server/discover') {
        t.onmessage?.({ jsonrpc: '2.0', id: message.id, result: discoverResult });
    }
};

/** A 2025 server: -32601 for server/discover (legacy evidence), a plain result for initialize. */
const legacy: Script = (message, t) => {
    if (!isJSONRPCRequest(message)) return;
    if (message.method === 'initialize') {
        t.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'legacy-server', version: '1.0.0' } }
        });
    } else {
        t.onmessage?.({ jsonrpc: '2.0', id: message.id, error: { code: -32_601, message: 'Method not found' } });
    }
};

/** An HTTP-class transport (no `stderr`/`pid`) whose replies come from a script; `close()` always fires `onclose`. */
class FakeHttpTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    sessionId?: string;

    startCalls = 0;
    sent: JSONRPCMessage[] = [];
    sendOptions: (TransportSendOptions | undefined)[] = [];
    /** Runs synchronously inside `start()`. */
    onStart?: () => void;
    /** Runs synchronously inside `send()`, before the scripted reply is queued. */
    onSend?: (message: JSONRPCMessage) => void;

    constructor(private readonly script: Script = silent) {}

    async start(): Promise<void> {
        this.startCalls++;
        this.onStart?.();
    }

    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        this.sent.push(message);
        this.sendOptions.push(options);
        this.onSend?.(message);
        queueMicrotask(() => this.script(message, this));
    }

    async close(): Promise<void> {
        this.onclose?.();
    }

    setProtocolVersion(): void {}
}

/**
 * An SDK-shaped stdio transport (`_serverParams` with a command, an own
 * `_dispose`, `stderr`/`pid`), so `connect()` probes on a disposable sibling.
 * Its "child" answers server/discover when `behavior` is 'modern' and never
 * otherwise; `close()` fires `onclose` only for a started child.
 */
class FakeStdioTransport implements Transport {
    static instances: FakeStdioTransport[] = [];
    /** Test hook: runs when sibling disposal begins (reset after use). */
    static onDisposeStart: (() => void) | undefined;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    readonly _serverParams: Record<string, unknown>;
    startCalls = 0;
    sent: JSONRPCMessage[] = [];
    disposed = false;
    private _alive = false;

    constructor(params: Record<string, unknown>) {
        this._serverParams = params;
        FakeStdioTransport.instances.push(this);
    }

    get stderr(): null {
        return null;
    }
    get pid(): number | null {
        return this._alive ? 4242 : null;
    }

    async start(): Promise<void> {
        this._alive = true;
        this.startCalls++;
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this.sent.push(message);
        queueMicrotask(() => {
            if (!this._alive || !isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover' && this._serverParams.behavior === 'modern') {
                this.onmessage?.({ jsonrpc: '2.0', id: message.id, result: discoverResult });
            }
        });
    }

    async close(): Promise<void> {
        if (this._alive) {
            this._alive = false;
            this.onclose?.();
        }
    }

    private async _dispose(): Promise<void> {
        FakeStdioTransport.onDisposeStart?.();
        this.disposed = true;
        this._alive = false;
    }
}

const autoClient = (maxRetries?: number) =>
    new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: PROBE_TIMEOUT_MS, maxRetries } } });

const abortSoon = (reason: unknown = new Error('aborted by caller')): AbortSignal => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(reason), ABORT_AFTER_MS);
    return abort.signal;
};

const discoverCount = (sent: JSONRPCMessage[]) => sent.filter(m => isJSONRPCRequest(m) && m.method === 'server/discover').length;

describe('connect() signal during the server/discover probe', () => {
    afterEach(() => {
        FakeStdioTransport.instances = [];
        FakeStdioTransport.onDisposeStart = undefined;
    });

    test('control: legacy mode, an abort mid-initialize rejects promptly', async () => {
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'legacy' } });

        const settled = await settleWithin(client.connect(new FakeHttpTransport(), { signal: abortSoon(), timeout: PROBE_TIMEOUT_MS }));

        expectAbortRejection(settled, /aborted by caller/);
    });

    test('auto mode: an abort mid-probe rejects promptly with the legacy-path error', async () => {
        const transport = new FakeHttpTransport();

        const settled = await settleWithin(autoClient().connect(transport, { signal: abortSoon() }));

        expectAbortRejection(settled, /aborted by caller/);
        expect(discoverCount(transport.sent)).toBe(1);
        expect(transport.sent.some(m => isJSONRPCRequest(m) && m.method === 'initialize')).toBe(false);
    });

    test('pin mode: an abort mid-probe rejects promptly', async () => {
        const client = new Client(
            { name: 'c', version: '0' },
            { versionNegotiation: { mode: { pin: MODERN }, probe: { timeoutMs: PROBE_TIMEOUT_MS } } }
        );

        const settled = await settleWithin(client.connect(new FakeHttpTransport(), { signal: abortSoon() }));

        expectAbortRejection(settled, /aborted by caller/);
    });

    test('an SdkError abort reason is rethrown as is', async () => {
        const reason = new SdkError(SdkErrorCode.ConnectionClosed, 'caller shut down');

        const settled = await settleWithin(autoClient().connect(new FakeHttpTransport(), { signal: abortSoon(reason) }));

        expect(settled).toEqual({ state: 'rejected', error: reason });
        expect((settled as { error: unknown }).error).toBe(reason);
    });

    test('a non-SdkError abort reason is wrapped in an SdkError carrying its text', async () => {
        const settled = await settleWithin(autoClient().connect(new FakeHttpTransport(), { signal: abortSoon('plain string reason') }));

        expectAbortRejection(settled, /plain string reason/);
    });

    test('the caller signal is forwarded to transport.send as requestSignal', async () => {
        const transport = new FakeHttpTransport(modern);
        const abort = new AbortController();

        await autoClient().connect(transport, { signal: abort.signal });

        expect(discoverCount(transport.sent)).toBe(1);
        expect(transport.sendOptions[0]?.requestSignal).toBe(abort.signal);
    });

    test('after a normal reply the abort listener is removed, and a later abort touches nothing', async () => {
        const transport = new FakeHttpTransport(modern);
        const abort = new AbortController();
        const signal = abort.signal;
        const added = vi.spyOn(signal, 'addEventListener');
        const removed = vi.spyOn(signal, 'removeEventListener');
        const abortCalls = (spy: typeof added | typeof removed) => spy.mock.calls.filter(([type]) => type === 'abort').length;
        const client = autoClient();
        let closes = 0;
        const errors: Error[] = [];
        client.onclose = () => closes++;
        client.onerror = error => errors.push(error);

        await client.connect(transport, { signal });
        expect(abortCalls(added)).toBeGreaterThan(0);
        expect(abortCalls(removed)).toBe(abortCalls(added));

        abort.abort(new Error('too late'));
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(closes).toBe(0);
        expect(errors).toEqual([]);
        expect(client.getServerVersion()?.name).toBe('modern-server');
    });

    describe('reply and abort in the same tick', () => {
        test.each([
            ['modern', modern],
            ['legacy', legacy]
        ] as const)('a %s verdict that lands with the abort still rejects, and no session handshake starts', async (_name, script) => {
            const abort = new AbortController();
            const transport = new FakeHttpTransport((message, t) => {
                script(message, t);
                abort.abort(new Error('aborted with the reply'));
            });

            const settled = await settleWithin(autoClient().connect(transport, { signal: abort.signal }));

            expectAbortRejection(settled, /aborted with the reply/);
            expect(transport.sent.some(m => isJSONRPCRequest(m) && m.method === 'initialize')).toBe(false);
        });
    });

    test('an abort fired inside send() with maxRetries: 2 sends exactly one server/discover', async () => {
        const transport = new FakeHttpTransport();
        const abort = new AbortController();
        transport.onSend = () => abort.abort(new Error('aborted during send'));

        const settled = await settleWithin(autoClient(2).connect(transport, { signal: abort.signal }));

        expectAbortRejection(settled, /aborted during send/);
        expect(discoverCount(transport.sent)).toBe(1);
    });

    test('an abort fired while the transport starts rejects before any probe is sent', async () => {
        const transport = new FakeHttpTransport(modern);
        const abort = new AbortController();
        transport.onStart = () => abort.abort(new Error('aborted during start'));

        const settled = await settleWithin(autoClient().connect(transport, { signal: abort.signal }));

        expectAbortRejection(settled, /aborted during start/);
        expect(transport.startCalls).toBe(1);
        expect(transport.sent).toEqual([]);
    });

    test('negotiateEra: a modern reply landing with the abort rejects instead of returning a verdict', async () => {
        const abort = new AbortController();
        const transport = new FakeHttpTransport((message, t) => {
            modern(message, t);
            abort.abort(new Error('aborted with the reply'));
        });

        const negotiated = negotiateEra(
            { kind: 'auto', modernVersions: [MODERN], fallbackAvailable: true, probe: { timeoutMs: PROBE_TIMEOUT_MS } },
            {
                transport,
                clientInfo: { name: 'c', version: '0' },
                capabilities: {},
                environment: 'node',
                transportKind: 'http',
                defaultTimeoutMs: PROBE_TIMEOUT_MS,
                signal: abort.signal
            }
        );

        await expect(negotiated).rejects.toThrow(/aborted with the reply/);
        expect(transport.onmessage).toBeUndefined();
    });

    test('an abort landing after the verdict but before the handover leaves the transport reusable', async () => {
        // Three microtasks after the reply lands between the probe loop's own
        // abort check (which has already returned the verdict) and the window's
        // handover of the transport. Fewer hit the loop check, more arrive after
        // connect() has succeeded. The failed connect must leave start()
        // untouched: a second connect on the same transport starts it again.
        const abort = new AbortController();
        const transport = new FakeHttpTransport((message, t) => {
            modern(message, t);
            queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => abort.abort(new Error('aborted before handover')))));
        });
        const client = autoClient();

        const settled = await settleWithin(client.connect(transport, { signal: abort.signal }));

        expectAbortRejection(settled, /aborted before handover/);
        expect(transport.sent.some(m => isJSONRPCRequest(m) && m.method === 'initialize')).toBe(false);
        expect(transport.startCalls).toBe(1);

        await autoClient().connect(transport);
        expect(transport.startCalls).toBe(2);
    });

    test('after an aborted connect, the same client connects on a fresh transport', async () => {
        const client = autoClient();
        const aborted = await settleWithin(client.connect(new FakeHttpTransport(), { signal: abortSoon() }));
        expect(aborted.state).toBe('rejected');

        await client.connect(new FakeHttpTransport(modern));

        expect(client.getServerVersion()?.name).toBe('modern-server');
    });

    describe('already-aborted signal', () => {
        test('HTTP-class transport: rejects without starting or sending; the cleanup close fires onclose once', async () => {
            const transport = new FakeHttpTransport(modern);
            let closes = 0;
            transport.onclose = () => closes++;
            const abort = new AbortController();
            abort.abort(new Error('aborted before connect'));

            const settled = await settleWithin(autoClient().connect(transport, { signal: abort.signal }));

            expectAbortRejection(settled, /aborted before connect/);
            expect(transport.sent).toEqual([]);
            expect(transport.startCalls).toBe(0);
            expect(closes).toBe(1);
        });

        test('stdio sibling: no sibling is started and nothing is sent; the unstarted session fires no onclose', async () => {
            const session = new FakeStdioTransport({ command: 'srv', behavior: 'modern' });
            let closes = 0;
            session.onclose = () => closes++;
            const abort = new AbortController();
            abort.abort(new Error('aborted before connect'));

            const settled = await settleWithin(autoClient().connect(session, { signal: abort.signal }));

            expectAbortRejection(settled, /aborted before connect/);
            for (const instance of FakeStdioTransport.instances) {
                expect(instance.startCalls).toBe(0);
                expect(instance.sent).toEqual([]);
            }
            expect(closes).toBe(0);
        });
    });

    describe('stdio sibling probe', () => {
        test('an abort mid-probe rejects promptly; the sibling is reaped and the session never starts', async () => {
            const session = new FakeStdioTransport({ command: 'srv', behavior: 'silent' });

            const settled = await settleWithin(autoClient().connect(session, { signal: abortSoon() }));

            expectAbortRejection(settled, /aborted by caller/);
            expect(FakeStdioTransport.instances).toHaveLength(2);
            const sibling = FakeStdioTransport.instances[1]!;
            expect(discoverCount(sibling.sent)).toBe(1);
            expect(sibling.disposed).toBe(true);
            expect(session.startCalls).toBe(0);
        });

        test('an abort landing during sibling disposal still rejects: the session transport is never started', async () => {
            const session = new FakeStdioTransport({ command: 'srv', behavior: 'modern' });
            const abort = new AbortController();
            FakeStdioTransport.onDisposeStart = () => abort.abort(new Error('aborted during disposal'));

            const settled = await settleWithin(autoClient().connect(session, { signal: abort.signal }));

            expectAbortRejection(settled, /aborted during disposal/);
            expect(session.startCalls).toBe(0);
        });
    });

    describe('over real HTTP', () => {
        let server: Server | undefined;

        afterEach(async () => {
            server?.closeAllConnections();
            await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
            server = undefined;
        });

        test('StreamableHTTPClientTransport against a server that never answers: an abort mid-probe rejects promptly', async () => {
            server = createServer(req => {
                req.resume();
            });
            await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
            const { port } = server.address() as AddressInfo;
            const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

            const settled = await settleWithin(autoClient().connect(transport, { signal: abortSoon() }));
            await transport.close().catch(() => {});

            expectAbortRejection(settled, /aborted by caller/);
        });
    });
});
